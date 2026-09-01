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
PROBE_KEYS = {"id", "storyKey", "insightId", "insightAuthorityDigest", "documentId", "documentKind", "eventIds", "timestamp", "signal"} | \
    {"score", "turns", "recap", "question", "options", "presentations", "allowOther", "allowSkip"}
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


def context_evidence(context: Any) -> tuple[dict[tuple[str, str], Any], dict[tuple[str, str], str], dict[tuple[str, str], str]]:
    regeneration = isinstance(context, dict) and context.get("schema") == "oxygen.preference-regeneration-context"
    keys = {"schema", "reusableLessons", "insightScope", "reviewedEvidence", "autoRemoved"} if not regeneration else {
        "schema", "binding", "reusableLessons", "insightScope", "reviewedEvidence", "targets", "exportDigest"}
    if not exact(context, keys) or (not regeneration and context["schema"] != PREPARE.CONTEXT_SCHEMA):
        raise ValueError("preference context is malformed")
    lessons, scope = context["reusableLessons"], context["insightScope"]
    if not isinstance(lessons, list) or not isinstance(scope, list):
        raise ValueError("preference context is malformed")
    expected, seen = [], set()
    for lesson in lessons:
        language_fields = {"language"} if not regeneration else set()
        allowed = ({"storyKey", "insightId", "insightAuthorityDigest", "background", "directlyAcquiredExperience", "principle"} | language_fields,
                   {"storyKey", "insightId", "insightAuthorityDigest", "title", "background", "directlyAcquiredExperience", "principle"} | language_fields)
        if (not isinstance(lesson, dict) or set(lesson) not in allowed
                or not stable_id(lesson.get("storyKey")) or not stable_id(lesson.get("insightId"))
                or not isinstance(lesson.get("insightAuthorityDigest"), str) or len(lesson["insightAuthorityDigest"]) != 64
                or any(character not in "0123456789abcdef" for character in lesson["insightAuthorityDigest"])
                or (not regeneration and lesson.get("language") not in {"en", "zh"})
                or not all(safe_text(lesson.get(field)) for field in ("background", "directlyAcquiredExperience", "principle"))
                or ("title" in lesson and not safe_text(lesson["title"]))):
            raise ValueError("preference context has malformed reusable lessons")
        identity = (lesson["storyKey"], lesson["insightId"])
        if identity in seen:
            raise ValueError("preference context has duplicate Insight identity")
        seen.add(identity); expected.append({"storyKey": identity[0], "insightId": identity[1], "insightAuthorityDigest": lesson["insightAuthorityDigest"]})
    canonical_scope = sorted(expected, key=lambda item: (
        item["storyKey"].encode("utf-8"), item["insightId"].encode("utf-8"),
    ))
    if scope != canonical_scope or not isinstance(context["reviewedEvidence"], list):
        raise ValueError("preference context identities or evidence are stale")
    evidence: dict[tuple[str, str], Any] = {}
    evidence_keys = {"documentId", "eventId", "documentKind"} if regeneration else PREPARE.PREFERENCE_EVIDENCE_KEYS
    for record in context["reviewedEvidence"]:
        if (not exact(record, evidence_keys)
                or not stable_id(record["documentId"]) or not stable_id(record["eventId"], 1_000)
                or not PREPARE.valid_document_kind(record["documentKind"])):
            raise ValueError("preference context has malformed reviewed evidence")
        if not regeneration and (
                not PREPARE.nonnegative_integer(record["sequence"]) or record["sequence"] == 0
                or (record["role"] is not None and not safe_text(record["role"]))
                or (record["timestamp"] is not None and not safe_text(record["timestamp"]))
                or not safe_text(record["redactedText"])):
            raise ValueError("preference context has malformed reviewed evidence")
        identity = (record["documentId"], record["eventId"])
        if identity in evidence:
            raise ValueError("preference context has duplicate reviewed evidence")
        evidence[identity] = record["documentKind"]
    if not regeneration and PREPARE.canonical_auto_removed(context["autoRemoved"]) != context["autoRemoved"]:
        raise ValueError("preference context Privacy aggregate is not canonical")
    languages = {} if regeneration else {
        (item["storyKey"], item["insightId"]): item["language"] for item in lessons
    }
    return evidence, {(item["storyKey"], item["insightId"]): item["insightAuthorityDigest"] for item in scope}, languages


