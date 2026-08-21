#!/usr/bin/env python3
"""Extract only conversational turns (user input + model output) from a run.

Non-conversational events (tool_call, tool_result, artifact, git, system) are
skipped entirely -- they are the Code/ToCode content that must never reach the
redaction model. Output is one JSON file per trajectory, ready to hand to a
sub-agent in a single request.
"""
import argparse
import json
import pathlib

KEEP_EVENT_TYPE = "message"


def extract_one(traj_dir: pathlib.Path) -> dict:
    turns = []
    events_path = traj_dir / "events.jsonl"
    with events_path.open(encoding="utf-8", errors="replace") as fh:
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
            turns.append({
                "event_id": event.get("event_id"),
                "role": payload.get("role"),
                "timestamp": event.get("timestamp"),
                "text": text,
            })
    return {"trajectory": traj_dir.name, "turns": turns,
            "chars": sum(len(t["text"]) for t in turns)}


def extract_meeting(path: pathlib.Path) -> dict | None:
    dataset = json.loads(path.read_text(encoding="utf-8"))
    meeting_id = str(dataset.get("meeting_id") or dataset.get("id") or path.parent.name)
    turns = []
    for index, record in enumerate(dataset.get("records") or [], 1):
        if not isinstance(record, dict):
            continue
        text = record.get("text")
        if not isinstance(text, str) or not text.strip():
            continue
        turns.append({
            "event_id": str(record.get("record_id") or f"record-{index:06d}"),
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=pathlib.Path)
    parser.add_argument("--out", type=pathlib.Path, required=True)
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    index = []
    bundles = []
    trajectories = args.run / "trajectories"
    if trajectories.is_dir():
        bundles.extend(
            extract_one(traj_dir)
            for traj_dir in sorted(trajectories.iterdir())
            if traj_dir.is_dir()
        )
    meeting_path = args.run / "meeting.json"
    if meeting_path.is_file():
        meeting = extract_meeting(meeting_path)
        if meeting:
            bundles.append(meeting)
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
