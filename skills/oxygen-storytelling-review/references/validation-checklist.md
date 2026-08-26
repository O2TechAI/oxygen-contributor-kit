# Validation checklist

Use behavioral/model/structural tests plus visible browser verification. Avoid brittle pixel equality; compare material product behavior and visual hierarchy.

## Story-first generation contract

- [ ] Active generation targets `oxygen.story/3`; deterministic source readiness permits atomic
      workflow activation into `oxygen.story-review-session/2` and the successor Viewer, but is not
      human review completion, reviewed-story `/2` release authority, or publication approval.
- [ ] Generation order is complete approved history -> coherent Chapter arcs -> complete Story ->
      continuity/chronology/attribution/Evidence/uncertainty verification -> adjacent Chapter Phase
      grouping -> independently warranted learning moments -> zero or more Insights.
- [ ] Every Chapter is one complete coherent narrative arc with at least one Evidence-supported
      Person or actor.
- [ ] Chapter boundaries are determined before Phases; Phase labels are precise one- or two-word
      labels and Phase does not dictate Chapter boundaries.
- [ ] Every Chapter accepts `0..n` Insights with no minimum, maximum, quota, or density target.
- [ ] Every existing Insight contains exactly Background, Quote, Directly Acquired Experience, and
      Principle; title is optional presentation metadata.
- [ ] Quote uses safe reviewed Story anchors and internal Evidence support without copying raw/private
      Evidence. Directly Acquired Experience remains bounded to the actual project moment. Principle
      introduces no unsupported industry prior.
- [ ] Passage assistance is optional, local, human-facing, non-authoritative, non-readiness, and
      non-release; no Story block requires why-it-mattered, what-was-learned, or a reusable lesson.
- [ ] Complete-history consideration, context retention, failure retention, chronology, attribution,
      causal restraint, uncertainty, Privacy, Evidence traceability, and non-fabrication remain.
- [ ] The canonical live mapping is `/3` source -> session `/2` -> reviewed-story `/2`; the server
      revalidates exact source revision/digest and review completion rather than treating generation
      readiness as human approval.
- [ ] Compatibility remains explicitly `/2` Story Highlight -> session `/1` -> reviewed-story `/1`;
      historical `/1` Story Milestone remains non-reviewable compatibility only.

## Data and safety

- [ ] Reviewed archive passes CRC/member-path safety.
- [ ] Manifest counts match data and `publication_approved=false`.
- [ ] Story data source hash matches the reviewed artifact.
- [ ] No raw history, private ledger, removed text/value, source envelope, credential material, or forbidden sibling implementation was opened.
- [ ] Chapter keys are bounded primitive strings and unique/chronological; current state is honest as
      its own coherent Chapter or the supported ending of the final Chapter. Numeric/string coercion
      cannot collapse two Chapters.
- [ ] Every newly generated primary/supporting/Person `eventId` is the exact fully qualified imported item ID; each reference is unique and resolves to exactly one actual reviewed item before activation, Apply, or All set.
- [ ] Participant, insight, Privacy-candidate, and annotation IDs are bounded primitive strings and unique within each Chapter and paired language presentation; numeric/string coercion cannot collapse two identities.
- [ ] Privacy decisions use an injective Chapter/candidate tuple identity rather than delimiter concatenation; delimiter-shaped IDs cannot collide.
- [ ] `/3` source import accepts zero or more Insights. Compatibility `oxygen.story-highlight/2`
      import/release retains its exact-one behavior and is never reused for canonical `/3`.
- [ ] Final confirmation/release revalidates insight provenance, latest Privacy decision history,
      and the exact derived redacted-target set; forged browser state fails closed.
- [ ] No identity/evidence/fact was fabricated.
- [ ] Project-specific copy/excerpts do not appear in reusable generic source/Skill.
- [ ] Direct-edit transaction IDs/ranges/revisions replay from immutable Story sources; pending,
      reverted, needs-evidence, and malformed applied records cannot enter release output.
