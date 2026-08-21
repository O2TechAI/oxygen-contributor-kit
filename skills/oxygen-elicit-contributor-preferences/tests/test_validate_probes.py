import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).parents[1] / "scripts" / "validate_probes.py"
SPEC = importlib.util.spec_from_file_location("validate_probes", SCRIPT)
VALIDATOR = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(VALIDATOR)


def valid_document() -> dict:
    return {
        "schema_version": "1",
        "auto_removed": {
            "total": 1,
            "reversible": False,
            "categories": [{"kind": "private-personal", "count": 1}],
        },
        "bulk_decisions": [],
        "probes": [],
        "set_aside": 0,
    }


class AutoRemovedValidationTests(unittest.TestCase):
    def write_run(self, document: dict) -> tempfile.TemporaryDirectory:
        temporary = tempfile.TemporaryDirectory()
        Path(temporary.name, "preference-probes.json").write_text(
            json.dumps(document), encoding="utf-8"
        )
        return temporary

    def test_valid_aggregate_passes(self):
        with self.write_run(valid_document()) as run:
            self.assertEqual(VALIDATOR.validate(Path(run)), [])

    def test_cli_rejects_extra_top_level_field_without_echoing_value(self):
        document = valid_document()
        document["auto_removed"]["removed_text"] = "AUTO-REMOVED-PRIVATE-SENTINEL-8472"
        with self.write_run(document) as run:
            result = subprocess.run(
                [sys.executable, str(SCRIPT), run], capture_output=True, text=True, check=False
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unknown fields", result.stderr)
        self.assertNotIn("AUTO-REMOVED-PRIVATE-SENTINEL-8472", result.stdout + result.stderr)

    def test_rejects_extra_category_field(self):
        document = valid_document()
        document["auto_removed"]["categories"][0]["sample"] = (
            "AUTO-REMOVED-PRIVATE-SENTINEL-8472"
        )
        with self.write_run(document) as run:
            errors = VALIDATOR.validate(Path(run))
        self.assertTrue(any("categories[0] has unknown fields" in error for error in errors))
        self.assertFalse(any("AUTO-REMOVED-PRIVATE-SENTINEL-8472" in error for error in errors))

    def test_rejects_malformed_types_and_negative_counts(self):
        cases = {
            "negative total": {"total": -1},
            "string total": {"total": "1"},
            "wrong reversible": {"reversible": "false"},
            "non-array categories": {"categories": {}},
            "negative count": {"categories": [{"kind": "private-personal", "count": -1}]},
            "non-integer count": {"categories": [{"kind": "private-personal", "count": 1.5}]},
        }
        for label, changes in cases.items():
            with self.subTest(label=label):
                document = valid_document()
                document["auto_removed"].update(changes)
                with self.write_run(document) as run:
                    self.assertTrue(VALIDATOR.validate(Path(run)))

    def test_rejects_duplicate_and_non_contract_categories(self):
        document = valid_document()
        document["auto_removed"] = {
            "total": 2,
            "reversible": True,
            "categories": [
                {"kind": "private-personal", "count": 1},
                {"kind": "private-personal", "count": 1},
            ],
        }
        with self.write_run(document) as run:
            duplicate_errors = VALIDATOR.validate(Path(run))
        self.assertTrue(any("duplicates" in error for error in duplicate_errors))

        document["auto_removed"]["categories"][1]["kind"] = "private free-form label"
        with self.write_run(document) as run:
            kind_errors = VALIDATOR.validate(Path(run))
        self.assertTrue(any("allowed aggregate category" in error for error in kind_errors))


if __name__ == "__main__":
    unittest.main()
