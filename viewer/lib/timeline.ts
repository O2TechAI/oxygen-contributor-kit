export type StorySourceIdentity = {
  id: string;
  sequence?: number;
  timestamp?: string | null;
  documentId?: string;
  document_id?: string;
};

export type TimelineCandidate = StorySourceIdentity & {
  summary?: string;
  content?: string;
  project?: string;
};

export const STORY_PREFIX = "oxygen.story:";

/** Permanent total order for stored Story source identity. Missing timestamps
 * sort first; stable row ID is the final tie-breaker. */
export function compareStorySourceIdentity(a: StorySourceIdentity, b: StorySourceIdentity) {
  const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  return compareText(String(a.timestamp || ""), String(b.timestamp || ""))
    || compareText(
      String(a.documentId || a.document_id || ""),
      String(b.documentId || b.document_id || ""),
    )
    || Number(a.sequence || 0) - Number(b.sequence || 0)
    || compareText(a.id, b.id);
}

export type StoryKind =
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

export type StoryLanguage = "en" | "zh";

export type StoryReleaseTargetName =
  | "phase"
  | "title"
  | "overview"
  | "transition:before"
  | "transition:after"
  | `people:${string}:releaseLabel`
  | `people:${string}:role`
  | `people:${string}:description`
  | `story:${string}`
  | "uncertainty"
  | `insight:${string}:title`
  | `insight:${string}:background`
  | `insight:${string}:directlyAcquiredExperience`
  | `insight:${string}:principle`;

export type StoryReleaseTarget = `${string}::${StoryReleaseTargetName}`;

export type StoryReleaseTargetDescriptor = {
  id: StoryReleaseTarget;
  storyKey: string;
  target: StoryReleaseTargetName;
};

export type StoryReleaseTargetCatalog = ReadonlyMap<StoryReleaseTarget, StoryReleaseTargetDescriptor>;

export type StoryPrivacyCandidate = {
  id: string;
  reviewState: "deterministic" | "needs_confirmation";
  title: string;
  whyFlagged: string;
  uncertaintyReason: string | null;
  releaseTargets: StoryReleaseTarget[];
};

export type StoryPerson = {
  id: string;
  releaseLabel: string;
  role: string;
  description: string;
  localIdentityState: "not_identified" | "local_only";
  evidence: EvidenceReference[];
};

export type StoryBlock = {
  id: string;
  text: string;
  evidence: EvidenceReference[];
};

export type StoryInsight = {
  id: string;
  title?: string;
  background: string;
  quote: { storyBlockIds: string[] };
  directlyAcquiredExperience: string;
  principle: string;
  evidence: EvidenceReference[];
};

export const STORY_SEMANTIC_EXCLUSION_REASONS = [
  "duplicate",
  "privacy_withheld",
  "routine_non_narrative",
  "outside_story_scope",
] as const;
export const MAX_STORY_SEMANTIC_UNIT_REFERENCES = 512;

export type StorySemanticExclusionReason = typeof STORY_SEMANTIC_EXCLUSION_REASONS[number];

export type StoryCoverage = {
  semanticManifest: { revision: number; digest: string };
  coverageManifest: { revision: number; digest: string };
  representedUnitIds: string[];
  excludedUnits: Array<{ unitId: string; reason: StorySemanticExclusionReason }>;
};

