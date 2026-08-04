#!/usr/bin/env python3
"""Build normalized, text-only-reviewed release candidates.

The release schema deliberately does not preserve source envelopes. Conversational
text is retained in a small normalized schema. Every other trajectory event is
reduced to an allowlisted action label, with no source identifiers, metadata,
tool arguments, outputs, artifacts, paths, timestamps, or intent summaries.
"""

from __future__ import annotations

import argparse
import copy
import gzip
import hashlib
import io
import json
import re
import shutil
import sys
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Iterable, Iterator


TOOL_VERSION = "0.7.0"
EVENT_SCHEMA = "release-redactor.event/1"
MEETING_SCHEMA = "release-redactor.meeting/1"
INDEX_VERSION = "1"
MASK_VERSION = "1"
NOTICE = (
    "Best-effort redaction v0.1; no formal anonymity guarantee. "
    "Original-contributor final review is required before release."
)
NOTICE_ZH = (
    "尽力脱敏 v0.1；不提供形式化匿名保证；发布前必须由原贡献者人工终审。"
)

SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
DEFAULT_POLICY = SKILL_DIR / "assets" / "default-policy.json"

SAFE_ACTION_TYPES = {
    "system",
    "tool_call",
    "tool_result",
    "artifact",
    "version_control",
    "agent_event",
    "user_event",
    "other",
}
SAFE_ACTORS = {"user", "assistant", "system", "tool", "other"}
TAG_RE = re.compile(r'<redacted category="[a-z0-9][a-z0-9-]{0,63}"/>')
TAG_LIKE_RE = re.compile(r"(?is)<\s*/?\s*redacted\b[^>]*>")
CATEGORY_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


class RedactionError(Exception):
    """A fail-closed user-facing error."""


@dataclass(frozen=True)
class PiiSpan:
    start: int
    end: int
    category: str
    entity_type: str


@dataclass(frozen=True)
class TextTarget:
    target_id: str
    path: str
    pointer: str
    length: int
    text_sha256: str
    source_kind: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "target_id": self.target_id,
            "path": self.path,
            "pointer": self.pointer,
            "length": self.length,
            "text_sha256": self.text_sha256,
            "source_kind": self.source_kind,
        }


def canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_text(value: str) -> str:
    return sha256_bytes(value.encode("utf-8"))


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RedactionError(f"cannot read valid JSON: {path}") from error


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def write_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value, encoding="utf-8")


def policy_path(argument: str | None) -> Path:
    return Path(argument).resolve() if argument else DEFAULT_POLICY


def load_policy(path: Path) -> dict[str, Any]:
    value = read_json(path)
    if not isinstance(value, dict):
        raise RedactionError("policy must be a JSON object")
    required = {
        "version",
        "pii",
        "semantic",
        "rules",
        "review_signals",
        "mask_categories",
    }
    if not required.issubset(value):
        raise RedactionError(
            "policy is missing one of: version, pii, semantic, rules, "
            "review_signals, mask_categories"
        )
    if not isinstance(value["rules"], list) or not isinstance(
        value["review_signals"], list
    ):
        raise RedactionError("policy rules and review_signals must be arrays")
    for rule in value["rules"]:
        if not isinstance(rule, dict):
            raise RedactionError("each policy rule must be an object")
        pattern = compiled_pattern(rule)
        replacement_group = rule.get("replacement_group")
        if replacement_group is not None and (
            not isinstance(replacement_group, str)
            or not replacement_group
            or replacement_group not in pattern.groupindex
        ):
            raise RedactionError(
                f"invalid replacement_group in rule {rule.get('id', '<unknown>')}"
            )
        preserve_placeholders = rule.get("preserve_synthetic_placeholders")
        if preserve_placeholders is not None and not isinstance(
            preserve_placeholders, bool
        ):
            raise RedactionError(
                "preserve_synthetic_placeholders must be boolean in rule "
                f"{rule.get('id', '<unknown>')}"
            )
    categories = value["mask_categories"]
    if not isinstance(categories, list) or not categories:
        raise RedactionError("policy mask_categories must be a nonempty array")
    for category in categories:
        if not isinstance(category, str) or not CATEGORY_RE.fullmatch(category):
            raise RedactionError(f"invalid policy mask category: {category!r}")
    allowed_categories = set(categories)
    pii = value["pii"]
    if not isinstance(pii, dict) or not isinstance(
        pii.get("entity_categories"), dict
    ):
        raise RedactionError("policy pii.entity_categories must be an object")
    configured_categories = set(pii["entity_categories"].values())
    configured_categories.update(
        rule.get("category")
        for rule in value["rules"]
        if isinstance(rule, dict)
    )
    configured_categories.update(
        signal.get("category")
        for signal in value["review_signals"]
        if isinstance(signal, dict)
    )
    configured_categories.update(
        {
            "pii",
            "private-entity",
            "direct-identifier",
            "speaker",
            "source-markup",
            "sensitive",
        }
    )
    if not configured_categories.issubset(allowed_categories):
        missing = sorted(configured_categories - allowed_categories)
        raise RedactionError(f"policy uses non-allowlisted categories: {missing}")
    recognizer_files = pii.get("custom_recognizer_files")
    if not isinstance(recognizer_files, list) or not recognizer_files:
        raise RedactionError("policy pii.custom_recognizer_files must be nonempty")
    ignored_entities = pii.get("ignored_entities")
    if not isinstance(ignored_entities, list) or any(
        not isinstance(entity, str) or not entity
        for entity in ignored_entities
    ):
        raise RedactionError("policy pii.ignored_entities must be an array of names")
    return value


def load_custom_recognizer_bundle(
    configuration: dict[str, Any],
) -> dict[str, Any]:
    file_names = configuration.get("custom_recognizer_files")
    if not isinstance(file_names, list) or not file_names:
        raise RedactionError("at least one custom Presidio recognizer file is required")
    recognizers: list[dict[str, Any]] = []
    sources: list[dict[str, str]] = []
    for file_name in file_names:
        if not isinstance(file_name, str) or not file_name:
            raise RedactionError("custom Presidio recognizer paths must be strings")
        relative = PurePosixPath(file_name)
        if relative.is_absolute() or ".." in relative.parts:
            raise RedactionError("custom Presidio recognizer path is unsafe")
        path = SKILL_DIR.joinpath(*relative.parts).resolve()
        try:
            path.relative_to(SKILL_DIR.resolve())
        except ValueError as error:
            raise RedactionError("custom Presidio recognizer escaped the skill") from error
        value = read_json(path)
        if not isinstance(value, dict) or value.get("version") != "1":
            raise RedactionError(f"unsupported custom recognizer file: {file_name}")
        items = value.get("recognizers")
        if not isinstance(items, list) or not items:
            raise RedactionError(f"custom recognizer file is empty: {file_name}")
        sources.append(
            {
                "path": file_name,
                "sha256": sha256_bytes(path.read_bytes()),
            }
        )
        for item in items:
            if not isinstance(item, dict):
                raise RedactionError("custom recognizer entries must be objects")
            name = item.get("name")
            entity = item.get("supported_entity")
            language = item.get("supported_language")
            patterns = item.get("patterns")
            if (
                not isinstance(name, str)
                or not name
                or not isinstance(entity, str)
                or not re.fullmatch(r"[A-Z][A-Z0-9_]{1,63}", entity)
                or not isinstance(language, str)
                or not language
                or not isinstance(patterns, list)
                or not patterns
            ):
                raise RedactionError(f"invalid custom recognizer: {name!r}")
            normalized_patterns: list[dict[str, Any]] = []
            for pattern in patterns:
                if not isinstance(pattern, dict):
                    raise RedactionError("custom recognizer patterns must be objects")
                pattern_name = pattern.get("name")
                regex = pattern.get("regex")
                score = pattern.get("score")
                if (
                    not isinstance(pattern_name, str)
                    or not pattern_name
                    or not isinstance(regex, str)
                    or not isinstance(score, (int, float))
                    or isinstance(score, bool)
                    or not 0 < float(score) <= 1
                ):
                    raise RedactionError("invalid custom recognizer pattern")
                try:
                    re.compile(regex)
                except re.error as error:
                    raise RedactionError(
                        f"invalid custom recognizer regex: {pattern_name}"
                    ) from error
                normalized_patterns.append(
                    {
                        "name": pattern_name,
                        "regex": regex,
                        "score": float(score),
                    }
                )
            recognizers.append(
                {
                    "name": name,
                    "supported_entity": entity,
                    "supported_language": language,
                    "patterns": normalized_patterns,
                }
            )
    bundle = {
        "version": "1",
        "sources": sources,
        "recognizers": recognizers,
    }
    bundle["sha256"] = sha256_text(canonical_json(bundle))
    return bundle


def regex_flags(specification: str) -> int:
    flags = 0
    mapping = {"i": re.IGNORECASE, "m": re.MULTILINE, "s": re.DOTALL}
    for character in specification:
        if character not in mapping:
            raise RedactionError(f"unsupported regex flag: {character}")
        flags |= mapping[character]
    return flags


def compiled_pattern(rule: dict[str, Any]) -> re.Pattern[str]:
    try:
        pattern = rule["pattern"]
        flags = rule.get("flags", "")
        if not isinstance(pattern, str) or not isinstance(flags, str):
            raise TypeError
        return re.compile(pattern, regex_flags(flags))
    except (KeyError, TypeError, re.error) as error:
        raise RedactionError(f"invalid regex rule: {rule.get('id', '<unknown>')}") from error


def replace_outside_tags(
    text: str,
    pattern: re.Pattern[str],
    replacement: str | Callable[[re.Match[str]], str],
) -> tuple[str, int]:
    pieces: list[str] = []
    cursor = 0
    count = 0
    for match in TAG_RE.finditer(text):
        segment, changed = pattern.subn(replacement, text[cursor : match.start()])
        pieces.extend((segment, match.group(0)))
        count += changed
        cursor = match.end()
    segment, changed = pattern.subn(replacement, text[cursor:])
    pieces.append(segment)
    count += changed
    return "".join(pieces), count


