#!/usr/bin/env python3
"""Write a redacted copy of a collected run, ready for the local viewer.

Copies the whole run, then substitutes each conversational turn's text with its
tagged version. Non-conversational events are copied untouched -- they were
never sent to the redaction model, so there is nothing to substitute. The
source run is never modified.
"""
import argparse
import json
import pathlib
import shutil


def load_redactions(redacted_dir: pathlib.Path) -> dict:
    """(trajectory, event_id) -> redacted text.

    event_id restarts at evt-000001 in every trajectory, so it is only unique
    within one. Keying on it alone cross-contaminates trajectories.
    """
    replacements = {}
    for path in sorted(redacted_dir.glob("traj-*.json")):
        bundle = json.loads(path.read_text())
        for turn in bundle["turns"]:
            if turn.get("redactions"):
                replacements[(bundle["trajectory"], turn["event_id"])] = turn["redacted_text"]
    return replacements


def rewrite_events(events_path: pathlib.Path, replacements: dict) -> int:
    trajectory = events_path.parent.name
    lines, changed = [], 0
    with events_path.open(errors="ignore") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            event = json.loads(line)
            new_text = replacements.get((trajectory, event.get("event_id")))
            if new_text is not None and event.get("event_type") == "message":
                event["payload"]["text"] = new_text
                event.setdefault("note", None)
                event["note"] = "Contains best-effort redaction tags; v0.1, no anonymity guarantee."
                changed += 1
            lines.append(json.dumps(event, ensure_ascii=False))
    events_path.write_text("\n".join(lines) + "\n")
    return changed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=pathlib.Path, required=True)
    parser.add_argument("--redacted", type=pathlib.Path, required=True)
    parser.add_argument("--out", type=pathlib.Path, required=True)
    args = parser.parse_args()

    if args.out.exists():
        shutil.rmtree(args.out)
    shutil.copytree(args.run, args.out)

    replacements = load_redactions(args.redacted)
    total = 0
    for events_path in sorted((args.out / "trajectories").glob("*/events.jsonl")):
        total += rewrite_events(events_path, replacements)

    index_path = args.out / "index.json"
    index = json.loads(index_path.read_text())
    index["redaction"] = {
        "backend": "llm",
        "notice": "Best-effort redaction v0.1; no formal anonymity guarantee. "
                  "Original-contributor final review is required before release.",
        "turns_tagged": total,
    }
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=1))

    print(json.dumps({"out": str(args.out), "turns_tagged": total,
                      "turns_expected": len(replacements)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
