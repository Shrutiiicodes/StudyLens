"""
graph/question_generator.py
KG-first question generation.

Design principle
----------------
The LLM has exactly ONE job: given a (subject, relation, object) triple
and its source text, write a clear question and a correct answer.

The knowledge graph has exactly ONE job: build the distractors from
graph-distance neighbours of the correct-answer concept.

These two responsibilities never overlap.

MCQ generation flow (per triple)
---------------------------------
1.  LLM receives ONE triple + supporting chunk text.
    Returns: {question, correct, difficulty}.
    Does NOT return options. Doesn't know the question type yet.

2.  Graph fetches neighbours of the subject concept up to 3 hops:
    - distance=1 neighbours  → hardest distractors (directly connected)
    - distance=2 neighbours  → medium distractors
    - distance=3 neighbours  → easiest distractors

3.  If graph can supply ≥3 distinct distractors → MCQ.
    Options = 3 graph distractors + correct answer, shuffled.
    distractor_distances records which option came from which hop.

4.  If graph cannot supply ≥3 distractors → SHORT answer.
    No LLM fallback. No invented distractors.
    Question type is determined entirely by graph density.

Difficulty rule (graph-grounded)
---------------------------------
- All distractors dist=1  → "hard"
- Mix of dist 1 and 2     → "medium"
- Mostly dist=3+          → "easy"
Difficulty comes from graph topology, not LLM guessing.

Concurrency
-----------
One Groq call per triple, all fired in parallel via asyncio + semaphore.
Smaller prompts (no options) → faster, cheaper, cleaner JSON.
"""

import json
import logging
import os
import random
import re
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)

_LEADING_ARTICLES = re.compile(r"^(the|a|an)\s+", re.IGNORECASE)
_GENERIC_RELATION_WEIGHTS = {
    "USED_FOR": 1.0,
    "PURPOSE": 1.0,
    "CAUSED_BY": 0.95,
    "LED_TO": 0.95,
    "DISCOVERED_BY": 0.9,
    "BUILT_BY": 0.9,
    "DEVELOPED_BY": 0.9,
    "PRODUCED_BY": 0.9,
    "SUPPLIED_BY": 0.85,
    "TRADED_BY": 0.85,
    "INVENTED_BY": 0.85,
    "FOUND_IN": 0.8,
    "LOCATED_IN": 0.7,
    "CONTAINS": 0.65,
    "PART_OF": 0.6,
    "IS_A": 0.55,
}

# Minimum cosine similarity a distractor must have with the concept name
# for it to be considered topically relevant. Hop-3 neighbours frequently
# sit outside the topic domain — this threshold filters them out.
_DISTRACTOR_TOPIC_THRESHOLD    = 0.12   # hop 1 & 2
_DISTRACTOR_HOP3_THRESHOLD     = 0.18   # hop 3 (tighter)

# Minimum triples per subject to attempt a complex multi-triple question
_MIN_TRIPLES_FOR_COMPLEX       = 2

# Lazy-loaded sentence-transformer for semantic distractor filtering.
# Loaded at most once per process lifetime.
_ST_MODEL = None

def _get_st_model():
    """Return a cached SentenceTransformer for semantic distractor filtering."""
    global _ST_MODEL
    if _ST_MODEL is None:
        try:
            from sentence_transformers import SentenceTransformer
            _ST_MODEL = SentenceTransformer("all-MiniLM-L6-v2")
            logger.debug("Loaded SentenceTransformer for distractor filtering.")
        except ImportError:
            logger.warning(
                "sentence-transformers not installed — semantic distractor "
                "filtering disabled. Run: pip install sentence-transformers"
            )
    return _ST_MODEL


def _cosine_similarity(a: str, b: str) -> float:
    """Quick cosine similarity between two strings. Returns 0.0 if ST unavailable."""
    model = _get_st_model()
    if model is None:
        return 1.0   # no filter if ST unavailable — let all distractors through
    import numpy as np
    vecs = model.encode([a, b])
    num  = float(np.dot(vecs[0], vecs[1]))
    den  = float(np.linalg.norm(vecs[0]) * np.linalg.norm(vecs[1]) + 1e-9)
    return max(0.0, min(1.0, num / den))


def _normalize_triple_text(text: str) -> str:
    text = (text or "").strip().lower()
    text = _LEADING_ARTICLES.sub("", text)
    text = re.sub(r"\s+", " ", text)
    return text


