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
import urllib.parse
import urllib.request
import uuid
import webbrowser


SKILL_DIR = Path(__file__).resolve().parents[1]
KIT_ROOT = SKILL_DIR.parents[1]
VIEWER = KIT_ROOT / "viewer"
TOOLS_ROOT = KIT_ROOT / "tools"
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from oxygen_utf8 import configure_utf8_stdio, text_subprocess_options


VIEWER_HOST = "127.0.0.1"
INPUT_RUN_INVALID = "INPUT_RUN_INVALID"
INPUT_INDEX_INVALID = "INPUT_INDEX_INVALID"
INPUT_TRAJECTORY_ID_INVALID = "INPUT_TRAJECTORY_ID_INVALID"
INPUT_MEETING_ID_INVALID = "INPUT_MEETING_ID_INVALID"
INPUT_MEETING_ID_DUPLICATE = "INPUT_MEETING_ID_DUPLICATE"
INPUT_PATH_OUTSIDE_RUN = "INPUT_PATH_OUTSIDE_RUN"
INPUT_PATH_MISSING = "INPUT_PATH_MISSING"
INPUT_FILE_INVALID = "INPUT_FILE_INVALID"

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


def reserve_free_port(host: str = VIEWER_HOST) -> socket.socket:
    """Reserve an OS-selected loopback port until immediately before launch."""
    reservation = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
        reservation.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    try:
        reservation.bind((host, 0))
    except Exception:
        reservation.close()
        raise
    return reservation


def select_free_port(host: str = VIEWER_HOST) -> int:
    with reserve_free_port(host) as reservation:
        return int(reservation.getsockname()[1])


def normalize_local_viewer_url(value: str) -> str:
    parsed = urllib.parse.urlparse(value)
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {VIEWER_HOST, "localhost"}
        or parsed.port is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        raise SystemExit("--attach-url must be an explicit localhost HTTP origin")
    return f"http://{parsed.hostname}:{parsed.port}"


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


def resolve_contained_path(candidate: Path, approved_root: Path) -> Path:
    """Resolve one existing input and require its target to stay inside the run root."""
    resolved_root = approved_root.resolve(strict=True)
    resolved_candidate = candidate.resolve(strict=True)
    if not resolved_candidate.is_relative_to(resolved_root):
        raise ValueError("resolved path leaves approved run")
    return resolved_candidate


def event_content(event: dict, trajectory_dir: Path) -> str:
    payload = event.get("payload") or {}
    if event.get("event_type") == "artifact" and isinstance(payload.get("path"), str):
        try:
            candidate = resolve_contained_path(trajectory_dir / payload["path"], trajectory_dir)
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


def import_trajectory(opener, base_url: str, prepared: dict, project_map: dict):
    directory = prepared["directory"]
    manifest = prepared["manifest"]
    redaction = prepared["redaction"]
    events = prepared["events"]
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


def import_meeting(opener, base_url: str, prepared: dict):
    dataset = prepared["dataset"]
    records = dataset.get("records") or []
    meeting_id = prepared["meeting_id"]
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


def _validated_trajectory_id(value) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,254}", value):
        raise SystemExit(INPUT_TRAJECTORY_ID_INVALID)
    if urllib.parse.unquote(value) != value:
        raise SystemExit(INPUT_TRAJECTORY_ID_INVALID)
    return value


def _validated_meeting_id(value) -> str:
    try:
        return _validated_trajectory_id(value)
    except SystemExit:
        raise SystemExit(INPUT_MEETING_ID_INVALID) from None


def _located_input(candidate: Path, approved_run: Path) -> Path:
    try:
        return resolve_contained_path(candidate, approved_run)
    except ValueError:
        raise SystemExit(INPUT_PATH_OUTSIDE_RUN) from None
    except (OSError, RuntimeError):
        raise SystemExit(INPUT_PATH_MISSING) from None


def _located_file(candidate: Path, approved_run: Path, *, required: bool) -> Path | None:
    if not candidate.exists() and not candidate.is_symlink():
        if required:
            raise SystemExit(INPUT_PATH_MISSING)
        return None
    located = _located_input(candidate, approved_run)
    if not located.is_file():
        raise SystemExit(INPUT_PATH_MISSING)
    return located


def _trajectory_files(directory: Path, approved_run: Path) -> tuple[Path, Path | None, Path]:
    manifest = _located_file(directory / "manifest.json", approved_run, required=True)
    redaction = _located_file(directory / "redaction.json", approved_run, required=False)
    events = _located_file(directory / "events.jsonl", approved_run, required=True)
    assert manifest is not None and events is not None
    return manifest, redaction, events


