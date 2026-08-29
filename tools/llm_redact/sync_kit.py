#!/usr/bin/env python3
"""Copy the kit to a destination, skipping local build and review artefacts.

rsync is not installed on every host, and a plain `cp -a` would replace the
destination's `node_modules` symlinks. This walks the tree, skips the excluded
names, and never
follows or overwrites a symlink at the destination.
"""
import argparse
from contextlib import contextmanager, nullcontext
import ctypes
import hashlib
import os
import pathlib
import shutil
import stat
import sys
import tempfile
import time

TOOLS_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from atomic_rename import rename_noreplace

EXCLUDE_NAMES = {
    "work", ".venv", "node_modules", ".next", "__pycache__",
    "outputs", ".git", ".oxygen-local.json",
}
EXCLUDE_FILES = {"redaction-diff.html"}
LOCAL_STATE_SUFFIXES = (".db", ".sqlite", ".sqlite3", ".log")
SYNC_BUSY = "SYNC_BUSY"


def should_skip(path: pathlib.Path) -> bool:
    if path.name in EXCLUDE_NAMES or path.name in EXCLUDE_FILES:
        return True
    if path.suffix.lower() in LOCAL_STATE_SUFFIXES:
        return True
    return any(part in EXCLUDE_NAMES for part in path.parts)


def _is_link_or_reparse(path: pathlib.Path, metadata: os.stat_result) -> bool:
    if stat.S_ISLNK(metadata.st_mode):
        return True
    attributes = getattr(metadata, "st_file_attributes", None)
    if os.name == "nt" and attributes is None:
        raise ValueError("cannot prove reparse-point safety")
    if attributes is None:
        return False
    return bool(attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))


def _physical_sync_path(
    path: pathlib.Path,
    *,
    allow_missing_tail: bool = False,
) -> pathlib.Path:
    literal = path.expanduser()
    if not literal.is_absolute():
        literal = pathlib.Path.cwd() / literal
    current = pathlib.Path(literal.anchor)
    parts = literal.parts[1:] if literal.anchor else literal.parts
    for index, part in enumerate(parts):
        if part in {"", "."}:
            continue
        current = current.parent if part == ".." else current / part
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            if allow_missing_tail:
                continue
            raise ValueError("sync path is unavailable") from None
        except OSError:
            raise ValueError("sync path cannot be inspected") from None
        if _is_link_or_reparse(current, metadata):
            raise ValueError("sync path contains an alias")
        if index < len(parts) - 1 and not stat.S_ISDIR(metadata.st_mode):
            raise ValueError("sync path component is not a directory")
    return pathlib.Path(os.path.abspath(literal))


def _regular_target_metadata(path: pathlib.Path) -> os.stat_result | None:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return None
    if _is_link_or_reparse(path, metadata):
        raise ValueError("sync target is aliased")
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise ValueError("sync target is not a unique regular file")
    return metadata


