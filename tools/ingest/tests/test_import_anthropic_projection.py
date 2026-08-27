import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


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

            converted = MODULE.convert_conversation(conversation, trajectories, home, warnings)
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
            designed = MODULE.convert_design_chat(design_path, trajectories, home, warnings)
            self.assertIsNotNone(designed)

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
