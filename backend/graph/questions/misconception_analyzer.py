"""
graph/misconception_analyzer.py
KG-grounded misconception analysis.

Design principle
----------------
Scoring and gap identification are deterministic — derived entirely from
the knowledge graph structure. Explanation writing is template-first with
LLM escalation for unusual cases, and all LLM outputs are cached.

This means:
  - Scores are reproducible (same answer always gets same score)
  - Misconception labels come from graph topology, not LLM opinion
  - The LLM cannot hallucinate a gap that doesn't exist in the graph
  - Most wrong answers get a graph-grounded TEMPLATE explanation (no LLM)
  - Only unusual or repeat-miss cases escalate to the LLM
  - Every LLM output is cached for cross-student reuse

MCQ evaluation
--------------
The question stores distractor_distances: {option_text: hop_distance}.
Scoring is purely distance-based:
  - Correct answer              → score = 1.0
  - Distance-1 wrong answer     → score = 0.4  (subtle gap — closely related concept)
  - Distance-2 wrong answer     → score = 0.2  (moderate gap)
  - Distance-3+ wrong answer    → score = 0.0  (fundamental gap)

Short answer evaluation
-----------------------
The question carries:
  concept  (subject of the triple, e.g. "Harappan Cities")
  relation (edge type, e.g. "SUPPLIED_BY")
  correct  (object of the triple, e.g. "Farmers And Herders")

Three checks run in order, each contributing to the score:
  1. Object check    — weight 0.60
  2. Relation check  — weight 0.25
  3. Subject check   — weight 0.15

Severity tiers
--------------
  CORRECT  ≥ 0.85   → full marks
  CLOSE    0.60-0.84 → right idea, wrong detail
  PARTIAL  0.30-0.59 → partial understanding
  CRITICAL < 0.30   → fundamental gap

Explanation policy (Hotspot C)
------------------------------
LLM is called only when one of these signals fires:
  * No KG path found AND severity is PARTIAL or CRITICAL
    (template without a path is uninformative)
  * Short-answer question (templates can't capture the nuance)
  * Student has repeatedly missed this concept — escalation via
    supabase 'attempts' table lookup (requires conceptId; silently
    skipped if unavailable)

The cache key is (label | correct | student | concept | kg_path_joined),
deliberately user-independent so cross-student reuse works.
"""

import hashlib
import json
import logging
import os
import re
import time
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────
# Optional Supabase client for the cache + prior-wrong-attempts lookup.
# If env vars aren't set, the cache is disabled and the analyzer still
# works (template-first behaviour — the important win — is always on).
# ──────────────────────────────────────────────────────────────────────────

_SUPABASE_CLIENT = None


def _get_supabase():
    """Return a cached Supabase client, or None if unavailable."""
    global _SUPABASE_CLIENT
    if _SUPABASE_CLIENT is not None:
        return _SUPABASE_CLIENT
    url = os.environ.get("SUPABASE_URL")
    key = (
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        or os.environ.get("SUPABASE_SERVICE_KEY")
        or os.environ.get("SUPABASE_KEY")
    )
    if not url or not key:
        return None
    try:
        from supabase import create_client  # type: ignore
        _SUPABASE_CLIENT = create_client(url, key)
        return _SUPABASE_CLIENT
    except Exception as exc:
        logger.debug("Supabase client unavailable (cache disabled): %s", exc)
        return None


# ──────────────────────────────────────────────────────────────────────────
# Severity
# ──────────────────────────────────────────────────────────────────────────

class Severity:
    CORRECT  = "CORRECT"
    CLOSE    = "CLOSE"
    PARTIAL  = "PARTIAL"
    CRITICAL = "CRITICAL"

    @staticmethod
    def from_score(score: float) -> str:
        if score >= 0.85: return Severity.CORRECT
        if score >= 0.60: return Severity.CLOSE
        if score >= 0.30: return Severity.PARTIAL
        return Severity.CRITICAL


# ──────────────────────────────────────────────────────────────────────────
# Result dataclass
# ──────────────────────────────────────────────────────────────────────────

