import importlib.util
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "sync_kit.py"
SPEC = importlib.util.spec_from_file_location("sync_kit", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def run_sync(source: Path, destination: Path) -> int:
    with (
        mock.patch.object(sys, "argv", [
            str(MODULE_PATH), "--src", str(source), "--dest", str(destination),
        ]),
        mock.patch("builtins.print"),
    ):
        return MODULE.main()


def directory_link_or_skip(test_case: unittest.TestCase, link: Path, target: Path) -> None:
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


class SyncKitFilesystemTest(unittest.TestCase):
    def test_ordinary_create_and_update_are_atomic_and_complete(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            destination = root / "destination"
            source.mkdir()
            destination.mkdir()
            (source / "new.txt").write_bytes(b"new file bytes")
            (source / "updated.txt").write_bytes(b"new replacement bytes")
            (destination / "updated.txt").write_bytes(b"old replacement bytes")

            self.assertEqual(run_sync(source, destination), 0)

            self.assertEqual((destination / "new.txt").read_bytes(), b"new file bytes")
            self.assertEqual(
                (destination / "updated.txt").read_bytes(), b"new replacement bytes",
            )
            self.assertEqual(list(destination.glob(".*.sync")), [])

    def test_hardlinked_destination_is_rejected_without_changing_either_link(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            destination = root / "destination"
            source.mkdir()
            destination.mkdir()
            (source / "owned.txt").write_bytes(b"new bytes")
            external = root / "external.bin"
            external.write_bytes(b"external original bytes")
            target = destination / "owned.txt"
            try:
                os.link(external, target)
            except OSError as error:
                self.skipTest(f"hard links unavailable: {error}")

            with self.assertRaisesRegex(ValueError, "unique regular file"):
                run_sync(source, destination)

            self.assertEqual(external.read_bytes(), b"external original bytes")
            self.assertEqual(target.read_bytes(), b"external original bytes")
            self.assertEqual(list(destination.glob(".*.sync")), [])

    def test_destination_directory_junction_is_rejected_before_external_write(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            destination = root / "destination"
            external = root / "external"
            (source / "nested").mkdir(parents=True)
            destination.mkdir()
            external.mkdir()
            (source / "nested" / "file.txt").write_bytes(b"new bytes")
            sentinel = external / "sentinel.bin"
            sentinel.write_bytes(b"external sentinel")
            directory_link_or_skip(self, destination / "nested", external)

            with self.assertRaisesRegex(ValueError, "directory is aliased"):
                run_sync(source, destination)

            self.assertEqual(sentinel.read_bytes(), b"external sentinel")
            self.assertFalse((external / "file.txt").exists())

    def test_source_directory_alias_is_rejected_before_any_destination_write(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            destination = root / "destination"
            external = root / "external"
            source.mkdir()
            destination.mkdir()
            external.mkdir()
            (source / "ordinary.txt").write_bytes(b"must not be copied")
            (external / "sentinel.bin").write_bytes(b"external sentinel")
            directory_link_or_skip(self, source / "linked", external)

            with self.assertRaisesRegex(ValueError, "source contains an alias"):
                run_sync(source, destination)

            self.assertEqual(list(destination.iterdir()), [])
            self.assertEqual(
                (external / "sentinel.bin").read_bytes(), b"external sentinel",
            )

    def test_copy_failure_leaves_existing_target_unchanged_and_cleans_stage(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            destination = root / "destination"
            source.mkdir()
            destination.mkdir()
            (source / "owned.txt").write_bytes(b"new bytes")
            target = destination / "owned.txt"
            target.write_bytes(b"old bytes")

            with mock.patch.object(
                MODULE, "_copy_into_open_stage", side_effect=OSError("synthetic copy failure"),
            ):
                with self.assertRaises(OSError):
                    run_sync(source, destination)

            self.assertEqual(target.read_bytes(), b"old bytes")
            self.assertEqual(list(destination.glob(".*.sync")), [])

    def test_read_only_source_copies_without_leaking_temporary_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            destination = root / "destination"
            source.mkdir()
            destination.mkdir()
            readonly = source / "readonly.txt"
            readonly.write_bytes(b"read-only source bytes")
            readonly.chmod(stat.S_IREAD)
            try:
                self.assertEqual(run_sync(source, destination), 0)
                self.assertEqual(
                    (destination / "readonly.txt").read_bytes(),
                    b"read-only source bytes",
                )
                self.assertEqual(list(destination.glob(".*.sync")), [])
            finally:
                readonly.chmod(stat.S_IREAD | stat.S_IWRITE)

    def test_absent_target_race_is_no_clobber_and_cleans_stage(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            destination = root / "destination"
            source.mkdir()
            destination.mkdir()
            (source / "owned.txt").write_bytes(b"new bytes")
            target = destination / "owned.txt"
            real_rename = MODULE.rename_noreplace

            def race(staging: Path, final: Path) -> None:
                final.write_bytes(b"raced owner bytes")
                real_rename(staging, final)

            with mock.patch.object(MODULE, "rename_noreplace", side_effect=race):
                with self.assertRaises(FileExistsError):
                    run_sync(source, destination)

            self.assertEqual(target.read_bytes(), b"raced owner bytes")
            self.assertEqual(list(destination.glob(".*.sync")), [])

    def test_existing_target_change_before_install_preserves_competitor(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            destination = root / "destination"
            source.mkdir()
            destination.mkdir()
            (source / "owned.txt").write_bytes(b"new bytes")
            target = destination / "owned.txt"
            target.write_bytes(b"old bytes")
            real_fingerprint = MODULE.file_fingerprint
            target_fingerprint_calls = 0

            def observe_fingerprint(path: Path):
                nonlocal target_fingerprint_calls
                if path == target:
                    target_fingerprint_calls += 1
                    if target_fingerprint_calls == 2:
                        competitor = target.with_suffix(".competitor")
                        competitor.write_bytes(b"concurrent owner bytes")
                        os.replace(competitor, target)
                return real_fingerprint(path)

            with mock.patch.object(MODULE, "file_fingerprint", side_effect=observe_fingerprint):
                with self.assertRaisesRegex(ValueError, "changed during publication"):
                    run_sync(source, destination)

            self.assertEqual(target.read_bytes(), b"concurrent owner bytes")
            self.assertEqual(list(destination.glob(".*.sync")), [])

    @unittest.skipIf(os.name == "nt", "POSIX no-follow race proof")
    def test_existing_target_symlink_race_never_reads_external_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            destination = root / "destination"
            source.mkdir()
            destination.mkdir()
            (source / "owned.txt").write_bytes(b"new bytes")
            target = destination / "owned.txt"
            target.write_bytes(b"old bytes")
            external = root / "external.bin"
            external.write_bytes(b"external sentinel bytes")
            real_fingerprint = MODULE.file_fingerprint
            rejected_links = []
            target_fingerprint_calls = 0

            def observe_fingerprint(path: Path):
                nonlocal target_fingerprint_calls
                if path == target:
                    target_fingerprint_calls += 1
                    if target_fingerprint_calls == 2:
                        target.unlink()
                        target.symlink_to(external)
                if path.is_symlink():
                    rejected_links.append(path)
                return real_fingerprint(path)

            with mock.patch.object(MODULE, "file_fingerprint", side_effect=observe_fingerprint):
                with self.assertRaises(OSError):
                    run_sync(source, destination)

            self.assertTrue(target.is_symlink())
            self.assertEqual(external.read_bytes(), b"external sentinel bytes")
            self.assertTrue(rejected_links)

    @unittest.skipIf(os.name == "nt", "Windows denies replacement of the open staging file")
    def test_staging_hardlink_substitution_cannot_receive_copied_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            destination = root / "destination"
            source.mkdir()
            destination.mkdir()
            (source / "owned.txt").write_bytes(b"new bytes")
            external = root / "external.bin"
            external.write_bytes(b"external read-only bytes")
            external.chmod(stat.S_IREAD)
            before_mode = external.stat().st_mode

            real_copy = MODULE._copy_into_open_stage

            def substitute(copy_source, staging, stage_handle, source_metadata):
                staging_path = Path(staging)
                staging_path.unlink()
                os.link(external, staging_path)
                real_copy(copy_source, staging_path, stage_handle, source_metadata)

            try:
                with mock.patch.object(MODULE, "_copy_into_open_stage", side_effect=substitute):
                    with self.assertRaisesRegex(ValueError, "staging entry changed identity"):
                        run_sync(source, destination)

                self.assertEqual(external.read_bytes(), b"external read-only bytes")
                self.assertEqual(external.stat().st_mode, before_mode)
                staged_links = list(destination.glob(".*.sync"))
                self.assertEqual(len(staged_links), 1)
                self.assertEqual(staged_links[0].read_bytes(), b"external read-only bytes")
            finally:
                external.chmod(stat.S_IREAD | stat.S_IWRITE)

    def test_existing_target_update_is_never_missing_or_partial(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            destination = root / "destination"
            source.mkdir()
            destination.mkdir()
            old = b"old:" + (b"a" * (2 * 1024 * 1024))
            new = b"new:" + (b"b" * (2 * 1024 * 1024))
            (source / "owned.txt").write_bytes(new)
            target = destination / "owned.txt"
            target.write_bytes(old)
            stop = threading.Event()
            started = threading.Event()
            observed: list[bytes | None] = []
            read_errors: list[OSError] = []

            def read_repeatedly() -> None:
                while not stop.is_set():
                    try:
                        observed.append(target.read_bytes())
                    except FileNotFoundError:
                        observed.append(None)
                    except PermissionError:
                        # Windows can briefly deny a new open while its atomic
                        # rename is in progress; no partial bytes are exposed.
                        pass
                    except OSError as error:
                        read_errors.append(error)
                    started.set()

            reader = threading.Thread(target=read_repeatedly)
            reader.start()
            self.assertTrue(started.wait(timeout=5))
            writer_error: PermissionError | None = None
            try:
                try:
                    self.assertEqual(run_sync(source, destination), 0)
                except PermissionError as error:
                    # An ordinary Windows reader denies delete sharing. The
                    # atomic writer must fail with the old file intact; it can
                    # succeed once that external reader closes.
                    writer_error = error
            finally:
                stop.set()
                reader.join(timeout=5)

            self.assertFalse(reader.is_alive())
            self.assertEqual(read_errors, [])
            if writer_error is not None:
                self.assertEqual(target.read_bytes(), old)
                self.assertEqual(run_sync(source, destination), 0)
            observed.append(target.read_bytes())
            self.assertIn(old, observed)
            self.assertIn(new, observed)
            self.assertTrue(all(value in {old, new} for value in observed))

    def test_destination_lock_rejects_second_sync_writer(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            destination = root / "destination"
            source.mkdir()
            destination.mkdir()
            (source / "owned.txt").write_bytes(b"new bytes")
            script = "\n".join((
                "import importlib.util, pathlib, sys",
                "spec = importlib.util.spec_from_file_location('sync_lock_child', sys.argv[1])",
                "module = importlib.util.module_from_spec(spec)",
                "spec.loader.exec_module(module)",
                "with module._sync_lock(pathlib.Path(sys.argv[2])):",
                "    print('ready', flush=True)",
                "    sys.stdin.readline()",
            ))
            child = subprocess.Popen(
                [sys.executable, "-c", script, str(MODULE_PATH), str(destination)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
            )
            try:
                assert child.stdout is not None
                ready = child.stdout.readline().strip()
                if ready != "ready":
                    assert child.stderr is not None
                    self.fail(f"lock child failed: {ready} {child.stderr.read()}")
                with self.assertRaisesRegex(ValueError, MODULE.SYNC_BUSY):
                    run_sync(source, destination)
                self.assertFalse((destination / "owned.txt").exists())
                child.kill()
                child.wait(timeout=10)
                self.assertEqual(run_sync(source, destination), 0)
                self.assertEqual((destination / "owned.txt").read_bytes(), b"new bytes")
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=10)
                if child.stdin is not None:
                    child.stdin.close()
                if child.stdout is not None:
                    child.stdout.close()
                if child.stderr is not None:
                    child.stderr.close()

    def test_existing_leaf_symlink_is_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            destination = root / "destination"
            source.mkdir()
            destination.mkdir()
            (source / "wired.txt").write_bytes(b"new bytes")
            external = root / "external.txt"
            external.write_bytes(b"wired bytes")
            link = destination / "wired.txt"
            try:
                link.symlink_to(external)
            except OSError as error:
                self.skipTest(f"file symlink unavailable: {error}")

            self.assertEqual(run_sync(source, destination), 0)
            self.assertTrue(link.is_symlink())
            self.assertEqual(external.read_bytes(), b"wired bytes")


if __name__ == "__main__":
    unittest.main()
