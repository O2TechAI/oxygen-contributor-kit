#!/usr/bin/env python3
"""Extract only normalized message events from a prepared AI review run.

Fixed action labels are skipped entirely. Output is one JSON file per
trajectory, ready to hand to a sub-agent in a single request.
"""
import argparse
import json
import os
import pathlib
import shutil
import sys
import tempfile
import urllib.request

TOOLS_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))
LLM_REDACT_ROOT = pathlib.Path(__file__).resolve().parent
if str(LLM_REDACT_ROOT) not in sys.path:
    sys.path.insert(0, str(LLM_REDACT_ROOT))

from oxygen_utf8 import configure_utf8_stdio
from atomic_rename import rename_noreplace
from ingest.human_source_projection import (
    meeting_contribution_ids,
)
from prepare_ai_review_run import (
    AI_REVIEW_EVENT_SCHEMA,
    AI_REVIEW_MEETING_SCHEMA,
    AI_REVIEW_TRAJECTORY_SCHEMA,
    POLICY_ID,
    digest_events,
    discover_meetings,
    validated_trajectory,
)
from push_redactions import _RejectRedirects, validate_base_url
from source_privacy_receipt import (
    SOURCE_AUTHORITY_KEYS,
    assert_literal_physical_path,
    canonical_bundle_bytes,
    dialogue_authority,
    validate_source_authority,
)

KEEP_EVENT_TYPE = "message"


def extract_one(traj_dir: pathlib.Path) -> dict:
    turns = []
    document_id = traj_dir.name
    events_path = traj_dir / "events.jsonl"
    _, events, _ = validated_trajectory(
        events_path,
        manifest_schema=AI_REVIEW_TRAJECTORY_SCHEMA,
        event_schema=AI_REVIEW_EVENT_SCHEMA,
    )
    for index, event in enumerate(events, 1):
        if event.get("event_type") != KEEP_EVENT_TYPE:
            continue
        payload = event.get("payload") or {}
        text = payload.get("text") or ""
        if not text.strip():
            continue
        item_id = event.get("event_id")
        turns.append({
            "event_id": event.get("event_id"),
            "document_id": document_id,
            "item_id": item_id,
            "sequence": event.get("sequence", index),
            "role": payload.get("role"),
            "timestamp": event.get("timestamp"),
            "text": text,
        })
    turns.sort(key=lambda turn: (turn["sequence"], turn["item_id"].encode("utf-8")))
    return {"trajectory": document_id, "document_kind": "trajectory", "turns": turns,
            "chars": sum(len(t["text"]) for t in turns)}


def extract_meeting(dataset: dict, meeting_id: str) -> dict | None:
    records = dataset.get("records") or []
    try:
        item_ids = meeting_contribution_ids(meeting_id, records)
    except ValueError as error:
        raise SystemExit(f"invalid meeting contribution identity: {error}") from error
    turns = []
    for index, (record, item_id) in enumerate(zip(records, item_ids), 1):
        if not isinstance(record, dict):
            continue
        text = record.get("text")
        if not isinstance(text, str) or not text.strip():
            continue
        turns.append({
            "event_id": item_id,
            "document_id": meeting_id,
            "item_id": item_id,
            "sequence": record.get("sequence_in_meeting") or record.get("order") or index,
            "role": "user",
            "timestamp": record.get("timestamp") or record.get("started_at"),
            "text": text,
        })
    if not turns:
        return None
    turns.sort(key=lambda turn: (turn["sequence"], turn["item_id"].encode("utf-8")))
    return {
        "trajectory": meeting_id,
        "document_kind": "meeting",
        "turns": turns,
        "chars": sum(len(turn["text"]) for turn in turns),
    }


def extract_bundles(run: pathlib.Path) -> list[dict]:
    try:
        run = assert_literal_physical_path(run).resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        raise SystemExit("SOURCE_PRIVACY_DIALOGUE_INPUT_INVALID") from None
    bundles = []
    trajectories = run / "trajectories"
    if trajectories.exists() or trajectories.is_symlink():
        try:
            trajectories = assert_literal_physical_path(trajectories).resolve(strict=True)
            trajectory_dirs = sorted(trajectories.iterdir())
            for traj_dir in trajectory_dirs:
                if not traj_dir.is_dir():
                    continue
                traj_dir = assert_literal_physical_path(traj_dir).resolve(strict=True)
                assert_literal_physical_path(traj_dir / "manifest.json")
                assert_literal_physical_path(traj_dir / "events.jsonl")
                bundles.append(extract_one(traj_dir))
        except (OSError, RuntimeError, ValueError):
            raise SystemExit("SOURCE_PRIVACY_DIALOGUE_INPUT_INVALID") from None
    for meeting in discover_meetings(
        run,
        expected_schema=AI_REVIEW_MEETING_SCHEMA,
        require_review_identity=True,
    ):
        bundle = extract_meeting(meeting["dataset"], meeting["source_meeting_id"])
        if bundle:
            bundles.append(bundle)
    return sorted(bundles, key=lambda bundle: bundle["trajectory"].encode("utf-8"))


