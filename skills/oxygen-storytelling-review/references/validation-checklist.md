# Validation checklist

Use behavioral/model/structural tests plus visible browser verification. Avoid brittle pixel equality; compare material product behavior and visual hierarchy.

## Data and safety

- [ ] Reviewed archive passes CRC/member-path safety.
- [ ] Manifest counts match data and `publication_approved=false`.
- [ ] Story data source hash matches the reviewed artifact.
- [ ] No raw history, private ledger, removed text/value, source envelope, credential material, or forbidden sibling implementation was opened.
- [ ] Chapter keys are bounded primitive strings, unique/chronological, and the last is honest current state; numeric/string coercion cannot collapse two Chapters.
- [ ] Every primary/supporting evidence ID is unique and resolves to exactly one actual reviewed item before Apply/All set.
- [ ] Participant, insight, Privacy-candidate, and annotation IDs are bounded primitive strings and unique within each Chapter and paired language presentation; numeric/string coercion cannot collapse two identities.
- [ ] Privacy decisions use an injective Chapter/candidate tuple identity rather than delimiter concatenation; delimiter-shaped IDs cannot collide.
- [ ] Import accepts exactly one paired reviewable insight per Chapter, the release projection never emits multiple insights, and server sanitization rejects multiple insights.
- [ ] Final confirmation/release revalidates insight provenance, latest Privacy decision history,
      and the exact derived redacted-target set; forged browser state fails closed.
- [ ] No identity/evidence/fact was fabricated.
- [ ] Project-specific copy/excerpts do not appear in reusable generic source/Skill.
- [ ] No unavailable Privacy candidate contains anything beyond its unavailable discriminator (no excerpt, language, removed value, or raw field).
- [ ] Every Privacy candidate declares stable release targets; every target resolves in both language presentations, and an intentionally local-only candidate declares an explicit empty target set.
- [ ] Package/publication behavior is unchanged.

## Workflow progress

- [ ] Existing centered loading treatment is reused for workflow progress rather than replaced by a developer dashboard.
- [ ] Stages match the real contributor workflow and expose completed/current/next plus waiting, blocked, and human-action state.
- [ ] Determinate progress appears only when backed by a real denominator; no fake percentage is shown.
- [ ] Refresh hydrates the same persisted operational stage and a quiet shell action can reopen it.
- [ ] Progress data contains only allowlisted stage/status codes, counts, timestamps, blocker codes,
      and human-action state; it contains no reasoning, prompts, raw model/tool output, private
      messages, Story/Evidence payload, removed content, or free-form private status text.

## Productization and workflow

- [ ] Root contributor instructions and the organize/review workflow explicitly delegate the
      reviewed-input stage to `oxygen-storytelling-review`; README listing alone is not counted.
- [ ] A workflow-level instruction that does not name the Skill still selects it after organization
      and privacy preparation.
- [ ] The Skill requires reuse of `InlineWorkspace`, `StoryChapterEditor`, and the shared
      `viewer/lib` contracts rather than a new independent frontend.
- [ ] At least one safe synthetic project fixture differs from Golden in project name, Chapter
      count, Phase count, People, Privacy candidates, dates, chips, and evidence IDs.
- [ ] Renderer, Skill, and tests contain no Golden project copy, fixed Golden counts, local ports,
      machine paths, or project-specific evidence IDs.
- [ ] Golden behavior/composition is checked with bounded visual fidelity; private Golden data and
      screenshots remain local-only.

## Project Story

