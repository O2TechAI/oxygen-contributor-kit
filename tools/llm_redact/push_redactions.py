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
    missing = report.get("missing_worker_output", [])
    if missing:
        raise SystemExit(
            "redaction coverage is incomplete; missing worker output for: "
            + ", ".join(map(str, missing))
        )
    return report


def main() -> int:
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
    rejected = int(report.get("rejected", 0))

    spans = []
    bundles = [p for p in sorted(args.redacted.glob("*.json")) if p.name != "index.json"]
    if not bundles:
        raise SystemExit(f"no redacted bundles found in {args.redacted}")
    for path in bundles:
        bundle = json.loads(path.read_text(encoding="utf-8"))
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
                "total": len(spans), "rejected": rejected},
        "redactions": spans,
    })
    print(json.dumps({"sent": len(spans), **result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