- [ ] No unavailable Privacy candidate contains anything beyond its unavailable discriminator (no excerpt, language, removed value, or raw field).
- [ ] Every Privacy candidate declares stable release targets; every target resolves in English,
      any optional localization preserves the same safe identity or is omitted, and an intentionally
      local-only candidate declares an explicit empty target set.
- [ ] Package/publication behavior is unchanged.

## Workflow progress

- [ ] Project Story remains hidden through Collect, Organize, Privacy, and Build Project Story; organization records, fallback milestones, and partial Story rows never unlock it.
- [ ] One persisted Story generation status survives refresh and reaches `ready_for_human_review` only through complete server-side package validation.
- [ ] Activation atomically moves Build Project Story to complete and Review Story to current with human action required; a changed source revision or failed validation remains on Progress.
- [ ] Direct Story navigation and Story review-session GET/POST fail closed before readiness.
- [ ] An already-mounted Build Progress page reloads the activated Story snapshot and reveals the
      complete Story within the normal polling interval; no manual refresh or tab reopening occurs.
- [ ] Initial server render stays on persisted Build Progress before readiness and opens the
      complete Story directly after Review readiness, without a fabricated Collect frame.
- [ ] Stage 5 immediately surfaces the exact no-password URL and pauses the same Agent/Viewer for
      real human review; unattended validation reports `WAITING_FOR_HUMAN_STORY_REVIEW`.

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

- [ ] Selection is event-driven, globally meaningful, deduplicated, and not time/volume/count bucketed.
- [ ] Chapter eligibility includes evidence-supported direction changes, durable progress,
      substantive iterations, failures/diagnostics that affected later work, validations,
      recoveries, handoffs, and the current boundary; a judgment moment is not mandatory.
- [ ] Distinct durable states remain separate milestones. Events are combined only when they form
      one connected causal arc, and no numeric target silently removes supported milestones.
- [ ] Derivation considered every record in the approved reviewed input boundary. Chapter copy
      retains every supported unit that explains the milestone's background, causal or temporal
      relationships, participant interaction, judgment, failure, progress, or result; no
      broader/private-history coverage is claimed.
- [ ] Project Summary is nonempty, normally 2–3 concise sentences, and establishes the supported beginning, major turn, and current boundary without mechanically listing Phases or repeating visible metrics.
- [ ] Phase labels are evidence-derived and strongly prefer one or two English words plus equivalently compact natural Chinese; selection/grouping was not changed merely for naming.
- [ ] Each Phase has one consistent evidence-derived rationale, adjacent Phase rationales are
      distinct, generic fallback labels fail activation, and a demonstrated coherent single Phase
      remains valid without a minimum count.
- [ ] When supported evidence contains the initiating problem/goal/baseline assumptions, the opening
      Chapter and overview establish that beginning. A midstream routine setup/test failure cannot
      replace the supported orientation.
- [ ] Routine command, import-path, test-collection, and ordinary test incidents are omitted only
      when they contribute no explanatory background, relationship, interaction, judgment, failure,
      progress, or result to the current milestone.
- [ ] Timeline remains the narrative table of contents with direct Chapter actions.
- [ ] Project/source rail, Release preview, Preferences, and existing downloads remain usable.
- [ ] Compact orientation retains canonical project name, overview, Chapter count, Phase count, and
      useful source/Evidence context when available; values are derived rather than hardcoded.
- [ ] The Timeline reading column is visibly centered in the available canvas and no giant project card dominates it.
- [ ] Meaningful phases are visually stronger than card metadata; every milestone belongs visibly to one generated phase.
- [ ] Desktop has a sticky ordered Phase directory with direct scroll navigation and active/visible indication where practical; narrow layouts collapse it without squeezing the Timeline.
- [ ] Every selected Chapter exposes supported date/type/title, concise Before -> After when the
      consumer supports it, and secondary Evidence/read action; generation does not assign canonical
      meaning through an AI-selected marker.
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
- [ ] Chapter chrome, Hero/title, People, complete Story grid, Privacy, Evidence, and completion use
      one shared responsive outer-canvas contract and visibly align at desktop widths.
