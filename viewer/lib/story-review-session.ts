import {
  privacyDecisionKey,
  validateChapterReviewCompletion,
  validateChapterReviewLedger,
  validateInsightReviewLedger,
  type ChapterReviewState,
  type PrivacyDecision,
} from "./story-review.ts";
import {
  storyReleaseTargetCatalog,
  type StoryLanguage,
  type StoryReleaseTarget,
  type TimelineMilestone,
} from "./timeline.ts";
import { isWorkflowRunId } from "./workflow-progress.ts";

export const STORY_REVIEW_SESSION_SCHEMA = "oxygen.story-review-session/1" as const;
export const MAX_STORY_REVIEW_SESSION_BYTES = 2_000_000;

export type StoryReviewSession = {
  schema: typeof STORY_REVIEW_SESSION_SCHEMA;
  workflowRunId: string;
  chapterReviews: Record<string, ChapterReviewState>;
  privacyDecisions: Record<string, PrivacyDecision>;
  updatedAt: string;
};

export type HydratedStoryReviewSession = Pick<StoryReviewSession, "chapterReviews" | "privacyDecisions">;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value)
  && typeof value === "object" && !Array.isArray(value);
const validStableId = (value: unknown): value is string => typeof value === "string"
  && value.trim().length > 0 && value.length <= 1_000;
const validDecision = (value: unknown): value is PrivacyDecision => value === "keep" || value === "redact";

function canonicalEvidence(value: unknown) {
  if (!isRecord(value)) return null;
  return { documentId: value.documentId, eventId: value.eventId };
}

function canonicalEvidenceList(value: unknown) {
  if (!Array.isArray(value) || value.length > 500) return null;
  const evidence = value.map(canonicalEvidence);
  return evidence.some((item) => !item) ? null : evidence;
}

function canonicalAnnotation(value: unknown) {
  if (!isRecord(value) || !isRecord(value.selection)) return null;
  const evidence = value.supportingEvidence === undefined ? undefined : canonicalEvidenceList(value.supportingEvidence);
  if (value.supportingEvidence !== undefined && !evidence) return null;
  return {
    id: value.id,
    blockId: value.blockId,
    type: value.type,
    sourceLanguage: value.sourceLanguage,
    selection: { start: value.selection.start, end: value.selection.end, text: value.selection.text },
    ...(value.instruction !== undefined ? { instruction: value.instruction } : {}),
    ...(evidence ? { supportingEvidence: evidence } : {}),
    resolution: value.resolution,
    baseRevision: value.baseRevision,
    ...(value.appliedRevision !== undefined ? { appliedRevision: value.appliedRevision } : {}),
  };
}

