import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest import mock

TEST_ROOT = Path(__file__).resolve().parent
if str(TEST_ROOT) not in sys.path:
    sys.path.insert(0, str(TEST_ROOT))

from source_privacy_fixture import (
    EVENT_ID,
    bundle,
    canonical_bundle_bytes,
    digest_value,
    finalized_fixture,
    write_dialogue,
    write_findings,
)


def load_script(name: str):
    path = Path(__file__).resolve().parents[1] / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"source_privacy_{name}", path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


VERIFY = load_script("verify_coverage")
MERGE = load_script("merge_and_apply")


class SourcePrivacyReceiptTest(unittest.TestCase):
    def _terminal(self, module: str, patch: str, args: list[str]):
        runner = (f"import sys;sys.path.insert(0,{str(TEST_ROOT.parent)!r});"
                  f"import {module} as m;{patch};sys.argv=['{module}.py',"
                  "*sys.argv[1:]];raise SystemExit(m.main())")
        return subprocess.run(
            [sys.executable, "-c", runner, *args], capture_output=True, text=True,
            encoding="utf-8", errors="replace", check=False,
        )

    def _verify(self, dialogue: Path, findings: Path, receipt: Path) -> int:
        argv = [
            "verify_coverage.py", "--dialogue", str(dialogue),
            "--findings", str(findings), "--receipt", str(receipt),
        ]
        with mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return VERIFY.main()

    def test_positive_completed_zero_creates_one_exact_receipt_and_merges(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            dialogue, findings, review, _ = finalized_fixture(root)
            receipt = root / "terminal-receipt.json"

            self.assertEqual(self._verify(dialogue, findings, receipt), 0)
            self.assertEqual(json.loads(receipt.read_text(encoding="utf-8")), review["receipt"])
            self.assertGreater(review["receipt"]["sourceRevision"], 0)
            self.assertEqual(review["receipt"]["redactions"]["count"], 0)

            output = root / "merged"
            argv = [
                "merge_and_apply.py", "--dialogue", str(dialogue),
                "--findings", str(findings), "--out", str(output),
                "--receipt", str(receipt),
            ]
            with mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(MERGE.main(), 0)
            self.assertTrue((output / "redacted" / "traj-1.json").is_file())
            self.assertEqual(
                json.loads((output / "report.json").read_text(encoding="utf-8"))["receiptDigest"],
                review["receipt"]["receiptDigest"],
            )

    def test_receipt_output_io_failure_returns_fixed_terminal_error(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            dialogue, findings, _, _ = finalized_fixture(root)
            prior_receipt = root / "receipt.json"; prior_bytes = prior_receipt.read_bytes()
            target = root / "blocked-receipt.json"
            result = self._terminal(
                "verify_coverage", "m.install_receipt=lambda *_:(_ for _ in ()).throw("
                "OSError('HOSTILE_RECEIPT_IO'))", ["--dialogue", str(dialogue),
                "--findings", str(findings), "--receipt", str(target)],
            )
            self.assertEqual((result.returncode, result.stdout, result.stderr),
                             (1, "", "SOURCE_PRIVACY_REVIEW_INVALID\n"))
            self.assertFalse(target.exists())
            self.assertEqual(prior_receipt.read_bytes(), prior_bytes)

    def test_merge_install_io_failure_cleans_staging_and_is_fixed(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            dialogue, findings, _, _ = finalized_fixture(root)
            receipt = root / "receipt.json"; receipt_bytes = receipt.read_bytes()
            output = root / "merged"
            result = self._terminal(
                "merge_and_apply", "m.rename_noreplace=lambda *_:(_ for _ in ()).throw("
                "OSError('HOSTILE_MERGE_IO'))", ["--dialogue", str(dialogue),
                "--findings", str(findings), "--out", str(output),
                "--receipt", str(receipt)],
            )
            self.assertEqual((result.returncode, result.stdout, result.stderr),
                             (1, "", "SOURCE_PRIVACY_MERGE_OUTPUT_INVALID\n"))
            self.assertFalse(output.exists())
            self.assertEqual(list(root.glob(".merged.*.tmp")), [])
            self.assertEqual(receipt.read_bytes(), receipt_bytes)

    def test_revision_zero_and_wrong_reviewed_sets_create_no_receipt(self):
        cases = ("revision-zero", "missing-item", "foreign-item")
        for case in cases:
            with self.subTest(case=case), TemporaryDirectory() as temp:
                root = Path(temp)
                value = bundle()
                dialogue = write_dialogue(
                    root / "dialogue", [value], source_revision=0 if case == "revision-zero" else 3,
                )
                findings = write_findings(root / "findings", [value])
                worker_path = findings / "traj-1.json"
                worker = json.loads(worker_path.read_text(encoding="utf-8"))
                if case == "missing-item":
                    worker["reviewed_item_ids"] = []
                elif case == "foreign-item":
                    worker["reviewed_item_ids"] = ["evt-" + "b" * 64]
                if case != "revision-zero":
                    worker["reviewed_items_digest"] = digest_value(worker["reviewed_item_ids"])
                    worker_path.write_text(json.dumps(worker), encoding="utf-8")
                receipt = root / "receipt.json"

                self.assertEqual(self._verify(dialogue, findings, receipt), 1)
                self.assertFalse(receipt.exists())

    def test_dialogue_or_receipt_tamper_blocks_merge_before_output(self):
        for case in ("dialogue", "receipt"):
            with self.subTest(case=case), TemporaryDirectory() as temp:
                root = Path(temp)
                dialogue, findings, review, _ = finalized_fixture(root)
                receipt = root / "receipt.json"
                if case == "dialogue":
                    path = dialogue / "traj-1.json"
                    value = json.loads(path.read_text(encoding="utf-8"))
                    value["turns"][0]["text"] = "safe synthetic texu"
                    path.write_bytes(canonical_bundle_bytes(value))
                else:
                    value = review["receipt"]
                    value["redactions"]["digest"] = "0" * 64
                    receipt.write_text(json.dumps(value), encoding="utf-8")
                output = root / "merged"
                argv = [
                    "merge_and_apply.py", "--dialogue", str(dialogue),
                    "--findings", str(findings), "--out", str(output),
                    "--receipt", str(receipt),
                ]
                with mock.patch.object(sys, "argv", argv), \
                        self.assertRaisesRegex(SystemExit, "SOURCE_PRIVACY_MERGE"):
                    MERGE.main()
                self.assertFalse(output.exists())

    def test_item_identity_in_receipt_is_exact(self):
        with TemporaryDirectory() as temp:
            _, _, review, _ = finalized_fixture(Path(temp))
            turn = review["receipt"]["dialogue"]["bundles"][0]["turns"][0]
            self.assertEqual(turn["eventId"], EVENT_ID)
            self.assertEqual(turn["itemId"], EVENT_ID)

    def test_noncanonical_or_hardlinked_receipt_blocks_merge_before_output(self):
        for case in ("noncanonical", "hardlinked"):
            with self.subTest(case=case), TemporaryDirectory() as temp:
                root = Path(temp)
                dialogue, findings, review, _ = finalized_fixture(root)
                receipt = root / "receipt.json"
                if case == "noncanonical":
                    receipt.write_text(
                        json.dumps(review["receipt"], ensure_ascii=False, indent=2),
                        encoding="utf-8",
                    )
                else:
                    try:
                        os.link(receipt, root / "receipt-alias.json")
                    except OSError:
                        self.skipTest("hard-link creation is unavailable")
                output = root / "merged"
                argv = [
                    "merge_and_apply.py", "--dialogue", str(dialogue),
                    "--findings", str(findings), "--out", str(output),
                    "--receipt", str(receipt),
                ]
                with mock.patch.object(sys, "argv", argv), \
                        self.assertRaisesRegex(SystemExit, "SOURCE_PRIVACY_MERGE_INVALID"):
                    MERGE.main()
                self.assertFalse(output.exists())

    def test_merge_late_collision_preserves_owner_and_returns_fixed_error(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            dialogue, findings, _, _ = finalized_fixture(root)
            receipt = root / "receipt.json"
            self.assertEqual(self._verify(dialogue, findings, receipt), 0)
            output = root / "merged"

            def collide(_stage: Path, final: Path) -> None:
                final.mkdir()
                (final / "owner.txt").write_text("owner", encoding="utf-8")
                raise FileExistsError

            argv = [
                "merge_and_apply.py", "--dialogue", str(dialogue),
                "--findings", str(findings), "--out", str(output),
                "--receipt", str(receipt),
            ]
            with mock.patch.object(sys, "argv", argv), \
                    mock.patch.object(MERGE, "rename_noreplace", side_effect=collide), \
                    self.assertRaisesRegex(SystemExit, "^SOURCE_PRIVACY_MERGE_OUTPUT_EXISTS$"):
                MERGE.main()

            self.assertEqual((output / "owner.txt").read_text(encoding="utf-8"), "owner")
            self.assertEqual(list(root.glob(".merged.*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
