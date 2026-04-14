"""
pipeline.py
Orchestrates the PDF ingestion pipeline (Supabase only):
    1. Download PDF from Supabase Storage
    2. Extract text + metadata with PyMuPDF
    3. Chunk the extracted text

The resulting chunks are returned to the caller so that the
graph/ layer can consume them and write to Neo4j independently.
"""

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional
import re

from .pdf_downloader import PDFDownloader, UploadValidationResult
from .pdf_extractor import PDFExtractor, DocumentContent
from .chunker import Chunker, TextChunk, ChunkingIntegrityReport

logger = logging.getLogger(__name__)

def clean_text(text: str) -> str:
    # Remove repeated comma-separated words
    text = re.sub(r'\b(\w+)(,\1)+\b', r'\1', text)

    # Collapse repeated words like andandand
    text = re.sub(r'(\b\w+\b)\1+', r'\1', text)

    # Remove excessive repeated characters
    text = re.sub(r'(.)\1{3,}', r'\1', text)

    return text


@dataclass
class DocumentIntegrityReport:
    """
    Aggregated integrity report for one processed document.
    Combines signals from all three pipeline stages:
      - PDFDownloader.validate_before_download()  (upload validation)
      - PDFExtractor._compute_extraction_quality() (extraction quality)
      - Chunker.check_integrity()                  (chunking integrity)

    Stored in Supabase alongside the chunks. The graph/ layer reads
    pipeline_ok before dispatching chunks to Stage 2 workers.
    """
    doc_id:             str
    pipeline_ok:        bool    # False = do not dispatch to Stage 2
    overall_confidence: float   # 0.0–1.0 weighted composite

    # ── Upload validation ────────────────────────────────────────────────
    upload_valid:       bool
    file_size_bytes:    Optional[int]
    upload_issues:      list[str] = field(default_factory=list)
    upload_warnings:    list[str] = field(default_factory=list)

    # ── Extraction quality (from pdf_extractor.py) ───────────────────────
    quality_tier:       str = "UNKNOWN"   # "HIGH" | "MEDIUM" | "LOW" | "UNREADABLE"
    quality_score:      float = 0.0
    chars_per_page:     float = 0.0
    noise_ratio:        float = 0.0
    coverage_ratio:     float = 0.0
    coverage_verdict:   str = "UNKNOWN"
    empty_pages:        list[int] = field(default_factory=list)
    ocr_page_count:     int = 0
    ocr_avg_confidence: Optional[float] = None
    ocr_low_conf_pages: list[int] = field(default_factory=list)
    extraction_notes:   list[str] = field(default_factory=list)

    # ── Chunking integrity (from chunker.py) ─────────────────────────────
    chunking_verdict:        str = "UNKNOWN"
    chunk_coverage_ratio:    float = 0.0
    uncovered_char_estimate: int = 0
    duplicate_pairs:         list = field(default_factory=list)
    avg_chunk_confidence:    float = 0.0
    high_conf_count:         int = 0
    medium_conf_count:       int = 0
    low_conf_count:          int = 0
    chunking_notes:          list[str] = field(default_factory=list)

    # ── Semantic gaps (from pdf_extractor.py SemanticGap detection) ───────
    # These represent content that is structurally present in the document
    # but whose meaning did not survive extraction — diagrams, tables, equations.
    # Not a blocker (pipeline proceeds) but always surfaced as warnings so
    # the teacher knows which concepts the KG will be missing.
    semantic_gap_count:    int = 0
    diagram_gap_count:     int = 0
    table_gap_count:       int = 0
    equation_gap_count:    int = 0
    semantic_gaps:         list = field(default_factory=list)  # list[SemanticGap]
    semantic_completeness: float = 1.0

    # ── Actionable summary ───────────────────────────────────────────────
    blockers:  list[str] = field(default_factory=list)  # halt Stage 2
    warnings:  list[str] = field(default_factory=list)  # proceed with caution

    low_confidence_chunk_ids: list = field(default_factory=list)

