export type TimelineCandidate = {
  id: string;
  sequence?: number;
  timestamp?: string;
  summary?: string;
  content?: string;
  project?: string;
  documentId?: string;
  document_id?: string;
};

export const STORY_PREFIX = "oxygen.story-highlight/2:";
export const LEGACY_STORY_PREFIX = "oxygen.story-milestone/1:";
export const SUCCESSOR_STORY_PREFIX = "oxygen.story/3:";

export type MilestoneKind =
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

export type EvidenceReference = {
  documentId: string;
  eventId: string;
  label?: string;
};

export type StoryReleaseTarget =
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

export type StoryReleaseTargetDescriptor =
  | {
      target: "phase" | "title" | "overview" | "before" | "after" | "scene" | "outcome" | "uncertainty";
      kind: "scalar";
      field: "phase" | "title" | "overview" | "before" | "after" | "scene" | "decisionOutcome" | "uncertainty";
    }
  | { target: `reconstruction-${number}`; kind: "reconstruction"; index: number }
  | { target: `detail-${number}`; kind: "detail"; index: number }
  | { target: `people:${string}`; kind: "person"; id: string }
  | { target: `insight:${string}`; kind: "insight"; id: string };

export type StoryReleaseTargetCatalog = ReadonlyMap<StoryReleaseTarget, StoryReleaseTargetDescriptor>;

export type ReleaseEpisode = {
  startTimestamp?: string;
  endTimestamp?: string;
  readingTimeMinutes: number;
  scene: string;
  reconstruction: string[];
  importantDetails: string[];
  decisionOutcome: string;
  uncertainty?: string;
  compression: {
    sourceScope: string;
    retained: string[];
    omittedLowValue: string[];
    omittedSensitive: string[];
    rewriteBrief: string;
  };
};

export type StoryInsight = {
  proposal: string;
  rationale: string;
  reviewState: "ai_proposed";
};

export type StoryLanguage = "en" | "zh";

export type StoryPerson = {
  id: string;
  releaseLabel: string;
  role: string;
  description: string;
  localIdentityState: "not_identified" | "local_only";
  /** Reviewed references supporting this functional role. Historical review
   * artifacts may omit this field; newly activated candidates require it. */
  evidence?: EvidenceReference[];
};

export type SuccessorStoryPerson = Omit<StoryPerson, "evidence"> & {
  evidence: EvidenceReference[];
};

export type SuccessorStoryBlock = {
  id: string;
  text: string;
  evidence: EvidenceReference[];
};

export type SuccessorStoryInsight = {
  id: string;
  title?: string;
  background: string;
  quote: { storyBlockIds: string[] };
  directlyAcquiredExperience: string;
  principle: string;
  evidence: EvidenceReference[];
};

export type SuccessorStorySource = {
  schema: "oxygen.story/3";
  key: string;
  phase: { id: string; label: string };
  kind?: MilestoneKind;
  title: string;
  overview: string;
  people: SuccessorStoryPerson[];
  story: {
    blocks: SuccessorStoryBlock[];
    uncertainty?: string;
  };
  insights: SuccessorStoryInsight[];
  evidence: {
    primary: EvidenceReference;
    supporting: EvidenceReference[];
  };
  contextRetention: {
    excluded: Array<{
      evidence: EvidenceReference;
      reason: StoryContextExclusionReason;
    }>;
  };
};

export type StoryChapter = {
  scene: string;
  reconstruction: string[];
  importantDetails: string[];
  decisionOutcome: string;
  uncertainty?: string;
};

export type StoryHighlightItem = {
  id: string;
  title: string;
  noticed: string;
  lesson: string;
};

export type StoryPassageContext = {
  whatWasHappening: string;
  whyItMattered: string;
  whatWeLearned?: string;
  reusableLesson?: string;
};

export type StoryPrivacyCandidate = {
  id: string;
  title: string;
  explanation: string;
  recommendation: "keep" | "redact";
  /** Stable semantic release blocks affected by a Redact decision. An empty
   * array explicitly means the reviewed candidate is local-only and no release
   * block contains it. */
  releaseTargets: StoryReleaseTarget[];
  original: {
    availability: "available" | "unavailable";
    excerpt?: string;
    sourceLanguage?: StoryLanguage;
  };
  whyFlagged: string;
  suggestedRelease?: string;
};

export type StoryLanguagePresentation = {
  phase: string;
  title: string;
  timelineSummary: string;
  before: string;
  after: string;
  timelineChips: string[];
  overview: string;
  people: StoryPerson[];
  story: StoryChapter;
  /** Precomputed local reading assistance keyed by stable Story block ID. It
   * is never an additional reviewable Insight or release field. */
  passageContext: Record<string, StoryPassageContext>;
  highlights: StoryHighlightItem[];
  privacy: {
    summary: string;
    candidates: StoryPrivacyCandidate[];
  };
};

export type EpisodeReviewPresentation = {
  en: StoryLanguagePresentation;
  /** Optional localized sidecar. English is the canonical Story/readiness
   * surface; a missing or unsafe localized sidecar never blocks activation. */
  zh?: StoryLanguagePresentation;
  projectSummary?: { en: string; zh?: string };
  semanticAnchors: string[];
};

export const STORY_COVERAGE_KEYS = [
  "mainProblem",
  "participants",
  "startingPosition",
  "alternatives",
  "objectionOrDisagreement",
  "failedAttempt",
  "correction",
  "decisionChangingEvidence",
  "quantitativeResult",
  "finalAction",
  "result",
  "remainingUncertainty",
] as const;

export type StoryCoverageKey = typeof STORY_COVERAGE_KEYS[number];

export type StoryCoverageItem =
  | { state: "not_supported" }
  | { state: "represented"; blockIds: string[]; evidence: EvidenceReference[] }
  | { state: "supporting_detail"; evidence: EvidenceReference[]; justification: string };

export type StoryClaimTrace = {
  id: string;
  kind: "factual_claim" | "insight_input";
  blockId: string;
  evidence: EvidenceReference[];
  /** Stable extracted source units carried by this claim. Historical records
   * may omit these; new context-complete activation validates them. */
  unitIds?: string[];
};

export const STORY_CONTEXT_EXCLUSION_REASONS = [
  "duplicate",
  "routine_status",
  "outside_milestone",
  "privacy_withheld",
] as const;

export type StoryContextExclusionReason = typeof STORY_CONTEXT_EXCLUSION_REASONS[number];
export type StoryContextUnitKind =
  | "instruction"
  | "response"
  | "decision"
  | "failure"
  | "correction"
  | "progress"
  | "result"
  | "uncertainty";

