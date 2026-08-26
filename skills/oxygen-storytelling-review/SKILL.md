---
name: oxygen-storytelling-review
description: Continue an already-reviewed project history through Oxygen's canonical evidence-grounded Project Story and iterative Chapter review, with optional non-blocking localization. Use after organization and privacy preparation; reuse the repository Viewer/runtime rather than creating an independent frontend. Do not collect raw history, rerun redaction, or approve publication.
---

# Oxygen Storytelling Review

Use Oxygen's canonical local Storytelling Review capability to turn a reviewed project history into:

```text
Project Story
→ evidence-linked Chapters
→ iterative human-AI review
→ human-confirmed Final Release Memory
```

The input is reviewed history, never unrestricted raw history. The output is a human-confirmed release representation, never publication approval.

## Progressive reference loading

Read each routed reference completely before the corresponding work. Do not treat all eight as an
ordinary Build Project Story prerequisite.

| Stage or condition | Load | Critical boundary |
|---|---|---|
| **Build Project Story — always** | [product-contract.md](references/product-contract.md), [story-data-contract.md](references/story-data-contract.md), [privacy-evidence-boundary.md](references/privacy-evidence-boundary.md), and [narrative-writing-contract.md](references/narrative-writing-contract.md) | Input is privacy-prepared reviewed history; output is one complete validated `oxygen.story/3` source candidate. Missing product, schema, Privacy/Evidence, or context-complete writing support keeps Build active. Deterministic source readiness permits atomic workflow activation; it is not human review completion or release authority. |
| **Human Review begins** | [chapter-review-lifecycle.md](references/chapter-review-lifecycle.md) | Load when `ready_for_human_review` is reached and the human begins review/editing or asks for Story review assistance. Runtime review state and editor safety remain authoritative. |
| **Human Review or review-UI work** | [ui-interaction-contract.md](references/ui-interaction-contract.md) | Load when Human Review begins or when diagnosing, auditing, or implementing review UI. The canonical Viewer remains the only review interface. |
| **Localization requested or present** | [bilingual-contract.md](references/bilingual-contract.md) | Load before creating, validating, refreshing, omitting, inspecting, or releasing localized Story or review state when the user requests localization or a sidecar exists. English remains canonical; missing Chinese is nonblocking. |
| **QA, clean-room, or submission/release gate** | [validation-checklist.md](references/validation-checklist.md) | Load for final Story conformance, clean-room reproduction, submission/release gating, Storytelling implementation audit, or failed completion-gate diagnosis. The clean-room completion requirement remains mandatory. |

## Non-negotiable boundaries

- Work only from a reviewed contribution artifact and explicitly permitted local Story data.
- Keep `publication_approved=false` unless a separate user instruction explicitly approves publication. Apply review, All set, Final Release Memory, ZIP creation, and download are not publication.
- Never inspect or reopen raw private histories, removed redaction findings, private review ledgers, credential material, source envelopes, or original secrets to improve the Story.
- Never reconstruct removed content, fabricate evidence, fabricate identities, invent quotes, or rewrite uncertainty into hindsight certainty.
- Preserve exact source event IDs, chronology, original evidence language, and the existing Release preview/Preferences/package behavior.
- Keep project-specific Story copy and private/local presentation data outside reusable Skill and generic frontend source.

If the reviewed artifact lacks information needed for a richer Story, remain conservative and disclose the limit.

## Canonical Toolkit boundary

Inside this repository, reuse the canonical live versioned workflow:

```text
reviewed project data
→ generated `oxygen.story/3` metadata (`viewer/lib/timeline.ts`)
→ deterministic source readiness (`viewer/lib/story-readiness.ts`)
→ atomic workflow activation
→ `oxygen.story-review-session/2`
→ successor Viewer review (`SuccessorStoryChapterEditor`)
→ server-owned `oxygen.reviewed-story/2` release
```

Generate project-specific Story data against those existing entrypoints. Do not add a second app,
generation framework, compatibility adapter, project-bound page, or direct import of local Story
copy. The canonical `/3` path uses session `/2`, the successor Viewer, and reviewed-story `/2`.
The compatibility path remains `oxygen.story-highlight/2` → session `/1` → reviewed-story `/1`;
historical `oxygen.story-milestone/1` remains non-reviewable compatibility only.

