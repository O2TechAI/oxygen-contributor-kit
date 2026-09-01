#!/usr/bin/env python3
"""Create the current skeleton and provide canonical Organization finalization authority.

The public transport prepares and composes semantic worker outputs in separate
provider-free scripts. This module remains the one deterministic digest,
membership, duplicate-topology, and revision authority used for installation.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from typing import Any

TOOLS_ROOT = Path(__file__).resolve().parents[3] / "tools"
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from ingest.human_source_projection import (
    AI_REVIEW_EVENT_SCHEMA,
    AI_REVIEW_MEETING_SCHEMA,
    AI_REVIEW_RUN_SCHEMA,
    AI_REVIEW_TRAJECTORY_SCHEMA,
    INGEST_RUN_SCHEMA,
    MEETING_SCHEMA,
    POLICY_ID,
    TRAJECTORY_EVENT_SCHEMA,
    TRAJECTORY_SCHEMA,
    canonical_json,
    digest_value,
    imported_contribution_digest_value,
    meeting_contribution_ids,
    projected_event_content,
    projected_contribution_id,
)
from oxygen_utf8 import configure_utf8_stdio


MAX_SEMANTIC_UNITS = 512
MAX_SEMANTIC_MANIFEST_BYTES = 2_200_000
MAX_STORY_SEMANTIC_PROJECTION_BYTES = 325_000
MAX_PROJECT_MAP_SUMMARY_BYTES = MAX_STORY_SEMANTIC_PROJECTION_BYTES
# The map carries semantic membership twice (proposal plus finalized authority).
# A third manifest budget bounds JSON framing and the remaining project metadata.
MAX_PROJECT_MAP_BYTES = 3 * MAX_SEMANTIC_MANIFEST_BYTES
SEMANTIC_WORKER_KIND_INVALID = "SEMANTIC_WORKER_KIND_INVALID"
PROJECT_MEMBERSHIP_NEEDS_USER_RESOLUTION = "PROJECT_MEMBERSHIP_NEEDS_USER_RESOLUTION"
CWD_RELATIONS = {"exact", "child", "parent", "sibling", "unrelated", "missing_unparseable"}
CURRENT_CWD_RELATIONS = {"exact", "child"}
FOREIGN_CWD_RELATIONS = {"sibling", "unrelated"}
SEMANTIC_UNIT_KIND_PATTERN = re.compile(r"[a-z][a-z0-9_]{0,63}")
SOURCE_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,254}")
CURRENT_PROJECT_MAP_KEYS = {
    "schema", "primary_project", "summary", "projects",
    "source_authority", "semantic_units", "semantic_manifest",
}
PROJECT_MAP_SCHEMA = "oxygen.project-map"
RECOLLECT_GUIDANCE = (
    "current canonical contribution projections are required; re-collect this run "
    "through tools/ingest/collect_repo_trajectories.py"
)


def digest(value: Any) -> str:
    return digest_value(value)


def valid_digest(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(
        character in "0123456789abcdef" for character in value
    )


def read_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"expected a JSON object: {path}")
    return value


def _is_reparse_point(path: Path) -> bool:
    attributes = getattr(path.stat(follow_symlinks=False), "st_file_attributes", None)
    if os.name == "nt" and attributes is None:
        raise ValueError(f"cannot prove reparse-point safety: {path}")
    if attributes is None:
        return False
    return bool(attributes & 0x400)


def assert_literal_physical_path(
    path: Path,
    *,
    allow_missing_leaf: bool = False,
    reject_hardlinked_file: bool = True,
) -> Path:
    """Reject links/reparse points in every literal existing path component."""
    literal = path.expanduser()
    if not literal.is_absolute():
        literal = Path.cwd() / literal
    anchor = Path(literal.anchor)
    current = anchor
    parts = literal.parts[1:] if literal.anchor else literal.parts
    for index, part in enumerate(parts):
        if part in {"", "."}:
            continue
        if part == "..":
            current = current.parent
            continue
        current = current / part
        missing_leaf = allow_missing_leaf and index == len(parts) - 1
        try:
            info = current.lstat()
        except FileNotFoundError:
            if missing_leaf:
                return Path(os.path.abspath(literal))
            raise ValueError(f"path component is unavailable: {current}")
        except OSError as error:
            raise ValueError(f"path component is unavailable: {current}") from error
        if current.is_symlink() or _is_reparse_point(current):
            raise ValueError(f"path component is aliased: {current}")
        if index < len(parts) - 1 and not current.is_dir():
            raise ValueError(f"path component is not a directory: {current}")
        if reject_hardlinked_file and current.is_file() and info.st_nlink != 1:
            raise ValueError(f"file has hard-link aliases: {current}")
    return Path(os.path.abspath(literal))


def transport_json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def atomic_write_json(destination: Path, value: Any) -> None:
    """Install one canonical JSON file without exposing a partial destination."""
    assert_literal_physical_path(destination.parent)
    if destination.exists() or destination.is_symlink():
        assert_literal_physical_path(destination)
    temporary = destination.parent / f".{destination.name}.{os.getpid()}.tmp"
    if temporary.exists() or temporary.is_symlink():
        raise ValueError(f"temporary output already exists: {temporary}")
    data = transport_json_bytes(value)
    try:
        with temporary.open("xb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
    finally:
        if temporary.exists():
            temporary.unlink()


def contained_file(path: Path, run: Path) -> Path:
    root = assert_literal_physical_path(run).resolve(strict=True)
    assert_literal_physical_path(path)
    resolved = path.resolve(strict=True)
    if not resolved.is_relative_to(root) or not resolved.is_file():
        raise ValueError(f"source path leaves approved run: {path}")
    return resolved


def physical_projected_event_content(event: dict[str, Any], trajectory_dir: Path) -> str:
    if event.get("event_type") == "artifact":
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        raw_path = payload.get("path")
        if isinstance(raw_path, str):
            relative = Path(raw_path)
            if (
                not relative.is_absolute() and ".." not in relative.parts
                and relative.parts and relative.parts[0] == "artifacts"
            ):
                assert_literal_physical_path(trajectory_dir / relative)
    return projected_event_content(event, trajectory_dir)


def direct_physical_child(path: Path, parent: Path, run: Path, *, directory: bool) -> Path:
    try:
        assert_literal_physical_path(path)
        resolved = path.resolve(strict=True)
    except ValueError as error:
        if "hard-link" in str(error):
            raise ValueError(f"meeting source file has hard-link aliases: {path}") from None
        raise ValueError(f"meeting source path is aliased: {path}") from None
    except (OSError, RuntimeError):
        raise ValueError(f"meeting source path is invalid: {path}") from None
    if not resolved.is_relative_to(run.resolve(strict=True)):
        raise ValueError(f"source path leaves approved run: {path}")
    if resolved != parent / path.name:
        raise ValueError(f"meeting source path is aliased: {path}")
    if directory and not resolved.is_dir():
        raise ValueError(f"meeting source is not a directory: {path}")
    if not directory and not resolved.is_file():
        raise ValueError(f"meeting source is not a file: {path}")
    return resolved


def indexed_trajectory_directories(run: Path) -> list[Path]:
    """Return the exact successful trajectory membership declared by the run index."""
    run = assert_literal_physical_path(run).resolve(strict=True)
    trajectories_root = run / "trajectories"
    index_path = run / "index.json"
    has_root = trajectories_root.exists() or trajectories_root.is_symlink()
    has_index = index_path.exists() or index_path.is_symlink()
    if not has_root and not has_index:
        return []
    if not has_index:
        raise ValueError("trajectory index authority is required")
    index = read_object(contained_file(index_path, run))
    entries = index.get("trajectories")
    count = index.get("trajectory_count")
    schema = index.get("schema")
    tool = index.get("tool")
    collector_index = schema == INGEST_RUN_SCHEMA and tool == "collect_repo_trajectories"
    anthropic_index = schema == INGEST_RUN_SCHEMA and tool == "import_anthropic_export"
    review_index = schema == AI_REVIEW_RUN_SCHEMA and tool == "prepare_ai_review_run"
    if (
        not (collector_index or anthropic_index or review_index)
        or not isinstance(entries, list)
        or not isinstance(count, int)
        or isinstance(count, bool)
        or count != len(entries)
    ):
        raise ValueError("trajectory index authority is invalid")
    if collector_index and (
        index.get("collection_status") != "complete"
        or not isinstance(index.get("trajectory_failures"), int)
        or isinstance(index.get("trajectory_failures"), bool)
        or index.get("trajectory_failures") != 0
    ):
        raise ValueError("trajectory index authority is invalid")
    if (anthropic_index or review_index) and "trajectory_failures" in index:
        raise ValueError("trajectory index authority is invalid")

    expected_ids: list[str] = []
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("trajectory index authority is invalid")
        trajectory_id = entry.get("trajectory_id")
        if (
            not isinstance(trajectory_id, str)
            or not SOURCE_ID_PATTERN.fullmatch(trajectory_id)
            or (collector_index and entry.get("ok") is not True)
            or (review_index and entry.get("ok") is not True)
            or (anthropic_index and "ok" in entry)
        ):
            raise ValueError("trajectory index authority is invalid")
        expected_ids.append(trajectory_id)
    if len(set(expected_ids)) != len(expected_ids):
        raise ValueError("trajectory index authority is invalid")

    actual: dict[str, Path] = {}
    if has_root:
        root = assert_literal_physical_path(trajectories_root).resolve(strict=True)
        if not root.is_dir() or root.parent != run:
            raise ValueError("trajectory directory authority is invalid")
        for entry in root.iterdir():
            try:
                physical = assert_literal_physical_path(entry).resolve(strict=True)
            except (OSError, RuntimeError, ValueError):
                raise ValueError("trajectory directory authority is invalid") from None
            if not physical.is_dir() or physical.parent != root:
                raise ValueError("trajectory directory authority is invalid")
            actual[entry.name] = physical
    if set(actual) != set(expected_ids):
        raise ValueError("trajectory index membership is not exact")
    selected_ids = expected_ids
    if collector_index:
        selected_ids = []
        unresolved = False
        for entry in entries:
            if "cwd_relations" not in entry:
                unresolved = True
                continue
            relations = entry["cwd_relations"]
            if (
                not isinstance(relations, list) or not relations
                or relations != sorted(relations) or len(relations) != len(set(relations))
                or any(not isinstance(value, str) or value not in CWD_RELATIONS
                       for value in relations)
            ):
                raise ValueError("trajectory index authority is invalid")
            relation_set = set(relations)
            if relation_set <= CURRENT_CWD_RELATIONS:
                selected_ids.append(entry["trajectory_id"])
            elif not relation_set <= FOREIGN_CWD_RELATIONS:
                unresolved = True
        if unresolved:
            raise ValueError(PROJECT_MEMBERSHIP_NEEDS_USER_RESOLUTION)
    return [actual[value] for value in sorted(selected_ids, key=lambda item: item.encode("utf-8"))]


def source_inventory(
    run: Path,
) -> tuple[list[str], list[dict[str, Any]], dict[str, str]]:
    contribution_ids, sources, contribution_source_digests, _ = source_inventory_records(run)
    return contribution_ids, sources, contribution_source_digests


def source_inventory_records(
    run: Path,
) -> tuple[
    list[str], list[dict[str, Any]], dict[str, str], list[dict[str, Any]],
]:
    contribution_ids: list[str] = []
    contribution_source_digests: dict[str, str] = {}
    contribution_records: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []
    for trajectory_dir in indexed_trajectory_directories(run):
        events_path = contained_file(trajectory_dir / "events.jsonl", run)
        manifest_path = contained_file(trajectory_dir / "manifest.json", run)
        manifest = read_object(manifest_path)
        manifest_schema = manifest.get("schema")
        event_schema = {
            TRAJECTORY_SCHEMA: TRAJECTORY_EVENT_SCHEMA,
            AI_REVIEW_TRAJECTORY_SCHEMA: AI_REVIEW_EVENT_SCHEMA,
        }.get(manifest_schema)
        if event_schema is None:
            raise ValueError(f"{RECOLLECT_GUIDANCE}: non-canonical trajectory contract")
        trajectory_id = manifest.get("trajectory_id")
        if (
            not isinstance(trajectory_id, str)
            or not SOURCE_ID_PATTERN.fullmatch(trajectory_id)
            or trajectory_id != trajectory_dir.name
        ):
            raise ValueError("trajectory source identity is invalid")
        projection = manifest.get("contribution_projection")
        if not isinstance(projection, dict):
            raise ValueError(f"{RECOLLECT_GUIDANCE}: {trajectory_id}")
        policy_id = projection.get("policy_id")
        raw_digest = projection.get("raw_source_digest")
        projected_digest = projection.get("projected_universe_digest")
        raw_count = projection.get("raw_event_count")
        normalized_count = projection.get("normalized_event_count")
        kept_count = projection.get("kept_event_count")
        dropped_count = projection.get("dropped_event_count")
        replay_count = projection.get("cross_trajectory_semantic_replay_count")
        events = [
            json.loads(line) for line in events_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        if any(
            not isinstance(event, dict)
            or event.get("schema") != event_schema
            for event in events
        ):
            raise ValueError(f"{RECOLLECT_GUIDANCE}: non-canonical trajectory event")
        projected_hasher = hashlib.sha256()
        for event in events:
            projected_hasher.update((canonical_json(event) + "\n").encode("utf-8"))
        if (
            policy_id != POLICY_ID
            or not all(valid_digest(value) for value in (raw_digest, projected_digest))
            or projected_hasher.hexdigest() != projected_digest
            or not all(isinstance(value, int) and not isinstance(value, bool) for value in (
                raw_count, normalized_count, kept_count, dropped_count, replay_count,
            ))
            or kept_count != int(manifest.get("event_count", -1))
            or raw_count - replay_count != normalized_count
            or normalized_count - kept_count != dropped_count
        ):
            raise ValueError(
                f"current contribution projection is invalid; re-collect through current ingest: "
                f"{trajectory_id}"
            )
        sources.append({
            "kind": "trajectory",
            "id": trajectory_id,
            "policyId": policy_id,
            "rawSourceDigest": raw_digest,
            "projectedUniverseDigest": projected_digest,
        })
        for index, event in enumerate(events, 1):
            contribution_id = projected_contribution_id(event)
            contribution_ids.append(contribution_id)
            actor = event.get("actor") if isinstance(event.get("actor"), dict) else {}
            record = {
                "id": contribution_id,
                "documentId": trajectory_id,
                "sequence": event.get("sequence", index),
                "eventType": event.get("event_type"),
                "actorId": actor.get("id"),
                "actorType": actor.get("type"),
                "timestamp": event.get("timestamp") or event.get("started_at"),
                "content": physical_projected_event_content(event, events_path.parent),
            }
            contribution_source_digests[contribution_id] = imported_contribution_digest_value(
                event, record,
            )
            contribution_records.append(record)

    root_meeting = run / "meeting.json"
    if root_meeting.exists() or root_meeting.is_symlink():
        raise ValueError("root meeting source is not supported")
    meeting_candidates: list[tuple[str, Path]] = []
    meetings_root = run / "meetings"
    if meetings_root.exists() or meetings_root.is_symlink():
        try:
            assert_literal_physical_path(meetings_root)
        except ValueError:
            raise ValueError("meetings path is aliased") from None
        resolved_meetings = meetings_root.resolve(strict=True)
        resolved_run = run.resolve(strict=True)
        if not resolved_meetings.is_relative_to(resolved_run) or not resolved_meetings.is_dir():
            raise ValueError("meetings path leaves approved run")
        if resolved_meetings != resolved_run / "meetings":
            raise ValueError("meetings path is aliased")
        for entry in sorted(meetings_root.iterdir()):
            literal_meeting_id = entry.name
            directory = direct_physical_child(
                entry, resolved_meetings, run, directory=True,
            )
            meeting_path = direct_physical_child(
                entry / "meeting.json", directory, run, directory=False,
            )
            meeting_candidates.append((literal_meeting_id, meeting_path))

    for literal_meeting_id, meeting_path in meeting_candidates:
        meeting = read_object(meeting_path)
        if meeting.get("schema") not in {MEETING_SCHEMA, AI_REVIEW_MEETING_SCHEMA}:
            raise ValueError("meeting source uses a non-canonical contract")
        meeting_id = meeting.get("meeting_id") or meeting.get("id") or literal_meeting_id
        records = meeting.get("records")
        if not isinstance(meeting_id, str) or not meeting_id or not isinstance(records, list):
            raise ValueError("meeting source is invalid")
        if (
            not SOURCE_ID_PATTERN.fullmatch(meeting_id)
            or literal_meeting_id != meeting_id
        ):
            raise ValueError("meeting source identity is invalid")
        sources.append({
            "kind": "meeting",
            "id": meeting_id,
            "rawSourceDigest": hashlib.sha256(meeting_path.read_bytes()).hexdigest(),
        })
        record_identities = meeting_contribution_ids(meeting_id, records)
        for index, (record, contribution_id) in enumerate(zip(records, record_identities), 1):
            sequence = record.get("sequence_in_meeting")
            if sequence is None:
                sequence = record.get("order")
            if sequence is None:
                sequence = index
            contribution_ids.append(contribution_id)
            imported_record = {
                "id": contribution_id,
                "documentId": meeting_id,
                "sequence": sequence,
                "eventType": "record",
                "actorId": record.get("speaker"),
                "actorType": "human",
                "timestamp": record.get("timestamp") or record.get("started_at"),
                "content": record.get("text", ""),
            }
            contribution_source_digests[contribution_id] = imported_contribution_digest_value(
                record, imported_record,
            )
            contribution_records.append(imported_record)

    if len(set(contribution_ids)) != len(contribution_ids):
        raise ValueError("contribution identity is duplicated")
    source_ids = [(source["kind"], source["id"]) for source in sources]
    if len(set(source_ids)) != len(source_ids):
        raise ValueError("source identity is duplicated")
    ordered_ids = sorted(contribution_ids, key=lambda value: value.encode("utf-8"))
    records_by_id = {record["id"]: record for record in contribution_records}
    return (
        ordered_ids,
        sorted(sources, key=lambda item: (
            item["kind"].encode("utf-8"), item["id"].encode("utf-8")
        )),
        contribution_source_digests,
        [records_by_id[contribution_id] for contribution_id in ordered_ids],
    )


def bounded_text(value: Any, limit: int) -> bool:
    return (
        isinstance(value, str) and bool(value.strip())
        and len(value.encode("utf-8")) <= limit
    )


def valid_semantic_unit_kind(value: Any) -> bool:
    return isinstance(value, str) and SEMANTIC_UNIT_KIND_PATTERN.fullmatch(value) is not None


def validate_previous_manifest(value: Any, project_id: str) -> dict[str, Any]:
    """Validate explicit revision lineage before it can influence new authority."""
    try:
        serialized_bytes = len(canonical_json(value).encode("utf-8"))
    except (TypeError, ValueError):
        raise ValueError("previous semantic manifest is invalid") from None
    if serialized_bytes > MAX_SEMANTIC_MANIFEST_BYTES:
        raise ValueError("previous semantic manifest serialized-byte limit exceeded")
    if not isinstance(value, dict) or set(value) != {
        "projectId", "revision", "sourceDigest", "universeDigest", "registryDigest",
        "manifestDigest", "units",
    }:
        raise ValueError("previous semantic manifest is invalid")
    if (
        value.get("projectId") != project_id
        or not isinstance(value.get("revision"), int)
        or isinstance(value.get("revision"), bool)
        or value["revision"] <= 0
        or not all(valid_digest(value.get(key)) for key in (
            "sourceDigest", "universeDigest", "registryDigest", "manifestDigest",
        ))
        or not isinstance(value.get("units"), list)
        or len(value["units"]) > MAX_SEMANTIC_UNITS
    ):
        raise ValueError("previous semantic manifest is invalid")

    units: list[dict[str, Any]] = []
    unit_ids: set[str] = set()
    members_seen: set[str] = set()
    for raw in value["units"]:
        if not isinstance(raw, dict) or set(raw) - {
            "id", "revision", "projectId", "kind", "members", "memberCount",
            "membershipDigest", "duplicateOfUnitId", "storyProjection",
        } or not {
            "id", "revision", "projectId", "kind", "members", "memberCount",
            "membershipDigest",
        }.issubset(raw):
            raise ValueError("previous semantic unit authority is invalid")
        unit_id = raw.get("id")
        revision = raw.get("revision")
        members = raw.get("members")
        if not valid_semantic_unit_kind(raw.get("kind")):
            raise ValueError(SEMANTIC_WORKER_KIND_INVALID)
        if (
            not bounded_text(unit_id, 300)
            or unit_id in unit_ids
            or not isinstance(revision, int)
            or isinstance(revision, bool)
            or revision <= 0
            or raw.get("projectId") != project_id
            or not isinstance(members, list)
            or not members
            or not isinstance(raw.get("memberCount"), int)
            or isinstance(raw.get("memberCount"), bool)
            or raw["memberCount"] != len(members)
            or not valid_digest(raw.get("membershipDigest"))
            or not all(bounded_text(member, 300) for member in members)
        ):
            raise ValueError("previous semantic unit authority is invalid")
        normalized_members = sorted(members, key=lambda member: member.encode("utf-8"))
        if len(set(normalized_members)) != len(normalized_members):
            raise ValueError("previous semantic unit repeats a member")
        if members_seen.intersection(normalized_members):
            raise ValueError("previous semantic manifest double-owns a member")
        projection = raw.get("storyProjection")
        if projection is not None and (
            not isinstance(projection, dict)
            or set(projection) != {"label", "summary"}
            or not bounded_text(projection.get("label"), 120)
            or not bounded_text(projection.get("summary"), 300)
        ):
            raise ValueError("previous Story projection is invalid")
        duplicate_of = raw.get("duplicateOfUnitId")
        if duplicate_of is not None and not bounded_text(duplicate_of, 300):
            raise ValueError("previous duplicate authority is invalid")
        unit_ids.add(unit_id)
        members_seen.update(normalized_members)
        units.append({
            "id": unit_id,
            "revision": revision,
            "projectId": project_id,
            "kind": raw["kind"],
            "members": normalized_members,
            "memberCount": len(normalized_members),
            "membershipDigest": raw["membershipDigest"],
            **({"duplicateOfUnitId": duplicate_of} if duplicate_of else {}),
            **({"storyProjection": projection} if projection else {}),
        })
    units.sort(key=lambda unit: unit["id"].encode("utf-8"))
    units_by_id = {unit["id"]: unit for unit in units}
    for unit in units:
        duplicate_of = unit.get("duplicateOfUnitId")
        if unit["kind"] == "duplicate":
            if (
                not duplicate_of
                or duplicate_of == unit["id"]
                or duplicate_of not in units_by_id
                or units_by_id[duplicate_of]["kind"] == "duplicate"
            ):
                raise ValueError("previous duplicate relation is invalid")
        elif duplicate_of is not None:
            raise ValueError("previous non-duplicate unit declares duplicate authority")
    member_universe = sorted(members_seen, key=lambda member: member.encode("utf-8"))
    if digest(member_universe) != value["universeDigest"]:
        raise ValueError("previous semantic universe digest is stale")
    core = {
        "projectId": project_id,
        "sourceDigest": value["sourceDigest"],
        "universeDigest": value["universeDigest"],
        "registryDigest": value["registryDigest"],
        "units": units,
        "revision": value["revision"],
    }
    if digest(core) != value["manifestDigest"]:
        raise ValueError("previous semantic manifest digest is stale")
    story_projection = {
        "projectId": project_id,
        "revision": value["revision"],
        "sourceDigest": value["sourceDigest"],
        "universeDigest": value["universeDigest"],
        "registryDigest": value["registryDigest"],
        "manifestDigest": value["manifestDigest"],
        "units": [{
            "id": unit["id"],
            "revision": unit["revision"],
            "kind": unit["kind"],
            "memberCount": unit["memberCount"],
            "membershipDigest": unit["membershipDigest"],
            **({"duplicateOfUnitId": unit["duplicateOfUnitId"]}
               if unit.get("duplicateOfUnitId") else {}),
            **({"storyProjection": unit["storyProjection"]}
               if unit.get("storyProjection") else {}),
        } for unit in units],
    }
    if len(canonical_json(story_projection).encode("utf-8")) > MAX_STORY_SEMANTIC_PROJECTION_BYTES:
        raise ValueError("previous Story-facing semantic projection limit exceeded")
    return {**core, "manifestDigest": value["manifestDigest"]}


def finalize_units(
    project_id: str,
    contribution_ids: list[str],
    contribution_source_digests: dict[str, str],
    source_digest: str,
    raw_units: Any,
    previous_manifest: Any = None,
    registry_digest: str | None = None,
) -> dict[str, Any]:
    if not bounded_text(project_id, 300):
        raise ValueError("project identity is invalid")
    if not isinstance(raw_units, list) or (contribution_ids and not raw_units):
        raise ValueError("Organization must supply semantic_units before finalization")
    if previous_manifest is not None:
        previous_manifest = validate_previous_manifest(previous_manifest, project_id)
        if registry_digest is None:
            registry_digest = previous_manifest["registryDigest"]
    if not valid_digest(registry_digest):
        raise ValueError("semantic registry digest is invalid")
    if len(raw_units) > MAX_SEMANTIC_UNITS:
        raise ValueError(f"semantic unit limit exceeded: {len(raw_units)} > {MAX_SEMANTIC_UNITS}")
    known = set(contribution_ids)
    owned: set[str] = set()
    unit_ids: set[str] = set()
    units: list[dict[str, Any]] = []
    for raw in raw_units:
        if not isinstance(raw, dict) or set(raw) - {
            "id", "kind", "members", "duplicateOfUnitId", "storyProjection",
        }:
            raise ValueError("semantic unit has unsupported fields")
        unit_id = raw.get("id")
        kind = raw.get("kind")
        members = raw.get("members")
        if not bounded_text(unit_id, 300) or unit_id in unit_ids:
            raise ValueError("semantic unit identity is invalid or duplicated")
        if not valid_semantic_unit_kind(kind):
            raise ValueError(SEMANTIC_WORKER_KIND_INVALID)
        if not isinstance(members, list) or not members:
            raise ValueError(f"semantic unit membership is invalid: {unit_id}")
        if not all(bounded_text(member, 300) for member in members):
            raise ValueError(f"semantic unit contains an invalid member: {unit_id}")
        normalized_members = sorted(members, key=lambda value: value.encode("utf-8"))
        if len(set(normalized_members)) != len(normalized_members):
            raise ValueError(f"semantic unit repeats a member: {unit_id}")
        unknown = set(normalized_members) - known
        overlap = set(normalized_members) & owned
        if unknown:
            raise ValueError(f"semantic unit contains unknown members: {unit_id}")
        if overlap:
            raise ValueError(f"contribution is owned by more than one semantic unit: {unit_id}")
        projection = raw.get("storyProjection")
        if projection is not None and (
            not isinstance(projection, dict) or set(projection) != {"label", "summary"}
            or not bounded_text(projection.get("label"), 120)
            or not bounded_text(projection.get("summary"), 300)
        ):
            raise ValueError(f"Story projection is invalid: {unit_id}")
        duplicate_of = raw.get("duplicateOfUnitId")
        if duplicate_of is not None and not bounded_text(duplicate_of, 300):
            raise ValueError(f"duplicate authority is invalid: {unit_id}")
        unit_ids.add(unit_id)
        owned.update(normalized_members)
        member_authority = [{
            "id": member,
            "sourceDigest": contribution_source_digests[member],
        } for member in normalized_members]
        units.append({
            "id": unit_id,
            "projectId": project_id,
            "kind": kind,
            "members": normalized_members,
            "memberCount": len(normalized_members),
            "membershipDigest": digest(member_authority),
            **({"duplicateOfUnitId": duplicate_of} if duplicate_of else {}),
            **({"storyProjection": projection} if projection else {}),
        })
    missing = known - owned
    if missing:
        raise ValueError(f"semantic manifest omits {len(missing)} contribution records")
    units.sort(key=lambda item: item["id"].encode("utf-8"))
    units_by_id = {unit["id"]: unit for unit in units}
    for unit in units:
        duplicate_of = unit.get("duplicateOfUnitId")
        if unit["kind"] == "duplicate":
            if (
                not duplicate_of
                or duplicate_of == unit["id"]
                or duplicate_of not in units_by_id
                or units_by_id[duplicate_of]["kind"] == "duplicate"
            ):
                raise ValueError(f"duplicate relation is invalid: {unit['id']}")
        elif duplicate_of is not None:
            raise ValueError(f"non-duplicate unit declares duplicate authority: {unit['id']}")
    previous_units: dict[str, dict[str, Any]] = {}
    previous_revision = 0
    if previous_manifest is not None:
        previous_revision = previous_manifest["revision"]
        for unit in previous_manifest["units"]:
            if (
                not isinstance(unit, dict)
                or not bounded_text(unit.get("id"), 300)
                or not isinstance(unit.get("revision"), int)
                or isinstance(unit.get("revision"), bool)
                or unit["revision"] <= 0
                or unit["id"] in previous_units
            ):
                raise ValueError("previous semantic unit authority is invalid")
            previous_units[unit["id"]] = unit

    def comparable_unit(unit: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in unit.items() if key != "revision"}

    for unit in units:
        previous = previous_units.get(unit["id"])
        unit["revision"] = (
            1 if previous is None
            else previous["revision"]
            if comparable_unit(previous) == comparable_unit(unit)
            else previous["revision"] + 1
        )
    units.sort(key=lambda item: item["id"].encode("utf-8"))
    manifest_base = {
        "projectId": project_id,
        "sourceDigest": source_digest,
        "universeDigest": digest(contribution_ids),
        "registryDigest": registry_digest,
        "units": units,
    }
    previous_base = None
    if previous_manifest is not None:
        previous_base = {
            key: value for key, value in previous_manifest.items()
            if key in {"projectId", "sourceDigest", "universeDigest", "registryDigest", "units"}
        }
    revision = (
        1 if previous_manifest is None
        else previous_revision if previous_base == manifest_base
        else previous_revision + 1
    )
    manifest_core = {**manifest_base, "revision": revision}
    manifest = {**manifest_core, "manifestDigest": digest(manifest_core)}
    if len(canonical_json(manifest).encode("utf-8")) > MAX_SEMANTIC_MANIFEST_BYTES:
        raise ValueError("semantic manifest serialized-byte limit exceeded")
    story_projection = {
        "projectId": project_id,
        "revision": revision,
        "sourceDigest": source_digest,
        "universeDigest": manifest["universeDigest"],
        "registryDigest": manifest["registryDigest"],
        "manifestDigest": manifest["manifestDigest"],
        "units": [{
            "id": unit["id"],
            "revision": unit["revision"],
            "kind": unit["kind"],
            "memberCount": unit["memberCount"],
            "membershipDigest": unit["membershipDigest"],
            **({"duplicateOfUnitId": unit["duplicateOfUnitId"]}
               if unit.get("duplicateOfUnitId") else {}),
            **({"storyProjection": unit["storyProjection"]} if unit.get("storyProjection") else {}),
        } for unit in units],
    }
    if len(canonical_json(story_projection).encode("utf-8")) > MAX_STORY_SEMANTIC_PROJECTION_BYTES:
        raise ValueError("Story-facing semantic projection limit exceeded")
    return manifest


def canonical_project_map(
    run: Path,
    primary_project: str,
    summary: str,
    raw_units: Any,
    previous_manifest: Any = None,
    *,
    finalize: bool = True,
    existing_manifest: Any = None,
    registry_digest: str | None = None,
) -> dict[str, Any]:
    """Build the single Organization project map for ``run``."""
    if (
        not isinstance(summary, str)
        or len(summary.encode("utf-8")) > MAX_PROJECT_MAP_SUMMARY_BYTES
    ):
        raise ValueError("project summary is invalid")
    contribution_ids, sources, contribution_source_digests = source_inventory(run)
    source_digest = digest([{
        "id": contribution_id,
        "sourceDigest": contribution_source_digests[contribution_id],
    } for contribution_id in contribution_ids])
    if registry_digest is None and isinstance(existing_manifest, dict):
        registry_digest = existing_manifest.get("registryDigest")
    project_map = {
        "schema": PROJECT_MAP_SCHEMA,
        "primary_project": primary_project,
        "summary": summary,
        "projects": [{
            "name": primary_project,
            "event_count": len(contribution_ids),
            "reason": "One repo-scoped projected contribution universe.",
        }],
        "source_authority": {
            "sourceDigest": source_digest,
            "sourceCount": len(sources),
            "contributionCount": len(contribution_ids),
        },
        "semantic_units": raw_units,
        "semantic_manifest": finalize_units(
            primary_project,
            contribution_ids,
            contribution_source_digests,
            source_digest,
            raw_units,
            previous_manifest,
            registry_digest,
        ) if finalize else existing_manifest,
    }
    if len(transport_json_bytes(project_map)) > MAX_PROJECT_MAP_BYTES:
        raise ValueError("project map transport-byte limit exceeded")
    return project_map


def validate_current_project_map_skeleton(
    run: Path, project_map: Any, *, allow_stale_source: bool = False,
) -> dict[str, Any]:
    """Accept only the current builder-owned skeleton shape for this exact run."""
    if not isinstance(project_map, dict) or set(project_map) != CURRENT_PROJECT_MAP_KEYS:
        raise ValueError(f"project map is not the current canonical skeleton; {RECOLLECT_GUIDANCE}")
    if project_map.get("schema") != PROJECT_MAP_SCHEMA:
        raise ValueError(f"project map is not the current canonical skeleton; {RECOLLECT_GUIDANCE}")
    project_id = project_map.get("primary_project")
    projects = project_map.get("projects")
    source_authority = project_map.get("source_authority")
    if (
        not bounded_text(project_id, 300)
        or not isinstance(project_map.get("summary"), str)
        or not isinstance(projects, list) or len(projects) != 1
        or not isinstance(projects[0], dict)
        or set(projects[0]) != {"name", "event_count", "reason"}
        or projects[0].get("name") != project_id
        or projects[0].get("reason") != "One repo-scoped projected contribution universe."
        or not isinstance(projects[0].get("event_count"), int)
        or isinstance(projects[0].get("event_count"), bool)
        or projects[0]["event_count"] < 0
        or not isinstance(source_authority, dict)
        or set(source_authority) != {"sourceDigest", "sourceCount", "contributionCount"}
        or not valid_digest(source_authority.get("sourceDigest"))
        or any(
            not isinstance(source_authority.get(key), int)
            or isinstance(source_authority.get(key), bool)
            or source_authority[key] < 0
            for key in ("sourceCount", "contributionCount")
        )
    ):
        raise ValueError(f"project map is not the current canonical skeleton; {RECOLLECT_GUIDANCE}")
    raw_units = project_map.get("semantic_units")
    if not isinstance(raw_units, list):
        raise ValueError("current project-map skeleton semantic_units is invalid")
    existing_manifest = project_map.get("semantic_manifest")
    if existing_manifest is not None:
        validate_previous_manifest(existing_manifest, project_id)
    expected = canonical_project_map(
        run,
        project_map.get("primary_project"),
        project_map.get("summary"),
        raw_units,
        finalize=False,
        existing_manifest=existing_manifest,
    )
    comparable_expected = expected
    comparable_actual = project_map
    if allow_stale_source:
        comparable_expected = {
            key: value for key, value in expected.items()
            if key not in {"projects", "source_authority"}
        }
        comparable_actual = {
            key: value for key, value in project_map.items()
            if key not in {"projects", "source_authority"}
        }
    if comparable_expected != comparable_actual:
        raise ValueError("current project-map skeleton is stale or was hand-edited")
    return expected


def validate_project_map_authority(
    run: Path, project_map: Any,
) -> dict[str, Any]:
    """Prove a finalized project map is bound to the exact current corpus."""
    if not isinstance(project_map, dict):
        raise ValueError("project map semantic authority is invalid")
    manifest = project_map.get("semantic_manifest")
    source_authority = project_map.get("source_authority")
    if not isinstance(manifest, dict) or not isinstance(source_authority, dict):
        raise ValueError("project map semantic authority is not finalized")
    expected = canonical_project_map(
        run,
        project_map.get("primary_project"),
        project_map.get("summary"),
        project_map.get("semantic_units"),
        manifest,
        registry_digest=manifest.get("registryDigest"),
    )
    if (
        expected["semantic_manifest"] != manifest
        or expected["source_authority"] != source_authority
    ):
        raise ValueError("project map semantic authority is stale")
    return expected


def main() -> None:
    configure_utf8_stdio()
    parser = argparse.ArgumentParser()
    parser.add_argument("run", type=Path)
    parser.add_argument("--primary-project", required=True)
    parser.add_argument("--summary", required=True)
    parser.add_argument("--finalize", action="store_true")
    parser.add_argument(
        "--registry-digest",
        help="Required for a fresh finalized map; an existing manifest may supply it.",
    )
    parser.add_argument(
        "--previous", type=Path,
        help="Explicit prior project-map or semantic-manifest file used for revision lineage.",
    )
    args = parser.parse_args()
    run = assert_literal_physical_path(args.run).resolve(strict=True)
    if not run.is_dir():
        raise ValueError("run is not a directory")
    destination = run / "project-map.json"
    if destination.exists() or destination.is_symlink():
        contained_file(destination, run)
    existing = (
        read_object(contained_file(destination, run))
        if destination.exists() or destination.is_symlink()
        else {}
    )
    if existing:
        validate_current_project_map_skeleton(run, existing, allow_stale_source=True)
    raw_units = existing.get("semantic_units", [])
    previous_manifest = None
    if args.previous is not None:
        previous_object = read_object(contained_file(args.previous, run))
        if "semantic_manifest" not in previous_object:
            raise ValueError("previous authority must be a current canonical project map")
        validate_current_project_map_skeleton(
            run, previous_object, allow_stale_source=True,
        )
        previous_manifest = previous_object["semantic_manifest"]
    output = canonical_project_map(
        run,
        args.primary_project,
        args.summary,
        raw_units,
        previous_manifest,
        finalize=args.finalize,
        existing_manifest=existing.get("semantic_manifest"),
        registry_digest=args.registry_digest,
    )
    atomic_write_json(destination, output)
    print(json.dumps({
        "project_map": str(destination),
        "contribution_records": output["source_authority"]["contributionCount"],
        "semantic_units": len(raw_units),
        "finalized": bool(output["semantic_manifest"] is not None),
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        if isinstance(error, ValueError) and str(error) in {
            SEMANTIC_WORKER_KIND_INVALID, PROJECT_MEMBERSHIP_NEEDS_USER_RESOLUTION,
        }:
            raise SystemExit(str(error)) from None
        raise SystemExit("PROJECT_MAP_INPUT_INVALID") from None
