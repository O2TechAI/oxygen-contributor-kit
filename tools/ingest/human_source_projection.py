#!/usr/bin/env python3
"""Project extracted Oxygen events into the human-semantic contribution universe.

The original session file remains the reproducibility authority. This module runs
after an extractor has produced structured v0.2 events and before the run is made
available to Organization. It retains recorded natural-language cognition,
coordination, decisions, and meaningful progress while removing execution
mechanics. It persists aggregate counts and digests, never dropped bodies or a
per-event negative ledger.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
from collections import Counter, defaultdict
from pathlib import Path
import re
import struct
from typing import Any


POLICY_ID = "oxygen-human-semantic-source-boundary-2026-08-26"

KEEP_HUMAN_DIALOGUE = "KEEP_HUMAN_DIALOGUE"
KEEP_HUMAN_FEEDBACK = "KEEP_HUMAN_FEEDBACK"
KEEP_AGENT_DIALOGUE = "KEEP_AGENT_DIALOGUE"
KEEP_RECORDED_REASONING = "KEEP_RECORDED_REASONING"
KEEP_AGENT_COORDINATION = "KEEP_AGENT_COORDINATION"
KEEP_MEANINGFUL_PROGRESS = "KEEP_MEANINGFUL_PROGRESS"
KEEP_HUMAN_SOURCE = "KEEP_HUMAN_SOURCE"

DROP_TOOL_CALL = "DROP_TOOL_CALL"
DROP_TOOL_RESULT = "DROP_TOOL_RESULT"
DROP_EXECUTION_OBSERVATION = "DROP_EXECUTION_OBSERVATION"
DROP_SYSTEM_MACHINERY = "DROP_SYSTEM_MACHINERY"
DROP_AGENT_PLUMBING = "DROP_AGENT_PLUMBING"
DROP_GENERIC_EXECUTION_MARKER = "DROP_GENERIC_EXECUTION_MARKER"
DROP_MACHINE_ARTIFACT = "DROP_MACHINE_ARTIFACT"
DROP_AMBIGUOUS = "DROP_AMBIGUOUS"

KEEP_DISPOSITIONS = {
    KEEP_HUMAN_DIALOGUE,
    KEEP_HUMAN_FEEDBACK,
    KEEP_AGENT_DIALOGUE,
    KEEP_RECORDED_REASONING,
    KEEP_AGENT_COORDINATION,
    KEEP_MEANINGFUL_PROGRESS,
    KEEP_HUMAN_SOURCE,
}
HUMAN_SOURCE_ARTIFACT_KINDS = {"attachment", "image"}
HUMAN_FEEDBACK_KINDS = {"correction", "feedback", "preference", "review"}
AGENT_COORDINATION_DIRECTIONS = {
    "agent_to_agent",
    "agent_to_subagent",
    "subagent_to_agent",
}
GENERIC_EXECUTION_MARKERS = {
    "loaded a tool, ran commands",
    "read files, ran commands",
    "ran commands",
}
SEMANTIC_SOURCE_RECORD_TYPES = {
    "agent_message_event",
    "agent_plan",
    "agent_reasoning",
    "agent_message",
    "coordination_prompt:followup_task",
    "coordination_prompt:send_message",
    "coordination_prompt:spawn_agent",
    "coordination_prompt:agent",
    "coordination_prompt:task",
    "human_tool_response",
    "human_question",
    "message",
    "reasoning_summary",
    "subagent_finding",
    "thinking",
    "task_complete_agent_message",
    "user_message",
}
MAX_SAFE_JSON_INTEGER = 9_007_199_254_740_991
LINE_RECORD_ID = re.compile(r"line-\d+(?::\d+)?")
PROJECTED_EVENT_ID = re.compile(r"evt-[0-9a-f]{64}")
SOURCE_COMPONENT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,254}")


def canonical_json(value: Any) -> str:
    if value is None or isinstance(value, (bool, int, float, str)):
        return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            raise ValueError("canonical JSON keys must be strings")
        keys = sorted(value, key=lambda key: key.encode("utf-8"))
        return "{" + ",".join(
            json.dumps(key, ensure_ascii=False) + ":" + canonical_json(value[key])
            for key in keys
        ) + "}"
    raise ValueError("value is not JSON-compatible")


def digest_value(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _digest_normal_form(value: Any) -> Any:
    """Encode JSON values without relying on provider-specific number spelling."""
    if value is None:
        return ["null"]
    if isinstance(value, bool):
        return ["boolean", value]
    if isinstance(value, int):
        if abs(value) > MAX_SAFE_JSON_INTEGER:
            raise ValueError("contribution contains an unsafe JSON integer")
        return ["number", f"i:{value}"]
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("contribution contains a non-finite JSON number")
        if value.is_integer():
            if abs(value) > MAX_SAFE_JSON_INTEGER:
                raise ValueError("contribution contains an unsafe JSON integer")
            return ["number", f"i:{int(value)}"]
        return ["number", f"f:{struct.pack('>d', value).hex()}"]
    if isinstance(value, str):
        return ["string", value]
    if isinstance(value, list):
        return ["array", [_digest_normal_form(item) for item in value]]
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            raise ValueError("contribution JSON keys must be strings")
        return ["object", [
            [key, _digest_normal_form(value[key])]
            for key in sorted(value, key=lambda key: key.encode("utf-8"))
        ]]
    raise ValueError("contribution is not JSON-compatible")


def _stable_record_id(value: Any) -> str | None:
    return value if isinstance(value, str) and value and not LINE_RECORD_ID.fullmatch(value) else None


def contribution_authority(value: Any) -> Any:
    """Remove extractor mechanics from one projected event's content authority."""
    if not isinstance(value, dict) or not {
        "event_id", "event_type", "payload", "source",
    }.issubset(value):
        return value
    source = value.get("source") if isinstance(value.get("source"), dict) else {}
    authority_source = {
        key: source[key] for key in (
            "system", "session_id", "record_type", "origin", "interaction_direction",
        ) if key in source
    }
    record_id = _stable_record_id(source.get("record_id"))
    if record_id:
        authority_source["record_id"] = record_id
    payload = copy.deepcopy(value.get("payload"))
    if value.get("event_type") == "artifact" and isinstance(payload, dict):
        # Artifact storage names and paths come from a process-wide staging
        # counter. They remain in the projected event for local retrieval, but
        # are not semantic content authority: a preceding dropped tool artifact
        # must not invalidate an otherwise unchanged human attachment.
        payload = {
            key: copy.deepcopy(payload[key]) for key in (
                "kind", "original_name", "media_type", "size_bytes", "sha256",
                "created_by_event",
            ) if key in payload
        }
    authority = {
        key: copy.deepcopy(value[key]) for key in (
            "schema_version", "event_id", "trajectory_id", "event_type", "timestamp",
            "started_at", "turn_id", "actor", "relations",
        ) if key in value
    } | {"source": authority_source}
    authority["payload"] = payload
    return authority


