# Story Data Contract

This file mirrors the final production parser in `viewer/lib/timeline.ts`, review-session parser in `viewer/lib/story-review-session.ts`, and release serializer in `viewer/lib/story-release.ts`.

## Source Prefix And Schema

Generated Story candidates are stored in reviewed item summaries as:

```text
prefix: oxygen.story:
schema: oxygen.story
```

The serialized form is the literal prefix followed by JSON:

```text
oxygen.story:{"schema":"oxygen.story",...}
```

Rows with a different prefix or schema are not current Story candidates. Unknown fields, duplicate semantic IDs, malformed references, stale coverage, or invalid ordering fail closed.

## Source Type

The canonical Story source shape is:

```ts
type EvidenceReference = {
  documentId: string;
  eventId: string;
  label?: string;
};

type StoryKind =
  | "foundation"
  | "discovery"
  | "baseline"
  | "problem"
  | "failure"
  | "root_cause"
  | "decision"
  | "direction_change"
  | "breakthrough"
  | "quantitative_change"
  | "validation"
  | "freeze"
  | "handoff"
  | "current_state";

type StoryPerson = {
  id: string;
  releaseLabel: string;
  role: string;
  description: string;
  localIdentityState: "not_identified" | "local_only";
  evidence: EvidenceReference[];
};

type StoryBlock = {
  id: string;
  text: string;
  evidence: EvidenceReference[];
};

type StoryInsight = {
  id: string;
  title?: string;
  background: string;
  quote: { storyBlockIds: string[] };
  directlyAcquiredExperience: string;
  principle: string;
  evidence: EvidenceReference[];
};

type StoryCoverage = {
  semanticManifest: { revision: number; digest: string };
  coverageManifest: { revision: number; digest: string };
  representedUnitIds: string[];
  excludedUnits: Array<{
    unitId: string;
    reason: "duplicate" | "privacy_withheld" | "routine_non_narrative" | "outside_story_scope";
  }>;
};

type StorySource = {
  schema: "oxygen.story";
  key: string;
  phase: { id: string; label: string };
  kind?: StoryKind;
  title: string;
  overview: string;
  transition?: { before: string; after: string };
  chips?: string[];
  people: StoryPerson[];
  story: {
    blocks: StoryBlock[];
    uncertainty?: string;
  };
  insights: StoryInsight[];
  evidence: {
    primary: EvidenceReference;
    supporting: EvidenceReference[];
  };
  coverage: StoryCoverage;
};
```

`key` is the stable Chapter identity. `phase.id`, `people[].id`, `story.blocks[].id`, and `insights[].id` are stable primitive-string identities. Display titles, rendered prose, array position, numeric coercion, and localized text are not identities.

## Evidence Rules

Each Evidence reference has `documentId`, `eventId`, and optional `label`. For activation, `eventId` must be the exact fully qualified imported item ID, and `documentId` must match that item. A bare suffix is rejected by package validation even if it would be easy to guess.

`evidence.primary` must identify the candidate row that carries the Chapter. `evidence.supporting` contains additional Chapter evidence and must not duplicate the primary reference.

Person, Story-block, and Insight evidence must all belong to the Chapter evidence set. Evidence belonging to an excluded semantic unit cannot support Story copy.

## Chapter, Phase, And Ordering

Candidate rows are ordered by the production comparator:

```text
timestamp -> documentId -> sequence -> row id
```

Every Chapter key must be unique. Phases are assigned only after Chapters are complete and ordered. A Phase ID must occupy one contiguous Chapter range, use one consistent one- or two-word label, and avoid generic labels such as `Project Evolution`, `General Work`, `Other`, or `Later Stage`.

`kind`, `transition`, and `chips` are optional presentation metadata. Emit `transition` only for an Evidence-supported before/after change. Emit at most 12 unique supported chips, each at most 200 characters. Absence is valid.

## People And Story Blocks

Every activated Chapter must have nonempty `people` and nonempty `story.blocks`. Each Person needs exact Evidence and a release-safe label/role/description. Preserve role uncertainty and never infer names, employers, titles, relationships, replies, consensus, or identity merges.

Each Story block is safe release-draft prose with exact Evidence support. Do not copy raw/private Evidence merely because the block cites it.

`story.uncertainty` is optional. Use it only for supported uncertainty. Do not fabricate a cleaner ending.

## Insights

`insights` is an array and may be empty. Each existing Insight has exactly these four meanings:

- `background`: minimum Story-grounded context for the judgment moment.
- `quote`: one or more safe Story-block anchors in the same Chapter.
- `directlyAcquiredExperience`: what was learned from that actual project moment.
- `principle`: a reusable rule, question, or guardrail for a genuinely similar future condition.

`title` is optional presentation metadata, not a fifth required meaning. Insight Evidence must be same-Chapter Evidence and must support at least one anchored Story block. Raw/private Evidence does not enter Insight text.

## Coverage Authority

Story carries only bounded coverage references:

- `coverage.semanticManifest.revision`;
- `coverage.semanticManifest.digest`;
- `coverage.coverageManifest.revision`;
- `coverage.coverageManifest.digest`;
- `coverage.representedUnitIds`;
- `coverage.excludedUnits`.

The semantic manifest and normalized coverage manifest are server/tool-owned authority. Story JSON must not contain exact unit member lists or per-event negative ledgers. Every semantic unit is represented exactly once by one Chapter owner or excluded exactly once with one authorized reason.

The local coverage draft contains `rows` only. Draft rows use only these shapes:

```ts
type CoverageDraftRow =
  | { unitId: string; disposition: "represented"; ownerId: string }
  | { unitId: string; disposition: "excluded"; exclusionReason: "duplicate" | "privacy_withheld" | "routine_non_narrative" | "outside_story_scope" };
```

