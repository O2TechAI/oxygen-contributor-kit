import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).parents[1]
SCRIPT = ROOT / "scripts" / "prepare_preference_context.py"
REPOSITORY_ROOT = ROOT.parents[1]
MERGE_SCRIPT = REPOSITORY_ROOT / "tools" / "llm_redact" / "merge_and_apply.py"
VERIFY_SCRIPT = REPOSITORY_ROOT / "tools" / "llm_redact" / "verify_coverage.py"
LLM_REDACT_ROOT = REPOSITORY_ROOT / "tools" / "llm_redact"
if str(LLM_REDACT_ROOT) not in sys.path:
    sys.path.insert(0, str(LLM_REDACT_ROOT))
from source_privacy_receipt import canonical_bundle_bytes, dialogue_authority, digest_value
SPEC = importlib.util.spec_from_file_location("prepare_preference_context", SCRIPT)
PREPARE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(PREPARE)


def story(key="chapter-a", event="event-a", document="trajectory-a", insight="lesson-a"):
    evidence = {"documentId": document, "eventId": event}
    return {
        "schema": "oxygen.story", "key": key,
        "phase": {"id": "build", "label": "Build"}, "title": "Title", "overview": "Overview",
        "people": [], "story": {"blocks": [{
            "id": "block", "text": "A safe reviewed contribution established the boundary.",
            "evidence": [evidence],
        }]},
        "insights": [{
            "id": insight, "title": "Lesson", "background": "Background",
            "anchorStoryBlockId": "block",
            "quote": {"text": "safe synthetic reviewed text", "evidence": evidence},
            "directlyAcquiredExperience": "Experience", "principle": "Principle",
            "evidence": [],
        }],
        "evidence": {
            "primary": evidence, "supporting": [],
        },
        "coverage": {
            "semanticManifest": {"revision": 1, "digest": "a" * 64},
            "coverageManifest": {"revision": 1, "digest": "b" * 64},
            "representedUnitIds": [], "excludedUnits": [],
        },
    }


def inputs(root: Path, stories=None, spans=None):
    stories = stories or [story()]
    spans = spans or []
    candidates = [
        {"id": f"candidate-{index}", "summary": "oxygen.story:" + json.dumps(source)}
        for index, source in enumerate(stories)
    ]
    redacted = root / "redacted"
    redacted.mkdir()
    text = "safe synthetic reviewed text"
    redacted_text = PREPARE.apply_spans(text, spans)
    bundle = {
        "trajectory": "trajectory-a", "document_kind": "trajectory",
        "turns": [{
            "event_id": "event-a", "document_id": "trajectory-a", "item_id": "event-a",
            "sequence": 1, "role": "user", "timestamp": None, "text": text,
            "redactions": spans, "redacted_text": redacted_text,
        }],
        "chars": len(text),
    }
    (redacted / "trajectory-a.json").write_text(json.dumps(bundle), encoding="utf-8")
    categories = {}
    for span in spans:
        categories[span["category"]] = categories.get(span["category"], 0) + 1
    report = {
        "categories": categories, "total_applied": len(spans), "rejected": 0,
        "rejects": [], "missing_worker_output": [],
        "per_trajectory": [{"trajectory": "trajectory-a", "turns": 1, "applied": len(spans)}],
        "receiptDigest": "c" * 64,
    }
    report_path = root / "report.json"
    report_path.write_text(json.dumps(report), encoding="utf-8")
    candidates_path = root / "story-candidates.json"
    candidates_path.write_text(json.dumps(candidates), encoding="utf-8")
    return candidates_path, redacted, report_path


