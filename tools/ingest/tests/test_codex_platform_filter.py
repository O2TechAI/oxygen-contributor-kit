import importlib.util
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest


MODULE_PATH = Path(__file__).resolve().parents[1] / "vendor" / "extract_codex_trajectory.py"
SPEC = importlib.util.spec_from_file_location("extract_codex_trajectory", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

PROJECTION_PATH = Path(__file__).resolve().parents[1] / "human_source_projection.py"
PROJECTION_SPEC = importlib.util.spec_from_file_location(
    "human_source_projection_for_codex_test", PROJECTION_PATH,
)
PROJECTION = importlib.util.module_from_spec(PROJECTION_SPEC)
assert PROJECTION_SPEC and PROJECTION_SPEC.loader
PROJECTION_SPEC.loader.exec_module(PROJECTION)


class PlatformFilterTest(unittest.TestCase):
    def test_platform_wrappers_are_filtered(self):
        for value in (
            "<recommended_plugins>\n...",
            "  <environment_context>\n...",
            "# AGENTS.md instructions\n...",
        ):
            self.assertEqual(MODULE.strip_platform_injected_user_text(value), "")

    def test_actual_user_text_is_retained(self):
        self.assertEqual(
            MODULE.strip_platform_injected_user_text(
                "Can full-context baselines outperform a learned skill?"
            ),
            "Can full-context baselines outperform a learned skill?",
        )

    def test_complete_platform_wrapper_is_removed_without_erasing_human_suffix(self):
        self.assertEqual(
            MODULE.strip_platform_injected_user_text(
                "<environment_context>mechanics</environment_context>\nKeep this decision."
            ),
            "Keep this decision.",
        )

    def test_recorded_semantics_keep_origin_and_direction_without_encrypted_bodies(self):
        records = [
            {
                "type": "session_meta",
                "timestamp": "2026-08-26T00:00:00Z",
                "payload": {
                    "id": "top-session",
                    "thread_source": "user",
                    "source": "vscode",
                    "cwd": "D:/public/project",
                },
            },
            {
                "type": "response_item",
                "timestamp": "2026-08-26T00:00:01Z",
                "payload": {
                    "id": "human-message",
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "Verify the hard gate."}],
                },
            },
            {
                "type": "event_msg",
                "timestamp": "2026-08-26T00:00:02Z",
                "payload": {
                    "type": "agent_message",
                    "phase": "commentary",
                    "message": "The hard gate passes.",
                },
            },
            {
                "type": "response_item",
                "timestamp": "2026-08-26T00:00:02Z",
                "payload": {
                    "id": "agent-message",
                    "type": "message",
                    "role": "assistant",
                    "phase": "commentary",
                    "content": [{"type": "output_text", "text": "The hard gate passes."}],
                },
            },
            {
                "type": "response_item",
                "timestamp": "2026-08-26T00:00:02Z",
                "payload": {
                    "id": "agent-message",
                    "type": "message",
                    "role": "assistant",
                    "phase": "commentary",
                    "content": [{"type": "output_text", "text": "The hard gate passes."}],
                },
            },
            {
                "type": "event_msg",
                "timestamp": "2026-08-26T00:00:03Z",
                "payload": {
                    "type": "agent_reasoning",
                    "text": "Evidence changes the next action.",
                },
            },
            {
                "type": "response_item",
                "timestamp": "2026-08-26T00:00:03Z",
                "payload": {
                    "id": "reasoning",
                    "type": "reasoning",
                    "summary": [{"type": "summary_text", "text": "Evidence changes the next action."}],
                    "encrypted_content": "must-not-leak",
                },
            },
            {
                "type": "response_item",
                "timestamp": "2026-08-26T00:00:04Z",
                "payload": {
                    "id": "coordination",
                    "type": "agent_message",
                    "author": "parent",
                    "recipient": "reviewer",
                    "content": [{"type": "input_text", "text": "Audit the parser semantics."}],
                    "encrypted_content": "must-not-leak",
                },
            },
            {
                "type": "session_meta",
                "timestamp": "2026-08-26T00:00:05Z",
                "payload": {
                    "id": "sub-session",
                    "thread_source": "subagent",
                    "source": {"subagent": {"other": "reviewer"}},
                    "parent_thread_id": "top-session",
                    "agent_path": "/root/reviewer",
                    "cwd": "D:/public/project",
                },
            },
            {
                "type": "response_item",
                "timestamp": "2026-08-26T00:00:06Z",
                "payload": {
                    "id": "delegation",
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "Return evidence-backed findings."}],
                },
            },
            {
                "type": "response_item",
                "timestamp": "2026-08-26T00:00:07Z",
                "payload": {
                    "id": "finding",
                    "type": "message",
                    "role": "assistant",
                    "phase": "final_answer",
                    "content": [{"type": "output_text", "text": "The parser omitted summaries."}],
                },
            },
            {
                "type": "event_msg",
                "timestamp": "2026-08-26T00:00:08Z",
                "payload": {
                    "type": "thread_goal_updated",
                    "goal": "Correct only the affected projection logic.",
                },
            },
            {
                "type": "event_msg",
                "timestamp": "2026-08-26T00:00:09Z",
                "payload": {
                    "type": "agent_reasoning",
                    "text": "Evidence changes the next action.",
                },
            },
            {
                "type": "event_msg",
                "timestamp": "2026-08-26T00:00:10Z",
                "payload": {
                    "type": "agent_message",
                    "phase": "commentary",
                    "message": "The isolated worktree is now created.",
                },
            },
        ]

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            session = root / "session.jsonl"
            session.write_text(
                "".join(json.dumps(record) + "\n" for record in records),
                encoding="utf-8",
            )
            before = hashlib.sha256(session.read_bytes()).hexdigest()
            extractor = MODULE.Extractor(
                session,
                root / "out",
                "traj-semantic",
                overwrite=False,
                source_home=root,
                source_user="tester",
            )
            extractor.process()

            self.assertEqual(hashlib.sha256(session.read_bytes()).hexdigest(), before)
            reasoning = [item for item in extractor.events if item["event_type"] == "reasoning"]
            self.assertEqual(len(reasoning), 2)
            self.assertEqual(
                [item["source"]["record_type"] for item in reasoning],
                ["reasoning_summary", "agent_reasoning"],
            )
            self.assertTrue(all(
                item["payload"]["text"] == "Evidence changes the next action."
                for item in reasoning
            ))
            self.assertNotIn("encrypted_content", json.dumps(extractor.events))
            coordination = [
                item for item in extractor.events
                if item["source"]["record_type"] == "agent_message"
            ]
            self.assertEqual(len(coordination), 1)
            self.assertEqual(coordination[0]["payload"]["interaction_direction"], "agent_to_agent")
            delegation = next(item for item in extractor.events if item["source"]["record_id"] == "delegation")
            finding = next(item for item in extractor.events if item["source"]["record_id"] == "finding")
            self.assertEqual(delegation["actor"]["type"], "ai")
            self.assertEqual(delegation["payload"]["interaction_direction"], "agent_to_subagent")
            self.assertEqual(finding["payload"]["interaction_direction"], "subagent_to_agent")
            self.assertEqual(delegation["source"]["origin"], "subagent")
            progress = [item for item in extractor.events if item["event_type"] == "progress"]
            self.assertEqual(len(progress), 1)
            self.assertEqual(progress[0]["payload"]["text"], "Correct only the affected projection logic.")
            event_message = next(
                item for item in extractor.events
                if item["source"]["record_type"] == "agent_message_event"
            )
            self.assertEqual(event_message["payload"]["text"], "The isolated worktree is now created.")
            self.assertEqual(extractor.duplicate_semantic_replays, 3)
            self.assertEqual(
                [item["event_id"] for item in extractor.events],
                [f"evt-{index:06d}" for index in range(1, len(extractor.events) + 1)],
            )

    def test_adjacent_mirror_collapse_preserves_identity_and_exact_plaintext(self):
        def extract(records, name):
            root = Path(temporary)
            session = root / f"{name}.jsonl"
            session.write_text(
                "".join(json.dumps(record) + "\n" for record in records),
                encoding="utf-8",
            )
            extractor = MODULE.Extractor(
                session, root / "out", name, overwrite=False,
                source_home=root, source_user="tester",
            )
            extractor.process()
            return extractor

        response = {
            "type": "response_item",
            "timestamp": "2026-08-26T00:00:00Z",
            "payload": {
                "id": "reasoning-1", "type": "reasoning",
                "summary": [{"type": "summary_text", "text": "Check the exact gate."}],
            },
        }
        event_message = {
            "type": "event_msg",
            "timestamp": "2026-08-26T00:00:00Z",
            "payload": {"type": "agent_reasoning", "text": "Check the exact gate."},
        }
        with tempfile.TemporaryDirectory() as temporary:
            response_only = extract([response], "response-only")
            mirrored = extract([event_message, response], "mirrored")
            self.assertEqual(len(response_only.events), 1)
            self.assertEqual(len(mirrored.events), 1)
            self.assertEqual(response_only.events[0]["event_id"], "evt-000001")
            self.assertEqual(mirrored.events[0]["event_id"], "evt-000001")
            self.assertEqual(
                response_only.events[0]["payload"]["text"],
                mirrored.events[0]["payload"]["text"],
            )

            distinct_secret_event = json.loads(json.dumps(event_message))
            distinct_secret_event["payload"]["text"] = "api_key=abcdefghijklmnop"
            distinct_secret_response = json.loads(json.dumps(response))
            distinct_secret_response["payload"]["summary"][0]["text"] = "api_key=qrstuvwxyzabcdef"
            redacted = extract([distinct_secret_event, distinct_secret_response], "redacted")
            self.assertEqual(len(redacted.events), 2)
            self.assertEqual(redacted.duplicate_semantic_replays, 0)
            self.assertEqual(
                [item["event_id"] for item in redacted.events],
                ["evt-000001", "evt-000002"],
            )

    def test_conflicting_semantic_replay_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            session = root / "session.jsonl"
            session.write_text("", encoding="utf-8")
            extractor = MODULE.Extractor(
                session,
                root / "out",
                "traj-conflict",
                overwrite=False,
                source_home=root,
                source_user="tester",
            )
            payload = {"id": "same-source-record"}
            self.assertTrue(extractor.should_emit_semantic_record(payload, "message", {"text": "first"}))
            with self.assertRaisesRegex(ValueError, "conflicting semantic replay"):
                extractor.should_emit_semantic_record(payload, "message", {"text": "different"})

    def test_user_event_carriers_keep_event_only_semantics_and_exact_mirrors_once(self):
        records = [
            {
                "type": "session_meta", "timestamp": "2026-08-26T00:00:00Z",
                "payload": {
                    "id": "sub-session", "thread_source": "subagent",
                    "parent_thread_id": "parent", "cwd": "D:/public/project",
                },
            },
            {
                "type": "response_item", "timestamp": "2026-08-26T00:00:01Z",
                "payload": {
                    "id": "response-user", "type": "message", "role": "user",
                    "content": [{"type": "input_text", "text": "Inspect the adapter."}],
                },
            },
            {
                "type": "event_msg", "timestamp": "2026-08-26T00:00:01Z",
                "payload": {
                    "type": "user_message", "client_id": "event-user",
                    "message": "Inspect the adapter.", "images": [], "local_images": [],
                    "text_elements": [], "audio": [], "local_audio": [],
                },
            },
            {
                "type": "event_msg", "timestamp": "2026-08-26T00:00:02Z",
                "payload": {
                    "type": "user_message", "client_id": "event-only",
                    "message": "Recheck the source boundary.", "images": [],
                    "local_images": [], "text_elements": [],
                },
            },
            {
                "type": "event_msg", "timestamp": "2026-08-26T00:00:03Z",
                "payload": {
                    "type": "user_message", "client_id": "platform-context",
                    "message": "<environment_context>\n  <cwd>D:/public/project</cwd>\n</environment_context>",
                    "images": [], "local_images": [], "text_elements": [],
                },
            },
        ]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            session = root / "session.jsonl"
            session.write_text(
                "".join(json.dumps(record) + "\n" for record in records), encoding="utf-8",
            )
            extractor = MODULE.Extractor(
                session, root / "out", "traj-user-events", overwrite=False,
                source_home=root, source_user="tester",
            )
            extractor.process()

            messages = [event for event in extractor.events if event["event_type"] == "message"]
            self.assertEqual([event["payload"]["text"] for event in messages], [
                "Inspect the adapter.", "Recheck the source boundary.",
            ])
            self.assertEqual(messages[0]["source"]["record_id"], "response-user")
            self.assertEqual(messages[1]["source"]["record_id"], "event-only")
            self.assertTrue(all(
                event["payload"]["interaction_direction"] == "agent_to_subagent"
                for event in messages
            ))
            self.assertEqual(extractor.duplicate_semantic_replays, 1)

    def test_event_only_user_attachment_is_retained_with_stable_subidentity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            session = root / "session.jsonl"
            records = [
                {
                    "type": "session_meta", "timestamp": "2026-08-26T00:00:00Z",
                    "payload": {"id": "top-session", "cwd": str(root)},
                },
                {
                    "type": "event_msg", "timestamp": "2026-08-26T00:00:01Z",
                    "payload": {
                        "type": "user_message", "client_id": "user-with-image",
                        "message": "", "images": [],
                        "local_images": ["D:/public/image.png"], "text_elements": [],
                    },
                },
            ]
            session.write_text(
                "".join(json.dumps(record) + "\n" for record in records), encoding="utf-8",
            )
            extractor = MODULE.Extractor(
                session, root / "out", "traj-user-attachment", overwrite=False,
                source_home=root, source_user="tester",
            )
            extractor.process()
            self.assertEqual(len(extractor.events), 2)
            message, artifact = extractor.events
            self.assertEqual(message["payload"]["interaction_direction"], "human_to_agent")
            self.assertEqual(artifact["payload"]["kind"], "attachment")
            self.assertEqual(artifact["source"]["record_id"], "user-with-image")
            self.assertEqual(artifact["source"]["record_type"], "user_message_attachment:0")
            self.assertEqual(artifact["payload"]["created_by_event"], message["event_id"])
            projected, summary = PROJECTION.project_events(extractor.events)
            self.assertEqual(len(projected), 2)
            self.assertEqual(summary["kept_human_source_artifact_count"], 1)

    def test_multiple_response_attachments_and_redaction_collisions_fail_safely(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            session = root / "session.jsonl"
            attachment_message = {
                "type": "response_item", "timestamp": "2026-08-26T00:00:01Z",
                "payload": {
                    "id": "attachment-source", "type": "message", "role": "user",
                    "content": [
                        {"type": "input_text", "text": "Use both files."},
                        {"type": "input_file", "file_id": "file-one"},
                        {"type": "input_file", "file_id": "file-two"},
                    ],
                },
            }
            session.write_text(json.dumps(attachment_message) + "\n", encoding="utf-8")
            extractor = MODULE.Extractor(
                session, root / "out", "traj-two-attachments", overwrite=False,
                source_home=root, source_user="tester",
            )
            extractor.process()
            self.assertEqual(len(extractor.events), 3)
            self.assertEqual(
                [event["source"]["record_type"] for event in extractor.events[1:]],
                ["message_attachment:1", "message_attachment:2"],
            )
            projected, summary = PROJECTION.project_events(extractor.events)
            self.assertEqual(summary["kept_human_source_artifact_count"], 2)
            self.assertEqual(len(projected), 3)
            self.assertEqual(len({event["event_id"] for event in projected}), 3)
            self.assertTrue(all(
                event["payload"]["created_by_event"] == projected[0]["event_id"]
                for event in projected[1:]
            ))

            conflicting = [
                {
                    "type": "response_item", "timestamp": "2026-08-26T00:00:02Z",
                    "payload": {
                        "id": "same-source", "type": "message", "role": "assistant",
                        "content": [{"type": "output_text", "text": "api_key=abcdefghijklmnop"}],
                    },
                },
                {
                    "type": "event_msg", "timestamp": "2026-08-26T00:00:03Z",
                    "payload": {"type": "task_started"},
                },
                {
                    "type": "response_item", "timestamp": "2026-08-26T00:00:04Z",
                    "payload": {
                        "id": "same-source", "type": "message", "role": "assistant",
                        "content": [{"type": "output_text", "text": "api_key=qrstuvwxyzabcdef"}],
                    },
                },
            ]
            session.write_text(
                "".join(json.dumps(record) + "\n" for record in conflicting), encoding="utf-8",
            )
            rejected = MODULE.Extractor(
                session, root / "rejected", "traj-redaction-conflict", overwrite=False,
                source_home=root, source_user="tester",
            )
            with self.assertRaisesRegex(ValueError, "conflicting semantic replay"):
                rejected.process()

    def test_task_complete_last_message_is_deduplicated_or_retained_by_turn(self):
        turn_id = "turn-synthetic"
        mirrored_records = [
            {
                "type": "response_item", "timestamp": "2026-08-26T00:00:00Z",
                "payload": {
                    "id": "visible-final", "type": "message", "role": "assistant",
                    "internal_chat_message_metadata_passthrough": {"turn_id": turn_id},
                    "content": [{"type": "output_text", "text": "The verified result is ready."}],
                },
            },
            {
                "type": "event_msg", "timestamp": "2026-08-26T00:00:01Z",
                "payload": {"type": "token_count", "turn_id": turn_id},
            },
            {
                "type": "event_msg", "timestamp": "2026-08-26T00:00:02Z",
                "payload": {
                    "type": "task_complete", "turn_id": turn_id,
                    "last_agent_message": "The verified result is ready.",
                    "duration_ms": 10,
                },
            },
        ]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            session = root / "session.jsonl"
            session.write_text(
                "".join(json.dumps(record) + "\n" for record in mirrored_records),
                encoding="utf-8",
            )
            extractor = MODULE.Extractor(
                session, root / "out", "traj-task-complete", overwrite=False,
                source_home=root, source_user="tester",
            )
            extractor.process()
            self.assertEqual(
                len([event for event in extractor.events if event["event_type"] == "message"]), 1,
            )
            self.assertEqual(extractor.duplicate_semantic_replays, 1)

            unmatched = json.loads(json.dumps(mirrored_records[-1]))
            unmatched["payload"]["turn_id"] = "turn-unmatched"
            unmatched["payload"]["last_agent_message"] = "A final answer recorded only here."
            session.write_text(json.dumps(unmatched) + "\n", encoding="utf-8")
            fallback = MODULE.Extractor(
                session, root / "fallback", "traj-task-fallback", overwrite=False,
                source_home=root, source_user="tester",
            )
            fallback.process()
            messages = [event for event in fallback.events if event["event_type"] == "message"]
            self.assertEqual(len(messages), 1)
            self.assertEqual(messages[0]["source"]["record_type"], "task_complete_agent_message")
            self.assertEqual(messages[0]["source"]["record_id"], "turn-unmatched")
            projected, _ = PROJECTION.project_events(fallback.events)
            self.assertEqual(len(projected), 1)
            self.assertEqual(projected[0]["payload"]["text"], "A final answer recorded only here.")

    def test_mixed_tool_records_project_only_coordination_and_plan_language(self):
        records = [
            {
                "type": "response_item", "timestamp": "2026-08-26T00:00:00Z",
                "payload": {
                    "id": "spawn-call", "call_id": "spawn-call", "type": "function_call",
                    "name": "spawn_agent", "arguments": json.dumps({
                        "task_name": "reviewer", "fork_turns": "all",
                        "message": "Audit the source taxonomy and return evidence.",
                    }),
                },
            },
            {
                "type": "response_item", "timestamp": "2026-08-26T00:00:01Z",
                "payload": {
                    "id": "plan-call", "call_id": "plan-call", "type": "function_call",
                    "name": "update_plan", "arguments": json.dumps({
                        "explanation": "The evidence changes the next sequence.",
                        "plan": [
                            {"step": "Verify the boundary.", "status": "completed"},
                            {"step": "Measure the projected corpus.", "status": "in_progress"},
                        ],
                    }),
                },
            },
            {
                "type": "response_item", "timestamp": "2026-08-26T00:00:02Z",
                "payload": {
                    "id": "send-call", "call_id": "send-call", "type": "function_call",
                    "name": "send_message", "arguments": json.dumps({
                        "target": "reviewer", "message": "Share the structural finding.",
                    }),
                },
            },
            {
                "type": "response_item", "timestamp": "2026-08-26T00:00:03Z",
                "payload": {
                    "id": "shell-call", "call_id": "shell-call", "type": "function_call",
                    "name": "exec", "arguments": json.dumps({
                        "cmd": "echo This command-shaped text is not contribution narration",
                    }),
                },
            },
            {
                "type": "response_item", "timestamp": "2026-08-26T00:00:04Z",
                "payload": {
                    "id": "wait-call", "call_id": "wait-call", "type": "function_call",
                    "name": "wait", "arguments": "{}",
                },
            },
            {
                "type": "response_item", "timestamp": "2026-08-26T00:00:05Z",
                "payload": {
                    "id": "wait-result", "call_id": "wait-call", "type": "function_call_output",
                    "output": [{
                        "type": "input_text",
                        "text": "The extractor retains the recorded decision and rejects the wrapper.",
                    }],
                },
            },
            {
                "type": "response_item", "timestamp": "2026-08-26T00:00:06Z",
                "payload": {
                    "id": "wait-status-call", "call_id": "wait-status-call", "type": "function_call",
                    "name": "wait", "arguments": "{}",
                },
            },
            {
                "type": "response_item", "timestamp": "2026-08-26T00:00:07Z",
                "payload": {
                    "id": "wait-status-result", "call_id": "wait-status-call",
                    "type": "function_call_output", "output": "Timed out waiting for agent activity.",
                },
            },
            {
                "type": "response_item", "timestamp": "2026-08-26T00:00:08Z",
                "payload": {
                    "id": "question-call", "call_id": "question-call", "type": "function_call",
                    "name": "request_user_input", "arguments": json.dumps({
                        "questions": [{"id": "boundary", "question": "Which source boundary?"}],
                    }),
                },
            },
            {
                "type": "response_item", "timestamp": "2026-08-26T00:00:09Z",
                "payload": {
                    "id": "question-result", "call_id": "question-call",
                    "type": "function_call_output",
                    "output": json.dumps({"answers": {"boundary": "Keep cognition; drop mechanics."}}),
                },
            },
        ]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            session = root / "session.jsonl"
            session.write_text(
                "".join(json.dumps(record) + "\n" for record in records), encoding="utf-8",
            )
            extractor = MODULE.Extractor(
                session, root / "out", "traj-mixed-tools", overwrite=False,
                source_home=root, source_user="tester",
            )
            extractor.process()
            projected, summary = PROJECTION.project_events(extractor.events)
            self.assertEqual(summary["kept_event_count"], 6)
            self.assertEqual(summary["dropped_by_reason"][PROJECTION.DROP_TOOL_CALL], 7)
            self.assertEqual(summary["dropped_by_reason"][PROJECTION.DROP_TOOL_RESULT], 3)
            self.assertEqual(summary["dropped_by_reason"][PROJECTION.DROP_MACHINE_ARTIFACT], 10)
            self.assertEqual(
                [event["source"]["record_type"] for event in projected],
                [
                    "coordination_prompt:spawn_agent", "agent_plan",
                    "coordination_prompt:send_message",
                    "subagent_finding",
                    "human_question",
                    "human_tool_response",
                ],
            )
            self.assertEqual(projected[0]["payload"]["interaction_direction"], "agent_to_subagent")
            self.assertIn("Measure the projected corpus.", projected[1]["payload"]["text"])
            self.assertEqual(projected[2]["payload"]["interaction_direction"], "agent_to_agent")
            self.assertEqual(projected[3]["payload"]["interaction_direction"], "subagent_to_agent")
            self.assertEqual(projected[4]["payload"]["interaction_direction"], "agent_to_human")
            self.assertIn("Which source boundary?", projected[4]["payload"]["text"])
            self.assertEqual(projected[5]["actor"]["type"], "human")
            self.assertEqual(projected[5]["relations"][0]["event_id"], projected[4]["event_id"])
            self.assertEqual(summary["kept_by_reason"][PROJECTION.KEEP_HUMAN_FEEDBACK], 1)
            self.assertNotIn("command-shaped", json.dumps(projected))

    def test_current_codex_thread_tools_retain_only_authored_semantics(self):
        def call(call_id, name, arguments):
            return {
                "type": "response_item", "timestamp": "2026-08-26T01:00:00Z",
                "payload": {
                    "id": call_id, "call_id": call_id, "type": "function_call",
                    "name": name, "arguments": json.dumps(arguments),
                },
            }

        def result(call_id, output):
            return {
                "type": "response_item", "timestamp": "2026-08-26T01:00:01Z",
                "payload": {
                    "id": f"{call_id}-result", "call_id": call_id,
                    "type": "function_call_output",
                    "output": [{"type": "text", "text": json.dumps(output)}],
                },
            }

        create = call(
            "create", "create_thread",
            {"prompt": "Implement the bounded parser repair.", "projectId": "project-secret"},
        )
        records = [
            {
                "type": "response_item", "timestamp": "2026-08-26T00:59:59Z",
                "payload": {
                    "id": "originating-human", "type": "message", "role": "user",
                    "content": [{"type": "input_text", "text": "Preserve the exact scope."}],
                },
            },
            create,
            json.loads(json.dumps(create)),
            result("create", {"threadId": "thread-created", "hostId": "host-secret"}),
            call(
                "send", "mcp__codex_app__send_message_to_thread",
                {"threadId": "thread-secret", "prompt": "Return only verified findings."},
            ),
            call(
                "handoff", "handoff_thread",
                {"threadId": "thread-secret", "followUpPrompt": "Continue from the clean base."},
            ),
            call(
                "empty-handoff", "mcp__codex_app__handoff_thread",
                {"threadId": "thread-secret", "followUpPrompt": "   "},
            ),
            call("read-created", "read_thread", {"threadId": "thread-created"}),
            result("read-created", {
                "threadId": "thread-created",
                "turns": [{"items": [
                    {"type": "userMessage", "content": "Implement the bounded parser repair."},
                ]}],
            }),
            call("read", "mcp__codex_app__read_thread", {"threadId": "thread-secret"}),
            result("read", {
                "threadId": "thread-secret", "hostId": "host-secret", "status": "completed",
                "turns": [{
                    "turnId": "turn-secret",
                    "items": [
                        {"type": "userMessage", "content": "Return only verified findings."},
                        {
                            "type": "message", "role": "user",
                            "content": "A traversal copy is not human authority.",
                        },
                        {"type": "progress", "text": "The required base is verified."},
                        {
                            "type": "agentMessage", "phase": "final",
                            "text": "The scoped repair is complete.",
                        },
                        {
                            "type": "tool_result", "role": "assistant",
                            "text": "raw command output must stay mechanical",
                            "truncated": True,
                        },
                        {"role": "assistant", "content": {"text": "malformed authored wrapper"}},
                    ],
                }],
                "latestAssistantMessage": "The scoped repair is complete.",
                "cursor": "cursor-secret", "tokenUsage": 123,
            }),
            call("wait-final", "wait_threads", {"targets": [{"threadId": "thread-secret"}]}),
            result("wait-final", {
                "timedOut": False, "wake": {"threadId": "thread-secret"},
                "polls": [{
                    "threadId": "thread-secret", "hostId": "host-secret", "status": "completed",
                    "latestAssistantMessage": "The scoped repair is complete.",
                }],
            }),
            call("wait-distinct", "wait_threads", {"targets": [
                {"threadId": "thread-a"}, {"threadId": "thread-b"},
            ]}),
            result("wait-distinct", {
                "timedOut": False,
                "polls": [
                    {
                        "threadId": "thread-a", "status": "completed",
                        "latestAssistantMessage": "The shared final wording.",
                    },
                    {
                        "threadId": "thread-b", "status": "completed",
                        "latestAssistantMessage": "The shared final wording.",
                    },
                ],
            }),
            call(
                "wait-attention", "mcp__codex_app__wait_threads",
                {"targets": [{"threadId": "thread-secret"}]},
            ),
            result("wait-attention", {
                "timedOut": False,
                "polls": [{
                    "threadId": "thread-secret", "status": "blocked",
                    "latestAssistantMessage": "The scoped repair is complete.",
                }],
            }),
            call("wait-timeout", "wait_threads", {"targets": []}),
            result("wait-timeout", {
                "timedOut": True, "wake": None,
                "polls": [{
                    "threadId": "thread-secret", "status": "running",
                    "latestAssistantMessage": "timeout metadata is not a final report",
                }],
            }),
            call("wait-status", "wait_threads", {"targets": []}),
            result("wait-status", {"status": "completed", "cursor": "cursor-secret"}),
            call("missing-identity", "read_thread", {}),
            result("missing-identity", {
                "latestAssistantMessage": "Identity unavailable; retain without guessing.",
            }),
            call("malformed-identity", "read_thread", {"threadId": ["not-stable"]}),
            result("malformed-identity", {
                "threadId": {"not": "stable"},
                "latestAssistantMessage": "Identity unavailable; retain without guessing.",
            }),
            call("unknown", "mcp__codex_app__list_threads", {"prompt": "Do not retain this."}),
            call("malformed-call", "create_thread", {"prompt": {"text": "not a string"}}),
            call("malformed-read", "read_thread", {"threadId": "thread-secret"}),
            {
                "type": "response_item", "timestamp": "2026-08-26T01:00:02Z",
                "payload": {
                    "id": "malformed-read-result", "call_id": "malformed-read",
                    "type": "function_call_output", "output": "{not-json",
                },
            },
        ]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            session = root / "session.jsonl"
            session.write_text(
                "".join(json.dumps(record) + "\n" for record in records), encoding="utf-8",
            )
            extractor = MODULE.Extractor(
                session, root / "out", "traj-current-thread-tools", overwrite=False,
                source_home=root, source_user="tester",
            )
            extractor.process()
            projected, summary = PROJECTION.project_events(extractor.events)
            self.assertEqual(summary["kept_event_count"], 11)
            self.assertEqual(extractor.duplicate_semantic_replays, 2)
            self.assertEqual(
                [event["source"]["record_type"] for event in projected],
                [
                    "message",
                    "coordination_prompt:create_thread",
                    "coordination_prompt:send_message_to_thread",
                    "coordination_prompt:handoff_thread",
                    "thread_content:read_thread",
                    "thread_content:read_thread",
                    "thread_content:wait_threads",
                    "thread_content:wait_threads",
                    "thread_content:wait_threads",
                    "thread_content:read_thread",
                    "thread_content:read_thread",
                ],
            )
            texts = [event["payload"]["text"] for event in projected]
            self.assertEqual(texts.count("Implement the bounded parser repair."), 1)
            self.assertEqual(texts.count("Return only verified findings."), 1)
            self.assertEqual(texts.count("The scoped repair is complete."), 2)
            self.assertEqual(texts.count("The shared final wording."), 2)
            self.assertEqual(texts.count("Identity unavailable; retain without guessing."), 2)
            self.assertNotIn("A traversal copy is not human authority.", texts)
            self.assertEqual(projected[0]["actor"]["type"], "human")
            self.assertEqual(projected[0]["payload"]["interaction_direction"], "human_to_agent")
            self.assertTrue(all(
                event["payload"]["interaction_direction"] == "agent_to_agent"
                for event in projected[1:]
            ))
            self.assertTrue(all(
                event["actor"]["type"] == "ai"
                for event in projected
                if event["source"]["record_type"] == "thread_content:read_thread"
            ))
            scoped_final = [
                event for event in projected
                if event["payload"]["text"] == "The scoped repair is complete."
            ]
            self.assertEqual(
                [event["payload"]["phase"] for event in scoped_final],
                ["final", "needs_attention"],
            )
            projected_json = json.dumps(projected)
            for excluded in (
                "thread-created", "thread-secret", "thread-a", "thread-b",
                "host-secret", "cursor-secret", "raw command output",
                "timeout metadata", "Do not retain this", "malformed authored wrapper",
            ):
                self.assertNotIn(excluded, projected_json)


if __name__ == "__main__":
    unittest.main()
