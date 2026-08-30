# Ingest implementation handoff

The bundled tools support three stable outputs:

1. `collect_repo_trajectories.py`: `index.json`, `trajectories/`, and `memory/`.
2. `import_anthropic_export.py`: `index.json`, `trajectories/`, and imported memory/project documents.
3. `import_meeting.py`: every source keeps `meeting.json`, `raw.md`, and `timestamped.txt` under
   `meetings/<meeting-id>/` in one run.

Repo collection matches sessions whose recorded working directory falls inside the resolved
repository. It checks `~/.claude/projects` and the user-global `~/.codex/sessions` (normally
`C:\Users\<user>\.codex\sessions` on Windows), and copies matched Claude project memory plus
repository guidance files. User-global `CLAUDE.md` / `AGENTS.md` require the explicit
`--include-global-memory` option. Repository-local `.codex` is not a default session source. Exact
and child cwd sessions are eligible; parent, sibling, and body-mention-only sessions are excluded.
Credential-like filenames are excluded.

Discovery home and source-path masking home are separate inputs. `--home` chooses default discovery
locations. `--source-home` overrides only the local path-masking root and is required when an
isolated discovery home is paired with an explicitly approved session root. It never expands the
session boundary and is never sent through Workflow Progress.

The normal workflow starts the canonical Viewer before collection. The repo collector accepts
`--progress-url` plus `--workflow-run-id` only as a pair and sends fixed collection lifecycle
events with nonnegative counts to that exact loopback Viewer. It never sends the working-folder
path, matched session names, messages, prompts, reasoning, tool data, or extracted content. Hand
the resulting ingest directory, Viewer origin, and stable run ID to the organizer so it can attach
the run to the same process-owned Viewer state.

The Claude importer supports `conversations.json`, `memories.json`, `projects/*.json`, and
`design_chats/*.json`. It deliberately excludes `users.json` because it is pure account PII.

Meeting audio uses faster-whisper locally. Speaker diarization is optional and requires the
current user's accepted access to the gated pyannote model. Without a token, the tool still
produces a single-speaker transcript and records a warning.

Every ingest command requires an explicit local `--out`. For meetings, each source keeps its own
stable meeting ID and records; transcript contents are never concatenated. With exactly one source,
`--meeting-id` and `--title` can override its generated identity and source-derived title.

Unknown repeated speaker/body layouts use one source-bound preparation directory under
`.meeting-interpretation/<source-sha256>/`. `state.json` is importer-owned, content-free correction
state; the workflow Agent may write only `proposal.json`. The plan is source-independent and
declarative: exact bounded literals plus closed field order. The importer binds raw-byte SHA-256,
validates and canonicalizes the plan, owns all extraction and record identity, and removes only
that preparation directory after successful canonical publication. Invalid or exhausted plans
leave `meetings/<meeting-id>/` absent. Known formats, malformed known-family evidence, and ordinary
plain notes retain their existing deterministic paths.

All outputs default to `review_status=pending` and `publication_approved=false`.
