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
import re
import shutil
import sys
import tempfile
import urllib.parse

TOOLS_ROOT = Path(__file__).resolve().parents[1]
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from oxygen_utf8 import configure_utf8_stdio
from ingest.human_source_projection import POLICY_ID, digest_events

ORGANIZER_SCRIPTS = (
    Path(__file__).resolve().parents[2]
    / "skills"
    / "oxygen-organize-review-export"
    / "scripts"
)
if str(ORGANIZER_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(ORGANIZER_SCRIPTS))

import build_project_map as project_map_authority


CONVERSATIONAL_TYPES = {
    "message", "user", "assistant", "agent", "reasoning", "progress",
    "status", "record", "speech",
}
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
INPUT_PATH_OUTSIDE_RUN = "INPUT_PATH_OUTSIDE_RUN"
INPUT_MEETING_INVALID = "INPUT_MEETING_INVALID"
INPUT_MEETING_ID_DUPLICATE = "INPUT_MEETING_ID_DUPLICATE"
INPUT_PROJECTION_INVALID = "INPUT_PROJECTION_INVALID"
INPUT_SEMANTIC_AUTHORITY_INVALID = "INPUT_SEMANTIC_AUTHORITY_INVALID"


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
    actor = event.get("actor") if isinstance(event.get("actor"), dict) else {}
    role = str(payload.get("role") or actor.get("type") or "").lower()
    if role in {"human", "speaker", "user"}:
        role = "user"
    elif role in {"ai", "assistant", "agent", "model"}:
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
        "sequence": index if sequence is None else sequence,
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
            timestamp=event.get("timestamp"),
            payload={"role": role, "text": text},
        )
        return base
    source_type = str(event.get("event_type") or "other").lower()
    action_type = ACTION_TYPES.get(source_type, "other")
    base["payload"] = {"action_type": action_type, "text": LABEL_TEXT[action_type]}
    return base


def validated_trajectory(events_path: Path) -> tuple[dict, list[dict], dict]:
    manifest_path = events_path.parent / "manifest.json"
    try:
        manifest = read_json(manifest_path)
        events = [
            json.loads(line)
            for line in events_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        projected_digest = digest_events(events)
    except (OSError, UnicodeError, ValueError):
        raise SystemExit(INPUT_PROJECTION_INVALID) from None
    if not isinstance(manifest, dict) or not all(isinstance(event, dict) for event in events):
        raise SystemExit(INPUT_PROJECTION_INVALID)
    projection = manifest.get("contribution_projection")
    manifest_count = manifest.get("event_count")
    counts = (
        projection.get("raw_event_count") if isinstance(projection, dict) else None,
        projection.get("normalized_event_count") if isinstance(projection, dict) else None,
        projection.get("kept_event_count") if isinstance(projection, dict) else None,
        projection.get("dropped_event_count") if isinstance(projection, dict) else None,
        projection.get("cross_trajectory_semantic_replay_count")
        if isinstance(projection, dict) else None,
    )
    if (
        not isinstance(projection, dict)
        or projection.get("policy_id") != POLICY_ID
        or not re.fullmatch(r"[0-9a-f]{64}", str(projection.get("raw_source_digest") or ""))
        or projection.get("projected_universe_digest") != projected_digest
        or not all(
            isinstance(value, int) and not isinstance(value, bool) and value >= 0
            for value in counts
        )
        or not isinstance(manifest_count, int) or isinstance(manifest_count, bool)
        or manifest_count != len(events)
        or counts[0] - counts[4] != counts[1]
        or counts[1] - counts[2] != counts[3]
        or counts[2] != len(events)
    ):
        raise SystemExit(INPUT_PROJECTION_INVALID)
    return manifest, events, projection


def prepare_trajectories(source: Path, output: Path) -> list[dict]:
    prepared: list[tuple[str, dict, list[dict], dict, int]] = []
    for events_path in sorted((source / "trajectories").glob("*/events.jsonl")):
        trajectory_id = events_path.parent.name
        source_manifest, source_events, source_projection = validated_trajectory(events_path)
        source_warnings = source_manifest.get("warnings")
        warning_count = len(source_warnings) if isinstance(source_warnings, list) else 0
        events = [
            normalize_event(event, trajectory_id, index)
            for index, event in enumerate(source_events, 1)
        ]
        dropped_count = source_projection["normalized_event_count"] - len(events)
        if (
            len(events) != source_projection["kept_event_count"]
            or dropped_count != source_projection["dropped_event_count"]
        ):
            raise SystemExit(INPUT_PROJECTION_INVALID)
        projection = {
            "policy_id": source_projection["policy_id"],
            "raw_source_digest": source_projection["raw_source_digest"],
            "projected_universe_digest": digest_events(events),
            "raw_event_count": source_projection["raw_event_count"],
            "normalized_event_count": source_projection["normalized_event_count"],
            "kept_event_count": len(events),
            "dropped_event_count": dropped_count,
            "cross_trajectory_semantic_replay_count": source_projection[
                "cross_trajectory_semantic_replay_count"
            ],
        }
        prepared.append((trajectory_id, source_manifest, events, projection, warning_count))

    entries: list[dict] = []
    for trajectory_id, source_manifest, events, projection, warning_count in prepared:
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
            "event_count": len(events),
            "contribution_projection": projection,
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


def _contained(candidate: Path, source: Path) -> Path:
    try:
        resolved = candidate.resolve(strict=True)
    except (OSError, RuntimeError):
        raise SystemExit(INPUT_MEETING_INVALID) from None
    if not resolved.is_relative_to(source.resolve(strict=True)):
        raise SystemExit(INPUT_PATH_OUTSIDE_RUN)
    return resolved


def _direct_physical_child(candidate: Path, parent: Path, source: Path) -> Path:
    resolved = _contained(candidate, source)
    if resolved != parent / candidate.name:
        raise SystemExit(INPUT_MEETING_INVALID)
    return resolved


def _meeting_id(value: object) -> str:
    if not isinstance(value, str) or not re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9._-]{0,254}", value
    ):
        raise SystemExit(INPUT_MEETING_INVALID)
    if urllib.parse.unquote(value) != value:
        raise SystemExit(INPUT_MEETING_INVALID)
    return value


