import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "prepare_ai_review_run.py"
SPEC = importlib.util.spec_from_file_location("prepare_ai_review_run", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

EXTRACT_PATH = MODULE_PATH.with_name("extract_dialogue.py")
EXTRACT_SPEC = importlib.util.spec_from_file_location(
    "extract_dialogue_for_prepare_test", EXTRACT_PATH
)
EXTRACT = importlib.util.module_from_spec(EXTRACT_SPEC)
assert EXTRACT_SPEC and EXTRACT_SPEC.loader
EXTRACT_SPEC.loader.exec_module(EXTRACT)

LAUNCHER_PATH = (
    MODULE_PATH.parents[2]
    / "skills"
    / "oxygen-organize-review-export"
    / "scripts"
    / "run_local_review.py"
)
LAUNCHER_SPEC = importlib.util.spec_from_file_location(
    "run_local_review_for_prepare_test", LAUNCHER_PATH
)
LAUNCHER = importlib.util.module_from_spec(LAUNCHER_SPEC)
assert LAUNCHER_SPEC and LAUNCHER_SPEC.loader
LAUNCHER_SPEC.loader.exec_module(LAUNCHER)


def write_source_trajectory(run: Path, trajectory_id: str, events: list[dict]) -> Path:
    directory = run / "trajectories" / trajectory_id
    directory.mkdir(parents=True)
    (directory / "events.jsonl").write_text(
        "".join(json.dumps(event, ensure_ascii=False) + "\n" for event in events),
        encoding="utf-8",
    )
    normalized_count = len(events) + 1
    (directory / "manifest.json").write_text(json.dumps({
        "trajectory_id": trajectory_id,
        "source_system": "codex",
        "warnings": ["synthetic warning"],
        "event_count": len(events),
        "contribution_projection": {
            "policy_id": MODULE.POLICY_ID,
            "raw_source_digest": "a" * 64,
            "projected_universe_digest": MODULE.digest_events(events),
            "raw_event_count": normalized_count + 1,
            "normalized_event_count": normalized_count,
            "kept_event_count": len(events),
            "dropped_event_count": 1,
            "cross_trajectory_semantic_replay_count": 1,
        },
    }), encoding="utf-8")
    return directory


def write_meeting(run: Path, meeting_id: str, *, root=False, records=None) -> Path:
    directory = run if root else run / "meetings" / meeting_id
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "meeting.json"
    path.write_text(json.dumps({
        "meeting_id": meeting_id,
        "title": "Private title",
        "records": records if records is not None else [{
            "record_id": "source-record-id",
            "speaker": "Named Person",
            "timestamp": "2026-01-02T03:04:05Z",
            "text": "safe synthetic review text",
        }],
    }), encoding="utf-8")
    return path


def directory_link_or_skip(test_case: unittest.TestCase, link: Path, target: Path) -> None:
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


def file_link_or_skip(test_case: unittest.TestCase, link: Path, target: Path) -> None:
    try:
        link.symlink_to(target)
        return
    except OSError:
        pass
    if os.name == "nt":
        result = subprocess.run(
            ["cmd", "/c", "mklink", str(link), str(target)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=subprocess.CREATE_NO_WINDOW,
            check=False,
        )
        if result.returncode == 0:
            return
    test_case.skipTest("file link creation is unavailable")


class PrepareAiReviewRunTest(unittest.TestCase):
    def assert_projection_invalid(self, mutate):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "review"
            directory = write_source_trajectory(source, "traj-safe", [{
                "event_id": "evt-safe", "event_type": "message",
                "actor": {"type": "user"}, "payload": {"text": "safe synthetic text"},
            }])
            manifest_path = directory / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            mutate(manifest, directory)
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(SystemExit, f"^{MODULE.INPUT_PROJECTION_INVALID}$"):
                MODULE.prepare_trajectories(source, output)
            self.assertFalse(output.exists())

    def test_semantic_carriers_become_canonical_messages(self):
        cases = [
            ("message", "user", "user"),
            ("user", "user", "user"),
            ("assistant", "assistant", "assistant"),
            ("agent", "agent", "assistant"),
            ("reasoning", "ai", "assistant"),
            ("progress", "ai", "assistant"),
            ("status", "ai", "assistant"),
            ("record", "speaker", "user"),
            ("speech", "speaker", "user"),
        ]
        for event_type, actor_type, role in cases:
            with self.subTest(event_type=event_type):
                event = {
                    "event_id": f"evt-{event_type}",
                    "sequence": 0,
                    "event_type": event_type,
                    "actor": {"type": actor_type},
                    "timestamp": "2026-01-02T03:04:05Z",
                    "payload": {"text": f"reviewable {event_type}"},
                }
                result = MODULE.normalize_event(event, "traj-1", 9)
                self.assertEqual(result["event_type"], "message")
                self.assertEqual(result["event_id"], event["event_id"])
                self.assertEqual(result["sequence"], 0)
                self.assertEqual(result["timestamp"], event["timestamp"])
                self.assertEqual(result["payload"], {
                    "role": role, "text": event["payload"]["text"],
                })

    def test_delegation_and_subagent_message_roles_are_preserved(self):
        cases = [
            ("agent_to_subagent", "user"),
            ("subagent_to_agent", "assistant"),
        ]
        for direction, role in cases:
            with self.subTest(direction=direction):
                result = MODULE.normalize_event({
                    "event_id": f"evt-{direction}",
                    "event_type": "message",
                    "actor": {"type": "ai"},
                    "payload": {
                        "role": role,
                        "interaction_direction": direction,
                        "text": f"semantic {direction}",
                    },
                }, "traj-1", 1)
                self.assertEqual(result["event_type"], "message")
                self.assertEqual(result["payload"]["role"], role)

    def test_nonsemantic_and_malformed_events_use_fixed_labels(self):
        cases = [
            ("tool_call", "[tool call]", {"arguments": "SECRET"}),
            ("tool_result", "[tool result]", {"stdout": "SECRET"}),
            ("system", "[system action]", {"text": "SECRET"}),
            ("git", "[version control]", {"text": "SECRET"}),
            ("version_control", "[version control]", {"text": "SECRET"}),
            ("artifact", "[artifact]", {"text": "SECRET"}),
            ("assistant", "[agent event]", {"text": ""}),
            ("message", "[action]", {"text": "SECRET"}),
            ("unknown", "[action]", {"text": "SECRET"}),
        ]
        for event_type, label, payload in cases:
            with self.subTest(event_type=event_type, label=label):
                result = MODULE.normalize_event({
                    "event_id": f"evt-{event_type}",
                    "sequence": 0,
                    "event_type": event_type,
                    "timestamp": "2026-01-02T03:04:05Z",
                    "actor": {"type": "unknown"},
                    "payload": payload,
                    "executor": {"tool": "shell"},
                }, "traj-1", 2)
                self.assertEqual(result["event_type"], "action_label")
                self.assertEqual(result["sequence"], 0)
                self.assertIsNone(result["timestamp"])
                self.assertEqual(result["payload"]["text"], label)
                self.assertNotIn("SECRET", str(result))
                self.assertNotIn("executor", result)

    def test_trajectory_directory_is_prepared_end_to_end(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "review"
            events = [
                {
                    "event_id": "evt-1",
                    "event_type": "message",
                    "actor": {"type": "assistant"},
                    "payload": {"text": "联系李四，token 不应在工具输出中暴露"},
                },
                {
                    "event_id": "evt-2",
                    "event_type": "tool_result",
                    "payload": {"stdout": "token=secret-value"},
                },
            ]
            trajectory = write_source_trajectory(source, "traj-1", events)
            manifest_path = trajectory / "manifest.json"
            source_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            source_manifest["warnings"] = ["warning one", "warning two"]
            manifest_path.write_text(json.dumps(source_manifest), encoding="utf-8")

            MODULE.prepare_trajectories(source, output)

            prepared = (output / "trajectories" / "traj-1" / "events.jsonl").read_text(
                encoding="utf-8"
            )
            self.assertIn("联系李四", prepared)
            self.assertIn("[tool result]", prepared)
            self.assertNotIn("secret-value", prepared)
            manifest = json.loads(
                (output / "trajectories" / "traj-1" / "manifest.json").read_text()
            )
            self.assertEqual(manifest["source_system"], "codex")
            self.assertEqual(manifest["source_warning_count"], 2)
            self.assertFalse(manifest["publication_approved"])

    def test_prepare_extract_and_launcher_projection_contract(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "review"
            source_events = [
                {
                    "event_id": "evt-user",
                    "sequence": 7,
                    "event_type": "speech",
                    "actor": {"type": "speaker"},
                    "timestamp": "2026-01-02T03:04:05Z",
                    "payload": {"text": "safe synthetic request"},
                },
                {
                    "event_id": "evt-agent",
                    "sequence": 8,
                    "event_type": "reasoning",
                    "actor": {"type": "ai"},
                    "timestamp": "2026-01-02T03:04:06Z",
                    "payload": {"text": "safe synthetic reasoning"},
                },
                {
                    "event_id": "evt-tool",
                    "sequence": 9,
                    "event_type": "tool_result",
                    "actor": {"type": "tool"},
                    "payload": {"stdout": "SECRET"},
                },
            ]
            source_directory = write_source_trajectory(source, "traj-safe", source_events)
            source_manifest = json.loads(
                (source_directory / "manifest.json").read_text(encoding="utf-8")
            )

            MODULE.prepare_trajectories(source, output)

            prepared_directory = output / "trajectories" / "traj-safe"
            prepared_events = [
                json.loads(line) for line in
                (prepared_directory / "events.jsonl").read_text(encoding="utf-8").splitlines()
            ]
            manifest = json.loads(
                (prepared_directory / "manifest.json").read_text(encoding="utf-8")
            )
            projection = manifest["contribution_projection"]
            source_projection = source_manifest["contribution_projection"]
            self.assertEqual(manifest["event_count"], len(prepared_events))
            self.assertFalse(manifest["publication_approved"])
            self.assertEqual(set(projection), {
                "policy_id", "raw_source_digest", "projected_universe_digest",
                "raw_event_count", "normalized_event_count", "kept_event_count",
                "dropped_event_count", "cross_trajectory_semantic_replay_count",
            })
            for key in (
                "policy_id", "raw_source_digest", "raw_event_count",
                "normalized_event_count", "cross_trajectory_semantic_replay_count",
            ):
                self.assertEqual(projection[key], source_projection[key])
            self.assertEqual(
                projection["projected_universe_digest"],
                MODULE.digest_events(prepared_events),
            )
            self.assertEqual(projection["kept_event_count"], len(prepared_events))
            self.assertEqual(
                projection["normalized_event_count"] - projection["kept_event_count"],
                projection["dropped_event_count"],
            )
            dialogue = EXTRACT.extract_one(prepared_directory)
            self.assertEqual(
                [turn["text"] for turn in dialogue["turns"]],
                ["safe synthetic request", "safe synthetic reasoning"],
            )
            loaded = LAUNCHER._prepare_trajectory(prepared_directory, output)
            self.assertEqual(loaded["events"], prepared_events)

    def test_invalid_source_projection_fails_before_any_output_file(self):
        mutations = [
            ("missing", lambda manifest, _: manifest.pop("contribution_projection")),
            ("stale-event-count", lambda manifest, _: manifest.update(event_count=99)),
            ("boolean-event-count", lambda manifest, _: manifest.update(event_count=True)),
            ("wrong-policy", lambda manifest, _: manifest["contribution_projection"].update(
                policy_id="obsolete-policy"
            )),
            ("stale-digest", lambda manifest, _: manifest["contribution_projection"].update(
                projected_universe_digest="b" * 64
            )),
            ("bad-raw-digest", lambda manifest, _: manifest["contribution_projection"].update(
                raw_source_digest="not-a-digest"
            )),
            ("bad-count-equation", lambda manifest, _: manifest["contribution_projection"].update(
                dropped_event_count=2
            )),
            ("negative-count", lambda manifest, _: manifest["contribution_projection"].update(
                cross_trajectory_semantic_replay_count=-1,
                raw_event_count=1,
            )),
            ("tampered-events", lambda _, directory: (directory / "events.jsonl").write_text(
                json.dumps({
                    "event_id": "evt-safe", "event_type": "message",
                    "actor": {"type": "user"}, "payload": {"text": "tampered"},
                }) + "\n", encoding="utf-8"
            )),
        ]
        for name, mutate in mutations:
            with self.subTest(name=name):
                self.assert_projection_invalid(mutate)

        for field in (
            "raw_event_count", "normalized_event_count", "kept_event_count",
            "dropped_event_count", "cross_trajectory_semantic_replay_count",
        ):
            with self.subTest(boolean_count=field):
                self.assert_projection_invalid(
                    lambda manifest, _, field=field:
                    manifest["contribution_projection"].update({field: True})
                )

        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "review"
            event = {
                "event_id": "evt-safe", "event_type": "message",
                "actor": {"type": "user"}, "payload": {"text": "safe synthetic text"},
            }
            write_source_trajectory(source, "traj-a-valid", [event])
            invalid = write_source_trajectory(source, "traj-z-invalid", [event])
            manifest_path = invalid / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["contribution_projection"]["policy_id"] = "obsolete-policy"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(SystemExit, f"^{MODULE.INPUT_PROJECTION_INVALID}$"):
                MODULE.prepare_trajectories(source, output)
            self.assertFalse(output.exists())

    def test_meeting_review_input_is_canonical_text_only(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "review"
            write_meeting(source, "private-meeting-id", records=[{
                "record_id": "source-record-id",
                "speaker": "Named Person",
                "timestamp": "2026-01-02T03:04:05Z",
                "text": "reviewable text",
            }])
            meeting_path = source / "meetings" / "private-meeting-id" / "meeting.json"
            meeting = json.loads(meeting_path.read_text(encoding="utf-8"))
            meeting.update({
                "meeting_id": "private-meeting-id",
                "title": "Private title",
                "warnings": ["one warning"],
            })
            meeting_path.write_text(json.dumps(meeting), encoding="utf-8")

            meetings = MODULE.discover_meetings(source)
            evidence_ids, warning_count = MODULE.prepare_meetings(meetings, output)
            prepared_path = output / "meetings" / "meeting-000001" / "meeting.json"
            prepared = json.loads(prepared_path.read_text())

            self.assertEqual(len(meetings), 1)
            self.assertEqual(warning_count, 1)
            self.assertEqual(prepared["meeting_id"], "meeting-000001")
            self.assertEqual(prepared["records"], [{
                "record_id": "record-000001",
                "order": 0,
                "speaker": "participant",
                "text": "reviewable text",
            }])
            self.assertEqual(
                evidence_ids["private-meeting-id:source-record-id"],
                "meeting-000001:record-000001",
            )
            self.assertNotIn("Private title", json.dumps(prepared))
            self.assertNotIn("Named Person", json.dumps(prepared))
            self.assertNotIn("2026-01-02", json.dumps(prepared))

    def test_single_plural_meeting_main_emits_only_plural_topology(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "review"
            write_meeting(source, "meeting-only")

            with mock.patch.object(sys, "argv", [
                str(MODULE_PATH), "--run", str(source), "--out", str(output)
            ]), mock.patch("builtins.print") as emit:
                self.assertEqual(MODULE.main(), 0)

            self.assertFalse((output / "meeting.json").exists())
            self.assertTrue(
                (output / "meetings" / "meeting-000001" / "meeting.json").is_file()
            )
            index = json.loads((output / "index.json").read_text(encoding="utf-8"))
            self.assertEqual(index["meeting_count"], 1)
            report = json.loads(emit.call_args.args[0])
            self.assertEqual(report, {
                "output": str(output), "trajectories": 0, "meetings": 1,
            })

    def test_plural_meetings_prepare_as_distinct_private_documents(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "review"
            write_meeting(source, "meeting-alpha")
            write_meeting(source, "meeting-beta")

            meetings = MODULE.discover_meetings(source)
            evidence_ids, warning_count = MODULE.prepare_meetings(meetings, output)

            prepared_paths = [
                output / "meetings" / "meeting-000001" / "meeting.json",
                output / "meetings" / "meeting-000002" / "meeting.json",
            ]
            prepared = [json.loads(path.read_text(encoding="utf-8")) for path in prepared_paths]
            self.assertEqual(
                [meeting["meeting_id"] for meeting in prepared],
                ["meeting-000001", "meeting-000002"],
            )
            self.assertEqual(warning_count, 0)
            self.assertEqual(
                evidence_ids["meeting-alpha:source-record-id"],
                "meeting-000001:record-000001",
            )
            self.assertEqual(
                evidence_ids["meeting-beta:source-record-id"],
                "meeting-000002:record-000001",
            )
            self.assertNotIn("source-record-id", evidence_ids)

    def test_root_meeting_is_rejected_before_output(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "review"
            write_meeting(source, "meeting-root", root=True)
            with mock.patch.object(sys, "argv", [
                str(MODULE_PATH), "--run", str(source), "--out", str(output)
            ]):
                with self.assertRaisesRegex(
                    SystemExit, f"^{MODULE.INPUT_MEETING_INVALID}$"
                ):
                    MODULE.main()
            self.assertFalse(output.exists())

    def test_root_meeting_symlink_is_rejected(self):
        with TemporaryDirectory() as temp:
            source = Path(temp, "source")
            source.mkdir()
            root_meeting = source / "meeting.json"
            with mock.patch.object(
                Path, "is_symlink", autospec=True,
                side_effect=lambda path: path == root_meeting,
            ):
                with self.assertRaisesRegex(
                    SystemExit, f"^{MODULE.INPUT_MEETING_INVALID}$"
                ):
                    MODULE.discover_meetings(source)

    def test_duplicate_and_malformed_meetings_fail_before_output(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "review"
            write_meeting(source, "meeting-alpha")
            second = write_meeting(source, "meeting-beta")
            duplicate = json.loads(second.read_text(encoding="utf-8"))
            duplicate["meeting_id"] = "meeting-alpha"
            second.write_text(json.dumps(duplicate), encoding="utf-8")
            with mock.patch.object(sys, "argv", [
                str(MODULE_PATH), "--run", str(source), "--out", str(output)
            ]):
                with self.assertRaisesRegex(
                    SystemExit, f"^{MODULE.INPUT_MEETING_INVALID}$"
                ):
                    MODULE.main()
            self.assertFalse(output.exists())

        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "review"
            write_meeting(source, "meeting-malformed", records="not-a-list")
            with mock.patch.object(sys, "argv", [
                str(MODULE_PATH), "--run", str(source), "--out", str(output)
            ]):
                with self.assertRaisesRegex(
                    SystemExit, f"^{MODULE.INPUT_MEETING_INVALID}$"
                ):
                    MODULE.main()
            self.assertFalse(output.exists())

    def test_plural_meeting_path_escape_is_rejected(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            outside = root / "outside"
            write_meeting(outside, "meeting-escape", root=True)
            (source / "meetings").mkdir(parents=True)
            directory_link_or_skip(
                self, source / "meetings" / "meeting-escape", outside
            )

            with self.assertRaisesRegex(
                SystemExit, f"^{MODULE.INPUT_PATH_OUTSIDE_RUN}$"
            ):
                MODULE.discover_meetings(source)

    def test_contained_meeting_directory_alias_is_rejected(self):
        with TemporaryDirectory() as temp:
            source = Path(temp, "source")
            target = write_meeting(source, "real-id").parent
            directory_link_or_skip(
                self, source / "meetings" / "alias-id", target,
            )

            with self.assertRaisesRegex(
                SystemExit, f"^{MODULE.INPUT_MEETING_INVALID}$"
            ):
                MODULE.discover_meetings(source)

    def test_contained_meetings_root_alias_is_rejected(self):
        with TemporaryDirectory() as temp:
            source = Path(temp, "source")
            write_meeting(source, "real-id")
            hidden = source / "hidden"
            (source / "meetings").rename(hidden)
            directory_link_or_skip(self, source / "meetings", hidden)

            with self.assertRaisesRegex(
                SystemExit, f"^{MODULE.INPUT_MEETING_INVALID}$"
            ):
                MODULE.discover_meetings(source)

    def test_contained_meeting_file_alias_is_rejected(self):
        with TemporaryDirectory() as temp:
            source = Path(temp, "source")
            directory = source / "meetings" / "meeting-one"
            directory.mkdir(parents=True)
            target = directory / "payload.json"
            target.write_text(json.dumps({
                "meeting_id": "meeting-one",
                "records": [{"record_id": "record-one", "text": "safe text"}],
            }), encoding="utf-8")
            file_link_or_skip(self, directory / "meeting.json", target)

            with self.assertRaisesRegex(
                SystemExit, f"^{MODULE.INPUT_MEETING_INVALID}$"
            ):
                MODULE.discover_meetings(source)


if __name__ == "__main__":
    unittest.main()
