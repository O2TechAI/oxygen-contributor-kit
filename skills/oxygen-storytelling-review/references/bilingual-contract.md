# Bilingual contract

## Scope

Support:

```text
EN | 中文
```

English is the canonical fresh-session default. Mount one compact control in the retained application shell/top-right navigation so it remains globally discoverable across Project Story, Chapter, and Exact Evidence instead of creating separate page-local language controls. Local persistence is optional when straightforward, but a fresh/reset session must still have a clear English default.

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
- passage-context headings/copy and compact fallback;
- collapsed canonical AI insight title/observation/lesson/actions;
- selection toolbar and contextual editors;
- annotation type/state/cancel UI;
- Privacy title/summary/why-flagged/actions;
- review summary, blockers, Apply, All set, Reopen;
- Evidence-view chrome and Back labels.

Exact source evidence and technical identifiers do not translate as original content.

## Semantic equivalence

English and Chinese are two presentations of one Chapter, not independent Stories. They share:

- Chapter key/order/kind;
- participant IDs and safe release identity;
- semantic Story block IDs/structure;
- passage-context block-key set and supported meaning;
- inline insight IDs and review state;
- Privacy candidate IDs and decisions;
- evidence references;
- revision number/stage;
- annotations and provenance;
- Final Release Memory confirmation.

The language versions must preserve the same factual claims, causal relationships, failures, uncertainty, decisions, and lessons. Chinese should be natural editorial Chinese rather than literal word-for-word translation.

Apply the narrative-compression and voice rules from
[product-contract.md](product-contract.md) to both presentations. The English project summary is
normally 2–3 concise sentences; Chinese conveys the same start, turn, and current boundary in
equally economical natural prose rather than mirroring English sentence structure. Prefer one- or
two-word English Phase names and compact Chinese book-part labels without changing Phase semantics.
Chapter depth remains semantically equivalent in both languages: problem, constraints, attempts,
failures, evidence, decision/rationale, action/outcome, uncertainty, and reusable learning may use
different natural sentence structures but cannot diverge in claims. The canonical AI insight stays
concrete and project-specific in both languages rather than being forced to an arbitrary sentence
count.

Natural localization applies to every reader-facing Story field, including inline insight title/observation/lesson, participant identity explanations, status copy, annotation labels, and review blockers. Do not leave an English narrative sentence or UI explanation inside the Chinese presentation merely because its stable ID is shared. Exact technical identifiers and deliberately preserved product terms are the only expected unchanged strings.

Preserve exact benchmark/product names, metrics, code identifiers, versions, and other technical anchors when translation would reduce precision. Do not create different numbers or outcomes across languages.

## Presentation-data validation

Use stable shared keys and validate:

- exact Chapter-key set match;
- matching Chapter order;
- matching phase membership and Before/After transition semantics;
- matching evidence-backed chip facts, with natural localized wording around preserved technical anchors;
- matching participant/insight/privacy IDs;
- matching reconstruction and important-detail semantic block counts, or an explicit alignment map;
- matching passage-context key sets and equivalent evidence-grounded meaning when passage context is present;
- presence of every declared selected technical/semantic anchor in reader-facing fields of both language presentations, or an explicit bilingual alignment for a non-literal semantic anchor; reject absent and one-locale-only anchors;
- one shared evidence set;
- unavailable Privacy candidates have no excerpt in either language;
- available excerpts have one original source-language value, not separate translated originals.
- nontechnical Chinese Story/insight/identity/status fields are actually localized rather than copied wholesale from English.

An implementation may store English core Story plus a Chinese presentation sidecar or one combined bilingual object. Project-specific bilingual copy stays local, not hardcoded in generic frontend source.

## Shared review state

Do not key Chapter review state by language. Use the Chapter key. Do not key Privacy decisions by language. Use Chapter + candidate ID. Do not create separate All set histories.

Annotations preserve:

- shared semantic block ID;
- source language in which selection occurred;
- exact source-language offsets/text;
- one shared base/applied revision history.

Do not pretend an English character range maps exactly to Chinese. When applying cross-language changes, regenerate or conservatively update the equivalent semantic block. The paired result must remain semantically aligned.

## Language switching with annotations

Switching language must preserve:

- pending annotations;
- selected quote/instruction provenance;
- applied annotations;
- revision number;
- stage;
- Privacy decisions/progress;
- inline insight review;
- All set/Reopen state.

If exact selected-range styling cannot be shown in the other language because no safe alignment exists, keep the annotation visible as shared pending review metadata without inventing offsets. Never broaden to a whole paragraph solely to simulate alignment.

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
12. Chinese inline insights and identity/review explanations contain natural Chinese rather than English placeholder copy.
13. Read/Edit, margin-note, passage-context, and collapsed canonical-Insight controls localize while
    sharing one underlying semantic/review state.