def fetch_source_authority(base_url: str, workflow_run_id: str) -> dict:
    origin = validate_base_url(base_url)
    request = urllib.request.Request(
        f"{origin}/api/redactions?sourceAuthority=1",
        headers={"accept": "application/json"},
        method="GET",
    )
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        _RejectRedirects(),
    )
    try:
        with opener.open(request, timeout=60) as response:
            payload = json.loads(response.read().decode("utf-8") or "{}")
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise SystemExit("SOURCE_PRIVACY_AUTHORITY_UNAVAILABLE") from error
    try:
        if not isinstance(payload, dict) or set(payload) != {"sourceAuthority"}:
            raise ValueError
        authority = validate_source_authority(payload["sourceAuthority"])
    except ValueError:
        raise SystemExit("SOURCE_PRIVACY_AUTHORITY_INVALID") from None
    if authority["workflowRunId"] != workflow_run_id:
        raise SystemExit("SOURCE_PRIVACY_AUTHORITY_FOREIGN")
    return authority


def install_dialogue_output(out: pathlib.Path, authority: dict, bundles: list[dict]) -> None:
    try:
        records = [(bundle, canonical_bundle_bytes(bundle)) for bundle in bundles]
        dialogue = dialogue_authority(records)
    except (TypeError, ValueError):
        raise SystemExit("SOURCE_PRIVACY_DIALOGUE_INVALID") from None
    document_names = [f"{bundle['trajectory']}.json" for bundle in bundles]
    folded_names = [name.casefold() for name in document_names]
    if ("index.json" in folded_names
            or len(folded_names) != len(set(folded_names))):
        raise SystemExit("SOURCE_PRIVACY_DIALOGUE_IDENTITY_CONFLICT")
    try:
        literal = assert_literal_physical_path(out, allow_missing_leaf=True)
    except ValueError:
        raise SystemExit("SOURCE_PRIVACY_DIALOGUE_OUTPUT_INVALID") from None
    if literal.exists() or literal.is_symlink():
        raise SystemExit("SOURCE_PRIVACY_DIALOGUE_OUTPUT_EXISTS")
    temporary = pathlib.Path(tempfile.mkdtemp(
        prefix=f".{literal.name}.", suffix=".tmp", dir=literal.parent,
    ))
    try:
        for bundle, raw in records:
            with (temporary / f"{bundle['trajectory']}.json").open("xb") as handle:
                handle.write(raw)
        index = {
            **{key: authority[key] for key in SOURCE_AUTHORITY_KEYS},
            "dialogue": dialogue,
        }
        with (temporary / "index.json").open("xb") as handle:
            handle.write(canonical_bundle_bytes(index))
        rename_noreplace(temporary, literal)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def main() -> int:
    configure_utf8_stdio()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=pathlib.Path)
    parser.add_argument("--out", type=pathlib.Path, required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--workflow-run-id", required=True)
    args = parser.parse_args()

    authority = fetch_source_authority(args.base_url, args.workflow_run_id)
    bundles = extract_bundles(args.run)
    bundles = [bundle for bundle in bundles if bundle["turns"]]
    if not bundles:
        raise SystemExit(f"no conversational turns found in {args.run}")
    install_dialogue_output(args.out, authority, bundles)
    total = sum(bundle["chars"] for bundle in bundles)
    print(json.dumps({"trajectories": len(bundles),
                      "turns": sum(len(bundle["turns"]) for bundle in bundles),
                      "chars": total}, ensure_ascii=False))
    for bundle in sorted(bundles, key=lambda value: -value["chars"]):
        print(
            f"  {bundle['trajectory']}  turns={len(bundle['turns']):4d}  "
            f"chars={bundle['chars']:7d}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
