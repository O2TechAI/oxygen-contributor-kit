import contextlib
import http.server
import importlib.util
import io
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import threading
import unittest
from unittest import mock

TEST_ROOT = Path(__file__).resolve().parent
if str(TEST_ROOT) not in sys.path:
    sys.path.insert(0, str(TEST_ROOT))

from source_privacy_fixture import (
    EVENT_ID,
    bundle,
    canonical_bundle_bytes,
    finalized_fixture,
    write_dialogue,
    write_redacted_output,
)


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


def write_push_fixture(
    root: Path,
    *,
    turn_updates=None,
    findings=None,
) -> tuple[Path, Path, Path]:
    default_findings = [{
        "event_id": EVENT_ID,
        "start": 0,
        "end": 4,
        "category": "sensitive",
        "confidence": None,
        "reason": None,
        "review_state": "deterministic",
        "uncertainty_reason": None,
    }]
    _, _, review, _ = finalized_fixture(
        root, findings=default_findings if findings is None else findings,
    )
    redacted, report = write_redacted_output(root, review)
    if turn_updates:
        path = redacted / "traj-1.json"
        payload = json.loads(path.read_text(encoding="utf-8"))
        payload["turns"][0].update(turn_updates)
        path.write_bytes(canonical_bundle_bytes(payload))
    return redacted, report, root / "receipt.json"


