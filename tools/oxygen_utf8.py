"""Process-local UTF-8 policy shared by Oxygen command-line tools."""

from __future__ import annotations

import sys
from typing import TextIO


UTF8 = "utf-8"


def _configure_stream(stream: TextIO | None) -> None:
    reconfigure = getattr(stream, "reconfigure", None)
    if callable(reconfigure):
        reconfigure(encoding=UTF8, errors="strict")


def configure_utf8_stdio() -> None:
    """Use strict UTF-8 for this process without changing machine configuration."""
    _configure_stream(sys.stdin)
    _configure_stream(sys.stdout)
    _configure_stream(sys.stderr)


def text_subprocess_options() -> dict[str, object]:
    """Keyword arguments for strict UTF-8 subprocess text pipes."""
    return {"text": True, "encoding": UTF8, "errors": "strict"}
