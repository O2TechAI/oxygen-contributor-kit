import importlib.util
from contextlib import closing
import hashlib
import http.server
import io
import json
import os
from pathlib import Path
import re
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
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
        "schema": MODULE.TRAJECTORY_EVENT_SCHEMA,
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
            "schema": MODULE.TRAJECTORY_SCHEMA,
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
        json.dumps({
            "schema": MODULE.INGEST_RUN_SCHEMA,
            "tool": "collect_repo_trajectories",
            "collection_status": "complete",
            "trajectory_count": len(entries),
            "trajectory_failures": 0,
            "trajectories": [
                {**entry, "cwd_relations": entry.get("cwd_relations", ["exact"])}
                for entry in entries
            ],
        }, ensure_ascii=False), encoding="utf-8"
    )


PREFERENCE_INSIGHT_BINDING = {
    "storyKey": "chapter-a", "insightId": "insight-a",
    "insightAuthorityDigest": "f" * 64,
}


def preference_probe(identifier="probe-a"):
    return {
        "id": identifier, **PREFERENCE_INSIGHT_BINDING,
        "documentId": "doc-a", "documentKind": "trajectory",
        "eventIds": ["event-a"], "timestamp": None, "signal": "explicit_rule",
        "score": 90, "turns": 1, "recap": "A reviewed source set a boundary.",
        "question": "What should the agent remember?",
        "options": [
            {"id": "one", "text": "Ask before changing this boundary."},
            {"id": "two", "text": "Use a separate branch for this boundary."},
        ],
        "presentations": {}, "allowOther": True, "allowSkip": True,
    }


def bulk_decision(identifier="bulk-a"):
    return {
        "id": identifier, "kind": "privacy", "count": 1,
        "question": "Keep this reviewed group?", "evidenceSample": ["event-a"],
        "presentations": {},
    }


def ready_authority(workflow_run_id="run-1", *, probes=None, bulk_decisions=None):
    probes = [preference_probe()] if probes is None else probes
    bulk_decisions = [] if bulk_decisions is None else bulk_decisions
    insight_scope = [PREFERENCE_INSIGHT_BINDING.copy()] if probes else []
    output_count = len(probes) + len(bulk_decisions)
    preference = {
        "workflowRunId": workflow_run_id, "sourceRevision": 7,
        "inputDigest": "a" * 64, "outputDigest": "b" * 64,
        "outputCount": output_count, "setAside": 0,
        "insightScope": insight_scope, "probes": probes, "bulkDecisions": bulk_decisions,
        "autoRemoved": {"total": 0, "reversible": True, "categories": []},
    }
    receipt = lambda lane, **values: {
        "lane": lane, "status": "complete", "inputDigest": "c" * 64,
        "scopeDigest": "d" * 64, "scopeCount": 0,
        "outputDigest": "e" * 64, "outputCount": 0, **values,
    }
    preparation = {
        "schema": "oxygen.story-preparation", "workflowRunId": workflow_run_id,
        "sourceRevision": 7,
        "storyPrivacy": {"candidates": [], "targetProposals": []},
        "receipts": [
            receipt("story"), receipt("insight"), receipt("story_privacy"),
            receipt("preference", inputDigest=preference["inputDigest"],
                    scopeCount=len(insight_scope), outputDigest=preference["outputDigest"],
                    outputCount=output_count),
        ],
    }
    return preference, preparation


def write_meeting(run: Path, meeting_id: str, *, directory_id=None) -> Path:
    directory = run / "meetings" / (directory_id or meeting_id)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "meeting.json"
    path.write_text(json.dumps({
        "schema": MODULE.MEETING_SCHEMA,
        "meeting_id": meeting_id,
        "title": meeting_id,
        "records": [{"record_id": "rec-00001", "order": 1, "text": "safe synthetic text"}],
    }), encoding="utf-8")
    return path


