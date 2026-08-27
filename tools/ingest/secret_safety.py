"""Shared fail-closed secret grammar for ingest and Organization transport."""
from __future__ import annotations

import re
from typing import Any, Callable


CANONICAL_SECRET_MARKER = "<REDACTED>"
MINIMUM_SECRET_VALUE_LENGTH = 6

Replacement = str | Callable[[re.Match[str]], str]

ASSIGNMENT_PREFIX = re.compile(
    r"\b(?:api[_ -]?key|access[_ -]?token|token|password|passwd|secret|authorization)"
    r"\s*(?::|=(?!=))\s*",
    re.IGNORECASE,
)

# Non-assignment rules also own both detection and replacement. Organization
# rejects any remaining match; ingest applies these same rules before projection.
SECRET_RULES: tuple[tuple[re.Pattern[str], Replacement], ...] = (
    (
        re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----", re.IGNORECASE),
        CANONICAL_SECRET_MARKER,
    ),
    (
        re.compile(r"\b(?:sk|gh[pousr]|xox[baprs])-[A-Za-z0-9_-]{8,}", re.IGNORECASE),
        CANONICAL_SECRET_MARKER,
    ),
    (
        re.compile(r"\bAKIA[0-9A-Z]{16}\b", re.IGNORECASE),
        CANONICAL_SECRET_MARKER,
    ),
    (
        re.compile(
            r"(?P<prefix>://)[^/\s:@]+:[^/\s@]+(?P<suffix>@)",
            re.IGNORECASE,
        ),
        rf"\g<prefix>{CANONICAL_SECRET_MARKER}\g<suffix>",
    ),
)


def _assignment_value(text: str, start: int) -> tuple[int, str, bool] | None:
    """Return lexical end, replacement, and whether the value is already safe."""
    if start >= len(text) or text[start] in "\r\n":
        return None

    first_end = start
    while (
        first_end < len(text)
        and not text[first_end].isspace()
        and text[first_end] not in ",;"
    ):
        first_end += 1
    if first_end - start < MINIMUM_SECRET_VALUE_LENGTH:
        return first_end, CANONICAL_SECRET_MARKER, True

    quote = text[start] if text[start] in {'"', "'"} else None
    if quote is None:
        end = start
        while end < len(text) and not text[end].isspace() and text[end] not in ",;":
            end += 1
        if end == start:
            return None
        value = text[start:end]
        return end, CANONICAL_SECRET_MARKER, value == CANONICAL_SECRET_MARKER

    escaped = False
    close = start + 1
    while close < len(text) and text[close] not in "\r\n":
        character = text[close]
        if character == quote and not escaped:
            break
        if character == "\\":
            escaped = not escaped
        else:
            escaped = False
        close += 1

    if close >= len(text) or text[close] in "\r\n":
        return close, CANONICAL_SECRET_MARKER, False

    end = close + 1
    while end < len(text) and not text[end].isspace() and text[end] not in ",;":
        end += 1
    fully_quoted = end == close + 1
    value = text[start:end]
    replacement = f"{quote}{CANONICAL_SECRET_MARKER}{quote}" if fully_quoted else CANONICAL_SECRET_MARKER
    safe = fully_quoted and value == replacement
    return end, replacement, safe


def _unsafe_assignment(text: str) -> bool:
    for match in ASSIGNMENT_PREFIX.finditer(text):
        value = _assignment_value(text, match.end())
        if value is not None and not value[2]:
            return True
    return False


def _redact_assignments(text: str) -> str:
    parts: list[str] = []
    cursor = 0
    for match in ASSIGNMENT_PREFIX.finditer(text):
        if match.start() < cursor:
            continue
        value = _assignment_value(text, match.end())
        if value is None or value[2]:
            continue
        end, replacement, _ = value
        parts.extend((text[cursor:match.end()], replacement))
        cursor = end
    if cursor == 0:
        return text
    parts.append(text[cursor:])
    return "".join(parts)


def _require_text(value: Any) -> str:
    if not isinstance(value, str):
        raise TypeError("secret safety input must be text")
    return value


def secret_like_text(value: str) -> bool:
    text = _require_text(value)
    return _unsafe_assignment(text) or any(pattern.search(text) for pattern, _ in SECRET_RULES)


def redact_secret_like_text(value: str) -> str:
    redacted = _redact_assignments(_require_text(value))
    for pattern, replacement in SECRET_RULES:
        redacted = pattern.sub(replacement, redacted)
    if secret_like_text(redacted):
        raise ValueError("secret sanitization did not close the worker safety boundary")
    return redacted
