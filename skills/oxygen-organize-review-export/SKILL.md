---
name: oxygen-organize-review-export
description: Separate mixed-project content across one or many Oxygen trajectories, identify the dominant project, label every event by project, synthesize a chronological main-project timeline, proactively open the local English review viewer, and export one final ZIP. Use after project histories or meetings have been collected and before any upload or publication decision.
---

# Organize, review, and export

## Organize projects first

Read every human/assistant conversation in the ingest run. Tool events are supporting evidence,
not standalone projects. Then write `<run>/project-map.json` using
[references/project-map-contract.md](references/project-map-contract.md).

1. Find topic changes both within a conversation and across conversations.
2. Group events by the actual product, repository, or workstream being discussed.
3. Choose `primary_project` by sustained user intent, substantive turns, artifacts, and
   continuity over time—not merely by the most repeated token.
4. Give every event a project label. Attach tool/system events to the nearest substantive
   project context; use `Unrelated / uncertain` when evidence is weak.
5. For primary-project human/assistant events, use AI to rewrite a compact timeline description
   of what changed, was decided, was questioned, or was produced. Preserve timestamps and
   evidence IDs, but never paste or lightly paraphrase the full source message.
6. Build exactly one chronological timeline per project across all trajectories.

## Project timeline is the unit of organization

- A trajectory is evidence, not a timeline. Never create one timeline per trajectory.
- Merge events from every matching trajectory into the timeline for their assigned project.
- A project appears once in the Viewer, even when it spans many conversations or source systems.
- Keep trajectory/document IDs on every timeline event so **Open source event** can return to
  the exact evidence.
- Order each project timeline globally by source timestamp, then source sequence for ties.
- Distill each project to 10–40 high-impact milestones. Never show hundreds of raw conversation
  turns as timeline cards; retain every omitted turn in source evidence.
- Cover the project's full time range. Prefer decisions, changes, questions, outcomes, failures,
  and validations over greetings, repeated status updates, or routine tool narration.
- The default Viewer selection is the primary project's combined timeline.
- Source trajectories may be listed for evidence inspection, but they must not look like
  separate project timelines.

Parallelize per-trajectory summaries when there are many conversations, then reconcile project
aliases globally. Use the user's configured model/key; never require a bundled Oxygen key.

Timeline descriptions must be glanceable:

- one sentence and one idea;
- at most 18 English words or 32 Chinese characters;
- start with a concrete action, decision, question, or outcome;
- remove greetings, setup narration, repeated context, implementation detail, and filler;
- do not include timestamps, project names, confidence, or source quotations because the UI
  presents those separately;
- when a source event is long, summarize its project significance rather than its contents.

## Launch the local review

From the `contributor-kit` root run:

```bash
python3 skills/oxygen-organize-review-export/scripts/run_local_review.py work/<run>
```

The launcher validates the run, starts the password-free localhost Viewer, imports the project
map and source records into SQLite/D1, builds the timeline, and proactively opens the browser.
Keep it running while the user reviews.

On Linux/WSL it also verifies Node/npm and the platform-specific dependency installation,
rebuilding incompatible modules with `npm ci`. Every launch receives fresh process-owned D1
state and binds directly to the requested IPv4 loopback port; never move `.wrangler` or add a
manual socat bridge. Use `--port <number>` when a specific isolated port is required.

## Browser handoff is required

After the Viewer becomes ready:

1. Open the local Viewer URL without waiting for a follow-up.
2. Tell the user the URL and that no password is required.
3. If automatic opening fails, surface the exact URL clearly.
4. Keep the process alive until the user finishes or asks to stop.

Do not use `--no-browser` except for automated tests or headless environments.

## Review

- Confirm every event has the correct project label, confidence, and explanation.
- Confirm the selected main project reflects sustained user intent.
- Read the cross-trajectory timeline for missing, duplicated, or out-of-order milestones.
- Inspect `Unrelated / uncertain` events and revise the project map when needed.
- Use **Source events** to compare the concise timeline against complete original content.
- Never treat organization as publication approval.

## Export

Use **Download ZIP** to create `oxygen-contribution.zip`, then inspect its member list. It must
contain `manifest.json`, normalized documents and events, `project-map.json`, and the offline
HTML review file. The exporter must apply every active AI-redaction span, omit original event
envelopes, include a safe aggregate redaction summary, and block when the model pass is incomplete
or has rejected spans. The local SQLite/D1 database is temporary runtime state and must not enter
the ZIP. Preserve `publication_approved=false`.

Read [references/data-contract.md](references/data-contract.md) when the ingest directory is
unrecognized or a new source format needs adapting.