export type StorySource = {
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

export type TimelinePresentation = Pick<StorySource, "kind" | "chips"> & {
  before?: string;
  after?: string;
  marker?: "ai_insight";
};

/** Preserve source-owned Timeline fields exactly; do not invent presentation. */
export function timelinePresentation(source: StorySource): TimelinePresentation {
  const presentation: TimelinePresentation = {};
  if (source.kind !== undefined) presentation.kind = source.kind;
  if (source.transition !== undefined) {
    presentation.before = source.transition.before;
    presentation.after = source.transition.after;
  }
  if (source.chips !== undefined) presentation.chips = source.chips;
  if (source.insights.length > 0) presentation.marker = "ai_insight";
  return presentation;
}

const STORY_KINDS = new Set<StoryKind>([
  "foundation", "discovery", "baseline", "problem", "failure", "root_cause",
  "decision", "direction_change", "breakthrough", "quantitative_change",
  "validation", "freeze", "handoff", "current_state",
]);

const STORY_KIND_LABELS: Record<StoryKind, string> = {
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

const STORY_KIND_LABELS_ZH: Record<StoryKind, string> = {
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

export function storyKindLabel(kind: StoryKind, language: StoryLanguage = "en") {
  return language === "zh" ? STORY_KIND_LABELS_ZH[kind] : STORY_KIND_LABELS[kind];
}

const onlyKeys = (value: object, allowed: string[]) => (
  Object.keys(value).every((key) => allowed.includes(key))
);
const nonEmptyString = (value: unknown): value is string => (
  typeof value === "string" && Boolean(value.trim())
);
const validStableId = (value: unknown): value is string => (
  nonEmptyString(value) && value.length <= 1_000
);
const uniqueValues = (values: string[]) => new Set(values).size === values.length;
const evidenceKey = (reference: EvidenceReference) => (
  JSON.stringify([reference.documentId, reference.eventId])
);

function validEvidence(value: unknown): value is EvidenceReference {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !onlyKeys(value, ["documentId", "eventId", "label"])) return false;
  const reference = value as Partial<EvidenceReference>;
  return validStableId(reference.documentId)
    && validStableId(reference.eventId)
    && (reference.label === undefined || (
      typeof reference.label === "string" && reference.label.length <= 500
    ));
}

function validStoryPerson(value: unknown): value is StoryPerson {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !onlyKeys(value, ["id", "releaseLabel", "role", "description", "localIdentityState", "evidence"])) return false;
  const person = value as Partial<StoryPerson>;
  return validStableId(person.id)
    && nonEmptyString(person.releaseLabel)
    && nonEmptyString(person.role)
    && nonEmptyString(person.description)
    && (person.localIdentityState === "not_identified" || person.localIdentityState === "local_only")
    && Array.isArray(person.evidence) && person.evidence.length > 0
    && person.evidence.every(validEvidence)
    && uniqueValues(person.evidence.map(evidenceKey));
}

function validStoryBlock(value: unknown): value is StoryBlock {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !onlyKeys(value, ["id", "text", "evidence"])) return false;
  const block = value as Partial<StoryBlock>;
  return validStableId(block.id)
    && nonEmptyString(block.text) && block.text.length <= 20_000
    && Array.isArray(block.evidence) && block.evidence.length > 0
    && block.evidence.every(validEvidence)
    && uniqueValues(block.evidence.map(evidenceKey));
}

function validStoryInsight(value: unknown): value is StoryInsight {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !onlyKeys(value, [
      "id", "title", "background", "quote", "directlyAcquiredExperience", "principle", "evidence",
    ])) return false;
  const insight = value as Partial<StoryInsight>;
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