@dataclass
class MisconceptionResult:
    """
    Full evaluation result for one student answer.
    """
    question_id:         str
    student_answer:      str
    is_correct:          bool
    score:               float
    severity:            str
    misconception_label: str
    gap_description:     str
    correct_explanation: str
    attempt_id:          str             = ""
    kg_path:             list            = field(default_factory=list)
    checks:              dict            = field(default_factory=dict)
    distractor_distance: Optional[int]   = None   # MCQ only


# ──────────────────────────────────────────────────────────────────────────
# Escalation tunables
# ──────────────────────────────────────────────────────────────────────────

# How many prior wrong attempts on this concept before escalating to LLM.
REPEAT_MISS_ESCALATION_THRESHOLD = 2


# ──────────────────────────────────────────────────────────────────────────
# LLM prompts — explanation only, scoring already done
# ──────────────────────────────────────────────────────────────────────────

_SYSTEM_PROMPT = """\
You are an educational feedback writer for school-level history.

You will be given:
- A question and the correct answer
- A student's wrong answer
- The specific conceptual gap already identified (you do not re-evaluate correctness)
- The knowledge graph path between the student's answer and the correct answer (if available)

Your job is to write TWO short pieces of text:
1. "gap_description"     – 1-2 sentences explaining exactly what conceptual link the student missed.
                           Be specific. Refer to the actual concepts involved.
2. "correct_explanation" – 1-2 sentences explaining why the correct answer is correct,
                           in plain language a school student can understand.

Return ONLY a JSON object with these two string fields.
Example:
{
  "gap_description": "The student identified traders as the food source, but traders exchanged goods between cities — they did not grow or herd food themselves. The direct suppliers were farmers and herders.",
  "correct_explanation": "Harappan cities depended on farmers and herders in surrounding villages who sent food into the cities. Traders played a different role — moving goods between regions.",
}

Rules:
- gap_description must reference the specific wrong concept the student chose.
- Keep all two fields under 3 sentences each.
- Return ONLY the JSON. No markdown, no preamble.\
"""

_USER_TEMPLATE = """\
Question: {question}
Correct answer: {correct}
Student's answer: {student_answer}
Misconception label: {label}
KG path (correct → wrong concept): {kg_path}
Source text: {source_text}

Write the gap_description, correct_explanation.\
"""


# ──────────────────────────────────────────────────────────────────────────
# Analyzer
# ──────────────────────────────────────────────────────────────────────────

