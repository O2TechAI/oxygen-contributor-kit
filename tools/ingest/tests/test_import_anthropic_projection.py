import importlib.util
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zipfile


INGEST_ROOT = Path(__file__).resolve().parents[1]
IMPORT_PATH = INGEST_ROOT / "import_anthropic_export.py"
SPEC = importlib.util.spec_from_file_location("import_anthropic_projection", IMPORT_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

BUILD_PATH = (
    INGEST_ROOT.parents[1]
    / "skills" / "oxygen-organize-review-export" / "scripts" / "build_project_map.py"
)
BUILD_SPEC = importlib.util.spec_from_file_location("build_project_map_for_anthropic", BUILD_PATH)
BUILD = importlib.util.module_from_spec(BUILD_SPEC)
assert BUILD_SPEC and BUILD_SPEC.loader
sys.modules[BUILD_SPEC.name] = BUILD
BUILD_SPEC.loader.exec_module(BUILD)


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


class AnthropicProjectionTest(unittest.TestCase):
    @staticmethod
    def conversation(identifier: str | None, title: str = "Synthetic") -> dict:
        value = {
            "name": title,
            "chat_messages": [
                {"uuid": "message-1", "sender": "human", "text": "bounded input"},
                {"uuid": "message-2", "sender": "assistant", "text": "bounded reply"},
            ],
        }
        if identifier is not None:
            value["uuid"] = identifier
        return value

    @staticmethod
    def design_chat(identifier: str | None, title: str = "Synthetic design") -> dict:
        value = {
            "title": title,
            "messages": [
                {"uuid": "design-message-1", "role": "user", "content": "bounded design"},
            ],
        }
        if identifier is not None:
            value["uuid"] = identifier
        return value

    def test_output_root_junction_fails_before_touching_external_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "conversations.json"
            source.write_text("[]", encoding="utf-8")
            external = root / "external"
            external.mkdir()
            (external / "sentinel.bin").write_bytes(b"junction sentinel\x00")
            before = tree_snapshot(external)
            requested = root / "requested-run"
            cleanup = junction_or_symlink(self, requested, external)
            try:
                with self.assertRaises(SystemExit):
                    MODULE.main([str(source), "--out", str(requested)])
                self.assertEqual(tree_snapshot(external), before)
            finally:
                cleanup()

    def test_hard_linked_index_fails_before_any_mutation(self):
        artifacts = (
            Path("index.json"),
            Path("trajectories/traj-hard/events.jsonl"),
            Path("trajectories/traj-hard/manifest.json"),
            Path("memory/claudeai-memory/files/note.md"),
        )
        for artifact in artifacts:
            with self.subTest(artifact=artifact), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                source = root / "conversations.json"
                source.write_text("[]", encoding="utf-8")
                external = root / "external-artifact"
                external.write_bytes(b"hard-link sentinel\x00")
                out = root / "run"
                target = out / artifact
                target.parent.mkdir(parents=True)
                hard_link_or_skip(self, external, target)
                before_out = tree_snapshot(out)
                before_external = external.read_bytes()

                with self.assertRaises(SystemExit):
                    MODULE.main([str(source), "--out", str(out)])

                self.assertEqual(external.read_bytes(), before_external)
                self.assertEqual(tree_snapshot(out), before_out)

    def test_writable_historical_shared_location_is_unchanged(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "conversations.json"
            source.write_text("[]", encoding="utf-8")
            out = root / "run"
            shared = root.joinpath("srv", "shared", "oxygen", "data", "ingest" + "-staging")
            (shared / "existing-run").mkdir(parents=True)
            (shared / "existing-run" / "private.bin").write_bytes(b"private\x00export")
            (shared / "INBOX.md").write_bytes(b"existing inbox\n")
            before = tree_snapshot(shared)

            with mock.patch("builtins.print"):
                result = MODULE.main([str(source), "--out", str(out)])

            self.assertEqual(result, 0)
            self.assertTrue((out / "index.json").is_file())
            self.assertEqual(tree_snapshot(shared), before)

    def test_output_is_required_before_import(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary, "conversations.json")
            source.write_text("[]", encoding="utf-8")
            with self.assertRaises(SystemExit):
                MODULE.main([str(source)])

    def test_exact_file_does_not_read_sibling_supplements(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "selected.json"
            source.write_text(json.dumps([self.conversation("selected")]), encoding="utf-8")
            design_dir = root / "design_chats"
            design_dir.mkdir()
            (design_dir / "foreign.json").write_text(
                json.dumps(self.design_chat("foreign")), encoding="utf-8",
            )
            (root / "projects.json").write_text(json.dumps([{
                "name": "foreign-project", "description": "must not be imported",
            }]), encoding="utf-8")
            (root / "memories.json").write_text(json.dumps([{
                "conversations_memory": "must not be imported",
            }]), encoding="utf-8")
            out = root / "out"

            with mock.patch("builtins.print"):
                self.assertEqual(MODULE.main([str(source), "--out", str(out)]), 0)

            index = json.loads((out / "index.json").read_text(encoding="utf-8"))
            self.assertEqual(index["trajectory_count"], 1)
            self.assertEqual(index["memory_doc_count"], 0)
            self.assertFalse((out / "memory").exists())
            self.assertEqual(len(list((out / "trajectories").iterdir())), 1)

    def test_ambiguous_directory_fails_before_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "export"
            for name in ("one", "two"):
                path = source / name / "conversations.json"
                path.parent.mkdir(parents=True)
                path.write_text("[]", encoding="utf-8")
            out = root / "out"

            with self.assertRaises(SystemExit), mock.patch("builtins.print"):
                MODULE.main([str(source), "--out", str(out)])

            self.assertFalse(out.exists())

    def test_zip_escape_fails_before_extraction_or_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "export.zip"
            with zipfile.ZipFile(source, "w") as archive:
                archive.writestr("conversations.json", "[]")
                archive.writestr("../outside-sentinel", "must stay absent")
            out = root / "out"

            with self.assertRaises(SystemExit), mock.patch("builtins.print"):
                MODULE.main([str(source), "--out", str(out)])

            self.assertFalse(out.exists())
            self.assertFalse((root / "outside-sentinel").exists())

    def test_duplicate_zip_member_fails_before_extraction_or_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "export.zip"
            with zipfile.ZipFile(source, "w") as archive:
                archive.writestr("conversations.json", "[]")
                with self.assertWarns(UserWarning):
                    archive.writestr("conversations.json", "[]")
            out = root / "out"

            with self.assertRaises(SystemExit), mock.patch("builtins.print"):
                MODULE.main([str(source), "--out", str(out)])

            self.assertFalse(out.exists())

    def test_supplement_junction_fails_before_output_or_external_mutation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "export"
            source.mkdir()
            (source / "conversations.json").write_text("[]", encoding="utf-8")
            external = root / "external-design-chats"
            external.mkdir()
            (external / "sentinel.json").write_bytes(b'{"private":"sentinel"}\n')
            before = tree_snapshot(external)
            cleanup = junction_or_symlink(self, source / "design_chats", external)
            out = root / "out"
            try:
                with self.assertRaises(SystemExit), mock.patch("builtins.print"):
                    MODULE.main([str(source), "--out", str(out)])
                self.assertFalse(out.exists())
                self.assertEqual(tree_snapshot(external), before)
            finally:
                cleanup()

    def test_full_explicit_ids_with_same_prefix_preserve_exact_union(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "conversations.json"
            source.write_text(json.dumps([
                self.conversation("abcdefgh-first"),
                self.conversation("abcdefgh-second"),
            ]), encoding="utf-8")
            out = root / "out"

            with mock.patch("builtins.print"):
                MODULE.main([str(source), "--out", str(out)])

            index = json.loads((out / "index.json").read_text(encoding="utf-8"))
            ids = [entry["trajectory_id"] for entry in index["trajectories"]]
            self.assertEqual(len(ids), 2)
            self.assertEqual(len(set(ids)), 2)
            self.assertTrue(all((out / "trajectories" / value).is_dir() for value in ids))

    def test_identical_missing_id_records_use_stable_indexed_provenance(self):
        conversation = self.conversation(None, title="same title")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "conversations.json"
            source.write_text(json.dumps([conversation, conversation]), encoding="utf-8")
            first = root / "first"
            second = root / "second"

            with mock.patch("builtins.print"):
                MODULE.main([str(source), "--out", str(first)])
                MODULE.main([str(source), "--out", str(second)])

            first_ids = [
                entry["trajectory_id"]
                for entry in json.loads((first / "index.json").read_text(encoding="utf-8"))["trajectories"]
            ]
            second_ids = [
                entry["trajectory_id"]
                for entry in json.loads((second / "index.json").read_text(encoding="utf-8"))["trajectories"]
            ]
            self.assertEqual(first_ids, second_ids)
            self.assertEqual(len(first_ids), 2)
            self.assertEqual(len(set(first_ids)), 2)

    def test_duplicate_explicit_id_fails_before_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "conversations.json"
            source.write_text(json.dumps([
                self.conversation("duplicate"), self.conversation("duplicate"),
            ]), encoding="utf-8")
            out = root / "out"

            with self.assertRaises(SystemExit), mock.patch("builtins.print"):
                MODULE.main([str(source), "--out", str(out)])

            self.assertFalse(out.exists())

    def test_design_chat_full_ids_and_duplicates_are_preflighted(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "export"
            source.mkdir()
            (source / "conversations.json").write_text("[]", encoding="utf-8")
            design_dir = source / "design_chats"
            design_dir.mkdir()
            for name, identifier in (
                ("first.json", "abcdefgh-first"),
                ("second.json", "abcdefgh-second"),
            ):
                (design_dir / name).write_text(
                    json.dumps(self.design_chat(identifier)), encoding="utf-8",
                )
            out = root / "out"

            with mock.patch("builtins.print"):
                MODULE.main([str(source), "--out", str(out)])
            ids = [
                entry["trajectory_id"]
                for entry in json.loads((out / "index.json").read_text(encoding="utf-8"))["trajectories"]
            ]
            self.assertEqual(len(ids), 2)
            self.assertEqual(len(set(ids)), 2)

            duplicate = root / "duplicate-export"
            duplicate.mkdir()
            (duplicate / "conversations.json").write_text("[]", encoding="utf-8")
            duplicate_design = duplicate / "design_chats"
            duplicate_design.mkdir()
            for name in ("one.json", "two.json"):
                (duplicate_design / name).write_text(
                    json.dumps(self.design_chat("duplicate")), encoding="utf-8",
                )
            duplicate_out = root / "duplicate-out"
            with self.assertRaises(SystemExit), mock.patch("builtins.print"):
                MODULE.main([str(duplicate), "--out", str(duplicate_out)])
            self.assertFalse(duplicate_out.exists())

    def test_empty_design_chat_leaves_no_unindexed_trajectory_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "export"
            source.mkdir()
            (source / "conversations.json").write_text("[]", encoding="utf-8")
            design_dir = source / "design_chats"
            design_dir.mkdir()
            empty = self.design_chat("empty-design")
            empty["messages"] = [{"role": "tool", "content": "not a contribution"}]
            (design_dir / "empty.json").write_text(
                json.dumps(empty), encoding="utf-8",
            )
            out = root / "out"

            with mock.patch("builtins.print"):
                self.assertEqual(MODULE.main([str(source), "--out", str(out)]), 0)

            index = json.loads((out / "index.json").read_text(encoding="utf-8"))
            self.assertEqual(index["trajectory_count"], 0)
            self.assertFalse((out / "trajectories").exists())

    def test_empty_conversation_leaves_no_unindexed_trajectory_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "conversations.json"
            empty = self.conversation("empty-conversation")
            empty["chat_messages"] = [
                {"sender": "tool", "text": "not a contribution"},
                {"sender": "human", "text": ""},
            ]
            source.write_text(json.dumps([empty]), encoding="utf-8")
            out = root / "out"

            with mock.patch("builtins.print"):
                self.assertEqual(MODULE.main([str(source), "--out", str(out)]), 0)

            index = json.loads((out / "index.json").read_text(encoding="utf-8"))
            self.assertEqual(index["trajectory_count"], 0)
            self.assertFalse((out / "trajectories").exists())

    def test_nonempty_output_is_rejected_without_mutation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "conversations.json"
            source.write_text(json.dumps([self.conversation("selected")]), encoding="utf-8")
            out = root / "out"
            out.mkdir()
            (out / "sentinel.bin").write_bytes(b"existing output sentinel\x00")
            before = tree_snapshot(out)

            stdout, stderr = StringIO(), StringIO()
            with redirect_stdout(stdout), redirect_stderr(stderr), self.assertRaises(SystemExit):
                MODULE.main([str(source), "--out", str(out)])

            self.assertIn(MODULE.OUTPUT_NOT_EMPTY, stdout.getvalue() + stderr.getvalue())
            self.assertEqual(tree_snapshot(out), before)

    def test_rerun_is_rejected_without_changing_first_run(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "conversations.json"
            source.write_text(json.dumps([self.conversation("first")]), encoding="utf-8")
            out = root / "out"
            with mock.patch("builtins.print"):
                self.assertEqual(MODULE.main([str(source), "--out", str(out)]), 0)
            before = tree_snapshot(out)
            source.write_text(json.dumps([self.conversation("second")]), encoding="utf-8")

            stdout, stderr = StringIO(), StringIO()
            with redirect_stdout(stdout), redirect_stderr(stderr), self.assertRaises(SystemExit):
                MODULE.main([str(source), "--out", str(out)])

            self.assertIn(MODULE.OUTPUT_NOT_EMPTY, stdout.getvalue() + stderr.getvalue())
            self.assertEqual(tree_snapshot(out), before)

    def test_existing_empty_output_remains_a_valid_destination(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "conversations.json"
            source.write_text(json.dumps([self.conversation("selected")]), encoding="utf-8")
            out = root / "out"
            out.mkdir()

            with mock.patch("builtins.print"):
                self.assertEqual(MODULE.main([str(source), "--out", str(out)]), 0)

            index = json.loads((out / "index.json").read_text(encoding="utf-8"))
            self.assertEqual(index["trajectory_count"], 1)

    def test_conversation_and_design_chat_enter_the_same_projected_universe(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            trajectories = root / "trajectories"
            home = root / "home"
            home.mkdir()
            warnings: list[str] = []
            conversation = {
                "uuid": "conversation-001",
                "name": "Synthetic conversation",
                "chat_messages": [
                    {
                        "uuid": "human-attachment",
                        "sender": "human",
                        "text": "",
                        "attachments": [{"file_name": "requirements.txt"}],
                    },
                    {
                        "uuid": "assistant-visible",
                        "sender": "assistant",
                        "text": "The retained source changes the decision.",
                    },
                    {"uuid": "ambiguous", "sender": "unknown", "text": "Do not guess me."},
                ],
            }
            source_path = root / "conversations.json"
            source_path.write_text(json.dumps([conversation]), encoding="utf-8")
            original_bytes = source_path.read_bytes()

            conversation_id, _ = MODULE.plan_import_identities(
                [conversation], [], conversation_locator="conversations.json",
            )
            converted = MODULE.convert_conversation(
                conversation, "conversations.json", conversation_id[0],
                trajectories, home, warnings,
            )
            self.assertIsNotNone(converted)
            design_path = root / "design.json"
            design_path.write_text(json.dumps({
                "uuid": "design-001",
                "title": "Synthetic design",
                "messages": [
                    {"uuid": "design-user", "role": "user", "content": "Prefer the bounded path."},
                    {
                        "uuid": "design-assistant",
                        "role": "assistant",
                        "content": {"content": "I will keep the recorded rationale."},
                    },
                    {"uuid": "design-unknown", "role": "tool", "content": "mechanics"},
                ],
            }), encoding="utf-8")
            design = json.loads(design_path.read_text(encoding="utf-8"))
            _, design_ids = MODULE.plan_import_identities(
                [], [(design, "design.json")], conversation_locator="conversations.json",
            )
            designed = MODULE.convert_design_chat(
                design, "design.json", design_ids[0], trajectories, home, warnings,
            )
            self.assertIsNotNone(designed)
            (root / "index.json").write_text(json.dumps({
                "schema": BUILD.INGEST_RUN_SCHEMA,
                "tool": "import_anthropic_export",
                "trajectory_count": 2,
                "trajectories": [
                    {"trajectory_id": converted["trajectory_id"]},
                    {"trajectory_id": designed["trajectory_id"]},
                ],
            }), encoding="utf-8")

            self.assertEqual(source_path.read_bytes(), original_bytes)
            self.assertEqual(len(warnings), 2)
            events = []
            for path in sorted(trajectories.glob("*/events.jsonl")):
                events.extend(json.loads(line) for line in path.read_text(encoding="utf-8").splitlines())
                manifest = json.loads((path.parent / "manifest.json").read_text(encoding="utf-8"))
                self.assertIn("contribution_projection", manifest)
                self.assertEqual(manifest["event_count"], len(path.read_text(encoding="utf-8").splitlines()))
            self.assertEqual(len(events), 4)
            self.assertTrue(all(event["event_id"].startswith("evt-") for event in events))
            self.assertTrue(events[0]["payload"]["has_attachments"])
            self.assertNotIn("Do not guess me.", json.dumps(events))
            self.assertNotIn("mechanics", json.dumps(events))

            contribution_ids, sources, digests = BUILD.source_inventory(root)
            self.assertEqual(len(contribution_ids), 4)
            self.assertEqual(len(sources), 2)
            self.assertEqual(set(contribution_ids), set(digests))


if __name__ == "__main__":
    unittest.main()
