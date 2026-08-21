#!/usr/bin/env python3
"""Start the bundled local Viewer and import one Oxygen ingest output."""

from __future__ import annotations

import argparse
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import re
import signal
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import webbrowser


SKILL_DIR = Path(__file__).resolve().parents[1]
KIT_ROOT = SKILL_DIR.parents[1]
VIEWER = KIT_ROOT / "viewer"


def parse_version(value: str) -> tuple[int, int, int]:
    match = re.search(r"(\d+)\.(\d+)\.(\d+)", value)
    if not match:
        raise ValueError(f"unrecognized version: {value!r}")
    return tuple(int(part) for part in match.groups())


def required_node_version(viewer: Path = VIEWER) -> tuple[int, int, int]:
    package = json.loads((viewer / "package.json").read_text(encoding="utf-8"))
    engine = str((package.get("engines") or {}).get("node") or "")
    try:
        return parse_version(engine)
    except ValueError as error:
        raise SystemExit(f"Cannot determine the Viewer Node requirement from {engine!r}") from error


def command_version(command: list[str], *, cwd: Path = VIEWER) -> str:
    result = subprocess.run(command, cwd=cwd, text=True, capture_output=True)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise SystemExit(f"Command failed ({' '.join(command)}): {detail}")
    return result.stdout.strip()


def validate_node_runtime(viewer: Path = VIEWER) -> tuple[str, str]:
    node = shutil.which("node")
    npm = shutil.which("npm")
    if not node or not npm:
        raise SystemExit(
            "Linux Node.js and npm are required. Open a shell where your Node version manager "
            "is initialized, then rerun the launcher."
        )
    if sys.platform.startswith("linux") and (
        node.lower().endswith(".exe") or npm.lower().endswith(".exe")
    ):
        raise SystemExit(f"Linux launcher resolved a Windows executable: node={node}, npm={npm}")
    node_text = command_version([node, "--version"], cwd=viewer)
    npm_text = command_version([npm, "--version"], cwd=viewer)
    minimum = required_node_version(viewer)
    if parse_version(node_text) < minimum:
        needed = ".".join(str(part) for part in minimum)
        raise SystemExit(f"Viewer requires Node >= {needed}; resolved {node_text} at {node}")
    if Path(node).parent != Path(npm).parent:
        raise SystemExit(
            "Node and npm must come from the same installation; "
            f"resolved node={node}, npm={npm}"
        )
    print(f"Runtime: Node {node_text} · npm {npm_text} ({node})", flush=True)
    return node, npm


def node_modules_issue(viewer: Path = VIEWER) -> str | None:
    modules = viewer / "node_modules"
    vinext = modules / ".bin" / "vinext"
    if not modules.is_dir():
        return "node_modules is absent"
    if not vinext.exists():
        return "node_modules is incomplete (missing .bin/vinext)"
    if os.name == "posix" and not vinext.is_symlink():
        return (
            "node_modules was not installed by npm on this POSIX runtime "
            "(.bin/vinext is not a symlink)"
        )
    return None


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate_viewer_cli(node: str, viewer: Path = VIEWER) -> str | None:
    issue = node_modules_issue(viewer)
    if issue:
        return issue
    cli = (viewer / "node_modules" / ".bin" / "vinext").resolve()
    result = subprocess.run(
        [node, str(cli), "--version"], cwd=viewer, text=True, capture_output=True
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        return f"Vinext CLI cannot run under Linux Node: {detail}"
    return None


def ensure_dependencies(*, skip_install: bool, viewer: Path = VIEWER) -> str:
    node, npm = validate_node_runtime(viewer)
    issue = validate_viewer_cli(node, viewer)
    if not issue:
        return npm
    if skip_install:
        raise SystemExit(
            f"Incompatible Viewer dependencies: {issue}. Rerun without --skip-install "
            "to rebuild them deterministically for Linux."
        )
    lockfile = viewer / "package-lock.json"
    command = [npm, "ci", "--no-audit", "--no-fund"] if lockfile.exists() else [
        npm, "install", "--no-audit", "--no-fund"
    ]
    before = sha256_file(lockfile) if lockfile.exists() else None
    print(f"Viewer dependencies need a Linux rebuild: {issue}", flush=True)
    print(f"Running: {' '.join(command)}", flush=True)
    try:
        subprocess.run(command, cwd=viewer, check=True)
    except subprocess.CalledProcessError as error:
        raise SystemExit(
            "Linux Viewer dependency rebuild failed. Ensure no external process is using "
            f"viewer/node_modules, then rerun the same launcher command (exit {error.returncode})."
        ) from error
    if before is not None and sha256_file(lockfile) != before:
        raise SystemExit("Dependency bootstrap unexpectedly changed package-lock.json")
    remaining = validate_viewer_cli(node, viewer)
    if remaining:
        raise SystemExit(f"Viewer dependency rebuild did not produce a valid Linux install: {remaining}")
    return npm


def ensure_port_available(port: int) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind(("127.0.0.1", port))
        except OSError as error:
            raise SystemExit(
                f"Port {port} is already in use on 127.0.0.1; choose another --port."
            ) from error


def viewer_environment(runtime_root: Path) -> dict[str, str]:
    environment = os.environ.copy()
    environment["OXYGEN_VIEWER_STATE_DIR"] = str(runtime_root / "state")
    environment["WRANGLER_LOG_PATH"] = str(runtime_root / "wrangler.log")
    environment["MINIFLARE_REGISTRY_PATH"] = str(runtime_root / "registry")
    return environment


def viewer_command(port: int, npm: str = "npm") -> list[str]:
    return [npm, "run", "dev", "--", "--host", "127.0.0.1", "--port", str(port)]


def terminate_process_group(process: subprocess.Popen, timeout: int = 8) -> None:
    if os.name != "posix":
        process.terminate()
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=3)


