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
| **Build Project Story — always** | [product-contract.md](references/product-contract.md), [story-data-contract.md](references/story-data-contract.md), [privacy-evidence-boundary.md](references/privacy-evidence-boundary.md), and [narrative-writing-contract.md](references/narrative-writing-contract.md) | Input is privacy-prepared reviewed history; output is one complete validated Story candidate ready for atomic activation. Missing product, schema, Privacy/Evidence, or context-complete writing support keeps Build active. |
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

Select Chapters across the full set of meaningful project developments. Decisions and direction
changes are two eligible categories among several.
Eligible milestones include the supported beginning, problem discovery, a baseline, durable
progress or capability, a substantive iteration that changed quality, coverage, or understanding,
a surprising result, failure or diagnostic case that affected later work, root cause, decision,
direction or architecture change, quantitative result, validation, recovery, freeze, handoff, and
current state. Keep separate milestones when each establishes a distinct durable state that a
future reader needs. Combine events only when they form one connected causal arc. Deduplicate
repeated discussion and omit execution/status noise that adds no new result, constraint, or
understanding. Keep Chapters chronological and never select to satisfy a fixed count.

Build one coherent, evidence-grounded story of why the project began, what changed, what surprised people, where work failed, what decision followed, what was learned, and where the project now stands. Within a Chapter, brevity is never a selection, generation, revision, or validation objective. Retain every reviewed-Evidence-supported unit that materially explains the current milestone's background, causal or temporal relationship, participant interaction, judgment, failed attempt, progress or iteration, or result.

Apply the canonical context-retention and voice rules in
[product-contract.md](references/product-contract.md) and the evidence-driven roles in
[narrative-writing-contract.md](references/narrative-writing-contract.md): consider the complete reviewed history at
the approved boundary, then write a concise 2–3 sentence project arc, compact evidence-derived
Phase names, and context-complete causal Chapter prose. Determine Chapter length from the reviewed
Evidence needed to reconstruct the meaningful change. Do not apply a global word, paragraph, or
sentence maximum. A Chapter may use several substantial paragraphs when needed to preserve the
participants, starting position, alternatives, objections, corrections, failures, directional
Evidence, decision, action, outcome, and uncertainty. Omit only duplicated or routine material that
contributes none of those meanings, material outside the current milestone boundary, and content
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
manufacture an objection, reply, consensus, or second actor when Evidence contains none. Avoid
generic `the team` wording when a supported functional role is available.

Determine the actual supported relationship before choosing its wording. Express that relationship
with the most natural sentence construction; a connective adverb is optional. Sequence, cause,
response, contrast, correction, evidence, uncertainty, and continuation require different
Evidence. The examples in [narrative-writing-contract.md](references/narrative-writing-contract.md)
are an open vocabulary, not an allowlist. Do not require a transition word in every sentence or
paragraph, force lexical novelty, or substitute one stock connector for another. Prefer clear
syntax, explicit roles, and direct verbs. Never claim a stronger relationship than Evidence supports.

Before accepting the Chapter set, perform a narrative-coverage audit. Confirm that the selected
milestones retain supported progress, substantive iterations, and failures as well as judgment
moments. When reviewed evidence contains the initiating problem, goal, or baseline assumptions,
the opening Chapter/overview must establish that supported beginning. A midstream command,
import-path, test-collection, or other routine setup failure cannot replace that orientation. Keep an
operational incident when it produced a durable diagnostic result, recovery rule, contract,
capability, architecture, evaluation boundary, or direction change.

### 3. Generate project-local Story data

Create stable Chapter, participant, Story-block, passage-context, inline-insight, Privacy-candidate,
and evidence identities using [story-data-contract.md](references/story-data-contract.md). Generate
English as the canonical Story and readiness surface. Chinese is an optional localized sidecar,
never an activation requirement. When it is generated, keep it natural and preserve shared safe
identities; discard an unsafe sidecar without rejecting the English Story. Keep evidence IDs and
source text language-independent. Passage context is precomputed local review assistance keyed by
stable Story block; it is not a second release insight and is excluded from release/export.

Attach Story metadata to reviewed evidence without replacing source content. Validate source hash,
chronology, unique keys, the canonical English structure, any present localized sidecar's safe
identity boundary, evidence resolution, and the final current-state Chapter.

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

The staged package is ready only when its English Project Summary is complete; every selected
milestone is an explicit ordered Phase member with one complete Chapter; every required Story block
has complete English `passageContext`; every Chapter has exactly one canonical Insight; evidence and
Privacy structures resolve; and no placeholder, fallback milestone, partial job, or validation debt
remains. Missing, incomplete, or semantically stale Chinese copy never blocks Stage 5. Do not
require a fixed number of Phases, milestones, or Chapters.

