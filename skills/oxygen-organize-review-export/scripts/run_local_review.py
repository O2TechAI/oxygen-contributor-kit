#!/usr/bin/env python3
"""Start the bundled local Viewer and import one Oxygen ingest output."""

from __future__ import annotations

import argparse
from contextlib import closing, nullcontext
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import re
import signal
import shutil
import socket
import sqlite3
import stat
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

from ingest.human_source_projection import (
    AI_REVIEW_EVENT_SCHEMA,
    AI_REVIEW_MEETING_SCHEMA,
    AI_REVIEW_RUN_SCHEMA,
    AI_REVIEW_TRAJECTORY_SCHEMA,
    INGEST_RUN_SCHEMA,
    MEETING_SCHEMA,
    POLICY_ID as HUMAN_SOURCE_POLICY_ID,
    TRAJECTORY_EVENT_SCHEMA,
    TRAJECTORY_REDACTION_SCHEMA,
    TRAJECTORY_SCHEMA,
    meeting_contribution_ids,
    projected_event_content,
    projected_contribution_id,
)
from oxygen_utf8 import configure_utf8_stdio, text_subprocess_options


VIEWER_HOST = "127.0.0.1"
INPUT_RUN_INVALID = "INPUT_RUN_INVALID"
INPUT_INDEX_INVALID = "INPUT_INDEX_INVALID"
INPUT_TRAJECTORY_ID_INVALID = "INPUT_TRAJECTORY_ID_INVALID"
INPUT_MEETING_ID_INVALID = "INPUT_MEETING_ID_INVALID"
INPUT_MEETING_ID_DUPLICATE = "INPUT_MEETING_ID_DUPLICATE"
INPUT_PATH_OUTSIDE_RUN = "INPUT_PATH_OUTSIDE_RUN"
INPUT_PATH_ALIAS = "INPUT_PATH_ALIAS"
INPUT_PATH_MISSING = "INPUT_PATH_MISSING"
INPUT_FILE_INVALID = "INPUT_FILE_INVALID"
INPUT_PROJECTION_INVALID = "INPUT_PROJECTION_INVALID"
VIEWER_NETWORK_ERROR = "VIEWER_NETWORK_ERROR: The local Viewer could not be reached."
VIEWER_RESPONSE_INVALID = "VIEWER_RESPONSE_INVALID: The local Viewer returned an invalid response."
VIEWER_STATE_INVALID = "VIEWER_STATE_INVALID: The saved Viewer state is missing or corrupt."
VIEWER_STATE_EXISTS = "VIEWER_STATE_EXISTS: The saved Viewer state destination already exists."
VIEWER_STATE_SAVE_FAILED = "VIEWER_STATE_SAVE_FAILED: The Viewer state could not be saved."
WORKFLOW_SESSION_QUERY = """
SELECT id, target_confirmed, collection_status, collection_completed, collection_total,
       story_generation_status, story_generation_completed, story_generation_total,
       story_source_revision, active_story_digest, blocker_code, created_at, updated_at
FROM workflow_runs
"""
VIEWER_WORKFLOW_BLOCKERS = {
    400: "VIEWER_WORKFLOW_BLOCKED_HTTP_400: The local Viewer rejected the workflow request.",
    404: "VIEWER_WORKFLOW_BLOCKED_HTTP_404: The local Viewer rejected the workflow request.",
    409: "VIEWER_WORKFLOW_BLOCKED_HTTP_409: The local Viewer rejected the workflow request.",
}

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
    next_shim = modules / ".bin" / "next"
    cli = modules / "next" / "dist" / "bin" / "next"
    if not modules.is_dir():
        return "node_modules is absent"
    if not cli.is_file():
        return "node_modules is incomplete (missing next/dist/bin/next)"
    if platform == "nt" and not (modules / ".bin" / "next.cmd").is_file():
        return (
            "node_modules was not installed by npm on Windows "
            "(missing .bin/next.cmd)"
        )
    if platform == "posix" and (not next_shim.exists() or not next_shim.is_symlink()):
        return (
            "node_modules was not installed by npm on this POSIX runtime "
            "(.bin/next is not a symlink)"
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
    cli = viewer / "node_modules" / "next" / "dist" / "bin" / "next"
    result = subprocess.run(
        [node, str(cli), "--version"],
        cwd=viewer,
        capture_output=True,
        **text_subprocess_options(),
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        return f"Next CLI cannot run under the resolved Node runtime: {detail}"
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


def viewer_environment(runtime_root: Path) -> dict[str, str]:
    environment = os.environ.copy()
    environment["OXYGEN_VIEWER_STATE_DIR"] = str(runtime_root / "state")
    environment["NEXT_TELEMETRY_DISABLED"] = "1"
    return environment


def validate_viewer_state(runtime_root: Path) -> Path:
    """Return the SQLite path for a complete, readable Viewer state directory."""
    state_root = runtime_root / "state"
    database = state_root / "oxygen.sqlite"
    try:
        if not state_root.is_dir() or not database.is_file():
            raise OSError
        database_uri = f"{database.resolve(strict=True).as_uri()}?mode=ro"
        with closing(sqlite3.connect(database_uri, uri=True)) as connection:
            integrity = connection.execute("PRAGMA integrity_check").fetchall()
            workflow_rows = connection.execute(WORKFLOW_SESSION_QUERY).fetchmany(2)
        if integrity != [("ok",)]:
            raise sqlite3.DatabaseError
        if len(workflow_rows) != 1:
            raise sqlite3.DatabaseError
    except (OSError, ValueError, sqlite3.Error):
        raise SystemExit(VIEWER_STATE_INVALID) from None
    return database


def resolve_state_path(path: Path, error: str) -> Path:
    try:
        return path.expanduser().resolve()
    except (OSError, RuntimeError):
        raise SystemExit(error) from None


def _current_head() -> str:
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=KIT_ROOT,
        capture_output=True,
        **text_subprocess_options(),
    )
    head = result.stdout.strip()
    if result.returncode != 0 or re.fullmatch(r"[0-9a-f]{40}", head) is None:
        raise RuntimeError
    return head


def save_viewer_state(
    runtime_root: Path,
    destination: Path,
    workflow_run_id: str | None,
) -> Path:
    """Copy one stopped Viewer's complete state directory into a new local session."""
    validate_viewer_state(runtime_root)
    destination = resolve_state_path(destination, VIEWER_STATE_SAVE_FAILED)
    if destination.exists() or destination.is_symlink():
        raise SystemExit(VIEWER_STATE_EXISTS)

    created = False
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.mkdir()
        created = True
        saved_state = destination / "state"
        shutil.copytree(runtime_root / "state", saved_state, symlinks=True)
        validate_viewer_state(destination)
        locator = "\n".join((
            f"origin_worktree: {KIT_ROOT.resolve()}",
            f"origin_head: {_current_head()}",
            f"workflow_run_id: {workflow_run_id or 'unknown'}",
            f"saved_path: {destination}",
            "",
        ))
        (destination / "viewer-session.txt").write_text(locator, encoding="utf-8")
    except SystemExit:
        if created:
            shutil.rmtree(destination, ignore_errors=True)
        raise SystemExit(VIEWER_STATE_SAVE_FAILED) from None
    except (OSError, RuntimeError, shutil.Error, sqlite3.Error):
        if created:
            shutil.rmtree(destination, ignore_errors=True)
        raise SystemExit(VIEWER_STATE_SAVE_FAILED) from None

    print(f"Saved Viewer state: {destination}", flush=True)
    return destination


def stop_owned_viewer(
    process: OwnedProcess,
    port: int,
    *,
    runtime_root: Path,
    save_destination: Path | None = None,
    workflow_run_id: str | None = None,
    save_ready: bool = False,
    preserve_active_failure: bool = False,
) -> None:
    terminate_process_group(process)
    wait_for_port_release(port)
    if save_destination is not None and save_ready:
        try:
            save_viewer_state(runtime_root, save_destination, workflow_run_id)
        except (SystemExit, Exception):
            if not preserve_active_failure:
                raise SystemExit(VIEWER_STATE_SAVE_FAILED) from None
            print(f"Warning: {VIEWER_STATE_SAVE_FAILED}", file=sys.stderr, flush=True)


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
    try:
        with opener.open(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        status = error.code
        error.close()
        blocker = VIEWER_WORKFLOW_BLOCKERS.get(status)
        if blocker:
            raise SystemExit(blocker) from None
        if 500 <= status <= 599:
            raise SystemExit(
                f"VIEWER_SERVER_ERROR_HTTP_{status}: The local Viewer failed to process the request."
            ) from None
        raise SystemExit(
            f"VIEWER_HTTP_ERROR_{status}: The local Viewer request failed."
        ) from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise SystemExit(VIEWER_NETWORK_ERROR) from None
    except (UnicodeError, json.JSONDecodeError):
        raise SystemExit(VIEWER_RESPONSE_INVALID) from None


def resolve_contained_path(candidate: Path, approved_root: Path) -> Path:
    """Resolve one existing input and require its target to stay inside the run root."""
    resolved_root = approved_root.resolve(strict=True)
    resolved_candidate = candidate.resolve(strict=True)
    if not resolved_candidate.is_relative_to(resolved_root):
        raise ValueError("resolved path leaves approved run")
    return resolved_candidate


def event_content(event: dict, trajectory_dir: Path) -> str:
    try:
        return projected_event_content(event, trajectory_dir)
    except (OSError, ValueError) as error:
        raise SystemExit(f"artifact source is unavailable: {error}") from error


def trajectory_document(prepared: dict, project_map: dict) -> dict:
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
    items = []
    for index, event in enumerate(events, 1):
        event_id = projected_contribution_id(event)
        items.append({
            "id": event_id,
            "sequence": event.get("sequence", index),
            "eventType": event.get("event_type"),
            "actorId": (event.get("actor") or {}).get("id"),
            "actorType": (event.get("actor") or {}).get("type"),
            "timestamp": event.get("timestamp") or event.get("started_at"),
            "content": event_content(event, directory),
            "original": event,
        })
    return {"document": document, "items": items}


def meeting_document(prepared: dict) -> dict:
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
    record_identities = meeting_contribution_ids(meeting_id, records)
    for index, (record, contribution_id) in enumerate(zip(records, record_identities), 1):
        sequence = record.get("sequence_in_meeting")
        if sequence is None:
            sequence = record.get("order")
        if sequence is None:
            sequence = index
        items.append({
            "id": contribution_id,
            "sequence": sequence,
            "eventType": "record",
            "actorId": record.get("speaker"),
            "actorType": "human",
            "timestamp": record.get("timestamp") or record.get("started_at"),
            "content": record.get("text", ""),
            "original": record,
        })
    return {"document": document, "items": items}


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


def _has_path_entry(candidate: Path) -> bool:
    try:
        candidate.lstat()
        return True
    except FileNotFoundError:
        return False
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


def _is_path_alias(candidate: Path, metadata: os.stat_result) -> bool:
    if candidate.is_symlink():
        return True
    is_junction = getattr(os.path, "isjunction", None)
    if is_junction is not None and is_junction(candidate):
        return True
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(getattr(metadata, "st_file_attributes", 0) & reparse_flag)


def _canonical_meeting_member(
    candidate: Path,
    approved_run: Path,
    *,
    directory: bool,
) -> Path:
    """Require a physical, non-aliased member at this exact lexical path."""
    try:
        metadata = candidate.lstat()
    except (OSError, RuntimeError):
        raise SystemExit(INPUT_PATH_MISSING) from None
    if _is_path_alias(candidate, metadata):
        raise SystemExit(INPUT_PATH_ALIAS)

    located = _located_input(candidate, approved_run)
    literal = os.path.normcase(os.path.normpath(os.path.abspath(candidate)))
    physical = os.path.normcase(os.path.normpath(str(located)))
    if literal != physical:
        raise SystemExit(INPUT_PATH_ALIAS)
    if directory:
        if not stat.S_ISDIR(metadata.st_mode) or not located.is_dir():
            raise SystemExit(INPUT_PATH_MISSING)
    else:
        if (
            not stat.S_ISREG(metadata.st_mode)
            or not located.is_file()
            or metadata.st_nlink != 1
        ):
            raise SystemExit(INPUT_PATH_ALIAS if metadata.st_nlink != 1 else INPUT_PATH_MISSING)
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
    manifest_schema = manifest.get("schema")
    event_schema = {
        TRAJECTORY_SCHEMA: TRAJECTORY_EVENT_SCHEMA,
        AI_REVIEW_TRAJECTORY_SCHEMA: AI_REVIEW_EVENT_SCHEMA,
    }.get(manifest_schema)
    if event_schema is None or "schema_version" in manifest:
        raise SystemExit(INPUT_FILE_INVALID)
    if manifest.get("trajectory_id") is not None:
        _validated_trajectory_id(manifest["trajectory_id"])
    redaction = _read_json_object(redaction_path) if redaction_path else {
        "review_status": "pending", "publication_approved": False,
    }
    if redaction_path and (
        redaction.get("schema") != TRAJECTORY_REDACTION_SCHEMA
        or "schema_version" in redaction
    ):
        raise SystemExit(INPUT_FILE_INVALID)
    try:
        events = [
            json.loads(line)
            for line in events_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise SystemExit(INPUT_FILE_INVALID) from None
    if not all(
        isinstance(event, dict)
        and event.get("schema") == event_schema
        and "schema_version" not in event
        for event in events
    ):
        raise SystemExit(INPUT_FILE_INVALID)
    projection = manifest.get("contribution_projection")
    if not isinstance(projection, dict):
        raise SystemExit(INPUT_PROJECTION_INVALID)
    projected_digest = hashlib.sha256()
    for event in events:
        projected_digest.update(json.dumps(
            event, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8"))
        projected_digest.update(b"\n")
    raw_count = projection.get("raw_event_count")
    normalized_count = projection.get("normalized_event_count")
    kept_count = projection.get("kept_event_count")
    dropped_count = projection.get("dropped_event_count")
    replay_count = projection.get("cross_trajectory_semantic_replay_count")
    if (
        projection.get("policy_id") != HUMAN_SOURCE_POLICY_ID
        or not re.fullmatch(r"[0-9a-f]{64}", str(projection.get("raw_source_digest") or ""))
        or projection.get("projected_universe_digest") != projected_digest.hexdigest()
        or not isinstance(raw_count, int) or isinstance(raw_count, bool)
        or not all(isinstance(value, int) and not isinstance(value, bool) for value in (
            normalized_count, kept_count, dropped_count, replay_count,
        ))
        or kept_count != len(events)
        or raw_count - replay_count != normalized_count
        or normalized_count - kept_count != dropped_count
        or manifest.get("event_count") != len(events)
    ):
        raise SystemExit(INPUT_PROJECTION_INVALID)
    return {
        "directory": directory,
        "manifest": manifest,
        "redaction": redaction,
        "events": events,
    }


def _prepare_meeting(path: Path) -> dict:
    dataset = _read_json_object(path)
    if (
        dataset.get("schema") not in {MEETING_SCHEMA, AI_REVIEW_MEETING_SCHEMA}
        or "schema_version" in dataset
    ):
        raise SystemExit(INPUT_FILE_INVALID)
    records = dataset.get("records")
    if not isinstance(records, list) or not all(isinstance(record, dict) for record in records):
        raise SystemExit(INPUT_FILE_INVALID)
    literal_id = _validated_meeting_id(path.parent.name)
    payload_ids = [dataset[key] for key in ("meeting_id", "id") if key in dataset]
    if not payload_ids or any(value != literal_id for value in payload_ids):
        raise SystemExit(INPUT_MEETING_ID_INVALID)
    return {"path": path, "dataset": dataset, "meeting_id": literal_id}


def locate_inputs(run: Path):
    try:
        approved_run = run.resolve(strict=True)
    except (OSError, RuntimeError):
        raise SystemExit(INPUT_RUN_INVALID) from None
    if not approved_run.is_dir():
        raise SystemExit(INPUT_RUN_INVALID)

    root_meeting = approved_run / "meeting.json"
    if _has_path_entry(root_meeting):
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
        if (
            index.get("schema") not in {INGEST_RUN_SCHEMA, AI_REVIEW_RUN_SCHEMA}
            or "schema_version" in index
        ):
            raise SystemExit(INPUT_INDEX_INVALID)
        entries = index.get("trajectories") or []
        trajectory_failures = index.get("trajectory_failures", 0)
        if (
            not isinstance(entries, list)
            or not isinstance(trajectory_failures, int)
            or isinstance(trajectory_failures, bool)
            or trajectory_failures < 0
            or trajectory_failures != sum(
                1 for entry in entries
                if isinstance(entry, dict) and entry.get("ok", True) is False
            )
        ):
            raise SystemExit(INPUT_INDEX_INVALID)
        if trajectory_failures:
            raise SystemExit(INPUT_INDEX_INVALID)
        selected_entries = 0
        seen_ids = set()
        for entry in entries:
            if not isinstance(entry, dict) or ("ok" in entry and not isinstance(entry["ok"], bool)):
                raise SystemExit(INPUT_INDEX_INVALID)
            trajectory_id = entry.get("trajectory_id")
            trajectory_id = _validated_trajectory_id(trajectory_id)
            if trajectory_id in seen_ids:
                raise SystemExit(INPUT_INDEX_INVALID)
            seen_ids.add(trajectory_id)
            if entry.get("ok", True) is False:
                raise SystemExit(INPUT_INDEX_INVALID)
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
    meetings_candidate = approved_run / "meetings"
    if _has_path_entry(meetings_candidate):
        meetings_root = _canonical_meeting_member(
            meetings_candidate, approved_run, directory=True
        )
        try:
            entries = sorted(meetings_root.iterdir())
        except (OSError, RuntimeError):
            raise SystemExit(INPUT_PATH_MISSING) from None
        for entry in entries:
            _validated_meeting_id(entry.name)
            directory = _canonical_meeting_member(entry, approved_run, directory=True)
            meeting = _canonical_meeting_member(
                directory / "meeting.json", approved_run, directory=False
            )
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
    documents = [
        trajectory_document(prepared, project_map)
        for prepared in prepared_trajectories
    ] + [meeting_document(prepared) for prepared in prepared_meetings]
    document_count = len(documents)
    event_count = sum(len(entry["items"]) for entry in documents)
    finalized = request_json(
        opener,
        f"{base_url}/api/documents",
        method="POST",
        body={"documents": documents},
    )
    if (
        not isinstance(finalized, dict)
        or finalized.get("finalized") is not True
        or finalized.get("documentCount") != document_count
        or finalized.get("itemCount") != event_count
        or type(finalized.get("corpusRevision")) is not int
        or finalized["corpusRevision"] < 1
        or not isinstance(finalized.get("corpusDigest"), str)
        or re.fullmatch(r"[0-9a-f]{64}", finalized["corpusDigest"]) is None
    ):
        raise SystemExit("Viewer did not finalize the complete source corpus")
    return document_count, event_count


def finalized_semantic_manifest(run: Path) -> dict:
    approved_run = _located_input(run, run)
    project_map_path = _located_file(
        approved_run / "project-map.json", approved_run, required=True
    )
    assert project_map_path is not None
    project_map = _read_json_object(project_map_path)
    manifest = project_map.get("semantic_manifest")
    if not isinstance(manifest, dict):
        raise SystemExit(
            "project-map.json must contain a finalized semantic_manifest before Viewer import"
        )
    return manifest


def complete_organization(opener, base_url: str, semantic_manifest: dict) -> dict:
    return request_json(
        opener,
        f"{base_url}/api/organization",
        method="POST",
        body={"semanticManifest": semantic_manifest},
    )


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
    semantic_manifest = finalized_semantic_manifest(run)
    document_count, event_count = import_run(opener, base_url, run)
    organization = complete_organization(opener, base_url, semantic_manifest)
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

_DIGEST = re.compile(r"^[0-9a-f]{64}$")
_PREFERENCE_BUNDLE_FIELDS = {
    "workflowRunId", "sourceRevision", "inputDigest", "outputDigest", "outputCount",
    "setAside", "probes", "bulkDecisions", "autoRemoved",
}
_AUTO_REMOVED_FIELDS = {"total", "reversible", "categories"}
_AUTO_REMOVED_CATEGORY_FIELDS = {"kind", "count"}
_AUTO_REMOVED_KINDS = {
    "credential", "private-personal", "sensitive", "internal-metric",
    "internal-timeline", "mosaic-reidentification",
}
_PREPARATION_FIELDS = {
    "schema", "workflowRunId", "sourceRevision", "receipts", "storyPrivacyCandidates",
}
_RECEIPT_FIELDS = {
    "lane", "status", "inputDigest", "scopeDigest", "scopeCount", "outputDigest", "outputCount",
}
_PREPARATION_LANES = ("story", "insight", "story_privacy", "preference")


def _nonnegative_integer(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _digest(value: object) -> bool:
    return isinstance(value, str) and bool(_DIGEST.fullmatch(value))


def _valid_auto_removed(value: object) -> bool:
    if not isinstance(value, dict) or set(value) != _AUTO_REMOVED_FIELDS:
        return False
    total = value.get("total")
    categories = value.get("categories")
    if (
        not _nonnegative_integer(total)
        or value.get("reversible") is not True
        or not isinstance(categories, list)
    ):
        return False
    seen: set[str] = set()
    counted = 0
    for category in categories:
        if not isinstance(category, dict) or set(category) != _AUTO_REMOVED_CATEGORY_FIELDS:
            return False
        kind = category.get("kind")
        count = category.get("count")
        if (
            not isinstance(kind, str)
            or kind not in _AUTO_REMOVED_KINDS
            or kind in seen
            or not _nonnegative_integer(count)
        ):
            return False
        seen.add(kind)
        counted += count
    kinds = [category["kind"] for category in categories]
    return counted == total and kinds == sorted(kinds, key=lambda item: item.encode("utf-8"))


def validate_ready_authority(
    workflow_run_id: str,
    preference_bundle: object,
    preparation_manifest: object,
) -> tuple[dict, dict]:
    """Fail closed before transport unless the composed ready authority is exact."""
    if not isinstance(preference_bundle, dict) or set(preference_bundle) != _PREFERENCE_BUNDLE_FIELDS:
        raise SystemExit("Preference bundle authority is invalid")
    if (
        preference_bundle.get("workflowRunId") != workflow_run_id
        or not _nonnegative_integer(preference_bundle.get("sourceRevision"))
        or not _digest(preference_bundle.get("inputDigest"))
        or not _digest(preference_bundle.get("outputDigest"))
        or not _nonnegative_integer(preference_bundle.get("outputCount"))
        or not _nonnegative_integer(preference_bundle.get("setAside"))
        or not all(isinstance(preference_bundle.get(field), list) for field in ("probes", "bulkDecisions"))
        or not _valid_auto_removed(preference_bundle.get("autoRemoved"))
        or preference_bundle["outputCount"] != len(preference_bundle["probes"]) + len(preference_bundle["bulkDecisions"])
    ):
        raise SystemExit("Preference bundle authority is invalid")
    if not isinstance(preparation_manifest, dict) or set(preparation_manifest) != _PREPARATION_FIELDS:
        raise SystemExit("Story preparation authority is invalid")
    if (
        preparation_manifest.get("schema") != "oxygen.story-preparation"
        or preparation_manifest.get("workflowRunId") != workflow_run_id
        or preparation_manifest.get("sourceRevision") != preference_bundle["sourceRevision"]
        or not isinstance(preparation_manifest.get("storyPrivacyCandidates"), list)
        or not isinstance(preparation_manifest.get("receipts"), list)
        or len(preparation_manifest["receipts"]) != len(_PREPARATION_LANES)
    ):
        raise SystemExit("Story preparation authority is invalid")
    receipts = {}
    for receipt in preparation_manifest["receipts"]:
        if not isinstance(receipt, dict) or set(receipt) != _RECEIPT_FIELDS:
            raise SystemExit("Story preparation authority is invalid")
        lane = receipt.get("lane")
        if (
            lane not in _PREPARATION_LANES or lane in receipts or receipt.get("status") != "complete"
            or not _digest(receipt.get("inputDigest")) or not _digest(receipt.get("scopeDigest"))
            or not _digest(receipt.get("outputDigest")) or not _nonnegative_integer(receipt.get("scopeCount"))
            or not _nonnegative_integer(receipt.get("outputCount"))
        ):
            raise SystemExit("Story preparation authority is invalid")
        receipts[lane] = receipt
    preference_receipt = receipts.get("preference")
    if preference_receipt is None or any(
        preference_receipt[field] != preference_bundle[field]
        for field in ("inputDigest", "outputDigest", "outputCount")
    ):
        raise SystemExit("Preference receipt does not match the Preference bundle")
    return preference_bundle, preparation_manifest


def update_story_workflow(
    base_url: str,
    workflow_run_id: str,
    story_event: str,
    completed: int | None = None,
    total: int | None = None,
    coverage_manifest: dict | None = None,
    story_candidates: list[dict] | None = None,
    preference_bundle: dict | None = None,
    preparation_manifest: dict | None = None,
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
    if story_event == "ready":
        if not isinstance(coverage_manifest, dict):
            raise SystemExit("Story activation requires a normalized coverage manifest")
        if not isinstance(story_candidates, list) or not story_candidates:
            raise SystemExit("Story activation requires bounded Story candidates")
        preference_bundle, preparation_manifest = validate_ready_authority(
            workflow_run_id, preference_bundle, preparation_manifest
        )
        preference_result = request_json(
            opener, f"{base_url}/api/probes", method="POST", body=preference_bundle
        )
        if not isinstance(preference_result, dict):
            raise SystemExit("The Viewer did not import the exact Preference bundle")
        imported = preference_result.get("imported")
        bulk_imported = preference_result.get("bulkImported")
        if (
            not _nonnegative_integer(imported)
            or not _nonnegative_integer(bulk_imported)
            or imported != len(preference_bundle["probes"])
            or bulk_imported != len(preference_bundle["bulkDecisions"])
            or imported + bulk_imported != preference_bundle["outputCount"]
        ):
            raise SystemExit("The Viewer did not import the exact Preference bundle")
        payload["coverageManifest"] = coverage_manifest
        payload["storyCandidates"] = story_candidates
        payload["preparationManifest"] = preparation_manifest
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
    parser.add_argument("--coverage-manifest", type=Path)
    parser.add_argument("--story-candidates", type=Path)
    parser.add_argument("--preference-bundle", type=Path)
    parser.add_argument("--preparation-manifest", type=Path)
    parser.add_argument("--port", type=int)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--skip-install", action="store_true")
    state_mode = parser.add_mutually_exclusive_group()
    state_mode.add_argument(
        "--save-state", type=Path,
        help="save the stopped Viewer's complete state into a new local session directory",
    )
    state_mode.add_argument(
        "--resume-state", type=Path,
        help="launch the Viewer using an existing saved local session directory",
    )
    parser.add_argument("--smoke-test", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()

    if args.story_event:
        if (
            args.run or args.target or args.save_state or args.resume_state
            or not args.attach_url or not args.workflow_run_id
        ):
            parser.error("Story events require --attach-url and --workflow-run-id only")
        has_counts = args.story_completed is not None or args.story_total is not None
        if args.story_event == "progress":
            if args.story_completed is None or args.story_total is None:
                parser.error("Story progress requires --story-completed and --story-total")
            if not 0 <= args.story_completed <= args.story_total:
                parser.error("Story progress counts must satisfy 0 <= completed <= total")
        elif has_counts:
            parser.error("Story counts are accepted only with --story-event progress")
        if args.story_event == "ready" and (
            args.coverage_manifest is None or args.story_candidates is None
            or args.preference_bundle is None or args.preparation_manifest is None
        ):
            parser.error("Story ready requires coverage, candidates, Preference bundle, and preparation manifest")
        if args.story_event != "ready" and (
            args.coverage_manifest is not None or args.story_candidates is not None
            or args.preference_bundle is not None or args.preparation_manifest is not None
        ):
            parser.error(
                "ready authority files are accepted only with --story-event ready"
            )
        coverage_manifest = (
            _read_json_object(args.coverage_manifest.resolve(strict=True))
            if args.coverage_manifest is not None else None
        )
        story_candidates = None
        if args.story_candidates is not None:
            try:
                story_candidates = json.loads(
                    args.story_candidates.resolve(strict=True).read_text(encoding="utf-8")
                )
            except (OSError, UnicodeError, json.JSONDecodeError):
                raise SystemExit(INPUT_FILE_INVALID) from None
            if not isinstance(story_candidates, list):
                raise SystemExit(INPUT_FILE_INVALID)
        preference_bundle = (
            _read_json_object(args.preference_bundle.resolve(strict=True))
            if args.preference_bundle is not None else None
        )
        preparation_manifest = (
            _read_json_object(args.preparation_manifest.resolve(strict=True))
            if args.preparation_manifest is not None else None
        )
        if args.story_event == "ready":
            validate_ready_authority(args.workflow_run_id, preference_bundle, preparation_manifest)
        update_story_workflow(
            normalize_local_viewer_url(args.attach_url), args.workflow_run_id,
            args.story_event, args.story_completed, args.story_total, coverage_manifest,
            story_candidates, preference_bundle, preparation_manifest,
        )
        return

    if args.attach_url:
        if (
            not args.run or args.target or args.save_state or args.resume_state
            or not args.workflow_run_id
        ):
            parser.error("attach mode requires RUN, --attach-url, and --workflow-run-id only")
        run = args.run.expanduser().resolve()
        attach_run(normalize_local_viewer_url(args.attach_url), args.workflow_run_id, run)
        return

    if args.resume_state:
        if args.run or args.target or args.workflow_run_id:
            parser.error("resume mode requires --resume-state without RUN or --target")
    elif bool(args.run) == bool(args.target):
        parser.error("choose exactly one of RUN or --target")
    if args.port is not None and not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    if args.workflow_run_id and not args.target:
        parser.error("--workflow-run-id without --attach-url requires --target")

    run = args.run.expanduser().resolve() if args.run else None
    target = args.target.expanduser().resolve() if args.target else None
    save_destination = (
        resolve_state_path(args.save_state, VIEWER_STATE_SAVE_FAILED)
        if args.save_state else None
    )
    resume_session = (
        resolve_state_path(args.resume_state, VIEWER_STATE_INVALID)
        if args.resume_state else None
    )
    if save_destination is not None and (
        save_destination.exists() or save_destination.is_symlink()
    ):
        raise SystemExit(VIEWER_STATE_EXISTS)
    if resume_session is not None:
        validate_viewer_state(resume_session)
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

    runtime_context = (
        nullcontext(resume_session)
        if resume_session is not None
        else tempfile.TemporaryDirectory(prefix=f"oxygen-viewer-{port}-")
    )
    with runtime_context as runtime:
        runtime_root = Path(runtime)
        process = start_owned_process(
            viewer_command(port, npm),
            cwd=VIEWER,
            env=viewer_environment(runtime_root),
        )
        viewer_ready = False
        workflow_run_id = None
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
            viewer_ready = True

            if resume_session is not None:
                print(f"\nOxygen local review resumed: {base_url}", flush=True)
                print(f"Saved Viewer state: {resume_session}", flush=True)
                print("No collection or import was rerun.", flush=True)
                print("Changes remain in this saved local session. Press Ctrl+C to stop.\n", flush=True)
                if not args.no_browser:
                    webbrowser.open(base_url)
                if args.smoke_test:
                    opener = urllib.request.build_opener(
                        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
                    )
                    workflow = request_json(opener, f"{base_url}/api/workflow")
                    print(json.dumps({
                        "smoke_test": "passed", "resumed": True, "workflow": workflow,
                    }))
                    return
                return_code = wait_for_owned_exit(process)
                if return_code != 0:
                    raise SystemExit(f"Viewer exited unexpectedly with status {return_code}")
                return

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
                semantic_manifest = finalized_semantic_manifest(run)
                document_count, event_count = import_run(opener, base_url, run)
                organization = complete_organization(opener, base_url, semantic_manifest)
                print(f"\nOxygen local review: {base_url}", flush=True)
                print("No password is required for this localhost-only viewer", flush=True)
                print(
                    f"Imported: {document_count} trajectories/meetings, "
                    f"{event_count} events/records",
                    flush=True,
                )
                print("Nothing has been uploaded. Press Ctrl+C to stop.\n", flush=True)
                if args.smoke_test:
                    if event_count and organization["status"] != "complete":
                        raise SystemExit(f"Organizer did not complete: {organization}")
                    print(json.dumps({"smoke_test": "passed", "organization": organization}))
                    return
                if not args.no_browser:
                    webbrowser.open(base_url)

            return_code = wait_for_owned_exit(process)
            if return_code != 0:
                raise SystemExit(f"Viewer exited unexpectedly with status {return_code}")
        except KeyboardInterrupt:
            pass
        finally:
            stop_owned_viewer(
                process,
                port,
                runtime_root=runtime_root,
                save_destination=save_destination,
                workflow_run_id=workflow_run_id,
                save_ready=viewer_ready,
                preserve_active_failure=sys.exc_info()[0] is not None,
            )


if __name__ == "__main__":
    main()
