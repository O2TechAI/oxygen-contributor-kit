import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).parents[1]
SCRIPT = ROOT / "scripts" / "validate_probes.py"
SPEC = importlib.util.spec_from_file_location("validate_probes", SCRIPT)
VALIDATOR = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(VALIDATOR)


def context():
    return {
        "schema": "oxygen.preference-context",
        "reusableLessons": [{
            "storyKey": "chapter-a", "insightId": "lesson-a", "title": "Lesson A",
            "background": "A reviewed background.", "directlyAcquiredExperience": "A learned fact.",
            "principle": "A bounded principle.",
        }],
        "insightIdentities": [{"storyKey": "chapter-a", "insightId": "lesson-a"}],
        "reviewedEvidence": [{"documentId": "trajectory-a", "eventId": "event-a", "documentKind": "trajectory"}],
        "autoRemoved": {"total": 1, "reversible": True, "categories": [{"kind": "credential", "count": 1}]},
    }


def probe(identifier="probe-a"):
    options = [{"id": "one", "text": "Ask before editing deployment files."}, {"id": "two", "text": "Put deployment work on a separate branch."}]
    return {
        "id": identifier, "documentId": "trajectory-a", "documentKind": "trajectory", "eventIds": ["event-a"],
        "timestamp": None, "signal": "explicit_rule", "score": 80, "turns": 2,
        "recap": "The reviewed event records a deployment boundary.", "question": "What should the agent remember?",
        "options": options, "presentations": {"zh": {"recap": "已审阅事件记录了部署边界。", "question": "代理应该记住什么？", "options": [{"id": "one", "text": "修改部署文件前先询问。"}, {"id": "two", "text": "把部署工作放在单独分支。"}]}},
        "allowOther": True, "allowSkip": True,
    }


class FinalizerTests(unittest.TestCase):
    def test_fixed_nonempty_digests_and_exact_bundle_keys(self):
        bundle = VALIDATOR.finalize(context(), {"probes": [probe()], "bulkDecisions": [], "setAside": 0}, "run-a", 7)
        self.assertEqual(set(bundle), {"workflowRunId", "sourceRevision", "inputDigest", "outputDigest", "outputCount", "setAside", "probes", "bulkDecisions", "autoRemoved"})
        self.assertEqual(bundle["inputDigest"], "0aaccfef36606dee21895ac04c22e1d2be6c395685f0ff43670a44b5dcb9662a")
        self.assertEqual(bundle["outputDigest"], "b4f891752ea9e4763150ac3daf41b0fb12eccf3a98f977b395d52172fe6eb274")

    def test_completed_zero_and_nonzero_set_aside_rejection(self):
        bundle = VALIDATOR.finalize(context(), {"probes": [], "bulkDecisions": [], "setAside": 0}, "run-a", 7)
        self.assertEqual(bundle["outputDigest"], VALIDATOR.EMPTY_DIGEST)
        with self.assertRaisesRegex(ValueError, "completed-zero"):
            VALIDATOR.finalize(context(), {"probes": [], "bulkDecisions": [], "setAside": 1}, "run-a", 7)

    def test_reordering_is_byte_stable(self):
        first = VALIDATOR.finalize(context(), {"probes": [probe("probe-z"), probe("probe-a")], "bulkDecisions": [], "setAside": 0}, "run-a", 7)
        second = VALIDATOR.finalize(context(), {"probes": [probe("probe-a"), probe("probe-z")], "bulkDecisions": [], "setAside": 0}, "run-a", 7)
        self.assertEqual(VALIDATOR.PREPARE.canonical_json(first), VALIDATOR.PREPARE.canonical_json(second))

    def test_rejects_foreign_cross_document_duplicate_and_answer_fields(self):
        cases = []
        foreign = probe(); foreign["eventIds"] = ["missing"]; cases.append(foreign)
        duplicate = probe(); duplicate["eventIds"] = ["event-a", "event-a"]; cases.append(duplicate)
        answered = probe(); answered["answer"] = {"choice": "one"}; cases.append(answered)
        for candidate in cases:
            with self.subTest(candidate=candidate["id"]):
                with self.assertRaises(ValueError):
                    VALIDATOR.finalize(context(), {"probes": [candidate], "bulkDecisions": [], "setAside": 0}, "run-a", 7)

    def test_rejects_foreign_and_duplicate_bulk_evidence(self):
        decision = {"id": "bulk-a", "kind": "privacy", "count": 1, "question": "Keep this reviewed group?", "evidenceSample": ["missing"], "presentations": {}}
        with self.assertRaises(ValueError):
            VALIDATOR.finalize(context(), {"probes": [], "bulkDecisions": [decision], "setAside": 0}, "run-a", 7)
        decision["evidenceSample"] = ["event-a", "event-a"]
        with self.assertRaises(ValueError):
            VALIDATOR.finalize(context(), {"probes": [], "bulkDecisions": [decision], "setAside": 0}, "run-a", 7)

    def test_rejects_score_signal_options_presentations_and_flags(self):
        for field, value in (("score", 101), ("signal", "made_up"), ("allowOther", False), ("presentations", {"fr": {}})):
            with self.subTest(field=field):
                candidate = probe(); candidate[field] = value
                with self.assertRaises(ValueError):
                    VALIDATOR.finalize(context(), {"probes": [candidate], "bulkDecisions": [], "setAside": 0}, "run-a", 7)
        candidate = probe(); candidate["options"] = candidate["options"][:1]
        with self.assertRaises(ValueError):
            VALIDATOR.finalize(context(), {"probes": [candidate], "bulkDecisions": [], "setAside": 0}, "run-a", 7)

    def test_privacy_aggregate_is_context_only_and_invalid_output_is_unchanged(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); output = root / "bundle.json"; output.write_bytes(b"preserve-me")
            context_path, candidates_path = root / "context.json", root / "candidates.json"
            context_path.write_text(json.dumps(context()), encoding="utf-8")
            candidates_path.write_text(json.dumps({"probes": [dict(probe(), autoRemoved={})], "bulkDecisions": [], "setAside": 0}), encoding="utf-8")
            result = subprocess.run([sys.executable, str(SCRIPT), "--context", str(context_path), "--candidates", str(candidates_path), "--workflow-run-id", "run-a", "--source-revision", "7", "--output", str(output)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(output.read_bytes(), b"preserve-me")


if __name__ == "__main__":
    unittest.main()
