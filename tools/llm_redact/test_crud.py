#!/usr/bin/env python3
"""End-to-end check for explicit Keep and Redact review decisions."""
import argparse
import json
import pathlib
import sys
import urllib.error
import urllib.request

TOOLS_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from oxygen_utf8 import configure_utf8_stdio

DEFAULT_BASE = "http://127.0.0.1:3210"


def call(base_url, path, method="GET", body=None):
    """Return (payload, status). A 4xx is a result here, not a crash -- the
    rejection path is one of the behaviours under test."""
    request = urllib.request.Request(
        base_url + path,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None,
        headers={"content-type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8") or "{}"), response.status
    except urllib.error.HTTPError as error:
        return json.loads(error.read().decode("utf-8") or "{}"), error.code


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=DEFAULT_BASE)
    return parser


def main(argv=None):
    configure_utf8_stdio()
    args = build_parser().parse_args(argv)
    base_url = args.base_url.rstrip("/")
    rows, _ = call(base_url, "/api/redactions")
    pending = [
        row for row in rows["redactions"]
        if row.get("review_state") == "needs_confirmation"
    ]
    if len(pending) < 2:
        print("FAIL: explicit decision check requires two needs_confirmation rows")
        return 1

    keep_target, redact_target = pending[:2]
    kept, keep_status = call(
        base_url,
        f"/api/redactions/{keep_target['id']}",
        "PATCH",
        {"decision": "keep"},
    )
    redacted, redact_status = call(
        base_url,
        f"/api/redactions/{redact_target['id']}",
        "PATCH",
        {"decision": "redact"},
    )
    print(f"Keep -> {kept.get('review_state')} / {kept.get('status')}")
    print(f"Redact -> {redacted.get('review_state')} / {redacted.get('status')}")

    passed = (
        keep_status == 200
        and kept.get("review_state") == "confirmed_keep"
        and kept.get("status") == "removed"
        and redact_status == 200
        and redacted.get("review_state") == "confirmed_redact"
        and redacted.get("status") == "active"
    )
    print("PASS" if passed else "FAIL")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