def contribution_digest_value(value: Any) -> str:
    authority = contribution_authority(value)
    return hashlib.sha256(canonical_json(_digest_normal_form(authority)).encode("utf-8")).hexdigest()


IMPORTED_CONTRIBUTION_FIELDS = (
    "id", "documentId", "sequence", "eventType", "actorId", "actorType",
    "timestamp", "content",
)


def imported_contribution_authority(original: Any, imported: dict[str, Any]) -> dict[str, Any]:
    """Bind semantic membership to the exact normalized Evidence row.

    ``original_json`` alone is insufficient authority because Story reads the
    normalized actor, time, and content columns. The manifest digest therefore
    covers both the semantic original and every imported field Story consumes.
    """
    if not isinstance(imported, dict) or set(imported) != set(IMPORTED_CONTRIBUTION_FIELDS):
        raise ValueError("imported contribution authority is invalid")
    if (
        not isinstance(imported["id"], str) or not imported["id"]
        or not isinstance(imported["documentId"], str) or not imported["documentId"]
        or not isinstance(imported["sequence"], int)
        or isinstance(imported["sequence"], bool)
        or not isinstance(imported["content"], str)
    ):
        raise ValueError("imported contribution authority is invalid")
    for key in ("eventType", "actorId", "actorType", "timestamp"):
        if imported[key] is not None and not isinstance(imported[key], str):
            raise ValueError("imported contribution authority is invalid")
    return {
        "original": contribution_authority(original),
        "imported": {key: copy.deepcopy(imported[key]) for key in IMPORTED_CONTRIBUTION_FIELDS},
    }