Workflow callers should delegate here automatically after organization and privacy preparation;
the contributor should not need to know this Skill's name. A candidate remains inactive while
generation or deterministic source readiness is incomplete. Once the complete candidate passes the
existing atomic activation gate, the workflow enters human review; generation alone never confirms
the Story or authorizes release.

## End-to-end workflow

### 1. Establish the reviewed boundary

Read repository instructions and existing Viewer contracts. Inspect the reviewed archive without opening disallowed sources. Fail closed on unsafe member paths, count/manifest mismatches, non-false publication state, or evidence that cannot be resolved.

Do not rerun collection or privacy redaction unless separately requested and authorized.

### 2. Distill the Project Story

Before generating any Story candidate, persist the Build Project Story state in the already-running
Viewer:

```bash
python3 skills/oxygen-organize-review-export/scripts/run_local_review.py \
  --attach-url <viewer-url> --workflow-run-id <run-id> --story-event started
```

Keep the full-screen Workflow Progress surface active. Generate into project-local staged data;
never treat partially written Phases, milestones, or Chapters as the active Project Story. Optional
real subprogress may use `--story-event progress --story-completed <n> --story-total <n>` only when
the denominator is known.

Use this Story-first semantic order inside the existing Build Project Story stage:

1. understand the complete approved project history;
2. determine coherent Chapter narrative arcs;
3. write the complete ordered Chapter and Project Story narrative;
4. verify continuity, chronology, attribution, Evidence, causal restraint, Privacy, and uncertainty;
5. group adjacent Chapters into precise one- or two-word Phases;
6. only after the complete Story is understood, identify independently warranted learning moments;
7. produce zero or more Insights.

These are conceptual passes, not new top-level workflow stages. Story inclusion is independent of
Insight worthiness.

Determine Chapters across the full set of meaningful project developments. A complete coherent
narrative arc owns each boundary. Decisions and direction changes are two eligible categories among
several. Eligible arcs include the supported beginning, problem discovery, a baseline, durable
progress or capability, a substantive iteration that changed quality, coverage, or understanding,
a surprising result, failure or diagnostic case that affected later work, root cause, decision,
direction or architecture change, quantitative result, validation, recovery, freeze, handoff, and
current state. Keep separate Chapters when each establishes a distinct durable state that a future
reader needs. Combine events only when they form one connected causal arc. Deduplicate
repeated discussion and omit execution/status noise that adds no new result, constraint, or
understanding. Keep Chapters chronological and never select to satisfy a fixed count.

A transcript, meeting, file, source document, event count, fixed time slice, Insight count,
importance score, Highlight worthiness, or reusable lesson does not define a Chapter. A Chapter does
not universally require drama, tension, a breakthrough, a universal problem/final-action/result
template, or a separate final `current_state` Chapter.

Build one coherent, evidence-grounded Story of why the project began, what changed, what surprised
people, where work failed, what decision followed, and where the project now stands. Within a
Chapter, brevity is never a selection, generation, revision, or validation objective. Retain every
reviewed-Evidence-supported unit that materially explains the arc's background, causal or temporal
relationship, participant interaction, judgment, failed attempt, progress or iteration, result, or
open state. Do not omit supported Story merely because it yields no Insight.

Apply the canonical context-retention and voice rules in
[product-contract.md](references/product-contract.md) and the evidence-driven roles in
[narrative-writing-contract.md](references/narrative-writing-contract.md): consider the complete reviewed history at
the approved boundary, then write a concise 2–3 sentence project arc and context-complete causal
Chapter prose. Determine Chapter length from the reviewed
Evidence needed to reconstruct the meaningful change. Do not apply a global word, paragraph, or
sentence maximum. A Chapter may use several substantial paragraphs when needed to preserve the
participants, starting position, alternatives, objections, corrections, failures, directional
Evidence, decision, action, outcome, and uncertainty. Omit only duplicated or routine material that
contributes none of those meanings, material outside the current Chapter arc, and content
withheld by Privacy. Readability may reorganize retained context but may not delete it. Never add
hidden model reasoning or unsupported causality.

Write a distinct, localized Chapter overview beneath each title. It is a short summary of that
Chapter's supported background, consequential participant turn or judgment, and result or open
boundary. It is never a navigation instruction such as `Open the Chapter…`, and two Chapters may
not reuse the same boilerplate. Bind its factual claims to Chapter Evidence. Use concrete nouns,
active verbs, specific constraints, and varied sentence rhythm so the preview and full Chapter feel
lively and engaging. Engagement never authorizes jokes, invented color, dialogue, emotion, motive,
metaphor, anthropomorphism, or unsupported causality.