def presentations(value: Any, options: list[dict[str, str]], bulk: bool = False,
                  required_language: str | None = None) -> bool:
    if not isinstance(value, dict) or set(value) - {"en", "zh"}:
        return False
    if required_language is not None and required_language not in value:
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


def evidence_document_kind(record: Any) -> Any:
    return record["documentKind"] if isinstance(record, dict) else record


def probe(value: Any, evidence: dict[tuple[str, str], Any], scope: dict[tuple[str, str], str],
          languages: dict[tuple[str, str], str]) -> dict[str, Any]:
    if not exact(value, PROBE_KEYS):
        raise ValueError("candidate probe has extra, unknown, or missing fields")
    if not stable_id(value["id"]) or not stable_id(value["documentId"]) or not PREPARE.valid_document_kind(value["documentKind"]) or value["signal"] not in SIGNALS:
        raise ValueError("candidate probe identity, kind, or signal is invalid")
    if (not stable_id(value["storyKey"]) or not stable_id(value["insightId"])
            or scope.get((value["storyKey"], value["insightId"])) != value["insightAuthorityDigest"]):
        raise ValueError("candidate probe Insight binding is missing, foreign, or stale")
    if (not PREPARE.nonnegative_integer(value["score"]) or value["score"] > 100
            or not PREPARE.nonnegative_integer(value["turns"])):
        raise ValueError("candidate probe score or turns is invalid")
    if value["timestamp"] is not None and not safe_text(value["timestamp"]):
        raise ValueError("candidate probe timestamp is invalid")
    if not safe_text(value["recap"]) or not safe_text(value["question"]):
        raise ValueError("candidate probe text is invalid")
    event_ids = value["eventIds"]
    if (not isinstance(event_ids, list) or not 1 <= len(event_ids) <= PREPARE.MAX_PREFERENCE_EVIDENCE_IDS
            or not all(stable_id(event, 1_000) for event in event_ids) or len(set(event_ids)) != len(event_ids)):
        raise ValueError("candidate probe evidence is invalid")
    if any(evidence_document_kind(evidence.get((value["documentId"], event))) != value["documentKind"] for event in event_ids):
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
    required_language = languages.get((value["storyKey"], value["insightId"]))
    if (languages and required_language is None) or value["allowOther"] is not True or value["allowSkip"] is not True \
            or not presentations(value["presentations"], options, required_language=required_language):
        raise ValueError("candidate probe flags or presentations are invalid")
    return {key: value[key] for key in PROBE_KEYS}


def bulk(value: Any, evidence: dict[tuple[str, str], Any]) -> dict[str, Any]:
    if not exact(value, BULK_KEYS):
        raise ValueError("candidate bulk decision has extra, unknown, or missing fields")
    if (not stable_id(value["id"]) or not safe_text(value["kind"])
            or not safe_text(value["question"]) or not PREPARE.nonnegative_integer(value["count"])):
        raise ValueError("candidate bulk decision is invalid")
    sample = value["evidenceSample"]
    if (not isinstance(sample, list) or len(sample) > PREPARE.MAX_PREFERENCE_EVIDENCE_IDS
            or not all(stable_id(event, 1_000) for event in sample) or len(set(sample)) != len(sample)):
        raise ValueError("candidate bulk evidence is invalid")
    known = {event_id for _, event_id in evidence}
    if any(event not in known for event in sample) or not presentations(value["presentations"], [], True):
        raise ValueError("candidate bulk cites foreign evidence or has invalid presentations")
    return {key: value[key] for key in BULK_KEYS}