def imported_contribution_digest_value(original: Any, imported: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json(
        _digest_normal_form(imported_contribution_authority(original, imported))
    ).encode("utf-8")).hexdigest()


def _artifact_bytes(event: dict[str, Any], trajectory_dir: Path) -> bytes:
    payload = event.get("payload")
    if not isinstance(payload, dict) or not isinstance(payload.get("path"), str):
        raise ValueError("artifact contribution lacks a local path")
    relative = Path(payload["path"])
    if relative.is_absolute() or ".." in relative.parts or not relative.parts \
            or relative.parts[0] != "artifacts":
        raise ValueError("artifact contribution path leaves the derived trajectory")
    root = trajectory_dir.resolve(strict=True)
    candidate = trajectory_dir / relative
    if candidate.is_symlink():
        raise ValueError("artifact contribution path is a symlink")
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as error:
        raise ValueError("artifact contribution source is unavailable") from error
    if not resolved.is_relative_to(root) or not resolved.is_file():
        raise ValueError("artifact contribution path leaves the derived trajectory")
    data = resolved.read_bytes()
    expected_size = payload.get("size_bytes")
    expected_digest = payload.get("sha256")
    if not isinstance(expected_size, int) or isinstance(expected_size, bool) \
            or expected_size != len(data):
        raise ValueError("artifact contribution size does not match provenance")
    if not isinstance(expected_digest, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_digest) \
            or hashlib.sha256(data).hexdigest() != expected_digest:
        raise ValueError("artifact contribution digest does not match provenance")
    return data


def projected_event_content(event: dict[str, Any], trajectory_dir: Path) -> str:
    """Reproduce the exact local Evidence content imported into the Viewer."""
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    if event.get("event_type") == "artifact":
        data = _artifact_bytes(event, trajectory_dir)
        if b"\0" not in data:
            try:
                return data.decode("utf-8")
            except UnicodeDecodeError as error:
                raise ValueError("artifact contribution is not valid UTF-8 text") from error
    for key in ("text", "content", "stdout", "stderr", "message", "summary", "note"):
        if isinstance(payload.get(key), str) and payload[key]:
            return payload[key]
    return json.dumps(payload, ensure_ascii=False, indent=2)


def projected_contribution_id(event: Any) -> str:
    event_id = event.get("event_id") if isinstance(event, dict) else None
    if not isinstance(event_id, str) or not PROJECTED_EVENT_ID.fullmatch(event_id):
        raise ValueError("projected contribution identity is invalid")
    return event_id


def meeting_contribution_ids(meeting_id: str, records: list[Any]) -> list[str]:
    if not SOURCE_COMPONENT.fullmatch(meeting_id):
        raise ValueError("meeting source identity is invalid")
    fallback_occurrences: Counter[str] = Counter()
    identities: list[str] = []
    seen: set[str] = set()
    for record in records:
        if not isinstance(record, dict):
            raise ValueError("meeting record is invalid")
        record_id = record.get("record_id")
        if not isinstance(record_id, str) or not SOURCE_COMPONENT.fullmatch(record_id):
            fingerprint = contribution_digest_value(record)
            fallback_occurrences[fingerprint] += 1
            record_id = "rec-" + contribution_digest_value({
                "semanticFingerprint": fingerprint,
                "occurrence": fallback_occurrences[fingerprint],
            })
        identity = f"{meeting_id}:{record_id}"
        if identity in seen:
            raise ValueError("meeting contribution identity is duplicated")
        seen.add(identity)
        identities.append(identity)
    return identities


