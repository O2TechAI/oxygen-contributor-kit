#!/usr/bin/env python3
"""Validate Organization worker receipts, compose proposals, and install one project map."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import sys
from typing import Any

from build_project_map import (
    SEMANTIC_WORKER_KIND_INVALID,
    assert_literal_physical_path,
    atomic_write_json,
    bounded_text,
    canonical_project_map,
    digest,
    read_object,
    validate_current_project_map_skeleton,
)
from prepare_semantic_units import (
    MAX_MAX_SHARD_BYTES,
    MIN_MAX_SHARD_BYTES,
    build_preparation,
    safe_record,
)

TOOLS_ROOT = Path(__file__).resolve().parents[3] / "tools"
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from oxygen_utf8 import configure_utf8_stdio


SHARD_ID = re.compile(r"shard-[0-9]{4}")
CONTROL = re.compile(r"[\x00-\x1f\x7f]")
MANIFEST_KEYS = {
    "inputDigest", "projectId", "sourceDigest", "universeDigest",
    "registryDigest", "registryPath", "maximumShardBytes", "contributionIds", "shards",
}
SHARD_KEYS = {
    "id", "inputDigest", "contributionIds", "inputPath", "proposalPath", "receiptPath",
}
RECEIPT_KEYS = {
    "status", "shardId", "inputDigest", "contributionIds",
    "outputPath", "outputDigest", "outputCount",
}
OUTPUT_KEYS = {"shardId", "inputDigest", "proposals"}
SEMANTIC_WORKER_MAPPING_INVALID = "SEMANTIC_WORKER_MAPPING_INVALID"


def exact_keys(value: Any, required: set[str], optional: set[str] = set()) -> bool:
    return isinstance(value, dict) and required <= set(value) <= required | optional


def stable_id(value: Any, maximum: int = 300) -> bool:
    return bounded_text(value, maximum) and CONTROL.search(value) is None


def contained_relative(root: Path, relative_value: Any) -> Path:
    if not isinstance(relative_value, str) or not relative_value:
        raise ValueError("worker path is invalid")
    posix = PurePosixPath(relative_value)
    windows = PureWindowsPath(relative_value)
    if (
        posix.is_absolute() or windows.is_absolute()
        or ".." in posix.parts or ".." in windows.parts
        or "\\" in relative_value
    ):
        raise ValueError("worker path leaves the explicit semantic output root")
    target = root.joinpath(*posix.parts)
    assert_literal_physical_path(target)
    resolved = target.resolve(strict=True)
    if not resolved.is_relative_to(root.resolve(strict=True)) or not resolved.is_file():
        raise ValueError("worker path leaves the explicit semantic output root")
    return resolved


def validate_context(
    root: Path,
    manifest: dict[str, Any],
    project_map: dict[str, Any],
    expected_context: dict[str, Any],
) -> None:
    context = read_object(contained_relative(root, "semantic-context.json"))
    required = {
        "inputDigest", "projectId", "summary", "sourceDigest", "universeDigest",
        "sources", "contributions",
    }
    if set(context) != required or context != expected_context:
        raise ValueError("semantic preparation context is invalid")
    core = {key: context[key] for key in required if key != "inputDigest"}
    if (
        digest(core) != context["inputDigest"]
        or context["inputDigest"] != manifest["inputDigest"]
        or context["projectId"] != project_map["primary_project"]
        or context["summary"] != project_map["summary"]
        or context["sourceDigest"] != manifest["sourceDigest"]
        or context["universeDigest"] != manifest["universeDigest"]
        or not isinstance(context["sources"], list)
        or not isinstance(context["contributions"], list)
    ):
        raise ValueError("semantic preparation context is stale or tampered")
    records = [safe_record(record) for record in context["contributions"]]
    if records != context["contributions"]:
        raise ValueError("semantic preparation context contains unsupported metadata")
    ids = [record["id"] for record in records]
    if ids != manifest["contributionIds"] or digest(ids) != manifest["universeDigest"]:
        raise ValueError("semantic preparation context universe is stale")


def proposal(
    value: Any,
    assigned: set[str],
    registry_by_id: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    if not exact_keys(value, {"unitId", "contributionIds"}):
        raise ValueError(SEMANTIC_WORKER_MAPPING_INVALID)
    unit_id = value["unitId"]
    contribution_ids = value["contributionIds"]
    if (
        not stable_id(unit_id) or unit_id not in registry_by_id
        or not isinstance(contribution_ids, list) or not contribution_ids
        or any(not stable_id(member) for member in contribution_ids)
        or len(contribution_ids) != len(set(contribution_ids))
        or not set(contribution_ids) <= assigned
    ):
        raise ValueError(SEMANTIC_WORKER_MAPPING_INVALID)
    ordered = sorted(contribution_ids, key=lambda item: item.encode("utf-8"))
    if contribution_ids != ordered:
        raise ValueError(SEMANTIC_WORKER_MAPPING_INVALID)
    registry_unit = registry_by_id[unit_id]
    return {
        "id": unit_id,
        "kind": registry_unit["kind"],
        "members": ordered,
        **({"duplicateOfUnitId": registry_unit["duplicateOfUnitId"]}
           if registry_unit.get("duplicateOfUnitId") is not None else {}),
        **({"storyProjection": registry_unit["storyProjection"]}
           if registry_unit.get("storyProjection") is not None else {}),
    }


def read_shard_proposals(
    root: Path,
    manifest: dict[str, Any],
    registry: dict[str, Any],
) -> list[dict[str, Any]]:
    seen_shards: set[str] = set()
    globally_assigned: set[str] = set()
    proposals: list[dict[str, Any]] = []
    for shard in manifest["shards"]:
        if not isinstance(shard, dict) or set(shard) != SHARD_KEYS:
            raise ValueError("semantic shard manifest entry is invalid")
        shard_id = shard["id"]
        contribution_ids = shard["contributionIds"]
        expected_input_path = f"inputs/{shard_id}.json"
        expected_proposal_path = f"handoffs/{shard_id}.proposals.json"
        expected_receipt_path = f"records/{shard_id}/receipt.json"
        expected_output_path = f"records/{shard_id}/output.json"
        if (
            not isinstance(shard_id, str) or SHARD_ID.fullmatch(shard_id) is None
            or shard_id in seen_shards
            or not isinstance(contribution_ids, list) or not contribution_ids
            or any(not stable_id(member) for member in contribution_ids)
            or contribution_ids != sorted(contribution_ids, key=lambda item: item.encode("utf-8"))
            or len(contribution_ids) != len(set(contribution_ids))
            or shard["inputPath"] != expected_input_path
            or shard["proposalPath"] != expected_proposal_path
            or shard["receiptPath"] != expected_receipt_path
        ):
            raise ValueError("semantic shard manifest entry is invalid")
        seen_shards.add(shard_id)
        if globally_assigned.intersection(contribution_ids):
            raise ValueError("semantic shards overlap")
        globally_assigned.update(contribution_ids)
        input_value = read_object(contained_relative(root, expected_input_path))
        input_core = {
            "projectId": manifest["projectId"],
            "sourceDigest": manifest["sourceDigest"],
            "universeDigest": manifest["universeDigest"],
            "registry": registry,
            "shardId": shard_id,
            "contributions": input_value.get("contributions"),
        }
        if (
            set(input_value) != {*input_core, "inputDigest"}
            or input_value.get("inputDigest") != shard["inputDigest"]
            or digest(input_core) != shard["inputDigest"]
            or input_value.get("registry") != registry
            or not isinstance(input_value.get("contributions"), list)
            or [record.get("id") for record in input_value["contributions"]] != contribution_ids
            or any(safe_record(record) != record for record in input_value["contributions"])
        ):
            raise ValueError("semantic shard input is stale or tampered")

        receipt = read_object(contained_relative(root, expected_receipt_path))
        if (
            set(receipt) != RECEIPT_KEYS
            or receipt.get("status") != "complete"
            or receipt.get("shardId") != shard_id
            or receipt.get("inputDigest") != shard["inputDigest"]
            or receipt.get("contributionIds") != contribution_ids
            or receipt.get("outputPath") != expected_output_path
            or not isinstance(receipt.get("outputCount"), int)
            or isinstance(receipt.get("outputCount"), bool)
            or receipt["outputCount"] < 0
        ):
            raise ValueError("semantic worker receipt is missing, foreign, stale, or incomplete")
        output = read_object(contained_relative(root, receipt["outputPath"]))
        if (
            set(output) != OUTPUT_KEYS
            or output.get("shardId") != shard_id
            or output.get("inputDigest") != shard["inputDigest"]
            or not isinstance(output.get("proposals"), list)
            or receipt["outputDigest"] != digest(output)
            or receipt["outputCount"] != len(output["proposals"])
        ):
            raise ValueError("semantic worker output or receipt digest is tampered")
        assigned = set(contribution_ids)
        registry_by_id = {unit["unitId"]: unit for unit in registry["units"]}
        shard_owned: set[str] = set()
        for raw in output["proposals"]:
            normalized = proposal(raw, assigned, registry_by_id)
            overlap = shard_owned.intersection(normalized["members"])
            if overlap:
                raise ValueError("semantic worker proposals overlap within a shard")
            shard_owned.update(normalized["members"])
            proposals.append(normalized)
        if shard_owned != assigned:
            raise ValueError("semantic worker completed without proposing every shard contribution")
    expected = manifest["contributionIds"]
    if sorted(globally_assigned, key=lambda item: item.encode("utf-8")) != expected:
        raise ValueError("semantic shard receipts do not form the exact global union")
    return proposals


def compose(proposals: list[dict[str, Any]], contribution_ids: list[str]) -> list[dict[str, Any]]:
    units: dict[str, dict[str, Any]] = {}
    owned: set[str] = set()
    for current in proposals:
        unit_id = current["id"]
        metadata = {key: value for key, value in current.items() if key not in {"id", "members"}}
        existing = units.get(unit_id)
        if existing is None:
            existing = {"id": unit_id, **metadata, "members": []}
            units[unit_id] = existing
        elif {key: value for key, value in existing.items() if key not in {"id", "members"}} != metadata:
            raise ValueError("cross-shard unit proposals disagree on semantic authority")
        overlap = owned.intersection(current["members"])
        if overlap:
            raise ValueError("cross-shard unit proposals overlap")
        owned.update(current["members"])
        existing["members"].extend(current["members"])
    if sorted(owned, key=lambda item: item.encode("utf-8")) != contribution_ids:
        raise ValueError("composed semantic units do not form the exact global union")
    result = sorted(units.values(), key=lambda unit: unit["id"].encode("utf-8"))
    for unit in result:
        unit["members"].sort(key=lambda member: member.encode("utf-8"))
    return result


def finalize(run: Path, root: Path) -> dict[str, Any]:
    project_map_path = run / "project-map.json"
    assert_literal_physical_path(project_map_path)
    project_map = validate_current_project_map_skeleton(run, read_object(project_map_path))
    manifest = read_object(contained_relative(root, "shards.json"))
    if set(manifest) != MANIFEST_KEYS:
        raise ValueError("semantic shard manifest is invalid")
    maximum_shard_bytes = manifest.get("maximumShardBytes")
    if (
        not isinstance(maximum_shard_bytes, int)
        or isinstance(maximum_shard_bytes, bool)
        or not MIN_MAX_SHARD_BYTES <= maximum_shard_bytes <= MAX_MAX_SHARD_BYTES
    ):
        raise ValueError("semantic shard byte authority is invalid")
    registry_path = manifest.get("registryPath")
    if registry_path != "semantic-registry.json":
        raise ValueError("semantic registry path authority is invalid")
    registry = read_object(contained_relative(root, registry_path))
    proposed_registry = {"units": registry.get("units")}
    expected_preparation = build_preparation(run, maximum_shard_bytes, proposed_registry)
    if registry != expected_preparation["registry"] or registry.get("registryDigest") != manifest.get(
        "registryDigest"
    ):
        raise ValueError("semantic registry is stale or tampered")
    if manifest != expected_preparation["manifest"]:
        raise ValueError("semantic shard manifest is stale or tampered")
    ids = manifest.get("contributionIds")
    shards = manifest.get("shards")
    if (
        manifest.get("projectId") != project_map["primary_project"]
        or manifest.get("sourceDigest") != project_map["source_authority"]["sourceDigest"]
        or not isinstance(ids, list) or not isinstance(shards, list)
        or ids != sorted(ids, key=lambda item: item.encode("utf-8"))
        or len(ids) != len(set(ids))
        or digest(ids) != manifest.get("universeDigest")
        or (bool(ids) != bool(shards))
    ):
        raise ValueError("semantic shard manifest is stale, foreign, or incomplete")
    validate_context(root, manifest, project_map, expected_preparation["context"])
    proposals = read_shard_proposals(root, manifest, registry)
    units = compose(proposals, ids)
    previous_manifest = project_map.get("semantic_manifest")
    output = canonical_project_map(
        run,
        project_map["primary_project"],
        project_map["summary"],
        units,
        previous_manifest,
        registry_digest=registry["registryDigest"],
    )
    atomic_write_json(project_map_path, output)
    return output


def main() -> None:
    configure_utf8_stdio()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path)
    parser.add_argument("semantic_output_root", type=Path)
    args = parser.parse_args()
    run = assert_literal_physical_path(args.run).resolve(strict=True)
    root = assert_literal_physical_path(args.semantic_output_root).resolve(strict=True)
    if not run.is_dir() or not root.is_dir():
        raise ValueError("run and semantic output root must be directories")
    output = finalize(run, root)
    print(json.dumps({
        "project_map": str(run / "project-map.json"),
        "semantic_units": len(output["semantic_units"]),
        "manifest_revision": output["semantic_manifest"]["revision"],
        "manifest_digest": output["semantic_manifest"]["manifestDigest"],
        "finalized": True,
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        if isinstance(error, ValueError) and str(error) == SEMANTIC_WORKER_KIND_INVALID:
            raise SystemExit(SEMANTIC_WORKER_KIND_INVALID) from None
        raise SystemExit("SEMANTIC_FINALIZATION_INVALID") from None
