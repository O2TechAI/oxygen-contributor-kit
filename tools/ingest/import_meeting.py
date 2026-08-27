#!/usr/bin/env python3
"""Import meeting notes / transcript (txt, md, or m4a/wav/mp3 audio) into Oxygen meeting format.

- Audio input: first runs transcribe_diarize.py locally (CPU ASR + optional
  speaker diarization), then imports the resulting transcript.
- Text input, three accepted shapes (auto-detected):
    1. "M:SSSpeaker A text"      (Oxygen timestamped format)
    2. "Speaker A: text" / "说话人0: text" / "张三: text"
    3. plain lines (no speaker structure)

Every source is stored under the explicitly requested run directory:
    meetings/<meeting-id>/meeting.json     canonical records
    meetings/<meeting-id>/raw.md           internal raw markdown
    meetings/<meeting-id>/timestamped.txt  timestamped records when available

Everything is marked contains_unredacted_source_text=true / publication_approved=false.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from oxygen_common import (configure_utf8_stdio, fail, progress, safe_slug, sha256_file,
                           text_subprocess_options, utc_now, write_json)

AUDIO_SUFFIXES = {".m4a", ".wav", ".mp3", ".flac", ".ogg", ".aac", ".mp4"}
TIMESTAMPED_RE = re.compile(r"^(\d{1,3}:\d{2})Speaker\s+([A-Z])\s*(.*)$")
SPEAKER_RE = re.compile(r"^(?:\[(\d{1,3}:\d{2}(?::\d{2})?)\]\s*)?([^\s:：]{1,24})[:：]\s*(.+)$")
MEETING_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$")
MEETING_ID_DIGEST_LENGTH = 64


def validate_output_tree(out: Path) -> None:
    """Reject any existing entry that can redirect writes outside the run."""
    if not out.exists():
        if out.is_symlink():
            raise fail("output path must not be a symbolic link")
        return
    if out.is_symlink() or not out.is_dir():
        raise fail("output path must be a real directory")
    resolved_out = out.resolve(strict=True)
    pending = [out]
    while pending:
        directory = pending.pop()
        for entry in directory.iterdir():
            if entry.is_symlink():
                raise fail("output directory must not contain symbolic links")
            try:
                resolved_entry = entry.resolve(strict=True)
            except (OSError, RuntimeError) as error:
                raise fail(f"output directory contains an invalid entry: {entry}") from error
            if not resolved_entry.is_relative_to(resolved_out):
                raise fail("output directory contains an entry outside the run")
            if entry.is_dir():
                pending.append(entry)


def run_asr(audio: Path, scratch: Path, model: str, language: str | None,
            hf_token: str | None) -> Path:
    tools_dir = Path(__file__).resolve().parent
    candidates = (
        tools_dir / ".venv-audio" / "Scripts" / "python.exe",
        tools_dir / ".venv-audio" / "bin" / "python",
    )
    venv_python = next((candidate for candidate in candidates if candidate.is_file()), None)
    python = str(venv_python) if venv_python else sys.executable
    cmd = [python, str(tools_dir / "transcribe_diarize.py"), str(audio), "--out", str(scratch / "asr"),
           "--model", model]
    if language:
        cmd += ["--language", language]
    if hf_token:
        cmd += ["--hf-token", hf_token]
    process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        **text_subprocess_options(),
    )
    for line in process.stdout:  # forward ASR progress (rescaled to 0-70%)
        line = line.rstrip()
        if line.startswith("PROGRESS "):
            try:
                record = json.loads(line[len("PROGRESS "):])
                if "pct" in record:
                    record_pct = 70 * record["pct"] / 100
                    progress(record_pct, "asr:" + record.get("stage", ""), record.get("detail", ""))
                    continue
            except json.JSONDecodeError:
                pass
        print(line, flush=True)
    if process.wait() != 0:
        raise fail("transcription failed (see log above)")
    transcript = scratch / "asr" / "timestamped.txt"
    if not transcript.is_file():
        raise fail("transcription produced no timestamped.txt")
    return transcript


def parse_lines(text: str) -> tuple[list[dict], str]:
    """Return (records, detected_format)."""
    records: list[dict] = []
    lines = [(number, line.strip()) for number, line in enumerate(text.splitlines(), 1) if line.strip()]
    if not lines:
        return records, "empty"

    timestamped_hits = sum(1 for _, line in lines if TIMESTAMPED_RE.match(line))
    speaker_hits = sum(1 for _, line in lines if SPEAKER_RE.match(line))

    if timestamped_hits >= max(1, len(lines) // 2):
        detected = "timestamped"
        for number, line in lines:
            match = TIMESTAMPED_RE.match(line)
            if match:
                timestamp, speaker, body = match.groups()
                records.append({"timestamp": timestamp, "speaker": speaker, "text": body.strip(),
                                "source_line": number})
            elif records:
                records[-1]["text"] += " " + line
    elif speaker_hits >= max(2, len(lines) // 2):
        detected = "speaker-labeled"
        for number, line in lines:
            match = SPEAKER_RE.match(line)
            if match:
                timestamp, speaker, body = match.groups()
                records.append({"timestamp": timestamp, "speaker": speaker, "text": body.strip(),
                                "source_line": number})
            elif records:
                records[-1]["text"] += " " + line
            else:
                records.append({"timestamp": None, "speaker": None, "text": line, "source_line": number})
    else:
        detected = "plain"
        for number, line in lines:
            records.append({"timestamp": None, "speaker": None, "text": line, "source_line": number})

    for order, record in enumerate(records, 1):
        record["record_id"] = f"rec-{order:05d}"
        record["order"] = order
    return records, detected


def generated_meeting_id(source: Path) -> str:
    digest = sha256_file(source)
    slug_limit = 255 - len("meeting--") - MEETING_ID_DIGEST_LENGTH
    return f"meeting-{safe_slug(source.stem)[:slug_limit]}-{digest}"


def import_source(source: Path, out: Path, meeting_id: str, title: str, date: str, args) -> dict:
    out.mkdir(parents=True, exist_ok=True)

    if source.suffix.lower() in AUDIO_SUFFIXES:
        progress(2, "asr", f"audio input — running local transcription for {source.name}")
        scratch_root = Path(tempfile.gettempdir()).resolve()
        if scratch_root == out or scratch_root.is_relative_to(out):
            raise fail("operating-system scratch directory must be outside the meeting output")
        with tempfile.TemporaryDirectory(prefix="oxygen-asr-", dir=scratch_root) as temporary:
            text_path = run_asr(
                source, Path(temporary), args.model, args.language, args.hf_token
            )
            transcript = text_path.read_text(encoding="utf-8")
    else:
        transcript = source.read_text(encoding="utf-8")

    progress(75, "parse", f"parsing {source.name}")
    records, detected = parse_lines(transcript)
    if not records:
        raise fail("no content found in transcript")
    speakers = sorted({r["speaker"] for r in records if r["speaker"]})
    progress(85, "write", f"format={detected}, {len(records)} records, {len(speakers)} speakers")

    write_json(out / "meeting.json", {
        "schema_version": "0.2",
        "tool": "import_meeting",
        "meeting_id": meeting_id,
        "date": date,
        "title": title,
        "generated_at": utc_now(),
        "source_file": str(source),
        "detected_format": detected,
        "record_count": len(records),
        "speakers": speakers,
        "contains_unredacted_source_text": True,
        "review_status": "pending",
        "publication_approved": False,
        "records": records,
    })

    body = [f"# Raw Transcript — {date} {title}", "",
            f"> Meeting ID: {meeting_id}", f"> Recorded at: {date}",
            "> Internal, unredacted source; publication approval required.", "", "---", ""]
    for record in records:
        speaker = f"说话人{record['speaker']}:" if record["speaker"] else ""
        stamp = f"[{record['timestamp']}] " if record["timestamp"] else ""
        if speaker:
            body.extend((speaker, f"{stamp}{record['text']}"))
        else:
            body.append(f"{stamp}{record['text']}")
    (out / "raw.md").write_text("\n".join(body) + "\n", encoding="utf-8")

    stamped = out / "timestamped.txt"
    with stamped.open("w", encoding="utf-8") as handle:
        for record in records:
            if record["timestamp"] and record["speaker"]:
                handle.write(f"{record['timestamp']}Speaker {record['speaker']}{record['text']}\n")

    progress(100, "done", f"{len(records)} records ({detected}) -> {out}")
    return {"output": str(out), "meeting_id": meeting_id,
            "record_count": len(records), "detected_format": detected}


def main(argv=None) -> int:
    configure_utf8_stdio()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, nargs="+",
                        help="one or more txt/md transcripts or m4a/wav/mp3 audio files")
    parser.add_argument("--out", type=Path, required=True,
                        help="explicit local run output directory")
    parser.add_argument("--meeting-id", default=None)
    parser.add_argument("--title", default=None)
    parser.add_argument("--date", default=None, help="YYYY-MM-DD (default today)")
    parser.add_argument("--model", default="small", help="ASR model when source is audio")
    parser.add_argument("--language", default=None)
    parser.add_argument("--hf-token", default=None)
    args = parser.parse_args(argv)

    sources = [source.expanduser().resolve() for source in args.source]
    for source in sources:
        if not source.is_file():
            raise fail(f"source not found: {source}")
    if len(sources) > 1 and (args.meeting_id or args.title):
        raise fail("--meeting-id and --title require exactly one source")
    if args.meeting_id is not None and not MEETING_ID_RE.fullmatch(args.meeting_id):
        raise fail("--meeting-id must be one safe identity component")

    meeting_ids = [
        args.meeting_id or generated_meeting_id(source)
        for source in sources
    ]
    if len(set(meeting_ids)) != len(meeting_ids):
        raise fail("duplicate meeting IDs in one collection run")

    date = args.date or dt.date.today().isoformat()
    requested_out = args.out.expanduser()
    if requested_out.is_symlink():
        raise fail("output path must not be a symbolic link")
    base_out = requested_out.resolve()
    validate_output_tree(base_out)
    results = []
    for source, meeting_id in zip(sources, meeting_ids):
        out = (base_out / "meetings" / meeting_id).resolve()
        if not out.is_relative_to(base_out):
            raise fail("meeting output must remain inside the requested run")
        results.append(import_source(
            source, out, meeting_id, args.title or source.stem, date, args
        ))

    print(json.dumps({"output": str(base_out), "meeting_count": len(results),
                      "meetings": results}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
