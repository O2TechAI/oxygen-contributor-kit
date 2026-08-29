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
-> finalized current coverage authority
-> public deterministic owner-atomic Story input preparation
-> complete phase-free Story proposal set
-> parent full-prose editorial acceptance bound to every exact proposal digest
-> parent production ordering and one global Phase assignment
-> one globally validated atomic Story batch
-> public deterministic Insight input preparation
-> recorded bounded Insight result and composed `oxygen.story:` candidate rows
-> recorded Story Privacy result and exact Preference producer bundle
-> preparation finalizer output
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
The tracked Story preparer and recorder create immutable worker inputs and atomic terminal
output/receipt pairs. The existing Preference producer remains the sole nine-field bundle
authority; the Preference recorder binds its exact output.

Preference questions must be generated before Project Story human review opens by using reusable lessons represented by generated Insight candidates. Generated questions are not confirmed preferences; answers exist only after explicit contributor action.

## Bounded Semantic Workers

Semantic work is Master-owned. The owning Agent runs the public preparer before any worker starts;
it computes immutable input digests, assigns the exact current identities, and installs the bounded
worker input and shard manifest together.

Before Coverage finalization, the parent establishes one global Chapter-owner skeleton by coherent
narrative arc across the complete Privacy-safe semantic projection. It never defaults or
mechanically copies `ownerId` from `unitId`; no semantic-unit, source-document, meeting, prior-run,
Chapter, Phase, block, Insight, or Evidence count is golden. Related units may share one owner, one
Chapter may represent multiple units, and multiple Chapters may later share one Phase. Finalized
Coverage `ownerId` is then the sole Story Chapter-ownership source. Every represented unit for one
owner stays in one indivisible byte-balanced owner bundle; one owner never spans workers and a
shard may contain multiple owners. The public worker contract uses separate dependent passes for Story writing and Insight reasoning,
then sibling Story Privacy and Preference-question passes. Story, Insight, and Story Privacy remain
multi-shard. Preference intentionally uses exactly one global bounded worker because it produces
one deduplicated questionnaire authority, capped at 12 probes by default and 20 maximum. Workers
write only lane proposals. The recorder validates each proposal against the frozen lane, shard, input digest, and assigned
identities. Each Story input is self-contained with its complete represented units, Privacy-reviewed
narrative, canonical references, and equality-only actor tokens; it has no excluded narrative, raw
identity, Source Privacy rows, pre-redaction content, or provider metadata. Story workers return
phase-free proposals and never author schema, keys, Phase, Coverage, exclusions, receipts, or
authority. On a subagent-capable host the parent does not initially write Story prose or choose
People or Evidence. It reads every proposal in full, records all eight narrative decisions against
that exact proposal digest, and rejects negative, missing, stale, or foreign editorial review before
Phase and receipt. After every proposal is accepted, the parent orders Chapters with the production
comparator, assigns only the smallest coherent global Phase IDs and labels, injects canonical
Coverage/exclusions, and the one Story batch recorder directly calls the unchanged Viewer
`validateStorySourcePackage` on the complete package.
It installs every output and exactly one receipt per shard with one atomic records-directory rename.
Exact union, no
overlap, no foreign identities, no stale digest, deterministic deduplication, and deterministic
composition are executable checks.

Each assignment gets one initial proposal plus at most two automatic proposal-only correction
attempts. `correctionAttemptCount` is assignment-local, counts corrections only, excludes the
initial proposal, and is always `0..2`. Every correction uses the byte-identical immutable input;
an invalid initial or correction attempt creates neither output nor receipt. Only a fixed safe
pre-receipt authoring-validation code is correctable. If the second correction fails, the lane
stops safely, reports correction exhaustion and the last safe validation code, and does not
continue downstream, except that after two Story corrections are rejected specifically for
editorial quality, the Ultra parent may complete the same still-unrecorded assignment from the
byte-identical input through the same canonical phase-free proposal shape, editorial gate,
recorder, and validators. This is not a fallback format or a second authority. Authority,
immutability, containment, path, I/O, infrastructure, and corrupt-state failures stop immediately
and are never correctable.

Story uses the same bound as at most two lane-wide correction waves after the initial complete
batch. Proposal-only and Phase-only corrections consume that one budget. Every failed wave leaves
all Story outputs and receipts absent. After success, outputs and receipts are immutable. Insight
remains a separate later pass. Actual subagent spawning is proved only by later E2E evidence, not by
static tests.

Each Insight worker receives only its assigned frozen Story candidates, their Story blocks and
Evidence references, the minimum Privacy-reviewed narrative rows those blocks reference, and the
existing validation-authority reference. It receives no raw/pre-redaction source, Source Privacy
rows, unrelated Chapter or trajectory narrative, private actor identity, or provider metadata.
`anchorStoryBlockId` controls placement only. `quote.text` is one exact current Privacy-reviewed
trajectory substring bound to `quote.evidence`, and that Evidence must support the anchored block.
Invalid anchors, quote/anchor mismatch, modified or Story-derived paraphrase, foreign/stale/private
Evidence, and unavailable current reviewed narrative fail before output or receipt and again in the
finalizer and server-owned activation path. Completed-zero is valid.

The composed preparation finalizer independently revalidates the frozen inputs, receipts, output
digests, exact union, lane dependency digests, final Story composition, the same complete shared
Story validation, Preference bundle, and
activation binding. Revision authority, coverage
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

Final decision-only Chapter Privacy/Release Preview is implemented in the canonical Viewer. Current
candidate authority may be completed-empty or contain decision candidates; unresolved candidates
and stale authority fail closed before final release confirmation or export.

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

Each AI Insight card appears beside its one `anchorStoryBlockId` passage and displays its exact safe
source `quote.text`; it never reconstructs Quote from Story prose. On narrow screens the card follows
its anchored paragraph in DOM order. AI source Quote and anchor remain read-only in the editor while
explanatory fields may be reviewed. Human-created Insight keeps its separate exact user-selected
Story-substring Quote origin and lifecycle. Release HTML and ZIP preserve the same placement and
safe Quote while stripping anchors, Evidence IDs, Privacy authority, CAS data, and review metadata.

## Visual And Interaction Product

The Project Story and Chapter views keep the existing application shell. The Chapter document uses unnumbered primary sections:

```text
People
Story
Privacy
```

Review status/completion and local Evidence are supporting surfaces. Use typography for reading and bounded boxes for interaction. Do not replace the flow with a dashboard, numbered section markers, fake stepper, standalone Insights page, Release/Original card pair, or project-specific one-off UI.
