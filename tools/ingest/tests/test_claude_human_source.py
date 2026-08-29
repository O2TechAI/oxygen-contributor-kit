import base64
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest


EXTRACTOR_PATH = Path(__file__).resolve().parents[1] / "vendor" / "extract_claude_trajectory.py"
sys.path.insert(0, str(EXTRACTOR_PATH.parent))
SPEC = importlib.util.spec_from_file_location("extract_claude_for_human_source_test", EXTRACTOR_PATH)
EXTRACTOR = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = EXTRACTOR
SPEC.loader.exec_module(EXTRACTOR)

PROJECTION_PATH = Path(__file__).resolve().parents[1] / "human_source_projection.py"
PROJECTION_SPEC = importlib.util.spec_from_file_location(
    "human_source_projection_for_claude_test", PROJECTION_PATH,
)
PROJECTION = importlib.util.module_from_spec(PROJECTION_SPEC)
assert PROJECTION_SPEC and PROJECTION_SPEC.loader
PROJECTION_SPEC.loader.exec_module(PROJECTION)


class ClaudeHumanSourceTests(unittest.TestCase):
    def test_multiple_images_keep_block_identity_through_projection(self):
        encoded = base64.b64encode(b"synthetic image bytes").decode("ascii")
        record = {
            "uuid": "message-uuid",
            "sessionId": "session-one",
            "type": "user",
            "timestamp": "2026-08-26T00:00:00Z",
            "message": {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Compare these images."},
                    {"type": "image", "source": {
                        "type": "base64", "media_type": "image/png", "data": encoded,
                    }},
                    {"type": "image", "source": {
                        "type": "base64", "media_type": "image/png", "data": encoded,
                    }},
                ],
            },
        }
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            session = root / "session.jsonl"
            session.write_text(json.dumps(record) + "\n", encoding="utf-8")
            extractor = EXTRACTOR.ClaudeExtractor(
                session, root / "out", "traj-claude-images", overwrite=False,
                source_home=root, source_user="tester",
            )
            extractor.process()
            self.assertEqual(
                [event["source"]["record_id"] for event in extractor.events],
                ["message-uuid:0", "message-uuid", "message-uuid:1", "message-uuid:2"],
            )
            projected, summary = PROJECTION.project_events(extractor.events)
            self.assertEqual(summary["kept_human_source_artifact_count"], 2)
            self.assertEqual(len(projected), 4)
            self.assertEqual(len({event["event_id"] for event in projected}), 4)
            carrier = next(event for event in projected if event["payload"].get("has_attachments"))
            self.assertTrue(all(
                event["payload"]["created_by_event"] == carrier["event_id"]
                for event in projected if event["event_type"] == "artifact"
            ))

    def test_attachment_only_and_image_before_text_remain_human_source(self):
        encoded = base64.b64encode(b"public synthetic image").decode("ascii")
        for name, content, expected_count in [
            ("attachment-only", [{"type": "image", "source": {
                "type": "base64", "media_type": "image/png", "data": encoded,
            }}], 2),
            ("image-first", [
                {"type": "image", "source": {
                    "type": "base64", "media_type": "image/png", "data": encoded,
                }},
                {"type": "text", "text": "Use this image as source evidence."},
            ], 3),
        ]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                session = root / "session.jsonl"
                session.write_text(json.dumps({
                    "uuid": f"message-{name}", "sessionId": "session-one", "type": "user",
                    "timestamp": "2026-08-26T00:00:00Z",
                    "message": {"role": "user", "content": content},
                }) + "\n", encoding="utf-8")
                extractor = EXTRACTOR.ClaudeExtractor(
                    session, root / "out", f"traj-{name}", overwrite=False,
                    source_home=root, source_user="tester",
                )
                extractor.process()
                projected, summary = PROJECTION.project_events(extractor.events)
                self.assertEqual(len(projected), expected_count)
                self.assertEqual(summary["kept_human_source_artifact_count"], 1)
                artifact = next(event for event in projected if event["event_type"] == "artifact")
                self.assertTrue(artifact["payload"].get("created_by_event"))

    def test_task_tool_splits_semantic_delegation_from_mechanical_envelope(self):
        records = [{
            "uuid": "delegation-message", "sessionId": "session-one", "type": "assistant",
            "timestamp": "2026-08-26T00:00:00Z",
            "message": {"role": "assistant", "content": [{
                "type": "tool_use", "id": "task-call", "name": "Task",
                "input": {
                    "prompt": "Audit the event taxonomy and report findings.",
                    "description": "Explain the source-boundary implications.",
                },
            }]},
        }, {
            "uuid": "delegation-result", "parentUuid": "delegation-message",
            "sessionId": "session-one", "type": "user",
            "timestamp": "2026-08-26T00:00:01Z",
            "message": {"role": "user", "content": [{
                "type": "tool_result", "tool_use_id": "task-call",
                "content": "The extractor retains the semantic prompt and omits the wrapper.",
            }]},
        }]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            session = root / "session.jsonl"
            session.write_text(
                "".join(json.dumps(record) + "\n" for record in records), encoding="utf-8",
            )
            extractor = EXTRACTOR.ClaudeExtractor(
                session, root / "out", "traj-delegation", overwrite=False,
                source_home=root, source_user="tester",
            )
            extractor.process()
            projected, summary = PROJECTION.project_events(extractor.events)
            self.assertEqual(summary["kept_event_count"], 2)
            self.assertIn(records[0]["message"]["content"][0]["input"]["prompt"], projected[0]["payload"]["text"])
            self.assertIn(records[0]["message"]["content"][0]["input"]["description"], projected[0]["payload"]["text"])
            self.assertEqual(projected[1]["payload"]["interaction_direction"], "subagent_to_agent")
            self.assertEqual(summary["dropped_by_reason"][PROJECTION.DROP_TOOL_CALL], 1)
            self.assertEqual(summary["dropped_by_reason"][PROJECTION.DROP_TOOL_RESULT], 1)
            self.assertEqual(summary["dropped_by_reason"][PROJECTION.DROP_MACHINE_ARTIFACT], 2)

    def test_ask_user_question_result_is_human_feedback(self):
        records = [{
            "uuid": "question", "sessionId": "session-one", "type": "assistant",
            "message": {"role": "assistant", "content": [{
                "type": "tool_use", "id": "question-call", "name": "AskUserQuestion",
                "input": {"question": "Which boundary should be canonical?"},
            }]},
        }, {
            "uuid": "answer", "sessionId": "session-one", "type": "user",
            "message": {"role": "user", "content": [{
                "type": "tool_result", "tool_use_id": "question-call",
                "content": "Keep recorded cognition and drop mechanics.",
            }]},
        }]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            session = root / "session.jsonl"
            session.write_text(
                "".join(json.dumps(record) + "\n" for record in records), encoding="utf-8",
            )
            extractor = EXTRACTOR.ClaudeExtractor(
                session, root / "out", "traj-human-feedback", overwrite=False,
                source_home=root, source_user="tester",
            )
            extractor.process()
            projected, summary = PROJECTION.project_events(extractor.events)
            self.assertEqual(summary["kept_by_reason"][PROJECTION.KEEP_HUMAN_FEEDBACK], 1)
            feedback = next(event for event in projected if event["source"]["record_type"] == "human_tool_response")
            self.assertEqual(feedback["actor"]["type"], "human")


if __name__ == "__main__":
    unittest.main()
