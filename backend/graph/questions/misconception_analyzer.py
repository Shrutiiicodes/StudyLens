"""
graph/misconception_analyzer.py
KG-grounded misconception analysis.

Design principle
----------------
Scoring and gap identification are deterministic — derived entirely from
the knowledge graph structure. The LLM's only job is to write the
human-readable explanation of a gap that the graph has already identified.

This means:
  - Scores are reproducible (same answer always gets same score)
  - Misconception labels come from graph topology, not LLM opinion
  - The LLM cannot hallucinate a gap that doesn't exist in the graph
  - Evaluation works even if the Groq call fails (fallback explanation)

MCQ evaluation
--------------
The question stores distractor_distances: {option_text: hop_distance}.
Scoring is purely distance-based:
  - Correct answer              → score = 1.0
  - Distance-1 wrong answer     → score = 0.4  (subtle gap — closely related concept)
  - Distance-2 wrong answer     → score = 0.2  (moderate gap)
  - Distance-3+ wrong answer    → score = 0.0  (fundamental gap)

The KG path between correct and chosen concept is retrieved and passed to
the LLM, which explains specifically what conceptual link the student missed.

Short answer evaluation
-----------------------
The question carries:
  concept  (subject of the triple, e.g. "Harappan Cities")
  relation (edge type, e.g. "SUPPLIED_BY")
  correct  (object of the triple, e.g. "Farmers And Herders")

Three checks run in order, each contributing to the score:
  1. Object check    — does the student answer contain / imply the correct object?
                       Exact or fuzzy match against correct answer text.
                       Weight: 0.6  (the most important — what is the answer?)
  2. Relation check  — does the answer imply the correct relation type?
                       Keyword heuristics per relation category.
                       Weight: 0.25
  3. Subject check   — does the answer demonstrate understanding of the subject?
                       Checks if subject concept appears or is implied.
                       Weight: 0.15

Severity tiers
--------------
  CORRECT  ≥ 0.85   → full marks
  CLOSE    0.60-0.84 → right idea, wrong detail
  PARTIAL  0.30-0.59 → partial understanding
  CRITICAL < 0.30   → fundamental gap
"""

import json
import logging
import os
import re
import time
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)


# Severity
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

# Result dataclass
@dataclass
class MisconceptionResult:
    """
    Full evaluation result for one student answer.

    Fields used in the report
    -------------------------
    severity            : CORRECT / CLOSE / PARTIAL / CRITICAL
    score               : 0.0 – 1.0  (deterministic, not LLM-assigned)
    is_correct          : score >= 0.85
    misconception_label : Short label e.g. "Confused supplier with trader"
    gap_description     : What specific conceptual link was missed
    correct_explanation : What the correct answer means in context
    hint                : Socratic nudge toward the right answer
    kg_path             : The graph path between chosen and correct concept
                          (MCQ only) — shown in report as evidence
    checks              : For short answer — {"object": bool, "relation": bool,
                          "subject": bool}
    """
    question_id:         str
    student_answer:      str
    is_correct:          bool
    score:               float
    severity:            str
    misconception_label: str
    gap_description:     str
    correct_explanation: str
    hint:                str
    attempt_id:          str             = ""
    kg_path:             list[str]       = field(default_factory=list)
    checks:              dict[str, bool] = field(default_factory=dict)
    distractor_distance: Optional[int]  = None   # MCQ only


# Relation keyword heuristics for short-answer relation check
_RELATION_KEYWORDS: dict[str, list[str]] = {
    "LOCATED_IN":    ["located", "found", "in", "at", "city", "place", "site"],
    "FOUND_IN":      ["found", "discovered", "located", "in", "at"],
    "USED_FOR":      ["used", "purpose", "function", "for", "served"],
    "SUPPLIED_BY":   ["supplied", "provided", "sent", "came from", "source"],
    "PART_OF":       ["part of", "belongs to", "component", "section", "member"],
    "BUILT_BY":      ["built", "constructed", "made", "created", "erected"],
    "DISCOVERED_BY": ["discovered", "found", "excavated", "unearthed"],
    "PRODUCED_BY":   ["produced", "made", "created", "manufactured"],
    "TRADED_BY":     ["traded", "exchanged", "sold", "bought", "commerce"],
    "CAUSED_BY":     ["caused", "led to", "resulted from", "because", "due to"],
    "LED_TO":        ["led to", "caused", "resulted in", "brought about"],
}


