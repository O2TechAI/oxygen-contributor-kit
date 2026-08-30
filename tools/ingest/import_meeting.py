#!/usr/bin/env python3
"""Import meeting notes / transcript (txt, md, or m4a/wav/mp3 audio) into Oxygen meeting format.

- Audio input: first runs transcribe_diarize.py locally (CPU ASR + optional
  speaker diarization), then imports the resulting transcript.
- Text input, accepted shapes are auto-detected:
    1. "M:SSSpeaker A text"      (Oxygen timestamped format)
    2. "Speaker A: text" / "说话人0: text" / "张三: text"
    3. "[Speaker A] 9:05 AM" followed by body lines; plain lines are also accepted

Every source is stored under the explicitly requested run directory:
    meetings/<meeting-id>/meeting.json     canonical records
    meetings/<meeting-id>/raw.md           internal raw markdown
    meetings/<meeting-id>/timestamped.txt  timestamped records when available

Everything is marked contains_unredacted_source_text=true / publication_approved=false.
"""

from __future__ import annotations

import argparse
from collections import Counter
import datetime as dt
import hashlib
import json
import re
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path

from oxygen_common import (configure_utf8_stdio, fail, progress, safe_slug, sha256_file,
                           text_subprocess_options, utc_now, validate_output_root, write_json)
from human_source_projection import MEETING_SCHEMA
from meeting_interpretation import (DETECTED_FORMAT as INTERPRETED_FORMAT,
                                    InterpretationError, classify_plain_structure,
                                    finish_success, interpret_or_prepare,
                                    legacy_override_structure)

AUDIO_SUFFIXES = {".m4a", ".wav", ".mp3", ".flac", ".ogg", ".aac", ".mp4"}
TIMESTAMPED_RE = re.compile(r"^(\d{1,3}:\d{2})Speaker\s+([A-Z])\s*(.*)$")
SPEAKER_RE = re.compile(
    r"^(?:\[(\d{1,3}:\d{2}(?::\d{2})?)\] *)?(.+?)[：:] *(\S.*)$"
)
SPEAKER_LABEL_RE = re.compile(
    r"^[^\W_]+(?:[.'’\-][^\W_]+)*(?: +[^\W_]+(?:[.'’\-][^\W_]+)*)*$"
)
SPEAKER_TIME_LABEL_WORD = r"[^\W_]+(?:[.'’\-][^\W_]+)*"
SPEAKER_TIME_LABEL_RE = re.compile(
    rf"^{SPEAKER_TIME_LABEL_WORD}(?: +{SPEAKER_TIME_LABEL_WORD})*(?: +\({SPEAKER_TIME_LABEL_WORD}(?: +{SPEAKER_TIME_LABEL_WORD})*\))?$"
)
WALL_CLOCK = (
    r"(?:0?[1-9]|1[0-2]):[0-5]\d(?::[0-5]\d)?[ \t]*(?:AM|PM|am|pm)"
    r"|(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?"
)
SPEAKER_TIME_HEADER_RE = re.compile(rf"^(.+?)[ \t]+({WALL_CLOCK})$")
CLOCKISH_HEADER_RE = re.compile(r"^(.+?)[ \t]+\d{1,2}:\d{0,2}(?::\d{0,2})?(?:[ \t]*[A-Za-z]{0,2})?$")
NON_SPEAKER_LABELS = {
    "agenda", "answer", "author", "created", "date", "description", "duration", "file",
    "id", "key", "language", "location", "meeting id", "meeting title", "metadata", "name",
    "note", "owner", "path", "project", "project id", "question", "schema", "source",
    "speaker", "status", "summary", "time", "title", "todo", "topic", "type", "updated",
    "uri", "url", "value", "version", "warning",
}
NON_SPEAKER_FIRST_WORDS = {"action", "chapter", "meeting", "phase", "project", "section", "step"}
MEETING_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$")
MEETING_ID_DIGEST_LENGTH = 64
STRUCTURAL_FAILURE_CODE = "MEETING_TRANSCRIPT_STRUCTURE_INVALID"

class MeetingStructureError(ValueError):
    pass


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