export function parseStorySource(summary?: string): StorySource | null {
  if (!summary?.startsWith(STORY_PREFIX)) return null;
  try {
    const value = JSON.parse(summary.slice(STORY_PREFIX.length)) as Partial<StorySource>;
    if (!value || typeof value !== "object" || Array.isArray(value)
      || !onlyKeys(value, [
        "schema", "key", "phase", "kind", "title", "overview", "transition", "chips",
        "people", "story", "insights", "evidence", "coverage",
      ])
      || value.schema !== "oxygen.story"
      || !validStableId(value.key)
      || !value.phase || typeof value.phase !== "object" || Array.isArray(value.phase)
      || !onlyKeys(value.phase, ["id", "label"])
      || !validStableId(value.phase.id) || !nonEmptyString(value.phase.label)
      || (value.kind !== undefined && !STORY_KINDS.has(value.kind))
      || !nonEmptyString(value.title) || value.title.length > 500
      || !nonEmptyString(value.overview) || value.overview.length > 20_000
      || (value.transition !== undefined && (
        !value.transition || typeof value.transition !== "object" || Array.isArray(value.transition)
        || !onlyKeys(value.transition, ["before", "after"])
        || !nonEmptyString(value.transition.before) || value.transition.before.length > 500
        || !nonEmptyString(value.transition.after) || value.transition.after.length > 500
      ))
      || (value.chips !== undefined && (
        !Array.isArray(value.chips) || value.chips.length > 12
        || !value.chips.every((chip) => nonEmptyString(chip) && chip.length <= 200)
        || !uniqueValues(value.chips)
      ))
      || !Array.isArray(value.people) || !value.people.every(validStoryPerson)
      || !uniqueValues(value.people.map((person) => person.id))
      || !value.story || typeof value.story !== "object" || Array.isArray(value.story)
      || !onlyKeys(value.story, ["blocks", "uncertainty"])
      || !Array.isArray(value.story.blocks) || value.story.blocks.length === 0
      || !value.story.blocks.every(validStoryBlock)
      || !uniqueValues(value.story.blocks.map((block) => block.id))
      || (value.story.uncertainty !== undefined
        && (!nonEmptyString(value.story.uncertainty) || value.story.uncertainty.length > 4_000))
      || !Array.isArray(value.insights) || !value.insights.every(validStoryInsight)
      || !uniqueValues(value.insights.map((insight) => insight.id))
      || !value.evidence || typeof value.evidence !== "object" || Array.isArray(value.evidence)
      || !onlyKeys(value.evidence, ["primary", "supporting"])
      || !validEvidence(value.evidence.primary)
      || !Array.isArray(value.evidence.supporting) || !value.evidence.supporting.every(validEvidence)
      || !uniqueValues([value.evidence.primary, ...value.evidence.supporting].map(evidenceKey))
      || !value.coverage || typeof value.coverage !== "object" || Array.isArray(value.coverage)
      || !onlyKeys(value.coverage, [
        "semanticManifest", "coverageManifest", "representedUnitIds", "excludedUnits",
      ])
      || !value.coverage.semanticManifest
      || typeof value.coverage.semanticManifest !== "object"
      || Array.isArray(value.coverage.semanticManifest)
      || !onlyKeys(value.coverage.semanticManifest, ["revision", "digest"])
      || !Number.isSafeInteger(value.coverage.semanticManifest.revision)
      || value.coverage.semanticManifest.revision <= 0
      || typeof value.coverage.semanticManifest.digest !== "string"
      || !/^[0-9a-f]{64}$/.test(value.coverage.semanticManifest.digest)
      || !value.coverage.coverageManifest
      || typeof value.coverage.coverageManifest !== "object"
      || Array.isArray(value.coverage.coverageManifest)
      || !onlyKeys(value.coverage.coverageManifest, ["revision", "digest"])
      || !Number.isSafeInteger(value.coverage.coverageManifest.revision)
      || value.coverage.coverageManifest.revision <= 0
      || typeof value.coverage.coverageManifest.digest !== "string"
      || !/^[0-9a-f]{64}$/.test(value.coverage.coverageManifest.digest)
      || !Array.isArray(value.coverage.representedUnitIds)
      || !value.coverage.representedUnitIds.every(validStableId)
      || !uniqueValues(value.coverage.representedUnitIds)
      || !Array.isArray(value.coverage.excludedUnits)
      || value.coverage.representedUnitIds.length + value.coverage.excludedUnits.length
        > MAX_STORY_SEMANTIC_UNIT_REFERENCES
      || !value.coverage.excludedUnits.every((item) => Boolean(item
        && typeof item === "object" && !Array.isArray(item)
        && onlyKeys(item, ["unitId", "reason"])
        && validStableId(item.unitId)
        && STORY_SEMANTIC_EXCLUSION_REASONS.includes(item.reason)))
      || !uniqueValues(value.coverage.excludedUnits.map((item) => item.unitId))
      || value.coverage.excludedUnits.some((item) => (
        value.coverage?.representedUnitIds.includes(item.unitId)
      ))) return null;
    return value as StorySource;
  } catch {
    return null;
  }
}

export type EvidenceTargetResolution =
  | { status: "resolved"; itemId: string; index: number }
  | { status: "missing" | "ambiguous" };

/** Resolve exact evidence against imported item IDs. Importers commonly qualify
 * IDs as `document:event`; Story metadata may retain the reviewed bare event ID. */
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