class MisconceptionAnalyzer:
    """
    KG-grounded misconception analyzer.

    Usage
    -----
        analyzer = MisconceptionAnalyzer()
        result = analyzer.evaluate(
            question_id    = q["question_id"],
            question_text  = q["question"],
            correct_answer = q["correct"],
            student_answer = chosen_option,
            q_type         = q["q_type"],
            concept        = q["concept"],
            relation       = q["relation"],
            distractor_distances = q["distractor_distances"],  # MCQ
            neo4j_session  = session,
            source_text    = chunk_text,
            user_id        = "uuid-of-student",   # optional, enables repeat-miss escalation
            concept_id     = "uuid-of-concept",   # optional, same
        )
    """

    def __init__(self, model: str = "llama-3.1-8b-instant"):
        try:
            from groq import Groq
            self._client = Groq(api_key=os.environ["GROQ_API_KEY"])
        except ImportError:
            raise ImportError("groq not installed. Run: pip install groq")
        except KeyError:
            raise EnvironmentError("GROQ_API_KEY not set in .env")
        self.model = model

    # ------------------------------------------------------------------
    # Public entry point
    # ------------------------------------------------------------------

    def evaluate(
        self,
        question_id:          str,
        question_text:        str,
        correct_answer:       str,
        student_answer:       str,
        q_type:               str,
        concept:              str,
        relation:             str,
        neo4j_session,
        distractor_distances: dict = None,   # MCQ only
        source_text:          str = "",
        doc_id:               str = "",
        user_id:              str = "",      # optional — enables repeat-miss
        concept_id:           str = "",      # optional — enables repeat-miss
    ) -> MisconceptionResult:
        """
        Evaluate one student answer using the KG-first approach.

        Steps:
          1. Blank/empty answer → immediate CRITICAL result, no Groq call.
          2. Correct answer check → CORRECT, no Groq call.
          3. Score deterministically from KG.
          4. Retrieve KG path between wrong and correct concept.
          5. Build explanation (template-first; LLM only on escalation).
          6. Return MisconceptionResult.
        """
        # Step 1 — blank answer
        if not student_answer.strip():
            return self._blank_result(question_id, student_answer, correct_answer)

        # Step 2 — correct answer
        if self._is_correct(student_answer, correct_answer):
            return self._correct_result(
                question_id, student_answer, correct_answer
            )

        # Step 3 — deterministic scoring
        if q_type != "mcq":
            raise ValueError(
                f"Only MCQ questions are supported (got q_type={q_type!r}). "
                "Short-answer support was removed."
            )
        score, distance, label = self._score_mcq(
            student_answer, correct_answer, distractor_distances or {}
        )

        severity = Severity.from_score(score)

        # Step 4 — KG path (best-effort, non-fatal)
        kg_path = []
        try:
            kg_path = self._get_kg_path(
                student_answer, correct_answer, concept, doc_id, neo4j_session
            )
        except Exception as e:
            logger.debug("KG path lookup failed (non-fatal): %s", e)

        # Step 5 — Explanation (template-first with LLM escalation)
        explanation = self._build_explanation(
            question=question_text,
            correct=correct_answer,
            student_answer=student_answer,
            label=label,
            severity=severity,
            q_type=q_type,
            concept=concept,
            kg_path=kg_path,
            source_text=source_text,
            user_id=user_id,
            concept_id=concept_id,
        )

        return MisconceptionResult(
            question_id=question_id,
            student_answer=student_answer,
            is_correct=False,
            score=round(score, 2),
            severity=severity,
            misconception_label=label,
            gap_description=explanation.get("gap_description", ""),
            correct_explanation=explanation.get("correct_explanation", ""),
            kg_path=kg_path,
            checks=checks,
            distractor_distance=dist,
        )

    # ------------------------------------------------------------------
    # Step 2 — Correct answer check
    # ------------------------------------------------------------------

    def _is_correct(self, student: str, correct: str) -> bool:
        """
        Normalised string match — case-insensitive, strips punctuation.
        """
        def norm(s):
            return re.sub(r"[^\w\s]", "", s.lower()).strip()

        s = norm(student)
        c = norm(correct)

        if s == c:
            return True
        if c in s:
            return True
        if len(s) > 3 and s in c:
            return True
        return False

    # ------------------------------------------------------------------
    # Step 3a — MCQ scoring
    # ------------------------------------------------------------------

    def _score_mcq(
        self,
        student_answer:       str,
        correct_answer:       str,
        distractor_distances: dict,
    ):
        """Score an MCQ answer purely from graph hop distance."""
        distance = distractor_distances.get(student_answer)
        if distance is None:
            distance = 3

        score_map = {1: 0.4, 2: 0.2}
        score = score_map.get(distance, 0.0)

        label_map = {
            1: f"Confused closely related concepts: '{student_answer}' vs '{correct_answer}'",
            2: f"Mixed up concepts in the same domain: chose '{student_answer}'",
        }
        label = label_map.get(
            distance,
            f"Fundamental gap: chose '{student_answer}' (far from correct)"
        )

        return score, distance, label

    # ------------------------------------------------------------------
    # Step 4 — KG path between wrong and correct concept
    # ------------------------------------------------------------------

    def _get_kg_path(
        self,
        student_answer: str,
        correct_answer: str,
        concept:        str,
        doc_id:         str,
        session,
    ) -> list:
        """Find the shortest path in the KG between wrong and correct concepts."""
        if not session or not doc_id:
            return []

        result = session.run(
            """
            MATCH (correct:Concept {doc_id: $doc_id})
            WHERE toLower(correct.name) CONTAINS toLower($correct)
               OR toLower($correct) CONTAINS toLower(correct.name)
            MATCH (wrong:Concept {doc_id: $doc_id})
            WHERE toLower(wrong.name) CONTAINS toLower($wrong)
               OR toLower($wrong) CONTAINS toLower(wrong.name)
            MATCH path = shortestPath((correct)-[*1..4]-(wrong))
            RETURN [n IN nodes(path) | n.name] AS nodes,
                   [r IN relationships(path) | type(r)] AS rels
            LIMIT 1
            """,
            doc_id=doc_id,
            correct=correct_answer[:50],
            wrong=student_answer[:50],
        )
        row = result.single()
        if not row:
            return []

        nodes = row["nodes"]
        rels  = row["rels"]
        path_parts = []
        for i, rel in enumerate(rels):
            path_parts.append(f"{nodes[i]} -[{rel}]-> {nodes[i+1]}")

        return path_parts

    # ------------------------------------------------------------------
    # Step 5 — Explanation (template-first with LLM escalation)
    # ------------------------------------------------------------------

    def _build_explanation(
        self,
        question:       str,
        correct:        str,
        student_answer: str,
        label:          str,
        severity:       str,
        q_type:         str,
        concept:        str,
        kg_path:        list,
        source_text:    str,
        user_id:        str,
        concept_id:     str,
    ) -> dict:
        """
        Policy:
          A. Cache lookup — if we've written this explanation before, reuse.
          B. Template unless one of the escalation signals fires:
             - severity in (PARTIAL, CRITICAL) AND kg_path is empty
             - short-answer question (templates aren't specific enough)
             - student has missed this concept REPEAT_MISS_ESCALATION_THRESHOLD+
               times before
          C. LLM is the escalation path. Cache whatever we produce.

        Note on the cache-vs-repeat-miss tension:
          The cache key is intentionally user-independent so cross-student
          reuse works. The repeat-miss escalation only fires the FIRST time
          any student hits the threshold for a given wrong-answer pattern;
          after that the escalated (LLM-generated) text is served from cache
          for all subsequent repeat-missers, which is still richer than the
          template, so it's the right outcome.
        """
        # ── A. Cache hit ──────────────────────────────────────────────
        cached = self._lookup_explanation(label, correct, student_answer, concept, kg_path)
        if cached:
            logger.info("[MCAnalyzer] Cache hit (%s)", cached.get("source", "?"))
            return {
                "gap_description":     cached.get("gap_description", ""),
                "correct_explanation": cached.get("correct_explanation", ""),
            }

        # ── B. Decide: template or LLM? ───────────────────────────────
        path_missing = len(kg_path) == 0
        severe_gap = severity in (Severity.PARTIAL, Severity.CRITICAL)

        prior_misses = 0
        if user_id and concept_id:
            prior_misses = self._count_prior_wrong_attempts(user_id, concept_id)
        repeated_miss = prior_misses >= REPEAT_MISS_ESCALATION_THRESHOLD

        should_escalate = (path_missing and severe_gap) or repeated_miss

        if not should_escalate:
            # Template path — the default.
            explanation = self._template_explanation(
                concept, correct, student_answer, label, kg_path
            )
            self._store_explanation(
                label, correct, student_answer, concept, kg_path,
                explanation, source="template"
            )
            logger.info("[MCAnalyzer] Template explanation used")
            return explanation

        # ── C. LLM escalation path ────────────────────────────────────
        logger.info(
            "[MCAnalyzer] Escalating to LLM (path_missing=%s, severe_gap=%s, is_short=%s, prior_misses=%d)",
            path_missing, severe_gap, is_short, prior_misses,
        )
        llm_explanation = self._explain_with_llm(
            question, correct, student_answer, label, kg_path, source_text
        )
        self._store_explanation(
            label, correct, student_answer, concept, kg_path,
            llm_explanation, source="llm", model=self.model,
        )
        return llm_explanation

    # ------------------------------------------------------------------
    # Template explanation (the DEFAULT path)
    # ------------------------------------------------------------------

    def _template_explanation(
        self,
        concept:        str,
        correct:        str,
        student_answer: str,
        label:          str,
        kg_path:        list,
    ) -> dict:
        """
        Build a genuinely useful explanation from the KG path alone.
        Unlike the old "fallback" (which was bland because it was emergency-
        only), this is the default path and pulls structural context from
        the graph.
        """
        if kg_path:
            # First relation type is the key link.
            first_rel_match = re.search(r"-\[([A-Z_]+)\]->", kg_path[0])
            first_rel = (
                first_rel_match.group(1).replace("_", " ").lower()
                if first_rel_match else ""
            )
            path_trail = " → ".join(kg_path)

            if first_rel:
                gap_description = (
                    f"You chose \"{student_answer}\", which is related to "
                    f"\"{correct}\" through \"{first_rel}\", but it isn't "
                    f"the same thing. The correct answer is \"{correct}\"."
                )
            else:
                gap_description = (
                    f"You chose \"{student_answer}\", which is related to "
                    f"\"{correct}\" in the graph but is not the correct "
                    f"answer here. The correct answer is \"{correct}\"."
                )

            concept_label = f'"{concept}"' if concept else "this question"
            correct_explanation = (
                f'"{correct}" is the right answer for {concept_label}. '
                f"In the knowledge graph the connection is: {path_trail}. "
                f"Review this chain to see why they are distinct concepts."
            )
            return {
                "gap_description":     gap_description,
                "correct_explanation": correct_explanation,
            }

        # No path — say so clearly.
        gap_description = (
            f"{label}. \"{student_answer}\" does not appear to be "
            f"connected to \"{correct}\" in the material you studied."
        )
        if concept:
            correct_explanation = (
                f"The correct answer is \"{correct}\". Revisit the section "
                f"of the source document that covers \"{concept}\"."
            )
        else:
            correct_explanation = (
                f"The correct answer is \"{correct}\". Revisit the relevant "
                f"section of your notes."
            )
        return {
            "gap_description":     gap_description,
            "correct_explanation": correct_explanation,
        }

    # ------------------------------------------------------------------
    # LLM explanation writer — ESCALATION path only
    # ------------------------------------------------------------------

    def _explain_with_llm(
        self,
        question:       str,
        correct:        str,
        student_answer: str,
        label:          str,
        kg_path:        list,
        source_text:    str,
    ) -> dict:
        """
        Ask the LLM to write gap_description + correct_explanation.
        Falls back to template if the LLM call itself fails, so this
        function never throws.
        """
        kg_path_str = " → ".join(kg_path) if kg_path else "Path not available in graph."
        source_trimmed = source_text[:600] if source_text else "Not available."

        prompt = _USER_TEMPLATE.format(
            question=question,
            correct=correct,
            student_answer=student_answer,
            label=label,
            kg_path=kg_path_str,
            source_text=source_trimmed,
        )

        for attempt in range(1, 3):
            try:
                response = self._client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": _SYSTEM_PROMPT},
                        {"role": "user",   "content": prompt},
                    ],
                    temperature=0.3,
                    max_tokens=400,
                )
                raw = response.choices[0].message.content
                parsed = self._parse_explanation(raw)
                if parsed.get("gap_description") and parsed.get("correct_explanation"):
                    return parsed
                # LLM returned empty fields — use template instead.
                return self._template_explanation("", correct, student_answer, label, kg_path)

            except Exception as exc:
                err = str(exc).lower()
                if "rate" in err or "429" in err:
                    logger.warning("Rate limit on explanation call — waiting 30s")
                    time.sleep(30)
                else:
                    logger.warning("Groq explanation error (attempt %d): %s", attempt, exc)
                    time.sleep(2)

        # LLM failed twice — template it.
        return self._template_explanation("", correct, student_answer, label, kg_path)

    def _parse_explanation(self, raw: str) -> dict:
        """Parse LLM JSON response for explanation fields."""
        cleaned  = re.sub(r"```(?:json)?", "", raw).strip()
        start    = cleaned.find("{")
        end      = cleaned.rfind("}")
        if start == -1 or end == -1:
            return {}

        json_str = cleaned[start: end + 1]
        json_str = re.sub(r",\s*([}\]])", r"\1", json_str)

        try:
            data = json.loads(json_str)
            return {
                "gap_description":     str(data.get("gap_description", "")).strip(),
                "correct_explanation": str(data.get("correct_explanation", "")).strip(),
            }
        except json.JSONDecodeError:
            return {}

    # ------------------------------------------------------------------
    # Cache — Supabase-backed, silently disabled without creds
    # ------------------------------------------------------------------

    def _explanation_hash(
        self,
        label:          str,
        correct:        str,
        student_answer: str,
        concept:        str,
        kg_path:        list,
    ) -> str:
        """Stable cache key across users."""
        def _norm(s: str) -> str:
            return re.sub(r"\s+", " ", (s or "").lower()).strip()
        parts = "||".join([
            _norm(label),
            _norm(correct),
            _norm(student_answer),
            _norm(concept),
            " >> ".join((p or "").strip() for p in kg_path),
        ])
        return hashlib.sha256(parts.encode("utf-8")).hexdigest()

    def _lookup_explanation(
        self,
        label:          str,
        correct:        str,
        student_answer: str,
        concept:        str,
        kg_path:        list,
    ) -> Optional[dict]:
        """Return cached explanation if present, else None."""
        supabase = _get_supabase()
        if supabase is None:
            return None
        try:
            h = self._explanation_hash(label, correct, student_answer, concept, kg_path)
            resp = (
                supabase.table("misconception_explanation_cache")
                .select("gap_description, correct_explanation, source")
                .eq("explanation_hash", h)
                .limit(1)
                .execute()
            )
            rows = getattr(resp, "data", None) or []
            if not rows:
                return None
            # Bump last_hit_at, best-effort.
            try:
                supabase.table("misconception_explanation_cache").update(
                    {"last_hit_at": "now()"}
                ).eq("explanation_hash", h).execute()
            except Exception:
                pass
            return rows[0]
        except Exception as exc:
            logger.debug("[MCCache] Lookup failed (treating as miss): %s", exc)
            return None

    def _store_explanation(
        self,
        label:          str,
        correct:        str,
        student_answer: str,
        concept:        str,
        kg_path:        list,
        explanation:    dict,
        source:         str,
        model:          Optional[str] = None,
    ) -> None:
        """Upsert an explanation into the cache. Non-fatal on failure."""
        supabase = _get_supabase()
        if supabase is None:
            return
        try:
            h = self._explanation_hash(label, correct, student_answer, concept, kg_path)
            row = {
                "explanation_hash":    h,
                "gap_description":     explanation.get("gap_description", ""),
                "correct_explanation": explanation.get("correct_explanation", ""),
                "source":              source,
                "model":               model if source == "llm" else None,
            }
            supabase.table("misconception_explanation_cache").upsert(
                row, on_conflict="explanation_hash"
            ).execute()
        except Exception as exc:
            logger.debug("[MCCache] Store failed (non-fatal): %s", exc)

    def _count_prior_wrong_attempts(self, user_id: str, concept_id: str) -> int:
        """Count prior wrong attempts for the escalation signal."""
        supabase = _get_supabase()
        if supabase is None or not user_id or not concept_id:
            return 0
        try:
            resp = (
                supabase.table("attempts")
                .select("id", count="exact", head=True)
                .eq("user_id", user_id)
                .eq("concept_id", concept_id)
                .eq("correct", False)
                .execute()
            )
            return int(getattr(resp, "count", 0) or 0)
        except Exception as exc:
            logger.debug("[MCCache] Prior-wrong-attempts lookup failed: %s", exc)
            return 0

    # ------------------------------------------------------------------
    # Fast-path results
    # ------------------------------------------------------------------

    def _blank_result(
        self, question_id: str, student_answer: str, correct_answer: str
    ) -> MisconceptionResult:
        return MisconceptionResult(
            question_id=question_id,
            student_answer=student_answer,
            is_correct=False,
            score=0.0,
            severity=Severity.CRITICAL,
            misconception_label="No answer provided",
            gap_description="The student did not attempt this question.",
            correct_explanation=f"The correct answer is '{correct_answer}'."
        )

    def _correct_result(
        self,
        question_id:    str,
        student_answer: str,
        correct_answer: str,
    ) -> MisconceptionResult:
        """
        Correct-answer result — deterministic, no LLM call.
        The previous implementation made an LLM call even for correct
        answers to produce a one-sentence affirmation. That was two
        LLM calls per wrong-then-correct pair; we drop it in favour of a
        simple deterministic message.
        """
        return MisconceptionResult(
            question_id=question_id,
            student_answer=student_answer,
            is_correct=True,
            score=1.0,
            severity=Severity.CORRECT,
            misconception_label="",
            gap_description="",
            correct_explanation=f"\"{correct_answer}\" is correct. Well done!",
        )