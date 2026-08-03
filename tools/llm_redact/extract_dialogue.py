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
    with events_path.open(errors="ignore") as fh:
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=pathlib.Path)
    parser.add_argument("--out", type=pathlib.Path, required=True)
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    index = []
    for traj_dir in sorted((args.run / "trajectories").iterdir()):
        if not traj_dir.is_dir():
            continue
        bundle = extract_one(traj_dir)
        if not bundle["turns"]:
            continue
        dest = args.out / f"{bundle['trajectory']}.json"
        dest.write_text(json.dumps(bundle, ensure_ascii=False, indent=1))
        index.append({"trajectory": bundle["trajectory"],
                      "turns": len(bundle["turns"]),
                      "chars": bundle["chars"],
                      "file": str(dest)})
    (args.out / "index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=1))
    total = sum(item["chars"] for item in index)
    print(json.dumps({"trajectories": len(index),
                      "turns": sum(i["turns"] for i in index),
                      "chars": total}, ensure_ascii=False))
    for item in sorted(index, key=lambda x: -x["chars"]):
        print(f"  {item['trajectory']}  turns={item['turns']:4d}  chars={item['chars']:7d}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