export type StoryContextRetentionUnit =
  | {
      id: string;
      kind: StoryContextUnitKind;
      evidence: EvidenceReference;
      state: "represented";
      blockIds: string[];
    }
  | {
      id: string;
      kind: StoryContextUnitKind;
      evidence: EvidenceReference;
      state: "excluded";
      reason: StoryContextExclusionReason;
    };

export type StoryContextRetention = {
  schema: "oxygen.story-context-retention/1";
  sourceScope: EvidenceReference[];
  sourceUnitCount: number;
  representedUnitCount: number;
  excludedUnitCount: number;
  units: StoryContextRetentionUnit[];
};

export type StoryNarrativeReview = {
  schema: "oxygen.story-narrative-review/1";
  status: "passed";
  title: { tensionAndOutcome: true };
  roles: {
    background: string[];
    evidenceThread: string[];
    turn: string[];
    result: string[];
    directLearning: string[];
    reusablePrinciple: string[];
    openTension: {
      state: "supported" | "not_supported";
      blockIds: string[];
    };
  };
  phase: {
    rationale: string;
    assignmentCoherent: true;
    adjacentBoundaryReviewed: true;
  };
  passageInsightsDistinct: true;
  /** Local Stage-4 proof. Kept optional so historical reviewed artifacts remain
   * readable; activation requires one of these explicit actor boundaries. */
  actorCoverage?: {
    state: "people_present";
    personIds: string[];
  };
  /** Bounded editorial self-check. This records results, never model reasoning. */
  editorial?: {
    standardTerminology: true;
    neutralStructure: true;
    factualClaimsEvidenceBound: true;
    interpretationSeparated: true;
    uncertaintyPreserved: true;
    prohibitedStyleChecked: true;
  };
  /** Bounded Stage-4 coverage record. Every possible element is classified;
   * supported material is either represented or explicitly retained only as
   * supporting detail. This is validation metadata, never model reasoning. */
  coverageLedger?: Record<StoryCoverageKey, StoryCoverageItem>;
  /** One entry per material factual claim plus explicit Evidence inputs for
   * the canonical Insight. Multiple claims may own the same stable block. */
  claimTraceability?: StoryClaimTrace[];
  /** Every extracted explanatory source unit is either mapped to Story blocks
   * or assigned one fixed exclusion reason. This stores decisions and hashes,
   * never source copy or model reasoning. */
  contextRetention?: StoryContextRetention;
};

export type StoryAnnotation = {
  schema: "oxygen.story-highlight/2";
  key: string;
  phase: string;
  kind: MilestoneKind;
  title: string;
  timelineSummary: string;
  whyThisMatters: string;
  before: string;
  after: string;
  metric?: string;
  importance?: number;
  releaseEpisode: ReleaseEpisode;
  insight: StoryInsight;
  evidence: {
    primary: EvidenceReference;
    supporting: EvidenceReference[];
  };
  sourceVersion: {
    defaultView: "release";
    originalState: "local_evidence_only";
    releaseState: "ai_prepared_draft";
    note: string;
  };
  privacyReview: {
    state: "reviewed_release" | "needs_human_review" | "not_applicable";
    note: string;
    prompt?: string;
  };
  reviewPresentation: EpisodeReviewPresentation;
  /** Structured, payload-local Stage-4 editorial self-review. It records
   * coverage decisions without exposing model reasoning in Workflow Progress. */
  narrativeReview?: StoryNarrativeReview;
};

export type LegacyStoryAnnotation = {
  schema: "oxygen.story-milestone/1";
  key: string;
  phase: string;
  kind: MilestoneKind;
  title: string;
  narrative: string;
  before: string;
  after: string;
  metric?: string;
  importance?: number;
};

export type StoryPresentation = {
  explicit: boolean;
  key: string;
  phase: string;
  kind: MilestoneKind;
  title: string;
  narrative: string;
  before?: string;
  after?: string;
  metric?: string;
  importance: number;
  whyThisMatters?: string;
  releaseEpisode?: ReleaseEpisode;
  insight?: StoryInsight;
  evidence?: StoryAnnotation["evidence"];
  sourceVersion?: StoryAnnotation["sourceVersion"];
  privacyReview?: StoryAnnotation["privacyReview"];
  reviewPresentation?: EpisodeReviewPresentation;
  narrativeReview?: StoryNarrativeReview;
};

export type TimelineMilestone<T extends TimelineCandidate = TimelineCandidate> = T & {
  story: StoryPresentation;
};

const KINDS = new Set<MilestoneKind>([
  "foundation", "discovery", "baseline", "problem", "failure", "root_cause",
  "decision", "direction_change", "breakthrough", "quantitative_change",
  "validation", "freeze", "handoff", "current_state",
]);

const KIND_LABELS: Record<MilestoneKind, string> = {
  foundation: "Foundation",
  discovery: "Discovery",
  baseline: "Baseline",
  problem: "Problem",
  failure: "Failure",
  root_cause: "Root cause",
  decision: "Decision",
  direction_change: "Direction change",
  breakthrough: "Breakthrough",
  quantitative_change: "Quantitative change",
  validation: "Validation",
  freeze: "Freeze",
  handoff: "Handoff",
  current_state: "Current state",
};

const KIND_LABELS_ZH: Record<MilestoneKind, string> = {
  foundation: "基础",
  discovery: "发现",
  baseline: "基线",
  problem: "问题",
  failure: "失败",
  root_cause: "根因",
  decision: "决定",
  direction_change: "方向变化",
  breakthrough: "突破",
  quantitative_change: "量化变化",
  validation: "验证",
  freeze: "冻结",
  handoff: "交接",
  current_state: "当前状态",
};

const TRANSITION_TERMS: Array<[string, number, MilestoneKind]> = [
  ["root cause", 12, "root_cause"], ["caused by", 9, "root_cause"],
  ["blocked", 9, "failure"], ["failed", 8, "failure"], ["failure", 8, "failure"],
  ["decision", 8, "decision"], ["decided", 8, "decision"], ["approved", 7, "decision"],
  ["pivot", 10, "direction_change"], ["supersed", 9, "direction_change"],
  ["instead", 5, "direction_change"], ["changed direction", 10, "direction_change"],
  ["discovered", 8, "discovery"], ["found that", 7, "discovery"], ["exposed", 7, "discovery"],
  ["baseline", 8, "baseline"], ["foundation", 8, "foundation"],
  ["breakthrough", 10, "breakthrough"], ["resolved", 8, "breakthrough"], ["fixed", 7, "breakthrough"],
  ["validated", 8, "validation"], ["validation", 7, "validation"], ["passed", 6, "validation"],
  ["frozen", 8, "freeze"], ["sealed", 8, "freeze"], ["final acceptance", 10, "validation"],
  ["handoff", 7, "handoff"], ["ready for review", 8, "handoff"],
  ["current state", 9, "current_state"], ["where things stand", 9, "current_state"],
  ["first complete", 8, "breakthrough"], ["completed milestone", 8, "breakthrough"],
  ["iteration improved", 7, "quantitative_change"], ["iteration established", 7, "breakthrough"],
  ["recovered after", 8, "validation"], ["became available", 6, "breakthrough"],
  ["→", 5, "quantitative_change"], ["increased", 6, "quantitative_change"], ["decreased", 6, "quantitative_change"],
];