class PrepareContextTests(unittest.TestCase):
    def test_context_contains_only_final_lessons_and_cited_reviewed_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidates, redacted, report = inputs(root)
            output = PREPARE.prepare(candidates, redacted, report)
        self.assertEqual(output["schema"], "oxygen.preference-context")
        self.assertEqual(
            set(output),
            {"schema", "reusableLessons", "insightIdentities", "reviewedEvidence", "autoRemoved"},
        )
        self.assertEqual(
            output["insightIdentities"],
            [{"storyKey": "chapter-a", "insightId": "lesson-a"}],
        )
        self.assertEqual(output["reviewedEvidence"], [{
            "documentId": "trajectory-a", "eventId": "event-a", "documentKind": "trajectory",
        }])

    def test_plain_array_is_the_only_story_candidate_shape(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidates, redacted, report = inputs(root)
            wrapped = {"schema": "invalid-wrapper", "candidates": json.loads(candidates.read_text())}
            candidates.write_text(json.dumps(wrapped), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "story-candidates"):
                PREPARE.prepare(candidates, redacted, report)

    def test_reordered_candidates_emit_byte_identical_utf8_ordered_context(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidates, redacted, report = inputs(root, [
                story(key="chapter-emoji", insight="lesson-emoji"),
                story(key="chapter-private-use", insight="lesson-private-use"),
            ])
            rows = json.loads(candidates.read_text(encoding="utf-8"))
            rows[0]["id"] = "\U0001f600"
            rows[1]["id"] = "\ue000"
            candidates.write_text(json.dumps(rows), encoding="utf-8")
            first_path = root / "first-context.json"
            first_run = subprocess.run([
                sys.executable, str(SCRIPT), "--story-candidates", str(candidates),
                "--redacted", str(redacted), "--privacy-report", str(report),
                "--output", str(first_path),
            ], check=True, capture_output=True, text=True)
            candidates.write_text(json.dumps(list(reversed(rows))), encoding="utf-8")
            second_path = root / "second-context.json"
            second_run = subprocess.run([
                sys.executable, str(SCRIPT), "--story-candidates", str(candidates),
                "--redacted", str(redacted), "--privacy-report", str(report),
                "--output", str(second_path),
            ], check=True, capture_output=True, text=True)
            first = json.loads(first_path.read_text(encoding="utf-8"))
            first_bytes = first_path.read_bytes()
            second_bytes = second_path.read_bytes()

        self.assertEqual(first_bytes, second_bytes)
        self.assertEqual(first_run.stdout, second_run.stdout)
        self.assertEqual(
            [lesson["storyKey"] for lesson in first["reusableLessons"]],
            ["chapter-private-use", "chapter-emoji"],
        )

    def test_rejects_internal_controls_and_oversized_privacy_integers(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidates, redacted, report = inputs(root)
            rows = json.loads(candidates.read_text(encoding="utf-8"))
            rows[0]["id"] = "candidate\tid"
            candidates.write_text(json.dumps(rows), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "story candidate"):
                PREPARE.prepare(candidates, redacted, report)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidates, redacted, report = inputs(root)
            rows = json.loads(candidates.read_text(encoding="utf-8"))
            source = json.loads(rows[0]["summary"].removeprefix("oxygen.story:"))
            source["insights"][0]["principle"] = "unsafe\u0000text"
            rows[0]["summary"] = "oxygen.story:" + json.dumps(source)
            candidates.write_text(json.dumps(rows), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Insight"):
                PREPARE.prepare(candidates, redacted, report)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidates, redacted, report = inputs(root)
            privacy = json.loads(report.read_text(encoding="utf-8"))
            privacy["total_applied"] = PREPARE.MAX_SAFE_INTEGER + 1
            report.write_text(json.dumps(privacy), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Privacy report"):
                PREPARE.prepare(candidates, redacted, report)

    def test_rejects_foreign_evidence_duplicate_identity_and_malformed_story(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidates, redacted, report = inputs(root)
            data = json.loads(candidates.read_text())
            data[0]["summary"] = "oxygen.story:{}"
            candidates.write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaises(ValueError):
                PREPARE.prepare(candidates, redacted, report)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidates, redacted, report = inputs(root, [
                story(), story(key="chapter-b", event="foreign", insight="lesson-b"),
            ])
            with self.assertRaisesRegex(ValueError, "foreign"):
                PREPARE.prepare(candidates, redacted, report)

    def test_completed_privacy_report_binds_exact_redacted_bundles(self):
        span = {
            "start": 0, "end": 4, "category": "credential", "confidence": 0.9,
            "reason": "synthetic", "review_state": "deterministic", "uncertainty_reason": None,
        }
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidates, redacted, report = inputs(root, spans=[span])
            output = PREPARE.prepare(candidates, redacted, report)
            self.assertEqual(output["autoRemoved"], {
                "total": 1, "reversible": True,
                "categories": [{"kind": "credential", "count": 1}],
            })
            stale = json.loads(report.read_text())
            stale["total_applied"] = 2
            report.write_text(json.dumps(stale), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "inconsistent"):
                PREPARE.prepare(candidates, redacted, report)

    def test_privacy_categories_are_exactly_the_upstream_allowlist(self):
        self.assertEqual(PREPARE.AUTO_REMOVED_KINDS, frozenset({
            "credential", "private-personal", "sensitive", "internal-metric",
            "internal-timeline", "mosaic-reidentification",
        }))
        for category in ("user_path", "third_party_contact"):
            with self.subTest(category=category), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                span = {
                    "start": 0, "end": 4, "category": category, "confidence": 0.9,
                    "reason": "synthetic", "review_state": "deterministic",
                    "uncertainty_reason": None,
                }
                candidates, redacted, report = inputs(root, spans=[span])
                with self.assertRaisesRegex(ValueError, "categories are malformed"):
                    PREPARE.prepare(candidates, redacted, report)

    def test_rejects_noncanonical_spans_and_redacted_text(self):
        spans = [
            {
                "start": 0, "end": 4, "category": "credential", "confidence": 0.9,
                "reason": "synthetic", "review_state": "deterministic",
                "uncertainty_reason": None,
            },
            {
                "start": 10, "end": 18, "category": "sensitive", "confidence": 0.8,
                "reason": "synthetic", "review_state": "needs_confirmation",
                "uncertainty_reason": "synthetic uncertainty",
            },
        ]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidates, redacted, report = inputs(root, spans=spans)
            bundle_path = redacted / "trajectory-a.json"
            bundle = json.loads(bundle_path.read_text())
            bundle["turns"][0]["redactions"].reverse()
            bundle_path.write_text(json.dumps(bundle), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "spans are not canonical"):
                PREPARE.prepare(candidates, redacted, report)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidates, redacted, report = inputs(root, spans=spans)
            bundle_path = redacted / "trajectory-a.json"
            bundle = json.loads(bundle_path.read_text())
            bundle["turns"][0]["redactions"][1]["start"] = 3
            bundle_path.write_text(json.dumps(bundle), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "spans are not canonical"):
                PREPARE.prepare(candidates, redacted, report)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidates, redacted, report = inputs(root, spans=spans)
            bundle_path = redacted / "trajectory-a.json"
            bundle = json.loads(bundle_path.read_text())
            bundle["turns"][0]["redacted_text"] += "tampered"
            bundle_path.write_text(json.dumps(bundle), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "text is not canonical"):
                PREPARE.prepare(candidates, redacted, report)

    def test_real_merge_and_apply_output_is_accepted(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dialogue = root / "dialogue"
            findings = root / "findings"
            merged = root / "merged"
            dialogue.mkdir()
            findings.mkdir()
            text = "token safe reviewed text"
            bundle = {
                "trajectory": "trajectory-a", "document_kind": "trajectory",
                "turns": [{
                    "event_id": "event-a", "document_id": "trajectory-a",
                    "item_id": "event-a", "sequence": 1,
                    "role": "user", "timestamp": None,
                    "text": text,
                }],
                "chars": len(text),
            }
            bundle_bytes = canonical_bundle_bytes(bundle)
            (dialogue / "trajectory-a.json").write_bytes(bundle_bytes)
            dialogue_receipt = dialogue_authority([(bundle, bundle_bytes)])
            source_authority = {
                "workflowRunId": "synthetic-run",
                "sourceRevision": 1,
                "finalizedCorpus": {
                    "revision": 1, "digest": "a" * 64,
                    "documentCount": 1, "itemCount": 1,
                },
                "sourceDigest": "b" * 64,
            }
            (dialogue / "index.json").write_bytes(canonical_bundle_bytes({
                **source_authority, "dialogue": dialogue_receipt,
            }))
            finding = {
                "trajectory": "trajectory-a",
                "input_digest": dialogue_receipt["bundles"][0]["inputDigest"],
                "reviewed_item_ids": ["event-a"],
                "reviewed_items_digest": digest_value(["event-a"]),
                "findings": [{
                    "event_id": "event-a", "start": 0, "end": 5,
                    "category": "credential", "confidence": "high",
                    "reason": "synthetic", "review_state": "deterministic",
                    "uncertainty_reason": None,
                }],
                "reviewed_turns": 1,
            }
            (findings / "trajectory-a.json").write_text(json.dumps(finding), encoding="utf-8")
            receipt = root / "source-privacy-receipt.json"
            subprocess.run([
                sys.executable, str(VERIFY_SCRIPT), "--dialogue", str(dialogue),
                "--findings", str(findings), "--receipt", str(receipt),
            ], check=True, capture_output=True, text=True)
            subprocess.run([
                sys.executable, str(MERGE_SCRIPT), "--dialogue", str(dialogue),
                "--findings", str(findings), "--out", str(merged),
                "--receipt", str(receipt),
            ], check=True, capture_output=True, text=True)
            candidates_path = root / "story-candidates.json"
            candidates_path.write_text(json.dumps([{
                "id": "candidate-a", "summary": "oxygen.story:" + json.dumps(story()),
            }]), encoding="utf-8")
            output = PREPARE.prepare(candidates_path, merged / "redacted", merged / "report.json")
            reviewed = json.loads((merged / "redacted" / "trajectory-a.json").read_text())

        self.assertEqual(
            reviewed["turns"][0]["redacted_text"],
            '<redacted category="credential"/> safe reviewed text',
        )
        self.assertEqual(output["autoRemoved"], {
            "total": 1, "reversible": True,
            "categories": [{"kind": "credential", "count": 1}],
        })

    def test_meeting_evidence_uses_the_imported_qualified_item_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidates, redacted, report = inputs(root, [
                story(document="meeting-a", event="meeting-a:event-a"),
            ])
            source = redacted / "trajectory-a.json"
            bundle = json.loads(source.read_text())
            bundle["trajectory"] = "meeting-a"
            bundle["document_kind"] = "meeting"
            bundle["turns"][0]["document_id"] = "meeting-a"
            bundle["turns"][0]["item_id"] = "meeting-a:event-a"
            bundle["turns"][0]["event_id"] = "meeting-a:event-a"
            source.unlink()
            (redacted / "meeting-a.json").write_text(json.dumps(bundle), encoding="utf-8")
            privacy = json.loads(report.read_text())
            privacy["per_trajectory"][0]["trajectory"] = "meeting-a"
            report.write_text(json.dumps(privacy), encoding="utf-8")
            output = PREPARE.prepare(candidates, redacted, report)
        self.assertEqual(output["reviewedEvidence"], [{
            "documentId": "meeting-a", "eventId": "meeting-a:event-a",
            "documentKind": "meeting",
        }])

    def test_invalid_input_does_not_replace_existing_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidates, redacted, report = inputs(root)
            output = root / "preference-context.json"
            output.write_bytes(b"preserve-me")
            bad = json.loads(report.read_text())
            bad["rejected"] = 1
            bad["rejects"] = [{"reason": "synthetic rejection"}]
            report.write_text(json.dumps(bad), encoding="utf-8")
            result = subprocess.run([
                sys.executable, str(SCRIPT), "--story-candidates", str(candidates),
                "--redacted", str(redacted), "--privacy-report", str(report),
                "--output", str(output),
            ], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(output.read_bytes(), b"preserve-me")

    def test_source_has_no_network_sqlite_or_model_execution(self):
        source = SCRIPT.read_text(encoding="utf-8").lower()
        for forbidden in ("urllib", "requests", "http", "sqlite", "openai", "provider"):
            self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main()
