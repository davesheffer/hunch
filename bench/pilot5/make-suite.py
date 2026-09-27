#!/usr/bin/env python3
"""Build bench/pilot5/suite.json from the five preregistered issue cards.

Deterministic: reads bench/pilot5/cards/*.yaml and bench/pilot5/validators/**,
validates hashes and shapes, and writes bench/pilot5/suite.json. Does not
touch any other file. See bench/pilot5/GATE-A-HARNESS.md for the schema this
serves.
"""
import hashlib
import json
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent  # bench/pilot5

# Task order = SELECTION.md category order.
CATEGORY_ORDER = [
    "repeated-bug",
    "continuation",
    "convention",
    "operation",
    "self-contained",
]

RECORD_ID_RE = re.compile(r"^(dec|con|fnd|bug|htask)_[0-9a-f]+$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
ISO_UTC_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$"
)


class Stop(Exception):
    """Raised for any condition the brief says must stop the run."""


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode("utf-8"))


def load_card(category: str) -> dict:
    path = ROOT / "cards" / f"{category}.yaml"
    with path.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def resolve_prompt_variant(card: dict, category: str) -> tuple[str, str]:
    """Return (prompt_text_to_use, variant_label). Stops if no variant matches."""
    prompt = card["task_prompt"]
    expected = card["issue_text_sha256"]

    variants = {
        "as-loaded": prompt,
        "minus-trailing-newline": prompt[:-1] if prompt.endswith("\n") else None,
        "plus-trailing-newline": prompt + "\n",
    }

    for label, candidate in variants.items():
        if candidate is None:
            continue
        got = sha256_text(candidate)
        if got == expected:
            return candidate, label

    got_as_loaded = sha256_text(prompt)
    raise Stop(
        f"card {category!r} (issue #{card.get('issue_number')}): task_prompt does not "
        f"match issue_text_sha256 under any variant.\n"
        f"  expected:                 {expected}\n"
        f"  as-loaded:                {got_as_loaded}\n"
        f"  minus-trailing-newline:   {sha256_text(variants['minus-trailing-newline']) if variants['minus-trailing-newline'] is not None else 'n/a (no trailing newline)'}\n"
        f"  plus-trailing-newline:    {sha256_text(variants['plus-trailing-newline'])}"
    )


def check_validator(card: dict, category: str, issue_number: int) -> str:
    """Validate the validator file and return its path relative to bench/pilot5/."""
    validator_dir = ROOT / "validators" / str(issue_number)
    validator_file = validator_dir / f"pilot5-issue-{issue_number}.test.ts"

    if not validator_file.is_file():
        raise Stop(
            f"card {category!r} (issue #{issue_number}): validator file not found: {validator_file}"
        )

    files_in_dir = sorted(p.name for p in validator_dir.iterdir() if p.is_file())
    if files_in_dir != [validator_file.name]:
        print(
            f"WARNING: {validator_dir} contains more than just the validator file: {files_in_dir}",
            file=sys.stderr,
        )

    data = validator_file.read_bytes()
    got = sha256_bytes(data)
    expected = card["validator"]["validator_sha256"]
    if got != expected:
        raise Stop(
            f"card {category!r} (issue #{issue_number}): validator sha256 mismatch.\n"
            f"  file:     {validator_file}\n"
            f"  expected: {expected}\n"
            f"  got:      {got}"
        )

    rel = validator_file.relative_to(ROOT).as_posix()
    return rel, got


def build_task(category: str) -> dict:
    card = load_card(category)

    issue_number = card["issue_number"]
    if not isinstance(issue_number, int):
        raise Stop(f"card {category!r}: issue_number is not an int: {issue_number!r}")

    card_category = card["category"]
    if card_category != category:
        raise Stop(
            f"card {category!r}: card's own category field ({card_category!r}) "
            f"does not match its filename-derived category"
        )

    starting_commit = card["starting_commit"]
    if not SHA_RE.match(starting_commit):
        raise Stop(
            f"card {category!r} (issue #{issue_number}): starting_commit is not "
            f"40 lowercase hex characters: {starting_commit!r}"
        )

    memory = card["memory"]
    cutoff_at = memory["cutoff_at"]
    if not ISO_UTC_RE.match(cutoff_at):
        raise Stop(
            f"card {category!r} (issue #{issue_number}): memory.cutoff_at is not "
            f"an ISO UTC timestamp ending in Z: {cutoff_at!r}"
        )

    eligible_record_ids = memory["eligible_record_ids"]
    if not isinstance(eligible_record_ids, list) or not eligible_record_ids:
        raise Stop(
            f"card {category!r} (issue #{issue_number}): memory.eligible_record_ids "
            f"must be a non-empty list"
        )
    for rid in eligible_record_ids:
        if not isinstance(rid, str) or not RECORD_ID_RE.match(rid):
            raise Stop(
                f"card {category!r} (issue #{issue_number}): eligible_record_ids "
                f"entry fails the id pattern: {rid!r}"
            )

    relevance_expected = memory["relevance_expected"]
    if relevance_expected not in ("relevant", "abstain", "unknown"):
        raise Stop(
            f"card {category!r} (issue #{issue_number}): memory.relevance_expected "
            f"is not one of relevant/abstain/unknown: {relevance_expected!r}"
        )

    prompt, variant = resolve_prompt_variant(card, category)
    validator_rel, validator_sha = check_validator(card, category, issue_number)

    task = {
        "id": f"{category}-{issue_number}",
        "issue_number": issue_number,
        "category": category,
        "prompt": prompt,
        "starting_commit": starting_commit,
        "memory": {
            "cutoff_at": cutoff_at,
            "eligible_record_ids": list(eligible_record_ids),
            "relevance_expected": relevance_expected,
        },
        "validator": {
            "file": validator_rel,
            "sha256": validator_sha,
        },
    }
    return task, variant, len(prompt), len(eligible_record_ids)


def main() -> int:
    tasks = []
    seen_ids = set()

    for category in CATEGORY_ORDER:
        try:
            task, variant, prompt_chars, eligible_count = build_task(category)
        except Stop as e:
            print(f"STOP: {e}", file=sys.stderr)
            return 1

        if task["id"] in seen_ids:
            print(f"STOP: duplicate task id {task['id']!r}", file=sys.stderr)
            return 1
        seen_ids.add(task["id"])

        print(
            f"{task['id']}: prompt_variant={variant} prompt_chars={prompt_chars} "
            f"validator=ok eligible_count={eligible_count}"
        )
        tasks.append(task)

    suite = {
        "schema": "hunch.context-efficiency-suite/1",
        "id": "pilot5-gate-a",
        "kind": "retrospective",
        "timeout_ms": 1800000,
        "validator_timeout_ms": 600000,
        "tasks": tasks,
    }

    out_path = ROOT / "suite.json"
    text = json.dumps(suite, indent=2, ensure_ascii=False) + "\n"
    with out_path.open("w", encoding="utf-8", newline="\n") as f:
        f.write(text)

    return 0


if __name__ == "__main__":
    sys.exit(main())
