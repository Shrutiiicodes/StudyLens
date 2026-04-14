from __future__ import annotations

import os
from collections import defaultdict
from dataclasses import dataclass, field
from statistics import mean
from typing import Optional, Protocol


class SimilarityBackend(Protocol):
    def similarity(self, left: str, right: str) -> float:
        ...


class LLMScorer(Protocol):
    def score_answerability(self, question: str, source: str, answer: str) -> float:
        ...


class SentenceTransformerBackend:
    def __init__(self, model_name: str = "all-MiniLM-L6-v2") -> None:
        from sentence_transformers import SentenceTransformer, util

        self._model = SentenceTransformer(model_name)
        self._util = util

    def similarity(self, left: str, right: str) -> float:
        left_emb = self._model.encode(left, convert_to_tensor=True)
        right_emb = self._model.encode(right, convert_to_tensor=True)
        score = float(self._util.cos_sim(left_emb, right_emb)[0][0])
        return max(0.0, min(1.0, score))


class GroqAnswerabilityScorer:
    def __init__(self, model: str = "llama-3.1-70b-versatile") -> None:
        from groq import Groq

        self._client = Groq(api_key=os.getenv("GROQ_API_KEY"))
        self.model = model

    def score_answerability(self, question: str, source: str, answer: str) -> float:
        prompt = f"""Rate if this question can be answered from the source (0-100):

Source: {source[:800]}
Question: {question}
Answer: {answer}

Respond with just a number 0-100."""
        response = self._client.chat.completions.create(
            model=self.model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=10,
        )
        raw = (response.choices[0].message.content or "").strip()
        score = float(raw) / 100.0
        return max(0.0, min(1.0, score))


@dataclass
class QuestionScore:
    question: str
    q_type: str
    difficulty: str
    concept: str
    source_chunk: str
    answerability: float
    concept_relevance: float
    context_relevance: float
    relevance: float
    grammar: float
    clarity: float
    quality: float
    distractor_quality: Optional[float]
    overall: float


@dataclass
class QuestionEvaluationReport:
    doc_id: str
    total_questions: int
    evaluated_questions: int
    skipped_questions: int
    average_answerability: float
    average_relevance: float
    average_quality: float
    average_distractor_quality: Optional[float]
    overall_accuracy: float
    by_type: dict[str, int] = field(default_factory=dict)
    by_difficulty: dict[str, int] = field(default_factory=dict)
    excellent_count: int = 0
    good_count: int = 0
    moderate_count: int = 0
    poor_count: int = 0
    scores: list[QuestionScore] = field(default_factory=list)


