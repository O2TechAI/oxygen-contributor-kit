#!/usr/bin/env python3
"""Validate one bounded worker proposal file and create its terminal receipt."""
from __future__ import annotations

import argparse
import errno
import json
from pathlib import Path
import shutil
import sys
import tempfile

from build_project_map import (
    assert_literal_physical_path,
    atomic_write_json,
    digest,
    read_object,
)
from finalize_semantic_units import (
    MANIFEST_KEYS,
    SEMANTIC_WORKER_MAPPING_INVALID,
    SHARD_ID,
    SHARD_KEYS,
    contained_relative,
    proposal,
    stable_id,
)
from prepare_semantic_units import safe_record, semantic_registry

TOOLS_ROOT = Path(__file__).resolve().parents[3] / "tools"
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from oxygen_utf8 import configure_utf8_stdio
from atomic_rename import rename_noreplace


def _validate_installed_pair(directory: Path, output: dict, receipt: dict) -> None:
    try:
        assert_literal_physical_path(directory)
        if not directory.is_dir() or {entry.name for entry in directory.iterdir()} != {
            "output.json", "receipt.json",
        }:
            raise ValueError
        output_path = assert_literal_physical_path(directory / "output.json")
        receipt_path = assert_literal_physical_path(directory / "receipt.json")
        if read_object(output_path) != output or read_object(receipt_path) != receipt:
            raise ValueError
    except (OSError, RuntimeError, ValueError):
        raise ValueError(
            f"immutable semantic worker artifact already differs: {directory}"
        ) from None


def install_pair(root: Path, shard_id: str, output: dict, receipt: dict) -> None:
    if not isinstance(shard_id, str) or SHARD_ID.fullmatch(shard_id) is None:
        raise ValueError("semantic worker shard identity is invalid")
    records = assert_literal_physical_path(root / "records")
    if not records.is_dir():
        raise ValueError("semantic worker record root is invalid")
    destination = records / shard_id
    if destination.parent != records:
        raise ValueError("semantic worker record path leaves the explicit output root")
    if destination.exists() or destination.is_symlink():
        _validate_installed_pair(destination, output, receipt)
        return
    stage = Path(tempfile.mkdtemp(prefix=f".{shard_id}.", suffix=".tmp", dir=records))
    try:
        atomic_write_json(stage / "output.json", output)
        atomic_write_json(stage / "receipt.json", receipt)
        try:
            rename_noreplace(stage, destination)
        except OSError as error:
            if error.errno not in {errno.EEXIST, errno.EACCES, errno.ENOTEMPTY}:
                raise
            _validate_installed_pair(destination, output, receipt)
    finally:
        if stage.exists() or stage.is_symlink():
            shutil.rmtree(stage)


