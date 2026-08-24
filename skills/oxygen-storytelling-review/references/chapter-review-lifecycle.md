# Chapter review lifecycle

## State machine

The review loop is iterative, never one-shot:

```text
initial AI draft (revision 1, reviewing)
  → human adds annotations
  → Apply review
  → revision 2 (revision_ready)
  → human reviews and may add annotations
  → reviewing
  → Apply review
  → revision 3 (revision_ready)
  → ...
  → All set
  → human_confirmed Final Release Memory
  → optional Reopen review
  → reviewing
```

Use three conceptual stages:

```ts
type ChapterReviewStage = "reviewing" | "revision_ready" | "human_confirmed";
```

The initial draft is revision 1. Each successful Apply review increments the revision. All set does not increment it; it confirms the currently presented clean revision.

## Annotation model

Store at least:

```ts
type StoryAnnotation = {
  id: string;
  blockId: string;
  type: "delete" | "revise" | "add";
  sourceLanguage: "en" | "zh";
  selection: { start: number; end: number; text: string };
  instruction?: string;
  resolution: "pending" | "applied" | "needs_evidence" | "cancelled";
  baseRevision: number;
  appliedRevision?: number;
};

type ChapterReviewState = {
  stage: ChapterReviewStage;
  revision: number;
  annotations: StoryAnnotation[];
  evidenceVerified: boolean;
  publicationApproved: false;
};
```

The annotation identity is semantic block + exact source-language selection + revision context, not English text alone.
Annotation IDs are nonempty primitive strings and globally unique within the Chapter across every resolution, including pending, applied, needs-evidence, and cancelled. Pending ranges in the same block, language, and base revision must not overlap; reject a conflicting annotation instead of allowing one revision record to claim that both were applied.

## Exact-range invariant

Render pending styling only when every condition holds:

- annotation block equals rendered block;
- annotation language equals rendered language;
- annotation base revision equals current revision;
- resolution is pending;
- start/end are integers;
- `0 <= start < end <= source.length`;
- `source.slice(start, end) === selection.text`.

If validation fails, render the Story normally and show no broadened styling. Never underline the parent paragraph merely because it contains an annotation.

Build inline segments from all unique valid boundaries. This permits multiple non-overlapping annotations in one paragraph to render independently and permits cancellation of one without changing another.

Reject a selection when both endpoints do not belong to the same reviewable semantic copy element. Do not expand a cross-paragraph selection to whole blocks.

## Delete

Delete means: remove the selected generated Story text from the next release draft.

- Store the exact selection as pending.
- Keep the underlying current draft recoverable until Apply review.
- Do not delete or alter source evidence.
- On Apply, remove the exact source-language span. For a paired language without safe literal alignment, conservatively suppress or regenerate the equivalent semantic block; do not invent an offset.

## Revise

Revise opens a contextual instruction input such as `What should be corrected here?`.

- Require a nonempty trimmed instruction.
- Store it with the exact span.
- On Apply, treat the human correction as authoritative.
- Preserve uncertainty and surrounding useful detail.
- In a deterministic local prototype, the human instruction may appear directly as the corrected wording if no safe model integration exists. Do not pretend an external AI ran when it did not.

## Add

Add opens a contextual input such as `What is missing here?`.

- Anchor the instruction to the selected semantic Story position.
- Incorporate it only when support exists in permitted reviewed evidence/context.
- Resolve the cited evidence against actual reviewed items and verify the proposed factual wording/content; a checkbox or matching ID alone is insufficient.
- When support cannot be proven, set `needs_evidence`; do not add the factual claim.
- `needs_evidence` remains visible and blocks All set until resolved or cancelled.

## Pending visibility and cancellation

Unresolved work should be visible but restrained:

- exact inline range styling;
- type and resolution;
- exact selected quote;
- human instruction when present;
- Cancel annotation.

Present the same ledger entry as a Word/Docs-like note beside its stable Story block on wide screens
and as a compact block-associated inline note on narrow screens. Selecting a note focuses its exact
validated range. The note is presentation metadata only: it does not duplicate, replace, or bypass
the annotation ledger, and it never enters release output.

Cancellation is available only for `pending` or `needs_evidence` work and changes only that unresolved annotation to cancelled. Cancelling still returns/stays in reviewing until another Apply presents the resulting revision. Never expose Cancel for an applied annotation: reversing applied content must be represented as a new pending operation and pass through another Apply.

Story Read/Edit mode is also presentation state only. Leaving Edit clears transient selection and
toolbar state but never deletes pending/applied annotations or revision provenance. Precomputed
passage context does not create annotations, insight-review state, or lifecycle transitions.

## Apply review contract

Apply review means only: apply currently pending human annotations and present another draft.

It must:

