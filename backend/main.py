"""
backend/main.py
FastAPI application — Python backend for Study-Lens.

Provides:
  - OCR-capable PDF ingestion pipeline
  - KG-grounded question generation
  - KG-grounded misconception analysis

Endpoints
---------
POST /ingest         — Full ingestion pipeline for one PDF
GET  /questions/{doc_id} — Return generated questions
POST /answer         — Single answer with misconception feedback
POST /submit-all     — Batch answers with full misconception report
GET  /summary/{doc_id}   — Aggregate misconception analytics
GET  /triples/{doc_id}   — Scored KG triples
GET  /health         — Health check

Run locally:
    cd backend && uvicorn main:app --reload --port 8000
"""

import json
import logging
import os
import sys
from pathlib import Path

# Path setup — backend/ is now inside study-lens/
BACKEND_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = BACKEND_ROOT.parent  # study-lens/
for p in [str(BACKEND_ROOT), str(PROJECT_ROOT)]:
    if p not in sys.path:
        sys.path.insert(0, p)

# Load .env from study-lens root (.env.local) or backend/.env
try:
    from dotenv import load_dotenv
    # Try study-lens root .env.local first, then backend/.env
    env_local = PROJECT_ROOT / ".env.local"
    env_backend = BACKEND_ROOT / ".env"
    if env_local.exists():
        load_dotenv(env_local)
    elif env_backend.exists():
        load_dotenv(env_backend)
except ImportError:
    pass

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from graph.neo4j_client import Neo4jClient
from graph.graph_service import GraphService
from graph.questions.question_generator import QuestionGenerator, deduplicate_relations, score_relations
from graph.questions.question_repository import QuestionRepository
from graph.questions.misconception_analyzer import MisconceptionAnalyzer
from graph.questions.attempt_repository import AttemptRepository
from ingestion.pipeline import IngestionPipeline
from utils.question_exporter import export_questions

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("api")

# App setup

