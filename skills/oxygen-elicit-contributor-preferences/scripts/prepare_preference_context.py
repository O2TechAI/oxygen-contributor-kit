#!/usr/bin/env python3
"""Prepare the bounded, reviewed-only input for preference-question generation."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import tempfile
from typing import Any


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from tools.llm_redact.merge_and_apply import (  # noqa: E402
    ALLOWED as MERGE_ALLOWED,
    REVIEW_STATES,
    apply_spans,
)


CONTEXT_SCHEMA = "oxygen.preference-context"
AUTO_REMOVED_KINDS = frozenset(MERGE_ALLOWED)
MAX_SAFE_INTEGER = 9_007_199_254_740_991
MAX_PREFERENCE_QUESTIONS = 20
MAX_PREFERENCE_EVIDENCE_IDS = 500
DOCUMENT_KIND_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
STABLE_ID_CONTROLS = frozenset(chr(code) for code in (*range(0x20), 0x7F))
SAFE_TEXT_CONTROLS = STABLE_ID_CONTROLS - {"\t", "\n", "\r"}
ECMASCRIPT_TRIM = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def canonical_json(value: Any) -> str:
    """Match Core's UTF-8 key ordering and compact JSON authority encoding."""
    if value is None or not isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    return "{" + ",".join(
        json.dumps(key, ensure_ascii=False, separators=(",", ":")) + ":" + canonical_json(value[key])
        for key in sorted(value, key=lambda item: item.encode("utf-8"))
    ) + "}"


def sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def insight_authority(story_key: str, insight: dict[str, Any]) -> dict[str, Any]:
    return {"storyKey": story_key, "insightId": insight["id"], "content": insight}


def js_trim(value: str) -> str:
    return value.strip(ECMASCRIPT_TRIM)


