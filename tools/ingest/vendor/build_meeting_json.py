#!/usr/bin/env python3
"""Merge raw meeting transcripts into one chronological, speaker-free JSON file."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
from pathlib import Path
from typing import Any


DEFAULT_INPUT = Path("meeting notes")
DEFAULT_OUTPUT = Path("data/meetings/meeting-transcripts.json")
HEADER_RE = re.compile(r"^# Raw Transcript\s+[—-]\s+(\d{4}-\d{2}-\d{2})\s*(.*)$")
SPEAKER_RE = re.compile(r"^说话人\d+:\s*$")
SEPARATOR_RE = re.compile(r"^---\s*$")
MEETING_ID_RE = re.compile(r"^>\s*Meeting ID:\s*(meeting-[A-Za-z0-9_-]+)\s*$")
RECORDED_AT_RE = re.compile(r"^>\s*Recorded at:\s*(\S+)\s*$")


def parse_transcript(path: Path, source_root: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    lines = path.read_text(encoding="utf-8").splitlines()
    if not lines:
        raise ValueError(f"empty transcript: {path}")
    header = HEADER_RE.match(lines[0])
    if not header:
        raise ValueError(f"invalid raw transcript heading: {path}")
    date_text, title = header.groups()
    dt.date.fromisoformat(date_text)
    title = title.strip() or path.stem
    meeting_id = f"meeting-{date_text.replace('-', '')}"
    recorded_at: str | None = None
    for metadata_line in lines[1:]:
        if SEPARATOR_RE.match(metadata_line):
            break
        id_match = MEETING_ID_RE.match(metadata_line)
        if id_match:
            meeting_id = id_match.group(1)
        time_match = RECORDED_AT_RE.match(metadata_line)
        if time_match:
            recorded_at = time_match.group(1)
            dt.datetime.fromisoformat(recorded_at.replace("Z", "+00:00"))

    records: list[dict[str, Any]] = []
    in_body = False
    segment = 0
    current_lines: list[str] | None = None
    current_start: int | None = None
    current_end: int | None = None

    def flush() -> None:
        nonlocal current_lines, current_start, current_end
        if current_lines is None:
            return
        text = "\n".join(current_lines).strip()
        if text:
            records.append(
                {
                    "meeting_id": meeting_id,
                    "meeting_date": date_text,
                    "segment": segment,
                    "sequence_in_meeting": len(records) + 1,
                    "text": text,
                    "source": {
                        "file": path.relative_to(source_root).as_posix(),
                        "line_start": current_start,
                        "line_end": current_end,
                    },
                }
            )
        current_lines = None
        current_start = None
        current_end = None

    for line_number, line in enumerate(lines, 1):
        if SEPARATOR_RE.match(line):
            if not in_body:
                in_body = True
                segment = 1
            else:
                flush()
                segment += 1
            continue
        if not in_body:
            continue
        if SPEAKER_RE.match(line):
            flush()
            current_lines = []
            continue
        if current_lines is None:
            # Ignore blank material outside a diarized turn.
            continue
        current_lines.append(line)
        if line.strip():
            current_start = current_start or line_number
            current_end = line_number
    flush()

    source = {
        "meeting_id": meeting_id,
        "date": date_text,
        "title": title,
        "source_file": path.relative_to(source_root).as_posix(),
        "segment_count": segment,
        "record_count": len(records),
    }
    if recorded_at:
        source["recorded_at"] = recorded_at
        for record in records:
            record["meeting_timestamp"] = recorded_at
    return source, records


def build_dataset(input_dir: Path) -> dict[str, Any]:
    source_root = input_dir.parent.resolve()
    paths = sorted(input_dir.resolve().glob("*raw transcript.md"))
    if not paths:
        raise ValueError(f"no raw transcripts found under {input_dir}")

    parsed = [parse_transcript(path, source_root) for path in paths]
    parsed.sort(key=lambda item: (item[0]["date"], item[0]["source_file"]))
    sources: list[dict[str, Any]] = []
    records: list[dict[str, Any]] = []
    for source, meeting_records in parsed:
        sources.append(source)
        records.extend(meeting_records)

    for global_sequence, record in enumerate(records, 1):
        record["record_id"] = f"record-{global_sequence:06d}"
        record["sequence"] = global_sequence

    return {
        "schema_version": "0.1",
        "dataset_id": "oxygen-meeting-transcripts",
        "project_id": "oxygen",
        "contains_unredacted_source_text": True,
        "review_status": "pending",
        "publication_approved": False,
        "ordering": ["meeting_date", "segment", "sequence_in_meeting"],
        "source_count": len(sources),
        "record_count": len(records),
        "sources": sources,
        "records": records,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    dataset = build_dataset(args.input_dir)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(dataset, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.output}: {dataset['source_count']} meetings, {dataset['record_count']} records")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
