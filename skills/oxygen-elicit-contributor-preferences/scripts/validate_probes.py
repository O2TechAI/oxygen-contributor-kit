#!/usr/bin/env python3
"""Finalize bounded preference candidates into the exact Viewer API bundle."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from typing import Any

_path = Path(__file__).with_name("prepare_preference_context.py")
_spec = importlib.util.spec_from_file_location("prepare_preference_context", _path)
assert _spec and _spec.loader
PREPARE = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = PREPARE
_spec.loader.exec_module(PREPARE)

EMPTY_DIGEST = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"
SIGNALS = {"repeated_correction", "long_exchange", "late_rejection", "decision_reversal", "explicit_rule", "sustained_disagreement"}
PROBE_KEYS = {"id", "documentId", "documentKind", "eventIds", "timestamp", "signal", "score", "turns", "recap", "question", "options", "presentations", "allowOther", "allowSkip"}
BULK_KEYS = {"id", "kind", "count", "question", "evidenceSample", "presentations"}
GENERIC = {"be more careful", "communicate better", "be clearer", "ask more questions", "do better", "follow instructions", "be consistent", "improve quality", "write better code", "test more", "be faster", "explain more"}
ASCII_LOWER = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")


def safe_text(value: Any, limit: int = 20_000) -> bool:
    return PREPARE.safe_text(value, limit)


def stable_id(value: Any, limit: int = 20_000) -> bool:
    return PREPARE.stable_id(value, limit)


def normalize_option_text(value: str) -> str:
    """Cross-runtime rule: ECMAScript trim, trailing ASCII dots, ASCII A-Z fold."""
    return PREPARE.js_trim(value).rstrip(".").translate(ASCII_LOWER)


def exact(value: Any, fields: set[str]) -> bool:
    return isinstance(value, dict) and set(value) == fields


def load(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read {path.name}") from exc


def digest(value: Any) -> str:
    return hashlib.sha256(PREPARE.canonical_json(value).encode("utf-8")).hexdigest()


def context_evidence(context: Any) -> dict[tuple[str, str], str]:
    keys = {"schema", "reusableLessons", "insightIdentities", "reviewedEvidence", "autoRemoved"}
    if not exact(context, keys) or context["schema"] != PREPARE.CONTEXT_SCHEMA:
        raise ValueError("preference context is malformed")
    lessons, identities = context["reusableLessons"], context["insightIdentities"]
    if not isinstance(lessons, list) or not isinstance(identities, list):
        raise ValueError("preference context is malformed")
    expected, seen = [], set()
    for lesson in lessons:
        allowed = ({"storyKey", "insightId", "background", "directlyAcquiredExperience", "principle"}, {"storyKey", "insightId", "title", "background", "directlyAcquiredExperience", "principle"})
        if (not isinstance(lesson, dict) or set(lesson) not in allowed
                or not stable_id(lesson.get("storyKey")) or not stable_id(lesson.get("insightId"))
                or not all(safe_text(lesson.get(field)) for field in ("background", "directlyAcquiredExperience", "principle"))
                or ("title" in lesson and not safe_text(lesson["title"]))):
            raise ValueError("preference context has malformed reusable lessons")
        identity = (lesson["storyKey"], lesson["insightId"])
        if identity in seen:
            raise ValueError("preference context has duplicate Insight identity")
        seen.add(identity); expected.append({"storyKey": identity[0], "insightId": identity[1]})
    if identities != expected or not isinstance(context["reviewedEvidence"], list):
        raise ValueError("preference context identities or evidence are stale")
    evidence: dict[tuple[str, str], str] = {}
    for record in context["reviewedEvidence"]:
        if (not exact(record, {"documentId", "eventId", "documentKind"})
                or not stable_id(record["documentId"]) or not stable_id(record["eventId"], 1_000)
                or record["documentKind"] not in {"trajectory", "meeting"}):
            raise ValueError("preference context has malformed reviewed evidence")
        identity = (record["documentId"], record["eventId"])
        if identity in evidence:
            raise ValueError("preference context has duplicate reviewed evidence")
        evidence[identity] = record["documentKind"]
    if PREPARE.canonical_auto_removed(context["autoRemoved"]) != context["autoRemoved"]:
        raise ValueError("preference context Privacy aggregate is not canonical")
    return evidence


def presentations(value: Any, options: list[dict[str, str]], bulk: bool = False) -> bool:
    if not isinstance(value, dict) or set(value) - {"en", "zh"}:
        return False
    for item in value.values():
        fields = {"question"} if bulk else {"recap", "question", "options"}
        if not exact(item, fields) or not safe_text(item["question"]):
            return False
        if not bulk:
            localized = item["options"]
            if not safe_text(item["recap"]) or not isinstance(localized, list) or len(localized) != len(options):
                return False
            if any(not exact(option, {"id", "text"}) or option["id"] != options[index]["id"]
                   or not stable_id(option["id"], 200) or not safe_text(option["text"])
                   for index, option in enumerate(localized)):
                return False
    return True


def probe(value: Any, evidence: dict[tuple[str, str], str]) -> dict[str, Any]:
    if not exact(value, PROBE_KEYS):
        raise ValueError("candidate probe has extra, unknown, or missing fields")
    if not stable_id(value["id"]) or not stable_id(value["documentId"]) or value["documentKind"] not in {"trajectory", "meeting"} or value["signal"] not in SIGNALS:
        raise ValueError("candidate probe identity, kind, or signal is invalid")
    if (not PREPARE.nonnegative_integer(value["score"]) or value["score"] > 100
            or not PREPARE.nonnegative_integer(value["turns"])):
        raise ValueError("candidate probe score or turns is invalid")
    if value["timestamp"] is not None and not safe_text(value["timestamp"]):
        raise ValueError("candidate probe timestamp is invalid")
    if not safe_text(value["recap"]) or not safe_text(value["question"]):
        raise ValueError("candidate probe text is invalid")
    event_ids = value["eventIds"]
    if not isinstance(event_ids, list) or not event_ids or not all(stable_id(event, 1_000) for event in event_ids) or len(set(event_ids)) != len(event_ids):
        raise ValueError("candidate probe evidence is invalid")
    if any(evidence.get((value["documentId"], event)) != value["documentKind"] for event in event_ids):
        raise ValueError("candidate probe cites foreign or cross-document evidence")
    options = value["options"]
    if not isinstance(options, list) or len(options) not in {2, 3}:
        raise ValueError("candidate probe options are invalid")
    seen_ids, seen_texts = set(), set()
    for option in options:
        if not exact(option, {"id", "text"}) or not stable_id(option["id"], 200) or not safe_text(option["text"]):
            raise ValueError("candidate probe options are invalid")
        normalized = normalize_option_text(option["text"])
        if option["id"] in seen_ids or normalized in seen_texts or normalized in GENERIC:
            raise ValueError("candidate probe options are not distinct or grounded")
        seen_ids.add(option["id"]); seen_texts.add(normalized)
    if value["allowOther"] is not True or value["allowSkip"] is not True or not presentations(value["presentations"], options):
        raise ValueError("candidate probe flags or presentations are invalid")
    return {key: value[key] for key in PROBE_KEYS}


def bulk(value: Any, evidence: dict[tuple[str, str], str]) -> dict[str, Any]:
    if not exact(value, BULK_KEYS):
        raise ValueError("candidate bulk decision has extra, unknown, or missing fields")
    if (not stable_id(value["id"]) or not safe_text(value["kind"])
            or not safe_text(value["question"]) or not PREPARE.nonnegative_integer(value["count"])):
        raise ValueError("candidate bulk decision is invalid")
    sample = value["evidenceSample"]
    if not isinstance(sample, list) or not all(stable_id(event, 1_000) for event in sample) or len(set(sample)) != len(sample):
        raise ValueError("candidate bulk evidence is invalid")
    known = {event_id for _, event_id in evidence}
    if any(event not in known for event in sample) or not presentations(value["presentations"], [], True):
        raise ValueError("candidate bulk cites foreign evidence or has invalid presentations")
    return {key: value[key] for key in BULK_KEYS}


def finalize(context: Any, candidates: Any, workflow_run_id: str, source_revision: int) -> dict[str, Any]:
    evidence = context_evidence(context)
    if (not stable_id(workflow_run_id, 1_000)
            or not PREPARE.nonnegative_integer(source_revision) or source_revision < 1):
        raise ValueError("workflow authority is invalid")
    if (not exact(candidates, {"probes", "bulkDecisions", "setAside"})
            or not isinstance(candidates["probes"], list)
            or not isinstance(candidates["bulkDecisions"], list)
            or not PREPARE.nonnegative_integer(candidates["setAside"])):
        raise ValueError("candidates must contain only valid probes, bulkDecisions, and setAside")
    probes = [probe(item, evidence) for item in candidates["probes"]]
    decisions = [bulk(item, evidence) for item in candidates["bulkDecisions"]]
    ids = [item["id"] for item in probes + decisions]
    if len(ids) != len(set(ids)):
        raise ValueError("candidate identity is duplicated")
    probes.sort(key=lambda item: item["id"].encode("utf-8")); decisions.sort(key=lambda item: item["id"].encode("utf-8"))
    count = len(probes) + len(decisions)
    if count == 0 and candidates["setAside"] != 0:
        raise ValueError("completed-zero cannot set questions aside")
    batch = [{**item, "type": "probe"} for item in probes] + [{**item, "type": "bulk"} for item in decisions]
    batch.sort(key=lambda item: f"{item['type']}:{item['id']}".encode("utf-8"))
    output = digest(batch)
    if count == 0 and output != EMPTY_DIGEST:
        raise ValueError("completed-zero digest is invalid")
    return {"workflowRunId": workflow_run_id, "sourceRevision": source_revision, "inputDigest": digest(context["reusableLessons"]), "outputDigest": output, "outputCount": count, "setAside": candidates["setAside"], "probes": probes, "bulkDecisions": decisions, "autoRemoved": context["autoRemoved"]}


def write_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        handle.write((PREPARE.canonical_json(value) + "\n").encode("utf-8")); temporary = Path(handle.name)
    temporary.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--context", required=True, type=Path); parser.add_argument("--candidates", required=True, type=Path)
    parser.add_argument("--workflow-run-id", required=True); parser.add_argument("--source-revision", required=True, type=int); parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        result = finalize(load(args.context), load(args.candidates), args.workflow_run_id, args.source_revision)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr); return 1
    write_atomic(args.output, result)
    print(json.dumps({"ok": True, "inputDigest": result["inputDigest"], "outputDigest": result["outputDigest"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
