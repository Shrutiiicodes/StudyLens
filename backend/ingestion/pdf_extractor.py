"""
pdf_extractor.py
Extracts text and metadata from PDF files using PyMuPDF (fitz).

Strategy (per page)
-------------------
1. Try native text extraction via PyMuPDF — fast, lossless.
2. If a page comes back empty (scanned / image-only), render it to
   a high-res image, apply preprocessing to improve OCR quality,
   then run Tesseract OCR on it.
3. If OCR also fails or Tesseract is not installed, log a warning
   and continue — never crash the pipeline over one bad page.

Preprocessing pipeline (applied before OCR, in order)
------------------------------------------------------
1. Upscale  — render at high DPI to give Tesseract more pixel data
2. Greyscale — remove colour noise, simplify the image
3. Denoise  — light Gaussian blur to smooth JPEG / sensor noise
4. Deskew   — detect and correct page tilt from handheld photos
5. Adaptive threshold — binarise per local region so dark corners
               and uneven phone lighting don't destroy OCR accuracy

Dependencies
------------
    pip install pymupdf pytesseract pillow opencv-python-headless numpy
    # Tesseract binary:
    # macOS  : brew install tesseract
    # Ubuntu : sudo apt install tesseract-ocr
    # Windows: https://github.com/UB-Mannheim/tesseract/wiki
"""

import io
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import fitz  # PyMuPDF

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Optional OCR imports — degrade gracefully if not installed
# ---------------------------------------------------------------------------
try:
    import pytesseract
    from PIL import Image
    OCR_AVAILABLE = True
except ImportError:
    OCR_AVAILABLE = False
    logger.warning(
        "pytesseract / Pillow not installed. OCR fallback disabled. "
        "Run: pip install pytesseract pillow"
    )

try:
    import cv2
    import numpy as np
    CV2_AVAILABLE = True
except ImportError:
    CV2_AVAILABLE = False
    logger.warning(
        "opencv-python-headless / numpy not installed. "
        "Image preprocessing (deskew, adaptive threshold) will be skipped. "
        "Run: pip install opencv-python-headless numpy"
    )


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class SemanticGap:
    """
    A specific piece of content detected on a page that either could not
    be extracted at all (image body) or was extracted but lost its
    structure (table, equation).

    gap_type  : "DIAGRAM"  — an image whose body is not in the text layer;
                             only the caption (if any) was extracted.
                "TABLE"    — a table whose row/column structure was lost;
                             cells may have been extracted as a flat text run.
                "EQUATION" — a mathematical expression that survived
                             extraction but is garbled or symbol-heavy.
    severity  : "HIGH"   — concept is entirely absent from the text layer.
                "MEDIUM" — partial information survived but is unreliable.
                "LOW"    — minor degradation; LLM may still parse correctly.
    caption   : The caption text detected near the element, if any.
                For diagrams this is the only content that reached Stage 2.
    """
    gap_type:    str              # "DIAGRAM" | "TABLE" | "EQUATION"
    page_number: int
    description: str              # Human-readable summary for the teacher dashboard
    severity:    str              # "HIGH" | "MEDIUM" | "LOW"
    caption:     Optional[str] = None
    recovered_text: Optional[str] = None


@dataclass
class PageContent:
    """Structured content extracted from a single PDF page."""
    page_number: int        # 1-based
    text: str
    char_count: int
    has_images: bool
    ocr_applied: bool = False
    preprocessing_applied: bool = False
    ocr_confidence: Optional[float] = None  # Mean Tesseract word confidence 0–100; None for native pages
    semantic_gaps: list = field(default_factory=list)  # list[SemanticGap] detected on this page


@dataclass
class ExtractionQualityReport:
    """
    Per-document extraction quality assessment produced by PDFExtractor.
    Attached to DocumentContent.extraction_quality after extract() completes.
    Consumed by the pipeline to gate Stage 2 dispatch and adjust KG
    verification thresholds.
    """
    quality_tier:       str           # "HIGH" | "MEDIUM" | "LOW" | "UNREADABLE"
    quality_score:      float         # 0.0–1.0 composite
    chars_per_page:     float
    noise_ratio:        float         # Fraction of garbled / non-printable chars
    empty_pages:        list[int]     # Page numbers that yielded < 50 chars
    ocr_page_count:     int           # Pages where Tesseract was used
    ocr_avg_confidence: Optional[float]  # Mean Tesseract word confidence (0–100)
    ocr_low_conf_pages: list[int]     # OCR pages where confidence < 60
    coverage_ratio:     float         # Extracted chars / expected chars (0–1)
    coverage_verdict:   str           # "COMPLETE" | "PARTIAL" | "SPARSE"
    # ── Semantic gap summary ─────────────────────────────────────────────────
    semantic_gap_count:    int = 0
    diagram_gap_count:     int = 0    # Images whose body is absent from text layer
    table_gap_count:       int = 0    # Tables whose structure was destroyed
    equation_gap_count:    int = 0    # Equations that are garbled or symbol-only
    semantic_gaps:         list = field(default_factory=list)  # list[SemanticGap]
    notes:                 list[str] = field(default_factory=list)


@dataclass
class DocumentContent:
    """Aggregated content extracted from an entire PDF document."""
    file_path: str
    title: Optional[str]
    author: Optional[str]
    page_count: int
    full_text: str
    pages: list[PageContent] = field(default_factory=list)
    extraction_quality: Optional[ExtractionQualityReport] = None  # Set after extract()

    @property
    def all_semantic_gaps(self) -> list:
        """Flattened list of SemanticGap objects across all pages."""
        return [gap for page in self.pages for gap in page.semantic_gaps]

    @property
    def is_empty(self) -> bool:
        return not self.full_text.strip()

    @property
    def ocr_page_count(self) -> int:
        return sum(1 for p in self.pages if p.ocr_applied)

    @property
    def preprocessed_page_count(self) -> int:
        return sum(1 for p in self.pages if p.preprocessing_applied)


