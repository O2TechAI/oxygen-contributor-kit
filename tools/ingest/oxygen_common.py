#!/usr/bin/env python3
"""Shared helpers for the Oxygen ingestion tools (progress protocol, safety filters)."""

from __future__ import annotations

import getpass
import hashlib
import json
import os
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

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
    """Machine-readable progress line consumed by webapp.py; human-readable too."""
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


STAGING_DIR = Path("/srv/shared/oxygen/data/ingest-staging")


def publish_to_staging(src: Path, name: str) -> str | None:
    """Copy a finished output dir into the shared oxygen_collab staging area.

    Returns the destination path, or None when staging is unavailable (e.g. the
    tools run on a user's own machine). Files inherit the oxygen_collab group
    via the setgid staging dir, so the public dropbox guard keeps them hidden.
    """
    import shutil

    if not STAGING_DIR.is_dir() or not os.access(STAGING_DIR, os.W_OK):
        return None
    dest = STAGING_DIR / safe_slug(name)
    shutil.copytree(src, dest, dirs_exist_ok=True)
    with (STAGING_DIR / "INBOX.md").open("a", encoding="utf-8") as handle:
        handle.write(f"- [{utc_now()}] {getpass.getuser()} staged `{dest.name}` "
                     f"(from {src}) — pending Inline import, unredacted, do not publish\n")
    return str(dest)


def read_first_jsonl_records(path: Path, limit: int = 50) -> list[dict]:
    records: list[dict] = []
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for index, line in enumerate(handle):
                if index >= limit:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(record, dict):
                    records.append(record)
    except OSError:
        pass
    return records