- [ ] Selection is event-driven, globally consequential, deduplicated, and not time/volume bucketed.
- [ ] Derivation considered every record in the approved reviewed input boundary while visible copy compresses routine history; no broader/private-history coverage is claimed.
- [ ] Project Summary is nonempty, normally 2–3 concise sentences, and establishes the supported beginning, major turn, and current boundary without mechanically listing Phases or repeating visible metrics.
- [ ] Phase labels are evidence-derived and strongly prefer one or two English words plus equivalently compact natural Chinese; selection/grouping was not changed merely for naming.
- [ ] When supported evidence contains the initiating problem/goal/baseline assumptions, the opening Chapter and overview establish that beginning instead of starting at a midstream routine setup/test failure.
- [ ] Routine command, import-path, test-collection, and ordinary test incidents are compressed unless they demonstrably changed a durable contract, architecture, execution envelope, or direction.
- [ ] Timeline remains the narrative table of contents with direct Chapter actions.
- [ ] Project/source rail, Release preview, Preferences, and existing downloads remain usable.
- [ ] Compact orientation retains canonical project name, overview, milestone count, phase count, reviewed-Highlight progress, and useful source/evidence context when available; values are derived rather than hardcoded.
- [ ] The Timeline reading column is visibly centered in the available canvas and no giant project card dominates it.
- [ ] Meaningful phases are visually stronger than card metadata; every milestone belongs visibly to one generated phase.
- [ ] Desktop has a sticky ordered Phase directory with direct scroll navigation and active/visible indication where practical; narrow layouts collapse it without squeezing the Timeline.
- [ ] Every selected milestone visibly exposes a mandatory date, milestone type, unmistakable AI-selected Highlight signal, short title, concise Before → After, and secondary evidence/read action.
- [ ] Before/After can be understood in seconds and do not read like paragraph summaries.
- [ ] Accent chips carry only high-signal supported counts, metrics, versions, named concepts, or status changes and replace prose rather than adding decorative density.
- [ ] Long Timeline explanation, detailed summary, lesson, reasoning, and narrative prose live in the Chapter instead of milestone cards.

## Chapter shell and visual structure

- [ ] Left application rail remains present in Chapter.
- [ ] Chapter selector is a bounded independent overflow region with visible scrollbar on overflow.
- [ ] Mouse wheel/trackpad scroll the selector without moving Story.
- [ ] Any Chapter, including the last, is directly reachable.
- [ ] Active Chapter is highlighted and programmatic next/previous keeps it visible.
- [ ] Source records remain usable below.
- [ ] Article is moderately wide, responsive, centered, readable, and has no horizontal overflow.
- [ ] Chapter has exactly unnumbered People, Story, Privacy primary sections.
- [ ] No numbered markers, tabs, stepper, standalone Highlights, or Release/Original card pair.
- [ ] Boxes are limited to interaction; Story/People remain typography-first.
- [ ] Project Story homepage retains the approved hierarchy/rhythm; the only product addition is a
      subtle localized instruction to read a Chapter for the full Story, Evidence, and lessons.

## People and Story

- [ ] People markers use one centered non-wrapping size and AI aligns with humans.
- [ ] Roles/descriptions are compact and evidence-supported.
- [ ] Local/release identity distinction is clear; no fabricated name.
- [ ] Story is a structured, context-sufficient article with clear causal progression and uncertainty.
- [ ] Chapter prose preserves supported problem/purpose, constraints, prior attempts, failures or
      rejected approaches, directional evidence, decision/rationale, action/outcome, uncertainty,
      and reusable learning without becoming a raw log or audit report.
- [ ] Final reviewed Chapters are explicitly reusable human/future-Agent project memory, with no
      hidden model reasoning or unsupported retrospective causality.
- [ ] Default read mode remains clean; accessible pencil/Edit enters a visibly contained review
      surface without uncontrolled DOM mutation.
- [ ] The single reviewable AI insight and reusable lesson appear in one end-of-Story disclosure,
      collapsed by default and labeled as interpretation; no multi-insight fallback UI exists.
- [ ] Canonical AI insight copy is concrete, project-specific, evidence-grounded, and avoids generic summary formulas.
- [ ] Accept/remove/direct edit/human-directed revise work without a full chat UI.
- [ ] Clicking/selecting different Story blocks changes a secondary sticky contextual panel using
      the correct stable block key; passage context is precomputed local assistance, not another
      reviewable Insight or a browser model call.