def request_json(opener, url: str, *, method="GET", body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(
        url, data=data, method=method,
        headers={"content-type": "application/json"} if data else {},
    )
    with opener.open(request, timeout=30) as response:
        return json.loads(response.read().decode())


def event_content(event: dict, trajectory_dir: Path) -> str:
    payload = event.get("payload") or {}
    if event.get("event_type") == "artifact" and isinstance(payload.get("path"), str):
        candidate = (trajectory_dir / payload["path"]).resolve()
        try:
            candidate.relative_to(trajectory_dir.resolve())
            data = candidate.read_bytes()
            if b"\0" not in data:
                return data.decode("utf-8", errors="replace")
        except (OSError, ValueError):
            pass
    for key in ("text", "content", "stdout", "stderr", "message", "summary", "note"):
        if isinstance(payload.get(key), str) and payload[key]:
            return payload[key]
    if event.get("event_type") == "tool_call":
        return " · ".join(str(value) for value in (
            payload.get("tool_name") or (event.get("executor") or {}).get("tool") or "tool",
            payload.get("action"),
        ) if value)
    return json.dumps(payload, ensure_ascii=False, indent=2)


def import_trajectory(opener, base_url: str, directory: Path, project_map: dict):
    manifest = json.loads((directory / "manifest.json").read_text())
    redaction_path = directory / "redaction.json"
    redaction = json.loads(redaction_path.read_text()) if redaction_path.exists() else {
        "review_status": "pending", "publication_approved": False,
    }
    events = [
        json.loads(line) for line in (directory / "events.jsonl").read_text().splitlines()
        if line.strip()
    ]
    event_times = [
        event.get("timestamp") or event.get("started_at") for event in events
        if event.get("timestamp") or event.get("started_at")
    ]
    trajectory_id = manifest.get("trajectory_id") or directory.name
    document = {
        "id": trajectory_id, "kind": "trajectory",
        "title": manifest.get("title") or trajectory_id,
        "sourceUser": manifest.get("source_user"),
        "sourceSystem": manifest.get("source_system"),
        "sourceTimestamp": min(event_times) if event_times else manifest.get("snapshot_at"),
        "metadata": {
            "manifest": manifest,
            "redaction": redaction,
            "project_organization": {
                "primary_project": project_map.get("primary_project", "Unclassified"),
                "projects": project_map.get("projects", []),
                "summary": project_map.get("summary", ""),
            },
        },
        "envelope": {"manifest": manifest, "redaction": redaction, "format": "oxygen-events-jsonl"},
        "itemCount": len(events),
    }
    event_labels = project_map.get("events") or {}
    items = []
    for index, event in enumerate(events, 1):
        event_id = event.get("event_id")
        # Event IDs restart inside every trajectory, so prefer the qualified key.
        label = event_labels.get(f"{trajectory_id}:{event_id}", event_labels.get(event_id, {}))
        items.append({
            "id": f"{trajectory_id}:{event_id or f'event-{index}'}",
            "sequence": event.get("sequence", index),
            "eventType": event.get("event_type"),
            "actorId": (event.get("actor") or {}).get("id"),
            "actorType": (event.get("actor") or {}).get("type"),
            "timestamp": event.get("timestamp") or event.get("started_at"),
            "content": event_content(event, directory),
            "original": event,
            "organizationCategory": label.get("project"),
            "organizationConfidence": label.get("confidence"),
            "organizationReason": label.get("summary") or label.get("reason"),
        })
    for start in range(0, max(1, len(items)), 75):
        request_json(opener, f"{base_url}/api/documents", method="POST", body={
            "document": document, "items": items[start:start + 75],
        })
    return len(items)


def import_meeting(opener, base_url: str, path: Path):
    dataset = json.loads(path.read_text())
    records = dataset.get("records") or []
    meeting_id = dataset.get("meeting_id") or dataset.get("id") or path.parent.name
    document = {
        "id": meeting_id, "kind": "meeting",
        "title": dataset.get("title") or meeting_id,
        "sourceSystem": "meeting-transcript",
        "sourceTimestamp": dataset.get("recorded_at") or dataset.get("date"),
        "metadata": {
            "review_status": dataset.get("review_status", "pending"),
            "source_warning_count": int(dataset.get("source_warning_count") or 0),
        },
        "envelope": {**dataset, "records": []},
        "itemCount": len(records),
    }
    items = []
    for index, record in enumerate(records, 1):
        sequence = record.get("sequence_in_meeting")
        if sequence is None:
            sequence = record.get("order")
        if sequence is None:
            sequence = index
        items.append({
            "id": f"{meeting_id}:{record.get('record_id') or f'record-{index}'}",
            "sequence": sequence,
            "eventType": "record",
            "actorId": record.get("speaker"),
            "actorType": "human",
            "timestamp": record.get("timestamp") or record.get("started_at"),
            "content": record.get("text", ""),
            "original": record,
        })
    for start in range(0, max(1, len(items)), 75):
        request_json(opener, f"{base_url}/api/documents", method="POST", body={
            "document": document, "items": items[start:start + 75],
        })
    return len(items)


def locate_inputs(run: Path):
    index_path = run / "index.json"
    trajectories = []
    if index_path.exists():
        index = json.loads(index_path.read_text())
        for entry in index.get("trajectories") or []:
            trajectory_id = entry.get("trajectory_id")
            if trajectory_id and entry.get("ok", True):
                directory = run / "trajectories" / trajectory_id
                if (directory / "events.jsonl").exists():
                    trajectories.append(directory)
        if not trajectories:
            trajectories = sorted(
                path.parent for path in (run / "trajectories").glob("*/events.jsonl")
            )
    meeting = run / "meeting.json"
    if not trajectories and not meeting.exists() and not index_path.exists():
        raise SystemExit(f"Unrecognized ingest output: {run}")
    return trajectories, meeting if meeting.exists() else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("run", type=Path, help="Oxygen ingest output directory")
    parser.add_argument("--port", type=int, default=3210)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--skip-install", action="store_true")
    parser.add_argument("--smoke-test", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    run = args.run.expanduser().resolve()
    trajectories, meeting = locate_inputs(run)
    project_map_path = run / "project-map.json"
    project_map = json.loads(project_map_path.read_text()) if project_map_path.exists() else {}

    signal.signal(signal.SIGTERM, lambda _signum, _frame: (_ for _ in ()).throw(KeyboardInterrupt()))
    base_url = f"http://127.0.0.1:{args.port}"
    ensure_port_available(args.port)
    npm = ensure_dependencies(skip_install=args.skip_install)
    # Check again immediately before launch in case dependency installation took time.
    ensure_port_available(args.port)
    with tempfile.TemporaryDirectory(prefix=f"oxygen-viewer-{args.port}-") as runtime:
        process = subprocess.Popen(
            viewer_command(args.port, npm),
            cwd=VIEWER,
            env=viewer_environment(Path(runtime)),
            start_new_session=True,
        )
        try:
            for _ in range(90):
                try:
                    urllib.request.urlopen(base_url, timeout=1).close()
                    break
                except (OSError, urllib.error.URLError):
                    if process.poll() is not None:
                        raise SystemExit("Viewer exited before becoming ready")
                    time.sleep(0.5)
            else:
                raise SystemExit("Viewer did not become ready")

            opener = urllib.request.build_opener(
                urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
            )
            event_count = sum(
                import_trajectory(opener, base_url, path, project_map) for path in trajectories
            )
            if meeting:
                event_count += import_meeting(opener, base_url, meeting)
            print(f"\nOxygen local review: {base_url}", flush=True)
            print("No password is required for this localhost-only viewer", flush=True)
            print(
                f"Imported: {len(trajectories)} trajectories, {event_count} events/records",
                flush=True,
            )
            print("Nothing has been uploaded. Press Ctrl+C to stop.\n", flush=True)
            if args.smoke_test:
                status = request_json(opener, f"{base_url}/api/organization")
                while status["status"] in {"idle", "running"}:
                    status = request_json(
                        opener, f"{base_url}/api/organization", method="POST", body={}
                    )
                if event_count and status["status"] != "complete":
                    raise SystemExit(f"Organizer did not complete: {status}")
                print(json.dumps({"smoke_test": "passed", "organization": status}))
                return
            if not args.no_browser:
                webbrowser.open(base_url)
            process.wait()
        except KeyboardInterrupt:
            pass
        finally:
            terminate_process_group(process)


if __name__ == "__main__":
    main()