Before activation, write and validate the structured Stage-4 narrative self-review defined in the
data and narrative contracts. Map Background, Decision process, Result, Open questions, Direct
learning, and Reusable rule to stable Story/Insight block IDs; confirm at least one supported
participant and complete actor coverage; confirm standard neutral terminology, Evidence-bound facts, separated
interpretation, preserved uncertainty, and the absence of prohibited style; confirm each Phase
assignment and adjacent boundary; and confirm that every inline AI Insight adds an Evidence-grounded
participant interaction and narrative explanation plus a bounded Reusable rule, without numbering
semantic passages or repeating its Story block. Confirm that every listed Person's English
functional role is used in Decision process so the participant interaction is understandable. If a
Chinese sidecar exists, validate its safe shared participant/Privacy identities, but do not make its
prose quality or semantic alignment a Story-readiness gate.
Classify every Chapter coverage-ledger element as represented or unsupported by the reviewed
Evidence. The historical `supporting_detail` state remains parser-compatible, but a staged candidate
that uses it cannot enter human review because supported explanatory context belongs in the Chapter. Create one
claim-traceability entry per material factual claim and explicit Evidence inputs for the canonical
Insight. Represent every supported unit that explains background, causal or temporal relationships,
participant interaction, judgment, failure, progress or iteration, or result. Omit a source unit only
when it contributes none of those meanings, lies outside the milestone boundary, duplicates retained
meaning, or is withheld by Privacy. An arbitrary Chapter count is never a justification.
Persist one privacy-safe context-retention row for every classified source unit in the complete
milestone Evidence cluster. A source unit is a reviewed conversational turn or independently
meaningful nested reviewed turn, not merely an Evidence-event ID. The row stores a stable digest
identity, unit kind, owning Evidence reference, and either its Story block IDs or one fixed exclusion
reason; it never stores source copy. Several units may share one Evidence reference, and repeating
that reference across claim traces does not prove context coverage. Activation fails unless every
represented unit is linked through `unitIds` to the factual claim and Story block that carries it.
Use a concise evidence-derived Phase rationale without hidden
chain-of-thought. If any check fails, keep the
workflow on Build Project Story and improve the staged candidate or disclose the evidence
limitation. Never activate a merely structural package.

After reattaching the fully generated candidate, confirm that the existing complete Privacy pass
was preserved for source-equivalent data. If source-bearing data changed, complete Privacy again.
Then request the single atomic activation:

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

AI Highlights live inside Story as restrained interpretations with reusable rules. Do not create a standalone Highlights section, a wizard, numbered section markers, a Release/Original card pair, or a dashboard of schema fields.

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

On wide screens, a secondary sticky passage-context panel exposes the complete Story-block sequence
with position and Previous/Next controls. Navigation scrolls/highlights the stable owning block;
clicking or focusing a Story block synchronizes the panel. It may explain what was happening, why the
moment mattered, what became clearer, and a grounded reusable rule, but only from precomputed
evidence-backed `passageContext`. Collapse it inline on narrower screens. Keep exactly one canonical
reviewable Chapter Insight, collapsed by default at the end of Story; its existing review lifecycle
remains unchanged.

Use the neutral localized Story headings Background, Decision process, Result, and Open questions.
Keep supporting evidence/factors inside Decision process and omit empty or generic-filler-only
headings. Label canonical Insight meanings Direct learning and Reusable rule. Accept and Do not
preserve must provide immediate accessible pending feedback; after Apply, show the applied revision
without implying Saved, Final, Published, or publication approval.

Every complete canonical English Chapter must supply `passageContext` for its exact rendered
Story-block set. Missing or unsupported English context makes that Chapter incomplete; do not use
an empty panel, generic copy, or optional import fallback. When a Chinese sidecar exists, its own
rendered blocks require safe matching context or the sidecar is omitted. Missing Chinese never
blocks English readiness. Passage context is local non-reviewable reading assistance and never
enters Final Release Memory, HTML, or ZIP.

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
transaction remains, no unresolved compatible legacy work remains, the canonical Insight is
settled, and evidence plus complete provenance validate. Paired-language debt remains visible but
never blocks All set; omit stale localized copy from release. Reopen review resumes the same shared
lifecycle.

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

The result is complete only when a fresh reviewer can understand what to read and what to do without learning Oxygen's internal schema, every Story claim remains traceable to reviewed evidence, the Chapter is useful reusable project memory for humans and future Agents, the canonical English review loop works, any available localization remains non-blocking, and Final Release Memory remains explicitly separate from publication. Reusable memory may preserve evidence-backed user-visible rationale, mistakes, decisions, corrections, rejected approaches, and outcomes; it never records private latent reasoning.

Completion also requires a new clean clone and a completely fresh, contextless Agent to receive only
the normal public Oxygen workflow request and independently reach the same integrated canonical
Viewer capability. Do not provide the Storytelling Skill name, prior task/chat context, expected UI,
golden counts, hidden conversion steps, or generated project-local data. Unit tests and a hand-built
candidate are necessary evidence but are not substitutes for this clean-room gate. Any material fix
requires a new exact snapshot, new clone, and new Agent run.
