---
name: oxygen-storytelling-review
description: Transform an already-reviewed project history into an evidence-grounded Project Story with iterative bilingual human-AI Chapter review. Use for Storytelling Review generation or implementation; do not use it to collect raw history, rerun privacy redaction, or approve publication.
---

# Oxygen Storytelling Review

Build a local review experience that turns a reviewed project history into:

```text
Project Story
→ evidence-linked Chapters
→ iterative human-AI review
→ human-confirmed Final Release Memory
```

The input is reviewed history, never unrestricted raw history. The output is a human-confirmed release representation, never publication approval.

## Required references

Read these references before the corresponding work. For an end-to-end implementation, read all seven completely before editing:

1. [product-contract.md](references/product-contract.md) — read before selecting Chapters or designing the Project Story/Chapter experience.
2. [story-data-contract.md](references/story-data-contract.md) — read before generating Story data or defining frontend types/import validation.
3. [chapter-review-lifecycle.md](references/chapter-review-lifecycle.md) — read before implementing annotations, Apply review, All set, provenance, or Reopen review.
4. [ui-interaction-contract.md](references/ui-interaction-contract.md) — read before implementing layout, navigation, selection, Privacy interactions, or responsive behavior.
5. [privacy-evidence-boundary.md](references/privacy-evidence-boundary.md) — read before opening input data, presenting local originals, or linking exact evidence.
6. [bilingual-contract.md](references/bilingual-contract.md) — read before generating localized Story copy or review state.
7. [validation-checklist.md](references/validation-checklist.md) — read before writing tests and again before handoff.

## Non-negotiable boundaries

- Work only from a reviewed contribution artifact and explicitly permitted local Story data.
- Keep `publication_approved=false` unless a separate user instruction explicitly approves publication. Apply review, All set, Final Release Memory, ZIP creation, and download are not publication.
- Never inspect or reopen raw private histories, removed redaction findings, private review ledgers, credential material, source envelopes, or original secrets to improve the Story.
- Never reconstruct removed content, fabricate evidence, fabricate identities, invent quotes, or rewrite uncertainty into hindsight certainty.
- Preserve exact source event IDs, chronology, original evidence language, and the existing Release preview/Preferences/package behavior.
- Keep project-specific Story copy and private/local presentation data outside reusable Skill and generic frontend source.

If the reviewed artifact lacks information needed for a richer Story, remain conservative and disclose the limit.

## End-to-end workflow

### 1. Establish the reviewed boundary

Read repository instructions and existing Viewer contracts. Inspect the reviewed archive without opening disallowed sources. Fail closed on unsafe member paths, count/manifest mismatches, non-false publication state, or evidence that cannot be resolved.

Do not rerun collection or privacy redaction unless separately requested and authorized.

### 2. Distill the Project Story

Select Chapters by meaningful state transition, not time or activity volume. Prefer problem discovery, baseline, surprising result, failure, root cause, decision, direction change, architecture change, quantitative shift, validation, freeze, handoff, and current state. Deduplicate repeated discussion and keep Chapters chronological.

Build one coherent, evidence-grounded story of why the project began, what changed, what surprised people, where work failed, what decision followed, what was learned, and where the project now stands. Compress procedure and repeated status while retaining causal transitions, technical precision, failure, disagreement, and uncertainty.

Before accepting the Chapter set, perform a narrative-coverage audit: when reviewed evidence contains the initiating problem, goal, or baseline assumptions, the opening Chapter/overview must establish that supported beginning rather than start at a midstream command, import-path, test-collection, or other routine setup failure. Keep such operational incidents only when they caused a durable contract, architecture, or direction change.

### 3. Generate project-local Story data

Create stable Chapter, participant, Story-block, inline-insight, Privacy-candidate, and evidence identities using [story-data-contract.md](references/story-data-contract.md). Generate English as canonical default and natural semantically equivalent Chinese. Keep evidence IDs and source text language-independent.

Attach Story metadata to reviewed evidence without replacing source content. Validate source hash, chronology, unique keys, bilingual structure, evidence resolution, and the final current-state Chapter.

### 4. Implement the Project Story

Retain the existing application shell. The Timeline is the narrative table of contents and keeps project/source navigation, phases when meaningful, direct Chapter actions, Release preview, and Preferences.

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

### 5. Implement the Chapter document editor

Use unnumbered headings and this primary order:

```text
People
Story
Privacy
Review status / completion
```

AI Highlights live inside Story as restrained interpretations with reusable lessons. Do not create a standalone Highlights section, a wizard, numbered section markers, a Release/Original card pair, or a dashboard of schema fields.

Follow the rule:

> Typography for reading. Boxes for interaction.

### 6. Implement exact Story annotations

Selecting generated Story text opens a temporary Delete / Revise / Add toolbar. Store semantic block ID, exact start/end offsets, selected text, type, instruction, source language, base revision, resolution, and applied revision.

Style only the exact validated inline range. Reject unsafe cross-block selections. Multiple non-overlapping ranges in one paragraph remain independent. Cancel removes only its annotation. Exact evidence is never annotatable or mutated.

### 7. Implement iterative review

The lifecycle is repeatable:

```text
initial AI draft
→ human annotations
→ Apply review
→ revised draft
→ human reviews and may annotate again
→ Apply review again
→ ...
→ All set
```

Apply review is never finalization. Revised text remains annotatable. Human instructions are authoritative, but unsupported Add requests must be flagged rather than fabricated. Preserve revision provenance.

Only All set creates human-confirmed Final Release Memory, and only after the latest revision was presented, all required Privacy decisions are complete, and no pending/unapplied/unsupported annotations remain. Reopen review resumes the same shared lifecycle.

### 8. Implement contextual Privacy

Show one candidate at a time:

```text
Local original
Why AI flagged it
Keep | Redact
```

There is no Suggested Release field or AI-prescribed decision. When permitted reviewed context exists, show only the minimum necessary original-language excerpt and explain the specific concern. When it does not exist, state that the original is unavailable and explain only the safe surviving information class, risk, uncertainty, and need for human confirmation. Never reconstruct the value.

### 9. Validate behavior, safety, and visual language

Write behavioral/model tests and perform browser verification from [validation-checklist.md](references/validation-checklist.md). Demonstrate at least two consecutive annotation → Apply review cycles before All set. Verify exact-range styling, available/unavailable Privacy, bilingual shared lifecycle, both Back routes, independent Chapter-list scrolling, unaffected Release preview/Preferences, and no publication side effect.

Do not require pixel identity across implementations. Require material equivalence in reading hierarchy, restrained card usage, responsive article width, retained sidebar, semantic state, privacy/evidence boundaries, and interaction behavior.

## Completion standard

The result is complete only when a fresh reviewer can understand what to read and what to do without learning Oxygen's internal schema, every Story claim remains traceable to reviewed evidence, the iterative review loop works in both languages, and Final Release Memory remains explicitly separate from publication.