def match_speaker_line(line: str) -> tuple[str | None, str, str] | None:
    """Return a conservative timestamp/label/body match for one speaker line."""
    if any(unicodedata.category(character) == "Cc" for character in line):
        return None
    match = SPEAKER_RE.fullmatch(line)
    if not match:
        return None
    timestamp, raw_label, body = match.groups()
    label = raw_label.strip(" ")
    if not label or len(label) > 24 or not SPEAKER_LABEL_RE.fullmatch(label):
        return None
    if not any(character.isalpha() for character in label):
        return None
    if label.casefold() in NON_SPEAKER_LABELS:
        return None

    words = label.split(" ")
    cased_words = [word for word in words if any(character.islower() for character in word)]
    if words[0].casefold() in NON_SPEAKER_FIRST_WORDS:
        return None
    explicit_role = words[0].startswith("Speaker") or words[0].startswith("说话人")
    if not explicit_role and any(word[0].islower() for word in cased_words):
        return None

    first_body_word = body.split(" ", 1)[0]
    if first_body_word.startswith(("/", "\\")) or ":" in first_body_word or "：" in first_body_word:
        return None
    return timestamp, label, body


def _speaker_time_label(raw_label: str) -> tuple[str, bool, str] | None:
    label = raw_label.strip(" ")
    bracketed = "[" in label or "]" in label
    valid_wrapper = (label.startswith("[") and label.endswith("]")
                     and label.count("[") == 1 and label.count("]") == 1)
    if bracketed and not valid_wrapper:
        raise MeetingStructureError
    if bracketed:
        label = label[1:-1]
    valid = (label and len(label) <= 64 and any(character.isalpha() for character in label)
             and SPEAKER_TIME_LABEL_RE.fullmatch(label))
    words = re.findall(r"[^\W_]+", label)
    valid = valid and bool(words)
    cased_words = [word for word in words if any(character.islower() for character in word)]
    role = bool(re.match(r"^(?:Speaker(?: +|\d)|说话人(?: +|\d))", label))
    valid = valid and (role or not any(word[0].islower() for word in cased_words))
    if not valid:
        if bracketed:
            raise MeetingStructureError
        return None
    return label, bracketed or role or label.endswith(")"), unicodedata.normalize("NFC", " ".join(label.split()))


def match_speaker_time_header(line: str) -> tuple[str, str, bool, str] | None:
    match = SPEAKER_TIME_HEADER_RE.fullmatch(line)
    if (not match
            or any(unicodedata.category(character) == "Cc" for character in line)):
        return None
    raw_label, timestamp = match.groups()
    parsed = _speaker_time_label(raw_label)
    if not parsed:
        return None
    return parsed[0], timestamp, *parsed[1:]


def _clock_order(timestamp: str) -> dt.time:
    value = timestamp.upper().replace(" ", "").replace("\t", "")
    period_format = "%p" if value.endswith(("AM", "PM")) else ""
    date_format = ("%I" if period_format else "%H") + ":%M"
    date_format += (":%S" if value.count(":") == 2 else "") + period_format
    return dt.datetime.strptime(value, date_format).time()


def parse_speaker_time_layout(text: str) -> tuple[list[dict], str] | None:
    lines = list(enumerate(text.splitlines(), 1))
    headers: dict[int, tuple[str, str, bool, str]] = {}
    clockish: list[tuple[int, str, bool, str]] = []
    for number, line in ((number, line.strip()) for number, line in lines if line.strip()):
        header = match_speaker_time_header(line)
        if header:
            headers[number] = header
            continue
        match = CLOCKISH_HEADER_RE.fullmatch(line)
        if match and (parsed := _speaker_time_label(match.group(1))):
            clockish.append((number, *parsed))

    label_counts = Counter(header[3] for header in headers.values())
    activated = (any(header[2] for header in headers.values())
                 or any(count >= 2 for count in label_counts.values()))
    candidate_lines = set(headers) | {item[0] for item in clockish}
    if not activated:
        if any(item[2] for item in clockish) or len(candidate_lines) > 1:
            raise MeetingStructureError
        if not candidate_lines: return None
        records = [
            {"timestamp": None, "speaker": None, "text": line.strip(), "source_line": number}
            for number, line in lines if line.strip()
        ]
        return records, "plain"
    if clockish: raise MeetingStructureError
    if any(not header[2] and label_counts[header[3]] < 2 for header in headers.values()):
        raise MeetingStructureError

    records: list[dict] = []
    current: dict | None = None
    body: list[str] = []
    for number, raw_line in lines:
        line = raw_line.strip()
        if not line:
            continue
        header = headers.get(number)
        if header:
            if current is not None:
                if not body:
                    raise MeetingStructureError
                current["text"] = "\n".join(body)
                records.append(current)
            speaker, timestamp, _, _ = header
            current = {"timestamp": timestamp, "speaker": speaker, "source_line": number}
            body = []
            continue
        if current is None:
            raise MeetingStructureError
        if TIMESTAMPED_RE.match(line) or match_speaker_line(line):
            raise MeetingStructureError
        body.append(raw_line)

    if current is None or not body:
        raise MeetingStructureError
    current["text"] = "\n".join(body)
    records.append(current)
    clocks = [_clock_order(record["timestamp"]) for record in records]
    if any(left > right for left, right in zip(clocks, clocks[1:])):
        raise MeetingStructureError
    return records, "speaker-time"


