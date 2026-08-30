#!/usr/bin/env python3
"""Collect all Claude Code / Codex trajectories (and memory) related to one repo.

Given a repo path, this scans the current user's ~/.claude and ~/.codex session
stores, keeps only sessions whose recorded cwd is inside the repo, converts each
one to the canonical Oxygen trajectory contract via the vendored extractors, and copies the
related memory files (Claude project memory, CLAUDE.md, AGENTS.md).

Output layout:

    <out>/
    ├── index.json
    ├── trajectories/traj-<user>-<agent>-<hash>/   (manifest/events/redaction/artifacts)
    └── memory/{claude,codex}/...

Everything starts as review_status=pending / publication_approved=false.
"""

from __future__ import annotations

import argparse
import atexit
from dataclasses import dataclass, field
import getpass
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath, PureWindowsPath

from oxygen_common import (
    VENDOR_DIR,
    fail,
    is_sensitive_name,
    progress,
    safe_slug,
    sha256_file,
    configure_utf8_stdio,
    text_subprocess_options,
    utc_now,
    validate_output_root,
    write_json,
)
from human_source_projection import INGEST_RUN_SCHEMA, POLICY_ID, project_trajectory


SESSION_SCAN_MAX_RECORDS = 2048
SESSION_SCAN_MAX_BYTES = 4 * 1024 * 1024
CODEX_CWD_RECORD_TYPES = {"session_meta", "turn_context"}
MEMORY_SOURCE_MISSING = "MEMORY_SOURCE_MISSING"
MEMORY_SOURCE_INVALID = "MEMORY_SOURCE_INVALID"
MEMORY_SOURCE_OUTSIDE_APPROVED_ROOT = "MEMORY_SOURCE_OUTSIDE_APPROVED_ROOT"
MEMORY_SOURCE_UNREADABLE = "MEMORY_SOURCE_UNREADABLE"


def normalize_progress_url(value: str) -> str:
    """Accept only an explicit loopback HTTP Viewer origin."""
    parsed = urllib.parse.urlparse(value)
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "localhost"}
        or parsed.port is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("progress URL must be an explicit localhost HTTP origin")
    return f"http://{parsed.hostname}:{parsed.port}"


