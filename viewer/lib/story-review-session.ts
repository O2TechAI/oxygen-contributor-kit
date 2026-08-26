import {
  privacyDecisionKey,
  successorStoryBlocks,
  validateChapterReviewCompletion,
  validateChapterReviewLedger,
  validateInsightReviewLedger,
  validateSuccessorChapterReviewCompletion,
  validateSuccessorChapterReviewLedger,
  type ChapterReviewState,
  type PrivacyDecision,
  type SuccessorChapterReviewContext,
  type SuccessorChapterReviewState,
  type SuccessorHumanInsightContent,
  type SuccessorHumanInsightReview,
  type SuccessorInsightContent,
  type SuccessorInsightRevisionRecord,
  type SuccessorSourceInsightReview,
} from "./story-review.ts";
import {
  SUCCESSOR_STORY_PREFIX,
  parseSuccessorStorySource,
  storyReleaseTargetCatalog,
  type SuccessorStorySource,
  type StoryLanguage,
  type StoryReleaseTarget,
  type TimelineMilestone,
} from "./timeline.ts";
import { isWorkflowRunId } from "./workflow-progress.ts";

export const STORY_REVIEW_SESSION_SCHEMA = "oxygen.story-review-session/1" as const;
export const SUCCESSOR_STORY_REVIEW_SESSION_SCHEMA = "oxygen.story-review-session/2" as const;
export const MAX_STORY_REVIEW_SESSION_BYTES = 2_000_000;

export type StoryReviewSession = {
  schema: typeof STORY_REVIEW_SESSION_SCHEMA;
  workflowRunId: string;
  chapterReviews: Record<string, ChapterReviewState>;
  privacyDecisions: Record<string, PrivacyDecision>;
  updatedAt: string;
};

export type SuccessorStoryReviewSession = {
  schema: typeof SUCCESSOR_STORY_REVIEW_SESSION_SCHEMA;
  workflowRunId: string;
  chapterReviews: Record<string, SuccessorChapterReviewState>;
  privacyDecisions: Record<string, PrivacyDecision>;
  updatedAt: string;
};

export type AnyStoryReviewSession = StoryReviewSession | SuccessorStoryReviewSession;

export type HydratedStoryReviewSession = Pick<StoryReviewSession, "chapterReviews" | "privacyDecisions">;
export type HydratedSuccessorStoryReviewSession = Pick<SuccessorStoryReviewSession, "chapterReviews" | "privacyDecisions">;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value)
  && typeof value === "object" && !Array.isArray(value);
const validStableId = (value: unknown): value is string => typeof value === "string"
  && value.trim().length > 0 && value.length <= 1_000;
const validDecision = (value: unknown): value is PrivacyDecision => value === "keep" || value === "redact";
const onlyKeys = (value: object, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));

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

function canonicalSuccessorInsightContent(value: unknown): SuccessorInsightContent | null {
  if (!isRecord(value) || !isRecord(value.quote)
    || !onlyKeys(value, ["title", "background", "quote", "directlyAcquiredExperience", "principle", "evidence"])
    || !onlyKeys(value.quote, ["storyBlockIds"])) return null;
  const storyBlockIds = canonicalStringArray(value.quote.storyBlockIds, 500);
  const evidence = canonicalEvidenceList(value.evidence);
  if (!storyBlockIds || storyBlockIds.length === 0 || !storyBlockIds.every(validStableId)
    || new Set(storyBlockIds).size !== storyBlockIds.length
    || !evidence || evidence.length === 0
    || evidence.some((item) => !validStableId(item!.documentId) || !validStableId(item!.eventId))
    || new Set(evidence.map((item) => JSON.stringify(item))).size !== evidence.length
    || (value.title !== undefined && (typeof value.title !== "string" || value.title.length > 500))
    || typeof value.background !== "string" || !value.background.trim() || value.background.length > 4_000
    || typeof value.directlyAcquiredExperience !== "string"
    || !value.directlyAcquiredExperience.trim() || value.directlyAcquiredExperience.length > 4_000
    || typeof value.principle !== "string" || !value.principle.trim() || value.principle.length > 4_000) return null;
  return {
    ...(value.title === undefined ? {} : { title: value.title }),
    background: value.background,
    quote: { storyBlockIds },
    directlyAcquiredExperience: value.directlyAcquiredExperience,
    principle: value.principle,
    evidence: evidence as SuccessorInsightContent["evidence"],
  };
}

