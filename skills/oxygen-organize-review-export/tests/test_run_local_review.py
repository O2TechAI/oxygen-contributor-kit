import importlib.util
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "run_local_review.py"
SPEC = importlib.util.spec_from_file_location("run_local_review", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class LauncherUnitTest(unittest.TestCase):
    def test_windows_npm_cmd_resolution_uses_actual_which_result(self):
        expected = r"C:\Program Files\nodejs\npm.cmd"
        resolved = MODULE.resolve_executable(
            "npm",
            platform="nt",
            which=lambda candidate: expected if candidate == "npm.cmd" else None,
        )
        self.assertEqual(resolved, expected)

    def test_windows_npx_cmd_resolution_uses_actual_which_result(self):
        expected = r"C:\Program Files\nodejs\npx.cmd"
        resolved = MODULE.resolve_executable(
            "npx",
            platform="nt",
            which=lambda candidate: expected if candidate == "npx.cmd" else None,
        )
        self.assertEqual(resolved, expected)

    def test_posix_npm_resolution_is_preserved(self):
        self.assertEqual(
            MODULE.resolve_executable(
                "npm", platform="posix", which=lambda candidate: "/usr/bin/npm"
                if candidate == "npm" else None,
            ),
            "/usr/bin/npm",
        )

    def test_missing_executable_is_reported_as_none(self):
        self.assertIsNone(MODULE.resolve_executable("npm", platform="nt", which=lambda _: None))

    def test_viewer_binds_requested_ipv4_port_without_bridge(self):
        command = MODULE.viewer_command(3240, "/linux/npm")
        self.assertEqual(command[0], "/linux/npm")
        self.assertEqual(command[-4:], ["--hostname", "127.0.0.1", "--port", "3240"])
        self.assertNotIn("socat", command)

    def test_port_in_use_fails_immediately_without_killing_owner(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as owner:
            owner.bind(("127.0.0.1", 0))
            port = owner.getsockname()[1]
            started = time.monotonic()
            with self.assertRaisesRegex(SystemExit, f"Port {port} is already in use"):
                MODULE.ensure_port_available(port)
            self.assertLess(time.monotonic() - started, 1)
            owner.listen(1)

    def test_os_selected_port_is_reserved_until_launcher_releases_it(self):
        reservation = MODULE.reserve_free_port()
        port = reservation.getsockname()[1]
        try:
            self.assertFalse(MODULE._port_available(port))
        finally:
            reservation.close()
        self.assertTrue(MODULE._port_available(port))

    def test_attach_url_is_strictly_local_and_origin_only(self):
        self.assertEqual(
            MODULE.normalize_local_viewer_url("http://127.0.0.1:3298/"),
            "http://127.0.0.1:3298",
        )
        for value in (
            "https://127.0.0.1:3298",
            "http://example.com:3298",
            "http://127.0.0.1:3298/api/workflow",
        ):
            with self.subTest(value=value), self.assertRaises(SystemExit):
                MODULE.normalize_local_viewer_url(value)

    def test_attach_verifies_stable_workflow_run_before_import(self):
        with (
            mock.patch.object(MODULE, "request_json", return_value={"workflowRunId": "run-1"}),
            mock.patch.object(MODULE, "import_run", return_value=(2, 9)) as imported,
            mock.patch.object(MODULE, "complete_organization", return_value={"status": "complete"}),
            mock.patch("builtins.print"),
        ):
            MODULE.attach_run("http://127.0.0.1:3298", "run-1", Path("reviewed run"))
        imported.assert_called_once()

    def test_attach_rejects_a_different_workflow_run(self):
        with (
            mock.patch.object(MODULE, "request_json", return_value={"workflowRunId": "other"}),
            mock.patch.object(MODULE, "import_run") as imported,
        ):
            with self.assertRaisesRegex(SystemExit, "does not own"):
                MODULE.attach_run("http://127.0.0.1:3298", "run-1", Path("reviewed run"))
        imported.assert_not_called()

    def test_story_progress_uses_only_sanitized_counts(self):
        with (
            mock.patch.object(MODULE, "request_json", return_value={
                "currentStageId": "story",
                "storyGenerationStatus": "running",
                "requiresHumanAction": False,
            }) as request,
            mock.patch("builtins.print"),
        ):
            MODULE.update_story_workflow(
                "http://127.0.0.1:3298", "run-1", "progress", 8, 14
            )
        request.assert_called_once_with(
            mock.ANY,
            "http://127.0.0.1:3298/api/workflow",
            method="POST",
            body={
                "workflowRunId": "run-1",
                "event": "story_generation_progress",
                "completed": 8,
                "total": 14,
            },
        )

    def test_story_ready_event_does_not_send_story_payload(self):
        with (
            mock.patch.object(MODULE, "request_json", return_value={
                "currentStageId": "review",
                "storyGenerationStatus": "ready_for_human_review",
                "requiresHumanAction": True,
            }) as request,
            mock.patch("builtins.print") as printed,
        ):
            result = MODULE.update_story_workflow(
                "http://127.0.0.1:3298", "run-1", "ready"
            )
        request.assert_called_once_with(
            mock.ANY,
            "http://127.0.0.1:3298/api/workflow",
            method="POST",
            body={
                "workflowRunId": "run-1",
                "event": "story_ready_for_human_review",
            },
        )
        self.assertEqual(result["viewer"], "http://127.0.0.1:3298")
        self.assertEqual(result["handoff_state"], "WAITING_FOR_HUMAN_STORY_REVIEW")
        self.assertFalse(result["password_required"])
        self.assertTrue(result["pause_for_human_review"])
        serialized = printed.call_args.args[0]
        self.assertNotIn("story_payload", serialized)
        self.assertNotIn("evidence_payload", serialized)

    def test_story_ready_requires_the_exact_persisted_human_boundary(self):
        with (
            mock.patch.object(MODULE, "request_json", return_value={
                "currentStageId": "story",
                "storyGenerationStatus": "running",
                "requiresHumanAction": False,
            }),
            mock.patch("builtins.print") as printed,
        ):
            with self.assertRaisesRegex(SystemExit, "human Story review boundary"):
                MODULE.update_story_workflow(
                    "http://127.0.0.1:3298", "run-1", "ready"
                )
        printed.assert_not_called()

    @unittest.skipUnless(os.name == "posix", "POSIX npm layout test")
    def test_incompatible_regular_file_shim_is_detected(self):
        with tempfile.TemporaryDirectory() as temporary:
            viewer = Path(temporary)
            cli = viewer / "node_modules" / "vinext" / "dist" / "cli.js"
            cli.parent.mkdir(parents=True)
            cli.write_text("", encoding="utf-8")
            bin_dir = viewer / "node_modules" / ".bin"
            bin_dir.mkdir(parents=True)
            (bin_dir / "vinext").write_text("#!/bin/sh\nexec node.exe\n", encoding="utf-8")
            self.assertIn("not a symlink", MODULE.node_modules_issue(viewer))

    @unittest.skipUnless(os.name == "posix", "POSIX npm layout test")
    def test_linux_symlink_layout_is_accepted(self):
        with tempfile.TemporaryDirectory() as temporary:
            viewer = Path(temporary)
            cli = viewer / "node_modules" / "vinext" / "dist" / "cli.js"
            cli.parent.mkdir(parents=True)
            cli.write_text("", encoding="utf-8")
            bin_dir = viewer / "node_modules" / ".bin"
            bin_dir.mkdir(parents=True)
            (bin_dir / "vinext").symlink_to("../vinext/dist/cli.js")
            self.assertIsNone(MODULE.node_modules_issue(viewer))

    def test_windows_cmd_layout_is_accepted(self):
        with tempfile.TemporaryDirectory(prefix="viewer layout ") as temporary:
            viewer = Path(temporary)
            cli = viewer / "node_modules" / "vinext" / "dist" / "cli.js"
            cli.parent.mkdir(parents=True)
            cli.write_text("", encoding="utf-8")
            bin_dir = viewer / "node_modules" / ".bin"
            bin_dir.mkdir(parents=True)
            (bin_dir / "vinext.cmd").write_text("@echo off\r\n", encoding="utf-8")
            self.assertIsNone(MODULE.node_modules_issue(viewer, platform="nt"))

    def test_windows_rejects_posix_only_node_modules(self):
        with tempfile.TemporaryDirectory(prefix="viewer layout ") as temporary:
            viewer = Path(temporary)
            cli = viewer / "node_modules" / "vinext" / "dist" / "cli.js"
            cli.parent.mkdir(parents=True)
            cli.write_text("", encoding="utf-8")
            bin_dir = viewer / "node_modules" / ".bin"
            bin_dir.mkdir(parents=True)
            (bin_dir / "vinext").write_text("#!/bin/sh\n", encoding="utf-8")
            self.assertIn("missing .bin/vinext.cmd", MODULE.node_modules_issue(viewer, platform="nt"))

    def test_lockfile_bootstrap_uses_npm_ci_and_preserves_lock(self):
        with tempfile.TemporaryDirectory(prefix="viewer bootstrap ") as temporary:
            viewer = Path(temporary)
            lockfile = viewer / "package-lock.json"
            lockfile.write_text('{"lockfileVersion":3}\n', encoding="utf-8")
            before = lockfile.read_bytes()
            with (
                mock.patch.object(MODULE, "validate_node_runtime", return_value=("node", r"C:\Program Files\nodejs\npm.cmd")),
                mock.patch.object(MODULE, "validate_viewer_cli", side_effect=["node_modules is absent", None]),
                mock.patch.object(MODULE.subprocess, "run") as run,
            ):
                npm = MODULE.ensure_dependencies(skip_install=False, viewer=viewer)
            self.assertEqual(npm, r"C:\Program Files\nodejs\npm.cmd")
            run.assert_called_once_with(
                [r"C:\Program Files\nodejs\npm.cmd", "ci", "--no-audit", "--no-fund"],
                cwd=viewer,
                check=True,
            )
            self.assertEqual(lockfile.read_bytes(), before)

    def test_runtime_environment_is_scoped_to_owned_root(self):
        root = Path("/tmp/oxygen-launch-test")
        environment = MODULE.viewer_environment(root)
        self.assertEqual(environment["OXYGEN_VIEWER_STATE_DIR"], str(root / "state"))
        self.assertEqual(environment["WRANGLER_LOG_PATH"], str(root / "wrangler.log"))
        self.assertEqual(environment["MINIFLARE_REGISTRY_PATH"], str(root / "registry"))
        self.assertEqual(environment["OXYGEN_VIEWER_HOST"], "127.0.0.1")

    def test_runtime_environment_carries_exact_requested_port(self):
        environment = MODULE.viewer_environment(Path("runtime root"), 3296)
        self.assertEqual(environment["OXYGEN_VIEWER_PORT"], "3296")

    @unittest.skipUnless(os.name == "posix", "POSIX process-group test")
    def test_cleanup_terminates_owned_process_group(self):
        process = subprocess.Popen(
            ["bash", "-c", "sleep 60 & wait"],
            start_new_session=True,
        )
        MODULE.terminate_process_group(process, timeout=2)
        self.assertIsNotNone(process.poll())
        with self.assertRaises(ProcessLookupError):
            os.killpg(process.pid, signal.SIGCONT)

    @unittest.skipUnless(os.name == "nt", "Windows Job Object integration test")
    def test_windows_gate_assigns_before_immediate_child_and_cleans_tree(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        before_temp_roots = set(Path(tempfile.gettempdir()).glob("oxygen-viewer-*"))
        with tempfile.TemporaryDirectory(prefix="immediate child ") as temporary:
            marker = Path(temporary) / "real-command-started.txt"
            child_code = (
                "import socket,time; "
                "s=socket.socket(); s.bind(('127.0.0.1', %d)); s.listen(); time.sleep(60)" % port
            )
            root_code = (
                "import pathlib,subprocess,sys; "
                f"pathlib.Path({str(marker)!r}).write_text('started',encoding='utf-8'); "
                f"child=subprocess.Popen([sys.executable, '-c', {child_code!r}]); child.wait()"
            )
            assignment_observations = []

            class TrackingJob:
                def __init__(self):
                    self.inner = MODULE.WindowsJob()
                    self.closed = False

                def assign(self, process):
                    assignment_observations.append(marker.exists())
                    self.inner.assign(process)

                def terminate(self):
                    self.inner.terminate()

                def close(self):
                    self.inner.close()
                    self.closed = True

            job = TrackingJob()
            gate = MODULE.WindowsLaunchGate()
            owned = None
            try:
                owned = MODULE.start_owned_process(
                    [sys.executable, "-c", root_code],
                    cwd=Path.cwd(),
                    env=os.environ.copy(),
                    _windows_job_factory_for_test=lambda: job,
                    _windows_gate_factory_for_test=lambda: gate,
                )
                self.assertEqual(assignment_observations, [False])
                self.assertIsNone(gate.handle)
                deadline = time.monotonic() + 8
                while time.monotonic() < deadline and MODULE._port_available(port):
                    time.sleep(0.05)
                self.assertTrue(marker.is_file(), "real command never started after Job assignment")
                self.assertFalse(
                    MODULE._port_available(port), "synthetic immediate child listener never started"
                )
            finally:
                if owned is not None:
                    MODULE.terminate_process_group(owned, timeout=3)
            MODULE.wait_for_port_release(port, timeout=3)
            self.assertIsNotNone(owned.poll())
            self.assertTrue(job.closed)
        self.assertEqual(
            set(Path(tempfile.gettempdir()).glob("oxygen-viewer-*")), before_temp_roots
        )

    @unittest.skipUnless(os.name == "nt", "Windows Job Object integration test")
    def test_windows_assignment_failure_never_releases_real_command(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        before_temp_roots = set(Path(tempfile.gettempdir()).glob("oxygen-viewer-*"))
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as unrelated_owner:
            unrelated_owner.bind(("127.0.0.1", 0))
            unrelated_owner.listen(1)
            unrelated_port = unrelated_owner.getsockname()[1]
            with tempfile.TemporaryDirectory(prefix="assignment failure ") as temporary:
                marker = Path(temporary) / "must-not-start.txt"
                real_code = (
                    "import pathlib,socket,time; "
                    f"pathlib.Path({str(marker)!r}).write_text('started',encoding='utf-8'); "
                    f"s=socket.socket(); s.bind(('127.0.0.1',{port})); s.listen(); time.sleep(60)"
                )

                class FailingJob:
                    def __init__(self):
                        self.process = None
                        self.close_calls = 0
                        self.terminate_calls = 0

                    def assign(self, process):
                        self.process = process
                        raise OSError("synthetic assignment failure")

                    def terminate(self):
                        self.terminate_calls += 1

                    def close(self):
                        self.close_calls += 1

                class TrackingGate(MODULE.WindowsLaunchGate):
                    def __init__(self):
                        super().__init__()
                        self.close_calls = 0

                    def close(self):
                        if self.handle:
                            self.close_calls += 1
                        super().close()

                job = FailingJob()
                gate = TrackingGate()
                with self.assertRaisesRegex(
                    SystemExit, "Cannot establish Windows Viewer process-tree ownership"
                ):
                    MODULE.start_owned_process(
                        [sys.executable, "-c", real_code],
                        cwd=Path.cwd(),
                        env=os.environ.copy(),
                        _windows_job_factory_for_test=lambda: job,
                        _windows_gate_factory_for_test=lambda: gate,
                    )
                self.assertIsNotNone(job.process)
                self.assertIsNotNone(job.process.poll())
                self.assertEqual(job.close_calls, 1)
                self.assertEqual(job.terminate_calls, 0)
                self.assertEqual(gate.close_calls, 1)
                self.assertIsNone(gate.handle)
                self.assertFalse(marker.exists())
                self.assertTrue(MODULE._port_available(port))
                self.assertFalse(MODULE._port_available(unrelated_port))
        self.assertEqual(
            set(Path(tempfile.gettempdir()).glob("oxygen-viewer-*")), before_temp_roots
        )

    @unittest.skipUnless(os.name == "nt", "Windows Job Object integration test")
    def test_windows_gate_preserves_normal_exit_status(self):
        gate = MODULE.WindowsLaunchGate()
        owned = MODULE.start_owned_process(
            [sys.executable, "-c", "raise SystemExit(7)"],
            cwd=Path.cwd(),
            env=os.environ.copy(),
            _windows_gate_factory_for_test=lambda: gate,
        )
        try:
            self.assertEqual(owned.wait(timeout=5), 7)
            self.assertIsNone(gate.handle)
        finally:
            MODULE.terminate_process_group(owned, timeout=3)

    @unittest.skipUnless(os.name == "nt", "Windows console control-event integration test")
    def test_windows_ctrl_c_runs_owned_cleanup_and_finally(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        with tempfile.TemporaryDirectory(prefix="ctrl c harness ") as temporary:
            marker = Path(temporary) / "cleaned.txt"
            child_code = (
                "import socket,time; "
                "s=socket.socket(); s.bind(('127.0.0.1', %d)); s.listen(); time.sleep(60)" % port
            )
            harness = (
                "import importlib.util,os,pathlib,sys,time; "
                f"spec=importlib.util.spec_from_file_location('launcher', {str(MODULE_PATH)!r}); "
                "module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); "
                "module.install_signal_handlers(); "
                f"owned=module.start_owned_process([sys.executable,'-c',{child_code!r}],cwd=pathlib.Path.cwd(),env=os.environ.copy()); "
                "print('READY',flush=True); "
                "\ntry:\n module.wait_for_owned_exit(owned)\n"
                "except KeyboardInterrupt:\n pass\n"
                "finally:\n"
                " module.terminate_process_group(owned,timeout=3)\n"
                f" pathlib.Path({str(marker)!r}).write_text('cleaned',encoding='utf-8')\n"
            )
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = subprocess.SW_HIDE
            process = subprocess.Popen(
                [sys.executable, "-c", harness],
                cwd=Path.cwd(),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="strict",
                creationflags=subprocess.CREATE_NEW_CONSOLE,
                startupinfo=startupinfo,
            )
            try:
                self.assertEqual(process.stdout.readline().strip(), "READY")
                deadline = time.monotonic() + 8
                while time.monotonic() < deadline and MODULE._port_available(port):
                    time.sleep(0.1)
                self.assertFalse(MODULE._port_available(port))
                sender = (
                    "import ctypes,sys,time; "
                    "kernel32=ctypes.WinDLL('kernel32',use_last_error=True); "
                    "kernel32.FreeConsole(); "
                    "ok=kernel32.AttachConsole(int(sys.argv[1])); "
                    "ok or (_ for _ in ()).throw(ctypes.WinError(ctypes.get_last_error())); "
                    "kernel32.SetConsoleCtrlHandler(None,True); "
                    "ok=kernel32.GenerateConsoleCtrlEvent(0,0); "
                    "ok or (_ for _ in ()).throw(ctypes.WinError(ctypes.get_last_error())); "
                    "time.sleep(0.5)"
                )
                sent = subprocess.run(
                    [sys.executable, "-c", sender, str(process.pid)],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="strict",
                    timeout=5,
                )
                status_control_c_exit = 0xC000013A
                self.assertIn(sent.returncode, {0, status_control_c_exit}, sent.stderr)
                process.wait(timeout=10)
                self.assertEqual(process.returncode, 0)
                MODULE.wait_for_port_release(port, timeout=3)
                self.assertEqual(marker.read_text(encoding="utf-8"), "cleaned")
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=3)
                if process.stdout:
                    process.stdout.close()
                if process.stderr:
                    process.stderr.close()


if __name__ == "__main__":
    unittest.main()
