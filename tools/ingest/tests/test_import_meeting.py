import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


KIT_ROOT = Path(__file__).resolve().parents[3]
MODULE_PATH = KIT_ROOT / "tools" / "ingest" / "import_meeting.py"
sys.path.insert(0, str(MODULE_PATH.parent))
import oxygen_common as COMMON
SPEC = importlib.util.spec_from_file_location("oxygen_import_meeting_test", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def run_main(*arguments: object) -> dict:
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        result = MODULE.main([str(argument) for argument in arguments])
    if result != 0:
        raise AssertionError(f"import returned {result}")
    return json.loads(output.getvalue().strip().splitlines()[-1])


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


class ImportMeetingParserTest(unittest.TestCase):
    def test_speaker_time_matrix_preserves_turn_ownership_and_source_anchors(self):
        text = (
            "\nAlex O'Neil (Host) 9:05 AM\n"
            "Opening line\nWe reconvene at 10:45 AM\n\nSecond line\n\n"
            "[李 小龙] 14:06:07\n中文正文\n"
            "Alex O'Neil (Host) 09:07:08 PM\nClosing line\n"
            "[Jean-Luc O’Neil] 23:59\nOne-line body\n\n"
        )

        records, detected = MODULE.parse_lines(text)

        self.assertEqual(detected, "speaker-time")
        self.assertEqual(
            [
                (record["speaker"], record["timestamp"], record["source_line"], record["text"])
                for record in records
            ],
            [
                ("Alex O'Neil (Host)", "9:05 AM", 2,
                 "Opening line\nWe reconvene at 10:45 AM\nSecond line"),
                ("李 小龙", "14:06:07", 8, "中文正文"),
                ("Alex O'Neil (Host)", "09:07:08 PM", 10, "Closing line"),
                ("Jean-Luc O’Neil", "23:59", 12, "One-line body"),
            ],
        )
        self.assertEqual([record["record_id"] for record in records], [
            "rec-00001", "rec-00002", "rec-00003", "rec-00004",
        ])
        self.assertEqual([record["order"] for record in records], [1, 2, 3, 4])

    def test_speaker_time_layout_is_stable_across_newlines_blanks_names_and_counts(self):
        families = (
            (("[Ava Stone]", "08:01", ("alpha",)),),
            (
                ("Speaker 7", "1:02 PM", ("beta one", "beta two")),
                ("[Noémie D'Arcy]", "13:03:04", ("gamma",)),
            ),
            (
                ("张 三", "07:00", ("one",)),
                ("[Rina-Soo Park]", "7:01:02 am", ("two",)),
                ("张 三", "19:02", ("three",)),
            ),
        )

        for turns in families:
            with self.subTest(record_count=len(turns)):
                compact = "\n".join(
                    line
                    for speaker, clock, body in turns
                    for line in (f"{speaker} {clock}", *body)
                ) + "\n"
                separated = "\n\n".join(
                    "\n".join((f"{speaker} {clock}", *body))
                    for speaker, clock, body in turns
                ) + "\n\n"
                variants = (compact, compact.replace("\n", "\r\n"), separated)
                normalized = []
                for variant in variants:
                    records, detected = MODULE.parse_lines(variant)
                    self.assertEqual(detected, "speaker-time")
                    self.assertEqual(len(records), len(turns))
                    normalized.append([
                        (record["speaker"], record["timestamp"], record["text"])
                        for record in records
                    ])
                self.assertEqual(normalized[1:], normalized[:1] * 2)

    def test_explicit_single_and_recurrent_bare_speakers_are_accepted(self):
        cases = (
            (
                "[Solo Speaker] 08:01:02\none\ntwo\n",
                [("Solo Speaker", "08:01:02", 1, "one\ntwo")],
            ),
            (
                "Dana North 09:00\none\nLee West 09:10\ntwo\n"
                "Dana North 09:20\nthree\nLee West 09:30\nfour\n",
                [
                    ("Dana North", "09:00", 1, "one"),
                    ("Lee West", "09:10", 3, "two"),
                    ("Dana North", "09:20", 5, "three"),
                    ("Lee West", "09:30", 7, "four"),
                ],
            ),
        )
        for text, expected in cases:
            with self.subTest(expected=expected):
                records, detected = MODULE.parse_lines(text)
                self.assertEqual(detected, "speaker-time")
                self.assertEqual([
                    (row["speaker"], row["timestamp"], row["source_line"], row["text"])
                    for row in records
                ], expected)

    def test_speaker_time_structural_evidence_fails_closed(self):
        cases = {
            "malformed header": "[Alice Stone] 09:00\none\n[Bob Reed] 25:61\ntwo\n",
            "missing body": "[Alice Stone] 09:00\n[Bob Reed] 10:00\ntwo\n",
            "incomplete final header": "[Alice Stone] 09:00\none\n[Bob Reed] 10:00\n",
            "mixed plain preamble": (
                "ordinary preamble\n[Alice Stone] 09:00\none\n[Bob Reed] 10:00\ntwo\n"
            ),
            "mixed structured layouts": (
                "[Alice Stone] 09:00\none\nBob Reed: ambiguous owner\n"
                "[Carol Jones] 10:00\nthree\n"
            ),
            "recurring malformed clocks": (
                "[Dana North] 25:61\nFirst body\n[Lee West] 24:99\nSecond body\n"
            ),
            "monotonic singleton bare title": (
                "Dana North 09:00\none\nLee West 09:10\ntwo\n"
                "Checkpoint Review 09:15\nordinary body\nDana North 09:20\nthree\n"
                "Lee West 09:30\nfour\n"
            ),
            "multiple unique bare candidates": "Dana North 09:00\none\nLee West 09:10\ntwo\n",
            "unbalanced bracket": "[Dana North 09:00\none\n",
            "nested bracket": "[[Dana North]] 09:00\none\n",
        }
        for name, text in cases.items():
            with self.subTest(name=name), self.assertRaises(MODULE.MeetingStructureError):
                MODULE.parse_lines(text)

    def test_plain_and_existing_structured_records_are_behaviorally_unchanged(self):
        cases = (
            (
                "ordinary prose\nzero-speaker note\n",
                "plain",
                [
                    {"timestamp": None, "speaker": None, "text": "ordinary prose",
                     "source_line": 1, "record_id": "rec-00001", "order": 1},
                    {"timestamp": None, "speaker": None, "text": "zero-speaker note",
                     "source_line": 2, "record_id": "rec-00002", "order": 2},
                ],
            ),
            (
                "Checkpoint Review 14:30\nThe release continues tomorrow.\n",
                "plain",
                [
                    {"timestamp": None, "speaker": None, "text": "Checkpoint Review 14:30",
                     "source_line": 1, "record_id": "rec-00001", "order": 1},
                    {"timestamp": None, "speaker": None,
                     "text": "The release continues tomorrow.", "source_line": 2,
                     "record_id": "rec-00002", "order": 2},
                ],
            ),
            (
                "0:01Speaker Afirst\ncontinuation\n0:02Speaker Bsecond\n",
                "timestamped",
                [
                    {"timestamp": "0:01", "speaker": "A", "text": "first continuation",
                     "source_line": 1, "record_id": "rec-00001", "order": 1},
                    {"timestamp": "0:02", "speaker": "B", "text": "second",
                     "source_line": 3, "record_id": "rec-00002", "order": 2},
                ],
            ),
            (
                "Alice: first\ncontinuation\nBob: second\n",
                "speaker-labeled",
                [
                    {"timestamp": None, "speaker": "Alice", "text": "first continuation",
                     "source_line": 1, "record_id": "rec-00001", "order": 1},
                    {"timestamp": None, "speaker": "Bob", "text": "second",
                     "source_line": 3, "record_id": "rec-00002", "order": 2},
                ],
            ),
        )
        for text, detected, expected in cases:
            with self.subTest(detected=detected):
                self.assertEqual(MODULE.parse_lines(text), (expected, detected))

    def test_documented_multiword_and_unicode_speaker_labels_are_preserved(self):
        records, detected = MODULE.parse_lines(
            "Speaker A: first\nAlex Smith  :   second\n张三: 第三\n李  小龙: 第四\n说话人0: 第五\n"
        )

        self.assertEqual(detected, "speaker-labeled")
        self.assertEqual(
            [(record["speaker"], record["text"]) for record in records],
            [
                ("Speaker A", "first"),
                ("Alex Smith", "second"),
                ("张三", "第三"),
                ("李  小龙", "第四"),
                ("说话人0", "第五"),
            ],
        )

    def test_single_token_timestamped_and_plain_formats_remain_distinct(self):
        cases = (
            ("Alice: hello\nBob: goodbye\n", "speaker-labeled", ["Alice", "Bob"]),
            ("0:01Speaker Ahello\n0:02Speaker Bgoodbye\n", "timestamped", ["A", "B"]),
            ("ordinary prose\nNote: metadata, not dialogue\n", "plain", [None, None]),
        )
        for text, expected_format, expected_speakers in cases:
            with self.subTest(expected_format=expected_format):
                records, detected = MODULE.parse_lines(text)
                self.assertEqual(detected, expected_format)
                self.assertEqual(
                    [record["speaker"] for record in records], expected_speakers
                )

    def test_non_speaker_colon_forms_remain_plain(self):
        cases = (
            r"C:\Users\Bruce\meeting.txt",
            "http://example.com/meeting",
            "https://example.com/meeting",
            "12:30 agenda",
            "key: value",
            "title: weekly sync",
            "Name: Alex",
            "speaker: Alex",
            "Meeting Notes: text",
            '\"speaker\": \"Alex\"',
            ": missing label",
            "Alex:",
            f"{'A' * 25}: text",
            "Alex:Smith: text",
            "Alex: text\t",
            "Al\x00ex: text",
            "Alex: text\x00",
        )
        for line in cases:
            with self.subTest(line=repr(line)):
                records, detected = MODULE.parse_lines(line)
                self.assertEqual(detected, "plain")
                self.assertEqual(len(records), 1)
                self.assertIsNone(records[0]["speaker"])


class ImportMeetingTopologyTest(unittest.TestCase):
    def test_speaker_time_import_preserves_schema_privacy_and_exact_fields(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "synthetic.txt"
            source.write_text(
                "[Ada North] 11:02 AM\nfirst line\nsecond line\n"
                "[Béla West] 16:03:04\nthird line\n",
                encoding="utf-8",
            )
            run = root / "run"

            result = run_main(
                source, "--out", run, "--meeting-id", "speaker-time",
                "--title", "Synthetic", "--date", "2026-08-30",
            )

            meeting = run / "meetings" / "speaker-time"
            dataset = json.loads((meeting / "meeting.json").read_text(encoding="utf-8"))
            self.assertEqual(result["meetings"][0]["detected_format"], "speaker-time")
            self.assertEqual(dataset["schema"], MODULE.MEETING_SCHEMA)
            self.assertEqual(dataset["tool"], "import_meeting")
            self.assertEqual(dataset["speakers"], ["Ada North", "Béla West"])
            self.assertEqual(
                [(row["speaker"], row["timestamp"], row["text"]) for row in dataset["records"]],
                [
                    ("Ada North", "11:02 AM", "first line\nsecond line"),
                    ("Béla West", "16:03:04", "third line"),
                ],
            )
            self.assertTrue(dataset["contains_unredacted_source_text"])
            self.assertEqual(dataset["review_status"], "pending")
            self.assertFalse(dataset["publication_approved"])

    def test_hostile_structural_failure_emits_only_safe_code_and_no_artifacts(self):
        with tempfile.TemporaryDirectory(prefix="HOSTILE_PATH_SENTINEL_") as temporary:
            root = Path(temporary)
            sentinel = "HOSTILE_BODY_SENTINEL_https_example_invalid"
            source = root / "synthetic.txt"
            source.write_text(
                f"Alice Stone 09:00\n{sentinel}\nBob Reed 10:00\n",
                encoding="utf-8",
            )
            run = root / "run"

            result = subprocess.run(
                [sys.executable, str(MODULE_PATH), str(source), "--out", str(run)],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
            )

            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, "")
            self.assertEqual(
                result.stderr.splitlines(), [MODULE.STRUCTURAL_FAILURE_CODE]
            )
            captured = result.stdout + result.stderr
            for leaked in (
                "Traceback", str(root), str(KIT_ROOT), sentinel, "https", "example", "invalid",
            ):
                self.assertNotIn(leaked, captured)
            self.assertFalse(run.exists())
            for artifact in ("meeting.json", "raw.md", "timestamped.txt"):
                self.assertEqual(list(root.rglob(artifact)), [])

    def test_documented_text_command_shape_reaches_import_boundary(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "meeting notes.txt"
            source.write_text("Speaker A: bounded text\n", encoding="utf-8")
            out = root / "meeting-run"

            result = run_main(source, "--out", out)

            self.assertEqual(result["meeting_count"], 1)
            self.assertTrue(Path(result["meetings"][0]["output"]).is_dir())

    def test_canonical_docs_contain_no_removed_no_publish_flag(self):
        for name in ("README.md", "SOP.md"):
            with self.subTest(name=name):
                text = (KIT_ROOT / name).read_text(encoding="utf-8")
                self.assertNotIn("--no-publish", text)

    def test_mocked_reparse_metadata_is_detected_and_unknown_windows_metadata_fails_closed(self):
        reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
        metadata = SimpleNamespace(
            st_mode=stat.S_IFDIR,
            st_file_attributes=reparse_flag,
        )
        self.assertTrue(COMMON._is_link_or_reparse(metadata, windows=True))
        with self.assertRaisesRegex(ValueError, "cannot prove"):
            COMMON._is_link_or_reparse(SimpleNamespace(st_mode=stat.S_IFDIR), windows=True)

    def test_output_root_junction_fails_before_touching_external_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "meeting.txt"
            source.write_text("private meeting\n", encoding="utf-8")
            external = root / "external"
            external.mkdir()
            (external / "sentinel.bin").write_bytes(b"junction sentinel\x00")
            before = tree_snapshot(external)
            requested = root / "requested-run"
            cleanup = junction_or_symlink(self, requested, external)
            try:
                with self.assertRaises(SystemExit):
                    run_main(source, "--out", requested, "--meeting-id", "meeting-junction")
                self.assertEqual(tree_snapshot(external), before)
            finally:
                cleanup()

    def test_hard_linked_meeting_file_fails_before_any_mutation(self):
        for artifact in ("meeting.json", "raw.md", "timestamped.txt"):
            with self.subTest(artifact=artifact), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                source = root / "meeting.txt"
                source.write_text("private meeting\n", encoding="utf-8")
                external = root / f"external-{artifact}"
                external.write_bytes(b"hard-link sentinel\x00")
                run = root / "run"
                meeting = run / "meetings" / "meeting-hard-link"
                meeting.mkdir(parents=True)
                hard_link_or_skip(self, external, meeting / artifact)
                before_run = tree_snapshot(run)
                before_external = external.read_bytes()

                with self.assertRaises(SystemExit):
                    run_main(source, "--out", run, "--meeting-id", "meeting-hard-link")

                self.assertEqual(external.read_bytes(), before_external)
                self.assertEqual(tree_snapshot(run), before_run)

    def test_single_explicit_output_uses_plural_topology_and_all_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "notes.txt"
            source.write_text("Speaker A: first\nSpeaker B: second\n", encoding="utf-8")
            run = root / "run"

            result = run_main(
                source, "--out", run, "--meeting-id", "meeting-stable",
                "--title", "Stable meeting", "--date", "2026-08-27",
            )

            meeting = run / "meetings" / "meeting-stable"
            self.assertEqual(result["output"], str(run.resolve()))
            self.assertEqual(result["meeting_count"], 1)
            self.assertEqual(result["meetings"][0]["meeting_id"], "meeting-stable")
            self.assertEqual(result["meetings"][0]["output"], str(meeting.resolve()))
            self.assertNotIn("staged", result["meetings"][0])
            for name in ("meeting.json", "raw.md", "timestamped.txt"):
                self.assertFalse((run / name).exists())
            self.assertEqual(
                {path.name for path in meeting.iterdir()},
                {"meeting.json", "raw.md", "timestamped.txt"},
            )
            dataset = json.loads((meeting / "meeting.json").read_text(encoding="utf-8"))
            self.assertEqual(dataset["meeting_id"], "meeting-stable")
            self.assertEqual(dataset["title"], "Stable meeting")
            self.assertEqual(dataset["detected_format"], "speaker-labeled")
            self.assertEqual(dataset["speakers"], ["Speaker A", "Speaker B"])
            self.assertFalse(dataset["publication_approved"])
            expected_stamped = "Speaker A: first\nSpeaker B: second\n"
            self.assertEqual(
                (meeting / "timestamped.txt").read_bytes(), expected_stamped.encode("utf-8")
            )

    def test_output_is_required_before_any_run_is_created(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fake_module = root / "tools" / "ingest" / "import_meeting.py"
            fake_module.parent.mkdir(parents=True)
            source = root / "timestamped.txt"
            source.write_text("0:01Speaker Ahello\n", encoding="utf-8")

            with (
                mock.patch.object(MODULE, "__file__", str(fake_module)),
                self.assertRaises(SystemExit),
            ):
                run_main(source, "--meeting-id", "meeting-default")

            self.assertFalse((fake_module.parent / "out").exists())

    def test_missing_source_cli_emits_only_fixed_code(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            sentinel = "HOSTILE_MEETING_SENTINEL"
            exception_body = "synthetic-exception-body"
            source = root / f"missing-{sentinel}-https-example.invalid-{exception_body}.txt"
            out = root / "requested-output"

            result = subprocess.run(
                [sys.executable, str(MODULE_PATH), str(source), "--out", str(out)],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
            )
            captured = result.stdout + result.stderr

            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, "")
            self.assertEqual(result.stderr.splitlines(), ["MEETING_SOURCE_INVALID"])
            for leaked in (
                "Traceback", str(root), str(KIT_ROOT), sentinel,
                "https", "example.invalid", exception_body,
            ):
                self.assertNotIn(leaked, captured)
            self.assertFalse(out.exists())

    def test_audio_cli_uses_temporary_asr_scratch_and_leaves_only_canonical_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "meeting.wav"
            source.write_bytes(b"local audio fixture")
            run = root / "run"
            asr_outputs = []

            class SuccessfulAsr:
                stdout = iter(['PROGRESS {"pct": 100, "stage": "done"}\n'])

                @staticmethod
                def wait():
                    return 0

            def run_mock_asr(command, **_kwargs):
                self.assertIn("--language", command)
                self.assertEqual(command[command.index("--language") + 1], "en")
                asr_out = Path(command[command.index("--out") + 1])
                asr_outputs.append(asr_out)
                asr_out.mkdir(parents=True)
                (asr_out / "timestamped.txt").write_text(
                    "0:01Speaker Ahello from audio\n", encoding="utf-8"
                )
                (asr_out / "intermediate.bin").write_bytes(b"temporary")
                return SuccessfulAsr()

            with mock.patch.object(MODULE.subprocess, "Popen", side_effect=run_mock_asr):
                result = run_main(
                    source, "--out", run, "--meeting-id", "meeting-audio",
                    "--language", "en",
                )

            meeting = run / "meetings" / "meeting-audio"
            self.assertEqual(result["meetings"][0]["output"], str(meeting.resolve()))
            self.assertEqual(
                {path.name for path in meeting.iterdir()},
                {"meeting.json", "raw.md", "timestamped.txt"},
            )
            self.assertEqual(len(asr_outputs), 1)
            self.assertNotEqual(asr_outputs[0], meeting)
            self.assertNotIn(meeting, asr_outputs[0].parents)
            self.assertFalse(asr_outputs[0].exists())

    def test_multi_source_run_keeps_records_separate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = root / "alpha.txt"
            second = root / "beta.txt"
            first.write_text("Speaker A: alpha private text\n", encoding="utf-8")
            second.write_text("张三: beta private text\n", encoding="utf-8")
            run = root / "run"

            result = run_main(first, second, "--out", run)

            expected_ids = [
                f"meeting-alpha-{hashlib.sha256(first.read_bytes()).hexdigest()}",
                f"meeting-beta-{hashlib.sha256(second.read_bytes()).hexdigest()}",
            ]
            self.assertEqual(result["meeting_count"], 2)
            self.assertEqual([item["meeting_id"] for item in result["meetings"]], expected_ids)
            self.assertFalse((run / "meeting.json").exists())
            for meeting_id, expected_speaker, expected_text, foreign_text in (
                (expected_ids[0], "Speaker A", "alpha private text", "beta private text"),
                (expected_ids[1], "张三", "beta private text", "alpha private text"),
            ):
                meeting = run / "meetings" / meeting_id
                dataset = json.loads((meeting / "meeting.json").read_text(encoding="utf-8"))
                self.assertEqual(dataset["meeting_id"], meeting_id)
                self.assertEqual(dataset["detected_format"], "speaker-labeled")
                self.assertEqual(dataset["speakers"], [expected_speaker])
                self.assertEqual(dataset["records"][0]["record_id"], "rec-00001")
                self.assertEqual([record["text"] for record in dataset["records"]], [expected_text])
                self.assertNotIn(foreign_text, (meeting / "raw.md").read_text(encoding="utf-8"))
                self.assertFalse(dataset["publication_approved"])
                self.assertEqual(
                    (meeting / "timestamped.txt").read_text(encoding="utf-8"),
                    f"{expected_speaker}: {expected_text}\n",
                )

    def test_generated_identity_is_stable_and_content_bound(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "same name.txt"
            source.write_text("same content\n", encoding="utf-8")

            first = run_main(source, "--out", root / "first")
            second = run_main(source, "--out", root / "second")
            first_id = first["meetings"][0]["meeting_id"]
            self.assertEqual(second["meetings"][0]["meeting_id"], first_id)
            self.assertEqual(
                first_id,
                f"meeting-same-name-{hashlib.sha256(source.read_bytes()).hexdigest()}",
            )
            first_output = Path(first["meetings"][0]["output"])
            self.assertEqual(first_output.name, first_id)
            self.assertEqual(first_output.parent.name, "meetings")

            source.write_text("changed content\n", encoding="utf-8")
            changed = run_main(source, "--out", root / "changed")
            self.assertNotEqual(changed["meetings"][0]["meeting_id"], first_id)

    def test_writable_historical_shared_locations_remain_byte_for_byte_unchanged(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "meeting.txt"
            source.write_text("plain record\n", encoding="utf-8")
            run = root / "run"
            shared = root.joinpath("srv", "shared", "oxygen", "data", "ingest" + "-staging")
            (shared / "existing-run").mkdir(parents=True)
            (shared / "existing-run" / "private.bin").write_bytes(b"private\x00bytes")
            (shared / "INBOX.md").write_bytes(b"existing inbox\n")
            webapp_data = root / ("webapp" + "-data")
            webapp_data.mkdir()
            (webapp_data / "sentinel.json").write_bytes(b'{"unchanged":true}\n')
            before_shared = tree_snapshot(shared)
            before_webapp = tree_snapshot(webapp_data)

            with mock.patch.object(COMMON, "STAGING_DIR", shared, create=True):
                result = run_main(
                    source, "--out", run, "--meeting-id", "meeting-local",
                )

            self.assertEqual(result["meeting_count"], 1)
            self.assertEqual(tree_snapshot(shared), before_shared)
            self.assertEqual(tree_snapshot(webapp_data), before_webapp)

    def test_explicit_identity_cannot_escape_the_run(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "meeting.txt"
            source.write_text("plain record\n", encoding="utf-8")
            with self.assertRaises(SystemExit):
                run_main(
                    source, "--out", root / "run", "--meeting-id", "../outside",
                )
            self.assertFalse((root / "outside").exists())


if __name__ == "__main__":
    unittest.main()
