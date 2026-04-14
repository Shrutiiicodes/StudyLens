"""
graph/attempt_repository.py
Neo4j writes and reads for (:Attempt) nodes.

Graph schema managed here
--------------------------
Nodes
    (:Attempt {
        attempt_id, question_id, student_answer,
        is_correct, score, misconception,
        explanation, correct_explanation, hint,
        created_at
    })

Relationships
    (:Attempt)-[:ANSWERS]->(:Question)
        Every attempt is linked to the question it answers.

    (:Attempt)-[:HAS_MISCONCEPTION {label}]->(:Question)
        Only created when is_correct=False. The label property
        carries the misconception string for easy graph querying:

        MATCH (a:Attempt)-[m:HAS_MISCONCEPTION]->(q:Question)
        RETURN m.label, count(*) AS frequency
        ORDER BY frequency DESC

        This lets you see which misconceptions are most common
        across all students for a document — useful analytics.
"""

import logging
import time
import uuid
from typing import Optional

from neo4j import Session

from .misconception_analyzer import MisconceptionResult

logger = logging.getLogger(__name__)


class AttemptRepository:
    """
    Data-access object for (:Attempt) nodes.

    Usage
    -----
        with client.session() as session:
            repo = AttemptRepository(session)
            repo.save(result)
    """

    def __init__(self, session: Session):
        self._session = session

    # ------------------------------------------------------------------
    # Writes
    # ------------------------------------------------------------------

    def save(self, result: MisconceptionResult) -> MisconceptionResult:
        """
        Persist a MisconceptionResult as an (:Attempt) node.

        Assigns attempt_id if not already set.
        Creates ANSWERS relationship to the parent Question.
        Creates HAS_MISCONCEPTION relationship if answer is wrong.

        Returns:
            The result with attempt_id populated.
        """
        if not result.attempt_id:
            result.attempt_id = f"att_{uuid.uuid4().hex}"

        self._session.run(
            """
            MERGE (a:Attempt {attempt_id: $attempt_id})
            SET a.question_id          = $question_id,
                a.student_answer       = $student_answer,
                a.is_correct           = $is_correct,
                a.score                = $score,
                a.misconception        = $misconception,
                a.explanation          = $explanation,
                a.correct_explanation  = $correct_explanation,
                a.hint                 = $hint,
                a.created_at           = $created_at
            WITH a
            MATCH (q:Question {question_id: $question_id})
            MERGE (a)-[:ANSWERS]->(q)
            """,
            attempt_id=result.attempt_id,
            question_id=result.question_id,
            student_answer=result.student_answer,
            is_correct=result.is_correct,
            score=result.score,
            misconception=result.misconception,
            explanation=result.explanation,
            correct_explanation=result.correct_explanation,
            hint=result.hint,
            created_at=int(time.time()),
        )

        # Create misconception relationship for wrong answers
        if not result.is_correct and result.misconception:
            self._session.run(
                """
                MATCH (a:Attempt {attempt_id: $attempt_id})
                MATCH (q:Question {question_id: $question_id})
                MERGE (a)-[:HAS_MISCONCEPTION {label: $label}]->(q)
                """,
                attempt_id=result.attempt_id,
                question_id=result.question_id,
                label=result.misconception,
            )

        logger.info(
            "Saved Attempt %s — correct=%s, score=%.2f",
            result.attempt_id, result.is_correct, result.score,
        )
        return result

    # ------------------------------------------------------------------
    # Reads
    # ------------------------------------------------------------------

    def find_by_question(self, question_id: str) -> list[dict]:
        """Return all attempts for a question, newest first."""
        result = self._session.run(
            """
            MATCH (a:Attempt {question_id: $qid})
            RETURN a ORDER BY a.created_at DESC
            """,
            qid=question_id,
        )
        return [dict(r["a"]) for r in result]

    def get_misconception_summary(self, doc_id: str) -> list[dict]:
        """
        Return the most common misconceptions across all questions
        for a document. Useful for teacher analytics.

        Returns list of {misconception, frequency, avg_score} sorted
        by frequency descending.
        """
        result = self._session.run(
            """
            MATCH (a:Attempt)-[:ANSWERS]->(q:Question {doc_id: $doc_id})
            WHERE a.is_correct = false AND a.misconception <> ''
            RETURN a.misconception AS misconception,
                   count(a) AS frequency,
                   avg(a.score) AS avg_score
            ORDER BY frequency DESC
            LIMIT 20
            """,
            doc_id=doc_id,
        )
        return [dict(r) for r in result]

    def get_concept_mastery(self, doc_id: str) -> list[dict]:
        """
        Return per-concept average score across all attempts.
        Shows which concepts students are struggling with most.
        """
        result = self._session.run(
            """
            MATCH (a:Attempt)-[:ANSWERS]->(q:Question {doc_id: $doc_id})
            RETURN q.concept AS concept,
                   count(a) AS attempts,
                   avg(a.score) AS avg_score,
                   sum(CASE WHEN a.is_correct THEN 1 ELSE 0 END) AS correct_count
            ORDER BY avg_score ASC
            """,
            doc_id=doc_id,
        )
        return [dict(r) for r in result]