def record(root: Path, shard_id: str, proposal_path: Path) -> dict:
    if not isinstance(shard_id, str) or SHARD_ID.fullmatch(shard_id) is None:
        raise ValueError("semantic worker shard identity is invalid")
    manifest = read_object(contained_relative(root, "shards.json"))
    if (
        not isinstance(manifest, dict)
        or set(manifest) != MANIFEST_KEYS
        or not isinstance(manifest.get("shards"), list)
    ):
        raise ValueError("semantic shard manifest is invalid")
    matches = [shard for shard in manifest.get("shards", []) if shard.get("id") == shard_id]
    if len(matches) != 1:
        raise ValueError("semantic worker shard identity is foreign or duplicated")
    shard = matches[0]
    contribution_ids = shard.get("contributionIds")
    registry_path = manifest.get("registryPath")
    if registry_path != "semantic-registry.json":
        raise ValueError("semantic registry path authority is invalid")
    registry = read_object(contained_relative(root, registry_path))
    if (
        registry != semantic_registry(
            manifest.get("projectId"), manifest.get("sourceDigest"),
            manifest.get("universeDigest"), {"units": registry.get("units")},
        )
        or registry.get("registryDigest") != manifest.get("registryDigest")
    ):
        raise ValueError("semantic registry is stale or tampered")
    expected_input_path = f"inputs/{shard_id}.json"
    expected_proposal_relative = f"handoffs/{shard_id}.proposals.json"
    expected_receipt_path = f"records/{shard_id}/receipt.json"
    if (
        not isinstance(shard, dict)
        or set(shard) != SHARD_KEYS
        or not isinstance(contribution_ids, list)
        or not contribution_ids
        or any(not stable_id(member) for member in contribution_ids)
        or contribution_ids != sorted(contribution_ids, key=lambda item: item.encode("utf-8"))
        or len(contribution_ids) != len(set(contribution_ids))
        or shard.get("inputPath") != expected_input_path
        or shard.get("proposalPath") != expected_proposal_relative
        or shard.get("receiptPath") != expected_receipt_path
    ):
        raise ValueError("semantic shard manifest entry is invalid")
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
        or input_value.get("inputDigest") != shard.get("inputDigest")
        or digest(input_core) != shard.get("inputDigest")
        or input_value.get("registry") != registry
        or not isinstance(input_value.get("contributions"), list)
        or [record.get("id") for record in input_value["contributions"]] != contribution_ids
        or any(safe_record(record) != record for record in input_value["contributions"])
    ):
        raise ValueError("semantic shard input is stale or tampered")
    expected_proposal_path = assert_literal_physical_path(
        root.joinpath(*expected_proposal_relative.split("/")),
        allow_missing_leaf=True,
    )
    supplied_proposal_path = assert_literal_physical_path(proposal_path)
    try:
        same_proposal = supplied_proposal_path.samefile(expected_proposal_path)
    except OSError:
        same_proposal = False
    if not same_proposal:
        raise ValueError("semantic worker proposal path is not canonical")
    expected_proposal_path = contained_relative(
        root, expected_proposal_relative
    )
    assigned = set(contribution_ids)
    try:
        raw = json.loads(expected_proposal_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise ValueError(SEMANTIC_WORKER_MAPPING_INVALID) from None
    if not isinstance(raw, list):
        raise ValueError(SEMANTIC_WORKER_MAPPING_INVALID)
    owned: set[str] = set()
    registry_by_id = {unit["unitId"]: unit for unit in registry["units"]}
    for value in raw:
        normalized = proposal(value, assigned, registry_by_id)
        if owned.intersection(normalized["members"]):
            raise ValueError(SEMANTIC_WORKER_MAPPING_INVALID)
        owned.update(normalized["members"])
    if owned != assigned:
        raise ValueError(SEMANTIC_WORKER_MAPPING_INVALID)
    output = {
        "shardId": shard_id,
        "inputDigest": shard["inputDigest"],
        "proposals": raw,
    }
    receipt = {
        "status": "complete",
        "shardId": shard_id,
        "inputDigest": shard["inputDigest"],
        "contributionIds": shard["contributionIds"],
        "outputPath": f"records/{shard_id}/output.json",
        "outputDigest": digest(output),
        "outputCount": len(raw),
    }
    install_pair(root, shard_id, output, receipt)
    return receipt


def main() -> None:
    configure_utf8_stdio()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("semantic_output_root", type=Path)
    parser.add_argument("shard_id")
    parser.add_argument("proposal_file", type=Path)
    args = parser.parse_args()
    root = assert_literal_physical_path(args.semantic_output_root)
    proposal_path = assert_literal_physical_path(args.proposal_file)
    receipt = record(root, args.shard_id, proposal_path)
    print(json.dumps({
        "shard": receipt["shardId"],
        "status": receipt["status"],
        "output_digest": receipt["outputDigest"],
        "output_count": receipt["outputCount"],
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        if isinstance(error, ValueError) and str(error) == SEMANTIC_WORKER_MAPPING_INVALID:
            raise SystemExit(SEMANTIC_WORKER_MAPPING_INVALID) from None
        raise SystemExit("SEMANTIC_WORKER_RECORD_INVALID") from None
