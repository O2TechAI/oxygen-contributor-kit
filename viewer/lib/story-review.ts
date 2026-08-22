import type { StoryHighlightItem, StoryLanguage, StoryPrivacyCandidate } from "./timeline";

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
  resolution: StoryAnnotationResolution;
  baseRevision: number;
  appliedRevision?: number;
};

export type StoryAnnotationSegment = {
  text: string;
  annotationIds: string[];
};

export type ChapterReviewStage = "reviewing" | "revision_ready" | "human_confirmed";

export type ChapterReviewState = {
  stage: ChapterReviewStage;
  revision: number;
  annotations: StoryReviewAnnotation[];
  publicationApproved: false;
};

export const emptyChapterReview = (): ChapterReviewState => ({
  stage: "reviewing",
  revision: 1,
  annotations: [],
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
  return {
    ...state,
    stage: "reviewing",
    annotations: [...state.annotations, annotation],
  };
}

export function cancelStoryAnnotation(state: ChapterReviewState, annotationId: string): ChapterReviewState {
  const annotations = state.annotations.map((annotation) => annotation.id === annotationId
    ? { ...annotation, resolution: "cancelled" as const }
    : annotation);
  const hasUnresolved = annotations.some((annotation) => annotation.resolution === "pending" || annotation.resolution === "needs_evidence");
  return { ...state, stage: hasUnresolved || state.revision === 1 ? "reviewing" : "revision_ready", annotations };
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
  return {
    delete: active.filter((annotation) => annotation.type === "delete").length,
    revise: active.filter((annotation) => annotation.type === "revise").length,
    add: active.filter((annotation) => annotation.type === "add").length,
    unresolved: active.filter((annotation) => annotation.resolution === "pending" || annotation.resolution === "needs_evidence").length,
  };
}

export function applyChapterReview(
  state: ChapterReviewState,
  privacyComplete: boolean,
): { state: ChapterReviewState; blockedReason?: "privacy" } {
  if (!privacyComplete) return { state, blockedReason: "privacy" };
  const revision = state.revision + 1;
  return {
    state: {
      ...state,
      stage: "revision_ready",
      revision,
      annotations: state.annotations.map((annotation) => {
        if (annotation.resolution !== "pending") return annotation;
        return {
          ...annotation,
          resolution: annotation.type === "add" ? "needs_evidence" : "applied",
          ...(annotation.type === "add" ? {} : { appliedRevision: revision }),
        };
      }),
    },
  };
}

export function canMarkChapterReady(state: ChapterReviewState, privacyComplete: boolean) {
  return privacyComplete
    && state.stage === "revision_ready"
    && !state.annotations.some((annotation) => annotation.resolution === "pending" || annotation.resolution === "needs_evidence");
}

export function markChapterReady(state: ChapterReviewState, privacyComplete: boolean): ChapterReviewState {
  return canMarkChapterReady(state, privacyComplete) ? { ...state, stage: "human_confirmed" } : state;
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
  const applicable = annotations.filter((annotation) => annotation.blockId === blockId && annotation.resolution === "applied" && annotation.appliedRevision);
  let result = source;
  const revisions = [...new Set(applicable.map((annotation) => annotation.appliedRevision!))].sort((a, b) => a - b);
  for (const revision of revisions) {
    const group = applicable.filter((annotation) => annotation.appliedRevision === revision).sort((a, b) => b.selection.start - a.selection.start);
    for (const annotation of group) {
      if (annotation.type === "delete") {
        result = annotation.sourceLanguage === language
          ? `${result.slice(0, annotation.selection.start)}${result.slice(annotation.selection.end)}`.replace(/\s{2,}/g, " ").trim()
          : "";
      } else if (annotation.type === "revise" && annotation.instruction) {
        const prefix = language === "zh" ? "人工修订：" : "Human revision: ";
        result = annotation.sourceLanguage === language
          ? `${result.slice(0, annotation.selection.start)}${annotation.instruction}${result.slice(annotation.selection.end)}`.trim()
          : `${prefix}${annotation.instruction}`;
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
  const reviewed = candidates.filter((candidate) => decisions[candidate.id]).length;
  const activeIndex = candidates.findIndex((candidate) => !decisions[candidate.id]);
  return {
    reviewed,
    activeIndex,
    active: activeIndex >= 0 ? candidates[activeIndex] : null,
    complete: candidates.length > 0 && activeIndex < 0,
  };
}
