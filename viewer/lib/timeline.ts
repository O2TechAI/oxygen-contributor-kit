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
  passageContext?: Record<string, StoryPassageContext>;
  highlights: StoryHighlightItem[];
  privacy: {
    summary: string;
    candidates: StoryPrivacyCandidate[];
  };
};

export type EpisodeReviewPresentation = {
  en: StoryLanguagePresentation;
  zh: StoryLanguagePresentation;
  projectSummary?: Record<StoryLanguage, string>;
  semanticAnchors: string[];
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
};

type LegacyStoryAnnotation = {
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

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\p{L}]+/gu, " ").trim();
}

const nonEmptyStrings = (value: unknown) => Array.isArray(value)
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
    && Boolean(candidate.original.excerpt && candidate.original.sourceLanguage
      && ["en", "zh"].includes(candidate.original.sourceLanguage));
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

function validPassageContext(value: unknown, blockIds: string[]) {
  if (value === undefined) return true;
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
  return [
    "phase", "title", "overview", "before", "after",
    ...value.people.map((person) => `people:${person.id}`),
    ...storyContentBlockIds(value),
    ...value.highlights.map((highlight) => `insight:${highlight.id}`),
  ];
}

function validReviewLanguage(value: unknown): value is StoryLanguagePresentation {
  if (!value || typeof value !== "object") return false;
  const copy = value as Partial<StoryLanguagePresentation>;
  const people = copy.people;
  const story = copy.story;
  const highlights = copy.highlights;
  const privacy = copy.privacy;
  return Boolean(
    copy.phase && copy.title && copy.timelineSummary && copy.before && copy.after && copy.overview
    && Array.isArray(copy.timelineChips) && copy.timelineChips.every((chip) => typeof chip === "string" && chip.trim())
    && Array.isArray(people) && people.every((person) => (
      validStableId(person.id)
      && typeof person.releaseLabel === "string" && Boolean(person.releaseLabel.trim())
      && typeof person.role === "string" && Boolean(person.role.trim())
      && typeof person.description === "string" && Boolean(person.description.trim())
      && ["not_identified", "local_only"].includes(person.localIdentityState)
    ))
    && story?.scene && nonEmptyStrings(story.reconstruction)
    && nonEmptyStrings(story.importantDetails) && story.decisionOutcome
    && (story.uncertainty === undefined || story.uncertainty === null
      || (typeof story.uncertainty === "string" && Boolean(story.uncertainty.trim())))
    && validPassageContext(copy.passageContext, story ? storyContentBlockIds(copy as StoryLanguagePresentation) : [])
    && Array.isArray(highlights) && highlights.length === 1
    && highlights.every((item) => validStableId(item.id)
      && typeof item.title === "string" && Boolean(item.title.trim())
      && typeof item.noticed === "string" && Boolean(item.noticed.trim())
      && typeof item.lesson === "string" && Boolean(item.lesson.trim()))
    && privacy?.summary && Array.isArray(privacy.candidates)
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

function validReviewPresentation(value: unknown): value is EpisodeReviewPresentation {
  if (!value || typeof value !== "object") return false;
  const presentation = value as Partial<EpisodeReviewPresentation>;
  if (!validReviewLanguage(presentation.en)
      || !validReviewLanguage(presentation.zh)
      || (presentation.projectSummary !== undefined
        && (!presentation.projectSummary
          || typeof presentation.projectSummary !== "object"
          || !(typeof presentation.projectSummary.en === "string" && presentation.projectSummary.en.trim())
          || !(typeof presentation.projectSummary.zh === "string" && presentation.projectSummary.zh.trim())
          || presentation.projectSummary.en.length > 20_000
          || presentation.projectSummary.zh.length > 20_000))
      || !nonEmptyStrings(presentation.semanticAnchors)
      || !uniqueValues(presentation.semanticAnchors)
      || presentation.semanticAnchors.some((anchor) => anchor.length > 500)) return false;
  const en = presentation.en;
  const zh = presentation.zh;
  const enText = readerFacingPresentationText(en);
  const zhText = readerFacingPresentationText(zh);
  const enBlocks = semanticBlockIds(en);
  const zhBlocks = semanticBlockIds(zh);
  return presentation.semanticAnchors.every((anchor) => enText.includes(anchor) && zhText.includes(anchor))
    && sameOrderedValues(en.people.map((person) => person.id), zh.people.map((person) => person.id))
    && sameOrderedValues(en.people.map((person) => person.releaseLabel), zh.people.map((person) => person.releaseLabel))
    && sameOrderedValues(en.people.map((person) => person.localIdentityState), zh.people.map((person) => person.localIdentityState))
    && sameOrderedValues(en.highlights.map((highlight) => highlight.id), zh.highlights.map((highlight) => highlight.id))
    && sameOrderedValues(Object.keys(en.passageContext || {}).sort(), Object.keys(zh.passageContext || {}).sort())
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
    if (!validStableId(value.key) || !value.phase || !value.title || !value.before || !value.after || !value.kind || !KINDS.has(value.kind)) return null;
    if (value.schema === "oxygen.story-milestone/1") {
      return value.narrative ? value as LegacyStoryAnnotation : null;
    }
    if (value.schema !== "oxygen.story-highlight/2") return null;
    const episode = value.releaseEpisode;
    const evidence = value.evidence;
    if (
      !value.timelineSummary || !value.whyThisMatters || !episode || !value.insight
      || !value.insight.proposal || !value.insight.rationale || value.insight.reviewState !== "ai_proposed"
      || !episode.scene || !nonEmptyStrings(episode.reconstruction) || !nonEmptyStrings(episode.importantDetails)
      || !episode.decisionOutcome || !episode.compression || !episode.compression.sourceScope
      || !nonEmptyStrings(episode.compression.retained) || !nonEmptyStrings(episode.compression.omittedLowValue)
      || !episode.compression.rewriteBrief || !evidence || !validEvidence(evidence.primary)
      || !Array.isArray(evidence.supporting) || !evidence.supporting.every(validEvidence)
      || !uniqueValues([evidence.primary, ...evidence.supporting].map(evidenceKey))
      || value.sourceVersion?.defaultView !== "release"
      || value.sourceVersion?.originalState !== "local_evidence_only"
      || value.sourceVersion?.releaseState !== "ai_prepared_draft"
      || !value.sourceVersion.note || !value.privacyReview?.state || !value.privacyReview.note
      || !validReviewPresentation(value.reviewPresentation)
    ) return null;
    const annotation = value as StoryAnnotation;
    for (const language of ["en", "zh"] as const) {
      const chapter = annotation.reviewPresentation[language].story as StoryChapter & { uncertainty?: string | null };
      if (chapter.uncertainty === null) delete chapter.uncertainty;
    }
    return annotation;
  } catch {
    return null;
  }
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
 * Select meaningful project state transitions without distributing picks into
 * time or volume buckets. Explicit reviewed story annotations win; otherwise
 * candidates are ranked globally, routine updates are penalized, and repeated
 * summaries collapse to one milestone.
 */
export function selectProjectTimeline<T extends TimelineCandidate>(events: T[], maximum = 40): Array<TimelineMilestone<T>> {
  const ordered = [...events].sort(eventOrder);
  const explicit = explicitMilestones(ordered, maximum);
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
    .slice(0, maximum)
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
