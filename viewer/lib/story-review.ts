import type {
  EvidenceReference,
  StoryHighlightItem,
  StoryLanguage,
  StoryPrivacyCandidate,
} from "./timeline";

export type PrivacyDecision = "keep" | "redact";

export type StoryAnnotationType = "delete" | "revise" | "add";
export type StoryAnnotationResolution = "pending" | "applied" | "needs_evidence" | "cancelled";

export type StoryReviewAnnotation = {
  id: string;
  blockId: string;
  type: StoryAnnotationType;
  sourceLanguage: StoryLanguage;
  selection: { start: number; end: number; text: string };
  instruction?: string;
  supportingEvidence?: EvidenceReference[];
  resolution: StoryAnnotationResolution;
  baseRevision: number;
  appliedRevision?: number;
};

export type StoryAnnotationSegment = {
  text: string;
  annotationIds: string[];
};

export type InsightReviewStatus = "accepted" | "needs_changes" | "rejected" | "overridden";
export type InsightReview = {
  status: InsightReviewStatus;
  text: string;
  localized: Partial<Record<StoryLanguage, StoryHighlightItem>>;
  pendingLanguages: StoryLanguage[];
  revision?: "direct" | "ai";
  resolution: "pending" | "applied";
  appliedRevision?: number;
};

export type TranslationStaleness = {
  subject: `story:${string}` | `insight:${string}`;
  language: StoryLanguage;
  count: number;
};

export type ChapterRevisionRecord = {
  revision: number;
  annotationIds: string[];
  insightIds: string[];
  privacyDecisions: Record<string, PrivacyDecision>;
};

export type ChapterReviewStage = "reviewing" | "revision_ready" | "human_confirmed";

export type ChapterReviewState = {
  stage: ChapterReviewStage;
  revision: number;
  annotations: StoryReviewAnnotation[];
  insightReviews: Record<string, InsightReview>;
  appliedPrivacyDecisions: Record<string, PrivacyDecision>;
  redactedBlocks: string[];
  staleTranslations: TranslationStaleness[];
  revisionHistory: ChapterRevisionRecord[];
  evidenceVerified: boolean;
  publicationApproved: false;
};

export type ApplyReviewContext = {
  privacyCandidates: StoryPrivacyCandidate[];
  privacyDecisions: Record<string, PrivacyDecision>;
  chapterEvidence: EvidenceReference[];
  evidenceResolved: boolean;
  supportedAddIds: string[];
  reviewedBlocks: Record<StoryLanguage, Record<string, string>>;
};

export const emptyChapterReview = (): ChapterReviewState => ({
  stage: "reviewing",
  revision: 1,
  annotations: [],
  insightReviews: {},
  appliedPrivacyDecisions: {},
  redactedBlocks: [],
  staleTranslations: [],
  revisionHistory: [],
  evidenceVerified: false,
  publicationApproved: false,
});