function canonicalEditTransaction(value: unknown) {
  if (!isRecord(value) || !isRecord(value.beforeRange) || !isRecord(value.afterRange)) return null;
  const evidence = value.supportingEvidence === undefined ? undefined : canonicalEvidenceList(value.supportingEvidence);
  if (value.supportingEvidence !== undefined && !evidence) return null;
  return {
    id: value.id,
    storyKey: value.storyKey,
    blockId: value.blockId,
    sourceLanguage: value.sourceLanguage,
    baseRevision: value.baseRevision,
    operation: value.operation,
    beforeText: value.beforeText,
    afterText: value.afterText,
    beforeRange: { start: value.beforeRange.start, end: value.beforeRange.end },
    afterRange: { start: value.afterRange.start, end: value.afterRange.end },
    resolution: value.resolution,
    requiresEvidence: value.requiresEvidence,
    ...(evidence ? { supportingEvidence: evidence } : {}),
    ...(value.appliedRevision !== undefined ? { appliedRevision: value.appliedRevision } : {}),
    ...(value.revertsTransactionId !== undefined ? { revertsTransactionId: value.revertsTransactionId } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function canonicalStringArray(value: unknown, maximum = 5_000) {
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== "string")) return null;
  return [...value] as string[];
}

function canonicalInsightReviews(value: unknown) {
  if (!isRecord(value) || Object.keys(value).length > 500) return null;
  const result: Record<string, unknown> = {};
  for (const [insightId, rawReview] of Object.entries(value)) {
    if (!isRecord(rawReview) || !isRecord(rawReview.localized)) return null;
    const pendingLanguages = canonicalStringArray(rawReview.pendingLanguages, 2);
    if (!pendingLanguages) return null;
    const localized: Record<string, unknown> = {};
    for (const [language, rawHighlight] of Object.entries(rawReview.localized)) {
      if ((language !== "en" && language !== "zh") || !isRecord(rawHighlight)) return null;
      localized[language] = {
        id: rawHighlight.id,
        title: rawHighlight.title,
        noticed: rawHighlight.noticed,
        lesson: rawHighlight.lesson,
      };
    }
    result[insightId] = {
      status: rawReview.status,
      text: rawReview.text,
      localized,
      pendingLanguages,
      ...(rawReview.revision !== undefined ? { revision: rawReview.revision } : {}),
      resolution: rawReview.resolution,
      ...(rawReview.appliedRevision !== undefined ? { appliedRevision: rawReview.appliedRevision } : {}),
    };
  }
  return result;
}

function canonicalDecisions(value: unknown) {
  if (!isRecord(value) || Object.keys(value).length > 5_000) return null;
  const result: Record<string, PrivacyDecision> = {};
  for (const [key, decision] of Object.entries(value)) {
    if (!validStableId(key) || !validDecision(decision)) return null;
    result[key] = decision;
  }
  return result;
}

function canonicalRevision(value: unknown) {
  if (!isRecord(value)) return null;
  const annotationIds = canonicalStringArray(value.annotationIds);
  const editTransactionIds = value.editTransactionIds === undefined
    ? undefined : canonicalStringArray(value.editTransactionIds);
  const insightIds = canonicalStringArray(value.insightIds);
  const privacyDecisions = canonicalDecisions(value.privacyDecisions);
  if (!annotationIds || (value.editTransactionIds !== undefined && !editTransactionIds)
    || !insightIds || !privacyDecisions) return null;
  return {
    revision: value.revision,
    annotationIds,
    ...(editTransactionIds ? { editTransactionIds } : {}),
    insightIds,
    privacyDecisions,
  };
}

function canonicalChapterReview(value: unknown) {
  if (!isRecord(value)
    || !Array.isArray(value.annotations) || value.annotations.length > 5_000
    || !Array.isArray(value.editTransactions) || value.editTransactions.length > 5_000
    || !Array.isArray(value.staleTranslations) || value.staleTranslations.length > 1_000
    || !Array.isArray(value.revisionHistory) || value.revisionHistory.length > 5_000) return null;
  const annotations = value.annotations.map(canonicalAnnotation);
  const editTransactions = value.editTransactions.map(canonicalEditTransaction);
  const redoTransactionIds = canonicalStringArray(value.redoTransactionIds);
  const insightReviews = canonicalInsightReviews(value.insightReviews);
  const appliedPrivacyDecisions = canonicalDecisions(value.appliedPrivacyDecisions);
  const redactedBlocks = canonicalStringArray(value.redactedBlocks);
  const revisionHistory = value.revisionHistory.map(canonicalRevision);
  const staleTranslations = value.staleTranslations.map((item) => isRecord(item)
    ? { subject: item.subject, language: item.language, count: item.count }
    : null);
  if (annotations.some((item) => !item) || editTransactions.some((item) => !item)
    || !redoTransactionIds || !insightReviews || !appliedPrivacyDecisions || !redactedBlocks
    || staleTranslations.some((item) => !item) || revisionHistory.some((item) => !item)) return null;
  return {
    stage: value.stage,
    revision: value.revision,
    annotations,
    editTransactions,
    redoTransactionIds,
    insightReviews,
    appliedPrivacyDecisions,
    redactedBlocks,
    staleTranslations,
    revisionHistory,
    evidenceVerified: value.evidenceVerified,
    publicationApproved: value.publicationApproved,
  } as unknown as ChapterReviewState;
}

/** Reconstruct the local persistence envelope from an explicit allowlist. This
 * removes unknown/private payload fields before the session can be stored or
 * hydrated. Source-bound ledger validation happens in `hydrateStoryReviewSession`. */
export function canonicalizeStoryReviewSession(value: unknown): StoryReviewSession | null {
  if (!isRecord(value)
    || value.schema !== STORY_REVIEW_SESSION_SCHEMA
    || !isWorkflowRunId(value.workflowRunId)
    || !isRecord(value.chapterReviews)
    || Object.keys(value.chapterReviews).length > 500
    || typeof value.updatedAt !== "string" || !value.updatedAt.trim() || value.updatedAt.length > 100) return null;
  let serializedSize = MAX_STORY_REVIEW_SESSION_BYTES + 1;
  try { serializedSize = new TextEncoder().encode(JSON.stringify(value)).byteLength; } catch { return null; }
  if (serializedSize > MAX_STORY_REVIEW_SESSION_BYTES) return null;
  const privacyDecisions = canonicalDecisions(value.privacyDecisions);
  if (!privacyDecisions) return null;
  const chapterReviews: Record<string, ChapterReviewState> = {};
  for (const [storyKey, rawReview] of Object.entries(value.chapterReviews)) {
    if (!validStableId(storyKey)) return null;
    const review = canonicalChapterReview(rawReview);
    if (!review) return null;
    chapterReviews[storyKey] = review;
  }
  return {
    schema: STORY_REVIEW_SESSION_SCHEMA,
    workflowRunId: value.workflowRunId,
    chapterReviews,
    privacyDecisions,
    updatedAt: value.updatedAt,
  };
}

export function createStoryReviewSession(
  workflowRunId: string,
  chapterReviews: Record<string, ChapterReviewState>,
  privacyDecisions: Record<string, PrivacyDecision>,
  updatedAt = new Date().toISOString(),
) {
  return canonicalizeStoryReviewSession({
    schema: STORY_REVIEW_SESSION_SCHEMA,
    workflowRunId,
    chapterReviews,
    privacyDecisions,
    updatedAt,
  });
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort()
    .map((key) => [key, stableJsonValue(value[key])]));
}