app = FastAPI(
    title="Study-Lens Backend",
    description="KG-powered study assistant with OCR ingestion and misconception analysis",
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3000",
        "*",  # Remove in production
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Shared Neo4j client — one connection pool for the app lifetime
_neo4j_client: Neo4jClient = None

def get_client() -> Neo4jClient:
    global _neo4j_client
    if _neo4j_client is None:
        _neo4j_client = Neo4jClient()
        _neo4j_client.connect()
    return _neo4j_client

def get_service() -> GraphService:
    return GraphService(get_client())

# ── Request / Response models ─────────────────────────────────────────────

class IngestRequest(BaseModel):
    storage_path: str
    """Supabase storage path e.g. 'harappa.pdf' or 'user-id/chapter3.pdf'"""
    user_id: str = ""
    """Supabase user UUID — used for user-scoped Neo4j nodes"""
    document_id: str = ""
    """Supabase concept UUID — links backend doc to Study-Lens concept record"""

class IngestResponse(BaseModel):
    doc_id: str
    storage_path: str
    page_count: int
    chunk_count: int
    triple_count: int
    question_count: int
    message: str

class AnswerRequest(BaseModel):
    question_id: str
    student_answer: str
    chosen_option: str = ""
    user_id: str = ""

class SubmitAllRequest(BaseModel):
    doc_id: str
    user_id: str = ""
    answers: list[dict]
    # Each item: {question_id, student_answer, chosen_option (MCQ only)}

class AnswerResponse(BaseModel):
    attempt_id: str
    question_id: str
    is_correct: bool
    score: float
    feedback: str
    hint: str
    correct_explanation: str

# ── Startup / Shutdown ────────────────────────────────────────────────────

@app.on_event("startup")
async def startup():
    logger.info("Starting Study-Lens Backend ...")
    try:
        get_client().verify_connectivity()
        logger.info("Neo4j connection verified.")
    except Exception as exc:
        logger.error("Neo4j unreachable at startup: %s", exc)


@app.on_event("shutdown")
async def shutdown():
    global _neo4j_client
    if _neo4j_client:
        _neo4j_client.close()
        logger.info("Neo4j connection closed.")

# ── Endpoints ─────────────────────────────────────────────────────────────

@app.post("/ingest", response_model=IngestResponse)
async def ingest(request: IngestRequest):
    """
    Full ingestion pipeline for one PDF:
    download → extract → quality check → chunk → concepts → questions.

    Returns doc_id and counts for each stage.
    """
    logger.info("POST /ingest — storage_path='%s', user_id='%s'",
                request.storage_path, request.user_id)

    # Step 1: Ingestion pipeline
    try:
        pipeline = IngestionPipeline()
        result = pipeline.run(request.storage_path)
    except Exception as exc:
        if hasattr(exc, 'rejection_reason'):
            raise HTTPException(
                status_code=422,
                detail={
                    "error": "quality_rejected",
                    "message": exc.rejection_reason,
                    "quality_score": getattr(getattr(exc, 'report', None), 'overall_score', 0),
                },
            )
        logger.error("Ingestion failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Ingestion failed: {exc}")

    # Step 2: Write chunks to Neo4j (with user_id)
    service = get_service()
    try:
        doc_id = service.save_ingestion_result(
            result, user_id=request.user_id, document_id=request.document_id
        )
    except Exception as exc:
        logger.error("Graph write failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Graph write failed: {exc}")

    # Step 3: Extract concepts
    triple_count = 0
    try:
        triple_count = service.extract_and_save_concepts(
            doc_id, user_id=request.user_id
        )
    except Exception as exc:
        logger.warning("Concept extraction failed (non-fatal): %s", exc)

    # Step 4: Generate questions
    question_count = 0
    question_export_paths: dict[str, str] = {}
    try:
        relations = service.get_relations_for_document(doc_id)
        chunks    = service.get_chunks_for_document(doc_id)

        generator = QuestionGenerator()
        with get_client().session() as session:
            session.run(
                "CREATE CONSTRAINT unique_question IF NOT EXISTS "
                "FOR (q:Question) REQUIRE q.question_id IS UNIQUE"
            )
            questions = generator.generate_for_document(
                doc_id, relations, chunks, neo4j_session=session
            )
            QuestionRepository(session).upsert_many(questions)
            question_count = len(questions)
            question_export_paths = export_questions(
                doc_id,
                questions,
                output_dir=BACKEND_ROOT / "exports" / "questions",
            )

    except Exception as exc:
        logger.warning("Question generation failed (non-fatal): %s", exc)

    return IngestResponse(
        doc_id=doc_id,
        storage_path=request.storage_path,
        page_count=result.page_count,
        chunk_count=result.chunk_count,
        triple_count=triple_count,
        question_count=question_count,
        message=(
            f"Ingestion complete. {result.chunk_count} chunks, "
            f"{triple_count} concept triples, {question_count} questions generated."
            + (
                f" Exported to JSON: {question_export_paths.get('json')} "
                f"and CSV: {question_export_paths.get('csv')}."
                if question_export_paths else ""
            )
        ),
    )


@app.get("/questions/{doc_id}")
async def get_questions(
    doc_id: str,
    difficulty: str = Query(None, pattern="^(easy|medium|hard)$"),
    q_type: str = Query(None, alias="type", pattern="^(mcq|short)$"),
    limit: int = Query(50, ge=1, le=200),
):
    """
    Return questions for a document.
    Optional filters: difficulty, type, limit.
    """
    logger.info("GET /questions/%s", doc_id)

    service = get_service()
    doc = service.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail=f"Document '{doc_id}' not found.")

    with get_client().session() as session:
        repo = QuestionRepository(session)
        questions = repo.find_by_document(doc_id, difficulty=difficulty, q_type=q_type, limit=limit)

    if not questions:
        raise HTTPException(
            status_code=404,
            detail="No questions found. Run /ingest first or check doc_id.",
        )

    return {
        "doc_id": doc_id,
        "count": len(questions),
        "questions": questions,
    }


