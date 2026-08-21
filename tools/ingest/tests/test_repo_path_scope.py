import importlib.util
from pathlib import Path
import sys
import unittest


INGEST_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INGEST_DIR))
MODULE_PATH = INGEST_DIR / "collect_repo_trajectories.py"
SPEC = importlib.util.spec_from_file_location("collect_repo_trajectories", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class RepoPathScopeTest(unittest.TestCase):
    def setUp(self):
        self.repo = Path("/mnt/d/Coding Projects/O2-Intern/oxygen-contributor-kit")

    def test_equivalent_windows_and_wsl_paths_match(self):
        self.assertTrue(
            MODULE.is_inside(
                r"D:\Coding Projects\O2-Intern\oxygen-contributor-kit",
                self.repo,
            )
        )

    def test_child_path_matches(self):
        self.assertTrue(
            MODULE.is_inside(
                r"D:\Coding Projects\O2-Intern\oxygen-contributor-kit\viewer",
                self.repo,
            )
        )

    def test_parent_path_does_not_match(self):
        self.assertFalse(MODULE.is_inside(r"D:\Coding Projects\O2-Intern", self.repo))

    def test_sibling_repo_does_not_match(self):
        self.assertFalse(
            MODULE.is_inside(r"D:\Coding Projects\O2-Intern\parts-catalog", self.repo)
        )

    def test_windows_drive_and_path_case_are_normalized(self):
        self.assertTrue(
            MODULE.is_inside(
                r"d:\coding projects\o2-intern\OXYGEN-CONTRIBUTOR-KIT\Viewer",
                self.repo,
            )
        )

    def test_windows_dotdot_cannot_broaden_scope(self):
        self.assertFalse(
            MODULE.is_inside(
                r"D:\Coding Projects\O2-Intern\oxygen-contributor-kit\..\parts-catalog",
                self.repo,
            )
        )


if __name__ == "__main__":
    unittest.main()
