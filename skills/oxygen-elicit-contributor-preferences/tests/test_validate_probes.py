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


def context(count=1):
    lessons = [{
        "storyKey": f"chapter-{index}", "insightId": f"lesson-{index}", "insightAuthorityDigest": "d" * 64,
        "language": "en",
        "title": "Lesson A", "background": "A reviewed background.",
        "directlyAcquiredExperience": "A learned fact.", "principle": "A bounded principle.",
    } for index in range(count)]
    return {
        "schema": "oxygen.preference-context",
        "reusableLessons": lessons,
        "insightScope": sorted([
            {key: item[key] for key in ("storyKey", "insightId", "insightAuthorityDigest")}
            for item in lessons
        ], key=lambda item: (item["storyKey"].encode("utf-8"), item["insightId"].encode("utf-8"))),
        "reviewedEvidence": [{
            "documentId": "trajectory-a", "eventId": "event-a", "documentKind": "trajectory",
            "sequence": 1, "role": "user", "timestamp": None,
            "redactedText": "The reviewed event records a deployment boundary.",
        }],
        "autoRemoved": {"total": 1, "reversible": True, "categories": [{"kind": "credential", "count": 1}]},
    }


def probe(identifier="probe-a", binding_index=0):
    options = [{"id": "one", "text": "Ask before editing deployment files."}, {"id": "two", "text": "Put deployment work on a separate branch."}]
    return {
        "id": identifier, "storyKey": f"chapter-{binding_index}", "insightId": f"lesson-{binding_index}",
        "insightAuthorityDigest": "d" * 64, "documentId": "trajectory-a", "documentKind": "trajectory", "eventIds": ["event-a"],
        "timestamp": None, "signal": "explicit_rule", "score": 80, "turns": 2,
        "recap": "The reviewed event records a deployment boundary.", "question": "What should the agent remember?",
        "options": options, "presentations": {
            "en": {"recap": "The reviewed event records a deployment boundary.",
                   "question": "What should the agent remember?", "options": options},
            "zh": {"recap": "已审阅事件记录了部署边界。", "question": "代理应该记住什么？",
                   "options": [{"id": "one", "text": "修改部署文件前先询问。"},
                               {"id": "two", "text": "把部署工作放在单独分支。"}]},
        },
        "allowOther": True, "allowSkip": True,
    }


def bulk(identifier="bulk-a", evidence=None):
    return {
        "id": identifier, "kind": "privacy", "count": 1,
        "question": "Keep this reviewed group?", "evidenceSample": evidence or [],
        "presentations": {},
    }


def regeneration_context():
    value = context(); value.pop("autoRemoved"); value["schema"] = "oxygen.preference-regeneration-context"
    for lesson in value["reusableLessons"]:
        lesson.pop("language")
    value["reviewedEvidence"] = [{key: item[key] for key in ("documentId", "eventId", "documentKind")} for item in value["reviewedEvidence"]]
    value["binding"] = {"workflowRunId": "run-a", "sourceRevision": 7, "activeStoryDigest": "a" * 64,
                        "serverVersion": 3, "lifecycleDigest": "b" * 64}
    value["targets"] = [{"id": "probe-a", "storyKey": "chapter-0", "insightId": "lesson-0",
                         "previousQuestionDigest": "c" * 64}]
    value["exportDigest"] = VALIDATOR.digest(value)
    return value


