"""
Utilities for exporting generated questions to JSON and CSV.
"""

from __future__ import annotations

import csv
import json
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any


def _to_question_dict(question: Any) -> dict[str, Any]:
    if is_dataclass(question):
        row = asdict(question)
    else:
        row = dict(question)

    options = row.get("options") or []
    correct = row.get("correct", "")
    row["options"] = list(options)
    row["distractors"] = [option for option in row["options"] if option != correct]
    row["distractor_distances"] = row.get("distractor_distances") or {}
    return row


def _export_dir(output_dir: str | Path | None) -> Path:
    base = Path(output_dir) if output_dir else Path("exports") / "questions"
    base.mkdir(parents=True, exist_ok=True)
    return base


def export_questions(
    doc_id: str,
    questions: list[Any],
    output_dir: str | Path | None = None,
) -> dict[str, str]:
    rows = [_to_question_dict(question) for question in questions]
    base_dir = _export_dir(output_dir)

    json_path = base_dir / f"{doc_id}_questions.json"
    csv_path = base_dir / f"{doc_id}_questions.csv"

    json_payload = {
        "doc_id": doc_id,
        "question_count": len(rows),
        "questions": rows,
    }
    json_path.write_text(json.dumps(json_payload, indent=2), encoding="utf-8")

    fieldnames = [
        "question_id",
        "doc_id",
        "question",
        "q_type",
        "difficulty",
        "concept",
        "relation",
        "correct",
        "source_chunk",
        "option_1",
        "option_2",
        "option_3",
        "option_4",
        "distractor_1",
        "distractor_2",
        "distractor_3",
        "distractor_distances_json",
    ]
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            options = row.get("options", [])
            distractors = row.get("distractors", [])
            writer.writerow(
                {
                    "question_id": row.get("question_id", ""),
                    "doc_id": row.get("doc_id", doc_id),
                    "question": row.get("question", ""),
                    "q_type": row.get("q_type", ""),
                    "difficulty": row.get("difficulty", ""),
                    "concept": row.get("concept", ""),
                    "relation": row.get("relation", ""),
                    "correct": row.get("correct", ""),
                    "source_chunk": row.get("source_chunk", ""),
                    "option_1": options[0] if len(options) > 0 else "",
                    "option_2": options[1] if len(options) > 1 else "",
                    "option_3": options[2] if len(options) > 2 else "",
                    "option_4": options[3] if len(options) > 3 else "",
                    "distractor_1": distractors[0] if len(distractors) > 0 else "",
                    "distractor_2": distractors[1] if len(distractors) > 1 else "",
                    "distractor_3": distractors[2] if len(distractors) > 2 else "",
                    "distractor_distances_json": json.dumps(
                        row.get("distractor_distances", {}),
                        sort_keys=True,
                    ),
                }
            )

    return {
        "json": str(json_path),
        "csv": str(csv_path),
    }
