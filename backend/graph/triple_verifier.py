from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from typing import Any, Dict, List, Optional, Protocol


ALLOWED_PREDICATES = {
  # ─── Shared / IPD-origin ───
  "REQUIRES",
  "IS_A",
  "CAUSES",
  "PART_OF",
  "DEFINES",
  "CONTRASTS_WITH",
  "EXAMPLE_OF",
  "FOUND_IN",
  "OCCURS_DURING",
  "USED_FOR",
  "CHARACTERIZED_BY",
  "VISIBLE_IN",
  "CONTAINS",
  "LOCATED_IN",
  "COMPARED_WITH",
  # ─── Study-Lens-origin ───
  "FEATURE_OF",
  "PRECEDES",
  "EXTENSION_OF",
  "DISCOVERED_BY",
  "BUILT_BY",
  "PRODUCED_BY",
  "SUPPLIED_BY",
  "TRADED_BY",
  "LED_TO",
  "RELATES_TO",
}


@dataclass
class Triple:
  subject: str
  predicate: str
  object: str
  source_chunk_id: Optional[str] = None
  extraction_confidence: Optional[float] = None


@dataclass
class TripleVerificationResult:
  subject: str
  predicate: str
  object: str
  is_supported: bool
  confidence: float
  reason: str
  corrected_subject: Optional[str] = None
  corrected_predicate: Optional[str] = None
  corrected_object: Optional[str] = None
  source_chunk_id: Optional[str] = None


class LLMClient(Protocol):
  def generate(self, prompt: str) -> str:
    ...


class TripleVerifier:
  def __init__(
    self,
    llm_client: LLMClient,
    allowed_predicates: Optional[set[str]] = None,
    min_confidence: float = 0.70,
  ) -> None:
    self.llm_client = llm_client
    self.allowed_predicates = allowed_predicates or ALLOWED_PREDICATES
    self.min_confidence = min_confidence

  def verify_triple(
    self,
    passage: str,
    triple: Triple,
  ) -> TripleVerificationResult:
    if triple.predicate not in self.allowed_predicates:
      return TripleVerificationResult(
        subject=triple.subject,
        predicate=triple.predicate,
        object=triple.object,
        is_supported=False,
        confidence=0.0,
        reason=f"Predicate '{triple.predicate}' is not in allowed ontology.",
        source_chunk_id=triple.source_chunk_id,
      )

    prompt = self._build_verification_prompt(passage, triple)
    raw = self.llm_client.generate(prompt)
    parsed = self._safe_parse_json(raw)

    result = TripleVerificationResult(
      subject=triple.subject,
      predicate=triple.predicate,
      object=triple.object,
      is_supported=bool(parsed.get("is_supported", False)),
      confidence=float(parsed.get("confidence", 0.0)),
      reason=str(parsed.get("reason", "")).strip(),
      corrected_subject=self._none_if_blank(parsed.get("corrected_subject")),
      corrected_predicate=self._none_if_blank(parsed.get("corrected_predicate")),
      corrected_object=self._none_if_blank(parsed.get("corrected_object")),
      source_chunk_id=triple.source_chunk_id,
    )

    if result.corrected_predicate and result.corrected_predicate not in self.allowed_predicates:
      result.corrected_predicate = None

    return result

  def verify_batch(
    self,
    passage: str,
    triples: List[Triple],
  ) -> List[TripleVerificationResult]:
    results: List[TripleVerificationResult] = []
    for triple in triples:
      results.append(self.verify_triple(passage, triple))
    return results

  def filter_verified(
    self,
    results: List[TripleVerificationResult],
  ) -> List[TripleVerificationResult]:
    verified: List[TripleVerificationResult] = []
    for result in results:
      if result.is_supported and result.confidence >= self.min_confidence:
        verified.append(result)
    return verified

  def apply_corrections(
    self,
    results: List[TripleVerificationResult],
  ) -> List[Triple]:
    corrected: List[Triple] = []
    for result in results:
      if not result.is_supported or result.confidence < self.min_confidence:
        continue

      subject = result.corrected_subject or result.subject
      predicate = result.corrected_predicate or result.predicate
      object_ = result.corrected_object or result.object

      if predicate not in self.allowed_predicates:
        continue

      corrected.append(
        Triple(
          subject=subject,
          predicate=predicate,
          object=object_,
          source_chunk_id=result.source_chunk_id,
          extraction_confidence=result.confidence,
        )
      )
    return corrected

  def _build_verification_prompt(self, passage: str, triple: Triple) -> str:
    allowed = ", ".join(sorted(self.allowed_predicates))
    return f"""
You are an independent knowledge graph triple verifier.

Your task:
1. Read the source passage carefully.
2. Judge whether the triple is directly and explicitly supported by the passage.
3. Reject triples that rely on inference, background knowledge, stylistic interpretation, metaphor, or vague implication.
4. Only accept a triple if a student could answer a question from the passage alone.
5. Do NOT assume facts not present in the passage.
6. Do NOT rewrite using free-form predicates.
7. If the triple is wrong but can be fixed using the passage, suggest a corrected triple only when the correction is also directly supported.
8. Allowed predicates are ONLY: {allowed}

Important verification rules:
- "Directly supported" means the passage states the fact clearly, or it is a very close paraphrase.
- Reject decorative or descriptive relations such as contrasts based on tone or appearance unless the passage explicitly compares the two things.
- Reject relations like PART_OF, CAUSES, REQUIRES, DEFINES, or IS_A when the passage does not clearly state that exact relationship.
- If support is partial, ambiguous, or inferred, return is_supported = false.
- Be strict. It is better to reject a weak triple than to approve a hallucinated one.

Return STRICT JSON only with these keys:
{{
  "is_supported": true or false,
  "confidence": float between 0 and 1,
  "reason": "short explanation that refers to explicit support or lack of support",
  "corrected_subject": "string or null",
  "corrected_predicate": "string or null",
  "corrected_object": "string or null"
}}

Source passage:
\"\"\"
{passage}
\"\"\"

Triple to verify:
{json.dumps(asdict(triple), ensure_ascii=False)}
""".strip()

  def _safe_parse_json(self, raw: str) -> Dict[str, Any]:
    raw = raw.strip()

    try:
      return json.loads(raw)
    except json.JSONDecodeError:
      pass

    start = raw.find("{")
    end = raw.rfind("}")
    if start != -1 and end != -1 and end > start:
      try:
        return json.loads(raw[start:end + 1])
      except json.JSONDecodeError:
        pass

    return {
      "is_supported": False,
      "confidence": 0.0,
      "reason": f"Verifier returned invalid JSON: {raw[:300]}",
      "corrected_subject": None,
      "corrected_predicate": None,
      "corrected_object": None,
    }

  def _none_if_blank(self, value: Any) -> Optional[str]:
    if value is None:
      return None
    value = str(value).strip()
    return value if value else None
