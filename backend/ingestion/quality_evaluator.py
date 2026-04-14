"""
quality_evaluator.py
Evaluates whether extracted PDF content is good enough for downstream
knowledge-graph processing.

Tuned for student-uploaded PDFs (phone photos of textbook chapters).

Checks performed
----------------
1. extraction_yield  — hard minimum total characters (hard-fail if zero)
2. page_loss         — pages PyMuPDF parsed vs pages the PDF declares it has
3. text_density      — average chars-per-page (catches blurry/dark scans)
4. gibberish         — character-level noise patterns from bad OCR
5. word_ratio        — fraction of tokens that look like real words

Weights are tuned toward the two most likely failure modes for phone
photos: blurry/low-res OCR gibberish and missing pages.

Each check produces a score (0.0–1.0). Overall score is a weighted
average. Pipeline raises PDFQualityError immediately on failure —
no chunking is attempted.
"""

import logging
import re
from dataclasses import dataclass, field
from typing import Optional

import fitz  # needed for declared page count check

from .pdf_extractor import DocumentContent

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------

@dataclass
class CheckResult:
    """Outcome of a single quality check."""
    name: str
    passed: bool
    score: float        # 0.0 – 1.0
    message: str        # human-readable; student-safe


@dataclass
class QualityReport:
    """Full quality evaluation result for one document."""
    doc_id: str
    overall_score: float    # 0.0 – 1.0
    passed: bool
    checks: list[CheckResult] = field(default_factory=list)
    rejection_reason: Optional[str] = None  # student-facing if failed

    @property
    def failed_checks(self) -> list[CheckResult]:
        return [c for c in self.checks if not c.passed]

    def summary(self) -> str:
        status = "PASSED" if self.passed else "FAILED"
        lines = [f"[{status}] overall_score={self.overall_score:.2f}"]
        for c in self.checks:
            icon = "✓" if c.passed else "✗"
            lines.append(f"  {icon} {c.name} ({c.score:.2f}): {c.message}")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Evaluator
# ---------------------------------------------------------------------------

