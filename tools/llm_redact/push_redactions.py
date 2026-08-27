#!/usr/bin/env python3
"""Push redaction spans into a running local viewer.

The viewer stores the ORIGINAL text and overlays these spans at render time, so
a reviewer can change a category or delete a decision without the source having
been destroyed. Dialogue extraction finalizes each canonical document/item pair;
this script validates and forwards those identities without rewriting them.
"""
import argparse
import json
import pathlib
import re
import sys
import urllib.request

TOOLS_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from oxygen_utf8 import configure_utf8_stdio


DOCUMENT_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,254}")
TRAJECTORY_ITEM_ID = re.compile(r"evt-[0-9a-f]{64}")
MEETING_ITEM_COMPONENT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,254}")
MEETING_FALLBACK_ITEM = re.compile(r"rec-[0-9a-f]{64}")


def post(base_url: str, path: str, body: dict) -> dict:
    request = urllib.request.Request(
        f"{base_url}{path}",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8") or "{}")


def load_report(report_path: pathlib.Path) -> dict:
    if not report_path.is_file():
        raise SystemExit(
            f"redaction report not found: {report_path}; "
            "run merge_and_apply.py before pushing"
        )
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"cannot read redaction report {report_path}: {error}") from error
    if not isinstance(report, dict):
        raise SystemExit(f"invalid redaction report {report_path}: expected an object")
    missing = report.get("missing_worker_output")
    if not isinstance(missing, list):
        raise SystemExit(
            f"invalid redaction report {report_path}: missing_worker_output must be a list"
        )
    if missing:
        raise SystemExit(
            "redaction coverage is incomplete; missing worker output for: "
            + ", ".join(map(str, missing))
        )
    rejected = report.get("rejected")
    if not isinstance(rejected, int) or isinstance(rejected, bool):
        raise SystemExit(f"invalid redaction report {report_path}: rejected must be an integer")
    if rejected != 0:
        raise SystemExit(
            f"redaction merge rejected {rejected} finding(s); refusing to push"
        )
    return report


def _identity_error(path: pathlib.Path, message: str) -> SystemExit:
    return SystemExit(f"invalid redaction identity in {path}: {message}")


def collect_spans(redacted: pathlib.Path) -> list[dict]:
    """Validate every bundle before returning the canonical API spans."""
    spans = []
    seen_item_ids: set[str] = set()
    bundles = [p for p in sorted(redacted.glob("*.json")) if p.name != "index.json"]
    if not bundles:
        raise SystemExit(f"no redacted bundles found in {redacted}")

    for path in bundles:
        try:
            bundle = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise SystemExit(f"cannot read redacted bundle {path}: {error}") from error
        if not isinstance(bundle, dict):
            raise _identity_error(path, "bundle must be an object")
        trajectory = bundle.get("trajectory")
        if not isinstance(trajectory, str) or not DOCUMENT_ID.fullmatch(trajectory):
            raise _identity_error(path, "trajectory is missing or invalid")
        if path.stem != trajectory:
            raise _identity_error(path, "bundle trajectory does not match its filename")
        document_kind = bundle.get("document_kind")
        if document_kind not in {"trajectory", "meeting"}:
            raise _identity_error(path, "document_kind must be trajectory or meeting")
        turns = bundle.get("turns")
        if not isinstance(turns, list):
            raise _identity_error(path, "turns must be a list")

        seen_event_ids: set[str] = set()
        for turn in turns:
            if not isinstance(turn, dict):
                raise _identity_error(path, "turn must be an object")
            event_id = turn.get("event_id")
            document_id = turn.get("document_id")
            item_id = turn.get("item_id")
            if not isinstance(event_id, str) or not event_id:
                raise _identity_error(path, "turn event_id is missing or invalid")
            if event_id in seen_event_ids:
                raise _identity_error(path, f"duplicate event_id {event_id}")
            seen_event_ids.add(event_id)
            if not isinstance(document_id, str) or not DOCUMENT_ID.fullmatch(document_id):
                raise _identity_error(path, f"turn {event_id} document_id is missing or invalid")
            if document_id != trajectory:
                raise _identity_error(path, f"turn {event_id} belongs to a different document")
            if not isinstance(item_id, str):
                raise _identity_error(path, f"turn {event_id} item_id is missing or invalid")

            if document_kind == "trajectory":
                if not TRAJECTORY_ITEM_ID.fullmatch(item_id) or item_id != event_id:
                    raise _identity_error(path, f"turn {event_id} has a forged trajectory item_id")
            else:
                prefix = f"{document_id}:"
                if not item_id.startswith(prefix):
                    raise _identity_error(path, f"turn {event_id} has a forged meeting item_id")
                component = item_id[len(prefix):]
                if not MEETING_ITEM_COMPONENT.fullmatch(component):
                    raise _identity_error(path, f"turn {event_id} meeting item_id has invalid grammar")
                if component != event_id and not MEETING_FALLBACK_ITEM.fullmatch(component):
                    raise _identity_error(path, f"turn {event_id} has a forged meeting item_id")

            if item_id in seen_item_ids:
                raise _identity_error(path, f"duplicate item_id {item_id}")
            seen_item_ids.add(item_id)
            redactions = turn.get("redactions", [])
            if not isinstance(redactions, list):
                raise _identity_error(path, f"turn {event_id} redactions must be a list")
            for span in redactions:
                if not isinstance(span, dict):
                    raise _identity_error(path, f"turn {event_id} redaction must be an object")
                try:
                    start = span["start"]
                    end = span["end"]
                    category = span["category"]
                except KeyError as error:
                    raise _identity_error(
                        path, f"turn {event_id} redaction is missing {error.args[0]}"
                    ) from error
                spans.append({
                    "itemId": item_id,
                    "documentId": document_id,
                    "startOffset": start,
                    "endOffset": end,
                    "category": category,
                    "confidence": span.get("confidence"),
                    "reason": span.get("reason"),
                    "createdBy": "llm",
                })
    return spans


def validate_push_result(result: object, expected_imported: int) -> dict:
    if not isinstance(result, dict):
        raise SystemExit("redaction push failed: response must be an object")
    imported = result.get("imported")
    status = result.get("status")
    rejected = result.get("rejected")
    if not isinstance(imported, int) or isinstance(imported, bool) \
            or imported != expected_imported:
        raise SystemExit(
            "redaction push failed: imported count does not match submitted spans"
        )
    if status != "complete":
        raise SystemExit("redaction push failed: response status is not complete")
    if not isinstance(rejected, list) or rejected:
        raise SystemExit("redaction push failed: response contains rejected spans")
    return result


def main() -> int:
    configure_utf8_stdio()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--redacted", type=pathlib.Path, required=True)
    parser.add_argument("--base-url", default="http://127.0.0.1:3210")
    parser.add_argument("--model", default="claude-sonnet-5")
    parser.add_argument(
        "--report",
        type=pathlib.Path,
        help="merge report (default: the parent of --redacted/report.json)",
    )
    args = parser.parse_args()

    report = load_report(args.report or args.redacted.parent / "report.json")
    spans = collect_spans(args.redacted)

    result = post(args.base_url, "/api/redactions", {
        "replaceAll": True,
        "job": {"status": "complete", "stage": "已完成", "model": args.model,
                "total": len(spans), "rejected": report["rejected"]},
        "redactions": spans,
    })
    result = validate_push_result(result, len(spans))
    print(json.dumps({"sent": len(spans), **result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
