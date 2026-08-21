import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest


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

    def test_push_report_preserves_rejected_count(self):
        with TemporaryDirectory() as temp:
            report = Path(temp) / "report.json"
            report.write_text(
                json.dumps({"rejected": 3, "missing_worker_output": []}),
                encoding="utf-8",
            )
            self.assertEqual(PUSH.load_report(report)["rejected"], 3)


if __name__ == "__main__":
    unittest.main()
