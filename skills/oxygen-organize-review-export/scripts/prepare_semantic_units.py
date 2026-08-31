#!/usr/bin/env python3
"""Prepare immutable provider-safe Organization context and balanced shard inputs."""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import re
import shutil
import sys
from typing import Any

from build_project_map import (
    MAX_SEMANTIC_UNITS,
    assert_literal_physical_path,
    bounded_text,
    canonical_json,
    digest,
    read_object,
    source_inventory_records,
    valid_digest,
    valid_semantic_unit_kind,
    validate_current_project_map_skeleton,
)

TOOLS_ROOT = Path(__file__).resolve().parents[3] / "tools"
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from oxygen_utf8 import configure_utf8_stdio
from ingest.secret_safety import secret_like_text


DEFAULT_MAX_SHARD_BYTES = 196_608
MIN_MAX_SHARD_BYTES = 4_096
MAX_MAX_SHARD_BYTES = 1_048_576
MAX_CONTEXT_BYTES = 64 * 1024 * 1024
MAX_RECORDS_PER_SHARD = 400
MAX_REGISTRY_BYTES = DEFAULT_MAX_SHARD_BYTES // 2
MAX_REGISTRY_GUIDANCE_BYTES = 300
CONTROL = re.compile(r"[\x00-\x1f\x7f]")
SAFE_RECORD_KEYS = (
    "id", "documentId", "sequence", "eventType", "actorType", "timestamp", "content",
)


def safe_record(record: dict[str, Any]) -> dict[str, Any]:
    value = {key: record.get(key) for key in SAFE_RECORD_KEYS}
    if (
        not isinstance(value["id"], str) or not value["id"]
        or not isinstance(value["documentId"], str) or not value["documentId"]
        or not isinstance(value["sequence"], int) or isinstance(value["sequence"], bool)
        or not isinstance(value["content"], str)
    ):
        raise ValueError("projected contribution is not safe for semantic preparation")
    for key in ("eventType", "actorType", "timestamp"):
        if value[key] is not None and not isinstance(value[key], str):
            raise ValueError("projected contribution is not safe for semantic preparation")
    if secret_like_text(value["content"]):
        raise ValueError(
            "secret-like content cannot enter semantic worker context; sanitize and re-collect"
        )
    return value


def serialized_bytes(value: Any) -> int:
    return len(canonical_json(value).encode("utf-8"))


def semantic_registry(
    project_id: str,
    source_digest: str,
    universe_digest: str,
    value: Any,
) -> dict[str, Any]:
    if (
        not bounded_text(project_id, 300)
        or not valid_digest(source_digest) or not valid_digest(universe_digest)
        or not isinstance(value, dict) or set(value) != {"units"}
    ):
        raise ValueError("semantic registry proposal is invalid")
    raw_units = value["units"]
    if not isinstance(raw_units, list) or len(raw_units) > MAX_SEMANTIC_UNITS:
        raise ValueError("semantic registry proposal is invalid")
    units: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in raw_units:
        if (
            not isinstance(raw, dict)
            or not {"unitId", "kind", "definition", "disambiguation"} <= set(raw)
            or set(raw) - {
                "unitId", "kind", "definition", "disambiguation",
                "duplicateOfUnitId", "storyProjection",
            }
        ):
            raise ValueError("semantic registry entry is invalid")
        unit_id = raw["unitId"]
        duplicate_of = raw.get("duplicateOfUnitId")
        projection = raw.get("storyProjection")
        if (
            not bounded_text(unit_id, 300) or CONTROL.search(unit_id) is not None
            or secret_like_text(unit_id)
            or unit_id in seen
            or not valid_semantic_unit_kind(raw["kind"])
            or any(
                not bounded_text(raw[field], MAX_REGISTRY_GUIDANCE_BYTES)
                or CONTROL.search(raw[field]) is not None
                or secret_like_text(raw[field])
                for field in ("definition", "disambiguation")
            )
            or (duplicate_of is not None and (
                not bounded_text(duplicate_of, 300) or CONTROL.search(duplicate_of) is not None
                or secret_like_text(duplicate_of)
            ))
            or (projection is not None and (
                not isinstance(projection, dict) or set(projection) != {"label", "summary"}
                or not bounded_text(projection.get("label"), 120)
                or not bounded_text(projection.get("summary"), 300)
                or CONTROL.search(projection["label"]) is not None
                or CONTROL.search(projection["summary"]) is not None
                or secret_like_text(projection["label"])
                or secret_like_text(projection["summary"])
            ))
        ):
            raise ValueError("semantic registry entry is invalid")
        seen.add(unit_id)
        units.append({
            "unitId": unit_id,
            "kind": raw["kind"],
            "definition": raw["definition"],
            "disambiguation": raw["disambiguation"],
            **({"duplicateOfUnitId": duplicate_of} if duplicate_of is not None else {}),
            **({"storyProjection": projection} if projection is not None else {}),
        })
    units.sort(key=lambda unit: unit["unitId"].encode("utf-8"))
    by_id = {unit["unitId"]: unit for unit in units}
    for unit in units:
        duplicate_of = unit.get("duplicateOfUnitId")
        if unit["kind"] == "duplicate":
            if (
                not duplicate_of or duplicate_of == unit["unitId"]
                or duplicate_of not in by_id or by_id[duplicate_of]["kind"] == "duplicate"
            ):
                raise ValueError("semantic registry duplicate relation is invalid")
        elif duplicate_of is not None:
            raise ValueError("semantic registry non-duplicate entry declares duplicate authority")
    core = {
        "projectId": project_id,
        "sourceDigest": source_digest,
        "universeDigest": universe_digest,
        "units": units,
    }
    registry = {**core, "registryDigest": digest(core)}
    if serialized_bytes(registry) > MAX_REGISTRY_BYTES:
        raise ValueError("semantic registry byte limit exceeded")
    return registry


