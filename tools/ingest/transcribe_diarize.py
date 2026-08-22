#!/usr/bin/env python3
"""Local (CPU) speech-to-text + speaker diarization for meeting audio (m4a/wav/mp3).

Everything runs on this machine — audio never leaves the server. This matches
the project rule that unredacted meeting material must not go to外部 services.

- ASR: faster-whisper (CTranslate2, CPU-friendly, no torch needed).
- Diarization: pyannote.audio 3.x, optional — the model is gated, so it needs a
  Hugging Face token (--hf-token or HF_TOKEN env) and one-time license
  acceptance for `pyannote/speaker-diarization-3.1`. Without it, the transcript
  is produced with a single "Speaker A" and a clear warning.

Run inside the audio venv:  tools/.venv-audio/bin/python transcribe_diarize.py ...

Outputs in --out:
    transcript.json     segments with start/end/speaker/text
    timestamped.txt     "M:SSSpeaker A text" lines (Oxygen meeting import format)
    transcript.md       human-readable transcript
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from oxygen_common import configure_utf8_stdio, fail, progress, run_stamp, safe_slug, utc_now, write_json


def format_ts(seconds: float) -> str:
    minutes = int(seconds) // 60
    return f"{minutes}:{int(seconds) % 60:02d}"


def diarize(audio_path: Path, hf_token: str | None, num_speakers: int | None):
    """Return list of (start, end, speaker_label) or None if unavailable."""
    if not hf_token:
        return None
    try:
        from pyannote.audio import Pipeline  # type: ignore
    except ImportError:
        progress(None, "diarize", "pyannote.audio not installed — skipping diarization")
        return None
    progress(None, "diarize", "loading pyannote/speaker-diarization-3.1 (first run downloads models)")
    try:  # pyannote 4.x
        pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1", token=hf_token)
    except TypeError:  # pyannote 3.x
        pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1", use_auth_token=hf_token)
    kwargs = {"num_speakers": num_speakers} if num_speakers else {}
    # Decode via PyAV (bundled with faster-whisper) instead of pyannote's own
    # torchcodec loader, which needs a matching system ffmpeg.
    import torch
    from faster_whisper.audio import decode_audio

    samples = decode_audio(str(audio_path), sampling_rate=16000)
    waveform = torch.from_numpy(samples).unsqueeze(0)
    result = pipeline({"waveform": waveform, "sample_rate": 16000}, **kwargs)
    # pyannote 3.x returns an Annotation; 4.x wraps it in a DiarizeOutput.
    annotation = result if hasattr(result, "itertracks") else (
        getattr(result, "speaker_diarization", None) or getattr(result, "annotation", None))
    if annotation is None:
        progress(None, "diarize", f"unexpected pipeline output {type(result).__name__} — skipping")
        return None
    turns = [
        (segment.start, segment.end, label)
        for segment, _, label in annotation.itertracks(yield_label=True)
    ]
    turns.sort()
    return turns


def speaker_for(start: float, end: float, turns) -> str | None:
    """Speaker with the largest time overlap for [start, end]."""
    best, best_overlap = None, 0.0
    for turn_start, turn_end, label in turns:
        overlap = min(end, turn_end) - max(start, turn_start)
        if overlap > best_overlap:
            best, best_overlap = label, overlap
    return best


def main(argv=None) -> int:
    configure_utf8_stdio()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", type=Path)
    parser.add_argument("--out", type=Path, help="output dir (default tools/out/asr-<name>-<ts>)")
    parser.add_argument("--model", default="small", help="faster-whisper model (base/small/medium)")
    parser.add_argument("--language", default=None, help="e.g. zh / en; default auto-detect")
    parser.add_argument("--hf-token", default=os.environ.get("HF_TOKEN"))
    parser.add_argument("--num-speakers", type=int, default=None)
    args = parser.parse_args(argv)

    audio = args.audio.expanduser().resolve()
    if not audio.is_file():
        raise fail(f"audio not found: {audio}")
    out = (
        args.out.expanduser().resolve()
        if args.out
        else Path(__file__).resolve().parent / "out" / f"asr-{safe_slug(audio.stem)}-{run_stamp()}"
    )
    out.mkdir(parents=True, exist_ok=True)

    try:
        from faster_whisper import WhisperModel  # type: ignore
    except ImportError:
        raise fail(
            "faster-whisper is not installed in this python. "
            "Run: tools/.venv-audio/bin/python transcribe_diarize.py ... "
            "(create venv: python3 -m venv tools/.venv-audio && tools/.venv-audio/bin/pip install faster-whisper)"
        )

    progress(3, "load", f"loading whisper model '{args.model}' (first run downloads it)")
    model = WhisperModel(args.model, device="cpu", compute_type="int8")

    progress(8, "transcribe", f"transcribing {audio.name}")
    segments_iter, info = model.transcribe(
        str(audio), language=args.language, vad_filter=True, beam_size=5
    )
    duration = max(info.duration or 1.0, 1.0)
    segments = []
    for segment in segments_iter:
        segments.append(
            {"start": round(segment.start, 2), "end": round(segment.end, 2), "text": segment.text.strip()}
        )
        pct = 8 + 70 * min(segment.end / duration, 1.0)
        progress(pct, "transcribe", f"{format_ts(segment.end)}/{format_ts(duration)} {segment.text.strip()[:60]}")
    if not segments:
        raise fail("no speech recognized")

    progress(80, "diarize", "running speaker diarization" if args.hf_token else
             "no HF token — writing single-speaker transcript")
    turns = diarize(audio, args.hf_token, args.num_speakers)
    warnings = []
    if turns:
        labels = sorted({label for _, _, label in turns})
        letter = {label: chr(ord("A") + index % 26) for index, label in enumerate(labels)}
        for segment in segments:
            label = speaker_for(segment["start"], segment["end"], turns)
            segment["speaker"] = letter.get(label, "A")
    else:
        for segment in segments:
            segment["speaker"] = "A"
        warnings.append(
            "diarization skipped (no HF token or pyannote missing): all lines labeled Speaker A"
        )

    write_json(
        out / "transcript.json",
        {
            "tool": "transcribe_diarize",
            "generated_at": utc_now(),
            "audio": str(audio),
            "model": args.model,
            "language": info.language,
            "language_probability": round(info.language_probability or 0, 3),
            "duration_seconds": round(duration, 1),
            "diarization": bool(turns),
            "speaker_count": len({s["speaker"] for s in segments}),
            "warnings": warnings,
            "segments": segments,
        },
    )
    with (out / "timestamped.txt").open("w", encoding="utf-8") as handle:
        for segment in segments:
            handle.write(f"{format_ts(segment['start'])}Speaker {segment['speaker']}{segment['text']}\n")
    with (out / "transcript.md").open("w", encoding="utf-8") as handle:
        handle.write(f"# Transcript — {audio.name}\n\n")
        handle.write(f"> generated {utc_now()} · model {args.model} · language {info.language} · ")
        handle.write("diarized\n\n" if turns else "NOT diarized (single speaker label)\n\n")
        for segment in segments:
            handle.write(f"**[{format_ts(segment['start'])}] Speaker {segment['speaker']}:** {segment['text']}\n\n")

    progress(100, "done", f"{len(segments)} segments, language={info.language} -> {out}")
    print(json.dumps({"output": str(out)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
