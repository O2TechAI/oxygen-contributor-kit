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
    parser.add_argument("--base-url", default="http://127.0.0.1:3210")
    parser.add_argument("--model", default="claude-sonnet-5")
    parser.add_argument("--limit", type=int, default=12)
    args = parser.parse_args()

    known_events = {}
    for path in args.dialogue.glob("*.json"):
        if path.name == "index.json":
            continue
        bundle = json.loads(path.read_text())
        known_events[bundle["trajectory"]] = {t["event_id"] for t in bundle["turns"]}
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
                "documentId": trajectory, "documentKind": "trajectory",
                "eventIds": event_ids, "timestamp": probe.get("timestamp"),
                "signal": probe["signal"], "score": probe.get("score", 0),
                "turns": probe.get("turns", 0), "recap": probe["recap"],
                "question": probe.get("question") or "Anything here you want the agent to remember?",
                "options": probe["options"],
            })

    collected.sort(key=lambda p: -p["score"])
    kept = collected[:args.limit]
    set_aside = len(collected) - len(kept)

    result = post(args.base_url, "/api/probes", {
        "replaceAll": True,
        "run": {"status": "complete", "stage": "complete",
                "model": args.model, "setAside": set_aside},
        "probes": kept,
    })
    print(json.dumps({"collected": len(collected), "kept": len(kept),
                      "set_aside": set_aside, "dropped": dropped, **result},
                     ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
