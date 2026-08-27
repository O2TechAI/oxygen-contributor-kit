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
    return {"schema": "oxygen.story", "key": key, "phase": {"id": "build", "label": "Build"}, "title": "Title", "overview": "Overview", "people": [], "story": {"blocks": []}, "insights": [{"id": insight, "title": "Lesson", "background": "Background", "quote": {"storyBlockIds": ["block"]}, "directlyAcquiredExperience": "Experience", "principle": "Principle", "evidence": [{"documentId": document, "eventId": event}]}], "evidence": {"primary": {"documentId": document, "eventId": event}, "supporting": []}, "coverage": {"semanticManifest": {"revision": 1, "digest": "a" * 64}, "coverageManifest": {"revision": 1, "digest": "b" * 64}, "representedUnitIds": [], "excludedUnits": []}}


def inputs(root: Path, stories=None):
    stories = stories or [story()]
    candidates = {"schema": "oxygen.story-candidates.v1", "candidates": [{"id": f"candidate-{index}", "documentId": source["evidence"]["primary"]["documentId"], "sequence": index, "timestamp": None, "summary": "oxygen.story:" + json.dumps(source)} for index, source in enumerate(stories)]}
    reviewed = {"schema": "oxygen.reviewed-evidence.v1", "documents": [{"documentId": "trajectory-a", "documentKind": "trajectory", "events": [{"eventId": "event-a"}]}]}
    privacy = {"schema": "oxygen.privacy-summary.v1", "status": "complete", "autoRemoved": {"total": 0, "reversible": True, "categories": []}}
    (root / "story-candidates.json").write_text(json.dumps(candidates), encoding="utf-8")
    (root / "reviewed-evidence.json").write_text(json.dumps(reviewed), encoding="utf-8")
    (root / "privacy-summary.json").write_text(json.dumps(privacy), encoding="utf-8")
    return root / "story-candidates.json", root / "privacy-summary.json"


class PrepareContextTests(unittest.TestCase):
    def test_context_contains_only_final_lessons_and_cited_reviewed_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); candidates, privacy = inputs(root)
            output = PREPARE.prepare(candidates, root, privacy)
        self.assertEqual(set(output), {"schema", "reusableLessons", "insightIdentities", "reviewedEvidence", "autoRemoved"})
        self.assertEqual(output["insightIdentities"], [{"storyKey": "chapter-a", "insightId": "lesson-a"}])
        self.assertEqual(output["reviewedEvidence"], [{"documentId": "trajectory-a", "eventId": "event-a", "documentKind": "trajectory"}])

    def test_rejects_foreign_evidence_duplicate_identity_and_malformed_story(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); candidates, privacy = inputs(root)
            data = json.loads(candidates.read_text()); data["candidates"][0]["summary"] = "oxygen.story:{}"; candidates.write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaises(ValueError): PREPARE.prepare(candidates, root, privacy)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); first = story(); second = story(key="chapter-b", event="foreign", insight="lesson-b"); candidates, privacy = inputs(root, [first, second])
            with self.assertRaisesRegex(ValueError, "foreign"):
                PREPARE.prepare(candidates, root, privacy)

    def test_invalid_input_does_not_replace_existing_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); candidates, privacy = inputs(root); output = root / "preference-context.json"; output.write_bytes(b"preserve-me")
            bad = json.loads(privacy.read_text()); bad["status"] = "running"; privacy.write_text(json.dumps(bad), encoding="utf-8")
            result = subprocess.run([sys.executable, str(SCRIPT), "--story-candidates", str(candidates), "--review-dir", str(root), "--privacy-summary", str(privacy), "--output", str(output)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0); self.assertEqual(output.read_bytes(), b"preserve-me")

    def test_source_has_no_http_sqlite_or_provider_execution(self):
        source = SCRIPT.read_text(encoding="utf-8").lower()
        for forbidden in ("urllib", "requests", "http", "sqlite", "openai", "provider"):
            self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main()