- [ ] Passage-context key sets exactly cover rendered Story blocks in both languages and the release
      projection excludes all passage-context copy.

## Text annotations

- [ ] Toolbar is absent until meaningful Story text is selected.
- [ ] Toolbar is unavailable in default read mode and becomes available only in explicit Story Edit Mode.
- [ ] Toolbar has accessible Delete, Revise, Add, and visible compact Close actions.
- [ ] Close and Escape immediately clear only transient selection/toolbar state; saved annotations remain.
- [ ] Exact block ID, start, end, selected text, language, base revision, type, instruction, and resolution persist.
- [ ] Only the exact range is styled; parent paragraph/list item is not.
- [ ] Pending quote equals `source.slice(start,end)`.
- [ ] Two non-overlapping annotations in one paragraph render independently.
- [ ] Overlapping same-revision ranges and duplicate annotation IDs are rejected before they enter/apply; adversarial batches fail atomically without revision provenance.
- [ ] The complete ledger is replayed from immutable source blocks: malformed applied/cancelled records and duplicate IDs across resolutions block Apply, All set, and release projection without changing the revision.
- [ ] Cancelling one removes only that range.
- [ ] Stale/mismatched/cross-language literal ranges fail closed.
- [ ] Cross-block/cross-paragraph selection is rejected when not safely supported.
- [ ] Exact Evidence cannot be annotated or mutated.
- [ ] Each annotation has one restrained block-associated margin note on wide screens; clicking it
      focuses the exact range, and narrow screens use an inline fallback without horizontal overflow.
- [ ] Leaving Edit Mode clears only transient selection/toolbar state; saved pending/applied review state remains.
- [ ] Annotation notes and their UI metadata are absent from release/export.

## Iterative lifecycle

Demonstrate this complete sequence in tests and browser QA:

1. [ ] Initial AI draft, revision 1, reviewing, publication false.
2. [ ] Create first Delete or Revise annotation.
3. [ ] All set unavailable while pending.
4. [ ] Resolve required Privacy.
5. [ ] Apply review produces revision 2.
6. [ ] Revision 2 Story remains annotatable.
7. [ ] Create a second annotation on revision 2.
8. [ ] All set becomes unavailable again.
9. [ ] Second Apply produces revision 3.
10. [ ] Clean revision 3 plus complete Privacy enables All set.
11. [ ] All set produces human-confirmed Final Release Memory.
12. [ ] Publication approval remains false and no upload/package/publish occurs.
13. [ ] Reopen review returns to editable reviewing state with provenance preserved.
14. [ ] Another apply/confirmation cycle remains possible.
15. [ ] An applied rejected insight can be reopened, restored through a new pending operation and
        Apply, then confirmed again without deleting its prior provenance.

Also verify:

- [ ] Privacy blocks Apply/All set as specified.
- [ ] Unsupported Add becomes `needs_evidence`, is not inserted, and blocks All set.
- [ ] Evidence-supported Add receives `appliedRevision`, enters the next draft, and can complete after paired-language review.
- [ ] A real evidence ID plus arbitrary unsupported Add wording remains `needs_evidence`; checkbox/ID possession alone never certifies a factual claim.
- [ ] Applied annotations do not expose Cancel; reversal requires a new pending operation and revision.
- [ ] Redact suppresses all bound targets in the allowlisted EN/中文 release projection, while Keep preserves permitted safe copy.
- [ ] Pending insight changes and stale paired-language blocks disable All set.
- [ ] Accepting a localized pending insight edit does not erase the paired-language review debt.
- [ ] Summary counts and revision labels are correct.
- [ ] Human intent is not silently dropped.
- [ ] Pending/forged insight state, latest Privacy-history disagreement, and a forged
      `redactedBlocks` set each block All set and release projection.

## Privacy