def finalize(context: Any, candidates: Any, workflow_run_id: str, source_revision: int) -> dict[str, Any]:
    evidence, scope, languages = context_evidence(context)
    if (not stable_id(workflow_run_id, 1_000)
            or not PREPARE.nonnegative_integer(source_revision) or source_revision < 1):
        raise ValueError("workflow authority is invalid")
    if (not exact(candidates, {"probes", "bulkDecisions", "setAside"})
            or not isinstance(candidates["probes"], list)
            or not isinstance(candidates["bulkDecisions"], list)
            or len(candidates["probes"]) + len(candidates["bulkDecisions"]) > PREPARE.MAX_PREFERENCE_QUESTIONS
            or not PREPARE.nonnegative_integer(candidates["setAside"])):
        raise ValueError("candidates must contain only valid probes, bulkDecisions, and setAside")
    probes = [probe(item, evidence, scope, languages) for item in candidates["probes"]]
    decisions = [bulk(item, evidence) for item in candidates["bulkDecisions"]]
    ids = [item["id"] for item in probes + decisions]
    bindings = [(item["storyKey"], item["insightId"]) for item in probes]
    if len(ids) != len(set(ids)) or len(bindings) != len(set(bindings)):
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
    return {"workflowRunId": workflow_run_id, "sourceRevision": source_revision,
            "inputDigest": digest(context["reusableLessons"]), "outputDigest": output, "outputCount": count,
            "setAside": candidates["setAside"], "insightScope": context["insightScope"], "probes": probes,
            "bulkDecisions": decisions, "autoRemoved": context["autoRemoved"]}


def finalize_regeneration(context: Any, candidates: Any) -> dict[str, Any]:
    evidence, scope, languages = context_evidence(context)
    draft = {key: context[key] for key in context if key != "exportDigest"}
    if context["exportDigest"] != digest(draft) or not exact(candidates, {"probes", "bulkDecisions", "setAside"}) \
            or candidates["bulkDecisions"] != [] or candidates["setAside"] != 0:
        raise ValueError("regeneration authority is invalid")
    probes = [probe(item, evidence, scope, languages) for item in candidates["probes"]]
    targets = context["targets"]
    if not isinstance(targets, list) or len(probes) != len(targets):
        raise ValueError("regeneration scope is incomplete")
    target_map = {(item.get("storyKey"), item.get("insightId")): item for item in targets if isinstance(item, dict)}
    question_digest = lambda item: digest({key: item[key] for key in ("question", "options", "presentations")})
    if len(target_map) != len(targets) or any(
        (target := target_map.get((item["storyKey"], item["insightId"]))) is None
        or target.get("id") != item["id"] or target.get("previousQuestionDigest") == question_digest(item)
        for item in probes
    ):
        raise ValueError("regeneration is foreign or unchanged")
    probes.sort(key=lambda item: item["id"].encode("utf-8"))
    receipt = {"status": "complete", "inputDigest": context["exportDigest"],
               "outputDigest": digest(probes), "outputCount": len(probes)}
    output = {"schema": "oxygen.preference-regeneration-import", "binding": context["binding"],
              "targets": targets, "probes": probes, "receipt": receipt}
    return {**output, "importDigest": digest(output)}


def write_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        handle.write((PREPARE.canonical_json(value) + "\n").encode("utf-8")); temporary = Path(handle.name)
    temporary.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--context", required=True, type=Path); parser.add_argument("--candidates", required=True, type=Path)
    parser.add_argument("--workflow-run-id"); parser.add_argument("--source-revision", type=int); parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--regeneration", action="store_true")
    args = parser.parse_args()
    try:
        context = load(args.context); candidates = load(args.candidates)
        result = finalize_regeneration(context, candidates) if args.regeneration else finalize(context, candidates, args.workflow_run_id, args.source_revision)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr); return 1
    write_atomic(args.output, result)
    receipt = result.get("receipt", result)
    print(json.dumps({"ok": True, "inputDigest": receipt["inputDigest"], "outputDigest": receipt["outputDigest"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
