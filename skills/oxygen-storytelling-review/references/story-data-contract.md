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
- human annotation;
- direct Story-edit transaction.

Do not use rendered English text as the sole identity. Stable IDs are required for language switching, revision provenance, navigation restoration, and exact evidence linkage.

IDs must be nonempty bounded primitive strings and unique within their Chapter and semantic collection. A Chapter key is always a primitive stable string; reject numeric or otherwise coercible substitutes. Reject duplicate participant, insight, Privacy-candidate, annotation, or evidence-reference IDs rather than allowing keyed maps/decision records to collapse distinct objects into one review action. Validate uniqueness using the same exact string representation used by decision/provenance maps so mixed values such as numeric `1` and string `"1"` cannot pass validation and later coerce to one key. Encode composite Privacy-decision identity injectively as a tuple (for example `JSON.stringify([chapterKey, candidateId])`), never by delimiter concatenation. Paired English/Chinese presentations use the same ordered semantic IDs.

Every direct-edit transaction also stores the exact owning Chapter key. Import, Apply Review, final
confirmation, and release projection must reject a transaction ledger containing a different key;
do not trust a Chapter-scoped map alone to prove transaction ownership.

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
  evidence: EvidenceReference[];
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

type StoryPassageContext = {
  whatWasHappening: string;
  whyItMattered: string;
  whatWeLearned?: string;
  reusableLesson?: string;
};

type StoryCoverageKey =
  | "mainProblem"
  | "participants"
  | "startingPosition"
  | "alternatives"
  | "objectionOrDisagreement"
  | "failedAttempt"
  | "correction"
  | "decisionChangingEvidence"
  | "quantitativeResult"
  | "finalAction"
  | "result"
  | "remainingUncertainty";

type StoryCoverageItem =
  | { state: "not_supported" }
  | { state: "represented"; blockIds: StoryBlockId[]; evidence: EvidenceReference[] }
  | { state: "supporting_detail"; evidence: EvidenceReference[]; justification: string };

type StoryClaimTrace = {
  id: string;
  kind: "factual_claim" | "insight_input";
  blockId: StoryBlockId;
  evidence: EvidenceReference[];
  unitIds?: string[];
};

type StoryContextRetentionUnit =
  | {
      id: string;
      kind: "instruction" | "response" | "decision" | "failure" | "correction" |
        "progress" | "result" | "uncertainty";
      evidence: EvidenceReference;
      state: "represented";
      blockIds: StoryBlockId[];
    }
  | {
      id: string;
      kind: "instruction" | "response" | "decision" | "failure" | "correction" |
        "progress" | "result" | "uncertainty";
      evidence: EvidenceReference;
      state: "excluded";
      reason: "duplicate" | "routine_status" | "outside_milestone" | "privacy_withheld";
    };

type StoryContextRetention = {
  schema: "oxygen.story-context-retention/1";
  sourceScope: EvidenceReference[];
  sourceUnitCount: number;
  representedUnitCount: number;
  excludedUnitCount: number;
  units: StoryContextRetentionUnit[];
};

type StoryNarrativeReview = {
  schema: "oxygen.story-narrative-review/1";
  status: "passed";
  title: { tensionAndOutcome: true };
  roles: {
    background: StoryBlockId[];
    evidenceThread: StoryBlockId[];
    turn: StoryBlockId[];
    result: StoryBlockId[];
    directLearning: StoryBlockId[];
    reusablePrinciple: StoryBlockId[];
    openTension: {
      state: "supported" | "not_supported";
      blockIds: StoryBlockId[];
    };
  };
  phase: {
    rationale: string;
    assignmentCoherent: true;
    adjacentBoundaryReviewed: true;
  };
  passageInsightsDistinct: true;
  actorCoverage: { state: "people_present"; personIds: string[] };
  editorial: {
    standardTerminology: true;
    neutralStructure: true;
    factualClaimsEvidenceBound: true;
    interpretationSeparated: true;
    uncertaintyPreserved: true;
    prohibitedStyleChecked: true;
  };
  coverageLedger: Record<StoryCoverageKey, StoryCoverageItem>;
  claimTraceability: StoryClaimTrace[];
  contextRetention: StoryContextRetention;
};

