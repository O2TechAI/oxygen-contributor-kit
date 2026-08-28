---
name: oxygen-organize-review-export
description: Continue the progress-first local Viewer after deterministic source projection, organize the complete contribution universe into bounded semantic units, identify the dominant project, build the reviewed Story, and export one final ZIP. Use after project histories or meetings have been collected and before any upload or publication decision.
---

# Organize, review, and export

## Organize projects first

Read every projected contribution record in the ingest run. The early deterministic projection
keeps recorded human dialogue, Agent reasoning/dialogue, agent/subagent coordination and findings,
meaningful progress, meetings, feedback, and human-supplied sources. Tool envelopes/results, raw
commands/output, generic execution markers, telemetry, and other mechanics are already absent; do
not recreate or request them. Use the current transport in
[references/project-map-contract.md](references/project-map-contract.md).

On POSIX, create the canonical skeleton and immutable worker handoff:

```bash
python3 skills/oxygen-organize-review-export/scripts/build_project_map.py work/<run> \
  --primary-project "<project>" --summary "<summary>"
python3 skills/oxygen-organize-review-export/scripts/prepare_semantic_units.py \
  work/<run> work/<run>-organization
```

On Windows PowerShell:

```powershell
python .\skills\oxygen-organize-review-export\scripts\build_project_map.py `
  "work\<run>" --primary-project "<project>" --summary "<summary>"
python .\skills\oxygen-organize-review-export\scripts\prepare_semantic_units.py `
  "work\<run>" "work\<run>-organization"
```

Preparation validates only current ingest projections and the exact current skeleton. If a
projection is absent or an old project map is present, stop and re-collect through current ingest;
never read or upgrade a historical map. The command ends with the exact internal handoff marker
`PAUSE_FOR_BOUNDED_SEMANTIC_WORKERS`. This is an internal orchestration boundary, not a human-review
pause and not a request for the contributor to create workers.

1. Find topic changes both within a conversation and across conversations.
2. Group events by the actual product, repository, or workstream being discussed.
3. Choose `primary_project` by sustained user intent, substantive turns, artifacts, and
   continuity over time—not merely by the most repeated token.
4. Group the complete filtered contribution universe into semantic units by meaning, not by
   filename, session, timestamp, record count, or future Chapter shape.
5. Give every contribution record exactly one unit owner. Use a bounded `routine` unit when
   semantic narration is retained but later may be explicitly dispositioned as non-narrative.
6. Finalize the manifest provider-free so exact disjoint membership and digests are proved before
   the Viewer accepts Organization as complete.

## Semantic unit is the authority of organization

- A trajectory is source provenance, not a semantic boundary.
- A unit may span trajectories when the recorded meaning belongs to one episode.
- Every filtered contribution belongs to exactly one unit; omission is never an exclusion signal.
- Exact member IDs remain in the local manifest and server tables. Story receives only stable unit
  IDs, revisions, counts, digests, kind, and an optional privacy-safe projection.
- Keep chronology, causal continuity, ordinary setup that later matters, failures, corrections,
  decisions, validation, handoffs, and current unresolved state. Do not discard recorded semantic
  narration merely because its raw family was Agent reasoning, delegation, or status/progress.
- Do not create one unit per raw record, one unit per session, or a second coverage ledger.
- Use progressive exact Evidence access by unit when Story needs member bodies.

The workflow-owning parent automatically enumerates every manifest shard. When host subagents are
available, it must dispatch them in waves of at most three live subagents. Each assignment reads
exactly one Privacy-safe immutable `inputs/<shard-id>.json` and writes only its strict proposal
array at `handoffs/<shard-id>.proposals.json`. Workers never write receipts, final manifests,
SQLite, Viewer APIs, revisions, activation state, release state, or publication state. Internal
host subagents are not product provider/API calls, need no separate API key, and receive no
raw/private source beyond that bounded input. Silently performing all semantic reasoning in the
parent while subagents are available is invalid.

If the host genuinely lacks subagent capability, the parent processes the same immutable shards
serially, reports `executionMode=serial_capability_limited`, and continues without asking the
contributor to create workers. This uses the identical recorder and finalizer authority and is not
a fallback contract. In either execution mode, the parent exclusively invokes recorders, installs
immutable output/receipt pairs, checks exact union and no overlap, waits for every terminal receipt,
finalizes authority, and performs later Viewer mutations.

