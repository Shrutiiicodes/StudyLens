"""
models/pdf_model.py
Pydantic-free dataclass representing a PDF document as it exists in the
knowledge graph. This is the canonical data contract between ingestion
and the graph layer — neither side should import from the other directly.
"""

from dataclasses import dataclass, field
from typing import Optional
import time


@dataclass
class PDFModel:
    """
    Represents a single uploaded PDF document.

    This maps 1-to-1 with a (:Document) node in Neo4j.

    Fields
    ------
    doc_id        : Stable unique identifier — Supabase storage path.
                    e.g. "user-uuid/biology-chapter-3.pdf"
    storage_path  : Same as doc_id; kept explicit for clarity when
                    passing to Neo4j properties.
    title         : Extracted from PDF metadata (may be None).
    author        : Extracted from PDF metadata (may be None).
    page_count    : Total pages in the document.
    quality_score : Overall quality score from QualityEvaluator (0.0–1.0).
    ocr_applied   : True if any page required OCR to extract text.
    created_at    : Unix timestamp of ingestion (set automatically).
    """

    doc_id: str
    storage_path: str
    page_count: int
    quality_score: float
    title: Optional[str] = None
    author: Optional[str] = None
    ocr_applied: bool = False
    user_id: str = ""
    document_id: str = ""
    created_at: int = field(default_factory=lambda: int(time.time()))

    def to_neo4j_props(self) -> dict:
        """Return a flat dict suitable for Neo4j MERGE/SET operations."""
        props = {
            "doc_id": self.doc_id,
            "storage_path": self.storage_path,
            "title": self.title or "",
            "author": self.author or "",
            "page_count": self.page_count,
            "quality_score": self.quality_score,
            "ocr_applied": self.ocr_applied,
            "created_at": self.created_at,
        }
        if self.user_id:
            props["user_id"] = self.user_id
        if self.document_id:
            props["document_id"] = self.document_id
        return props