# Product Contract

## Product Outcome

Storytelling Review turns a reviewed project history with upstream Source Privacy release
authority into:

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
Story/Release Privacy total proposal preparation
Preference-question generation
Project Story human review
Privacy target choices
Preference answers
All set
local reviewed release
```

The Story stage may use conceptual passes inside Build Project Story, but it must not add new public workflow stages or hide human pauses.

## Review Readiness

Opening Project Story for human review requires terminal results for Story generation, the independent global sparse Insight pass, Story/Release Privacy total proposal preparation, and Preference-question generation. Completed-zero is a valid terminal result for the Insight and Preference lanes when no warranted Insight or valid question exists.

The composed launcher requires coverage, Story candidates, a deterministic Preference bundle, and
an `oxygen.story-preparation` manifest at `--story-event ready`. It validates the exact four
terminal receipts and imports the unchanged Preference bundle before requesting Review Story.
The tracked Story preparer and recorder create immutable worker inputs and atomic terminal
output/receipt pairs. The existing Preference producer remains the sole nine-field bundle
authority; the Preference recorder binds its exact output.

Preference questions must be generated before Project Story human review opens by using reusable lessons represented by generated Insight candidates. Generated questions are not confirmed preferences; answers exist only after explicit contributor action.

## Bounded Semantic Workers

The parent owns global Chapter selection, full-prose editorial acceptance, Phase assignment,
recording, exact union/no overlap, activation, and human handoff. Workers author only bounded
lane proposals from their exact immutable inputs. Story owners remain atomic, and Story inclusion
never depends on Insight worthiness. Story, Insight, and Story Privacy are multi-shard lanes;
Preference is exactly one global bounded questionnaire worker with 12 probes by default and 20 maximum.

[Story preparation transport](story-preparation-transport.md#dispatch-and-recording) owns dispatch,
correction limits, the narrow pre-receipt Story takeover, atomic installation, and finalization.
Its [worker reading routes](story-preparation-transport.md#worker-reading-routes) define the exact
role-specific authoring contracts. [Narrative acceptance](narrative-writing-contract.md#parent-editorial-acceptance)
owns the eight parent semantic decisions. No worker may expand scope, reopen raw history, repair
another lane, or treat missing, foreign, stale, or invalid authority as success.

## Product Boundaries

Reuse the existing repository Viewer and contracts. Do not build a second frontend, second workflow runner, schema adapter, local database repair tool, or provider client inside the launcher.

The contributor-selected current coding Agent/model provider may process raw or private project
material during Organization and Story authoring. Oxygen must not silently switch providers or send
Privacy-derived data to a second endpoint. The localhost Viewer, working artifacts, and final
package flow do not automatically upload or publish data. Final package reconstruction is
provider-free; that does not make the entire workflow provider-free or guarantee that raw/private
material stays on the machine.

The hard Privacy boundary is the exact contributor-reviewed final export bytes. Detection and
anonymization are best effort, final human review is mandatory, and the detailed release rules live
in `privacy-evidence-boundary.md`.

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

Chapter Privacy/Release Preview is implemented in the canonical Viewer. Current target-choice
authority may be completed-empty or contain candidate metadata and release targets; missing target
choices and stale authority fail closed before final release confirmation or export.

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

Each AI Insight card appears beside its one `anchorStoryBlockId` passage and locally displays its
exact bound reviewed source `quote.text`; it never reconstructs Quote from Story prose. The local
Quote may contain exact bound raw source text. On narrow screens the card follows its anchored
paragraph in DOM order. AI source Quote and anchor remain read-only in the editor while
explanatory fields may be reviewed. Human-created Insight keeps its separate exact user-selected
Story-substring Quote origin and lifecycle. Release HTML and ZIP preserve the same placement and
the contributor-selected Story Privacy release bytes while stripping anchors, Evidence IDs,
Privacy authority, CAS data, and review metadata.

## Visual And Interaction Product

The Project Story and Chapter views keep the existing application shell. The Chapter document uses unnumbered primary sections:

```text
People
Story
Privacy
```

Review status/completion and local Evidence are supporting surfaces. Use typography for reading and bounded boxes for interaction. Do not replace the flow with a dashboard, numbered section markers, fake stepper, standalone Insights page, Release/Original card pair, or project-specific one-off UI.
