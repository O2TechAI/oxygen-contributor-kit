# Story data contract

## Separation of concerns

The reviewed contribution artifact remains the evidence source. Generated Story data is separate local metadata that references reviewed event IDs. It must not overwrite source content or embed project-specific copy in generic frontend source.

Keep project-specific:

- project overview;
- phase and Chapter copy;
- participant mapping;
- bilingual Story presentation;
- inline AI insight/lesson;
- Privacy candidate presentation;
- permitted local excerpts;
- prototype human review state;

outside reusable Skill/frontend fixtures.

## Stable identities

Use stable identities for:

- project;
- Chapter/story key;
- participant;
- semantic Story block;
- inline AI insight;
- Privacy candidate;
- primary/supporting evidence;
- human annotation.

Do not use rendered English text as the sole identity. Stable IDs are required for language switching, revision provenance, navigation restoration, and exact evidence linkage.

## Recommended Story envelope

The exact implementation shape may vary, but it must represent these semantics:

```ts
type EvidenceReference = {
  documentId: string;
  eventId: string;
  label?: string;
};

type StoryPerson = {
  id: string;
  releaseLabel: string;
  role: string;
  description: string;
  localIdentityState: "not_identified" | "local_only";
};

type StoryChapterCopy = {
  scene: string;
  reconstruction: string[];
  importantDetails: string[];
  decisionOutcome: string;
  uncertainty?: string;
};

type StoryInsight = {
  id: string;
  title: string;
  observation: string;
  lesson: string;
  evidence?: EvidenceReference[];
  initialReviewState: "ai_proposed";
};

type PrivacyOriginal =
  | { availability: "available"; excerpt: string; sourceLanguage: "en" | "zh" | string }
  | { availability: "unavailable" };

type PrivacyCandidate = {
  id: string;
  title: string;
  original: PrivacyOriginal;
  whyFlagged: string;
  required: boolean;
};

type LanguagePresentation = {
  phase: string;
  title: string;
  timelineSummary: string;
  before: string;
  after: string;
  timelineChips: string[];
  overview: string;
  people: StoryPerson[];
  story: StoryChapterCopy;
  insights: StoryInsight[];
  privacy: { summary: string; candidates: PrivacyCandidate[] };
};

type ChapterStory = {
  key: string;
  kind: string;
  importance: number;
  before?: string;
  after?: string;
  metric?: string;
  readingTimeMinutes: number;
  sourceScope: string;
  retained: string[];
  omittedLowValue: string[];
  omittedSensitive: string[];
  uncertainty?: string;
  evidence: { primary: EvidenceReference; supporting: EvidenceReference[] };
  sourceVersion: {
    defaultView: "release";
    originalState: "local_evidence_only";
    releaseState: "ai_prepared_draft";
  };
  presentation: { en: LanguagePresentation; zh: LanguagePresentation };
  semanticAnchors: string[];
};
```

Internal compatibility fields such as a privacy recommendation or former suggested-release copy may exist in legacy data. They are not approved visible UI and must not drive the human decision panel.

## Semantic Story blocks

Assign stable block IDs before rendering, for example:

```text
scene
reconstruction-0
reconstruction-1
detail-0
detail-1
outcome
uncertainty
```

The paired language presentations map to the same semantic block IDs, even when text lengths and literal offsets differ. An annotation preserves the language and exact offsets of the selection plus the shared semantic block ID.

## Evidence linkage

Every explicit Chapter must have one primary evidence reference anchored to an existing reviewed event. Supporting references may expand causal context. All references must resolve before import/render.

Preserve:

- exact document and event IDs;
- chronological order;
- source timestamps;
- source language;
- primary vs supporting role.

Do not invent a source link merely to satisfy a schema. If evidence cannot be resolved, omit or block the Chapter.

## Chapter-generation rules

For each Chapter:

1. Define one consequential transition and stable key.
2. Choose primary evidence and only necessary supporting evidence.
3. Write a concise Timeline summary.
4. Write short Timeline Before/After states and select only evidence-backed high-signal chips; keep long explanation out of the card.
5. Reconstruct a coherent article that preserves causal order and uncertainty.
6. Record what was retained, what routine material was compressed, and what sensitive material remains unavailable.
7. Generate an AI insight/lesson explicitly typed as interpretation.
8. Generate People only when supported.
9. Generate contextual Privacy candidates only from permitted reviewed information.
10. Generate natural Chinese with the same facts, transition semantics, scan chips, and technical anchors.
11. End the sequence with an honest current-state Chapter.

## Import and validation gates

Fail closed when any of these conditions is false:

- archive CRC and member paths are safe;
- manifest count matches actual reviewed data;
- `publication_approved` is false;
- Story source hash matches the reviewed artifact;
- Chapter keys are present and unique;
- Chapters are chronological;
- Chapter count is within the applicable product envelope;
- required Story fields are nonempty;
- project orientation can derive milestone count, meaningful phase count, reviewed-Highlight progress, and source/evidence context;
- every Timeline milestone has a date, visible selected-Highlight status, short before/after states, and only supported scan chips;
- every milestone belongs to a generated phase when phases are present;
- milestone kind/state is allowed;
- primary evidence matches the annotation anchor where that representation is used;
- all primary/supporting evidence resolves;
- AI insight starts as an AI proposal;
- release draft is the default Story view;
- bilingual key sets and semantic block structures align;
- required technical/semantic anchors appear in both presentations;
- available Privacy original has an excerpt and source language;
- unavailable Privacy original has no excerpt;
- the last Chapter is current state.

Malformed Story metadata should not fall back to confident invented copy. Stop with a clear local error or omit the invalid annotation and disclose the limitation.

## Review-state separation

Chapter review state is keyed by Chapter, not presentation language. Privacy decisions are keyed by Chapter + candidate. Insight review is keyed by Chapter + insight. Exact Story annotations are defined in [chapter-review-lifecycle.md](chapter-review-lifecycle.md).

Every Chapter review state includes an immutable publication boundary equivalent to:

```ts
publicationApproved: false
```