# LLM prompts — explanation only, scoring already done
_SYSTEM_PROMPT = """\
You are an educational feedback writer for school-level history.

You will be given:
- A question and the correct answer
- A student's wrong answer
- The specific conceptual gap already identified (you do not re-evaluate correctness)
- The knowledge graph path between the student's answer and the correct answer (if available)

Your job is to write THREE short pieces of text:
1. "gap_description"     – 1-2 sentences explaining exactly what conceptual link the student missed.
                           Be specific. Refer to the actual concepts involved.
2. "correct_explanation" – 1-2 sentences explaining why the correct answer is correct,
                           in plain language a school student can understand.
3. "hint"                – 1 Socratic question that guides the student toward the right answer
                           WITHOUT revealing it. Point to a specific aspect to reconsider.

Return ONLY a JSON object with these three string fields.
Example:
{
  "gap_description": "The student identified traders as the food source, but traders exchanged goods between cities — they did not grow or herd food themselves. The direct suppliers were farmers and herders.",
  "correct_explanation": "Harappan cities depended on farmers and herders in surrounding villages who sent food into the cities. Traders played a different role — moving goods between regions.",
  "hint": "Who actually produces food — the people who grow and raise it, or the people who move it between places?"
}

Rules:
- Never reveal the correct answer directly in the hint.
- gap_description must reference the specific wrong concept the student chose.
- Keep all three fields under 3 sentences each.
- Return ONLY the JSON. No markdown, no preamble.\
"""

_USER_TEMPLATE = """\
Question: {question}
Correct answer: {correct}
Student's answer: {student_answer}
Misconception label: {label}
KG path (correct → wrong concept): {kg_path}
Source text: {source_text}

Write the gap_description, correct_explanation, and hint.\
"""

