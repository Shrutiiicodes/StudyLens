"""
utils/id_generator.py
Centralised ID generation for all entities in the knowledge graph.
Keeping this in one place means if the ID scheme ever changes,
there is exactly one file to update.
"""

import hashlib
import time
import uuid


def generate_doc_id(storage_path: str) -> str:
    """
    Generate a stable, deterministic document ID from the Supabase
    storage path. The same path always produces the same ID, so
    re-ingesting the same file is idempotent in Neo4j.

    Args:
        storage_path: e.g. "user-uuid/biology-chapter-3.pdf"

    Returns:
        e.g. "doc_a3f9c1d2e4b7..."  (16 hex chars)
    """
    digest = hashlib.sha256(storage_path.encode()).hexdigest()[:16]
    return f"doc_{digest}"


def generate_chunk_id(doc_id: str, chunk_index: int) -> str:
    """
    Generate a stable chunk ID from its parent doc ID and position.

    Args:
        doc_id      : Parent document ID (from generate_doc_id).
        chunk_index : 0-based position of the chunk within the document.

    Returns:
        e.g. "chunk_a3f9c1d2e4b7_0042"
    """
    base = doc_id.replace("doc_", "")
    return f"chunk_{base}_{chunk_index:04d}"


def generate_session_id() -> str:
    """
    Generate a unique session/run ID for tracing a single ingestion run.
    Not stored in Neo4j by default but useful for logging correlation.
    """
    return f"session_{int(time.time())}_{uuid.uuid4().hex[:8]}"