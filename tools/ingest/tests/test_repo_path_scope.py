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
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class RepoPathScopeTest(unittest.TestCase):
    def setUp(self):
        self.repo = "/mnt/d/Coding Projects/O2-Intern/oxygen-contributor-kit"

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

    def test_windows_forward_slashes_and_spaces_are_normalized(self):
        self.assertTrue(
            MODULE.is_inside(
                "d:/Coding Projects/O2-Intern/oxygen-contributor-kit/./viewer",
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

    def test_explicit_posix_absolute_paths_keep_exact_child_scope(self):
        repo = "/home/synthetic user/oxygen-contributor-kit"
        self.assertTrue(MODULE.is_inside(repo, repo))
        self.assertTrue(MODULE.is_inside(f"{repo}/viewer", repo))
        self.assertFalse(MODULE.is_inside("/home/synthetic user", repo))
        self.assertFalse(MODULE.is_inside("/home/synthetic user/other-kit", repo))

    def test_ambiguous_and_relative_paths_fail_closed(self):
        for value in (
            "",
            ".",
            "viewer",
            "..",
            "~",
            "~/repo",
            r"~\repo",
            r"\repo",
            "D:repo",
            "C:viewer",
        ):
            with self.subTest(value=value):
                self.assertFalse(MODULE.is_inside(value, self.repo))


if __name__ == "__main__":
    unittest.main()
