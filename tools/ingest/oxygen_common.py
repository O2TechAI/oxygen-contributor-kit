#!/usr/bin/env python3
"""Shared helpers for the Oxygen ingestion tools (progress protocol, safety filters)."""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
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


def _is_link_or_reparse(metadata, *, windows: bool | None = None) -> bool:
    if stat.S_ISLNK(metadata.st_mode):
        return True
    windows = os.name == "nt" if windows is None else windows
    attributes = getattr(metadata, "st_file_attributes", None)
    if windows and attributes is None:
        raise ValueError("cannot prove output path reparse-point safety")
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return attributes is not None and bool(attributes & reparse_flag)


def validate_output_root(requested: Path) -> Path:
    """Validate a literal output boundary before resolving or mutating it."""
    literal = requested.expanduser()
    if not literal.is_absolute():
        literal = Path.cwd() / literal

    current = Path(literal.anchor)
    for component in literal.parts[1:]:
        if component in ("", "."):
            continue
        if component == "..":
            current = current.parent
            continue
        current /= component
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            continue
        except OSError as error:
            raise ValueError(f"cannot inspect output path component: {current}") from error
        if _is_link_or_reparse(metadata):
            raise ValueError("output path must not contain links or reparse points")

    out = current
    if not out.exists():
        return out.resolve()
    try:
        root_metadata = out.lstat()
    except OSError as error:
        raise ValueError("cannot inspect output path") from error
    if _is_link_or_reparse(root_metadata) or not stat.S_ISDIR(root_metadata.st_mode):
        raise ValueError("output path must be a real directory")

    pending = [out]
    while pending:
        directory = pending.pop()
        try:
            entries = list(directory.iterdir())
        except OSError as error:
            raise ValueError(f"cannot inspect output directory: {directory}") from error
        for entry in entries:
            try:
                metadata = entry.lstat()
            except OSError as error:
                raise ValueError(f"cannot inspect output entry: {entry}") from error
            if _is_link_or_reparse(metadata):
                raise ValueError("output directory must not contain links or reparse points")
            if stat.S_ISDIR(metadata.st_mode):
                pending.append(entry)
            elif stat.S_ISREG(metadata.st_mode):
                if getattr(metadata, "st_nlink", None) != 1:
                    raise ValueError("output directory must not contain hard-linked files")
            else:
                raise ValueError("output directory must not contain special entries")
    return out.resolve(strict=True)
