import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest


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


def write_jsonl(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records),
        encoding="utf-8",
    )


class BoundedMetadataScanTest(unittest.TestCase):
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
            self.assertEqual(matches, [session])
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


if __name__ == "__main__":
    unittest.main()
