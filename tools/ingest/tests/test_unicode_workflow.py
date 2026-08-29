import hashlib
import http.server
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import unittest


KIT_ROOT = Path(__file__).resolve().parents[3]


def run_python(*arguments: object) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, *(str(argument) for argument in arguments)],
        cwd=KIT_ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="strict",
    )


class UnicodeWorkflowTest(unittest.TestCase):
    def test_process_local_stdio_emits_exact_unicode(self):
        expected = "中文路径 😀 exact"
        code = (
            "import sys; "
            f"sys.path.insert(0, {str(KIT_ROOT / 'tools')!r}); "
            "from oxygen_utf8 import configure_utf8_stdio; "
            f"configure_utf8_stdio(); print({expected!r})"
        )
        result = run_python("-c", code)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), expected)

    def test_meeting_and_project_map_round_trip_unicode(self):
        with tempfile.TemporaryDirectory(prefix="oxygen unicode ") as temporary:
            root = Path(temporary, "资料 😀")
            root.mkdir()
            transcript = root / "会议 记录 😀.txt"
            transcript.write_text("用户：你好，Windows 😀\n助手：精确 UTF-8 往返。\n", encoding="utf-8")
            meeting_out = root / "meeting output"
            meeting = run_python(
                "tools/ingest/import_meeting.py",
                transcript,
                "--out",
                meeting_out,
                "--title",
                "会议 标题 😀",
            )
            self.assertEqual(meeting.returncode, 0, meeting.stderr)
            summary = json.loads(meeting.stdout.strip().splitlines()[-1])
            dataset_path = Path(summary["meetings"][0]["output"]) / "meeting.json"
            dataset = json.loads(dataset_path.read_text(encoding="utf-8"))
            self.assertEqual(dataset["title"], "会议 标题 😀")
            self.assertEqual(
                [record["text"] for record in dataset["records"]],
                ["你好，Windows 😀", "精确 UTF-8 往返。"],
            )

            run = root / "run with spaces"
            trajectory = run / "trajectories" / "traj-unicode"
            trajectory.mkdir(parents=True)
            events = [
                {
                    "schema": "oxygen.trajectory-event",
                    "event_id": f"evt-{hashlib.sha256(b'unicode-1').hexdigest()}",
                    "event_type": "message",
                    "actor": {"type": "human"},
                    "payload": {"text": "中文问题 😀"},
                },
                {
                    "schema": "oxygen.trajectory-event",
                    "event_id": f"evt-{hashlib.sha256(b'unicode-2').hexdigest()}",
                    "event_type": "message",
                    "actor": {"type": "assistant"},
                    "payload": {"text": "English answer with 精确语义 🚀"},
                },
            ]
            serialized_events = "".join(
                json.dumps(event, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
                for event in events
            )
            (trajectory / "events.jsonl").write_text(serialized_events, encoding="utf-8")
            projected_digest = hashlib.sha256(serialized_events.encode("utf-8")).hexdigest()
            (trajectory / "manifest.json").write_text(json.dumps({
                "schema": "oxygen.trajectory",
                "trajectory_id": "traj-unicode",
                "event_count": 2,
                "contribution_projection": {
                    "policy_id": "oxygen-human-semantic-source-boundary-2026-08-26",
                    "raw_source_digest": "a" * 64,
                    "projected_universe_digest": projected_digest,
                    "raw_event_count": 3,
                    "normalized_event_count": 3,
                    "kept_event_count": 2,
                    "dropped_event_count": 1,
                    "cross_trajectory_semantic_replay_count": 0,
                },
            }), encoding="utf-8")
            (run / "index.json").write_text(json.dumps({
                "schema": "oxygen.ingest-run",
                "tool": "collect_repo_trajectories",
                "collection_status": "complete",
                "trajectory_count": 1,
                "trajectory_failures": 0,
                "trajectories": [{"trajectory_id": "traj-unicode", "ok": True}],
            }), encoding="utf-8")
            project_map = run_python(
                "skills/oxygen-organize-review-export/scripts/build_project_map.py",
                run,
                "--primary-project",
                "氧气 Windows 🚀",
                "--summary",
                "在原生 Windows 上保留中文与 emoji 😀",
            )
            self.assertEqual(project_map.returncode, 0, project_map.stderr)
            mapped = json.loads((run / "project-map.json").read_text(encoding="utf-8"))
            self.assertEqual(mapped["primary_project"], "氧气 Windows 🚀")
            self.assertEqual(mapped["summary"], "在原生 Windows 上保留中文与 emoji 😀")
            self.assertIsNone(mapped["semantic_manifest"])
            mapped["semantic_units"] = [{
                "id": "语义单元-😀",
                "kind": "discussion",
                "members": [
                    f"evt-{hashlib.sha256(b'unicode-1').hexdigest()}",
                    f"evt-{hashlib.sha256(b'unicode-2').hexdigest()}",
                ],
                "storyProjection": {
                    "label": "中文讨论 😀",
                    "summary": "保留精确 UTF-8 语义。",
                },
            }]
            (run / "project-map.json").write_text(
                json.dumps(mapped, ensure_ascii=False), encoding="utf-8"
            )
            finalized = run_python(
                "skills/oxygen-organize-review-export/scripts/build_project_map.py",
                run,
                "--primary-project",
                "氧气 Windows 🚀",
                "--summary",
                "在原生 Windows 上保留中文与 emoji 😀",
                "--finalize",
            )
            self.assertEqual(finalized.returncode, 0, finalized.stderr)
            mapped = json.loads((run / "project-map.json").read_text(encoding="utf-8"))
            self.assertEqual(mapped["semantic_manifest"]["units"][0]["id"], "语义单元-😀")

    def test_coverage_count_matches_dialogue_for_unicode(self):
        with tempfile.TemporaryDirectory(prefix="oxygen coverage ") as temporary:
            run = Path(temporary, "review 😀")
            trajectory = run / "trajectories" / "traj-unicode"
            trajectory.mkdir(parents=True)
            texts = ["你好 Windows 😀", "Exact emoji 🚀 and 中文"]
            events = [
                {
                    "schema": "oxygen.ai-review-event",
                    "event_id": f"event-{index}",
                    "event_type": "message",
                    "actor": {"type": "human" if index == 1 else "assistant"},
                    "payload": {"text": text},
                }
                for index, text in enumerate(texts, 1)
            ]
            serialized = "".join(
                json.dumps(event, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
                for event in events
            )
            (trajectory / "events.jsonl").write_text(serialized, encoding="utf-8")
            (trajectory / "manifest.json").write_text(json.dumps({
                "schema": "oxygen.ai-review-trajectory",
                "trajectory_id": "traj-unicode",
                "event_count": len(events),
                "contribution_projection": {
                    "policy_id": "oxygen-human-semantic-source-boundary-2026-08-26",
                    "raw_source_digest": "a" * 64,
                    "projected_universe_digest": hashlib.sha256(serialized.encode("utf-8")).hexdigest(),
                    "raw_event_count": len(events),
                    "normalized_event_count": len(events),
                    "kept_event_count": len(events),
                    "dropped_event_count": 0,
                    "cross_trajectory_semantic_replay_count": 0,
                },
            }), encoding="utf-8")
            dialogue = Path(temporary, "dialogue output")
            source_authority = {
                "workflowRunId": "unicode-run",
                "sourceRevision": 1,
                "finalizedCorpus": {
                    "revision": 1, "digest": "a" * 64,
                    "documentCount": 1, "itemCount": len(events),
                },
                "sourceDigest": "b" * 64,
            }

            class Handler(http.server.BaseHTTPRequestHandler):
                def do_GET(self):
                    payload = json.dumps({"sourceAuthority": source_authority}).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)

                def log_message(self, *_args):
                    pass

            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                extract = run_python(
                    "tools/llm_redact/extract_dialogue.py", run, "--out", dialogue,
                    "--base-url", f"http://127.0.0.1:{server.server_address[1]}",
                    "--workflow-run-id", "unicode-run",
                )
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
            self.assertEqual(extract.returncode, 0, extract.stderr)
            coverage = run_python("tools/llm_redact/audit_coverage.py", run)
            self.assertEqual(coverage.returncode, 0, coverage.stderr)
            match = re.search(r"reviewed by the model:\s+(\d+)", coverage.stdout)
            self.assertIsNotNone(match, coverage.stdout)
            expected = sum(len(text) for text in texts)
            index = json.loads((dialogue / "index.json").read_text(encoding="utf-8"))
            reviewed = json.loads((dialogue / "traj-unicode.json").read_text(encoding="utf-8"))
            self.assertEqual(index["dialogue"]["turnCount"], len(texts))
            self.assertEqual(reviewed["chars"], expected)
            self.assertEqual(int(match.group(1)), expected)

    def test_malformed_utf8_transcript_fails_instead_of_mojibake(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary, "invalid.txt")
            source.write_bytes(b"valid\n\xffinvalid\n")
            result = run_python(
                "tools/ingest/import_meeting.py",
                source,
                "--out",
                Path(temporary, "out"),
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("UnicodeDecodeError", result.stderr)


if __name__ == "__main__":
    unittest.main()