Integrate People into the Decision process with evidence-supported actions. Show which safe role
raised or framed the issue, which role acted, and which role questioned, corrected, approved, or
responded when the reviewed record contains those turns. Preserve the action → response → revision
or result sequence across paragraphs without converting the Chapter into a transcript. Do not
manufacture an objection, reply, consensus, or second actor when Evidence contains none. Every
Chapter requires at least one supported Person or actor. Avoid
generic `the team` wording when a supported functional role is available.

Determine the actual supported relationship before choosing its wording. Express that relationship
with the most natural sentence construction; a connective adverb is optional. Sequence, cause,
response, contrast, correction, evidence, uncertainty, and continuation require different
Evidence. The examples in [narrative-writing-contract.md](references/narrative-writing-contract.md)
are an open vocabulary, not an allowlist. Do not require a transition word in every sentence or
paragraph, force lexical novelty, or substitute one stock connector for another. Prefer clear
syntax, explicit roles, and direct verbs. Never claim a stronger relationship than Evidence supports.

Before accepting the Chapter set, perform a narrative-coverage audit. Confirm that the selected
Chapters retain supported progress, substantive iterations, and failures as well as judgment
moments. When reviewed evidence contains the initiating problem, goal, or baseline assumptions,
the opening Chapter/overview must establish that supported beginning. A midstream command,
import-path, test-collection, or other routine setup failure cannot replace that orientation. Keep an
operational incident when it produced a durable diagnostic result, recovery rule, contract,
capability, architecture, evaluation boundary, or direction change.

### 3. Generate project-local `oxygen.story/3` data

Create stable Chapter, Phase, Person, Story-block, Insight, and Evidence identities using
[story-data-contract.md](references/story-data-contract.md). Generate English as the canonical Story
and source-readiness surface. Chinese is an optional localized sidecar, never an activation
requirement. When generated, keep it natural and preserve shared safe identities; discard an unsafe
sidecar without rejecting English. Keep Evidence IDs and source text language-independent.

Attach Story metadata to reviewed Evidence without replacing source content. Validate source hash,
chronology, unique keys, canonical English structure, any present localized sidecar's safe identity
boundary, and exact Evidence resolution. Do not require a separately typed final current-state
Chapter.

Establish the project context and functional role table before writing Chapters. For every selected
human, user, Agent, reviewer, speaker, owner, or operator action, generate a neutral release-safe
Person with reviewed Evidence references. Preserve role uncertainty and never infer a name,
employer, title, identity, or relationship. If no participant can be supported, keep the event in
Timeline or Exact Evidence and do not generate or activate a Chapter. Routine machine-only events
cannot stand alone; they may support a Chapter only when reviewed Evidence also identifies an actor
who diagnosed, decided, executed, reviewed, approved, or responded.

At generation time, write every primary, supporting, and Person Evidence `eventId` as the exact
fully qualified imported item ID. A bare event suffix is ineligible even when it currently resolves
once. Reject that candidate before staging. Regeneration after ambiguity wastes completed work.

The candidate is source-ready only when its English Project Summary is complete; every Chapter
is one complete coherent arc with nonempty supported People and Story blocks; adjacent Chapters are
grouped into precise one- or two-word Phases; Evidence and Privacy structures resolve; every allowed
Evidence input is represented or uses one fixed safe exclusion reason; and no placeholder, fallback
Chapter, partial job, or validation debt remains. Missing, incomplete, or stale Chinese never blocks
the English candidate. Do not require a fixed number of Phases, Chapters, or Insights.

Only after the complete Story is understood, generate zero or more independently warranted
Insights. Every existing Insight contains exactly Background, Quote, Directly Acquired Experience,
and Principle. Quote uses safe reviewed Story-block anchors with internal Evidence support and never
copies raw/private Evidence. Directly Acquired Experience remains bounded to the actual project
moment. Principle may abstract only for a genuinely similar future condition and may not introduce
unsupported industry prior. Insight title is optional presentation metadata.

Before declaring source readiness, validate that every Chapter remains complete without an Insight,
every Person and Story block is Evidence-supported, Phase grouping follows already-determined
adjacent Chapters, Insight cardinality is `0..n` without a quota, and chronology, attribution,
failure retention, causal restraint, uncertainty, Privacy, and non-fabrication remain intact. If any
check fails, keep Build Project Story active and improve the staged candidate or disclose the
Evidence limitation.