def assign_balanced(records: list[dict[str, Any]], shard_count: int) -> list[list[dict[str, Any]]]:
    shards: list[list[dict[str, Any]]] = [[] for _ in range(shard_count)]
    totals = [[0, 0, 0] for _ in range(shard_count)]
    weighted = sorted(
        records,
        key=lambda record: (
            -serialized_bytes(record),
            -len(record["content"].encode("utf-8")),
            record["id"].encode("utf-8"),
        ),
    )
    for record in weighted:
        index = min(
            range(shard_count),
            key=lambda candidate: (*totals[candidate], candidate),
        )
        shards[index].append(record)
        totals[index][0] += serialized_bytes(record)
        totals[index][1] += len(record["content"].encode("utf-8"))
        totals[index][2] += 1
    for shard in shards:
        shard.sort(key=lambda record: record["id"].encode("utf-8"))
    return shards


def shard_input(
    project_id: str,
    source_digest: str,
    universe_digest: str,
    registry: dict[str, Any],
    shard_id: str,
    records: list[dict[str, Any]],
) -> dict[str, Any]:
    core = {
        "projectId": project_id,
        "sourceDigest": source_digest,
        "universeDigest": universe_digest,
        "registry": registry,
        "shardId": shard_id,
        "contributions": records,
    }
    return {**core, "inputDigest": digest(core)}


