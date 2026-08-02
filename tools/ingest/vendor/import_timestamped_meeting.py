#!/usr/bin/env python3
"""Convert timestamped Speaker A/B transcripts into Oxygen raw meeting Markdown."""

from __future__ import annotations

import argparse
import re
from pathlib import Path


TURN_RE = re.compile(r"^(\d{1,2}:\d{2})(?:Speaker\s+([A-Z]))(.*)$")


def convert(source: Path, output: Path, recorded_at: str, meeting_id: str, title: str) -> int:
    turns: list[tuple[str, str, str]] = []
    for line_number, raw in enumerate(source.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line:
            continue
        match = TURN_RE.match(line)
        if not match:
            raise ValueError(f"line {line_number} is not a timestamped speaker turn")
        timestamp, speaker, text = match.groups()
        turns.append((timestamp, speaker, text.strip()))
    if not turns:
        raise ValueError("transcript has no turns")

    speaker_numbers = {speaker: index for index, speaker in enumerate(sorted({turn[1] for turn in turns}))}
    body = [
        f"# Raw Transcript — {recorded_at[:10]} {title}",
        "",
        f"> Meeting ID: {meeting_id}",
        f"> Recorded at: {recorded_at}",
        "> Internal, unredacted source; publication approval required.",
        "",
        "---",
        "",
    ]
    for timestamp, speaker, text in turns:
        body.extend((f"说话人{speaker_numbers[speaker]}:", f"[{timestamp}] {text}"))
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(body) + "\n", encoding="utf-8")
    return len(turns)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--recorded-at", required=True)
    parser.add_argument("--meeting-id", required=True)
    parser.add_argument("--title", required=True)
    args = parser.parse_args()
    count = convert(args.source, args.output, args.recorded_at, args.meeting_id, args.title)
    print(f"wrote {args.output}: {count} turns")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
