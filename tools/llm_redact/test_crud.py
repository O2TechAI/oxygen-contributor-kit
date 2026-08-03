#!/usr/bin/env python3
"""End-to-end check that a reviewer can edit and delete a redaction decision."""
import json
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:3210"


def call(path, method="GET", body=None):
    """Return (payload, status). A 4xx is a result here, not a crash -- the
    rejection path is one of the behaviours under test."""
    request = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"content-type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode() or "{}"), response.status
    except urllib.error.HTTPError as error:
        return json.loads(error.read().decode() or "{}"), error.code


def active_count():
    return len(call("/api/redactions")[0]["redactions"])


before = active_count()
target = call("/api/redactions")[0]["redactions"][0]
print(f"起始 active={before}  样本={target['id'][:8]}  类别={target['category']}")

new_category = "sensitive" if target["category"] != "sensitive" else "credential"
patched, _ = call(f"/api/redactions/{target['id']}", "PATCH", {"category": new_category})
print(f"PATCH 改类别 -> {patched['category']}  (期望 {new_category})  "
      f"created_by={patched['created_by']}")

call(f"/api/redactions/{target['id']}", "DELETE")
after_delete = active_count()
print(f"DELETE 软删 -> active={after_delete}  (期望 {before - 1})")

call(f"/api/redactions/{target['id']}", "PATCH", {"status": "active"})
restored = active_count()
print(f"PATCH 恢复 -> active={restored}  (期望 {before})")

call(f"/api/redactions/{target['id']}", "PATCH", {"category": target["category"]})

bad, bad_status = call(f"/api/redactions/{target['id']}", "PATCH",
                       {"category": "not-a-category"})
print(f"非法类别被拒: HTTP {bad_status} · {bad.get('error')}")

missing, missing_status = call("/api/redactions/does-not-exist", "DELETE")
print(f"删除不存在的记录: HTTP {missing_status} · {missing.get('error')}")

print("PASS" if (patched["category"] == new_category
                 and after_delete == before - 1
                 and restored == before
                 and bad_status == 400
                 and missing_status == 404) else "FAIL")
