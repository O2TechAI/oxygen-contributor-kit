---
name: oxygen-ingest-project-history
description: Collect local Codex or Claude Code sessions and allowed memory related to a repository, import a claude.ai data export, or convert meeting text/audio into Oxygen trajectory v0.2 inputs. Use when a contributor asks to gather project history before local organization and review.
---

# Ingest project history

Run from the `contributor-kit` root. Keep all output local and unapproved.

## Choose the input

- Repository path: `tools/ingest/collect_repo_trajectories.py`
- claude.ai ZIP, `conversations.json`, or export directory:
  `tools/ingest/import_anthropic_export.py`
- Meeting TXT, Markdown, M4A, WAV, or MP3: `tools/ingest/import_meeting.py`

## Collect

```bash
python3 tools/ingest/collect_repo_trajectories.py /path/to/repo --out work/repo-run
python3 tools/ingest/import_anthropic_export.py export.zip --out work/claude-run
python3 tools/ingest/import_meeting.py meeting.txt --out work/meeting-run \
  --title "Project meeting" --no-publish
```

On native Windows PowerShell:

```powershell
python .\tools\ingest\collect_repo_trajectories.py `
  "D:\Coding Projects\my-project" --out "work\repo-run"
python .\tools\ingest\import_anthropic_export.py `
  "D:\Downloads\export.zip" --out "work\claude-run"
python .\tools\ingest\import_meeting.py `
  "D:\Meetings\meeting.txt" --out "work\meeting-run" `
  --title "Project meeting" --no-publish
```

Codex discovery defaults to the contributor's global
`Path.home() / ".codex" / "sessions"` (`C:\Users\<user>\.codex\sessions` on
Windows). Do not substitute the repository-local `.codex`; that is ignored toolkit
fixture/runtime space. Match only exact/child recorded cwd values. Parent, sibling, and
message-body-only references remain out of scope, so a valid global-store scan can return zero.

For audio, use local transcription. Only accept a Hugging Face token supplied by the current
user and pass it at runtime; never store it:

```bash
HF_TOKEN="<current-user-token>" python3 tools/ingest/import_meeting.py meeting.m4a \
  --out work/meeting-run --language en --no-publish
```

Windows audio remains optional and project-local. The importer recognizes
`tools\ingest\.venv-audio\Scripts\python.exe`; do not install its packages globally:

```powershell
$AudioPython = ".\tools\ingest\.venv-audio\Scripts\python.exe"
& $AudioPython -c "import faster_whisper"  # availability check only
$env:HF_TOKEN = "<current-user-token>"
try {
  python .\tools\ingest\import_meeting.py "D:\Meetings\meeting.m4a" `
    --out "work\meeting-run" --language en --no-publish
}
finally {
  Remove-Item Env:\HF_TOKEN -ErrorAction SilentlyContinue
}
```

Do not use `--publish`. Do not copy outputs to staging or any network location.

## Verify

- Repo/Claude export: inspect `index.json`; report counts, failures, and warnings.
- Meeting: inspect `meeting.json`; report record and speaker counts and warnings.
- Treat zero histories for a newly cloned repo as a valid result.
- Confirm `publication_approved=false`.

Then invoke `$oxygen-organize-review-export` with the output directory.

## Boundaries

- Never read credential files, private keys, cookies, tokens, or system/developer prompts.
- Only inspect the current contributor's local session directories.
- Keep audio local.
- Automatic filtering is not publication approval.

Read [references/ingest-handoff.md](references/ingest-handoff.md) only when troubleshooting
format details or optional diarization.
