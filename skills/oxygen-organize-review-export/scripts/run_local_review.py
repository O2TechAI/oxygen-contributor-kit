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
TOOLS_ROOT = KIT_ROOT / "tools"
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from oxygen_utf8 import configure_utf8_stdio, text_subprocess_options


VIEWER_HOST = "127.0.0.1"

_WINDOWS_BOOTSTRAP = """\
import ctypes
from ctypes import wintypes
import subprocess
import sys

handle = wintypes.HANDLE(int(sys.argv[1]))
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
kernel32.WaitForSingleObject.restype = wintypes.DWORD
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.CloseHandle.restype = wintypes.BOOL
try:
    wait_status = kernel32.WaitForSingleObject(handle, 30000)
finally:
    kernel32.CloseHandle(handle)
if wait_status != 0:
    raise SystemExit(90)
raise SystemExit(subprocess.Popen(sys.argv[2:], shell=False).wait())
"""


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
    result = subprocess.run(command, cwd=cwd, capture_output=True, **text_subprocess_options())
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise SystemExit(f"Command failed ({' '.join(command)}): {detail}")
    return result.stdout.strip()


def resolve_executable(
    name: str,
    *,
    platform: str | None = None,
    which=shutil.which,
) -> str | None:
    platform = platform or os.name
    candidates = [name]
    if platform == "nt":
        if name in {"npm", "npx"}:
            candidates = [f"{name}.cmd", f"{name}.exe", name]
        elif name == "node":
            candidates = ["node.exe", "node"]
    for candidate in candidates:
        resolved = which(candidate)
        if resolved:
            return str(resolved)
    return None


def _normalized_parent(path: str) -> str:
    return os.path.normcase(os.path.abspath(str(Path(path).parent)))


