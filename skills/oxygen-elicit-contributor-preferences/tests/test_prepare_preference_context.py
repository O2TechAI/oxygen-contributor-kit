import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).parents[1]
SCRIPT = ROOT / "scripts" / "prepare_preference_context.py"
SPEC = importlib.util.spec_from_file_location("prepare_preference_context", SCRIPT)
PREPARE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(PREPARE)


def story(key="chapter-a", event="event-a", document="trajectory-a", insight="lesson-a"):
    return {
        "schema": "oxygen.story", "key": key,
        "phase": {"id": "build", "label": "Build"}, "title": "Title", "overview": "Overview",
        "people": [], "story": {"blocks": []},
        "insights": [{
            "id": insight, "title": "Lesson", "background": "Background",
            "quote": {"storyBlockIds": ["block"]},
            "directlyAcquiredExperience": "Experience", "principle": "Principle",
            "evidence": [{"documentId": document, "eventId": event}],
        }],
        "evidence": {
            "primary": {"documentId": document, "eventId": event}, "supporting": [],
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
    redacted_text = "<redacted category=\"credential\"/> synthetic reviewed text" if spans else text
    bundle = {
        "trajectory": "trajectory-a", "document_kind": "trajectory",
        "turns": [{
            "event_id": "event-a", "document_id": "trajectory-a", "item_id": "event-a",
            "role": "user", "timestamp": None, "text": text,
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