- [ ] One candidate at a time with progress.
- [ ] Visible fields are Local original and Why AI flagged it, followed by Keep/Redact.
- [ ] Suggested Release/recommendation copy is absent in both languages.
- [ ] Available mode shows only permitted minimal original-language context and a specific concern.
- [ ] Unavailable mode shows the explicit unavailable message, safe risk/uncertainty explanation, and no reconstructed value.
- [ ] Keep/Redact advance naturally and Review again behaves safely.
- [ ] Decisions drive completion state but never alter source evidence.

## Navigation and evidence

- [ ] Timeline scroll to a middle/late milestone → Chapter → Project Story Back restores useful scroll/focus.
- [ ] Chapter → primary evidence focuses exact source event.
- [ ] Chapter → supporting evidence focuses exact source event.
- [ ] Evidence shows prominent Back to chapter.
- [ ] Back restores originating Chapter, language, useful Story scroll, an open local-Evidence disclosure, and focus on the exact primary/supporting origin control.
- [ ] Evidence remains original-language and is labeled local-only/not exported.

## Bilingual

- [ ] Fresh state is English.
- [ ] One shell-level `EN | 中文` control is compact and remains discoverable on Project Story, Chapter, and Exact Evidence; it is not duplicated as unrelated page-local controls.
- [ ] Chinese changes Timeline Story labels and full Chapter presentation.
- [ ] Chinese localizes inline insight title/observation/lesson, participant identity explanations, status/annotation copy, and review blockers; nontechnical English placeholder sentences do not remain.
- [ ] Chinese localizes Story read/Edit guidance, margin notes, passage context, and collapsed
      canonical-Insight controls while sharing one semantic/review state.
- [ ] Switching back restores equivalent English.
- [ ] Every declared shared semantic anchor/technical identifier is present in reader-facing EN and 中文 copy (or has an explicit alignment); missing and one-language-only anchors fail closed.
- [ ] Annotation/Privacy/revision/All set state survives language switching.
- [ ] One lifecycle/confirmation history drives both languages.
- [ ] Evidence content remains source-language.

## Automated validation

Run the repository's required commands. For the Oxygen Viewer this normally includes:

```bash
cd viewer
npm test
npm run build
```

Also run:

- focused ESLint on changed files;
- `git diff --check`;
- lockfile/dependency diff check;
- staged-file check;
- focused tests for every behavior above;
- story-data/schema validation;
- generic-source scan for project-specific/private copy.

Do not fix unrelated origin debt or mutate dependencies/lockfiles merely to complete Storytelling Review.

## Visible browser QA

Use the actual local Viewer. Capture and inspect at least:

1. Project Story opening;
2. Chapter opening with retained rail and People;
3. Chapter default read mode;
4. contained Story Edit Mode;
5. exact-range annotation with left-margin note and contextual input;
6. first passage-context panel state;
7. second passage/context switch;
8. canonical AI Insight collapsed and expanded;
9. Privacy available mode;
10. Privacy unavailable mode;
11. gated completion and clean revision-ready state;
12. Final Release Memory and Reopen review;
13. exact Evidence with Back to chapter;
14. Chinese Chapter with shared review state;
15. narrow Chapter fallback for notes and contextual assistance.

Check console errors and responsive layout. Preserve the user's visible review state or reset prototype-only QA edits before handoff.

## Material-equivalence comparison

Two implementations need not be pixel-identical. They are materially equivalent only when all of these match:

- information architecture;
- reading hierarchy and density;
- retained application context;
- direct Chapter/evidence navigation;
- exact-range document annotation;
- iterative Apply/All set/Reopen semantics;
- one-at-a-time contextual Privacy with no Suggested Release;
- evidence and identity safety boundaries;
- bilingual shared lifecycle;
- publication separation.

Classify differences as:

```text
SKILL_MISSING_REQUIREMENT
SKILL_AMBIGUOUS
SKILL_CONTRADICTORY
IMPLEMENTATION_BUG
ACCEPTABLE_IMPLEMENTATION_VARIATION
```

A missing material behavior normally means the Skill is incomplete unless the requirement was already explicit and unambiguous.
