---
name: oxygen-storytelling-review
description: Continue an already-reviewed project history through Oxygen's canonical evidence-grounded Project Story and iterative bilingual Chapter review. Use after organization and privacy preparation; reuse the repository Viewer/runtime rather than creating an independent frontend. Do not collect raw history, rerun redaction, or approve publication.
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

## Required references

Read these references before the corresponding work. For end-to-end generation, adaptation, or validation, read all eight completely before editing:

1. [product-contract.md](references/product-contract.md) — read before selecting Chapters or adapting the Project Story/Chapter experience.
2. [story-data-contract.md](references/story-data-contract.md) — read before generating Story data or changing frontend types/import validation.
3. [chapter-review-lifecycle.md](references/chapter-review-lifecycle.md) — read before changing annotations, Apply review, All set, provenance, or Reopen review.
4. [ui-interaction-contract.md](references/ui-interaction-contract.md) — read before changing layout, navigation, selection, Privacy interactions, or responsive behavior.
5. [privacy-evidence-boundary.md](references/privacy-evidence-boundary.md) — read before opening input data, presenting local originals, or linking exact evidence.
6. [bilingual-contract.md](references/bilingual-contract.md) — read before generating localized Story copy or review state.
7. [validation-checklist.md](references/validation-checklist.md) — read before writing tests and again before handoff.
8. [narrative-writing-contract.md](references/narrative-writing-contract.md) — read before generating or revising titles, Story prose, passage assistance, or the canonical Chapter Insight.

## Non-negotiable boundaries

- Work only from a reviewed contribution artifact and explicitly permitted local Story data.
- Keep `publication_approved=false` unless a separate user instruction explicitly approves publication. Apply review, All set, Final Release Memory, ZIP creation, and download are not publication.
- Never inspect or reopen raw private histories, removed redaction findings, private review ledgers, credential material, source envelopes, or original secrets to improve the Story.
- Never reconstruct removed content, fabricate evidence, fabricate identities, invent quotes, or rewrite uncertainty into hindsight certainty.
- Preserve exact source event IDs, chronology, original evidence language, and the existing Release preview/Preferences/package behavior.
- Keep project-specific Story copy and private/local presentation data outside reusable Skill and generic frontend source.

If the reviewed artifact lacks information needed for a richer Story, remain conservative and disclose the limit.

## Canonical Toolkit runtime

Inside this repository, the default path is reuse, not reinvention:

```text
reviewed project data
→ validated Story metadata (`viewer/lib/timeline.ts`)
→ existing Viewer Project Story (`viewer/app/workspace.tsx`, `InlineWorkspace`)
→ existing Chapter editor (`viewer/app/story-chapter-editor.tsx`, `StoryChapterEditor`)
→ shared review/evidence/navigation/release primitives (`viewer/lib/story-*`)
→ existing Release preview / Preferences / package surfaces
```

Generate and bind project-specific Story data to those entrypoints. Do not add a second app, a
project-bound page, or a direct import of local Story copy. Do not reimplement Privacy, evidence,
review-state, bilingual, release, or export rules in a new component. Modify the canonical runtime
only when a missing generalized capability is demonstrated, and keep the change bounded so every
valid project benefits.

Workflow callers should delegate here automatically after organization and privacy preparation;
the contributor should not need to know this Skill's name. When Story review finishes, return to
the existing Release preview, Preferences, and package flow.

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

Select Chapters by meaningful state transition, not time or activity volume. Prefer problem discovery, baseline, surprising result, failure, root cause, decision, direction change, architecture change, quantitative shift, validation, freeze, handoff, and current state. Deduplicate repeated discussion and keep Chapters chronological.

Build one coherent, evidence-grounded story of why the project began, what changed, what surprised people, where work failed, what decision followed, what was learned, and where the project now stands. Compress procedure and repeated status while retaining causal transitions, technical precision, failure, disagreement, and uncertainty.

Apply the canonical narrative-compression and voice rules in
[product-contract.md](references/product-contract.md) and the evidence-driven roles in
[narrative-writing-contract.md](references/narrative-writing-contract.md): consider the complete reviewed history at
the approved boundary, then write a concise 2–3 sentence project arc, compact evidence-derived
Phase names, and context-sufficient causal Chapter prose. A Chapter may use several substantial
paragraphs when needed to preserve the problem, constraints, attempts, failures, evidence, decision,
action, outcome, uncertainty, and reusable lesson. Compression never permits fictionalization,
hidden model reasoning, or unsupported causality.