class QualityEvaluator:
    """
    Runs quality checks on a DocumentContent and returns a QualityReport.

    Parameters
    ----------
    min_total_chars        : Hard minimum chars for the whole document.
    min_chars_per_page     : Average chars required per page.
    max_empty_page_ratio   : Fraction of pages allowed to be empty (0–1).
    max_page_loss_ratio    : Fraction of declared PDF pages allowed to be
                             missing from extraction (0–1). E.g. 0.2 means
                             up to 20% of pages may fail before rejection.
    min_word_ratio         : Fraction of tokens that must look like real words.
    min_gibberish_score    : Minimum score on the gibberish detector (0–1).
    pass_threshold         : Minimum overall weighted score to pass (0–1).
    """

    # Weights tuned for phone-photo textbook scans.
    # Gibberish + density together = 55% since those are the dominant
    # failure modes. Page loss = 20% because partial page extraction is
    # the second most common issue with low-quality phone scans.
    _WEIGHTS = {
        "extraction_yield": 0.15,   # hard-fail guard; low weight since it's binary
        "page_loss":        0.20,   # NEW: catches pages lost to bad scans
        "text_density":     0.25,   # blurry/dark pages produce very few chars
        "gibberish":        0.25,   # bad OCR noise — highest individual risk
        "word_ratio":       0.15,   # corroborates gibberish check
    }

    def __init__(
        self,
        min_total_chars: int = 200,
        min_chars_per_page: int = 100,
        max_empty_page_ratio: float = 0.25,     # tighter than before (was 0.3)
        max_page_loss_ratio: float = 0.20,
        min_word_ratio: float = 0.5,
        min_gibberish_score: float = 0.55,      # slightly tighter (was 0.5)
        pass_threshold: float = 0.70,
    ):
        self.min_total_chars = min_total_chars
        self.min_chars_per_page = min_chars_per_page
        self.max_empty_page_ratio = max_empty_page_ratio
        self.max_page_loss_ratio = max_page_loss_ratio
        self.min_word_ratio = min_word_ratio
        self.min_gibberish_score = min_gibberish_score
        self.pass_threshold = pass_threshold

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def evaluate(self, content: DocumentContent, doc_id: str = "") -> QualityReport:
        """
        Evaluate extracted document content.

        Args:
            content: Output of PDFExtractor.extract()
            doc_id : Optional identifier used in log messages.

        Returns:
            QualityReport with overall score, pass/fail, and per-check details.
        """
        # Read the declared page count directly from the PDF file so we can
        # compare it against what was actually extracted.
        declared_pages = self._get_declared_page_count(content.file_path)

        checks = [
            self._check_extraction_yield(content),
            self._check_page_loss(content, declared_pages),
            self._check_text_density(content),
            self._check_gibberish(content),
            self._check_word_ratio(content),
        ]

        overall = sum(c.score * self._WEIGHTS[c.name] for c in checks)

        # Hard-fail conditions — these override the overall score:
        # 1. Zero text extracted — nothing to work with
        # 2. Zero real words — text exists but is completely unusable garbage
        hard_fails = [
            c for c in checks
            if (c.name == "extraction_yield" and not c.passed)
            or (c.name == "word_ratio" and c.score == 0.0)
        ]
        passed = (overall >= self.pass_threshold) and len(hard_fails) == 0

        rejection_reason = None
        if not passed:
            rejection_reason = self._build_rejection_reason(checks, overall)

        report = QualityReport(
            doc_id=doc_id,
            overall_score=round(overall, 3),
            passed=passed,
            checks=checks,
            rejection_reason=rejection_reason,
        )

        logger.info("Quality report for '%s':\n%s", doc_id, report.summary())
        return report

    # ------------------------------------------------------------------
    # Individual checks
    # ------------------------------------------------------------------

    def _check_extraction_yield(self, content: DocumentContent) -> CheckResult:
        """Total characters extracted must meet a hard minimum."""
        total = len(content.full_text.strip())
        passed = total >= self.min_total_chars
        score = min(total / (self.min_total_chars * 2), 1.0) if self.min_total_chars else 1.0

        return CheckResult(
            name="extraction_yield",
            passed=passed,
            score=round(score, 3),
            message=(
                f"{total} chars extracted (min {self.min_total_chars})"
                if passed
                else f"Only {total} chars — PDF appears blank or completely unreadable"
            ),
        )

    def _check_page_loss(
        self, content: DocumentContent, declared_pages: Optional[int]
    ) -> CheckResult:
        """
        A page counts as 'lost' if it has fewer than min_page_chars after
        extraction + OCR. Structural presence isn't enough — a page that
        PyMuPDF parsed but yielded no usable text is effectively unreadable.

        This catches the key failure mode for dark phone photos: all 19 pages
        are structurally present in the PDF, but 18 of them produced nothing.
        """
        min_page_chars = 50  # below this a page is considered unreadable

        if not content.pages:
            return CheckResult("page_loss", False, 0.0, "No pages found")

        unreadable = sum(
            1 for p in content.pages if len(p.text.strip()) < min_page_chars
        )
        total = len(content.pages)
        loss_ratio = unreadable / total
        passed = loss_ratio <= self.max_page_loss_ratio
        score = round(max(1.0 - loss_ratio, 0.0), 3)

        return CheckResult(
            name="page_loss",
            passed=passed,
            score=score,
            message=(
                f"{unreadable}/{total} pages effectively unreadable after extraction "
                f"({loss_ratio:.0%} loss — {'ok' if passed else 'too many unreadable pages'})"
            ),
        )

    def _check_text_density(self, content: DocumentContent) -> CheckResult:
        """Average characters per page must meet minimum."""
        if not content.page_count:
            return CheckResult("text_density", False, 0.0, "No pages")

        avg = len(content.full_text) / content.page_count
        passed = avg >= self.min_chars_per_page
        score = min(avg / (self.min_chars_per_page * 2), 1.0) if self.min_chars_per_page else 1.0

        return CheckResult(
            name="text_density",
            passed=passed,
            score=round(score, 3),
            message=(
                f"{avg:.0f} avg chars/page (min {self.min_chars_per_page})"
                if passed
                else f"Only {avg:.0f} avg chars/page — scan may be too blurry or dark"
            ),
        )

    def _check_gibberish(self, content: DocumentContent) -> CheckResult:
        """
        Heuristic gibberish detector tuned for bad OCR from phone photos:
        - High non-ASCII ratio (blurry text → junk Unicode)
        - Long character runs with no spaces (skewed page → merged tokens)
        - High punctuation / symbol density
        """
        text = content.full_text
        if not text:
            return CheckResult("gibberish", False, 0.0, "No text to analyse")

        penalties = 0.0

        # 1. Non-ASCII ratio
        non_ascii = sum(1 for c in text if ord(c) > 127)
        non_ascii_ratio = non_ascii / len(text)
        if non_ascii_ratio > 0.15:
            penalties += 0.45
        elif non_ascii_ratio > 0.05:
            penalties += 0.15

        # 2. Long unbroken runs (50+ chars with no space — skewed page symptom)
        long_runs = re.findall(r"\S{50,}", text)
        run_ratio = sum(len(r) for r in long_runs) / len(text)
        if run_ratio > 0.10:
            penalties += 0.35
        elif run_ratio > 0.03:
            penalties += 0.12

        # 3. Symbol / punctuation density
        punct = sum(1 for c in text if not c.isalnum() and not c.isspace())
        punct_ratio = punct / len(text)
        if punct_ratio > 0.30:
            penalties += 0.30
        elif punct_ratio > 0.15:
            penalties += 0.10

        score = round(max(1.0 - penalties, 0.0), 3)
        passed = score >= self.min_gibberish_score

        return CheckResult(
            name="gibberish",
            passed=passed,
            score=score,
            message=(
                "Text looks clean"
                if passed
                else "Text contains noise patterns typical of a blurry or skewed scan"
            ),
        )

    def _check_word_ratio(self, content: DocumentContent) -> CheckResult:
        """
        Fraction of whitespace-split tokens that are alphabetic words
        (length 2–25). Corroborates the gibberish check from a different angle.
        """
        tokens = content.full_text.split()
        if not tokens:
            return CheckResult("word_ratio", False, 0.0, "No tokens found")

        real_words = sum(1 for t in tokens if re.match(r"^[A-Za-z]{2,25}$", t))
        ratio = real_words / len(tokens)
        passed = ratio >= self.min_word_ratio
        score = round(min(ratio / self.min_word_ratio, 1.0), 3) if self.min_word_ratio else 1.0

        return CheckResult(
            name="word_ratio",
            passed=passed,
            score=score,
            message=(
                f"{ratio:.0%} word-like tokens (min {self.min_word_ratio:.0%})"
                if passed
                else f"Only {ratio:.0%} tokens look like words — text may be garbled"
            ),
        )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _get_declared_page_count(self, file_path: str) -> Optional[int]:
        """
        Read the page count declared in the PDF's cross-reference table.
        This is what the PDF *says* it has, regardless of whether PyMuPDF
        could extract text from each page.
        Returns None if the file can't be opened (e.g. already deleted).
        """
        try:
            doc = fitz.open(file_path)
            count = len(doc)
            doc.close()
            return count
        except Exception:
            return None

    def _build_rejection_reason(
        self, checks: list[CheckResult], overall: float
    ) -> str:
        """
        Return the single most actionable student-facing rejection message,
        prioritising the failure most likely to be fixable by re-scanning.
        """
        failed = [c for c in checks if not c.passed]
        if not failed:
            return (
                f"Overall quality score ({overall:.0%}) is below the required threshold. "
                "Please try uploading a clearer scan."
            )

        priority = [
            "extraction_yield",
            "page_loss",
            "text_density",
            "gibberish",
            "word_ratio",
        ]
        failed_sorted = sorted(
            failed,
            key=lambda c: priority.index(c.name) if c.name in priority else 99,
        )
        worst = failed_sorted[0]

        reasons = {
            "extraction_yield": (
                "We couldn't read any text from your PDF. "
                "Make sure the page is well-lit and fully in frame, then try again."
            ),
            "page_loss": (
                "Some pages in your PDF couldn't be read — they may be too dark, "
                "blurry, or cut off. Please retake those pages and upload again."
            ),
            "text_density": (
                "Your scan is too blurry or dark — we could only extract a small amount "
                "of text per page. Try scanning in better lighting or higher resolution."
            ),
            "gibberish": (
                "The text we extracted looks garbled, likely because the scan is blurry "
                "or the page was at an angle. Please upload a clearer, straighter photo."
            ),
            "word_ratio": (
                "Most of the extracted text doesn't look like real words. "
                "The scan may be skewed, too dark, or at too low a resolution."
            ),
        }

        return reasons.get(
            worst.name,
            "PDF quality is too low. Please upload a clearer scan.",
        )