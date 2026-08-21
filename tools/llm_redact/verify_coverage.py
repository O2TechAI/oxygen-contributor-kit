#!/usr/bin/env python3
"""Cross-check each worker's self-reported turn count against the source.

A worker that reports a count it did not actually review makes coverage
unverifiable, so this runs as a gate rather than as a nicety.
"""
import argparse
import glob
import json
import os
import os.path
import pathlib


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dialogue", type=pathlib.Path, required=True)
    parser.add_argument("--findings", type=pathlib.Path, required=True)
    args = parser.parse_args()

    source = {}
    for path in glob.glob(str(args.dialogue / "*.json")):
        if os.path.basename(path) == "index.json":
            continue
        bundle = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
        source[bundle["trajectory"]] = len(bundle["turns"])
    if not source:
        print(f"no dialogue bundles found in {args.dialogue}")
        return 1

    mismatched = 0
    reviewed = set()
    for path in sorted(glob.glob(str(args.findings / "*.json"))):
        if os.path.basename(path) == "index.json":
            continue
        traj = os.path.basename(path)[:-5]
        reviewed.add(traj)
        reported = json.loads(pathlib.Path(path).read_text(encoding="utf-8")).get("reviewed_turns")
        actual = source.get(traj)
        if reported != actual:
            mismatched += 1
            print(f"  MISMATCH {traj}  reported={reported}  actual={actual}")

    missing = sorted(set(source) - reviewed)
    unexpected = sorted(reviewed - set(source))
    for traj in missing:
        print(f"  MISSING {traj}  no worker findings file")
    for traj in unexpected:
        print(f"  UNEXPECTED {traj}  no matching dialogue bundle")

    failures = mismatched + len(missing) + len(unexpected)
    print(
        f"{len(source)} trajectories expected, {len(reviewed)} findings files, "
        f"{mismatched} mismatched, {len(missing)} missing, "
        f"{len(unexpected)} unexpected"
    )
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