class ReleaseGateTest(unittest.TestCase):
    def test_valid_loopback_origins_pass_before_private_input(self):
        cases = [
            ("http://127.0.0.1:3210", "http://127.0.0.1:3210"),
            ("http://localhost:3210", "http://localhost:3210"),
        ]
        for supplied, normalized in cases:
            with self.subTest(supplied=supplied), TemporaryDirectory() as temp:
                argv = [
                    "push_redactions.py", "--redacted", str(Path(temp) / "redacted"),
                    "--report", str(Path(temp) / "report.json"),
                    "--receipt", str(Path(temp) / "receipt.json"),
                    "--base-url", supplied,
                ]
                with mock.patch.object(
                        PUSH, "read_receipt", return_value={"receiptDigest": "a" * 64}), \
                        mock.patch.object(PUSH, "load_report", return_value={"rejected": 0}), \
                        mock.patch.object(PUSH, "collect_spans", return_value=[]), \
                        mock.patch.object(PUSH, "post", return_value={
                            "imported": 0, "status": "complete", "rejected": [],
                        }) as post, \
                        mock.patch.object(sys, "argv", argv), \
                        contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(PUSH.main(), 0)
                self.assertEqual(post.call_args.args[0], normalized)

    def test_invalid_origin_families_fail_before_private_input_or_http(self):
        cases = [
            "https://127.0.0.1:3210",
            "http://example.com:3210",
            "http://viewer.local:3210",
            "http://0.0.0.0:3210",
            "http://[::1]:3210",
            "http://127.1:3210",
            "http://user@localhost:3210",
            "http://user:secret@localhost:3210",
            "http://localhost",
            "http://localhost:not-a-port",
            "http://localhost:0",
            "http://localhost:01",
            "http://localhost:65536",
            "http://localhost:3210/",
            "http://localhost:3210/private",
            "http://localhost:3210/;private",
            "http://localhost:3210?",
            "http://localhost:3210?private=1",
            "http://localhost:3210#",
            "http://localhost:3210#private",
            "http://localhost:3210\t",
            "\nhttp://localhost:3210",
            "HTTP://localhost:3210",
            "http://[localhost:3210",
        ]
        with TemporaryDirectory() as temp:
            fixture_path = str(Path(temp) / "private" / "report.json")
            for supplied in cases:
                with self.subTest(supplied=supplied):
                    argv = [
                        "push_redactions.py", "--redacted", str(Path(temp) / "private"),
                        "--report", fixture_path,
                        "--receipt", str(Path(temp) / "private" / "receipt.json"),
                        "--base-url", supplied,
                    ]
                    with mock.patch.object(PUSH, "read_receipt") as read_receipt, \
                            mock.patch.object(PUSH, "load_report") as load_report, \
                            mock.patch.object(PUSH, "collect_spans") as collect_spans, \
                            mock.patch.object(PUSH, "post") as post, \
                            mock.patch.object(PUSH.urllib.request, "Request") as request, \
                            mock.patch.object(PUSH.urllib.request, "build_opener") as opener, \
                            mock.patch.object(sys, "argv", argv), \
                            self.assertRaises(SystemExit) as raised:
                        PUSH.main()
                    self.assertEqual(str(raised.exception), PUSH.INVALID_ORIGIN_ERROR)
                    self.assertNotIn(supplied, str(raised.exception))
                    self.assertNotIn(fixture_path, str(raised.exception))
                    load_report.assert_not_called()
                    read_receipt.assert_not_called()
                    collect_spans.assert_not_called()
                    post.assert_not_called()
                    request.assert_not_called()
                    opener.assert_not_called()

    def test_direct_post_rejects_external_origin_before_request_construction(self):
        supplied = "http://example.com:3210"
        sentinel = "SYNTHETIC_PRIVATE_MARKER"
        with mock.patch.object(PUSH.urllib.request, "Request") as request, \
                mock.patch.object(PUSH.urllib.request, "build_opener") as opener, \
                self.assertRaises(SystemExit) as raised:
            PUSH.post(supplied, {"marker": sentinel})
        self.assertEqual(str(raised.exception), PUSH.INVALID_ORIGIN_ERROR)
        self.assertNotIn(supplied, str(raised.exception))
        self.assertNotIn(sentinel, str(raised.exception))
        request.assert_not_called()
        opener.assert_not_called()

    def test_post_disables_environment_proxies(self):
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = b"{}"
        opener = mock.Mock()
        opener.open.return_value = response
        with mock.patch.object(
            PUSH.urllib.request,
            "getproxies",
            return_value={"http": "http://proxy.example:8080"},
        ) as getproxies, mock.patch.object(
            PUSH.urllib.request, "build_opener", return_value=opener,
        ) as build_opener:
            self.assertEqual(
                PUSH.post("http://127.0.0.1:3210", {"marker": "private"}),
                {},
            )

        getproxies.assert_not_called()
        handlers = build_opener.call_args.args
        self.assertIsInstance(handlers[0], PUSH.urllib.request.ProxyHandler)
        self.assertEqual(handlers[0].proxies, {})
        self.assertIsInstance(handlers[1], PUSH._RejectRedirects)

    def test_caller_controlled_route_is_not_part_of_post_contract(self):
        sentinel = "SYNTHETIC_ROUTE_MARKER"
        with mock.patch.object(PUSH.urllib.request, "Request") as request, \
                mock.patch.object(PUSH.urllib.request, "build_opener") as opener, \
                self.assertRaises(TypeError):
            PUSH.post(
                "http://127.0.0.1:3210",
                "@example.com:80/api/redactions",
                {"marker": sentinel},
            )
        request.assert_not_called()
        opener.assert_not_called()

    def test_redirect_statuses_stop_without_follow_up_contact(self):
        sentinel = "SYNTHETIC_REDIRECT_MARKER"
        for status in (301, 302, 303, 307, 308):
            with self.subTest(status=status):
                class RedirectHandler(http.server.BaseHTTPRequestHandler):
                    requests = []

                    def do_POST(self):
                        length = int(self.headers.get("content-length", "0"))
                        body = self.rfile.read(length)
                        self.__class__.requests.append((self.command, self.path, body))
                        self.send_response(status)
                        self.send_header(
                            "Location",
                            f"http://127.0.0.1:{self.server.server_port}/redirect-target",
                        )
                        self.end_headers()

                    def do_GET(self):
                        self.__class__.requests.append((self.command, self.path, b""))
                        self.send_response(204)
                        self.end_headers()

                    def log_message(self, format, *args):
                        pass

                server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), RedirectHandler)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    with self.assertRaises(SystemExit) as raised:
                        PUSH.post(
                            f"http://127.0.0.1:{server.server_port}",
                            {"marker": sentinel},
                        )
                finally:
                    server.shutdown()
                    server.server_close()
                    thread.join(timeout=5)

                self.assertEqual(str(raised.exception), PUSH.REDIRECT_ERROR)
                self.assertEqual(
                    [(method, path) for method, path, _ in RedirectHandler.requests],
                    [("POST", "/api/redactions")],
                )

    def test_missing_worker_file_fails_coverage(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            dialogue = root / "dialogue"
            findings = root / "findings"
            findings.mkdir()
            write_dialogue(dialogue, [bundle()])
            receipt = root / "receipt.json"
            argv = sys.argv
            try:
                sys.argv = [
                    "verify_coverage.py", "--dialogue", str(dialogue),
                    "--findings", str(findings),
                    "--receipt", str(receipt),
                ]
                with contextlib.redirect_stdout(io.StringIO()) as output:
                    result = VERIFY.main()
            finally:
                sys.argv = argv
            self.assertEqual(result, 1)
            self.assertIn("SOURCE_PRIVACY_REVIEW_INVALID", output.getvalue())
            self.assertFalse(receipt.exists())

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
                redacted, report, receipt = write_push_fixture(root, turn_updates=updates)
                argv = [
                    "push_redactions.py", "--redacted", str(redacted),
                    "--report", str(report),
                    "--receipt", str(receipt),
                ]
                with mock.patch.object(PUSH, "post") as post, \
                        mock.patch.object(sys, "argv", argv), \
                        self.assertRaisesRegex(SystemExit, "SOURCE_PRIVACY_PUSH_INPUT_INVALID"):
                    PUSH.main()
                post.assert_not_called()

    def test_duplicate_identity_fails_before_http(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            redacted, report, receipt = write_push_fixture(root)
            path = redacted / "traj-1.json"
            bundle = json.loads(path.read_text(encoding="utf-8"))
            bundle["turns"].append(dict(bundle["turns"][0]))
            path.write_text(json.dumps(bundle), encoding="utf-8")
            argv = [
                "push_redactions.py", "--redacted", str(redacted),
                "--report", str(report),
                "--receipt", str(receipt),
            ]
            with mock.patch.object(PUSH, "post") as post, \
                    mock.patch.object(sys, "argv", argv), \
                    self.assertRaisesRegex(SystemExit, "SOURCE_PRIVACY_PUSH_INPUT_INVALID"):
                PUSH.main()
            post.assert_not_called()

    def test_post_body_forwards_canonical_pair_without_qualification(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            safe_reason = "human context is required to classify this reference"
            redacted, report, receipt = write_push_fixture(root, findings=[{
                    "event_id": EVENT_ID,
                    "start": 0,
                    "end": 4,
                    "category": "sensitive",
                    "confidence": None,
                    "reason": None,
                    "review_state": "needs_confirmation",
                    "uncertainty_reason": safe_reason,
                }])
            captured = {}

            def fake_post(base_url, body):
                captured.update({"base_url": base_url, "body": body})
                return {"imported": 1, "status": "complete", "rejected": []}

            argv = [
                "push_redactions.py", "--redacted", str(redacted),
                "--report", str(report), "--base-url", "http://127.0.0.1:3270",
                "--receipt", str(receipt),
            ]
            with mock.patch.object(PUSH, "post", fake_post), \
                    mock.patch.object(sys, "argv", argv), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(PUSH.main(), 0)

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
        self.assertIn("receipt", captured["body"])

    def test_positive_completed_zero_pushes_the_unchanged_receipt(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            redacted, report, receipt = write_push_fixture(root, findings=[])
            captured = {}

            def fake_post(base_url, body):
                captured.update(body)
                return {"imported": 0, "status": "complete", "rejected": []}

            argv = [
                "push_redactions.py", "--redacted", str(redacted),
                "--report", str(report), "--receipt", str(receipt),
            ]
            with mock.patch.object(PUSH, "post", fake_post), \
                    mock.patch.object(sys, "argv", argv), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(PUSH.main(), 0)

            self.assertEqual(captured["redactions"], [])
            self.assertEqual(captured["receipt"]["sourceRevision"], 3)
            self.assertEqual(captured["receipt"]["redactions"]["count"], 0)

    def test_tampered_redacted_bundle_fails_before_http(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            redacted, report, receipt = write_push_fixture(root)
            path = redacted / "traj-1.json"
            payload = json.loads(path.read_text(encoding="utf-8"))
            payload["turns"][0]["redacted_text"] += "x"
            path.write_bytes(canonical_bundle_bytes(payload))
            argv = [
                "push_redactions.py", "--redacted", str(redacted),
                "--report", str(report), "--receipt", str(receipt),
            ]
            with mock.patch.object(PUSH, "post") as post, \
                    mock.patch.object(sys, "argv", argv), \
                    self.assertRaisesRegex(SystemExit, "SOURCE_PRIVACY_PUSH_INPUT_INVALID"):
                PUSH.main()
            post.assert_not_called()

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
            redacted, report, receipt = write_push_fixture(
                root, turn_updates={"redactions": invalid_spans}
            )
            argv = [
                "push_redactions.py", "--redacted", str(redacted),
                "--report", str(report),
                "--receipt", str(receipt),
            ]
            with mock.patch.object(PUSH, "post") as post, \
                    mock.patch.object(sys, "argv", argv), \
                    self.assertRaisesRegex(SystemExit, "SOURCE_PRIVACY_PUSH_INPUT_INVALID"):
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
                redacted, report, receipt = write_push_fixture(root)
                argv = [
                    "push_redactions.py", "--redacted", str(redacted),
                    "--report", str(report),
                    "--receipt", str(receipt),
                ]
                with mock.patch.object(PUSH, "post", return_value=response), \
                        mock.patch.object(sys, "argv", argv), \
                        self.assertRaisesRegex(SystemExit, error):
                    PUSH.main()


if __name__ == "__main__":
    unittest.main()