Before accepting the Chapter set, perform a narrative-coverage audit: when reviewed evidence contains the initiating problem, goal, or baseline assumptions, the opening Chapter/overview must establish that supported beginning rather than start at a midstream command, import-path, test-collection, or other routine setup failure. Keep such operational incidents only when they caused a durable contract, architecture, or direction change.

### 3. Generate project-local Story data

Create stable Chapter, participant, Story-block, passage-context, inline-insight, Privacy-candidate,
and evidence identities using [story-data-contract.md](references/story-data-contract.md). Generate
English as canonical default and natural semantically equivalent Chinese. Keep evidence IDs and
source text language-independent. Passage context is precomputed local review assistance keyed by
stable Story block; it is not a second release insight and is excluded from release/export.

Attach Story metadata to reviewed evidence without replacing source content. Validate source hash, chronology, unique keys, bilingual structure, evidence resolution, and the final current-state Chapter.

The staged package is ready only when its bilingual Project Summary is complete; every selected
milestone is an explicit ordered Phase member with one complete Chapter; every required Story block
has matching EN/中文 `passageContext`; every Chapter has exactly one canonical Insight; evidence and
Privacy structures resolve; and no placeholder, fallback milestone, partial job, or validation debt
remains. Do not require a fixed number of Phases, milestones, or Chapters.

Before activation, write and validate the structured Stage-4 narrative self-review defined in the
data and narrative contracts. Map Background, evidence thread, turn, result, direct learning,
reusable principle, and supported open tension to stable Story/Insight block IDs; confirm that the
title names tension plus outcome; confirm each Phase assignment and each adjacent boundary; and
confirm that every Passage Insight adds interpretation rather than repeating its Story block. Use a
concise evidence-derived Phase rationale, not hidden chain-of-thought. If any check fails, keep the
workflow on Build Project Story and improve the staged candidate or disclose the evidence
limitation. Never activate a merely structural package.

After reattaching the fully generated candidate and restoring a complete privacy pass, request the
single atomic activation:

```bash
python3 skills/oxygen-organize-review-export/scripts/run_local_review.py \
  --attach-url <viewer-url> --workflow-run-id <run-id> --story-event ready
```

The Viewer revalidates the complete staged package and activates it only if its source revision is
unchanged. A failed activation remains on Workflow Progress. Report it with `--story-event blocked`
when no automatic correction remains; never patch the Viewer database or reveal the partial draft.

On successful activation, immediately give the contributor the exact Viewer URL, say that no
password is required, and pause with this Agent and Viewer alive. Do not perform human review or
release work first. In an unattended run, report `WAITING_FOR_HUMAN_STORY_REVIEW` and wait.

### 4. Bind data into the canonical Project Story

Retain the existing application shell. The Timeline is the narrative table of contents and keeps project/source navigation, phases when meaningful, direct Chapter actions, Release preview, and Preferences.

Reuse the existing centered loading treatment as the workflow-progress surface. Derive its stages
from the contributor workflow and show completed/current/next, waiting/blocked state, real
denominator-based progress when available, and human-action state. Persist operational progress in
existing workflow data so refresh can hydrate it; do not invent percentages or expose reasoning,
prompts, raw tool arguments, private messages, Story/Evidence payloads, or removed content. Keep a
quiet shell action for reopening the status.

Treat the Project Story homepage as a scan-first table of contents, not a compressed Chapter. Preserve this hierarchy:

```text
project identity + concise overview
→ milestone / phase / Highlight-review / source orientation
→ narrative Phase
→ dated AI-selected Highlight milestone
→ short Before → After transition
→ high-signal keyword / metric chips
→ Read Chapter
```

Center the Timeline reading column in the canvas and use a lightweight project header rather than one dominant full-width project card. When meaningful phases exist, make every milestone's phase visually explicit and add a secondary sticky right-side phase directory on desktop; collapse it gracefully on narrower screens. Date and visible AI-selected Highlight marking are mandatory on every selected milestone. Keep Timeline copy terse: title and compact state transition carry the meaning, while explanatory summary, lesson, reasoning, and narrative prose belong in the Chapter. Use accent chips only for evidence-backed counts, metrics, versions, named concepts, and status changes; chips replace prose rather than decorate it.

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