class WorkflowProgressReporter:
    """Send fixed operational events only; never send paths or project data."""

    def __init__(self, base_url: str, workflow_run_id: str):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", workflow_run_id):
            raise ValueError("workflow run ID is invalid")
        self.base_url = normalize_progress_url(base_url)
        self.workflow_run_id = workflow_run_id
        self.completed = 0
        self.total = 0
        self.active = False

    def post(self, event: str, *, completed: int | None = None, total: int | None = None) -> None:
        payload: dict[str, object] = {
            "workflowRunId": self.workflow_run_id,
            "event": event,
        }
        if completed is not None:
            payload["completed"] = max(0, int(completed))
        if total is not None:
            payload["total"] = max(0, int(total))
        request = urllib.request.Request(
            f"{self.base_url}/api/workflow",
            data=json.dumps(payload).encode("utf-8"),
            headers={"content-type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                if response.status < 200 or response.status >= 300:
                    raise RuntimeError(f"workflow progress returned HTTP {response.status}")
        except (OSError, urllib.error.URLError) as error:
            raise RuntimeError("could not update the local Workflow Progress Viewer") from error

    def start(self) -> None:
        self.post("collection_started")
        self.active = True
        atexit.register(self.fail_if_active)

    def update(self, completed: int, total: int) -> None:
        self.completed = max(0, int(completed))
        self.total = max(0, int(total))
        self.post("collection_progress", completed=self.completed, total=self.total)

    def finish(self, *, failed: bool = False) -> None:
        event = "collection_failed" if failed else "collection_completed"
        self.post(event, completed=self.completed, total=self.total)
        self.active = False
        atexit.unregister(self.fail_if_active)

    def fail_if_active(self) -> None:
        if not self.active:
            return
        try:
            self.post("collection_failed", completed=self.completed, total=self.total)
        except Exception:
            pass
        self.active = False


@dataclass
class SessionCwdScan:
    cwds: set[str] = field(default_factory=set)
    records_scanned: int = 0
    bytes_scanned: int = 0
    malformed_records: int = 0
    bound_reached: bool = False


def _structured_cwds(record: dict, system: str) -> list[str]:
    """Return only cwd fields from structured metadata/context positions."""
    values: list[str] = []
    record_type = record.get("type")
    if system == "codex":
        if record_type not in CODEX_CWD_RECORD_TYPES:
            return values
        payload = record.get("payload")
        if isinstance(payload, dict) and isinstance(payload.get("cwd"), str):
            values.append(payload["cwd"])
    cwd = record.get("cwd")
    if isinstance(cwd, str) and (system == "claude" or record_type in CODEX_CWD_RECORD_TYPES):
        values.append(cwd)
    return values


def session_cwds(
    path: Path,
    system: str,
    repo: Path | None = None,
    *,
    max_records: int = SESSION_SCAN_MAX_RECORDS,
    max_bytes: int = SESSION_SCAN_MAX_BYTES,
) -> SessionCwdScan:
    """Bounded scan for structured cwd metadata, never repository mentions in bodies."""
    result = SessionCwdScan()
    try:
        with path.open("rb") as handle:
            while result.records_scanned < max_records and result.bytes_scanned < max_bytes:
                remaining = max_bytes - result.bytes_scanned
                raw = handle.readline(remaining)
                if not raw:
                    break
                result.bytes_scanned += len(raw)
                if not raw.endswith(b"\n") and result.bytes_scanned >= max_bytes:
                    try:
                        has_unread_bytes = path.stat().st_size > handle.tell()
                    except OSError:
                        has_unread_bytes = True
                    if has_unread_bytes:
                        result.bound_reached = True
                        break
                result.records_scanned += 1
                if b'"cwd"' not in raw:
                    continue
                try:
                    record = json.loads(raw)
                except (UnicodeDecodeError, json.JSONDecodeError):
                    result.malformed_records += 1
                    continue
                if not isinstance(record, dict):
                    continue
                for cwd in _structured_cwds(record, system):
                    result.cwds.add(cwd)
                    if repo is not None and is_inside(cwd, repo):
                        return result
            reached_limit = (
                result.records_scanned >= max_records or result.bytes_scanned >= max_bytes
            )
            if reached_limit and not result.bound_reached:
                try:
                    result.bound_reached = path.stat().st_size > handle.tell()
                except OSError:
                    result.bound_reached = True
    except OSError:
        pass
    return result


WINDOWS_ABSOLUTE = re.compile(r"^[A-Za-z]:[\\/]")


def _lexical_parts(parts, *, fold_case: bool = False) -> tuple[str, ...]:
    normalized: list[str] = []
    for part in parts:
        if part in {"", "."}:
            continue
        if part == "..":
            if normalized:
                normalized.pop()
            continue
        normalized.append(part.casefold() if fold_case else part)
    return tuple(normalized)


def canonical_location(value: str | Path) -> tuple[str, str, tuple[str, ...]]:
    text = str(value)
    if not text or "\0" in text:
        raise ValueError("cwd must be a nonempty absolute path")
    if WINDOWS_ABSOLUTE.match(text):
        # Native tools may record one existing directory through an 8.3 alias
        # and another through its long name. Expand that filesystem alias before
        # applying the lexical/case normalization shared with non-native audits.
        if os.name == "nt":
            try:
                text = str(Path(text).resolve(strict=False))
            except OSError:
                pass
        path = PureWindowsPath(text)
        return (
            "windows",
            path.drive.rstrip(":").casefold(),
            _lexical_parts(path.parts[1:], fold_case=True),
        )
    if not text.startswith("/") or text.startswith("//"):
        raise ValueError("cwd must be an explicit drive-absolute or POSIX-absolute path")
    path = PurePosixPath(text)
    parts = _lexical_parts(path.parts[1:])
    if len(parts) >= 2 and parts[0] == "mnt" and re.fullmatch(r"[A-Za-z]", parts[1]):
        return "windows", parts[1].casefold(), tuple(part.casefold() for part in parts[2:])
    return "posix", "", ("/", *parts)


def is_inside(cwd: str, repo: Path) -> bool:
    try:
        cwd_kind, cwd_root, cwd_parts = canonical_location(cwd)
        repo_kind, repo_root, repo_parts = canonical_location(repo)
    except (OSError, ValueError):
        return False
    return (
        cwd_kind == repo_kind
        and cwd_root == repo_root
        and cwd_parts[:len(repo_parts)] == repo_parts
    )


def cwd_relation(cwd: str, repo: Path) -> str:
    """Classify a structured cwd without weakening exact/child eligibility."""
    try:
        cwd_kind, cwd_root, cwd_parts = canonical_location(cwd)
        repo_kind, repo_root, repo_parts = canonical_location(repo)
    except (OSError, ValueError):
        return "missing_unparseable"
    if cwd_kind != repo_kind or cwd_root != repo_root:
        return "unrelated"
    if cwd_parts == repo_parts:
        return "exact"
    if cwd_parts[:len(repo_parts)] == repo_parts:
        return "child"
    if repo_parts[:len(cwd_parts)] == cwd_parts:
        return "parent"
    if repo_parts and cwd_parts[:len(repo_parts) - 1] == repo_parts[:-1]:
        return "sibling"
    return "unrelated"


def resolve_contained_path(candidate: Path, approved_root: Path) -> Path:
    """Resolve one existing path and require its target to stay inside the approved root."""
    resolved_root = approved_root.resolve(strict=True)
    resolved_candidate = candidate.resolve(strict=True)
    if not resolved_candidate.is_relative_to(resolved_root):
        raise ValueError("resolved path leaves approved root")
    return resolved_candidate


@dataclass
class DiscoveryStats:
    system: str
    root: Path
    files_scanned: int = 0
    matched: int = 0
    exact: int = 0
    child: int = 0
    parent: int = 0
    sibling: int = 0
    unrelated: int = 0
    missing_unparseable: int = 0
    limit_reached_without_cwd: int = 0
    malformed_records: int = 0
    approved_root_selected: int = 0

    def add(self, scan: SessionCwdScan, repo: Path) -> None:
        self.files_scanned += 1
        self.malformed_records += scan.malformed_records
        if not scan.cwds:
            self.missing_unparseable += 1
            if scan.bound_reached:
                self.limit_reached_without_cwd += 1
            return
        relations = {cwd_relation(cwd, repo) for cwd in scan.cwds}
        relation = next(
            name for name in ("exact", "child", "parent", "sibling", "unrelated",
                              "missing_unparseable") if name in relations
        )
        setattr(self, relation, getattr(self, relation) + 1)
        if relation in {"exact", "child"}:
            self.matched += 1

    def as_dict(self) -> dict:
        return {
            "system": self.system,
            "root": str(self.root),
            "files_scanned": self.files_scanned,
            "matched": self.matched,
            "cwd_scope": {
                "exact": self.exact,
                "child": self.child,
                "parent": self.parent,
                "sibling": self.sibling,
                "unrelated": self.unrelated,
                "missing_unparseable": self.missing_unparseable,
            },
            "limit_reached_without_cwd": self.limit_reached_without_cwd,
            "malformed_records": self.malformed_records,
            "approved_root_selected": self.approved_root_selected,
            "scan_limits": {
                "records_per_session": SESSION_SCAN_MAX_RECORDS,
                "bytes_per_session": SESSION_SCAN_MAX_BYTES,
            },
        }


def report_discovery(stats: DiscoveryStats) -> None:
    scope = stats.as_dict()["cwd_scope"]
    progress(
        None,
        "scan",
        f"{stats.system} store {stats.root}: scanned={stats.files_scanned}, "
        f"exact={scope['exact']}, child={scope['child']}, parent={scope['parent']}, "
        f"sibling={scope['sibling']}, unrelated={scope['unrelated']}, "
        f"missing/unparseable={scope['missing_unparseable']}, "
        f"limit-without-cwd={stats.limit_reached_without_cwd}, "
        f"approved-root-selected={stats.approved_root_selected}",
    )


def find_claude_sessions(
    home: Path, repo: Path, diagnostics: DiscoveryStats | None = None
) -> tuple[list[Path], list[Path]]:
    """Return (matching session jsonl files, matching project dirs)."""
    projects_root = home / ".claude" / "projects"
    sessions: list[Path] = []
    project_dirs: list[Path] = []
    if not projects_root.is_dir():
        return sessions, project_dirs
    for project_dir in sorted(projects_root.iterdir()):
        if not project_dir.is_dir():
            continue
        matched_dir = False
        for jsonl in sorted(project_dir.rglob("*.jsonl")):
            scan = session_cwds(jsonl, "claude", repo)
            if diagnostics is not None:
                diagnostics.add(scan, repo)
            if any(is_inside(cwd, repo) for cwd in scan.cwds):
                sessions.append(jsonl)
                matched_dir = True
        if matched_dir:
            project_dirs.append(project_dir)
    return sessions, project_dirs


def find_codex_sessions(
    home: Path,
    repo: Path,
    session_root: Path | None = None,
    diagnostics: DiscoveryStats | None = None,
) -> list[Path]:
    """Find target-cwd sessions, or every valid session in an explicit approved root.

    Passing ``session_root`` is an affirmative source-boundary decision. The implicit global
    store remains cwd-filtered; an explicit root is never inferred from the repository.
    """
    sessions_root = session_root or home / ".codex" / "sessions"
    sessions: list[Path] = []
    if not sessions_root.is_dir():
        return sessions
    explicit_boundary = session_root is not None
    try:
        resolved_root = sessions_root.resolve(strict=True)
    except (OSError, RuntimeError):
        return sessions
    for jsonl in sorted(sessions_root.rglob("*.jsonl")):
        try:
            resolved_jsonl = resolve_contained_path(jsonl, resolved_root)
        except (OSError, RuntimeError, ValueError):
            continue
        if jsonl.is_symlink():
            continue
        scan = session_cwds(resolved_jsonl, "codex", repo)
        if diagnostics is not None:
            diagnostics.add(scan, repo)
        if explicit_boundary:
            if is_codex_session_file(resolved_jsonl):
                sessions.append(resolved_jsonl)
                if diagnostics is not None:
                    diagnostics.approved_root_selected += 1
        elif any(is_inside(cwd, repo) for cwd in scan.cwds):
            sessions.append(resolved_jsonl)
    return sessions


def is_codex_session_file(path: Path) -> bool:
    """Validate the minimum structured Codex identity envelope without reading bodies."""
    try:
        with path.open("rb") as handle:
            records = 0
            bytes_scanned = 0
            while records < SESSION_SCAN_MAX_RECORDS and bytes_scanned < SESSION_SCAN_MAX_BYTES:
                raw = handle.readline(SESSION_SCAN_MAX_BYTES - bytes_scanned)
                if not raw:
                    return False
                records += 1
                bytes_scanned += len(raw)
                if b'"session_meta"' not in raw or b'"type"' not in raw:
                    continue
                try:
                    record = json.loads(raw)
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
                if not isinstance(record, dict) or record.get("type") != "session_meta":
                    continue
                payload = record.get("payload")
                return (
                    isinstance(record.get("timestamp"), str)
                    and isinstance(payload, dict)
                    and isinstance(payload.get("id"), str)
                    and bool(payload["id"])
                    and isinstance(payload.get("cwd"), str)
                    and bool(payload["cwd"])
                )
    except OSError:
        return False
    return False


def stable_trajectory_id(session: Path, system: str, user: str) -> str:
    """Name one raw container from its provider-owned structured identity.

    Codex ``session_id`` is the logical parent thread and is intentionally
    shared by top-level, subagent, and compaction rollout containers. The
    ``session_meta.payload.id`` field identifies the individual recorded
    container, so it must take precedence or distinct source files overwrite
    one another downstream.
    """
    source_identity = session.stem
    try:
        with session.open("rb") as handle:
            records = 0
            bytes_scanned = 0
            while records < SESSION_SCAN_MAX_RECORDS and bytes_scanned < SESSION_SCAN_MAX_BYTES:
                raw = handle.readline(SESSION_SCAN_MAX_BYTES - bytes_scanned)
                if not raw:
                    break
                records += 1
                bytes_scanned += len(raw)
                try:
                    record = json.loads(raw)
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
                if not isinstance(record, dict):
                    continue
                if system == "codex" and record.get("type") == "session_meta":
                    payload = record.get("payload")
                    if isinstance(payload, dict):
                        value = payload.get("id") or payload.get("session_id")
                        if isinstance(value, str) and value:
                            source_identity = value
                            break
                if system == "claude":
                    value = record.get("sessionId")
                    if isinstance(value, str) and value:
                        source_identity = value
                        break
    except OSError:
        pass
    locator_digest = hashlib.sha256(
        f"{system}\0{source_identity}".encode("utf-8")
    ).hexdigest()[:16]
    return f"traj-{safe_slug(user)}-{system}-{locator_digest}"


def validate_rerunnable_output(out: Path) -> bool:
    """Allow replacement cleanup only for an identified prior collector run."""
    if not out.exists():
        return False
    if out.is_symlink() or not out.is_dir():
        raise ValueError("output path must be a real directory")
    entries = list(out.iterdir())
    if not entries:
        return False
    index_path = out / "index.json"
    if index_path.is_symlink() or not index_path.is_file():
        raise ValueError("nonempty output is not an identified collector run")
    try:
        index = json.loads(index_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise ValueError("existing collector index is invalid") from None
    if (
        not isinstance(index, dict)
        or index.get("schema") != INGEST_RUN_SCHEMA
        or index.get("tool") != "collect_repo_trajectories"
        or index.get("collection_status") not in {"complete", "in_progress"}
    ):
        raise ValueError("nonempty output is not an identified collector run")
    entries = index.get("trajectories")
    count = index.get("trajectory_count")
    failures = index.get("trajectory_failures")
    if (
        not isinstance(entries, list)
        or not isinstance(count, int)
        or isinstance(count, bool)
        or count != len(entries)
        or not isinstance(failures, int)
        or isinstance(failures, bool)
        or failures < 0
    ):
        raise ValueError("existing collector index is invalid")
    if index["collection_status"] == "in_progress":
        if entries or count != 0 or failures != 1:
            raise ValueError("existing collector index is invalid")
        return True
    if any(
        not isinstance(entry, dict)
        or not isinstance(entry.get("trajectory_id"), str)
        or not isinstance(entry.get("ok"), bool)
        for entry in entries
    ) or failures != sum(1 for entry in entries if entry["ok"] is False):
        raise ValueError("existing collector index is invalid")
    return True


def prune_stale_trajectory_outputs(out: Path, successful_ids: set[str]) -> int:
    """Remove only obsolete derived trajectory directories from a proven run."""
    root = out / "trajectories"
    if not root.exists():
        return 0
    if root.is_symlink() or not root.is_dir():
        raise ValueError("trajectory output root is invalid")
    resolved_out = out.resolve(strict=True)
    resolved_root = root.resolve(strict=True)
    if not resolved_root.is_relative_to(resolved_out):
        raise ValueError("trajectory output root leaves the collector run")
    removed = 0
    for entry in root.iterdir():
        if entry.is_symlink() or not entry.is_dir():
            raise ValueError("trajectory output contains an unsupported entry")
        resolved_entry = entry.resolve(strict=True)
        if not resolved_entry.is_relative_to(resolved_root):
            raise ValueError("trajectory output entry leaves the collector run")
        if entry.name not in successful_ids:
            shutil.rmtree(resolved_entry)
            removed += 1
    return removed


def atomic_write_json(path: Path, value: object) -> None:
    """Replace the collector index without exposing a partial JSON document."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def invalidate_collection_authority(out: Path) -> None:
    """Make every pre-existing trajectory set non-consumable before mutation."""
    atomic_write_json(out / "index.json", {
        "schema": INGEST_RUN_SCHEMA,
        "tool": "collect_repo_trajectories",
        "collection_status": "in_progress",
        "trajectory_count": 0,
        "trajectory_failures": 1,
        "trajectories": [],
        "review_status": "pending",
        "publication_approved": False,
    })


def extract(
    session: Path,
    system: str,
    out_root: Path,
    home: Path,
    user: str,
    semantic_source_registry: dict[tuple[str, str, str, str, str], str],
    claimed_trajectory_ids: set[str],
) -> dict:
    source_digest = sha256_file(session)
    digest = source_digest[:16]
    trajectory_id = stable_trajectory_id(session, system, user)
    if trajectory_id in claimed_trajectory_ids:
        return {
            "trajectory_id": trajectory_id,
            "system": system,
            "source_session": str(session),
            "source_sha256_prefix": digest,
            "ok": False,
            "error": "duplicate structured raw session identity",
        }
    script = VENDOR_DIR / (
        "extract_claude_trajectory.py" if system == "claude" else "extract_codex_trajectory.py"
    )
    out_root.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix="oxygen-extraction-",
        dir=out_root.parent,
    ) as staging_directory:
        staging_root = Path(staging_directory)
        cmd = [
            sys.executable,
            str(script),
            "--session",
            str(session),
            "--output-root",
            str(staging_root),
            "--trajectory-id",
            trajectory_id,
            "--source-home",
            str(home),
            "--source-user",
            user,
            "--overwrite",
        ]
        result = subprocess.run(
            cmd, capture_output=True, cwd=str(VENDOR_DIR), **text_subprocess_options()
        )
        entry = {
            "trajectory_id": trajectory_id,
            "system": system,
            "source_session": str(session),
            "source_sha256_prefix": digest,
            "ok": result.returncode == 0,
        }
        if result.returncode != 0:
            entry["error"] = (result.stderr or result.stdout).strip()[-2000:]
            return entry
        try:
            staged_trajectory = staging_root / trajectory_id
            staged_semantic_registry = dict(semantic_source_registry)
            entry["contribution_projection"] = project_trajectory(
                staged_trajectory,
                raw_source_digest=source_digest,
                semantic_source_registry=staged_semantic_registry,
            )
            out_root.mkdir(parents=True, exist_ok=True)
            final_trajectory = out_root / trajectory_id
            if final_trajectory.exists():
                shutil.rmtree(final_trajectory)
            shutil.move(str(staged_trajectory), str(final_trajectory))
            semantic_source_registry.clear()
            semantic_source_registry.update(staged_semantic_registry)
            claimed_trajectory_ids.add(trajectory_id)
        except (OSError, ValueError, json.JSONDecodeError) as error:
            entry["ok"] = False
            entry["error"] = f"human-source projection failed: {error}"
        return entry


def aggregate_projection(trajectories: list[dict]) -> dict:
    projections = [
        item["contribution_projection"] for item in trajectories
        if item.get("ok") and isinstance(item.get("contribution_projection"), dict)
    ]
    by_family: dict[str, dict[str, int]] = {}
    kept_by_reason: dict[str, int] = {}
    dropped_by_reason: dict[str, int] = {}
    for projection in projections:
        for family, counts in projection.get("by_event_family", {}).items():
            target = by_family.setdefault(family, {
                "raw": 0, "normalized": 0, "kept": 0, "dropped": 0,
                "source_replays": 0,
            })
            for key in target:
                target[key] += int(counts.get(key, 0))
        for reason, count in projection.get("kept_by_reason", {}).items():
            kept_by_reason[reason] = kept_by_reason.get(reason, 0) + int(count)
        for reason, count in projection.get("dropped_by_reason", {}).items():
            dropped_by_reason[reason] = dropped_by_reason.get(reason, 0) + int(count)
    raw_source_digest = hashlib.sha256()
    projected_digest = hashlib.sha256()
    for item in sorted(
        (
            trajectory["trajectory_id"],
            trajectory["contribution_projection"]["raw_source_digest"],
            trajectory["contribution_projection"]["projected_universe_digest"],
        )
        for trajectory in trajectories
        if trajectory.get("ok") and isinstance(trajectory.get("contribution_projection"), dict)
    ):
        raw_source_digest.update(f"{item[0]}\t{item[1]}\n".encode("utf-8"))
        projected_digest.update(f"{item[0]}\t{item[2]}\n".encode("utf-8"))
    return {
        "policy_id": POLICY_ID,
        "trajectory_count": len(projections),
        "raw_event_count": sum(int(item.get("raw_event_count", 0)) for item in projections),
        "extracted_event_count": sum(
            int(item.get("extracted_event_count", item.get("raw_event_count", 0)))
            for item in projections
        ),
        "normalized_event_count": sum(
            int(item.get("normalized_event_count", item.get("raw_event_count", 0)))
            for item in projections
        ),
        "kept_event_count": sum(int(item.get("kept_event_count", 0)) for item in projections),
        "dropped_event_count": sum(int(item.get("dropped_event_count", 0)) for item in projections),
        "mechanical_drop_count": sum(
            int(item.get("mechanical_drop_count", item.get("dropped_event_count", 0)))
            for item in projections
        ),
        "projection_removed_event_count": sum(
            int(item.get("projection_removed_event_count", item.get("dropped_event_count", 0)))
            for item in projections
        ),
        "cross_trajectory_semantic_replay_count": sum(
            int(item.get("cross_trajectory_semantic_replay_count", 0)) for item in projections
        ),
        "extractor_semantic_replay_count": sum(
            int(item.get("extractor_semantic_replay_count", 0)) for item in projections
        ),
        "source_duplicate_semantic_replay_count": sum(
            int(item.get("source_duplicate_semantic_replay_count", 0)) for item in projections
        ),
        "kept_by_reason": dict(sorted(kept_by_reason.items())),
        "dropped_by_reason": dict(sorted(dropped_by_reason.items())),
        "by_event_family": dict(sorted(by_family.items())),
        "raw_artifact_count": sum(int(item.get("raw_artifact_count", 0)) for item in projections),
        "kept_human_source_artifact_count": sum(
            int(item.get("kept_human_source_artifact_count", 0)) for item in projections
        ),
        "dropped_machine_artifact_count": sum(
            int(item.get("dropped_machine_artifact_count", 0)) for item in projections
        ),
        "projected_serialized_bytes": sum(
            int(item.get("projected_serialized_bytes", 0)) for item in projections
        ),
        "raw_serialized_bytes": sum(
            int(item.get("raw_serialized_bytes", 0)) for item in projections
        ),
        "normalized_serialized_bytes": sum(
            int(item.get("normalized_serialized_bytes", item.get("raw_serialized_bytes", 0)))
            for item in projections
        ),
        "mechanical_serialized_byte_reduction": sum(
            int(item.get("mechanical_serialized_byte_reduction", 0)) for item in projections
        ),
        "serialized_byte_reduction": sum(
            int(item.get("serialized_byte_reduction", 0)) for item in projections
        ),
        "raw_source_digest": raw_source_digest.hexdigest(),
        "projected_universe_digest": projected_digest.hexdigest(),
    }


def copy_memory(
    src: Path,
    dest_root: Path,
    base_label: str,
    collected: list[dict],
    approved_root: Path,
) -> None:
    """Copy one approved memory file/dir without following a target outside its root."""
    if not src.exists() and not src.is_symlink():
        raise ValueError(MEMORY_SOURCE_MISSING)
    try:
        resolved_src = resolve_contained_path(src, approved_root)
    except ValueError:
        raise ValueError(MEMORY_SOURCE_OUTSIDE_APPROVED_ROOT) from None
    except (OSError, RuntimeError):
        raise ValueError(MEMORY_SOURCE_INVALID) from None

    try:
        if resolved_src.is_file():
            targets = [(src, resolved_src)]
        elif resolved_src.is_dir():
            targets = []
            for target in sorted(src.rglob("*")):
                try:
                    resolved_target = resolve_contained_path(target, resolved_src)
                except ValueError:
                    raise ValueError(MEMORY_SOURCE_OUTSIDE_APPROVED_ROOT) from None
                except (OSError, RuntimeError):
                    raise ValueError(MEMORY_SOURCE_INVALID) from None
                if resolved_target.is_file():
                    targets.append((target, resolved_target))
        else:
            raise ValueError(MEMORY_SOURCE_INVALID)
    except PermissionError:
        raise ValueError(MEMORY_SOURCE_UNREADABLE) from None

    for target, resolved_target in targets:
        if is_sensitive_name(target) or is_sensitive_name(resolved_target):
            collected.append({"source": str(target), "skipped": "sensitive filename"})
            continue
        rel = target.name if src.is_file() else str(target.relative_to(src))
        dest = dest_root / base_label / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.copy2(resolved_target, dest)
        except PermissionError:
            raise ValueError(MEMORY_SOURCE_UNREADABLE) from None
        collected.append(
            {"source": str(target), "copied_to": str(dest), "sha256": sha256_file(resolved_target)}
        )


def main(argv=None) -> int:
    configure_utf8_stdio()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", type=Path, help="repo the trajectories should relate to")
    parser.add_argument("--out", type=Path, required=True,
                        help="explicit local run output directory")
    parser.add_argument("--home", type=Path, default=Path.home())
    parser.add_argument(
        "--source-home",
        type=Path,
        help=(
            "home path used only to mask source paths during extraction "
            "(default: --home; set explicitly when discovery uses an isolated home)"
        ),
    )
    parser.add_argument(
        "--codex-session-root",
        type=Path,
        help=(
            "user-approved exact Codex session boundary; valid session JSONL files inside are "
            "selected without cwd re-filtering (default: strict target-cwd filtering under "
            "<home>/.codex/sessions)"
        ),
    )
    parser.add_argument(
        "--include-global-memory",
        action="store_true",
        help=(
            "include user-global CLAUDE.md/AGENTS.md only after explicit approval "
            "(default: project-scoped memory and repository guidance only)"
        ),
    )
    parser.add_argument(
        "--progress-url",
        help="exact localhost Viewer origin for sanitized Workflow Progress",
    )
    parser.add_argument(
        "--workflow-run-id",
        help="stable workflow run ID printed by the progress-first launcher",
    )
    parser.add_argument("--user", default=getpass.getuser())
    parser.add_argument(
        "--agents", default="claude,codex", help="comma list among: claude,codex"
    )
    args = parser.parse_args(argv)
    if bool(args.progress_url) != bool(args.workflow_run_id):
        parser.error("--progress-url and --workflow-run-id must be supplied together")

    repo = args.repo.expanduser().resolve()
    if not repo.is_dir():
        print("REPOSITORY_SOURCE_INVALID", file=sys.stderr)
        return 1
    agents = {a.strip() for a in args.agents.split(",") if a.strip()}
    try:
        out = validate_output_root(args.out)
        replacing_existing_output = validate_rerunnable_output(out)
    except ValueError as error:
        raise fail(str(error)) from error
    out.mkdir(parents=True, exist_ok=True)
    home = args.home.expanduser().resolve()
    source_home = (args.source_home or home).expanduser().resolve()
    if args.source_home and not source_home.is_dir():
        raise fail(f"source home not found: {source_home}")
    codex_root = (
        args.codex_session_root.expanduser().resolve()
        if args.codex_session_root
        else home / ".codex" / "sessions"
    )
    reporter = (
        WorkflowProgressReporter(args.progress_url, args.workflow_run_id)
        if args.progress_url and args.workflow_run_id
        else None
    )
    if reporter:
        reporter.start()

    progress(2, "scan", f"scanning sessions related to {repo}")
    claude_sessions: list[Path] = []
    claude_project_dirs: list[Path] = []
    codex_sessions: list[Path] = []
    discovery: dict[str, DiscoveryStats] = {}
    if "claude" in agents:
        claude_stats = DiscoveryStats("claude", home / ".claude" / "projects")
        discovery["claude"] = claude_stats
        claude_sessions, claude_project_dirs = find_claude_sessions(home, repo, claude_stats)
        report_discovery(claude_stats)
    if "codex" in agents:
        codex_stats = DiscoveryStats("codex", codex_root)
        discovery["codex"] = codex_stats
        approved_codex_root = codex_root if args.codex_session_root else None
        codex_sessions = find_codex_sessions(
            home, repo, approved_codex_root, codex_stats
        )
        report_discovery(codex_stats)
    total = len(claude_sessions) + len(codex_sessions)
    progress(10, "scan", f"{len(claude_sessions)} claude + {len(codex_sessions)} codex sessions match")
    if reporter:
        reporter.update(0, total)

    # The old index must stop authorizing bytes before the first trajectory or
    # memory file is changed. A crash from this point leaves a fixed invalid
    # authority rather than a valid index pointing at stale/partial output.
    invalidate_collection_authority(out)

    trajectories: list[dict] = []
    semantic_source_registry: dict[tuple[str, str, str, str, str], str] = {}
    claimed_trajectory_ids: set[str] = set()
    done = 0
    for system, sessions in (("claude", claude_sessions), ("codex", codex_sessions)):
        for session in sessions:
            entry = extract(
                session,
                system,
                out / "trajectories",
                source_home,
                args.user,
                semantic_source_registry,
                claimed_trajectory_ids,
            )
            trajectories.append(entry)
            done += 1
            pct = 10 + 75 * done / max(1, total)
            status = "ok" if entry["ok"] else "FAILED"
            progress(pct, "extract", f"[{done}/{total}] {entry['trajectory_id']} {status}")
            if reporter:
                reporter.update(done, total)

    progress(88, "memory", "collecting memory files")
    memory: list[dict] = []
    memory_root = out / "memory"
    if "claude" in agents:
        for project_dir in claude_project_dirs:
            source = project_dir / "memory"
            if source.exists() or source.is_symlink():
                copy_memory(
                    source, memory_root / "claude", f"project-{project_dir.name}", memory,
                    project_dir,
                )
        if args.include_global_memory:
            source = home / ".claude" / "CLAUDE.md"
            if source.exists() or source.is_symlink():
                copy_memory(source, memory_root / "claude", "global", memory, home / ".claude")
        for source, label in ((repo / "CLAUDE.md", "repo"), (repo / ".claude", "repo-dot-claude")):
            if source.exists() or source.is_symlink():
                copy_memory(source, memory_root / "claude", label, memory, repo)
    if "codex" in agents:
        if args.include_global_memory:
            source = home / ".codex" / "AGENTS.md"
            if source.exists() or source.is_symlink():
                copy_memory(source, memory_root / "codex", "global", memory, home / ".codex")
        source = repo / "AGENTS.md"
        if source.exists() or source.is_symlink():
            copy_memory(source, memory_root / "codex", "repo", memory, repo)

    index = {
        "schema": INGEST_RUN_SCHEMA,
        "tool": "collect_repo_trajectories",
        "collection_status": "complete",
        "generated_at": utc_now(),
        "repo": str(repo),
        "source_user": args.user,
        "trajectory_count": len(trajectories),
        "trajectory_failures": sum(1 for t in trajectories if not t["ok"]),
        "memory_file_count": sum(1 for m in memory if "copied_to" in m),
        "review_status": "pending",
        "publication_approved": False,
        "trajectories": trajectories,
        "memory": memory,
        "session_discovery": {name: stats.as_dict() for name, stats in discovery.items()},
        "contribution_projection": aggregate_projection(trajectories),
    }
    if replacing_existing_output:
        try:
            prune_stale_trajectory_outputs(
                out,
                {
                    entry["trajectory_id"]
                    for entry in trajectories
                    if entry.get("ok") is True
                },
            )
        except ValueError as error:
            raise fail(str(error)) from error
    atomic_write_json(out / "index.json", index)
    progress(
        100,
        "done",
        f"{index['trajectory_count']} trajectories ({index['trajectory_failures']} failed), "
        f"{index['memory_file_count']} memory files -> {out}",
    )
    if reporter:
        reporter.finish(failed=index["trajectory_failures"] > 0)
    print(json.dumps({"output": str(out), "index": str(out / 'index.json')}, ensure_ascii=False))
    return 1 if index["trajectory_failures"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