function canonicalSuccessorHumanInsightContent(value: unknown): SuccessorHumanInsightContent | null {
  if (!isRecord(value) || !isRecord(value.quote) || !isRecord(value.quote.selection)
    || !onlyKeys(value, ["title", "background", "quote", "directlyAcquiredExperience", "principle", "evidence"])
    || !onlyKeys(value.quote, ["chapterKey", "storyBlockId", "selection", "baseRevision"])
    || !onlyKeys(value.quote.selection, ["start", "end", "text"])
    || !validStableId(value.quote.chapterKey) || !validStableId(value.quote.storyBlockId)) return null;
  const selectionStart = value.quote.selection.start;
  const selectionEnd = value.quote.selection.end;
  const selectionText = value.quote.selection.text;
  const baseRevision = value.quote.baseRevision;
  if (typeof selectionStart !== "number" || typeof selectionEnd !== "number"
    || typeof selectionText !== "string" || typeof baseRevision !== "number") return null;
  const content = canonicalSuccessorInsightContent({
    ...value,
    quote: { storyBlockIds: [value.quote.storyBlockId] },
  });
  return content ? {
    ...content,
    quote: {
      chapterKey: value.quote.chapterKey,
      storyBlockId: value.quote.storyBlockId,
      selection: {
        start: selectionStart,
        end: selectionEnd,
        text: selectionText,
      },
      baseRevision,
    },
  } : null;
}

function canonicalSourceInsightReview(value: unknown): SuccessorSourceInsightReview | null {
  if (!isRecord(value)
    || value.origin !== "source_ai"
    || !Number.isInteger(value.version) || Number(value.version) < 1
    || !["pending", "accepted", "rejected"].includes(String(value.decision))
    || (value.resolution !== "pending" && value.resolution !== "applied")) return null;
  const editedContent = value.editedContent === undefined ? undefined : canonicalSuccessorInsightContent(value.editedContent);
  if ((value.editedContent !== undefined && !editedContent)
    || (editedContent === undefined ? value.version !== 1 : Number(value.version) < 2)
    || (value.resolution === "pending"
      ? value.appliedVersion !== undefined || value.appliedRevision !== undefined
      : value.decision === "pending"
        || !Number.isInteger(value.appliedVersion) || Number(value.appliedVersion) < 1
        || !Number.isInteger(value.appliedRevision) || Number(value.appliedRevision) < 2)) return null;
  return {
    origin: "source_ai",
    version: Number(value.version),
    decision: value.decision as SuccessorSourceInsightReview["decision"],
    resolution: value.resolution,
    ...(editedContent ? { editedContent } : {}),
    ...(value.appliedVersion === undefined ? {} : { appliedVersion: Number(value.appliedVersion) }),
    ...(value.appliedRevision === undefined ? {} : { appliedRevision: Number(value.appliedRevision) }),
  };
}

function canonicalHumanInsightReview(value: unknown): SuccessorHumanInsightReview | null {
  if (!isRecord(value)
    || value.origin !== "human_created"
    || !Number.isInteger(value.version) || Number(value.version) < 1
    || (value.decision !== "draft" && value.decision !== "human_approved")
    || (value.resolution !== "pending" && value.resolution !== "applied")) return null;
  const content = canonicalSuccessorHumanInsightContent(value.content);
  if (!content
    || (value.resolution === "pending"
      ? value.appliedVersion !== undefined || value.appliedRevision !== undefined
      : value.decision !== "human_approved"
        || !Number.isInteger(value.appliedVersion) || Number(value.appliedVersion) < 1
        || !Number.isInteger(value.appliedRevision) || Number(value.appliedRevision) < 2)) return null;
  return {
    origin: "human_created",
    version: Number(value.version),
    decision: value.decision,
    resolution: value.resolution,
    content,
    ...(value.appliedVersion === undefined ? {} : { appliedVersion: Number(value.appliedVersion) }),
    ...(value.appliedRevision === undefined ? {} : { appliedRevision: Number(value.appliedRevision) }),
  };
}

function canonicalSuccessorRevision(value: unknown): SuccessorInsightRevisionRecord | null {
  if (!isRecord(value)
    || !Number.isInteger(value.revision) || Number(value.revision) < 2
    || !validStableId(value.insightId)
    || (value.origin !== "source_ai" && value.origin !== "human_created")
    || !Number.isInteger(value.version) || Number(value.version) < 1
    || (value.origin === "source_ai" && value.decision !== "accepted" && value.decision !== "rejected")
    || (value.origin === "human_created" && value.decision !== "human_approved")) return null;
  return {
    revision: Number(value.revision),
    insightId: value.insightId,
    origin: value.origin,
    version: Number(value.version),
    decision: value.decision as SuccessorInsightRevisionRecord["decision"],
  };
}