@app.post("/answer", response_model=AnswerResponse)
async def submit_answer(request: AnswerRequest):
    """Submit a single student answer and get immediate feedback."""
    logger.info("POST /answer — question_id='%s'", request.question_id)

    with get_client().session() as session:
        question = QuestionRepository(session).find_by_id(request.question_id)

    if not question:
        raise HTTPException(status_code=404,
                            detail=f"Question '{request.question_id}' not found.")

    # Source chunk text for context
    source_text = ""
    if question.get("source_chunk"):
        chunks = get_service().get_chunk_with_context(question["source_chunk"], depth=1)
        source_text = " ".join(c.get("text", "") for c in chunks)

    # For MCQ use chosen_option; for short use student_answer
    q_type = question.get("q_type", "short")
    eval_answer = (
        request.chosen_option
        if q_type == "mcq" and request.chosen_option
        else request.student_answer
    )

    # Parse distractor_distances from stored JSON string
    dd_raw = question.get("distractor_distances", "{}")
    try:
        distractor_distances = json.loads(dd_raw) if isinstance(dd_raw, str) else (dd_raw or {})
    except Exception:
        distractor_distances = {}

    try:
        analyzer = MisconceptionAnalyzer()
        with get_client().session() as session:
            result = analyzer.evaluate(
                question_id=request.question_id,
                question_text=question["question"],
                correct_answer=question["correct"],
                student_answer=eval_answer,
                q_type=q_type,
                concept=question.get("concept", ""),
                relation=question.get("relation", ""),
                distractor_distances=distractor_distances,
                neo4j_session=session,
                source_text=source_text,
                doc_id=question.get("doc_id", ""),
            )
    except Exception as exc:
        logger.error("Evaluation failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Evaluation failed: {exc}")

    try:
        with get_client().session() as session:
            AttemptRepository(session).save(result)
    except Exception as exc:
        logger.warning("Failed to save attempt (non-fatal): %s", exc)

    return AnswerResponse(
        attempt_id=result.attempt_id,
        question_id=request.question_id,
        is_correct=result.is_correct,
        score=result.score,
        feedback=result.gap_description if not result.is_correct else "Correct!",
        hint=result.hint if not result.is_correct else "",
        correct_explanation=result.correct_explanation,
    )


@app.post("/submit-all")
async def submit_all_answers(request: SubmitAllRequest):
    """
    Submit all student answers at once and receive a full misconception report.

    Returns per-question breakdown with severity, misconception labels,
    gap descriptions, hints, KG paths, and distractor distances.
    """
    logger.info("POST /submit-all — doc_id='%s', %d answers",
                request.doc_id, len(request.answers))

    analyzer     = MisconceptionAnalyzer()
    service      = get_service()
    report_items = []

    for answer in request.answers:
        qid           = answer.get("question_id", "")
        student_ans   = answer.get("student_answer", "")
        chosen_option = answer.get("chosen_option", "")

        with get_client().session() as session:
            question = QuestionRepository(session).find_by_id(qid)
        if not question:
            logger.warning("Question '%s' not found — skipping", qid)
            continue

        # Source text
        source_text = ""
        if question.get("source_chunk"):
            chunks = service.get_chunk_with_context(question["source_chunk"], depth=1)
            source_text = " ".join(c.get("text", "") for c in chunks)

        q_type = question.get("q_type", "short")
        eval_answer = (
            chosen_option if q_type == "mcq" and chosen_option else student_ans
        )

        # Parse distractor_distances
        dd_raw = question.get("distractor_distances", "{}")
        try:
            distractor_distances = json.loads(dd_raw) if isinstance(dd_raw, str) else (dd_raw or {})
        except Exception:
            distractor_distances = {}

        # Evaluate with KG-grounded analyzer
        with get_client().session() as session:
            result = analyzer.evaluate(
                question_id=qid,
                question_text=question["question"],
                correct_answer=question["correct"],
                student_answer=eval_answer,
                q_type=q_type,
                concept=question.get("concept", ""),
                relation=question.get("relation", ""),
                distractor_distances=distractor_distances,
                neo4j_session=session,
                source_text=source_text,
                doc_id=request.doc_id,
            )

        # Save attempt
        try:
            with get_client().session() as session:
                AttemptRepository(session).save(result)
        except Exception as exc:
            logger.warning("Failed to save attempt for '%s': %s", qid, exc)

        report_items.append({
            "question_id":          qid,
            "question":             question["question"],
            "q_type":               q_type,
            "concept":              question.get("concept", ""),
            "relation":             question.get("relation", ""),
            "difficulty":           question.get("difficulty", ""),
            "correct_answer":       question["correct"],
            "student_answer":       eval_answer,
            "is_correct":           result.is_correct,
            "score":                result.score,
            "severity":             result.severity,
            "misconception_label":  result.misconception_label,
            "gap_description":      result.gap_description,
            "correct_explanation":  result.correct_explanation,
            "hint":                 result.hint,
            "kg_path":              result.kg_path,
            "checks":               result.checks,
            "distractor_distance":  result.distractor_distance,
        })

    if not report_items:
        raise HTTPException(status_code=400,
                            detail="No valid answers submitted. Check question_ids.")

    # ── Aggregate ─────────────────────────────────────────────────────
    total     = len(report_items)
    n_correct = sum(1 for r in report_items if r["is_correct"])
    avg_score = round(sum(r["score"] for r in report_items) / total, 2)

    severity_counts = {"CORRECT": 0, "CLOSE": 0, "PARTIAL": 0, "CRITICAL": 0}
    for r in report_items:
        severity_counts[r["severity"]] = severity_counts.get(r["severity"], 0) + 1

    concept_scores: dict[str, list[float]] = {}
    for item in report_items:
        c = item.get("concept") or "Unknown"
        concept_scores.setdefault(c, []).append(item["score"])

    concept_mastery = sorted(
        [
            {
                "concept":   c,
                "avg_score": round(sum(s) / len(s), 2),
                "attempts":  len(s),
                "mastered":  sum(s) / len(s) >= 0.85,
            }
            for c, s in concept_scores.items()
        ],
        key=lambda x: x["avg_score"],
    )

    gaps = [m for m in concept_mastery if not m["mastered"]]

    return {
        "doc_id":          request.doc_id,
        "total_questions": total,
        "correct":         n_correct,
        "incorrect":       total - n_correct,
        "score_percent":   round(n_correct / total * 100, 1),
        "avg_score":       avg_score,
        "severity_counts": severity_counts,
        "concept_mastery": concept_mastery,
        "concepts_to_review": [g["concept"] for g in gaps],
        "breakdown":       report_items,
    }


