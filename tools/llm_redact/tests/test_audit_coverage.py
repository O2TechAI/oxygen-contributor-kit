import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "audit_coverage.py"
SPEC = importlib.util.spec_from_file_location("audit_coverage", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def write_trajectory(
    run: Path, text: str, action_text: str | None = None,
    artifact_bytes: bytes | None = None,
) -> None:
    directory = run / "trajectories" / "traj-safe"
    directory.mkdir(parents=True)
    if artifact_bytes is None:
        events = [{"schema": MODULE.AI_REVIEW_EVENT_SCHEMA,
                   "event_type": "message", "payload": {"text": text}}]
    else:
        (directory / "hostile.bin").write_bytes(artifact_bytes)
        events = [{"schema": MODULE.AI_REVIEW_EVENT_SCHEMA,
                   "event_type": "artifact", "payload": {"path": "hostile.bin"}}]
    if action_text is not None:
        events.append({
            "schema": MODULE.AI_REVIEW_EVENT_SCHEMA,
            "event_type": "action_label",
            "payload": {"text": action_text},
        })
    (directory / "events.jsonl").write_text(
        "".join(json.dumps(event) + "\n" for event in events), encoding="utf-8"
    )
    (directory / "manifest.json").write_text(json.dumps({
        "schema": MODULE.AI_REVIEW_TRAJECTORY_SCHEMA,
        "trajectory_id": "traj-safe",
        "event_count": len(events),
        "contribution_projection": {
            "policy_id": MODULE.POLICY_ID,
            "raw_source_digest": "a" * 64,
            "projected_universe_digest": MODULE.digest_events(events),
            "raw_event_count": len(events),
            "normalized_event_count": len(events),
            "kept_event_count": len(events),
            "dropped_event_count": 0,
            "cross_trajectory_semantic_replay_count": 0,
        },
    }), encoding="utf-8")


def write_meeting(run: Path, meeting_id: str, text: str) -> None:
    directory = run / "meetings" / meeting_id
    directory.mkdir(parents=True)
    (directory / "meeting.json").write_text(json.dumps({
        "schema": MODULE.AI_REVIEW_MEETING_SCHEMA,
        "meeting_id": meeting_id,
        "records": [{"record_id": "record-000001", "text": text}],
    }), encoding="utf-8")


def audit(run: Path) -> str:
    output = io.StringIO()
    with mock.patch.object(sys, "argv", [str(MODULE_PATH), str(run)]):
        with contextlib.redirect_stdout(output):
            MODULE.main()
    return output.getvalue()


class AuditCoverageTest(unittest.TestCase):
    def test_trajectory_only_preserves_coverage(self):
        with TemporaryDirectory() as temp:
            run = Path(temp)
            write_trajectory(run, "12345", "123")

            output = audit(run)

            self.assertIn("total chars: 8", output)
            self.assertIn("reviewed by the model: 5 (62.50%)", output)
            self.assertIn("never reviewed:        3 (37.50%)", output)

    def test_meeting_only_counts_plural_records(self):
        with TemporaryDirectory() as temp:
            run = Path(temp)
            write_meeting(run, "meeting-000001", "12345")
            write_meeting(run, "meeting-000002", "123456")

            output = audit(run)

            self.assertIn("message              2          11", output)
            self.assertIn("total chars: 11", output)
            self.assertIn("reviewed by the model: 11 (100.00%)", output)

    def test_mixed_sources_are_counted_once(self):
        with TemporaryDirectory() as temp:
            run = Path(temp)
            write_trajectory(run, "12345")
            write_meeting(run, "meeting-000001", "123456")

            output = audit(run)

            self.assertIn("message              2          11", output)
            self.assertIn("total chars: 11", output)

    def test_empty_input_fails_closed(self):
        with TemporaryDirectory() as temp:
            with mock.patch.object(sys, "argv", [str(MODULE_PATH), temp]):
                with self.assertRaisesRegex(SystemExit, "^NO_REVIEWABLE_TEXT$"):
                    MODULE.main()

    def test_non_utf8_artifact_returns_fixed_terminal_error(self):
        with TemporaryDirectory() as temp:
            run = Path(temp)
            write_trajectory(run, "", artifact_bytes=b"\xffHOSTILE_CODEC_SENTINEL")

            result = subprocess.run(
                [sys.executable, str(MODULE_PATH), str(run)], capture_output=True,
                text=True, encoding="utf-8", errors="replace", check=False,
            )
            self.assertEqual(
                (result.returncode, result.stdout, result.stderr),
                (1, "", "SOURCE_PRIVACY_AUDIT_INPUT_INVALID\n"),
            )
            self.assertNotIn(str(run), result.stderr)


if __name__ == "__main__":
    unittest.main()
