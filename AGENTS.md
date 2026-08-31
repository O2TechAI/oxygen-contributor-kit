# Oxygen contributor agent instructions

When a user asks to use the Oxygen Contributor Kit to collect, organize, review, or package project
history, use this file as the initial routing contract:

1. Resolve and verify the contributor-approved target project or input boundary.
2. Before collection, load the organizer Skill and start its sanitized Workflow Progress surface.
   Surface the exact localhost URL and keep one canonical local Viewer/run through the workflow.
3. Keep the final public workflow in this order: Collect, Organize, upstream source Privacy
   preparation as mandatory release authority, Build Project Story with bounded semantic workers,
   independent global sparse
   Insight pass, Story/Release Privacy candidate preparation, Preference-question generation,
   Project Story human review, Privacy Keep/Redact decisions, Preference answers, All set,
   local reviewed release.
4. Load a stage's owning Skill when that stage begins, then open only the specific contracts that
   Skill requires for the current work.

Stage ownership:

- **Target / Collect** — `skills/oxygen-ingest-project-history/SKILL.md`.
- **Organize / Viewer orchestration** — `skills/oxygen-organize-review-export/SKILL.md`.
- **Upstream source Privacy preparation** — `tools/llm_redact/REDACTION_PROMPT.md` and the existing
  reviewed-boundary tooling.
- **Build Project Story, Insight pass, and Story/Release Privacy candidate preparation** —
  delegate to `skills/oxygen-storytelling-review/SKILL.md` only after upstream source Privacy
  establishes the reviewed source authority. The workflow parent selects Story owners from, and
  gives Story and Insight workers, the exact bound raw reviewed narrative through the
  contributor-selected current provider. Source Privacy spans are mandatory for release; they are
  not applied to that narrative before Story authoring.
- **Preference-question generation** —
  `skills/oxygen-elicit-contributor-preferences/SKILL.md` after reusable lessons and generated
  Insight candidates exist, using that same reviewed input without reopening raw history or
  rerunning Privacy. Generated questions are not confirmed preferences.
- **Project Story human review** — the Story Skill; load its review lifecycle only when human
  review begins.
- **Release handoff** — the organizer/export Skill plus canonical release validation.

Repository-development Agents are outside the Toolkit runtime contract. During a normal Toolkit
request, the workflow-owning parent Agent automatically executes every nonempty immutable semantic
shard. Story, Insight, and Story Privacy remain multi-shard lanes. Preference intentionally uses
exactly one global bounded worker because it produces one deduplicated questionnaire authority,
capped at 12 probes by default and 20 maximum; never fan Preference out across multiple workers.
When host subagents are available, the parent dispatches with no more than three live at once; each
subagent reads exactly one generated immutable `inputPath` and writes only its assigned proposal.
Story and Insight inputs carry only the exact bound raw reviewed narrative needed for their assigned
scope through the contributor-selected current provider. The parent alone runs recorders and
finalizers, installs authority, proves exact union and no overlap,
mutates Viewer state, and waits for all terminal receipts. Story is the global boundary: before
Coverage finalization, the parent selects Chapter owners by coherent narrative arc across the
complete exact-bound reviewed semantic projection. It never defaults or mechanically copies
`ownerId` from `unitId`; Chapter count never follows semantic-unit, source, meeting, or prior-run count, and Phase
count never follows Chapter count or semantic kind. Related units may share one owner, multiple
units may form one Chapter, and multiple Chapters may later share one Phase. Finalized Coverage
`ownerId` is then the sole Chapter-ownership source, complete owner bundles never split across
workers, every phase-free proposal is collected and read in full by the parent before any Story
receipt exists, and one batch recorder installs all Story outputs plus exactly one receipt per shard
only after complete editorial and global validation. Other lanes retain their per-shard
atomic output/receipt pairs.

