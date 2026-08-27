import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest


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


class AnthropicProjectionTest(unittest.TestCase):
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
