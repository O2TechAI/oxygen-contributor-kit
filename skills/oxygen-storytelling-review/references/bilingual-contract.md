# Bilingual contract

## Scope

Support:

```text
EN | 中文
```

English is the canonical fresh-session default. Mount one compact control in the retained application shell/top-right navigation so it remains globally discoverable across Project Story, Chapter, and Exact Evidence instead of creating separate page-local language controls. Local persistence is optional when straightforward, but a fresh/reset session must still have a clear English default.

English is the canonical `oxygen.story/3` generation and source-readiness surface. Chinese is an
optional localized sidecar. Its absence, incomplete prose, semantic drift, or outstanding
translation debt cannot invalidate a valid English candidate or later block compatible review and
release. Canonical `/3` activation uses `oxygen.story-review-session/2` and server-owned
`oxygen.reviewed-story/2`; localization does not alter that mapping or turn source readiness into
human review completion. Hide the Chinese control when no complete safe sidecar is available. If
supplied Chinese breaks shared participant, Privacy, Evidence, or semantic-block identity, discard
that sidecar and continue with the validated English Story. Never weaken the English, Privacy, or
Evidence gates to preserve a localization.

## What localizes

Where Story presentation exists, switching language updates:

- global Storytelling navigation labels;
- Project Story title/overview labels;
- concise project-story summary and compact evidence-derived Phase names;
- phase and milestone-kind labels;
- Timeline Chapter title, concise Before/After states, high-signal chips, and read action;
- Chapter navigation, status, metadata, headings, and overview;
- People role/descriptions and identity explanation;
- Story prose and subheadings;
- Story read/Edit labels and helper copy;
- margin-note type/state/action UI;
- optional passage-assistance headings/copy when a later consumer retains it;
- zero or more Insight titles and Background, Quote, Directly Acquired Experience, and Principle;
- direct-selection replacement/deletion behavior and editor controls;
- direct-edit and compatible legacy-annotation note state/actions;
- Privacy title/summary/why-flagged/actions;
- review summary, blockers, Apply, All set, Reopen;
- Evidence-view chrome and Back labels.

Exact source evidence and technical identifiers do not translate as original content.

## Optional semantic equivalence

English and Chinese are two presentations of one Chapter, not independent Stories. They share:

- Chapter key/order/kind;
- participant IDs and safe release identity;
- semantic Story block IDs/structure;
- optional passage-assistance block keys when present;
- Insight IDs, safe Story anchors, and eventual independent review state;
- Privacy candidate IDs and decisions;
- evidence references;
- revision number/stage;
- annotations and provenance;
- Final Release Memory confirmation.

Every Chapter retains at least one Evidence-supported Person or actor in both presentations.
Determine complete coherent Chapter arcs first, then group adjacent Chapters into precise one- or
two-word Phases; localization must not use Phase or Insight wording to change Chapter boundaries.

When Chinese is present, it should preserve the same factual claims, causal relationships,
failures, uncertainty, decisions, and Insight meanings when present. Chinese should be natural editorial Chinese rather
than literal word-for-word translation. These are localization quality goals, not activation gates.

Apply the semantic-coverage and voice rules from
[product-contract.md](product-contract.md) to both presentations. The English project summary is
normally 2–3 concise sentences; Chinese conveys the same start, turn, and current boundary in
equally economical natural prose rather than mirroring English sentence structure. Prefer one- or
two-word English Phase names and compact Chinese book-part labels without changing Phase semantics.
Each Chapter overview is a distinct localized summary of that Chapter's supported background,
participant turn or judgment, and result/open boundary. English and Chinese may use different
sentence rhythm, but both remain concrete, engaging, Evidence-traced, and free of repeated
navigation boilerplate.
Chapter depth remains semantically equivalent in both languages: participants, problem,
constraints, alternatives, disagreement, corrections, attempts, failures, directional Evidence,
decision/rationale, action/outcome, and uncertainty may use different natural
sentence structures but cannot diverge in claims. Shared coverage-ledger and claim-traceability
identities prove the same semantic material even when sentence boundaries differ. Story remains
complete before Insight selection. Each Chapter preserves `0..n` Insight identities without a quota;
each existing Insight keeps exactly Background, Quote, Directly Acquired Experience, and Principle.
Insight title is optional presentation metadata.

Natural localization applies to every reader-facing Story field, including existing Insight title
and four meanings, participant identity explanations, status copy, annotation labels, and review
blockers. Quote remains a safe reviewed Story anchor and never copies raw/private Evidence. Do not
leave an English narrative sentence or UI explanation inside the Chinese presentation merely
because its stable ID is shared. Exact technical identifiers and deliberately preserved product
terms are the only expected unchanged strings.