def write_unsupported_root_meeting(run: Path, meeting_id="meeting-root") -> Path:
    run.mkdir(parents=True, exist_ok=True)
    path = run / "meeting.json"
    path.write_text(json.dumps({
        "schema": MODULE.MEETING_SCHEMA,
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


def file_link_or_skip(test_case: unittest.TestCase, link: Path, target: Path):
    try:
        link.symlink_to(target)
        return
    except OSError:
        pass
    try:
        os.link(target, link)
        return
    except OSError as error:
        test_case.skipTest(f"file link creation is unavailable: {error.__class__.__name__}")


def create_workflow_runs(
    connection,
    count: int = 1,
    workflow_run_id: str | None = None,
) -> None:
    connection.execute("""
        CREATE TABLE workflow_runs (
            id TEXT PRIMARY KEY, target_confirmed INTEGER NOT NULL,
            collection_status TEXT NOT NULL, collection_completed INTEGER NOT NULL,
            collection_total INTEGER NOT NULL, story_generation_status TEXT NOT NULL,
            story_generation_completed INTEGER NOT NULL, story_generation_total INTEGER NOT NULL,
            story_source_revision INTEGER NOT NULL, active_story_digest TEXT,
            blocker_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        )
    """)
    connection.executemany(
        "INSERT INTO workflow_runs VALUES (?, 1, 'pending', 0, 0, 'not_started', 0, 0, 0, NULL, NULL, ?, ?)",
        [
            (
                workflow_run_id if count == 1 and workflow_run_id is not None
                else f"workflow-{index}",
                "2026-08-28T00:00:00Z",
                "2026-08-28T00:00:00Z",
            )
            for index in range(count)
        ],
    )


def write_viewer_state(
    runtime_root: Path,
    rows: list[tuple[str, bytes]],
    *,
    workflow_count: int = 1,
    workflow_run_id: str | None = None,
) -> Path:
    state = runtime_root / "state"
    state.mkdir(parents=True)
    database = state / "oxygen.sqlite"
    with closing(sqlite3.connect(database)) as connection:
        create_workflow_runs(connection, workflow_count, workflow_run_id)
        connection.execute(
            "CREATE TABLE persisted_state (authority TEXT PRIMARY KEY, value BLOB NOT NULL)"
        )
        connection.executemany("INSERT INTO persisted_state VALUES (?, ?)", rows)
        connection.commit()
    (state / "viewer-owned.bin").write_bytes(b"synthetic-viewer-sidecar\x00\xff")
    return database


def write_viewer_locator(
    session: Path,
    *,
    workflow_run_id: str = "workflow-0",
    head: str = "a" * 40,
    saved_path: Path | None = None,
    origin_worktree: Path | None = None,
) -> None:
    locator = "\n".join((
        f"origin_worktree: {origin_worktree or MODULE.KIT_ROOT.resolve()}",
        f"origin_head: {head}",
        f"workflow_run_id: {workflow_run_id}",
        f"saved_path: {saved_path or Path(os.path.abspath(session))}",
        "",
    ))
    (session / "viewer-session.txt").write_text(locator, encoding="utf-8")


def state_file_bytes(state: Path) -> dict[str, bytes]:
    return {
        path.relative_to(state).as_posix(): path.read_bytes()
        for path in state.rglob("*")
        if path.is_file()
    }


class LauncherUnitTest(unittest.TestCase):
    def test_missing_target_uses_fixed_safe_error(self):
        with tempfile.TemporaryDirectory() as temporary:
            missing = Path(temporary) / "HOSTILE_SENTINEL_https_example.invalid_exception-body"
            result = subprocess.run(
                [sys.executable, str(MODULE_PATH), "--target", str(missing)],
                capture_output=True, text=True, encoding="utf-8", check=False,
            )

        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "WORKING_FOLDER_INVALID\n")
        self.assertTrue(all(fragment not in result.stderr for fragment in (
            str(missing), "HOSTILE_SENTINEL", "example.invalid", "Traceback",
            "FileNotFoundError", "No such file or directory", "cannot find",
        )))

    def test_complete_viewer_state_and_locator_survive_save(self):
        rows = [
            ("workflow", b"complete\x00workflow"),
            ("story", b"reviewed story bytes"),
            ("privacy", b"keep:redact:exact"),
            ("preference", b"answer bytes"),
            ("release", b"confirmed locally"),
        ]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = root / "runtime"
            write_viewer_state(runtime, rows, workflow_run_id="run-synthetic")
            before = state_file_bytes(runtime / "state")
            destination = root / ".old" / "viewer-session"

            with (
                mock.patch.object(MODULE, "_current_head", return_value="a" * 40),
                mock.patch("builtins.print") as printed,
            ):
                saved_session = MODULE.save_viewer_state(runtime, destination, "run-synthetic")

            self.assertEqual(saved_session, Path(os.path.abspath(destination)))
            saved_state = saved_session / "state"
            self.assertEqual(state_file_bytes(saved_state), before)
            with closing(sqlite3.connect(saved_state / "oxygen.sqlite")) as connection:
                self.assertEqual(
                    connection.execute(
                        "SELECT authority, value FROM persisted_state ORDER BY authority"
                    ).fetchall(),
                    sorted(rows),
                )
            locator = (destination / "viewer-session.txt").read_text(encoding="utf-8")
            self.assertIn(f"origin_worktree: {MODULE.KIT_ROOT.resolve()}", locator)
            self.assertIn(f"origin_head: {'a' * 40}", locator)
            self.assertIn("workflow_run_id: run-synthetic", locator)
            self.assertIn(f"saved_path: {saved_session}", locator)
            printed.assert_called_once_with(f"Saved Viewer state: {saved_session}", flush=True)

    def test_blocked_pending_and_partial_state_are_saved_without_inference(self):
        rows = [
            ("blocked", b"existing blocker"),
            ("pending", b"collection pending"),
            ("partial-review", b"two of five reviewed"),
        ]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = root / "runtime"
            write_viewer_state(runtime, rows)
            destination = root / ".old" / "progress-session"
            with (
                mock.patch.object(MODULE, "_current_head", return_value="b" * 40),
                mock.patch("builtins.print"),
            ):
                saved_session = MODULE.save_viewer_state(runtime, destination, None)

            with closing(sqlite3.connect(saved_session / "state" / "oxygen.sqlite")) as connection:
                self.assertEqual(
                    connection.execute(
                        "SELECT authority, value FROM persisted_state ORDER BY authority"
                    ).fetchall(),
                    sorted(rows),
                )
            self.assertIn(
                "workflow_run_id: workflow-0",
                (destination / "viewer-session.txt").read_text(encoding="utf-8"),
            )

    def test_save_rejects_a_supplied_workflow_id_that_differs_from_sqlite(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = root / "runtime"
            write_viewer_state(
                runtime, [("workflow", b"complete")], workflow_run_id="run-canonical",
            )
            destination = root / "saved"
            with self.assertRaisesRegex(
                SystemExit, f"^{re.escape(MODULE.VIEWER_STATE_SAVE_FAILED)}$",
            ):
                MODULE.save_viewer_state(runtime, destination, "run-foreign")
            self.assertFalse(destination.exists())

    def test_change_after_resume_remains_present_on_next_resume(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = root / "runtime"
            write_viewer_state(
                runtime, [("partial-review", b"before")], workflow_run_id="run-durable",
            )
            destination = root / ".old" / "durable-session"
            with (
                mock.patch.object(MODULE, "_current_head", return_value="c" * 40),
                mock.patch("builtins.print"),
            ):
                MODULE.save_viewer_state(runtime, destination, "run-durable")

            first_database = MODULE.validate_viewer_state(destination)
            environment = MODULE.viewer_environment(destination)
            self.assertEqual(environment["OXYGEN_VIEWER_STATE_DIR"], str(destination / "state"))
            with closing(sqlite3.connect(first_database)) as connection:
                connection.execute(
                    "UPDATE persisted_state SET value = ? WHERE authority = ?",
                    (b"after-resume exact bytes", "partial-review"),
                )
                connection.commit()

            second_database = MODULE.validate_viewer_state(destination)
            self.assertEqual(first_database, second_database)
            with closing(sqlite3.connect(second_database)) as connection:
                self.assertEqual(
                    connection.execute(
                        "SELECT value FROM persisted_state WHERE authority = 'partial-review'"
                    ).fetchone(),
                    (b"after-resume exact bytes",),
                )

    def test_missing_and_corrupt_sqlite_fail_with_fixed_safe_error(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            missing = root / "private-missing-session"
            corrupt = root / "private-corrupt-session"
            (missing / "state").mkdir(parents=True)
            (corrupt / "state").mkdir(parents=True)
            (corrupt / "state" / "oxygen.sqlite").write_bytes(
                b"private raw content that is not sqlite"
            )
            for session in (missing, corrupt):
                with self.subTest(session=session.name):
                    with self.assertRaisesRegex(
                        SystemExit, f"^{re.escape(MODULE.VIEWER_STATE_INVALID)}$"
                    ) as error:
                        MODULE.validate_viewer_state(session)
                    message = str(error.exception)
                    self.assertNotIn(session.name, message)
                    self.assertNotIn("private raw content", message)

    def test_integrity_valid_non_oxygen_and_invalid_workflow_identity_fail_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            sessions = {}

            for name in ("missing-table", "arbitrary-valid"):
                session = root / name
                (session / "state").mkdir(parents=True)
                with closing(sqlite3.connect(session / "state" / "oxygen.sqlite")) as connection:
                    connection.execute("CREATE TABLE unrelated (value TEXT)")
                    connection.commit()
                sessions[name] = session

            missing_columns = root / "missing-columns"
            (missing_columns / "state").mkdir(parents=True)
            with closing(
                sqlite3.connect(missing_columns / "state" / "oxygen.sqlite")
            ) as connection:
                connection.execute("CREATE TABLE workflow_runs (id TEXT PRIMARY KEY)")
                connection.execute("INSERT INTO workflow_runs VALUES ('not-oxygen')")
                connection.commit()
            sessions["missing-columns"] = missing_columns

            for name, count in (("zero-rows", 0), ("multiple-rows", 2)):
                session = root / name
                (session / "state").mkdir(parents=True)
                with closing(sqlite3.connect(session / "state" / "oxygen.sqlite")) as connection:
                    create_workflow_runs(connection, count)
                    connection.commit()
                sessions[name] = session

            for name, session in sessions.items():
                with self.subTest(name=name), self.assertRaisesRegex(
                    SystemExit, f"^{re.escape(MODULE.VIEWER_STATE_INVALID)}$"
                ) as error:
                    MODULE.validate_viewer_state(session)
                self.assertEqual(str(error.exception), MODULE.VIEWER_STATE_INVALID)

    def test_existing_save_destination_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = root / "runtime"
            write_viewer_state(
                runtime, [("workflow", b"complete")], workflow_run_id="run-existing",
            )
            destination = root / ".old" / "existing"
            destination.mkdir(parents=True)
            sentinel = destination / "owner.txt"
            sentinel.write_bytes(b"owner bytes")

            with self.assertRaisesRegex(
                SystemExit, f"^{re.escape(MODULE.VIEWER_STATE_EXISTS)}$"
            ):
                MODULE.save_viewer_state(runtime, destination, "run-existing")
            self.assertEqual(sentinel.read_bytes(), b"owner bytes")
            self.assertEqual(list(destination.iterdir()), [sentinel])

    def test_hardlinked_sqlite_is_rejected_without_changing_either_link(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = root / "runtime"
            database = write_viewer_state(runtime, [("workflow", b"complete")])
            external = root / "external.sqlite"
            try:
                os.link(database, external)
            except OSError as error:
                self.skipTest(f"hard links unavailable: {error}")
            before = database.read_bytes()

            with self.assertRaisesRegex(
                SystemExit, f"^{re.escape(MODULE.VIEWER_STATE_INVALID)}$",
            ):
                MODULE.validate_viewer_state(runtime)

            self.assertEqual(database.read_bytes(), before)
            self.assertEqual(external.read_bytes(), before)

    def test_aliased_state_directory_is_rejected_without_external_mutation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            external_runtime = root / "external-runtime"
            write_viewer_state(external_runtime, [("workflow", b"complete")])
            before = state_file_bytes(external_runtime / "state")
            session = root / "session"
            session.mkdir()
            directory_link_or_skip(self, session / "state", external_runtime / "state")

            with self.assertRaisesRegex(
                SystemExit, f"^{re.escape(MODULE.VIEWER_STATE_INVALID)}$",
            ):
                MODULE.validate_viewer_state(session)

            self.assertEqual(state_file_bytes(external_runtime / "state"), before)

    def test_symlinked_state_member_is_rejected_without_external_mutation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = root / "runtime"
            write_viewer_state(runtime, [("workflow", b"complete")])
            external = root / "external.bin"
            external.write_bytes(b"external member bytes")
            link = runtime / "state" / "linked.bin"
            try:
                link.symlink_to(external)
            except OSError as error:
                self.skipTest(f"file symlink unavailable: {error}")

            with self.assertRaisesRegex(
                SystemExit, f"^{re.escape(MODULE.VIEWER_STATE_INVALID)}$",
            ):
                MODULE.validate_viewer_state(runtime)

            self.assertEqual(external.read_bytes(), b"external member bytes")

    def test_save_parent_junction_is_rejected_before_external_mutation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = root / "runtime"
            write_viewer_state(
                runtime, [("workflow", b"complete")], workflow_run_id="run-safe",
            )
            external = root / "external"
            external.mkdir()
            sentinel = external / "sentinel.bin"
            sentinel.write_bytes(b"external owner bytes")
            directory_link_or_skip(self, root / "alias", external)

            with self.assertRaisesRegex(
                SystemExit, f"^{re.escape(MODULE.VIEWER_STATE_SAVE_FAILED)}$",
            ):
                MODULE.save_viewer_state(runtime, root / "alias" / "saved", "run-safe")

            self.assertEqual(sentinel.read_bytes(), b"external owner bytes")
            self.assertFalse((external / "saved").exists())

    def test_late_save_collision_is_no_clobber_and_clean_retry_succeeds(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = root / "runtime"
            write_viewer_state(
                runtime, [("workflow", b"complete")], workflow_run_id="run-race",
            )
            destination = root / "sessions" / "saved"
            destination.parent.mkdir()
            real_rename = MODULE.rename_noreplace

            def race(staging: Path, final: Path) -> None:
                final.mkdir()
                (final / "owner.bin").write_bytes(b"raced owner bytes")
                real_rename(staging, final)

            with (
                mock.patch.object(MODULE, "_current_head", return_value="d" * 40),
                mock.patch.object(MODULE, "rename_noreplace", side_effect=race),
                self.assertRaisesRegex(
                    SystemExit, f"^{re.escape(MODULE.VIEWER_STATE_EXISTS)}$",
                ),
            ):
                MODULE.save_viewer_state(runtime, destination, "run-race")

            self.assertEqual((destination / "owner.bin").read_bytes(), b"raced owner bytes")
            self.assertEqual(list(destination.parent.glob(".saved.save-*")), [])
            (destination / "owner.bin").unlink()
            destination.rmdir()
            with (
                mock.patch.object(MODULE, "_current_head", return_value="d" * 40),
                mock.patch("builtins.print"),
            ):
                saved = MODULE.save_viewer_state(runtime, destination, "run-race")
            self.assertEqual(saved, destination)
            self.assertEqual(MODULE.validate_viewer_state(saved), saved / "state" / "oxygen.sqlite")

    def test_save_runs_after_termination_and_port_release(self):
        order = []
        with (
            mock.patch.object(
                MODULE, "terminate_process_group", side_effect=lambda _process: order.append("stop")
            ),
            mock.patch.object(
                MODULE, "wait_for_port_release", side_effect=lambda _port: order.append("released")
            ),
            mock.patch.object(
                MODULE, "save_viewer_state", side_effect=lambda *_args: order.append("saved")
            ) as save,
        ):
            MODULE.stop_owned_viewer(
                mock.sentinel.process,
                3210,
                runtime_root=Path("runtime"),
                save_destination=Path("session"),
                workflow_run_id="run-order",
                save_ready=True,
            )
        self.assertEqual(order, ["stop", "released", "saved"])
        save.assert_called_once_with(Path("runtime"), Path("session"), "run-order")

    def test_failed_port_release_never_saves(self):
        with (
            mock.patch.object(MODULE, "terminate_process_group"),
            mock.patch.object(
                MODULE, "wait_for_port_release", side_effect=RuntimeError("private port detail")
            ),
            mock.patch.object(MODULE, "save_viewer_state") as save,
        ):
            with self.assertRaisesRegex(RuntimeError, "private port detail"):
                MODULE.stop_owned_viewer(
                    mock.sentinel.process,
                    3210,
                    runtime_root=Path("runtime"),
                    save_destination=Path("session"),
                    save_ready=True,
                )
        save.assert_not_called()

    def test_original_failure_survives_later_save_failure_as_safe_warning(self):
        order = []
        stderr = io.StringIO()

        def fail_save(*_args):
            order.append("save-failed")
            raise RuntimeError("private SQLite path and content")

        with (
            mock.patch.object(
                MODULE, "terminate_process_group", side_effect=lambda _process: order.append("stop")
            ),
            mock.patch.object(
                MODULE, "wait_for_port_release", side_effect=lambda _port: order.append("released")
            ),
            mock.patch.object(
                MODULE,
                "save_viewer_state",
                side_effect=fail_save,
            ),
            mock.patch("sys.stderr", stderr),
        ):
            with self.assertRaisesRegex(SystemExit, "^ORIGINAL_WORKFLOW_FAILURE$"):
                try:
                    raise SystemExit("ORIGINAL_WORKFLOW_FAILURE")
                finally:
                    MODULE.stop_owned_viewer(
                        mock.sentinel.process,
                        3210,
                        runtime_root=Path("private-runtime"),
                        save_destination=Path("private-session"),
                        save_ready=True,
                        preserve_active_failure=sys.exc_info()[0] is not None,
                    )

        self.assertEqual(order, ["stop", "released", "save-failed"])
        self.assertEqual(
            stderr.getvalue(), f"Warning: {MODULE.VIEWER_STATE_SAVE_FAILED}\n"
        )
        self.assertNotIn("private", stderr.getvalue().lower())
        self.assertNotIn("sqlite", stderr.getvalue().lower())

    def test_save_failure_without_earlier_failure_is_terminal_and_safe(self):
        order = []
        stderr = io.StringIO()

        def fail_save(*_args):
            order.append("save-failed")
            raise RuntimeError("private SQLite path and content")

        with (
            mock.patch.object(
                MODULE, "terminate_process_group", side_effect=lambda _process: order.append("stop")
            ),
            mock.patch.object(
                MODULE, "wait_for_port_release", side_effect=lambda _port: order.append("released")
            ),
            mock.patch.object(
                MODULE, "save_viewer_state",
                side_effect=fail_save,
            ),
            mock.patch("sys.stderr", stderr),
        ):
            with self.assertRaisesRegex(
                SystemExit, f"^{re.escape(MODULE.VIEWER_STATE_SAVE_FAILED)}$"
            ):
                MODULE.stop_owned_viewer(
                    mock.sentinel.process,
                    3210,
                    runtime_root=Path("private-runtime"),
                    save_destination=Path("private-session"),
                    save_ready=True,
                )

        self.assertEqual(order, ["stop", "released", "save-failed"])
        self.assertEqual(stderr.getvalue(), "")

    def test_save_failure_does_not_leak_raw_path_or_content(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = root / "runtime-private"
            write_viewer_state(
                runtime,
                [("workflow", b"private database bytes")],
                workflow_run_id="private-run",
            )
            destination = root / ".old" / "private-destination"
            with mock.patch.object(
                MODULE.shutil,
                "copytree",
                side_effect=OSError("C:/private/source token=secret"),
            ):
                with self.assertRaisesRegex(
                    SystemExit, f"^{re.escape(MODULE.VIEWER_STATE_SAVE_FAILED)}$"
                ) as error:
                    MODULE.save_viewer_state(runtime, destination, "private-run")
            message = str(error.exception)
            self.assertNotIn("private", message.lower())
            self.assertNotIn("secret", message.lower())
            self.assertFalse(destination.exists())

    def test_exact_saved_locator_is_accepted(self):
        with tempfile.TemporaryDirectory() as temporary:
            session = Path(temporary) / "saved-session"
            database = write_viewer_state(
                session, [("partial-review", b"preserved")],
                workflow_run_id="run-preserved",
            )
            write_viewer_locator(
                session, workflow_run_id="run-preserved", head="e" * 40,
            )
            with mock.patch.object(MODULE, "_current_head", return_value="e" * 40):
                self.assertEqual(
                    MODULE.validate_viewer_session(
                        Path(os.path.abspath(session)), Path(os.path.abspath(session)),
                    ),
                    database,
                )

    def test_resume_locator_mismatches_fail_before_dependencies_listener_or_runtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            other_saved = root / "other-saved"
            other_saved.mkdir()
            other_worktree = root / "other-worktree"
            other_worktree.mkdir()
            cases = [
                "missing", "malformed", "duplicate", "unknown", "run", "path",
                "worktree", "head-format", "head-mismatch",
            ]
            for name in cases:
                session = root / f"session-{name}"
                write_viewer_state(
                    session, [("partial-review", b"preserved")],
                    workflow_run_id="run-exact",
                )
                if name != "missing":
                    write_viewer_locator(
                        session,
                        workflow_run_id="unknown" if name == "unknown" else (
                            "run-foreign" if name == "run" else "run-exact"
                        ),
                        head="A" * 40 if name == "head-format" else (
                            "f" * 40 if name == "head-mismatch" else "e" * 40
                        ),
                        saved_path=other_saved if name == "path" else None,
                        origin_worktree=other_worktree if name == "worktree" else None,
                    )
                    locator = session / "viewer-session.txt"
                    if name == "malformed":
                        locator.write_text("origin_worktree without separator\n", encoding="utf-8")
                    elif name == "duplicate":
                        locator.write_text(
                            locator.read_text(encoding="utf-8")
                            + f"saved_path: {Path(os.path.abspath(session))}\n",
                            encoding="utf-8",
                        )
                with (
                    self.subTest(name=name),
                    mock.patch.object(sys, "argv", [
                        "run_local_review.py", "--resume-state", str(session), "--no-browser",
                    ]),
                    mock.patch.object(MODULE, "_current_head", return_value="e" * 40),
                    mock.patch.object(MODULE, "ensure_dependencies") as dependencies,
                    mock.patch.object(MODULE, "reserve_free_port") as reserve,
                    mock.patch.object(MODULE, "start_owned_process") as start,
                ):
                    with self.assertRaisesRegex(
                        SystemExit, f"^{re.escape(MODULE.VIEWER_STATE_INVALID)}$",
                    ):
                        MODULE.main()
                dependencies.assert_not_called()
                reserve.assert_not_called()
                start.assert_not_called()

    def test_resume_rejects_a_linked_locator_without_external_mutation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            session = root / "saved-session"
            write_viewer_state(
                session, [("partial-review", b"preserved")],
                workflow_run_id="run-exact",
            )
            external = root / "external-locator.txt"
            external.write_text("private external locator", encoding="utf-8")
            file_link_or_skip(self, session / "viewer-session.txt", external)
            with self.assertRaisesRegex(
                SystemExit, f"^{re.escape(MODULE.VIEWER_STATE_INVALID)}$",
            ):
                MODULE.validate_viewer_session(session, session)
            self.assertEqual(
                external.read_text(encoding="utf-8"), "private external locator",
            )

    def test_resume_cli_uses_saved_state_without_collection_or_import(self):
        class FakeProcess:
            def poll(self):
                return None

        class ReadyResponse:
            def close(self):
                pass

        with tempfile.TemporaryDirectory() as temporary:
            session = Path(temporary) / "saved-session"
            write_viewer_state(
                session, [("partial-review", b"preserved")],
                workflow_run_id="run-preserved",
            )
            write_viewer_locator(
                session, workflow_run_id="run-preserved", head="e" * 40,
            )
            with (
                mock.patch.object(sys, "argv", [
                    "run_local_review.py", "--resume-state", str(session),
                    "--port", "3210", "--skip-install", "--no-browser", "--smoke-test",
                ]),
                mock.patch.object(MODULE, "install_signal_handlers"),
                mock.patch.object(MODULE, "_current_head", return_value="e" * 40),
                mock.patch.object(MODULE, "ensure_port_available"),
                mock.patch.object(MODULE, "ensure_dependencies", return_value="npm"),
                mock.patch.object(MODULE, "start_owned_process", return_value=FakeProcess()) as start,
                mock.patch.object(MODULE.urllib.request, "urlopen", return_value=ReadyResponse()),
                mock.patch.object(
                    MODULE, "request_json", return_value={"workflowRunId": "run-preserved"}
                ) as request,
                mock.patch.object(MODULE, "stop_owned_viewer") as stop,
                mock.patch.object(MODULE, "establish_workflow_run") as establish,
                mock.patch.object(MODULE, "import_run") as imported,
                mock.patch("builtins.print"),
            ):
                MODULE.main()

            environment = start.call_args.kwargs["env"]
            self.assertEqual(
                environment["OXYGEN_VIEWER_STATE_DIR"],
                str(Path(os.path.abspath(session / "state"))),
            )
            request.assert_called_once_with(
                mock.ANY, "http://127.0.0.1:3210/api/workflow"
            )
            establish.assert_not_called()
            imported.assert_not_called()
            stop.assert_called_once_with(
                start.return_value,
                3210,
                runtime_root=Path(os.path.abspath(session)),
                save_destination=None,
                workflow_run_id=None,
                save_ready=True,
                preserve_active_failure=False,
            )

    def test_save_cli_passes_established_workflow_to_post_release_save(self):
        class FakeProcess:
            def poll(self):
                return None

        class ReadyResponse:
            def close(self):
                pass

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "target"
            target.mkdir()
            destination = root / ".old" / "saved-session"
            with (
                mock.patch.object(sys, "argv", [
                    "run_local_review.py", "--target", str(target),
                    "--save-state", str(destination), "--port", "3211",
                    "--skip-install", "--no-browser", "--smoke-test",
                ]),
                mock.patch.object(MODULE, "install_signal_handlers"),
                mock.patch.object(MODULE, "ensure_port_available"),
                mock.patch.object(MODULE, "ensure_dependencies", return_value="npm"),
                mock.patch.object(MODULE, "start_owned_process", return_value=FakeProcess()) as start,
                mock.patch.object(MODULE.urllib.request, "urlopen", return_value=ReadyResponse()),
                mock.patch.object(MODULE, "establish_workflow_run", return_value="run-saved"),
                mock.patch.object(MODULE, "request_json", return_value={"workflowRunId": "run-saved"}),
                mock.patch.object(MODULE, "stop_owned_viewer") as stop,
                mock.patch("builtins.print"),
            ):
                MODULE.main()

            runtime_root = Path(start.call_args.kwargs["env"]["OXYGEN_VIEWER_STATE_DIR"]).parent
            stop.assert_called_once_with(
                start.return_value,
                3211,
                runtime_root=runtime_root,
                save_destination=Path(os.path.abspath(destination)),
                workflow_run_id="run-saved",
                save_ready=True,
                preserve_active_failure=False,
            )

    def test_invalid_resume_fails_before_dependencies_listener_or_runtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            sessions = [root / "missing", root / "corrupt", root / "wrong-valid"]
            (sessions[1] / "state").mkdir(parents=True)
            (sessions[1] / "state" / "oxygen.sqlite").write_bytes(b"private invalid bytes")
            (sessions[2] / "state").mkdir(parents=True)
            with closing(sqlite3.connect(sessions[2] / "state" / "oxygen.sqlite")) as connection:
                connection.execute("CREATE TABLE unrelated (value TEXT)")
                connection.commit()
            for session in sessions:
                with (
                    self.subTest(session=session.name),
                    mock.patch.object(sys, "argv", [
                        "run_local_review.py", "--resume-state", str(session), "--no-browser",
                    ]),
                    mock.patch.object(MODULE, "ensure_dependencies") as dependencies,
                    mock.patch.object(MODULE, "reserve_free_port") as reserve,
                    mock.patch.object(MODULE, "start_owned_process") as start,
                ):
                    with self.assertRaisesRegex(
                        SystemExit, f"^{re.escape(MODULE.VIEWER_STATE_INVALID)}$"
                    ):
                        MODULE.main()
                dependencies.assert_not_called()
                reserve.assert_not_called()
                start.assert_not_called()


    def test_story_blocked_cli_sanitizes_hostile_409_without_retry(self):
        hostile_body = (
            b'{"private":"token=secret-value","sqlite":"C:/private/state.db",'
            b'"payload":"customer-data"}'
        )
        requests = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                requests.append(self.path)
                self.send_response(409)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(hostile_body)))
                self.end_headers()
                self.wfile.write(hostile_body)

            def log_message(self, *_args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            port = server.server_address[1]
            result = subprocess.run(
                [
                    sys.executable,
                    str(MODULE_PATH),
                    "--attach-url",
                    f"http://127.0.0.1:{port}",
                    "--workflow-run-id",
                    "synthetic-run",
                    "--story-event",
                    "blocked",
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="strict",
                check=False,
            )
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertEqual(
            result.stderr,
            MODULE.VIEWER_WORKFLOW_BLOCKERS[409] + "\n",
        )
        self.assertEqual(requests, ["/api/workflow"])
        for leaked in (
            "Traceback",
            "secret-value",
            "C:/private/state.db",
            "customer-data",
            f"127.0.0.1:{port}",
        ):
            self.assertNotIn(leaked, result.stderr)

    def test_expected_400_and_404_blockers_are_sanitized_without_retry(self):
        hostile_body = b"private payload sqlite detail token=secret"
        for status in (400, 404):
            with self.subTest(status=status):
                opener = mock.Mock()
                opener.open.side_effect = urllib.error.HTTPError(
                    "http://127.0.0.1:3298/api/workflow",
                    status,
                    "internal exception text",
                    {},
                    io.BytesIO(hostile_body),
                )
                with self.assertRaises(SystemExit) as raised:
                    MODULE.request_json(
                        opener,
                        "http://127.0.0.1:3298/api/workflow",
                        method="POST",
                        body={"event": "synthetic"},
                    )
                self.assertEqual(
                    str(raised.exception),
                    MODULE.VIEWER_WORKFLOW_BLOCKERS[status],
                )
                opener.open.assert_called_once()
                for leaked in ("private payload", "sqlite detail", "secret", "internal exception"):
                    self.assertNotIn(leaked, str(raised.exception))

    def test_5xx_and_network_failures_are_distinguishable_bounded_and_not_retried(self):
        opener = mock.Mock()
        opener.open.side_effect = urllib.error.HTTPError(
            "http://127.0.0.1:3298/api/workflow",
            503,
            "database secret",
            {},
            io.BytesIO(b"private server body"),
        )
        with self.assertRaisesRegex(
            SystemExit,
            r"^VIEWER_SERVER_ERROR_HTTP_503: The local Viewer failed to process the request\.$",
        ) as server_error:
            MODULE.request_json(opener, "http://127.0.0.1:3298/api/workflow")
        opener.open.assert_called_once()
        self.assertNotIn("database secret", str(server_error.exception))
        self.assertNotIn("private server body", str(server_error.exception))

        opener = mock.Mock()
        opener.open.side_effect = urllib.error.URLError("socket secret detail")
        with self.assertRaisesRegex(
            SystemExit,
            rf"^{MODULE.VIEWER_NETWORK_ERROR}$",
        ) as network_error:
            MODULE.request_json(opener, "http://127.0.0.1:3298/api/workflow")
        opener.open.assert_called_once()
        self.assertNotIn("socket secret detail", str(network_error.exception))

    def test_invalid_and_successful_json_responses_preserve_bounded_behavior(self):
        invalid_response = mock.MagicMock()
        invalid_response.__enter__.return_value.read.return_value = (
            b"private invalid response body"
        )
        opener = mock.Mock()
        opener.open.return_value = invalid_response
        with self.assertRaisesRegex(
            SystemExit,
            rf"^{MODULE.VIEWER_RESPONSE_INVALID}$",
        ) as invalid_error:
            MODULE.request_json(opener, "http://127.0.0.1:3298/api/workflow")
        self.assertNotIn("private invalid response body", str(invalid_error.exception))

        successful_response = mock.MagicMock()
        successful_response.__enter__.return_value.read.return_value = b'{"ok":true}'
        opener = mock.Mock()
        opener.open.return_value = successful_response
        self.assertEqual(
            MODULE.request_json(opener, "http://127.0.0.1:3298/api/workflow"),
            {"ok": True},
        )
        opener.open.assert_called_once()

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
            MODULE.normalize_local_viewer_url("http://127.0.0.1:3298"),
            "http://127.0.0.1:3298",
        )
        self.assertEqual(
            MODULE.normalize_local_viewer_url("http://localhost:1"),
            "http://localhost:1",
        )
        for value in (
            "https://127.0.0.1:3298",
            "http://example.com:3298",
            "http://127.0.0.1:3298/api/workflow",
            "http://127.0.0.1:3298/",
            "http://127.0.0.1:03298",
            "http://127.0.0.1:65536",
            "http://LOCALHOST:3298",
            "http://localhost:3298?x=1",
            "http://localhost:3298#fragment",
            "http://user@localhost:3298",
            "http://127.0.0.1:3298@example.com:80",
            " http://localhost:3298",
        ):
            with self.subTest(value=value), self.assertRaises(SystemExit):
                MODULE.normalize_local_viewer_url(value)

    def test_story_privacy_export_and_import_use_fixed_routes_and_no_clobber_files(self):
        snapshot = {
            "schema": "oxygen.reviewed-story-privacy-snapshot",
            "binding": {"workflowRunId": "run-1"},
            "targetTransitions": [],
            "changedTargets": [],
        }
        authority = {"workflowRunId": "run-1", "status": "completed_empty", "candidates": []}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "snapshot.json"
            bundle_path = root / "bundle.json"
            bundle_path.write_text(json.dumps({
                "schema": "oxygen.reviewed-story-privacy-import",
                "binding": {"workflowRunId": "run-1"},
            }), encoding="utf-8")
            calls = []

            def request(_opener, url, *, method="GET", body=None):
                calls.append((url, method, body))
                return snapshot if method == "GET" else authority

            with (
                mock.patch.object(MODULE, "request_json", side_effect=request),
                mock.patch.object(MODULE, "local_viewer_opener", return_value=mock.sentinel.opener),
                mock.patch("builtins.print"),
            ):
                exported = MODULE.export_story_privacy_snapshot(
                    "http://127.0.0.1:3210", "run-1", output,
                )
                self.assertEqual(exported["story_privacy"], "snapshot_exported")
                self.assertEqual(json.loads(output.read_text(encoding="utf-8")), snapshot)
                with self.assertRaisesRegex(SystemExit, "STORY_PRIVACY_EXPORT_EXISTS"):
                    MODULE.export_story_privacy_snapshot(
                        "http://127.0.0.1:3210", "run-1", output,
                    )
                imported = MODULE.import_story_privacy_bundle(
                    "http://127.0.0.1:3210", "run-1", bundle_path,
                )
                self.assertEqual(imported["story_privacy"], "bundle_imported")

            self.assertEqual(calls[0][:2], (
                "http://127.0.0.1:3210/api/story-privacy/export?workflowRunId=run-1", "GET",
            ))
            self.assertEqual(calls[1], (
                "http://127.0.0.1:3210/api/story-privacy/import", "POST",
                json.loads(bundle_path.read_text(encoding="utf-8")),
            ))

    def test_story_privacy_mode_rejects_origin_before_reading_any_path(self):
        with (
            mock.patch.object(sys, "argv", [
                "run_local_review.py", "--attach-url", "http://127.0.0.1:3210@example.com:80",
                "--workflow-run-id", "run-1", "--story-privacy-import", "PRIVATE_SENTINEL.json",
            ]),
            mock.patch.object(MODULE, "_direct_unique_file") as opened,
        ):
            with self.assertRaisesRegex(SystemExit, "VIEWER_ORIGIN_INVALID"):
                MODULE.main()
        opened.assert_not_called()

    def test_story_privacy_direct_helpers_reject_origin_before_any_path_access(self):
        hostile = "http://127.0.0.1:3210@example.com:80"
        with mock.patch.object(MODULE, "_json_export_path") as export_path:
            with self.assertRaisesRegex(SystemExit, "VIEWER_ORIGIN_INVALID"):
                MODULE.export_story_privacy_snapshot(hostile, "run-1", Path("PRIVATE.json"))
        export_path.assert_not_called()
        with mock.patch.object(MODULE, "_direct_unique_file") as import_path:
            with self.assertRaisesRegex(SystemExit, "VIEWER_ORIGIN_INVALID"):
                MODULE.import_story_privacy_bundle(hostile, "run-1", Path("PRIVATE.json"))
        import_path.assert_not_called()

    def test_story_privacy_export_rejects_foreign_snapshot_without_output(self):
        snapshot = {
            "schema": "oxygen.reviewed-story-privacy-snapshot",
            "binding": {"workflowRunId": "foreign-run"},
            "targetTransitions": [],
            "changedTargets": [],
        }
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "snapshot.json"
            with (
                mock.patch.object(MODULE, "request_json", return_value=snapshot),
                mock.patch.object(MODULE, "local_viewer_opener", return_value=mock.sentinel.opener),
            ):
                with self.assertRaisesRegex(SystemExit, "VIEWER_RESPONSE_INVALID"):
                    MODULE.export_story_privacy_snapshot(
                        "http://127.0.0.1:3210", "run-1", output,
                    )
            self.assertFalse(output.exists())

    def test_story_privacy_import_maps_malformed_binding_and_response_to_fixed_errors(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "PRIVATE_SENTINEL_bundle.json"
            source.write_text(json.dumps({
                "schema": "oxygen.reviewed-story-privacy-import", "binding": "malformed",
            }), encoding="utf-8")
            with mock.patch.object(MODULE, "request_json") as request:
                with self.assertRaisesRegex(SystemExit, "STORY_PRIVACY_IMPORT_INVALID") as error:
                    MODULE.import_story_privacy_bundle(
                        "http://127.0.0.1:3210", "run-1", source,
                    )
            request.assert_not_called()
            self.assertNotIn(str(source), str(error.exception))

            source.write_text(json.dumps({
                "schema": "oxygen.reviewed-story-privacy-import",
                "binding": {"workflowRunId": "run-1"},
            }), encoding="utf-8")
            with (
                mock.patch.object(MODULE, "request_json", return_value={
                    "workflowRunId": "run-1", "candidates": "malformed",
                }),
                mock.patch.object(MODULE, "local_viewer_opener", return_value=mock.sentinel.opener),
            ):
                with self.assertRaisesRegex(SystemExit, "VIEWER_RESPONSE_INVALID"):
                    MODULE.import_story_privacy_bundle(
                        "http://127.0.0.1:3210", "run-1", source,
                    )

    def test_story_privacy_export_rejects_an_ancestor_directory_alias(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            physical = root / "physical"
            physical.mkdir()
            (physical / "nested").mkdir()
            alias = root / "alias"
            try:
                alias.symlink_to(physical, target_is_directory=True)
            except OSError as error:
                self.skipTest(f"directory symlink unavailable: {error}")
            with self.assertRaisesRegex(SystemExit, "STORY_PRIVACY_EXPORT_FAILED"):
                MODULE._json_export_path(
                    alias / "nested" / "snapshot.json",
                    MODULE.STORY_PRIVACY_EXPORT_EXISTS,
                    MODULE.STORY_PRIVACY_EXPORT_FAILED,
                )
            self.assertFalse((physical / "nested" / "snapshot.json").exists())

    def test_source_privacy_export_writes_exact_current_projection_including_completed_zero(self):
        for redaction_count in (1, 0):
            with self.subTest(redaction_count=redaction_count), tempfile.TemporaryDirectory() as temporary:
                output = Path(temporary) / "source-privacy.json"
                projection = {
                    "redactions": [{"id": "row-a"}] if redaction_count else [],
                    "job": {
                        "status": "complete",
                        "completed": redaction_count,
                        "total": redaction_count,
                        "rejected": 0,
                        "source_revision": 7,
                        "source_digest": "a" * 64,
                    },
                }
                authority = {"sourceAuthority": {
                    "workflowRunId": "run-1",
                    "sourceRevision": 7,
                    "finalizedCorpus": {
                        "revision": 3,
                        "digest": "b" * 64,
                        "documentCount": 2,
                        "itemCount": 9,
                    },
                    "sourceDigest": "a" * 64,
                }}
                with (
                    mock.patch.object(
                        MODULE, "request_json", side_effect=[projection, authority],
                    ) as request,
                    mock.patch.object(
                        MODULE, "local_viewer_opener", return_value=mock.sentinel.opener,
                    ),
                    mock.patch("builtins.print") as printed,
                ):
                    MODULE.export_source_privacy_projection(
                        "http://127.0.0.1:3210", "run-1", output,
                    )
                self.assertEqual(json.loads(output.read_text(encoding="utf-8")), projection)
                self.assertEqual(request.call_args_list, [
                    mock.call(mock.sentinel.opener, "http://127.0.0.1:3210/api/redactions"),
                    mock.call(
                        mock.sentinel.opener,
                        "http://127.0.0.1:3210/api/redactions?sourceAuthority=1",
                    ),
                ])
                result = json.loads(printed.call_args.args[0])
                self.assertEqual(set(result), {"redaction_count", "output"})
                self.assertEqual(result["redaction_count"], redaction_count)

    def test_source_privacy_export_rejects_foreign_stale_incomplete_and_malformed_authority(self):
        projection = {
            "redactions": [{"id": "row-a"}],
            "job": {
                "status": "complete", "completed": 1, "total": 1, "rejected": 0,
                "source_revision": 7, "source_digest": "a" * 64,
            },
        }
        authority = {"sourceAuthority": {
            "workflowRunId": "run-1", "sourceRevision": 7,
            "finalizedCorpus": {
                "revision": 3, "digest": "b" * 64, "documentCount": 2, "itemCount": 9,
            },
            "sourceDigest": "a" * 64,
        }}
        cases = {
            "foreign": (projection, {**authority, "sourceAuthority": {
                **authority["sourceAuthority"], "workflowRunId": "foreign-run",
            }}),
            "stale-revision": ({**projection, "job": {
                **projection["job"], "source_revision": 6,
            }}, authority),
            "stale-digest": ({**projection, "job": {
                **projection["job"], "source_digest": "c" * 64,
            }}, authority),
            "incomplete": ({**projection, "job": {
                **projection["job"], "status": "running",
            }}, authority),
            "count-mismatch": ({**projection, "job": {
                **projection["job"], "completed": 0, "total": 1,
            }}, authority),
            "rejected": ({**projection, "job": {
                **projection["job"], "rejected": 1,
            }}, authority),
            "unsafe-authority-count": (projection, {**authority, "sourceAuthority": {
                **authority["sourceAuthority"], "finalizedCorpus": {
                    **authority["sourceAuthority"]["finalizedCorpus"],
                    "itemCount": (1 << 53),
                },
            }}),
            "malformed-projection": ({"redactions": "invalid", "job": None}, authority),
            "malformed-authority": (projection, {"sourceAuthority": None}),
        }
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name, responses in cases.items():
                output = root / f"{name}.json"
                with (
                    self.subTest(name=name),
                    mock.patch.object(MODULE, "request_json", side_effect=responses),
                    mock.patch.object(
                        MODULE, "local_viewer_opener", return_value=mock.sentinel.opener,
                    ),
                    self.assertRaisesRegex(
                        SystemExit, f"^{re.escape(MODULE.SOURCE_PRIVACY_EXPORT_INVALID)}$",
                    ),
                ):
                    MODULE.export_source_privacy_projection(
                        "http://127.0.0.1:3210", "run-1", output,
                    )
                self.assertFalse(output.exists())

    def test_source_privacy_export_is_no_clobber_and_validates_loopback_before_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "source-privacy.json"
            output.write_bytes(b"owner bytes")
            with (
                mock.patch.object(MODULE, "request_json") as request,
                self.assertRaisesRegex(
                    SystemExit, f"^{re.escape(MODULE.SOURCE_PRIVACY_EXPORT_EXISTS)}$",
                ),
            ):
                MODULE.export_source_privacy_projection(
                    "http://127.0.0.1:3210", "run-1", output,
                )
            request.assert_not_called()
            self.assertEqual(output.read_bytes(), b"owner bytes")

        with mock.patch.object(MODULE, "_json_export_path") as export_path:
            with self.assertRaisesRegex(SystemExit, "VIEWER_ORIGIN_INVALID"):
                MODULE.export_source_privacy_projection(
                    "http://127.0.0.1:3210@example.com:80",
                    "run-1",
                    Path("PRIVATE_SENTINEL.json"),
                )
        export_path.assert_not_called()

    def test_source_privacy_export_cli_is_one_attach_only_mode(self):
        destination = Path("current-public-source-privacy.json")
        with (
            mock.patch.object(sys, "argv", [
                "run_local_review.py",
                "--attach-url", "http://127.0.0.1:3210",
                "--workflow-run-id", "run-1",
                "--source-privacy-export", str(destination),
            ]),
            mock.patch.object(MODULE, "export_source_privacy_projection") as exported,
        ):
            MODULE.main()
        exported.assert_called_once_with(
            "http://127.0.0.1:3210", "run-1", destination,
        )

    def test_story_privacy_opener_has_no_proxy_redirect_or_ambient_cookie_authority(self):
        opener = MODULE.local_viewer_opener()
        proxy_handlers = [handler for handler in opener.handlers
                          if isinstance(handler, MODULE.urllib.request.ProxyHandler)]
        redirect_handlers = [handler for handler in opener.handlers
                             if isinstance(handler, MODULE._NoLocalViewerRedirect)]
        cookie_handlers = [handler for handler in opener.handlers
                           if isinstance(handler, MODULE.urllib.request.HTTPCookieProcessor)]
        # An inert ProxyHandler({}) suppresses urllib's environment-derived default
        # and is intentionally omitted from the installed handler list.
        self.assertEqual(proxy_handlers, [])
        self.assertEqual(len(redirect_handlers), 1)
        self.assertEqual(len(cookie_handlers), 1)
        self.assertEqual(list(cookie_handlers[0].cookiejar), [])

    def test_attach_verifies_stable_workflow_run_before_import(self):
        order = []
        with (
            mock.patch.object(MODULE, "request_json", return_value={"workflowRunId": "run-1"}),
            mock.patch.object(
                MODULE,
                "finalized_semantic_manifest",
                side_effect=lambda _run: order.append("semantic") or {"revision": 1},
            ) as semantic,
            mock.patch.object(
                MODULE,
                "import_run",
                side_effect=lambda *_args: order.append("corpus") or (2, 9),
            ) as imported,
            mock.patch.object(
                MODULE,
                "complete_organization",
                side_effect=lambda *_args: order.append("organization") or {"status": "complete"},
            ) as organization,
            mock.patch("builtins.print"),
        ):
            MODULE.attach_run("http://127.0.0.1:3298", "run-1", Path("reviewed run"))
        semantic.assert_called_once()
        imported.assert_called_once()
        organization.assert_called_once()
        self.assertEqual(order, ["semantic", "corpus", "organization"])

    def test_collection_only_attach_finalizes_corpus_without_semantic_or_organization_access(self):
        with (
            mock.patch.object(MODULE, "request_json", return_value={"workflowRunId": "run-1"}),
            mock.patch.object(MODULE, "finalized_semantic_manifest") as semantic,
            mock.patch.object(MODULE, "import_run", return_value=(2, 9)) as imported,
            mock.patch.object(MODULE, "complete_organization") as organization,
            mock.patch("builtins.print") as printed,
        ):
            MODULE.attach_run(
                "http://127.0.0.1:3298",
                "run-1",
                Path("collected run"),
                collection_only=True,
            )
        semantic.assert_not_called()
        imported.assert_called_once()
        organization.assert_not_called()
        self.assertEqual(json.loads(printed.call_args.args[0])["collection"], "finalized")

    def test_collection_only_cli_uses_the_existing_attach_path(self):
        run = Path("collected-run")
        with (
            mock.patch.object(sys, "argv", [
                "run_local_review.py", str(run),
                "--attach-url", "http://127.0.0.1:3298",
                "--workflow-run-id", "run-1",
                "--collection-only",
            ]),
            mock.patch.object(MODULE, "locate_inputs"),
            mock.patch.object(MODULE, "attach_run") as attached,
        ):
            MODULE.main()
        attached.assert_called_once_with(
            "http://127.0.0.1:3298",
            "run-1",
            run.resolve(),
            collection_only=True,
        )

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
                '{"schema":"oxygen.trajectory-event","event_id":"changed","event_type":"message"}\n',
                encoding="utf-8",
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

    def test_story_ready_imports_exact_preference_bundle_before_activation(self):
        coverage_manifest = {"revision": 1, "coverageDigest": "a" * 64}
        story_candidates = [{"id": "doc:item-1", "summary": "oxygen.story:{}"}]
        preference_bundle, preparation_manifest = ready_authority()
        with (
            mock.patch.object(MODULE, "request_json", side_effect=[
                {"imported": 1, "bulkImported": 0},
                {"currentStageId": "review", "storyGenerationStatus": "ready_for_human_review",
                 "requiresHumanAction": True},
            ]) as request,
            mock.patch("builtins.print") as printed,
        ):
            result = MODULE.update_story_workflow(
                "http://127.0.0.1:3298", "run-1", "ready",
                coverage_manifest=coverage_manifest,
                story_candidates=story_candidates,
                preference_bundle=preference_bundle,
                preparation_manifest=preparation_manifest,
            )
        self.assertEqual(request.call_args_list[0], mock.call(
            mock.ANY, "http://127.0.0.1:3298/api/probes", method="POST", body=preference_bundle))
        self.assertEqual(request.call_args_list[1], mock.call(
            mock.ANY, "http://127.0.0.1:3298/api/workflow", method="POST", body={
                "workflowRunId": "run-1", "event": "story_ready_for_human_review",
                "coverageManifest": coverage_manifest, "storyCandidates": story_candidates,
                "preparationManifest": preparation_manifest,
            }))
        self.assertEqual(result["viewer"], "http://127.0.0.1:3298")
        self.assertEqual(result["handoff_state"], "WAITING_FOR_HUMAN_STORY_REVIEW")
        self.assertFalse(result["password_required"])
        self.assertTrue(result["pause_for_human_review"])
        serialized = printed.call_args.args[0]
        self.assertNotIn("story_payload", serialized)
        self.assertNotIn("evidence_payload", serialized)

    def test_story_ready_requires_the_exact_persisted_human_boundary(self):
        preference_bundle, preparation_manifest = ready_authority()
        with (
            mock.patch.object(MODULE, "request_json", side_effect=[
                {"imported": 1, "bulkImported": 0},
                {"currentStageId": "story", "storyGenerationStatus": "running",
                 "requiresHumanAction": False},
            ]),
            mock.patch("builtins.print") as printed,
        ):
            with self.assertRaisesRegex(SystemExit, "human Story review boundary"):
                MODULE.update_story_workflow(
                    "http://127.0.0.1:3298", "run-1", "ready",
                    coverage_manifest={"revision": 1},
                    story_candidates=[{"id": "doc:item-1", "summary": "oxygen.story:{}"}],
                    preference_bundle=preference_bundle,
                    preparation_manifest=preparation_manifest,
                )
        printed.assert_not_called()

    def test_failed_preference_import_prevents_activation_and_completed_zero_is_valid(self):
        preference_bundle, preparation_manifest = ready_authority(probes=[])
        with mock.patch.object(MODULE, "request_json", return_value={"imported": 0, "bulkImported": 1}) as request:
            with self.assertRaisesRegex(SystemExit, "did not import"):
                MODULE.update_story_workflow(
                    "http://127.0.0.1:3298", "run-1", "ready",
                    coverage_manifest={}, story_candidates=[{"id": "doc:item-1"}],
                    preference_bundle=preference_bundle, preparation_manifest=preparation_manifest,
                )
        request.assert_called_once_with(
            mock.ANY, "http://127.0.0.1:3298/api/probes", method="POST", body=preference_bundle)

        with (
            mock.patch.object(MODULE, "request_json", side_effect=[
                {"imported": 0, "bulkImported": 0},
                {"currentStageId": "review", "storyGenerationStatus": "ready_for_human_review",
                 "requiresHumanAction": True},
            ]) as request,
            mock.patch("builtins.print"),
        ):
            MODULE.update_story_workflow(
                "http://127.0.0.1:3298", "run-1", "ready",
                coverage_manifest={}, story_candidates=[{"id": "doc:item-1"}],
                preference_bundle=preference_bundle, preparation_manifest=preparation_manifest,
            )
        self.assertEqual(len(request.call_args_list), 2)

    def test_http_failed_preference_import_prevents_workflow_activation(self):
        preference_bundle, preparation_manifest = ready_authority()
        with (
            mock.patch.object(
                MODULE,
                "request_json",
                side_effect=SystemExit(MODULE.VIEWER_WORKFLOW_BLOCKERS[409]),
            ) as request,
            mock.patch("builtins.print") as printed,
        ):
            with self.assertRaisesRegex(SystemExit, "VIEWER_WORKFLOW_BLOCKED_HTTP_409"):
                MODULE.update_story_workflow(
                    "http://127.0.0.1:3298",
                    "run-1",
                    "ready",
                    coverage_manifest={},
                    story_candidates=[{"id": "doc:item-1"}],
                    preference_bundle=preference_bundle,
                    preparation_manifest=preparation_manifest,
                )
        request.assert_called_once_with(
            mock.ANY,
            "http://127.0.0.1:3298/api/probes",
            method="POST",
            body=preference_bundle,
        )
        printed.assert_not_called()

    def test_failed_ready_transition_stops_after_import_without_success_output(self):
        preference_bundle, preparation_manifest = ready_authority()
        with (
            mock.patch.object(
                MODULE,
                "request_json",
                side_effect=[
                    {"imported": 1, "bulkImported": 0},
                    SystemExit(MODULE.VIEWER_WORKFLOW_BLOCKERS[409]),
                ],
            ) as request,
            mock.patch("builtins.print") as printed,
        ):
            with self.assertRaisesRegex(SystemExit, "VIEWER_WORKFLOW_BLOCKED_HTTP_409"):
                MODULE.update_story_workflow(
                    "http://127.0.0.1:3298",
                    "run-1",
                    "ready",
                    coverage_manifest={},
                    story_candidates=[{"id": "doc:item-1"}],
                    preference_bundle=preference_bundle,
                    preparation_manifest=preparation_manifest,
                )
        self.assertEqual(
            [call.args[1] for call in request.call_args_list],
            [
                "http://127.0.0.1:3298/api/probes",
                "http://127.0.0.1:3298/api/workflow",
            ],
        )
        printed.assert_not_called()

    def test_failed_blocked_transition_stops_without_success_output(self):
        with (
            mock.patch.object(
                MODULE,
                "request_json",
                side_effect=SystemExit(MODULE.VIEWER_WORKFLOW_BLOCKERS[409]),
            ) as request,
            mock.patch("builtins.print") as printed,
        ):
            with self.assertRaisesRegex(SystemExit, "VIEWER_WORKFLOW_BLOCKED_HTTP_409"):
                MODULE.update_story_workflow(
                    "http://127.0.0.1:3298", "run-1", "blocked"
                )
        request.assert_called_once_with(
            mock.ANY,
            "http://127.0.0.1:3298/api/workflow",
            method="POST",
            body={"workflowRunId": "run-1", "event": "story_generation_blocked"},
        )
        printed.assert_not_called()

    def test_story_ready_accepts_exact_nonempty_counter_partitions(self):
        cases = (
            ([preference_probe()], [], {"imported": 1, "bulkImported": 0}),
            ([], [bulk_decision()], {"imported": 0, "bulkImported": 1}),
            ([preference_probe()], [bulk_decision()], {"imported": 1, "bulkImported": 1}),
        )
        for probes, bulk_decisions, import_result in cases:
            with self.subTest(import_result=import_result):
                preference_bundle, preparation_manifest = ready_authority(
                    probes=probes, bulk_decisions=bulk_decisions
                )
                if probes and bulk_decisions:
                    preference_bundle["autoRemoved"] = {
                        "total": 2, "reversible": True,
                        "categories": [
                            {"kind": "credential", "count": 1},
                            {"kind": "sensitive", "count": 1},
                        ],
                    }
                with (
                    mock.patch.object(MODULE, "request_json", side_effect=[
                        import_result,
                        {"currentStageId": "review", "storyGenerationStatus": "ready_for_human_review",
                         "requiresHumanAction": True},
                    ]) as request,
                    mock.patch("builtins.print"),
                ):
                    MODULE.update_story_workflow(
                        "http://127.0.0.1:3298", "run-1", "ready",
                        coverage_manifest={}, story_candidates=[{"id": "doc:item-1"}],
                        preference_bundle=preference_bundle, preparation_manifest=preparation_manifest,
                    )
                self.assertEqual(request.call_args_list[0], mock.call(
                    mock.ANY, "http://127.0.0.1:3298/api/probes", method="POST",
                    body=preference_bundle,
                ))
                self.assertEqual(request.call_args_list[1].args[1], "http://127.0.0.1:3298/api/workflow")

    def test_story_ready_rejects_mismatched_import_counters_before_activation(self):
        preference_bundle, preparation_manifest = ready_authority(
            probes=[preference_probe()], bulk_decisions=[bulk_decision()]
        )
        for result in (
            {"imported": 2, "bulkImported": 0},
            {"imported": 1, "bulkImported": 0},
            {"imported": True, "bulkImported": 1},
            [],
        ):
            with self.subTest(result=result), mock.patch.object(
                MODULE, "request_json", return_value=result
            ) as request:
                with self.assertRaisesRegex(SystemExit, "did not import"):
                    MODULE.update_story_workflow(
                        "http://127.0.0.1:3298", "run-1", "ready",
                        coverage_manifest={}, story_candidates=[{"id": "doc:item-1"}],
                        preference_bundle=preference_bundle, preparation_manifest=preparation_manifest,
                    )
                request.assert_called_once_with(
                    mock.ANY, "http://127.0.0.1:3298/api/probes", method="POST",
                    body=preference_bundle,
                )

    def test_ready_authority_rejects_malformed_auto_removed_before_http(self):
        malformed = (
            [],
            {"total": 0, "reversible": True},
            {"total": 0, "reversible": True, "categories": [], "unexpected": True},
            {"total": 0, "reversible": False, "categories": []},
            {"total": 1, "reversible": True, "categories": []},
            {"total": 1, "reversible": True, "categories": [{"kind": "unknown", "count": 1}]},
            {"total": 1, "reversible": True, "categories": [{"kind": "user_path", "count": 1}]},
            {"total": 1, "reversible": True, "categories": [{"kind": "third_party_contact", "count": 1}]},
            {"total": 1, "reversible": True, "categories": [{"kind": [], "count": 1}]},
            {"total": 2, "reversible": True, "categories": [
                {"kind": "sensitive", "count": 1}, {"kind": "credential", "count": 1},
            ]},
            {"total": 2, "reversible": True, "categories": [
                {"kind": "credential", "count": 1}, {"kind": "credential", "count": 1},
            ]},
            {"total": 1, "reversible": True, "categories": [{"kind": "credential", "count": True}]},
        )
        for auto_removed in malformed:
            with self.subTest(auto_removed=auto_removed):
                preference_bundle, preparation_manifest = ready_authority()
                preference_bundle["autoRemoved"] = auto_removed
                with mock.patch.object(MODULE, "request_json") as request:
                    with self.assertRaisesRegex(SystemExit, "Preference bundle authority is invalid"):
                        MODULE.update_story_workflow(
                            "http://127.0.0.1:3298", "run-1", "ready",
                            coverage_manifest={}, story_candidates=[{"id": "doc:item-1"}],
                            preference_bundle=preference_bundle,
                            preparation_manifest=preparation_manifest,
                        )
                request.assert_not_called()

    def test_ready_authority_rejects_identity_revision_and_receipt_mismatches_before_http(self):
        preference_bundle, preparation_manifest = ready_authority()
        for mutate in (
            lambda: preference_bundle.__setitem__("workflowRunId", "foreign"),
            lambda: preparation_manifest.__setitem__("sourceRevision", 8),
            lambda: preparation_manifest["receipts"][3].__setitem__("outputDigest", "f" * 64),
        ):
            preference_bundle, preparation_manifest = ready_authority()
            mutate()
            with mock.patch.object(MODULE, "request_json") as request:
                with self.assertRaises(SystemExit):
                    MODULE.update_story_workflow(
                        "http://127.0.0.1:3298", "run-1", "ready", coverage_manifest={},
                        story_candidates=[{"id": "doc:item-1"}], preference_bundle=preference_bundle,
                        preparation_manifest=preparation_manifest)
            request.assert_not_called()

    def test_story_ready_rejects_zero_source_revisions_before_http(self):
        unsafe = (1 << 53)
        for preference_revision, preparation_revision, message in (
            (0, 0, "Preference bundle authority is invalid"),
            (7, 0, "Story preparation authority is invalid"),
            (unsafe, unsafe, "Preference bundle authority is invalid"),
            (7, unsafe, "Story preparation authority is invalid"),
        ):
            with self.subTest(
                preference_revision=preference_revision,
                preparation_revision=preparation_revision,
            ):
                preference_bundle, preparation_manifest = ready_authority(probes=[])
                preference_bundle["sourceRevision"] = preference_revision
                preparation_manifest["sourceRevision"] = preparation_revision
                with mock.patch.object(MODULE, "request_json") as request:
                    with self.assertRaisesRegex(SystemExit, message):
                        MODULE.update_story_workflow(
                            "http://127.0.0.1:3298",
                            "run-1",
                            "ready",
                            coverage_manifest={},
                            story_candidates=[{"id": "doc:item-1"}],
                            preference_bundle=preference_bundle,
                            preparation_manifest=preparation_manifest,
                        )
                request.assert_not_called()

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
            "http://127.0.0.1:3298", "run-1", "started", None, None, None, None, None, None
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
            "http://127.0.0.1:3298", "run-1", "progress", 4, 4, None, None, None, None
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
            preference_bundle, preparation_manifest = ready_authority()
            coverage_path = root / "story-coverage-manifest.json"
            candidates_path = root / "story-candidates.json"
            preference_path = root / "preference-bundle.json"
            preparation_path = root / "story-preparation-manifest.json"
            coverage_path.write_text(json.dumps(coverage_manifest), encoding="utf-8")
            candidates_path.write_text(json.dumps(story_candidates), encoding="utf-8")
            preference_path.write_text(json.dumps(preference_bundle), encoding="utf-8")
            preparation_path.write_text(json.dumps(preparation_manifest), encoding="utf-8")

            with (
                mock.patch.object(sys, "argv", [
                    "run_local_review.py",
                    "--attach-url", "http://127.0.0.1:3298",
                    "--workflow-run-id", "run-1",
                    "--story-event", "ready",
                    "--coverage-manifest", str(coverage_path),
                    "--story-candidates", str(candidates_path),
                    "--preference-bundle", str(preference_path),
                    "--preparation-manifest", str(preparation_path),
                ]),
                mock.patch.object(MODULE, "update_story_workflow") as update,
            ):
                MODULE.main()
        update.assert_called_once_with(
            "http://127.0.0.1:3298", "run-1", "ready", None, None,
            coverage_manifest, story_candidates, preference_bundle, preparation_manifest,
        )

    def test_cli_rejects_old_two_file_ready_path_before_http(self):
        with mock.patch.object(sys, "argv", [
            "run_local_review.py", "--attach-url", "http://127.0.0.1:3298",
            "--workflow-run-id", "run-1", "--story-event", "ready",
            "--coverage-manifest", "coverage.json", "--story-candidates", "candidates.json",
        ]), mock.patch.object(MODULE, "update_story_workflow") as update:
            with self.assertRaises(SystemExit):
                MODULE.main()
        update.assert_not_called()

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

    def test_viewer_import_posts_only_current_collector_documents(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary, "run")
            current = write_trajectory(run, "traj-current")
            write_trajectory(run, "traj-foreign")
            write_index(run, [
                {"trajectory_id": "traj-current", "ok": True},
                {"trajectory_id": "traj-foreign", "ok": True,
                 "cwd_relations": ["sibling", "unrelated"]},
            ])
            trajectories, meetings = MODULE.locate_inputs(run)
            self.assertEqual(trajectories, [current.resolve()])
            self.assertEqual(meetings, [])
            with mock.patch.object(
                MODULE, "request_json", return_value=finalized_response(1, 1)
            ) as request:
                self.assertEqual(MODULE.import_run(
                    mock.sentinel.opener, "http://127.0.0.1:3298", run,
                ), (1, 1))
            documents = request.call_args.kwargs["body"]["documents"]
            self.assertEqual([item["document"]["id"] for item in documents], ["traj-current"])

    def test_unresolved_viewer_import_makes_zero_requests_and_cli_is_fixed(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary, "HOSTILE_SENTINEL-run")
            write_trajectory(run, "traj-one")
            write_index(run, [{
                "trajectory_id": "traj-one", "ok": True, "cwd_relations": ["parent"],
            }])
            self.assert_import_fails_before_request(
                run, MODULE.project_map_authority.PROJECT_MEMBERSHIP_NEEDS_USER_RESOLUTION,
            )
            result = subprocess.run([
                sys.executable, str(MODULE_PATH), str(run),
                "--attach-url", "http://127.0.0.1:9", "--workflow-run-id", "run-1",
            ], capture_output=True, text=True, encoding="utf-8", check=False)
            self.assertEqual(result.stdout, "")
            self.assertEqual(result.stderr.splitlines(), [
                MODULE.project_map_authority.PROJECT_MEMBERSHIP_NEEDS_USER_RESOLUTION,
            ])
            self.assertNotIn("HOSTILE_SENTINEL", result.stderr)
            self.assertNotIn("Traceback", result.stderr)

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

    def test_empty_index_never_falls_back_to_stale_trajectory_glob(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary, "run")
            write_trajectory(run, "traj-stale")
            write_index(run, [])

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
                 "--out", str(run), "--date", "2026-08-25"],
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

    def test_root_meeting_is_not_a_supported_input(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary, "run")
            write_unsupported_root_meeting(run)

            self.assert_import_fails_before_request(run, MODULE.INPUT_RUN_INVALID)

    def test_root_meeting_with_empty_index_fails_before_any_viewer_request(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary, "run")
            write_index(run, [])
            write_unsupported_root_meeting(run)

            self.assert_import_fails_before_request(run, MODULE.INPUT_RUN_INVALID)

    def test_true_empty_history_remains_valid(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary, "run")
            write_index(run, [])

            with mock.patch.object(
                MODULE, "request_json", return_value=finalized_response(0, 0)
            ) as request:
                self.assertEqual(
                    MODULE.import_run(
                        mock.sentinel.opener, "http://127.0.0.1:3298", run
                    ),
                    (0, 0),
                )
            self.assertEqual(request.call_args.kwargs["body"], {"documents": []})

    def test_root_meeting_with_valid_trajectory_fails_before_any_viewer_request(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary, "run")
            write_trajectory(run, "traj-alpha")
            write_index(run, [{"trajectory_id": "traj-alpha", "ok": True}])
            write_unsupported_root_meeting(run)

            self.assert_import_fails_before_request(run, MODULE.INPUT_RUN_INVALID)

    def test_root_meeting_with_plural_meetings_fails_before_any_viewer_request(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary, "run")
            write_meeting(run, "meeting-plural")
            write_unsupported_root_meeting(run)

            self.assert_import_fails_before_request(run, MODULE.INPUT_RUN_INVALID)

    def test_root_meeting_symlink_fails_before_any_viewer_request(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run = root / "run"
            write_index(run, [])
            outside = root / "outside-meeting.json"
            outside.write_text("{}", encoding="utf-8")
            symlink_or_skip(self, run / "meeting.json", outside)

            self.assert_import_fails_before_request(run, MODULE.INPUT_RUN_INVALID)

    def test_root_meeting_broken_symlink_signal_fails_before_any_viewer_request(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary, "run")
            write_index(run, [])
            symlink_or_skip(self, run / "meeting.json", run / "missing-meeting.json")

            self.assert_import_fails_before_request(run, MODULE.INPUT_RUN_INVALID)

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

    def test_payload_meeting_id_must_equal_literal_directory_before_any_viewer_request(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary, "run")
            write_meeting(run, "meeting-payload", directory_id="meeting-literal")

            self.assert_import_fails_before_request(
                run, MODULE.INPUT_MEETING_ID_INVALID
            )

    def test_contained_meeting_child_alias_fails_before_any_viewer_request(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary, "run")
            target = run / "hidden" / "real-id"
            target.mkdir(parents=True)
            (target / "meeting.json").write_text(json.dumps({
                "meeting_id": "real-id", "records": [],
            }), encoding="utf-8")
            (run / "meetings").mkdir()
            directory_link_or_skip(self, run / "meetings" / "alias-id", target)

            self.assert_import_fails_before_request(run, MODULE.INPUT_PATH_ALIAS)

    def test_meetings_root_alias_fails_before_any_viewer_request(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary, "run")
            target = run / "hidden-meetings"
            meeting = target / "meeting-one"
            meeting.mkdir(parents=True)
            (meeting / "meeting.json").write_text(json.dumps({
                "meeting_id": "meeting-one", "records": [],
            }), encoding="utf-8")
            directory_link_or_skip(self, run / "meetings", target)

            self.assert_import_fails_before_request(run, MODULE.INPUT_PATH_ALIAS)

    def test_meeting_json_alias_fails_before_any_viewer_request(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary, "run")
            directory = run / "meetings" / "meeting-one"
            directory.mkdir(parents=True)
            target = run / "hidden-meeting.json"
            target.write_text(json.dumps({
                "meeting_id": "meeting-one", "records": [],
            }), encoding="utf-8")
            file_link_or_skip(self, directory / "meeting.json", target)

            self.assert_import_fails_before_request(run, MODULE.INPUT_PATH_ALIAS)

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
            outside = write_meeting(
                root, "meeting-escape", directory_id="outside-meeting"
            ).parent
            (run / "meetings").mkdir(parents=True)
            directory_link_or_skip(self, run / "meetings" / "meeting-escape", outside)

            self.assert_import_fails_before_request(run, MODULE.INPUT_PATH_ALIAS)

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
