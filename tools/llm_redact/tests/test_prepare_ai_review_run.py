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


class PrepareAiReviewRunTest(unittest.TestCase):
    def test_conversation_text_is_preserved_for_ai_review(self):
        event = {
            "event_id": "evt-1",
            "event_type": "message",
            "actor": {"type": "user"},
            "payload": {"role": "user", "text": "请隐藏张三"},
        }
        result = MODULE.normalize_event(event, "traj-1", 1)
        self.assertEqual(result["event_type"], "message")
        self.assertEqual(result["payload"]["text"], "请隐藏张三")
        self.assertEqual(result["relations"], [])

    def test_tool_content_and_source_metadata_are_removed(self):
        event = {
            "event_id": "evt-2",
            "sequence": 0,
            "event_type": "tool_result",
            "timestamp": "2026-01-02T03:04:05Z",
            "payload": {
                "stdout": "SECRET OUTPUT",
                "path": r"C:\\Users\\bruce\\private.txt",
            },
            "executor": {"tool": "shell"},
            "relations": [{"target": "private-event"}],
        }
        result = MODULE.normalize_event(event, "traj-1", 2)
        self.assertEqual(result["event_type"], "action_label")
        self.assertEqual(result["sequence"], 0)
        self.assertIsNone(result["timestamp"])
        self.assertEqual(result["payload"], {
            "action_type": "tool_result",
            "text": "[tool result]",
        })
        serialized = str(result)
        self.assertNotIn("SECRET OUTPUT", serialized)
        self.assertNotIn("private.txt", serialized)
        self.assertNotIn("executor", serialized)

    def test_trajectory_directory_is_prepared_end_to_end(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "review"
            trajectory = source / "trajectories" / "traj-1"
            trajectory.mkdir(parents=True)
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
            (trajectory / "events.jsonl").write_text(
                "".join(json.dumps(event, ensure_ascii=False) + "\n" for event in events),
                encoding="utf-8",
            )
            (trajectory / "manifest.json").write_text(json.dumps({
                "source_system": "codex",
                "warnings": ["warning one", "warning two"],
            }), encoding="utf-8")

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

    def test_meeting_review_input_is_canonical_text_only(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "review"
            source.mkdir()
            (source / "meeting.json").write_text(json.dumps({
                "meeting_id": "private-meeting-id",
                "title": "Private title",
                "warnings": ["one warning"],
                "records": [{
                    "record_id": "source-record-id",
                    "speaker": "Named Person",
                    "timestamp": "2026-01-02T03:04:05Z",
                    "text": "reviewable text",
                }],
            }), encoding="utf-8")

            meetings = MODULE.discover_meetings(source)
            evidence_ids, warning_count = MODULE.prepare_meetings(meetings, output)
            prepared = json.loads((output / "meeting.json").read_text())

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

    def test_root_and_plural_meetings_prepare_as_distinct_private_documents(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "review"
            write_meeting(source, "meeting-root", root=True)
            write_meeting(source, "meeting-alpha")
            write_meeting(source, "meeting-beta")

            meetings = MODULE.discover_meetings(source)
            evidence_ids, warning_count = MODULE.prepare_meetings(meetings, output)

            prepared_paths = [
                output / "meeting.json",
                output / "meetings" / "meeting-000002" / "meeting.json",
                output / "meetings" / "meeting-000003" / "meeting.json",
            ]
            prepared = [json.loads(path.read_text(encoding="utf-8")) for path in prepared_paths]
            self.assertEqual(
                [meeting["meeting_id"] for meeting in prepared],
                ["meeting-000001", "meeting-000002", "meeting-000003"],
            )
            self.assertEqual(warning_count, 0)
            self.assertEqual(
                evidence_ids["meeting-alpha:source-record-id"],
                "meeting-000002:record-000001",
            )
            self.assertEqual(
                evidence_ids["meeting-beta:source-record-id"],
                "meeting-000003:record-000001",
            )
            self.assertNotIn("source-record-id", evidence_ids)

    def test_duplicate_and_malformed_meetings_fail_before_output(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "review"
            write_meeting(source, "meeting-shared", root=True)
            write_meeting(source, "meeting-shared")
            with mock.patch.object(sys, "argv", [
                str(MODULE_PATH), "--run", str(source), "--out", str(output)
            ]):
                with self.assertRaisesRegex(
                    SystemExit, f"^{MODULE.INPUT_MEETING_ID_DUPLICATE}$"
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


if __name__ == "__main__":
    unittest.main()