def _read_json_object(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise SystemExit(INPUT_FILE_INVALID) from None
    if not isinstance(value, dict):
        raise SystemExit(INPUT_FILE_INVALID)
    return value


def _prepare_trajectory(directory: Path, approved_run: Path) -> dict:
    manifest_path, redaction_path, events_path = _trajectory_files(directory, approved_run)
    manifest = _read_json_object(manifest_path)
    if manifest.get("trajectory_id") is not None:
        _validated_trajectory_id(manifest["trajectory_id"])
    redaction = _read_json_object(redaction_path) if redaction_path else {
        "review_status": "pending", "publication_approved": False,
    }
    try:
        events = [
            json.loads(line)
            for line in events_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise SystemExit(INPUT_FILE_INVALID) from None
    if not all(isinstance(event, dict) for event in events):
        raise SystemExit(INPUT_FILE_INVALID)
    return {
        "directory": directory,
        "manifest": manifest,
        "redaction": redaction,
        "events": events,
    }


def _prepare_meeting(path: Path) -> dict:
    dataset = _read_json_object(path)
    records = dataset.get("records")
    if not isinstance(records, list) or not all(isinstance(record, dict) for record in records):
        raise SystemExit(INPUT_FILE_INVALID)
    meeting_id = _validated_meeting_id(
        dataset.get("meeting_id") or dataset.get("id") or path.parent.name
    )
    return {"path": path, "dataset": dataset, "meeting_id": meeting_id}


def locate_inputs(run: Path):
    try:
        approved_run = run.resolve(strict=True)
    except (OSError, RuntimeError):
        raise SystemExit(INPUT_RUN_INVALID) from None
    if not approved_run.is_dir():
        raise SystemExit(INPUT_RUN_INVALID)

    index_candidate = approved_run / "index.json"
    index_path = None
    trajectories = []
    if index_candidate.exists() or index_candidate.is_symlink():
        index_path = _located_input(index_candidate, approved_run)
        try:
            index = json.loads(index_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            raise SystemExit(INPUT_INDEX_INVALID) from None
        if not isinstance(index, dict):
            raise SystemExit(INPUT_INDEX_INVALID)
        entries = index.get("trajectories") or []
        if not isinstance(entries, list):
            raise SystemExit(INPUT_INDEX_INVALID)
        selected_entries = 0
        seen_ids = set()
        for entry in entries:
            if not isinstance(entry, dict) or ("ok" in entry and not isinstance(entry["ok"], bool)):
                raise SystemExit(INPUT_INDEX_INVALID)
            trajectory_id = entry.get("trajectory_id")
            if trajectory_id is None and entry.get("ok", True) is False:
                continue
            trajectory_id = _validated_trajectory_id(trajectory_id)
            if trajectory_id in seen_ids:
                raise SystemExit(INPUT_INDEX_INVALID)
            seen_ids.add(trajectory_id)
            if entry.get("ok", True) is False:
                continue
            selected_entries += 1
            directory = _located_input(approved_run / "trajectories" / trajectory_id, approved_run)
            if not directory.is_dir():
                raise SystemExit(INPUT_PATH_MISSING)
            _trajectory_files(directory, approved_run)
            trajectories.append(directory)
        if not trajectories and selected_entries == 0:
            trajectory_root = approved_run / "trajectories"
            if trajectory_root.is_dir():
                for events_candidate in sorted(trajectory_root.glob("*/events.jsonl")):
                    events_path = _located_input(events_candidate, approved_run)
                    directory = _located_input(events_path.parent, approved_run)
                    if not events_path.is_file() or not directory.is_dir():
                        raise SystemExit(INPUT_PATH_MISSING)
                    _trajectory_files(directory, approved_run)
                    trajectories.append(directory)

    _located_file(approved_run / "project-map.json", approved_run, required=False)

    meetings = []
    meeting_candidate = approved_run / "meeting.json"
    if meeting_candidate.exists() or meeting_candidate.is_symlink():
        meeting = _located_file(meeting_candidate, approved_run, required=True)
        assert meeting is not None
        meetings.append(meeting)

    meetings_candidate = approved_run / "meetings"
    if meetings_candidate.exists() or meetings_candidate.is_symlink():
        meetings_root = _located_input(meetings_candidate, approved_run)
        if not meetings_root.is_dir():
            raise SystemExit(INPUT_PATH_MISSING)
        try:
            entries = sorted(meetings_root.iterdir())
        except (OSError, RuntimeError):
            raise SystemExit(INPUT_PATH_MISSING) from None
        for entry in entries:
            directory = _located_input(entry, approved_run)
            if not directory.is_dir():
                raise SystemExit(INPUT_PATH_MISSING)
            _validated_meeting_id(directory.name)
            meeting = _located_file(directory / "meeting.json", approved_run, required=True)
            assert meeting is not None
            meetings.append(meeting)

    if not trajectories and not meetings and index_path is None:
        raise SystemExit(INPUT_RUN_INVALID)
    return trajectories, meetings


def import_run(opener, base_url: str, run: Path) -> tuple[int, int]:
    trajectories, meetings = locate_inputs(run)
    approved_run = _located_input(run, run)
    project_map_path = _located_file(
        approved_run / "project-map.json", approved_run, required=False
    )
    project_map = _read_json_object(project_map_path) if project_map_path else {}
    prepared_trajectories = [
        _prepare_trajectory(path, approved_run) for path in trajectories
    ]
    prepared_meetings = [_prepare_meeting(path) for path in meetings]
    meeting_ids = [prepared["meeting_id"] for prepared in prepared_meetings]
    if len(set(meeting_ids)) != len(meeting_ids):
        raise SystemExit(INPUT_MEETING_ID_DUPLICATE)
    event_count = sum(
        import_trajectory(opener, base_url, prepared, project_map)
        for prepared in prepared_trajectories
    )
    event_count += sum(
        import_meeting(opener, base_url, prepared) for prepared in prepared_meetings
    )
    return len(trajectories) + len(meetings), event_count


def complete_organization(opener, base_url: str) -> dict:
    current = request_json(opener, f"{base_url}/api/organization")
    while current["status"] not in {"complete", "empty"}:
        current = request_json(
            opener, f"{base_url}/api/organization", method="POST", body={}
        )
    return current


def establish_workflow_run(opener, base_url: str, workflow_run_id: str | None = None) -> str:
    established = workflow_run_id or f"oxygen-{uuid.uuid4().hex}"
    workflow = request_json(opener, f"{base_url}/api/workflow", method="POST", body={
        "workflowRunId": established,
        "event": "target_confirmed",
    })
    if workflow.get("workflowRunId") != established:
        raise SystemExit("The Viewer did not establish the requested workflow run ID")
    return established


def attach_run(base_url: str, workflow_run_id: str, run: Path) -> None:
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
    )
    workflow = request_json(opener, f"{base_url}/api/workflow")
    if workflow.get("workflowRunId") != workflow_run_id:
        raise SystemExit("The target Viewer does not own the requested workflow run ID")
    document_count, event_count = import_run(opener, base_url, run)
    organization = complete_organization(opener, base_url)
    print(json.dumps({
        "attached_to": base_url,
        "workflow_run_id": workflow_run_id,
        "documents": document_count,
        "events_or_records": event_count,
        "organization": organization,
    }, ensure_ascii=False), flush=True)


STORY_WORKFLOW_EVENTS = {
    "started": "story_generation_started",
    "progress": "story_generation_progress",
    "blocked": "story_generation_blocked",
    "ready": "story_ready_for_human_review",
}


def update_story_workflow(
    base_url: str,
    workflow_run_id: str,
    story_event: str,
    completed: int | None = None,
    total: int | None = None,
) -> dict:
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
    )
    payload = {
        "workflowRunId": workflow_run_id,
        "event": STORY_WORKFLOW_EVENTS[story_event],
    }
    if story_event == "progress":
        payload.update({"completed": completed, "total": total})
    workflow = request_json(
        opener, f"{base_url}/api/workflow", method="POST", body=payload
    )
    if story_event == "ready" and not (
        workflow.get("currentStageId") == "review"
        and workflow.get("storyGenerationStatus") == "ready_for_human_review"
        and workflow.get("requiresHumanAction") is True
    ):
        raise SystemExit("The Viewer did not enter the persisted human Story review boundary")
    result = {
        "viewer": base_url,
        "workflow_run_id": workflow_run_id,
        "story_event": story_event,
        "current_stage": workflow.get("currentStageId"),
        "story_generation_status": workflow.get("storyGenerationStatus"),
        "requires_human_action": workflow.get("requiresHumanAction"),
        **({
            "handoff_state": "WAITING_FOR_HUMAN_STORY_REVIEW",
            "password_required": False,
            "pause_for_human_review": True,
        } if story_event == "ready" else {}),
    }
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return result


def main():
    configure_utf8_stdio()
    parser = argparse.ArgumentParser()
    parser.add_argument("run", nargs="?", type=Path, help="Oxygen ingest output directory")
    parser.add_argument("--target", type=Path, help="working folder confirmed before collection")
    parser.add_argument("--attach-url", help="attach the run to an existing progress-first Viewer")
    parser.add_argument("--workflow-run-id", help="stable progress-first workflow run ID")
    parser.add_argument("--story-event", choices=sorted(STORY_WORKFLOW_EVENTS))
    parser.add_argument("--story-completed", type=int)
    parser.add_argument("--story-total", type=int)
    parser.add_argument("--port", type=int)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--skip-install", action="store_true")
    parser.add_argument("--smoke-test", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()

    if args.story_event:
        if args.run or args.target or not args.attach_url or not args.workflow_run_id:
            parser.error("Story events require --attach-url and --workflow-run-id only")
        has_counts = args.story_completed is not None or args.story_total is not None
        if args.story_event == "progress":
            if args.story_completed is None or args.story_total is None:
                parser.error("Story progress requires --story-completed and --story-total")
            if not 0 <= args.story_completed <= args.story_total:
                parser.error("Story progress counts must satisfy 0 <= completed <= total")
        elif has_counts:
            parser.error("Story counts are accepted only with --story-event progress")
        update_story_workflow(
            normalize_local_viewer_url(args.attach_url), args.workflow_run_id,
            args.story_event, args.story_completed, args.story_total,
        )
        return

    if args.attach_url:
        if not args.run or args.target or not args.workflow_run_id:
            parser.error("attach mode requires RUN, --attach-url, and --workflow-run-id only")
        run = args.run.expanduser().resolve()
        attach_run(normalize_local_viewer_url(args.attach_url), args.workflow_run_id, run)
        return

    if bool(args.run) == bool(args.target):
        parser.error("choose exactly one of RUN or --target")
    if args.port is not None and not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    if args.workflow_run_id and not args.target:
        parser.error("--workflow-run-id without --attach-url requires --target")

    run = args.run.expanduser().resolve() if args.run else None
    target = args.target.expanduser().resolve() if args.target else None
    if run:
        locate_inputs(run)
    if target and not target.is_dir():
        raise SystemExit(f"Working folder not found: {target}")

    install_signal_handlers()
    reservation = reserve_free_port() if args.port is None else None
    port = int(reservation.getsockname()[1]) if reservation else int(args.port)
    if not reservation:
        ensure_port_available(port)
    try:
        npm = ensure_dependencies(skip_install=args.skip_install)
    finally:
        if reservation:
            reservation.close()
    # Fail closed if the exact selected/requested port changed owners during setup.
    ensure_port_available(port)
    base_url = f"http://{VIEWER_HOST}:{port}"

    with tempfile.TemporaryDirectory(prefix=f"oxygen-viewer-{port}-") as runtime:
        process = start_owned_process(
            viewer_command(port, npm),
            cwd=VIEWER,
            env=viewer_environment(Path(runtime), port),
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
            workflow_run_id = establish_workflow_run(
                opener, base_url, args.workflow_run_id
            )
            if target:
                print(f"\nOxygen Workflow Progress: {base_url}", flush=True)
                print(f"Workflow run: {workflow_run_id}", flush=True)
                print("Working folder confirmed; collection has not started.", flush=True)
                print("No password is required for this localhost-only viewer", flush=True)
                print("Nothing has been uploaded. Press Ctrl+C to stop.\n", flush=True)
                if not args.no_browser:
                    webbrowser.open(base_url)
                if args.smoke_test:
                    workflow = request_json(opener, f"{base_url}/api/workflow")
                    print(json.dumps({"smoke_test": "passed", "workflow": workflow}))
                    return
            else:
                document_count, event_count = import_run(opener, base_url, run)
                print(f"\nOxygen local review: {base_url}", flush=True)
                print("No password is required for this localhost-only viewer", flush=True)
                print(
                    f"Imported: {document_count} trajectories/meetings, "
                    f"{event_count} events/records",
                    flush=True,
                )
                print("Nothing has been uploaded. Press Ctrl+C to stop.\n", flush=True)
                if args.smoke_test:
                    status = complete_organization(opener, base_url)
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
            wait_for_port_release(port)


if __name__ == "__main__":
    main()
