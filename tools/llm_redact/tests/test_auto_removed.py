import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).parents[1] / "push_probes.py"
SPEC = importlib.util.spec_from_file_location("push_probes_auto_removed", SCRIPT)
PUSH_PROBES = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(PUSH_PROBES)


def valid_auto_removed() -> dict:
    return {
        "total": 2,
        "reversible": False,
        "categories": [
            {"kind": "private-personal", "count": 1},
            {"kind": "credential", "count": 1},
        ],
    }


class PushAutoRemovedTests(unittest.TestCase):
    def test_canonicalizer_reconstructs_only_contract_fields(self):
        source = valid_auto_removed()
        canonical = PUSH_PROBES.canonical_auto_removed(source)
        self.assertEqual(canonical, source)
        self.assertIsNot(canonical, source)
        self.assertIsNot(canonical["categories"], source["categories"])

    def test_canonicalizer_rejects_unknown_fields(self):
        source = valid_auto_removed()
        source["removed_text"] = "AUTO-REMOVED-PRIVATE-SENTINEL-8472"
        with self.assertRaisesRegex(ValueError, "exactly total"):
            PUSH_PROBES.canonical_auto_removed(source)

    def test_main_posts_exact_canonical_aggregate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dialogue = root / "dialogue"
            probes = root / "probes"
            dialogue.mkdir()
            probes.mkdir()
            (dialogue / "traj-1.json").write_text(json.dumps({
                "trajectory": "traj-1",
                "document_kind": "trajectory",
                "turns": [{"event_id": "evt-1"}],
            }), encoding="utf-8")
            (probes / "traj-1.json").write_text(json.dumps({
                "trajectory": "traj-1",
                "probes": [{
                    "signal": "explicit_rule",
                    "event_ids": ["evt-1"],
                    "recap": "Synthetic recap.",
                    "options": [
                        {"id": "A", "text": "Synthetic choice A"},
                        {"id": "B", "text": "Synthetic choice B"},
                    ],
                }],
            }), encoding="utf-8")
            summary = root / "preference-probes.json"
            summary.write_text(json.dumps({
                "auto_removed": valid_auto_removed(),
                "bulk_decisions": [],
            }), encoding="utf-8")
            captured = {}

            def fake_post(base_url, path, body):
                captured.update({"base_url": base_url, "path": path, "body": body})
                return {"ok": True}

            argv = [
                str(SCRIPT), "--probes", str(probes), "--dialogue", str(dialogue),
                "--summary", str(summary), "--base-url", "http://127.0.0.1:3270",
            ]
            with mock.patch.object(PUSH_PROBES, "post", fake_post), mock.patch.object(sys, "argv", argv):
                self.assertEqual(PUSH_PROBES.main(), 0)

        self.assertEqual(captured["path"], "/api/probes")
        self.assertEqual(captured["body"]["run"]["autoRemoved"], valid_auto_removed())
        self.assertEqual(
            set(captured["body"]["run"]["autoRemoved"]),
            {"total", "reversible", "categories"},
        )


if __name__ == "__main__":
    unittest.main()
