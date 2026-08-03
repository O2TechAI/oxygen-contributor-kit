#!/usr/bin/env python3
"""Turn a prepared redaction case into a run the local viewer can import.

The prepared case is already the release shape: every non-conversational event
has collapsed to a bare `action_label` and only conversational turns keep text.
This adds the minimal per-trajectory manifest the viewer's importer expects,
without reintroducing anything the policy strips -- no source session ids, no
original titles, no artifact files, no executor metadata.
"""
import argparse
import json
import pathlib
import shutil

LABEL_TEXT = {
    "system": "[system action]",
    "tool_call": "[tool call]",
    "tool_result": "[tool result]",
    "artifact": "[artifact]",
    "version_control": "[version control]",
    "agent_event": "[agent event]",
    "user_event": "[user event]",
    "other": "[action]",
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", type=pathlib.Path, required=True)
    parser.add_argument("--out", type=pathlib.Path, required=True)
    args = parser.parse_args()

    source = args.case / "automatic" / "data" / "trajectories"
    if args.out.exists():
        shutil.rmtree(args.out)
    (args.out / "trajectories").mkdir(parents=True)

    index = {"schema_version": "0.2", "tool": "build_release_run",
             "trajectory_count": 0, "review_status": "pending",
             "publication_approved": False, "trajectories": []}

    labels = 0
    messages = 0
    for traj_dir in sorted(source.iterdir()):
        if not traj_dir.is_dir():
            continue
        dest = args.out / "trajectories" / traj_dir.name
        dest.mkdir(parents=True)

        rewritten = []
        for line in (traj_dir / "events.jsonl").read_text(errors="ignore").splitlines():
            if not line.strip():
                continue
            event = json.loads(line)
            if event.get("event_type") == "action_label":
                # The viewer renders payload text; give the label a short
                # human-readable stand-in so the row is not blank. The label
                # kind is the only thing the policy lets us keep.
                kind = (event.get("payload") or {}).get("action_type") or "other"
                event.setdefault("payload", {})
                event["payload"]["text"] = LABEL_TEXT.get(kind, LABEL_TEXT["other"])
                labels += 1
            elif event.get("event_type") == "message":
                messages += 1
            rewritten.append(json.dumps(event, ensure_ascii=False))
        (dest / "events.jsonl").write_text("\n".join(rewritten) + "\n")

        (dest / "manifest.json").write_text(json.dumps({
            "trajectory_id": traj_dir.name,
            "title": traj_dir.name,
            "source_system": "codex",
            "schema_version": "0.2",
            "notice": "Release candidate. Non-conversational events are reduced to "
                      "action labels; no artifact content is retained.",
        }, ensure_ascii=False, indent=1))

        index["trajectories"].append({"trajectory_id": traj_dir.name, "ok": True})
        index["trajectory_count"] += 1

    (args.out / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1))
    print(json.dumps({"out": str(args.out),
                      "trajectories": index["trajectory_count"],
                      "action_labels": labels, "messages": messages},
                     ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
