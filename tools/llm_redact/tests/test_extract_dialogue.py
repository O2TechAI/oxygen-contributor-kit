import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest


MODULE_PATH = Path(__file__).resolve().parents[1] / "extract_dialogue.py"
SPEC = importlib.util.spec_from_file_location("extract_dialogue", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def write_meeting(run: Path, meeting_id: str, *, root=False, records=None) -> Path:
    directory = run if root else run / "meetings" / meeting_id
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "meeting.json"
    path.write_text(json.dumps({
        "meeting_id": meeting_id,
        "records": records if records is not None else [{
            "record_id": "record-000001",
            "text": f"safe synthetic text for {meeting_id}",
        }],
    }), encoding="utf-8")
    return path


def write_trajectory(run: Path) -> None:
    directory = run / "trajectories" / "traj-safe"
    directory.mkdir(parents=True)
    (directory / "events.jsonl").write_text(json.dumps({
        "event_id": "evt-" + "a" * 64,
        "event_type": "message",
        "payload": {"role": "user", "text": "safe trajectory text"},
    }) + "\n", encoding="utf-8")


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

    def test_legacy_root_meeting_still_extracts(self):
        with TemporaryDirectory() as temp:
            run = Path(temp, "review")
            write_meeting(run, "meeting-000001", root=True)

            bundles = MODULE.extract_bundles(run)

            self.assertEqual(len(bundles), 1)
            self.assertEqual(bundles[0]["trajectory"], "meeting-000001")
            self.assertEqual(bundles[0]["document_kind"], "meeting")

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
            self.assertEqual(turns[0]["event_id"], "stable-record")
            self.assertRegex(
                turns[1]["item_id"],
                r"^meeting-000001:rec-[0-9a-f]{64}$",
            )
            self.assertEqual(turns[1]["event_id"], "record-000002")
            self.assertEqual([turn["text"] for turn in turns], [
                "safe stable record", "safe fallback record",
            ])

    def test_trajectory_root_and_plural_meetings_keep_deterministic_order(self):
        with TemporaryDirectory() as temp:
            run = Path(temp, "review")
            write_trajectory(run)
            write_meeting(run, "meeting-000001", root=True)
            write_meeting(run, "meeting-000002")
            write_meeting(run, "meeting-000003")

            bundles = MODULE.extract_bundles(run)

            self.assertEqual(
                [bundle["trajectory"] for bundle in bundles],
                ["traj-safe", "meeting-000001", "meeting-000002", "meeting-000003"],
            )

    def test_duplicate_and_malformed_prepared_meetings_fail_closed(self):
        with TemporaryDirectory() as temp:
            run = Path(temp, "review")
            write_meeting(run, "meeting-000001", root=True)
            write_meeting(run, "meeting-000001")
            with self.assertRaisesRegex(
                SystemExit, "^INPUT_MEETING_ID_DUPLICATE$"
            ):
                MODULE.extract_bundles(run)

        with TemporaryDirectory() as temp:
            run = Path(temp, "review")
            write_meeting(run, "meeting-000001", records="not-a-list")
            with self.assertRaisesRegex(SystemExit, "^INPUT_MEETING_INVALID$"):
                MODULE.extract_bundles(run)


if __name__ == "__main__":
    unittest.main()