def deduplicate_relations(relations: list[dict]) -> list[dict]:
    """
    Collapse relations that express the same triple with superficial wording
    differences such as article prefixes or case differences.
    """
    deduped: list[dict] = []
    seen_keys: set[tuple[str, str, str]] = set()

    for relation in relations:
        key = (
            _normalize_triple_text(relation.get("subject", "")),
            _normalize_triple_text(relation.get("relation", "")),
            _normalize_triple_text(relation.get("object", "")),
        )
        if key in seen_keys:
            continue
        seen_keys.add(key)
        deduped.append(relation)

    return deduped


@dataclass
class TripleScore:
    subject: str
    relation: str
    object: str
    chunk_id: str
    score: float
    relation_weight: float
    subject_centrality: float
    object_centrality: float
    source_support: float
    answer_specificity: float
    distinctness: float
    reasons: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return asdict(self)


def _clamp(value: float, lower: float = 0.0, upper: float = 1.0) -> float:
    return max(lower, min(upper, value))


def _relation_weight(relation: str) -> float:
    return _GENERIC_RELATION_WEIGHTS.get(_normalize_triple_text(relation).upper(), 0.7)


def _specificity_score(text: str) -> float:
    normalized = _normalize_triple_text(text)
    if not normalized:
        return 0.0
    tokens = normalized.split()
    token_count = len(tokens)
    char_count = len(normalized.replace(" ", ""))

    token_score = 1.0
    if token_count == 1:
        token_score = 0.55
    elif token_count == 2:
        token_score = 0.8
    elif 3 <= token_count <= 6:
        token_score = 1.0
    elif token_count > 8:
        token_score = 0.75

    char_score = _clamp((char_count - 2) / 10.0)
    return _clamp((token_score * 0.6) + (char_score * 0.4))


def _source_support_score(subject: str, object_: str, chunk_text: str) -> float:
    if not chunk_text:
        return 0.0

    text = chunk_text.lower()
    subj = subject.lower()
    obj = object_.lower()

    subject_present = subj in text
    object_present = obj in text

    if subject_present and object_present:
        return 1.0
    if subject_present:
        return 0.65
    if object_present:
        return 0.4
    return 0.1


def score_relations(
    relations: list[dict],
    chunk_map: dict[str, str],
    mention_count: dict[str, int],
    max_context_chars: int,
) -> list[TripleScore]:
    context_matches = build_context_matches(relations, chunk_map, max_context_chars)
    max_mentions = max(mention_count.values(), default=1)

    scores: list[TripleScore] = []
    for relation in relations:
        subject = relation.get("subject", "")
        predicate = relation.get("relation", "")
        object_ = relation.get("object", "")
        key = f"{subject}||{predicate}||{object_}"
        match = context_matches.get(key, {})
        chunk_id = match.get("chunk_id", "")
        chunk_text = match.get("text", "")

        subject_centrality = _clamp(mention_count.get(subject, 0) / max_mentions)
        object_centrality = _clamp(mention_count.get(object_, 0) / max_mentions)
        relation_weight = _relation_weight(predicate)
        source_support = _source_support_score(subject, object_, chunk_text)
        answer_specificity = _specificity_score(object_)
        distinctness = 0.0 if _normalize_triple_text(subject) == _normalize_triple_text(object_) else 1.0

        score = (
            relation_weight * 0.22
            + subject_centrality * 0.22
            + object_centrality * 0.12
            + source_support * 0.24
            + answer_specificity * 0.12
            + distinctness * 0.08
        )

        reasons = [
            f"relation={relation_weight:.2f}",
            f"subject_centrality={subject_centrality:.2f}",
            f"object_centrality={object_centrality:.2f}",
            f"source_support={source_support:.2f}",
            f"specificity={answer_specificity:.2f}",
            f"distinctness={distinctness:.2f}",
        ]
        scores.append(
            TripleScore(
                subject=subject,
                relation=predicate,
                object=object_,
                chunk_id=chunk_id,
                score=round(score, 4),
                relation_weight=round(relation_weight, 4),
                subject_centrality=round(subject_centrality, 4),
                object_centrality=round(object_centrality, 4),
                source_support=round(source_support, 4),
                answer_specificity=round(answer_specificity, 4),
                distinctness=round(distinctness, 4),
                reasons=reasons,
            )
        )

    return scores


def build_context_matches(
    relations: list[dict],
    chunk_map: dict[str, str],
    max_context_chars: int,
) -> dict[str, dict[str, str]]:
    """
    For each triple, choose the best supporting chunk and retain both
    the truncated context text and the winning chunk_id.
    """
    all_chunks = list(chunk_map.items())
    context_map: dict[str, dict[str, str]] = {}

    for r in relations:
        key = f"{r['subject']}||{r['relation']}||{r['object']}"
        subj_lc = r["subject"].lower()
        obj_lc = r["object"].lower()

        best_chunk_id = ""
        best_text = ""

        for chunk_id, text in all_chunks:
            tl = text.lower()
            if subj_lc in tl and obj_lc in tl:
                best_chunk_id = chunk_id
                best_text = text
                break
        if not best_text:
            for chunk_id, text in all_chunks:
                if subj_lc in text.lower():
                    best_chunk_id = chunk_id
                    best_text = text
                    break
        if not best_text and all_chunks:
            best_chunk_id, best_text = all_chunks[0]

        context_map[key] = {
            "chunk_id": best_chunk_id,
            "text": best_text[:max_context_chars],
        }

    return context_map