function canonicalSuccessorChapterReview(value: unknown): SuccessorChapterReviewState | null {
  if (!isRecord(value)
    || !isRecord(value.sourceInsightReviews) || Object.keys(value.sourceInsightReviews).length > 500
    || !isRecord(value.humanInsights) || Object.keys(value.humanInsights).length > 500
    || !Array.isArray(value.successorInsightRevisionHistory)
    || value.successorInsightRevisionHistory.length > 5_000) return null;
  const common = canonicalChapterReview(value);
  if (!common || Object.keys(common.insightReviews).length !== 0) return null;
  const sourceEntries = Object.entries(value.sourceInsightReviews).sort(([left], [right]) => left.localeCompare(right));
  const humanEntries = Object.entries(value.humanInsights).sort(([left], [right]) => left.localeCompare(right));
  if (sourceEntries.some(([id]) => !validStableId(id))
    || humanEntries.some(([id]) => !validStableId(id) || !id.startsWith("human:"))) return null;
  const sourceReviews = sourceEntries.map(([id, review]) => [id, canonicalSourceInsightReview(review)] as const);
  const humanReviews = humanEntries.map(([id, review]) => [id, canonicalHumanInsightReview(review)] as const);
  const history = value.successorInsightRevisionHistory.map(canonicalSuccessorRevision);
  if (sourceReviews.some(([, review]) => !review)
    || humanReviews.some(([, review]) => !review)
    || history.some((record) => !record)) return null;
  const sortedHistory = (history as SuccessorInsightRevisionRecord[]).sort((left, right) => (
    left.revision - right.revision
      || left.origin.localeCompare(right.origin)
      || left.insightId.localeCompare(right.insightId)
  ));
  if (new Set(sortedHistory.map((record) => JSON.stringify([record.revision, record.origin, record.insightId]))).size
    !== sortedHistory.length) return null;
  return {
    ...common,
    sourceInsightReviews: Object.fromEntries(sourceReviews) as Record<string, SuccessorSourceInsightReview>,
    humanInsights: Object.fromEntries(humanReviews) as Record<string, SuccessorHumanInsightReview>,
    successorInsightRevisionHistory: sortedHistory,
  };
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

export function canonicalizeSuccessorStoryReviewSession(value: unknown): SuccessorStoryReviewSession | null {
  if (!isRecord(value)
    || value.schema !== SUCCESSOR_STORY_REVIEW_SESSION_SCHEMA
    || !isWorkflowRunId(value.workflowRunId)
    || !isRecord(value.chapterReviews)
    || Object.keys(value.chapterReviews).length > 500
    || typeof value.updatedAt !== "string" || !value.updatedAt.trim() || value.updatedAt.length > 100) return null;
  let serializedSize = MAX_STORY_REVIEW_SESSION_BYTES + 1;
  try { serializedSize = new TextEncoder().encode(JSON.stringify(value)).byteLength; } catch { return null; }
  if (serializedSize > MAX_STORY_REVIEW_SESSION_BYTES) return null;
  const privacyDecisions = canonicalDecisions(value.privacyDecisions);
  if (!privacyDecisions) return null;
  const chapterReviews: Record<string, SuccessorChapterReviewState> = {};
  for (const [storyKey, rawReview] of Object.entries(value.chapterReviews).sort(([left], [right]) => left.localeCompare(right))) {
    if (!validStableId(storyKey)) return null;
    const review = canonicalSuccessorChapterReview(rawReview);
    if (!review) return null;
    chapterReviews[storyKey] = review;
  }
  return {
    schema: SUCCESSOR_STORY_REVIEW_SESSION_SCHEMA,
    workflowRunId: value.workflowRunId,
    chapterReviews,
    privacyDecisions: Object.fromEntries(Object.entries(privacyDecisions).sort(([left], [right]) => left.localeCompare(right))),
    updatedAt: value.updatedAt,
  };
}

/** Exact schema dispatch only; malformed successor payloads never become v1. */
export function parseStoryReviewSession(value: unknown): AnyStoryReviewSession | null {
  if (!isRecord(value)) return null;
  return value.schema === SUCCESSOR_STORY_REVIEW_SESSION_SCHEMA
    ? canonicalizeSuccessorStoryReviewSession(value)
    : value.schema === STORY_REVIEW_SESSION_SCHEMA ? canonicalizeStoryReviewSession(value) : null;
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

export function createSuccessorStoryReviewSession(
  workflowRunId: string,
  chapterReviews: Record<string, SuccessorChapterReviewState>,
  privacyDecisions: Record<string, PrivacyDecision>,
  updatedAt = new Date().toISOString(),
) {
  return canonicalizeSuccessorStoryReviewSession({
    schema: SUCCESSOR_STORY_REVIEW_SESSION_SCHEMA,
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

function successorReviewContext(source: SuccessorStorySource): SuccessorChapterReviewContext {
  const blocks = successorStoryBlocks(source);
  return {
    source,
    privacyCandidates: [],
    privacyDecisions: {},
    targetCatalog: new Map(),
    evidenceResolved: true,
    supportedAddIds: [],
    supportedEditIds: [],
    sourceBlocks: blocks,
    reviewedBlocks: blocks,
  };
}

function validPersistedSuccessorReview(state: SuccessorChapterReviewState, source: SuccessorStorySource) {
  if (![
    "reviewing", "revision_ready", "human_confirmed",
  ].includes(state.stage)
    || typeof state.evidenceVerified !== "boolean"
    || state.publicationApproved !== false
    || Object.keys(state.appliedPrivacyDecisions || {}).length !== 0
    || !Array.isArray(state.redactedBlocks) || state.redactedBlocks.length !== 0
    || !Array.isArray(state.staleTranslations)) return false;
  const storyIds = new Set(source.story.blocks.map((block) => block.id));
  const insightIds = new Set([
    ...source.insights.map((insight) => insight.id),
    ...Object.keys(state.humanInsights || {}),
  ]);
  if (state.staleTranslations.some((item) => !item
    || (item.language !== "en" && item.language !== "zh")
    || !Number.isInteger(item.count) || item.count < 1
    || typeof item.subject !== "string"
    || (item.subject.startsWith("story:") && !storyIds.has(item.subject.slice("story:".length)))
    || (item.subject.startsWith("insight:") && !insightIds.has(item.subject.slice("insight:".length)))
    || (!item.subject.startsWith("story:") && !item.subject.startsWith("insight:")))) return false;
  const allowedEvidence = new Set([source.evidence.primary, ...source.evidence.supporting]
    .map((item) => JSON.stringify([item.documentId, item.eventId])));
  const reviewEvidence = [...state.annotations.flatMap((item) => item.supportingEvidence || []),
    ...state.editTransactions.flatMap((item) => item.supportingEvidence || [])];
  if (reviewEvidence.some((item) => !allowedEvidence.has(JSON.stringify([item.documentId, item.eventId])))) return false;
  if (!validateSuccessorChapterReviewLedger(state, source, true)) return false;
  if (Object.values(state.sourceInsightReviews).some((review) => (
    review.resolution === "applied" && review.appliedVersion !== review.version
  )) || Object.values(state.humanInsights).some((review) => (
    review.resolution === "applied" && review.appliedVersion !== review.version
  ))) return false;
  const context = successorReviewContext(source);
  return state.stage === "reviewing" || validateSuccessorChapterReviewCompletion(state, context);
}

/** Hydrate the exact successor Chapter set only. Any version, identity,
 * anchor, Evidence, or provenance mismatch fails the whole successor session. */
export function hydrateSuccessorStoryReviewSession(
  value: unknown,
  workflowRunId: string,
  rawSources: unknown[],
): HydratedSuccessorStoryReviewSession {
  const empty = { chapterReviews: {}, privacyDecisions: {} };
  const session = canonicalizeSuccessorStoryReviewSession(value);
  if (!session || session.workflowRunId !== workflowRunId || Object.keys(session.privacyDecisions).length !== 0
    || !Array.isArray(rawSources) || rawSources.length === 0 || rawSources.length > 500) return empty;
  const sources: SuccessorStorySource[] = [];
  for (const rawSource of rawSources) {
    let parsed: SuccessorStorySource | null = null;
    try {
      parsed = parseSuccessorStorySource(`${SUCCESSOR_STORY_PREFIX}${JSON.stringify(rawSource)}`);
    } catch {
      return empty;
    }
    if (!parsed) return empty;
    sources.push(parsed);
  }
  const sourceMap = new Map<string, SuccessorStorySource>();
  for (const source of sources) {
    if (sourceMap.has(source.key)) return empty;
    sourceMap.set(source.key, source);
  }
  const sourceKeys = [...sourceMap.keys()].sort();
  const reviewKeys = Object.keys(session.chapterReviews).sort();
  if (sourceKeys.length !== reviewKeys.length || sourceKeys.some((key, index) => key !== reviewKeys[index])) return empty;
  const chapterReviews: Record<string, SuccessorChapterReviewState> = {};
  for (const storyKey of sourceKeys) {
    const source = sourceMap.get(storyKey)!;
    const review = session.chapterReviews[storyKey];
    if (!validPersistedSuccessorReview(review, source)) return empty;
    chapterReviews[storyKey] = review;
  }
  return { chapterReviews, privacyDecisions: {} };
}
