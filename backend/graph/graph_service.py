"""
graph/graph_service.py
Higher-level orchestration of graph write and read operations.

This is the only file the rest of the application (api/, scripts/)
should import from. It hides the repository layer and the model
construction details behind a clean, intention-revealing interface.

Responsibilities
----------------
- Convert an IngestionResult into PDFModel + ChunkModel instances.
- Coordinate PDFRepository and ChunkRepository in the right order.
- Expose read operations needed by the question-generation layer.
- Handle re-ingestion cleanly (delete stale chunks before re-writing).

What this file does NOT do
--------------------------
- No Supabase calls.
- No PDF parsing or chunking.
- No Cypher queries (those live in the repositories).
"""

import logging
from typing import Optional

from graph.neo4j_client import Neo4jClient
from graph.pdf_repository import PDFRepository
from graph.chunk_repo import ChunkRepository
from graph.concept_extractor import ConceptExtractor
from graph.concept_repository import ConceptRepository
from models.pdf_model import PDFModel
from models.chunk_model import ChunkModel
from utils.id_generator import generate_doc_id, generate_chunk_id

logger = logging.getLogger(__name__)


class GraphService:
    """
    High-level interface for all knowledge-graph operations.

    Usage — writing after ingestion:
        client = Neo4jClient().connect()
        service = GraphService(client)
        service.save_ingestion_result(result)

    Usage — reading for question generation:
        chunks = service.get_chunks_for_document(doc_id)
        context = service.get_chunk_with_context(chunk_id, depth=2)
    """

    def __init__(self, client: Neo4jClient):
        self._client = client
        self._ensure_concept_constraint()

    # ------------------------------------------------------------------
    # Write path — called after ingestion pipeline
    # ------------------------------------------------------------------

    def save_ingestion_result(self, result, user_id: str = "", document_id: str = "") -> str:
        """
        Persist a completed IngestionResult to the knowledge graph.

        This is the primary entry point called after the ingestion
        pipeline succeeds. It:
          1. Builds a stable doc_id from the storage path.
          2. Cleans up any stale chunks from a previous run of the same doc.
          3. Upserts the Document node.
          4. Batch-upserts all Chunk nodes with PART_OF relationships.
          5. Links chunks sequentially with NEXT_CHUNK.

        Args:
            result: IngestionResult from ingestion.pipeline.
            user_id: Supabase user UUID for user-scoped nodes.
            document_id: Supabase concept UUID for linking to Study-Lens.

        Returns:
            The doc_id used in Neo4j — store this to query later.
        """
        doc_id = generate_doc_id(result.storage_path)

        pdf_model = self._build_pdf_model(doc_id, result)
        # Store user_id and document_id on the Document node
        pdf_model.user_id = user_id
        pdf_model.document_id = document_id

        chunk_models = self._build_chunk_models(doc_id, result.chunks)

        with self._client.session() as session:
            pdf_repo   = PDFRepository(session)
            chunk_repo = ChunkRepository(session)

            # Clean up stale chunks if this doc was previously ingested
            if pdf_repo.exists(doc_id):
                logger.info(
                    "Document '%s' already exists — removing stale chunks before re-ingestion.",
                    doc_id,
                )
                chunk_repo.delete_for_document(doc_id)

            # Write in dependency order: Document must exist before Chunks
            pdf_repo.upsert(pdf_model)
            chunk_repo.upsert_many(chunk_models)
            chunk_repo.link_sequential(chunk_models)

        logger.info(
            "Graph write complete — doc_id='%s', %d chunks.",
            doc_id, len(chunk_models),
        )
        return doc_id

    # ------------------------------------------------------------------
    # Read path — called by question-generation layer
    # ------------------------------------------------------------------

    def get_document(self, doc_id: str) -> Optional[dict]:
        """
        Fetch a Document node's properties.

        Returns:
            Dict of node properties, or None if not found.
        """
        with self._client.session() as session:
            return PDFRepository(session).find_by_id(doc_id)

    def get_chunks_for_document(self, doc_id: str) -> list[dict]:
        """
        Return all Chunk nodes for a document, ordered by chunk_index.

        This is the primary read used by question generation to get
        the full text corpus for a student's uploaded PDF.

        Args:
            doc_id: Document identifier returned by save_ingestion_result.

        Returns:
            Ordered list of chunk property dicts.
        """
        with self._client.session() as session:
            return ChunkRepository(session).find_by_document(doc_id)

    def get_chunk_with_context(
        self, chunk_id: str, depth: int = 1
    ) -> list[dict]:
        """
        Return a chunk and its immediate neighbours via NEXT_CHUNK.

        Used by question generation when a specific chunk is selected
        as a question source — surrounding context improves question
        quality by avoiding questions that depend on cut-off sentences.

        Args:
            chunk_id : The anchor chunk.
            depth    : Number of neighbouring chunks to include on each
                       side (default 1 = one before, one after).

        Returns:
            Ordered list of chunk dicts including the anchor.
        """
        with self._client.session() as session:
            return ChunkRepository(session).find_neighbours(chunk_id, depth)

    def list_documents(self) -> list[dict]:
        """
        Return all Document nodes, newest first.
        Useful for admin views or debugging.
        """
        with self._client.session() as session:
            return PDFRepository(session).list_all()

    def document_exists(self, doc_id: str) -> bool:
        """Return True if a Document with this doc_id is in the graph."""
        with self._client.session() as session:
            return PDFRepository(session).exists(doc_id)

    def delete_document(self, doc_id: str) -> None:
        """
        Remove a Document and all its Chunks from the graph.

        Args:
            doc_id: Document identifier to delete.
        """
        with self._client.session() as session:
            PDFRepository(session).delete(doc_id)
        logger.info("Deleted document from graph: %s", doc_id)

    # ------------------------------------------------------------------
    # Concept extraction — call after save_ingestion_result
    # ------------------------------------------------------------------

    def extract_and_save_concepts(self, doc_id: str, chunks: list = None, user_id: str = "") -> int:
        """
        Extract (subject, relation, object) triples from chunks of a
        document and write (:Concept) nodes + typed edges to Neo4j.

        Call this after save_ingestion_result() once chunks are in Neo4j.
        
        Args:
            doc_id: Document ID to extract concepts for
            chunks: Optional list of chunks to process. If None, fetches all chunks.
                   Useful for rate-limiting (e.g., only process first 10 chunks)
            user_id: Supabase user UUID for user-scoped concept nodes.

        Returns:
            Number of valid triples written.
        """
        if chunks is None:
            chunks = self.get_chunks_for_document(doc_id)
        
        if not chunks:
            logger.warning("No chunks found for doc_id='%s'. Skipping extraction.", doc_id)
            return 0

        # Convert TextChunk objects to dicts if needed (for compatibility with extractor)
        chunks_as_dicts = self._convert_chunks_to_dicts(chunks)

        logger.info(
            "Extracting concepts from %d chunks for doc_id='%s' ...",
            len(chunks_as_dicts), doc_id,
        )
        extractor = ConceptExtractor()
        triples = extractor.extract_from_chunks(chunks_as_dicts, doc_id)

        if not triples:
            logger.warning("No triples extracted for doc_id='%s'.", doc_id)
            return 0

        with self._client.session() as session:
            ConceptRepository(session).upsert_triples(triples)

        logger.info("Saved %d triple(s) for doc_id='%s'.", len(triples), doc_id)
        return len(triples)

    def get_concepts_for_document(self, doc_id: str) -> list[dict]:
        """Return all Concept nodes for a document, sorted by mention count."""
        with self._client.session() as session:
            return ConceptRepository(session).find_concepts_for_document(doc_id)

    def get_relations_for_document(self, doc_id: str) -> list[dict]:
        """
        Return all typed concept relationships as {subject, relation, object}.
        This is the raw knowledge graph that question generation queries.
        """
        with self._client.session() as session:
            return ConceptRepository(session).find_relations_for_document(doc_id)

    def get_chunks_for_concept(self, concept_name: str, doc_id: str) -> list[str]:
        """Return chunk_ids that mention a given concept."""
        with self._client.session() as session:
            return ConceptRepository(session).find_chunks_for_concept(concept_name, doc_id)

    # ------------------------------------------------------------------
    # Schema helpers
    # ------------------------------------------------------------------

    def _ensure_concept_constraint(self) -> None:
        """Composite uniqueness constraint on (name, doc_id) for Concept nodes."""
        try:
            with self._client.session() as session:
                session.run(
                    "CREATE CONSTRAINT unique_concept IF NOT EXISTS "
                    "FOR (c:Concept) REQUIRE (c.name, c.doc_id) IS UNIQUE"
                )
        except Exception as exc:
            logger.debug("Concept constraint note: %s", exc)

    def _build_pdf_model(self, doc_id: str, result) -> PDFModel:
        """Build a PDFModel from an IngestionResult."""
        content = result.content
        ocr_applied = any(p.ocr_applied for p in content.pages)
        title = content.title
        if title and title.startswith("http"):
            title = None   # fall back to filename display in the frontend

        return PDFModel(
            doc_id=doc_id,
            storage_path=result.storage_path,
            title=content.title,
            author=content.author,
            page_count=content.page_count,
            # quality_score=result.quality_report.overall_score,
            quality_score= 0.0,
            # ocr_applied=ocr_applied,
            ocr_applied = ocr_applied,
        )

    def _build_chunk_models(self, doc_id: str, chunks) -> list[ChunkModel]:
        """Build ChunkModel instances from ingestion TextChunk instances."""
        return [
            ChunkModel(
                chunk_id=generate_chunk_id(doc_id, chunk.chunk_index),
                doc_id=doc_id,
                text=chunk.text,
                chunk_index=chunk.chunk_index,
                char_count=chunk.char_count,
                start_page=chunk.start_page,
                end_page=chunk.end_page,
            )
            for chunk in chunks
        ]

    def _convert_chunks_to_dicts(self, chunks: list) -> list[dict]:
        """
        Convert chunks to dictionaries for compatibility with ConceptExtractor.
        
        Handles both TextChunk objects (from ingestion) and dict objects 
        (from Neo4j queries). Returns list of dicts with at minimum 'chunk_id' 
        and 'text' keys.
        """
        result = []
        for chunk in chunks:
            if isinstance(chunk, dict):
                # Already a dict from Neo4j query
                result.append(chunk)
            else:
                # TextChunk object from ingestion - convert to dict
                result.append({
                    "chunk_id": chunk.chunk_id,
                    "text": chunk.text,
                    "doc_id": chunk.doc_id,
                    "chunk_index": chunk.chunk_index,
                    "char_count": chunk.char_count,
                    "start_page": chunk.start_page,
                    "end_page": chunk.end_page,
                })
        return result