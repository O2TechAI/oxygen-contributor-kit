#!/usr/bin/env python3
"""Build the local review run used by the AI redaction workflow.

Conversational text is preserved for the contributor-configured model and local
review. Every non-conversational event is reduced to a fixed action label before
the Viewer can import it, so commands, paths, tool output, artifacts, and source
metadata cannot accidentally enter the downloadable package.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil


CONVERSATIONAL_TYPES = {"message", "user", "assistant", "agent"}
ACTION_TYPES = {
    "system": "system",
    "tool_call": "tool_call",
    "tool_result": "tool_result",
    "artifact": "artifact",
    "git": "version_control",
    "version_control": "version_control",
    "agent": "agent_event",
    "assistant": "agent_event",
    "user": "user_event",
}
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
SAFE_SOURCE_SYSTEMS = {
    "codex",
    "claude-code",
    "claude-ai-export",
    "meeting-transcript",
    "local-agent-history",
}


def safe_source_system(value: object) -> str:
    source = str(value or "")
    return source if source in SAFE_SOURCE_SYSTEMS else "local-agent-history"


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def conversation(event: dict) -> tuple[str, str] | None:
    event_type = str(event.get("event_type") or "").lower()
    payload = event.get("payload") or {}
    if event_type not in CONVERSATIONAL_TYPES or not isinstance(payload, dict):
        return None
    role = str(payload.get("role") or (event.get("actor") or {}).get("type") or "").lower()
    if role in {"human", "user"}:
        role = "user"
    elif role in {"assistant", "agent", "model"}:
        role = "assistant"
    else:
        return None
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip():
        return None
    return role, text


def normalize_event(event: dict, trajectory_id: str, index: int) -> dict:
    event_id = str(event.get("event_id") or f"event-{index:06d}")
    sequence = event.get("sequence")
    base = {
        "schema_version": "ai-review.event/1",
        "event_id": event_id,
        "trajectory_id": trajectory_id,
        "turn_id": None,
        "sequence": int(index if sequence is None else sequence),
        "event_type": "action_label",
        "actor": {"type": "tool"},
        # The release policy permits only the fixed action kind for
        # non-conversational events; source timestamps are not part of it.
        "timestamp": None,
        "payload": {"action_type": "other", "text": LABEL_TEXT["other"]},
        "relations": [],
    }
    message = conversation(event)
    if message:
        role, text = message
        base.update(
            turn_id=str(event.get("turn_id") or f"turn-{index:06d}"),
            event_type="message",
            actor={"type": role},
            timestamp=event.get("timestamp") or event.get("started_at"),
            payload={"role": role, "text": text},
        )
        return base
    source_type = str(event.get("event_type") or "other").lower()
    action_type = ACTION_TYPES.get(source_type, "other")
    base["payload"] = {"action_type": action_type, "text": LABEL_TEXT[action_type]}
    return base


def prepare_trajectories(source: Path, output: Path) -> list[dict]:
    entries: list[dict] = []
    for events_path in sorted((source / "trajectories").glob("*/events.jsonl")):
        trajectory_id = events_path.parent.name
        manifest_path = events_path.parent / "manifest.json"
        source_manifest = read_json(manifest_path) if manifest_path.is_file() else {}
        source_warnings = source_manifest.get("warnings")
        warning_count = len(source_warnings) if isinstance(source_warnings, list) else 0
        events = []
        for index, line in enumerate(events_path.read_text(encoding="utf-8").splitlines(), 1):
            if line.strip():
                events.append(normalize_event(json.loads(line), trajectory_id, index))
        destination = output / "trajectories" / trajectory_id
        destination.mkdir(parents=True, exist_ok=True)
        (destination / "events.jsonl").write_text(
            "\n".join(json.dumps(event, ensure_ascii=False) for event in events) + "\n",
            encoding="utf-8",
        )
        write_json(destination / "manifest.json", {
            "schema_version": "0.2",
            "trajectory_id": trajectory_id,
            "title": trajectory_id,
            "source_system": safe_source_system(source_manifest.get("source_system")),
            "source_warning_count": warning_count,
            "review_status": "pending",
            "publication_approved": False,
        })
        entries.append({
            "trajectory_id": trajectory_id,
            "ok": True,
            "event_count": len(events),
            "source_warning_count": warning_count,
        })
    return entries


def prepare_meeting(source: Path, output: Path) -> tuple[bool, dict[str, str], int]:
    path = source / "meeting.json"
    if not path.is_file():
        return False, {}, 0
    meeting = read_json(path)
    source_meeting_id = str(meeting.get("meeting_id") or meeting.get("id") or "meeting")
    meeting_id = "meeting-000001"
    source_warnings = meeting.get("warnings")
    warning_count = len(source_warnings) if isinstance(source_warnings, list) else 0
    records = []
    evidence_ids: dict[str, str] = {}
    for index, record in enumerate(meeting.get("records") or [], 1):
        text = record.get("text") if isinstance(record, dict) else None
        if not isinstance(text, str) or not text.strip():
            continue
        record_number = len(records) + 1
        source_record_id = str(record.get("record_id") or f"record-{index:06d}")
        record_id = f"record-{record_number:06d}"
        evidence_ids[source_record_id] = record_id
        evidence_ids[f"{source_meeting_id}:{source_record_id}"] = (
            f"{meeting_id}:{record_id}"
        )
        records.append({
            "record_id": record_id,
            "order": record_number - 1,
            "speaker": "participant",
            "text": text,
        })
    write_json(output / "meeting.json", {
        "schema_version": "ai-review.meeting/1",
        "meeting_id": meeting_id,
        "title": meeting_id,
        "source_warning_count": warning_count,
        "review_status": "pending",
        "publication_approved": False,
        "records": records,
    })
    return True, evidence_ids, warning_count


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True, help="organized ingest run")
    parser.add_argument("--out", type=Path, required=True, help="new AI review run")
    args = parser.parse_args()
    source = args.run.expanduser().resolve()
    output = args.out.expanduser().resolve()
    if not source.is_dir():
        raise SystemExit(f"run not found: {source}")
    if output.exists():
        raise SystemExit(f"output already exists: {output}")
    output.mkdir(parents=True)

    trajectories = prepare_trajectories(source, output)
    meeting, meeting_evidence_ids, meeting_warning_count = prepare_meeting(source, output)
    if not trajectories and not meeting:
        shutil.rmtree(output)
        raise SystemExit(f"no trajectories or meeting found in {source}")
    project_map = source / "project-map.json"
    if project_map.is_file():
        project_map_data = read_json(project_map)
        if meeting_evidence_ids and isinstance(project_map_data.get("events"), dict):
            project_map_data["events"] = {
                meeting_evidence_ids.get(str(event_id), str(event_id)): label
                for event_id, label in project_map_data["events"].items()
            }
        write_json(output / "project-map.json", project_map_data)
    write_json(output / "index.json", {
        "schema_version": "0.2",
        "tool": "prepare_ai_review_run",
        "trajectory_count": len(trajectories),
        "meeting_count": int(meeting),
        "source_warning_count": (
            sum(entry["source_warning_count"] for entry in trajectories)
            + meeting_warning_count
        ),
        "review_status": "pending",
        "publication_approved": False,
        "trajectories": trajectories,
    })
    print(json.dumps({
        "output": str(output),
        "trajectories": len(trajectories),
        "meeting": meeting,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
