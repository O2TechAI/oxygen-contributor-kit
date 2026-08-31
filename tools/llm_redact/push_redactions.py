#!/usr/bin/env python3
"""Push redaction spans into a running local viewer.

The viewer stores the ORIGINAL text and overlays these spans at render time, so
an uncertain span can receive an explicit Keep or Redact decision without the
source having been destroyed. Dialogue extraction finalizes each canonical
document/item pair; this script validates and forwards those identities without
rewriting them.
"""
import argparse
import http.client
import json
import pathlib
import re
import sys
import urllib.error
import urllib.request

TOOLS_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from oxygen_utf8 import configure_utf8_stdio
from source_privacy_receipt import (
    REDACTED_TURN_KEYS,
    REDACTION_KEYS,
    TURN_INPUT_KEYS,
    apply_spans,
    assert_literal_physical_path,
    bundle_authority,
    canonical_bundle_bytes,
    canonical_transport_redactions,
    digest_value,
    read_receipt,
    transport_redaction,
    validate_findings,
    validate_receipt,
)


INVALID_ORIGIN_ERROR = (
    "REDACTION_PUSH_INVALID_ORIGIN: expected an explicit local Viewer HTTP origin"
)
REDIRECT_ERROR = "REDACTION_PUSH_REDIRECT_BLOCKED: HTTP redirects are disabled"
LOOPBACK_ORIGIN = re.compile(
    r"http://(?P<host>127\.0\.0\.1|localhost):(?P<port>[1-9][0-9]{0,4})"
)


def validate_base_url(base_url: str) -> str:
    """Return the canonical local Viewer origin or fail without echoing input."""
    if not isinstance(base_url, str):
        raise SystemExit(INVALID_ORIGIN_ERROR)
    match = LOOPBACK_ORIGIN.fullmatch(base_url)
    if match is None or int(match.group("port")) > 65535:
        raise SystemExit(INVALID_ORIGIN_ERROR)
    return base_url


class _RejectRedirects(urllib.request.HTTPRedirectHandler):
    def _blocked(self, request, response, code, message, headers):
        response.close()
        raise SystemExit(REDIRECT_ERROR)

    http_error_301 = _blocked
    http_error_302 = _blocked
    http_error_303 = _blocked
    http_error_307 = _blocked
    http_error_308 = _blocked