Passage assistance is not a `/3` generation or readiness requirement. If present, it is optional,
local, human-facing, non-authoritative, does not create an Insight, does not require a per-block
lesson, and remains excluded from reviewed release.

After the complete `/3` candidate passes deterministic source readiness, request the existing atomic
workflow activation:

```bash
python3 skills/oxygen-organize-review-export/scripts/run_local_review.py \
  --attach-url <viewer-url> --workflow-run-id <run-id> --story-event ready
```

Activation must revalidate the exact homogeneous source package, source revision, and digest before
entering Review Story. The live `/3` path creates or hydrates `oxygen.story-review-session/2`, opens
the successor Viewer, and later reconstructs `oxygen.reviewed-story/2` server-side only after human
review completion. Source readiness is not Accept/Reject resolution, All set, Final Release Memory,
download authority, or publication approval.

### 4. Enter the live Project Story boundary

Retain the existing application shell. The live Timeline remains the
narrative table of contents with project/source navigation, Phase presentation, direct Chapter
actions, Release preview, and Preferences. An incomplete or invalid `/3` source must not appear
there; an atomically activated ready `/3` source is the canonical Story workflow.

Reuse the existing centered loading treatment as the workflow-progress surface. Derive its stages
from the contributor workflow and show completed/current/next, waiting/blocked state, real
denominator-based progress when available, and human-action state. Persist operational progress in
existing workflow data so refresh can hydrate it; do not invent percentages or expose reasoning,
prompts, raw tool arguments, private messages, Story/Evidence payloads, or removed content. Keep a
quiet shell action for reopening the status.

The homepage-facing successor content preserves this conceptual hierarchy without a UI redesign:

```text
project identity + concise overview
→ Chapter / Phase / source orientation
→ narrative Phase
→ dated Chapter
→ short Before → After transition
→ high-signal keyword / metric chips
→ Read Chapter
```

Phases continue to group adjacent Chapters for homepage and Timeline navigation. Generation supplies
precise Phase membership and labels after Chapter boundaries are complete; it does not use Phase,
Insight presence, or ranking to dictate Chapter boundaries. Keep Timeline copy concise when a later
activation lane consumes it, while complete narrative prose remains in the Chapter.

When a Chapter opens, retain the left rail. Use an independently scrollable bounded Chapter selector with the active Chapter visible and Source records below. Preserve:

```text
Project Story → Chapter → Local Evidence
```

Each level has its own conventional Back route and useful context restoration.

### 5. Use the canonical Chapter document editor

Use unnumbered headings and this primary order:

```text
People
Story
Privacy
Review status / completion
```

Insights, when present, remain restrained Story-grounded interpretations. Do not create a standalone
Insights section, a wizard, numbered section markers, a Release/Original card pair, or a dashboard
of schema fields.

Default to a clean read mode. A compact accessible pencil/Edit control enters a visually contained
Story Edit Mode. Direct typing, caret insertion, selection replacement/deletion, and safe plain-text
paste are the primary interaction, but every mutation must become a controlled block-local review
transaction; never let uncontrolled `contenteditable` or browser-native history bypass the review
state. Expose synchronized Undo/Redo and readable margin notes with pending Discard and applied
Revert-in-a-new-revision. Do not add a second text-selection action toolbar: native selection is
used directly for replacement or deletion inside Story Edit Mode.
Treat `beforeinput` as optional metadata: type-check unknown event fields, derive one minimal
previous/next-text mutation when metadata is incomplete, deduplicate `beforeinput` + `change`, and
commit IME composition only after its stable result.
On narrow screens, fold notes into compact block-associated surfaces without reducing Story width.

For `/3`, passage assistance, if present, is optional, local, human-facing, non-authoritative, and
never Story readiness or Review Session completion. It does not require why-it-mattered,
what-was-learned, or reusable-lesson copy for every block, never creates an Insight, and never enters
reviewed release.

In the live `/3` Viewer, zero, one, or multiple independently warranted Insights are handled by the
successor review contract. Each Insight contains
Background, Quote, Directly Acquired Experience, and Principle; title is optional presentation
metadata. Do not route `/3` through the compatibility single-Insight fallback.