def discover_meetings(source: Path) -> list[dict]:
    root_candidate = source / "meeting.json"
    if root_candidate.exists() or root_candidate.is_symlink():
        raise SystemExit(INPUT_MEETING_INVALID)

    meetings: list[tuple[Path, str]] = []
    plural_candidate = source / "meetings"
    if plural_candidate.exists() or plural_candidate.is_symlink():
        plural = _contained(plural_candidate, source)
        if plural != source.resolve(strict=True) / "meetings" or not plural.is_dir():
            raise SystemExit(INPUT_MEETING_INVALID)
        try:
            entries = sorted(plural_candidate.iterdir())
        except (OSError, RuntimeError):
            raise SystemExit(INPUT_MEETING_INVALID) from None
        for entry in entries:
            literal_meeting_id = entry.name
            directory = _direct_physical_child(entry, plural, source)
            if not directory.is_dir():
                raise SystemExit(INPUT_MEETING_INVALID)
            path = _direct_physical_child(entry / "meeting.json", directory, source)
            if not path.is_file():
                raise SystemExit(INPUT_MEETING_INVALID)
            meetings.append((path, literal_meeting_id))

    prepared = []
    seen_ids = set()
    for path, literal_meeting_id in meetings:
        try:
            meeting = read_json(path)
        except (OSError, UnicodeError, json.JSONDecodeError):
            raise SystemExit(INPUT_MEETING_INVALID) from None
        if not isinstance(meeting, dict) or not isinstance(meeting.get("records"), list):
            raise SystemExit(INPUT_MEETING_INVALID)
        if not all(isinstance(record, dict) for record in meeting["records"]):
            raise SystemExit(INPUT_MEETING_INVALID)
        source_meeting_id = _meeting_id(
            meeting.get("meeting_id")
            or meeting.get("id")
            or literal_meeting_id
        )
        if literal_meeting_id != source_meeting_id:
            raise SystemExit(INPUT_MEETING_INVALID)
        if source_meeting_id in seen_ids:
            raise SystemExit(INPUT_MEETING_ID_DUPLICATE)
        seen_ids.add(source_meeting_id)
        prepared.append({
            "dataset": meeting,
            "path": path,
            "source_meeting_id": source_meeting_id,
        })
    return prepared


def prepare_meeting(
    source: dict, output: Path, meeting_id: str
) -> tuple[dict[str, str], int]:
    meeting = source["dataset"]
    source_meeting_id = source["source_meeting_id"]
    source_warnings = meeting.get("warnings")
    warning_count = len(source_warnings) if isinstance(source_warnings, list) else 0
    records = []
    evidence_ids: dict[str, str] = {}
    source_records = meeting.get("records") or []
    source_record_ids = project_map_authority.meeting_contribution_ids(
        source_meeting_id, source_records,
    )
    for record, source_record_id in zip(source_records, source_record_ids):
        text = record.get("text") if isinstance(record, dict) else None
        if not isinstance(text, str) or not text.strip():
            continue
        record_number = len(records) + 1
        record_id = f"record-{record_number:06d}"
        evidence_ids[source_record_id] = f"{meeting_id}:{record_id}"
        records.append({
            "record_id": record_id,
            "order": record_number - 1,
            "speaker": "participant",
            "text": text,
        })
    destination = output / "meetings" / meeting_id
    write_json(destination / "meeting.json", {
        "schema_version": "ai-review.meeting/1",
        "meeting_id": meeting_id,
        "title": meeting_id,
        "source_warning_count": warning_count,
        "review_status": "pending",
        "publication_approved": False,
        "records": records,
    })
    return evidence_ids, warning_count


