---
name: oxygen-organize-review-export
description: Continue the progress-first local Viewer after collection, separate mixed-project content across one or many Oxygen trajectories, identify the dominant project, synthesize one chronological main-project timeline, and export one final ZIP. Use after project histories or meetings have been collected and before any upload or publication decision.
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
- Distill each project into evidence-supported meaningful milestones without using a numeric quota.
  Never show hundreds of raw conversation turns as timeline cards; retain every omitted turn in
  source evidence.
- Cover the project's full time range. Include consequential decisions and changes, durable
  progress, substantive iterations, failures or diagnostic cases that affected later work,
  validations, handoffs, and the current state. Exclude greetings, repeated status updates, routine
  tool narration, and reruns that add no new result or understanding.
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

## Delegate Storytelling after the reviewed boundary

In the complete contributor workflow, organization alone is not the final human review. After the
organized input has passed the required AI-privacy preparation and is safe to use as the reviewed
copy, read and follow
[`../oxygen-storytelling-review/SKILL.md`](../oxygen-storytelling-review/SKILL.md).

That Skill owns Story selection, bilingual Story data, Chapter review, Privacy/evidence review,
and Final Release Memory. Reuse the repository's existing Viewer shell and canonical Storytelling
renderer/runtime; do not create another frontend or copy the Storytelling contract into this Skill.
The contributor does not need to know or manually name the delegated Skill.

At workflow boundaries, expose progress through the existing Viewer using sanitized stage IDs,
completion/current/next state, justified counts, blocker codes, timestamps, and whether human
action is required. Never expose chain-of-thought, prompts, raw model/tool output, private messages,
Story/Evidence payloads, or removed content as workflow progress.

After iterative Story review, return to the existing Release preview, Preferences, and package
flow. `All set` is local human confirmation of the Story representation only; it does not create a
package, publish, or change `publication_approved`.

## Continue the same progress-first Viewer

The normal workflow already launched Workflow Progress before collection and retained its exact
Viewer origin and stable workflow run ID. After `project-map.json` exists, attach the ingest run to
that same process-owned D1 state:

```bash
python3 skills/oxygen-organize-review-export/scripts/run_local_review.py work/<run> \
  --attach-url http://127.0.0.1:<port> --workflow-run-id <run-id>
```

Native Windows PowerShell uses the same attach operation:

```powershell
python .\skills\oxygen-organize-review-export\scripts\run_local_review.py `
  "work\<run>" --attach-url "http://127.0.0.1:<port>" `
  --workflow-run-id "<run-id>"
```

Attach mode verifies ownership of the exact workflow run, imports the project map and source
records, and advances organization in the existing Viewer. Reattach the prepared reviewed run
after privacy-boundary preparation, and reattach again when validated Story metadata changes;
these are idempotent updates to the same canonical runtime, not new Viewers.
When the reattach changes only organization or staged Story metadata, the Viewer preserves the
completed Privacy pass because its reviewed source identity is unchanged. Any source-bearing item
change marks that pass stale and requires Privacy to complete again before Story activation.

For a downstream reviewed-artifact resume or a compatibility-only manual review, the launcher
still accepts a run directly and starts a fresh Viewer:

```bash
python3 skills/oxygen-organize-review-export/scripts/run_local_review.py work/<run>
```

That compatibility path starts after collection and therefore must not be claimed as a complete
progress-first Toolkit run.

On native Windows and Linux/WSL it also verifies Node/npm and the platform-specific dependency
installation, rebuilding incompatible modules with `npm ci`. Windows resolution uses the real
`npm.cmd` command and rejects POSIX-only shims. Every launch receives fresh process-owned D1 state.
Without `--port`, the launcher reserves an OS-selected free `127.0.0.1` port and announces only
the exact port that becomes healthy. Use `--port <number>` when a specific isolated port is
required. An occupied port fails without killing its owner or choosing a fallback port.

## Browser handoff is required

After the Viewer becomes ready:

1. Once ready, proactively open the local Viewer URL without waiting for a follow-up.
2. Tell the user the URL and that no password is required.
3. If automatic opening fails, surface the exact URL clearly.
4. Keep the process alive until the user finishes or asks to stop.

The atomic transition to Stage 5 Review Story is an immediate human handoff, not permission for an
Agent or evaluator to review the Story first. The same Agent must surface the exact URL, state that
there is no password, and pause while the Viewer stays alive. Never fabricate Story edits, Privacy
decisions, preference answers, `All set`, or release state. An unattended run ends at
`WAITING_FOR_HUMAN_STORY_REVIEW`; continue to release/package work only after the contributor
explicitly indicates that review is complete.

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
