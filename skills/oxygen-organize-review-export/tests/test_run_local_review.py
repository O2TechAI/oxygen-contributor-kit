import importlib.util
import hashlib
import json
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
KIT_ROOT = MODULE_PATH.parents[3]
IMPORT_MEETING = KIT_ROOT / "tools" / "ingest" / "import_meeting.py"
SPEC = importlib.util.spec_from_file_location("run_local_review", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def write_trajectory(run: Path, trajectory_id: str) -> Path:
    directory = run / "trajectories" / trajectory_id
    directory.mkdir(parents=True)
    item = {
        "event_id": f"evt-{hashlib.sha256(trajectory_id.encode('utf-8')).hexdigest()}",
        "trajectory_id": trajectory_id,
        "event_type": "message",
        "actor": {"id": "person-safe", "type": "human"},
        "payload": {"role": "user", "text": "safe synthetic contribution"},
    }
    serialized = json.dumps(
        item, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ) + "\n"
    projected_digest = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
    (directory / "manifest.json").write_text(
        json.dumps({
            "trajectory_id": trajectory_id,
            "event_count": 1,
            "contribution_projection": {
                "policy_id": MODULE.HUMAN_SOURCE_POLICY_ID,
                "raw_source_digest": "a" * 64,
                "projected_universe_digest": projected_digest,
                "raw_event_count": 2,
                "normalized_event_count": 2,
                "kept_event_count": 1,
                "dropped_event_count": 1,
                "cross_trajectory_semantic_replay_count": 0,
            },
        }), encoding="utf-8"
    )
    (directory / "events.jsonl").write_text(serialized, encoding="utf-8")
    return directory


def write_index(run: Path, entries: list[dict]) -> None:
    run.mkdir(parents=True, exist_ok=True)
    (run / "index.json").write_text(
        json.dumps({"trajectories": entries}, ensure_ascii=False), encoding="utf-8"
    )


def write_meeting(run: Path, meeting_id: str, *, root=False, directory_id=None) -> Path:
    directory = run if root else run / "meetings" / (directory_id or meeting_id)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "meeting.json"
    path.write_text(json.dumps({
        "meeting_id": meeting_id,
        "title": meeting_id,
        "records": [{"record_id": "rec-00001", "order": 1, "text": "safe synthetic text"}],
    }), encoding="utf-8")
    return path


def finalized_response(document_count: int, item_count: int) -> dict:
    return {
        "finalized": True,
        "corpusRevision": 1,
        "corpusDigest": "a" * 64,
        "documentCount": document_count,
        "itemCount": item_count,
    }


def symlink_or_skip(test_case: unittest.TestCase, link: Path, target: Path, *, directory=False):
    try:
        link.symlink_to(target, target_is_directory=directory)
    except OSError as error:
        test_case.skipTest(f"symlink creation is unavailable: {error.__class__.__name__}")


def directory_link_or_skip(test_case: unittest.TestCase, link: Path, target: Path):
    try:
        link.symlink_to(target, target_is_directory=True)
        return
    except OSError:
        pass
    if os.name == "nt":
        result = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(link), str(target)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=subprocess.CREATE_NO_WINDOW,
            check=False,
        )
        if result.returncode == 0:
            return
    test_case.skipTest("directory link creation is unavailable")


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

    def test_node_preflight_rejects_a_runtime_below_the_viewer_minimum(self):
        with tempfile.TemporaryDirectory() as temporary:
            viewer = Path(temporary)
            (viewer / "package.json").write_text(
                '{"engines":{"node":">=22.15.0"}}', encoding="utf-8"
            )
            with (
                mock.patch.object(MODULE, "resolve_executable", side_effect=["/opt/node/bin/node", "/opt/node/bin/npm"]),
                mock.patch.object(MODULE, "command_version", side_effect=["v22.14.0", "10.9.0"]),
            ):
                with self.assertRaisesRegex(SystemExit, r"Viewer requires Node >= 22\.15\.0; resolved v22\.14\.0"):
                    MODULE.validate_node_runtime(viewer)

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
            mock.patch.object(MODULE, "finalized_semantic_manifest", return_value={"revision": 1}),
            mock.patch.object(MODULE, "import_run", return_value=(2, 9)) as imported,
            mock.patch.object(MODULE, "complete_organization", return_value={"status": "complete"}),
            mock.patch("builtins.print"),
        ):
            MODULE.attach_run("http://127.0.0.1:3298", "run-1", Path("reviewed run"))
        imported.assert_called_once()

    def test_attach_never_organizes_after_failed_corpus_finalization(self):
        with (
            mock.patch.object(MODULE, "request_json", return_value={"workflowRunId": "run-1"}),
            mock.patch.object(MODULE, "finalized_semantic_manifest", return_value={"revision": 1}),
            mock.patch.object(
                MODULE,
                "import_run",
                side_effect=SystemExit("Viewer did not finalize the complete source corpus"),
            ),
            mock.patch.object(MODULE, "complete_organization") as organization,
        ):
            with self.assertRaisesRegex(SystemExit, "did not finalize"):
                MODULE.attach_run("http://127.0.0.1:3298", "run-1", Path("reviewed run"))
        organization.assert_not_called()

    def test_trajectory_requires_current_projection_provenance_before_import(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            trajectory = write_trajectory(run, "traj-safe")
            manifest_path = trajectory / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest.pop("contribution_projection")
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(SystemExit, MODULE.INPUT_PROJECTION_INVALID):
                MODULE._prepare_trajectory(trajectory, run)

            trajectory = write_trajectory(run, "traj-stale")
            (trajectory / "events.jsonl").write_text(
                '{"event_id":"changed","event_type":"message"}\n', encoding="utf-8"
            )
            with self.assertRaisesRegex(SystemExit, MODULE.INPUT_PROJECTION_INVALID):
                MODULE._prepare_trajectory(trajectory, run)

            trajectory = write_trajectory(run, "traj-wrong-policy")
            manifest_path = trajectory / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["contribution_projection"]["policy_id"] = "obsolete-policy"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(SystemExit, MODULE.INPUT_PROJECTION_INVALID):
                MODULE._prepare_trajectory(trajectory, run)

    def test_organization_posts_one_finalized_semantic_manifest(self):
        semantic_manifest = {"revision": 1, "manifestDigest": "a" * 64}
        with mock.patch.object(
            MODULE, "request_json", return_value={"status": "complete"}
        ) as request:
            result = MODULE.complete_organization(
                mock.sentinel.opener, "http://127.0.0.1:3298", semantic_manifest
            )
        self.assertEqual(result, {"status": "complete"})
        request.assert_called_once_with(
            mock.sentinel.opener,
            "http://127.0.0.1:3298/api/organization",
            method="POST",
            body={"semanticManifest": semantic_manifest},
        )

    def test_establishment_uses_target_confirmation_and_exact_identity(self):
        with mock.patch.object(
            MODULE, "request_json", return_value={"workflowRunId": "run-1"}
        ) as request:
            established = MODULE.establish_workflow_run(
                mock.sentinel.opener, "http://127.0.0.1:3298", "run-1"
            )
        self.assertEqual(established, "run-1")
        request.assert_called_once_with(
            mock.sentinel.opener,
            "http://127.0.0.1:3298/api/workflow",
            method="POST",
            body={"workflowRunId": "run-1", "event": "target_confirmed"},
        )

    def test_establishment_rejects_a_substituted_workflow_run(self):
        with mock.patch.object(
            MODULE, "request_json", return_value={"workflowRunId": "other"}
        ):
            with self.assertRaisesRegex(SystemExit, "did not establish"):
                MODULE.establish_workflow_run(
                    mock.sentinel.opener, "http://127.0.0.1:3298", "run-1"
                )

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

    def test_story_ready_event_sends_only_bounded_coverage_authority(self):
        coverage_manifest = {"revision": 1, "coverageDigest": "a" * 64}
        story_candidates = [{"id": "doc:item-1", "summary": "oxygen.story:{}"}]
        with (
            mock.patch.object(MODULE, "request_json", return_value={
                "currentStageId": "review",
                "storyGenerationStatus": "ready_for_human_review",
                "requiresHumanAction": True,
            }) as request,
            mock.patch("builtins.print") as printed,
        ):
            result = MODULE.update_story_workflow(
                "http://127.0.0.1:3298", "run-1", "ready",
                coverage_manifest=coverage_manifest,
                story_candidates=story_candidates,
            )
        request.assert_called_once_with(
            mock.ANY,
            "http://127.0.0.1:3298/api/workflow",
            method="POST",
            body={
                "workflowRunId": "run-1",
                "event": "story_ready_for_human_review",
                "coverageManifest": coverage_manifest,
                "storyCandidates": story_candidates,
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
                    "http://127.0.0.1:3298", "run-1", "ready",
                    coverage_manifest={"revision": 1},
                    story_candidates=[{"id": "doc:item-1", "summary": "oxygen.story:{}"}],
                )
        printed.assert_not_called()

    def test_cli_accepts_documented_story_started_command(self):
        with (
            mock.patch.object(sys, "argv", [
                "run_local_review.py",
                "--attach-url", "http://127.0.0.1:3298",
                "--workflow-run-id", "run-1",
                "--story-event", "started",
            ]),
            mock.patch.object(MODULE, "update_story_workflow") as update,
        ):
            MODULE.main()
        update.assert_called_once_with(
            "http://127.0.0.1:3298", "run-1", "started", None, None, None, None
        )

    def test_cli_accepts_documented_story_progress_command(self):
        with (
            mock.patch.object(sys, "argv", [
                "run_local_review.py",
                "--attach-url", "http://127.0.0.1:3298",
                "--workflow-run-id", "run-1",
                "--story-event", "progress",
                "--story-completed", "4",
                "--story-total", "4",
            ]),
            mock.patch.object(MODULE, "update_story_workflow") as update,
        ):
            MODULE.main()
        update.assert_called_once_with(
            "http://127.0.0.1:3298", "run-1", "progress", 4, 4, None, None
        )

    def test_cli_accepts_documented_story_ready_command_and_loads_payloads(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            coverage_manifest = {
                "revision": 1,
                "semanticManifestRevision": 1,
                "semanticManifestDigest": "a" * 64,
                "coverageDigest": "b" * 64,
                "rows": [],
            }
            story_candidates = [{"id": "doc:item-1", "summary": "oxygen.story:{}"}]
            coverage_path = root / "story-coverage-manifest.json"
            candidates_path = root / "story-candidates.json"
            coverage_path.write_text(json.dumps(coverage_manifest), encoding="utf-8")
            candidates_path.write_text(json.dumps(story_candidates), encoding="utf-8")

            with (
                mock.patch.object(sys, "argv", [
                    "run_local_review.py",
                    "--attach-url", "http://127.0.0.1:3298",
                    "--workflow-run-id", "run-1",
                    "--story-event", "ready",
                    "--coverage-manifest", str(coverage_path),
                    "--story-candidates", str(candidates_path),
                ]),
                mock.patch.object(MODULE, "update_story_workflow") as update,
            ):
                MODULE.main()
        update.assert_called_once_with(
            "http://127.0.0.1:3298", "run-1", "ready", None, None,
            coverage_manifest, story_candidates,
        )

    @unittest.skipUnless(os.name == "posix", "POSIX npm layout test")
    def test_posix_regular_next_shim_is_detected(self):
        with tempfile.TemporaryDirectory() as temporary:
            viewer = Path(temporary)
            cli = viewer / "node_modules" / "next" / "dist" / "bin" / "next"
            cli.parent.mkdir(parents=True)
            cli.write_text("", encoding="utf-8")
            bin_dir = viewer / "node_modules" / ".bin"
            bin_dir.mkdir(parents=True)
            (bin_dir / "next").write_text("#!/bin/sh\nexec node.exe\n", encoding="utf-8")
            self.assertIn(".bin/next is not a symlink", MODULE.node_modules_issue(viewer))

    @unittest.skipUnless(os.name == "posix", "POSIX npm layout test")
    def test_posix_next_symlink_layout_is_accepted(self):
        with tempfile.TemporaryDirectory() as temporary:
            viewer = Path(temporary)
            cli = viewer / "node_modules" / "next" / "dist" / "bin" / "next"
            cli.parent.mkdir(parents=True)
            cli.write_text("", encoding="utf-8")
            bin_dir = viewer / "node_modules" / ".bin"
            bin_dir.mkdir(parents=True)
            (bin_dir / "next").symlink_to("../next/dist/bin/next")
            self.assertIsNone(MODULE.node_modules_issue(viewer))

    def test_windows_cmd_layout_is_accepted(self):
        with tempfile.TemporaryDirectory(prefix="viewer layout ") as temporary:
            viewer = Path(temporary)
            cli = viewer / "node_modules" / "next" / "dist" / "bin" / "next"
            cli.parent.mkdir(parents=True)
            cli.write_text("", encoding="utf-8")
            bin_dir = viewer / "node_modules" / ".bin"
            bin_dir.mkdir(parents=True)
            (bin_dir / "next.cmd").write_text("@echo off\r\n", encoding="utf-8")
            self.assertIsNone(MODULE.node_modules_issue(viewer, platform="nt"))

    def test_windows_rejects_posix_only_node_modules(self):
        with tempfile.TemporaryDirectory(prefix="viewer layout ") as temporary:
            viewer = Path(temporary)
            cli = viewer / "node_modules" / "next" / "dist" / "bin" / "next"
            cli.parent.mkdir(parents=True)
            cli.write_text("", encoding="utf-8")
            bin_dir = viewer / "node_modules" / ".bin"
            bin_dir.mkdir(parents=True)
            (bin_dir / "next").write_text("#!/bin/sh\n", encoding="utf-8")
            self.assertIn("missing .bin/next.cmd", MODULE.node_modules_issue(viewer, platform="nt"))

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
        with mock.patch.dict(os.environ, {}, clear=True):
            environment = MODULE.viewer_environment(root)
        self.assertEqual(
            environment,
            {
                "OXYGEN_VIEWER_STATE_DIR": str(root / "state"),
                "NEXT_TELEMETRY_DISABLED": "1",
            },
        )

    def test_separate_runtime_roots_own_separate_state_directories(self):
        first = MODULE.viewer_environment(Path("runtime-a"))
        second = MODULE.viewer_environment(Path("runtime-b"))
        self.assertNotEqual(
            first["OXYGEN_VIEWER_STATE_DIR"], second["OXYGEN_VIEWER_STATE_DIR"]
        )

    def test_runtime_environment_does_not_carry_viewer_endpoint(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            environment = MODULE.viewer_environment(Path("runtime root"))
        self.assertNotIn("OXYGEN_VIEWER_HOST", environment)
        self.assertNotIn("OXYGEN_VIEWER_PORT", environment)

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


class LocateInputsContainmentTest(unittest.TestCase):
    def assert_import_fails_before_request(self, run: Path, code: str) -> None:
        with mock.patch.object(MODULE, "request_json") as request:
            with self.assertRaisesRegex(SystemExit, f"^{code}$"):
                MODULE.import_run(mock.sentinel.opener, "http://127.0.0.1:3298", run)
        request.assert_not_called()

    def test_normal_trajectory_id_and_valid_multi_trajectory_run(self):
        with tempfile.TemporaryDirectory(prefix="review run 测试 ") as temporary:
            run = Path(temporary, "reviewed run")
            first = write_trajectory(run, "traj-alpha")
            second = write_trajectory(run, "traj-beta")
            write_index(run, [
                {"trajectory_id": "traj-alpha", "ok": True},
                {"trajectory_id": "traj-beta", "ok": True},
            ])
            event_ids = [
                f"evt-{hashlib.sha256(trajectory_id.encode('utf-8')).hexdigest()}"
                for trajectory_id in ("traj-alpha", "traj-beta")
            ]
            (run / "project-map.json").write_text(json.dumps({
                "events": {
                    event_id: {
                        "project": "Synthetic Project",
                        "confidence": 90,
                        "summary": "Synthetic unit",
                    }
                    for event_id in event_ids
                }
            }), encoding="utf-8")

            trajectories, meetings = MODULE.locate_inputs(run)

            self.assertEqual(trajectories, [first.resolve(), second.resolve()])
            self.assertEqual(meetings, [])
            with mock.patch.object(
                MODULE, "request_json", return_value=finalized_response(2, 2)
            ) as request:
                self.assertEqual(
                    MODULE.import_run(
                        mock.sentinel.opener, "http://127.0.0.1:3298", run
                    ),
                    (2, 2),
                )
            request.assert_called_once()
            documents = request.call_args.kwargs["body"]["documents"]
            self.assertEqual(len(documents), 2)
            for entry in documents:
                document_id = entry["document"]["id"]
                self.assertTrue(all(
                    item["original"]["trajectory_id"] == document_id
                    for item in entry["items"]
                ))
                self.assertTrue(all(
                    {
                        "organizationCategory",
                        "organizationConfidence",
                        "organizationReason",
                    }.isdisjoint(item)
                    for item in entry["items"]
                ))

    def test_failed_collector_index_is_never_attached_as_an_exhaustive_run(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary, "run")
            write_trajectory(run, "traj-alpha")
            run.mkdir(parents=True, exist_ok=True)
            (run / "index.json").write_text(json.dumps({
                "trajectory_failures": 1,
                "trajectories": [{"trajectory_id": "traj-alpha", "ok": False}],
            }), encoding="utf-8")
            self.assert_import_fails_before_request(run, MODULE.INPUT_INDEX_INVALID)

    def test_multi_meeting_cli_preserves_document_ids_and_qualified_records(self):
        with tempfile.TemporaryDirectory(prefix="multi meeting ") as temporary:
            root = Path(temporary)
            first = root / "alpha.txt"
            second = root / "beta.txt"
            first.write_text("Alpha synthetic record\n", encoding="utf-8")
            second.write_text("Beta synthetic record\n", encoding="utf-8")
            run = root / "run"

            result = subprocess.run(
                [sys.executable, str(IMPORT_MEETING), str(first), str(second),
                 "--out", str(run), "--date", "2026-08-25", "--no-publish"],
                cwd=KIT_ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="strict",
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

            trajectories, meetings = MODULE.locate_inputs(run)
            self.assertEqual(trajectories, [])
            self.assertEqual(len(meetings), 2)
            meeting_ids = {
                json.loads(path.read_text(encoding="utf-8"))["meeting_id"]
                for path in meetings
            }
            self.assertEqual(len(meeting_ids), 2)

            with mock.patch.object(
                MODULE, "request_json", return_value=finalized_response(2, 2)
            ) as request:
                self.assertEqual(
                    MODULE.import_run(
                        mock.sentinel.opener, "http://127.0.0.1:3298", run
                    ),
                    (2, 2),
                )
            request.assert_called_once()
            imported = request.call_args.kwargs["body"]["documents"]
            self.assertEqual({body["document"]["id"] for body in imported}, meeting_ids)
            for body in imported:
                document_id = body["document"]["id"]
                self.assertTrue(all(
                    item["id"].startswith(f"{document_id}:") for item in body["items"]
                ))

    def test_single_root_meeting_remains_compatible(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary, "run")
            meeting = write_meeting(run, "meeting-legacy", root=True)

            trajectories, meetings = MODULE.locate_inputs(run)

            self.assertEqual(trajectories, [])
            self.assertEqual(meetings, [meeting.resolve()])
            with mock.patch.object(
                MODULE, "request_json", return_value=finalized_response(1, 1)
            ) as request:
                self.assertEqual(
                    MODULE.import_run(
                        mock.sentinel.opener, "http://127.0.0.1:3298", run
                    ),
                    (1, 1),
                )
            request.assert_called_once()

    def test_multiple_trajectories_and_meetings_share_one_run(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary, "run")
            write_trajectory(run, "traj-alpha")
            write_trajectory(run, "traj-beta")
            write_index(run, [
                {"trajectory_id": "traj-alpha", "ok": True},
                {"trajectory_id": "traj-beta", "ok": True},
            ])
            write_meeting(run, "meeting-alpha")
            write_meeting(run, "meeting-beta")

            with mock.patch.object(
                MODULE, "request_json", return_value=finalized_response(4, 4)
            ) as request:
                self.assertEqual(
                    MODULE.import_run(
                        mock.sentinel.opener, "http://127.0.0.1:3298", run
                    ),
                    (4, 4),
                )
            request.assert_called_once()
            self.assertEqual(len(request.call_args.kwargs["body"]["documents"]), 4)

    def test_incomplete_corpus_acknowledgement_fails_the_whole_import(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary, "run")
            write_trajectory(run, "traj-alpha")
            write_index(run, [{"trajectory_id": "traj-alpha", "ok": True}])
            incomplete = finalized_response(1, 1)
            incomplete["itemCount"] = 0
            with mock.patch.object(
                MODULE, "request_json", return_value=incomplete
            ) as request:
                with self.assertRaisesRegex(SystemExit, "did not finalize"):
                    MODULE.import_run(
                        mock.sentinel.opener, "http://127.0.0.1:3298", run
                    )
            request.assert_called_once()

    def test_duplicate_meeting_ids_fail_before_any_viewer_request(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary, "run")
            write_meeting(run, "meeting-duplicate", directory_id="meeting-alpha")
            write_meeting(run, "meeting-duplicate", directory_id="meeting-beta")

            self.assert_import_fails_before_request(
                run, MODULE.INPUT_MEETING_ID_DUPLICATE
            )

    def test_unsupported_and_malformed_meeting_entries_fail_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary, "run")
            (run / "meetings").mkdir(parents=True)
            (run / "meetings" / "unexpected.json").write_text("{}\n", encoding="utf-8")
            with self.assertRaisesRegex(SystemExit, f"^{MODULE.INPUT_PATH_MISSING}$"):
                MODULE.locate_inputs(run)

        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary, "run")
            meeting = write_meeting(run, "meeting-malformed")
            meeting.write_text(json.dumps({
                "meeting_id": "meeting-malformed", "records": "not-a-list"
            }), encoding="utf-8")
            self.assert_import_fails_before_request(run, MODULE.INPUT_FILE_INVALID)

    def test_plural_meeting_path_escape_fails_before_any_viewer_request(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run = root / "run"
            outside = root / "outside-meeting"
            write_meeting(outside, "meeting-escape", root=True)
            (run / "meetings").mkdir(parents=True)
            directory_link_or_skip(self, run / "meetings" / "meeting-escape", outside)

            self.assert_import_fails_before_request(run, MODULE.INPUT_PATH_OUTSIDE_RUN)

    def test_traversal_absolute_drive_encoded_and_separator_ids_fail_before_selection(self):
        invalid_ids = [
            "../outside",
            "nested/../../outside",
            "/absolute/outside",
            r"C:\outside\trajectory",
            r"traj-alpha\..\outside",
            "traj-alpha/../outside",
            "%2e%2e%2foutside",
        ]
        for trajectory_id in invalid_ids:
            with self.subTest(trajectory_id=trajectory_id), tempfile.TemporaryDirectory() as temporary:
                run = Path(temporary, "run")
                write_index(run, [{"trajectory_id": trajectory_id, "ok": True}])
                with self.assertRaisesRegex(SystemExit, f"^{MODULE.INPUT_TRAJECTORY_ID_INVALID}$"):
                    MODULE.locate_inputs(run)

    def test_symlinked_trajectory_escape_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run = root / "run"
            outside = root / "outside-trajectory"
            outside.mkdir()
            (outside / "manifest.json").write_text("{}\n", encoding="utf-8")
            (outside / "events.jsonl").write_text("{}\n", encoding="utf-8")
            (run / "trajectories").mkdir(parents=True)
            directory_link_or_skip(self, run / "trajectories" / "traj-escape", outside)
            write_index(run, [{"trajectory_id": "traj-escape", "ok": True}])

            with self.assertRaisesRegex(SystemExit, f"^{MODULE.INPUT_PATH_OUTSIDE_RUN}$"):
                MODULE.locate_inputs(run)

    def test_missing_referenced_input_uses_fixed_bounded_error(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary, "run")
            write_index(run, [{"trajectory_id": "traj-missing", "ok": True}])

            with self.assertRaisesRegex(SystemExit, f"^{MODULE.INPUT_PATH_MISSING}$"):
                MODULE.locate_inputs(run)

    def test_fixed_member_symlink_escapes_fail_before_any_viewer_request(self):
        for member, content in (
            ("manifest.json", "{}\n"),
            ("redaction.json", "{}\n"),
            ("events.jsonl", "{}\n"),
        ):
            with self.subTest(member=member), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                run = root / "run"
                trajectory = write_trajectory(run, "traj-alpha")
                write_index(run, [{"trajectory_id": "traj-alpha", "ok": True}])
                outside = root / member
                outside.write_text(content, encoding="utf-8")
                target = trajectory / member
                if target.exists():
                    target.unlink()
                symlink_or_skip(self, target, outside)

                self.assert_import_fails_before_request(
                    run, MODULE.INPUT_PATH_OUTSIDE_RUN
                )

    def test_project_map_symlink_escape_fails_before_any_viewer_request(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run = root / "run"
            write_trajectory(run, "traj-alpha")
            write_index(run, [{"trajectory_id": "traj-alpha", "ok": True}])
            outside = root / "outside-project-map.json"
            outside.write_text("{}\n", encoding="utf-8")
            symlink_or_skip(self, run / "project-map.json", outside)

            self.assert_import_fails_before_request(run, MODULE.INPUT_PATH_OUTSIDE_RUN)

    def test_missing_manifest_fails_before_any_viewer_request(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary, "run")
            trajectory = write_trajectory(run, "traj-alpha")
            (trajectory / "manifest.json").unlink()
            write_index(run, [{"trajectory_id": "traj-alpha", "ok": True}])

            self.assert_import_fails_before_request(run, MODULE.INPUT_PATH_MISSING)

    def test_malformed_fixed_member_fails_before_any_viewer_request(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary, "run")
            trajectory = write_trajectory(run, "traj-alpha")
            (trajectory / "manifest.json").write_text("{", encoding="utf-8")
            write_index(run, [{"trajectory_id": "traj-alpha", "ok": True}])

            self.assert_import_fails_before_request(run, MODULE.INPUT_FILE_INVALID)


if __name__ == "__main__":
    unittest.main()
