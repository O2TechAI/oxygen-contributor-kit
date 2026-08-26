#!/usr/bin/env python3
"""Import meeting notes / transcript (txt, md, or m4a/wav/mp3 audio) into Oxygen meeting format.

- Audio input: first runs transcribe_diarize.py locally (CPU ASR + optional
  speaker diarization), then imports the resulting transcript.
- Text input, three accepted shapes (auto-detected):
    1. "M:SSSpeaker A text"      (Oxygen timestamped format)
    2. "Speaker A: text" / "说话人0: text" / "张三: text"
    3. plain lines (no speaker structure)

Single-source outputs in --out (default tools/out/meeting-<id>/):
    meeting.json        canonical records (order/speaker/timestamp/text/source_line)
    raw.md              internal raw markdown, same shape as scripts/import_timestamped_meeting.py
    timestamped.txt     present when timestamps exist — feeds the existing Oxygen importer

With multiple sources, --out is required and each meeting keeps the same files under
meetings/<meeting-id>/.

Everything is marked contains_unredacted_source_text=true / publication_approved=false.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
from pathlib import Path

from oxygen_common import (configure_utf8_stdio, fail, progress, publish_to_staging, run_stamp,
                           safe_slug, text_subprocess_options, utc_now, write_json)

AUDIO_SUFFIXES = {".m4a", ".wav", ".mp3", ".flac", ".ogg", ".aac", ".mp4"}
TIMESTAMPED_RE = re.compile(r"^(\d{1,3}:\d{2})Speaker\s+([A-Z])\s*(.*)$")
SPEAKER_RE = re.compile(r"^(?:\[(\d{1,3}:\d{2}(?::\d{2})?)\]\s*)?([^\s:：]{1,24})[:：]\s*(.+)$")


def run_asr(audio: Path, out: Path, model: str, language: str | None, hf_token: str | None) -> Path:
    tools_dir = Path(__file__).resolve().parent
    candidates = (
        tools_dir / ".venv-audio" / "Scripts" / "python.exe",
        tools_dir / ".venv-audio" / "bin" / "python",
    )
    venv_python = next((candidate for candidate in candidates if candidate.is_file()), None)
    python = str(venv_python) if venv_python else sys.executable
    cmd = [python, str(tools_dir / "transcribe_diarize.py"), str(audio), "--out", str(out / "asr"),
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
    transcript = out / "asr" / "timestamped.txt"
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


def import_source(source: Path, out: Path, meeting_id: str, title: str, date: str, args) -> dict:
    out.mkdir(parents=True, exist_ok=True)

    if source.suffix.lower() in AUDIO_SUFFIXES:
        progress(2, "asr", f"audio input — running local transcription for {source.name}")
        text_path = run_asr(source, out, args.model, args.language, args.hf_token)
    else:
        text_path = source

    progress(75, "parse", f"parsing {text_path.name}")
    records, detected = parse_lines(text_path.read_text(encoding="utf-8"))
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

    if detected == "timestamped" or (source.suffix.lower() in AUDIO_SUFFIXES):
        stamped = out / "timestamped.txt"
        if not stamped.exists():
            with stamped.open("w", encoding="utf-8") as handle:
                for record in records:
                    if record["timestamp"] and record["speaker"]:
                        handle.write(f"{record['timestamp']}Speaker {record['speaker']}{record['text']}\n")

    staged = None
    if not args.no_publish:
        staged = publish_to_staging(out, meeting_id)
        if staged:
            progress(98, "publish", f"staged for Inline import: {staged}")
    progress(100, "done", f"{len(records)} records ({detected}) -> {out}")
    return {"output": str(out), "meeting_id": meeting_id, "staged": staged,
            "record_count": len(records), "detected_format": detected}


def main(argv=None) -> int:
    configure_utf8_stdio()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, nargs="+",
                        help="one or more txt/md transcripts or m4a/wav/mp3 audio files")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--meeting-id", default=None)
    parser.add_argument("--title", default=None)
    parser.add_argument("--date", default=None, help="YYYY-MM-DD (default today)")
    parser.add_argument("--model", default="small", help="ASR model when source is audio")
    parser.add_argument("--language", default=None)
    parser.add_argument("--hf-token", default=None)
    parser.add_argument("--no-publish", action="store_true",
                        help="do not copy the result into the shared ingest-staging area")
    args = parser.parse_args(argv)

    sources = [source.expanduser().resolve() for source in args.source]
    for source in sources:
        if not source.is_file():
            raise fail(f"source not found: {source}")
    multiple = len(sources) > 1
    if multiple and args.out is None:
        raise fail("--out is required when importing multiple meetings")
    if multiple and (args.meeting_id or args.title):
        raise fail("--meeting-id and --title support single-meeting imports only")

    stamp = run_stamp()
    meeting_ids = [
        args.meeting_id or f"meeting-{safe_slug(source.stem)}-{stamp}"
        for source in sources
    ]
    if len(set(meeting_ids)) != len(meeting_ids):
        raise fail("duplicate meeting IDs in one collection run")

    date = args.date or dt.date.today().isoformat()
    base_out = args.out.expanduser().resolve() if args.out else (
        Path(__file__).resolve().parent / "out" / meeting_ids[0])
    results = []
    for source, meeting_id in zip(sources, meeting_ids):
        out = base_out / "meetings" / meeting_id if multiple else base_out
        results.append(import_source(
            source, out, meeting_id, args.title or source.stem, date, args
        ))

    if multiple:
        print(json.dumps({"output": str(base_out), "meeting_count": len(results),
                          "meetings": results}, ensure_ascii=False))
    else:
        print(json.dumps(results[0], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