- [ ] Chapter has exactly unnumbered People, Story, Privacy primary sections.
- [ ] No numbered markers, tabs, stepper, standalone Insights dashboard, or Release/Original card pair.
- [ ] Boxes are limited to interaction; Story/People remain typography-first.
- [ ] Project Story homepage retains the approved hierarchy/rhythm; the only product addition is a
      subtle localized instruction to read a Chapter for the full Story, Evidence, and lessons.
- [ ] That instruction is structurally after Project orientation/metrics and immediately before the
      first Phase, not inside the Hero and not rendered as a card/banner.

## People and Story

- [ ] People markers use one centered non-wrapping size and AI aligns with humans.
- [ ] Roles/descriptions are compact and each Person has reviewed Evidence contained in the Chapter Evidence set.
- [ ] Local/release identity distinction is clear; no fabricated name.
- [ ] Meeting speakers and user/Agent trajectories retain distinct supported functional roles;
      uncertain roles use safe aliases without inferred names, employers, titles, or relationships.
- [ ] Decision process uses every listed Person's localized functional role and makes the supported
      action → response/correction/approval → result sequence understandable. It does not replace
      known roles with generic `the team`.
- [ ] Decision process expresses the actual supported relationship with natural syntax and explicit
      roles. A connective is optional; no lexical allowlist or occurrence count gates readiness,
      and the wording never manufactures or strengthens a relationship beyond Evidence.
- [ ] Omit a missing objection, reply, second actor, or consensus. Fabrication cannot be used to
      make the Chapter sound interactive.
- [ ] Every Chapter has at least one evidence-supported Person. Empty People fails activation with
      `STORY_VALIDATION_FAILED`. Later human Privacy redaction may hide a supported Person without
      changing the original activation proof.
- [ ] Routine machine-only events remain Timeline/Exact Evidence data. A machine failure can support
      a Chapter only when a supported actor diagnoses, decides, executes, reviews, approves, or responds.
- [ ] Story is a structured, context-sufficient article with clear causal progression and uncertainty.
- [ ] Project Story remains scan-first while each Chapter is context-complete durable project memory;
      Chapter length follows decision-relevant Evidence density and has no global word, sentence,
      paragraph, or character ceiling.
- [ ] Chapter prose preserves supported problem/purpose, constraints, prior attempts, failures or
      rejected approaches, participant interaction, disagreement, correction, directional evidence,
      owner/reviewer intervention, decision/rationale, action/outcome, quantitative result,
      uncertainty, and reusable learning without becoming a raw log or audit report.
- [ ] Evidence-driven narrative validation covers the complete coherent arc, supported chronology,
      attribution, uncertainty, and Evidence identity without requiring a lesson or universal role
      template. Insights are validated independently only when present.
- [ ] Bounded source/readiness validation maps Story blocks and existing Insights to exact Evidence;
      missing or failed validation keeps Build Project Story active.
- [ ] Chapter validation preserves every supported unit that explains background, causal or temporal
      relationships, participant interaction, judgment, failure, durable progress, substantive
      iteration, result, or open state in a traceable Story block. Do not require unsupported
      universal problem/final-action/result roles, and never invent a judgment moment.
- [ ] A context-retention ledger classifies every reviewed conversational or independently meaningful
      nested source unit in the complete milestone Evidence cluster. Each represented unit has a
      stable privacy-safe identity, exact Evidence, Story block IDs, and matching factual-claim
      `unitIds`; each exclusion uses only duplicate, routine-status, outside-milestone, or
      Privacy-withheld. Multiple units sharing one Evidence event remain distinct, and no source copy
      enters the ledger or release.
- [ ] Every material factual claim has exact Chapter-contained Evidence traceability, every Person
      and Story block has support, every existing Insight has explicit Evidence inputs, and none of
      this local metadata enters release/export.
- [ ] Every Chapter title is followed by a distinct localized summary of that Chapter's supported
      background, consequential participant turn or judgment, and result/open boundary. Navigation
      instructions, repeated boilerplate, untraced claims, and exact copies of one source field fail
      readiness. Concrete detail and varied rhythm improve readability without invented color.
