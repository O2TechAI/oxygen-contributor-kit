#!/usr/bin/env python3
"""Check <run>/preference-probes.json against the probe contract.

Catches the failure modes that quietly produce a bad annotation pass: counts that
do not add up, probes whose evidence does not exist in the run, generic options,
and missing escape hatches.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


SIGNALS = {
    "repeated_correction", "long_exchange", "late_rejection",
    "decision_reversal", "explicit_rule", "sustained_disagreement",
}

# Options that could have been written without reading the transcript. A probe built
# from these makes the contributor pick "other" and costs them more than no probe.
GENERIC = {
    "be more careful", "communicate better", "be clearer", "ask more questions",
    "do better", "follow instructions", "be consistent", "improve quality",
    "write better code", "test more", "be faster", "explain more",
}

MAX_PROBES = 20
MAX_RECAP_SENTENCES = 3
AUTO_REMOVED_FIELDS = {"total", "reversible", "categories"}
AUTO_REMOVED_CATEGORY_FIELDS = {"kind", "count"}
AUTO_REMOVED_KINDS = {
    "credential",
    "private-personal",
    "sensitive",
    "internal-metric",
    "internal-timeline",
    "mosaic-reidentification",
    "user_path",
    "third_party_contact",
}


def validate_auto_removed(value: object) -> list[str]:
    errors: list[str] = []
    if not isinstance(value, dict):
        return ["auto_removed must be an object"]

    unknown = set(value) - AUTO_REMOVED_FIELDS
    missing = AUTO_REMOVED_FIELDS - set(value)
    if unknown:
        errors.append("auto_removed has unknown fields")
    if missing:
        errors.append(f"auto_removed is missing fields: {', '.join(sorted(missing))}")

    total = value.get("total")
    if type(total) is not int or total < 0:
        errors.append("auto_removed.total must be a non-negative integer")
    if not isinstance(value.get("reversible"), bool):
        errors.append("auto_removed.reversible must be a boolean")

    categories = value.get("categories")
    if not isinstance(categories, list):
        errors.append("auto_removed.categories must be an array")
        return errors

    summed = 0
    seen_kinds: set[str] = set()
    counts_valid = True
    for index, category in enumerate(categories):
        label = f"auto_removed.categories[{index}]"
        if not isinstance(category, dict):
            errors.append(f"{label} must be an object")
            counts_valid = False
            continue
        category_unknown = set(category) - AUTO_REMOVED_CATEGORY_FIELDS
        category_missing = AUTO_REMOVED_CATEGORY_FIELDS - set(category)
        if category_unknown:
            errors.append(f"{label} has unknown fields")
        if category_missing:
            errors.append(f"{label} is missing fields: {', '.join(sorted(category_missing))}")

        kind = category.get("kind")
        if not isinstance(kind, str) or kind not in AUTO_REMOVED_KINDS:
            errors.append(f"{label}.kind is not an allowed aggregate category")
        elif kind in seen_kinds:
            errors.append(f"{label}.kind duplicates {kind!r}")
        else:
            seen_kinds.add(kind)

        count = category.get("count")
        if type(count) is not int or count < 0:
            errors.append(f"{label}.count must be a non-negative integer")
            counts_valid = False
        else:
            summed += count

    if type(total) is int and total >= 0 and counts_valid and total != summed:
        errors.append(f"auto_removed.total {total} != sum of categories {summed}")
    return errors


def collect_event_ids(run: Path) -> set[str]:
    ids: set[str] = set()
    for events in (run / "trajectories").glob("*/events.jsonl"):
        with events.open(encoding="utf-8", errors="replace") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(event.get("event_id"), str):
                    ids.add(event["event_id"])
    meeting = run / "meeting.json"
    if meeting.exists():
        try:
            dataset = json.loads(meeting.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            dataset = {}
        for record in dataset.get("records") or []:
            if isinstance(record.get("record_id"), str):
                ids.add(record["record_id"])
    return ids


def sentence_count(text: str) -> int:
    return sum(text.count(mark) for mark in (".", "!", "?", "。", "！", "？")) or 1


def validate(run: Path) -> list[str]:
    errors: list[str] = []
    path = run / "preference-probes.json"
    if not path.exists():
        return [f"missing {path}"]
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return [f"{path.name} is not valid JSON: {exc}"]

    if not isinstance(data, dict):
        return [f"{path.name} must contain a JSON object"]

    if data.get("schema_version") != "1":
        errors.append("schema_version must be \"1\"")

    errors.extend(validate_auto_removed(data.get("auto_removed")))

    for decision in data.get("bulk_decisions") or []:
        did = decision.get("id", "<no id>")
        if decision.get("default") != "keep":
            errors.append(f"{did}: default must be \"keep\"; removal requires a deliberate answer")
        if decision.get("answer") not in (None, "remove", "keep", "inspect"):
            errors.append(f"{did}: answer must be null, remove, keep, or inspect")

    known_events = collect_event_ids(run)
    probes = data.get("probes") or []
    if len(probes) > MAX_PROBES:
        errors.append(f"{len(probes)} probes exceeds the hard limit of {MAX_PROBES}")

    seen_ids: set[str] = set()
    for probe in probes:
        pid = probe.get("id", "<no id>")
        if pid in seen_ids:
            errors.append(f"{pid}: duplicate probe id")
        seen_ids.add(pid)

        if probe.get("document_kind") not in ("trajectory", "meeting"):
            errors.append(f"{pid}: document_kind must be trajectory or meeting")
        if probe.get("signal") not in SIGNALS:
            errors.append(f"{pid}: unknown signal {probe.get('signal')!r}")
        score = probe.get("score")
        if not isinstance(score, int) or not 0 <= score <= 100:
            errors.append(f"{pid}: score must be an integer 0-100")

        event_ids = probe.get("event_ids") or []
        if not event_ids:
            errors.append(f"{pid}: needs at least one evidence event id")
        if known_events:
            for event_id in event_ids:
                if event_id not in known_events:
                    errors.append(f"{pid}: evidence {event_id} not found in the run")

        recap = (probe.get("recap") or "").strip()
        if not recap:
            errors.append(f"{pid}: recap is required")
        elif sentence_count(recap) > MAX_RECAP_SENTENCES:
            errors.append(f"{pid}: recap is longer than {MAX_RECAP_SENTENCES} sentences")

        options = probe.get("options") or []
        if not 2 <= len(options) <= 3:
            errors.append(f"{pid}: needs 2 or 3 options, found {len(options)}")
        texts = [(o.get("text") or "").strip() for o in options]
        if any(not t for t in texts):
            errors.append(f"{pid}: every option needs text")
        lowered = [t.lower().rstrip(".") for t in texts]
        if len(set(lowered)) != len(lowered):
            errors.append(f"{pid}: options must be distinct")
        for text, low in zip(texts, lowered):
            if low in GENERIC:
                errors.append(f"{pid}: option {text!r} is generic; ground it in this transcript")

        if probe.get("allow_other") is not True:
            errors.append(f"{pid}: allow_other must be true")
        if probe.get("allow_skip") is not True:
            errors.append(f"{pid}: allow_skip must be true")

        answer = probe.get("answer")
        if answer is not None:
            choice = answer.get("choice") if isinstance(answer, dict) else None
            valid = {o.get("id") for o in options} | {"other", "skip"}
            if choice not in valid:
                errors.append(f"{pid}: answer.choice {choice!r} is not one of {sorted(valid)}")
            elif choice == "other" and not (answer.get("text") or "").strip():
                errors.append(f"{pid}: answer.choice 'other' needs text")

    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("run", type=Path, help="Oxygen run directory")
    args = parser.parse_args()
    run = args.run.expanduser().resolve()

    errors = validate(run)
    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        print(f"\n{len(errors)} problem(s) found.", file=sys.stderr)
        return 1

    data = json.loads((run / "preference-probes.json").read_text(encoding="utf-8"))
    probes = data.get("probes") or []
    answered = sum(1 for p in probes if p.get("answer") is not None)
    removed = (data.get("auto_removed") or {}).get("total", 0)
    print(json.dumps({
        "ok": True,
        "probes": len(probes),
        "answered": answered,
        "set_aside": data.get("set_aside", 0),
        "auto_removed": removed,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