/** Compare the canonical schema-1 review meaning while excluding only the
 * top-level compatibility timestamp, which is server-owned at persistence. */
export function storyReviewSessionSemanticJson(value: unknown) {
  const session = canonicalizeStoryReviewSession(value);
  return session ? JSON.stringify(stableJsonValue({ ...session, updatedAt: "" })) : null;
}

function sourceBlocks(milestone: TimelineMilestone) {
  return (["en", "zh"] as const).reduce<Record<StoryLanguage, Record<string, string>>>((result, language) => {
    const presentation = milestone.story.reviewPresentation?.[language];
    if (!presentation) return result;
    result[language] = {
      scene: presentation.story.scene,
      ...Object.fromEntries(presentation.story.reconstruction.map((copy, index) => [`reconstruction-${index}`, copy])),
      ...Object.fromEntries(presentation.story.importantDetails.map((copy, index) => [`detail-${index}`, copy])),
      outcome: presentation.story.decisionOutcome,
      ...(presentation.story.uncertainty ? { uncertainty: presentation.story.uncertainty } : {}),
    };
    return result;
  }, { en: {}, zh: {} });
}

function validPersistedReview(state: ChapterReviewState, milestone: TimelineMilestone) {
  const storyKey = milestone.story.key;
  const presentation = milestone.story.reviewPresentation?.en;
  const targetCatalog = presentation ? storyReleaseTargetCatalog(presentation) : null;
  if (!presentation
    || !targetCatalog
    || !["reviewing", "revision_ready", "human_confirmed"].includes(state.stage)
    || typeof state.evidenceVerified !== "boolean"
    || state.publicationApproved !== false
    || !isRecord(state.appliedPrivacyDecisions)
    || Object.entries(state.appliedPrivacyDecisions).some(([id, decision]) => (
      !presentation.privacy.candidates.some((candidate) => candidate.id === id) || !validDecision(decision)
    ))) return false;
  const sources = sourceBlocks(milestone);
  const blockIds = new Set(Object.keys(sources.en));
  const insightIds = presentation.highlights.map((highlight) => highlight.id);
  if (!Array.isArray(state.redactedBlocks)
    || state.redactedBlocks.some((id) => !targetCatalog.has(id as StoryReleaseTarget))
    || new Set(state.redactedBlocks).size !== state.redactedBlocks.length
    || !Array.isArray(state.staleTranslations)
    || state.staleTranslations.some((item) => !item
      || (item.language !== "en" && item.language !== "zh")
      || !Number.isInteger(item.count) || item.count < 1
      || (typeof item.subject !== "string")
      || (item.subject.startsWith("story:") && !blockIds.has(item.subject.slice("story:".length)))
      || (item.subject.startsWith("insight:") && !insightIds.includes(item.subject.slice("insight:".length)))
      || (!item.subject.startsWith("story:") && !item.subject.startsWith("insight:")))) return false;
  try {
    if (!validateChapterReviewLedger(state, storyKey, sources, sources)
      || !validateInsightReviewLedger(state, insightIds)) return false;
    if (state.stage !== "reviewing" && !validateChapterReviewCompletion(state, {
      storyKey,
      privacyCandidates: presentation.privacy.candidates,
      privacyDecisions: state.appliedPrivacyDecisions,
      targetCatalog,
      reviewableInsightIds: insightIds,
      sourceBlocks: sources,
      reviewedBlocks: sources,
    })) return false;
  } catch {
    return false;
  }
  return true;
}

