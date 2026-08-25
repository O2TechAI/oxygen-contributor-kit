#!/usr/bin/env python3
"""Collect all Claude Code / Codex trajectories (and memory) related to one repo.

Given a repo path, this scans the current user's ~/.claude and ~/.codex session
stores, keeps only sessions whose recorded cwd is inside the repo, converts each
one to Oxygen trajectory v0.2 via the vendored extractors, and copies the
related memory files (Claude project memory, CLAUDE.md, AGENTS.md).

Output layout:

    <out>/
    ├── index.json
    ├── trajectories/traj-<user>-<agent>-<hash>/   (v0.2: manifest/events/redaction/artifacts)
    └── memory/{claude,codex}/...

Everything starts as review_status=pending / publication_approved=false.
"""

from __future__ import annotations

import argparse
import atexit
from dataclasses import dataclass, field
import getpass
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath, PureWindowsPath

from oxygen_common import (
    VENDOR_DIR,
    fail,
    is_sensitive_name,
    progress,
    run_stamp,
    safe_slug,
    sha256_file,
    configure_utf8_stdio,
    text_subprocess_options,
    utc_now,
    write_json,
)


SESSION_SCAN_MAX_RECORDS = 2048
SESSION_SCAN_MAX_BYTES = 4 * 1024 * 1024
CODEX_CWD_RECORD_TYPES = {"session_meta", "turn_context"}


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
    except OSError:
        return sessions
    for jsonl in sorted(sessions_root.rglob("*.jsonl")):
        try:
            resolved_jsonl = jsonl.resolve(strict=True)
        except OSError:
            continue
        if jsonl.is_symlink() or not resolved_jsonl.is_relative_to(resolved_root):
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


def extract(session: Path, system: str, out_root: Path, home: Path, user: str) -> dict:
    digest = sha256_file(session)[:16]
    trajectory_id = f"traj-{safe_slug(user)}-{system}-{digest}"
    script = VENDOR_DIR / (
        "extract_claude_trajectory.py" if system == "claude" else "extract_codex_trajectory.py"
    )
    cmd = [
        sys.executable,
        str(script),
        "--session",
        str(session),
        "--output-root",
        str(out_root),
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


def copy_memory(src: Path, dest_root: Path, base_label: str, collected: list[dict]) -> None:
    """Copy one memory file/dir, skipping anything credential-shaped."""
    try:
        if not src.exists():
            return
        targets = [src] if src.is_file() else sorted(p for p in src.rglob("*") if p.is_file())
    except PermissionError:
        collected.append({"source": str(src), "skipped": "permission denied"})
        return
    for target in targets:
        if is_sensitive_name(target):
            collected.append({"source": str(target), "skipped": "sensitive filename"})
            continue
        rel = target.name if src.is_file() else str(target.relative_to(src))
        dest = dest_root / base_label / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.copy2(target, dest)
        except PermissionError:
            collected.append({"source": str(target), "skipped": "permission denied"})
            continue
        collected.append(
            {"source": str(target), "copied_to": str(dest), "sha256": sha256_file(target)}
        )


def main(argv=None) -> int:
    configure_utf8_stdio()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", type=Path, help="repo the trajectories should relate to")
    parser.add_argument("--out", type=Path, help="output dir (default tools/out/repo-<name>-<ts>)")
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
    parser.add_argument("--publish", action="store_true",
                        help="copy the result into the shared ingest-staging area")
    args = parser.parse_args(argv)
    if bool(args.progress_url) != bool(args.workflow_run_id):
        parser.error("--progress-url and --workflow-run-id must be supplied together")

    repo = args.repo.expanduser().resolve()
    if not repo.is_dir():
        raise fail(f"repo not found: {repo}")
    agents = {a.strip() for a in args.agents.split(",") if a.strip()}
    out = (
        args.out.expanduser().resolve()
        if args.out
        else Path(__file__).resolve().parent / "out" / f"repo-{safe_slug(repo.name)}-{run_stamp()}"
    )
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

    trajectories: list[dict] = []
    done = 0
    for system, sessions in (("claude", claude_sessions), ("codex", codex_sessions)):
        for session in sessions:
            entry = extract(session, system, out / "trajectories", source_home, args.user)
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
            copy_memory(
                project_dir / "memory", memory_root / "claude", f"project-{project_dir.name}", memory
            )
        if args.include_global_memory:
            copy_memory(home / ".claude" / "CLAUDE.md", memory_root / "claude", "global", memory)
        copy_memory(repo / "CLAUDE.md", memory_root / "claude", "repo", memory)
        copy_memory(repo / ".claude", memory_root / "claude", "repo-dot-claude", memory)
    if "codex" in agents:
        if args.include_global_memory:
            copy_memory(home / ".codex" / "AGENTS.md", memory_root / "codex", "global", memory)
        copy_memory(repo / "AGENTS.md", memory_root / "codex", "repo", memory)

    index = {
        "schema_version": "0.2",
        "tool": "collect_repo_trajectories",
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
    }
    write_json(out / "index.json", index)
    if args.publish:
        from oxygen_common import publish_to_staging
        staged = publish_to_staging(out, out.name)
        if staged:
            progress(98, "publish", f"staged: {staged}")
    progress(
        100,
        "done",
        f"{index['trajectory_count']} trajectories ({index['trajectory_failures']} failed), "
        f"{index['memory_file_count']} memory files -> {out}",
    )
    if reporter:
        reporter.finish(failed=index["trajectory_failures"] > 0)
    print(json.dumps({"output": str(out), "index": str(out / 'index.json')}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
