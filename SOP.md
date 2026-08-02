# Oxygen local contribution SOP

## Goal

Collect the contributor's project-related trajectories, memories, and meetings; separate mixed
project work; identify the primary project; let the contributor review everything locally; and
finish with one downloadable ZIP. Nothing is uploaded automatically.

## Completion criteria

The workflow is not complete until both conditions are true:

1. The contributor has been shown the local review frontend whenever a browser-visible frontend
   is available.
2. The contributor can download one final `oxygen-contribution.zip` containing the reviewed
   contribution package.

## 1. Confirm scope

- Resolve the repository or input path.
- Confirm the data belongs to the contributor.
- Do not inspect users outside the requested local account.
- Never read or package credential files, private keys, tokens, cookies, or hidden model reasoning.
- Keep `publication_approved=false` unless the contributor explicitly approves publication.

## 2. Collect

Select one or more input paths:

```bash
# Local repo-related Claude Code and Codex history, including allowed memory files.
python3 tools/ingest/collect_repo_trajectories.py /path/to/repo --out work/repo-run

# claude.ai export ZIP, JSON, or directory.
python3 tools/ingest/import_anthropic_export.py export.zip --out work/claude-run

# Meeting transcript or audio. Audio remains local.
python3 tools/ingest/import_meeting.py meeting.m4a --out work/meeting-run \
  --language en --no-publish
```

Do not use `--publish`. Collection stops before staging, upload, or publication.

## 3. Check ingest results

- For repo or Claude export, read `work/<run>/index.json`.
- For meetings, read `work/<run>/meeting.json`.
- Report trajectory/record counts, warnings, and failures.
- A newly cloned repo may correctly have zero matching historical sessions.
- Confirm credentials, caches, databases, and unrelated users were not collected.

## 4. Organize projects and build the timeline

Follow `skills/oxygen-organize-review-export/SKILL.md` before launching the Viewer:

- classify each event by project rather than by event/tool type;
- reconcile project aliases across conversations;
- identify the primary project from sustained user intent and substantive work;
- create `work/<run>/project-map.json`;
- use AI to turn primary-project events into short, one-idea timeline descriptions;
- preserve source event IDs and timestamps so every summary can open its original evidence.

Then run:

```bash
python3 skills/oxygen-organize-review-export/scripts/run_local_review.py work/<run>
```

## 5. Make the frontend visible

Showing the frontend is required, not an optional follow-up.

As soon as the Viewer is healthy:

1. Proactively open it in the contributor's visible browser when the environment supports browser
   opening. Do not wait for the contributor to ask to see it.
2. Always print and send the exact local URL, even when automatic opening succeeds.
3. If the current environment exposes a visible frontend or in-app browser, reuse that visible
   surface and navigate it to the Viewer.
4. If automatic opening is unavailable, clearly provide a clickable URL and say that no password
   is required.
5. Keep the Viewer process alive during review. Do not start it briefly and exit.

The frontend must show:

- organization progress while work is running;
- the selected primary project and related project groups;
- one chronological timeline per project, merged across every matching trajectory, with short
  AI descriptions (never one timeline per trajectory), distilled to 10–40 key milestones;
- a source-event view for checking the complete original content;
- a visible action for downloading the final ZIP when it is ready.

## 6. Review and finalize

- Ask the contributor to inspect the project classification and primary-project timeline.
- Compare concise timeline summaries with the read-only source events.
- If removal or redaction is needed, revise the ingest/project-map files and relaunch the Viewer.
- Do not treat automated organization or redaction as publication approval.

## 7. Produce one downloadable ZIP

Create:

```text
work/<run>/oxygen-contribution.zip
```

The ZIP should contain only the reviewed package:

```text
oxygen-contribution/
├── manifest.json
├── data/                  # selected trajectories, memories, and meetings
├── project-map.json       # project labels, primary project, and timeline summaries
└── review/
    └── oxygen-local-viewer.html
```

Requirements:

- Include a manifest with counts, warnings, source types, creation time, and
  `publication_approved`.
- Include the reviewed source-format data, not credentials or local runtime state.
- Exclude `.env*`, auth/credential files, tokens, cookies, private keys, `node_modules`, caches,
  `.wrangler`, SQLite/D1 files, logs, and temporary model output.
- Open or inspect the ZIP after creation and verify its member list.
- Verify the packaged HTML opens locally and states that nothing was uploaded.
- Make the ZIP directly downloadable by the contributor. Prefer the Viewer's visible download
  action; if it is unavailable, provide a clickable local file/download link immediately.
- Do not finish by reporting only a filesystem path that the contributor cannot download.

## 8. Handoff and stop

Tell the contributor:

- the exact Viewer URL;
- what inputs and projects were included;
- the primary project and timeline-event count;
- what was excluded or remains uncertain;
- the exact ZIP filename and a clickable download action/link;
- whether `publication_approved` is `false` or explicitly approved.

Keep the server alive until the contributor finishes downloading or asks to stop. Then stop it
with `Ctrl+C`. Do not upload, stage, publish, or submit automatically.