AI Highlights live inside Story as restrained interpretations with reusable lessons. Do not create a standalone Highlights section, a wizard, numbered section markers, a Release/Original card pair, or a dashboard of schema fields.

Default to a clean read mode. A compact accessible pencil/Edit control enters a visually contained
Story Edit Mode. Direct typing, caret insertion, selection replacement/deletion, and safe plain-text
paste are the primary interaction, but every mutation must become a controlled block-local review
transaction; never let uncontrolled `contenteditable` or browser-native history bypass the review
state. Expose synchronized Undo/Redo and readable margin notes with pending Discard and applied
Revert-in-a-new-revision. Do not add a second text-selection action toolbar: native selection is
used directly for replacement or deletion inside Story Edit Mode.
On narrow screens, fold notes into compact block-associated surfaces without reducing Story width.

On wide screens, a secondary sticky passage-context panel exposes the complete Story-block sequence
with position and Previous/Next controls. Navigation scrolls/highlights the stable owning block;
clicking or focusing a Story block synchronizes the panel. It may explain what was happening, why the
moment mattered, what became clearer, and a grounded reusable lesson, but only from precomputed
evidence-backed `passageContext`. Collapse it inline on narrower screens. Keep exactly one canonical
reviewable Chapter Insight, collapsed by default at the end of Story; its existing review lifecycle
remains unchanged.

Every complete Chapter must supply `passageContext` for the exact rendered Story-block set in both
English and Chinese with identical stable keys. Missing or unsupported context makes that Chapter
incomplete; do not use an empty panel, generic copy, or an optional import fallback. Passage context
is local non-reviewable reading assistance and never enters Final Release Memory, HTML, or ZIP.

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

Only All set creates human-confirmed Final Release Memory, and only after the latest revision was
presented, all required Privacy decisions are complete, no pending or needs-evidence direct
transaction remains, no unresolved compatible legacy work remains, paired-language debt is clear,
the canonical Insight is settled, and evidence plus complete provenance validate. Reopen review
resumes the same shared lifecycle.

### 8. Preserve contextual Privacy

Show one candidate at a time:

```text
Local original
Why AI flagged it
Keep | Redact
```

There is no Suggested Release field or AI-prescribed decision. When permitted reviewed context exists, show only the minimum necessary original-language excerpt and explain the specific concern. When it does not exist, state that the original is unavailable and explain only the safe surviving information class, risk, uncertainty, and need for human confirmation. Never reconstruct the value.

### 9. Validate behavior, safety, and visual language

Write behavioral/model tests and perform browser verification from [validation-checklist.md](references/validation-checklist.md). Demonstrate direct typing → Apply → another direct edit → Apply before All set. Verify safe progress hydration, read/Edit mode, synchronized Undo/Redo, Discard/applied Revert, margin notes, complete contextual passage navigation, the collapsed canonical Insight, exact-range fallback styling, available/unavailable Privacy, bilingual shared lifecycle/debt, both Back routes, independent Chapter-list scrolling, release exclusion, unaffected Release preview/Preferences, and no publication side effect.

Do not require browser-independent pixel identity. Require bounded Golden-v1 fidelity: the retained three-region desktop composition, editorial hierarchy, restrained palette/card usage, responsive article width, Chapter reading order, and mandatory interactions remain recognizable. Project content, counts, wrapping, and minor spacing may vary. Reject a new visual system or information hierarchy when the canonical components can render the validated data.

## Completion standard

The result is complete only when a fresh reviewer can understand what to read and what to do without learning Oxygen's internal schema, every Story claim remains traceable to reviewed evidence, the Chapter is useful reusable project memory for humans and future Agents, the iterative review loop works in both languages, and Final Release Memory remains explicitly separate from publication. Reusable memory may preserve evidence-backed user-visible rationale, mistakes, decisions, corrections, rejected approaches, and outcomes; it never records private latent reasoning.

Completion also requires a new clean clone and a completely fresh, contextless Agent to receive only
the normal public Oxygen workflow request and independently reach the same integrated canonical
Viewer capability. Do not provide the Storytelling Skill name, prior task/chat context, expected UI,
golden counts, hidden conversion steps, or generated project-local data. Unit tests and a hand-built
candidate are necessary evidence but are not substitutes for this clean-room gate. Any material fix
requires a new exact snapshot, new clone, and new Agent run.
