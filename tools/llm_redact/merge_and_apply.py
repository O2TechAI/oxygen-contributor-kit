#!/usr/bin/env python3
"""Merge sub-agent redaction findings, validate them, and apply the tags.

Validation is deliberately strict: a worker model that hallucinates an offset,
an unknown category, or an overlapping span must not be able to corrupt the
release candidate. Any rejected finding fails the whole receipt-bound merge
before output publication.

Reads   work/<dialogue>/  (immutable source text)
        work/<findings>/  (one JSON per trajectory, from the workers)
Writes  work/<out>/redacted/<traj>.json   tagged turns
        work/<out>/report.json            per-category counts + rejects
"""
import argparse
import copy
import json
import os
import pathlib
import shutil
import sys
import tempfile

TOOLS_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from oxygen_utf8 import configure_utf8_stdio
from atomic_rename import rename_noreplace
try:
    from .source_privacy_receipt import (
        ALLOWED_CATEGORIES,
        REVIEW_STATES,
        apply_spans,
        assert_literal_physical_path,
        canonical_bundle_bytes,
        finalize_review,
        read_receipt,
        validate_findings,
    )
except ImportError:
    from source_privacy_receipt import (
        ALLOWED_CATEGORIES,
        REVIEW_STATES,
        apply_spans,
        assert_literal_physical_path,
        canonical_bundle_bytes,
        finalize_review,
        read_receipt,
        validate_findings,
    )

ALLOWED = ALLOWED_CATEGORIES

def validate(findings, turns_by_id, traj, rejects):
    """Return findings that are safe to apply, grouped by event_id."""
    return validate_findings(findings, turns_by_id, traj, rejects)

def main() -> int:
    configure_utf8_stdio()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dialogue", type=pathlib.Path, required=True)
    parser.add_argument("--findings", type=pathlib.Path, required=True)
    parser.add_argument("--out", type=pathlib.Path, required=True)
    parser.add_argument("--receipt", type=pathlib.Path, required=True)
    args = parser.parse_args()

    try:
        receipt = read_receipt(args.receipt)
        review = finalize_review(args.dialogue, args.findings)
    except (OSError, RuntimeError, ValueError):
        raise SystemExit("SOURCE_PRIVACY_MERGE_INVALID") from None
    if review["receipt"] != receipt:
        raise SystemExit("SOURCE_PRIVACY_MERGE_RECEIPT_MISMATCH")
    try:
        literal_out = assert_literal_physical_path(args.out, allow_missing_leaf=True)
    except ValueError:
        raise SystemExit("SOURCE_PRIVACY_MERGE_OUTPUT_INVALID") from None
    if literal_out.exists() or literal_out.is_symlink():
        raise SystemExit("SOURCE_PRIVACY_MERGE_OUTPUT_EXISTS")
    try:
        temporary = pathlib.Path(tempfile.mkdtemp(
            prefix=f".{literal_out.name}.", suffix=".tmp", dir=literal_out.parent,
        ))
    except OSError:
        raise SystemExit("SOURCE_PRIVACY_MERGE_OUTPUT_INVALID") from None
    redacted_dir = temporary / "redacted"
    counts, per_traj = {}, []
    try:
        redacted_dir.mkdir()
        for source_bundle in review["bundles"]:
            bundle = copy.deepcopy(source_bundle)
            bundle.pop("input_digest")
            traj = bundle["trajectory"]
            by_event = review["byDocument"][traj]
            applied = 0
            for turn in bundle["turns"]:
                spans = by_event.get(turn["event_id"], [])
                turn["redactions"] = spans
                turn["redacted_text"] = (
                    apply_spans(turn["text"], spans) if spans else turn["text"]
                )
                for span in spans:
                    counts[span["category"]] = counts.get(span["category"], 0) + 1
                    applied += 1
            with (redacted_dir / f"{traj}.json").open("xb") as handle:
                handle.write(canonical_bundle_bytes(bundle))
            per_traj.append({
                "trajectory": traj, "turns": len(bundle["turns"]), "applied": applied,
            })

        report = {
            "categories": counts,
            "total_applied": sum(counts.values()),
            "rejected": 0,
            "rejects": [],
            "missing_worker_output": [],
            "per_trajectory": per_traj,
            "receiptDigest": receipt["receiptDigest"],
        }
        with (temporary / "report.json").open("xb") as handle:
            handle.write(canonical_bundle_bytes(report))
        try:
            rename_noreplace(temporary, literal_out)
        except FileExistsError:
            raise SystemExit("SOURCE_PRIVACY_MERGE_OUTPUT_EXISTS") from None
    except OSError:
        raise SystemExit("SOURCE_PRIVACY_MERGE_OUTPUT_INVALID") from None
    finally:
        if temporary.exists():
            try:
                shutil.rmtree(temporary)
            except OSError:
                raise SystemExit("SOURCE_PRIVACY_MERGE_OUTPUT_INVALID") from None
    print(json.dumps({k: report[k] for k in
                      ("categories", "total_applied", "rejected",
                       "missing_worker_output")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
