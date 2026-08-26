# Story data contract

## Active generation boundary

Generate new Story candidates as:

```text
prefix: oxygen.story/3:
schema: oxygen.story/3
```

The reviewed contribution artifact remains the Evidence source. Generated Story data is separate
local metadata that references reviewed Evidence IDs. It must not overwrite source content, copy
raw/private Evidence into Story fields, or embed project-specific copy in generic Skill/frontend
source.

`oxygen.story/3` is the canonical live generation source. A complete homogeneous package must pass
deterministic source readiness before the workflow atomically activates it. The active mapping is:

```text
oxygen.story/3
→ oxygen.story-review-session/2
→ oxygen.reviewed-story/2
```

Source readiness permits atomic activation into human review; it is not explicit Insight review,
All set, release authority, or publication approval. Compatibility remains exact and isolated:
`oxygen.story-highlight/2` maps to `oxygen.story-review-session/1` and
`oxygen.reviewed-story/1`. Historical `oxygen.story-milestone/1` is non-reviewable compatibility
only. No legacy artifact is rewritten or shape-guessed into `/3`.

## Stable identities

Use stable bounded primitive-string identities for:

- Chapter;
- Phase;
- Person;
- Story block;
- Insight;
- primary/supporting Evidence.

Do not use rendered prose, array position, numeric coercion, or a display title as identity. Reject
duplicate IDs within their semantic collection. New Evidence references use the exact fully
qualified imported item ID in `eventId`; a bare suffix is not eligible even when it currently
resolves once.

## Canonical successor source

Generate the existing production `/3` shape:

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