- [ ] No Story block requires an inline lesson. Optional passage assistance, when retained later,
      remains Story-grounded, local, human-facing, non-authoritative, non-readiness, and non-release.
- [ ] Generic activity titles and prohibited filler fail Story activation regardless of length.
- [ ] Visible Story headings are the neutral localized equivalents of Background, Decision process,
      Result, and Open questions; no empty or generic-filler-only heading renders.
- [ ] Story and every existing Insight use standard terminology and direct neutral
      prose with no metaphor, analogy, slogan, literary framing, colloquial phrasing,
      anthropomorphism, `X, not Y` contrast formula, vague boilerplate, or invented cause/outcome.
- [ ] Unknown causes use the localized equivalent of `Cause not determined.`
- [ ] In read mode, double-clicking only reviewable Story copy enters Edit Mode, focuses the owning
      semantic passage, preserves a safe selection/caret when possible, and creates no mutation;
      the pencil remains the primary accessible entry.
- [ ] Final reviewed Chapters are explicitly reusable human/future-Agent project memory, with no
      hidden model reasoning or unsupported retrospective causality.
- [ ] Default read mode remains clean; accessible pencil/Edit enters a visibly contained review
      surface without uncontrolled DOM mutation.
- [ ] Each Chapter carries `0..n` independently warranted Insights; each existing Insight uses
      Background, Quote, Directly Acquired Experience, and Principle and is labeled interpretation.
- [ ] Insight copy is concrete, project-specific, Evidence-grounded, and avoids generic formulas.
- [ ] Accept/remove/direct edit/human-directed revise work without a full chat UI.
- [ ] Accept immediately changes to `Accepted — pending Apply review` with a restrained status icon,
      accessible live announcement, and updated pending count. Do not preserve has equivalent
      feedback, the decision can change before Apply, and Apply identifies the current revision.
- [ ] Insight feedback survives refresh and EN/中文 switching, preserves paired-language debt and
      Reopen, and never changes publication state or claims Saved/Final/Published early.
- [ ] If a later consumer retains passage assistance, stable Story-block navigation remains local
      and accessible without becoming a reviewable Insight or browser model call.
- [ ] Passage assistance remains optional; missing keys do not fail `/3` source import/readiness and
      no generic fallback or fabricated lesson is generated.
- [ ] Any retained passage-assistance copy is excluded from release; Chinese remains optional and an
      unsafe sidecar is omitted without blocking English.

## Direct selection and legacy annotation compatibility

- [ ] Selecting Story text never opens a Delete/Revise/Add action window in read or Edit mode.
- [ ] In Story Edit Mode, typing replaces the native selection and Backspace/Delete removes it through the controlled direct-edit ledger.
- [ ] Text selection preserves the native range without causing a rerender; block focus may synchronize local passage assistance without creating review state.
- [ ] Existing imported exact-range annotations retain block ID, start, end, selected text, language, base revision, type, instruction, and resolution.
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
- [ ] Leaving Edit Mode clears only transient editor state; saved pending/applied review state remains.
- [ ] Annotation notes and their UI metadata are absent from release/export.

## Direct Story editing

- [ ] Default read mode is clean; Edit mode visibly says `Editing Story`, explains direct typing,
      and exposes labeled Undo, Redo, and Finish editing controls.
- [ ] No floating Delete/Revise/Add popover appears when direct-editor text is selected.
- [ ] Caret insertion, selection replacement, Backspace/Delete, ordinary navigation, and plain-text
      paste update a controlled working draft rather than bypassing review state.
- [ ] Missing/unknown `inputType`, null/undefined `data`, and reduced SyntheticEvent/nativeEvent
      shapes never call string methods on unknown fields and never crash.
- [ ] `beforeinput` is optional metadata: incomplete events fall back to one minimal controlled
      previous→next mutation, `beforeinput` + `change` create one transaction, and IME composition
      commits only the stable result.
