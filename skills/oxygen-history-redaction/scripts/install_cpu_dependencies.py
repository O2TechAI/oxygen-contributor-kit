#!/usr/bin/env python3
"""Install the skill's local Presidio/spaCy CPU runtime with pip."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import venv
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
REQUIREMENTS = SKILL_DIR / "requirements.txt"
POLICY = SKILL_DIR / "assets" / "default-policy.json"


def venv_python(directory: Path) -> Path:
    relative = Path("Scripts/python.exe") if sys.platform == "win32" else Path("bin/python")
    return directory / relative


def commands(directory: Path) -> list[list[str]]:
    model = json.loads(POLICY.read_text(encoding="utf-8"))["pii"]["model"]
    python = str(venv_python(directory))
    return [
        [python, "-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"],
        [python, "-m", "pip", "install", "-r", str(REQUIREMENTS)],
        [python, "-m", "spacy", "download", model],
        [python, "-m", "spacy", "validate"],
    ]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Create a venv and install the release-redactor CPU dependencies."
    )
    parser.add_argument("--venv", default=".venv", help="private virtualenv path")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print the local pip/spaCy commands without executing them",
    )
    args = parser.parse_args()
    directory = Path(args.venv).resolve()
    planned = commands(directory)
    if args.dry_run:
        print(json.dumps({"venv": str(directory), "commands": planned}, indent=2))
        return 0
    if not venv_python(directory).is_file():
        venv.EnvBuilder(with_pip=True).create(directory)
    for command in planned:
        subprocess.run(command, check=True)
    print(
        json.dumps(
            {
                "status": "ready",
                "venv": str(directory),
                "device": "cpu",
                "docker": False,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