Each proposal requires `unitId`, `kind`, and the shard's UTF-8-ordered `contributionIds`.
`kind` is an open machine label matching exactly `^[a-z][a-z0-9_]{0,63}$`; labels such as
`direction_change`, `root_cause`, and domain-specific lower-snake-case values need no product-code
registration. Never map an unrecognized label to a fallback. The reserved `duplicate` kind alone
permits `duplicateOfUnitId`, which must name one direct non-duplicate unit. The reserved `routine`
kind alone can later authorize the `routine_non_narrative` Coverage disposition.

Record each terminal worker result without hand-editing generated authority:

```bash
python3 skills/oxygen-organize-review-export/scripts/record_semantic_worker.py \
  work/<run>-organization <shard-id> \
  work/<run>-organization/handoffs/<shard-id>.proposals.json
```

```powershell
python .\skills\oxygen-organize-review-export\scripts\record_semantic_worker.py `
  "work\<run>-organization" "<shard-id>" `
  "work\<run>-organization\handoffs\<shard-id>.proposals.json"
```

A recorder validation failure is pre-receipt authoring feedback only when both
`outputs/<shard-id>.json` and `receipts/<shard-id>.json` are absent. The parent automatically
returns only the fixed safe validation code as authoring feedback through a bounded correction loop;
the assigned worker may replace only its non-authoritative handoff proposal against the byte-identical
immutable shard input. This is not a contributor pause. The recorder never rewrites, maps, or
repairs a proposal, and the loop may never replace durable output. Once an output or receipt exists,
that durable authority is immutable; a differing resubmission fails closed and must not replace or
repair either artifact.

Workers may use the same stable `unitId` across shards. The deterministic composition stage merges
those proposals, rejects conflicting metadata, and proves the exact global union. After every
receipt is complete, finalize and install atomically:

```bash
python3 skills/oxygen-organize-review-export/scripts/finalize_semantic_units.py \
  work/<run> work/<run>-organization
```

```powershell
python .\skills\oxygen-organize-review-export\scripts\finalize_semantic_units.py `
  "work\<run>" "work\<run>-organization"
```

The finalizer rejects missing, foreign, duplicate, stale, overlapping, or tampered worker
authority before replacing `project-map.json`. The existing project-map builder remains the sole
digest and revision authority. The optional Story-facing unit projection is one privacy-safe label
and summary, not a substitute for exact local membership.

For later E2E evidence, report `executionMode`, `lane`, `shardCount`, `spawnedSubagentCount`,
`maxConcurrentSubagents`, `correctionAttemptCount`, and `terminalReceiptCount` from observed parent
execution. Do not infer these values from manifest size alone.

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
that same process-owned Viewer state:

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

Attach mode verifies ownership of the exact workflow run, requires a finalized semantic manifest,
imports the project map and source records, and atomically publishes Organization authority in the
existing Viewer. Reattach the prepared reviewed run
after privacy-boundary preparation, and reattach again when validated Story metadata changes;
these are idempotent updates to the same canonical runtime, not new Viewers.
When the reattach changes only organization or staged Story metadata, the Viewer preserves the
completed Privacy pass because its reviewed source identity is unchanged. Any source-bearing item
change marks that pass stale and requires Privacy to complete again before Story activation.

For a downstream reviewed-artifact resume that already satisfies the same canonical plural
meeting contract, the launcher accepts the run directly and starts a fresh Viewer:

```bash
python3 skills/oxygen-organize-review-export/scripts/run_local_review.py work/<run>
```

Direct resume starts after collection and therefore must not be claimed as a complete
progress-first Toolkit run or as an alternate input contract.

On native Windows and Linux/WSL it also verifies Node/npm and the platform-specific dependency
installation, rebuilding incompatible modules with `npm ci`. Windows resolution uses the real
`npm.cmd` command and rejects POSIX-only shims. Every official launcher invocation uses native Next
and receives one fresh process-owned temporary local SQLite database. The Viewer owns cleanup when
it stops; there is no online deployment path.
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

- Confirm every projected contribution has exactly one semantic-unit owner.
- Confirm the selected main project reflects sustained user intent.
- Reject missing, double-owned, foreign, duplicated, or stale membership.
- Inspect units progressively against exact Evidence; do not expose the full member ledger to Story.
- Never treat organization as publication approval.

## Export

Use **Download ZIP** to create `oxygen-contribution.zip`, then inspect its member list. It must
contain `manifest.json`, normalized documents and events, `project-map.json`, and the offline
HTML review file. The exporter must apply every active AI-redaction span, omit original event
envelopes, include a safe aggregate redaction summary, and block when the model pass is incomplete
or has rejected spans. The temporary local SQLite database is runtime state and must not enter the
HTML or ZIP. Preserve `publication_approved=false`.

Read [references/data-contract.md](references/data-contract.md) when the ingest directory is
unrecognized or a new source format needs adapting.