const ROUTINE_TERMS = [
  "still running", "still active", "continuing", "no terminal", "in progress",
  "i'm checking", "i’m checking", "i'm now", "i’m now", "next i", "next, i",
  "reports progress", "supporting local operation", "source-control handoff",
  "tool call", "tool result", "system action", "installing", "setup is complete",
];

const clean = (value?: string) => String(value || "").replace(/\s+/g, " ").trim();

const validStableId = (value: unknown): value is string => typeof value === "string"
  && value.trim().length > 0
  && value.length <= 300;

const nonEmptyString = (value: unknown): value is string => typeof value === "string"
  && value.trim().length > 0;

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\p{L}]+/gu, " ").trim();
}

const nonEmptyStrings = (value: unknown): value is string[] => Array.isArray(value)
  && value.length > 0
  && value.every((item) => typeof item === "string" && item.trim().length > 0);

function validEvidence(value: unknown): value is EvidenceReference {
  if (!value || typeof value !== "object") return false;
  const evidence = value as Partial<EvidenceReference>;
  return Object.keys(value).every((key) => ["documentId", "eventId", "label"].includes(key))
    && typeof evidence.documentId === "string" && Boolean(evidence.documentId.trim()) && evidence.documentId.length <= 500
    && typeof evidence.eventId === "string" && Boolean(evidence.eventId.trim()) && evidence.eventId.length <= 500
    && (evidence.label === undefined || (typeof evidence.label === "string" && evidence.label.length <= 500));
}

const evidenceKey = (value: EvidenceReference) => JSON.stringify([value.documentId, value.eventId]);

const releaseTargetPattern = /^(?:phase|title|overview|before|after|scene|outcome|uncertainty|people:.+|reconstruction-\d+|detail-\d+|insight:.+)$/;

