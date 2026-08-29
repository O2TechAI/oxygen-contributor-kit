#!/usr/bin/env python3
"""Copy the kit to a destination, skipping local build and review artefacts.

rsync is not installed on every host, and a plain `cp -a` would replace the
destination's `node_modules` symlinks. This walks the tree, skips the excluded
names, and never
follows or overwrites a symlink at the destination.
"""
import argparse
import pathlib
import shutil

EXCLUDE_NAMES = {
    "work", ".venv", "node_modules", ".next", "__pycache__",
    "outputs", ".git", ".oxygen-local.json",
}
EXCLUDE_FILES = {"redaction-diff.html"}
LOCAL_STATE_SUFFIXES = (".db", ".sqlite", ".sqlite3", ".log")


def should_skip(path: pathlib.Path) -> bool:
    if path.name in EXCLUDE_NAMES or path.name in EXCLUDE_FILES:
        return True
    if path.suffix.lower() in LOCAL_STATE_SUFFIXES:
        return True
    return any(part in EXCLUDE_NAMES for part in path.parts)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--src", type=pathlib.Path, required=True)
    parser.add_argument("--dest", type=pathlib.Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    src = args.src.resolve()
    dest = args.dest.resolve()
    copied, skipped, preserved = 0, 0, []

    for path in sorted(src.rglob("*")):
        relative = path.relative_to(src)
        if should_skip(relative):
            skipped += 1
            continue
        target = dest / relative

        # A symlink already at the destination is environment wiring, not
        # content. Leave it exactly as found.
        if target.is_symlink():
            preserved.append(str(relative))
            continue

        if path.is_dir():
            if not args.dry_run:
                target.mkdir(parents=True, exist_ok=True)
            continue
        if not args.dry_run:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
        copied += 1

    print(f"copied {copied} file(s), skipped {skipped} excluded path(s)")
    if preserved:
        print("preserved existing symlinks at destination:")
        for entry in preserved:
            print(f"  {entry}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
