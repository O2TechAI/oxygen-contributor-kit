#!/usr/bin/env python3
"""Extract only normalized message events from a prepared AI review run.

Fixed action labels are skipped entirely. Output is one JSON file per
trajectory, ready to hand to a sub-agent in a single request.
"""
import argparse
import json
import pathlib
import sys

TOOLS_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))
LLM_REDACT_ROOT = pathlib.Path(__file__).resolve().parent
if str(LLM_REDACT_ROOT) not in sys.path:
    sys.path.insert(0, str(LLM_REDACT_ROOT))

from oxygen_utf8 import configure_utf8_stdio
from ingest.human_source_projection import (
    meeting_contribution_ids,
)
from prepare_ai_review_run import discover_meetings

KEEP_EVENT_TYPE = "message"


def extract_one(traj_dir: pathlib.Path) -> dict:
    turns = []
    document_id = traj_dir.name
    events_path = traj_dir / "events.jsonl"
    with events_path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("event_type") != KEEP_EVENT_TYPE:
                continue
            payload = event.get("payload") or {}
            text = payload.get("text") or ""
            if not text.strip():
                continue
            item_id = event.get("event_id")
            turns.append({
                "event_id": event.get("event_id"),
                "document_id": document_id,
                "item_id": item_id,
                "role": payload.get("role"),
                "timestamp": event.get("timestamp"),
                "text": text,
            })
    return {"trajectory": document_id, "document_kind": "trajectory", "turns": turns,
            "chars": sum(len(t["text"]) for t in turns)}


def extract_meeting(path: pathlib.Path) -> dict | None:
    dataset = json.loads(path.read_text(encoding="utf-8"))
    meeting_id = str(dataset.get("meeting_id") or dataset.get("id") or path.parent.name)
    records = dataset.get("records") or []
    try:
        item_ids = meeting_contribution_ids(meeting_id, records)
    except ValueError as error:
        raise SystemExit(f"invalid meeting contribution identity: {error}") from error
    turns = []
    for index, (record, item_id) in enumerate(zip(records, item_ids), 1):
        if not isinstance(record, dict):
            continue
        text = record.get("text")
        if not isinstance(text, str) or not text.strip():
            continue
        turns.append({
            "event_id": str(record.get("record_id") or f"record-{index:06d}"),
            "document_id": meeting_id,
            "item_id": item_id,
            "role": "user",
            "timestamp": record.get("timestamp") or record.get("started_at"),
            "text": text,
        })
    if not turns:
        return None
    return {
        "trajectory": meeting_id,
        "document_kind": "meeting",
        "turns": turns,
        "chars": sum(len(turn["text"]) for turn in turns),
    }


def extract_bundles(run: pathlib.Path) -> list[dict]:
    bundles = []
    trajectories = run / "trajectories"
    if trajectories.is_dir():
        bundles.extend(
            extract_one(traj_dir)
            for traj_dir in sorted(trajectories.iterdir())
            if traj_dir.is_dir()
        )
    for meeting in discover_meetings(run):
        bundle = extract_meeting(meeting["path"])
        if bundle:
            bundles.append(bundle)
    return bundles


def main() -> int:
    configure_utf8_stdio()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=pathlib.Path)
    parser.add_argument("--out", type=pathlib.Path, required=True)
    args = parser.parse_args()

    index = []
    bundles = extract_bundles(args.run)
    args.out.mkdir(parents=True, exist_ok=True)
    for bundle in bundles:
        if not bundle["turns"]:
            continue
        dest = args.out / f"{bundle['trajectory']}.json"
        dest.write_text(
            json.dumps(bundle, ensure_ascii=False, indent=1),
            encoding="utf-8",
        )
        index.append({"trajectory": bundle["trajectory"],
                      "document_kind": bundle.get("document_kind", "trajectory"),
                      "turns": len(bundle["turns"]),
                      "chars": bundle["chars"],
                      "file": str(dest)})
    if not index:
        raise SystemExit(f"no conversational turns found in {args.run}")
    (args.out / "index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
    total = sum(item["chars"] for item in index)
    print(json.dumps({"trajectories": len(index),
                      "turns": sum(i["turns"] for i in index),
                      "chars": total}, ensure_ascii=False))
    for item in sorted(index, key=lambda x: -x["chars"]):
        print(f"  {item['trajectory']}  turns={item['turns']:4d}  chars={item['chars']:7d}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
