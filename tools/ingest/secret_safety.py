"""Shared fail-closed secret grammar for ingest and Organization transport."""
from __future__ import annotations

import re
from typing import Any, Callable


CANONICAL_SECRET_MARKER = "<REDACTED>"


def _redact_assignment(match: re.Match[str]) -> str:
    value = match.group("value")
    marker = CANONICAL_SECRET_MARKER
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        marker = f"{value[0]}{marker}{value[0]}"
    return f"{match.group('prefix')}{marker}"


Replacement = str | Callable[[re.Match[str]], str]

# Each rule owns both detection and replacement. Organization rejects any
# remaining match; ingest applies the same ordered rules before projection.
# Replacements preserve only non-secret syntax around the matched value.
SECRET_RULES: tuple[tuple[re.Pattern[str], Replacement], ...] = (
    (
        re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----", re.IGNORECASE),
        CANONICAL_SECRET_MARKER,
    ),
    (
        re.compile(
            r"(?P<prefix>\b(?:api[_ -]?key|access[_ -]?token|token|password|passwd|secret|authorization)"
            r"\s*[:=]\s*)"
            r"(?!<redacted>|\[redacted\]|[\"'](?:<redacted>|\[redacted\])[\"'])"
            r"(?P<value>[^\s,;]{6,})",
            re.IGNORECASE,
        ),
        _redact_assignment,
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


def _require_text(value: Any) -> str:
    if not isinstance(value, str):
        raise TypeError("secret safety input must be text")
    return value


def secret_like_text(value: str) -> bool:
    text = _require_text(value)
    return any(pattern.search(text) for pattern, _ in SECRET_RULES)


def redact_secret_like_text(value: str) -> str:
    redacted = _require_text(value)
    for pattern, replacement in SECRET_RULES:
        redacted = pattern.sub(replacement, redacted)
    if secret_like_text(redacted):
        raise ValueError("secret sanitization did not close the worker safety boundary")
    return redacted
