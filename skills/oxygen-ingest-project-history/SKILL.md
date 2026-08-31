---
name: oxygen-ingest-project-history
description: Collect local Codex or Claude Code sessions and allowed memory related to a repository, import a claude.ai data export, or convert meeting text/audio into canonical Oxygen trajectory inputs. Use when a contributor asks to gather project history before local organization and review.
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
  --title "Project meeting" --date 2026-08-30
python3 tools/ingest/import_meeting.py meeting-a.txt meeting-b.txt \
  --out work/meeting-run --date 2026-08-30
```

Before importing, the selected workflow Agent must resolve exactly one date for each meeting
source. Use the first level below that has one unambiguous credible date, and do not consult a
lower-priority level after resolving a higher-priority one:

1. One corresponding date in the filename.
2. Otherwise, the transcript's own meeting or recording date in its content, excluding incidental
   dates mentioned in discussion.
3. Otherwise, a contiguous ancestor-directory date hierarchy such as year/month/day.

If the selected level has multiple credible candidates, or all three levels lack a credible date,
pause Collect and ask the contributor for that source's date. Never substitute the current date,
filesystem metadata, another source's date, or one collection-wide date. Pass the resolved date
normalized to `YYYY-MM-DD` with `--date`. Sources with distinct dates must be imported in separate
commands with their exact dates; a multi-source command is valid only when every source
intentionally has the same resolved date. `MEETING_DATE_REQUIRED` and `MEETING_DATE_INVALID` are
recoverable correction or contributor-input states, not security or whole-workflow failures.

The meeting importer always tries its deterministic known formats and ordinary plain notes first.
If it returns only `MEETING_TRANSCRIPT_STRUCTURE_UNSUPPORTED`, the currently selected workflow
Agent may inspect that contributor-approved text source and write one declarative proposal at:

```text
<out>/.meeting-interpretation/<source-sha256>/proposal.json
```

The proposal has exactly `sourceDigest`, `recordForm`, `prefix`, `separator`, `suffix`, `fields`,
and `blankLines`. It describes inert exact literals and a closed field order; it contains no
records, code, regex, commands, paths, transformations, provider choice, or instructions. Rerun
the same importer with the same source and output root. The importer alone validates the proposal,
derives canonical records from the source, and publishes the meeting.

For `header_body`, `fields` is `["speaker"]`, `["speaker","timestamp"]`, or
`["timestamp","speaker"]`; physical content through the next exact header is the body. For `row`,
`fields` is a permutation with exactly one `speaker`, one `body`, and optionally one `timestamp`.
Use `blankLines` as `body` or `record_separator` (`row` requires `record_separator`). The three
literal tokens are bounded exact UTF-8 matchers without line breaks or controls other than a tab
used as the row separator, never executable syntax; fixed alphabetic labels such as `Speaker: `
are allowed.

Only `MEETING_INTERPRETATION_PROPOSAL_INVALID` permits replacing `proposal.json`, using the same
Agent and byte-identical source, for at most two corrections after the initial proposal. Rerun the
same importer after each replacement. `MEETING_INTERPRETATION_EXHAUSTED` pauses Collect and asks the
contributor; do not report a generic security failure. Missing proposals consume no attempt, and
state/authority failures are not correctable. Never switch provider, write parser code, or enter
Organize while interpretation remains unresolved.

On native Windows PowerShell:

```powershell
python .\tools\ingest\collect_repo_trajectories.py `
  "D:\Coding Projects\my-project" --out "work\repo-run" `
  --progress-url "http://127.0.0.1:<port>" --workflow-run-id "<run-id>"
python .\tools\ingest\import_anthropic_export.py `
  "D:\Downloads\export.zip" --out "work\claude-run"
python .\tools\ingest\import_meeting.py `
  "D:\Meetings\meeting.txt" --out "work\meeting-run" `
  --title "Project meeting" --date "2026-08-30"
python .\tools\ingest\import_meeting.py `
  "D:\Meetings\meeting-a.txt" "D:\Meetings\meeting-b.txt" `
  --out "work\meeting-run" --date "2026-08-30"
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
  --out work/meeting-run --language en --date 2026-08-30
```

Windows audio remains optional and project-local. The importer recognizes
`tools\ingest\.venv-audio\Scripts\python.exe`; do not install its packages globally:

```powershell
$AudioPython = ".\tools\ingest\.venv-audio\Scripts\python.exe"
& $AudioPython -c "import faster_whisper"  # availability check only
$env:HF_TOKEN = "<current-user-token>"
try {
  python .\tools\ingest\import_meeting.py "D:\Meetings\meeting.m4a" `
    --out "work\meeting-run" --language en --date "2026-08-30"
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