def build_preparation(
    run: Path,
    maximum_shard_bytes: int,
    registry_proposal: Any,
) -> dict[str, Any]:
    project_map_path = run / "project-map.json"
    if not project_map_path.is_file():
        raise ValueError(
            "current canonical project-map skeleton is required; run build_project_map.py first"
        )
    assert_literal_physical_path(project_map_path)
    project_map = validate_current_project_map_skeleton(run, read_object(project_map_path))
    ids, sources, source_digests, records = source_inventory_records(run)
    source_digest = digest([{
        "id": contribution_id,
        "sourceDigest": source_digests[contribution_id],
    } for contribution_id in ids])
    universe_digest = digest(ids)
    registry = semantic_registry(
        project_map["primary_project"], source_digest, universe_digest, registry_proposal,
    )
    if bool(ids) != bool(registry["units"]):
        raise ValueError("semantic registry must be nonempty exactly when the universe is nonempty")
    authority = project_map["source_authority"]
    if authority != {
        "sourceDigest": source_digest,
        "sourceCount": len(sources),
        "contributionCount": len(ids),
    }:
        raise ValueError("current project-map skeleton source authority is stale")
    safe_records = [safe_record(record) for record in records]
    context_core = {
        "projectId": project_map["primary_project"],
        "summary": project_map["summary"],
        "sourceDigest": source_digest,
        "universeDigest": universe_digest,
        "sources": [{"kind": source["kind"], "id": source["id"]} for source in sources],
        "contributions": safe_records,
    }
    context = {**context_core, "inputDigest": digest(context_core)}
    if serialized_bytes(context) > MAX_CONTEXT_BYTES:
        raise ValueError("semantic preparation context byte limit exceeded")

    if not safe_records:
        shard_groups: list[list[dict[str, Any]]] = []
    else:
        total_record_bytes = sum(serialized_bytes(record) for record in safe_records)
        total_content_bytes = sum(len(record["content"].encode("utf-8")) for record in safe_records)
        if any(serialized_bytes(record) > maximum_shard_bytes for record in safe_records):
            raise ValueError("one contribution exceeds the semantic shard byte bound")
        count = max(
            1,
            math.ceil(total_record_bytes / maximum_shard_bytes),
            math.ceil(total_content_bytes / maximum_shard_bytes),
            math.ceil(len(safe_records) / MAX_RECORDS_PER_SHARD),
        )
        while True:
            shard_groups = assign_balanced(safe_records, count)
            probes = [
                shard_input(
                    project_map["primary_project"], source_digest, universe_digest, registry,
                    f"shard-{index + 1:04d}", group,
                )
                for index, group in enumerate(shard_groups)
            ]
            if all(serialized_bytes(probe) <= maximum_shard_bytes for probe in probes):
                break
            count += 1
            if count > len(safe_records):
                raise ValueError("semantic shard byte bound cannot contain the prepared context")

    inputs = [
        shard_input(
            project_map["primary_project"], source_digest, universe_digest, registry,
            f"shard-{index + 1:04d}", group,
        )
        for index, group in enumerate(shard_groups)
    ]
    assigned = [record["id"] for value in inputs for record in value["contributions"]]
    if sorted(assigned, key=lambda value: value.encode("utf-8")) != ids \
            or len(assigned) != len(set(assigned)):
        raise ValueError("prepared shard inputs do not form the exact contribution universe")
    manifest = {
        "inputDigest": context["inputDigest"],
        "projectId": project_map["primary_project"],
        "sourceDigest": source_digest,
        "universeDigest": universe_digest,
        "registryDigest": registry["registryDigest"],
        "registryPath": "semantic-registry.json",
        "maximumShardBytes": maximum_shard_bytes,
        "contributionIds": ids,
        "shards": [{
            "id": value["shardId"],
            "inputDigest": value["inputDigest"],
            "contributionIds": [record["id"] for record in value["contributions"]],
            "inputPath": f"inputs/{value['shardId']}.json",
            "proposalPath": f"handoffs/{value['shardId']}.proposals.json",
            "receiptPath": f"records/{value['shardId']}/receipt.json",
        } for value in inputs],
    }
    return {
        "context": context, "registry": registry, "manifest": manifest, "inputs": inputs,
    }


def install_preparation(destination: Path, prepared: dict[str, Any]) -> None:
    literal = Path(os.path.abspath(destination))
    assert_literal_physical_path(literal.parent)
    if literal.exists() or literal.is_symlink():
        raise ValueError("semantic preparation output root already exists and is immutable")
    temporary = literal.parent / f".{literal.name}.{os.getpid()}.tmp"
    if temporary.exists() or temporary.is_symlink():
        raise ValueError("semantic preparation temporary output already exists")
    try:
        (temporary / "inputs").mkdir(parents=True)
        (temporary / "handoffs").mkdir()
        (temporary / "records").mkdir()
        (temporary / "semantic-context.json").write_text(
            json.dumps(prepared["context"], ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        (temporary / "semantic-registry.json").write_text(
            json.dumps(prepared["registry"], ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        (temporary / "shards.json").write_text(
            json.dumps(prepared["manifest"], ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        for value in prepared["inputs"]:
            (temporary / "inputs" / f"{value['shardId']}.json").write_text(
                json.dumps(value, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        os.replace(temporary, literal)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def main() -> None:
    configure_utf8_stdio()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path)
    parser.add_argument("output_root", type=Path)
    parser.add_argument("registry_proposal", type=Path)
    parser.add_argument("--max-shard-bytes", type=int, default=DEFAULT_MAX_SHARD_BYTES)
    args = parser.parse_args()
    if not MIN_MAX_SHARD_BYTES <= args.max_shard_bytes <= MAX_MAX_SHARD_BYTES:
        raise ValueError("max shard bytes is outside the supported bound")
    run = assert_literal_physical_path(args.run).resolve(strict=True)
    if not run.is_dir():
        raise ValueError("run is not a directory")
    registry_proposal = read_object(assert_literal_physical_path(args.registry_proposal))
    prepared = build_preparation(run, args.max_shard_bytes, registry_proposal)
    install_preparation(args.output_root, prepared)
    print(json.dumps({
        "output_root": str(Path(os.path.abspath(args.output_root))),
        "input_digest": prepared["context"]["inputDigest"],
        "registry_digest": prepared["registry"]["registryDigest"],
        "contribution_records": len(prepared["manifest"]["contributionIds"]),
        "shards": len(prepared["manifest"]["shards"]),
        "next": "PAUSE_FOR_BOUNDED_SEMANTIC_WORKERS",
    }))


if __name__ == "__main__":
    main()