/** Hydrate only source-valid project-local review state for this exact runtime
 * and Chapter set. Malformed, stale, foreign-run, or forged entries are dropped
 * before they can affect editor state, progress, All set, or release. */
export function hydrateStoryReviewSession(
  value: unknown,
  workflowRunId: string,
  milestones: TimelineMilestone[],
): HydratedStoryReviewSession {
  const empty = { chapterReviews: {}, privacyDecisions: {} };
  const session = canonicalizeStoryReviewSession(value);
  if (!session || session.workflowRunId !== workflowRunId) return empty;
  const milestoneMap = new Map<string, TimelineMilestone>();
  for (const milestone of milestones) {
    if (milestoneMap.has(milestone.story.key)) return empty;
    milestoneMap.set(milestone.story.key, milestone);
  }
  const chapterReviews: Record<string, ChapterReviewState> = {};
  for (const [storyKey, state] of Object.entries(session.chapterReviews)) {
    const milestone = milestoneMap.get(storyKey);
    if (milestone && validPersistedReview(state, milestone)) chapterReviews[storyKey] = state;
  }
  const privacyDecisions: Record<string, PrivacyDecision> = {};
  for (const [key, decision] of Object.entries(session.privacyDecisions)) {
    try {
      const tuple = JSON.parse(key) as unknown;
      if (!Array.isArray(tuple) || tuple.length !== 2 || !tuple.every(validStableId)
        || privacyDecisionKey(tuple[0], tuple[1]) !== key) continue;
      const milestone = milestoneMap.get(tuple[0]);
      if (milestone?.story.reviewPresentation?.en.privacy.candidates.some((candidate) => candidate.id === tuple[1])) {
        privacyDecisions[key] = decision;
      }
    } catch {
      // A malformed composite key is ignored without affecting valid Chapters.
    }
  }
  return { chapterReviews, privacyDecisions };
}
