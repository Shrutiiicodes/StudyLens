"""
models/chunk_model.py
Dataclass representing a single text chunk as it exists in the
knowledge graph. Maps 1-to-1 with a (:Chunk) node in Neo4j.
"""

from dataclasses import dataclass
from typing import Optional


@dataclass
class ChunkModel:
    """
    Represents one chunk of text extracted from a PDF.

    Maps 1-to-1 with a (:Chunk) node in Neo4j.

    Relationships created alongside this node:
      (:Document {doc_id})-[:PART_OF]->(:Chunk {chunk_id})
      (:Chunk)-[:NEXT_CHUNK]->(:Chunk)   # sequential ordering

    Fields
    ------
    chunk_id    : Globally unique — "{doc_id}::chunk_{index}"
    doc_id      : Parent document identifier (foreign key to PDFModel).
    text        : The raw chunk text passed to the graph and LLM.
    chunk_index : 0-based position within the document.
    char_count  : Length of text in characters.
    start_page  : First page this chunk spans (1-based, may be None).
    end_page    : Last page this chunk spans (1-based, may be None).
    """

    chunk_id: str
    doc_id: str
    text: str
    chunk_index: int
    char_count: int
    start_page: Optional[int] = None
    end_page: Optional[int] = None

    def to_neo4j_props(self) -> dict:
        """Return a flat dict suitable for Neo4j MERGE/SET operations."""
        return {
            "chunk_id": self.chunk_id,
            "doc_id": self.doc_id,
            "text": self.text,
            "chunk_index": self.chunk_index,
            "char_count": self.char_count,
            "start_page": self.start_page,
            "end_page": self.end_page,
        }