function sameOrderedValues(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function uniqueValues(values: string[]) {
  return new Set(values).size === values.length;
}

function onlyKeys(value: object, allowed: string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validPrivacyCandidate(value: unknown): value is StoryPrivacyCandidate {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoryPrivacyCandidate>;
  if (!onlyKeys(value, ["id", "title", "explanation", "recommendation", "releaseTargets", "original", "whyFlagged", "suggestedRelease"])
    || !validStableId(candidate.id)
    || typeof candidate.title !== "string" || !candidate.title.trim()
    || typeof candidate.explanation !== "string" || !candidate.explanation.trim()
    || !candidate.recommendation || !["keep", "redact"].includes(candidate.recommendation)
    || !Array.isArray(candidate.releaseTargets)
    || !candidate.releaseTargets.every((target) => typeof target === "string" && releaseTargetPattern.test(target))
    || !uniqueValues(candidate.releaseTargets)
    || !candidate.original || typeof candidate.original !== "object"
    || typeof candidate.whyFlagged !== "string" || !candidate.whyFlagged.trim()
    || (candidate.suggestedRelease !== undefined && typeof candidate.suggestedRelease !== "string")) return false;
  if (candidate.original.availability === "unavailable") {
    return onlyKeys(candidate.original, ["availability"]);
  }
  return candidate.original.availability === "available"
    && onlyKeys(candidate.original, ["availability", "excerpt", "sourceLanguage"])
    && nonEmptyString(candidate.original.excerpt)
    && typeof candidate.original.sourceLanguage === "string"
    && ["en", "zh"].includes(candidate.original.sourceLanguage);
}

function storyContentBlockIds(value: StoryLanguagePresentation) {
  return [
    "scene",
    ...value.story.reconstruction.map((_, index) => `reconstruction-${index}`),
    ...value.story.importantDetails.map((_, index) => `detail-${index}`),
    "outcome",
    ...(value.story.uncertainty ? ["uncertainty"] : []),
  ];
}

/** Derive every legal review/release target from one current Story
 * presentation. Direct-editable body blocks remain a deliberately narrower
 * responsibility than this semantic target catalog. */
export function storyReleaseTargetCatalog(
  value: StoryLanguagePresentation,
): StoryReleaseTargetCatalog | null {
  if (!value || typeof value !== "object"
    || !nonEmptyString(value.phase) || !nonEmptyString(value.title)
    || !nonEmptyString(value.overview) || !nonEmptyString(value.before) || !nonEmptyString(value.after)
    || !Array.isArray(value.people) || !value.story || typeof value.story !== "object"
    || !nonEmptyString(value.story.scene)
    || !Array.isArray(value.story.reconstruction) || !value.story.reconstruction.every(nonEmptyString)
    || !Array.isArray(value.story.importantDetails) || !value.story.importantDetails.every(nonEmptyString)
    || !nonEmptyString(value.story.decisionOutcome)
    || (value.story.uncertainty !== undefined && value.story.uncertainty !== null
      && !nonEmptyString(value.story.uncertainty))
    || !Array.isArray(value.highlights)) return null;

  const catalog = new Map<StoryReleaseTarget, StoryReleaseTargetDescriptor>();
  const add = (descriptor: StoryReleaseTargetDescriptor) => {
    if (catalog.has(descriptor.target)) return false;
    catalog.set(descriptor.target, descriptor);
    return true;
  };
  const fixed: Array<Extract<StoryReleaseTargetDescriptor, { kind: "scalar" }>> = [
    { target: "phase", kind: "scalar", field: "phase" },
    { target: "title", kind: "scalar", field: "title" },
    { target: "overview", kind: "scalar", field: "overview" },
    { target: "before", kind: "scalar", field: "before" },
    { target: "after", kind: "scalar", field: "after" },
  ];
  for (const descriptor of fixed) add(descriptor);
  for (const person of value.people) {
    if (!validStableId(person?.id)
      || !add({ target: `people:${person.id}`, kind: "person", id: person.id })) return null;
  }
  add({ target: "scene", kind: "scalar", field: "scene" });
  value.story.reconstruction.forEach((_, index) => {
    add({ target: `reconstruction-${index}`, kind: "reconstruction", index });
  });
  value.story.importantDetails.forEach((_, index) => {
    add({ target: `detail-${index}`, kind: "detail", index });
  });
  add({ target: "outcome", kind: "scalar", field: "decisionOutcome" });
  if (typeof value.story.uncertainty === "string") {
    add({ target: "uncertainty", kind: "scalar", field: "uncertainty" });
  }
  for (const highlight of value.highlights) {
    if (!validStableId(highlight?.id)
      || !add({ target: `insight:${highlight.id}`, kind: "insight", id: highlight.id })) return null;
  }
  return catalog;
}

function validPassageContext(value: unknown, blockIds: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length === blockIds.length
    && sameOrderedValues(entries.map(([id]) => id).sort(), [...blockIds].sort())
    && entries.every(([, context]) => {
      if (!context || typeof context !== "object" || Array.isArray(context)
        || !onlyKeys(context, ["whatWasHappening", "whyItMattered", "whatWeLearned", "reusableLesson"])) return false;
      const copy = context as Partial<StoryPassageContext>;
      return typeof copy.whatWasHappening === "string" && Boolean(copy.whatWasHappening.trim()) && copy.whatWasHappening.length <= 4_000
        && typeof copy.whyItMattered === "string" && Boolean(copy.whyItMattered.trim()) && copy.whyItMattered.length <= 4_000
        && (copy.whatWeLearned === undefined || (typeof copy.whatWeLearned === "string" && Boolean(copy.whatWeLearned.trim()) && copy.whatWeLearned.length <= 4_000))
        && (copy.reusableLesson === undefined || (typeof copy.reusableLesson === "string" && Boolean(copy.reusableLesson.trim()) && copy.reusableLesson.length <= 4_000));
    });
}

function semanticBlockIds(value: StoryLanguagePresentation) {
  return [...(storyReleaseTargetCatalog(value)?.keys() || [])];
}

function validReviewLanguage(value: unknown): value is StoryLanguagePresentation {
  if (!value || typeof value !== "object") return false;
  const copy = value as Partial<StoryLanguagePresentation>;
  const people = copy.people;
  const story = copy.story;
  const highlights = copy.highlights;
  const privacy = copy.privacy;
  return Boolean(
    nonEmptyString(copy.phase) && nonEmptyString(copy.title)
    && nonEmptyString(copy.timelineSummary) && nonEmptyString(copy.before)
    && nonEmptyString(copy.after) && nonEmptyString(copy.overview)
    && Array.isArray(copy.timelineChips) && copy.timelineChips.every((chip) => typeof chip === "string" && chip.trim())
    && Array.isArray(people) && people.every((person) => (
      validStableId(person.id)
      && typeof person.releaseLabel === "string" && Boolean(person.releaseLabel.trim())
      && typeof person.role === "string" && Boolean(person.role.trim())
      && typeof person.description === "string" && Boolean(person.description.trim())
      && ["not_identified", "local_only"].includes(person.localIdentityState)
      && (person.evidence === undefined || (Array.isArray(person.evidence)
        && person.evidence.length > 0
        && person.evidence.every(validEvidence)
        && uniqueValues(person.evidence.map(evidenceKey))))
    ))
    && nonEmptyString(story?.scene) && nonEmptyStrings(story.reconstruction)
    && nonEmptyStrings(story.importantDetails) && nonEmptyString(story.decisionOutcome)
    && (story.uncertainty === undefined || story.uncertainty === null
      || (typeof story.uncertainty === "string" && Boolean(story.uncertainty.trim())))
    && validPassageContext(copy.passageContext, story ? storyContentBlockIds(copy as StoryLanguagePresentation) : [])
    && Array.isArray(highlights) && highlights.length === 1
    && highlights.every((item) => validStableId(item.id)
      && typeof item.title === "string" && Boolean(item.title.trim())
      && typeof item.noticed === "string" && Boolean(item.noticed.trim())
      && typeof item.lesson === "string" && Boolean(item.lesson.trim()))
    && nonEmptyString(privacy?.summary) && Array.isArray(privacy.candidates)
    && privacy.candidates.every(validPrivacyCandidate)
    && uniqueValues(people.map((person) => person.id))
    && uniqueValues(highlights.map((item) => item.id))
    && uniqueValues(privacy.candidates.map((candidate) => candidate.id))
  );
}

function readerFacingPresentationText(value: StoryLanguagePresentation) {
  return [
    value.phase, value.title, value.timelineSummary, value.before, value.after,
    ...value.timelineChips, value.overview,
    ...value.people.flatMap((person) => [person.releaseLabel, person.role, person.description]),
    value.story.scene, ...value.story.reconstruction, ...value.story.importantDetails,
    value.story.decisionOutcome, value.story.uncertainty || "",
    ...value.highlights.flatMap((highlight) => [highlight.title, highlight.noticed, highlight.lesson]),
    value.privacy.summary,
    ...value.privacy.candidates.flatMap((candidate) => [
      candidate.title, candidate.explanation, candidate.whyFlagged, candidate.suggestedRelease || "",
    ]),
  ].join("\n");
}

function localizedSidecarIsSafe(
  en: StoryLanguagePresentation,
  zh: StoryLanguagePresentation,
) {
  const enBlocks = semanticBlockIds(en);
  const zhBlocks = semanticBlockIds(zh);
  return sameOrderedValues(en.people.map((person) => person.id), zh.people.map((person) => person.id))
    && sameOrderedValues(en.people.map((person) => person.releaseLabel), zh.people.map((person) => person.releaseLabel))
    && sameOrderedValues(en.people.map((person) => person.localIdentityState), zh.people.map((person) => person.localIdentityState))
    && en.people.every((person, index) => sameOrderedValues(
      (person.evidence || []).map(evidenceKey),
      (zh.people[index].evidence || []).map(evidenceKey),
    ))
    && sameOrderedValues(en.highlights.map((highlight) => highlight.id), zh.highlights.map((highlight) => highlight.id))
    && sameOrderedValues(Object.keys(en.passageContext).sort(), Object.keys(zh.passageContext).sort())
    && sameOrderedValues(en.privacy.candidates.map((candidate) => candidate.id), zh.privacy.candidates.map((candidate) => candidate.id))
    && en.privacy.candidates.every((candidate, index) => {
      const paired = zh.privacy.candidates[index];
      return paired.recommendation === candidate.recommendation
        && paired.original.availability === candidate.original.availability
        && paired.original.excerpt === candidate.original.excerpt
        && paired.original.sourceLanguage === candidate.original.sourceLanguage
        && sameOrderedValues(candidate.releaseTargets, paired.releaseTargets)
        && candidate.releaseTargets.every((target) => enBlocks.includes(target))
        && paired.releaseTargets.every((target) => zhBlocks.includes(target));
    })
    && sameOrderedValues(enBlocks, zhBlocks);
}

/** Treat Chinese as a non-blocking presentation sidecar. If supplied copy is
 * structurally unsafe or breaks shared Privacy/review identity, discard only
 * that sidecar and continue validating the canonical English Story. */
function normalizeOptionalLocalizedPresentation(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const presentation = value as Partial<EpisodeReviewPresentation>;
  if (presentation.zh !== undefined && (!validReviewLanguage(presentation.en)
    || !validReviewLanguage(presentation.zh)
    || !localizedSidecarIsSafe(presentation.en, presentation.zh))) {
    delete presentation.zh;
  }
  if (presentation.projectSummary && typeof presentation.projectSummary === "object") {
    const summary = presentation.projectSummary;
    if (summary.zh !== undefined && (typeof summary.zh !== "string"
      || !summary.zh.trim() || summary.zh.length > 20_000 || !presentation.zh)) {
      delete summary.zh;
    }
  }
}

function validReviewPresentation(value: unknown): value is EpisodeReviewPresentation {
  if (!value || typeof value !== "object") return false;
  const presentation = value as Partial<EpisodeReviewPresentation>;
  if (!validReviewLanguage(presentation.en)
      || (presentation.zh !== undefined && (!validReviewLanguage(presentation.zh)
        || !localizedSidecarIsSafe(presentation.en, presentation.zh)))
      || (presentation.projectSummary !== undefined
        && (!presentation.projectSummary
          || typeof presentation.projectSummary !== "object"
          || !(typeof presentation.projectSummary.en === "string" && presentation.projectSummary.en.trim())
          || presentation.projectSummary.en.length > 20_000
          || (presentation.projectSummary.zh !== undefined
            && (!(typeof presentation.projectSummary.zh === "string" && presentation.projectSummary.zh.trim())
              || presentation.projectSummary.zh.length > 20_000))))
      || !nonEmptyStrings(presentation.semanticAnchors)
      || !uniqueValues(presentation.semanticAnchors)
      || presentation.semanticAnchors.some((anchor) => anchor.length > 500)) return false;
  const enText = readerFacingPresentationText(presentation.en);
  return presentation.semanticAnchors.every((anchor) => enText.includes(anchor));
}

function validNarrativeReview(
  value: unknown,
  presentation: EpisodeReviewPresentation,
): value is StoryNarrativeReview {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !onlyKeys(value, [
      "schema", "status", "title", "roles", "phase", "passageInsightsDistinct",
      "actorCoverage", "editorial", "coverageLedger", "claimTraceability", "contextRetention",
    ])) return false;
  const review = value as Partial<StoryNarrativeReview>;
  if (review.schema !== "oxygen.story-narrative-review/1"
    || review.status !== "passed"
    || review.passageInsightsDistinct !== true
    || !review.title || !onlyKeys(review.title, ["tensionAndOutcome"])
    || review.title.tensionAndOutcome !== true
    || !review.roles || !onlyKeys(review.roles, [
      "background", "evidenceThread", "turn", "result", "directLearning",
      "reusablePrinciple", "openTension",
    ])
    || !review.phase || !onlyKeys(review.phase, [
      "rationale", "assignmentCoherent", "adjacentBoundaryReviewed",
    ])) return false;
  if (review.actorCoverage !== undefined) {
    if (!review.actorCoverage || typeof review.actorCoverage !== "object" || Array.isArray(review.actorCoverage)) return false;
    if (review.actorCoverage.state === "people_present") {
      if (!onlyKeys(review.actorCoverage, ["state", "personIds"])
        || !Array.isArray(review.actorCoverage.personIds)
        || review.actorCoverage.personIds.length === 0
        || !review.actorCoverage.personIds.every(validStableId)
        || !uniqueValues(review.actorCoverage.personIds)) return false;
    } else return false;
  }
  if (review.editorial !== undefined && (!review.editorial
    || typeof review.editorial !== "object" || Array.isArray(review.editorial)
    || !onlyKeys(review.editorial, [
      "standardTerminology", "neutralStructure", "factualClaimsEvidenceBound",
      "interpretationSeparated", "uncertaintyPreserved", "prohibitedStyleChecked",
    ])
    || review.editorial.standardTerminology !== true
    || review.editorial.neutralStructure !== true
    || review.editorial.factualClaimsEvidenceBound !== true
    || review.editorial.interpretationSeparated !== true
    || review.editorial.uncertaintyPreserved !== true
    || review.editorial.prohibitedStyleChecked !== true)) return false;
  const storyBlocks = storyContentBlockIds(presentation.en);
  const peopleBlocks = presentation.en.people.map((person) => `people:${person.id}`);
  const insightBlocks = presentation.en.highlights.map((highlight) => `insight:${highlight.id}`);
  const traceableBlocks = ["overview", ...peopleBlocks, ...storyBlocks, ...insightBlocks];
  if (review.coverageLedger !== undefined) {
    if (!review.coverageLedger || typeof review.coverageLedger !== "object"
      || Array.isArray(review.coverageLedger)
      || !onlyKeys(review.coverageLedger, [...STORY_COVERAGE_KEYS])
      || Object.keys(review.coverageLedger).length !== STORY_COVERAGE_KEYS.length) return false;
    for (const key of STORY_COVERAGE_KEYS) {
      const item = review.coverageLedger[key];
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      if (item.state === "not_supported") {
        if (!onlyKeys(item, ["state"])) return false;
      } else if (item.state === "represented") {
        if (!onlyKeys(item, ["state", "blockIds", "evidence"])
          || !Array.isArray(item.blockIds) || item.blockIds.length === 0
          || !item.blockIds.every((blockId) => typeof blockId === "string" && traceableBlocks.includes(blockId))
          || !uniqueValues(item.blockIds)
          || !Array.isArray(item.evidence) || item.evidence.length === 0
          || !item.evidence.every(validEvidence) || !uniqueValues(item.evidence.map(evidenceKey))) return false;
      } else if (item.state === "supporting_detail") {
        if (!onlyKeys(item, ["state", "evidence", "justification"])
          || !Array.isArray(item.evidence) || item.evidence.length === 0
          || !item.evidence.every(validEvidence) || !uniqueValues(item.evidence.map(evidenceKey))
          || typeof item.justification !== "string" || item.justification.trim().length < 12
          || item.justification.length > 2_000) return false;
      } else return false;
    }
  }
  if (review.claimTraceability !== undefined) {
    if (!Array.isArray(review.claimTraceability) || review.claimTraceability.length === 0
      || !review.claimTraceability.every((claim) => Boolean(claim && typeof claim === "object" && !Array.isArray(claim)
        && onlyKeys(claim, ["id", "kind", "blockId", "evidence", "unitIds"])
        && validStableId(claim.id)
        && (claim.kind === "factual_claim" || claim.kind === "insight_input")
        && typeof claim.blockId === "string" && traceableBlocks.includes(claim.blockId)
        && Array.isArray(claim.evidence) && claim.evidence.length > 0
        && claim.evidence.every(validEvidence) && uniqueValues(claim.evidence.map(evidenceKey))
        && (claim.unitIds === undefined || (Array.isArray(claim.unitIds)
          && claim.unitIds.length > 0 && claim.unitIds.every(validStableId)
          && uniqueValues(claim.unitIds)))))
      || !uniqueValues(review.claimTraceability.map((claim) => claim.id))) return false;
  }
  if (review.contextRetention !== undefined) {
    const retention = review.contextRetention;
    if (!retention || typeof retention !== "object" || Array.isArray(retention)
      || !onlyKeys(retention, [
        "schema", "sourceScope", "sourceUnitCount", "representedUnitCount",
        "excludedUnitCount", "units",
      ])
      || retention.schema !== "oxygen.story-context-retention/1"
      || !Array.isArray(retention.sourceScope) || retention.sourceScope.length === 0
      || !retention.sourceScope.every(validEvidence)
      || !uniqueValues(retention.sourceScope.map(evidenceKey))
      || !Number.isInteger(retention.sourceUnitCount) || retention.sourceUnitCount <= 0
      || !Number.isInteger(retention.representedUnitCount) || retention.representedUnitCount <= 0
      || !Number.isInteger(retention.excludedUnitCount) || retention.excludedUnitCount < 0
      || !Array.isArray(retention.units) || retention.units.length !== retention.sourceUnitCount
      || retention.representedUnitCount + retention.excludedUnitCount !== retention.sourceUnitCount
      || !retention.units.every((unit) => {
        if (!unit || typeof unit !== "object" || Array.isArray(unit)
          || !validStableId(unit.id)
          || !["instruction", "response", "decision", "failure", "correction", "progress", "result", "uncertainty"].includes(unit.kind)
          || !validEvidence(unit.evidence)) return false;
        if (unit.state === "represented") {
          return onlyKeys(unit, ["id", "kind", "evidence", "state", "blockIds"])
            && Array.isArray(unit.blockIds) && unit.blockIds.length > 0
            && unit.blockIds.every((blockId) => typeof blockId === "string" && storyBlocks.includes(blockId))
            && uniqueValues(unit.blockIds);
        }
        return unit.state === "excluded"
          && onlyKeys(unit, ["id", "kind", "evidence", "state", "reason"])
          && STORY_CONTEXT_EXCLUSION_REASONS.includes(unit.reason);
      })
      || !uniqueValues(retention.units.map((unit) => unit.id))
      || retention.units.filter((unit) => unit.state === "represented").length !== retention.representedUnitCount
      || retention.units.filter((unit) => unit.state === "excluded").length !== retention.excludedUnitCount) return false;
  }
  const validRole = (blockIds: unknown, allowed: string[]) => Array.isArray(blockIds)
    && blockIds.length > 0
    && blockIds.every((blockId) => typeof blockId === "string" && allowed.includes(blockId))
    && uniqueValues(blockIds);
  const openTension = review.roles.openTension;
  return validRole(review.roles.background, storyBlocks)
    && validRole(review.roles.evidenceThread, storyBlocks)
    && validRole(review.roles.turn, storyBlocks)
    && validRole(review.roles.result, storyBlocks)
    && validRole(review.roles.directLearning, insightBlocks)
    && validRole(review.roles.reusablePrinciple, insightBlocks)
    && Boolean(openTension && onlyKeys(openTension, ["state", "blockIds"])
      && (openTension.state === "supported" || openTension.state === "not_supported")
      && Array.isArray(openTension.blockIds)
      && uniqueValues(openTension.blockIds)
      && openTension.blockIds.every((blockId) => [...storyBlocks, ...insightBlocks].includes(blockId))
      && (openTension.state === "supported" ? openTension.blockIds.length > 0 : openTension.blockIds.length === 0))
    && typeof review.phase.rationale === "string"
    && review.phase.rationale.trim().length >= 12
    && review.phase.rationale.length <= 2_000
    && review.phase.assignmentCoherent === true
    && review.phase.adjacentBoundaryReviewed === true;
}

export type EvidenceTargetResolution =
  | { status: "resolved"; itemId: string; index: number }
  | { status: "missing" | "ambiguous" };

/** Resolve exact evidence against imported item IDs. Importers commonly qualify
 * IDs as `document:event`; Story metadata may retain the reviewed bare event ID.
 * Exact matches win, and a bare ID is accepted only when it has one match. */
export function resolveEvidenceTarget(
  items: Array<{ id: string }>,
  eventId: string,
): EvidenceTargetResolution {
  const exactIndex = items.findIndex((item) => item.id === eventId);
  if (exactIndex >= 0) return { status: "resolved", itemId: items[exactIndex].id, index: exactIndex };
  const matches = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.id.slice(item.id.lastIndexOf(":") + 1) === eventId);
  if (matches.length === 1) return { status: "resolved", itemId: matches[0].item.id, index: matches[0].index };
  return { status: matches.length ? "ambiguous" : "missing" };
}

