import importlib.util
from pathlib import Path
import sys
import unittest


MODULE_PATH = Path(__file__).resolve().parents[1] / "vendor" / "extract_codex_trajectory.py"
SPEC = importlib.util.spec_from_file_location("extract_codex_trajectory", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class PlatformFilterTest(unittest.TestCase):
    def test_platform_wrappers_are_filtered(self):
        for value in (
            "<recommended_plugins>\n...",
            "  <environment_context>\n...",
            "# AGENTS.md instructions\n...",
        ):
            self.assertTrue(MODULE.is_platform_injected_user_text(value))

    def test_actual_user_text_is_retained(self):
        self.assertFalse(
            MODULE.is_platform_injected_user_text(
                "Can full-context baselines outperform a learned skill?"
            )
        )


if __name__ == "__main__":
    unittest.main()
