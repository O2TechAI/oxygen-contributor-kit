import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "extract_dialogue.py"
SPEC = importlib.util.spec_from_file_location("extract_dialogue", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def write_meeting(run: Path, meeting_id: str, *, root=False, records=None) -> Path:
    directory = run if root else run / "meetings" / meeting_id
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "meeting.json"
    meeting_records = records if records is not None else [{
        "record_id": "record-000001",
        "text": f"safe synthetic text for {meeting_id}",
    }]
    if isinstance(meeting_records, list):
        meeting_records = [
            {**record, "sequence_in_meeting": record.get("sequence_in_meeting", index)}
            if isinstance(record, dict) else record
            for index, record in enumerate(meeting_records, 1)
        ]
    path.write_text(json.dumps({
        "schema": MODULE.AI_REVIEW_MEETING_SCHEMA,
        "meeting_id": meeting_id,
        "records": meeting_records,
    }), encoding="utf-8")
    return path


def write_trajectory(run: Path) -> None:
    directory = run / "trajectories" / "traj-safe"
    directory.mkdir(parents=True)
    event = {
        "schema": MODULE.AI_REVIEW_EVENT_SCHEMA,
        "event_id": "evt-" + "a" * 64,
        "event_type": "message",
        "payload": {"role": "user", "text": "safe trajectory text"},
    }
    (directory / "events.jsonl").write_text(json.dumps(event) + "\n", encoding="utf-8")
    (directory / "manifest.json").write_text(json.dumps({
        "schema": MODULE.AI_REVIEW_TRAJECTORY_SCHEMA,
        "trajectory_id": "traj-safe",
        "event_count": 1,
        "contribution_projection": {
            "policy_id": MODULE.POLICY_ID,
            "raw_source_digest": "a" * 64,
            "projected_universe_digest": MODULE.digest_events([event]),
            "raw_event_count": 1,
            "normalized_event_count": 1,
            "kept_event_count": 1,
            "dropped_event_count": 0,
            "cross_trajectory_semantic_replay_count": 0,
        },
    }), encoding="utf-8")
    (run / "index.json").write_text(json.dumps({
        "schema": MODULE.AI_REVIEW_RUN_SCHEMA,
        "tool": "prepare_ai_review_run",
        "trajectory_count": 1,
        "meeting_count": 0,
        "source_warning_count": 0,
        "review_status": "pending",
        "publication_approved": False,
        "trajectories": [{"trajectory_id": "traj-safe", "ok": True}],
    }), encoding="utf-8")


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


class ExtractDialogueTest(unittest.TestCase):
    def test_trajectory_turn_carries_exact_canonical_pair(self):
        with TemporaryDirectory() as temp:
            run = Path(temp, "review")
            write_trajectory(run)

            bundle = MODULE.extract_bundles(run)[0]

            self.assertEqual(bundle["document_kind"], "trajectory")
            self.assertEqual(bundle["turns"][0]["document_id"], "traj-safe")
            self.assertEqual(bundle["turns"][0]["item_id"], "evt-" + "a" * 64)
            self.assertEqual(bundle["turns"][0]["event_id"], "evt-" + "a" * 64)

    def test_foreign_trajectory_outside_run_index_is_rejected(self):
        with TemporaryDirectory() as temp:
            run = Path(temp, "review")
            write_trajectory(run)
            shutil.copytree(
                run / "trajectories" / "traj-safe",
                run / "trajectories" / "traj-foreign",
            )

            with self.assertRaisesRegex(
                SystemExit, "^SOURCE_PRIVACY_DIALOGUE_INPUT_INVALID$",
            ):
                MODULE.extract_bundles(run)

    def test_root_meeting_is_rejected(self):
        with TemporaryDirectory() as temp:
            run = Path(temp, "review")
            write_meeting(run, "meeting-000001", root=True)

            with self.assertRaisesRegex(SystemExit, "^INPUT_MEETING_INVALID$"):
                MODULE.extract_bundles(run)

    def test_root_meeting_symlink_is_rejected(self):
        with TemporaryDirectory() as temp:
            run = Path(temp, "review")
            run.mkdir()
            root_meeting = (
                MODULE.assert_literal_physical_path(run).resolve(strict=True)
                / "meeting.json"
            )
            with mock.patch.object(
                Path, "is_symlink", autospec=True,
                side_effect=lambda path: path == root_meeting,
            ):
                with self.assertRaisesRegex(SystemExit, "^INPUT_MEETING_INVALID$"):
                    MODULE.extract_bundles(run)

    def test_plural_meetings_extract_separately_with_distinct_identity(self):
        with TemporaryDirectory() as temp:
            run = Path(temp, "review")
            write_meeting(run, "meeting-000001")
            write_meeting(run, "meeting-000002")

            bundles = MODULE.extract_bundles(run)

            self.assertEqual(
                [bundle["trajectory"] for bundle in bundles],
                ["meeting-000001", "meeting-000002"],
            )
            self.assertTrue(all(bundle["document_kind"] == "meeting" for bundle in bundles))
            self.assertTrue(all(len(bundle["turns"]) == 1 for bundle in bundles))
            self.assertEqual(
                [bundle["turns"][0]["item_id"] for bundle in bundles],
                ["meeting-000001:record-000001", "meeting-000002:record-000001"],
            )
            self.assertEqual(
                [bundle["turns"][0]["document_id"] for bundle in bundles],
                ["meeting-000001", "meeting-000002"],
            )

    def test_meeting_record_and_fallback_identities_match_importer(self):
        with TemporaryDirectory() as temp:
            run = Path(temp, "review")
            records = [
                {"record_id": "stable-record", "text": "safe stable record"},
                {"text": "safe fallback record"},
            ]
            write_meeting(run, "meeting-000001", records=records)

            turns = MODULE.extract_bundles(run)[0]["turns"]

            self.assertEqual(turns[0]["item_id"], "meeting-000001:stable-record")
            self.assertEqual(turns[0]["event_id"], "meeting-000001:stable-record")
            self.assertRegex(
                turns[1]["item_id"],
                r"^meeting-000001:rec-[0-9a-f]{64}$",
            )
            self.assertEqual(turns[1]["event_id"], turns[1]["item_id"])
            self.assertEqual([turn["text"] for turn in turns], [
                "safe stable record", "safe fallback record",
            ])

    def test_trajectory_and_plural_meetings_keep_deterministic_order(self):
        with TemporaryDirectory() as temp:
            run = Path(temp, "review")
            write_trajectory(run)
            write_meeting(run, "meeting-000001")
            write_meeting(run, "meeting-000002")

            bundles = MODULE.extract_bundles(run)

            self.assertEqual(
                [bundle["trajectory"] for bundle in bundles],
                ["meeting-000001", "meeting-000002", "traj-safe"],
            )

    def test_output_identity_is_validated_before_any_staging_write(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            invalid = {
                "trajectory": "../escaped",
                "document_kind": "trajectory",
                "turns": [{
                    "event_id": "evt-" + "a" * 64,
                    "document_id": "../escaped",
                    "item_id": "evt-" + "a" * 64,
                    "sequence": 1,
                    "role": "user",
                    "timestamp": None,
                    "text": "safe synthetic text",
                }],
                "chars": len("safe synthetic text"),
            }
            authority = {
                "workflowRunId": "workflow-safe",
                "sourceRevision": 1,
                "finalizedCorpus": {
                    "revision": 1,
                    "digest": "c" * 64,
                    "documentCount": 1,
                    "itemCount": 1,
                },
                "sourceDigest": "d" * 64,
            }

            with self.assertRaisesRegex(SystemExit, "^SOURCE_PRIVACY_DIALOGUE_INVALID$"):
                MODULE.install_dialogue_output(root / "out", authority, [invalid])

            self.assertFalse((root / "out").exists())
            self.assertFalse((root / "escaped.json").exists())

    def test_output_late_collision_preserves_owner_and_returns_fixed_error(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            output = root / "dialogue"
            text = "safe synthetic text"
            bundle = {
                "trajectory": "traj-safe",
                "document_kind": "trajectory",
                "turns": [{
                    "event_id": "evt-" + "a" * 64,
                    "document_id": "traj-safe",
                    "item_id": "evt-" + "a" * 64,
                    "sequence": 1,
                    "role": "user",
                    "timestamp": None,
                    "text": text,
                }],
                "chars": len(text),
            }
            authority = {
                "workflowRunId": "workflow-safe",
                "sourceRevision": 1,
                "finalizedCorpus": {
                    "revision": 1,
                    "digest": "c" * 64,
                    "documentCount": 1,
                    "itemCount": 1,
                },
                "sourceDigest": "d" * 64,
            }

            def collide(_stage: Path, final: Path) -> None:
                final.mkdir()
                (final / "owner.txt").write_text("owner", encoding="utf-8")
                raise FileExistsError

            with mock.patch.object(MODULE, "rename_noreplace", side_effect=collide), \
                    self.assertRaisesRegex(
                        SystemExit, "^SOURCE_PRIVACY_DIALOGUE_OUTPUT_EXISTS$",
                    ):
                MODULE.install_dialogue_output(output, authority, [bundle])

            self.assertEqual((output / "owner.txt").read_text(encoding="utf-8"), "owner")
            self.assertEqual(list(root.glob(".dialogue.*.tmp")), [])

    def test_duplicate_and_malformed_prepared_meetings_fail_closed(self):
        with TemporaryDirectory() as temp:
            run = Path(temp, "review")
            write_meeting(run, "meeting-000001")
            duplicate = write_meeting(run, "meeting-000002")
            payload = json.loads(duplicate.read_text(encoding="utf-8"))
            payload["meeting_id"] = "meeting-000001"
            duplicate.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(
                SystemExit, "^INPUT_MEETING_INVALID$"
            ):
                MODULE.extract_bundles(run)

        with TemporaryDirectory() as temp:
            run = Path(temp, "review")
            write_meeting(run, "meeting-000001", records="not-a-list")
            with self.assertRaisesRegex(SystemExit, "^INPUT_MEETING_INVALID$"):
                MODULE.extract_bundles(run)

    def test_contained_meeting_directory_alias_fails_at_extraction(self):
        with TemporaryDirectory() as temp:
            run = Path(temp, "review")
            target = write_meeting(run, "real-id").parent
            directory_link_or_skip(self, run / "meetings" / "alias-id", target)

            with self.assertRaisesRegex(SystemExit, "^INPUT_MEETING_INVALID$"):
                MODULE.extract_bundles(run)

    def test_contained_meetings_root_alias_fails_at_extraction(self):
        with TemporaryDirectory() as temp:
            run = Path(temp, "review")
            write_meeting(run, "real-id")
            hidden = run / "hidden"
            (run / "meetings").rename(hidden)
            directory_link_or_skip(self, run / "meetings", hidden)

            with self.assertRaisesRegex(SystemExit, "^INPUT_MEETING_INVALID$"):
                MODULE.extract_bundles(run)


if __name__ == "__main__":
    unittest.main()