- [ ] Paste strips markup/scripts/embeds, preserves safe text/paragraph breaks, and adds no rich-text dependency.
- [ ] One contiguous typing burst in one block coalesces; independent non-overlapping block/ranges
      retain distinct transaction/note identities.
- [ ] Each transaction stores stable Chapter/block/language/base-revision identity, operation,
      before/after text/ranges, resolution, and applied revision/evidence linkage when required.
- [ ] Apply, All set, and release reject any transaction whose Story key differs from the owning
      primitive Chapter key.
- [ ] Ctrl/Cmd+Z, Ctrl/Cmd+Y, Ctrl/Cmd+Shift+Z, and visible buttons synchronize working copy,
      transaction state, and notes; disabled states have accessible explanations.
- [ ] Undo targets the most recently changed pending transaction after coalescing, not merely the
      most recently created ledger entry.
- [ ] Pending Discard restores only that effect and keeps unrelated edits. Applied history exposes
      Revert in a new revision and is never destructively undone.
- [ ] Applied Revert creates a distinct exact-inverse transaction, rejects overlap, and cannot clear
      reviewed-Evidence debt from an unrelated factual addition.
- [ ] A new direct edit after revision-ready returns the Chapter to reviewing and disables All set.
- [ ] Inline wording edits inherit the owning block only when they add no unsupported factual claim;
      new standalone sentences/numbers/paths/paragraphs fail visibly as `needs_evidence` until exact
      reviewed support resolves.
- [ ] Cross-block or overlapping mutations are atomic or visibly rejected with every passage unchanged.
- [ ] Active-locale direct edits create paired-language debt without copying replacement prose into
      the other locale; one shared revision/confirmation history remains authoritative.
- [ ] Paired-language debt is one informational entry per semantic block/target locale and one
      complete paired-block review clears it even when several source-locale ranges changed; it
      never blocks canonical English review.
- [ ] Notes show readable operation/state/language and concise before→after, not offsets, IDs, or JSON.
- [ ] Language switching keeps both locales' pending notes inspectable while exact inline range
      styling and editor selection remain active-locale only.
- [ ] Note click focuses/highlights the affected passage/range; narrow layouts keep notes accessible
      without shrinking Story or causing horizontal overflow.
- [ ] Pending/applied/reverted transactions, redo state, notes, passage assistance, and selection
      metadata are absent from actual reviewed JSON, HTML, and ZIP serialization.

## Iterative lifecycle

Demonstrate this complete sequence in tests and browser QA:

1. [ ] Initial AI draft, revision 1, reviewing, publication false.
2. [ ] Create a first controlled direct edit.
3. [ ] All set unavailable while pending.
4. [ ] Resolve required Privacy.
5. [ ] Apply review produces revision 2.
6. [ ] Revision 2 Story remains directly editable.
7. [ ] Create a second direct edit on revision 2.
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
- [ ] Evidence-supported Add receives `appliedRevision`, enters the next draft, and can complete canonical English review without a localization gate.
- [ ] A real evidence ID plus arbitrary unsupported Add wording remains `needs_evidence`; checkbox/ID possession alone never certifies a factual claim.
- [ ] Applied annotations do not expose Cancel; reversal requires a new pending operation and revision.
- [ ] Redact suppresses all bound targets in the allowlisted English release projection and every
      included safe localization, while Keep preserves permitted safe copy.
- [ ] Pending insight changes disable All set; stale localization remains visible but non-blocking.
- [ ] Accepting a localized pending insight edit does not erase its informational paired-language debt.
- [ ] Summary counts and revision labels are correct.
- [ ] Human intent is not silently dropped.
- [ ] Pending/forged insight state, latest Privacy-history disagreement, and a forged
      `redactedBlocks` set each block All set and release projection.

## Privacy