# Analyzer
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
            student_answer = chosen_option,       # MCQ: exact option text
            q_type         = q["q_type"],
            concept        = q["concept"],
            relation       = q["relation"],
            distractor_distances = q["distractor_distances"],  # MCQ
            neo4j_session  = session,
            source_text    = chunk_text,
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

   
    # Public entry point
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
        distractor_distances: dict[str, int] = None,   # MCQ only
        source_text:          str = "",
        doc_id:               str = "",
    ) -> MisconceptionResult:
        """
        Evaluate one student answer using the KG-first approach.

        Steps:
          1. Blank/empty answer → immediate CRITICAL result, no Groq call.
          2. Correct answer check (exact + normalised) → CORRECT, no Groq call.
          3. Score deterministically from KG (MCQ: distance; SHORT: triple checks).
          4. Retrieve KG path between wrong and correct concept (for explanation).
          5. Call Groq to write the human-readable explanation of the identified gap.
          6. Return MisconceptionResult.
        """
        # Step 1 — blank answer
        if not student_answer.strip():
            return self._blank_result(question_id, student_answer, correct_answer)

        # Step 2 — correct answer
        if self._is_correct(student_answer, correct_answer):
            return self._correct_result(
                question_id, student_answer, correct_answer,
                question_text, source_text
            )

        # Step 3 — deterministic scoring
        if q_type == "mcq":
            score, dist, label = self._score_mcq(
                student_answer, correct_answer, distractor_distances or {}
            )
            checks = {}
        else:
            score, checks, label = self._score_short(
                student_answer, correct_answer, concept, relation
            )
            dist = None

        severity = Severity.from_score(score)

        # Step 4 — KG path (best-effort, non-fatal)
        kg_path = []
        try:
            kg_path = self._get_kg_path(
                student_answer, correct_answer, concept, doc_id, neo4j_session
            )
        except Exception as e:
            logger.debug("KG path lookup failed (non-fatal): %s", e)

        # Step 5 — LLM writes explanation
        explanation = self._explain(
            question_text, correct_answer, student_answer,
            label, kg_path, source_text
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
            hint=explanation.get("hint", ""),
            kg_path=kg_path,
            checks=checks,
            distractor_distance=dist,
        )

   
    # Step 2 — Correct answer check
   

    def _is_correct(self, student: str, correct: str) -> bool:
        """
        Normalised string match — case-insensitive, strips punctuation.
        For MCQ this is an exact option match.
        For short answer, checks if the correct answer text appears in the response.
        """
        def norm(s):
            return re.sub(r"[^\w\s]", "", s.lower()).strip()

        s = norm(student)
        c = norm(correct)

        # Exact match
        if s == c:
            return True
        # Student answer contains the correct answer (short answer leniency)
        if c in s:
            return True
        # Correct answer contains the student answer (student was brief but right)
        if len(s) > 3 and s in c:
            return True
        return False

   
    # Step 3a — MCQ scoring
    def _score_mcq(
        self,
        student_answer:       str,
        correct_answer:       str,
        distractor_distances: dict[str, int],
    ) -> tuple[float, Optional[int], str]:
        """
        Score an MCQ answer purely from graph hop distance.

        Returns (score, distance, misconception_label).

        Distance → score mapping:
          1 → 0.4  The student picked a directly-connected concept.
                   They understand the topic area but confused adjacent concepts.
          2 → 0.2  Two hops away — related domain, wrong specific fact.
          3+ → 0.0 Far from correct — fundamental gap or guessing.
        """
        distance = distractor_distances.get(student_answer)

        if distance is None:
            # Option not in our map (shouldn't happen, but handle gracefully)
            distance = 3

        score_map = {1: 0.4, 2: 0.2}
        score = score_map.get(distance, 0.0)

        label_map = {
            1: f"Confused closely related concepts: '{student_answer}' vs '{correct_answer}'",
            2: f"Mixed up concepts in the same domain: chose '{student_answer}'",
        }
        label = label_map.get(distance,
                               f"Fundamental gap: chose '{student_answer}' (far from correct)")

        return score, distance, label

    # Step 3b — Short answer scoring
    def _score_short(
        self,
        student_answer: str,
        correct_answer: str,
        concept:        str,
        relation:       str,
    ) -> tuple[float, dict[str, bool], str]:
        """
        Score a short answer on three independent dimensions:

          Object check (0.60 weight)  — did they get the right answer entity?
          Relation check (0.25 weight) — did they identify the right relationship?
          Subject check (0.15 weight) — do they understand what the question is about?

        Returns (score, checks_dict, misconception_label).
        """
        s_lower   = student_answer.lower()
        c_lower   = correct_answer.lower()
        con_lower = concept.lower()

        # Object check — partial credit for partial matches
        obj_score = 0.0
        correct_words = set(re.sub(r"[^\w\s]", "", c_lower).split()) - {"the", "a", "an", "and", "of"}
        student_words = set(re.sub(r"[^\w\s]", "", s_lower).split())
        if correct_words:
            overlap = len(correct_words & student_words) / len(correct_words)
            obj_score = min(overlap, 1.0)
        object_ok = obj_score >= 0.5

        # Relation check — keyword heuristics
        rel_keywords = _RELATION_KEYWORDS.get(relation.upper(), [])
        relation_ok = any(kw in s_lower for kw in rel_keywords) if rel_keywords else True

        # Subject check — does the answer acknowledge what the question is about?
        concept_words = set(re.sub(r"[^\w\s]", "", con_lower).split()) - {"the", "a", "an"}
        subject_ok = any(w in s_lower for w in concept_words) if concept_words else True

        checks = {
            "object":   object_ok,
            "relation": relation_ok,
            "subject":  subject_ok,
        }

        score = (
            (obj_score * 0.60) +
            (1.0 if relation_ok else 0.0) * 0.25 +
            (1.0 if subject_ok else 0.0) * 0.15
        )

        # Build label from which checks failed
        failed = [k for k, v in checks.items() if not v]
        rel_readable = relation.lower().replace("_", " ")
        if not failed:
            label = "Minor wording issue — answer is essentially correct"
        elif failed == ["object"]:
            label = f"Wrong answer for {concept} — did not identify the correct {rel_readable}"
        elif failed == ["relation"]:
            label = f"Correct topic but wrong relationship type — expected {rel_readable}"
        elif "object" in failed and "relation" in failed:
            label = f"Fundamental gap on {concept} — wrong answer and wrong relationship"
        else:
            label = f"Incomplete answer on {concept} — missing: {', '.join(failed)}"

        return round(score, 2), checks, label

    # Step 4 — KG path between wrong and correct concept
    def _get_kg_path(
        self,
        student_answer: str,
        correct_answer: str,
        concept:        str,
        doc_id:         str,
        session,
    ) -> list[str]:
        """
        Find the shortest path in the KG between:
          - The correct answer concept (object of the triple)
          - The student's chosen concept (wrong answer)

        Returns a list of strings describing the path, e.g.:
          ["Great Bath -[LOCATED_IN]-> Mohenjodaro",
           "Harappa -[PART_OF]-> Harappan Civilization",
           "Mohenjodaro -[PART_OF]-> Harappan Civilization"]

        This path is passed to the LLM so it can explain *specifically*
        what relationship the student confused.

        Non-fatal — returns [] if concepts not found in graph.
        """
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

   
    # Step 5 — LLM explains the identified gap
    def _explain(
        self,
        question:       str,
        correct:        str,
        student_answer: str,
        label:          str,
        kg_path:        list[str],
        source_text:    str,
    ) -> dict:
        """
        Call the LLM to write gap_description, correct_explanation, and hint.
        The LLM receives the already-identified misconception label and KG path —
        it does not re-evaluate correctness. It only writes explanatory text.

        Returns dict with keys: gap_description, correct_explanation, hint.
        Falls back to a template-based explanation if Groq fails.
        """
        kg_path_str = (
            " → ".join(kg_path) if kg_path
            else "Path not available in graph."
        )
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
                return self._parse_explanation(raw)

            except Exception as exc:
                err = str(exc).lower()
                if "rate" in err or "429" in err:
                    logger.warning("Rate limit on explanation call — waiting 30s")
                    time.sleep(30)
                else:
                    logger.warning("Groq explanation error (attempt %d): %s", attempt, exc)
                    time.sleep(2)

        # Fallback — template-based, no LLM needed
        return self._fallback_explanation(label, correct, student_answer)

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
                "hint":                str(data.get("hint", "")).strip(),
            }
        except json.JSONDecodeError:
            return {}

    def _fallback_explanation(
        self, label: str, correct: str, student_answer: str
    ) -> dict:
        """Template-based fallback when LLM is unavailable."""
        return {
            "gap_description":     f"{label}. The answer '{student_answer}' does not match the expected concept.",
            "correct_explanation": f"The correct answer is '{correct}'. Review the relevant section of your notes for more detail.",
            "hint":                "Look at the specific relationship being asked about — what does the source text say connects these two concepts?",
        }

   
    # Fast-path results
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
            correct_explanation=f"The correct answer is '{correct_answer}'.",
            hint="Attempt the question — even a partial answer helps identify what you know.",
        )

    def _correct_result(
        self,
        question_id:    str,
        student_answer: str,
        correct_answer: str,
        question_text:  str,
        source_text:    str,
    ) -> MisconceptionResult:
        """Generate a correct-answer result with a brief explanation."""
        # For correct answers, get a short explanation without LLM overhead
        # by using a minimal prompt
        explanation = self._explain_correct(correct_answer, question_text, source_text)
        return MisconceptionResult(
            question_id=question_id,
            student_answer=student_answer,
            is_correct=True,
            score=1.0,
            severity=Severity.CORRECT,
            misconception_label="",
            gap_description="",
            correct_explanation=explanation,
            hint="",
        )

    def _explain_correct(
        self, correct_answer: str, question_text: str, source_text: str
    ) -> str:
        """
        One-sentence reinforcement for a correct answer.
        Explains WHY it's right from the source — does not echo the answer string.
        """
        if not source_text:
            return "Well done — that's correct."

        prompt = (
            f"Question: {question_text}\n"
            f"Correct answer: {correct_answer}\n"
            f"Source: {source_text[:400]}\n\n"
            f"Write ONE sentence explaining why this answer is correct, "
            f"in plain language for a school student. "
            f"Do not start with 'Correct' and do not repeat the answer word for word. "
            f"Return ONLY the sentence."
        )
        try:
            response = self._client.chat.completions.create(
                model=self.model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.2,
                max_tokens=80,
            )
            return response.choices[0].message.content.strip().strip('"')
        except Exception:
            return "Well done — that's correct."