def explicit_credential_placeholder(value: str) -> bool:
    candidate = value.strip().strip("\"'")
    if candidate.lower().startswith(("bearer ", "basic ")):
        candidate = candidate.split(None, 1)[1].strip().strip("\"'")
    symbolic = re.fullmatch(
        r"(?ix)(?:"
        r"<\s*[A-Z][A-Z0-9_-]*(?:KEY|TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIAL)[A-Z0-9_-]*\s*>|"
        r"\[\s*[A-Z][A-Z0-9_-]*(?:KEY|TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIAL)[A-Z0-9_-]*\s*\]|"
        r"\$\{\s*[A-Z][A-Z0-9_-]*(?:KEY|TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIAL)[A-Z0-9_-]*\s*\}|"
        r"\{\{\s*[A-Z][A-Z0-9_-]*(?:KEY|TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIAL)[A-Z0-9_-]*\s*\}\}"
        r")",
        candidate,
    )
    if symbolic:
        return True
    normalized = re.sub(r"[ _]+", "-", candidate.casefold())
    return normalized in {
        "placeholder",
        "example",
        "dummy",
        "changeme",
        "replace-me",
        "not-a-real-secret",
        "your-api-key",
        "your-access-token",
        "your-auth-token",
        "your-password",
        "your-secret",
        "api-key-placeholder",
        "token-placeholder",
        "password-placeholder",
        "secret-placeholder",
    }


def credential_match_is_placeholder(rule: dict[str, Any], value: str) -> bool:
    if rule.get("preserve_synthetic_placeholders") is not True:
        return False
    candidates: list[str] = []
    uri_match = re.search(r"://[^:/\s]+:([^@\s/]+)@", value)
    if uri_match:
        candidates.append(uri_match.group(1))
    if "=" in value:
        candidates.append(value.rsplit("=", 1)[1])
    if ":" in value:
        candidates.append(value.rsplit(":", 1)[1])
    candidates.append(value)
    return any(explicit_credential_placeholder(candidate) for candidate in candidates)


def credential_match_value(
    rule: dict[str, Any], match: re.Match[str]
) -> str:
    replacement_group = rule.get("replacement_group")
    if replacement_group is None:
        return match.group(0)
    if not isinstance(replacement_group, str) or not replacement_group:
        raise RedactionError(
            f"invalid replacement_group in rule {rule.get('id', '<unknown>')}"
        )
    try:
        value = match.group(replacement_group)
    except (IndexError, KeyError) as error:
        raise RedactionError(
            f"unknown replacement_group in rule {rule.get('id', '<unknown>')}"
        ) from error
    if value is None:
        raise RedactionError(
            f"unmatched replacement_group in rule {rule.get('id', '<unknown>')}"
        )
    return value


def apply_policy_rule(
    text: str, rule: dict[str, Any], category: str
) -> tuple[str, int]:
    sensitive_count = 0

    def replace(match: re.Match[str]) -> str:
        nonlocal sensitive_count
        value = credential_match_value(rule, match)
        if credential_match_is_placeholder(rule, value):
            return match.group(0)
        sensitive_count += 1
        replacement = redaction_tag(category)
        if (
            len(value) >= 2
            and value[0] == value[-1]
            and value[0] in {"\"", "'"}
        ):
            replacement = value[0] + replacement + value[-1]
        replacement_group = rule.get("replacement_group")
        if replacement_group is None:
            return replacement
        start = match.start(replacement_group) - match.start()
        end = match.end(replacement_group) - match.start()
        return match.group(0)[:start] + replacement + match.group(0)[end:]

    output, _ = replace_outside_tags(text, compiled_pattern(rule), replace)
    return output, sensitive_count


def rule_has_sensitive_match(text: str, rule: dict[str, Any]) -> bool:
    return any(
        not credential_match_is_placeholder(
            rule, credential_match_value(rule, match)
        )
        for match in compiled_pattern(rule).finditer(text)
    )


def redaction_tag(category: str) -> str:
    if not CATEGORY_RE.fullmatch(category):
        raise RedactionError(f"invalid redaction category: {category!r}")
    return f'<redacted category="{category}"/>'


