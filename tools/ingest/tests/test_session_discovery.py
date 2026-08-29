import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


INGEST_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INGEST_DIR))
MODULE_PATH = INGEST_DIR / "collect_repo_trajectories.py"
SPEC = importlib.util.spec_from_file_location("collect_repo_session_discovery", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


REPO = Path(r"D:\Coding Projects\O2-Intern\oxygen contributor 测试")
EXACT = str(REPO)
CHILD = EXACT + r"\viewer"
PARENT = r"D:\Coding Projects\O2-Intern"
SIBLING = r"D:\Coding Projects\O2-Intern\other-repo"


def codex_record(cwd: str) -> dict:
    return {"type": "turn_context", "payload": {"cwd": cwd}}


def codex_session_meta(cwd: str, session_id: str = "synthetic-session") -> dict:
    return {
        "timestamp": "2026-01-02T03:04:05.000Z",
        "type": "session_meta",
        "payload": {"id": session_id, "cwd": cwd},
    }


def write_jsonl(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records),
        encoding="utf-8",
    )


def tree_snapshot(root: Path) -> list[tuple[str, str, bytes | None]]:
    snapshot = []
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        snapshot.append((relative, "dir" if path.is_dir() else "file",
                         None if path.is_dir() else path.read_bytes()))
    return snapshot


