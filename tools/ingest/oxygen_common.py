#!/usr/bin/env python3
"""Shared helpers for the Oxygen ingestion tools (progress protocol, safety filters)."""

from __future__ import annotations

import hashlib
import json
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

TOOLS_ROOT = Path(__file__).resolve().parents[1]
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from oxygen_utf8 import configure_utf8_stdio, text_subprocess_options

TOOLS_DIR = Path(__file__).resolve().parent
VENDOR_DIR = TOOLS_DIR / "vendor"

# Files that are never collected, even inside consented material.
SENSITIVE_NAME_RE = re.compile(
    r"(auth\.json|\.credentials\.json|credentials|\.env(\.|$)|id_rsa|id_ed25519|id_ecdsa"
    r"|\.pem$|\.key$|token|secret|password|\.netrc|\.npmrc|\.pypirc)",
    re.IGNORECASE,
)


def is_sensitive_name(path: Path) -> bool:
    return bool(SENSITIVE_NAME_RE.search(path.name))


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def run_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_slug(value: str) -> str:
    value = unicodedata.normalize("NFKD", value)
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-.")
    return value or "item"


def progress(pct: float | None, stage: str, detail: str = "") -> None:
    """Emit a machine-readable, human-readable progress line."""
    record = {"stage": stage, "detail": detail}
    if pct is not None:
        record["pct"] = round(max(0.0, min(100.0, pct)), 1)
    print("PROGRESS " + json.dumps(record, ensure_ascii=False), flush=True)


def fail(message: str, code: int = 1) -> "SystemExit":
    print("PROGRESS " + json.dumps({"stage": "error", "detail": message}, ensure_ascii=False), flush=True)
    print(f"error: {message}", file=sys.stderr)
    return SystemExit(code)


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
