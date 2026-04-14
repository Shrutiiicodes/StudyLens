"""
chunker.py
Splits extracted document text into overlapping chunks suitable
for knowledge-graph node creation and embedding.
"""

import logging
import re
from dataclasses import dataclass, field
from typing import Optional

from .pdf_extractor import DocumentContent

logger = logging.getLogger(__name__)


@dataclass
class TextChunk:
    """A single piece of text ready for graph ingestion."""

    chunk_id: str            # "{doc_id}::chunk_{index}"
    doc_id: str              # Supabase storage path or any stable identifier
    text: str
    char_count: int
    chunk_index: int         # 0-based position within the document
    start_page: Optional[int] = None
    end_page: Optional[int] = None
    metadata: dict = field(default_factory=dict)

    # ── Chunk-level confidence (set by Chunker._score_chunk_confidence) ───
    # Stage 2 KG extraction uses these to adjust the LLM verification
    # threshold: low-confidence chunks get a stricter cutoff (0.88 vs 0.80).
    confidence_score: float = 0.0        # 0.0–1.0; 0.0 = not yet scored
    confidence_flags: list = field(default_factory=list)  # e.g. ["BOUNDARY_CUT"]


@dataclass
class ChunkingIntegrityReport:
    """
    Produced by Chunker.check_integrity() after chunk_document() completes.
    Summarises whether the chunks cover all extracted text and flags problems.
    Consumed by pipeline.py to assemble the final DocumentIntegrityReport.
    """
    doc_id:                  str
    verdict:                 str    # "COMPLETE" | "GAPS" | "DUPLICATES"
    chunk_coverage_ratio:    float  # chunk chars / extracted chars (capped at 1.0)
    total_chunk_chars:       int
    total_extracted_chars:   int
    uncovered_char_estimate: int    # approx chars not in any chunk
    duplicate_pairs:         list   # [(chunk_id_a, chunk_id_b, similarity), ...]
    avg_confidence:          float  # mean confidence across all chunks
    high_conf_count:         int
    medium_conf_count:       int
    low_conf_count:          int
    notes:                   list[str] = field(default_factory=list)


