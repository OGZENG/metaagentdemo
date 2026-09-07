"""Build deterministic browser datasets and thesis experiment profiles.

The source repositories/data are intentionally not vendored. Pass local copies to this
script and commit only the generated JavaScript fixtures used by the Flowise UI.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import random
import sys
from pathlib import Path
from typing import Any


SEED = 20260815
LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
MMLU_CATEGORIES = ("math", "computer science", "physics", "engineering")


def format_mcq(stem: str, choices: list[str]) -> str:
    rendered = "\n".join(f"{LETTERS[index]}. {choice.strip()}" for index, choice in enumerate(choices))
    return f"{stem.strip()}\n\n{rendered}\n\nSelect exactly one option and explain the reasoning briefly."


def write_javascript(path: Path, variable_name: str, source_comment: str, cases: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(cases, ensure_ascii=False, indent=4)
    path.write_text(
        f"/* eslint-disable */\n"
        f"// Generated deterministically by benchmarks/scripts/build_public_benchmark_subsets.py\n"
        f"// Source: {source_comment}\n"
        f"const {variable_name} = {body}\n\nexport default {variable_name}\n",
        encoding="utf-8",
    )


def write_profile_json(path: Path, source: str, paper_note: str, profiles: dict[str, dict[str, list[dict[str, Any]]]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "source": source,
                "paperNote": paper_note,
                "seed": SEED,
                "profiles": profiles,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )


def interleave_cases(cases: list[dict[str, Any]], seed_offset: int) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for case in cases:
        groups.setdefault(case.get("category") or "all", []).append(case)
    for group_index, group in enumerate(groups.values()):
        random.Random(SEED + seed_offset + group_index).shuffle(group)

    interleaved: list[dict[str, Any]] = []
    index = 0
    while any(index < len(group) for group in groups.values()):
        for group in groups.values():
            if index < len(group):
                interleaved.append(group[index])
        index += 1
    return interleaved


def make_profiles(
    development_cases: list[dict[str, Any]],
    test_cases: list[dict[str, Any]],
) -> dict[str, dict[str, list[dict[str, Any]]]]:
    if len(development_cases) < 160 or len(test_cases) < 100:
        raise ValueError("Profile generation requires at least 160 development and 100 test cases")
    optimization = development_cases[:112]
    validation = development_cases[112:160]
    return {
        "quick": {
            # Quick is a repeatable pilot profile. Keep all of its cases inside
            # the paper profile's development pool so repeated pilot runs never
            # reveal a paper-profile final-test answer.
            "optimization": development_cases[:40],
            "validation": development_cases[40:60],
            "test": development_cases[60:160],
        },
        "paper": {
            "optimization": optimization,
            "validation": validation,
            "test": test_cases,
        },
    }


def build_mmlu(parquet_path: Path) -> list[dict[str, Any]]:
    try:
        import pyarrow.parquet as pq
    except ImportError as error:
        raise SystemExit("pyarrow is required to read the MMLU-Pro parquet file") from error

    table = pq.read_table(parquet_path)
    records = table.to_pylist()
    cases: list[dict[str, Any]] = []

    for category_index, category in enumerate(MMLU_CATEGORIES):
        category_rows = [row for row in records if row["category"] == category]
        selected = random.Random(SEED + category_index).sample(category_rows, 5)
        for row in selected:
            cases.append(
                {
                    "id": f"mmlu_pro_{row['question_id']}",
                    "dataset": "MMLU-Pro",
                    "category": category,
                    "difficulty": "hard",
                    "sourceId": str(row["question_id"]),
                    "question": format_mcq(row["question"], list(row["options"])),
                    "referenceAnswer": row["answer"],
                }
            )
    return cases


def build_all_mmlu(parquet_path: Path) -> list[dict[str, Any]]:
    try:
        import pyarrow.parquet as pq
    except ImportError as error:
        raise SystemExit("pyarrow is required to read the MMLU-Pro parquet file") from error

    records = pq.read_table(parquet_path).to_pylist()
    return [
        {
            "id": f"mmlu_pro_{row['question_id']}",
            "dataset": "MMLU-Pro",
            "category": row["category"],
            "difficulty": "hard",
            "sourceId": str(row["question_id"]),
            "question": format_mcq(row["question"], list(row["options"])),
            "referenceAnswer": row["answer"],
        }
        for row in records
    ]


def build_musr(musr_root: Path) -> list[dict[str, Any]]:
    domain_counts = (("murder_mystery", 7), ("object_placements", 6), ("team_allocation", 7))
    cases: list[dict[str, Any]] = []

    for domain_index, (domain, count) in enumerate(domain_counts):
        records = json.loads((musr_root / "datasets" / f"{domain}.json").read_text(encoding="utf-8"))
        selected_indices = random.Random(SEED + 100 + domain_index).sample(range(len(records)), count)
        for local_index, record_index in enumerate(selected_indices):
            record = records[record_index]
            questions = record["questions"]
            question_index = random.Random(SEED + record_index).randrange(len(questions))
            item = questions[question_index]
            cases.append(
                {
                    "id": f"musr_{domain}_{record_index}_{question_index}",
                    "dataset": "MuSR",
                    "category": domain.replace("_", " "),
                    "difficulty": "hard",
                    "sourceId": f"{domain}:{record_index}:{question_index}",
                    "question": format_mcq(f"{record['context']}\n\nQuestion: {item['question']}", item["choices"]),
                    "referenceAnswer": LETTERS[int(item["answer"])],
                }
            )
    return cases


def build_all_musr(musr_root: Path) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    for domain in ("murder_mystery", "object_placements", "team_allocation"):
        records = json.loads((musr_root / "datasets" / f"{domain}.json").read_text(encoding="utf-8"))
        for record_index, record in enumerate(records):
            for question_index, item in enumerate(record["questions"]):
                cases.append(
                    {
                        "id": f"musr_{domain}_{record_index}_{question_index}",
                        "dataset": "MuSR",
                        "category": domain.replace("_", " "),
                        "difficulty": "hard",
                        "sourceId": f"{domain}:{record_index}:{question_index}",
                        "question": format_mcq(f"{record['context']}\n\nQuestion: {item['question']}", item["choices"]),
                        "referenceAnswer": LETTERS[int(item["answer"])],
                    }
                )
    return cases


def stable_choice_seed(record_id: str) -> int:
    digest = hashlib.sha256(f"{SEED}:{record_id}".encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big")


def build_gpqa(csv_path: Path) -> list[dict[str, Any]]:
    with csv_path.open(encoding="utf-8-sig", newline="") as handle:
        records = list(csv.DictReader(handle))

    selected = random.Random(SEED + 200).sample(records, 20)
    cases: list[dict[str, Any]] = []
    for row in selected:
        record_id = row["Record ID"]
        choices = [
            (row["Correct Answer"], True),
            (row["Incorrect Answer 1"], False),
            (row["Incorrect Answer 2"], False),
            (row["Incorrect Answer 3"], False),
        ]
        random.Random(stable_choice_seed(record_id)).shuffle(choices)
        answer_index = next(index for index, (_, correct) in enumerate(choices) if correct)
        cases.append(
            {
                "id": f"gpqa_diamond_{record_id}",
                "dataset": "GPQA Diamond",
                "category": row["High-level domain"].strip().lower(),
                "difficulty": "expert",
                "sourceId": record_id,
                "question": format_mcq(row["Question"], [choice for choice, _ in choices]),
                "referenceAnswer": LETTERS[answer_index],
            }
        )
    return cases


def build_all_gpqa(csv_path: Path, dataset_name: str) -> list[dict[str, Any]]:
    with csv_path.open(encoding="utf-8-sig", newline="") as handle:
        records = list(csv.DictReader(handle))

    cases: list[dict[str, Any]] = []
    for row in records:
        record_id = row["Record ID"]
        choices = [
            (row["Correct Answer"], True),
            (row["Incorrect Answer 1"], False),
            (row["Incorrect Answer 2"], False),
            (row["Incorrect Answer 3"], False),
        ]
        random.Random(stable_choice_seed(record_id)).shuffle(choices)
        answer_index = next(index for index, (_, correct) in enumerate(choices) if correct)
        cases.append(
            {
                "id": f"gpqa_{record_id}",
                "dataset": dataset_name,
                "category": row["High-level domain"].strip().lower(),
                "difficulty": "expert",
                "sourceId": record_id,
                "question": format_mcq(row["Question"], [choice for choice, _ in choices]),
                "referenceAnswer": LETTERS[answer_index],
            }
        )
    return cases


def build_experiment_profiles(
    mmlu_path: Path,
    musr_root: Path,
    gpqa_main_path: Path,
    gpqa_diamond_path: Path,
    output_dir: Path,
) -> None:
    mmlu_cases = interleave_cases(build_all_mmlu(mmlu_path), 1000)
    write_profile_json(
        output_dir / "mmlu-pro.json",
        "TIGER-Lab/MMLU-Pro test split (Apache-2.0)",
        "Paper-aligned profile uses a 160-case MAS search pool and a disjoint 500-case final test set.",
        make_profiles(mmlu_cases[:160], mmlu_cases[160:660]),
    )

    musr_cases = interleave_cases(build_all_musr(musr_root), 2000)
    write_profile_json(
        output_dir / "musr.json",
        "Zayne-sprague/MuSR (MIT)",
        "MuSR has no published MAS-search split; this project stratifies 160 cases for development and uses all remaining cases for final testing.",
        make_profiles(musr_cases[:160], musr_cases[160:]),
    )

    diamond_cases = interleave_cases(build_all_gpqa(gpqa_diamond_path, "GPQA Diamond"), 3000)
    diamond_ids = {case["sourceId"] for case in diamond_cases}
    main_non_diamond = [
        case for case in build_all_gpqa(gpqa_main_path, "GPQA") if case["sourceId"] not in diamond_ids
    ]
    development_cases = interleave_cases(main_non_diamond, 4000)[:160]
    write_profile_json(
        output_dir / "gpqa.json",
        "idavidrein/gpqa (CC BY 4.0)",
        "Paper-aligned profile uses 160 non-Diamond questions for MAS search and all 198 GPQA Diamond questions for final testing.",
        make_profiles(development_cases, diamond_cases),
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mmlu-parquet", type=Path, required=True)
    parser.add_argument("--musr-root", type=Path, required=True)
    parser.add_argument("--gpqa-diamond-csv", type=Path, required=True)
    parser.add_argument("--gpqa-main-csv", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--profile-output-dir", type=Path)
    parser.add_argument("--python-deps", type=Path, help="Optional directory containing pyarrow")
    args = parser.parse_args()

    if args.python_deps:
        sys.path.insert(0, str(args.python_deps.resolve()))

    write_javascript(
        args.output_dir / "mmluPro20.js",
        "mmluPro20",
        "TIGER-AI-Lab/MMLU-Pro test split (Apache-2.0), seed 20260815",
        build_mmlu(args.mmlu_parquet),
    )
    write_javascript(
        args.output_dir / "musr20.js",
        "musr20",
        "Zayne-sprague/MuSR (MIT), seed 20260815",
        build_musr(args.musr_root),
    )
    write_javascript(
        args.output_dir / "gpqaDiamond20.js",
        "gpqaDiamond20",
        "idavidrein/gpqa Diamond (CC BY 4.0), seed 20260815",
        build_gpqa(args.gpqa_diamond_csv),
    )
    if args.profile_output_dir:
        if not args.gpqa_main_csv:
            raise SystemExit("--gpqa-main-csv is required with --profile-output-dir")
        build_experiment_profiles(
            args.mmlu_parquet,
            args.musr_root,
            args.gpqa_main_csv,
            args.gpqa_diamond_csv,
            args.profile_output_dir,
        )


if __name__ == "__main__":
    main()
