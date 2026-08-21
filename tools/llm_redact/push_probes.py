#!/usr/bin/env python3
"""Merge per-trajectory probes, validate their evidence, and push them.

Evidence is what makes a probe reopenable at its original moment, so a probe
whose event_ids do not exist in the run is dropped rather than shipped. The
contract caps a batch at 12 by default; anything beyond that is reported as set
aside rather than silently discarded.
"""
import argparse
import json
import pathlib
import urllib.request

SIGNALS = {
    "repeated_correction", "long_exchange", "late_rejection",
    "decision_reversal", "explicit_rule", "sustained_disagreement",
}
AUTO_REMOVED_FIELDS = {"total", "reversible", "categories"}
AUTO_REMOVED_CATEGORY_FIELDS = {"kind", "count"}
AUTO_REMOVED_KINDS = {
    "credential",
    "private-personal",
    "sensitive",
    "internal-metric",
    "internal-timeline",
    "mosaic-reidentification",
    "user_path",
    "third_party_contact",
}


def canonical_auto_removed(value: object) -> dict:
    if not isinstance(value, dict):
        raise ValueError("auto_removed must be an object")
    if set(value) != AUTO_REMOVED_FIELDS:
        raise ValueError("auto_removed must contain exactly total, reversible, and categories")

    total = value.get("total")
    reversible = value.get("reversible")
    categories = value.get("categories")
    if type(total) is not int or total < 0:
        raise ValueError("auto_removed.total must be a non-negative integer")
    if not isinstance(reversible, bool):
        raise ValueError("auto_removed.reversible must be a boolean")
    if not isinstance(categories, list):
        raise ValueError("auto_removed.categories must be an array")

    canonical_categories = []
    seen_kinds = set()
    for index, category in enumerate(categories):
        if not isinstance(category, dict):
            raise ValueError(f"auto_removed.categories[{index}] must be an object")
        if set(category) != AUTO_REMOVED_CATEGORY_FIELDS:
            raise ValueError(
                f"auto_removed.categories[{index}] must contain exactly kind and count"
            )
        kind = category.get("kind")
        count = category.get("count")
        if not isinstance(kind, str) or kind not in AUTO_REMOVED_KINDS:
            raise ValueError(f"auto_removed.categories[{index}].kind is not allowed")
        if kind in seen_kinds:
            raise ValueError(f"duplicate auto_removed category {kind!r}")
        if type(count) is not int or count < 0:
            raise ValueError(
                f"auto_removed.categories[{index}].count must be a non-negative integer"
            )
        seen_kinds.add(kind)
        canonical_categories.append({"kind": kind, "count": count})

    counted = sum(category["count"] for category in canonical_categories)
    if total != counted:
        raise ValueError(f"auto_removed.total {total} != sum of categories {counted}")
    return {
        "total": total,
        "reversible": reversible,
        "categories": canonical_categories,
    }


def post(base_url: str, path: str, body: dict) -> dict:
    request = urllib.request.Request(
        f"{base_url}{path}", data=json.dumps(body).encode(),
        headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode() or "{}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--probes", type=pathlib.Path, required=True)
    parser.add_argument("--dialogue", type=pathlib.Path, required=True)
    parser.add_argument(
        "--summary", type=pathlib.Path,
        help="validated preference-probes.json carrying exact removal counts and bulk decisions",
    )
    parser.add_argument("--base-url", default="http://127.0.0.1:3210")
    parser.add_argument("--model", default="claude-sonnet-5")
    parser.add_argument("--limit", type=int, default=12)
    args = parser.parse_args()

    known_events = {}
    document_kinds = {}
    for path in args.dialogue.glob("*.json"):
        if path.name == "index.json":
            continue
        bundle = json.loads(path.read_text())
        known_events[bundle["trajectory"]] = {t["event_id"] for t in bundle["turns"]}
        document_kinds[bundle["trajectory"]] = bundle.get("document_kind", "trajectory")
    if not known_events:
        raise SystemExit(f"no dialogue bundles found in {args.dialogue}")

    probe_files = [p for p in sorted(args.probes.glob("*.json")) if p.name != "index.json"]
    if not probe_files:
        raise SystemExit(f"no probe bundles found in {args.probes}")

    collected, dropped = [], []
    for path in probe_files:
        try:
            bundle = json.loads(path.read_text())
        except json.JSONDecodeError:
            dropped.append({"trajectory": path.stem, "reason": "invalid JSON"})
            continue
        trajectory = bundle.get("trajectory") or path.stem
        for probe in bundle.get("probes", []):
            if probe.get("signal") not in SIGNALS:
                dropped.append({"trajectory": trajectory, "reason": "unknown signal"})
                continue
            event_ids = probe.get("event_ids") or []
            unknown = [e for e in event_ids if e not in known_events.get(trajectory, set())]
            if unknown:
                dropped.append({"trajectory": trajectory,
                                "reason": f"evidence not in run: {unknown[:3]}"})
                continue
            if not probe.get("recap") or not probe.get("options"):
                dropped.append({"trajectory": trajectory, "reason": "missing recap or options"})
                continue
            collected.append({
                "documentId": trajectory,
                "documentKind": document_kinds.get(trajectory, "trajectory"),
                "eventIds": event_ids, "timestamp": probe.get("timestamp"),
                "signal": probe["signal"], "score": probe.get("score", 0),
                "turns": probe.get("turns", 0), "recap": probe["recap"],
                "question": probe.get("question") or "Anything here you want the agent to remember?",
                "options": probe["options"],
            })

    collected.sort(key=lambda p: -p["score"])
    kept = collected[:args.limit]
    set_aside = len(collected) - len(kept)

    auto_removed = {"total": 0, "reversible": True, "categories": []}
    bulk_decisions = []
    if args.summary:
        summary = json.loads(args.summary.read_text(encoding="utf-8"))
        try:
            auto_removed = canonical_auto_removed(summary.get("auto_removed"))
        except ValueError as exc:
            raise SystemExit(f"invalid auto_removed in {args.summary}: {exc}") from exc
        bulk_decisions = [{
            "id": decision.get("id"),
            "kind": decision["kind"],
            "count": int(decision.get("count", 0)),
            "question": decision["question"],
            "evidenceSample": decision.get("evidence_sample") or [],
        } for decision in summary.get("bulk_decisions") or []]

    result = post(args.base_url, "/api/probes", {
        "replaceAll": True,
        "run": {"status": "complete", "stage": "complete",
                "model": args.model, "setAside": set_aside,
                "autoRemoved": auto_removed},
        "probes": kept,
        "bulkDecisions": bulk_decisions,
    })
    print(json.dumps({"collected": len(collected), "kept": len(kept),
                      "set_aside": set_aside, "dropped": dropped,
                      "auto_removed": auto_removed.get("total", 0),
                      "bulk_decisions": len(bulk_decisions), **result},
                     ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