def digest_events(events: list[dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    for event in events:
        digest.update(canonical_json(event).encode("utf-8"))
        digest.update(b"\n")
    return digest.hexdigest()


def serialized_event_bytes(events: list[dict[str, Any]]) -> int:
    return sum(len((canonical_json(event) + "\n").encode("utf-8")) for event in events)


def _actor_type(event: dict[str, Any]) -> str:
    actor = event.get("actor")
    return str(actor.get("type") or "").lower() if isinstance(actor, dict) else ""


def _source_field(event: dict[str, Any], key: str) -> str:
    source = event.get("source")
    return str(source.get(key) or "").lower() if isinstance(source, dict) else ""


def _semantic_text(event: dict[str, Any]) -> str:
    payload = event.get("payload")
    if not isinstance(payload, dict):
        return ""
    text = payload.get("text")
    return text.strip() if isinstance(text, str) else ""


def is_generic_execution_marker(text: str) -> bool:
    normalized = " ".join(text.casefold().split()).rstrip(".! ")
    return normalized in GENERIC_EXECUTION_MARKERS


def classify_event(
    event: dict[str, Any],
    *,
    kept_event_ids: set[str] | None = None,
) -> str:
    """Return one explicit disposition using extractor-owned structured fields."""
    event_type = str(event.get("event_type") or "").lower()
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    actor_type = _actor_type(event)
    record_type = _source_field(event, "record_type")
    direction = str(
        payload.get("interaction_direction")
        or _source_field(event, "interaction_direction")
    ).lower()
    text = _semantic_text(event)

    if event_type == "tool_call":
        return DROP_TOOL_CALL
    if event_type == "tool_result":
        return DROP_TOOL_RESULT
    if event_type == "git":
        return DROP_EXECUTION_OBSERVATION
    if event_type == "agent" or record_type == "sub_agent_activity":
        if not text:
            return DROP_AGENT_PLUMBING
        if is_generic_execution_marker(text):
            return DROP_GENERIC_EXECUTION_MARKER
        return (
            KEEP_AGENT_COORDINATION
            if direction in AGENT_COORDINATION_DIRECTIONS
            else KEEP_MEANINGFUL_PROGRESS
        )
    if event_type == "system":
        return DROP_SYSTEM_MACHINERY

    if event_type == "artifact":
        creator = payload.get("created_by_event")
        kind = str(payload.get("kind") or "").lower()
        if (
            kind in HUMAN_SOURCE_ARTIFACT_KINDS
            and isinstance(creator, str)
            and creator in (kept_event_ids or set())
        ):
            return KEEP_HUMAN_SOURCE
        return DROP_MACHINE_ARTIFACT

    has_attachment = payload.get("has_attachments") is True or bool(payload.get("attachments"))

    if not text and not (event_type in {"message", "record", "speech"} and has_attachment):
        return DROP_AMBIGUOUS
    if text and is_generic_execution_marker(text) and actor_type not in {
        "human", "speaker", "user",
    }:
        return DROP_GENERIC_EXECUTION_MARKER

    if event_type == "reasoning" and record_type in {
        "agent_plan",
        "agent_reasoning",
        "reasoning_summary",
        "thinking",
    }:
        return KEEP_RECORDED_REASONING

    if event_type in {"progress", "status"}:
        return KEEP_MEANINGFUL_PROGRESS

    if event_type in {"message", "record", "speech"}:
        interaction_kind = str(payload.get("interaction_kind") or "").lower()
        role = str(payload.get("role") or "").lower()
        if actor_type in {"human", "speaker", "user"}:
            if interaction_kind in HUMAN_FEEDBACK_KINDS:
                return KEEP_HUMAN_FEEDBACK
            return KEEP_HUMAN_DIALOGUE
        if direction in AGENT_COORDINATION_DIRECTIONS or record_type == "agent_message":
            return KEEP_AGENT_COORDINATION
        if actor_type in {"ai", "assistant", "agent"} and role in {"", "assistant"}:
            return KEEP_AGENT_DIALOGUE
        return DROP_AMBIGUOUS

    return DROP_AMBIGUOUS


def _validate_event_ids(events: list[dict[str, Any]]) -> None:
    seen: set[str] = set()
    for event in events:
        event_id = event.get("event_id")
        if not isinstance(event_id, str) or not event_id:
            raise ValueError("projection requires every event to have a nonempty event_id")
        if event_id in seen:
            raise ValueError(f"projection received duplicate event_id: {event_id}")
        seen.add(event_id)


def _projected_source(source: Any) -> dict[str, Any]:
    if not isinstance(source, dict):
        return {}
    projected = {
        key: copy.deepcopy(source[key]) for key in (
            "system", "session_id", "record_type", "origin", "interaction_direction",
        ) if key in source
    }
    record_id = _stable_record_id(source.get("record_id"))
    if record_id:
        projected["record_id"] = record_id
    return projected


def stabilize_projected_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Replace extractor ordinals with one mechanic-independent contribution identity."""
    raw_to_projected: dict[str, str] = {}
    projected_ids: set[str] = set()
    fallback_occurrences: Counter[str] = Counter()
    for event in events:
        source = event.get("source") if isinstance(event.get("source"), dict) else {}
        stable_record_id = _stable_record_id(source.get("record_id"))
        provenance = {
            key: source[key] for key in ("system", "session_id", "origin", "record_type")
            if key in source
        }
        if stable_record_id:
            seed = {"provenance": provenance, "recordId": stable_record_id}
            occurrence = 1
        else:
            semantic_seed = {
                "provenance": provenance,
                "eventType": event.get("event_type"),
                **({"timestamp": event["timestamp"]} if "timestamp" in event else {}),
                **({"startedAt": event["started_at"]} if "started_at" in event else {}),
                **({"turnId": event["turn_id"]} if "turn_id" in event else {}),
                "actor": event.get("actor"),
                "payload": event.get("payload"),
            }
            fingerprint = contribution_digest_value(semantic_seed)
            fallback_occurrences[fingerprint] += 1
            occurrence = fallback_occurrences[fingerprint]
            seed = {
                "semanticFingerprint": fingerprint,
                "occurrence": occurrence,
            }
        projected_id = f"evt-{contribution_digest_value(seed)}"
        if projected_id in projected_ids:
            if stable_record_id:
                raise ValueError(f"duplicate stable semantic source identity: {stable_record_id}")
            raise ValueError("projected contribution identity collision")
        projected_ids.add(projected_id)
        raw_to_projected[str(event["event_id"])] = projected_id

    projected_events: list[dict[str, Any]] = []
    for sequence, event in enumerate(events, 1):
        projected = copy.deepcopy(event)
        projected["event_id"] = raw_to_projected[str(event["event_id"])]
        projected["sequence"] = sequence
        projected["source"] = _projected_source(event.get("source"))
        payload = projected.get("payload")
        if isinstance(payload, dict) and isinstance(payload.get("created_by_event"), str):
            creator = raw_to_projected.get(payload["created_by_event"])
            if creator:
                payload["created_by_event"] = creator
            else:
                payload.pop("created_by_event", None)
        relations = projected.get("relations")
        if isinstance(relations, list):
            projected["relations"] = [
                {**relation, "event_id": raw_to_projected[relation["event_id"]]}
                for relation in relations
                if isinstance(relation, dict)
                and isinstance(relation.get("event_id"), str)
                and relation["event_id"] in raw_to_projected
            ]
        projected_events.append(projected)
    return projected_events


def deduplicate_semantic_source_records(
    events: list[dict[str, Any]],
    registry: dict[tuple[str, str, str, str, str], str],
) -> tuple[list[dict[str, Any]], int]:
    """Collapse exact source-record replays across trajectory files."""
    kept: list[dict[str, Any]] = []
    duplicate_count = 0
    for event in events:
        source = event.get("source")
        if not isinstance(source, dict):
            kept.append(event)
            continue
        if str(event.get("event_type") or "") not in {"message", "reasoning"}:
            kept.append(event)
            continue
        record_type = str(source.get("record_type") or "")
        record_id = source.get("record_id")
        if (
            record_type not in SEMANTIC_SOURCE_RECORD_TYPES
            or not isinstance(record_id, str)
            or not record_id
            or record_id.startswith("line-")
        ):
            kept.append(event)
            continue
        key = (
            str(source.get("system") or ""),
            str(source.get("session_id") or ""),
            str(source.get("origin") or ""),
            record_type,
            record_id,
        )
        raw_semantic_fingerprint = source.get("_semantic_sha256")
        fingerprint = (
            raw_semantic_fingerprint
            if isinstance(raw_semantic_fingerprint, str)
            and re.fullmatch(r"[0-9a-f]{64}", raw_semantic_fingerprint)
            else hashlib.sha256(canonical_json({
                "event_type": event.get("event_type"),
                "actor": event.get("actor"),
                "payload": event.get("payload"),
            }).encode("utf-8")).hexdigest()
        )
        previous = registry.get(key)
        if previous is None:
            registry[key] = fingerprint
            kept.append(event)
            continue
        if previous != fingerprint:
            raise ValueError(
                f"conflicting semantic source replay for {record_type} record {record_id}"
            )
        duplicate_count += 1
    return kept, duplicate_count


def project_events(
    events: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Return kept events and bounded structural provenance for one trajectory."""
    _validate_event_ids(events)
    dispositions: dict[str, str] = {}
    kept_ids: set[str] = set()
    for event in events:
        if str(event.get("event_type") or "").lower() == "artifact":
            continue
        disposition = classify_event(event)
        event_id = str(event["event_id"])
        dispositions[event_id] = disposition
        if disposition in KEEP_DISPOSITIONS:
            kept_ids.add(event_id)
    for event in events:
        if str(event.get("event_type") or "").lower() != "artifact":
            continue
        event_id = str(event["event_id"])
        disposition = classify_event(event, kept_event_ids=kept_ids)
        dispositions[event_id] = disposition
        if disposition in KEEP_DISPOSITIONS:
            kept_ids.add(event_id)

    kept = stabilize_projected_events([
        event for event in events if str(event["event_id"]) in kept_ids
    ])
    family_counts: dict[str, Counter[str]] = defaultdict(Counter)
    disposition_counts: Counter[str] = Counter()
    for event in events:
        family = str(event.get("event_type") or "unknown")
        disposition = dispositions[str(event["event_id"])]
        disposition_counts[disposition] += 1
        family_counts[family]["raw"] += 1
        family_counts[family]["kept" if disposition in KEEP_DISPOSITIONS else "dropped"] += 1

    raw_artifacts = family_counts["artifact"]["raw"]
    kept_artifacts = family_counts["artifact"]["kept"]
    raw_bytes = serialized_event_bytes(events)
    projected_bytes = serialized_event_bytes(kept)
    summary = {
        "policy_id": POLICY_ID,
        "raw_universe_digest": digest_events(events),
        "projected_universe_digest": digest_events(kept),
        "raw_event_count": len(events),
        "kept_event_count": len(kept),
        "dropped_event_count": len(events) - len(kept),
        "kept_by_reason": dict(sorted(
            (reason, count) for reason, count in disposition_counts.items()
            if reason in KEEP_DISPOSITIONS
        )),
        "dropped_by_reason": dict(sorted(
            (reason, count) for reason, count in disposition_counts.items()
            if reason not in KEEP_DISPOSITIONS
        )),
        "by_event_family": {
            family: {
                "raw": counts["raw"],
                "kept": counts["kept"],
                "dropped": counts["dropped"],
            }
            for family, counts in sorted(family_counts.items())
        },
        "raw_artifact_count": raw_artifacts,
        "kept_human_source_artifact_count": kept_artifacts,
        "dropped_machine_artifact_count": raw_artifacts - kept_artifacts,
        "raw_serialized_bytes": raw_bytes,
        "projected_serialized_bytes": projected_bytes,
        "serialized_byte_reduction": raw_bytes - projected_bytes,
    }
    return kept, summary


def project_trajectory(
    trajectory_dir: Path,
    *,
    raw_source_digest: str,
    semantic_source_registry: dict[tuple[str, str, str, str, str], str] | None = None,
) -> dict[str, Any]:
    """Apply the projection in place to one newly extracted trajectory directory."""
    trajectory_dir = trajectory_dir.resolve(strict=True)
    events_path = trajectory_dir / "events.jsonl"
    manifest_path = trajectory_dir / "manifest.json"
    events = [json.loads(line) for line in events_path.read_text(encoding="utf-8").splitlines() if line]
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    normalized_events, cross_trajectory_replays = deduplicate_semantic_source_records(
        events,
        semantic_source_registry if semantic_source_registry is not None else {},
    )
    kept, summary = project_events(normalized_events)
    summary["raw_source_digest"] = raw_source_digest
    source_normalization = manifest.get("source_normalization")
    extractor_replays = (
        int(source_normalization.get("duplicate_semantic_replay_count", 0))
        if isinstance(source_normalization, dict) else 0
    )
    normalized_family_counts = summary["by_event_family"]
    extracted_family_counts = Counter(
        str(event.get("event_type") or "unknown") for event in events
    )
    replay_family_counts = Counter(
        str(event.get("event_type") or "unknown") for event in events
    )
    replay_family_counts.subtract(
        str(event.get("event_type") or "unknown") for event in normalized_events
    )
    summary["by_event_family"] = {
        family: {
            "raw": extracted_family_counts[family],
            "normalized": int(normalized_family_counts.get(family, {}).get("raw", 0)),
            "kept": int(normalized_family_counts.get(family, {}).get("kept", 0)),
            "dropped": int(normalized_family_counts.get(family, {}).get("dropped", 0)),
            "source_replays": replay_family_counts[family],
        }
        for family in sorted(extracted_family_counts)
    }
    normalized_bytes = summary["raw_serialized_bytes"]
    extracted_bytes = serialized_event_bytes(events)
    summary.update({
        "raw_universe_digest": digest_events(events),
        "normalized_universe_digest": digest_events(normalized_events),
        "raw_event_count": len(events),
        "extracted_event_count": len(events),
        "normalized_event_count": len(normalized_events),
        "dropped_event_count": len(normalized_events) - len(kept),
        "mechanical_drop_count": len(normalized_events) - len(kept),
        "projection_removed_event_count": len(events) - len(kept),
        "cross_trajectory_semantic_replay_count": cross_trajectory_replays,
        "extractor_semantic_replay_count": extractor_replays,
        "source_duplicate_semantic_replay_count": cross_trajectory_replays + extractor_replays,
        "raw_serialized_bytes": extracted_bytes,
        "normalized_serialized_bytes": normalized_bytes,
        "mechanical_serialized_byte_reduction": normalized_bytes
            - summary["projected_serialized_bytes"],
        "serialized_byte_reduction": extracted_bytes - summary["projected_serialized_bytes"],
    })

    kept_artifact_events = [event for event in kept if event.get("event_type") == "artifact"]
    kept_artifact_paths = [
        str((event.get("payload") or {}).get("path")) for event in kept_artifact_events
    ]
    if len(set(kept_artifact_paths)) != len(kept_artifact_paths):
        raise ValueError("projected artifacts reuse a local source path")
    for event in kept_artifact_events:
        _artifact_bytes(event, trajectory_dir)
    kept_artifact_path_set = set(kept_artifact_paths)
    artifacts_root = trajectory_dir / "artifacts"
    if artifacts_root.is_dir():
        artifacts = list(artifacts_root.rglob("*"))
        if any(artifact.is_symlink() for artifact in artifacts):
            raise ValueError("derived artifact tree contains a symlink")
        for artifact in artifacts:
            if not artifact.is_file():
                continue
            relative = artifact.relative_to(trajectory_dir).as_posix()
            if relative not in kept_artifact_path_set:
                artifact.unlink()
        remaining = {
            artifact.relative_to(trajectory_dir).as_posix()
            for artifact in artifacts_root.rglob("*") if artifact.is_file()
        }
        if remaining != kept_artifact_path_set:
            raise ValueError("projected artifact manifest does not match local files")
    elif kept_artifact_paths:
        raise ValueError("projected artifact source tree is unavailable")

    events_path.write_text(
        "".join(canonical_json(event) + "\n" for event in kept),
        encoding="utf-8",
    )
    manifest["raw_event_count"] = len(events)
    manifest["event_count"] = len(kept)
    manifest["raw_artifact_count"] = summary["raw_artifact_count"]
    manifest["artifact_count"] = summary["kept_human_source_artifact_count"]
    manifest["contribution_projection"] = summary
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("trajectory_dir", type=Path)
    parser.add_argument("--raw-source-digest", required=True)
    args = parser.parse_args()
    print(json.dumps(
        project_trajectory(args.trajectory_dir, raw_source_digest=args.raw_source_digest),
        ensure_ascii=False,
        indent=2,
    ))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