Each shard assignment gets one initial proposal plus at most two automatic proposal-only correction
attempts. `correctionAttemptCount` is assignment-local, counts corrections only, excludes the
initial proposal, and is always `0..2`; never sum it across a multi-shard lane. Every correction
uses the byte-identical immutable input. Every invalid initial or correction attempt leaves both
output and receipt absent. Only a fixed safe pre-receipt authoring-validation code is correctable.
If the second correction fails, stop the lane safely, report correction exhaustion and the last
safe validation code, and do not continue downstream, except for the narrow Story editorial
takeover below. Authority, immutability, containment, path, I/O, infrastructure, and corrupt-state
failures stop immediately and are never correctable.

Story corrections run as at most two lane-wide waves after the initial complete batch attempt. A
proposal-only correction or a Phase-only correction consumes the same Story wave; there is no
separate Phase retry budget. Failed Story waves leave the complete terminal records directory
absent. After successful batch installation every Story output and receipt is immutable.

`PAUSE_FOR_BOUNDED_SEMANTIC_WORKERS` is an internal orchestration boundary. If host subagents are
genuinely unavailable, the parent processes the same assignments serially, reports
`executionMode=serial_capability_limited`, and continues through the identical recorder/finalizer
authority without asking the contributor to create workers. Internal host subagents are not
separate product provider/API calls and require no separate API key. Story workers receive exact
bound raw reviewed narrative only through the contributor-selected current provider and never
receive source outside that reviewed boundary.

Every `story`-lane subagent assignment must convey this ordered contract before dispatch:

1. Read `skills/oxygen-storytelling-review/references/narrative-writing-contract.md` completely.
2. Read `skills/oxygen-storytelling-review/references/story-data-contract.md` completely.
3. Then read exactly the assignment's one generated immutable `inputPath`.
4. Write only that assignment's proposal.

Do not dispatch a Story worker unless its assignment names both required contract paths, its one
actual generated `inputPath`, and its proposal-only write boundary. The worker must not read any
other data input or write a receipt, final artifact, or authority file.

Each Story input is self-contained for writing: it carries complete owner-atomic represented-unit
bundles, exact bound raw reviewed narrative, canonical semantic/Coverage references, and
equality-only actor tokens, with no excluded or outside-boundary narrative, raw actor identity,
Source Privacy rows, or provider metadata. Its validation authority contains no source narrative,
raw actor identity, or source outside the exact reviewed boundary. Workers return phase-free
proposals only. On a subagent-capable host the
parent does not initially write Story prose, People, Evidence choices, titles, overviews, or blocks.
The parent reads every proposed Chapter in full, records the eight-question narrative acceptance
bound to the exact current proposal digest, and rejects any dry, fragmented, mechanical,
incomplete, or record-by-record proposal before Phase or receipt. Each rejected writer proposal
gets a specific proposal-only correction against the byte-identical input. After the initial
proposal plus two rejected subagent corrections, the Ultra parent may complete only that same
still-unrecorded assignment from the byte-identical input through the same canonical phase-free
proposal shape, editorial gate, recorder, and validators. This narrow takeover is not a second
authority, compatibility format, or recorded-output repair. After every proposal passes, the
parent orders Chapters with the production comparator, assigns only the smallest coherent global
Phase IDs and labels, injects canonical Coverage/exclusions, and invokes the complete Story batch recorder.
Insight remains a separate later pass. Static tests prove contracts and authority behavior, not
actual host-subagent spawning; that requires later E2E evidence.

Pause for the contributor at Project Story human review, Privacy Keep/Redact decisions, Preference
answers, `All set`, and release handoff. These explicit review and decision boundaries are the only
contributor pauses. Do not fabricate Story edits, Privacy decisions,
preference answers, `All set`, or release/publication approval. Never widen the approved input
boundary, read credential or browser-profile data, upload automatically, or publish automatically.
`All set`, ZIP creation, download, and publication are separate; keep `publication_approved=false`
unless a separate future publication workflow exists.

Consult `README.md` for public or user-documentation questions. Consult `SOP.md` when a human asks
for the complete process, a stage interface remains unresolved after reading its owning Skill, or a
maintainer is auditing workflow ownership. Neither document is mandatory startup context for a
normal contributor workflow.