export function parseStoryAnnotation(summary?: string): StoryAnnotation | LegacyStoryAnnotation | null {
  const prefix = summary?.startsWith(STORY_PREFIX)
    ? STORY_PREFIX
    : summary?.startsWith(LEGACY_STORY_PREFIX) ? LEGACY_STORY_PREFIX : "";
  if (!summary || !prefix) return null;
  try {
    const value = JSON.parse(summary.slice(prefix.length)) as Partial<StoryAnnotation> | Partial<LegacyStoryAnnotation>;
    if (!validStableId(value.key)
      || !nonEmptyString(value.phase) || !nonEmptyString(value.title)
      || !nonEmptyString(value.before) || !nonEmptyString(value.after)
      || !value.kind || !KINDS.has(value.kind)) return null;
    if (value.schema === "oxygen.story-milestone/1") {
      return nonEmptyString(value.narrative) ? value as LegacyStoryAnnotation : null;
    }
    if (value.schema !== "oxygen.story-highlight/2") return null;
    normalizeOptionalLocalizedPresentation(value.reviewPresentation);
    const episode = value.releaseEpisode;
    const evidence = value.evidence;
    if (
      !nonEmptyString(value.timelineSummary) || !nonEmptyString(value.whyThisMatters) || !episode || !value.insight
      || (value.metric !== undefined && typeof value.metric !== "string")
      || (value.importance !== undefined && (!Number.isFinite(value.importance) || value.importance < 0))
      || !nonEmptyString(value.insight.proposal) || !nonEmptyString(value.insight.rationale) || value.insight.reviewState !== "ai_proposed"
      || !Number.isFinite(episode.readingTimeMinutes) || episode.readingTimeMinutes <= 0
      || (episode.startTimestamp !== undefined && typeof episode.startTimestamp !== "string")
      || (episode.endTimestamp !== undefined && typeof episode.endTimestamp !== "string")
      || !nonEmptyString(episode.scene) || !nonEmptyStrings(episode.reconstruction) || !nonEmptyStrings(episode.importantDetails)
      || !nonEmptyString(episode.decisionOutcome)
      || (episode.uncertainty !== undefined && !nonEmptyString(episode.uncertainty))
      || !episode.compression || !nonEmptyString(episode.compression.sourceScope)
      || !nonEmptyStrings(episode.compression.retained) || !nonEmptyStrings(episode.compression.omittedLowValue)
      || !Array.isArray(episode.compression.omittedSensitive)
      || !episode.compression.omittedSensitive.every((item) => typeof item === "string")
      || !nonEmptyString(episode.compression.rewriteBrief) || !evidence || !validEvidence(evidence.primary)
      || !Array.isArray(evidence.supporting) || !evidence.supporting.every(validEvidence)
      || !uniqueValues([evidence.primary, ...evidence.supporting].map(evidenceKey))
      || value.sourceVersion?.defaultView !== "release"
      || value.sourceVersion?.originalState !== "local_evidence_only"
      || value.sourceVersion?.releaseState !== "ai_prepared_draft"
      || !nonEmptyString(value.sourceVersion.note)
      || !value.privacyReview?.state
      || !["reviewed_release", "needs_human_review", "not_applicable"].includes(value.privacyReview.state)
      || !nonEmptyString(value.privacyReview.note)
      || (value.privacyReview.prompt !== undefined && typeof value.privacyReview.prompt !== "string")
      || !validReviewPresentation(value.reviewPresentation)
      || (value.narrativeReview !== undefined
        && !validNarrativeReview(value.narrativeReview, value.reviewPresentation))
    ) return null;
    const annotation = value as StoryAnnotation;
    for (const presentation of [annotation.reviewPresentation.en, annotation.reviewPresentation.zh]) {
      if (!presentation) continue;
      const chapter = presentation.story as StoryChapter & { uncertainty?: string | null };
      if (chapter.uncertainty === null) delete chapter.uncertainty;
    }
    return annotation;
  } catch {
    return null;
  }
}

