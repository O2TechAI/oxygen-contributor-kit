import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest import mock

TEST_ROOT = Path(__file__).resolve().parent
if str(TEST_ROOT) not in sys.path:
    sys.path.insert(0, str(TEST_ROOT))

from source_privacy_fixture import finalized_fixture


MODULE_PATH = Path(__file__).resolve().parents[1] / "merge_and_apply.py"
SPEC = importlib.util.spec_from_file_location("merge_and_apply_review_state", MODULE_PATH)
MERGE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MERGE)

EVENT_ID = "evt-" + "a" * 64
TEXT = "alpha beta"


def finding(**updates):
    value = {
        "event_id": EVENT_ID,
        "start": 0,
        "end": 5,
        "category": "sensitive",
        "confidence": "medium",
        "reason": "contains private implementation context",
        "review_state": "deterministic",
    }
    value.update(updates)
    return value


def validate_one(value):
    rejects = []
    accepted = MERGE.validate(
        [value],
        {EVENT_ID: {"event_id": EVENT_ID, "text": TEXT}},
        "traj-1",
        rejects,
    )
    return accepted, rejects


class ReviewStateContractTest(unittest.TestCase):
    def test_deterministic_is_accepted(self):
        accepted, rejects = validate_one(finding())
        self.assertEqual(rejects, [])
        self.assertEqual(accepted[EVENT_ID][0]["review_state"], "deterministic")
        self.assertIsNone(accepted[EVENT_ID][0]["uncertainty_reason"])

    def test_needs_confirmation_with_safe_reason_is_accepted(self):
        safe_reason = "context is insufficient to determine whether the reference is public"
        accepted, rejects = validate_one(finding(
            review_state="needs_confirmation",
            uncertainty_reason=safe_reason,
        ))
        self.assertEqual(rejects, [])
        self.assertEqual(accepted[EVENT_ID][0]["review_state"], "needs_confirmation")
        self.assertEqual(accepted[EVENT_ID][0]["uncertainty_reason"], safe_reason)

    def test_invalid_review_contracts_are_rejected(self):
        missing = finding()
        del missing["review_state"]
        cases = [
            ("missing", missing, "shape is invalid"),
            ("unknown", finding(review_state="pending"), "missing or invalid"),
            (
                "pending-without-reason",
                finding(review_state="needs_confirmation"),
                "requires a nonempty uncertainty_reason",
            ),
            (
                "deterministic-with-reason",
                finding(uncertainty_reason="human input is needed"),
                "requires uncertainty_reason to be omitted or null",
            ),
        ]
        for name, value, error in cases:
            with self.subTest(name=name):
                accepted, rejects = validate_one(value)
                self.assertEqual(accepted, {})
                self.assertEqual(len(rejects), 1)
                self.assertIn(error, rejects[0]["reason"])

    def test_confidence_does_not_select_or_change_review_state(self):
        for confidence in ("high", "medium", "low"):
            with self.subTest(confidence=confidence):
                accepted, rejects = validate_one(finding(
                    confidence=confidence,
                    review_state="needs_confirmation",
                    uncertainty_reason="human context is required to classify this reference",
                ))
                self.assertEqual(rejects, [])
                span = accepted[EVENT_ID][0]
                self.assertEqual(span["review_state"], "needs_confirmation")
                self.assertEqual(span["confidence"], confidence)

    def test_exact_fields_survive_merge_output(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            output = root / "output"
            safe_reason = "human context is required to classify this reference"
            dialogue, findings_dir, _, _ = finalized_fixture(
                root,
                findings=[finding(
                    review_state="needs_confirmation",
                    uncertainty_reason=safe_reason,
                )],
            )
            argv = [
                "merge_and_apply.py", "--dialogue", str(dialogue),
                "--findings", str(findings_dir), "--out", str(output),
                "--receipt", str(root / "receipt.json"),
            ]
            with mock.patch.object(sys, "argv", argv), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(MERGE.main(), 0)

            bundle = json.loads(
                (output / "redacted" / "traj-1.json").read_text(encoding="utf-8")
            )
            span = bundle["turns"][0]["redactions"][0]
            self.assertEqual(span["review_state"], "needs_confirmation")
            self.assertEqual(span["uncertainty_reason"], safe_reason)


if __name__ == "__main__":
    unittest.main()
