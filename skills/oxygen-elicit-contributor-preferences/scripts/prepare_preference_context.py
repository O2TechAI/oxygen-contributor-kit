#!/usr/bin/env python3
"""Prepare the bounded, reviewed-only input for preference-question generation."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys
import tempfile
from typing import Any


CONTEXT_SCHEMA = "oxygen.preference-context.v1"
STORY_CANDIDATES_SCHEMA = "oxygen.story-candidates.v1"
REVIEWED_EVIDENCE_SCHEMA = "oxygen.reviewed-evidence.v1"
PRIVACY_SUMMARY_SCHEMA = "oxygen.privacy-summary.v1"
AUTO_REMOVED_KINDS = {
    "credential", "private-personal", "sensitive", "internal-metric",
    "internal-timeline", "mosaic-reidentification", "user_path", "third_party_contact",
}


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


def nonempty(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip()) and len(value) <= 20_000


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
    if type(value["total"]) is not int or value["total"] < 0 or not isinstance(value["reversible"], bool):
        raise ValueError("Privacy aggregate is malformed")
    categories = value["categories"]
    if not isinstance(categories, list):
        raise ValueError("Privacy aggregate is malformed")
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for category in categories:
        if (not exact_object(category, {"kind", "count"}) or category["kind"] not in AUTO_REMOVED_KINDS
                or type(category["count"]) is not int or category["count"] < 0
                or category["kind"] in seen):
            raise ValueError("Privacy aggregate is malformed")
        seen.add(category["kind"])
        normalized.append({"kind": category["kind"], "count": category["count"]})
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
    if not exact_object(story, required, optional) or story["schema"] != "oxygen.story" or not nonempty(story["key"]):
        raise ValueError("Story is malformed")
    insights = story["insights"]
    if not isinstance(insights, list):
        raise ValueError("Story is malformed")
    seen: set[str] = set()
    parsed: list[dict[str, Any]] = []
    for insight in insights:
        fields = {"id", "background", "quote", "directlyAcquiredExperience", "principle", "evidence"}
        if not exact_object(insight, fields, {"title"}) or not nonempty(insight["id"]) or insight["id"] in seen:
            raise ValueError("Story Insight is malformed")
        if not all(nonempty(insight[field]) for field in ("background", "directlyAcquiredExperience", "principle")):
            raise ValueError("Story Insight is malformed")
        quote = insight["quote"]
        if not exact_object(quote, {"storyBlockIds"}) or not isinstance(quote["storyBlockIds"], list):
            raise ValueError("Story Insight is malformed")
        evidence = insight["evidence"]
        if not isinstance(evidence, list) or not evidence:
            raise ValueError("Story Insight is malformed")
        evidence_out = []
        evidence_seen: set[tuple[str, str]] = set()
        for reference in evidence:
            if not exact_object(reference, {"documentId", "eventId"}, {"label"}):
                raise ValueError("Story Insight evidence is malformed")
            if not nonempty(reference["documentId"]) or not nonempty(reference["eventId"]):
                raise ValueError("Story Insight evidence is malformed")
            identity = (reference["documentId"], reference["eventId"])
            if identity in evidence_seen:
                raise ValueError("Story Insight evidence is duplicated")
            evidence_seen.add(identity)
            evidence_out.append({"documentId": identity[0], "eventId": identity[1]})
        seen.add(insight["id"])
        lesson = {
            "storyKey": story["key"], "insightId": insight["id"],
            "background": insight["background"],
            "directlyAcquiredExperience": insight["directlyAcquiredExperience"],
            "principle": insight["principle"],
        }
        if "title" in insight:
            if not nonempty(insight["title"]):
                raise ValueError("Story Insight is malformed")
            lesson["title"] = insight["title"]
        parsed.append({"lesson": lesson, "evidence": evidence_out})
    return {"key": story["key"], "insights": parsed}


def read_reviewed_evidence(review_dir: Path) -> dict[tuple[str, str], str]:
    authority = read_json(review_dir / "reviewed-evidence.json")
    if not exact_object(authority, {"schema", "documents"}) or authority["schema"] != REVIEWED_EVIDENCE_SCHEMA:
        raise ValueError("reviewed evidence authority is missing or malformed")
    documents = authority["documents"]
    if not isinstance(documents, list):
        raise ValueError("reviewed evidence authority is malformed")
    events: dict[tuple[str, str], str] = {}
    document_ids: set[str] = set()
    for document in documents:
        if not exact_object(document, {"documentId", "documentKind", "events"}):
            raise ValueError("reviewed evidence authority is malformed")
        document_id = document["documentId"]
        if not nonempty(document_id) or document_id in document_ids or document["documentKind"] not in {"trajectory", "meeting"}:
            raise ValueError("reviewed evidence authority is malformed")
        document_ids.add(document_id)
        if not isinstance(document["events"], list):
            raise ValueError("reviewed evidence authority is malformed")
        for event in document["events"]:
            if not exact_object(event, {"eventId"}) or not nonempty(event["eventId"]):
                raise ValueError("reviewed evidence authority is malformed")
            identity = (document_id, event["eventId"])
            if identity in events:
                raise ValueError("reviewed evidence authority is duplicated")
            events[identity] = document["documentKind"]
    return events


def prepare(story_candidates_path: Path, review_dir: Path, privacy_summary_path: Path) -> dict[str, Any]:
    candidates = read_json(story_candidates_path)
    if not exact_object(candidates, {"schema", "candidates"}) or candidates["schema"] != STORY_CANDIDATES_SCHEMA:
        raise ValueError("story-candidates authority is malformed")
    if not isinstance(candidates["candidates"], list):
        raise ValueError("story-candidates authority is malformed")
    reviewed = read_reviewed_evidence(review_dir)
    privacy = read_json(privacy_summary_path)
    if (not exact_object(privacy, {"schema", "status", "autoRemoved"})
            or privacy["schema"] != PRIVACY_SUMMARY_SCHEMA or privacy["status"] != "complete"):
        raise ValueError("validated Privacy summary is missing or malformed")
    auto_removed = canonical_auto_removed(privacy["autoRemoved"])

    lessons: list[dict[str, Any]] = []
    identities: list[dict[str, str]] = []
    evidence: list[dict[str, str]] = []
    seen_story_keys: set[str] = set()
    seen_candidate_ids: set[str] = set()
    seen_identities: set[tuple[str, str]] = set()
    seen_evidence: set[tuple[str, str]] = set()
    for candidate in candidates["candidates"]:
        required = {"id", "documentId", "sequence", "timestamp", "summary"}
        if not exact_object(candidate, required) or not nonempty(candidate["id"]) or not nonempty(candidate["documentId"]):
            raise ValueError("story candidate is malformed")
        if candidate["id"] in seen_candidate_ids or type(candidate["sequence"]) is not int or candidate["sequence"] < 0:
            raise ValueError("story candidate is malformed")
        if candidate["timestamp"] is not None and not nonempty(candidate["timestamp"]):
            raise ValueError("story candidate is malformed")
        seen_candidate_ids.add(candidate["id"])
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
            identities.append({"storyKey": identity[0], "insightId": identity[1]})
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
        "insightIdentities": identities,
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
    parser.add_argument("--review-dir", required=True, type=Path)
    parser.add_argument("--privacy-summary", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        context = prepare(args.story_candidates, args.review_dir, args.privacy_summary)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    write_atomic(args.output, context)
    print(json.dumps({"ok": True, "inputDigest": sha256(context["reusableLessons"])}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
