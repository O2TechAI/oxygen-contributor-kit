import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


INGEST_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INGEST_DIR))
MODULE_PATH = INGEST_DIR / "collect_repo_trajectories.py"
SPEC = importlib.util.spec_from_file_location("collect_repo_memory_containment", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def symlink_or_skip(test_case: unittest.TestCase, link: Path, target: Path, *, directory=False):
    try:
        link.symlink_to(target, target_is_directory=directory)
    except OSError as error:
        test_case.skipTest(f"symlink creation is unavailable: {error.__class__.__name__}")


def directory_link_or_skip(test_case: unittest.TestCase, link: Path, target: Path):
    try:
        link.symlink_to(target, target_is_directory=True)
        return
    except OSError:
        pass
    if os.name == "nt":
        result = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(link), str(target)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=subprocess.CREATE_NO_WINDOW,
            check=False,
        )
        if result.returncode == 0:
            return
    test_case.skipTest("directory link creation is unavailable")


class MemoryContainmentTest(unittest.TestCase):
    def test_ordinary_contained_file_copies_from_windows_compatible_path(self):
        with tempfile.TemporaryDirectory(prefix="approved memory 测试 ") as temporary:
            approved = Path(temporary, "approved root")
            source = approved / "guidance.md"
            output = Path(temporary, "output")
            source.parent.mkdir()
            source.write_text("synthetic guidance", encoding="utf-8")
            collected = []

            MODULE.copy_memory(source, output, "repo", collected, approved)

            self.assertEqual((output / "repo" / "guidance.md").read_text(encoding="utf-8"), "synthetic guidance")
            self.assertEqual(len(collected), 1)

    def test_contained_file_symlink_may_copy_its_contained_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            approved = Path(temporary, "approved")
            approved.mkdir()
            target = approved / "target.md"
            target.write_text("contained", encoding="utf-8")
            link = approved / "link.md"
            symlink_or_skip(self, link, target)
            output = Path(temporary, "output")

            MODULE.copy_memory(link, output, "repo", [], approved)

            self.assertEqual((output / "repo" / "link.md").read_text(encoding="utf-8"), "contained")

    def test_file_symlink_escape_fails_closed_without_reading_or_copying_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            approved = root / "approved"
            approved.mkdir()
            outside = root / "unrelated.md"
            outside.write_text("must not be read", encoding="utf-8")
            link = approved / "escape.md"
            symlink_or_skip(self, link, outside)

            with (
                mock.patch.object(MODULE.shutil, "copy2") as copied,
                mock.patch.object(MODULE, "sha256_file") as hashed,
                self.assertRaisesRegex(ValueError, f"^{MODULE.MEMORY_SOURCE_OUTSIDE_APPROVED_ROOT}$"),
            ):
                MODULE.copy_memory(link, root / "output", "repo", [], approved)

            copied.assert_not_called()
            hashed.assert_not_called()

    def test_nested_directory_symlink_escape_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            approved = root / "approved"
            source = approved / "memory"
            outside = approved / "sibling-memory"
            source.mkdir(parents=True)
            outside.mkdir()
            (outside / "unrelated.md").write_text("must not be copied", encoding="utf-8")
            directory_link_or_skip(self, source / "nested", outside)

            with self.assertRaisesRegex(
                ValueError, f"^{MODULE.MEMORY_SOURCE_OUTSIDE_APPROVED_ROOT}$"
            ):
                MODULE.copy_memory(source, root / "output", "project", [], approved)
            self.assertFalse((root / "output" / "project" / "nested" / "unrelated.md").exists())

    def test_missing_source_returns_fixed_bounded_code(self):
        with tempfile.TemporaryDirectory() as temporary:
            approved = Path(temporary, "approved")
            approved.mkdir()
            with self.assertRaisesRegex(ValueError, f"^{MODULE.MEMORY_SOURCE_MISSING}$"):
                MODULE.copy_memory(approved / "missing.md", Path(temporary, "out"), "repo", [], approved)

    def test_broken_source_returns_fixed_bounded_code(self):
        with tempfile.TemporaryDirectory() as temporary:
            approved = Path(temporary, "approved")
            approved.mkdir()
            broken = approved / "broken.md"
            symlink_or_skip(self, broken, approved / "missing-target.md")
            with self.assertRaisesRegex(ValueError, f"^{MODULE.MEMORY_SOURCE_INVALID}$"):
                MODULE.copy_memory(broken, Path(temporary, "out"), "repo", [], approved)


if __name__ == "__main__":
    unittest.main()
