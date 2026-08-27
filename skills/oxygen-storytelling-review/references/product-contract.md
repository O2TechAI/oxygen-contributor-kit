# Product Contract

## Product Outcome

Storytelling Review turns a privacy-prepared reviewed project history into:

```text
Project Story
evidence-linked Chapters
iterative human review
human-confirmed Final Release Memory
local reviewed release
```

The final product identifiers are `oxygen.story`, `oxygen.story:`, `oxygen.story-review-session`, and `oxygen.reviewed-story`. No old product contract, migration path, alias, or historical lane defines current behavior.

Final Release Memory is not publication approval. ZIP creation, HTML export, Download, All set, and release handoff do not change `publication_approved=false`.

## Authority Sequence

The implemented authority sequence is:

```text
reviewed input boundary
-> provider/model drafting outside the launcher
-> `oxygen.story:` candidate rows
-> coverage finalizer output
-> workflow activation POST
-> `oxygen.story-review-session`
-> server reconstruction of `oxygen.reviewed-story`
-> HTML/ZIP from the same release-safe serialized bytes
```

The launcher owns only local Viewer lifecycle and safe workflow events. The server owns activation, source revision, active Story digest, session CAS, and release reconstruction. The browser cannot select a schema, fabricate readiness, or make release state authoritative by itself.

## Required Workflow Order

The public flow is:

```text
Collect
Organize
upstream source Privacy preparation producing the reviewed input boundary
build Project Story using bounded semantic workers
independent global sparse Insight pass
Story/Release Privacy candidate preparation
Preference-question generation
Project Story human review
Privacy Keep/Redact decisions
Preference answers
All set
local reviewed release
```

The Story stage may use conceptual passes inside Build Project Story, but it must not add new public workflow stages or hide human pauses.

## Review Readiness

Opening Project Story for human review requires terminal results for Story generation, the independent global sparse Insight pass, Story/Release Privacy candidate preparation, and Preference-question generation. Completed-zero is a valid terminal result for the Insight and Preference lanes when no warranted Insight or valid question exists.

The composed launcher requires coverage, Story candidates, a deterministic Preference bundle, and
an `oxygen.story-preparation` manifest at `--story-event ready`. It validates the exact four
terminal receipts and imports the unchanged Preference bundle before requesting Review Story.
The Preference producer and preparation finalizer are composition dependencies of this isolated
branch, not local stubs or fallback paths.

Preference questions must be generated before Project Story human review opens by using reusable lessons represented by generated Insight candidates. Generated questions are not confirmed preferences; answers exist only after explicit contributor action.

## Bounded Semantic Workers

Parallel semantic work is Master-owned. The owning Agent prepares deterministic inputs, computes one immutable input digest, assigns explicit semantic unit IDs, and writes byte/content-balanced shard manifests before any worker starts.

The desired worker contract uses separate bounded workers for Story writing, Insight reasoning, Privacy reasoning, and Preference-question reasoning. Each worker returns a receipt naming the input digest, shard ID, unit IDs covered, output path, and terminal status. Exact union coverage, no overlap, no foreign unit IDs, no stale digest, deterministic deduplication, and deterministic composition remain required.

The composed preparation finalizer validates the receipt and activation binding. Do not claim exact
union/no-overlap has been validated by this launcher alone. Revision authority, coverage
finalization, activation, human-pause enforcement, and release reconstruction stay outside worker
scope. No worker may silently expand scope, reopen raw history, repair another lane, or treat
another lane's failure as success.

## Product Boundaries

Reuse the existing repository Viewer and contracts. Do not build a second frontend, second workflow runner, schema adapter, local database repair tool, or provider client inside the launcher.

The required final Viewer must preserve:

- local-only loopback access;
- workflow progress;
- project/source records;
- Project Story Timeline;
- Chapter editor;
- Release Preview;
- Preferences;
- HTML/ZIP download actions;
- publication separation.

Final decision-only Chapter Privacy/Release Preview is **NOT YET IMPLEMENTED** on this base.
Production still exposes obsolete category/delete controls, so clean-room product completion remains
blocked until the required surface and candidate authority exist.

Project-specific Story prose, Privacy excerpts, generated candidates, preference answers, screenshots, and runtime database state remain local run artifacts. They must not be hardcoded in reusable Skill, Viewer, or test source.

## Progress Surface

The workflow-progress surface may display only sanitized operational facts:

- stage/status codes;
- completed/current/next state;
- real counts with known denominators;
- timestamps;
- blocker codes;
- whether human action is required.

It must not display prompts, chain-of-thought, model scratch work, raw tool arguments, provider responses, private messages, Story/Evidence payloads, removed values, or arbitrary free-form private status.

## Story Product Shape

The Project Story is a scan-first table of contents. Each Chapter is durable project memory with enough supported context for a human or future Agent to understand the project change without reopening raw evidence.

Chapters are selected by complete coherent narrative arcs, not by event count, time slice, source document, meeting, importance score, reusable lesson, or target count. Story inclusion is independent of Insight worthiness. Meaningful progress, substantive iterations, failures, corrections, decisions, validation, handoff, and current unresolved state remain eligible when supported.

After Chapters are complete and ordered, adjacent Chapters may be grouped into precise one- or two-word Phases for navigation. Phase never dictates Chapter boundaries.

Generate zero or more Insights only after the complete Story is understood. No Chapter has an Insight quota.

## Visual And Interaction Product

The Project Story and Chapter views keep the existing application shell. The Chapter document uses unnumbered primary sections:

```text
People
Story
Privacy
```

Review status/completion and local Evidence are supporting surfaces. Use typography for reading and bounded boxes for interaction. Do not replace the flow with a dashboard, numbered section markers, fake stepper, standalone Insights page, Release/Original card pair, or project-specific one-off UI.
