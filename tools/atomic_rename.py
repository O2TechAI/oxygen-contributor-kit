"""One native primitive for atomic, same-parent, no-replace publication."""

from __future__ import annotations

import ctypes
import errno
import os
from pathlib import Path
import sys


_AT_FDCWD = -100
_RENAME_NOREPLACE = 1


def _same_parent(source: Path, destination: Path) -> None:
    source_parent = os.path.normcase(os.path.abspath(source.parent))
    destination_parent = os.path.normcase(os.path.abspath(destination.parent))
    if source_parent != destination_parent:
        raise OSError(errno.EXDEV, "staging entry must share the destination parent")


def _linux_rename(source: Path, destination: Path, flags: int) -> None:
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        renameat2 = libc.renameat2
    except (AttributeError, OSError):
        raise OSError(errno.ENOTSUP, "required atomic rename is unavailable") from None
    renameat2.argtypes = (
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    )
    renameat2.restype = ctypes.c_int
    ctypes.set_errno(0)
    result = renameat2(
        _AT_FDCWD,
        os.fsencode(source),
        _AT_FDCWD,
        os.fsencode(destination),
        flags,
    )
    if result == 0:
        return
    code = ctypes.get_errno()
    if code in {
        errno.ENOSYS,
        errno.EINVAL,
        getattr(errno, "EOPNOTSUPP", errno.ENOTSUP),
    }:
        raise OSError(errno.ENOTSUP, "required atomic rename is unavailable")
    raise OSError(code, os.strerror(code))


def _rename_noreplace(source: Path, destination: Path) -> None:
    if os.name == "nt":
        os.rename(source, destination)
        return
    if sys.platform == "linux":
        _linux_rename(source, destination, _RENAME_NOREPLACE)
        return
    raise OSError(errno.ENOTSUP, "atomic no-replace rename is unavailable")


def rename_noreplace(source: Path, destination: Path) -> None:
    """Atomically rename one sibling entry without replacing the destination."""
    _same_parent(source, destination)
    _rename_noreplace(source, destination)