The finalizer rejects omissions, overlaps, unknown unit IDs, structurally stale semantic authority,
invalid exclusion reasons, and any extra keys. It is a provider-free structural projection, not the
source-backed semantic validator: activation revalidates every semantic member/source digest before
anything can become durable, ready, reviewable, or releasable. Run it before activation:

```bash
node skills/oxygen-storytelling-review/scripts/finalize_story_coverage.mjs \
  work/<run>-review/project-map.json \
  work/<run>-review/story-coverage-draft.json \
  work/<run>-review/story-coverage-manifest.json \
  --source-privacy work/<run>-review/current-public-source-privacy.json
```

The first input may be either the canonical Organization project map or the bare semantic
manifest. A canonical project map has a finite 6,600,000-byte transport envelope: it carries the
bounded semantic membership twice (`semantic_units` and `semantic_manifest`), with one additional
2,200,000-byte manifest budget for deterministic JSON framing and bounded project metadata. The
finalizer checks that outer file bound on one opened file identity before decoding and rechecks the
bytes read. It then extracts only a real `semantic_manifest`, deterministically serializes that
inner authority, and applies the unchanged 2,200,000-byte semantic-manifest limit. A bare manifest
keeps the same 2,200,000-byte transport and authority limit.

Wrapper fields such as `semantic_units`, `summary`, source authority, and arbitrary metadata are
not forwarded to Source Privacy or Coverage validation and never enter the coverage output.

`--source-privacy` is required and accepts only the current public Source Privacy JSON
response/projection from the same reviewed run. The complete job must have zero rejected rows and
equal completed/total counts. Exact current semantic membership maps active final-redaction
decisions to units: `deterministic` and `confirmed_redact` authorize withholding; pending
`needs_confirmation` and `confirmed_keep` decisions do not. Completed-zero is explicit empty authority, not
an omitted fallback.

This authority is transport-only input. The final coverage manifest shape above does not change and
must not contain Source Privacy rows, authorized-unit lists, offsets, categories, reasons, source
text, or other Privacy metadata. Activation independently rederives the same set from current local
SQLite source, corpus, semantic membership, and Source Privacy state. Persisted coverage readback
does the same; stale or changed authority makes current coverage invalid.

After a successful activation, the exact submitted `story-coverage-manifest.json` becomes the prior accepted coverage authority for the next regeneration. If activation is rejected, that output is not prior authority. For regeneration, pass `--previous` only to a local copy of the exact manifest from the last successful activation:

```bash
node skills/oxygen-storytelling-review/scripts/finalize_story_coverage.mjs \
  work/<run>-review/project-map.json \
  work/<run>-review/story-coverage-draft.json \
  work/<run>-review/story-coverage-manifest.json \
  --source-privacy work/<run>-review/current-public-source-privacy.json \
  --previous work/<run>-review/story-coverage-manifest.accepted.json
```

## Public Story Preparation

The canonical project map and bare semantic manifest enter Story preparation through the same
bounded parser used by Coverage. Run the public prepare, record, and compose commands in
[story-preparation-transport.md](story-preparation-transport.md). The Story worker returns only base
Stories with empty `insights`; the dependent Insight worker returns Story-keyed Insight arrays.
The deterministic composer, not the caller, creates the final two-field candidate rows below.
Receipts and authority digests are recorder-owned and must never be handwritten.

Before Story preparation, finalize Coverage. The Story preparer binds that exact authority to the
same semantic generation and current public Source Privacy state, derives equality-only actor facts
and redacted narrative from the canonical reviewed run, and persists no raw actor identity or
pre-redaction content. The recorder and finalizer call the exported Viewer
`validateStorySourcePackage` directly; no transport-local People, Evidence, Phase, Coverage, or
Insight-grounding validator substitutes for it.

## Activation Submission

`story-candidates.json` is a bounded array containing only:

```ts
type StoryCandidateSubmissionRow = {
  id: string;
  summary: string;
};
```

The server derives document, sequence, timestamp, and project identity from the current reviewed items. It validates candidate size, IDs, source schema, evidence, People, Phase contiguity, Insight grounding, coverage authority, revision transitions, and active digest before activation.

## Story Review Session

The implemented session shape is exactly:

```ts
type StoryReviewSession = {
  schema: "oxygen.story-review-session";
  workflowRunId: string;
  chapterReviews: Record<string, ChapterReviewState>;
  privacyDecisions: Record<string, "keep" | "redact">;
  updatedAt: string;
};
```

Do not claim this session stores Preference answers, source Privacy spans, Story source candidates, coverage manifests, release originals, private review notes, prompts, or hidden metadata.

On this base, restored final Story sessions reject nonempty top-level `privacyDecisions` during source-bound hydration. Story/Release Privacy candidates must come from an implemented authority outside `oxygen.story` before they can be treated as review obligations.

## Reviewed Release

The server-owned release schema is:

```ts
type ReviewedStoryRelease = {
  schema: "oxygen.reviewed-story";
  publication_approved: false;
  chapters: Array<{
    key: string;
    phase: { id: string; label: string };
    kind?: string;
    revision: number;
    en: {
      title: string;
      overview: string;
      people: Array<{ releaseLabel: string; role: string; description: string }>;
      story: { blocks: string[]; uncertainty?: string };
      insights: Array<{
        id: string;
        title?: string;
        background: string;
        quote: string;
        directlyAcquiredExperience: string;
        principle: string;
      }>;
    };
  }>;
};
```

Release serialization strips source IDs, Evidence references, Story-block IDs, Insight anchors, coverage metadata, review ledgers, originals, Privacy metadata, CAS metadata, and local editor state. HTML and ZIP use the same safe serialized Story bytes.