def prepare_meetings(meetings: list[dict], output: Path) -> tuple[dict[str, str], int]:
    evidence_ids: dict[str, str] = {}
    warning_count = 0
    for index, meeting in enumerate(meetings, 1):
        prepared_ids, prepared_warnings = prepare_meeting(
            meeting,
            output,
            f"meeting-{index:06d}",
        )
        evidence_ids.update(prepared_ids)
        warning_count += prepared_warnings
    return evidence_ids, warning_count


def validated_project_map(source: Path) -> tuple[dict, dict]:
    try:
        path = project_map_authority.contained_file(
            source / "project-map.json", source,
        )
        project_map = read_json(path)
        canonical = project_map_authority.validate_project_map_authority(
            source, project_map,
        )
    except (OSError, UnicodeError, ValueError, TypeError, json.JSONDecodeError):
        raise SystemExit(INPUT_SEMANTIC_AUTHORITY_INVALID) from None
    return project_map, canonical


def rebound_project_map(
    project_map: dict,
    canonical_source: dict,
    prepared_run: Path,
    changed_ids: dict[str, str],
) -> dict:
    try:
        source_manifest = canonical_source["semantic_manifest"]
        source_ids = sorted({
            member
            for unit in source_manifest["units"]
            for member in unit["members"]
        }, key=lambda value: value.encode("utf-8"))
        prepared_ids, _, _ = project_map_authority.source_inventory(prepared_run)
        identity_map = dict(changed_ids)
        for source_id in source_ids:
            identity_map.setdefault(source_id, source_id)
        if (
            set(identity_map) != set(source_ids)
            or len(set(identity_map.values())) != len(identity_map)
            or set(identity_map.values()) != set(prepared_ids)
        ):
            raise ValueError("prepared contribution identity mapping is not exact")

        raw_units = project_map["semantic_units"]
        remapped_units = [{
            **unit,
            "members": [identity_map[member] for member in unit["members"]],
        } for unit in raw_units]
        rebound = project_map_authority.canonical_project_map(
            prepared_run,
            project_map["primary_project"],
            project_map["summary"],
            remapped_units,
            source_manifest,
        )
        if "events" in project_map:
            events = project_map["events"]
            if not isinstance(events, dict):
                raise ValueError("project-map events authority is invalid")
            remapped_events: dict[str, object] = {}
            for source_id, value in events.items():
                prepared_id = identity_map[source_id]
                if prepared_id in remapped_events:
                    raise ValueError("project-map events authority is duplicated")
                remapped_events[prepared_id] = value
            rebound["events"] = {
                event_id: remapped_events[event_id]
                for event_id in sorted(
                    remapped_events, key=lambda value: value.encode("utf-8")
                )
            }
        project_map_authority.validate_project_map_authority(prepared_run, rebound)
        return rebound
    except (KeyError, TypeError, ValueError):
        raise SystemExit(INPUT_SEMANTIC_AUTHORITY_INVALID) from None


def prepare_run(source: Path, output: Path) -> tuple[list[dict], int]:
    meetings = discover_meetings(source)
    project_map, canonical_source = validated_project_map(source)
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(
        prefix=f".{output.name}.prepare-", dir=output.parent,
    ))
    try:
        trajectories = prepare_trajectories(source, staging)
        meeting_ids, meeting_warning_count = prepare_meetings(meetings, staging)
        if not trajectories and not meetings:
            raise SystemExit(f"no trajectories or meeting found in {source}")
        write_json(
            staging / "project-map.json",
            rebound_project_map(
                project_map, canonical_source, staging, meeting_ids,
            ),
        )
        write_json(staging / "index.json", {
            "schema_version": "0.2",
            "tool": "prepare_ai_review_run",
            "trajectory_count": len(trajectories),
            "meeting_count": len(meetings),
            "source_warning_count": (
                sum(entry["source_warning_count"] for entry in trajectories)
                + meeting_warning_count
            ),
            "review_status": "pending",
            "publication_approved": False,
            "trajectories": trajectories,
        })
        staging.replace(output)
        return trajectories, len(meetings)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def main() -> int:
    configure_utf8_stdio()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True, help="organized ingest run")
    parser.add_argument("--out", type=Path, required=True, help="new AI review run")
    args = parser.parse_args()
    source = args.run.expanduser().resolve()
    output = args.out.expanduser().resolve()
    if not source.is_dir():
        raise SystemExit(f"run not found: {source}")
    if output.exists() or output.is_symlink():
        raise SystemExit(f"output already exists: {output}")
    trajectories, meeting_count = prepare_run(source, output)
    print(json.dumps({
        "output": str(output),
        "trajectories": len(trajectories),
        "meetings": meeting_count,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