def file_fingerprint(path: pathlib.Path) -> tuple[int, int, int, str]:
    """Return rename-stable physical identity plus exact bytes for one sync leaf."""
    metadata = _regular_target_metadata(path)
    if metadata is None:
        raise FileNotFoundError(path)
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    digest = hashlib.sha256()
    descriptor = os.open(path, flags)
    with os.fdopen(descriptor, "rb") as handle:
        before = os.fstat(handle.fileno())
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or (before.st_dev, before.st_ino) != (metadata.st_dev, metadata.st_ino)
        ):
            raise ValueError("sync target changed before inspection")
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
        after = os.fstat(handle.fileno())
    if (
        (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
        != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
    ):
        raise ValueError("sync target changed during inspection")
    return after.st_dev, after.st_ino, after.st_size, digest.hexdigest()


def _source_tree_entries(
    source: pathlib.Path,
) -> list[tuple[pathlib.Path, os.stat_result]]:
    """Enumerate without following an unvalidated directory entry."""
    root_metadata = source.lstat()
    pending = [(source, (root_metadata.st_dev, root_metadata.st_ino))]
    entries: list[tuple[pathlib.Path, os.stat_result]] = []
    while pending:
        directory, expected = pending.pop()
        metadata = directory.lstat()
        if (
            _is_link_or_reparse(directory, metadata)
            or not stat.S_ISDIR(metadata.st_mode)
            or (metadata.st_dev, metadata.st_ino) != expected
        ):
            raise ValueError("sync source directory changed identity")
        try:
            children = sorted(directory.iterdir(), key=lambda path: path.name)
        except OSError:
            raise ValueError("sync source directory cannot be inspected") from None
        for path in children:
            child_metadata = path.lstat()
            if _is_link_or_reparse(path, child_metadata):
                raise ValueError("sync source contains an alias")
            if stat.S_ISDIR(child_metadata.st_mode):
                pending.append(
                    (path, (child_metadata.st_dev, child_metadata.st_ino))
                )
            elif not stat.S_ISREG(child_metadata.st_mode):
                raise ValueError("sync source contains a special entry")
            entries.append((path, child_metadata))
    return sorted(entries, key=lambda entry: entry[0].relative_to(source).as_posix())


@contextmanager
def _sync_lock(destination: pathlib.Path):
    """Serialize repository-owned sync writers without creating a lock artifact."""
    _physical_sync_path(destination)
    metadata = destination.lstat()
    if _is_link_or_reparse(destination, metadata) or not stat.S_ISDIR(metadata.st_mode):
        raise ValueError("sync destination is invalid")
    identity = (metadata.st_dev, metadata.st_ino)
    if os.name == "nt":
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateMutexW.argtypes = (ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p)
        kernel32.CreateMutexW.restype = ctypes.c_void_p
        kernel32.WaitForSingleObject.argtypes = (ctypes.c_void_p, ctypes.c_ulong)
        kernel32.WaitForSingleObject.restype = ctypes.c_ulong
        kernel32.ReleaseMutex.argtypes = (ctypes.c_void_p,)
        kernel32.ReleaseMutex.restype = ctypes.c_bool
        kernel32.CloseHandle.argtypes = (ctypes.c_void_p,)
        kernel32.CloseHandle.restype = ctypes.c_bool
        lock_name = "Local\\OxygenKitSync-" + hashlib.sha256(
            f"{identity[0]}:{identity[1]}".encode("ascii")
        ).hexdigest()
        handle = kernel32.CreateMutexW(None, False, lock_name)
        if not handle:
            raise OSError(ctypes.get_last_error(), "cannot create sync lock")
        acquired = False
        try:
            result = kernel32.WaitForSingleObject(handle, 0)
            if result not in {0x00000000, 0x00000080}:  # acquired or abandoned
                if result == 0x00000102:
                    raise ValueError(SYNC_BUSY)
                raise OSError(ctypes.get_last_error(), "cannot acquire sync lock")
            acquired = True
            current = destination.lstat()
            if (
                _is_link_or_reparse(destination, current)
                or not stat.S_ISDIR(current.st_mode)
                or (current.st_dev, current.st_ino) != identity
            ):
                raise ValueError("sync destination changed before locking")
            yield
        finally:
            if acquired:
                kernel32.ReleaseMutex(handle)
            kernel32.CloseHandle(handle)
        return

    try:
        import fcntl
    except ImportError:
        raise OSError("required sync lock is unavailable") from None
    descriptor = os.open(
        destination,
        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != identity or not stat.S_ISDIR(opened.st_mode):
            raise ValueError("sync destination changed before locking")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError(SYNC_BUSY) from None
        yield
    finally:
        os.close(descriptor)


def _copy_into_open_stage(
    source: pathlib.Path,
    temporary: pathlib.Path,
    stage_handle,
    source_metadata: os.stat_result,
) -> None:
    """Copy through already-open descriptors, never through the staging path."""
    source_flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
    source_flags |= getattr(os, "O_NOFOLLOW", 0)
    source_descriptor = os.open(source, source_flags)
    with os.fdopen(source_descriptor, "rb") as source_handle:
        opened = os.fstat(source_handle.fileno())
        if (
            not stat.S_ISREG(opened.st_mode)
            or (opened.st_dev, opened.st_ino)
            != (source_metadata.st_dev, source_metadata.st_ino)
        ):
            raise ValueError("sync source changed before copy")
        shutil.copyfileobj(source_handle, stage_handle, length=1024 * 1024)
        after = os.fstat(source_handle.fileno())
        if (
            (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
            != (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns)
        ):
            raise ValueError("sync source changed during copy")


def _owned_stage_metadata(
    temporary: pathlib.Path,
    created_identity: tuple[int, int],
) -> os.stat_result | None:
    try:
        metadata = temporary.lstat()
    except FileNotFoundError:
        return None
    attributes = getattr(metadata, "st_file_attributes", None)
    if (
        stat.S_ISLNK(metadata.st_mode)
        or not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or (metadata.st_dev, metadata.st_ino) != created_identity
        or (
            os.name == "nt"
            and (
                attributes is None
                or bool(attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))
            )
        )
    ):
        raise ValueError("sync staging entry changed identity")
    return metadata


def _replace_existing_atomic(
    temporary: pathlib.Path,
    target: pathlib.Path,
    expected: tuple[int, int, int, str],
) -> None:
    """Install one complete sibling while the destination-wide sync lock is held."""
    attempts = 50 if os.name == "nt" else 1
    for attempt in range(attempts):
        current = _regular_target_metadata(target)
        if current is None or file_fingerprint(target) != expected:
            raise ValueError("sync target changed during publication")
        try:
            os.replace(temporary, target)
            return
        except PermissionError:
            if attempt + 1 == attempts:
                raise
            time.sleep(0.01)


def _atomic_copy_entry(source: pathlib.Path, target: pathlib.Path) -> None:
    source_metadata = source.lstat()
    if _is_link_or_reparse(source, source_metadata) or not stat.S_ISREG(source_metadata.st_mode):
        raise ValueError("sync source is not a physical regular file")
    parent = _physical_sync_path(target.parent)
    if not parent.is_dir():
        raise ValueError("sync target parent is invalid")
    prior = _regular_target_metadata(target)
    prior_fingerprint = file_fingerprint(target) if prior is not None else None
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{target.name}.", suffix=".sync", dir=parent,
    )
    created_metadata = os.fstat(descriptor)
    created_identity = (created_metadata.st_dev, created_metadata.st_ino)
    temporary = pathlib.Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stage_handle:
            descriptor = -1
            _copy_into_open_stage(source, temporary, stage_handle, source_metadata)
            if hasattr(os, "fchmod"):
                os.fchmod(
                    stage_handle.fileno(),
                    stat.S_IMODE(source_metadata.st_mode) | stat.S_IWUSR,
                )
            stage_handle.flush()
            os.fsync(stage_handle.fileno())
            staged = os.fstat(stage_handle.fileno())
            if (
                not stat.S_ISREG(staged.st_mode)
                or staged.st_nlink != 1
                or (staged.st_dev, staged.st_ino) != created_identity
            ):
                raise ValueError("sync staging entry changed identity")
        _owned_stage_metadata(temporary, created_identity)
        _physical_sync_path(parent)
        if prior is None:
            rename_noreplace(temporary, target)
        else:
            assert prior_fingerprint is not None
            _replace_existing_atomic(temporary, target, prior_fingerprint)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        metadata = _owned_stage_metadata(temporary, created_identity)
        if metadata is not None:
            temporary.unlink()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--src", type=pathlib.Path, required=True)
    parser.add_argument("--dest", type=pathlib.Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    src = _physical_sync_path(args.src)
    if not src.is_dir():
        raise ValueError("sync source must be a physical directory")
    dest = _physical_sync_path(args.dest, allow_missing_tail=True)
    if dest.exists() and not dest.is_dir():
        raise ValueError("sync destination must be a physical directory")
    if not args.dry_run:
        dest.mkdir(parents=True, exist_ok=True)
        dest = _physical_sync_path(dest)
    copied, skipped, preserved = 0, 0, []

    lock = _sync_lock(dest) if not args.dry_run else nullcontext()
    with lock:
        for path, source_metadata in _source_tree_entries(src):
            relative = path.relative_to(src)
            if should_skip(relative):
                skipped += 1
                continue
            target = dest / relative

            # A symlink already at the destination is environment wiring, not
            # content. Leave it exactly as found.
            try:
                target_metadata = target.lstat()
            except FileNotFoundError:
                target_metadata = None
            if target_metadata is not None and _is_link_or_reparse(target, target_metadata):
                if stat.S_ISDIR(source_metadata.st_mode):
                    raise ValueError("sync target directory is aliased")
                preserved.append(str(relative))
                continue

            if stat.S_ISDIR(source_metadata.st_mode):
                if not args.dry_run:
                    _physical_sync_path(target.parent)
                    target.mkdir(parents=True, exist_ok=True)
                    physical_target = _physical_sync_path(target)
                    if not physical_target.is_dir():
                        raise ValueError("sync target directory is invalid")
                continue
            if not stat.S_ISREG(source_metadata.st_mode):
                raise ValueError("sync source contains a special entry")
            if not args.dry_run:
                _atomic_copy_entry(path, target)
            copied += 1

    print(f"copied {copied} file(s), skipped {skipped} excluded path(s)")
    if preserved:
        print("preserved existing symlinks at destination:")
        for entry in preserved:
            print(f"  {entry}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