function validSuccessorStoryPerson(value: unknown): value is SuccessorStoryPerson {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !onlyKeys(value, ["id", "releaseLabel", "role", "description", "localIdentityState", "evidence"])) return false;
  const person = value as Partial<SuccessorStoryPerson>;
  return validStableId(person.id)
    && nonEmptyString(person.releaseLabel)
    && nonEmptyString(person.role)
    && nonEmptyString(person.description)
    && (person.localIdentityState === "not_identified" || person.localIdentityState === "local_only")
    && Array.isArray(person.evidence) && person.evidence.length > 0
    && person.evidence.every(validEvidence)
    && uniqueValues(person.evidence.map(evidenceKey));
}

function validSuccessorStoryBlock(value: unknown): value is SuccessorStoryBlock {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !onlyKeys(value, ["id", "text", "evidence"])) return false;
  const block = value as Partial<SuccessorStoryBlock>;
  return validStableId(block.id)
    && nonEmptyString(block.text) && block.text.length <= 20_000
    && Array.isArray(block.evidence) && block.evidence.length > 0
    && block.evidence.every(validEvidence)
    && uniqueValues(block.evidence.map(evidenceKey));
}

function validSuccessorStoryInsight(value: unknown): value is SuccessorStoryInsight {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !onlyKeys(value, [
      "id", "title", "background", "quote", "directlyAcquiredExperience", "principle", "evidence",
    ])) return false;
  const insight = value as Partial<SuccessorStoryInsight>;
  const quote = insight.quote;
  return validStableId(insight.id)
    && (insight.title === undefined || (typeof insight.title === "string" && insight.title.length <= 500))
    && nonEmptyString(insight.background) && insight.background.length <= 4_000
    && Boolean(quote && typeof quote === "object" && !Array.isArray(quote)
      && onlyKeys(quote, ["storyBlockIds"])
      && Array.isArray(quote.storyBlockIds) && quote.storyBlockIds.length > 0
      && quote.storyBlockIds.every(validStableId)
      && uniqueValues(quote.storyBlockIds))
    && nonEmptyString(insight.directlyAcquiredExperience)
    && insight.directlyAcquiredExperience.length <= 4_000
    && nonEmptyString(insight.principle) && insight.principle.length <= 4_000
    && Array.isArray(insight.evidence) && insight.evidence.length > 0
    && insight.evidence.every(validEvidence)
    && uniqueValues(insight.evidence.map(evidenceKey));
}

