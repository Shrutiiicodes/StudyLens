"""
pdf_downloader.py
Downloads raw PDFs from Supabase Storage for processing.
"""

import os
import logging
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

try:
    from supabase import create_client, Client
    SUPABASE_AVAILABLE = True
except ImportError:
    create_client = None
    Client = None
    SUPABASE_AVAILABLE = False

logger = logging.getLogger(__name__)

# Suspiciously small PDF: less than ~2 KB/page is likely blank or corrupt
_MIN_BYTES_PER_PAGE = 2_000
# A PDF with no pages in its metadata is unprocessable
_MIN_PAGES = 1


@dataclass
class UploadValidationResult:
    """
    Result of PDFDownloader.validate_before_download().
    Lets the pipeline reject clearly bad uploads before spending time
    on a full download + extraction cycle.
    """
    storage_path: str
    is_valid:     bool
    file_size_bytes: Optional[int]      # None if metadata unavailable
    page_count_hint: Optional[int]      # From Supabase metadata if available
    issues:       list[str] = field(default_factory=list)   # Human-readable problems
    warnings:     list[str] = field(default_factory=list)   # Non-blocking concerns

    @property
    def upload_issues(self) -> list[str]:
        return self.issues

    @property
    def upload_warnings(self) -> list[str]:
        return self.warnings


class PDFDownloader:
    """
    Handles communication with Supabase Storage to download
    user-uploaded PDF files for the ingestion pipeline.
    """

    def __init__(
        self,
        supabase_url: Optional[str] = None,
        supabase_key: Optional[str] = None,
        bucket_name: str = "pdfs",
    ):
        if not SUPABASE_AVAILABLE:
            raise RuntimeError(
                "supabase-py is not installed. "
                "Run: pip install supabase"
            )
        url = supabase_url or os.environ["SUPABASE_URL"]
        key = supabase_key or os.environ["SUPABASE_SERVICE_KEY"]
        self.client: Client = create_client(url, key)
        self.bucket_name = bucket_name

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def download_to_tempfile(self, storage_path: str) -> str:
        """
        Download a PDF from Supabase Storage and write it to a
        temporary file on disk.

        Args:
            storage_path: Path inside the bucket, e.g.
                          "user-id/document.pdf"

        Returns:
            Absolute path of the downloaded temporary file.
            Caller is responsible for deleting the file when done.

        Raises:
            RuntimeError: If the download fails.
        """
        logger.info("Downloading %s from bucket '%s'", storage_path, self.bucket_name)
        try:
            response: bytes = (
                self.client.storage.from_(self.bucket_name).download(storage_path)
            )
        except Exception as exc:
            raise RuntimeError(
                f"Failed to download '{storage_path}' from Supabase: {exc}"
            ) from exc

        suffix = Path(storage_path).suffix or ".pdf"
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        try:
            tmp.write(response)
            tmp.flush()
        finally:
            tmp.close()

        logger.info("Saved to temporary file: %s", tmp.name)
        return tmp.name

    def list_pending_files(self, folder: str = "") -> list[dict]:
        """
        List all PDF files available in the bucket (optionally scoped
        to a sub-folder/user prefix).

        Args:
            folder: Optional prefix / "folder" path inside the bucket.

        Returns:
            List of Supabase file metadata dicts (name, id, created_at …).
        """
        try:
            files = self.client.storage.from_(self.bucket_name).list(folder)
        except Exception as exc:
            raise RuntimeError(f"Failed to list files in Supabase: {exc}") from exc

        pdf_files = [f for f in files if f.get("name", "").lower().endswith(".pdf")]
        logger.info(
            "Found %d PDF file(s) under '%s'", len(pdf_files), folder or "root"
        )
        return pdf_files

    def get_public_url(self, storage_path: str) -> str:
        """Return a public URL for a given storage path (if bucket is public)."""
        return self.client.storage.from_(self.bucket_name).get_public_url(storage_path)

    # ------------------------------------------------------------------
    # Pre-download validation
    # ------------------------------------------------------------------

    def validate_before_download(self, storage_path: str) -> UploadValidationResult:
        """
        Check a file's metadata in Supabase Storage before downloading it.

        Catches common problems early — wrong extension, suspiciously small
        file (blank scan / corrupt upload), or zero-byte file — without
        incurring the cost of a full download.

        Args:
            storage_path: Path inside the bucket, e.g. "user-id/document.pdf"

        Returns:
            UploadValidationResult. If is_valid is False, the pipeline
            should reject the file and surface result.issues to the teacher.
        """
        issues:   list[str] = []
        warnings: list[str] = []

        # ── Extension check ───────────────────────────────────────────────
        suffix = Path(storage_path).suffix.lower()
        if suffix != ".pdf":
            issues.append(
                f"File '{storage_path}' has extension '{suffix}', not '.pdf'. "
                "Only PDF uploads are supported."
            )
            return UploadValidationResult(
                storage_path    = storage_path,
                is_valid        = False,
                file_size_bytes = None,
                page_count_hint = None,
                issues          = issues,
            )

        # ── Fetch Supabase file metadata ──────────────────────────────────
        file_size: Optional[int] = None
        page_count_hint: Optional[int] = None

        try:
            folder   = str(Path(storage_path).parent)
            filename = Path(storage_path).name
            file_list = self.client.storage.from_(self.bucket_name).list(
                folder if folder != "." else ""
            )
            meta = next(
                (f for f in file_list if f.get("name") == filename), None
            )
            if meta:
                file_size = meta.get("metadata", {}).get("size") or meta.get("size")
        except Exception as exc:
            warnings.append(
                f"Could not fetch file metadata from Supabase: {exc}. "
                "Skipping size validation."
            )

        # ── Size checks ───────────────────────────────────────────────────
        if file_size is not None:
            if file_size == 0:
                issues.append(
                    "File is 0 bytes. The upload may have failed or the file is empty."
                )
            elif file_size < _MIN_BYTES_PER_PAGE:
                # Can't know page count yet, but < 2 KB total is always suspicious
                warnings.append(
                    f"File is very small ({file_size:,} bytes). "
                    "It may be a blank or corrupt PDF. "
                    "Extraction will proceed but quality may be poor."
                )
            elif file_size < 10_000:
                warnings.append(
                    f"File is unusually small ({file_size:,} bytes). "
                    "Verify the upload completed successfully."
                )

        is_valid = len(issues) == 0

        if not is_valid:
            logger.warning(
                "Upload validation FAILED for '%s': %s",
                storage_path, "; ".join(issues),
            )
        elif warnings:
            logger.warning(
                "Upload validation warnings for '%s': %s",
                storage_path, "; ".join(warnings),
            )
        else:
            logger.info("Upload validation OK for '%s' (%s bytes).", storage_path, file_size)

        return UploadValidationResult(
            storage_path    = storage_path,
            is_valid        = is_valid,
            file_size_bytes = file_size,
            page_count_hint = page_count_hint,
            issues          = issues,
            warnings        = warnings,
        )
