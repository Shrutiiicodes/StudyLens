"""
graph/pdf_repository.py
All Cypher queries related to (:Document) nodes.

Responsibilities
----------------
- Upsert a Document node from a PDFModel.
- Fetch a Document node by doc_id.
- Delete a Document and all its Chunks (cascade).

Nothing in this file knows about Supabase, ingestion, or chunking.
It only speaks Neo4j and PDFModel.
"""

import logging
from typing import Optional

from neo4j import Session

from models.pdf_model import PDFModel

logger = logging.getLogger(__name__)


class PDFRepository:
    """
    Data-access object for (:Document) nodes in Neo4j.

    Receives a Neo4j Session (not the client directly) so it stays
    stateless and is easy to test by injecting a mock session.

    Usage
    -----
        with client.session() as session:
            repo = PDFRepository(session)
            repo.upsert(pdf_model)
    """

    def __init__(self, session: Session):
        self._session = session

    # ------------------------------------------------------------------
    # Writes
    # ------------------------------------------------------------------

    def upsert(self, pdf: PDFModel) -> None:
        """
        Create or update a (:Document) node.

        Uses MERGE on doc_id so re-ingesting the same PDF updates
        the node rather than duplicating it. All properties are
        set on both create and match so a re-run stays in sync.

        Args:
            pdf: PDFModel instance built from an IngestionResult.
        """
        cypher = """
        MERGE (d:Document {doc_id: $doc_id})
        SET d.storage_path  = $storage_path,
            d.title         = $title,
            d.author        = $author,
            d.page_count    = $page_count,
            d.quality_score = $quality_score,
            d.ocr_applied   = $ocr_applied,
            d.created_at    = $created_at
        """
        self._session.run(cypher, **pdf.to_neo4j_props())
        logger.info("Upserted Document node: %s", pdf.doc_id)

    def delete(self, doc_id: str) -> None:
        """
        Delete a Document node and all its Chunk nodes.

        Detaches and deletes the document plus any chunks linked via
        PART_OF so there are no dangling nodes after deletion.

        Args:
            doc_id: The doc_id of the document to remove.
        """
        cypher = """
        MATCH (d:Document {doc_id: $doc_id})
        OPTIONAL MATCH (d)<-[:PART_OF]-(c:Chunk)
        DETACH DELETE d, c
        """
        self._session.run(cypher, doc_id=doc_id)
        logger.info("Deleted Document and its Chunks: %s", doc_id)

    # ------------------------------------------------------------------
    # Reads
    # ------------------------------------------------------------------

    def find_by_id(self, doc_id: str) -> Optional[dict]:
        """
        Fetch a Document node's properties by doc_id.

        Returns:
            Dict of node properties, or None if not found.
        """
        result = self._session.run(
            "MATCH (d:Document {doc_id: $doc_id}) RETURN d",
            doc_id=doc_id,
        )
        record = result.single()
        if record is None:
            return None
        return dict(record["d"])

    def exists(self, doc_id: str) -> bool:
        """Return True if a Document with this doc_id already exists."""
        result = self._session.run(
            "MATCH (d:Document {doc_id: $doc_id}) RETURN count(d) AS n",
            doc_id=doc_id,
        )
        return result.single()["n"] > 0

    def list_all(self) -> list[dict]:
        """Return all Document nodes as a list of property dicts."""
        result = self._session.run(
            "MATCH (d:Document) RETURN d ORDER BY d.created_at DESC"
        )
        return [dict(record["d"]) for record in result]