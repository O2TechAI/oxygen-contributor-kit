# Oxygen Ingest Tools

Three local entry points convert repository-related agent sessions, Claude exports, and meeting transcripts or recordings into canonical Oxygen trajectories or meeting records. Each writes to an explicit run directory. Output remains `review_status=pending` and `publication_approved=false`; it is not copied to a shared directory.

For Agent integration, read the [ingest Skill](../../skills/oxygen-ingest-project-history/SKILL.md). For contributor export and import steps, read [EXPORT-GUIDE.md](EXPORT-GUIDE.md).

## Files

```text
tools/ingest/
├── collect_repo_trajectories.py   # Repository-related Claude/Codex sessions and memory
├── import_anthropic_export.py    # Claude export ZIP, JSON, or directory
├── import_meeting.py             # Meeting text or audio to canonical meeting records
├── transcribe_diarize.py         # Local CPU transcription and optional diarization
├── oxygen_common.py              # Progress, sensitive filename filtering, and hashing
├── vendor/                      # Canonical Oxygen trajectory extractors
└── .venv-audio/                  # Optional local audio dependency environment
```

## Usage

Run these commands from the repository root:

```bash
# The canonical Viewer is the workflow UI and binds only to loopback.
python3 skills/oxygen-organize-review-export/scripts/run_local_review.py --target /path/to/repo

# Collect sessions and memory associated with the approved repository.
python3 tools/ingest/collect_repo_trajectories.py /path/to/repo --out work/repo-run

# Import an existing local Claude export into a new or empty directory.
python3 tools/ingest/import_anthropic_export.py ~/Downloads/export.zip --out work/claude-run

# Import text directly; transcribe audio locally before importing it.
python3 tools/ingest/import_meeting.py meeting.txt --out work/meeting-text-run --title "Project meeting" --date 2026-07-30
python3 tools/ingest/import_meeting.py meeting.m4a --out work/meeting-audio-run --language en --date 2026-08-30
```

Supply the resolved meeting date in `YYYY-MM-DD` form; the importer requires `--date`. Use the actual recording language for `--language`, or omit it for automatic detection.

Windows PowerShell uses the same UTF-8 toolchain without requiring `python -X utf8`, `chcp`, or WSL:

```powershell
python .\tools\ingest\collect_repo_trajectories.py `
  "D:\Coding Projects\my-project" --out "work\repo-run"
python .\tools\ingest\import_anthropic_export.py `
  "D:\Downloads\export.zip" --out "work\claude-run"
python .\tools\ingest\import_meeting.py "D:\Meetings\meeting.txt" `
  --out "work\meeting-run" --title "Project meeting" --date "2026-08-30"
```

Codex sessions default to `Path.home() / ".codex" / "sessions"`, typically `C:\Users\<user>\.codex\sessions` on Windows. A repository's own `.codex` directory is an ignored fixture/runtime location, not the default session store. Only sessions whose recorded working directory is the target repository or a descendant are included. Parent directories, sibling repositories, and sessions that merely mention the repository in their text are excluded. A new worktree can therefore legitimately yield no sessions.

## Optional speaker diarization

Audio is processed locally on CPU. Transcription uses `faster-whisper` and does not require a token; optional diarization uses the gated `pyannote/speaker-diarization-3.1` model. Model files may need to be downloaded before local processing.

Install audio dependencies in the project-local environment, not globally. Text imports do not need these packages:

```bash
python3 -m venv tools/ingest/.venv-audio
tools/ingest/.venv-audio/bin/python -m pip install faster-whisper pyannote.audio
```

Accept the conditions on [speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1) and [segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0), then use your own read token through `HF_TOKEN` or `--hf-token`.

Without a token, the pipeline produces a single-speaker transcript and records a warning in its intermediate `transcript.json`; those speaker labels are not verified attribution. The meeting importer uses an automatically cleaned operating-system temporary directory for intermediate audio output.

On Windows, create the environment at the same location and use its `Scripts\python.exe`:

```powershell
python -m venv .\tools\ingest\.venv-audio
$AudioPython = ".\tools\ingest\.venv-audio\Scripts\python.exe"
& $AudioPython -m pip install faster-whisper pyannote.audio
& $AudioPython -c "import faster_whisper"  # Check the selected interpreter.
$env:HF_TOKEN = "<current-user-token>"
try {
  python .\tools\ingest\import_meeting.py "D:\Meetings\meeting.m4a" `
    --out "work\meeting-audio-run" --language en --date "2026-08-30"
}
finally {
  Remove-Item Env:\HF_TOKEN -ErrorAction SilentlyContinue
}
```

The meeting importer prefers that project-local audio interpreter when it exists; otherwise it uses the current interpreter. Installing dependencies and downloading models are setup steps, not evidence that a recording has been reviewed.

## Format handoff

- Trajectories follow the single unversioned Oxygen contract.
- The audio transcriber's `timestamped.txt` uses the `M:SSSpeaker A text` format accepted by `import_meeting.py`. The meeting importer emits `meeting.json`, `raw.md`, and `timestamped.txt` when timestamps are available.
- Claude export layouts can change. Review `index.json.warnings` and imported counts. Some unsupported entries generate warnings; invalid top-level JSON or unsafe input boundaries fail instead of silently producing a valid run.

## Privacy

- Credential filenames, including authentication files, private keys, and tokens, are excluded by `oxygen_common.SENSITIVE_NAME_RE`.
- The vendored trajectory extractor masks recognized credential patterns and replaces home-directory paths with `<USER_HOME>`.
- Automatic filtering is not publication approval. Complete the redaction workflow and contributor review before a reviewed release; imported material remains `publication_approved=false`.
- The three entry points write persistent output only under explicit `--out` directories. Audio transcription and ZIP extraction may use automatically cleaned temporary directories. Output can still contain unredacted material; keep it out of shared folders and network locations.
