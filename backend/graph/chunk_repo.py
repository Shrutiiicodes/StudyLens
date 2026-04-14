"""
graph/chunk_repository.py
All Cypher queries related to (:Chunk) nodes and their relationships.

Graph schema managed here
--------------------------
Nodes
    (:Chunk {chunk_id, doc_id, text, chunk_index, char_count,
             start_page, end_page})

Relationships
    (:Chunk)-[:PART_OF]->(:Document)
        Every chunk belongs to exactly one document.

    (:Chunk)-[:NEXT_CHUNK]->(:Chunk)
        Sequential ordering — used by question generation to retrieve
        surrounding context when a chunk is selected as a question source.

Nothing in this file knows about Supabase, ingestion, or PDF extraction.
"""

import logging
from typing import Optional

from neo4j import Session

from models.chunk_model import ChunkModel

logger = logging.getLogger(__name__)

# Maximum chunks to write in a single Cypher UNWIND batch.
# Neo4j handles large lists well but batching keeps memory bounded
# and makes progress logging possible on very large documents.
_BATCH_SIZE = 100


class ChunkRepository:
    """
    Data-access object for (:Chunk) nodes in Neo4j.

    Usage
    -----
        with client.session() as session:
            repo = ChunkRepository(session)
            repo.upsert_many(chunk_models)
            repo.link_sequential(chunk_models)
    """

    def __init__(self, session: Session):
        self._session = session

    # ------------------------------------------------------------------
    # Writes
    # ------------------------------------------------------------------

    def upsert(self, chunk: ChunkModel) -> None:
        """
        Create or update a single (:Chunk) node and its PART_OF
        relationship to the parent Document.

        Args:
            chunk: ChunkModel instance.
        """
        self._upsert_batch([chunk])

    def upsert_many(self, chunks: list[ChunkModel]) -> None:
        """
        Batch-upsert a list of Chunk nodes and their PART_OF relationships.
        Processes in batches of _BATCH_SIZE for memory efficiency.

        Args:
            chunks: Ordered list of ChunkModel instances for one document.
        """
        if not chunks:
            logger.warning("upsert_many called with empty chunk list.")
            return

        total = len(chunks)
        for start in range(0, total, _BATCH_SIZE):
            batch = chunks[start : start + _BATCH_SIZE]
            self._upsert_batch(batch)
            logger.debug(
                "Upserted chunks %d-%d / %d", start, start + len(batch), total
            )

        logger.info("Upserted %d Chunk node(s).", total)

    def link_sequential(self, chunks: list[ChunkModel]) -> None:
        """
        Create (:Chunk)-[:NEXT_CHUNK]->(:Chunk) relationships between
        consecutive chunks in the document.

        This is written separately from upsert_many so that all chunk
        nodes are guaranteed to exist before relationships are created.

        Args:
            chunks: Ordered list of ChunkModel instances (same order as
                    they appear in the document).
        """
        if len(chunks) < 2:
            return

        pairs = [
            {"a": chunks[i].chunk_id, "b": chunks[i + 1].chunk_id}
            for i in range(len(chunks) - 1)
        ]

        # Process in batches
        for start in range(0, len(pairs), _BATCH_SIZE):
            batch = pairs[start : start + _BATCH_SIZE]
            self._session.run(
                """
                UNWIND $pairs AS p
                MATCH (a:Chunk {chunk_id: p.a})
                MATCH (b:Chunk {chunk_id: p.b})
                MERGE (a)-[:NEXT_CHUNK]->(b)
                """,
                pairs=batch,
            )

        logger.info(
            "Linked %d sequential NEXT_CHUNK relationship(s).", len(pairs)
        )

    def delete_for_document(self, doc_id: str) -> None:
        """
        Delete all Chunk nodes belonging to a document.
        Called before re-ingesting a document to avoid stale chunks.

        Args:
            doc_id: Parent document identifier.
        """
        result = self._session.run(
            """
            MATCH (c:Chunk {doc_id: $doc_id})
            WITH c, c.chunk_id AS cid
            DETACH DELETE c
            RETURN count(cid) AS deleted
            """,
            doc_id=doc_id,
        )
        deleted = result.single()["deleted"]
        logger.info("Deleted %d Chunk node(s) for doc_id='%s'.", deleted, doc_id)

    # ------------------------------------------------------------------
    # Reads
    # ------------------------------------------------------------------

    def find_by_id(self, chunk_id: str) -> Optional[dict]:
        """Fetch a Chunk node's properties by chunk_id."""
        result = self._session.run(
            "MATCH (c:Chunk {chunk_id: $chunk_id}) RETURN c",
            chunk_id=chunk_id,
        )
        record = result.single()
        return dict(record["c"]) if record else None

    def find_by_document(self, doc_id: str) -> list[dict]:
        """
        Return all chunks for a document, ordered by chunk_index.
        Used by the question-generation layer to retrieve full context.
        """
        result = self._session.run(
            """
            MATCH (c:Chunk {doc_id: $doc_id})
            RETURN c
            ORDER BY c.chunk_index ASC
            """,
            doc_id=doc_id,
        )
        return [dict(record["c"]) for record in result]

    def find_neighbours(self, chunk_id: str, depth: int = 1) -> list[dict]:
        """
        Return the immediate neighbours of a chunk via NEXT_CHUNK.
        Useful for question generation to retrieve surrounding context
        when a specific chunk is selected as a question source.

        Args:
            chunk_id : The anchor chunk.
            depth    : How many hops in each direction to retrieve (default 1).

        Returns:
            List of chunk property dicts ordered by chunk_index,
            including the anchor chunk itself.
        """
        result = self._session.run(
            """
            MATCH (anchor:Chunk {chunk_id: $chunk_id})
            MATCH (c:Chunk {doc_id: anchor.doc_id})
            WHERE c.chunk_index >= anchor.chunk_index - $depth
              AND c.chunk_index <= anchor.chunk_index + $depth
            RETURN c
            ORDER BY c.chunk_index ASC
            """,
            chunk_id=chunk_id,
            depth=depth,
        )
        return [dict(record["c"]) for record in result]

    def count_for_document(self, doc_id: str) -> int:
        """Return the number of Chunk nodes for a given document."""
        result = self._session.run(
            "MATCH (c:Chunk {doc_id: $doc_id}) RETURN count(c) AS n",
            doc_id=doc_id,
        )
        return result.single()["n"]

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _upsert_batch(self, chunks: list[ChunkModel]) -> None:
        """
        Write one batch of Chunk nodes and PART_OF relationships
        using a single UNWIND Cypher statement.
        """
        self._session.run(
            """
            UNWIND $chunks AS c
            MERGE (ch:Chunk {chunk_id: c.chunk_id})
            SET ch.doc_id      = c.doc_id,
                ch.text        = c.text,
                ch.chunk_index = c.chunk_index,
                ch.char_count  = c.char_count,
                ch.start_page  = c.start_page,
                ch.end_page    = c.end_page
            WITH ch, c
            MATCH (d:Document {doc_id: c.doc_id})
            MERGE (ch)-[:PART_OF]->(d)
            """,
            chunks=[ch.to_neo4j_props() for ch in chunks],
        )