# Question dataclass
@dataclass
class Question:
    """
    A fully assembled question ready for Neo4j storage.

    q_type is assigned AFTER graph distractor selection:
      "mcq"   → graph supplied ≥3 distractors
      "short" → graph could not supply ≥3 distractors

    distractor_distances: {distractor_text: hop_distance}
      distance=1 hardest (student confusion = subtle misconception)
      distance=3 easiest (student confusion = surface-level error)
    """
    doc_id:       str
    question:     str
    q_type:       str
    correct:      str
    concept:      str
    relation:     str
    difficulty:   str
    source_chunk: str

    options:              list[str]       = field(default_factory=list)
    distractor_distances: dict[str, int]  = field(default_factory=dict)
    question_id:          str             = ""
    combined_triples:     list[dict]      = field(default_factory=list)  # for multi-triple questions

    def is_valid(self) -> bool:
        if not self.question.strip() or not self.correct.strip():
            return False
        if self.q_type == "mcq":
            return len(self.options) == 4 and self.correct in self.options
        return self.q_type == "short"


# ── Prompts for complex multi-triple questions ────────────────────────────────
_COMPLEX_SYSTEM_PROMPT = """\
You are an expert question setter for school-level education.

You will be given MULTIPLE knowledge-graph relationships for the SAME subject entity
and the passage of text they were extracted from. Write ONE complex exam question
that requires a student to understand TWO OR MORE of these relationships together —
not just any single fact in isolation.

Return ONLY a valid JSON object with exactly these four fields.
Every value MUST be a quoted string.

Example of correct output format:
{"question": "What role did the Great Bath play in Harappan society, and where was it located?", "correct": "A large public bathing structure in Mohenjodaro, likely used for ritual purification", "difficulty": "hard", "concept": "Great Bath"}

Field definitions:
  "question"   – complex question requiring understanding of multiple relationships, ends with ?
  "correct"    – complete answer that addresses the full question, one or two concise sentences
  "difficulty" – exactly one of: "easy", "medium", "hard"
  "concept"    – the subject entity these relationships share

Complexity guidelines:
- Combine cause-and-effect, function-and-location, or role-and-significance relationships.
- Prefer "How did X relate to Y?" or "Why was X important for Z?" or "What does X tell us about Y?"
- The correct answer must synthesise at least two facts from the relationships provided.
- Do NOT create a question answerable from just one relationship.

Rules:
- Question must be answerable from the provided text.
- Correct answer must synthesise multiple relationships, not just name one.
- Do NOT include answer options — handled separately.
- Return ONLY the JSON object. No markdown, no explanation, no code fences.\
"""

_COMPLEX_USER_TEMPLATE = """\
Subject: {subject}

Relationships involving {subject}:
{relationships}

Source text:
{context}

Write ONE complex question that requires understanding MULTIPLE of the above relationships together.\
"""

# Prompts — minimal, one triple, no options requested
_SYSTEM_PROMPT = """\
You are an expert question setter for school-level education.

You will be given ONE knowledge-graph relationship and the passage of text
it was extracted from. Write ONE exam-quality question that tests a student's
understanding of that relationship.

Your goal is not just to check memory. Your goal is to help a student learn
the important ideas in the passage.

Return ONLY a valid JSON object with exactly these four fields.
Every value MUST be a quoted string — no bare words, no unquoted text.

Example of correct output format:
{"question": "Where was the Great Bath located?", "correct": "Mohenjodaro", "difficulty": "easy", "concept": "Great Bath"}

Field definitions:
  "question"   – question text, one sentence, ends with ?
  "correct"    – correct answer, one concise quoted phrase
  "difficulty" – exactly one of: "easy", "medium", "hard"
  "concept"    – copy the subject entity exactly as given

Guidance by relation type:
  LOCATED_IN / FOUND_IN    → ask "where" questions
  USED_FOR / PURPOSE       → ask "what was X used for"
  DISCOVERED_BY / BUILT_BY → ask "who" questions
  PART_OF / CONTAINS       → ask "what is X a part of"
  CAUSED_BY / LED_TO       → ask "what caused / what resulted from"
  SUPPLIED_BY / TRADED_BY  → ask "who supplied / who traded"

Pedagogical priorities:
- Prefer questions that test understanding of the main idea, function, cause,
  role, significance, or relationship between concepts.
- Prefer "how", "why", "what does this show", or "what is the role of"
  questions when the source text supports them.
- If the relation is too shallow for a strong conceptual question, rephrase it
  so the student must understand the concept, not just repeat a nearby phrase.
- Focus on the most educationally important fact in the source text, not the
  most obvious wording pattern.

Rules:
- Question must be answerable from the provided text.
- Correct answer must be a specific, quoted string — not a sentence fragment without quotes.
- Avoid trivial recall questions if a more conceptual question is possible from the same text.
- Avoid vague or overly generic answers such as "nothing", "thing", "place", or "the sky"
  unless the passage clearly teaches that exact idea as important content.
- Avoid copying the source wording too closely.
- Avoid questions whose only value is naming a location, membership, or label unless that fact is
  central to understanding the topic.
- Do NOT include answer options — handled separately.
- Return ONLY the JSON object. No markdown, no explanation, no code fences.\
"""