Follow the rule:

> Typography for reading. Boxes for interaction.

### 6. Preserve direct edits and compatible Story annotations

Direct edits store Chapter/story key, stable block, language, base revision, operation, before/after
text and ranges, pending/applied/reverted/needs-evidence state, evidence references when required,
and applied revision. Bind every transaction to the primitive owning Chapter key and reject a
cross-Chapter ledger at Apply, confirmation, and release. Coalesce a contiguous typing burst rather
than recording each character. Undo targets the most recently changed pending transaction, not
merely the last-created array entry. Undo/Redo changes the pending transaction state and working
draft together; it never rewrites an applied revision. Discard removes one pending effect while
keeping unrelated edits. Reversing an applied edit creates a distinct exact-inverse pending
transaction; never coalesce it with other work or let its evidence exemption clear an unrelated
addition. New standalone factual claims retain the reviewed-evidence gate. If safe cross-block
mutation is unavailable, reject it visibly and preserve all text.

Do not open Delete / Revise / Add windows when Story text is selected. The controlled editor already
supports those mutations directly and records them as transactions. If an existing imported review
contains legacy exact-range annotations, validate and render them without broadening their range;
pending legacy entries may retain their safe cancellation path. Exact evidence is never editable,
annotatable, or mutated.

### 7. Preserve iterative review

The lifecycle is repeatable:

```text
initial AI draft
→ human direct edits and/or compatible legacy review records
→ Apply review
→ revised draft
→ human directly reviews and may edit again
→ Apply review again
→ ...
→ All set
```

Apply review is never finalization. Revised text remains directly editable. Legacy Delete/Revise/Add
annotations are compatibility records, not the primary current interaction. Human instructions are
authoritative, but unsupported factual additions must be flagged rather than fabricated. Preserve
revision provenance.

Only All set creates human-confirmed Final Release Memory in an activated compatible runtime. For
the live `/3` path, every existing AI Insight must resolve independently through explicit
review of the currently presented version; zero Insights creates zero Insight-review obligations.
Privacy, Evidence, pending edits, provenance, localization debt, Reopen, and publication separation
remain governed by the review lifecycle and are not changed here.

### 8. Preserve contextual Privacy

Show one candidate at a time:

```text
Local original
Why AI flagged it
Keep | Redact
```

There is no Suggested Release field or AI-prescribed decision. When permitted reviewed context exists, show only the minimum necessary original-language excerpt and explain the specific concern. When it does not exist, state that the original is unavailable and explain only the safe surviving information class, risk, uncertainty, and need for human confirmation. Never reconstruct the value.

### 9. Validate behavior, safety, and visual language

Run the generation contract/source-shape checks from
[validation-checklist.md](references/validation-checklist.md). Prove `/3`, Story-first order,
required supported People, Chapter-first Phase grouping, sparse `0..n` Insights, exact four Insight
meanings, optional title metadata, optional passage assistance, preserved safety, atomic activation,
session `/2`, successor review, and server-owned reviewed-story `/2` release. Keep generation
readiness, human review completion, release download, and publication approval distinct.

Do not require browser-independent pixel identity. Require bounded Golden-v1 fidelity: the retained three-region desktop composition, editorial hierarchy, restrained palette/card usage, responsive article width, Chapter reading order, and mandatory interactions remain recognizable. Project content, counts, wrapping, and minor spacing may vary. Reject a new visual system or information hierarchy when the canonical components can render the validated data.

## Completion standard

The result is complete only when a fresh reviewer can understand what to read and what to do without learning Oxygen's internal schema, every Story claim remains traceable to reviewed evidence, the Chapter is useful reusable project memory for humans and future Agents, the canonical English review loop works, any available localization remains non-blocking, and Final Release Memory remains explicitly separate from publication. Reusable memory may preserve evidence-backed user-visible rationale, mistakes, decisions, corrections, rejected approaches, and outcomes; it never records private latent reasoning.

Completion also requires a new clean clone and a completely fresh, contextless Agent to receive only
the normal public Oxygen workflow request and independently reach the same integrated canonical
Viewer capability. Do not provide the Storytelling Skill name, prior task/chat context, expected UI,
golden counts, hidden conversion steps, or generated project-local data. Unit tests and a hand-built
candidate are necessary evidence but are not substitutes for this clean-room gate. Any material fix
requires a new exact snapshot, new clone, and new Agent run.
