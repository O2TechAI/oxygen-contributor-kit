#!/usr/bin/env python3
"""Build a safe first-pass project map for one repo-scoped ingest run.

The coding agent should review project aliases and summaries before launching the Viewer.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

TOOLS_ROOT = Path(__file__).resolve().parents[3] / "tools"
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from oxygen_utf8 import configure_utf8_stdio


def message_text(event: dict) -> str:
    payload = event.get("payload") or {}
    for key in ("text", "content", "message", "summary", "note"):
        if isinstance(payload.get(key), str):
            return payload[key].lower()
    return ""


def concise_summary(event: dict) -> str:
    kind = event.get("event_type") or "record"
    text = message_text(event)
    actor = (event.get("actor") or {}).get("type")
    if kind != "message":
        names = {
            "tool_call": "Runs a supporting local operation for the surrounding project task.",
            "tool_result": "Returns evidence from a supporting local project operation.",
            "artifact": "Preserves a local artifact produced during the project work.",
            "git": "Records a source-control change made during the project work.",
            "system": "Marks project-session context without adding a separate milestone.",
        }
        return names.get(kind, "Records supporting context for the surrounding project work.")
    rules = (
        (("pull", "github", "git", "commit", "push", " pr "), "Updates or verifies the project's source-control handoff."),
        (("zip", "contributor kit", "contributor-kit", "skill", "sop"), "Develops the clone-to-review contributor workflow and final package."),
        (("meeting", "transcript", "会议", "逐字稿"), "Organizes meeting evidence for the local project history."),
        (("checklist", "benchmark", "baseline", "评测", "算法"), "Refines the evaluation method for learned preferences and baselines."),
        (("sensitive", "privacy", "redact", "敏感", "脱敏"), "Improves privacy review and safe presentation of collected records."),
        (("viewer", "frontend", "inline", "前端", "页面"), "Improves the local review interface and timeline experience."),
        (("database", "sqlite", "d1", "数据库"), "Verifies or updates the local review data layer."),
        (("trajectory", "codex", "claude", "freeze", "冻结"), "Collects or validates local agent histories for project review."),
        (("test", "chromium", "qa", "验证", "测试"), "Validates the project workflow in an isolated browser environment."),
    )
    for words, summary in rules:
        if any(word in text for word in words):
            return summary
    return ("Requests the next concrete change in the project workflow."
            if actor == "human" else
            "Reports progress or results for the current project task.")


def main() -> None:
    configure_utf8_stdio()
    parser = argparse.ArgumentParser()
    parser.add_argument("run", type=Path)
    parser.add_argument("--primary-project", required=True)
    parser.add_argument("--summary", required=True)
    args = parser.parse_args()
    run = args.run.resolve()
    trajectories = sorted((run / "trajectories").glob("*/events.jsonl"))
    events: dict[str, dict] = {}
    count = 0
    for path in trajectories:
        trajectory_id = path.parent.name
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            event = json.loads(line)
            event_id = event.get("event_id")
            if not event_id:
                continue
            events[f"{trajectory_id}:{event_id}"] = {
                "project": args.primary_project,
                "confidence": 96 if event.get("event_type") == "message" else 82,
                "summary": concise_summary(event),
            }
            count += 1
    output = {
        "schema_version": "1",
        "primary_project": args.primary_project,
        "summary": args.summary,
        "projects": [{
            "name": args.primary_project,
            "event_count": count,
            "reason": "All collected sessions share sustained repository-scoped work and outputs.",
        }],
        "events": events,
    }
    destination = run / "project-map.json"
    destination.write_text(
        json.dumps(output, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"project_map": str(destination), "events": count}))


if __name__ == "__main__":
    main()