- [ ] One candidate at a time with progress.
- [ ] Visible fields are Local original and Why AI flagged it, followed by Keep/Redact.
- [ ] Suggested Release/recommendation copy is absent in English and every available localization.
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
- [ ] English alone can activate Stage 5, complete review, and export; no Chinese readiness gate remains.
- [ ] One shell-level `EN | 中文` control is compact when a safe Chinese sidecar exists and is hidden when it does not.
- [ ] Chinese changes Timeline Story labels and full Chapter presentation.
- [ ] Chinese localizes every existing Insight's optional title and four meanings, participant
      identity explanations, status/annotation copy, and review blockers; nontechnical English
      placeholder sentences do not remain.
- [ ] Chinese localizes Story read/Edit guidance, margin notes, optional passage assistance, and
      Insight controls while sharing one semantic/review state when successor review is active.
- [ ] Switching back restores equivalent English.
- [ ] Every declared semantic anchor/technical identifier is present in canonical English. Chinese alignment is non-gating.
- [ ] Annotation/Privacy/revision/All set state survives language switching.
- [ ] One lifecycle/confirmation history drives both languages.
- [ ] Evidence content remains source-language.
- [ ] Localization debt remains visible but does not block Apply review or All set; stale localized copy is omitted from release.

## Independent clean-room completion gate

- [ ] Create a new clone from the exact candidate snapshot with no prior generated Story data,
      validation reports, or failed-run residue.
- [ ] Give a completely fresh contextless Agent only the normal public Oxygen workflow request; do
      not name Storytelling, describe the expected UI/counts, provide hidden conversion steps, or
      include prior task/chat history.
- [ ] The Agent independently follows root routing into the one canonical Viewer and completes the
      integrated Privacy, Story direct review, evidence, Preferences, Release preview, and package
      workflow from the approved reviewed artifact boundary.
- [ ] Record every intervention. Environment/user-input help may be disclosed, but any
      Storytelling-specific steering or copied project-local generated data invalidates the run.
- [ ] Unit/build success does not waive this gate. After any material fix, use a new exact snapshot,
      new clean clone, and brand-new contextless Agent.

## Automated validation

Run the repository's required commands. For the Oxygen Viewer this normally includes:

```bash
cd viewer
node --test --test-name-pattern="active generation contracts" tests/story-productization.test.mjs
npm test
npm run build
```

Also run:

- repository-pinned ESLint on `tests/story-productization.test.mjs`;
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
4. contained direct Story Edit Mode with zero-guesswork guidance;
5. caret insertion, selection replacement/deletion, Undo/Redo, and multiple left-margin notes;
6. pending Discard plus applied Revert-in-a-new-revision;
7. native selection replacement/deletion with no floating action window;
8. optional passage-assistance state when a version-specific presentation exposes it;
9. Next/Previous with owning-block scroll/highlight and Story focus synchronization when present;
10. canonical `/3` sparse-Insight presentation and compatibility `/2` single-Highlight regression;
11. Privacy available mode;
12. Privacy unavailable mode;
13. gated completion and clean revision-ready state;
14. Final Release Memory and Reopen review;
15. exact Evidence with Back to chapter;
16. Chinese Chapter with shared review state/debt;
17. narrow Chapter fallback for notes and contextual assistance.
18. a long multi-step Chapter with readable Story width, optional local passage assistance, aligned
    notes, independent left navigation, reachable Insights when present, no horizontal overflow, and
    usable narrow/mobile flow.

Review at least one simple Chapter, one disagreement/decision Chapter, one failure/root-cause
Chapter, one long multi-step technical Chapter, and one Chapter with an unresolved question. Do not
expect equal lengths. Compare participant, decision, alternative, disagreement, correction,
consequence, and unresolved-issue coverage semantically; do not use exact wording or string-overlap
scores.

Check console errors and responsive layout. Preserve the user's visible review state or reset prototype-only QA edits before handoff.

## Material-equivalence comparison

Two implementations need not be pixel-identical. They are materially equivalent only when all of these match:

- information architecture;
- reading hierarchy and density;
- retained application context;
- direct Chapter/evidence navigation;
- controlled direct document editing with no redundant selection-action popover;
- synchronized Undo/Redo, Discard, and revision-based applied Revert;
- optional passage-assistance local-only boundary;
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
