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
import getpass
import json
import shutil
import subprocess
import sys
from pathlib import Path

from oxygen_common import (
    VENDOR_DIR,
    fail,
    is_sensitive_name,
    progress,
    run_stamp,
    read_first_jsonl_records,
    safe_slug,
    sha256_file,
    utc_now,
    write_json,
)


def session_cwds(path: Path, system: str) -> set[str]:
    cwds: set[str] = set()
    for record in read_first_jsonl_records(path, limit=80):
        if system == "claude":
            cwd = record.get("cwd")
            if isinstance(cwd, str):
                cwds.add(cwd)
        else:  # codex rollout: session_meta / turn_context carry cwd
            payload = record.get("payload")
            if isinstance(payload, dict):
                cwd = payload.get("cwd")
                if isinstance(cwd, str):
                    cwds.add(cwd)
            cwd = record.get("cwd")
            if isinstance(cwd, str):
                cwds.add(cwd)
    return cwds


def is_inside(cwd: str, repo: Path) -> bool:
    try:
        resolved = Path(cwd).resolve()
    except OSError:
        return False
    return resolved == repo or repo in resolved.parents


def find_claude_sessions(home: Path, repo: Path) -> tuple[list[Path], list[Path]]:
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
            cwds = session_cwds(jsonl, "claude")
            if any(is_inside(cwd, repo) for cwd in cwds):
                sessions.append(jsonl)
                matched_dir = True
        if matched_dir:
            project_dirs.append(project_dir)
    return sessions, project_dirs


def find_codex_sessions(home: Path, repo: Path) -> list[Path]:
    sessions_root = home / ".codex" / "sessions"
    sessions: list[Path] = []
    if not sessions_root.is_dir():
        return sessions
    for jsonl in sorted(sessions_root.rglob("*.jsonl")):
        cwds = session_cwds(jsonl, "codex")
        if any(is_inside(cwd, repo) for cwd in cwds):
            sessions.append(jsonl)
    return sessions


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
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=str(VENDOR_DIR))
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
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", type=Path, help="repo the trajectories should relate to")
    parser.add_argument("--out", type=Path, help="output dir (default tools/out/repo-<name>-<ts>)")
    parser.add_argument("--home", type=Path, default=Path.home())
    parser.add_argument("--user", default=getpass.getuser())
    parser.add_argument(
        "--agents", default="claude,codex", help="comma list among: claude,codex"
    )
    parser.add_argument("--publish", action="store_true",
                        help="copy the result into the shared ingest-staging area")
    args = parser.parse_args(argv)

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

    progress(2, "scan", f"scanning sessions related to {repo}")
    claude_sessions: list[Path] = []
    claude_project_dirs: list[Path] = []
    codex_sessions: list[Path] = []
    if "claude" in agents:
        claude_sessions, claude_project_dirs = find_claude_sessions(home, repo)
    if "codex" in agents:
        codex_sessions = find_codex_sessions(home, repo)
    total = len(claude_sessions) + len(codex_sessions)
    progress(10, "scan", f"{len(claude_sessions)} claude + {len(codex_sessions)} codex sessions match")

    trajectories: list[dict] = []
    done = 0
    for system, sessions in (("claude", claude_sessions), ("codex", codex_sessions)):
        for session in sessions:
            entry = extract(session, system, out / "trajectories", home, args.user)
            trajectories.append(entry)
            done += 1
            pct = 10 + 75 * done / max(1, total)
            status = "ok" if entry["ok"] else "FAILED"
            progress(pct, "extract", f"[{done}/{total}] {entry['trajectory_id']} {status}")

    progress(88, "memory", "collecting memory files")
    memory: list[dict] = []
    memory_root = out / "memory"
    if "claude" in agents:
        for project_dir in claude_project_dirs:
            copy_memory(
                project_dir / "memory", memory_root / "claude", f"project-{project_dir.name}", memory
            )
        copy_memory(home / ".claude" / "CLAUDE.md", memory_root / "claude", "global", memory)
        copy_memory(repo / "CLAUDE.md", memory_root / "claude", "repo", memory)
        copy_memory(repo / ".claude", memory_root / "claude", "repo-dot-claude", memory)
    if "codex" in agents:
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
    print(json.dumps({"output": str(out), "index": str(out / 'index.json')}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
