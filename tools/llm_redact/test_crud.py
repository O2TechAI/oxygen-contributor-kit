#!/usr/bin/env python3
"""End-to-end check that a reviewer can edit and delete a redaction decision."""
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


def active_count(base_url):
    return len(call(base_url, "/api/redactions")[0]["redactions"])


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=DEFAULT_BASE)
    return parser


def main(argv=None):
    configure_utf8_stdio()
    args = build_parser().parse_args(argv)
    base_url = args.base_url.rstrip("/")
    before = active_count(base_url)
    target = call(base_url, "/api/redactions")[0]["redactions"][0]
    print(f"起始 active={before}  样本={target['id'][:8]}  类别={target['category']}")

    new_category = "sensitive" if target["category"] != "sensitive" else "credential"
    patched, _ = call(
        base_url, f"/api/redactions/{target['id']}", "PATCH", {"category": new_category}
    )
    print(f"PATCH 改类别 -> {patched['category']}  (期望 {new_category})  "
          f"created_by={patched['created_by']}")

    call(base_url, f"/api/redactions/{target['id']}", "DELETE")
    after_delete = active_count(base_url)
    print(f"DELETE 软删 -> active={after_delete}  (期望 {before - 1})")

    call(base_url, f"/api/redactions/{target['id']}", "PATCH", {"status": "active"})
    restored = active_count(base_url)
    print(f"PATCH 恢复 -> active={restored}  (期望 {before})")

    call(base_url, f"/api/redactions/{target['id']}", "PATCH", {"category": target["category"]})

    bad, bad_status = call(
        base_url,
        f"/api/redactions/{target['id']}",
        "PATCH",
        {"category": "not-a-category"},
    )
    print(f"非法类别被拒: HTTP {bad_status} · {bad.get('error')}")

    missing, missing_status = call(
        base_url, "/api/redactions/does-not-exist", "DELETE"
    )
    print(f"删除不存在的记录: HTTP {missing_status} · {missing.get('error')}")

    passed = (
        patched["category"] == new_category
        and after_delete == before - 1
        and restored == before
        and bad_status == 400
        and missing_status == 404
    )
    print("PASS" if passed else "FAIL")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