/** Parse the staged Story-First source contract. This is intentionally not
 * used by the current Timeline or Review Session activation path. */
export function parseSuccessorStorySource(summary?: string): SuccessorStorySource | null {
  if (!summary?.startsWith(SUCCESSOR_STORY_PREFIX)) return null;
  try {
    const value = JSON.parse(summary.slice(SUCCESSOR_STORY_PREFIX.length)) as Partial<SuccessorStorySource>;
    if (!value || typeof value !== "object" || Array.isArray(value)
      || !onlyKeys(value, [
        "schema", "key", "phase", "kind", "title", "overview", "people", "story",
        "insights", "evidence", "contextRetention",
      ])
      || value.schema !== "oxygen.story/3"
      || !validStableId(value.key)
      || !value.phase || typeof value.phase !== "object" || Array.isArray(value.phase)
      || !onlyKeys(value.phase, ["id", "label"])
      || !validStableId(value.phase.id) || !nonEmptyString(value.phase.label)
      || (value.kind !== undefined && !KINDS.has(value.kind))
      || !nonEmptyString(value.title) || value.title.length > 500
      || !nonEmptyString(value.overview) || value.overview.length > 20_000
      || !Array.isArray(value.people) || !value.people.every(validSuccessorStoryPerson)
      || !uniqueValues(value.people.map((person) => person.id))
      || !value.story || typeof value.story !== "object" || Array.isArray(value.story)
      || !onlyKeys(value.story, ["blocks", "uncertainty"])
      || !Array.isArray(value.story.blocks) || value.story.blocks.length === 0
      || !value.story.blocks.every(validSuccessorStoryBlock)
      || !uniqueValues(value.story.blocks.map((block) => block.id))
      || (value.story.uncertainty !== undefined
        && (!nonEmptyString(value.story.uncertainty) || value.story.uncertainty.length > 4_000))
      || !Array.isArray(value.insights) || !value.insights.every(validSuccessorStoryInsight)
      || !uniqueValues(value.insights.map((insight) => insight.id))
      || !value.evidence || typeof value.evidence !== "object" || Array.isArray(value.evidence)
      || !onlyKeys(value.evidence, ["primary", "supporting"])
      || !validEvidence(value.evidence.primary)
      || !Array.isArray(value.evidence.supporting) || !value.evidence.supporting.every(validEvidence)
      || !uniqueValues([value.evidence.primary, ...value.evidence.supporting].map(evidenceKey))
      || !value.contextRetention || typeof value.contextRetention !== "object"
      || Array.isArray(value.contextRetention) || !onlyKeys(value.contextRetention, ["excluded"])
      || !Array.isArray(value.contextRetention.excluded)
      || !value.contextRetention.excluded.every((item) => Boolean(item
        && typeof item === "object" && !Array.isArray(item)
        && onlyKeys(item, ["evidence", "reason"])
        && validEvidence(item.evidence)
        && STORY_CONTEXT_EXCLUSION_REASONS.includes(item.reason)))
      || !uniqueValues(value.contextRetention.excluded.map((item) => evidenceKey(item.evidence)))) return null;
    return value as SuccessorStorySource;
  } catch {
    return null;
  }
}