def junction_or_symlink(testcase: unittest.TestCase, link: Path, target: Path):
    if os.name == "nt":
        result = subprocess.run(
            ["cmd.exe", "/d", "/c", "mklink", "/J", str(link), str(target)],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if result.returncode != 0:
            testcase.skipTest(f"directory junction unavailable: {result.stderr.strip()}")
        return lambda: os.rmdir(link)
    try:
        link.symlink_to(target, target_is_directory=True)
    except OSError as error:
        testcase.skipTest(f"directory symlink unavailable: {error}")
    return link.unlink


def hard_link_or_skip(testcase: unittest.TestCase, source: Path, target: Path) -> None:
    try:
        os.link(source, target)
    except OSError as error:
        testcase.skipTest(f"hard links unavailable: {error}")


class BoundedMetadataScanTest(unittest.TestCase):
    def test_codex_container_identity_does_not_collapse_shared_parent_thread(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = root / "first.jsonl"
            second = root / "second.jsonl"
            write_jsonl(first, [{
                "timestamp": "2026-01-02T03:04:05.000Z",
                "type": "session_meta",
                "payload": {"id": "container-a", "session_id": "shared-thread", "cwd": EXACT},
            }])
            write_jsonl(second, [{
                "timestamp": "2026-01-02T03:04:06.000Z",
                "type": "session_meta",
                "payload": {"id": "container-b", "session_id": "shared-thread", "cwd": EXACT},
            }])
            first_id = MODULE.stable_trajectory_id(first, "codex", "synthetic")
            second_id = MODULE.stable_trajectory_id(second, "codex", "synthetic")
            self.assertNotEqual(first_id, second_id)
            self.assertEqual(
                first_id,
                MODULE.stable_trajectory_id(first, "codex", "synthetic"),
            )

    def test_cwd_near_beginning_stops_early(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary, "session.jsonl")
            write_jsonl(path, [codex_record(EXACT), {"type": "response_item"}])
            scan = MODULE.session_cwds(path, "codex", REPO)
            self.assertEqual(scan.cwds, {EXACT})
            self.assertEqual(scan.records_scanned, 1)
            self.assertFalse(scan.bound_reached)

    def test_eligible_cwd_after_old_record_80_limit_is_found(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary, "session.jsonl")
            records = [{"type": "response_item", "payload": {"text": "synthetic"}}] * 96
            records.append(codex_record(CHILD))
            write_jsonl(path, records)
            scan = MODULE.session_cwds(path, "codex", REPO)
            self.assertEqual(scan.cwds, {CHILD})
            self.assertEqual(scan.records_scanned, 97)
            self.assertFalse(scan.bound_reached)

    def test_no_cwd_before_record_bound_is_reported(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary, "session.jsonl")
            write_jsonl(path, [{"type": "response_item"}] * 6)
            scan = MODULE.session_cwds(path, "codex", REPO, max_records=5, max_bytes=4096)
            self.assertFalse(scan.cwds)
            self.assertTrue(scan.bound_reached)
            self.assertEqual(scan.records_scanned, 5)

    def test_no_cwd_before_byte_bound_is_reported(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary, "session.jsonl")
            write_jsonl(path, [{"type": "response_item", "payload": {"text": "x" * 200}}])
            scan = MODULE.session_cwds(path, "codex", REPO, max_records=50, max_bytes=64)
            self.assertFalse(scan.cwds)
            self.assertTrue(scan.bound_reached)
            self.assertEqual(scan.bytes_scanned, 64)

    def test_complete_metadata_record_exactly_at_byte_bound_is_parsed(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary, "session.jsonl")
            encoded = json.dumps(codex_record(EXACT), ensure_ascii=False).encode("utf-8")
            path.write_bytes(encoded)
            scan = MODULE.session_cwds(
                path, "codex", REPO, max_records=50, max_bytes=len(encoded)
            )
            self.assertEqual(scan.cwds, {EXACT})
            self.assertFalse(scan.bound_reached)
            self.assertEqual(scan.bytes_scanned, len(encoded))

    def test_body_or_non_context_payload_mention_does_not_count(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary, "session.jsonl")
            write_jsonl(path, [{
                "type": "response_item",
                "payload": {"cwd": EXACT, "text": f"body mentions {EXACT}"},
            }])
            scan = MODULE.session_cwds(path, "codex", REPO)
            self.assertFalse(scan.cwds)

    def test_typeless_payload_cwd_does_not_count_as_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary, "session.jsonl")
            write_jsonl(path, [{"payload": {"cwd": EXACT}}])
            scan = MODULE.session_cwds(path, "codex", REPO)
            self.assertFalse(scan.cwds)


class DiscoveryContractTest(unittest.TestCase):
    def test_default_global_windows_user_store_is_discovered(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary, "User Home")
            session = home / ".codex" / "sessions" / "2026" / "08" / "21" / "exact.jsonl"
            write_jsonl(session, [codex_record(EXACT)])
            stats = MODULE.DiscoveryStats("codex", home / ".codex" / "sessions")
            matches = MODULE.find_codex_sessions(home, REPO, diagnostics=stats)
            self.assertEqual(matches, [session.resolve()])
            self.assertEqual(stats.exact, 1)
            self.assertEqual(stats.matched, 1)

    def test_repo_local_codex_store_alone_is_not_default_discovery(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = root / "user-home"
            repo = root / "repo with spaces"
            repo.mkdir()
            write_jsonl(repo / ".codex" / "sessions" / "local.jsonl", [codex_record(str(repo))])
            self.assertEqual(MODULE.find_codex_sessions(home, repo), [])

    def test_explicit_session_root_is_the_approved_boundary(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = root / "user-home"
            approved = root / "semantic project" / ".codex" / "sessions"
            session = approved / "2026" / "01" / "parent-cwd.jsonl"
            write_jsonl(session, [codex_session_meta(PARENT), codex_record(PARENT)])
            stats = MODULE.DiscoveryStats("codex", approved)

            matches = MODULE.find_codex_sessions(
                home, REPO, session_root=approved, diagnostics=stats
            )

            self.assertEqual(matches, [session.resolve()])
            self.assertEqual(stats.parent, 1)
            self.assertEqual(stats.matched, 0)
            self.assertEqual(stats.approved_root_selected, 1)

    def test_explicit_session_root_skips_non_session_jsonl_and_siblings(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = root / "user-home"
            approved = root / "approved" / "sessions"
            valid = approved / "valid.jsonl"
            invalid = approved / "work" / "events.jsonl"
            outside = root / "sibling" / "outside.jsonl"
            write_jsonl(valid, [codex_session_meta(PARENT)])
            write_jsonl(invalid, [codex_record(PARENT)])
            write_jsonl(outside, [codex_session_meta(PARENT, "outside")])

            matches = MODULE.find_codex_sessions(home, REPO, session_root=approved)

            self.assertEqual(matches, [valid.resolve()])

    def test_exact_child_parent_sibling_and_unrelated_are_distinct(self):
        expected = {
            EXACT: "exact",
            CHILD: "child",
            PARENT: "parent",
            SIBLING: "sibling",
            r"C:\unrelated": "unrelated",
        }
        for cwd, relation in expected.items():
            with self.subTest(cwd=cwd):
                self.assertEqual(MODULE.cwd_relation(cwd, REPO), relation)
        self.assertTrue(MODULE.is_inside(EXACT, REPO))
        self.assertTrue(MODULE.is_inside(CHILD, REPO))
        self.assertFalse(MODULE.is_inside(PARENT, REPO))
        self.assertFalse(MODULE.is_inside(SIBLING, REPO))

    def test_absolute_posix_exact_and_child_paths_remain_scoped(self):
        repo = "/home/synthetic user/oxygen 测试"
        self.assertTrue(MODULE.is_inside(repo, repo))
        self.assertTrue(MODULE.is_inside(f"{repo}/viewer", repo))
        self.assertFalse(MODULE.is_inside("/home/synthetic user", repo))
        self.assertFalse(MODULE.is_inside("/home/synthetic user/sibling", repo))

    def test_relative_session_metadata_never_uses_process_cwd(self):
        values = (
            "",
            ".",
            r".\viewer",
            "./viewer",
            "viewer",
            "..",
            r"..\repo",
            "../repo",
            "~",
            "~/repo",
            r"~\repo",
            r"\repo",
            "D:repo",
            "C:viewer",
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = root / "target repo"
            repo.mkdir()
            home = root / "synthetic home"
            session = home / ".codex" / "sessions" / "relative.jsonl"
            write_jsonl(session, [codex_record(value) for value in values])
            previous = Path.cwd()
            os.chdir(repo)
            try:
                self.assertEqual(MODULE.find_codex_sessions(home, repo), [])
                for value in values:
                    with self.subTest(value=value):
                        self.assertFalse(MODULE.is_inside(value, repo))
                        self.assertEqual(MODULE.cwd_relation(value, repo), "missing_unparseable")
            finally:
                os.chdir(previous)

    def test_case_slash_dot_and_spaces_remain_normalized(self):
        variant = r"d:/CODING PROJECTS/O2-INTERN/oxygen contributor 测试/.\viewer\..\viewer"
        self.assertTrue(MODULE.is_inside(variant, REPO))

    def test_diagnostics_separate_scope_and_limit_counts(self):
        stats = MODULE.DiscoveryStats("codex", Path(r"C:\Users\synthetic\.codex\sessions"))
        for cwd in (EXACT, CHILD, PARENT, SIBLING, r"C:\elsewhere"):
            stats.add(MODULE.SessionCwdScan(cwds={cwd}), REPO)
        stats.add(MODULE.SessionCwdScan(bound_reached=True), REPO)
        summary = stats.as_dict()
        self.assertEqual(summary["cwd_scope"], {
            "exact": 1,
            "child": 1,
            "parent": 1,
            "sibling": 1,
            "unrelated": 1,
            "missing_unparseable": 1,
        })
        self.assertEqual(summary["limit_reached_without_cwd"], 1)
        self.assertEqual(summary["matched"], 2)


class CollectorMainBoundaryTest(unittest.TestCase):
    def test_output_root_junction_fails_before_touching_external_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = root / "repo"
            repo.mkdir()
            external = root / "external"
            external.mkdir()
            (external / "sentinel.bin").write_bytes(b"junction sentinel\x00")
            before = tree_snapshot(external)
            redirected_parent = root / "redirected-parent"
            cleanup = junction_or_symlink(self, redirected_parent, external)
            requested = redirected_parent / "requested-run"
            try:
                with self.assertRaises(SystemExit):
                    MODULE.main([str(repo), "--out", str(requested)])
                self.assertEqual(tree_snapshot(external), before)
            finally:
                cleanup()

    def test_hard_linked_collector_index_fails_before_any_mutation(self):
        artifacts = (
            Path("index.json"),
            Path("trajectories/traj-hard/events.jsonl"),
            Path("trajectories/traj-hard/manifest.json"),
            Path("memory/repo/notes.md"),
        )
        for artifact in artifacts:
            with self.subTest(artifact=artifact), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                repo = root / "repo"
                repo.mkdir()
                external = root / "external-artifact"
                external.write_bytes(b"hard-link sentinel\x00")
                out = root / "run"
                target = out / artifact
                target.parent.mkdir(parents=True)
                hard_link_or_skip(self, external, target)
                if artifact != Path("index.json"):
                    (out / "index.json").write_text(
                        '{"tool":"collect_repo_trajectories"}\n', encoding="utf-8"
                    )
                before_out = tree_snapshot(out)
                before_external = external.read_bytes()

                with self.assertRaises(SystemExit):
                    MODULE.main([str(repo), "--out", str(out)])

                self.assertEqual(external.read_bytes(), before_external)
                self.assertEqual(tree_snapshot(out), before_out)

    def test_writable_historical_shared_location_is_unchanged(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = root / "repo"
            home = root / "home"
            out = root / "run"
            repo.mkdir()
            shared = root.joinpath("srv", "shared", "oxygen", "data", "ingest" + "-staging")
            (shared / "existing-run").mkdir(parents=True)
            (shared / "existing-run" / "events.jsonl").write_bytes(b"private\x00trajectory")
            (shared / "INBOX.md").write_bytes(b"existing inbox\n")
            before = tree_snapshot(shared)

            with mock.patch("builtins.print"):
                result = MODULE.main([
                    str(repo), "--out", str(out), "--home", str(home),
                    "--agents", "", "--user", "synthetic",
                ])

            self.assertEqual(result, 0)
            self.assertTrue((out / "index.json").is_file())
            self.assertEqual(tree_snapshot(shared), before)

    def test_output_is_required_before_collection(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary, "repo")
            repo.mkdir()
            with self.assertRaises(SystemExit):
                MODULE.main([str(repo)])

    def test_rerun_prunes_only_stale_derived_trajectory_directories(self):
        with tempfile.TemporaryDirectory() as temporary:
            out = Path(temporary, "collector-output")
            trajectories = out / "trajectories"
            current = trajectories / "traj-current"
            stale = trajectories / "traj-stale"
            current.mkdir(parents=True)
            stale.mkdir()
            (current / "events.jsonl").write_text("current\n", encoding="utf-8")
            (stale / "events.jsonl").write_text("stale\n", encoding="utf-8")
            (out / "index.json").write_text(json.dumps({
                "schema": MODULE.INGEST_RUN_SCHEMA,
                "tool": "collect_repo_trajectories",
                "collection_status": "complete",
                "trajectory_count": 2,
                "trajectory_failures": 0,
                "trajectories": [
                    {"trajectory_id": "traj-current", "ok": True},
                    {"trajectory_id": "traj-stale", "ok": True},
                ],
            }), encoding="utf-8")

            self.assertTrue(MODULE.validate_rerunnable_output(out))
            self.assertEqual(
                MODULE.prune_stale_trajectory_outputs(out, {"traj-current"}), 1,
            )
            self.assertTrue((current / "events.jsonl").is_file())
            self.assertFalse(stale.exists())

    def test_failed_same_identity_rerun_removes_previous_success(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = root / "home"
            repo = root / "repo"
            out = root / "collector-output"
            repo.mkdir()
            session = home / ".codex" / "sessions" / "same.jsonl"
            write_jsonl(session, [codex_session_meta(str(repo), "same")])
            previous = out / "trajectories" / "traj-same"
            previous.mkdir(parents=True)
            (previous / "events.jsonl").write_bytes(b"previous successful bytes\n")
            (out / "index.json").write_text(json.dumps({
                "schema": MODULE.INGEST_RUN_SCHEMA,
                "tool": "collect_repo_trajectories",
                "collection_status": "complete",
                "trajectory_count": 1,
                "trajectory_failures": 0,
                "trajectories": [{"trajectory_id": "traj-same", "ok": True}],
            }), encoding="utf-8")

            def failed_extract(*_args):
                return {
                    "trajectory_id": "traj-same",
                    "system": "codex",
                    "source_session": str(session),
                    "source_sha256_prefix": "synthetic",
                    "ok": False,
                    "error": "synthetic failure",
                }

            with (
                mock.patch.object(MODULE, "extract", side_effect=failed_extract),
                mock.patch("builtins.print"),
            ):
                result = MODULE.main([
                    str(repo), "--home", str(home), "--out", str(out),
                    "--agents", "codex", "--user", "synthetic",
                ])

            self.assertEqual(result, 1)
            self.assertFalse(previous.exists())
            index = json.loads((out / "index.json").read_text(encoding="utf-8"))
            self.assertEqual(index["trajectory_failures"], 1)
            self.assertEqual(index["trajectories"][0]["trajectory_id"], "traj-same")
            self.assertIs(index["trajectories"][0]["ok"], False)

    def test_interrupted_rerun_invalidates_old_index_before_trajectory_mutation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = root / "home"
            repo = root / "repo"
            out = root / "collector-output"
            repo.mkdir()
            session = home / ".codex" / "sessions" / "same.jsonl"
            write_jsonl(session, [codex_session_meta(str(repo), "same")])
            previous = out / "trajectories" / "traj-same"
            previous.mkdir(parents=True)
            (previous / "events.jsonl").write_bytes(b"previous successful bytes\n")
            (out / "index.json").write_text(json.dumps({
                "schema": MODULE.INGEST_RUN_SCHEMA,
                "tool": "collect_repo_trajectories",
                "collection_status": "complete",
                "trajectory_count": 1,
                "trajectory_failures": 0,
                "trajectories": [{"trajectory_id": "traj-same", "ok": True}],
            }), encoding="utf-8")

            def interrupted_extract(*_args):
                current = json.loads((out / "index.json").read_text(encoding="utf-8"))
                self.assertEqual(current["collection_status"], "in_progress")
                self.assertEqual(current["trajectory_failures"], 1)
                self.assertEqual(current["trajectories"], [])
                raise RuntimeError("synthetic interruption")

            with (
                mock.patch.object(MODULE, "extract", side_effect=interrupted_extract),
                mock.patch("builtins.print"),
                self.assertRaisesRegex(RuntimeError, "synthetic interruption"),
            ):
                MODULE.main([
                    str(repo), "--home", str(home), "--out", str(out),
                    "--agents", "codex", "--user", "synthetic",
                ])

            self.assertEqual(
                (previous / "events.jsonl").read_bytes(),
                b"previous successful bytes\n",
            )
            current = json.loads((out / "index.json").read_text(encoding="utf-8"))
            self.assertEqual(current["collection_status"], "in_progress")
            self.assertEqual(current["trajectory_failures"], 1)
            self.assertTrue(MODULE.validate_rerunnable_output(out))

    def test_nonempty_unidentified_output_is_never_cleaned_as_a_rerun(self):
        with tempfile.TemporaryDirectory() as temporary:
            out = Path(temporary, "unowned-output")
            out.mkdir()
            (out / "preserve.txt").write_text("preserve\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "not an identified collector run"):
                MODULE.validate_rerunnable_output(out)
            self.assertEqual((out / "preserve.txt").read_text(encoding="utf-8"), "preserve\n")

    def test_cli_keeps_cwd_filtering_and_excludes_global_memory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = root / "home"
            repo = root / "target"
            out = root / "out"
            repo.mkdir()
            exact = home / ".codex" / "sessions" / "exact.jsonl"
            unrelated = home / ".codex" / "sessions" / "unrelated.jsonl"
            write_jsonl(exact, [codex_session_meta(str(repo), "exact")])
            write_jsonl(unrelated, [codex_session_meta(str(root / "other"), "unrelated")])
            (home / ".codex" / "AGENTS.md").write_text("global", encoding="utf-8")
            (repo / "AGENTS.md").write_text("project", encoding="utf-8")

            def fake_extract(session, system, out_root, source_home, user, semantic_source_registry, claimed_trajectory_ids):
                return {
                    "trajectory_id": session.stem,
                    "system": system,
                    "source_session": str(session),
                    "source_sha256_prefix": "synthetic",
                    "ok": True,
                }

            with (
                mock.patch.object(MODULE, "extract", side_effect=fake_extract) as extracted,
                mock.patch("builtins.print"),
            ):
                result = MODULE.main([
                    str(repo), "--home", str(home), "--out", str(out),
                    "--agents", "codex", "--user", "synthetic",
                ])

            self.assertEqual(result, 0)
            self.assertEqual([call.args[0] for call in extracted.call_args_list], [exact.resolve()])
            self.assertEqual([call.args[3] for call in extracted.call_args_list], [home.resolve()])
            index = json.loads((out / "index.json").read_text(encoding="utf-8"))
            discovery = index["session_discovery"]["codex"]
            self.assertEqual(discovery["files_scanned"], 2)
            self.assertEqual(discovery["matched"], 1)
            self.assertEqual(discovery["approved_root_selected"], 0)
            self.assertEqual(index["memory_file_count"], 1)
            self.assertEqual(
                [entry["source"] for entry in index["memory"]],
                [str((repo / "AGENTS.md").resolve())],
            )

    def test_explicit_source_home_is_independent_from_isolated_discovery_home(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            discovery_home = root / "isolated-discovery-home"
            source_home = root / "source-home"
            repo = root / "target"
            session_root = root / "approved-sessions"
            out = root / "out"
            repo.mkdir()
            source_home.mkdir()
            session = session_root / "approved.jsonl"
            write_jsonl(session, [codex_session_meta(str(repo), "approved")])

            def fake_extract(session_path, system, out_root, masking_home, user, semantic_source_registry, claimed_trajectory_ids):
                return {
                    "trajectory_id": session_path.stem,
                    "system": system,
                    "source_session": str(session_path),
                    "source_sha256_prefix": "synthetic",
                    "ok": True,
                }

            with (
                mock.patch.object(MODULE, "extract", side_effect=fake_extract) as extracted,
                mock.patch("builtins.print"),
            ):
                result = MODULE.main([
                    str(repo), "--home", str(discovery_home),
                    "--source-home", str(source_home),
                    "--codex-session-root", str(session_root),
                    "--out", str(out), "--agents", "codex", "--user", "synthetic",
                ])

            self.assertEqual(result, 0)
            self.assertEqual([call.args[0] for call in extracted.call_args_list], [session.resolve()])
            self.assertEqual([call.args[3] for call in extracted.call_args_list], [source_home.resolve()])

    def test_missing_explicit_source_home_fails_before_session_extraction(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = root / "target"
            session_root = root / "approved-sessions"
            out = root / "out"
            repo.mkdir()
            write_jsonl(
                session_root / "approved.jsonl",
                [codex_session_meta(str(repo), "approved")],
            )

            with (
                mock.patch.object(MODULE, "extract") as extracted,
                mock.patch("builtins.print"),
                self.assertRaises(SystemExit) as raised,
            ):
                MODULE.main([
                    str(repo), "--home", str(root / "isolated-discovery-home"),
                    "--source-home", str(root / "missing-source-home"),
                    "--codex-session-root", str(session_root),
                    "--out", str(out), "--agents", "codex", "--user", "synthetic",
                ])

            self.assertEqual(raised.exception.code, 1)
            extracted.assert_not_called()


class WorkflowProgressReporterTest(unittest.TestCase):
    def test_progress_origin_is_strictly_loopback(self):
        self.assertEqual(
            MODULE.normalize_progress_url("http://127.0.0.1:3298/"),
            "http://127.0.0.1:3298",
        )
        for value in (
            "https://127.0.0.1:3298",
            "http://example.com:3298",
            "http://127.0.0.1:3298/api/workflow",
        ):
            with self.subTest(value=value), self.assertRaises(ValueError):
                MODULE.normalize_progress_url(value)

    def test_progress_payload_contains_only_fixed_operational_fields(self):
        response = mock.MagicMock()
        response.status = 200
        response.__enter__.return_value = response
        reporter = MODULE.WorkflowProgressReporter("http://127.0.0.1:3298", "run-1")
        with mock.patch.object(MODULE.urllib.request, "urlopen", return_value=response) as opened:
            reporter.post("collection_progress", completed=2, total=5)
        request = opened.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:3298/api/workflow")
        self.assertEqual(json.loads(request.data), {
            "workflowRunId": "run-1",
            "event": "collection_progress",
            "completed": 2,
            "total": 5,
        })

    def test_progress_lifecycle_is_terminal_and_counted(self):
        reporter = MODULE.WorkflowProgressReporter("http://localhost:3298", "run-1")
        with (
            mock.patch.object(reporter, "post") as post,
            mock.patch.object(MODULE.atexit, "register"),
            mock.patch.object(MODULE.atexit, "unregister"),
        ):
            reporter.start()
            reporter.update(3, 5)
            reporter.finish()
        self.assertEqual([call.args[0] for call in post.call_args_list], [
            "collection_started", "collection_progress", "collection_completed",
        ])
        self.assertFalse(reporter.active)


if __name__ == "__main__":
    unittest.main()
