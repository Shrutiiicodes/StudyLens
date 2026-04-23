"""
graph/question_repository.py
All Cypher queries for (:Question) nodes.

Graph schema managed here
--------------------------
Nodes
    (:Question {
        question_id, doc_id, question, q_type, correct,
        options, concept, relation, difficulty, source_chunk
    })

Relationships
    (:Question)-[:TESTS]->(:Concept)
        Links each question to the concept it tests.
        Used to find all questions about a concept, or
        all concepts that have been tested.

    (:Question)-[:SOURCED_FROM]->(:Chunk)
        Links each question to the chunk that provided
        its supporting context. Used by misconception
        analysis to pull the original text when evaluating answers.
"""

import json
import logging
import uuid
from typing import Optional

from neo4j import Session

from graph.questions.question_generator import Question

logger = logging.getLogger(__name__)

_BATCH_SIZE = 50


class QuestionRepository:
    """
    Data-access object for (:Question) nodes.

    Usage
    -----
        with client.session() as session:
            repo = QuestionRepository(session)
            stored = repo.upsert_many(questions)
    """

    def __init__(self, session: Session):
        self._session = session

    # ------------------------------------------------------------------
    # Writes
    # ------------------------------------------------------------------

    def upsert_many(self, questions: list[Question]) -> list[Question]:
        """
        Write a list of Question nodes and their relationships to Neo4j.

        Assigns a question_id to each question (uuid4), then writes in
        batches. Creates TESTS and SOURCED_FROM relationships after nodes exist.

        Args:
            questions: Valid Question objects from QuestionGenerator.

        Returns:
            The same questions with question_id fields populated.
        """
        if not questions:
            return []

        # Assign IDs
        for q in questions:
            if not q.question_id:
                q.question_id = f"q_{uuid.uuid4().hex[:12]}"

        self._upsert_nodes(questions)
        self._link_to_concepts(questions)
        self._link_to_chunks(questions)

        logger.info("Wrote %d Question node(s) to Neo4j.", len(questions))
        return questions

    def delete_for_document(self, doc_id: str) -> None:
        """Delete all Question nodes for a document (called on re-ingestion)."""
        result = self._session.run(
            """
            MATCH (q:Question {doc_id: $doc_id})
            DETACH DELETE q
            RETURN count(q) AS deleted
            """,
            doc_id=doc_id,
        )
        deleted = result.single()["deleted"]
        logger.info("Deleted %d Question node(s) for doc_id='%s'.", deleted, doc_id)

    # ------------------------------------------------------------------
    # Reads
    # ------------------------------------------------------------------

    def find_by_document(
        self,
        doc_id: str,
        difficulty: Optional[str] = None,
        limit: int = 50,
    ) -> list[dict]:
        """
        Return questions for a document with optional filters.

        Args:
            doc_id     : Document to query.
            difficulty : Filter by "easy" | "medium" | "hard" (optional).
            limit      : Max number of questions to return.

        Returns:
            List of question property dicts.
        """
        filters = ["q.doc_id = $doc_id"]
        params: dict = {"doc_id": doc_id, "limit": limit}

        if difficulty:
            filters.append("q.difficulty = $difficulty")
            params["difficulty"] = difficulty
        if q_type:
            filters.append("q.q_type = $q_type")
            params["q_type"] = q_type

        where = " AND ".join(filters)
        result = self._session.run(
            f"""
            MATCH (q:Question)
            WHERE {where}
            RETURN q
            ORDER BY q.difficulty, q.concept
            LIMIT $limit
            """,
            **params,
        )
        rows = [dict(r["q"]) for r in result]
        # Deserialise options (stored as JSON string)
        for row in rows:
            if isinstance(row.get("options"), str):
                try:
                    row["options"] = json.loads(row["options"])
                except Exception:
                    row["options"] = []
        return rows

    def find_by_concept(self, concept_name: str, doc_id: str) -> list[dict]:
        """Return all questions that test a specific concept."""
        result = self._session.run(
            """
            MATCH (q:Question)-[:TESTS]->(c:Concept {name: $name, doc_id: $doc_id})
            RETURN q
            ORDER BY q.difficulty
            """,
            name=concept_name,
            doc_id=doc_id,
        )
        rows = [dict(r["q"]) for r in result]
        for row in rows:
            if isinstance(row.get("options"), str):
                try:
                    row["options"] = json.loads(row["options"])
                except Exception:
                    row["options"] = []
        return rows

    def find_by_id(self, question_id: str) -> Optional[dict]:
        """Fetch a single question by its question_id."""
        result = self._session.run(
            "MATCH (q:Question {question_id: $qid}) RETURN q",
            qid=question_id,
        )
        record = result.single()
        if not record:
            return None
        row = dict(record["q"])
        if isinstance(row.get("options"), str):
            try:
                row["options"] = json.loads(row["options"])
            except Exception:
                row["options"] = []
        return row

    def count_for_document(self, doc_id: str) -> int:
        result = self._session.run(
            "MATCH (q:Question {doc_id: $doc_id}) RETURN count(q) AS n",
            doc_id=doc_id,
        )
        return result.single()["n"]

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _upsert_nodes(self, questions: list[Question]) -> None:
        """Write Question nodes in batches via UNWIND."""
        for start in range(0, len(questions), _BATCH_SIZE):
            batch = questions[start: start + _BATCH_SIZE]
            self._session.run(
                """
                UNWIND $questions AS q
                MERGE (n:Question {question_id: q.question_id})
                SET n.doc_id               = q.doc_id,
                    n.question             = q.question,
                    n.q_type               = q.q_type,
                    n.correct              = q.correct,
                    n.options              = q.options_json,
                    n.concept              = q.concept,
                    n.relation             = q.relation,
                    n.difficulty           = q.difficulty,
                    n.source_chunk         = q.source_chunk,
                    n.distractor_distances = q.distractor_distances_json
                """,
                questions=[
                    {
                        "question_id": q.question_id,
                        "doc_id":      q.doc_id,
                        "question":    q.question,
                        "q_type":      q.q_type,
                        "correct":     q.correct,
                        "options_json": json.dumps(q.options),
                        "concept":     q.concept,
                        "relation":    q.relation,
                        "difficulty":  q.difficulty,
                        "source_chunk": q.source_chunk,
                        "distractor_distances_json": json.dumps(
                            getattr(q, "distractor_distances", {})
                        ),
                    }
                    for q in batch
                ],
            )

    def _link_to_concepts(self, questions: list[Question]) -> None:
        """Create (:Question)-[:TESTS]->(:Concept) edges."""
        for start in range(0, len(questions), _BATCH_SIZE):
            batch = questions[start: start + _BATCH_SIZE]
            self._session.run(
                """
                UNWIND $items AS item
                MATCH (q:Question {question_id: item.question_id})
                MATCH (c:Concept {name: item.concept, doc_id: item.doc_id})
                MERGE (q)-[:TESTS]->(c)
                """,
                items=[
                    {"question_id": q.question_id, "concept": q.concept, "doc_id": q.doc_id}
                    for q in batch
                ],
            )

    def _link_to_chunks(self, questions: list[Question]) -> None:
        """Create (:Question)-[:SOURCED_FROM]->(:Chunk) edges."""
        linkable = [q for q in questions if q.source_chunk]
        for start in range(0, len(linkable), _BATCH_SIZE):
            batch = linkable[start: start + _BATCH_SIZE]
            self._session.run(
                """
                UNWIND $items AS item
                MATCH (q:Question {question_id: item.question_id})
                MATCH (ch:Chunk {chunk_id: item.source_chunk})
                MERGE (q)-[:SOURCED_FROM]->(ch)
                """,
                items=[
                    {"question_id": q.question_id, "source_chunk": q.source_chunk}
                    for q in batch
                ],
            )