class FinalizerTests(unittest.TestCase):
    def test_scope_is_canonical_and_matches_narrative_lessons_by_identity_and_digest(self):
        value = context(3)
        for lesson, story_key, insight_id, digest_value in zip(
                value["reusableLessons"], ["zeta", "故事", "alpha"],
                ["insight-c", "insight-a", "insight-b"], ["c" * 64, "a" * 64, "b" * 64]):
            lesson.update({"storyKey": story_key, "insightId": insight_id,
                           "insightAuthorityDigest": digest_value})
        value["insightScope"] = sorted([
            {key: lesson[key] for key in ("storyKey", "insightId", "insightAuthorityDigest")}
            for lesson in value["reusableLessons"]
        ], key=lambda item: (item["storyKey"].encode("utf-8"), item["insightId"].encode("utf-8")))
        bundle = VALIDATOR.finalize(
            value, {"probes": [], "bulkDecisions": [], "setAside": 0}, "run-a", 7,
        )
        self.assertEqual([row["storyKey"] for row in bundle["insightScope"]], ["alpha", "zeta", "故事"])

        noncanonical = json.loads(json.dumps(value))
        noncanonical["insightScope"].reverse()
        with self.assertRaisesRegex(ValueError, "identities"):
            VALIDATOR.finalize(
                noncanonical, {"probes": [], "bulkDecisions": [], "setAside": 0}, "run-a", 7,
            )

        stale = json.loads(json.dumps(value))
        stale["insightScope"][0]["insightAuthorityDigest"] = "f" * 64
        with self.assertRaisesRegex(ValueError, "identities"):
            VALIDATOR.finalize(stale, {"probes": [], "bulkDecisions": [], "setAside": 0}, "run-a", 7)

    def test_regeneration_is_exact_changed_and_digest_bound(self):
        candidate = probe(); candidate["question"] = "What should the agent remember now?"
        result = VALIDATOR.finalize_regeneration(
            regeneration_context(), {"probes": [candidate], "bulkDecisions": [], "setAside": 0})
        self.assertEqual(result["schema"], "oxygen.preference-regeneration-import")
        self.assertEqual(result["targets"][0]["id"], result["probes"][0]["id"])
        self.assertEqual(result["importDigest"], VALIDATOR.digest({key: result[key] for key in result if key != "importDigest"}))

    def test_regeneration_rejects_tampered_export_and_unchanged_question(self):
        tampered = regeneration_context(); tampered["binding"]["serverVersion"] = 4
        with self.assertRaisesRegex(ValueError, "authority"):
            VALIDATOR.finalize_regeneration(tampered, {"probes": [probe()], "bulkDecisions": [], "setAside": 0})
        unchanged = regeneration_context()
        unchanged["targets"][0]["previousQuestionDigest"] = VALIDATOR.digest(
            {key: probe()[key] for key in ("question", "options", "presentations")})
        unchanged["exportDigest"] = VALIDATOR.digest({key: unchanged[key] for key in unchanged if key != "exportDigest"})
        with self.assertRaisesRegex(ValueError, "unchanged"):
            VALIDATOR.finalize_regeneration(unchanged, {"probes": [probe()], "bulkDecisions": [], "setAside": 0})

    def test_fixed_nonempty_digests_and_exact_bundle_keys(self):
        bundle = VALIDATOR.finalize(context(), {"probes": [probe()], "bulkDecisions": [], "setAside": 0}, "run-a", 7)
        self.assertEqual(set(bundle), {
            "workflowRunId", "sourceRevision", "inputDigest", "outputDigest", "outputCount", "setAside",
            "insightScope", "probes", "bulkDecisions", "autoRemoved"})
        self.assertEqual(bundle["inputDigest"], "ec4ea10cc5c70d2e73373db3e3a7bab2b7fb019083ba12b363e479fcb68788d5")
        self.assertEqual(bundle["outputDigest"], "9087f672d0ab9566aa41652e063a37a2e929efdff74418d78008fdadb088b0f1")

    def test_completed_zero_and_nonzero_set_aside_rejection(self):
        bundle = VALIDATOR.finalize(context(), {"probes": [], "bulkDecisions": [], "setAside": 0}, "run-a", 7)
        self.assertEqual(bundle["outputDigest"], VALIDATOR.EMPTY_DIGEST)
        with self.assertRaisesRegex(ValueError, "completed-zero"):
            VALIDATOR.finalize(context(), {"probes": [], "bulkDecisions": [], "setAside": 1}, "run-a", 7)

    def test_regular_context_requires_exact_enriched_evidence_and_regeneration_stays_identity_only(self):
        for mutation in (lambda row: row.pop("redactedText"), lambda row: row.update({"text": "not allowed"})):
            invalid = context()
            mutation(invalid["reviewedEvidence"][0])
            with self.subTest(invalid=invalid["reviewedEvidence"][0]):
                with self.assertRaisesRegex(ValueError, "reviewed evidence"):
                    VALIDATOR.finalize(invalid, {"probes": [], "bulkDecisions": [], "setAside": 0}, "run-a", 7)
        self.assertEqual(
            VALIDATOR.finalize_regeneration(
                regeneration_context(), {"probes": [probe()], "bulkDecisions": [], "setAside": 0},
            )["probes"][0]["id"],
            "probe-a",
        )

    def test_reordering_is_byte_stable(self):
        first = VALIDATOR.finalize(context(2), {"probes": [probe("probe-z", 1), probe("probe-a", 0)], "bulkDecisions": [], "setAside": 0}, "run-a", 7)
        second = VALIDATOR.finalize(context(2), {"probes": [probe("probe-a", 0), probe("probe-z", 1)], "bulkDecisions": [], "setAside": 0}, "run-a", 7)
        self.assertEqual(VALIDATOR.PREPARE.canonical_json(first), VALIDATOR.PREPARE.canonical_json(second))

    def test_question_and_evidence_bounds_are_exact(self):
        questions = [probe(f"probe-{index:02d}", index) for index in range(20)]
        accepted = VALIDATOR.finalize(
            context(20), {"probes": questions, "bulkDecisions": [], "setAside": 7}, "run-a", 7,
        )
        self.assertEqual(accepted["outputCount"], 20)
        with self.assertRaisesRegex(ValueError, "candidates"):
            VALIDATOR.finalize(
                context(21), {"probes": questions + [probe("probe-20", 20)], "bulkDecisions": [], "setAside": 0},
                "run-a", 7,
            )

        bounded_context = context()
        event_ids = [f"event-{index:03d}" for index in range(501)]
        bounded_context["reviewedEvidence"] = [
            {"documentId": "trajectory-a", "eventId": event_id, "documentKind": "trajectory",
             "sequence": index + 1, "role": "user", "timestamp": None,
             "redactedText": f"Reviewed event {event_id}."}
            for index, event_id in enumerate(event_ids)
        ]
        candidate = probe()
        candidate["eventIds"] = event_ids[:500]
        VALIDATOR.finalize(
            bounded_context, {"probes": [candidate], "bulkDecisions": [bulk(evidence=event_ids[:500])], "setAside": 0},
            "run-a", 7,
        )
        candidate["eventIds"] = event_ids
        with self.assertRaisesRegex(ValueError, "probe evidence"):
            VALIDATOR.finalize(
                bounded_context, {"probes": [candidate], "bulkDecisions": [], "setAside": 0}, "run-a", 7,
            )
        with self.assertRaisesRegex(ValueError, "bulk evidence"):
            VALIDATOR.finalize(
                bounded_context, {"probes": [], "bulkDecisions": [bulk(evidence=event_ids)], "setAside": 0},
                "run-a", 7,
            )

    def test_open_document_kind_remains_bound_to_reviewed_evidence(self):
        lab_context = context()
        lab_context["reviewedEvidence"][0]["documentKind"] = "lab_notebook"
        candidate = probe()
        candidate["documentKind"] = "lab_notebook"
        self.assertEqual(VALIDATOR.finalize(
            lab_context, {"probes": [candidate], "bulkDecisions": [], "setAside": 0}, "run-a", 7,
        )["probes"][0]["documentKind"], "lab_notebook")
        for invalid in ("trajectory", "Lab_notebook", "lab-notebook", "a" * 65):
            with self.subTest(invalid=invalid):
                candidate["documentKind"] = invalid
                with self.assertRaises(ValueError):
                    VALIDATOR.finalize(
                        lab_context, {"probes": [candidate], "bulkDecisions": [], "setAside": 0}, "run-a", 7,
                    )

    def test_option_normalization_is_explicit_and_cross_runtime_stable(self):
        self.assertEqual(VALIDATOR.normalize_option_text("\u00a0CHOICE...\ufeff"), "choice")
        self.assertEqual(VALIDATOR.normalize_option_text("Straße"), "straße")
        self.assertEqual(VALIDATOR.normalize_option_text("STRASSE"), "strasse")
        candidate = probe()
        candidate["options"] = [
            {"id": "one", "text": "Straße"},
            {"id": "two", "text": "STRASSE"},
        ]
        candidate["presentations"] = {"en": {
            "recap": candidate["recap"], "question": candidate["question"],
            "options": [{"id": "one", "text": "German sharp s"},
                        {"id": "two", "text": "ASCII double s"}],
        }}
        VALIDATOR.finalize(
            context(), {"probes": [candidate], "bulkDecisions": [], "setAside": 0}, "run-a", 7,
        )
        candidate["options"] = [
            {"id": "one", "text": "Choice..."},
            {"id": "two", "text": "choice"},
        ]
        with self.assertRaisesRegex(ValueError, "distinct"):
            VALIDATOR.finalize(
                context(), {"probes": [candidate], "bulkDecisions": [], "setAside": 0}, "run-a", 7,
            )
        candidate = probe()
        candidate["options"][0]["id"] = "\U0001f600" * 101
        candidate["presentations"] = {}
        with self.assertRaisesRegex(ValueError, "options"):
            VALIDATOR.finalize(
                context(), {"probes": [candidate], "bulkDecisions": [], "setAside": 0}, "run-a", 7,
            )

    def test_rejects_internal_controls_and_integers_above_js_safe_range(self):
        for field, value in (("id", "probe\tid"), ("question", "unsafe\u000btext")):
            with self.subTest(field=field):
                candidate = probe()
                candidate[field] = value
                with self.assertRaises(ValueError):
                    VALIDATOR.finalize(
                        context(), {"probes": [candidate], "bulkDecisions": [], "setAside": 0},
                        "run-a", 7,
                    )

        candidate = probe()
        candidate["turns"] = VALIDATOR.PREPARE.MAX_SAFE_INTEGER + 1
        with self.assertRaisesRegex(ValueError, "score or turns"):
            VALIDATOR.finalize(
                context(), {"probes": [candidate], "bulkDecisions": [], "setAside": 0}, "run-a", 7,
            )
        with self.assertRaisesRegex(ValueError, "workflow authority"):
            VALIDATOR.finalize(
                context(), {"probes": [], "bulkDecisions": [], "setAside": 0},
                "run-a", VALIDATOR.PREPARE.MAX_SAFE_INTEGER + 1,
            )
        with self.assertRaisesRegex(ValueError, "setAside"):
            VALIDATOR.finalize(
                context(), {
                    "probes": [], "bulkDecisions": [],
                    "setAside": VALIDATOR.PREPARE.MAX_SAFE_INTEGER + 1,
                }, "run-a", 7,
            )
        bulk = {
            "id": "bulk-a", "kind": "privacy",
            "count": VALIDATOR.PREPARE.MAX_SAFE_INTEGER + 1,
            "question": "Keep this reviewed group?", "evidenceSample": ["event-a"],
            "presentations": {},
        }
        with self.assertRaisesRegex(ValueError, "bulk decision"):
            VALIDATOR.finalize(
                context(), {"probes": [], "bulkDecisions": [bulk], "setAside": 0}, "run-a", 7,
            )

        invalid_context = context()
        invalid_context["autoRemoved"] = {
            "total": VALIDATOR.PREPARE.MAX_SAFE_INTEGER + 1,
            "reversible": True,
            "categories": [],
        }
        with self.assertRaisesRegex(ValueError, "Privacy aggregate"):
            VALIDATOR.finalize(
                invalid_context, {"probes": [], "bulkDecisions": [], "setAside": 0}, "run-a", 7,
            )

    def test_rejects_foreign_cross_document_duplicate_and_answer_fields(self):
        cases = []
        foreign = probe(); foreign["eventIds"] = ["missing"]; cases.append(foreign)
        wrong_kind = probe(); wrong_kind["documentKind"] = "meeting"; cases.append(wrong_kind)
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
            candidates_path.write_text(json.dumps({
                "probes": [probe(f"probe-{index:02d}") for index in range(21)],
                "bulkDecisions": [], "setAside": 0,
            }), encoding="utf-8")
            result = subprocess.run([sys.executable, str(SCRIPT), "--context", str(context_path), "--candidates", str(candidates_path), "--workflow-run-id", "run-a", "--source-revision", "7", "--output", str(output)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(output.read_bytes(), b"preserve-me")


if __name__ == "__main__":
    unittest.main()
