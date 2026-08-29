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
