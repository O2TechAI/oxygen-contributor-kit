# Ingest implementation handoff

The bundled tools support three stable outputs:

1. `collect_repo_trajectories.py`: `index.json`, `trajectories/`, and `memory/`.
2. `import_anthropic_export.py`: `index.json`, `trajectories/`, and imported memory/project documents.
3. `import_meeting.py`: `meeting.json`, `raw.md`, and `timestamped.txt`.

Repo collection matches sessions whose recorded working directory falls inside the resolved
repository. It checks `~/.claude/projects` and the user-global `~/.codex/sessions` (normally
`C:\Users\<user>\.codex\sessions` on Windows), and copies only allowed Claude/Codex memory
and repository guidance files. Repository-local `.codex` is not a default session source. Exact
and child cwd sessions are eligible; parent, sibling, and body-mention-only sessions are excluded.
Credential-like filenames are excluded.

The Claude importer supports `conversations.json`, `memories.json`, `projects/*.json`, and
`design_chats/*.json`. It deliberately excludes `users.json` because it is pure account PII.

Meeting audio uses faster-whisper locally. Speaker diarization is optional and requires the
current user's accepted access to the gated pyannote model. Without a token, the tool still
produces a single-speaker transcript and records a warning.

All outputs default to `review_status=pending` and `publication_approved=false`.