_USER_TEMPLATE = """\
Relationship:  {subject}  --[{relation}]-->  {object}

Source text:
{context}

Write a question that helps a student understand an important idea from this relationship and source text.\
"""

# Generator
class QuestionGenerator:
    """
    KG-first question generator.

    Usage
    -----
        with client.session() as session:
            generator = QuestionGenerator()
            questions = generator.generate_for_document(
                doc_id, relations, chunks, neo4j_session=session
            )
    """

    def __init__(
        self,
        model:             str = "llama-3.1-8b-instant",
        max_context_chars: int = 1200,
    ):
        """
        Parameters
        ----------
        model             : Groq model ID.
                            llama-3.1-8b-instant: 1,000,000 TPM free tier — no rate issues.
                            llama-3.3-70b-versatile: ~6,000 TPM free tier — hits limit fast.
                            For single-triple question generation, 8b quality is sufficient.
                            Switch to 70b only if question quality is noticeably poor.
        max_context_chars : Max source-text characters per Groq call.
        """
        try:
            from groq import Groq
            self._sync_client = Groq(api_key=os.environ["GROQ_API_KEY"])
        except ImportError:
            raise ImportError("groq not installed. Run: pip install groq")
        except KeyError:
            raise EnvironmentError("GROQ_API_KEY not set in .env")

        self.model             = model
        self.max_context_chars = max_context_chars


    # Public entry point
    def generate_for_document(
        self,
        doc_id:        str,
        relations:     list[dict],
        chunks:        list[dict],
        neo4j_session,
        max_questions: int = 15,
        top_concepts:  int = 15,
    ) -> list[Question]:
        """
        Generate questions for a document using the KG-first approach.

        Instead of processing all relations (can be 300+), this method:
          1. Fetches concept mention counts from the graph
          2. Picks the top `top_concepts` concepts by mention count
          3. Selects the single best relation per concept
          4. Caps the working set at `max_questions` triples
          5. Fires one Groq call per triple (concurrent, semaphore-bounded)
          6. Attaches graph distractors → assigns q_type

        This gives you focused, high-quality questions on the most
        important concepts rather than noise from rare triples.

        Args:
            doc_id        : Document identifier.
            relations     : from graph_service.get_relations_for_document()
            chunks        : from graph_service.get_chunks_for_document()
            neo4j_session : Open Neo4j session — required for distractor queries.
            max_questions : Hard cap on triples to send to Groq. Default 15.
            top_concepts  : How many top concepts to draw from. Default 15.
        """
        if not relations:
            logger.warning("No relations for doc_id='%s'.", doc_id)
            return []

        unique_relations = deduplicate_relations(relations)

        # Step 1 — select the most important triples
        selected = self._select_triples(
            unique_relations, doc_id, neo4j_session, top_concepts, max_questions
        )
        logger.info(
            "Triple selection: %d total → %d unique → %d selected (top %d concepts, cap %d)",
            len(relations), len(unique_relations), len(selected), top_concepts, max_questions,
        )

        chunk_map        = {c["chunk_id"]: c["text"] for c in chunks}
        context_matches  = build_context_matches(selected, chunk_map, self.max_context_chars)
        distractor_map = self._build_distractor_map(selected, doc_id, neo4j_session)

        mcq_eligible = sum(1 for v in distractor_map.values() if len(v) >= 3)
        logger.info(
            "Distractor map: %d concepts, %d MCQ-eligible",
            len(distractor_map), mcq_eligible,
        )

        logger.info(
            "Querying Groq sequentially for %d triples (~%ds) ...",
            len(selected), len(selected) * 2,
        )
        raw_results = self._generate_sequential(selected, context_matches, doc_id)

        questions   = []
        mcq_count   = 0
        short_count = 0
        dropped     = 0

        for raw in raw_results:
            if raw is None:
                dropped += 1
                continue
            q = self._attach_distractors(raw, distractor_map)
            if q.is_valid():
                questions.append(q)
                if q.q_type == "mcq":
                    mcq_count += 1
                else:
                    short_count += 1
            else:
                dropped += 1

        # ── Complex multi-triple questions ─────────────────────────────────
        # Generate additional complex questions that combine multiple
        # relationships for the same subject into one synthesising question.
        logger.info("Generating complex multi-triple questions ...")
        complex_qs = self._build_complex_questions(
            doc_id          = doc_id,
            relations       = unique_relations,
            context_matches = context_matches,
            distractor_map  = distractor_map,
            max_complex     = max(3, max_questions // 3),
        )
        for q in complex_qs:
            if q.q_type == "mcq":
                mcq_count += 1
            else:
                short_count += 1
        questions.extend(complex_qs)

        logger.info(
            "Generated %d questions total: %d MCQ, %d short, %d dropped (%d complex)",
            len(questions), mcq_count, short_count, dropped, len(complex_qs),
        )
        return questions


    # Triple selection — top concepts, one best relation each
    def _select_triples(
        self,
        relations:    list[dict],
        doc_id:       str,
        session,
        top_concepts: int,
        max_triples:  int,
    ) -> list[dict]:
        """
        Select the most pedagogically valuable triples to generate questions from.

        Strategy:
          1. Fetch mention_count for every concept from Neo4j.
             Concepts mentioned more often = more central to the document.
          2. Rank all subject concepts by mention_count descending.
          3. Take the top `top_concepts` concepts.
          4. For each selected concept, pick its single BEST relation:
             prefer specific relation types (LOCATED_IN, USED_FOR, BUILT_BY)
             over generic ones (CONNECTED_TO, RELATED_TO).
          5. Deduplicate and cap at `max_triples`.

        Returns list of relation dicts, one per selected concept.
        """
        from graph.concept_repository import ConceptRepository
        repo     = ConceptRepository(session)
        concepts = repo.find_concepts_for_document(doc_id)
        # concepts is already sorted by mention_count DESC from the repo

        # Build mention count lookup
        mention_count = {c["name"]: c.get("mention_count", 0) for c in concepts}

        chunk_ids_by_concept = {
            concept["name"]: repo.find_chunks_for_concept(concept["name"], doc_id)
            for concept in concepts
        }
        chunk_map = {}
        for relation in relations:
            for chunk_id in chunk_ids_by_concept.get(relation["subject"], []):
                if chunk_id in chunk_map:
                    continue
                result = session.run(
                    "MATCH (c:Chunk {chunk_id: $chunk_id}) RETURN c.text AS text",
                    chunk_id=chunk_id,
                ).single()
                if result and result["text"]:
                    chunk_map[chunk_id] = result["text"]

        scored_relations = score_relations(
            relations,
            chunk_map,
            mention_count,
            self.max_context_chars,
        )

        scores_by_subject: defaultdict[str, list[TripleScore]] = defaultdict(list)
        for score in scored_relations:
            scores_by_subject[score.subject].append(score)

        # Rank all unique subject concepts that appear in relations
        subjects_ranked = sorted(
            {r["subject"] for r in relations},
            key=lambda s: mention_count.get(s, 0),
            reverse=True,
        )[:top_concepts]

        # For each top concept, pick its best relation
        selected: list[dict] = []
        seen_subjects: set[str] = set()

        for subject in subjects_ranked:
            if len(selected) >= max_triples:
                break
            if subject in seen_subjects:
                continue

            candidate_scores = sorted(
                scores_by_subject.get(subject, []),
                key=lambda item: item.score,
                reverse=True,
            )
            if not candidate_scores:
                continue

            chosen_score = candidate_scores[0]
            chosen = {
                "subject": chosen_score.subject,
                "relation": chosen_score.relation,
                "object": chosen_score.object,
            }

            selected.append(chosen)
            seen_subjects.add(subject)

        return selected[:max_triples]


    # Step 1 — Context map: triple → best chunk text
    def _build_context_map(
        self,
        relations: list[dict],
        chunk_map: dict[str, str],
    ) -> dict[str, str]:
        """
        For each triple, find the chunk that best supports it.

        Preference order:
          1. Chunk containing BOTH subject and object text (exact match)
          2. Chunk containing just the subject
          3. First available chunk (fallback)

        Returns {triple_key: context_text} where
          triple_key = "{subject}||{relation}||{object}"
        """
        matches = build_context_matches(relations, chunk_map, self.max_context_chars)
        return {key: value["text"] for key, value in matches.items()}


    # Step 2 — Distractor map: subject → [{name, distance}]
    def _build_distractor_map(
        self,
        relations:    list[dict],
        doc_id:       str,
        session,
    ) -> dict[str, list[dict]]:
        """
        For every unique subject concept, fetch graph-distance neighbours
        up to 3 hops.

        Returns {concept_name: [{name: str, distance: int}, ...]}
        Concepts with 0 neighbours get an empty list — these will become
        SHORT questions regardless of what the LLM returns.
        """
        from graph.concept_repository import ConceptRepository
        repo     = ConceptRepository(session)
        subjects = list({r["subject"] for r in relations})

        distractor_map: dict[str, list[dict]] = {}
        for concept in subjects:
            distractor_map[concept] = repo.find_neighbours_by_distance(
                concept, doc_id, max_hops=3
            )

        return distractor_map

    # Step 3 — Sequential Groq calls, one per triple
    def _generate_sequential(
        self,
        relations:   list[dict],
        context_matches: dict[str, dict[str, str]],
        doc_id:      str,
        delay_s:     float = 1.0,
    ) -> list[Optional[dict]]:
        """
        Call Groq once per triple, sequentially.

        llama-3.1-8b-instant has 1M TPM on the free tier, so a 1s delay
        between 15 calls is plenty of headroom. Total time: ~15-20 seconds.
        """
        import time
        results = []
        total   = len(relations)

        for i, relation in enumerate(relations):
            key     = f"{relation['subject']}||{relation['relation']}||{relation['object']}"
            context_info = context_matches.get(key, {})
            context = context_info.get("text", "")
            prompt  = _USER_TEMPLATE.format(
                subject=relation["subject"],
                relation=relation["relation"],
                object=relation["object"],
                context=context,
            )

            print(f"  [{i+1:02d}/{total}] {relation['subject']} --[{relation['relation']}]--> {relation['object']}", flush=True)

            raw    = self._groq_call_sync(prompt)
            parsed = self._parse_single(raw) if raw else None

            if parsed:
                parsed["concept"]      = relation["subject"]
                parsed["relation"]     = relation["relation"]
                parsed["doc_id"]       = doc_id
                parsed["source_chunk"] = context_info.get("chunk_id", "")
                print(f"           ✓  {parsed['question'][:70]}", flush=True)
            else:
                print(f"           ✗  no response or parse failed", flush=True)

            results.append(parsed)

            # Always wait between calls — even after the last one in case
            # the caller invokes this method twice in a row
            if i < total - 1:
                time.sleep(delay_s)

        return results

    def _groq_call_sync(self, user_prompt: str) -> Optional[str]:
        """
        Synchronous Groq call. One attempt only — rate limit handling
        is done at the _generate_sequential level via inter-call delay.
        If a rate limit is hit here despite the delay, wait 30s (full
        TPM window reset) then retry once before giving up.
        """
        import time
        for attempt in range(1, 3):
            try:
                response = self._sync_client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": _SYSTEM_PROMPT},
                        {"role": "user",   "content": user_prompt},
                    ],
                    temperature=0.15,
                    max_tokens=200,
                )
                return response.choices[0].message.content

            except Exception as exc:
                err = str(exc).lower()
                if "rate" in err or "429" in err:
                    if attempt == 1:
                        print(f"           ⏳ Rate limit hit — waiting 30s for TPM window reset ...", flush=True)
                        time.sleep(30)
                    else:
                        logger.error("Rate limited again after 30s wait — skipping this triple")
                        return None
                else:
                    logger.warning("Groq error: %s", exc)
                    return None
        return None


    # Step 4 — Attach graph distractors → assign q_type


    def _attach_distractors(
        self,
        parsed:         dict,
        distractor_map: dict[str, list[dict]],
    ) -> Question:
        """
        Select graph-distance distractors with semantic topic filtering.

        Phase 1 — one distractor from each hop tier (1 → 2 → 3).
        Each candidate is checked for topic relevance via cosine similarity
        to the concept name before being accepted:
          hop 1 & 2: minimum similarity 0.12
          hop 3:     minimum similarity 0.18 (tighter — further from concept)

        This prevents off-topic concepts (e.g. "Photosynthesis" as a distractor
        for "Great Bath") sneaking in just because they are 3 hops away.

        Phase 2 — fill remainder from any tier if still < 3 after Phase 1.

        Difficulty (graph-topology-grounded):
          max distractor distance ≤ 1 → "hard"
          any distractor distance ≤ 2 → "medium"
          all distances ≥ 3           → "easy"
        """
        concept       = parsed.get("concept", "")
        correct       = parsed.get("correct", "")
        correct_lower = correct.lower()
        neighbours    = distractor_map.get(concept, [])

        # Group by distance, exclude correct answer
        by_dist: dict[int, list[dict]] = defaultdict(list)
        for n in neighbours:
            if n["name"].lower() != correct_lower:
                by_dist[n["distance"]].append(n)

        def _is_topically_valid(name: str, hop: int) -> bool:
            threshold = _DISTRACTOR_HOP3_THRESHOLD if hop >= 3 else _DISTRACTOR_TOPIC_THRESHOLD
            return _cosine_similarity(concept, name) >= threshold

        # Phase 1: one per tier, semantically filtered
        chosen:    list[str]      = []
        distances: dict[str, int] = {}

        for dist in sorted(by_dist.keys()):
            if len(chosen) >= 3:
                break
            for candidate in by_dist[dist]:
                name = candidate["name"]
                if name not in chosen and _is_topically_valid(name, dist):
                    chosen.append(name)
                    distances[name] = dist
                    break

        # Phase 2: fill remainder from any tier
        if len(chosen) < 3:
            for dist in sorted(by_dist.keys()):
                for candidate in by_dist[dist]:
                    name = candidate["name"]
                    if name not in chosen and _is_topically_valid(name, dist):
                        chosen.append(name)
                        distances[name] = dist
                    if len(chosen) >= 3:
                        break
                if len(chosen) >= 3:
                    break

        base_kwargs = dict(
            doc_id=parsed["doc_id"],
            question=parsed["question"],
            correct=correct,
            concept=concept,
            relation=parsed.get("relation", ""),
            difficulty=parsed.get("difficulty", "medium"),
            source_chunk=parsed.get("source_chunk", ""),
            combined_triples=parsed.get("combined_triples", []),
        )

        if len(chosen) < 3:
            logger.debug(
                "Concept '%s': only %d semantically valid distractors → SHORT",
                concept, len(chosen),
            )
            return Question(q_type="short", **base_kwargs)

        dist_values = list(distances.values())
        if max(dist_values) <= 1:
            difficulty = "hard"
        elif min(dist_values) <= 2:
            difficulty = "medium"
        else:
            difficulty = "easy"

        options = chosen[:3] + [correct]
        random.shuffle(options)

        return Question(
            q_type="mcq",
            options=options,
            distractor_distances=distances,
            **{**base_kwargs, "difficulty": difficulty},
        )

    # ── Complex multi-triple question generation ───────────────────────────────

    def _group_triples_by_subject(
        self, relations: list[dict]
    ) -> dict[str, list[dict]]:
        """
        Group relations by subject. Only subjects with ≥ MIN_TRIPLES_FOR_COMPLEX
        relations are returned — these are the candidates for multi-triple questions.
        """
        groups: dict[str, list[dict]] = defaultdict(list)
        for r in relations:
            groups[r["subject"]].append(r)
        return {
            subj: triples
            for subj, triples in groups.items()
            if len(triples) >= _MIN_TRIPLES_FOR_COMPLEX
        }

    def _build_complex_questions(
        self,
        doc_id:          str,
        relations:       list[dict],
        context_matches: dict[str, dict],
        distractor_map:  dict[str, list[dict]],
        max_complex:     int = 5,
    ) -> list[Question]:
        """
        For subjects that appear in multiple triples, generate ONE complex
        question that synthesises two or more relationships.

        Strategy:
          1. Group triples by subject.
          2. For each subject with ≥ 2 triples, pick the top 3 by score
             (using the relation_weight as a proxy when score is unavailable).
          3. Build a single Groq prompt listing all selected relationships
             and asking for a question that requires understanding multiple facts.
          4. Attach distractors from the subject concept's graph neighbours.

        At most `max_complex` complex questions are generated to avoid
        flooding the output with synthetic questions.
        """
        import time

        groups = self._group_triples_by_subject(relations)
        if not groups:
            return []

        # Rank subjects by how many strong triples they have
        ranked_subjects = sorted(
            groups.keys(),
            key=lambda s: len(groups[s]),
            reverse=True,
        )[:max_complex]

        complex_questions: list[Question] = []
        total = len(ranked_subjects)

        for i, subject in enumerate(ranked_subjects):
            triples = groups[subject]

            # Pick top 3 triples for this subject (prefer high-weight relations)
            top_triples = sorted(
                triples,
                key=lambda r: _GENERIC_RELATION_WEIGHTS.get(
                    r.get("relation", "").upper(), 0.5
                ),
                reverse=True,
            )[:3]

            # Build relationship list and gather best context
            rel_lines = "\n".join(
                f"  • {r['subject']} --[{r['relation']}]--> {r['object']}"
                for r in top_triples
            )

            # Pick the richest context chunk (prefer chunk that has both subj + obj)
            best_context = ""
            for r in top_triples:
                key = f"{r['subject']}||{r['relation']}||{r['object']}"
                info = context_matches.get(key, {})
                text = info.get("text", "")
                if len(text) > len(best_context):
                    best_context = text

            prompt = _COMPLEX_USER_TEMPLATE.format(
                subject=subject,
                relationships=rel_lines,
                context=best_context,
            )

            print(
                f"  [complex {i+1:02d}/{total}] {subject} ({len(top_triples)} triples)",
                flush=True,
            )

            raw    = self._groq_call_sync_complex(prompt)
            parsed = self._parse_single(raw) if raw else None

            if parsed:
                parsed["concept"]         = subject
                parsed["relation"]        = "MULTI"
                parsed["doc_id"]          = doc_id
                parsed["source_chunk"]    = context_matches.get(
                    f"{top_triples[0]['subject']}||{top_triples[0]['relation']}||{top_triples[0]['object']}",
                    {},
                ).get("chunk_id", "")
                parsed["combined_triples"] = [
                    {"subject": r["subject"], "relation": r["relation"], "object": r["object"]}
                    for r in top_triples
                ]

                q = self._attach_distractors(parsed, distractor_map)
                if q.is_valid():
                    complex_questions.append(q)
                    print(f"           ✓ complex: {q.question[:70]}", flush=True)
                else:
                    print(f"           ✗ invalid after distractor attach", flush=True)
            else:
                print(f"           ✗ no response or parse failed", flush=True)

            if i < total - 1:
                time.sleep(1.0)

        logger.info("Generated %d complex question(s).", len(complex_questions))
        return complex_questions

    def _groq_call_sync_complex(self, user_prompt: str) -> Optional[str]:
        """Groq call using the complex multi-triple system prompt."""
        import time
        for attempt in range(1, 3):
            try:
                response = self._sync_client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": _COMPLEX_SYSTEM_PROMPT},
                        {"role": "user",   "content": user_prompt},
                    ],
                    temperature=0.20,
                    max_tokens=300,
                )
                return response.choices[0].message.content
            except Exception as exc:
                err = str(exc).lower()
                if "rate" in err or "429" in err:
                    if attempt == 1:
                        print("           ⏳ Rate limit — waiting 30s ...", flush=True)
                        time.sleep(30)
                    else:
                        return None
                else:
                    logger.warning("Groq error (complex): %s", exc)
                    return None
        return None


    def _parse_single(self, raw: str) -> Optional[dict]:
        """
        Parse the LLM JSON response for one triple.
        Returns None on any parse failure rather than raising.

        Handles the common LLM mistake of returning unquoted string values:
          BAD:  {"question": Who built it?, "correct": Farmers}
          GOOD: {"question": "Who built it?", "correct": "Farmers"}

        The regex pre-pass wraps bare values in quotes before json.loads.
        """
        cleaned = re.sub(r"```(?:json)?", "", raw).strip()

        start = cleaned.find("{")
        end   = cleaned.rfind("}")
        if start == -1 or end == -1:
            return None

        json_str = cleaned[start: end + 1]
        json_str = re.sub(r",\s*([}\]])", r"\1", json_str)  # trailing commas

        # Fix unquoted string values:
        # Matches:  "key": some unquoted text here,
        # Replaces: "key": "some unquoted text here",
        # Only applies to keys we expect to have string values.
        def _quote_value(m):
            key = m.group(1)
            val = m.group(2).strip().rstrip(",").strip()
            # If already quoted, leave it alone
            if val.startswith('"') and val.endswith('"'):
                return m.group(0)
            # Strip stray quotes from the edges
            val = val.strip('"').strip("'")
            return f'"{key}": "{val}"'

        json_str = re.sub(
            r'"(question|correct|difficulty|concept)"\s*:\s*([^"\[{][^,}\]]*)',
            _quote_value,
            json_str,
        )

        try:
            data = json.loads(json_str)
        except json.JSONDecodeError:
            return None

        question = data.get("question", "").strip().strip('"')
        correct  = data.get("correct",  "").strip().strip('"')

        if not question or not correct:
            return None

        if not question.endswith("?"):
            question += "?"

        difficulty = data.get("difficulty", "medium").lower().strip().strip('"')
        if difficulty not in ("easy", "medium", "hard"):
            difficulty = "medium"

        return {
            "question":   question,
            "correct":    correct,
            "difficulty": difficulty,
            "concept":    data.get("concept", "").strip().strip('"'),
        }