def post(base_url: str, body: dict) -> dict:
    base_url = validate_base_url(base_url)
    try:
        request = urllib.request.Request(
            f"{base_url}/api/redactions",
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={"content-type": "application/json"},
            method="POST",
        )
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            _RejectRedirects(),
        )
        with opener.open(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as error:
        is_conflict = error.code == 409
        error.close()
        if is_conflict:
            raise SystemExit("SOURCE_PRIVACY_MUTATION_CONFLICT") from None
        raise SystemExit("SOURCE_PRIVACY_VIEWER_UNAVAILABLE") from None
    except (OSError, UnicodeError, json.JSONDecodeError, http.client.HTTPException):
        raise SystemExit("SOURCE_PRIVACY_VIEWER_UNAVAILABLE") from None


def load_report(
    report_path: pathlib.Path,
    *,
    receipt_digest: str | None = None,
    expected_total: int | None = None,
) -> dict:
    if not report_path.is_file():
        raise _input_error()
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise _input_error() from None
    if not isinstance(report, dict):
        raise _input_error()
    missing = report.get("missing_worker_output")
    if not isinstance(missing, list):
        raise _input_error()
    if missing:
        raise _input_error()
    rejected = report.get("rejected")
    if not isinstance(rejected, int) or isinstance(rejected, bool):
        raise _input_error()
    if rejected != 0:
        raise _input_error()
    if receipt_digest is not None and report.get("receiptDigest") != receipt_digest:
        raise SystemExit("SOURCE_PRIVACY_PUSH_REPORT_MISMATCH")
    if expected_total is not None and report.get("total_applied") != expected_total:
        raise SystemExit("SOURCE_PRIVACY_PUSH_REPORT_MISMATCH")
    return report


def _input_error() -> SystemExit:
    return SystemExit("SOURCE_PRIVACY_PUSH_INPUT_INVALID")


def collect_spans(redacted: pathlib.Path, receipt: dict) -> list[dict]:
    """Rebuild and validate the exact receipt-bound API span set."""
    try:
        receipt = validate_receipt(receipt)
    except ValueError:
        raise _input_error() from None
    try:
        redacted = assert_literal_physical_path(redacted).resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        raise _input_error() from None
    declared = {
        bundle["documentId"]: bundle for bundle in receipt["dialogue"]["bundles"]
    }
    expected_names = sorted(f"{document_id}.json" for document_id in declared)
    try:
        if redacted.is_symlink() or not redacted.is_dir():
            raise _input_error()
        actual_names = sorted(
            path.name for path in redacted.iterdir() if path.suffix == ".json"
        )
    except OSError:
        raise _input_error() from None
    if actual_names != expected_names:
        raise _input_error()

    spans: list[dict] = []
    for authority in receipt["dialogue"]["bundles"]:
        path = redacted / f"{authority['documentId']}.json"
        try:
            raw = assert_literal_physical_path(path).read_bytes()
            bundle = json.loads(raw.decode("utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            raise _input_error() from None
        if (
            not isinstance(bundle, dict)
            or set(bundle) != {"trajectory", "document_kind", "turns", "chars"}
            or canonical_bundle_bytes(bundle) != raw
            or not isinstance(bundle.get("turns"), list)
        ):
            raise _input_error()
        original_turns = []
        bundle_spans: list[dict] = []
        for turn in bundle["turns"]:
            if not isinstance(turn, dict) or set(turn) != REDACTED_TURN_KEYS:
                raise _input_error()
            if not isinstance(turn.get("redactions"), list):
                raise _input_error()
            original_turn = {key: turn[key] for key in TURN_INPUT_KEYS}
            original_turns.append(original_turn)
            findings = []
            for redaction in turn["redactions"]:
                if not isinstance(redaction, dict) or set(redaction) != REDACTION_KEYS:
                    raise _input_error()
                findings.append({"event_id": turn["event_id"], **redaction})
            rejects: list[dict] = []
            by_event = validate_findings(
                findings,
                {turn["event_id"]: original_turn},
                str(bundle.get("trajectory") or ""),
                rejects,
            )
            normalized = by_event.get(turn["event_id"], [])
            if rejects or normalized != turn["redactions"]:
                raise _input_error()
            if (
                not isinstance(turn.get("redacted_text"), str)
                or turn["redacted_text"] != apply_spans(turn["text"], normalized)
            ):
                raise _input_error()
            bundle_spans.extend(
                transport_redaction(original_turn, redaction) for redaction in normalized
            )
        original_bundle = {
            **bundle,
            "turns": original_turns,
            "input_digest": authority["inputDigest"],
        }
        try:
            actual_authority = bundle_authority(
                original_bundle, canonical_bundle_bytes(original_bundle),
            )
        except ValueError:
            raise _input_error() from None
        if actual_authority != authority:
            raise _input_error()
        spans.extend(bundle_spans)
    spans = canonical_transport_redactions(spans)
    if (
        receipt["redactions"]["count"] != len(spans)
        or receipt["redactions"]["digest"] != digest_value(spans)
    ):
        raise _input_error()
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
    parser.add_argument("--receipt", type=pathlib.Path, required=True)
    parser.add_argument(
        "--report",
        type=pathlib.Path,
        help="merge report (default: the parent of --redacted/report.json)",
    )
    args = parser.parse_args()

    base_url = validate_base_url(args.base_url)
    try:
        receipt = read_receipt(args.receipt)
    except ValueError:
        raise SystemExit("SOURCE_PRIVACY_PUSH_RECEIPT_INVALID") from None
    spans = collect_spans(args.redacted, receipt)
    report = load_report(
        args.report or args.redacted.parent / "report.json",
        receipt_digest=receipt["receiptDigest"],
        expected_total=len(spans),
    )

    result = post(base_url, {
        "replaceAll": True,
        "job": {"status": "complete", "stage": "已完成", "model": args.model,
                "total": len(spans), "rejected": report["rejected"]},
        "redactions": spans,
        "receipt": receipt,
    })
    result = validate_push_result(result, len(spans))
    print(json.dumps({"sent": len(spans), **result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