def js_length(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def safe_text(value: Any, maximum: int = 20_000) -> bool:
    return (isinstance(value, str) and bool(js_trim(value)) and js_length(value) <= maximum
            and not any(character in SAFE_TEXT_CONTROLS for character in value))


def stable_id(value: Any, maximum: int = 20_000) -> bool:
    return (isinstance(value, str) and bool(js_trim(value)) and js_length(value) <= maximum
            and not any(character in STABLE_ID_CONTROLS for character in value))


def nonnegative_integer(value: Any) -> bool:
    return type(value) is int and 0 <= value <= MAX_SAFE_INTEGER


def valid_document_kind(value: Any) -> bool:
    return isinstance(value, str) and DOCUMENT_KIND_PATTERN.fullmatch(value) is not None


def exact_object(value: Any, required: set[str], optional: set[str] = set()) -> bool:
    return isinstance(value, dict) and required <= set(value) and set(value) <= required | optional


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read {path.name}") from exc


def canonical_auto_removed(value: Any) -> dict[str, Any]:
    if not exact_object(value, {"total", "reversible", "categories"}):
        raise ValueError("Privacy aggregate is malformed")
    if not nonnegative_integer(value["total"]) or value["reversible"] is not True:
        raise ValueError("Privacy aggregate is malformed")
    categories = value["categories"]
    if not isinstance(categories, list):
        raise ValueError("Privacy aggregate is malformed")
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for category in categories:
        if (not exact_object(category, {"kind", "count"}) or category["kind"] not in AUTO_REMOVED_KINDS
                or not nonnegative_integer(category["count"])
                or category["count"] == 0
                or category["kind"] in seen):
            raise ValueError("Privacy aggregate is malformed")
        seen.add(category["kind"])
        normalized.append({"kind": category["kind"], "count": category["count"]})
    normalized.sort(key=lambda category: category["kind"].encode("utf-8"))
    if sum(category["count"] for category in normalized) != value["total"]:
        raise ValueError("Privacy aggregate is inconsistent")
    return {"total": value["total"], "reversible": value["reversible"], "categories": normalized}


def parse_story(summary: Any) -> dict[str, Any]:
    if not isinstance(summary, str) or not summary.startswith("oxygen.story:"):
        raise ValueError("candidate is not canonical oxygen.story")
    try:
        story = json.loads(summary[len("oxygen.story:"):])
    except json.JSONDecodeError as exc:
        raise ValueError("Story JSON is malformed") from exc
    required = {"schema", "key", "phase", "title", "overview", "people", "story", "insights", "evidence", "coverage"}
    optional = {"kind", "transition", "chips"}
    if not exact_object(story, required, optional) or story["schema"] != "oxygen.story" or not stable_id(story["key"]):
        raise ValueError("Story is malformed")
    insights = story["insights"]
    if not isinstance(insights, list):
        raise ValueError("Story is malformed")
    story_body = story["story"]
    if not exact_object(story_body, {"blocks"}, {"uncertainty"}) or not isinstance(story_body["blocks"], list):
        raise ValueError("Story is malformed")
    block_evidence: dict[str, set[tuple[str, str]]] = {}
    for block in story_body["blocks"]:
        if (not exact_object(block, {"id", "text", "evidence"}) or not stable_id(block["id"])
                or block["id"] in block_evidence or not safe_text(block["text"])
                or not isinstance(block["evidence"], list)):
            raise ValueError("Story block is malformed")
        references: set[tuple[str, str]] = set()
        for reference in block["evidence"]:
            if (not exact_object(reference, {"documentId", "eventId"}, {"label"})
                    or not stable_id(reference["documentId"])
                    or not stable_id(reference["eventId"], 1_000)):
                raise ValueError("Story block evidence is malformed")
            references.add((reference["documentId"], reference["eventId"]))
        block_evidence[block["id"]] = references
    seen: set[str] = set()
    parsed: list[dict[str, Any]] = []
    for insight in insights:
        fields = {
            "id", "background", "anchorStoryBlockId", "quote",
            "directlyAcquiredExperience", "principle", "evidence",
        }
        if not exact_object(insight, fields, {"title"}) or not stable_id(insight["id"]) or insight["id"] in seen:
            raise ValueError("Story Insight is malformed")
        if not all(safe_text(insight[field]) for field in ("background", "directlyAcquiredExperience", "principle")):
            raise ValueError("Story Insight is malformed")
        anchor = insight["anchorStoryBlockId"]
        if not stable_id(anchor) or anchor not in block_evidence:
            raise ValueError("Story Insight is malformed")
        quote = insight["quote"]
        if (not exact_object(quote, {"text", "evidence"}) or not safe_text(quote["text"])
                or not exact_object(quote["evidence"], {"documentId", "eventId"})
                or not stable_id(quote["evidence"]["documentId"])
                or not stable_id(quote["evidence"]["eventId"], 1_000)):
            raise ValueError("Story Insight is malformed")
        evidence = insight["evidence"]
        if not isinstance(evidence, list):
            raise ValueError("Story Insight is malformed")
        evidence_out = []
        evidence_seen: set[tuple[str, str]] = set()
        quote_identity = (quote["evidence"]["documentId"], quote["evidence"]["eventId"])
        if quote_identity not in block_evidence[anchor]:
            raise ValueError("Story Insight Quote is not grounded by its anchor")
        for reference in [quote["evidence"], *evidence]:
            if not exact_object(reference, {"documentId", "eventId"}, {"label"}):
                raise ValueError("Story Insight evidence is malformed")
            if not stable_id(reference["documentId"]) or not stable_id(reference["eventId"], 1_000):
                raise ValueError("Story Insight evidence is malformed")
            identity = (reference["documentId"], reference["eventId"])
            if identity in evidence_seen:
                continue
            evidence_seen.add(identity)
            evidence_out.append({"documentId": identity[0], "eventId": identity[1]})
        seen.add(insight["id"])
        content = {key: insight[key] for key in (
            "id", "background", "anchorStoryBlockId", "quote",
            "directlyAcquiredExperience", "principle", "evidence",
        )}
        lesson = {
            "storyKey": story["key"], "insightId": insight["id"],
            "insightAuthorityDigest": sha256(insight_authority(story["key"], content)),
            "background": insight["background"],
            "directlyAcquiredExperience": insight["directlyAcquiredExperience"],
            "principle": insight["principle"],
        }
        if "title" in insight:
            if not safe_text(insight["title"]):
                raise ValueError("Story Insight is malformed")
            content["title"] = insight["title"]
            lesson["insightAuthorityDigest"] = sha256(insight_authority(story["key"], content))
            lesson["title"] = insight["title"]
        parsed.append({"lesson": lesson, "evidence": evidence_out})
    return {"key": story["key"], "insights": parsed}


def read_privacy_authority(
    redacted_dir: Path, privacy_report_path: Path,
) -> tuple[dict[tuple[str, str], str], dict[str, Any]]:
    report = read_json(privacy_report_path)
    report_fields = {
        "categories", "total_applied", "rejected", "rejects",
        "missing_worker_output", "per_trajectory", "receiptDigest",
    }
    if not exact_object(report, report_fields):
        raise ValueError("completed Privacy report is malformed")
    if (not nonnegative_integer(report["total_applied"])
            or not nonnegative_integer(report["rejected"]) or report["rejected"] != 0
            or report["rejects"] != [] or report["missing_worker_output"] != []
            or not isinstance(report["receiptDigest"], str)
            or len(report["receiptDigest"]) != 64
            or any(character not in "0123456789abcdef" for character in report["receiptDigest"])
            or not isinstance(report["categories"], dict)
            or not isinstance(report["per_trajectory"], list)):
        raise ValueError("completed Privacy report is incomplete")

    reported_counts: dict[str, int] = {}
    for kind, count in report["categories"].items():
        if kind not in AUTO_REMOVED_KINDS or not nonnegative_integer(count) or count == 0:
            raise ValueError("completed Privacy report categories are malformed")
        reported_counts[kind] = count
    if sum(reported_counts.values()) != report["total_applied"]:
        raise ValueError("completed Privacy report aggregate is inconsistent")

    reported_documents: dict[str, tuple[int, int]] = {}
    for row in report["per_trajectory"]:
        if (not exact_object(row, {"trajectory", "turns", "applied"})
                or not stable_id(row["trajectory"])
                or row["trajectory"] in reported_documents
                or not nonnegative_integer(row["turns"])
                or not nonnegative_integer(row["applied"])):
            raise ValueError("completed Privacy report documents are malformed")
        reported_documents[row["trajectory"]] = (row["turns"], row["applied"])

    if not redacted_dir.is_dir():
        raise ValueError("reviewed redaction directory is missing")
    bundle_paths = [
        path for path in sorted(redacted_dir.glob("*.json"), key=lambda item: item.name.encode("utf-8"))
        if path.name != "index.json"
    ]
    if not bundle_paths:
        raise ValueError("reviewed redaction directory is empty")

    events: dict[tuple[str, str], str] = {}
    observed_documents: dict[str, tuple[int, int]] = {}
    observed_counts: dict[str, int] = {}
    for path in bundle_paths:
        bundle = read_json(path)
        if not exact_object(bundle, {"trajectory", "document_kind", "turns", "chars"}):
            raise ValueError("reviewed redaction bundle is malformed")
        document_id = bundle["trajectory"]
        document_kind = bundle["document_kind"]
        turns = bundle["turns"]
        if (not stable_id(document_id) or path.stem != document_id
                or not valid_document_kind(document_kind)
                or not isinstance(turns, list)
                or not nonnegative_integer(bundle["chars"])
                or document_id in observed_documents):
            raise ValueError("reviewed redaction bundle is malformed")
        applied = 0
        character_count = 0
        for turn in turns:
            fields = {
                "event_id", "document_id", "item_id", "sequence", "role", "timestamp", "text",
                "redactions", "redacted_text",
            }
            if (not exact_object(turn, fields) or not stable_id(turn["event_id"], 1_000)
                    or turn["document_id"] != document_id or not stable_id(turn["item_id"], 1_000)
                    or turn["event_id"] != turn["item_id"]
                    or not nonnegative_integer(turn["sequence"]) or turn["sequence"] == 0
                    or not isinstance(turn["text"], str) or not isinstance(turn["redacted_text"], str)
                    or not isinstance(turn["redactions"], list)):
                raise ValueError("reviewed redaction turn is malformed")
            identity = (document_id, turn["item_id"])
            if identity in events:
                raise ValueError("reviewed evidence authority is duplicated")
            events[identity] = document_kind
            character_count += len(turn["text"])
            previous_end = 0
            for span in turn["redactions"]:
                span_fields = {
                    "start", "end", "category", "confidence", "reason",
                    "review_state", "uncertainty_reason",
                }
                if (not exact_object(span, span_fields)
                        or not nonnegative_integer(span["start"])
                        or not nonnegative_integer(span["end"])
                        or not 0 <= span["start"] < span["end"] <= len(turn["text"])
                        or span["category"] not in AUTO_REMOVED_KINDS
                        or span["review_state"] not in REVIEW_STATES):
                    raise ValueError("reviewed redaction span is malformed")
                if (span["review_state"] == "needs_confirmation"
                        and not safe_text(span["uncertainty_reason"])):
                    raise ValueError("reviewed redaction span is malformed")
                if (span["review_state"] == "deterministic"
                        and span["uncertainty_reason"] is not None):
                    raise ValueError("reviewed redaction span is malformed")
                if span["start"] < previous_end:
                    raise ValueError("reviewed redaction spans are not canonical")
                previous_end = span["end"]
                observed_counts[span["category"]] = observed_counts.get(span["category"], 0) + 1
                applied += 1
            if turn["redacted_text"] != apply_spans(turn["text"], turn["redactions"]):
                raise ValueError("reviewed redaction text is not canonical")
        if character_count != bundle["chars"]:
            raise ValueError("reviewed redaction bundle character count is stale")
        observed_documents[document_id] = (len(turns), applied)

    if observed_documents != reported_documents or observed_counts != reported_counts:
        raise ValueError("completed Privacy report does not bind the reviewed redaction bundles")
    auto_removed = canonical_auto_removed({
        "total": report["total_applied"],
        "reversible": True,
        "categories": [
            {"kind": kind, "count": reported_counts[kind]}
            for kind in sorted(reported_counts, key=lambda item: item.encode("utf-8"))
        ],
    })
    return events, auto_removed


def prepare(
    story_candidates_path: Path, redacted_dir: Path, privacy_report_path: Path,
) -> dict[str, Any]:
    candidates = read_json(story_candidates_path)
    if not isinstance(candidates, list):
        raise ValueError("story-candidates authority is malformed")
    reviewed, auto_removed = read_privacy_authority(redacted_dir, privacy_report_path)

    lessons: list[dict[str, Any]] = []
    scope: list[dict[str, str]] = []
    evidence: list[dict[str, str]] = []
    seen_story_keys: set[str] = set()
    seen_candidate_ids: set[str] = set()
    seen_identities: set[tuple[str, str]] = set()
    seen_evidence: set[tuple[str, str]] = set()
    for candidate in candidates:
        if (not exact_object(candidate, {"id", "summary"}) or not stable_id(candidate["id"])
                or candidate["id"] in seen_candidate_ids):
            raise ValueError("story candidate is malformed")
        seen_candidate_ids.add(candidate["id"])
    ordered_candidates = sorted(candidates, key=lambda item: item["id"].encode("utf-8"))
    for candidate in ordered_candidates:
        story = parse_story(candidate["summary"])
        if story["key"] in seen_story_keys:
            raise ValueError("Story key is duplicated")
        seen_story_keys.add(story["key"])
        for insight in story["insights"]:
            lesson = insight["lesson"]
            identity = (lesson["storyKey"], lesson["insightId"])
            if identity in seen_identities:
                raise ValueError("Insight identity is duplicated")
            seen_identities.add(identity)
            lessons.append(lesson)
            scope.append({
                "storyKey": identity[0], "insightId": identity[1],
                "insightAuthorityDigest": lesson["insightAuthorityDigest"],
            })
            for reference in insight["evidence"]:
                event_identity = (reference["documentId"], reference["eventId"])
                if event_identity not in reviewed:
                    raise ValueError("Story Insight cites foreign, raw, or unreviewed evidence")
                if event_identity not in seen_evidence:
                    seen_evidence.add(event_identity)
                    evidence.append({
                        "documentId": event_identity[0], "eventId": event_identity[1],
                        "documentKind": reviewed[event_identity],
                    })
    return {
        "schema": CONTEXT_SCHEMA,
        "reusableLessons": lessons,
        "insightScope": scope,
        "reviewedEvidence": evidence,
        "autoRemoved": auto_removed,
    }


def write_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = (canonical_json(value) + "\n").encode("utf-8")
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        handle.write(payload)
        temporary = Path(handle.name)
    temporary.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--story-candidates", required=True, type=Path)
    parser.add_argument("--redacted", required=True, type=Path)
    parser.add_argument("--privacy-report", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        context = prepare(args.story_candidates, args.redacted, args.privacy_report)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    write_atomic(args.output, context)
    print(json.dumps({"ok": True, "inputDigest": sha256(context["reusableLessons"])}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
