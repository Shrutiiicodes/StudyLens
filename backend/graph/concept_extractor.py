"""
graph/concept_extractor.py
Extracts (subject, relation, object) triples from text chunks using Groq.

Each triple becomes a pair of (:Concept) nodes and a typed relationship
edge in Neo4j. This is what turns a storage graph into a knowledge graph
that the question-generation layer can actually reason over.

Pipeline per chunk
------------------
1. Send chunk text to Groq with a strict JSON schema prompt.
2. Parse the returned list of triples.
3. Validate and normalise each triple (strip noise, title-case entities).
4. Return clean Triple objects ready for concept_repository.py to write.

Groq model used: llama-3.3-70b-versatile
- Fast enough for batch processing (tokens/sec >> GPT-4)
- Strong structured output reliability at this size
- Free tier sufficient for development

Dependencies
------------
    pip install groq
    GROQ_API_KEY=gsk_... in your .env
"""

import json
import logging
import os
import re
import time
from dataclasses import dataclass
from typing import Optional
from graph.predicates import ALLOWED_PREDICATES, predicate_rubric

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Triple dataclass
# ---------------------------------------------------------------------------

@dataclass
class Triple:
    """
    A single (subject, relation, object) knowledge triple.

    subject  : The entity the statement is about.
               e.g. "Great Bath", "Harappans", "Photosynthesis"
    relation : The typed relationship between subject and object.
               e.g. "LOCATED_IN", "USED_FOR", "DISCOVERED_BY"
               Always uppercase with underscores — used directly as
               the Neo4j relationship type.
    object_  : The target entity or concept.
               e.g. "Mohenjodaro", "ritual bathing", "Jan Ingenhousz"
    chunk_id : Source chunk this triple was extracted from.
    doc_id   : Parent document.
    """
    subject: str
    relation: str
    object_: str
    chunk_id: str
    doc_id: str

    def is_valid(self) -> bool:
        """Return True if all three parts are non-empty and meaningful."""
        return (
            bool(self.subject.strip())
            and bool(self.relation.strip())
            and bool(self.object_.strip())
            and self.subject.lower() != self.object_.lower()
            and len(self.subject) <= 120
            and len(self.object_) <= 120
        )


# ---------------------------------------------------------------------------
# Extractor
# ---------------------------------------------------------------------------

# Prompt carefully tuned for NCERT-style educational text.
# Key constraints in the prompt:
# - relation must be UPPER_SNAKE_CASE (maps directly to Neo4j rel type)
# - no pronouns as subjects/objects
# - entities must be specific nouns, not vague terms
# - return ONLY the JSON array, nothing else
_USER_TEMPLATE = """Extract knowledge triples from this educational text:

{text}

Return only a JSON array of triples."""


