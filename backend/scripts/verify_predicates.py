"""
Smoke test for the predicate ontology loader.

Run: python -m backend.scripts.verify_predicates
     (or: cd backend && python -m scripts.verify_predicates)
Exit 0 on success, 1 on any failure.
"""
import re
import sys

try:
    from backend.graph.predicates import (
        PREDICATE_SPECS,
        PREDICATE_NAMES,
        ALLOWED_PREDICATES,
        ASYMMETRIC_PREDICATES,
        DAG_RELATIONS,
        predicate_rubric,
    )
except ImportError:
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from graph.predicates import (  # type: ignore
        PREDICATE_SPECS,
        PREDICATE_NAMES,
        ALLOWED_PREDICATES,
        ASYMMETRIC_PREDICATES,
        DAG_RELATIONS,
        predicate_rubric,
    )


REQUIRED = {
    "IS_A", "PART_OF", "REQUIRES", "PRECEDES", "EXTENSION_OF",
    "CAUSES", "LED_TO", "FOUND_IN", "LOCATED_IN",
    "CONTRASTS_WITH", "RELATES_TO",
}

SNAKE_CASE = re.compile(r"^[A-Z][A-Z0-9_]*$")


def _check(cond: bool, msg: str, errors: list[str]) -> None:
    if not cond:
        errors.append(msg)


def main() -> int:
    errors: list[str] = []

    _check(len(PREDICATE_SPECS) >= 20,
           f"Only {len(PREDICATE_SPECS)} predicates loaded (expected >= 20)", errors)

    for i, p in enumerate(PREDICATE_SPECS):
        _check(bool(p.name), f"predicate[{i}]: empty name", errors)
        _check(isinstance(p.description, str),
               f"{p.name}: description not a string", errors)
        _check(isinstance(p.example, str),
               f"{p.name}: example not a string", errors)
        _check(isinstance(p.asymmetric, bool),
               f"{p.name}: asymmetric not a bool", errors)
        _check(isinstance(p.dag, bool),
               f"{p.name}: dag not a bool", errors)

    dupes = [n for n in PREDICATE_NAMES if PREDICATE_NAMES.count(n) > 1]
    _check(not dupes, f"Duplicate predicates: {sorted(set(dupes))}", errors)

    for name in PREDICATE_NAMES:
        _check(" " not in name, f"'{name}' contains whitespace", errors)
        _check(bool(SNAKE_CASE.match(name)),
               f"'{name}' is not UPPER_SNAKE_CASE", errors)

    stray_asym = ASYMMETRIC_PREDICATES - ALLOWED_PREDICATES
    stray_dag = DAG_RELATIONS - ALLOWED_PREDICATES
    _check(not stray_asym, f"ASYMMETRIC not in ALLOWED: {stray_asym}", errors)
    _check(not stray_dag, f"DAG not in ALLOWED: {stray_dag}", errors)

    dag_not_asym = DAG_RELATIONS - ASYMMETRIC_PREDICATES
    _check(not dag_not_asym,
           f"DAG predicates must be asymmetric: {dag_not_asym}", errors)

    try:
        rubric = predicate_rubric()
        _check(len(rubric) > 0, "predicate_rubric() returned empty", errors)
        for name in PREDICATE_NAMES:
            _check(name in rubric, f"'{name}' missing from rubric", errors)
    except Exception as e:
        errors.append(f"predicate_rubric() raised: {e}")

    missing = REQUIRED - ALLOWED_PREDICATES
    _check(not missing, f"Required predicates missing: {missing}", errors)

    if errors:
        print(f"[verify_predicates] FAIL - {len(errors)} issue(s):")
        for e in errors:
            print(f"  X {e}")
        return 1

    print(f"[verify_predicates] OK - {len(PREDICATE_SPECS)} predicates "
          f"({len(ASYMMETRIC_PREDICATES)} asymmetric, {len(DAG_RELATIONS)} DAG)")
    return 0


if __name__ == "__main__":
    sys.exit(main())