export function createStoryAnnotation(input: Omit<StoryReviewAnnotation, "id" | "resolution">): StoryReviewAnnotation {
  const instruction = input.instruction?.trim();
  return {
    ...input,
    id: `${input.blockId}:${input.type}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
    ...(instruction ? { instruction } : {}),
    resolution: "pending",
  };
}

export function addStoryAnnotation(state: ChapterReviewState, annotation: StoryReviewAnnotation): ChapterReviewState {
  if (state.stage === "human_confirmed" || hasStoryAnnotationConflict(state, annotation)) return state;
  return {
    ...state,
    stage: "reviewing",
    annotations: [...state.annotations, annotation],
  };
}

const rangesOverlap = (left: StoryReviewAnnotation, right: StoryReviewAnnotation) => (
  left.selection.start < right.selection.end && right.selection.start < left.selection.end
);

export function hasStoryAnnotationConflict(state: ChapterReviewState, candidate: StoryReviewAnnotation) {
  return state.annotations.some((annotation) => annotation.id === candidate.id
    || (annotation.resolution === "pending"
      && annotation.blockId === candidate.blockId
      && annotation.sourceLanguage === candidate.sourceLanguage
      && annotation.baseRevision === candidate.baseRevision
      && rangesOverlap(annotation, candidate)));
}

export function cancelStoryAnnotation(state: ChapterReviewState, annotationId: string): ChapterReviewState {
  const target = state.annotations.find((annotation) => annotation.id === annotationId);
  if (!target || !["pending", "needs_evidence"].includes(target.resolution)) return state;
  const annotations = state.annotations.map((annotation) => annotation.id === annotationId
    ? { ...annotation, resolution: "cancelled" as const }
    : annotation);
  return { ...state, stage: "reviewing", annotations };
}

export function updateInsightReview(
  state: ChapterReviewState,
  highlightId: string,
  language: StoryLanguage,
  update: Omit<InsightReview, "localized" | "pendingLanguages" | "resolution" | "appliedRevision"> & { highlight?: StoryHighlightItem },
): ChapterReviewState {
  if (state.stage === "human_confirmed") return state;
  const previous = state.insightReviews[highlightId];
  const localized = { ...(previous?.localized || {}) };
  if (update.highlight) localized[language] = update.highlight;
  const pendingLanguages = update.highlight
    ? [...new Set([...(previous?.resolution === "pending" ? previous.pendingLanguages : []), language])]
    : previous?.resolution === "pending" ? previous.pendingLanguages : [];
  return {
    ...state,
    stage: "reviewing",
    insightReviews: {
      ...state.insightReviews,
      [highlightId]: {
        status: update.status,
        text: update.text,
        localized,
        pendingLanguages,
        ...(update.revision ? { revision: update.revision } : {}),
        resolution: "pending",
      },
    },
  };
}

export function storyAnnotationSegments(
  source: string,
  blockId: string,
  language: StoryLanguage,
  revision: number,
  annotations: StoryReviewAnnotation[],
): StoryAnnotationSegment[] {
  const ranges = annotations.filter((annotation) => annotation.blockId === blockId
    && annotation.sourceLanguage === language
    && annotation.baseRevision === revision
    && annotation.resolution === "pending"
    && Number.isInteger(annotation.selection.start)
    && Number.isInteger(annotation.selection.end)
    && annotation.selection.start >= 0
    && annotation.selection.end > annotation.selection.start
    && annotation.selection.end <= source.length
    && source.slice(annotation.selection.start, annotation.selection.end) === annotation.selection.text);
  if (!ranges.length) return [{ text: source, annotationIds: [] }];

  const boundaries = [...new Set([0, source.length, ...ranges.flatMap((annotation) => [annotation.selection.start, annotation.selection.end])])]
    .sort((a, b) => a - b);
  return boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1];
    return {
      text: source.slice(start, end),
      annotationIds: ranges
        .filter((annotation) => annotation.selection.start <= start && annotation.selection.end >= end)
        .map((annotation) => annotation.id),
    };
  }).filter((segment) => segment.text.length > 0);
}

export function chapterReviewSummary(state: ChapterReviewState) {
  const active = state.annotations.filter((annotation) => annotation.resolution !== "cancelled");
  const pendingInsights = Object.values(state.insightReviews).filter((review) => review.resolution === "pending").length;
  return {
    delete: active.filter((annotation) => annotation.type === "delete").length,
    revise: active.filter((annotation) => annotation.type === "revise").length,
    add: active.filter((annotation) => annotation.type === "add").length,
    unresolved: active.filter((annotation) => annotation.resolution === "pending" || annotation.resolution === "needs_evidence").length
      + pendingInsights + state.staleTranslations.length,
  };
}

const evidenceKey = (evidence: EvidenceReference) => JSON.stringify([evidence.documentId, evidence.eventId]);
const oppositeLanguage = (language: StoryLanguage): StoryLanguage => language === "en" ? "zh" : "en";
const validPrivacyDecision = (value: unknown): value is PrivacyDecision => value === "keep" || value === "redact";

function updateTranslationStaleness(
  current: TranslationStaleness[],
  subject: TranslationStaleness["subject"],
  sourceLanguage: StoryLanguage,
) {
  const resolvesPairedLocale = current.some((item) => item.subject === subject && item.language === sourceLanguage);
  if (resolvesPairedLocale) return current.flatMap((item) => item.subject === subject && item.language === sourceLanguage
    ? item.count > 1 ? [{ ...item, count: item.count - 1 }] : []
    : [item]);
  const target = oppositeLanguage(sourceLanguage);
  return current.some((item) => item.subject === subject && item.language === target)
    ? current.map((item) => item.subject === subject && item.language === target ? { ...item, count: item.count + 1 } : item)
    : [...current, { subject, language: target, count: 1 }];
}

function privacyComplete(context: ApplyReviewContext) {
  const ids = context.privacyCandidates.map((candidate) => candidate.id);
  return new Set(ids).size === ids.length
    && context.privacyCandidates.every((candidate) => {
      const decision = context.privacyDecisions[candidate.id];
      return validPrivacyDecision(decision);
    });
}

function currentPrivacyDecisions(context: ApplyReviewContext) {
  return Object.fromEntries(context.privacyCandidates.map((candidate) => [candidate.id, context.privacyDecisions[candidate.id]])) as Record<string, PrivacyDecision>;
}

function sameDecisions(left: Record<string, PrivacyDecision>, right: Record<string, PrivacyDecision>) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

export function applyChapterReview(
  state: ChapterReviewState,
  context: ApplyReviewContext,
): { state: ChapterReviewState; blockedReason?: "privacy" | "evidence" | "annotations" } {
  if (!privacyComplete(context)) return { state, blockedReason: "privacy" };
  if (!context.evidenceResolved) return { state, blockedReason: "evidence" };
  const pendingAnnotations = state.annotations.filter((annotation) => annotation.resolution === "pending");
  if (new Set(pendingAnnotations.map((annotation) => annotation.id)).size !== pendingAnnotations.length) {
    return { state, blockedReason: "annotations" };
  }
  const conflicting = new Set<string>();
  for (let index = 0; index < pendingAnnotations.length; index += 1) {
    for (let compare = index + 1; compare < pendingAnnotations.length; compare += 1) {
      const left = pendingAnnotations[index];
      const right = pendingAnnotations[compare];
      if (left.blockId === right.blockId && left.sourceLanguage === right.sourceLanguage
        && left.baseRevision === right.baseRevision && rangesOverlap(left, right)) {
        conflicting.add(left.id);
        conflicting.add(right.id);
      }
    }
  }
  const invalidRange = pendingAnnotations.some((annotation) => {
    const source = context.reviewedBlocks[annotation.sourceLanguage]?.[annotation.blockId];
    return conflicting.has(annotation.id)
      || !annotation.id
      || !annotation.blockId
      || !["delete", "revise", "add"].includes(annotation.type)
      || !["en", "zh"].includes(annotation.sourceLanguage)
      || ((annotation.type === "revise" || annotation.type === "add") && !annotation.instruction?.trim())
      || annotation.baseRevision !== state.revision
      || !Number.isInteger(annotation.selection.start)
      || !Number.isInteger(annotation.selection.end)
      || annotation.selection.start < 0
      || annotation.selection.end <= annotation.selection.start
      || typeof source !== "string"
      || annotation.selection.end > source.length
      || source.slice(annotation.selection.start, annotation.selection.end) !== annotation.selection.text;
  });
  if (invalidRange) return { state, blockedReason: "annotations" };
  const revision = state.revision + 1;
  const availableEvidence = new Set(context.chapterEvidence.map(evidenceKey));
  const supportedAddIds = new Set(context.supportedAddIds);
  const appliedAnnotationIds: string[] = [];
  let staleTranslations = [...state.staleTranslations];
  const annotations = state.annotations.map((annotation) => {
    if (annotation.resolution !== "pending") return annotation;
    const supportedAddition = annotation.type !== "add"
      || Boolean(supportedAddIds.has(annotation.id)
        && annotation.supportingEvidence?.length
        && annotation.supportingEvidence.every((evidence) => availableEvidence.has(evidenceKey(evidence))));
    if (!supportedAddition) return { ...annotation, resolution: "needs_evidence" as const };
    appliedAnnotationIds.push(annotation.id);
    staleTranslations = updateTranslationStaleness(
      staleTranslations,
      `story:${annotation.blockId}`,
      annotation.sourceLanguage,
    );
    return { ...annotation, resolution: "applied" as const, appliedRevision: revision };
  });

  const appliedInsightIds: string[] = [];
  const insightReviews = Object.fromEntries(Object.entries(state.insightReviews).map(([highlightId, review]) => {
    if (review.resolution !== "pending") return [highlightId, review];
    appliedInsightIds.push(highlightId);
    if (review.status === "rejected") {
      staleTranslations = staleTranslations.filter((item) => item.subject !== `insight:${highlightId}`);
    } else {
      for (const language of review.pendingLanguages) {
        staleTranslations = updateTranslationStaleness(
          staleTranslations,
          `insight:${highlightId}`,
          language,
        );
      }
    }
    return [highlightId, { ...review, pendingLanguages: [], resolution: "applied" as const, appliedRevision: revision }];
  })) as Record<string, InsightReview>;

  const appliedPrivacyDecisions = currentPrivacyDecisions(context);
  const redactedBlocks = [...new Set<string>(context.privacyCandidates.flatMap((candidate) => (
    appliedPrivacyDecisions[candidate.id] === "redact" ? candidate.releaseTargets : []
  )))];
  staleTranslations = staleTranslations.filter((item) => item.subject.startsWith("story:")
    ? !redactedBlocks.includes(item.subject.slice("story:".length))
    : !redactedBlocks.includes(item.subject));
  return {
    state: {
      ...state,
      stage: "revision_ready",
      revision,
      annotations,
      insightReviews,
      appliedPrivacyDecisions,
      redactedBlocks,
      staleTranslations,
      evidenceVerified: true,
      revisionHistory: [...state.revisionHistory, {
        revision,
        annotationIds: appliedAnnotationIds,
        insightIds: appliedInsightIds,
        privacyDecisions: appliedPrivacyDecisions,
      }],
    },
  };
}

export function canMarkChapterReady(state: ChapterReviewState, context: ApplyReviewContext) {
  return privacyComplete(context)
    && sameDecisions(state.appliedPrivacyDecisions, currentPrivacyDecisions(context))
    && state.stage === "revision_ready"
    && state.evidenceVerified
    && state.staleTranslations.length === 0
    && !state.annotations.some((annotation) => annotation.resolution === "pending" || annotation.resolution === "needs_evidence")
    && !Object.values(state.insightReviews).some((review) => review.resolution === "pending");
}

export function markChapterReady(state: ChapterReviewState, context: ApplyReviewContext): ChapterReviewState {
  return canMarkChapterReady(state, context) ? { ...state, stage: "human_confirmed" } : state;
}

export function returnChapterToReview(state: ChapterReviewState): ChapterReviewState {
  return { ...state, stage: "reviewing" };
}

export function applyAnnotationsToBlock(
  source: string,
  blockId: string,
  language: StoryLanguage,
  annotations: StoryReviewAnnotation[],
) {
  const applicable = annotations.filter((annotation) => annotation.blockId === blockId
    && annotation.sourceLanguage === language
    && annotation.resolution === "applied"
    && annotation.appliedRevision);
  let result = source;
  const revisions = [...new Set(applicable.map((annotation) => annotation.appliedRevision!))].sort((a, b) => a - b);
  for (const revision of revisions) {
    const group = applicable.filter((annotation) => annotation.appliedRevision === revision).sort((a, b) => b.selection.start - a.selection.start);
    for (const annotation of group) {
      if (result.slice(annotation.selection.start, annotation.selection.end) !== annotation.selection.text) continue;
      if (annotation.type === "delete") {
        result = `${result.slice(0, annotation.selection.start)}${result.slice(annotation.selection.end)}`.replace(/\s{2,}/g, " ").trim();
      } else if (annotation.type === "revise" && annotation.instruction) {
        result = `${result.slice(0, annotation.selection.start)}${annotation.instruction}${result.slice(annotation.selection.end)}`.trim();
      } else if (annotation.type === "add" && annotation.instruction) {
        const separator = /\s$/.test(annotation.selection.text) ? "" : " ";
        result = `${result.slice(0, annotation.selection.end)}${separator}${annotation.instruction}${result.slice(annotation.selection.end)}`.trim();
      }
    }
  }
  return result;
}

export function reviseHighlight(
  highlight: StoryHighlightItem,
  instruction: string,
  language: StoryLanguage,
): StoryHighlightItem | null {
  const direction = instruction.trim();
  if (!direction) return null;
  return {
    ...highlight,
    noticed: language === "zh"
      ? `根据人工要求，重点调整为：${direction}`
      : `Revised emphasis: ${direction}`,
    lesson: direction,
  };
}

export function privacyReviewState(
  candidates: StoryPrivacyCandidate[],
  decisions: Record<string, PrivacyDecision>,
) {
  const uniqueIds = new Set(candidates.map((candidate) => candidate.id)).size === candidates.length;
  if (!uniqueIds) {
    return { reviewed: 0, activeIndex: 0, active: candidates[0] || null, complete: false };
  }
  const reviewed = candidates.filter((candidate) => validPrivacyDecision(decisions[candidate.id])).length;
  const activeIndex = candidates.findIndex((candidate) => !validPrivacyDecision(decisions[candidate.id]));
  return {
    reviewed,
    activeIndex,
    active: activeIndex >= 0 ? candidates[activeIndex] : null,
    complete: activeIndex < 0,
  };
}