type PrivacyOriginal =
  | { availability: "available"; excerpt: string; sourceLanguage: "en" | "zh" | string }
  | { availability: "unavailable" };

type StoryBlockId =
  | "phase"
  | "title"
  | "overview"
  | "before"
  | "after"
  | `people:${string}`
  | "scene"
  | `reconstruction-${number}`
  | `detail-${number}`
  | "outcome"
  | "uncertainty"
  | `insight:${string}`;

type PrivacyCandidate = {
  id: string;
  title: string;
  original: PrivacyOriginal;
  whyFlagged: string;
  required: boolean;
  releaseTargets: StoryBlockId[];
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
  passageContext: Record<string, StoryPassageContext>;
  insights: [StoryInsight];
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
  presentation: { en: LanguagePresentation; zh?: LanguagePresentation };
  semanticAnchors: string[];
  narrativeReview: StoryNarrativeReview;
};
```

Every imported Chapter has exactly one reviewable AI insight in canonical English. An optional
Chinese sidecar uses the same stable insight ID. Reject zero or multiple English reviewable insights
rather than rendering only the first. A final release projection may contain zero insights only when
the human explicitly chose not to preserve the one reviewed insight; release sanitization rejects
any projection containing more than one.

Internal compatibility fields such as a privacy recommendation or former suggested-release copy may exist in legacy data. They are not approved visible UI and must not drive the human decision panel.

`releaseTargets` binds a candidate to stable semantic release blocks so a Redact decision changes
the release projection rather than only completion state. Require the field even when empty: an
empty array explicitly means the reviewed sensitive material is local-only/already absent from
generated release copy. Every target must resolve in English. If a Chinese sidecar cannot preserve
the same safe target identity, omit the sidecar instead of blocking English.

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

The paired language presentations map to the same semantic block IDs, even when text lengths and literal offsets differ. An annotation or direct-edit transaction preserves its language, stable block, base revision, and exact range rather than using rendered English as identity.

Render the compatible fields with standard reader-facing terms:

```text
scene → Background
reconstruction + importantDetails → Decision process
decisionOutcome → Result
uncertainty → Open questions
Insight observation → Direct learning
Insight lesson → Reusable rule
```

Do not expose internal field names as presentation terminology. Omit optional empty sections and reject generic filler before activation.

Every complete canonical Chapter requires English passage-context assistance. Its key set must equal
the complete rendered English Story-content block set (`scene`, every reconstruction/detail block,
`outcome`, and optional `uncertainty`). A missing map, missing key, or extra key makes the English
Chapter incomplete and fails import; there is no valid empty or silent fallback. Each
value contains only bounded reader-facing contextual copy:
what was happening, why it mattered, and optional grounded learning/lesson. It is precomputed local
review assistance, not a reviewable insight, semantic anchor, evidence record, or release field.
When Chinese exists, it uses the same safe block identities and complete local passage-context keys;
an unsafe Chinese map is dropped as a sidecar rather than becoming a readiness failure.

## Evidence linkage

Every explicit Chapter must have one primary evidence reference anchored to an existing reviewed event. Supporting references may expand causal context. New generated primary, supporting, and Person references use the exact fully qualified imported item ID in `eventId`; a bare event suffix is not an activation-safe identity. References must be unique and all references must resolve to exactly one real item in the permitted reviewed artifact before Apply or human confirmation; a syntactically plausible document/event ID is not proof of resolution.

Preserve:

- exact document and event IDs;
- chronological order;
- source timestamps;
- source language;
- primary vs supporting role.

Do not invent a source link merely to satisfy a schema. If evidence cannot be resolved, omit or block the Chapter.

Every generated Person attaches one or more reviewed references from that Chapter. Derive a stable functional role from explicit event role or repeated reviewed content. Preserve uncertainty, use a release-safe alias, and do not infer a real name, employer, title, identity, or relationship without direct permitted Evidence. English and Chinese share the same ordered Person IDs, release labels, identity states, and Evidence identities.

Every selected Chapter must contain at least one supported human, user, Agent, reviewer, speaker, owner, or operator actor. People must be nonempty and collectively cover those actor identities. Tool metadata alone never authorizes a fabricated participant. A routine machine-only event remains Timeline or Exact Evidence data and cannot become a standalone Chapter. A machine failure may support a Chapter when reviewed Evidence also identifies the actor who diagnosed, decided, executed, reviewed, approved, or responded.

## Chapter-generation rules

Apply the canonical context-retention and voice rules in
[product-contract.md](product-contract.md) and the role/mapping rules in
[narrative-writing-contract.md](narrative-writing-contract.md) before generating fields. The structures below carry
that narrative; they do not justify field-by-field or log-style prose.

For each Chapter:

1. Define one meaningful project-development unit and stable key. It may be a consequential change,
   durable progress, substantive iteration, failure/diagnostic case, validation, recovery, or
   current-state boundary.
2. Choose primary Evidence and every supporting Evidence unit needed to preserve the milestone's
   supported background, causal or temporal relationships, participant interaction, judgment,
   failed attempts, progress or iteration, and result.
3. Write a concise Timeline summary.
4. Write short Timeline Before/After states and select only evidence-backed high-signal chips; keep long explanation out of the card.
5. Write a distinct localized Chapter `overview` that briefly previews this Chapter's supported
   background, consequential participant turn or judgment, and result or open boundary. Reject
   navigation instructions and repeated boilerplate; add exact Chapter Evidence traceability.
6. Reconstruct a context-complete coherent article that preserves the problem, purpose,
   constraints, attempts, failures/rejected approaches, directional evidence, decision/rationale,
   resulting action/outcome, uncertainty, and reusable learning when those elements are supported.
   Use as many substantial paragraphs as the supported context requires. Raw logs remain outside the
   Story, but any operational unit that explains the milestone must be represented in readable prose.
7. Record what was retained, what non-explanatory duplicate or routine material was omitted, and what
   sensitive material remains unavailable.
8. Generate exactly one canonical AI insight/lesson explicitly typed as interpretation.
9. Generate evidence-supported People for every supported actor; if none can be supported, do not promote the event cluster into a Chapter.
   Use every listed Person's localized functional role in Decision process and attribute only the
   actions, questions, corrections, approvals, or responses supported by that Person's Evidence.
   Express the supported relationship with natural syntax and an optional localized relation marker.
   Do not require a marker, count connectors, or use one to invent an interaction or causal claim.
10. Generate contextual Privacy candidates only from permitted reviewed information.
11. Generate local passage context for every Story-content block as an ordered inline AI Insight
    sequence. Each entry connects supported participant interaction with narrative explanation and a
    bounded Reusable rule. Do not number semantic passages or expose block/schema metadata, and do
    not create additional release insights or unsupported lessons.
12. Optionally generate natural Chinese with the same facts, transition semantics, scan chips,
    passage-context meaning, and technical anchors. Its absence never blocks the English Story.
13. End the sequence with an honest current-state Chapter.
14. Make the title express the supported problem and decisive result. Make Story carry Background,
    Decision process, Result, and Open questions. Make the single canonical Insight carry Direct
    learning and a bounded Reusable rule.
15. Apply the neutral editorial rules and complete the bounded actor/editorial self-review before activation.
16. Classify every coverage-ledger element. Represent all supported explanatory material. Keep the
    historical `supporting_detail` value parser-compatible, but reject it during readiness because
    supported background, relationship, interaction, judgment, failure, progress, and result belong
    in traceable Chapter blocks.
17. Add one traceability record per material factual claim, including the Chapter overview, and explicit input Evidence for the
    canonical Insight. Multiple material claims in one block require multiple records.
18. Extract every reviewed conversational turn or independently meaningful nested reviewed turn in
    the complete milestone Evidence cluster as a stable privacy-safe source unit. Record no source
    copy. Classify each unit as represented in exact Story blocks or excluded with one fixed reason.
    Several units may share an Evidence reference; represented units must appear in the owning
    factual claim's `unitIds`.

At project level, generate a natural English summary of roughly 2–3 sentences. A semantically
equivalent Chinese summary and compact Chinese Phase labels are optional sidecar content. Prefer
one- or two-word English Phase labels.
Treat `importantDetails` as high-signal support within the coherent Chapter, not an invitation to
repeat the Chapter as a fact list or compress material causal context into one sentence.

## Import and validation gates

Fail closed when any of these conditions is false:

- archive CRC and member paths are safe;
- manifest count matches actual reviewed data;
- `publication_approved` is false;
- Story source hash matches the reviewed artifact;
- Chapter keys are present and unique;
- Chapters are chronological;
- Chapter selection retains supported meaningful progress, substantive iterations, consequential
  failures, judgment moments, and the current boundary without enforcing a numeric quota;
- required Story fields are nonempty;
- project orientation can derive milestone count, meaningful phase count, reviewed-Highlight progress, and source/evidence context;
- every Timeline milestone has a date, visible selected-Highlight status, short before/after states, and only supported scan chips;
- every milestone belongs to a generated phase when phases are present;
- milestone kind/state is allowed;
- primary evidence matches the annotation anchor where that representation is used;
- all unique primary/supporting evidence resolves to exactly one reviewed item;
- every Person has unique resolvable reviewed Evidence contained in the Chapter Evidence set;
- every Chapter has at least one Person, and actor-bearing Chapter Evidence has complete
  non-overlapping People coverage;
- every English Person role appears in Decision process; interaction copy links supported actor
  actions and responses without inventing disagreement, reply, or consensus;
- English Decision process forms a connected Evidence-bound account through natural syntax and
  explicit supported roles; no fixed connective, connector count, or lexical allowlist is required;
- exactly one canonical English AI insight starts as an AI proposal; zero or multiple reviewable insights fail closed;
- release draft is the default Story view;
- English passage context contains only the allowlisted bounded fields and covers exactly every
  rendered English Story-content block; an optional Chinese sidecar is displayed only when its
  shared identities and own rendered-block context are structurally safe;
- the structured narrative self-review passed, every required narrative role resolves to an owning
  Story/Insight block, every inline AI Insight contains all four grounded meanings, connects
  supported participant interaction to the narrative, exposes no semantic-passage ordinal or other
  implementation metadata, and does not copy
  its Story block, and the canonical Insight supplies distinct synthesis rather than repeated copy;
- the complete coverage ledger exists; main problem, participants, final action, and result are
  represented; optional unsupported elements remain explicitly `not_supported`; every supported
  explanatory unit, including judgment moments, durable progress milestones, substantive
  iterations, and consequential failures, is represented in a traceable Story block;
- the context-retention ledger covers every classified source unit in every Evidence event inside
  the declared milestone scope; its counts reconcile; every represented unit maps through a factual
  claim `unitIds` entry to exact Story blocks and Evidence; exclusions use only the fixed privacy-safe
  reasons; repeated citations of one Evidence event never substitute for distinct unit identities;
- every People and Story block has exact Chapter-contained factual-claim traceability, every
  material factual claim has its own entry, the canonical Insight has explicit Evidence inputs, and
  local traceability metadata is absent from release/export;
- the editorial self-review passed and visible copy contains standard terminology, neutral
  structure, Evidence-bound facts, separated interpretation, preserved uncertainty, and no
  prohibited style;
- Phase labels reject generic fallbacks, each Phase has one consistent evidence-derived rationale,
  adjacent Phases have distinct rationales, and one coherent Phase remains valid without a fixed
  minimum count;
- every declared required technical/semantic anchor appears in reader-facing English fields; a
  merely nonempty anchor list is not validation, while Chinese anchor alignment is non-gating;
- available Privacy original has an excerpt and source language;
- unavailable Privacy original contains only its unavailable discriminator and no excerpt, source language, removed value, raw field, or compatibility payload;
- the last Chapter is current state.

Malformed Story metadata should not fall back to confident invented copy. Stop with a clear local error or omit the invalid annotation and disclose the limitation.

## Review-state separation

Chapter review state is keyed by Chapter, not presentation language. Privacy decisions are keyed by Chapter + candidate. Insight review is keyed by Chapter + insight. Exact Story annotations are defined in [chapter-review-lifecycle.md](chapter-review-lifecycle.md).

Every Chapter review state includes an immutable publication boundary equivalent to:

```ts
publicationApproved: false
```