class Chunker:
    """
    Splits a DocumentContent object into overlapping text chunks.

    Strategy
    --------
    1. Prefer splitting on paragraph / sentence boundaries.
    2. Fall back to hard character splits when no boundary is found.
    3. Apply a configurable overlap so context is preserved across chunks.

    Parameters
    ----------
    chunk_size   : Target maximum number of characters per chunk.
    chunk_overlap: Number of characters to carry over from the previous chunk.
    min_chunk_size: Chunks smaller than this are dropped (noise filtering).
    """

    # Patterns used to find natural split points (in priority order)
    _SPLIT_PATTERNS = [
        r"\n{2,}",           # blank lines / paragraph breaks
        r"(?<=[.!?])\s+",   # sentence endings
        r"\n",               # single newlines
        r"\s+",              # any whitespace
    ]

    # Used by _score_chunk_confidence() to detect OCR garbage and boundary quality
    _NOISE_RE       = re.compile(
        r"[^\x09\x0A\x0D\x20-\x7E\u00A0-\u024F\u2000-\u206F\u20A0-\u20CF]"
    )
    _SENTENCE_END_RE = re.compile(r"[.?!]\s|[.?!]$")

    # ── Semantic content-type detectors ───────────────────────────────────────
    # Used by _score_chunk_confidence() to identify chunks whose text
    # is structurally present but semantically incomplete.

    # A chunk that is only a figure/table caption — the content it describes
    # is an image and is absent from the text layer entirely.
    _CAPTION_ONLY_RE = re.compile(
        r"^\s*(fig(?:ure)?\.?\s*\d+|table\s*\d+|diagram\s*\d*|"
        r"chart\s*\d*|illustration\s*\d*)\b[^.]{0,120}$",
        re.IGNORECASE | re.DOTALL,
    )

    # A chunk that is a table remnant — high numeric / pipe density,
    # very few sentence-forming words.
    _TABLE_ROW_RE = re.compile(
        r"(\d+\.?\d*\s+){3,}"    # 3+ numbers in a row
        r"|(\|\s*\w+\s*){2,}"    # pipe-separated cells
    )

    # A chunk that contains a degraded equation.
    _MATH_DENSE_RE = re.compile(
        r"[∫∑∏√∞±×÷≈≠≤≥∂∇∆αβγδεζηθλμπρσφψωΑΒΓΔΕΖΗΘΛΜΠΡΣΦΨΩ∈∉⊂⊃∪∩]"
        r"|\\(?:frac|sqrt|sum|int|lim|alpha|beta|gamma|delta|theta|lambda|mu|pi|sigma)\b"
        r"|\^[\d\w{]"
    )

    def __init__(
        self,
        chunk_size: int = 1000,
        chunk_overlap: int = 150,
        min_chunk_size: int = 50,
    ):
        if chunk_overlap >= chunk_size:
            raise ValueError("chunk_overlap must be less than chunk_size")
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        self.min_chunk_size = min_chunk_size

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def chunk_document(
        self, content: DocumentContent, doc_id: str
    ) -> list[TextChunk]:
        """
        Split a DocumentContent into a list of TextChunk objects.

        Args:
            content: Extracted document from PDFExtractor.
            doc_id : Stable identifier for the source document
                     (e.g. Supabase storage path).

        Returns:
            Ordered list of TextChunk objects.
        """
        if content.is_empty:
            logger.warning("Document '%s' has no text; returning empty chunk list.", doc_id)
            return []

        cleaned_text = self._clean_text(content.full_text)
        raw_chunks = self._split_text(cleaned_text)
        chunks: list[TextChunk] = []

        for idx, text in enumerate(raw_chunks):
            if len(text) < self.min_chunk_size:
                logger.debug("Dropping tiny chunk #%d (%d chars)", idx, len(text))
                continue

            # Best-effort page attribution: find which page(s) this chunk spans
            start_page, end_page = self._locate_pages(text, content)

            chunk = TextChunk(
                chunk_id=f"{doc_id}::chunk_{idx}",
                doc_id=doc_id,
                text=text.strip(),
                char_count=len(text),
                chunk_index=idx,
                start_page=start_page,
                end_page=end_page,
                metadata={
                    "title": content.title,
                    "author": content.author,
                    "total_pages": content.page_count,
                },
            )
            self._score_chunk_confidence(chunk)
            chunks.append(chunk)

        logger.info(
            "Produced %d chunk(s) from document '%s' (chunk_size=%d, overlap=%d)",
            len(chunks),
            doc_id,
            self.chunk_size,
            self.chunk_overlap,
        )
        return chunks

    # ------------------------------------------------------------------
    # Chunk confidence scoring
    # ------------------------------------------------------------------

    def _score_chunk_confidence(self, chunk: TextChunk) -> None:
        """
        Score a single chunk's extraction quality and write the result
        directly onto chunk.confidence_score and chunk.confidence_flags.

        Five structural signals (weighted composite):
          30% text coherence      — sentence completeness, word density
          25% cleanliness         — inverse of noise/garbled char ratio
          20% length adequacy     — not a tiny fragment
          15% boundary integrity  — starts uppercase, ends with punctuation
          10% page attribution    — was this chunk found on a known page?

        Three semantic content-type checks (applied as penalties after
        the structural score is computed):
          CAPTION_ONLY      — chunk is only a figure/table label; the
                              content it describes is an image and absent.
                              Penalty: score capped at 0.35.
          TABLE_REMNANT     — chunk looks like a flat text dump of a table;
                              row/column structure is destroyed.
                              Penalty: score capped at 0.45.
          EQUATION_DEGRADED — chunk contains dense math symbols that
                              survived extraction but are garbled.
                              Penalty: score capped at 0.50.
        """
        text = chunk.text

        # ── Structural signals ────────────────────────────────────────────

        # Signal 1: Text coherence
        spaces       = text.count(" ")
        word_density = spaces / max(len(text), 1)
        density_ok   = word_density >= (1 / 8)
        ends         = len(self._SENTENCE_END_RE.findall(text))
        term_score   = min(ends / max(ends, 1), 1.0)
        words        = text.split()
        avg_wlen     = sum(len(w) for w in words) / max(len(words), 1)
        wlen_score   = 1.0 if avg_wlen <= 12 else max(1.0 - (avg_wlen - 12) / 20, 0.0)
        coherence    = round(
            0.4 * term_score + 0.3 * (1.0 if density_ok else 0.3) + 0.3 * wlen_score, 4
        )

        # Signal 2: Noise ratio
        noise        = round(len(self._NOISE_RE.findall(text)) / max(len(text), 1), 4)
        cleanliness  = max(1.0 - noise * 20, 0.0)

        # Signal 3: Length adequacy
        is_too_short = len(text) < 100
        length_score = 0.2 if is_too_short else min((len(text) - 100) / 900, 1.0)

        # Signal 4: Boundary integrity
        stripped     = text.strip()
        start_char   = stripped.lstrip("# ").lstrip()[:1]
        starts_ok    = bool(start_char and (start_char.isupper() or start_char.isdigit()))
        ends_ok      = bool(stripped and stripped[-1] in ".?!\"'")
        if starts_ok and ends_ok:
            boundary_score = 1.0
        elif starts_ok and not ends_ok:
            boundary_score = 0.5
        elif not starts_ok and ends_ok:
            boundary_score = 0.75
        else:
            boundary_score = 0.35

        # Signal 5: Page attribution
        located_score = 1.0 if chunk.start_page is not None else 0.7

        confidence = round(
            0.30 * coherence       +
            0.25 * cleanliness     +
            0.20 * length_score    +
            0.15 * boundary_score  +
            0.10 * located_score,
            4,
        )
        confidence = min(max(confidence, 0.0), 1.0)

        # ── Structural flags ──────────────────────────────────────────────
        flags: list[str] = []
        if is_too_short:
            flags.append("FRAGMENT")
        if not starts_ok:
            flags.append("START_CUT")
        if not ends_ok:
            flags.append("END_CUT")
        if not starts_ok and not ends_ok:
            flags.append("BOUNDARY_CUT")
        if noise > 0.05:
            flags.append(f"HIGH_NOISE:{noise:.2%}")
        if coherence < 0.40:
            flags.append("LOW_COHERENCE")
        if chunk.start_page is None:
            flags.append("PAGE_UNLOCATED")

        # ── Semantic content-type checks (penalties) ──────────────────────

        # Check 1: CAPTION_ONLY
        # The chunk is just a figure or table label — e.g. "Figure 3.2: The Krebs
        # Cycle". The actual diagram content is an image and was never extracted.
        # Stage 2 will form a triple like (Krebs Cycle, DEFINES, ?) with no body.
        if self._CAPTION_ONLY_RE.match(stripped):
            flags.append("CAPTION_ONLY")
            confidence = min(confidence, 0.35)

        # Check 2: TABLE_REMNANT
        # The chunk is a flat text dump of what was a structured table.
        # Detect by: high ratio of numeric tokens OR presence of pipe-separated
        # cells. If > 40% of lines look like data rows, flag it.
        else:
            lines = [l.strip() for l in text.split("\n") if l.strip()]
            if lines:
                table_like_lines = sum(
                    1 for l in lines if self._TABLE_ROW_RE.search(l)
                )
                numeric_tokens = sum(
                    1 for w in words
                    if re.fullmatch(r"[\d.,%;:\-/]+", w)
                )
                numeric_ratio = numeric_tokens / max(len(words), 1)

                if (table_like_lines / len(lines) >= 0.40) or (numeric_ratio > 0.55 and len(lines) >= 3):
                    flags.append("TABLE_REMNANT")
                    confidence = min(confidence, 0.45)

        # Check 3: EQUATION_DEGRADED
        # The chunk contains math symbols that survived extraction but are
        # garbled — the structural relationships (exponents, fractions,
        # subscripts) are flattened into a linear symbol sequence.
        math_hits = self._MATH_DENSE_RE.findall(text)
        if len(math_hits) >= 3:
            math_density = len(math_hits) / max(len(words), 1)
            if math_density > 0.5:
                # More than one math symbol per two words — equation dominant
                flags.append(f"EQUATION_DEGRADED:{len(math_hits)}_symbols")
                confidence = min(confidence, 0.50)
            elif len(math_hits) >= 5:
                # Many symbols but diluted by prose — partially degraded
                flags.append(f"EQUATION_INLINE:{len(math_hits)}_symbols")
                # No hard cap — just informational

        chunk.confidence_score = confidence
        chunk.confidence_flags = flags

    # ------------------------------------------------------------------
    # Chunking integrity check
    # ------------------------------------------------------------------

    def check_integrity(
        self, chunks: list[TextChunk], doc_id: str, extracted_chars: int
    ) -> ChunkingIntegrityReport:
        """
        Verify that the chunks collectively cover all extracted text and
        flag duplicates. Call this after chunk_document() completes.

        Args:
            chunks:          The list returned by chunk_document().
            doc_id:          Document identifier (for the report).
            extracted_chars: Total chars in DocumentContent.full_text
                             (after clean_text). Used to compute coverage.

        Returns:
            ChunkingIntegrityReport with verdict and per-issue notes.
        """
        total_chunk_chars  = sum(len(c.text) for c in chunks)
        chunk_coverage     = round(
            min(total_chunk_chars / max(extracted_chars, 1), 1.0), 4
        )
        uncovered_estimate = max(0, extracted_chars - total_chunk_chars)

        # Duplicate detection — Jaccard 5-gram similarity
        def _ngrams(text: str, n: int = 5) -> set:
            tokens = text.lower().split()
            return set(zip(*[tokens[i:] for i in range(n)])) if len(tokens) >= n else set()

        duplicate_pairs: list[tuple] = []
        n = len(chunks)
        for i in range(n):
            for j in range(i + 1, n):
                ng_a  = _ngrams(chunks[i].text)
                ng_b  = _ngrams(chunks[j].text)
                union = ng_a | ng_b
                if not union:
                    continue
                sim = len(ng_a & ng_b) / len(union)
                if sim >= 0.85:
                    duplicate_pairs.append(
                        (chunks[i].chunk_id, chunks[j].chunk_id, round(sim, 4))
                    )

        # Confidence aggregates
        total     = max(len(chunks), 1)
        avg_conf  = round(sum(c.confidence_score for c in chunks) / total, 4)
        high_c    = sum(1 for c in chunks if c.confidence_score >= 0.80)
        medium_c  = sum(1 for c in chunks if 0.50 <= c.confidence_score < 0.80)
        low_c     = sum(1 for c in chunks if c.confidence_score < 0.50)

        # Verdict
        if chunk_coverage < 0.75:
            verdict = "GAPS"
        elif duplicate_pairs:
            verdict = "DUPLICATES"
        else:
            verdict = "COMPLETE"

        notes: list[str] = []
        if chunk_coverage < 0.90:
            notes.append(
                f"Chunk coverage is {chunk_coverage:.0%}. "
                f"~{uncovered_estimate:,} chars of extracted text are not "
                "included in any chunk and will be invisible to Stage 2."
            )
        if chunk_coverage < 0.75:
            notes.append(
                "CRITICAL: More than 25% of extracted text is unchunked. "
                "Adjust chunk_size or boundary detection logic."
            )
        if duplicate_pairs:
            notes.append(
                f"{len(duplicate_pairs)} near-duplicate chunk pair(s) detected. "
                "These will produce redundant KG triples and inflate Stage 2 cost."
            )
        if avg_conf < 0.55:
            notes.append(
                f"Average chunk confidence is {avg_conf:.0%}. "
                "Raise the LLM verification threshold to 0.88 for this document."
            )
        if low_c > 0:
            notes.append(
                f"{low_c} LOW-confidence chunk(s) detected. "
                "Check chunk.confidence_flags for specific issues per chunk."
            )

        return ChunkingIntegrityReport(
            doc_id                 = doc_id,
            verdict                = verdict,
            chunk_coverage_ratio   = chunk_coverage,
            total_chunk_chars      = total_chunk_chars,
            total_extracted_chars  = extracted_chars,
            uncovered_char_estimate= uncovered_estimate,
            duplicate_pairs        = duplicate_pairs,
            avg_confidence         = avg_conf,
            high_conf_count        = high_c,
            medium_conf_count      = medium_c,
            low_conf_count         = low_c,
            notes                  = notes,
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _clean_text(self, text: str) -> str:
        """
        Clean extracted PDF text before chunking.

        Handles artefacts that survive the extractor's dedup logic,
        particularly patterns from typeset NCERT/Indian textbook PDFs.

        Steps (in order):
        1. Collapse runs of 3+ identical short lines — catches any
           heading fragments that weren't caught at the block level.
        2. Collapse 3+ consecutive blank lines into a single blank line.
        3. Strip page number lines (isolated numbers like "24" or "2019-20").
        4. Strip standalone URL/watermark lines (e.g. "www.ncertbooks.net").
        5. Normalise whitespace within each line.
        """
        lines = text.split("\n")
        out: list[str] = []

        i = 0
        while i < len(lines):
            line = lines[i].strip()

            # Rule 3: drop bare page numbers and year stamps
            if re.fullmatch(r"\d{1,4}(-\d{2,4})?", line):
                i += 1
                continue

            # Rule 4: drop watermark / URL lines
            if re.match(r"\s*(https?://|www\.)\S+\s*$", line, re.IGNORECASE):
                i += 1
                continue

            # Rule 1: collapse runs of 3+ identical (or near-identical) short lines
            # These are residual heading fragments not caught at extraction time.
            run_end = i + 1
            while (
                run_end < len(lines)
                and len(line) <= 40
                and lines[run_end].strip().lower() == line.lower()
            ):
                run_end += 1
            if run_end > i + 2:
                # 3+ identical lines — keep just one
                out.append(line)
                i = run_end
                continue

            out.append(line)
            i += 1

        # Rule 2: collapse 3+ consecutive blank lines → one blank line
        cleaned = re.sub(r"\n{3,}", "\n\n", "\n".join(out))

        return cleaned.strip()

    def _split_text(self, text: str) -> list[str]:
        """
        Recursively split text into chunks respecting natural boundaries
        and applying overlap between consecutive chunks.
        """
        if len(text) <= self.chunk_size:
            return [text]

        # Try split patterns in order until we get multiple sub-strings
        splits = self._find_splits(text)

        chunks: list[str] = []
        current = ""

        for segment in splits:
            if len(current) + len(segment) <= self.chunk_size:
                current += segment
            else:
                if current:
                    chunks.append(current)
                # Start new chunk with overlap from end of previous
                overlap_text = self._get_overlap(current)
                current = overlap_text + segment

                # If a single segment itself exceeds chunk_size, hard-split it
                while len(current) > self.chunk_size:
                    chunks.append(current[: self.chunk_size])
                    current = current[self.chunk_size - self.chunk_overlap :]

        if current.strip():
            chunks.append(current)

        return chunks

    def _find_splits(self, text: str) -> list[str]:
        """Split text using the first pattern that yields >1 parts."""
        for pattern in self._SPLIT_PATTERNS:
            parts = re.split(f"({pattern})", text)
            # Re-join separators with the preceding segment
            rejoined: list[str] = []
            for i in range(0, len(parts) - 1, 2):
                rejoined.append(parts[i] + (parts[i + 1] if i + 1 < len(parts) else ""))
            if parts and len(parts) % 2 != 0:
                rejoined.append(parts[-1])
            if len(rejoined) > 1:
                return rejoined

        # No pattern worked — hard-split by chunk_size
        return [
            text[i : i + self.chunk_size]
            for i in range(0, len(text), self.chunk_size - self.chunk_overlap)
        ]

    def _get_overlap(self, text: str) -> str:
        """Return the trailing overlap_size characters of text."""
        if not text or self.chunk_overlap == 0:
            return ""
        return text[-self.chunk_overlap :]

    def _locate_pages(
        self, chunk_text: str, content: DocumentContent
    ) -> tuple[Optional[int], Optional[int]]:
        """
        Find which page(s) a chunk comes from using a whitespace-normalised
        probe so extraction formatting differences do not break attribution.
        """
        def normalise(text: str) -> str:
            return re.sub(r"\s+", " ", text).strip()

        probe = normalise(chunk_text[:80])
        if not probe:
            return None, None

        start_page: Optional[int] = None
        end_page: Optional[int] = None

        for page in content.pages:
            if probe in normalise(page.text):
                if start_page is None:
                    start_page = page.page_number
                end_page = page.page_number

        return start_page, end_page
