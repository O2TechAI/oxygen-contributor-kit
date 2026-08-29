import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest import mock


def load_script(name: str):
    path = Path(__file__).resolve().parents[1] / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


VERIFY = load_script("verify_coverage")
PUSH = load_script("push_redactions")


EVENT_ID = "evt-" + "a" * 64


def write_push_fixture(root: Path, *, turn_updates=None, trajectory="traj-1") -> tuple[Path, Path]:
    redacted = root / "redacted"
    redacted.mkdir()
    turn = {
        "event_id": EVENT_ID,
        "document_id": trajectory,
        "item_id": EVENT_ID,
        "role": "user",
        "text": "safe synthetic text",
        "redactions": [{
            "start": 0,
            "end": 4,
            "category": "sensitive",
            "review_state": "deterministic",
            "uncertainty_reason": None,
        }],
    }
    turn.update(turn_updates or {})
    (redacted / f"{trajectory}.json").write_text(json.dumps({
        "trajectory": trajectory,
        "document_kind": "trajectory",
        "turns": [turn],
    }), encoding="utf-8")
    report = root / "report.json"
    report.write_text(json.dumps({
        "rejected": 0,
        "missing_worker_output": [],
    }), encoding="utf-8")
    return redacted, report


class ReleaseGateTest(unittest.TestCase):
    def test_missing_worker_file_fails_coverage(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            dialogue = root / "dialogue"
            findings = root / "findings"
            dialogue.mkdir()
            findings.mkdir()
            (dialogue / "traj-1.json").write_text(
                json.dumps({"trajectory": "traj-1", "turns": [{"event_id": "evt-1"}]}),
                encoding="utf-8",
            )
            argv = sys.argv
            try:
                sys.argv = [
                    "verify_coverage.py", "--dialogue", str(dialogue),
                    "--findings", str(findings),
                ]
                with contextlib.redirect_stdout(io.StringIO()) as output:
                    result = VERIFY.main()
            finally:
                sys.argv = argv
            self.assertEqual(result, 1)
            self.assertIn("MISSING traj-1", output.getvalue())

    def test_push_report_blocks_incomplete_worker_coverage(self):
        with TemporaryDirectory() as temp:
            report = Path(temp) / "report.json"
            report.write_text(
                json.dumps({"rejected": 0, "missing_worker_output": ["traj-2"]}),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(SystemExit, "traj-2"):
                PUSH.load_report(report)

    def test_push_report_missing_fails_closed(self):
        with TemporaryDirectory() as temp:
            report = Path(temp) / "missing.json"
            with self.assertRaisesRegex(SystemExit, "redaction report not found"):
                PUSH.load_report(report)

    def test_push_report_blocks_nonzero_rejected_count(self):
        with TemporaryDirectory() as temp:
            report = Path(temp) / "report.json"
            report.write_text(
                json.dumps({"rejected": 3, "missing_worker_output": []}),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(SystemExit, "rejected 3"):
                PUSH.load_report(report)

    def test_push_report_requires_rejected_field(self):
        with TemporaryDirectory() as temp:
            report = Path(temp) / "report.json"
            report.write_text(
                json.dumps({"missing_worker_output": []}),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(SystemExit, "rejected must be an integer"):
                PUSH.load_report(report)

    def test_missing_or_forged_identity_fails_before_http(self):
        cases = [
            ("missing", {"item_id": None}),
            ("wrong-document", {"document_id": "traj-2"}),
            ("forged-item", {"item_id": "evt-" + "b" * 64}),
        ]
        for name, updates in cases:
            with self.subTest(name=name), TemporaryDirectory() as temp:
                root = Path(temp)
                redacted, report = write_push_fixture(root, turn_updates=updates)
                argv = [
                    "push_redactions.py", "--redacted", str(redacted),
                    "--report", str(report),
                ]
                with mock.patch.object(PUSH, "post") as post, \
                        mock.patch.object(sys, "argv", argv), \
                        self.assertRaisesRegex(SystemExit, "invalid redaction identity"):
                    PUSH.main()
                post.assert_not_called()

    def test_duplicate_identity_fails_before_http(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            redacted, report = write_push_fixture(root)
            path = redacted / "traj-1.json"
            bundle = json.loads(path.read_text(encoding="utf-8"))
            bundle["turns"].append(dict(bundle["turns"][0]))
            path.write_text(json.dumps(bundle), encoding="utf-8")
            argv = [
                "push_redactions.py", "--redacted", str(redacted),
                "--report", str(report),
            ]
            with mock.patch.object(PUSH, "post") as post, \
                    mock.patch.object(sys, "argv", argv), \
                    self.assertRaisesRegex(SystemExit, "duplicate event_id"):
                PUSH.main()
            post.assert_not_called()

    def test_post_body_forwards_canonical_pair_without_qualification(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            safe_reason = "human context is required to classify this reference"
            redacted, report = write_push_fixture(root, turn_updates={
                "redactions": [{
                    "start": 0,
                    "end": 4,
                    "category": "sensitive",
                    "review_state": "needs_confirmation",
                    "uncertainty_reason": safe_reason,
                }],
            })
            captured = {}

            def fake_post(base_url, path, body):
                captured.update({"base_url": base_url, "path": path, "body": body})
                return {"imported": 1, "status": "complete", "rejected": []}

            argv = [
                "push_redactions.py", "--redacted", str(redacted),
                "--report", str(report), "--base-url", "http://127.0.0.1:3270",
            ]
            with mock.patch.object(PUSH, "post", fake_post), \
                    mock.patch.object(sys, "argv", argv), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(PUSH.main(), 0)

        self.assertEqual(captured["path"], "/api/redactions")
        self.assertEqual(captured["body"]["redactions"], [{
            "itemId": EVENT_ID,
            "documentId": "traj-1",
            "startOffset": 0,
            "endOffset": 4,
            "category": "sensitive",
            "confidence": None,
            "reason": None,
            "reviewState": "needs_confirmation",
            "uncertaintyReason": safe_reason,
            "createdBy": "llm",
        }])
        self.assertNotIn("traj-1:", captured["body"]["redactions"][0]["itemId"])

    def test_invalid_review_contract_fails_before_any_http_push(self):
        invalid_spans = [
            {
                "start": 0,
                "end": 4,
                "category": "sensitive",
                "review_state": "deterministic",
            },
            {
                "start": 5,
                "end": 9,
                "category": "sensitive",
                "review_state": "needs_confirmation",
            },
        ]
        with TemporaryDirectory() as temp:
            root = Path(temp)
            redacted, report = write_push_fixture(
                root, turn_updates={"redactions": invalid_spans}
            )
            argv = [
                "push_redactions.py", "--redacted", str(redacted),
                "--report", str(report),
            ]
            with mock.patch.object(PUSH, "post") as post, \
                    mock.patch.object(sys, "argv", argv), \
                    self.assertRaisesRegex(SystemExit, "uncertainty_reason"):
                PUSH.main()
            post.assert_not_called()

    def test_push_response_must_report_exact_complete_success(self):
        cases = [
            ("malformed", [], "response must be an object"),
            (
                "incomplete",
                {"imported": 1, "status": "incomplete", "rejected": []},
                "status is not complete",
            ),
            (
                "partial",
                {"imported": 0, "status": "complete", "rejected": []},
                "imported count does not match",
            ),
            (
                "rejected",
                {"imported": 1, "status": "complete", "rejected": [{"reason": "invalid"}]},
                "contains rejected spans",
            ),
        ]
        for name, response, error in cases:
            with self.subTest(name=name), TemporaryDirectory() as temp:
                root = Path(temp)
                redacted, report = write_push_fixture(root)
                argv = [
                    "push_redactions.py", "--redacted", str(redacted),
                    "--report", str(report),
                ]
                with mock.patch.object(PUSH, "post", return_value=response), \
                        mock.patch.object(sys, "argv", argv), \
                        self.assertRaisesRegex(SystemExit, error):
                    PUSH.main()


if __name__ == "__main__":
    unittest.main()