@app.get("/summary/{doc_id}")
async def get_summary(doc_id: str):
    """Aggregate analytics across all student sessions for a document."""
    logger.info("GET /summary/%s", doc_id)

    service = get_service()
    if not service.document_exists(doc_id):
        raise HTTPException(status_code=404, detail=f"Document '{doc_id}' not found.")

    with get_client().session() as session:
        repo = AttemptRepository(session)
        misconceptions = repo.get_misconception_summary(doc_id)
        mastery        = repo.get_concept_mastery(doc_id)

    return {
        "doc_id":                 doc_id,
        "misconception_summary":  misconceptions,
        "concept_mastery":        mastery,
    }


@app.get("/triples/{doc_id}")
async def get_scored_triples(
    doc_id: str,
    limit: int = Query(50, ge=1, le=500),
):
    """
    Return scored knowledge-graph triples for a document, ranked by
    learning value.
    """
    logger.info("GET /triples/%s", doc_id)

    service = get_service()
    if not service.document_exists(doc_id):
        raise HTTPException(status_code=404, detail=f"Document '{doc_id}' not found.")

    relations = service.get_relations_for_document(doc_id)
    chunks    = service.get_chunks_for_document(doc_id)
    concepts  = service.get_concepts_for_document(doc_id)

    if not relations:
        return {"doc_id": doc_id, "count": 0, "triples": []}

    deduped   = deduplicate_relations(relations)
    chunk_map = {c["chunk_id"]: c.get("text", "") for c in chunks}
    mention_count = {c["name"]: c.get("mention_count", 0) for c in concepts}

    scored = score_relations(deduped, chunk_map, mention_count, max_context_chars=1200)
    rows   = [
        item.as_dict()
        for item in sorted(scored, key=lambda x: x.score, reverse=True)
    ][:limit]

    return {
        "doc_id":           doc_id,
        "total_relations":  len(relations),
        "deduplicated":     len(deduped),
        "count":            len(rows),
        "triples":          rows,
    }


@app.get("/health")
async def health():
    """Quick health check — verifies Neo4j is reachable."""
    try:
        get_client().verify_connectivity()
        return {"status": "ok", "neo4j": "connected"}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Neo4j unreachable: {exc}")