class ConceptExtractor:
    """
    Sends chunks to Groq and returns structured Triple objects.

    Parameters
    ----------
    model          : Groq model ID. Default is llama-3.3-70b-versatile.
    max_retries    : Retries on rate-limit or transient errors.
    retry_delay    : Seconds between retries (doubles on each attempt).
    max_triples    : Hard cap on triples per chunk (extra are discarded).
    request_delay  : Seconds to wait between API calls (rate limit buffer).
    """

    def __init__(
        self,
        model: str = "llama-3.3-70b-versatile",
        max_retries: int = 3,
        retry_delay: float = 2.0,
        max_triples: int = 15,
        request_delay: float = 0.5,
        allowed_predicates: Optional[set[str]] = None,
    ):
        try:
            from groq import Groq
            self._client = Groq(api_key=os.environ["GROQ_API_KEY"])
        except ImportError:
            raise ImportError(
                "groq package not installed. Run: pip install groq"
            )
        except KeyError:
            raise EnvironmentError(
                "GROQ_API_KEY not set. Add it to your .env file."
            )

        self.model = model
        self.max_retries = max_retries
        self.retry_delay = retry_delay
        self.max_triples = max_triples
        self.request_delay = request_delay
        self.allowed_predicates = set(allowed_predicates or ALLOWED_PREDICATES)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def extract_from_chunk(self, text: str, chunk_id: str, doc_id: str) -> list[Triple]:
        """
        Extract triples from a single chunk of text.

        Args:
            text     : The chunk text.
            chunk_id : chunk_id from ChunkModel (stored on each Triple).
            doc_id   : Parent doc_id (stored on each Triple).

        Returns:
            List of validated Triple objects. Empty list on failure.
        """
        raw = self._call_groq(text)
        if raw is None:
            return []

        triples = self._parse_response(raw, chunk_id, doc_id)
        valid = [t for t in triples if t.is_valid()]

        logger.info(
            "Chunk %s: %d raw triples → %d valid", chunk_id, len(triples), len(valid)
        )
        return valid[:self.max_triples]

    def extract_from_chunks(
        self,
        chunks: list[dict],
        doc_id: str,
        skip_short: int = 150,
    ) -> list[Triple]:
        """
        Extract triples from a list of chunk dicts (as returned by Neo4j reads).

        Skips chunks shorter than skip_short characters — they rarely contain
        complete facts and waste API calls.

        Args:
            chunks     : List of chunk property dicts from chunk_repository.
            doc_id     : Parent document ID.
            skip_short : Min char count to process a chunk (default 150).

        Returns:
            All extracted triples across all chunks.
        """
        all_triples: list[Triple] = []
        skipped = 0

        for i, chunk in enumerate(chunks):
            text = chunk.get("text", "")
            chunk_id = chunk.get("chunk_id", f"unknown_{i}")

            if len(text) < skip_short:
                skipped += 1
                continue

            triples = self.extract_from_chunk(text, chunk_id, doc_id)
            all_triples.extend(triples)

            # Polite delay between requests
            if i < len(chunks) - 1:
                time.sleep(self.request_delay)

        logger.info(
            "Extracted %d total triples from %d chunks (%d skipped as too short).",
            len(all_triples), len(chunks), skipped,
        )
        return all_triples

    # ------------------------------------------------------------------
    # Groq API call with retry
    # ------------------------------------------------------------------

    def _call_groq(self, text: str) -> Optional[str]:
        """
        Call Groq API with retry on transient errors.
        Returns raw response string or None on failure.
        """
        delay = self.retry_delay

        for attempt in range(1, self.max_retries + 1):
            try:
                response = self._client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": self._build_system_prompt()},
                        {"role": "user",   "content": _USER_TEMPLATE.format(text=text)},
                    ],
                    temperature=0.0,   # deterministic — we want consistent JSON
                    max_tokens=1024,
                )
                return response.choices[0].message.content

            except Exception as exc:
                err = str(exc).lower()
                if "rate" in err or "429" in err:
                    wait = delay * attempt
                    logger.warning(
                        "Rate limited by Groq (attempt %d/%d). Waiting %.1fs ...",
                        attempt, self.max_retries, wait,
                    )
                    time.sleep(wait)
                elif attempt < self.max_retries:
                    logger.warning(
                        "Groq call failed (attempt %d/%d): %s. Retrying ...",
                        attempt, self.max_retries, exc,
                    )
                    time.sleep(delay)
                else:
                    logger.error(
                        "Groq call failed after %d attempts: %s", self.max_retries, exc
                    )

        return None

    # ------------------------------------------------------------------
    # Response parsing
    # ------------------------------------------------------------------

    def _parse_response(
        self, raw: str, chunk_id: str, doc_id: str
    ) -> list[Triple]:
        """
        Parse Groq's response into Triple objects.

        Handles common LLM response issues:
        - JSON wrapped in markdown code fences
        - Trailing commas
        - Extra explanation text before/after the array
        """
        # Strip markdown code fences if present
        cleaned = re.sub(r"```(?:json)?", "", raw).strip()

        # Extract the JSON array — find first [ and last ]
        start = cleaned.find("[")
        end   = cleaned.rfind("]")
        if start == -1 or end == -1:
            logger.warning("No JSON array found in Groq response: %s", raw[:200])
            return []

        json_str = cleaned[start : end + 1]

        # Fix trailing commas (common LLM mistake)
        json_str = re.sub(r",\s*([}\]])", r"\1", json_str)

        try:
            data = json.loads(json_str)
        except json.JSONDecodeError as exc:
            logger.warning("JSON parse error: %s — raw: %s", exc, json_str[:300])
            return []

        if not isinstance(data, list):
            logger.warning("Expected JSON array, got %s", type(data))
            return []

        triples = []
        for item in data:
            if not isinstance(item, dict):
                continue
            subject  = self._normalise_entity(item.get("subject", ""))
            relation = self._normalise_relation(item.get("relation", ""))
            object_  = self._normalise_entity(item.get("object", ""))

            if (
                subject
                and relation
                and object_
                and relation in self.allowed_predicates
            ):
                triples.append(
                    Triple(
                        subject=subject,
                        relation=relation,
                        object_=object_,
                        chunk_id=chunk_id,
                        doc_id=doc_id,
                    )
                )

        return triples

    # ------------------------------------------------------------------
    # Normalisation
    # ------------------------------------------------------------------

    def _normalise_entity(self, text: str) -> str:
        """
        Clean an entity string.
        - Strip leading/trailing whitespace and punctuation
        - Collapse internal whitespace
        - Title-case (so "great bath" and "Great Bath" merge to one node)
        - Reject if too short or too long
        """
        if not text:
            return ""
        cleaned = re.sub(r"\s+", " ", text.strip().strip(".,;:\"'"))
        if len(cleaned) < 2 or len(cleaned) > 120:
            return ""
        return cleaned.title()

    def _normalise_relation(self, text: str) -> str:
        """
        Clean a relation string into UPPER_SNAKE_CASE.
        - Strip spaces → underscores
        - Uppercase
        - Remove non-word characters
        """
        if not text:
            return ""
        cleaned = re.sub(r"[^\w\s]", "", text.strip())
        cleaned = re.sub(r"\s+", "_", cleaned).upper()
        if not cleaned or len(cleaned) > 60:
            return ""
        return cleaned

    def _build_system_prompt(self) -> str:
        allowed = ", ".join(sorted(self.allowed_predicates))
        return f"""You are a knowledge graph extraction engine.
Your only job is to extract factual (subject, relation, object) triples from educational text.

Rules:
- subject and object must be specific named entities, concepts, or noun phrases (no pronouns)
- relation must be one of these exact predicates only: {allowed}
- use only the predicate names exactly as written above
- do not include vague or generic triples like ("text", "HAS", "words")
- maximum {self.max_triples} triples per chunk — prioritise the most specific and informative
- return ONLY a valid JSON array, no explanation, no markdown, no code fences

Example output:
[
  {{"subject": "Photosynthesis", "relation": "REQUIRES", "object": "Sunlight"}},
  {{"subject": "Chlorophyll", "relation": "PART_OF", "object": "Leaf"}},
  {{"subject": "Mitochondria", "relation": "IS_A", "object": "Organelle"}}
]"""