- require complete required Privacy decisions;
- require every unique Chapter evidence reference to resolve to exactly one actual reviewed item;
- replay the complete stored annotation ledger from immutable revision-1 Story blocks and validate every applied/cancelled/needs-evidence record, ID, base/applied revision, exact quote, and revision-history link before any mutation;
- validate every pending annotation against the current block, language, revision, offsets, and exact selected quote before applying any annotation;
- reject an overlapping, stale, mismatched, duplicated-ID, malformed non-pending record, or otherwise invalid collection atomically without incrementing the revision or marking any annotation applied;
- increment the revision;
- apply Delete, Revise, and evidence-supported Add in revision order;
- preserve unaffected useful detail, failures, disagreement, uncertainty, and causal relationships;
- preserve evidence semantics and Privacy decisions;
- keep the resulting Story fully annotatable;
- record `appliedRevision` for applied work;
- surface unsupported Add as `needs_evidence`.

It must not:

- finalize the Chapter;
- invent facts or evidence;
- restore privacy-removed material;
- override explicit human intent;
- silently drop unresolved work;
- change publication approval.

Apply annotation groups in ascending revision order; within one revision, process spans from later offsets to earlier offsets so earlier edits do not invalidate later positions.

Final release projection must run the same full-ledger replay validation. It must omit/fail closed on malformed applied provenance rather than silently skipping an invalid range while claiming the instruction was applied.

The same fail-closed rule applies to non-annotation final state. Before All set and again before
release projection, validate that:

- every stored insight review belongs to the Chapter's single declared insight;
- no insight review is pending;
- the current applied insight state points to the latest revision record that names it;
- revision history does not name an unknown insight;
- applied Privacy decisions contain exactly the current candidate IDs and typed Keep/Redact values;
- the latest revision record contains exactly those applied Privacy decisions;
- the stored redacted-block set exactly equals the union of release targets for candidates whose
  latest applied decision is Redact.

Never trust a browser-supplied `human_confirmed` stage, rejected insight flag, Privacy map, or
redacted-block array without this provenance check. A mismatch blocks confirmation/release rather
than exporting an approximation.

When an insight edit creates paired-language review debt, a later status-only action such as Accept must preserve that pending-language provenance. Status changes cannot erase bilingual debt without reviewing/applying the paired representation.

## Review summary

Derive compact counts from non-cancelled annotations:

- revisions;
- additions;
- removals;
- unresolved work;
- completed / total required Privacy decisions.

Show one Apply action while reviewing. Disable it until required Privacy is complete. Do not create competing completion CTAs.

## All set

All set / `确认完成` is the only final human-confirmation action.

Enable it only when:

- stage is revision_ready;
- latest AI/local revision has been presented for human inspection;
- no pending annotation remains;
- no `needs_evidence` annotation remains;
- every required Privacy candidate has a Keep/Redact decision.
- no paired locale remains stale/unresolved;
- no inline-insight operation remains pending;
- the current Privacy decisions are the same typed decisions applied in the presented revision.
- the latest successful Apply verified the Chapter's actual evidence references.

Clicking it sets stage to human_confirmed without changing the revision or publication state. Show `Final Release Memory` plus a note that confirmation is local and not publication approval.

Creating another annotation after a revision returns the Chapter to reviewing and removes All set until the new work is applied.

## Reopen review

Provide a quiet Reopen review action on a human-confirmed Chapter. Reopen changes:

```text
human_confirmed → reviewing
```

Preserve revision provenance, Story content, Privacy decisions, and one shared bilingual history. Another Apply/All set cycle can create a newer confirmed version.

If the confirmed revision applied `Do not preserve` to the Chapter's insight, Reopen must make that
same insight available for review again. A human can create a new pending Accept/override operation,
Apply it as another revision, inspect the restored insight, and then use All set. Do not erase the
prior rejection record or restore it merely by changing the stage.

## Publication boundary

No lifecycle action may:

- upload;
- publish;
- submit;
- automatically create a package;
- set `publication_approved=true`.

Final Release Memory means only that this Chapter's release representation completed iterative human review.

## Required lifecycle tests

Test at minimum:

1. initial revision and false publication state;
2. annotation returns stage to reviewing;
3. Privacy blocks Apply and All set;
4. first Apply produces revision 2;
5. revision 2 can receive a new annotation;
6. second Apply produces revision 3;
7. All set unavailable with pending or needs-evidence work;
8. All set available on clean revision 3 with complete Privacy;
9. All set creates human_confirmed without publication change;
10. Reopen returns to reviewing and supports another cycle;
11. English and Chinese expose the same stage/revision/history.
12. unresolved/missing/ambiguous evidence blocks Apply and confirmation;
13. a real evidence ID with unsupported Add wording remains `needs_evidence`;
14. overlapping or stale annotation batches fail atomically without a new revision;
15. duplicate IDs across cancelled/pending states and malformed pre-applied records fail atomically and cannot enable All set or release projection;
16. localized insight edit followed by Accept still creates paired-language review debt;
17. forged pending/applied insight state, Privacy history disagreement, or redacted-target mismatch blocks All set and release;
18. Reject → Apply → All set → Reopen → Accept/override → Apply restores the insight through a new revision while preserving provenance.