def validate_node_runtime(viewer: Path = VIEWER) -> tuple[str, str]:
    node = resolve_executable("node")
    npm = resolve_executable("npm")
    if not node or not npm:
        raise SystemExit(
            "Node.js and npm are required. Open a shell where your Node version manager "
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
    if _normalized_parent(node) != _normalized_parent(npm):
        raise SystemExit(
            "Node and npm must come from the same installation; "
            f"resolved node={node}, npm={npm}"
        )
    print(f"Runtime: Node {node_text} · npm {npm_text} ({node})", flush=True)
    return node, npm


def node_modules_issue(viewer: Path = VIEWER, *, platform: str | None = None) -> str | None:
    platform = platform or os.name
    modules = viewer / "node_modules"
    vinext = modules / ".bin" / "vinext"
    cli = modules / "vinext" / "dist" / "cli.js"
    if not modules.is_dir():
        return "node_modules is absent"
    if not cli.is_file():
        return "node_modules is incomplete (missing vinext/dist/cli.js)"
    if platform == "nt" and not (modules / ".bin" / "vinext.cmd").is_file():
        return (
            "node_modules was not installed by npm on Windows "
            "(missing .bin/vinext.cmd)"
        )
    if platform == "posix" and (not vinext.exists() or not vinext.is_symlink()):
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
    cli = viewer / "node_modules" / "vinext" / "dist" / "cli.js"
    result = subprocess.run(
        [node, str(cli), "--version"],
        cwd=viewer,
        capture_output=True,
        **text_subprocess_options(),
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        return f"Vinext CLI cannot run under the resolved Node runtime: {detail}"
    return None


def ensure_dependencies(*, skip_install: bool, viewer: Path = VIEWER) -> str:
    node, npm = validate_node_runtime(viewer)
    issue = validate_viewer_cli(node, viewer)
    if not issue:
        return npm
    if skip_install:
        raise SystemExit(
            f"Incompatible Viewer dependencies: {issue}. Rerun without --skip-install "
            "to rebuild them deterministically for this operating system."
        )
    lockfile = viewer / "package-lock.json"
    command = [npm, "ci", "--no-audit", "--no-fund"] if lockfile.exists() else [
        npm, "install", "--no-audit", "--no-fund"
    ]
    before = sha256_file(lockfile) if lockfile.exists() else None
    print(f"Viewer dependencies need a platform-local rebuild: {issue}", flush=True)
    print(f"Running: {' '.join(command)}", flush=True)
    try:
        subprocess.run(command, cwd=viewer, check=True)
    except subprocess.CalledProcessError as error:
        raise SystemExit(
            "Viewer dependency rebuild failed. Ensure no external process is using "
            f"viewer/node_modules, then rerun the same launcher command (exit {error.returncode})."
        ) from error
    if before is not None and sha256_file(lockfile) != before:
        raise SystemExit("Dependency bootstrap unexpectedly changed package-lock.json")
    remaining = validate_viewer_cli(node, viewer)
    if remaining:
        raise SystemExit(
            f"Viewer dependency rebuild did not produce a valid platform-local install: {remaining}"
        )
    return npm


def _port_available(port: int, host: str = VIEWER_HOST) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        try:
            probe.bind((host, port))
            return True
        except OSError:
            return False


def ensure_port_available(port: int, host: str = VIEWER_HOST) -> None:
    if not _port_available(port, host):
        raise SystemExit(f"Port {port} is already in use on {host}; choose another --port.")


def wait_for_port_release(port: int, host: str = VIEWER_HOST, timeout: float = 8) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if _port_available(port, host):
            return
        time.sleep(0.1)
    raise RuntimeError(f"Owned Viewer process tree did not release {host}:{port}")


def viewer_environment(runtime_root: Path, port: int | None = None) -> dict[str, str]:
    environment = os.environ.copy()
    environment["OXYGEN_VIEWER_STATE_DIR"] = str(runtime_root / "state")
    environment["WRANGLER_LOG_PATH"] = str(runtime_root / "wrangler.log")
    environment["MINIFLARE_REGISTRY_PATH"] = str(runtime_root / "registry")
    environment["OXYGEN_VIEWER_HOST"] = VIEWER_HOST
    if port is not None:
        environment["OXYGEN_VIEWER_PORT"] = str(port)
    return environment


def viewer_command(port: int, npm: str = "npm") -> list[str]:
    return [npm, "run", "dev", "--", "--hostname", VIEWER_HOST, "--port", str(port)]


def _raise_keyboard_interrupt(_signum, _frame) -> None:
    raise KeyboardInterrupt


def install_signal_handlers() -> None:
    signal.signal(signal.SIGTERM, _raise_keyboard_interrupt)
    if os.name == "nt" and hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, _raise_keyboard_interrupt)


class WindowsJob:
    """Kill-on-close Job Object that owns exactly one spawned process tree."""

    def __init__(self) -> None:
        import ctypes
        from ctypes import wintypes

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [
                ("ReadOperationCount", ctypes.c_ulonglong),
                ("WriteOperationCount", ctypes.c_ulonglong),
                ("OtherOperationCount", ctypes.c_ulonglong),
                ("ReadTransferCount", ctypes.c_ulonglong),
                ("WriteTransferCount", ctypes.c_ulonglong),
                ("OtherTransferCount", ctypes.c_ulonglong),
            ]

        class BASIC_LIMITS(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_longlong),
                ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class EXTENDED_LIMITS(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", BASIC_LIMITS),
                ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.SetInformationJobObject.argtypes = [
            wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD
        ]
        kernel32.SetInformationJobObject.restype = wintypes.BOOL
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        kernel32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        kernel32.TerminateJobObject.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL

        handle = kernel32.CreateJobObjectW(None, None)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        limits = EXTENDED_LIMITS()
        limits.BasicLimitInformation.LimitFlags = 0x00002000  # KILL_ON_JOB_CLOSE
        if not kernel32.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            error = ctypes.WinError(ctypes.get_last_error())
            kernel32.CloseHandle(handle)
            raise error
        self._ctypes = ctypes
        self._kernel32 = kernel32
        self.handle = handle

    def assign(self, process: subprocess.Popen) -> None:
        if not self._kernel32.AssignProcessToJobObject(self.handle, int(process._handle)):
            raise self._ctypes.WinError(self._ctypes.get_last_error())

    def terminate(self) -> None:
        if self.handle and not self._kernel32.TerminateJobObject(self.handle, 1):
            raise self._ctypes.WinError(self._ctypes.get_last_error())

    def close(self) -> None:
        if self.handle:
            self._kernel32.CloseHandle(self.handle)
            self.handle = None


class WindowsLaunchGate:
    """One-shot inherited event that holds a bootstrap before real-command launch."""

    def __init__(self) -> None:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateEventW.argtypes = [
            wintypes.LPVOID, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR
        ]
        kernel32.CreateEventW.restype = wintypes.HANDLE
        kernel32.SetEvent.argtypes = [wintypes.HANDLE]
        kernel32.SetEvent.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        handle = kernel32.CreateEventW(None, True, False, None)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        self._ctypes = ctypes
        self._kernel32 = kernel32
        self.handle = handle

    def bootstrap_command(self, command: list[str]) -> list[str]:
        return [sys.executable, "-c", _WINDOWS_BOOTSTRAP, str(int(self.handle)), *command]

    def startupinfo(self) -> subprocess.STARTUPINFO:
        os.set_handle_inheritable(int(self.handle), True)
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.lpAttributeList = {"handle_list": [int(self.handle)]}
        return startupinfo

    def finish_inheritance(self) -> None:
        if self.handle:
            os.set_handle_inheritable(int(self.handle), False)

    def release(self) -> None:
        if not self.handle or not self._kernel32.SetEvent(self.handle):
            raise self._ctypes.WinError(self._ctypes.get_last_error())

    def close(self) -> None:
        if self.handle:
            try:
                self.finish_inheritance()
            finally:
                self._kernel32.CloseHandle(self.handle)
                self.handle = None


class OwnedProcess:
    def __init__(self, process: subprocess.Popen, job: WindowsJob | None = None) -> None:
        self.process = process
        self.job = job

    @property
    def pid(self) -> int:
        return self.process.pid

    def poll(self):
        return self.process.poll()

    def wait(self, timeout=None):
        return self.process.wait(timeout=timeout)


def _stop_waiting_bootstrap(process: subprocess.Popen, timeout: float = 3) -> None:
    """Reap a gated bootstrap; it cannot have descendants before release."""
    if process.poll() is None:
        try:
            process.terminate()
        except OSError:
            pass
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=timeout)


def start_owned_process(
    command: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    _windows_job_factory_for_test=None,
    _windows_gate_factory_for_test=None,
) -> OwnedProcess:
    if os.name != "nt":
        process = subprocess.Popen(command, cwd=cwd, env=env, start_new_session=True)
        return OwnedProcess(process)

    job_factory = _windows_job_factory_for_test or WindowsJob
    gate_factory = _windows_gate_factory_for_test or WindowsLaunchGate
    gate = None
    job = None
    process = None
    assigned = False
    try:
        gate = gate_factory()
        startupinfo = gate.startupinfo()
        try:
            process = subprocess.Popen(
                gate.bootstrap_command(command),
                cwd=cwd,
                env=env,
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
                startupinfo=startupinfo,
                close_fds=True,
            )
        finally:
            gate.finish_inheritance()
        job = job_factory()
        job.assign(process)
        assigned = True
        gate.release()
        return OwnedProcess(process, job)
    except BaseException as error:
        cleanup_errors = []
        if job is not None:
            try:
                if assigned:
                    job.terminate()
            except Exception as cleanup_error:
                cleanup_errors.append(cleanup_error)
            finally:
                try:
                    job.close()
                except Exception as cleanup_error:
                    cleanup_errors.append(cleanup_error)
        if process is not None:
            try:
                _stop_waiting_bootstrap(process)
            except Exception as cleanup_error:
                cleanup_errors.append(cleanup_error)
        if isinstance(error, (KeyboardInterrupt, SystemExit)):
            raise
        cleanup_detail = (
            f"; cleanup errors: {', '.join(str(item) for item in cleanup_errors)}"
            if cleanup_errors else ""
        )
        raise SystemExit(
            f"Cannot establish Windows Viewer process-tree ownership: {error}{cleanup_detail}"
        ) from error
    finally:
        if gate is not None:
            gate.close()


def terminate_process_group(process: OwnedProcess | subprocess.Popen, timeout: int = 8) -> None:
    owned = process if isinstance(process, OwnedProcess) else OwnedProcess(process)
    child = owned.process
    if os.name == "nt":
        if child.poll() is None:
            try:
                child.send_signal(signal.CTRL_BREAK_EVENT)
                child.wait(timeout=min(2, timeout))
            except (OSError, subprocess.TimeoutExpired):
                pass
        if owned.job is not None:
            try:
                owned.job.terminate()
            finally:
                owned.job.close()
        elif child.poll() is None:
            subprocess.run(
                ["taskkill.exe", "/PID", str(child.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        try:
            child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=3)
        return
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        child.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait(timeout=3)


def wait_for_owned_exit(process: OwnedProcess, poll_interval: float = 0.25) -> int:
    """Wait without blocking Windows Python signal dispatch indefinitely."""
    while True:
        try:
            return process.wait(timeout=poll_interval)
        except subprocess.TimeoutExpired:
            continue


def request_json(opener, url: str, *, method="GET", body=None):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url, data=data, method=method,
        headers={"content-type": "application/json"} if data else {},
    )
    with opener.open(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def event_content(event: dict, trajectory_dir: Path) -> str:
    payload = event.get("payload") or {}
    if event.get("event_type") == "artifact" and isinstance(payload.get("path"), str):
        candidate = (trajectory_dir / payload["path"]).resolve()
        try:
            candidate.relative_to(trajectory_dir.resolve())
            data = candidate.read_bytes()
            if b"\0" not in data:
                return data.decode("utf-8")
        except UnicodeDecodeError as error:
            raise SystemExit(f"artifact is not valid UTF-8 text: {candidate}: {error}") from error
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
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    redaction_path = directory / "redaction.json"
    redaction = json.loads(redaction_path.read_text(encoding="utf-8")) if redaction_path.exists() else {
        "review_status": "pending", "publication_approved": False,
    }
    events = [
        json.loads(line)
        for line in (directory / "events.jsonl").read_text(encoding="utf-8").splitlines()
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
    dataset = json.loads(path.read_text(encoding="utf-8"))
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
        index = json.loads(index_path.read_text(encoding="utf-8"))
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
    configure_utf8_stdio()
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
    project_map = (
        json.loads(project_map_path.read_text(encoding="utf-8"))
        if project_map_path.exists()
        else {}
    )

    install_signal_handlers()
    base_url = f"http://{VIEWER_HOST}:{args.port}"
    ensure_port_available(args.port)
    npm = ensure_dependencies(skip_install=args.skip_install)
    # Check again immediately before launch in case dependency installation took time.
    ensure_port_available(args.port)
    with tempfile.TemporaryDirectory(prefix=f"oxygen-viewer-{args.port}-") as runtime:
        process = start_owned_process(
            viewer_command(args.port, npm),
            cwd=VIEWER,
            env=viewer_environment(Path(runtime), args.port),
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
            return_code = wait_for_owned_exit(process)
            if return_code != 0:
                raise SystemExit(f"Viewer exited unexpectedly with status {return_code}")
        except KeyboardInterrupt:
            pass
        finally:
            terminate_process_group(process)
            wait_for_port_release(args.port)


if __name__ == "__main__":
    main()