class QuestionEvaluator:
    def __init__(
        self,
        use_llm: bool = True,
        similarity_backend: Optional[SimilarityBackend] = None,
        llm_scorer: Optional[LLMScorer] = None,
    ) -> None:
        self._similarity = similarity_backend or SentenceTransformerBackend()
        self._llm = llm_scorer

        if self._llm is None and use_llm:
            try:
                self._llm = GroqAnswerabilityScorer()
            except Exception:
                self._llm = None

    def evaluate_answerability(self, question: str, source: str, answer: str) -> float:
        if self._llm is not None:
            try:
                return self._llm.score_answerability(question, source, answer)
            except Exception:
                pass
        return self._similarity.similarity(f"{question} {answer}".strip(), source[:500])

    def evaluate_relevance(self, question: str, concept: str, source: str) -> tuple[float, float]:
        concept_rel = self._similarity.similarity(question, concept)
        context_rel = self._similarity.similarity(question, source[:500])
        return concept_rel, context_rel

    def evaluate_quality(self, question: str) -> tuple[float, float]:
        if not question.strip():
            return 0.0, 0.0

        score = 1.0
        if not question[0].isupper():
            score -= 0.2
        if not question.strip().endswith("?"):
            score -= 0.3

        word_count = len(question.split())
        if word_count < 3:
            score -= 0.3
        elif word_count > 50:
            score -= 0.1

        grammar = max(0.0, score)

        clarity = 1.0
        q_words = ["what", "when", "where", "who", "why", "how", "which", "is", "are", "do", "does"]
        if not any(qw in question.lower() for qw in q_words):
            clarity -= 0.3

        if word_count < 5:
            clarity -= 0.2
        elif word_count > 30:
            clarity -= 0.1

        return grammar, max(0.0, clarity)

    def evaluate_distractor_quality(
        self,
        correct: str,
        distractors: list[str],
        concept: str = "",
        distractor_distances: dict[str, int] | None = None,
    ) -> Optional[float]:
        """
        Score distractor quality on two independent axes then combine them.

        Axis 1 — Plausibility (vs correct answer)
        -------------------------------------------
        A good distractor is similar enough to the correct answer that a
        student who doesn't know might pick it, but not so similar that it's
        ambiguous. Target range: cosine similarity 0.30–0.70.

        Axis 2 — Topic relevance (vs concept)
        ---------------------------------------
        A distractor must be about the same topic as the concept being tested.
        Hop-3 graph neighbours can be completely off-topic — a distractor for
        "Great Bath" that is "Mesopotamia" is plausible, but one that is
        "Photosynthesis" is not. We penalise distractors whose similarity to
        the concept drops below 0.15 (essentially unrelated).

        The final score is plausibility * relevance_weight, where
        relevance_weight = 1.0 for sim >= 0.20, scales down to 0.0 at 0.05.

        distractor_distances: optional {distractor_text: hop_distance} from
        Question.distractor_distances. Hop-3 distractors get a tighter
        relevance check (threshold raised to 0.18) because they are known to
        be further from the concept in the graph.
        """
        if not distractors:
            return None

        dists = distractor_distances or {}
        scores: list[float] = []

        for distractor in distractors:
            # ── Axis 1: plausibility vs correct answer ────────────────────
            sim_correct = self._similarity.similarity(correct, distractor)
            if 0.30 <= sim_correct <= 0.70:
                plausibility = 1.0
            elif sim_correct < 0.30:
                plausibility = sim_correct / 0.30
            else:
                plausibility = (1.0 - sim_correct) / 0.30
            plausibility = max(0.0, plausibility)

            # ── Axis 2: topic relevance vs concept ────────────────────────
            if concept:
                sim_topic = self._similarity.similarity(concept, distractor)
                hop = dists.get(distractor, 2)
                # Tighter relevance threshold for hop-3 (known off-topic risk)
                min_relevance = 0.18 if hop >= 3 else 0.12
                if sim_topic >= 0.20:
                    relevance_weight = 1.0
                elif sim_topic >= min_relevance:
                    # Linear ramp from min_relevance → 0.20
                    relevance_weight = (sim_topic - min_relevance) / (0.20 - min_relevance)
                else:
                    relevance_weight = 0.0   # Off-topic — hard penalty
                relevance_weight = max(0.0, min(1.0, relevance_weight))
            else:
                relevance_weight = 1.0

            scores.append(plausibility * relevance_weight)

        return mean(scores) if scores else None

    def evaluate_question(self, question_row: dict, source: str) -> QuestionScore:
        answerability = self.evaluate_answerability(
            question_row["question"], source, question_row.get("correct", "")
        )
        concept_rel, context_rel = self.evaluate_relevance(
            question_row["question"], question_row.get("concept", ""), source
        )
        grammar, clarity = self.evaluate_quality(question_row["question"])

        relevance = (concept_rel + context_rel) / 2.0
        quality = (grammar + clarity) / 2.0

        distractor_quality = None
        q_type = question_row.get("q_type", "unknown")
        if q_type == "mcq" and question_row.get("options"):
            distractors = [
                option for option in question_row["options"]
                if option != question_row.get("correct")
            ]
            distractor_quality = self.evaluate_distractor_quality(
                correct              = question_row.get("correct", ""),
                distractors          = distractors,
                concept              = question_row.get("concept", ""),
                distractor_distances = question_row.get("distractor_distances"),
            )

        overall = (answerability * 0.35 + relevance * 0.30 + quality * 0.35)
        if distractor_quality is not None:
            overall = overall * 0.85 + distractor_quality * 0.15

        return QuestionScore(
            question=question_row["question"],
            q_type=q_type,
            difficulty=question_row.get("difficulty", "unknown"),
            concept=question_row.get("concept", ""),
            source_chunk=question_row.get("source_chunk", ""),
            answerability=answerability,
            concept_relevance=concept_rel,
            context_relevance=context_rel,
            relevance=relevance,
            grammar=grammar,
            clarity=clarity,
            quality=quality,
            distractor_quality=distractor_quality,
            overall=overall,
        )

    def evaluate_questions(
        self,
        doc_id: str,
        questions: list[dict],
        chunks_by_id: dict[str, str],
    ) -> QuestionEvaluationReport:
        scores: list[QuestionScore] = []
        skipped_questions = 0
        by_type: defaultdict[str, int] = defaultdict(int)
        by_difficulty: defaultdict[str, int] = defaultdict(int)

        for question in questions:
            chunk_id = question.get("source_chunk", "")
            source = chunks_by_id.get(chunk_id, "")
            if not source:
                skipped_questions += 1
                continue

            score = self.evaluate_question(question, source)
            scores.append(score)
            by_type[score.q_type] += 1
            by_difficulty[score.difficulty] += 1

        if not scores:
            return QuestionEvaluationReport(
                doc_id=doc_id,
                total_questions=len(questions),
                evaluated_questions=0,
                skipped_questions=skipped_questions,
                average_answerability=0.0,
                average_relevance=0.0,
                average_quality=0.0,
                average_distractor_quality=None,
                overall_accuracy=0.0,
                by_type=dict(by_type),
                by_difficulty=dict(by_difficulty),
                scores=[],
            )

        distractor_scores = [
            score.distractor_quality
            for score in scores
            if score.distractor_quality is not None
        ]
        overall_values = [score.overall for score in scores]

        return QuestionEvaluationReport(
            doc_id=doc_id,
            total_questions=len(questions),
            evaluated_questions=len(scores),
            skipped_questions=skipped_questions,
            average_answerability=mean(score.answerability for score in scores),
            average_relevance=mean(score.relevance for score in scores),
            average_quality=mean(score.quality for score in scores),
            average_distractor_quality=(
                mean(distractor_scores) if distractor_scores else None
            ),
            overall_accuracy=mean(overall_values),
            by_type=dict(by_type),
            by_difficulty=dict(by_difficulty),
            excellent_count=sum(1 for value in overall_values if value >= 0.8),
            good_count=sum(1 for value in overall_values if 0.6 <= value < 0.8),
            moderate_count=sum(1 for value in overall_values if 0.4 <= value < 0.6),
            poor_count=sum(1 for value in overall_values if value < 0.4),
            scores=scores,
        )