# ---------------------------------------------------------------------------
# Extractor
# ---------------------------------------------------------------------------

class PDFExtractor:
    """
    Extracts text from PDFs with automatic OCR fallback and image
    preprocessing for dark / blurry / skewed phone-photo scans.

    Per-page logic:
    - Native PyMuPDF extraction is always attempted first.
    - Pages with fewer than `ocr_threshold` chars go through OCR.
    - Before Tesseract runs, the page image is preprocessed:
        upscale → greyscale → denoise → deskew → adaptive threshold
    - Pages that fail OCR are included as empty strings so page
      numbering stays intact for downstream chunking.

    Parameters
    ----------
    sort_blocks       : Sort text blocks top-to-bottom (helps multi-column).
    ocr_threshold     : Min chars before a page is considered empty.
    ocr_dpi           : Render DPI. Higher = better OCR, slower processing.
                        300 is standard; 400 for very dark/small text.
    ocr_language      : Tesseract language code(s), e.g. "eng", "eng+hin".
    adaptive_block    : Block size for adaptive thresholding (must be odd).
                        Smaller = finer local adjustment. Default 31 works
                        well for most textbook fonts.
    adaptive_c        : Constant subtracted from mean in adaptive threshold.
                        Higher = more aggressive binarisation.
    deskew_enabled    : Whether to auto-correct page tilt before OCR.
    deskew_max_angle  : Maximum degrees of tilt to attempt to correct.
    """

    # Noise: characters outside normal printable + extended-Latin Unicode ranges.
    # Used by _compute_extraction_quality() to measure OCR garbage density.
    _NOISE_RE = re.compile(
        r"[^\x09\x0A\x0D\x20-\x7E\u00A0-\u024F\u2000-\u206F\u20A0-\u20CF]"
    )

    # Caption detection — lines that introduce a figure, diagram, or table.
    # Used to identify that an image or table exists even when its body is absent.
    _CAPTION_RE = re.compile(
        r"^\s*(fig(?:ure)?\.?\s*\d+|table\s*\d+|diagram\s*\d*|"
        r"chart\s*\d*|illustration\s*\d*|image\s*\d*|"
        r"exhibit\s*\d*|appendix\s*[a-z]?\d*)\b",
        re.IGNORECASE,
    )

    # Math symbol detection — Unicode math operators, Greek letters, and
    # LaTeX-style patterns that indicate an equation block.
    _MATH_SYMBOLS_RE = re.compile(
        r"[∫∑∏√∞±×÷≈≠≤≥∂∇∆αβγδεζηθλμπρσφψωΑΒΓΔΕΖΗΘΛΜΠΡΣΦΨΩ∈∉⊂⊃∪∩⊕⊗]"
        r"|\\(?:frac|sqrt|sum|int|prod|lim|infty|alpha|beta|gamma|delta|theta|lambda|mu|pi|sigma|phi|omega)\b"
        r"|\d+\s*[²³⁴⁵⁶⁷⁸⁹]"   # superscript digits
        r"|\^[\d\w{]"             # caret exponent notation
    )

    # Table remnant detection — text that was a table but lost its structure.
    # Looks for lines of short pipe-separated, tab-separated, or
    # tightly-spaced numeric/short-token columns.
    _TABLE_CELL_RE = re.compile(
        r"(\d+\.?\d*\s+){3,}"        # 3+ numbers in a row (CSV-like)
        r"|(\|\s*\w+\s*){2,}"         # pipe-separated cells
        r"|(\t\S+){2,}"               # tab-separated tokens
    )

    def __init__(
        self,
        sort_blocks: bool = True,
        ocr_threshold: int = 10,
        ocr_dpi: int = 300,
        ocr_language: str = "eng",
        adaptive_block: int = 31,
        adaptive_c: int = 15,
        deskew_enabled: bool = True,
        deskew_max_angle: float = 10.0,
    ):
        self.sort_blocks = sort_blocks
        self.ocr_threshold = ocr_threshold
        self.ocr_dpi = ocr_dpi
        self.ocr_language = ocr_language
        self.adaptive_block = adaptive_block
        self.adaptive_c = adaptive_c
        self.deskew_enabled = deskew_enabled
        self.deskew_max_angle = deskew_max_angle

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def extract(self, pdf_path: str) -> DocumentContent:
        """
        Extract all text and metadata from a PDF file.

        Args:
            pdf_path: Absolute path to the PDF on disk.

        Returns:
            DocumentContent with per-page breakdown and aggregated
            full_text. OCR + preprocessing applied transparently.

        Raises:
            FileNotFoundError: If the file does not exist.
            ValueError:        If the file cannot be opened as a PDF.
        """
        path = Path(pdf_path)
        if not path.exists():
            raise FileNotFoundError(f"PDF not found: {pdf_path}")

        logger.info("Extracting text from: %s", path.name)

        try:
            doc = fitz.open(str(path))
        except Exception as exc:
            raise ValueError(f"Cannot open PDF '{pdf_path}': {exc}") from exc

        with doc:
            meta = doc.metadata or {}
            pages: list[PageContent] = []

            for page_index in range(len(doc)):
                page = doc[page_index]
                page_content = self._extract_page(page, page_index + 1)
                pages.append(page_content)

        full_text = "\n\n".join(p.text for p in pages if p.text)

        content = DocumentContent(
            file_path=str(path),
            title=meta.get("title") or None,
            author=meta.get("author") or None,
            page_count=len(pages),
            full_text=full_text,
            pages=pages,
        )

        content.extraction_quality = self._compute_extraction_quality(content)
        self._log_summary(content, path.name)
        return content

    # ------------------------------------------------------------------
    # Per-page extraction
    # ------------------------------------------------------------------

    def _extract_page(self, page: fitz.Page, page_number: int) -> PageContent:
        """
        Extract text from a single page. Falls back to preprocessed OCR
        if native extraction yields too little text. Never raises.
        """
        images = page.get_images(full=False)
        has_images = len(images) > 0

        # ── Native extraction with span deduplication ──────────────────
        # Some PDFs (e.g. NCERT textbooks) render stylised headings as two
        # overlapping text layers — a shadow/outline pass plus the main text
        # pass on top. PyMuPDF extracts both, producing repeated words like
        # "The stor The story of Har y of Harappa". Fix: extract at the span
        # level, drop spans whose text duplicates the previous span on the
        # same line, then reassemble into clean line strings.
        text = self._extract_deduplicated(page)

        if len(text) >= self.ocr_threshold:
            gaps, recovered_text = self._detect_semantic_gaps(page, page_number, text)
            full_text = (text + "\n\n" + recovered_text).strip() if recovered_text else text
            return PageContent(
                page_number=page_number,
                text=full_text,
                char_count=len(full_text),
                has_images=has_images,
                ocr_applied=False,
                preprocessing_applied=False,
                semantic_gaps=gaps,
            )

        # ── OCR fallback ───────────────────────────────────────────────
        if not OCR_AVAILABLE:
            logger.warning(
                "Page %d is empty and OCR is not available. Skipping.", page_number
            )
            return PageContent(
                page_number=page_number,
                text="",
                char_count=0,
                has_images=has_images,
            )

        logger.info(
            "Page %d: native text too short (%d chars) — running OCR with preprocessing …",
            page_number, len(text),
        )
        ocr_text, preprocessed, ocr_confidence = self._ocr_page(page, page_number)
        gaps, recovered_text = self._detect_semantic_gaps(page, page_number, ocr_text)
        full_ocr_text = (ocr_text + "\n\n" + recovered_text).strip() if recovered_text else ocr_text

        return PageContent(
            page_number=page_number,
            text=full_ocr_text,
            char_count=len(full_ocr_text),
            has_images=has_images,
            ocr_applied=True,
            preprocessing_applied=preprocessed,
            ocr_confidence=ocr_confidence,
            semantic_gaps=gaps,
        )

    # ------------------------------------------------------------------
    # OCR with preprocessing
    # ------------------------------------------------------------------

    def _ocr_page(self, page: fitz.Page, page_number: int) -> tuple[str, bool, Optional[float]]:
        """
        Render a page to an image, preprocess it, and run Tesseract.
        Returns (ocr_text, preprocessing_was_applied, ocr_confidence).
        """
        try:
            # Step 1: Render at high DPI
            zoom = self.ocr_dpi / 72
            matrix = fitz.Matrix(zoom, zoom)
            pixmap = page.get_pixmap(matrix=matrix, alpha=False)
            img_bytes = pixmap.tobytes("png")

            preprocessed = False

            if CV2_AVAILABLE:
                # Step 2–5: Full preprocessing pipeline
                img_array = self._bytes_to_cv2(img_bytes)
                img_array = self._greyscale(img_array)
                img_array = self._denoise(img_array)
                if self.deskew_enabled:
                    img_array = self._deskew(img_array, page_number)
                img_array = self._adaptive_threshold(img_array)
                pil_image = self._cv2_to_pil(img_array)
                preprocessed = True
            else:
                logger.info(
                    "Page %d: OpenCV not available, skipping preprocessing.", page_number
                )
                pil_image = Image.open(io.BytesIO(img_bytes))

            # Step 6: Tesseract OCR — use image_to_data to capture word-level
            # confidence scores alongside the recognised text.
            if OCR_AVAILABLE:
                try:
                    tsv_data = pytesseract.image_to_data(
                        pil_image,
                        lang=self.ocr_language,
                        config="--psm 3 --oem 3",
                        output_type=pytesseract.Output.DICT,
                    )
                    confs = []
                    words = []
                    for word, conf_str in zip(tsv_data["text"], tsv_data["conf"]):
                        try:
                            conf_val = int(conf_str)
                        except (ValueError, TypeError):
                            continue
                        if conf_val >= 0:
                            confs.append(conf_val)
                            if str(word).strip():
                                words.append(str(word).strip())
                    ocr_confidence = round(sum(confs) / len(confs), 2) if confs else 0.0
                    ocr_text = " ".join(words).strip()
                    if not ocr_text:
                        ocr_text = pytesseract.image_to_string(
                            pil_image,
                            lang=self.ocr_language,
                            config="--psm 3 --oem 3",
                        ).strip()
                except Exception as exc:
                    logger.debug(
                        "Page %d: image_to_data failed (%s), falling back to image_to_string.",
                        page_number,
                        exc,
                    )
                    ocr_text = pytesseract.image_to_string(
                        pil_image,
                        lang=self.ocr_language,
                        config="--psm 3 --oem 3",
                    ).strip()
                    ocr_confidence = None
            else:
                ocr_text = ""
                ocr_confidence = None

            logger.info(
                "Page %d: OCR produced %d chars, confidence=%.1f (preprocessing=%s).",
                page_number, len(ocr_text),
                ocr_confidence if ocr_confidence is not None else -1,
                preprocessed,
            )
            return ocr_text, preprocessed, ocr_confidence

        except pytesseract.TesseractNotFoundError:
            logger.error(
                "Tesseract binary not found. "
                "macOS: brew install tesseract | Ubuntu: apt install tesseract-ocr"
            )
            return "", False, None

        except Exception as exc:
            logger.warning("Page %d: OCR failed — %s", page_number, exc)
            return "", False, None

    # ------------------------------------------------------------------
    # Preprocessing steps
    # ------------------------------------------------------------------

    def _bytes_to_cv2(self, img_bytes: bytes):
        """Convert raw PNG bytes to an OpenCV numpy array (BGR)."""
        arr = np.frombuffer(img_bytes, dtype=np.uint8)
        return cv2.imdecode(arr, cv2.IMREAD_COLOR)

    def _cv2_to_pil(self, img) -> "Image.Image":
        """Convert an OpenCV array (greyscale or BGR) to a PIL Image."""
        if len(img.shape) == 2:
            # Already greyscale / binary
            return Image.fromarray(img)
        return Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))

    def _greyscale(self, img):
        """
        Convert to greyscale. Removes colour noise and simplifies
        the image for all subsequent steps.
        """
        return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    def _denoise(self, img):
        """
        Apply a light Gaussian blur to reduce JPEG / sensor noise.
        Kernel size 3 is intentionally small — enough to smooth noise
        without blurring character edges.
        """
        return cv2.GaussianBlur(img, (3, 3), 0)

    def _deskew(self, img, page_number: int):
        """
        Detect and correct tilt caused by handheld photography.

        Uses Hough line transform to find dominant line angles in the
        image, then rotates by the median angle to straighten the page.
        Only corrects if tilt is within deskew_max_angle degrees —
        larger rotations are likely not tilt and are left alone.
        """
        try:
            # Edge detection to find lines
            edges = cv2.Canny(img, 50, 150, apertureSize=3)
            lines = cv2.HoughLinesP(
                edges,
                rho=1,
                theta=np.pi / 180,
                threshold=100,
                minLineLength=img.shape[1] // 4,  # lines must span 25% of width
                maxLineGap=20,
            )

            if lines is None or len(lines) == 0:
                return img

            # Compute angle of each detected line
            angles = []
            for line in lines:
                x1, y1, x2, y2 = line[0]
                if x2 - x1 == 0:
                    continue  # vertical line — skip
                angle = np.degrees(np.arctan2(y2 - y1, x2 - x1))
                # Only keep near-horizontal lines (text lines)
                if abs(angle) < self.deskew_max_angle:
                    angles.append(angle)

            if not angles:
                return img

            median_angle = float(np.median(angles))

            if abs(median_angle) < 0.3:
                return img  # negligible tilt — don't bother rotating

            logger.debug(
                "Page %d: deskewing by %.2f degrees.", page_number, -median_angle
            )

            # Rotate around image centre
            h, w = img.shape[:2]
            centre = (w // 2, h // 2)
            rotation_matrix = cv2.getRotationMatrix2D(centre, median_angle, 1.0)
            rotated = cv2.warpAffine(
                img, rotation_matrix, (w, h),
                flags=cv2.INTER_LINEAR,
                borderMode=cv2.BORDER_REPLICATE,
            )
            return rotated

        except Exception as exc:
            logger.debug("Page %d: deskew failed (%s), continuing.", page_number, exc)
            return img

    def _adaptive_threshold(self, img):
        """
        Binarise the image using adaptive (local) thresholding.

        Unlike global thresholding, this computes an optimal threshold
        for each small region of the image independently. This is the
        key technique for handling:
        - Dark corners from phone camera lenses
        - Uneven flash / ambient lighting across the page
        - Pages with mixed light/dark areas

        The result is a clean black-on-white binary image that Tesseract
        reads much more reliably than the raw greyscale scan.
        """
        # Ensure odd block size (required by OpenCV)
        block = self.adaptive_block if self.adaptive_block % 2 == 1 else self.adaptive_block + 1

        return cv2.adaptiveThreshold(
            img,
            maxValue=255,
            adaptiveMethod=cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            thresholdType=cv2.THRESH_BINARY,
            blockSize=block,
            C=self.adaptive_c,
        )

    # ------------------------------------------------------------------
    # Span-level deduplication  (column-aware)
    # ------------------------------------------------------------------

    def _detect_columns(self, blocks: list, page_width: float) -> Optional[float]:
        """Return the x split point for two-column layouts, or None."""
        if not blocks or page_width <= 0:
            return None

        x0_values = [
            block["bbox"][0]
            for block in blocks
            if block.get("type") == 0 and block.get("bbox")
        ]
        if len(x0_values) < 4:
            return None

        zone_start = page_width * 0.30
        zone_end = page_width * 0.70
        gap_min = page_width * 0.05
        occupied = set(round(x / 2) * 2 for x in x0_values)

        gap_start: Optional[float] = None
        best_gap_mid: Optional[float] = None
        best_gap_width = 0.0

        x = zone_start
        while x <= zone_end:
            bucket = round(x / 2) * 2
            if bucket not in occupied:
                if gap_start is None:
                    gap_start = x
            else:
                if gap_start is not None:
                    gap_width = x - gap_start
                    if gap_width >= gap_min and gap_width > best_gap_width:
                        best_gap_width = gap_width
                        best_gap_mid = gap_start + gap_width / 2
                    gap_start = None
            x += 2

        if gap_start is not None:
            gap_width = zone_end - gap_start
            if gap_width >= gap_min and gap_width > best_gap_width:
                best_gap_mid = gap_start + gap_width / 2

        return best_gap_mid

    def _extract_column(self, blocks: list, x_min: float, x_max: float) -> list[str]:
        """Extract and deduplicate text lines from blocks in one column."""
        lines_out: list[str] = []

        for block in blocks:
            if block.get("type") != 0:
                continue

            bbox = block.get("bbox", (0, 0, 0, 0))
            block_cx = (bbox[0] + bbox[2]) / 2
            if not (x_min <= block_cx < x_max):
                continue

            block_lines: list[str] = []
            for line in block.get("lines", []):
                spans = line.get("spans", [])
                if not spans:
                    continue

                kept_text = ""
                kept_parts = []
                for span in spans:
                    raw_text = span.get("text", "")
                    if not raw_text.strip():
                        kept_parts.append(raw_text)
                        continue
                    candidate = raw_text.strip()
                    if not kept_text:
                        kept_parts.append(raw_text)
                        kept_text = candidate
                    else:
                        if self._is_duplicate_span(candidate, kept_text):
                            continue
                        kept_parts.append(raw_text)
                        kept_text = (kept_text + " " + candidate).strip()

                line_str = "".join(kept_parts).strip()
                if line_str:
                    block_lines.append(line_str)

            lines_out.extend(self._dedup_heading_lines(block_lines))

        return lines_out

    def _extract_deduplicated(self, page: fitz.Page) -> str:
        """
        Extract text with span-level deduplication and basic two-column handling.
        """
        try:
            raw = page.get_text("rawdict", sort=self.sort_blocks)
        except Exception:
            return page.get_text("text", sort=self.sort_blocks).strip()

        blocks = raw.get("blocks", [])
        page_width = page.rect.width if hasattr(page, "rect") else 595.0
        split_x = self._detect_columns(blocks, page_width)

        if split_x is None:
            lines_out = self._extract_column(blocks, x_min=0, x_max=page_width)
            return "\n".join(lines_out).strip()

        logger.debug(
            "Page: two-column layout detected, split at x=%.1f (page width=%.1f)",
            split_x,
            page_width,
        )
        left_lines = self._extract_column(blocks, x_min=0, x_max=split_x)
        right_lines = self._extract_column(blocks, x_min=split_x, x_max=page_width)

        left_text = "\n".join(left_lines).strip()
        right_text = "\n".join(right_lines).strip()
        if left_text and right_text:
            return left_text + "\n\n" + right_text
        return (left_text or right_text).strip()


    def _is_duplicate_span(self, candidate: str, accumulated: str) -> bool:
        """
        Return True if `candidate` is a duplicate/shadow of text already
        accumulated on this line.

        Three cases to catch:

        1. Exact match — same text rendered twice.
           "Harappa" vs "Harappa"

        2. The accumulated text already contains the candidate as a
           substring (shadow layer fragments often appear as pieces).
           accumulated="The story of Harappa", candidate="story"

        3. The candidate is a mangled fragment — split mid-word by the
           PDF encoder — that when joined would reconstruct a word already
           in the accumulated text.
           accumulated="What was special", candidate="as" (from "w as")

        We use a character-overlap ratio rather than exact matching so that
        minor encoding differences (spaces, ligatures) don't defeat the check.
        """
        c = candidate.lower().strip()
        a = accumulated.lower().strip()

        if not c:
            return True

        # Case 1: exact duplicate
        if c == a:
            return True

        # Case 2: candidate is a substring of what we already have
        if c in a:
            return True

        # Case 3: high character overlap — candidate shares >70% of its
        # characters with the accumulated string (catches partial shadows)
        c_chars = set(c.replace(" ", ""))
        a_chars = set(a.replace(" ", ""))
        if c_chars and len(c_chars & a_chars) / len(c_chars) > 0.70:
            # Only apply the overlap heuristic for short spans (≤ 15 chars)
            # to avoid false-positives on legitimate repeated content
            if len(c) <= 15:
                return True

        return False

    def _dedup_heading_lines(self, lines: list[str]) -> list[str]:
        """
        Remove repeated heading fragments that appear as consecutive lines.

        NCERT and similar typeset PDFs encode bold/decorative headings with
        multiple text layers stacked at slightly different y-coordinates.
        PyMuPDF treats each layer as a separate line, producing output like:

            ["What w", "What w", "What w", "What was special about these cities?"]

        Strategy: scan consecutive lines. When a line is a prefix of the
        next line (or identical), it is a fragment — drop it and keep
        scanning. Emit only the line that is NOT a prefix of its successor.

        Safe for normal paragraph text: ordinary lines are not prefixes
        of each other, so they pass through unchanged.
        """
        if not lines:
            return lines

        result = []
        i = 0
        while i < len(lines):
            current = lines[i]
            # Look ahead: skip this line if it is a prefix of the next
            if i + 1 < len(lines):
                nxt = lines[i + 1]
                c_norm = current.lower().replace(" ", "")
                n_norm = nxt.lower().replace(" ", "")
                # Current is a leading fragment of next — drop it
                if n_norm.startswith(c_norm) and c_norm:
                    i += 1
                    continue
            result.append(current)
            i += 1

        if len(result) < len(lines):
            logger.debug(
                "Heading dedup: removed %d fragment line(s) from block of %d.",
                len(lines) - len(result), len(lines),
            )
        return result

    # ------------------------------------------------------------------
    # Semantic gap detection
    # ------------------------------------------------------------------

    def _detect_semantic_gaps(
        self, page: fitz.Page, page_number: int, extracted_text: str
    ) -> tuple[list, str]:
        """
        Detect content on this page whose meaning is absent or severely
        degraded in the extracted text layer.
        """
        all_gaps: list[SemanticGap] = []
        recovered_parts: list[str] = []

        diagram_gaps, diagram_recovered = self._detect_diagram_gaps(
            page, page_number, extracted_text
        )
        table_gaps, table_recovered = self._detect_table_gaps(page, page_number)

        all_gaps.extend(diagram_gaps)
        all_gaps.extend(table_gaps)
        all_gaps.extend(self._detect_equation_gaps(page, page_number, extracted_text))

        if diagram_recovered:
            recovered_parts.append(diagram_recovered)
        if table_recovered:
            recovered_parts.append(table_recovered)

        return all_gaps, "\n\n".join(recovered_parts)

    def _detect_diagram_gaps(
        self, page: fitz.Page, page_number: int, extracted_text: str
    ) -> tuple[list, str]:
        """
        Detect image blocks and recover nearby explanatory context.
        """
        gaps: list[SemanticGap] = []
        recovered_parts: list[str] = []

        try:
            raw = page.get_text("dict", sort=self.sort_blocks)
        except Exception:
            return gaps, ""

        blocks = raw.get("blocks", [])
        text_blocks = [b for b in blocks if b.get("type") == 0]
        image_blocks = [b for b in blocks if b.get("type") == 1]

        def block_text(tb: dict) -> str:
            lines = []
            for line in tb.get("lines", []):
                line_text = "".join(s.get("text", "") for s in line.get("spans", [])).strip()
                if line_text:
                    lines.append(line_text)
            return " ".join(lines)

        for img_block in image_blocks:
            bbox = img_block.get("bbox", (0, 0, 0, 0))  # (x0, y0, x1, y1)
            width  = bbox[2] - bbox[0]
            height = bbox[3] - bbox[1]
            if width < 50 or height < 50:
                continue

            img_top = bbox[1]
            img_bottom = bbox[3]
            caption_text: Optional[str] = None
            context_above: list[str] = []
            context_below: list[str] = []

            for tb in text_blocks:
                tb_bbox  = tb.get("bbox", (0, 0, 0, 0))
                tb_top   = tb_bbox[1]
                tb_bottom = tb_bbox[3]
                tb_left  = tb_bbox[0]
                tb_right = tb_bbox[2]
                h_overlap = not (tb_right < bbox[0] or tb_left > bbox[2])
                tb_text = block_text(tb)
                if not tb_text:
                    continue

                if h_overlap and img_bottom <= tb_top <= img_bottom + 80:
                    if self._CAPTION_RE.match(tb_text):
                        caption_text = tb_text
                    else:
                        context_below.append(tb_text)
                elif h_overlap and img_bottom < tb_top <= img_bottom + 200:
                    context_below.append(tb_text)
                elif h_overlap and img_top - 100 <= tb_bottom <= img_top:
                    context_above.append(tb_text)

            recovery_lines: list[str] = []
            if caption_text:
                recovery_lines.append(f"[Diagram: {caption_text}]")
                severity = "MEDIUM"
            else:
                recovery_lines.append(f"[Diagram on page {page_number} — no caption]")
                severity = "HIGH"

            if context_above:
                recovery_lines.append("Context before diagram: " + " ".join(context_above))
            if context_below:
                recovery_lines.append("Context after diagram: " + " ".join(context_below))

            recovered = "\n".join(recovery_lines) if len(recovery_lines) > 1 else None

            if caption_text:
                description = (
                    f"Page {page_number}: diagram detected ({width:.0f}×{height:.0f} pts). "
                    f"Caption extracted: \"{caption_text[:80]}\". "
                    "Image body absent — surrounding context recovered for Stage 2."
                )
            else:
                description = (
                    f"Page {page_number}: image detected ({width:.0f}×{height:.0f} pts) "
                    "with no caption. Image body absent from text layer. "
                    + (
                        "Surrounding context recovered." if recovered
                        else "No surrounding context found — concept entirely absent."
                    )
                )

            gaps.append(SemanticGap(
                gap_type    = "DIAGRAM",
                page_number = page_number,
                description = description,
                severity    = severity,
                caption     = caption_text,
                recovered_text = recovered,
            ))

            if recovered:
                recovered_parts.append(recovered)

        return gaps, "\n\n".join(recovered_parts)

    def _detect_table_gaps(self, page: fitz.Page, page_number: int) -> tuple[list, str]:
        """
        Detect tables and recover structured text when possible.
        """
        gaps: list[SemanticGap] = []
        recovered_parts: list[str] = []

        if hasattr(page, "find_tables"):
            try:
                table_finder = page.find_tables()
                tables = getattr(table_finder, "tables", [])
                for table in tables:
                    try:
                        cells = table.extract()
                    except Exception:
                        cells = []
                    if not cells:
                        continue

                    rows = len(cells)
                    cols = len(cells[0]) if cells else 0
                    structured_lines: list[str] = [
                        f"[Table extracted from page {page_number} ({rows} rows × {cols} cols)]"
                    ]

                    header_row = cells[0] if cells else []
                    has_headers = any(
                        cell and not str(cell).replace(".", "").replace(",", "").strip().isdigit()
                        for cell in header_row
                    )

                    if has_headers and rows > 1:
                        headers = [str(h).strip() if h else f"col{i}" for i, h in enumerate(header_row)]
                        for row in cells[1:]:
                            pairs = []
                            for header, cell in zip(headers, row):
                                cell_val = str(cell).strip() if cell else ""
                                if cell_val:
                                    pairs.append(f"{header}: {cell_val}")
                            if pairs:
                                structured_lines.append(", ".join(pairs))
                    else:
                        for row in cells:
                            row_str = ", ".join(
                                str(cell).strip() for cell in row if cell and str(cell).strip()
                            )
                            if row_str:
                                structured_lines.append(row_str)

                    recovered = "\n".join(structured_lines)
                    recovered_parts.append(recovered)
                    gaps.append(SemanticGap(
                        gap_type    = "TABLE",
                        page_number = page_number,
                        description = (
                            f"Page {page_number}: table detected ({rows} rows × {cols} cols). "
                            "Row/column structure reconstructed and appended to page text for Stage 2."
                        ),
                        severity    = "LOW",
                        caption     = None,
                        recovered_text = recovered,
                    ))
                if tables:
                    return gaps, "\n\n".join(recovered_parts)
            except Exception:
                pass

        try:
            raw = page.get_text("dict", sort=self.sort_blocks)
        except Exception:
            return gaps, ""

        for block in raw.get("blocks", []):
            if block.get("type") != 0:
                continue

            lines_data = block.get("lines", [])
            if len(lines_data) < 3:
                continue

            line_texts = []
            for line in lines_data:
                spans = line.get("spans", [])
                line_text = "".join(s.get("text", "") for s in spans).strip()
                if line_text:
                    line_texts.append(line_text)

            data_rows = 0
            for lt in line_texts:
                tokens = lt.split()
                if not tokens:
                    continue
                num_tokens = sum(1 for t in tokens if re.fullmatch(r"[\d.,%-]+", t))
                if (num_tokens / len(tokens) > 0.5) or "|" in lt:
                    data_rows += 1

            if data_rows >= 3 and data_rows / max(len(line_texts), 1) >= 0.5:
                gaps.append(SemanticGap(
                    gap_type    = "TABLE",
                    page_number = page_number,
                    description = (
                        f"Page {page_number}: table-like block detected "
                        f"({len(line_texts)} rows, ~{data_rows} data rows). "
                        "Row/column structure lost — PyMuPDF find_tables() unavailable. "
                        "Upgrade to PyMuPDF >= 1.23 to enable structured extraction."
                    ),
                    severity    = "HIGH",
                    caption     = None,
                ))

        return gaps, "\n\n".join(recovered_parts)

    def _detect_equation_gaps(
        self, page: fitz.Page, page_number: int, extracted_text: str
    ) -> list:
        """
        Detect mathematical expressions that are present in the text layer
        but are degraded — either garbled by OCR or stripped of their
        structure (fractions rendered as inline text, integrals as symbols).

        Detection strategy
        ------------------
        Split the extracted text into logical blocks (by double newline).
        For each block, count math symbol density. A block is flagged if:
          - It contains >= 3 distinct math symbols (Greek, operators, etc.)
          - OR it contains LaTeX-like escape patterns (\\frac, ^{, _{)
          - OR it has superscript Unicode digits

        Severity
        --------
        HIGH   : The block is almost entirely math symbols with almost no
                 natural-language words — the equation body is present but
                 unreadable.
        MEDIUM : Math symbols appear alongside readable text — a formula
                 embedded in a paragraph. May be partially parseable.
        """
        gaps: list[SemanticGap] = []

        # Work block-by-block on the extracted text for this page
        blocks = [b.strip() for b in extracted_text.split("\n\n") if b.strip()]

        for block in blocks:
            math_hits = self._MATH_SYMBOLS_RE.findall(block)
            if len(math_hits) < 3:
                continue

            # Measure how "math-dense" this block is
            words         = block.split()
            word_count    = max(len(words), 1)
            math_density  = len(math_hits) / word_count

            if math_density > 1.0:
                # More math symbols than words — equation is dominant, likely garbled
                severity    = "HIGH"
                description = (
                    f"Page {page_number}: equation block detected "
                    f"({len(math_hits)} math symbols, density={math_density:.1f}/word). "
                    "The expression is present in the text layer but is likely garbled. "
                    "Stage 2 will receive symbol noise rather than a parseable expression."
                )
            else:
                # Math embedded in prose — partial degradation
                severity    = "MEDIUM"
                description = (
                    f"Page {page_number}: inline equation detected "
                    f"({len(math_hits)} math symbols in paragraph). "
                    "Formula is partially readable but structural relationships "
                    "(exponents, fractions, subscripts) may be flattened."
                )

            # Extract a short preview of the problematic block
            preview = block[:60].replace("\n", " ")

            gaps.append(SemanticGap(
                gap_type    = "EQUATION",
                page_number = page_number,
                description = description,
                severity    = severity,
                caption     = f"Preview: \"{preview}…\"",
            ))

        return gaps

    def _compute_extraction_quality(self, content: "DocumentContent") -> ExtractionQualityReport:
        """
        Score the quality of the extraction that just completed.

        Called at the end of extract() once all pages are processed.
        Uses real per-page data (char counts, OCR flags, Tesseract
        confidence) — no heuristic approximations.

        Quality tier mapping
        --------------------
        HIGH       : quality_score >= 0.75, noise < 15%
        MEDIUM     : quality_score >= 0.45
        LOW        : quality_score >= 0.20
        UNREADABLE : quality_score < 0.20 OR noise > 15%
        """
        pages       = content.pages
        total_pages = max(content.page_count, 1)
        full_text   = content.full_text

        # ── Text density ──────────────────────────────────────────────────
        total_chars    = sum(p.char_count for p in pages)
        chars_per_page = round(total_chars / total_pages, 1)

        empty_pages = [p.page_number for p in pages if p.char_count < 50]
        empty_fraction = len(empty_pages) / total_pages

        # ── Noise ratio ───────────────────────────────────────────────────
        noise_count = len(self._NOISE_RE.findall(full_text))
        noise_ratio = round(noise_count / max(len(full_text), 1), 4)

        # ── OCR signals (exact — from real Tesseract output) ──────────────
        ocr_pages       = [p for p in pages if p.ocr_applied]
        ocr_page_count  = len(ocr_pages)
        ocr_confs       = [p.ocr_confidence for p in ocr_pages if p.ocr_confidence is not None]
        ocr_avg_conf    = round(sum(ocr_confs) / len(ocr_confs), 2) if ocr_confs else None
        ocr_low_conf_pages = [
            p.page_number for p in ocr_pages
            if p.ocr_confidence is not None and p.ocr_confidence < 60
        ]
        # Pages where OCR ran but returned almost nothing — confidence unknown
        ocr_empty_pages = [
            p.page_number for p in ocr_pages
            if p.char_count < 50 and p.ocr_confidence is None
        ]
        ocr_low_conf_pages = sorted(set(ocr_low_conf_pages + ocr_empty_pages))

        # ── Coverage (expected chars vs actual) ───────────────────────────
        # Native PyMuPDF pages: ~1800 chars/page; OCR pages: ~800 chars/page
        expected_chars = sum(
            800 if p.ocr_applied else 1800
            for p in pages
        )
        coverage_ratio = round(min(total_chars / max(expected_chars, 1), 1.0), 4)

        if coverage_ratio >= 0.95:
            coverage_verdict = "COMPLETE"
        elif coverage_ratio >= 0.60:
            coverage_verdict = "PARTIAL"
        else:
            coverage_verdict = "SPARSE"

        # ── Composite quality score ───────────────────────────────────────
        density_score  = min(chars_per_page / 1800, 1.0)
        clean_score    = max(1.0 - noise_ratio * 20, 0.0)   # noise > 5% → 0
        page_score     = max(1.0 - empty_fraction, 0.0)

        if ocr_page_count > 0 and ocr_avg_conf is not None:
            ocr_score = max((ocr_avg_conf - 60) / 40, 0.0)  # 60→0, 100→1
        elif ocr_page_count > 0:
            ocr_score = 0.5  # OCR ran but confidence unavailable — neutral
        else:
            ocr_score = 1.0  # No OCR needed

        quality_score = round(
            0.35 * density_score +
            0.30 * clean_score   +
            0.20 * page_score    +
            0.15 * ocr_score,
            4,
        )

        if noise_ratio > 0.15:
            quality_tier = "UNREADABLE"
        elif quality_score >= 0.75:
            quality_tier = "HIGH"
        elif quality_score >= 0.45:
            quality_tier = "MEDIUM"
        elif quality_score >= 0.20:
            quality_tier = "LOW"
        else:
            quality_tier = "UNREADABLE"

        # ── Notes ──────────────────────────────────────────────────────────
        notes: list[str] = []
        if chars_per_page < 400:
            notes.append(
                f"Low text density ({chars_per_page:.0f} chars/page). "
                "Document may be image-heavy or partially scanned."
            )
        if noise_ratio > 0.03:
            notes.append(
                f"Noise ratio {noise_ratio:.2%} — garbled characters detected. "
                "OCR post-processing recommended."
            )
        if empty_pages:
            notes.append(
                f"{len(empty_pages)} page(s) produced near-zero text: {empty_pages}. "
                "These sections will produce no KG triples."
            )
        if ocr_low_conf_pages:
            notes.append(
                f"Low OCR confidence on pages {ocr_low_conf_pages}. "
                "These pages may be too dark or blurry for reliable extraction."
            )
        if coverage_verdict == "PARTIAL":
            notes.append(
                f"Extraction coverage ~{coverage_ratio:.0%}. "
                "Some content may be in image-only pages."
            )
        if coverage_verdict == "SPARSE":
            notes.append(
                f"CRITICAL: Only ~{coverage_ratio:.0%} of expected text extracted. "
                "The document likely has major unreadable sections."
            )
        if quality_tier == "UNREADABLE":
            notes.append(
                "BLOCKER: Document quality is UNREADABLE. "
                "Upload a higher-quality scan or digital PDF."
            )

        # ── Semantic gap aggregation ───────────────────────────────────────
        all_gaps      = [gap for page in pages for gap in page.semantic_gaps]
        diagram_gaps  = [g for g in all_gaps if g.gap_type == "DIAGRAM"]
        table_gaps    = [g for g in all_gaps if g.gap_type == "TABLE"]
        equation_gaps = [g for g in all_gaps if g.gap_type == "EQUATION"]

        high_severity_gaps = [g for g in all_gaps if g.severity == "HIGH"]

        if diagram_gaps:
            captioned   = sum(1 for g in diagram_gaps if g.caption)
            uncaptioned = len(diagram_gaps) - captioned
            notes.append(
                f"{len(diagram_gaps)} diagram(s) detected: "
                f"{captioned} with caption (body absent), "
                f"{uncaptioned} with no label at all. "
                "Any concept explained only through these diagrams will be "
                "missing from the knowledge graph."
            )
        if table_gaps:
            notes.append(
                f"{len(table_gaps)} table(s) detected whose row/column structure "
                "is destroyed in the text layer. Numeric comparisons and relational "
                "data from these tables will produce unreliable KG triples."
            )
        if equation_gaps:
            high_eq = sum(1 for g in equation_gaps if g.severity == "HIGH")
            notes.append(
                f"{len(equation_gaps)} equation block(s) detected "
                f"({high_eq} severely garbled). "
                "Mathematical relationships from these expressions may be "
                "missing or misrepresented in the knowledge graph."
            )
        if high_severity_gaps:
            notes.append(
                f"Total HIGH-severity semantic gaps: {len(high_severity_gaps)} "
                f"across {len(set(g.page_number for g in high_severity_gaps))} page(s). "
                "These represent concepts entirely absent from the text layer."
            )

        return ExtractionQualityReport(
            quality_tier       = quality_tier,
            quality_score      = quality_score,
            chars_per_page     = chars_per_page,
            noise_ratio        = noise_ratio,
            empty_pages        = empty_pages,
            ocr_page_count     = ocr_page_count,
            ocr_avg_confidence = ocr_avg_conf,
            ocr_low_conf_pages = ocr_low_conf_pages,
            coverage_ratio     = coverage_ratio,
            coverage_verdict   = coverage_verdict,
            semantic_gap_count = len(all_gaps),
            diagram_gap_count  = len(diagram_gaps),
            table_gap_count    = len(table_gaps),
            equation_gap_count = len(equation_gaps),
            semantic_gaps      = all_gaps,
            notes              = notes,
        )

    # ------------------------------------------------------------------
    # Logging
    # ------------------------------------------------------------------

    def _log_summary(self, content: DocumentContent, filename: str) -> None:
        parts = []
        if content.ocr_page_count:
            parts.append(f"{content.ocr_page_count} page(s) via OCR")
        if content.preprocessed_page_count:
            parts.append(f"{content.preprocessed_page_count} preprocessed")
        note = f" ({', '.join(parts)})" if parts else ""

        logger.info(
            "Extracted %d page(s), %d chars total from '%s'%s",
            content.page_count, len(content.full_text), filename, note,
        )

        if content.is_empty:
            logger.warning(
                "'%s' produced no text even after preprocessing + OCR. "
                "The scan may be too dark to recover. "
                "Check Tesseract is installed: tesseract --version",
                filename,
            )