@dataclass
class IngestionResult:
    """Returned by the pipeline after processing a single PDF."""

    doc_id:           str
    storage_path:     str
    content:          DocumentContent
    chunks:           list[TextChunk]
    integrity_report: DocumentIntegrityReport

    @property
    def chunk_count(self) -> int:
        return len(self.chunks)

    @property
    def page_count(self) -> int:
        return self.content.page_count

    @property
    def pipeline_ok(self) -> bool:
        """False if any blocker was raised — do not dispatch to Stage 2."""
        return self.integrity_report.pipeline_ok

    @property
    def stage2_ready_chunks(self) -> list[TextChunk]:
        """
        Chunks with confidence_score >= 0.50 — safe to send to Stage 2.
        LOW-confidence chunks (score < 0.50) are excluded; the caller can
        inspect integrity_report.low_conf_count for how many were dropped,
        and read chunk.confidence_flags on any chunk to see exactly why.
        """
        return [c for c in self.chunks if c.confidence_score >= 0.50]



class IngestionPipeline:
    """
    Orchestrates download → extract → chunk for a single PDF.

    Returns an IngestionResult so the graph/ layer can take the
    chunks and write them to Neo4j without any coupling here.

    Usage
    -----
    pipeline = IngestionPipeline()
    result = pipeline.run("user-uuid/my-doc.pdf")
    # pass result.chunks to graph/ layer
    """

    def __init__(
        self,
        supabase_url: Optional[str] = None,
        supabase_key: Optional[str] = None,
        bucket_name: str = "raw-pdfs",
        chunk_size: int = 1000,
        chunk_overlap: int = 150,
    ):
        self.downloader = PDFDownloader(supabase_url, supabase_key, bucket_name)
        self.extractor = PDFExtractor()
        self.chunker = Chunker(chunk_size=chunk_size, chunk_overlap=chunk_overlap)

    def run(self, storage_path: str) -> IngestionResult:
        """
        Run the full ingestion flow for one PDF.

        Steps
        -----
        0. Validate upload metadata in Supabase before downloading.
        1. Download PDF from Supabase Storage to a temp file.
        2. Extract text + metadata with PyMuPDF (OCR fallback if needed).
        3. Chunk the extracted text.
        4. Score chunk confidence and run chunking integrity check.
        5. Assemble DocumentIntegrityReport — gate Stage 2 dispatch.

        Args:
            storage_path: Path inside the Supabase bucket,
                          e.g. "user-id/document.pdf"

        Returns:
            IngestionResult. Check result.pipeline_ok before dispatching
            result.stage2_ready_chunks to the graph/ layer.

        Raises:
            RuntimeError: If download fails.
            ValueError:   If the PDF cannot be parsed.
        """
        doc_id   = storage_path
        tmp_path: Optional[str] = None

        try:
            # ── Step 0: Validate before downloading ─────────────────────
            logger.info("[0/4] Validating upload '%s' …", storage_path)
            upload_validation = self.downloader.validate_before_download(storage_path)

            if not upload_validation.is_valid:
                # Build a blocked report without downloading anything
                integrity_report = self._build_integrity_report(
                    doc_id            = doc_id,
                    upload_validation = upload_validation,
                    eq                = None,
                    chunking          = None,
                    chunks            = [],
                    page_count        = 0,
                )
                return IngestionResult(
                    doc_id           = doc_id,
                    storage_path     = storage_path,
                    content          = DocumentContent(
                        file_path  = storage_path,
                        title      = None,
                        author     = None,
                        page_count = 0,
                        full_text  = "",
                    ),
                    chunks           = [],
                    integrity_report = integrity_report,
                )

            # ── Step 1: Download ─────────────────────────────────────────
            logger.info("[1/4] Downloading '%s' …", storage_path)
            tmp_path = self.downloader.download_to_tempfile(storage_path)

            # ── Step 2: Extract ──────────────────────────────────────────
            logger.info("[2/4] Extracting text …")
            content: DocumentContent = self.extractor.extract(tmp_path)
            content.full_text = clean_text(content.full_text)
            if content.is_empty:
                logger.warning(
                    "No text found in '%s'. Returning empty chunk list.", storage_path
                )

            # ── Step 3: Chunk ────────────────────────────────────────────
            logger.info("[3/4] Chunking text …")
            chunks: list[TextChunk] = self.chunker.chunk_document(content, doc_id)
            # Note: chunk_document() already calls _score_chunk_confidence()
            # on every chunk, so confidence_score/confidence_flags are set.

            # ── Step 4: Integrity check ──────────────────────────────────
            logger.info("[4/4] Running integrity check …")
            extracted_chars = len(content.full_text)
            chunking_report = self.chunker.check_integrity(chunks, doc_id, extracted_chars)

            integrity_report = self._build_integrity_report(
                doc_id            = doc_id,
                upload_validation = upload_validation,
                eq                = content.extraction_quality,
                chunking          = chunking_report,
                chunks            = chunks,
                page_count        = content.page_count,
            )

            if integrity_report.blockers:
                logger.error(
                    "Integrity BLOCKED for '%s' — Stage 2 suppressed:\n  • %s",
                    storage_path, "\n  • ".join(integrity_report.blockers),
                )
            elif integrity_report.warnings:
                logger.warning(
                    "%d integrity warning(s) for '%s':\n  • %s",
                    len(integrity_report.warnings),
                    storage_path,
                    "\n  • ".join(integrity_report.warnings),
                )

            result = IngestionResult(
                doc_id           = doc_id,
                storage_path     = storage_path,
                content          = content,
                chunks           = chunks,
                integrity_report = integrity_report,
            )
            logger.info(
                "Ingestion complete — %d page(s), %d chunks (%d stage2-ready), "
                "confidence=%.2f, quality=%s for '%s'",
                result.page_count,
                result.chunk_count,
                len(result.stage2_ready_chunks),
                integrity_report.overall_confidence,
                integrity_report.quality_tier,
                storage_path,
            )
            return result

        finally:
            if tmp_path and Path(tmp_path).exists():
                Path(tmp_path).unlink()
                logger.debug("Cleaned up temp file: %s", tmp_path)

    def _build_integrity_report(
        self,
        doc_id:            str,
        upload_validation: "UploadValidationResult",
        eq,                # ExtractionQualityReport | None
        chunking,          # ChunkingIntegrityReport | None
        chunks:            list[TextChunk],
        page_count:        int = 0,
    ) -> DocumentIntegrityReport:
        """
        Assemble the DocumentIntegrityReport from the three module outputs.
        Determines blockers, warnings, and overall_confidence.
        """
        blockers: list[str] = []
        warnings: list[str] = list(upload_validation.warnings)

        # ── Upload blockers ───────────────────────────────────────────────
        if not upload_validation.is_valid:
            blockers.extend(upload_validation.issues)

        # ── Extraction blockers / warnings ────────────────────────────────
        quality_tier     = eq.quality_tier      if eq else "UNKNOWN"
        quality_score    = eq.quality_score     if eq else 0.0
        coverage_ratio   = eq.coverage_ratio    if eq else 0.0
        coverage_verdict = eq.coverage_verdict  if eq else "UNKNOWN"
        extraction_notes = eq.notes             if eq else []

        if quality_tier == "UNREADABLE":
            blockers.append(
                "Document quality is UNREADABLE (>15% garbage characters or "
                "near-zero text density). KG construction would produce "
                "unreliable triples. Upload a higher-quality document."
            )
        elif quality_tier == "LOW":
            warnings.append(
                "Document quality is LOW. Raise the LLM verification threshold "
                "from 0.80 → 0.88 for all chunks in this document."
            )

        if coverage_verdict == "SPARSE":
            blockers.append(
                "Extraction coverage is SPARSE (<60% of expected text volume). "
                "The knowledge graph will have major topic gaps."
            )
        elif coverage_verdict == "PARTIAL":
            warnings.append(
                "Extraction coverage is PARTIAL (60–94%). "
                "Some pages may be image-only. Check empty_pages in the report."
            )

        # Surface individual extraction notes that aren't already a blocker
        for note in extraction_notes:
            if "BLOCKER" not in note and "CRITICAL" not in note:
                warnings.append(note)

        # ── Chunking blockers / warnings ──────────────────────────────────
        chunking_verdict        = chunking.verdict                  if chunking else "UNKNOWN"
        chunk_coverage_ratio    = chunking.chunk_coverage_ratio     if chunking else 0.0
        uncovered_estimate      = chunking.uncovered_char_estimate  if chunking else 0
        duplicate_pairs         = chunking.duplicate_pairs          if chunking else []
        avg_chunk_conf          = chunking.avg_confidence           if chunking else 0.0
        high_conf               = chunking.high_conf_count          if chunking else 0
        medium_conf             = chunking.medium_conf_count        if chunking else 0
        low_conf                = chunking.low_conf_count           if chunking else 0
        chunking_notes          = chunking.notes                    if chunking else []

        if chunking_verdict == "GAPS":
            blockers.append(
                "More than 25% of extracted text is not covered by any chunk. "
                "Significant content will be invisible to Stage 2."
            )
        elif duplicate_pairs:
            warnings.append(
                f"{len(duplicate_pairs)} near-duplicate chunk pair(s) detected. "
                "Stage 2 deduplication cost will be higher than normal."
            )

        if avg_chunk_conf < 0.55 and chunks:
            warnings.append(
                f"Average chunk confidence is {avg_chunk_conf:.0%}. "
                "Raise the LLM verification threshold to 0.88 for this document."
            )

        for note in chunking_notes:
            if "CRITICAL" not in note:
                warnings.append(note)

        # ── Semantic gap warnings ─────────────────────────────────────────
        # These are never blockers — the pipeline ran fine. But they tell
        # Stage 2 and the teacher exactly which concepts are missing.
        semantic_gaps      = eq.semantic_gaps      if eq else []
        semantic_gap_count = eq.semantic_gap_count if eq else 0
        diagram_gap_count  = eq.diagram_gap_count  if eq else 0
        table_gap_count    = eq.table_gap_count    if eq else 0
        equation_gap_count = eq.equation_gap_count if eq else 0

        # Also count semantic flags raised at the chunk level
        caption_only_chunks    = sum(1 for c in chunks if "CAPTION_ONLY"    in c.confidence_flags)
        table_remnant_chunks   = sum(1 for c in chunks if "TABLE_REMNANT"   in c.confidence_flags)
        equation_degraded_chunks = sum(1 for c in chunks if any(
            f.startswith("EQUATION_DEGRADED") for f in c.confidence_flags
        ))

        if diagram_gap_count > 0 or caption_only_chunks > 0:
            warnings.append(
                f"{diagram_gap_count} diagram(s) detected at page level "
                f"(+{caption_only_chunks} caption-only chunk(s)). "
                "Image bodies are absent from the text layer — any concept "
                "explained only through these diagrams will be missing from the KG. "
                "Consider adding alt-text or transcriptions to the source document."
            )
        if table_gap_count > 0 or table_remnant_chunks > 0:
            warnings.append(
                f"{table_gap_count} table(s) detected at page level "
                f"(+{table_remnant_chunks} table-remnant chunk(s)). "
                "Row/column structure is destroyed in the text layer. "
                "Numerical comparisons and relational data from these tables "
                "will produce unreliable KG triples. "
                "Stage 2 should apply stricter verification on chunks flagged TABLE_REMNANT."
            )
        if equation_gap_count > 0 or equation_degraded_chunks > 0:
            warnings.append(
                f"{equation_gap_count} equation block(s) detected at page level "
                f"(+{equation_degraded_chunks} EQUATION_DEGRADED chunk(s)). "
                "Mathematical expressions are present but structurally garbled. "
                "Relationships like exponents, fractions, and subscripts are flattened. "
                "KG triples extracted from these chunks should be manually verified."
            )

        # Overall semantic gap summary note
        if semantic_gap_count > 0:
            high_sev = sum(1 for g in semantic_gaps if g.severity == "HIGH")
            warnings.append(
                f"Total semantic gaps: {semantic_gap_count} "
                f"({high_sev} HIGH severity — concepts entirely absent from text layer). "
                "These gaps are inherent to the document format and cannot be resolved "
                "by re-running the pipeline without a richer source document."
            )

        # ── Overall confidence ─────────────────────────────────────────────
        # Penalise documents whose educational content is trapped in diagrams,
        # tables, or equations that never made it into the text layer.
        high_gap_pages = len(set(
            g.page_number for g in semantic_gaps if g.severity == "HIGH"
        ))
        semantic_penalty = high_gap_pages / max(page_count, 1)
        semantic_completeness = max(1.0 - semantic_penalty, 0.0)

        overall_confidence = round(
            0.30 * quality_score          +
            0.30 * coverage_ratio         +
            0.25 * chunk_coverage_ratio   +
            0.15 * semantic_completeness,
            4,
        )

        # Track low-confidence chunk ids for downstream convenience
        low_conf_ids = [c.chunk_id for c in chunks if c.confidence_score < 0.50]

        report = DocumentIntegrityReport(
            doc_id              = doc_id,
            pipeline_ok         = len(blockers) == 0,
            overall_confidence  = overall_confidence,
            upload_valid        = upload_validation.is_valid,
            file_size_bytes     = upload_validation.file_size_bytes,
            upload_issues       = list(upload_validation.issues),
            upload_warnings     = list(upload_validation.warnings),
            quality_tier        = quality_tier,
            quality_score       = quality_score,
            chars_per_page      = eq.chars_per_page      if eq else 0.0,
            noise_ratio         = eq.noise_ratio         if eq else 0.0,
            coverage_ratio      = coverage_ratio,
            coverage_verdict    = coverage_verdict,
            empty_pages         = eq.empty_pages         if eq else [],
            ocr_page_count      = eq.ocr_page_count      if eq else 0,
            ocr_avg_confidence  = eq.ocr_avg_confidence  if eq else None,
            ocr_low_conf_pages  = eq.ocr_low_conf_pages  if eq else [],
            extraction_notes    = extraction_notes,
            chunking_verdict    = chunking_verdict,
            chunk_coverage_ratio    = chunk_coverage_ratio,
            uncovered_char_estimate = uncovered_estimate,
            duplicate_pairs         = duplicate_pairs,
            avg_chunk_confidence    = avg_chunk_conf,
            high_conf_count         = high_conf,
            medium_conf_count       = medium_conf,
            low_conf_count          = low_conf,
            chunking_notes          = chunking_notes,
            semantic_gap_count      = semantic_gap_count,
            diagram_gap_count       = diagram_gap_count,
            table_gap_count         = table_gap_count,
            equation_gap_count      = equation_gap_count,
            semantic_gaps           = semantic_gaps,
            semantic_completeness   = semantic_completeness,
            blockers                = blockers,
            warnings                = warnings,
            low_confidence_chunk_ids= low_conf_ids,
        )
        return report

    def run_batch(self, storage_paths: list[str]) -> list[IngestionResult | dict]:
        """
        Process multiple PDFs sequentially.

        Failed documents are returned as error dicts so one bad PDF
        does not abort the entire batch.

        Args:
            storage_paths: List of Supabase storage paths.

        Returns:
            List of IngestionResult objects, with error dicts for
            any documents that failed.
        """
        results = []
        for path in storage_paths:
            try:
                results.append(self.run(path))
            except Exception as exc:
                logger.error("Failed to process '%s': %s", path, exc)
                results.append({"doc_id": path, "error": str(exc)})
        return results


