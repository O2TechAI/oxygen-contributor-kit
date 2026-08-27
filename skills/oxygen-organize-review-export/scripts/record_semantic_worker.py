#!/usr/bin/env python3
"""Validate one bounded worker proposal file and create its terminal receipt."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from build_project_map import assert_literal_physical_path, atomic_write_json, digest, read_object
from finalize_semantic_units import contained_relative, proposal

TOOLS_ROOT = Path(__file__).resolve().parents[3] / "tools"
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from oxygen_utf8 import configure_utf8_stdio


def install_exact(path: Path, value) -> None:
    if path.exists() or path.is_symlink():
        if read_object(path) != value:
            raise ValueError(f"immutable semantic worker artifact already differs: {path}")
        return
    atomic_write_json(path, value)


def record(root: Path, shard_id: str, proposal_path: Path) -> dict:
    manifest = read_object(contained_relative(root, "shards.json"))
    matches = [shard for shard in manifest.get("shards", []) if shard.get("id") == shard_id]
    if len(matches) != 1:
        raise ValueError("semantic worker shard identity is foreign or duplicated")
    shard = matches[0]
    assigned = set(shard["contributionIds"])
    raw = json.loads(proposal_path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise ValueError("semantic worker proposal file must contain one JSON array")
    owned: set[str] = set()
    for value in raw:
        normalized = proposal(value, assigned)
        if owned.intersection(normalized["members"]):
            raise ValueError("semantic worker proposals overlap within a shard")
        owned.update(normalized["members"])
    if owned != assigned:
        raise ValueError("semantic worker proposals do not cover the exact shard")
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
        "outputPath": f"outputs/{shard_id}.json",
        "outputDigest": digest(output),
        "outputCount": len(raw),
    }
    install_exact(root / "outputs" / f"{shard_id}.json", output)
    install_exact(root / "receipts" / f"{shard_id}.json", receipt)
    return receipt


def main() -> None:
    configure_utf8_stdio()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("semantic_output_root", type=Path)
    parser.add_argument("shard_id")
    parser.add_argument("proposal_file", type=Path)
    args = parser.parse_args()
    root = assert_literal_physical_path(args.semantic_output_root).resolve(strict=True)
    proposal_path = assert_literal_physical_path(args.proposal_file).resolve(strict=True)
    receipt = record(root, args.shard_id, proposal_path)
    print(json.dumps({
        "shard": receipt["shardId"],
        "status": receipt["status"],
        "output_digest": receipt["outputDigest"],
        "output_count": receipt["outputCount"],
    }))


if __name__ == "__main__":
    main()