type StorySource = {
  schema: "oxygen.story/3";
  key: string;
  phase: { id: string; label: string };
  kind?: string;
  title: string;
  overview: string;
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
  contextRetention: {
    excluded: Array<{
      evidence: EvidenceReference;
      reason: "duplicate" | "routine_status" | "outside_milestone" | "privacy_withheld";
    }>;
  };
};
```

Use the repository parser as the exact source-shape authority. Do not add compatibility fields,
review state, UI state, raw Evidence, free-form reasoning, or a second generation schema.

## Chapter and Story blocks

A Chapter is one complete coherent narrative arc. Stable Story blocks divide that arc for
traceability and review navigation; a block count, Evidence item count, time slice, Insight count,
importance score, Highlight worthiness, or lesson does not define Chapter boundaries.

Story blocks may carry background, ordinary setup or progress, transitions, relationships and
handoffs, attempts, failures, disagreements, corrections, decisions, validation, consequences,
and unresolved/current state when supported. Each block contains safe Story text and one or more
exact Chapter-contained Evidence references. Do not copy raw/private Evidence into public Story
text merely because the block records internal support.

Chapter `title` and `overview` orient the reader. They must be supported, specific, and useful, but
the title is not required to prove tension, drama, a decisive outcome, or a reusable lesson.
`kind` is optional presentation metadata. Do not require a special final `current_state` Chapter;
represent current state as its own Chapter only when it forms a coherent arc, or as the supported
ending of the final Chapter otherwise.

## People

`people` is required and nonempty for every Chapter. Generate at least one supported Person or
actor entry and attach exact reviewed Evidence references. Humans, users, Agents, reviewers,
speakers, owners, and operators may be actors when supported.

Preserve role uncertainty and release-safe identity. Never infer a name, employer, title,
relationship, response, consensus, or identity merge. Attribute each action, review, and decision
to the actor supported by the reviewed history. Routine machine-only activity cannot become a
standalone Chapter without a supported actor who diagnosed, decided, executed, reviewed, approved,
or responded.

## Chapter-first Phase grouping

Determine the complete ordered Chapter sequence before assigning Phases. Then group adjacent
Chapters that share a coherent project period or state. Phase is presentation and Timeline
navigation; it must not dictate, split, or merge Chapter boundaries.

Every Chapter has one stable Phase ID and a precise one- or two-word label. Each Phase ID occupies
one contiguous Chapter range and uses one consistent label. Reject generic labels such as
`Project Evolution`, `General Work`, `Other`, and `Later Stage`. Do not force a Phase count or
redesign the existing homepage-facing Phase concept.

## Sparse Insights

Each Chapter contains zero or more Insights (`0..n`). There is no minimum, maximum, per-Chapter or
per-block quota, density target, or preferred count. Generate an Insight only when it is an
independently warranted learning or judgment moment found after the complete Story is understood.
Zero Insights is a valid first-class source state, distinct from a generated Insight later rejected
during review.

Every generated Insight has exactly these four semantic meanings:

1. **Background** — minimum Story-grounded context needed to understand the judgment moment;
2. **Quote** — one or more safe reviewed Story-block anchors, not copied raw/private Evidence;
3. **Directly Acquired Experience** — what was learned from that actual project moment, bounded by
   what was known then;
4. **Principle** — a reusable rule, question, or guardrail for a genuinely similar future
   condition, without unsupported industry prior or generic slogans.

`title` is optional presentation metadata. It is not a fifth semantic meaning and its absence or
weakness alone does not decide semantic validity.

Ground every Insight through the existing chain:

```text
Insight -> safe reviewed Story block anchor(s) -> internal Evidence support
```

Each Quote anchor resolves within the same Chapter. Each Insight Evidence reference belongs to the
exact Chapter Evidence set and supports at least one anchored Story block. Never copy raw/private
Evidence into Background, Quote, Directly Acquired Experience, Principle, or title.

## Complete-history and Evidence accounting

Consider the complete approved reviewed history before deriving Chapters. Retain supported
background, chronology, relationships, participant actions, ordinary progress needed for later
understanding, failures, corrections, decisions, validation, consequences, uncertainty, and
current state. Do not omit a passage because it lacks an Insight.

For each Chapter, declare one primary Evidence reference plus every supporting reference needed for
the coherent arc. The exact Chapter Evidence allowlist must reconcile: every allowed reference is
represented by at least one Story block or appears once in `contextRetention.excluded` with an
allowed fixed reason. Represented and excluded references do not overlap. Duplicates, unresolved or
ambiguous Evidence, document mismatch, foreign references, and incomplete accounting fail closed.

This accounting is validation metadata, not permission to retain source copy or private reasoning.
Chronology, attribution, causal restraint, uncertainty, Privacy, and non-fabrication remain
mandatory even when structural validation passes.

## Passage assistance

Passage assistance is not part of `oxygen.story/3` and is never a generation or readiness
requirement. If a later consumer retains assistance, it is optional, local, human-facing,
non-authoritative, does not create an Insight, does not require a lesson, and remains excluded from
release unless a separate explicit decision changes that boundary.

## Optional localization

English is the canonical generation and source-readiness surface. Chinese is an optional localized
presentation sidecar governed by [bilingual-contract.md](bilingual-contract.md). It shares stable
semantic identities and facts but is not embedded as an alternate `/3` source schema. Missing,
incomplete, stale, or unsafe localization never blocks the valid English candidate.

## Generation order

Use this semantic order inside the existing Build Project Story stage:

1. understand the complete approved project history;
2. determine coherent Chapter narrative arcs;
3. write the complete ordered Chapter and Project Story narrative;
4. verify continuity, chronology, attribution, Evidence, causal restraint, Privacy, and
   uncertainty;
5. group adjacent Chapters into precise one- or two-word Phases;
6. only after the complete Story is understood, identify independently warranted learning moments;
7. produce zero or more Insights.

These are conceptual passes, not new top-level workflow stages.

## Import and source-readiness gates

Fail closed when any of these conditions is false:

- archive CRC/member paths, manifest counts, source hash, and `publication_approved=false` are safe;
- every row uses the exact `oxygen.story/3:` prefix and `oxygen.story/3` schema;
- Chapter keys and all nested stable IDs are bounded and unique;
- Chapters are chronological and each is a complete coherent arc;
- every Chapter has nonempty supported People with exact Evidence;
- every Chapter has nonempty safe Story blocks with exact Evidence;
- Evidence ownership and represented/excluded accounting reconcile exactly;
- Phases group adjacent already-determined Chapters and use precise one- or two-word labels;
- Insight cardinality is `0..n` without a quota;
- every existing Insight has Background, Quote, Directly Acquired Experience, and Principle;
- every Insight Quote and Evidence reference resolves through same-Chapter Story support;
- uncertainty, failures, attribution, chronology, causal restraint, Privacy, and non-fabrication are
  preserved;
- no placeholder, fallback Chapter, partial job, or validation debt remains.

Malformed `/3` metadata must not fall back to an older parser or confident invented copy. Keep the
candidate staged and disclose the bounded validation failure.

## Review-state separation

AI-generated Insights require explicit human review of the currently presented version under
`oxygen.story-review-session/2`; silence is not approval and each existing Insight resolves
independently. Editing an AI Insight creates a new version that requires a new Accept. Zero source
Insights creates zero Insight-review obligations. A saved human-created Insight is human-authored
and approved for that saved version. Only the server-owned validated `/3` + session `/2` path may
construct `oxygen.reviewed-story/2` after review completion.

Every review state retains the immutable publication boundary equivalent to:

```ts
publicationApproved: false
```
