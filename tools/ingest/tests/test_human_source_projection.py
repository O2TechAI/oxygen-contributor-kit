import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "human_source_projection.py"
SPEC = importlib.util.spec_from_file_location("human_source_projection", MODULE_PATH)
projection = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(projection)


def event(
    event_id: str,
    event_type: str,
    *,
    actor_type: str,
    text: str | None = None,
    role: str | None = None,
    record_type: str | None = None,
    direction: str | None = None,
    extra_payload: dict | None = None,
) -> dict:
    payload = dict(extra_payload or {})
    if text is not None:
        payload["text"] = text
    if role is not None:
        payload["role"] = role
    if direction is not None:
        payload["interaction_direction"] = direction
    return {
        "schema": projection.TRAJECTORY_EVENT_SCHEMA,
        "event_id": event_id,
        "trajectory_id": "traj-synthetic",
        "event_type": event_type,
        "actor": {"id": f"actor-{event_id}", "type": actor_type},
        "source": {
            "system": "synthetic",
            "record_type": record_type or event_type,
            "interaction_direction": direction,
        },
        "payload": payload,
    }


class HumanSourceProjectionTests(unittest.TestCase):
    def test_semantic_dialogue_reasoning_coordination_and_progress_are_retained(self):
        events = [
            event("human", "message", actor_type="human", role="user", text="Please verify the gate."),
            event("agent", "message", actor_type="ai", role="assistant", text="The hard gate passes."),
            event("meeting", "speech", actor_type="speaker", role="speaker", text="We prefer the smaller boundary."),
            event("human-marker", "message", actor_type="human", role="user", text="Ran commands."),
            event(
                "feedback",
                "message",
                actor_type="human",
                role="user",
                text="Correct the source contract.",
                extra_payload={"interaction_kind": "correction"},
            ),
            event(
                "reasoning",
                "reasoning",
                actor_type="ai",
                role="assistant",
                text="The evidence changes the next action.",
                record_type="reasoning_summary",
                direction="agent_internal_reasoning",
            ),
            event(
                "delegation",
                "message",
                actor_type="ai",
                role="user",
                text="Audit the extractor and report findings.",
                direction="agent_to_subagent",
            ),
            event(
                "finding",
                "message",
                actor_type="ai",
                role="assistant",
                text="The extractor drops plaintext summaries.",
                direction="subagent_to_agent",
            ),
            event(
                "progress",
                "progress",
                actor_type="ai",
                text="All mandated reports are now read.",
                direction="agent_internal_progress",
            ),
            event(
                "mixed-agent-progress",
                "agent",
                actor_type="ai",
                text="The isolated worktree is now created.",
                record_type="sub_agent_activity",
                direction="agent_internal_progress",
            ),
        ]

        kept, summary = projection.project_events(events)

        self.assertEqual(len(kept), len(events))
        self.assertTrue(all(projection.PROJECTED_EVENT_ID.fullmatch(item["event_id"]) for item in kept))
        self.assertEqual(len({item["event_id"] for item in kept}), len(events))
        self.assertEqual(summary["kept_event_count"], len(events))
        self.assertEqual(summary["dropped_event_count"], 0)
        self.assertEqual(summary["kept_by_reason"][projection.KEEP_RECORDED_REASONING], 1)
        self.assertEqual(summary["kept_by_reason"][projection.KEEP_AGENT_COORDINATION], 2)
        self.assertEqual(summary["kept_by_reason"][projection.KEEP_MEANINGFUL_PROGRESS], 2)

    def test_execution_mechanics_and_generic_markers_are_excluded(self):
        events = [
            event("call", "tool_call", actor_type="ai", extra_payload={"arguments": "private command"}),
            event("result", "tool_result", actor_type="tool", extra_payload={"stdout": "private output"}),
            event("git", "git", actor_type="ai", extra_payload={"action": "status"}),
            event("system", "system", actor_type="system", extra_payload={"action": "task_started"}),
            event(
                "plumbing",
                "agent",
                actor_type="ai",
                record_type="sub_agent_activity",
                extra_payload={"details": {"kind": "started"}},
            ),
            event("marker", "message", actor_type="ai", role="assistant", text="Read files, ran commands."),
            event(
                "encrypted",
                "reasoning",
                actor_type="ai",
                role="assistant",
                record_type="reasoning_summary",
                extra_payload={"encrypted_content": "opaque"},
            ),
            event("ambiguous", "unknown", actor_type="system", text="unowned text"),
        ]

        kept, summary = projection.project_events(events)

        self.assertEqual(kept, [])
        self.assertEqual(summary["dropped_event_count"], len(events))
        self.assertEqual(summary["dropped_by_reason"][projection.DROP_TOOL_CALL], 1)
        self.assertEqual(summary["dropped_by_reason"][projection.DROP_TOOL_RESULT], 1)
        self.assertEqual(summary["dropped_by_reason"][projection.DROP_GENERIC_EXECUTION_MARKER], 1)
        self.assertEqual(summary["dropped_by_reason"][projection.DROP_AMBIGUOUS], 2)

    def test_attachment_only_human_message_is_a_source_owner(self):
        source = event(
            "source", "message", actor_type="human", role="user",
            extra_payload={"has_attachments": True, "attachments": []},
        )
        attachment = event(
            "attachment", "artifact", actor_type="system",
            record_type="artifact:attachment",
            extra_payload={
                "kind": "attachment", "created_by_event": "source",
                "sha256": "a" * 64,
            },
        )
        kept, summary = projection.project_events([source, attachment])
        self.assertEqual(len(kept), 2)
        self.assertEqual(summary["kept_human_source_artifact_count"], 1)

    def test_only_human_source_artifact_owned_by_kept_semantic_event_survives(self):
        source = event("source", "message", actor_type="human", role="user", text="Use this supplied file.")
        attachment = event(
            "attachment",
            "artifact",
            actor_type="system",
            record_type="artifact:attachment",
            extra_payload={
                "kind": "attachment",
                "created_by_event": "source",
                "path": "artifacts/attachments/source.json",
            },
        )
        machine = event(
            "machine",
            "artifact",
            actor_type="system",
            record_type="tool_output",
            extra_payload={
                "kind": "stdout",
                "created_by_event": "tool",
                "path": "artifacts/outputs/stdout.txt",
            },
        )

        kept, summary = projection.project_events([source, attachment, machine])

        self.assertEqual(len(kept), 2)
        self.assertTrue(all(projection.PROJECTED_EVENT_ID.fullmatch(item["event_id"]) for item in kept))
        self.assertEqual(kept[1]["payload"]["created_by_event"], kept[0]["event_id"])
        self.assertEqual(summary["raw_artifact_count"], 2)
        self.assertEqual(summary["kept_human_source_artifact_count"], 1)
        self.assertEqual(summary["dropped_machine_artifact_count"], 1)

    def test_projection_rewrites_only_derived_trajectory_and_keeps_raw_source_unchanged(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            raw_source = root / "raw-session.jsonl"
            raw_source.write_text('{"private":"unchanged"}\n', encoding="utf-8")
            before = hashlib.sha256(raw_source.read_bytes()).hexdigest()

            trajectory = root / "trajectory"
            (trajectory / "artifacts" / "outputs").mkdir(parents=True)
            (trajectory / "artifacts" / "attachments").mkdir(parents=True)
            (trajectory / "artifacts" / "outputs" / "tool.txt").write_text("tool", encoding="utf-8")
            (trajectory / "artifacts" / "attachments" / "source.json").write_text("source", encoding="utf-8")
            source = event("source", "message", actor_type="human", role="user", text="Use the source.")
            attachment = event(
                "attachment",
                "artifact",
                actor_type="system",
                extra_payload={
                    "kind": "attachment",
                    "created_by_event": "source",
                    "path": "artifacts/attachments/source.json",
                    "size_bytes": 6,
                    "sha256": hashlib.sha256(b"source").hexdigest(),
                },
            )
            tool = event("tool", "tool_result", actor_type="tool")
            tool_artifact = event(
                "tool-artifact",
                "artifact",
                actor_type="system",
                extra_payload={
                    "kind": "stdout",
                    "created_by_event": "tool",
                    "path": "artifacts/outputs/tool.txt",
                },
            )
            (trajectory / "events.jsonl").write_text(
                "".join(json.dumps(item) + "\n" for item in [source, attachment, tool, tool_artifact]),
                encoding="utf-8",
            )
            (trajectory / "manifest.json").write_text(
                json.dumps({
                    "schema": projection.TRAJECTORY_SCHEMA,
                    "event_count": 4,
                    "artifact_count": 2,
                }),
                encoding="utf-8",
            )

            summary = projection.project_trajectory(trajectory, raw_source_digest=before)

            self.assertEqual(hashlib.sha256(raw_source.read_bytes()).hexdigest(), before)
            self.assertEqual(summary["kept_event_count"], 2)
            self.assertTrue((trajectory / "artifacts" / "attachments" / "source.json").is_file())
            self.assertFalse((trajectory / "artifacts" / "outputs" / "tool.txt").exists())
            manifest = json.loads((trajectory / "manifest.json").read_text(encoding="utf-8"))
            kept_events = [
                json.loads(line) for line in (trajectory / "events.jsonl").read_text(
                    encoding="utf-8"
                ).splitlines()
            ]
            artifact_events = [item for item in kept_events if item["event_type"] == "artifact"]
            self.assertEqual(len(artifact_events), manifest["artifact_count"])
            artifact_payload = artifact_events[0]["payload"]
            artifact_bytes = (trajectory / artifact_payload["path"]).read_bytes()
            self.assertEqual(len(artifact_bytes), artifact_payload["size_bytes"])
            self.assertEqual(hashlib.sha256(artifact_bytes).hexdigest(), artifact_payload["sha256"])
            remaining_files = {
                path.relative_to(trajectory).as_posix()
                for path in (trajectory / "artifacts").rglob("*") if path.is_file()
            }
            self.assertEqual(remaining_files, {artifact_payload["path"]})
            self.assertNotIn("excluded", manifest["contribution_projection"])
            self.assertNotIn("event_ids", manifest["contribution_projection"])

    def test_retained_artifact_integrity_failure_stops_projection(self):
        for path_value, content, size, digest in (
            ("artifacts/source.txt", b"tampered", 8, "0" * 64),
            ("../outside.txt", b"outside", 7, hashlib.sha256(b"outside").hexdigest()),
        ):
            with self.subTest(path=path_value), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                trajectory = root / "trajectory"
                (trajectory / "artifacts").mkdir(parents=True)
                target = trajectory / "artifacts" / "source.txt"
                target.write_bytes(content)
                (root / "outside.txt").write_bytes(content)
                source = event(
                    "source", "message", actor_type="human", role="user", text="Use it."
                )
                attachment = event(
                    "attachment", "artifact", actor_type="system",
                    extra_payload={
                        "kind": "attachment", "created_by_event": "source",
                        "path": path_value, "size_bytes": size, "sha256": digest,
                    },
                )
                (trajectory / "events.jsonl").write_text(
                    "".join(json.dumps(item) + "\n" for item in (source, attachment)),
                    encoding="utf-8",
                )
                (trajectory / "manifest.json").write_text(
                    json.dumps({
                        "schema": projection.TRAJECTORY_SCHEMA,
                        "event_count": 2,
                        "artifact_count": 1,
                    }), encoding="utf-8",
                )
                with self.assertRaisesRegex(ValueError, "artifact contribution"):
                    projection.project_trajectory(trajectory, raw_source_digest="a" * 64)

    def test_duplicate_or_missing_event_identity_fails_closed(self):
        duplicate = event("same", "message", actor_type="human", role="user", text="first")
        with self.assertRaisesRegex(ValueError, "duplicate event_id"):
            projection.project_events([duplicate, dict(duplicate)])
        missing = event("missing", "message", actor_type="human", role="user", text="missing")
        missing.pop("event_id")
        with self.assertRaisesRegex(ValueError, "nonempty event_id"):
            projection.project_events([missing])

    def test_cross_trajectory_source_replay_collapses_only_when_semantics_match(self):
        registry = {}
        first = event("first", "message", actor_type="human", role="user", text="same source")
        first["source"].update({
            "system": "codex",
            "session_id": "session-one",
            "origin": "top_level",
            "record_type": "message",
            "record_id": "raw-message-1",
        })
        replay = json.loads(json.dumps(first))
        replay["event_id"] = "replay"
        replay["trajectory_id"] = "traj-replay"

        kept_first, first_count = projection.deduplicate_semantic_source_records([first], registry)
        kept_replay, replay_count = projection.deduplicate_semantic_source_records([replay], registry)

        self.assertEqual(kept_first, [first])
        self.assertEqual(first_count, 0)
        self.assertEqual(kept_replay, [])
        self.assertEqual(replay_count, 1)
        conflicting = json.loads(json.dumps(replay))
        conflicting["payload"]["text"] = "different source"
        with self.assertRaisesRegex(ValueError, "conflicting semantic source replay"):
            projection.deduplicate_semantic_source_records([conflicting], registry)

        separate_session = json.loads(json.dumps(replay))
        separate_session["source"]["session_id"] = "session-two"
        kept_separate, separate_count = projection.deduplicate_semantic_source_records(
            [separate_session], registry,
        )
        self.assertEqual(kept_separate, [separate_session])
        self.assertEqual(separate_count, 0)

    def test_cross_trajectory_replay_uses_pre_redaction_semantic_hash(self):
        registry = {}
        first = event("first", "message", actor_type="human", role="user", text="<USER_HOME>/note")
        first["source"].update({
            "system": "codex", "session_id": "session-one", "origin": "top_level",
            "record_type": "message", "record_id": "raw-message-1",
            "_semantic_sha256": "a" * 64,
        })
        replay = json.loads(json.dumps(first))
        replay["event_id"] = "replay"
        replay["source"]["_semantic_sha256"] = "b" * 64
        projection.deduplicate_semantic_source_records([first], registry)
        with self.assertRaisesRegex(ValueError, "conflicting semantic source replay"):
            projection.deduplicate_semantic_source_records([replay], registry)

        kept, _ = projection.project_events([first])
        self.assertNotIn("_semantic_sha256", kept[0]["source"])

    def test_projection_accounts_for_source_replays_before_mechanical_filtering(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            registry = {}

            def write_trajectory(name, events):
                trajectory = root / name
                trajectory.mkdir()
                (trajectory / "events.jsonl").write_text(
                    "".join(json.dumps(item) + "\n" for item in events),
                    encoding="utf-8",
                )
                (trajectory / "manifest.json").write_text(json.dumps({
                    "schema": projection.TRAJECTORY_SCHEMA,
                    "event_count": len(events),
                    "source_normalization": {"duplicate_semantic_replay_count": 0},
                }), encoding="utf-8")
                return trajectory

            semantic = event(
                "semantic", "message", actor_type="human", role="user",
                text="Keep the recorded decision.",
            )
            semantic["source"].update({
                "system": "codex", "origin": "top_level",
                "session_id": "source-session",
                "record_type": "message", "record_id": "source-message-1",
            })
            first = write_trajectory("first", [semantic])
            first_summary = projection.project_trajectory(
                first, raw_source_digest="a" * 64, semantic_source_registry=registry,
            )
            replay = json.loads(json.dumps(semantic))
            replay["event_id"] = "semantic-replay"
            mechanical = event(
                "mechanical", "tool_result", actor_type="tool",
                extra_payload={"stdout": "raw mechanics"},
            )
            second = write_trajectory("second", [replay, mechanical])
            second_summary = projection.project_trajectory(
                second, raw_source_digest="b" * 64, semantic_source_registry=registry,
            )

            self.assertEqual(first_summary["raw_event_count"], 1)
            self.assertEqual(second_summary["raw_event_count"], 2)
            self.assertEqual(second_summary["cross_trajectory_semantic_replay_count"], 1)
            self.assertEqual(second_summary["normalized_event_count"], 1)
            self.assertEqual(second_summary["kept_event_count"], 0)
            self.assertEqual(second_summary["mechanical_drop_count"], 1)
            self.assertEqual(
                second_summary["raw_event_count"],
                second_summary["cross_trajectory_semantic_replay_count"]
                + second_summary["kept_event_count"]
                + second_summary["mechanical_drop_count"],
            )
            self.assertEqual(second_summary["by_event_family"]["message"], {
                "raw": 1, "normalized": 0, "kept": 0, "dropped": 0,
                "source_replays": 1,
            })

    def test_attachment_identity_and_digest_ignore_dropped_staging_ordinals(self):
        def semantic_source(event_id, record_type):
            return {
                "schema": projection.TRAJECTORY_EVENT_SCHEMA,
                "event_id": event_id,
                "trajectory_id": "traj-stable",
                "event_type": "message" if record_type == "message" else "artifact",
                "actor": {"id": "person" if record_type == "message" else "system", "type": "human" if record_type == "message" else "system"},
                "source": {
                    "system": "codex", "session_id": "stable-session", "origin": "top_level",
                    "record_id": "record-one", "record_type": record_type,
                },
                "payload": (
                    {"role": "user", "text": "Use this file."}
                    if record_type == "message" else {
                        "artifact_id": "artifact-000001", "kind": "attachment",
                        "stored_name": "artifact-000001.json",
                        "path": "artifacts/attachments/artifact-000001.json",
                        "media_type": "application/json", "size_bytes": 12,
                        "sha256": "a" * 64, "created_by_event": "message-raw",
                    }
                ),
                "relations": [] if record_type == "message" else [
                    {"type": "produced", "event_id": "message-raw"},
                ],
            }

        message = semantic_source("message-raw", "message")
        attachment = semantic_source("attachment-raw", "message_attachment:0")
        first, _ = projection.project_events([message, attachment])
        shifted_message = json.loads(json.dumps(message))
        shifted_attachment = json.loads(json.dumps(attachment))
        shifted_attachment["payload"].update({
            "artifact_id": "artifact-000019",
            "stored_name": "artifact-000019.json",
            "path": "artifacts/attachments/artifact-000019.json",
        })
        shifted, _ = projection.project_events([
            event("mechanical", "tool_result", actor_type="tool"),
            shifted_message,
            shifted_attachment,
        ])

        self.assertEqual([item["event_id"] for item in shifted], [item["event_id"] for item in first])
        self.assertEqual(
            [projection.contribution_digest_value(item) for item in shifted],
            [projection.contribution_digest_value(item) for item in first],
        )

    def test_multiple_attachments_have_distinct_stable_subidentities(self):
        message = event("message", "message", actor_type="human", role="user", text="Two files.")
        message["source"].update({
            "system": "codex", "session_id": "session", "origin": "top_level",
            "record_id": "record", "record_type": "message",
        })
        attachments = []
        for index in range(2):
            item = event(
                f"attachment-{index}", "artifact", actor_type="system",
                record_type=f"message_attachment:{index}",
                extra_payload={
                    "kind": "attachment", "created_by_event": "message",
                    "sha256": str(index) * 64,
                },
            )
            item["source"].update({
                "system": "codex", "session_id": "session", "origin": "top_level",
                "record_id": "record",
            })
            attachments.append(item)
        kept, _ = projection.project_events([message, *attachments])
        self.assertEqual(len(kept), 3)
        self.assertEqual(len({item["event_id"] for item in kept}), 3)

if __name__ == "__main__":
    unittest.main()
