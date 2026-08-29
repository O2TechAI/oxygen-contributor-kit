# Chapter Review Lifecycle

## Review State Machine

The Chapter review loop is iterative:

```text
initial AI draft, revision 1, reviewing
-> direct human edits and/or imported exact-range review records
-> Apply review
-> revised draft, revision 2, revision_ready
-> human reviews and may edit again
-> Apply review again
-> ...
-> All set
-> human_confirmed Final Release Memory
-> optional Reopen review
-> reviewing
```

The implemented stages are:

```ts
type ChapterReviewStage = "reviewing" | "revision_ready" | "human_confirmed";
```

Apply review is never finalization. All set confirms the current clean revision locally and does not increment the revision or approve publication.

## Implemented Session Shape

The current Story review session stores exactly:

```ts
type StoryReviewSession = {
  schema: "oxygen.story-review-session";
  workflowRunId: string;
  chapterReviews: Record<string, ChapterReviewState>;
  privacyDecisions: Record<string, "keep" | "redact">;
  updatedAt: string;
};
```

It does not store Preference answers, source redaction spans, Story source candidates, coverage manifests, release originals, evidence payloads, hidden prompts, or private notes.

Current source-bound hydration accepts only sessions matching the active workflow run and exact `oxygen.story` Chapter set. On this base, nonempty top-level `privacyDecisions` are not restored during hydration; do not claim Story/Release Privacy is complete unless an implemented candidate authority provides and applies those decisions.

## Chapter Review State

Each Chapter review state contains:

```ts
type ChapterReviewState = {
  stage: ChapterReviewStage;
  revision: number;
  annotations: StoryReviewAnnotation[];
  editTransactions: StoryEditTransaction[];
  redoTransactionIds: string[];
  sourceInsightReviews: Record<string, SourceInsightReview>;
  humanInsights: Record<string, HumanInsightReview>;
  insightRevisionHistory: InsightRevisionRecord[];
  appliedPrivacyDecisions: Record<string, "keep" | "redact">;
  redactedBlocks: string[];
  staleTranslations: TranslationStaleness[];
  revisionHistory: ChapterRevisionRecord[];
  evidenceVerified: boolean;
  publicationApproved: false;
};
```

Unknown fields fail closed. `publicationApproved` must remain false.

## Direct Editing

Direct Story editing is the primary current behavior. Every mutation is an app-controlled plain-text transaction anchored to one Chapter, one Story block, one language, and one base revision:

```ts
type StoryEditTransaction = {
  id: string;
  storyKey: string;
  blockId: string;
  sourceLanguage: "en" | "zh";
  baseRevision: number;
  operation: "insert" | "delete" | "replace";
  beforeText: string;
  afterText: string;
  beforeRange: { start: number; end: number };
  afterRange: { start: number; end: number };
  resolution: "pending" | "applied" | "reverted" | "needs_evidence";
  requiresEvidence: boolean;
  supportingEvidence?: EvidenceReference[];
  appliedRevision?: number;
  revertsTransactionId?: string;
  createdAt: number;
  updatedAt: number;
};
```

Caret insertion, selection replacement, deletion, and safe paste create controlled transactions. A continuous typing burst may coalesce. Cross-block or overlapping edits must be atomic or rejected visibly without changing text.

New standalone facts, numbers, links, paths, or paragraphs require exact reviewed Evidence support. Unsupported additions become `needs_evidence` and block All set.

Undo/Redo changes pending transaction state and working draft together. Pending Discard removes only that pending effect. Applied history is immutable; reversal creates a new exact-inverse pending transaction and must pass another Apply review.

## Imported Exact-Range Records

If an already-existing Delete, Revise, or Add record is imported, render it only after exact validation:

- same block;
- same source language;
- same base revision;
- pending or needs-evidence state;
- integer bounds;
- `0 <= start < end <= source.length`;
- `source.slice(start, end) === selection.text`;
- no overlapping same-revision pending range;
- unique annotation ID.

Do not expose a new Delete/Revise/Add creation window. Exact Evidence is never editable or annotatable.

## Apply Review

Apply review may run only when required Privacy decisions are complete for the implemented candidate authority and Evidence can be verified.

It must:

- resolve every unique Chapter Evidence reference to exactly one actual reviewed item;
- replay annotations and direct edits from immutable revision-1 Story blocks;
- reject stale, overlapping, duplicated, malformed, cross-Chapter, or unsupported work atomically;
- mark unsupported Add/direct factual work as `needs_evidence`;
- increment the Chapter revision on success;
- record applied annotation/edit IDs and applied Privacy decisions in revision history;
- preserve useful detail, failure, uncertainty, Evidence semantics, and human intent;
- keep publication false.

It must not finalize the Chapter, invent facts, restore Privacy-removed material, silently drop unresolved work, or claim release readiness.

## Insight Review

Every source AI Insight in the current `oxygen.story` source must receive an explicit applied Accept or Do-not-preserve decision for its current version. Editing an AI Insight creates a new version that requires a later Accept and Apply review.

A human-created Insight must use a `human:` ID, one same-Chapter Story anchor, safe selection provenance, and exact Evidence. Human Save approves the saved human-authored version and records its own revision. Zero source Insights create zero AI Insight obligations.

Completion checks must validate exact source Insight IDs, stable human IDs, current versions, same-Chapter anchors, grounding Evidence, and Insight revision history. Never infer approval from a missing entry, pending decision, older accepted version, or browser-supplied stage.

## All Set And Reopen

All set is available only when:

- stage is `revision_ready`;
- the latest revision has been presented for human inspection;
- no pending, reverted-active, or `needs_evidence` annotation/direct edit remains;
- every required implemented Privacy candidate has a Keep/Redact decision applied in the current revision;
- no Insight blocker remains;
- actual Evidence references were verified by the latest successful Apply.

Clicking All set changes only:

```text
revision_ready -> human_confirmed
```

Reopen review changes only:

```text
human_confirmed -> reviewing
```

Reopen preserves revision provenance, Story content, Privacy decisions, Insights, and publication separation. Another Apply/All set cycle remains possible.

## Release Boundary

No lifecycle action may upload, publish, submit, auto-create a package, or set `publication_approved=true`. Release projection reruns validation and strips local review state before producing `oxygen.reviewed-story`.

## Required Lifecycle Tests

Test at minimum:

1. initial revision 1 and false publication state;
2. direct edit returns stage to reviewing;
3. Privacy blocks Apply and All set when required current candidates are unresolved;
4. first Apply creates revision 2;
5. revision 2 can be edited again;
6. second Apply creates revision 3;
7. All set is unavailable with pending or needs-evidence work;
8. All set creates `human_confirmed` without publication change;
9. Reopen supports another cycle;
10. unresolved/missing/ambiguous Evidence blocks Apply and confirmation;
11. unsupported Add wording remains `needs_evidence`;
12. malformed or forged browser state blocks All set and release;
13. pending/applied/reverted transaction metadata is absent from release serialization.