/** Explicit bounded dispatch. Malformed successor input never falls back to
 * an older Story parser. */
export function parseStorySource(
  summary?: string,
): StoryAnnotation | LegacyStoryAnnotation | SuccessorStorySource | null {
  return summary?.startsWith(SUCCESSOR_STORY_PREFIX)
    ? parseSuccessorStorySource(summary)
    : parseStoryAnnotation(summary);
}

export function milestoneKindLabel(kind: MilestoneKind, language: StoryLanguage = "en") {
  return language === "zh" ? KIND_LABELS_ZH[kind] : KIND_LABELS[kind];
}

function inferKind(text: string): MilestoneKind {
  let best: [number, MilestoneKind] = [0, "discovery"];
  for (const [term, weight, kind] of TRANSITION_TERMS) {
    if (text.includes(term) && weight > best[0]) best = [weight, kind];
  }
  return best[1];
}

function transitionScore(event: TimelineCandidate) {
  const summary = clean(event.summary);
  const content = clean(event.content);
  const text = `${summary} ${content}`.toLowerCase();
  if (!text || /^\[(?:tool|artifact|system|version control)/.test(text)) return -100;
  let value = 0;
  for (const [term, weight] of TRANSITION_TERMS) if (text.includes(term)) value += weight;
  for (const term of ROUTINE_TERMS) if (text.includes(term)) value -= 7;
  if (/\b\d+(?:\.\d+)?%\b|\b\d+\s*(?:→|->)\s*\d+\b/.test(text)) value += 5;
  if (/\b(?:because|therefore|instead|before|after|from|to)\b/.test(text)) value += 2;
  if (summary.length >= 24 && summary.length <= 150) value += 2;
  if (content.length > 90) value += 1;
  return value;
}

function eventOrder(a: TimelineCandidate, b: TimelineCandidate) {
  return String(a.timestamp || "").localeCompare(String(b.timestamp || ""))
    || Number(a.sequence || 0) - Number(b.sequence || 0)
    || a.id.localeCompare(b.id);
}

function inferredTitle(event: TimelineCandidate) {
  const summary = clean(event.summary);
  if (summary && !ROUTINE_TERMS.some((term) => summary.toLowerCase().includes(term))) return summary;
  const content = clean(event.content);
  const sentence = content.split(/(?<=[.!?])\s/)[0] || content;
  return sentence.slice(0, 140) || "Project state changed";
}

function canonicalStoryValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalStoryValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalStoryValue(item)]));
}

function explicitMilestones<T extends TimelineCandidate>(events: T[], maximum: number) {
  const seen = new Map<string, string>();
  const milestones: Array<TimelineMilestone<T>> = [];
  for (const event of events) {
    const annotation = parseStoryAnnotation(event.summary);
    if (!annotation) continue;
    const serialized = JSON.stringify(canonicalStoryValue(annotation));
    const previous = seen.get(annotation.key);
    if (previous) {
      if (previous !== serialized) throw new Error(`Conflicting reviewed Story chapter key: ${annotation.key}`);
      continue;
    }
    seen.set(annotation.key, serialized);
    const isEpisode = annotation.schema === "oxygen.story-highlight/2";
    milestones.push({
      ...event,
      story: {
        explicit: true,
        key: annotation.key,
        phase: annotation.phase,
        kind: annotation.kind,
        title: annotation.title,
        narrative: isEpisode ? annotation.timelineSummary : annotation.narrative,
        before: annotation.before,
        after: annotation.after,
        metric: annotation.metric,
        importance: Math.max(1, Math.min(5, annotation.importance || 3)),
        ...(isEpisode ? {
          whyThisMatters: annotation.whyThisMatters,
          releaseEpisode: annotation.releaseEpisode,
          insight: annotation.insight,
          evidence: annotation.evidence,
          sourceVersion: annotation.sourceVersion,
          privacyReview: annotation.privacyReview,
          reviewPresentation: annotation.reviewPresentation,
          narrativeReview: annotation.narrativeReview,
        } : {}),
      },
    });
  }
  if (milestones.length <= maximum) return milestones;
  const keep = new Set(
    [...milestones]
      .sort((a, b) => b.story.importance - a.story.importance || eventOrder(a, b))
      .slice(0, maximum)
      .map((event) => event.story.key),
  );
  return milestones.filter((event) => keep.has(event.story.key));
}

/**
 * Select meaningful project developments without distributing picks into time,
 * volume, or count buckets. Eligible developments include durable progress,
 * substantive iterations, failures, and consequential state transitions.
 * Explicit reviewed story annotations win; otherwise candidates are ranked
 * globally, routine updates are penalized, and repeated summaries collapse.
 */
export function selectProjectTimeline<T extends TimelineCandidate>(events: T[], maximum?: number): Array<TimelineMilestone<T>> {
  const ordered = [...events].sort(eventOrder);
  const explicit = explicitMilestones(ordered, maximum ?? Number.POSITIVE_INFINITY);
  if (explicit.length) return explicit;

  const unique = new Map<string, { event: T; score: number }>();
  for (const event of ordered) {
    const score = transitionScore(event);
    if (score < 5) continue;
    const title = inferredTitle(event);
    const key = normalize(title).slice(0, 120);
    if (!key) continue;
    const previous = unique.get(key);
    if (!previous || score > previous.score) unique.set(key, { event, score });
  }

  return [...unique.values()]
    .sort((a, b) => b.score - a.score || eventOrder(a.event, b.event))
    .slice(0, maximum ?? 40)
    .map(({ event, score }) => {
      const text = `${clean(event.summary)} ${clean(event.content)}`.toLowerCase();
      const title = inferredTitle(event);
      return {
        ...event,
        story: {
          explicit: false,
          key: `${event.documentId || event.document_id || "source"}:${event.id}`,
          phase: "Project evolution",
          kind: inferKind(text),
          title,
          narrative: clean(event.content).slice(0, 420) || title,
          importance: Math.max(1, Math.min(5, Math.ceil(score / 8))),
        },
      };
    })
    .sort(eventOrder);
}
