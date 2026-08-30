"""Synthetic provider-free Source Privacy receipt fixtures for unit tests."""

from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile

LLM_REDACT_ROOT = Path(__file__).resolve().parents[1]
if str(LLM_REDACT_ROOT) not in sys.path:
    sys.path.insert(0, str(LLM_REDACT_ROOT))

from source_privacy_receipt import (  # noqa: E402
    apply_spans,
    bind_worker_assignment,
    canonical_json,
    canonical_bundle_bytes,
    dialogue_authority,
    finalize_review,
)

EVENT_ID = "evt-" + "a" * 64
TEXT = "safe synthetic text"


def authority(*, source_revision: int = 3, item_count: int = 1) -> dict:
    return {
        "workflowRunId": "workflow-source-privacy",
        "sourceRevision": source_revision,
        "finalizedCorpus": {
            "revision": 2,
            "digest": "c" * 64,
            "documentCount": 1,
            "itemCount": item_count,
        },
        "sourceDigest": "d" * 64,
    }


def bundle(
    *,
    trajectory: str = "traj-1",
    text: str = TEXT,
    event_id: str = EVENT_ID,
) -> dict:
    return bind_worker_assignment({
        "trajectory": trajectory,
        "document_kind": "trajectory",
        "turns": [{
            "event_id": event_id,
            "document_id": trajectory,
            "item_id": event_id,
            "sequence": 1,
            "role": "user",
            "timestamp": "2036-01-01T00:00:00.000Z",
            "text": text,
        }],
        "chars": len(text),
    })


def write_dialogue(root: Path, bundles: list[dict], *, source_revision: int = 3) -> Path:
    root.mkdir()
    records = []
    for value in bundles:
        raw = canonical_bundle_bytes(value)
        (root / f"{value['trajectory']}.json").write_bytes(raw)
        records.append((value, raw))
    source = authority(
        source_revision=source_revision,
        item_count=sum(len(value["turns"]) for value in bundles),
    )
    index = {**source, "dialogue": dialogue_authority(records)}
    (root / "index.json").write_bytes(canonical_bundle_bytes(index))
    return root


def write_findings(
    root: Path,
    bundles: list[dict],
    *,
    findings_by_document: dict[str, list[dict]] | None = None,
) -> Path:
    root.mkdir()
    findings_by_document = findings_by_document or {}
    for value in bundles:
        payload = {
            "trajectory": value["trajectory"],
            "input_digest": value["input_digest"],
            "findings": findings_by_document.get(value["trajectory"], []),
            "reviewed_turns": len(value["turns"]),
        }
        (root / f"{value['trajectory']}.json").write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8",
        )
    return root


def finalized_fixture(
    root: Path,
    *,
    source_revision: int = 3,
    findings: list[dict] | None = None,
) -> tuple[Path, Path, dict, dict]:
    value = bundle()
    dialogue = write_dialogue(root / "dialogue", [value], source_revision=source_revision)
    findings_root = write_findings(
        root / "findings",
        [value],
        findings_by_document={value["trajectory"]: findings or []},
    )
    review = finalize_review(dialogue, findings_root)
    receipt_path = root / "receipt.json"
    receipt_path.write_bytes(canonical_bundle_bytes(review["receipt"]))
    return dialogue, findings_root, review, value


def write_redacted_output(root: Path, review: dict) -> tuple[Path, Path]:
    redacted = root / "redacted"
    redacted.mkdir()
    categories: dict[str, int] = {}
    for source in review["bundles"]:
        output = json.loads(json.dumps(source))
        output.pop("input_digest")
        for turn in output["turns"]:
            spans = review["byDocument"][output["trajectory"]].get(turn["event_id"], [])
            turn["redactions"] = spans
            turn["redacted_text"] = apply_spans(turn["text"], spans)
            for span in spans:
                categories[span["category"]] = categories.get(span["category"], 0) + 1
        (redacted / f"{output['trajectory']}.json").write_bytes(
            canonical_bundle_bytes(output)
        )
    report = root / "report.json"
    report.write_bytes(canonical_bundle_bytes({
        "categories": categories,
        "total_applied": review["receipt"]["redactions"]["count"],
        "rejected": 0,
        "rejects": [],
        "missing_worker_output": [],
        "per_trajectory": [],
        "receiptDigest": review["receipt"]["receiptDigest"],
    }))
    return redacted, report


def unicode_completed_zero_receipt() -> dict:
    with tempfile.TemporaryDirectory(prefix="oxygen-source-privacy-vector-") as temporary:
        root = Path(temporary)
        value = bundle(text="safe synthetic café 🙂")
        dialogue = write_dialogue(root / "dialogue", [value])
        findings = write_findings(root / "findings", [value])
        return finalize_review(dialogue, findings)["receipt"]


if __name__ == "__main__":
    print(canonical_json(unicode_completed_zero_receipt()))