def parse_lines(text: str) -> tuple[list[dict], str]:
    """Return (records, detected_format)."""
    speaker_time = parse_speaker_time_layout(text)
    if speaker_time is not None:
        records, detected = speaker_time
        for order, record in enumerate(records, 1):
            record["record_id"] = f"rec-{order:05d}"
            record["order"] = order
        return records, detected
    records: list[dict] = []
    source_lines = [
        (number, line) for number, line in enumerate(text.splitlines(), 1) if line.strip()
    ]
    lines = [(number, line.strip()) for number, line in source_lines]
    if not lines:
        return records, "empty"

    timestamped_hits = sum(1 for _, line in lines if TIMESTAMPED_RE.match(line))
    speaker_matches = [
        None if any(unicodedata.category(character) == "Cc" for character in source_line)
        else match_speaker_line(line)
        for (_, line), (_, source_line) in zip(lines, source_lines)
    ]
    speaker_hits = sum(match is not None for match in speaker_matches)

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
    elif ((len(lines) == 1 and speaker_hits == 1)
          or speaker_hits >= max(2, len(lines) // 2)):
        detected = "speaker-labeled"
        for (number, line), match in zip(lines, speaker_matches):
            if match:
                timestamp, speaker, body = match
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
    interpreted = False
    interpretation_plan_digest = None
    preparation = None
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
        source_bytes = None
    else:
        source_bytes = source.read_bytes()
        transcript = source_bytes.decode("utf-8")

    records, detected = parse_lines(transcript)
    override = source_bytes is not None and legacy_override_structure(transcript)
    if source_bytes is not None and (detected == "plain" or override):
        remaining = "unsupported" if override else classify_plain_structure(transcript)
        if remaining == "invalid":
            raise MeetingStructureError
        if remaining == "unsupported":
            records, interpretation_plan_digest, preparation = interpret_or_prepare(
                source_bytes, out.parents[1]
            )
            detected = INTERPRETED_FORMAT
            interpreted = True
    if not records:
        raise fail("no content found in transcript")
    out.mkdir(parents=True, exist_ok=True)
    progress(75, "parse", f"parsing {source.name}")
    speakers = sorted({r["speaker"] for r in records if r["speaker"]})
    progress(85, "write", f"format={detected}, {len(records)} records, {len(speakers)} speakers")

    dataset = {
        "schema": MEETING_SCHEMA,
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
    }
    if interpreted:
        dataset.pop("generated_at")
        dataset.update(
            source_digest=hashlib.sha256(source_bytes).hexdigest(),
            interpretation_plan_digest=interpretation_plan_digest,
        )
    write_json(out / "meeting.json", dataset)

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
    with stamped.open("w", encoding="utf-8", newline="\n") as handle:
        for record in records:
            if record["timestamp"] and record["speaker"]:
                handle.write(f"{record['timestamp']}Speaker {record['speaker']}{record['text']}\n")
            elif record["speaker"]:
                handle.write(f"{record['speaker']}: {record['text']}\n")

    if preparation is not None:
        try:
            finish_success(preparation)
        except OSError:
            pass

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
            print("MEETING_SOURCE_INVALID", file=sys.stderr)
            return 1
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
    try:
        base_out = validate_output_root(args.out)
    except ValueError as error:
        raise fail(str(error)) from error
    results = []
    try:
        for source, meeting_id in zip(sources, meeting_ids):
            out = (base_out / "meetings" / meeting_id).resolve()
            if not out.is_relative_to(base_out):
                raise fail("meeting output must remain inside the requested run")
            results.append(import_source(
                source, out, meeting_id, args.title or source.stem, date, args
            ))
    except (MeetingStructureError, InterpretationError) as error:
        if isinstance(error, InterpretationError):
            print(error.code, file=sys.stderr)
            return 1
        print(STRUCTURAL_FAILURE_CODE, file=sys.stderr)
        return 1

    print(json.dumps({"output": str(base_out), "meeting_count": len(results),
                      "meetings": results}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
