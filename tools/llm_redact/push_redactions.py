#!/usr/bin/env python3
"""Push redaction spans into a running local viewer.

The viewer stores the ORIGINAL text and overlays these spans at render time, so
a reviewer can change a category or delete a decision without the source having
been destroyed. Item ids are qualified with the trajectory because event ids
restart inside every trajectory.
"""
import argparse
import json
import pathlib
import urllib.request


def post(base_url: str, path: str, body: dict) -> dict:
    request = urllib.request.Request(
        f"{base_url}{path}",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode() or "{}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--redacted", type=pathlib.Path, required=True)
    parser.add_argument("--base-url", default="http://127.0.0.1:3210")
    parser.add_argument("--model", default="claude-sonnet-5")
    parser.add_argument("--rejected", type=int, default=0)
    args = parser.parse_args()

    spans = []
    bundles = [p for p in sorted(args.redacted.glob("*.json")) if p.name != "index.json"]
    if not bundles:
        raise SystemExit(f"no redacted bundles found in {args.redacted}")
    for path in bundles:
        bundle = json.loads(path.read_text())
        trajectory = bundle["trajectory"]
        for turn in bundle["turns"]:
            for span in turn.get("redactions", []):
                spans.append({
                    "itemId": f"{trajectory}:{turn['event_id']}",
                    "documentId": trajectory,
                    "startOffset": span["start"],
                    "endOffset": span["end"],
                    "category": span["category"],
                    "confidence": span.get("confidence"),
                    "reason": span.get("reason"),
                    "createdBy": "llm",
                })

    result = post(args.base_url, "/api/redactions", {
        "replaceAll": True,
        "job": {"status": "complete", "stage": "已完成", "model": args.model,
                "total": len(spans), "rejected": args.rejected},
        "redactions": spans,
    })
    print(json.dumps({"sent": len(spans), **result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
