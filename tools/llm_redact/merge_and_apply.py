#!/usr/bin/env python3
"""Merge sub-agent redaction findings, validate them, and apply the tags.

Validation is deliberately strict: a worker model that hallucinates an offset,
an unknown category, or an overlapping span must not be able to corrupt the
release candidate. Anything that fails a check is dropped and reported, never
silently applied.

Reads   work/<dialogue>/  (immutable source text)
        work/<findings>/  (one JSON per trajectory, from the workers)
Writes  work/<out>/redacted/<traj>.json   tagged turns
        work/<out>/report.json            per-category counts + rejects
"""
import argparse
import json
import pathlib

ALLOWED = {
    "credential",
    "private-personal",
    "sensitive",
    "internal-metric",
    "internal-timeline",
    "mosaic-reidentification",
}
TAG = '<redacted category="{}"/>'


def validate(findings, turns_by_id, traj, rejects):
    """Return findings that are safe to apply, grouped by event_id."""
    by_event = {}
    for f in findings:
        event_id = f.get("event_id")
        category = f.get("category")
        turn = turns_by_id.get(event_id)

        def drop(why):
            rejects.append({"trajectory": traj, "event_id": event_id,
                            "category": category, "reason": why})

        if turn is None:
            drop("unknown event_id")
            continue
        if category not in ALLOWED:
            drop("category not in allowlist")
            continue
        try:
            start, end = int(f["start"]), int(f["end"])
        except (KeyError, TypeError, ValueError):
            drop("missing or non-integer offsets")
            continue
        if not 0 <= start < end <= len(turn["text"]):
            drop(f"offsets out of range for text of length {len(turn['text'])}")
            continue
        by_event.setdefault(event_id, []).append(
            {"start": start, "end": end, "category": category,
             "confidence": f.get("confidence"), "reason": f.get("reason")})

    # Drop overlaps within an event, keeping the earlier/longer span.
    for event_id, spans in by_event.items():
        spans.sort(key=lambda s: (s["start"], -(s["end"] - s["start"])))
        kept = []
        for span in spans:
            if kept and span["start"] < kept[-1]["end"]:
                rejects.append({"trajectory": traj, "event_id": event_id,
                                "category": span["category"],
                                "reason": "overlaps an earlier span"})
                continue
            kept.append(span)
        by_event[event_id] = kept
    return by_event


def apply_spans(text: str, spans: list) -> str:
    out, cursor = [], 0
    for span in spans:
        out.append(text[cursor:span["start"]])
        out.append(TAG.format(span["category"]))
        cursor = span["end"]
    out.append(text[cursor:])
    return "".join(out)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dialogue", type=pathlib.Path, required=True)
    parser.add_argument("--findings", type=pathlib.Path, required=True)
    parser.add_argument("--out", type=pathlib.Path, required=True)
    args = parser.parse_args()

    redacted_dir = args.out / "redacted"
    redacted_dir.mkdir(parents=True, exist_ok=True)

    counts, rejects, per_traj = {}, [], []
    missing = []

    sources = [p for p in sorted(args.dialogue.glob("*.json")) if p.name != "index.json"]
    if not sources:
        raise SystemExit(f"no dialogue bundles found in {args.dialogue}")
    for src in sources:
        traj = src.stem
        bundle = json.loads(src.read_text())
        turns_by_id = {t["event_id"]: t for t in bundle["turns"]}

        result_path = args.findings / f"{traj}.json"
        if not result_path.exists():
            missing.append(traj)
            findings = []
        else:
            try:
                findings = json.loads(result_path.read_text()).get("findings", [])
            except json.JSONDecodeError:
                rejects.append({"trajectory": traj, "reason": "worker returned invalid JSON"})
                findings = []

        by_event = validate(findings, turns_by_id, traj, rejects)

        applied = 0
        for turn in bundle["turns"]:
            spans = by_event.get(turn["event_id"], [])
            turn["redactions"] = spans
            turn["redacted_text"] = apply_spans(turn["text"], spans) if spans else turn["text"]
            for span in spans:
                counts[span["category"]] = counts.get(span["category"], 0) + 1
                applied += 1

        (redacted_dir / f"{traj}.json").write_text(
            json.dumps(bundle, ensure_ascii=False, indent=1))
        per_traj.append({"trajectory": traj, "turns": len(bundle["turns"]),
                         "applied": applied})

    report = {"categories": counts,
              "total_applied": sum(counts.values()),
              "rejected": len(rejects),
              "rejects": rejects,
              "missing_worker_output": missing,
              "per_trajectory": per_traj}
    (args.out / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=1))
    print(json.dumps({k: report[k] for k in
                      ("categories", "total_applied", "rejected",
                       "missing_worker_output")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