Preserve exact benchmark/product names, metrics, code identifiers, versions, and other technical anchors when translation would reduce precision. Do not create different numbers or outcomes across languages.

## Presentation-data validation

Validate the English presentation independently. For an optional Chinese sidecar, use stable shared
keys and validate the following safety identities before displaying or exporting it:

- exact Chapter-key set match;
- matching Chapter order;
- matching participant/insight/privacy IDs;
- matching reconstruction and important-detail semantic block counts, or an explicit alignment map;
- safe optional passage assistance when present; it is not a source-readiness gate;
- one shared current semantic-manifest and normalized coverage-manifest identity; unit coverage,
  Evidence identities, and Story block mappings are language-independent, while exact unit
  membership stays server/tool-owned;
- presence of every required technical/semantic anchor in canonical English; matching Chinese
  anchors are desirable but do not gate the English package;
- one shared evidence set;
- unavailable Privacy candidates have no excerpt in either language;
- available excerpts have one original source-language value, not separate translated originals.
- nontechnical Chinese Story/insight/identity/status fields are actually localized rather than copied wholesale from English.

Store English core Story plus an optional Chinese presentation sidecar. Project-specific localized
copy stays local, not hardcoded in generic frontend source. A malformed sidecar is omitted; it does
not invalidate the English core.

## Shared review state

Do not key Chapter review state by language. Use the Chapter key. Do not key Privacy decisions by language. Use Chapter + candidate ID. Do not create separate All set histories.

Annotations preserve:

- shared semantic block ID;
- source language in which selection occurred;
- exact source-language offsets/text;
- one shared base/applied revision history.

Direct-edit transactions preserve the same shared Chapter/block identity plus active-locale
before/after text and ranges. Editing one locale updates only that locale's working draft and may
mark the paired semantic block stale when a sidecar exists. Track this as informational debt once
per semantic block/target locale. It never blocks the canonical review. Omit a stale localized
sidecar from release instead of silently translating or exporting divergent copy. Undo/Redo
operates on active-locale pending transactions while the revision, evidence, Privacy, All set, and
Reopen lifecycle remains shared.

Do not pretend an English character range maps exactly to Chinese. When applying cross-language changes, regenerate or conservatively update the equivalent semantic block. The paired result must remain semantically aligned.

## Language switching with annotations

Switching language must preserve:

- pending annotations;
- selected quote/instruction provenance;
- applied annotations;
- revision number;
- stage;
- Privacy decisions/progress;
- independent Insight review state for every existing Insight when successor review is active;
- All set/Reopen state.
- direct-edit notes, pending/applied/reverted state, redo provenance, and paired-language debt.

If exact selected-range styling cannot be shown in the other language because no safe alignment exists, keep the annotation visible as shared pending review metadata without inventing offsets. Never broaden to a whole paragraph solely to simulate alignment.

Keep pending and applied review notes inspectable after language switching. Label each note's source
language and restrict exact inline styling or editor selection to its owning locale; do not hide
shared blockers merely because the other presentation is active.

## Evidence language rule

Story can switch language; Evidence remains source-language. Localize only the surrounding Evidence UI. Never translate Evidence and present it as original.

## Required tests

1. fresh state defaults to English;
2. Chinese updates Timeline and Chapter Story content, not just buttons;
3. switching back restores equivalent English content;
4. technical anchors and evidence IDs remain stable;
5. an annotation created in English survives Chinese and return;
6. an annotation created in Chinese survives English and return;
7. one Apply revision is visible in both presentations;
8. one Privacy decision map drives both;
9. one All set confirmation drives both;
10. exact Evidence stays in original language.
11. the single shell language control remains discoverable on Project Story, Chapter, and Exact Evidence;
12. Chinese Insights and identity/review explanations contain natural Chinese rather than English placeholder copy.
13. Read/Edit, margin-note, optional passage-assistance, and Insight controls localize while sharing
    one underlying semantic/review state when successor review is active.
14. direct editing one locale changes only that working draft; any paired-locale debt is visible but
    non-blocking, and Undo/Redo never forks revision or confirmation history.
15. optional passage-assistance navigation follows the same stable Story-block sequence in both languages when present.
16. an English-only Chapter activates, completes review, and exports without a Chinese sidecar.
17. an unsafe Chinese sidecar is omitted while the validated English Story remains reviewable.
