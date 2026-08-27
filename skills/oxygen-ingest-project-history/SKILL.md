---
name: oxygen-ingest-project-history
description: Collect local Codex or Claude Code sessions and allowed memory related to a repository, import a claude.ai data export, or convert meeting text/audio into Oxygen trajectory v0.2 inputs. Use when a contributor asks to gather project history before local organization and review.
---

# Ingest project history

Run from the `contributor-kit` root. Keep all output local and unapproved.

## Start Workflow Progress before collection

After resolving and verifying the contributor-approved working folder, start the canonical Viewer
before scanning any history:

```bash
python3 skills/oxygen-organize-review-export/scripts/run_local_review.py \
  --target /path/to/repo
```

The launcher reserves an arbitrary free loopback port, opens the sanitized Workflow Progress
surface, and prints the exact Viewer origin plus a stable workflow run ID. Keep it running. Do not
start collection until the Viewer is healthy. An explicit `--port` remains available when needed;
an occupied port fails closed without killing its owner or choosing another after announcement.

## Choose the input

- Repository path: `tools/ingest/collect_repo_trajectories.py`
- claude.ai ZIP, `conversations.json`, or export directory:
  `tools/ingest/import_anthropic_export.py`
- One or more meeting TXT, Markdown, M4A, WAV, or MP3 files:
  `tools/ingest/import_meeting.py`

## Collect

```bash
python3 tools/ingest/collect_repo_trajectories.py /path/to/repo --out work/repo-run \
  --progress-url http://127.0.0.1:<port> --workflow-run-id <run-id>
python3 tools/ingest/import_anthropic_export.py export.zip --out work/claude-run
python3 tools/ingest/import_meeting.py meeting.txt --out work/meeting-run \
  --title "Project meeting"
python3 tools/ingest/import_meeting.py meeting-a.txt meeting-b.txt \
  --out work/meeting-run
```

On native Windows PowerShell:

```powershell
python .\tools\ingest\collect_repo_trajectories.py `
  "D:\Coding Projects\my-project" --out "work\repo-run" `
  --progress-url "http://127.0.0.1:<port>" --workflow-run-id "<run-id>"
python .\tools\ingest\import_anthropic_export.py `
  "D:\Downloads\export.zip" --out "work\claude-run"
python .\tools\ingest\import_meeting.py `
  "D:\Meetings\meeting.txt" --out "work\meeting-run" `
  --title "Project meeting"
python .\tools\ingest\import_meeting.py `
  "D:\Meetings\meeting-a.txt" "D:\Meetings\meeting-b.txt" `
  --out "work\meeting-run"
```

Codex discovery defaults to the contributor's global
`Path.home() / ".codex" / "sessions"` (`C:\Users\<user>\.codex\sessions` on
Windows). Default discovery matches only exact/child recorded cwd values. Parent, sibling, and
message-body-only references remain out of scope, so a valid global-store scan can return zero.

Do not infer or automatically substitute a repository-local `.codex`; it can contain mixed
Toolkit fixture/runtime output. If the contributor explicitly identifies and approves an exact
Codex session directory after a metadata-only audit, pass that directory itself as
`--codex-session-root <approved-session-directory>`. This explicit option is the collection
boundary: every valid Codex session JSONL below it is eligible without reapplying target-cwd
matching. Point only at the audited `sessions` child, never a mixed `.codex` parent, and never
widen to a parent cwd or another session store without separate approval.

`--home` controls discovery. If a validation deliberately supplies an isolated task-local `--home`
while using an approved `--codex-session-root`, also pass
`--source-home <contributor-home-used-by-the-source>` so path masking remains stable. This second
path is used only by the local extractor; it does not widen collection and must never enter a
browser progress payload. Run a cheap path preflight before extraction and fail clearly if the
approved masking path is unavailable.

Repository guidance and matched Claude project memory remain in scope by default. User-global
`~/.codex/AGENTS.md` and `~/.claude/CLAUDE.md` are not collected automatically; include them only
after separate approval with `--include-global-memory`.

For audio, use local transcription. Only accept a Hugging Face token supplied by the current
user and pass it at runtime; never store it:

```bash
HF_TOKEN="<current-user-token>" python3 tools/ingest/import_meeting.py meeting.m4a \
  --out work/meeting-run --language en
```

Windows audio remains optional and project-local. The importer recognizes
`tools\ingest\.venv-audio\Scripts\python.exe`; do not install its packages globally:

```powershell
$AudioPython = ".\tools\ingest\.venv-audio\Scripts\python.exe"
& $AudioPython -c "import faster_whisper"  # availability check only
$env:HF_TOKEN = "<current-user-token>"
try {
  python .\tools\ingest\import_meeting.py "D:\Meetings\meeting.m4a" `
    --out "work\meeting-run" --language en
}
finally {
  Remove-Item Env:\HF_TOKEN -ErrorAction SilentlyContinue
}
```

All three ingestion commands require an explicit local `--out` and expose no staging,
publication, or upload option. Do not copy outputs to any shared or network location.

## Verify

- Repo/Claude export: inspect `index.json`; report counts, failures, and warnings.
- Meeting import: inspect every `work/<run>/meetings/<meeting-id>/meeting.json`, including for a
  one-meeting run. Report meeting, record, speaker, and warning counts.
- Treat zero histories for a newly cloned repo as a valid result.
- Confirm `publication_approved=false`.

Then invoke `$oxygen-organize-review-export` with the output directory, exact Viewer origin, and
workflow run ID. That Skill attaches the run to the already-running Viewer; it must not launch a
second runtime.

## Boundaries

- Never read credential files, private keys, cookies, tokens, or system/developer prompts.
- Only inspect the current contributor's local session directories.
- Keep audio local.
- Automatic filtering is not publication approval.
- Progress accepts only fixed operational events/counts. Never send a target path, session name,
  prompt, reasoning, tool argument, source payload, Story/Evidence content, or removed material.

Read [references/ingest-handoff.md](references/ingest-handoff.md) only when troubleshooting
format details or optional diarization.