class PresidioPiiFilter:
    """One process-local Presidio analyzer with an explicit CPU-only spaCy engine."""

    def __init__(self, configuration: dict[str, Any]):
        if not isinstance(configuration, dict):
            raise RedactionError("policy pii configuration must be an object")
        backend = configuration.get("backend")
        model = configuration.get("model")
        language = configuration.get("language")
        threshold = configuration.get("score_threshold")
        merge_gap = configuration.get("merge_gap")
        chunk_chars = configuration.get("chunk_chars")
        entity_categories = configuration.get("entity_categories")
        ignored_entities = configuration.get("ignored_entities")
        if backend != "spacy":
            raise RedactionError("the mandatory PII backend must be spacy")
        if not isinstance(model, str) or not model:
            raise RedactionError("policy pii.model must be a nonempty string")
        if not isinstance(language, str) or not language:
            raise RedactionError("policy pii.language must be a nonempty string")
        if (
            not isinstance(threshold, (int, float))
            or isinstance(threshold, bool)
            or not 0 <= float(threshold) <= 1
        ):
            raise RedactionError("policy pii.score_threshold must be between 0 and 1")
        if (
            not isinstance(merge_gap, int)
            or isinstance(merge_gap, bool)
            or merge_gap < 0
            or merge_gap > 64
        ):
            raise RedactionError("policy pii.merge_gap must be an integer from 0 to 64")
        if (
            not isinstance(chunk_chars, int)
            or isinstance(chunk_chars, bool)
            or chunk_chars < 1000
        ):
            raise RedactionError("policy pii.chunk_chars must be at least 1000")
        if not isinstance(entity_categories, dict):
            raise RedactionError("policy pii.entity_categories must be an object")
        if not isinstance(ignored_entities, list) or any(
            not isinstance(entity, str) or not entity
            for entity in ignored_entities
        ):
            raise RedactionError("policy pii.ignored_entities must be an array")
        for entity, category in entity_categories.items():
            if (
                not isinstance(entity, str)
                or not isinstance(category, str)
                or not CATEGORY_RE.fullmatch(category)
            ):
                raise RedactionError("invalid Presidio entity category mapping")
        try:
            import spacy
            import presidio_anonymizer  # noqa: F401
            from presidio_analyzer import AnalyzerEngine, Pattern, PatternRecognizer
            from presidio_analyzer.nlp_engine import NlpEngineProvider
        except ImportError as error:
            raise RedactionError(
                "mandatory Presidio/spaCy CPU dependencies are missing; run "
                f"`python3 {SCRIPT_DIR / 'install_cpu_dependencies.py'} "
                "--venv .venv`, activate it, and retry (no Docker)"
            ) from error
        try:
            spacy.require_cpu()
            nlp_configuration = {
                "nlp_engine_name": "spacy",
                "models": [{"lang_code": language, "model_name": model}],
            }
            nlp_engine = NlpEngineProvider(
                nlp_configuration=nlp_configuration
            ).create_engine()
            self.analyzer = AnalyzerEngine(
                nlp_engine=nlp_engine,
                supported_languages=[language],
            )
            self.custom_recognizer_bundle = load_custom_recognizer_bundle(
                configuration
            )
            for specification in self.custom_recognizer_bundle["recognizers"]:
                if specification["supported_language"] != language:
                    raise RedactionError(
                        "custom recognizer language differs from the PII language"
                    )
                recognizer = PatternRecognizer(
                    name=specification["name"],
                    supported_entity=specification["supported_entity"],
                    supported_language=specification["supported_language"],
                    patterns=[
                        Pattern(
                            name=pattern["name"],
                            regex=pattern["regex"],
                            score=pattern["score"],
                        )
                        for pattern in specification["patterns"]
                    ],
                )
                self.analyzer.registry.add_recognizer(recognizer)
        except Exception as error:
            raise RedactionError(
                "cannot initialize the mandatory CPU-only Presidio spaCy engine; "
                f"verify the `{model}` model with `python3 -m spacy validate`"
            ) from error
        self.model = model
        self.language = language
        self.score_threshold = float(threshold)
        self.merge_gap = merge_gap
        self.chunk_chars = chunk_chars
        self.entity_categories = {
            str(entity).upper(): str(category)
            for entity, category in entity_categories.items()
        }
        self.ignored_entities = {
            str(entity).upper() for entity in ignored_entities
        }
        self.metrics: dict[str, Any] = {
            "backend": "presidio",
            "nlp_engine": "spacy",
            "device": "cpu",
            "model": model,
            "language": language,
            "score_threshold": self.score_threshold,
            "texts_analyzed": 0,
            "raw_detections": 0,
            "merged_tags": 0,
            "entity_counts": {},
            "ignored_entities": sorted(self.ignored_entities),
            "custom_recognizers": [
                item["name"]
                for item in self.custom_recognizer_bundle["recognizers"]
            ],
            "custom_recognizer_sha256": self.custom_recognizer_bundle["sha256"],
        }

    def _chunks(self, text: str) -> Iterator[tuple[int, str]]:
        if len(text) <= self.chunk_chars:
            yield 0, text
            return
        overlap = min(256, max(32, self.chunk_chars // 20))
        start = 0
        while start < len(text):
            maximum_end = min(len(text), start + self.chunk_chars)
            end = maximum_end
            if maximum_end < len(text):
                lower_bound = start + self.chunk_chars // 2
                candidates = [
                    text.rfind(separator, lower_bound, maximum_end)
                    for separator in ("\n\n", "\n", ". ", "。", " ")
                ]
                boundary = max(candidates)
                if boundary >= lower_bound:
                    end = boundary + 1
            yield start, text[start:end]
            if end >= len(text):
                break
            start = max(start + 1, end - overlap)

    def _category(self, entity_type: str) -> str:
        return self.entity_categories.get(entity_type.upper(), "pii")

    def _coalesce(self, spans: list[PiiSpan]) -> list[PiiSpan]:
        if not spans:
            return []
        spans.sort(key=lambda item: (item.start, item.end, item.category))
        merged: list[PiiSpan] = []
        current = spans[0]
        for item in spans[1:]:
            if item.start <= current.end + self.merge_gap:
                categories = {current.category, item.category}
                entities = {
                    part
                    for value in (current.entity_type, item.entity_type)
                    for part in value.split(",")
                }
                current = PiiSpan(
                    start=current.start,
                    end=max(current.end, item.end),
                    category=(
                        next(iter(categories))
                        if len(categories) == 1
                        else "pii"
                    ),
                    entity_type=",".join(sorted(entities)),
                )
            else:
                merged.append(current)
                current = item
        merged.append(current)
        return merged

    def filter(self, text: str) -> tuple[str, dict[str, int]]:
        analysis_text = text_without_tags(text)
        detections: list[PiiSpan] = []
        local_entities: dict[str, int] = {}
        for chunk_start, chunk in self._chunks(analysis_text):
            try:
                results = self.analyzer.analyze(
                    text=chunk,
                    language=self.language,
                    score_threshold=self.score_threshold,
                )
            except Exception as error:
                raise RedactionError(
                    "Presidio analysis failed; no semantic baseline was created"
                ) from error
            for result in results:
                start = getattr(result, "start", None)
                end = getattr(result, "end", None)
                entity_type = str(getattr(result, "entity_type", "PII")).upper()
                if entity_type in self.ignored_entities:
                    continue
                if (
                    not isinstance(start, int)
                    or not isinstance(end, int)
                    or start < 0
                    or end <= start
                    or end > len(chunk)
                ):
                    raise RedactionError("Presidio returned an invalid PII span")
                absolute_start = chunk_start + start
                absolute_end = chunk_start + end
                pieces = [(absolute_start, absolute_end)]
                for tag in TAG_RE.finditer(text):
                    next_pieces: list[tuple[int, int]] = []
                    for piece_start, piece_end in pieces:
                        if piece_start >= tag.end() or piece_end <= tag.start():
                            next_pieces.append((piece_start, piece_end))
                            continue
                        if piece_start < tag.start():
                            next_pieces.append((piece_start, tag.start()))
                        if piece_end > tag.end():
                            next_pieces.append((tag.end(), piece_end))
                    pieces = next_pieces
                for piece_start, piece_end in pieces:
                    if not analysis_text[piece_start:piece_end].strip():
                        continue
                    detections.append(
                        PiiSpan(
                            start=piece_start,
                            end=piece_end,
                            category=self._category(entity_type),
                            entity_type=entity_type,
                        )
                    )
                local_entities[entity_type] = local_entities.get(entity_type, 0) + 1
        merged = self._coalesce(detections)
        output = text
        for span in reversed(merged):
            output = (
                output[: span.start]
                + redaction_tag(span.category)
                + output[span.end :]
            )
        self.metrics["texts_analyzed"] += 1
        self.metrics["raw_detections"] += sum(local_entities.values())
        self.metrics["merged_tags"] += len(merged)
        entity_counts = self.metrics["entity_counts"]
        for entity_type, count in local_entities.items():
            entity_counts[entity_type] = entity_counts.get(entity_type, 0) + count
        return output, {
            f"presidio:{entity_type.lower()}": count
            for entity_type, count in local_entities.items()
        }


def neutralize_source_tags(text: str) -> str:
    text = TAG_LIKE_RE.sub(redaction_tag("source-markup"), text)
    return re.sub(
        r"(?i)<\s*redacted\b",
        redaction_tag("source-markup"),
        text,
    )


def mask_speaker_prefixes(text: str) -> str:
    pattern = re.compile(r"(?m)^([^\n:<>{}]{1,48})(:\s+)")

    def replace(match: re.Match[str]) -> str:
        prefix = match.group(1).strip()
        if not any(character.isalpha() for character in prefix):
            return match.group(0)
        return redaction_tag("speaker") + match.group(2)

    output, _ = replace_outside_tags(text, pattern, replace)  # type: ignore[arg-type]
    return output


def redact_text(
    text: str,
    policy: dict[str, Any],
    pii_filter: PresidioPiiFilter,
    *,
    meeting: bool = False,
) -> tuple[str, dict[str, int]]:
    output = neutralize_source_tags(text)
    metrics: dict[str, int] = {}
    if meeting:
        before = output
        output = mask_speaker_prefixes(output)
        if output != before:
            metrics["speaker-prefix"] = 1
    output, pii_metrics = pii_filter.filter(output)
    merge_metrics(metrics, pii_metrics)
    for rule in policy["rules"]:
        if not isinstance(rule, dict):
            raise RedactionError("each policy rule must be an object")
        category = rule.get("category")
        rule_id = rule.get("id")
        if not isinstance(category, str) or not CATEGORY_RE.fullmatch(category):
            raise RedactionError(f"invalid category in rule {rule_id!r}")
        output, count = apply_policy_rule(output, rule, category)
        if count:
            metrics[str(rule_id)] = metrics.get(str(rule_id), 0) + count
    return output, metrics


def merge_metrics(destination: dict[str, int], source: dict[str, int]) -> None:
    for key, value in source.items():
        destination[key] = destination.get(key, 0) + value


def normalize_role(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    role = value.strip().lower()
    if role in {"user", "human", "customer"}:
        return "user"
    if role in {"assistant", "agent", "model", "ai"}:
        return "assistant"
    return None


def extract_text_value(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                item_type = str(item.get("type", "")).lower()
                if item_type in {"text", "input_text", "output_text", ""}:
                    candidate = item.get("text", item.get("content"))
                    if isinstance(candidate, str):
                        parts.append(candidate)
        return "\n".join(parts) if parts else None
    return None


def extract_conversation_text(event: dict[str, Any]) -> tuple[str, str] | None:
    event_type = str(event.get("event_type", event.get("type", ""))).strip().lower()
    if event_type not in {"message", "user", "assistant", "agent"}:
        return None
    payload = event.get("payload")
    payload_dict = payload if isinstance(payload, dict) else {}
    actor = event.get("actor")
    actor_dict = actor if isinstance(actor, dict) else {}
    role = (
        normalize_role(payload_dict.get("role"))
        or normalize_role(event.get("role"))
        or normalize_role(actor_dict.get("type"))
    )
    if role is None:
        if event_type == "user":
            role = "user"
        elif event_type in {"assistant", "agent"}:
            role = "assistant"
    if role is None:
        return None
    for container in (payload_dict, event):
        for key in ("text", "content", "message"):
            text = extract_text_value(container.get(key))
            if text is not None:
                return role, text
    return None


def action_type_for(event: dict[str, Any]) -> str:
    raw = str(event.get("event_type", event.get("type", ""))).strip().lower()
    if raw in {"system", "developer", "session", "session_start", "session_end"}:
        return "system"
    if raw in {
        "tool_call",
        "tool",
        "command",
        "execution",
        "function_call",
        "computer",
    }:
        return "tool_call"
    if raw in {
        "tool_result",
        "tool_output",
        "command_result",
        "execution_result",
        "function_result",
    }:
        return "tool_result"
    if raw in {"artifact", "attachment", "file", "patch", "image"}:
        return "artifact"
    if raw in {"git", "version_control", "version-control", "commit"}:
        return "version_control"
    if raw in {"agent", "assistant", "model"}:
        return "agent_event"
    if raw in {"user", "human"}:
        return "user_event"
    return "other"


def actor_for_action(action_type: str) -> str:
    if action_type in {"tool_call", "tool_result", "artifact"}:
        return "tool"
    if action_type == "agent_event":
        return "assistant"
    if action_type == "user_event":
        return "user"
    if action_type in {"system", "version_control"}:
        return "system"
    return "other"


def read_jsonl(path: Path) -> list[Any]:
    values: list[Any] = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError) as error:
        raise RedactionError(f"cannot read UTF-8 JSONL: {path}") from error
    for line_number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            values.append(json.loads(line))
        except json.JSONDecodeError as error:
            raise RedactionError(f"invalid JSONL at {path}:{line_number}") from error
    return values


def write_jsonl(path: Path, values: Iterable[Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(canonical_json(value) + "\n" for value in values),
        encoding="utf-8",
    )


def normalize_trajectory(
    source_dir: Path,
    output_dir: Path,
    trajectory_number: int,
    policy: dict[str, Any],
    pii_filter: PresidioPiiFilter,
    targets: list[TextTarget],
    metrics: dict[str, int],
) -> None:
    events_path = source_dir / "events.jsonl"
    source_events = read_jsonl(events_path)
    trajectory_id = f"trajectory-{trajectory_number:06d}"
    output_events: list[dict[str, Any]] = []
    relative_path = (
        f"data/trajectories/{trajectory_id}/events.jsonl"
    )
    for index, raw_event in enumerate(source_events):
        event = raw_event if isinstance(raw_event, dict) else {}
        conversation = extract_conversation_text(event)
        event_id = f"event-{index + 1:06d}"
        if conversation is not None:
            role, source_text = conversation
            text, counts = redact_text(
                source_text,
                policy,
                pii_filter,
            )
            merge_metrics(metrics, counts)
            normalized = {
                "schema_version": EVENT_SCHEMA,
                "event_id": event_id,
                "trajectory_id": trajectory_id,
                "turn_id": f"turn-{index + 1:06d}",
                "sequence": index,
                "event_type": "message",
                "actor": {"type": role},
                "payload": {"role": role, "text": text},
                "relations": [],
            }
            pointer = f"/{index}/payload/text"
            targets.append(
                TextTarget(
                    target_id=f"text-{len(targets) + 1:08d}",
                    path=relative_path,
                    pointer=pointer,
                    length=len(text),
                    text_sha256=sha256_text(text),
                    source_kind="trajectory-message",
                )
            )
        else:
            action_type = action_type_for(event)
            normalized = {
                "schema_version": EVENT_SCHEMA,
                "event_id": event_id,
                "trajectory_id": trajectory_id,
                "turn_id": None,
                "sequence": index,
                "event_type": "action_label",
                "actor": {"type": actor_for_action(action_type)},
                "payload": {"action_type": action_type},
                "relations": [],
            }
        output_events.append(normalized)
    write_jsonl(output_dir / trajectory_id / "events.jsonl", output_events)


def trajectory_directories(source: Path) -> list[Path]:
    if (source / "events.jsonl").is_file():
        return [source]
    directories = sorted(
        {path.parent for path in source.rglob("events.jsonl")},
        key=lambda path: path.as_posix(),
    )
    if not directories:
        raise RedactionError(f"no trajectory events.jsonl found under: {source}")
    return directories


def record_text(record: Any) -> str | None:
    if isinstance(record, str):
        return record
    if not isinstance(record, dict):
        return None
    for key in ("text", "content", "message", "note", "summary", "transcript"):
        value = extract_text_value(record.get(key))
        if value is not None:
            return value
    return None


def meeting_texts(source: Path) -> list[str]:
    suffix = source.suffix.lower()
    if suffix in {".md", ".markdown", ".txt"}:
        try:
            return [source.read_text(encoding="utf-8")]
        except (OSError, UnicodeDecodeError) as error:
            raise RedactionError(f"cannot read meeting notes as UTF-8: {source}") from error
    value = read_json(source)
    records: Any
    if isinstance(value, dict) and isinstance(value.get("records"), list):
        records = value["records"]
    elif isinstance(value, dict) and isinstance(value.get("turns"), list):
        records = value["turns"]
    elif isinstance(value, list):
        records = value
    else:
        records = [value]
    texts = [text for item in records if (text := record_text(item)) is not None]
    if not texts:
        raise RedactionError("meeting/dialogue input contains no reviewable text records")
    return texts


def normalize_meeting(
    source: Path,
    output_path: Path,
    policy: dict[str, Any],
    pii_filter: PresidioPiiFilter,
    targets: list[TextTarget],
    metrics: dict[str, int],
) -> None:
    records: list[dict[str, Any]] = []
    relative_path = "data/meeting-transcripts.json"
    for index, source_text in enumerate(meeting_texts(source)):
        text, counts = redact_text(
            source_text,
            policy,
            pii_filter,
            meeting=True,
        )
        merge_metrics(metrics, counts)
        records.append(
            {
                "record_id": f"record-{index + 1:06d}",
                "sequence": index,
                "speaker": "participant",
                "text": text,
            }
        )
        targets.append(
            TextTarget(
                target_id=f"text-{len(targets) + 1:08d}",
                path=relative_path,
                pointer=f"/records/{index}/text",
                length=len(text),
                text_sha256=sha256_text(text),
                source_kind="meeting-text",
            )
        )
    write_json(
        output_path,
        {
            "schema_version": MEETING_SCHEMA,
            "records": records,
        },
    )


def detect_kind(source: Path) -> str:
    if source.is_dir() and (
        (source / "events.jsonl").is_file()
        or any(source.rglob("events.jsonl"))
    ):
        return "trajectory"
    if source.is_file() and source.suffix.lower() in {
        ".json",
        ".md",
        ".markdown",
        ".txt",
    }:
        return "meeting"
    raise RedactionError("cannot detect input kind; pass --kind explicitly")


def safe_case_dir(case_dir: Path) -> None:
    if case_dir.exists() and any(case_dir.iterdir()):
        raise RedactionError(f"case directory must be empty or absent: {case_dir}")
    case_dir.mkdir(parents=True, exist_ok=True)


def tree_hash(root: Path) -> str:
    digest = hashlib.sha256()
    if not root.exists():
        return digest.hexdigest()
    for path in sorted(
        (item for item in root.rglob("*") if item.is_file()),
        key=lambda item: item.relative_to(root).as_posix(),
    ):
        relative = path.relative_to(root).as_posix().encode("utf-8")
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        data = path.read_bytes()
        digest.update(len(data).to_bytes(8, "big"))
        digest.update(data)
    return digest.hexdigest()


def semantic_findings(
    automatic_root: Path,
    targets: list[TextTarget],
    policy: dict[str, Any],
) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    texts = load_target_texts(automatic_root, targets)
    semantic_configuration = policy.get("semantic")
    if not isinstance(semantic_configuration, dict):
        raise RedactionError("policy semantic configuration must be an object")
    if semantic_configuration.get("expand_to") != "sentence":
        raise RedactionError("policy semantic.expand_to must be sentence")
    merge_gap = semantic_configuration.get("merge_gap")
    if (
        not isinstance(merge_gap, int)
        or isinstance(merge_gap, bool)
        or merge_gap < 0
        or merge_gap > 512
    ):
        raise RedactionError("policy semantic.merge_gap must be from 0 to 512")
    severity_rank = {"low": 0, "medium": 1, "high": 2, "critical": 3}
    for target in targets:
        text = texts[target.target_id]
        analysis_text = text_without_tags(text)
        raw: list[dict[str, Any]] = []
        for signal in policy["review_signals"]:
            if not isinstance(signal, dict):
                raise RedactionError("each review signal must be an object")
            pattern = compiled_pattern(signal)
            for match in pattern.finditer(analysis_text):
                start, end = semantic_sentence_span(
                    analysis_text, match.start(), match.end()
                )
                raw.append(
                    {
                        "start": start,
                        "end": end,
                        "signal_ids": {str(signal.get("id", "unknown"))},
                        "categories": {
                            str(signal.get("category", "sensitive"))
                        },
                        "severity": str(signal.get("severity", "high")),
                    }
                )
        raw.sort(key=lambda item: (item["start"], item["end"]))
        consolidated: list[dict[str, Any]] = []
        for item in raw:
            if (
                consolidated
                and item["start"] <= consolidated[-1]["end"] + merge_gap
            ):
                current = consolidated[-1]
                current["end"] = max(current["end"], item["end"])
                current["signal_ids"].update(item["signal_ids"])
                current["categories"].update(item["categories"])
                if severity_rank.get(item["severity"], 2) > severity_rank.get(
                    current["severity"], 2
                ):
                    current["severity"] = item["severity"]
            else:
                consolidated.append(item)
        for item in consolidated:
            categories = sorted(item["categories"])
            category = categories[0] if len(categories) == 1 else "sensitive"
            findings.append(
                {
                    "finding_id": f"review-{len(findings) + 1:08d}",
                    "target_id": target.target_id,
                    "path": target.path,
                    "pointer": target.pointer,
                    "signal_ids": sorted(item["signal_ids"]),
                    "categories": categories,
                    "category": category,
                    "severity": item["severity"],
                    "start": item["start"],
                    "end": item["end"],
                    "selected_sha256": sha256_text(
                        text[item["start"] : item["end"]]
                    ),
                }
            )
    return findings


def semantic_sentence_span(text: str, start: int, end: int) -> tuple[int, int]:
    delimiters = set("\n.!?。！？；;")
    expanded_start = start
    while expanded_start > 0 and text[expanded_start - 1] not in delimiters:
        expanded_start -= 1
    while expanded_start < start and text[expanded_start].isspace():
        expanded_start += 1
    expanded_end = end
    while expanded_end < len(text) and text[expanded_end] not in delimiters:
        expanded_end += 1
    if expanded_end < len(text):
        expanded_end += 1
    while expanded_end > end and text[expanded_end - 1].isspace():
        expanded_end -= 1
    return expanded_start, expanded_end


def suggested_mask_plan(
    targets: list[TextTarget], findings: list[dict[str, Any]]
) -> dict[str, Any]:
    target_index = {target.target_id: target for target in targets}
    grouped: dict[str, list[dict[str, Any]]] = {}
    for finding in findings:
        target_id = str(finding["target_id"])
        grouped.setdefault(target_id, []).append(
            {
                "start": finding["start"],
                "end": finding["end"],
                "category": finding["category"],
            }
        )
    return {
        "version": MASK_VERSION,
        "targets": [
            {
                "target_id": target_id,
                "text_sha256": target_index[target_id].text_sha256,
                "spans": grouped[target_id],
            }
            for target_id in sorted(grouped)
        ],
    }


def text_without_tags(text: str) -> str:
    return TAG_RE.sub(lambda match: " " * len(match.group(0)), text)


def initial_approval() -> dict[str, Any]:
    return {
        "version": "1",
        "semantic_review_complete": False,
        "original_contributor_reviewed": False,
        "privacy_reviewer_reviewed": False,
        "publication_approved": False,
        "review_roles": {
            "semantic": "",
            "original_contributor": "",
            "privacy": "",
            "publisher": "",
        },
    }


def prepare_case(args: argparse.Namespace) -> None:
    source = Path(args.input).resolve()
    case_dir = Path(args.case_dir).resolve()
    if not source.exists():
        raise RedactionError(f"input does not exist: {source}")
    selected_policy_path = policy_path(args.policy)
    policy = load_policy(selected_policy_path)
    pii_filter = PresidioPiiFilter(policy.get("pii"))
    kind = detect_kind(source) if args.kind == "auto" else args.kind
    if kind == "dialogue":
        kind = "meeting"
    safe_case_dir(case_dir)
    automatic_root = case_dir / "automatic"
    private_root = case_dir / "private"
    targets: list[TextTarget] = []
    metrics: dict[str, int] = {}
    if kind == "trajectory":
        output_root = automatic_root / "data" / "trajectories"
        for number, directory in enumerate(trajectory_directories(source), 1):
            normalize_trajectory(
                directory,
                output_root,
                number,
                policy,
                pii_filter,
                targets,
                metrics,
            )
    elif kind == "meeting":
        normalize_meeting(
            source,
            automatic_root / "data" / "meeting-transcripts.json",
            policy,
            pii_filter,
            targets,
            metrics,
        )
    else:
        raise RedactionError(f"unsupported input kind: {kind}")
    index = {
        "version": INDEX_VERSION,
        "targets": [target.as_dict() for target in targets],
    }
    write_json(private_root / "text-index.json", index)
    findings = semantic_findings(automatic_root, targets, policy)
    write_json(
        private_root / "findings.json",
        {
            "version": "1",
            "findings": findings,
        },
    )
    write_json(
        private_root / "suggested-mask-plan.json",
        suggested_mask_plan(targets, findings),
    )
    write_json(private_root / "masks.json", {"version": MASK_VERSION, "targets": []})
    write_json(private_root / "waivers.json", {"version": "1", "waivers": []})
    write_json(
        private_root / "pii-state.json",
        {
            "version": "1",
            **pii_filter.metrics,
        },
    )
    write_json(
        private_root / "presidio-custom-recognizers.json",
        pii_filter.custom_recognizer_bundle,
    )
    shutil.copy2(selected_policy_path, private_root / "policy.json")
    write_json(
        private_root / "source.json",
        {
            "source_path": str(source),
        },
    )
    write_json(
        case_dir / "case.json",
        {
            "version": "1",
            "tool_version": TOOL_VERSION,
            "kind": kind,
            "notice": NOTICE,
            "policy_version": policy["version"],
            "pii_filter": {
                "backend": "presidio",
                "nlp_engine": "spacy",
                "device": "cpu",
                "model": pii_filter.model,
                "language": pii_filter.language,
                "custom_recognizer_sha256": (
                    pii_filter.custom_recognizer_bundle["sha256"]
                ),
            },
            "automatic_sha256": tree_hash(automatic_root),
            "text_target_count": len(targets),
            "automatic_redactions": metrics,
        },
    )
    write_json(case_dir / "approval.json", initial_approval())
    apply_case(case_dir)
    finding_count = len(findings)
    print(
        canonical_json(
            {
                "case_dir": str(case_dir),
                "kind": kind,
                "text_targets": len(targets),
                "semantic_findings": finding_count,
                "action_events_reviewed": 0,
            }
        )
    )


def require_case(case_dir: Path) -> dict[str, Any]:
    case_path = case_dir / "case.json"
    if not case_path.is_file():
        raise RedactionError(f"not a release-redactor case: {case_dir}")
    value = read_json(case_path)
    if not isinstance(value, dict):
        raise RedactionError("case.json must be an object")
    return value


def load_text_index(case_dir: Path) -> list[TextTarget]:
    value = read_json(case_dir / "private" / "text-index.json")
    if not isinstance(value, dict) or value.get("version") != INDEX_VERSION:
        raise RedactionError("unsupported text-index version")
    targets = value.get("targets")
    if not isinstance(targets, list):
        raise RedactionError("text-index targets must be an array")
    result: list[TextTarget] = []
    locations: set[tuple[str, str]] = set()
    for index, item in enumerate(targets, 1):
        try:
            target = TextTarget(
                target_id=item["target_id"],
                path=item["path"],
                pointer=item["pointer"],
                length=item["length"],
                text_sha256=item["text_sha256"],
                source_kind=item["source_kind"],
            )
        except (KeyError, TypeError) as error:
            raise RedactionError("invalid text-index target") from error
        if (
            not isinstance(target.target_id, str)
            or not isinstance(target.path, str)
            or not isinstance(target.pointer, str)
            or not isinstance(target.length, int)
            or not isinstance(target.text_sha256, str)
            or not isinstance(target.source_kind, str)
        ):
            raise RedactionError("invalid text-index target field type")
        if target.target_id != f"text-{index:08d}":
            raise RedactionError("text-index target IDs are not canonical")
        validate_relative_path(target.path)
        pointer_parts(target.pointer)
        if target.length < 0 or not re.fullmatch(
            r"[0-9a-f]{64}", target.text_sha256
        ):
            raise RedactionError("invalid text-index length or hash")
        location = (target.path, target.pointer)
        if location in locations:
            raise RedactionError("duplicate text-index location")
        locations.add(location)
        result.append(target)
    return result


def validate_relative_path(value: str) -> PurePosixPath:
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise RedactionError(f"unsafe case-relative path: {value!r}")
    if path.parts[0] != "data":
        raise RedactionError("review paths must be under data/")
    return path


def pointer_parts(pointer: str) -> list[str]:
    if pointer == "":
        return []
    if not pointer.startswith("/"):
        raise RedactionError(f"invalid JSON pointer: {pointer!r}")
    return [
        item.replace("~1", "/").replace("~0", "~")
        for item in pointer[1:].split("/")
    ]


def load_document(root: Path, relative_path: str) -> tuple[str, Any]:
    relative = validate_relative_path(relative_path)
    path = root.joinpath(*relative.parts)
    if not path.is_file():
        raise RedactionError(f"review file is missing: {relative_path}")
    if path.suffix == ".jsonl":
        return "jsonl", read_jsonl(path)
    if path.suffix == ".json":
        return "json", read_json(path)
    try:
        return "text", path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise RedactionError(f"review file is not UTF-8 text: {relative_path}") from error


def write_document(root: Path, relative_path: str, kind: str, value: Any) -> None:
    relative = validate_relative_path(relative_path)
    path = root.joinpath(*relative.parts)
    if kind == "jsonl":
        write_jsonl(path, value)
    elif kind == "json":
        write_json(path, value)
    elif kind == "text":
        if not isinstance(value, str):
            raise RedactionError("text document must remain a string")
        write_text(path, value)
    else:
        raise RedactionError(f"unsupported document kind: {kind}")


def pointer_get(document: Any, pointer: str) -> Any:
    value = document
    for part in pointer_parts(pointer):
        if isinstance(value, list):
            try:
                index = int(part)
                value = value[index]
            except (ValueError, IndexError) as error:
                raise RedactionError(f"JSON pointer index is invalid: {pointer}") from error
        elif isinstance(value, dict):
            if part not in value:
                raise RedactionError(f"JSON pointer key is missing: {pointer}")
            value = value[part]
        else:
            raise RedactionError(f"JSON pointer traverses a scalar: {pointer}")
    return value


def pointer_set(document: Any, pointer: str, replacement: Any) -> Any:
    parts = pointer_parts(pointer)
    if not parts:
        return replacement
    value = document
    for part in parts[:-1]:
        if isinstance(value, list):
            try:
                value = value[int(part)]
            except (ValueError, IndexError) as error:
                raise RedactionError(f"JSON pointer index is invalid: {pointer}") from error
        elif isinstance(value, dict) and part in value:
            value = value[part]
        else:
            raise RedactionError(f"JSON pointer is invalid: {pointer}")
    final = parts[-1]
    if isinstance(value, list):
        try:
            value[int(final)] = replacement
        except (ValueError, IndexError) as error:
            raise RedactionError(f"JSON pointer index is invalid: {pointer}") from error
    elif isinstance(value, dict) and final in value:
        value[final] = replacement
    else:
        raise RedactionError(f"JSON pointer is invalid: {pointer}")
    return document


def get_target_text(root: Path, relative_path: str, pointer: str) -> str:
    kind, document = load_document(root, relative_path)
    if kind == "text" and pointer:
        raise RedactionError("plain text targets must use an empty pointer")
    value = pointer_get(document, pointer)
    if not isinstance(value, str):
        raise RedactionError(f"review target is not text: {relative_path} {pointer}")
    return value


def load_target_texts(
    root: Path, targets: Iterable[TextTarget]
) -> dict[str, str]:
    documents: dict[str, tuple[str, Any]] = {}
    texts: dict[str, str] = {}
    for target in targets:
        if target.path not in documents:
            documents[target.path] = load_document(root, target.path)
        kind, document = documents[target.path]
        if kind == "text" and target.pointer:
            raise RedactionError("plain text targets must use an empty pointer")
        value = pointer_get(document, target.pointer)
        if not isinstance(value, str):
            raise RedactionError(
                f"review target is not text: {target.path} {target.pointer}"
            )
        texts[target.target_id] = value
    return texts


def text_index_command(args: argparse.Namespace) -> None:
    case_dir = Path(args.case_dir).resolve()
    require_case(case_dir)
    targets = load_text_index(case_dir)
    if args.json:
        print(canonical_json({"version": INDEX_VERSION, "targets": [t.as_dict() for t in targets]}))
        return
    print("target_id\tpath\tpointer\tlength\ttext_sha256\tsource_kind")
    for target in targets:
        print(
            "\t".join(
                (
                    target.target_id,
                    target.path,
                    target.pointer,
                    str(target.length),
                    target.text_sha256,
                    target.source_kind,
                )
            )
        )


def findings_command(args: argparse.Namespace) -> None:
    case_dir = Path(args.case_dir).resolve()
    require_case(case_dir)
    findings_value = read_json(case_dir / "private" / "findings.json")
    findings = findings_value.get("findings", [])
    if args.json:
        print(canonical_json(findings_value))
        return
    print("finding_id\ttarget_id\tcategory\tseverity\tstart\tend\tpath\tpointer")
    for finding in findings:
        print(
            "\t".join(
                (
                    str(finding["finding_id"]),
                    str(finding["target_id"]),
                    str(finding["category"]),
                    str(finding["severity"]),
                    str(finding["start"]),
                    str(finding["end"]),
                    str(finding["path"]),
                    str(finding["pointer"]),
                )
            )
        )


def masks_hash(value: dict[str, Any]) -> str:
    return sha256_text(canonical_json(value))


def validate_span(
    span: Any,
    text: str,
    categories: set[str],
) -> dict[str, Any]:
    if not isinstance(span, dict):
        raise RedactionError("each mask span must be an object")
    allowed_keys = {"start", "end", "category", "selected_sha256"}
    if set(span) - allowed_keys:
        raise RedactionError(
            f"unsupported mask span fields: {sorted(set(span) - allowed_keys)}"
        )
    start = span.get("start")
    end = span.get("end")
    category = span.get("category")
    if (
        not isinstance(start, int)
        or isinstance(start, bool)
        or not isinstance(end, int)
        or isinstance(end, bool)
        or not isinstance(category, str)
    ):
        raise RedactionError("mask spans require integer start/end and string category")
    if start < 0 or end <= start or end > len(text):
        raise RedactionError(
            f"mask span [{start}, {end}) is outside text length {len(text)}"
        )
    if category not in categories:
        raise RedactionError(f"mask category is not allowlisted: {category}")
    for match in TAG_RE.finditer(text):
        if start < match.end() and end > match.start():
            if start > match.start() or end < match.end():
                raise RedactionError(
                    "manual mask spans may contain an automatic tag but must not "
                    "cut through one"
                )
    selected_hash = sha256_text(text[start:end])
    supplied_hash = span.get("selected_sha256")
    if supplied_hash is not None and supplied_hash != selected_hash:
        raise RedactionError("selected_sha256 does not match the automatic text")
    return {
        "start": start,
        "end": end,
        "category": category,
        "selected_sha256": selected_hash,
    }


def mask_text_command(args: argparse.Namespace) -> None:
    case_dir = Path(args.case_dir).resolve()
    require_case(case_dir)
    plan_path = Path(args.plan).resolve()
    plan = read_json(plan_path)
    if not isinstance(plan, dict) or plan.get("version") != MASK_VERSION:
        raise RedactionError(f"mask plan version must be {MASK_VERSION!r}")
    plan_targets = plan.get("targets")
    if not isinstance(plan_targets, list) or not plan_targets:
        raise RedactionError("mask plan targets must be a nonempty array")
    index = {target.target_id: target for target in load_text_index(case_dir)}
    policy = load_policy(case_dir / "private" / "policy.json")
    categories = set(policy["mask_categories"])
    automatic_texts = load_target_texts(case_dir / "automatic", index.values())
    current = read_json(case_dir / "private" / "masks.json")
    if not isinstance(current, dict) or current.get("version") != MASK_VERSION:
        raise RedactionError("unsupported masks ledger version")
    current_targets = current.get("targets")
    if not isinstance(current_targets, list):
        raise RedactionError("masks ledger targets must be an array")
    by_id: dict[str, dict[str, Any]] = {}
    for existing in current_targets:
        if not isinstance(existing, dict) or not isinstance(
            existing.get("target_id"), str
        ):
            raise RedactionError("invalid masks ledger target")
        by_id[existing["target_id"]] = existing
    seen: set[str] = set()
    total_spans = 0
    for proposed in plan_targets:
        if not isinstance(proposed, dict):
            raise RedactionError("each mask target must be an object")
        allowed_keys = {"target_id", "text_sha256", "spans"}
        if set(proposed) - allowed_keys:
            raise RedactionError(
                f"unsupported mask target fields: {sorted(set(proposed) - allowed_keys)}"
            )
        target_id = proposed.get("target_id")
        supplied_hash = proposed.get("text_sha256")
        spans = proposed.get("spans")
        if not isinstance(target_id, str) or target_id not in index:
            raise RedactionError(f"unknown text target: {target_id!r}")
        if target_id in seen:
            raise RedactionError(f"duplicate mask target in plan: {target_id}")
        seen.add(target_id)
        target = index[target_id]
        if supplied_hash != target.text_sha256:
            raise RedactionError(
                f"text_sha256 is required and must match the index for {target_id}"
            )
        text = automatic_texts[target_id]
        if len(text) != target.length or sha256_text(text) != target.text_sha256:
            raise RedactionError(f"automatic text changed for {target_id}")
        if not isinstance(spans, list) or not spans:
            raise RedactionError(f"{target_id} requires at least one span")
        normalized = [validate_span(span, text, categories) for span in spans]
        normalized.sort(key=lambda span: (span["start"], span["end"]))
        for left, right in zip(normalized, normalized[1:]):
            if left["end"] > right["start"]:
                raise RedactionError(f"overlapping mask spans in {target_id}")
        by_id[target_id] = {
            "target_id": target_id,
            "path": target.path,
            "pointer": target.pointer,
            "text_sha256": target.text_sha256,
            "spans": normalized,
        }
        total_spans += len(normalized)
    ledger = {
        "version": MASK_VERSION,
        "targets": [by_id[key] for key in sorted(by_id)],
    }
    write_json(case_dir / "private" / "masks.json", ledger)
    apply_case(case_dir)
    print(
        canonical_json(
            {
                "updated_targets": len(seen),
                "submitted_spans": total_spans,
                "total_masked_targets": len(ledger["targets"]),
                "reviewed_rebuilt": True,
            }
        )
    )


def render_spans(text: str, spans: list[dict[str, Any]]) -> str:
    output = text
    for span in reversed(spans):
        start = span["start"]
        end = span["end"]
        if sha256_text(text[start:end]) != span["selected_sha256"]:
            raise RedactionError("mask span fingerprint does not match automatic text")
        output = output[:start] + redaction_tag(span["category"]) + output[end:]
    return output


def apply_case(case_dir: Path) -> None:
    case = require_case(case_dir)
    automatic_root = case_dir / "automatic"
    if tree_hash(automatic_root) != case.get("automatic_sha256"):
        raise RedactionError("automatic baseline changed after prepare")
    index = {target.target_id: target for target in load_text_index(case_dir)}
    policy = load_policy(case_dir / "private" / "policy.json")
    categories = set(policy["mask_categories"])
    ledger = read_json(case_dir / "private" / "masks.json")
    if not isinstance(ledger, dict) or ledger.get("version") != MASK_VERSION:
        raise RedactionError("unsupported masks ledger")
    reviewed_root = case_dir / "reviewed"
    if reviewed_root.exists():
        shutil.rmtree(reviewed_root)
    shutil.copytree(automatic_root, reviewed_root)
    seen: set[str] = set()
    by_path: dict[str, list[tuple[TextTarget, dict[str, Any]]]] = {}
    for mask_target in ledger.get("targets", []):
        if not isinstance(mask_target, dict):
            raise RedactionError("invalid mask target")
        target_id = mask_target.get("target_id")
        if not isinstance(target_id, str) or target_id not in index:
            raise RedactionError(f"mask ledger references unknown target: {target_id!r}")
        if target_id in seen:
            raise RedactionError(f"duplicate mask ledger target: {target_id}")
        seen.add(target_id)
        target = index[target_id]
        for field in ("path", "pointer", "text_sha256"):
            if mask_target.get(field) != getattr(target, field):
                raise RedactionError(f"mask target metadata mismatch for {target_id}")
        spans = mask_target.get("spans")
        if not isinstance(spans, list):
            raise RedactionError(f"mask target spans are invalid for {target_id}")
        by_path.setdefault(target.path, []).append((target, mask_target))
    for relative_path, path_targets in by_path.items():
        automatic_kind, automatic_document = load_document(
            automatic_root, relative_path
        )
        reviewed_kind, reviewed_document = load_document(
            reviewed_root, relative_path
        )
        if automatic_kind != reviewed_kind:
            raise RedactionError(f"document type changed for {relative_path}")
        for target, mask_target in path_targets:
            text = pointer_get(automatic_document, target.pointer)
            if not isinstance(text, str):
                raise RedactionError(f"mask target is not text: {target.target_id}")
            normalized_spans = [
                validate_span(span, text, categories)
                for span in mask_target["spans"]
            ]
            normalized_spans.sort(key=lambda span: (span["start"], span["end"]))
            for left, right in zip(normalized_spans, normalized_spans[1:]):
                if left["end"] > right["start"]:
                    raise RedactionError(
                        f"overlapping mask spans in {target.target_id}"
                    )
            if normalized_spans != mask_target["spans"]:
                raise RedactionError(
                    f"mask spans are not canonical for {target.target_id}"
                )
            replacement = render_spans(text, normalized_spans)
            reviewed_document = pointer_set(
                reviewed_document, target.pointer, replacement
            )
        write_document(
            reviewed_root, relative_path, reviewed_kind, reviewed_document
        )
    write_json(
        case_dir / "private" / "apply-state.json",
        {
            "version": "1",
            "masks_sha256": masks_hash(ledger),
            "reviewed_sha256": tree_hash(reviewed_root),
        },
    )


def apply_command(args: argparse.Namespace) -> None:
    case_dir = Path(args.case_dir).resolve()
    apply_case(case_dir)
    print(canonical_json({"reviewed_rebuilt": True, "case_dir": str(case_dir)}))


def waive_command(args: argparse.Namespace) -> None:
    case_dir = Path(args.case_dir).resolve()
    require_case(case_dir)
    findings = read_json(case_dir / "private" / "findings.json").get("findings", [])
    known = {item.get("finding_id") for item in findings if isinstance(item, dict)}
    if args.finding not in known:
        raise RedactionError(f"unknown finding: {args.finding}")
    reviewer = args.reviewer.strip()
    reason = args.reason.strip()
    if not reviewer or len(reviewer) > 80:
        raise RedactionError("reviewer must be 1-80 characters")
    if not reason or len(reason) > 240 or "\n" in reason:
        raise RedactionError("waiver reason must be one line of 1-240 characters")
    policy = load_policy(case_dir / "private" / "policy.json")
    redacted_reason = neutralize_source_tags(reason)
    for rule in policy["rules"]:
        category = str(rule.get("category", "sensitive"))
        redacted_reason, _ = apply_policy_rule(
            redacted_reason, rule, category
        )
    if redacted_reason != reason or TAG_RE.search(reason):
        raise RedactionError("waiver reason contains deterministic sensitive content")
    value = read_json(case_dir / "private" / "waivers.json")
    waivers = value.get("waivers")
    if not isinstance(waivers, list):
        raise RedactionError("invalid waivers ledger")
    waivers = [
        item
        for item in waivers
        if not isinstance(item, dict) or item.get("finding_id") != args.finding
    ]
    waivers.append(
        {
            "finding_id": args.finding,
            "reviewer": reviewer,
            "reason": reason,
        }
    )
    waivers.sort(key=lambda item: str(item.get("finding_id", "")))
    write_json(
        case_dir / "private" / "waivers.json",
        {"version": "1", "waivers": waivers},
    )
    print(canonical_json({"waived": args.finding}))


def safe_diff_command(args: argparse.Namespace) -> None:
    case_dir = Path(args.case_dir).resolve()
    require_case(case_dir)
    ledger = read_json(case_dir / "private" / "masks.json")
    print("target_id\tmasked_characters\tspan_count\tcategories")
    for target in ledger.get("targets", []):
        spans = target.get("spans", [])
        characters = sum(span["end"] - span["start"] for span in spans)
        categories = ",".join(sorted({span["category"] for span in spans}))
        print(
            f"{target['target_id']}\t{characters}\t{len(spans)}\t{categories}"
        )


def validate_event_schema(path: Path) -> list[str]:
    errors: list[str] = []
    events = read_jsonl(path)
    trajectory_id = path.parent.name
    required = {
        "schema_version",
        "event_id",
        "trajectory_id",
        "turn_id",
        "sequence",
        "event_type",
        "actor",
        "payload",
        "relations",
    }
    for index, event in enumerate(events):
        label = f"{path}:{index + 1}"
        if not isinstance(event, dict) or set(event) != required:
            errors.append(f"{label}: event envelope is not normalized")
            continue
        if event["schema_version"] != EVENT_SCHEMA:
            errors.append(f"{label}: invalid schema_version")
        if event["event_id"] != f"event-{index + 1:06d}":
            errors.append(f"{label}: invalid canonical event_id")
        if event["trajectory_id"] != trajectory_id:
            errors.append(f"{label}: invalid canonical trajectory_id")
        if event["sequence"] != index:
            errors.append(f"{label}: sequence is not canonical")
        if event["relations"] != []:
            errors.append(f"{label}: relations must be empty")
        actor = event["actor"]
        if (
            not isinstance(actor, dict)
            or set(actor) != {"type"}
            or actor.get("type") not in SAFE_ACTORS
        ):
            errors.append(f"{label}: actor is not generic")
        if event["event_type"] == "message":
            if event["turn_id"] != f"turn-{index + 1:06d}":
                errors.append(f"{label}: invalid canonical turn_id")
            payload = event["payload"]
            if (
                not isinstance(payload, dict)
                or set(payload) != {"role", "text"}
                or payload.get("role") not in {"user", "assistant"}
                or not isinstance(payload.get("text"), str)
                or payload.get("role") != actor.get("type")
            ):
                errors.append(f"{label}: invalid message payload")
        elif event["event_type"] == "action_label":
            if event["turn_id"] is not None:
                errors.append(f"{label}: action turn_id must be null")
            payload = event["payload"]
            if (
                not isinstance(payload, dict)
                or set(payload) != {"action_type"}
                or payload.get("action_type") not in SAFE_ACTION_TYPES
            ):
                errors.append(f"{label}: invalid action label payload")
        else:
            errors.append(f"{label}: unsupported normalized event type")
    return errors


def validate_meeting_schema(path: Path) -> list[str]:
    errors: list[str] = []
    value = read_json(path)
    if not isinstance(value, dict) or set(value) != {"schema_version", "records"}:
        return [f"{path}: meeting envelope is not normalized"]
    if value["schema_version"] != MEETING_SCHEMA:
        errors.append(f"{path}: invalid meeting schema_version")
    records = value["records"]
    if not isinstance(records, list):
        return errors + [f"{path}: meeting records must be an array"]
    for index, record in enumerate(records):
        label = f"{path}:record-{index + 1}"
        if (
            not isinstance(record, dict)
            or set(record) != {"record_id", "sequence", "speaker", "text"}
            or record.get("record_id") != f"record-{index + 1:06d}"
            or record.get("sequence") != index
            or record.get("speaker") != "participant"
            or not isinstance(record.get("text"), str)
        ):
            errors.append(f"{label}: record is not normalized")
    return errors


def file_set(root: Path) -> set[str]:
    return {
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file()
    }


def validate_tags(text: str, target_id: str) -> list[str]:
    errors: list[str] = []
    cursor = 0
    while True:
        index = text.lower().find("<redacted", cursor)
        if index < 0:
            break
        match = TAG_RE.match(text, index)
        if match is None:
            errors.append(f"{target_id}: malformed redaction tag")
            cursor = index + 9
        else:
            cursor = match.end()
    return errors


def validate_reviewed_changes(case_dir: Path) -> list[str]:
    errors: list[str] = []
    automatic_root = case_dir / "automatic"
    reviewed_root = case_dir / "reviewed"
    if file_set(automatic_root) != file_set(reviewed_root):
        return ["reviewed file set differs from automatic baseline"]
    targets = load_text_index(case_dir)
    by_file: dict[str, list[TextTarget]] = {}
    for target in targets:
        by_file.setdefault(target.path, []).append(target)
    ledger = read_json(case_dir / "private" / "masks.json")
    masks = {
        item["target_id"]: item
        for item in ledger.get("targets", [])
        if isinstance(item, dict) and isinstance(item.get("target_id"), str)
    }
    for path in file_set(automatic_root):
        automatic_kind, automatic_document = load_document(automatic_root, path)
        reviewed_kind, reviewed_document = load_document(reviewed_root, path)
        if automatic_kind != reviewed_kind:
            errors.append(f"{path}: document type changed")
            continue
        automatic_shape = copy.deepcopy(automatic_document)
        reviewed_shape = copy.deepcopy(reviewed_document)
        for target in by_file.get(path, []):
            automatic_text = pointer_get(automatic_document, target.pointer)
            reviewed_text = pointer_get(reviewed_document, target.pointer)
            if not isinstance(automatic_text, str) or not isinstance(reviewed_text, str):
                errors.append(f"{target.target_id}: text target changed type")
                continue
            expected = (
                render_spans(automatic_text, masks[target.target_id]["spans"])
                if target.target_id in masks
                else automatic_text
            )
            if reviewed_text != expected:
                errors.append(
                    f"{target.target_id}: reviewed text is not the deterministic mask rendering"
                )
            errors.extend(validate_tags(reviewed_text, target.target_id))
            automatic_shape = pointer_set(
                automatic_shape, target.pointer, "<review-text>"
            )
            reviewed_shape = pointer_set(
                reviewed_shape, target.pointer, "<review-text>"
            )
        if automatic_shape != reviewed_shape:
            errors.append(f"{path}: non-text structure or value changed")
    return errors


def residual_rule_errors(
    case_dir: Path,
    targets: list[TextTarget],
    policy: dict[str, Any],
    reviewed_texts: dict[str, str] | None = None,
) -> list[str]:
    errors: list[str] = []
    texts = reviewed_texts or load_target_texts(case_dir / "reviewed", targets)
    for target in targets:
        text = text_without_tags(texts[target.target_id])
        for rule in policy["rules"]:
            if rule_has_sensitive_match(text, rule):
                errors.append(
                    f"{target.target_id}: residual deterministic rule {rule.get('id')}"
                )
    return errors


def finding_coverage_errors(case_dir: Path) -> list[str]:
    findings = read_json(case_dir / "private" / "findings.json").get("findings", [])
    ledger = read_json(case_dir / "private" / "masks.json")
    mask_by_target = {
        item.get("target_id"): item.get("spans", [])
        for item in ledger.get("targets", [])
        if isinstance(item, dict)
    }
    waivers = read_json(case_dir / "private" / "waivers.json").get("waivers", [])
    waived = {
        item.get("finding_id")
        for item in waivers
        if isinstance(item, dict)
    }
    errors: list[str] = []
    for finding in findings:
        if finding.get("finding_id") in waived:
            continue
        spans = mask_by_target.get(finding.get("target_id"), [])
        covered = any(
            span.get("start") <= finding.get("start")
            and span.get("end") >= finding.get("end")
            for span in spans
            if isinstance(span, dict)
        )
        if not covered:
            errors.append(
                f"{finding.get('finding_id')}: pending semantic finding "
                f"({finding.get('category')})"
            )
    return errors


def schema_errors(case_dir: Path, kind: str) -> list[str]:
    data_root = case_dir / "reviewed" / "data"
    if kind == "trajectory":
        events_paths = sorted(data_root.glob("trajectories/trajectory-*/events.jsonl"))
        if not events_paths:
            return ["reviewed trajectory data is missing"]
        expected_files = {
            path.relative_to(case_dir / "reviewed").as_posix()
            for path in events_paths
        }
        if file_set(case_dir / "reviewed") != expected_files:
            return ["trajectory release contains files other than normalized events.jsonl"]
        errors: list[str] = []
        for path in events_paths:
            errors.extend(validate_event_schema(path))
        return errors
    if kind == "meeting":
        path = data_root / "meeting-transcripts.json"
        if file_set(case_dir / "reviewed") != {"data/meeting-transcripts.json"}:
            return ["meeting release contains files other than normalized transcript data"]
        return validate_meeting_schema(path)
    return [f"unsupported case kind: {kind}"]


def expected_text_locations(case_dir: Path, kind: str) -> set[tuple[str, str]]:
    automatic_root = case_dir / "automatic"
    locations: set[tuple[str, str]] = set()
    if kind == "trajectory":
        for path in sorted(
            (automatic_root / "data" / "trajectories").glob(
                "trajectory-*/events.jsonl"
            )
        ):
            relative = path.relative_to(automatic_root).as_posix()
            for index, event in enumerate(read_jsonl(path)):
                if isinstance(event, dict) and event.get("event_type") == "message":
                    locations.add((relative, f"/{index}/payload/text"))
        return locations
    if kind == "meeting":
        path = automatic_root / "data" / "meeting-transcripts.json"
        value = read_json(path)
        records = value.get("records", []) if isinstance(value, dict) else []
        for index, _record in enumerate(records):
            locations.add(
                ("data/meeting-transcripts.json", f"/records/{index}/text")
            )
        return locations
    raise RedactionError(f"unsupported case kind: {kind}")


def check_case(case_dir: Path, *, quiet: bool = False) -> list[str]:
    case = require_case(case_dir)
    errors: list[str] = []
    if tree_hash(case_dir / "automatic") != case.get("automatic_sha256"):
        errors.append("automatic baseline changed after prepare")
    ledger = read_json(case_dir / "private" / "masks.json")
    apply_state_path = case_dir / "private" / "apply-state.json"
    if not apply_state_path.is_file():
        errors.append("apply state is missing; run apply")
    else:
        apply_state = read_json(apply_state_path)
        if apply_state.get("masks_sha256") != masks_hash(ledger):
            errors.append("mask ledger changed after apply")
        if apply_state.get("reviewed_sha256") != tree_hash(case_dir / "reviewed"):
            errors.append("reviewed candidate changed after apply")
    targets = load_text_index(case_dir)
    if len(targets) != case.get("text_target_count"):
        errors.append("text-index count differs from case metadata")
    indexed_locations = {(target.path, target.pointer) for target in targets}
    expected_locations = expected_text_locations(case_dir, str(case.get("kind")))
    if indexed_locations != expected_locations:
        errors.append("text-index is not the exhaustive set of reviewable text")
    automatic_texts = load_target_texts(case_dir / "automatic", targets)
    for target in targets:
        text = automatic_texts[target.target_id]
        if len(text) != target.length or sha256_text(text) != target.text_sha256:
            errors.append(f"{target.target_id}: automatic text/index mismatch")
    errors.extend(validate_reviewed_changes(case_dir))
    errors.extend(schema_errors(case_dir, str(case.get("kind"))))
    policy = load_policy(case_dir / "private" / "policy.json")
    pii_state = read_json(case_dir / "private" / "pii-state.json")
    recognizer_bundle = read_json(
        case_dir / "private" / "presidio-custom-recognizers.json"
    )
    if not isinstance(recognizer_bundle, dict):
        recognizer_bundle = {}
    recognizer_bundle_without_hash = {
        key: value for key, value in recognizer_bundle.items() if key != "sha256"
    }
    recognizer_hash = sha256_text(canonical_json(recognizer_bundle_without_hash))
    recognizer_names = [
        item.get("name")
        for item in recognizer_bundle.get("recognizers", [])
        if isinstance(item, dict)
    ]
    expected_pii = policy.get("pii", {})
    case_pii = case.get("pii_filter", {})
    if (
        not isinstance(pii_state, dict)
        or pii_state.get("version") != "1"
        or pii_state.get("backend") != "presidio"
        or pii_state.get("nlp_engine") != "spacy"
        or pii_state.get("device") != "cpu"
        or pii_state.get("model") != expected_pii.get("model")
        or pii_state.get("language") != expected_pii.get("language")
        or pii_state.get("texts_analyzed") != len(targets)
        or not pii_state.get("custom_recognizers")
        or pii_state.get("custom_recognizer_sha256") != recognizer_hash
        or recognizer_bundle.get("sha256") != recognizer_hash
        or pii_state.get("custom_recognizers") != recognizer_names
        or pii_state.get("ignored_entities")
        != sorted(str(item).upper() for item in expected_pii.get("ignored_entities", []))
        or not isinstance(case_pii, dict)
        or case_pii.get("custom_recognizer_sha256") != recognizer_hash
    ):
        errors.append("mandatory Presidio/spaCy CPU PII state is invalid")
    reviewed_texts = load_target_texts(case_dir / "reviewed", targets)
    errors.extend(
        residual_rule_errors(
            case_dir,
            targets,
            policy,
            reviewed_texts=reviewed_texts,
        )
    )
    errors.extend(finding_coverage_errors(case_dir))
    if not quiet:
        if errors:
            for error in errors:
                print(f"BLOCKED: {error}", file=sys.stderr)
        else:
            print(
                canonical_json(
                    {
                        "status": "passed",
                        "text_targets_checked": len(targets),
                        "non_text_events_semantically_reviewed": 0,
                    }
                )
            )
    return errors


def check_command(args: argparse.Namespace) -> None:
    case_dir = Path(args.case_dir).resolve()
    errors = check_case(case_dir)
    if errors:
        raise RedactionError(f"check failed with {len(errors)} blocker(s)")


def approval_errors(case_dir: Path) -> list[str]:
    value = read_json(case_dir / "approval.json")
    required = (
        "semantic_review_complete",
        "original_contributor_reviewed",
        "privacy_reviewer_reviewed",
        "publication_approved",
    )
    errors = [f"approval gate is false: {key}" for key in required if value.get(key) is not True]
    roles = value.get("review_roles")
    role_keys = {"semantic", "original_contributor", "privacy", "publisher"}
    if not isinstance(roles, dict) or set(roles) != role_keys:
        errors.append("review_roles must contain exactly the four required roles")
    elif any(not isinstance(roles[key], str) or not roles[key].strip() for key in role_keys):
        errors.append("all review_roles must be nonempty")
    return errors


def mask_metrics(case_dir: Path) -> tuple[int, int, dict[str, int]]:
    ledger = read_json(case_dir / "private" / "masks.json")
    targets = ledger.get("targets", [])
    span_count = 0
    categories: dict[str, int] = {}
    for target in targets:
        for span in target.get("spans", []):
            span_count += 1
            category = span["category"]
            categories[category] = categories.get(category, 0) + 1
    return len(targets), span_count, categories


def deterministic_archive(source_root: Path, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for path in sorted(
            (item for item in source_root.rglob("*") if item.is_file()),
            key=lambda item: item.relative_to(source_root).as_posix(),
        ):
            relative = path.relative_to(source_root).as_posix()
            data = path.read_bytes()
            info = tarfile.TarInfo(relative)
            info.size = len(data)
            info.mtime = 0
            info.mode = 0o644
            info.uid = 0
            info.gid = 0
            info.uname = ""
            info.gname = ""
            archive.addfile(info, io.BytesIO(data))
    with output_path.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
            compressed.write(buffer.getvalue())


def finalize_command(args: argparse.Namespace) -> None:
    case_dir = Path(args.case_dir).resolve()
    output_path = Path(args.output).resolve()
    blockers = check_case(case_dir, quiet=True) + approval_errors(case_dir)
    if blockers:
        for blocker in blockers:
            print(f"BLOCKED: {blocker}", file=sys.stderr)
        raise RedactionError(f"finalize blocked by {len(blockers)} condition(s)")
    case = require_case(case_dir)
    target_count, span_count, categories = mask_metrics(case_dir)
    findings = read_json(case_dir / "private" / "findings.json").get("findings", [])
    waivers = read_json(case_dir / "private" / "waivers.json").get("waivers", [])
    pii_state = read_json(case_dir / "private" / "pii-state.json")
    with tempfile.TemporaryDirectory(prefix="release-redactor-") as temporary:
        root = Path(temporary)
        shutil.copytree(case_dir / "reviewed" / "data", root / "data")
        write_text(
            root / "NOTICE.md",
            f"# Redaction notice\n\n{NOTICE}\n\n{NOTICE_ZH}\n",
        )
        summary = {
            "schema_version": "release-redactor.summary/1",
            "tool_version": TOOL_VERSION,
            "policy_version": case.get("policy_version"),
            "text_targets_reviewed": case.get("text_target_count"),
            "manual_mask_targets": target_count,
            "manual_mask_spans": span_count,
            "manual_mask_categories": categories,
            "semantic_findings": len(findings),
            "semantic_waivers": len(waivers),
            "automatic_pii_detections": pii_state.get("raw_detections"),
            "automatic_pii_tags": pii_state.get("merged_tags"),
            "pii_backend": {
                "name": "presidio",
                "nlp_engine": "spacy",
                "device": "cpu",
                "model": pii_state.get("model"),
            },
            "non_text_event_policy": "allowlisted-action-label-only",
            "notice": NOTICE,
        }
        write_json(root / "redaction-summary.json", summary)
        data_hash = tree_hash(root / "data")
        write_json(
            root / "release-manifest.json",
            {
                "schema_version": "release-redactor.manifest/1",
                "data_sha256": data_hash,
                "kind": case.get("kind"),
                "notice": NOTICE,
            },
        )
        deterministic_archive(root, output_path)
    print(
        canonical_json(
            {
                "archive": str(output_path),
                "sha256": sha256_bytes(output_path.read_bytes()),
            }
        )
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Normalize and redact trajectory or meeting text for local release."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    prepare = subparsers.add_parser("prepare", help="create a normalized private case")
    prepare.add_argument("input")
    prepare.add_argument("--case-dir", required=True)
    prepare.add_argument(
        "--kind",
        choices=("auto", "trajectory", "meeting", "dialogue"),
        default="auto",
    )
    prepare.add_argument("--policy")
    prepare.set_defaults(function=prepare_case)

    index = subparsers.add_parser(
        "text-index", help="list only text nodes eligible for semantic review"
    )
    index.add_argument("case_dir")
    index.add_argument("--json", action="store_true")
    index.set_defaults(function=text_index_command)

    findings = subparsers.add_parser(
        "findings", help="list high-recall semantic signals without snippets"
    )
    findings.add_argument("case_dir")
    findings.add_argument("--json", action="store_true")
    findings.set_defaults(function=findings_command)

    mask = subparsers.add_parser(
        "mask-text", help="ingest one grouped span plan and rebuild reviewed data"
    )
    mask.add_argument("case_dir")
    mask.add_argument("--plan", required=True)
    mask.set_defaults(function=mask_text_command)

    waive = subparsers.add_parser("waive", help="waive one semantic finding")
    waive.add_argument("case_dir")
    waive.add_argument("--finding", required=True)
    waive.add_argument("--reviewer", required=True)
    waive.add_argument("--reason", required=True)
    waive.set_defaults(function=waive_command)

    apply_parser = subparsers.add_parser(
        "apply", help="rebuild reviewed data from automatic data and masks"
    )
    apply_parser.add_argument("case_dir")
    apply_parser.set_defaults(function=apply_command)

    diff = subparsers.add_parser(
        "diff", help="show a content-free summary of applied masks"
    )
    diff.add_argument("case_dir")
    diff.set_defaults(function=safe_diff_command)

    check = subparsers.add_parser("check", help="run fail-closed release checks")
    check.add_argument("case_dir")
    check.set_defaults(function=check_command)

    finalize = subparsers.add_parser(
        "finalize", help="create a deterministic local release archive"
    )
    finalize.add_argument("case_dir")
    finalize.add_argument("--output", required=True)
    finalize.set_defaults(function=finalize_command)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        args.function(args)
    except RedactionError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
