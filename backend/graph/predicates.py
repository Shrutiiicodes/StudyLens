"""
Single source of truth for the predicate ontology.

Loads from /shared/predicates.json so that the TS kg-builder and the
Python concept_extractor cannot drift out of sync.
"""
import json
from dataclasses import dataclass
from pathlib import Path

_SHARED = Path(__file__).resolve().parents[2] / "shared" / "predicates.json"


@dataclass(frozen=True)
class PredicateSpec:
    name: str
    description: str
    example: str
    asymmetric: bool
    dag: bool


def _load() -> list[PredicateSpec]:
    with _SHARED.open() as f:
        data = json.load(f)
    return [PredicateSpec(**item) for item in data["predicates"]]


PREDICATE_SPECS: list[PredicateSpec] = _load()
PREDICATE_NAMES: list[str] = [p.name for p in PREDICATE_SPECS]
ALLOWED_PREDICATES: set[str] = set(PREDICATE_NAMES)
ASYMMETRIC_PREDICATES: set[str] = {p.name for p in PREDICATE_SPECS if p.asymmetric}
DAG_RELATIONS: set[str] = {p.name for p in PREDICATE_SPECS if p.dag}


def predicate_rubric() -> str:
    """Human-readable rubric for inclusion in extractor prompts."""
    lines = []
    for p in PREDICATE_SPECS:
        line = f"- {p.name:18s}→ {p.description}"
        if p.example:
            line += f' ("{p.example}")'
        lines.append(line)
    return "\n".join(lines)