# ---------------------------------------------------------------------------
# Entry point (for manual testing / CLI use)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse
    import json

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    parser = argparse.ArgumentParser(
        description="Run PDF ingestion pipeline (download → extract → chunk)"
    )
    parser.add_argument(
        "storage_paths",
        nargs="+",
        help="One or more Supabase storage paths, e.g. user-id/doc.pdf",
    )
    args = parser.parse_args()

    pipeline = IngestionPipeline()
    batch_results = pipeline.run_batch(args.storage_paths)

    # Print a JSON-serialisable summary (exclude raw content/chunks)
    summary = [
        {
            "doc_id":             r.doc_id,
            "page_count":         r.page_count,
            "chunk_count":        r.chunk_count,
            "stage2_ready":       len(r.stage2_ready_chunks),
            "pipeline_ok":        r.pipeline_ok,
            "overall_confidence": r.integrity_report.overall_confidence,
            "quality_tier":       r.integrity_report.quality_tier,
            "coverage_verdict":   r.integrity_report.coverage_verdict,
            "chunking_verdict":   r.integrity_report.chunking_verdict,
            "avg_chunk_conf":     r.integrity_report.avg_chunk_confidence,
            "low_conf_chunks":    r.integrity_report.low_conf_count,
            "blockers":           r.integrity_report.blockers,
            "warnings":           r.integrity_report.warnings,
        }
        if isinstance(r, IngestionResult)
        else r
        for r in batch_results
    ]
    print(json.dumps(summary, indent=2))
