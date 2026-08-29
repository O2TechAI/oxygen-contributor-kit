import {
  storyBlocks,
  validateChapterReviewCompletion,
  validateChapterReviewLedger,
  type ChapterReviewContext,
  type ChapterReviewState,
  type HumanInsightContent,
  type HumanInsightReview,
  type StoryInsightContent,
  type InsightRevisionRecord,
  type PrivacyDecision,
  type SourceInsightReview,
} from "./story-review.ts";
import {
  STORY_PREFIX,
  parseStorySource,
  type StorySource,
} from "./timeline.ts";
import { isWorkflowRunId } from "./workflow-progress.ts";

export const STORY_REVIEW_SESSION_SCHEMA = "oxygen.story-review-session" as const;
export const MAX_STORY_REVIEW_SESSION_BYTES = 2_000_000;

export type StoryReviewSession = {
  schema: typeof STORY_REVIEW_SESSION_SCHEMA;
  workflowRunId: string;
  chapterReviews: Record<string, ChapterReviewState>;
  privacyDecisions: Record<string, PrivacyDecision>;
  updatedAt: string;
};

export type HydratedStoryReviewSession = Pick<StoryReviewSession, "chapterReviews" | "privacyDecisions">;
type ChapterReviewCore = Omit<
  ChapterReviewState,
  "sourceInsightReviews" | "humanInsights" | "insightRevisionHistory"
>;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value)
  && typeof value === "object" && !Array.isArray(value);
const validStableId = (value: unknown): value is string => typeof value === "string"
  && value.trim().length > 0 && value.length <= 1_000;
const validDecision = (value: unknown): value is PrivacyDecision => value === "keep" || value === "redact";
const onlyKeys = (value: object, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));

function canonicalEvidence(value: unknown) {
  if (!isRecord(value) || !onlyKeys(value, ["documentId", "eventId", "label"])
    || !validStableId(value.documentId) || !validStableId(value.eventId)
    || (value.label !== undefined
      && (typeof value.label !== "string" || value.label.length > 500))) return null;
  return {
    documentId: value.documentId,
    eventId: value.eventId,
    ...(value.label === undefined ? {} : { label: value.label }),
  };
}

function canonicalEvidenceList(value: unknown) {
  if (!Array.isArray(value) || value.length > 500) return null;
  const evidence = value.map(canonicalEvidence);
  return evidence.some((item) => !item) ? null : evidence;
}

function canonicalAnnotation(value: unknown) {
  if (!isRecord(value) || !isRecord(value.selection)
    || !onlyKeys(value, ["id", "blockId", "type", "sourceLanguage", "selection", "instruction", "supportingEvidence", "resolution", "baseRevision", "appliedRevision"])
    || !onlyKeys(value.selection, ["start", "end", "text"])) return null;
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
  if (!isRecord(value) || !isRecord(value.beforeRange) || !isRecord(value.afterRange)
    || !onlyKeys(value, ["id", "storyKey", "blockId", "sourceLanguage", "baseRevision", "operation", "beforeText", "afterText", "beforeRange", "afterRange", "resolution", "requiresEvidence", "supportingEvidence", "appliedRevision", "revertsTransactionId", "createdAt", "updatedAt"])
    || !onlyKeys(value.beforeRange, ["start", "end"])
    || !onlyKeys(value.afterRange, ["start", "end"])) return null;
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
  if (!isRecord(value)
    || !onlyKeys(value, ["revision", "annotationIds", "editTransactionIds", "privacyDecisions"])) return null;
  const annotationIds = canonicalStringArray(value.annotationIds);
  const editTransactionIds = value.editTransactionIds === undefined
    ? undefined : canonicalStringArray(value.editTransactionIds);
  const privacyDecisions = canonicalDecisions(value.privacyDecisions);
  if (!annotationIds || (value.editTransactionIds !== undefined && !editTransactionIds)
    || !privacyDecisions) return null;
  return {
    revision: value.revision,
    annotationIds,
    ...(editTransactionIds ? { editTransactionIds } : {}),
    privacyDecisions,
  };
}

function canonicalChapterReviewCore(value: unknown): ChapterReviewCore | null {
  if (!isRecord(value)
    || !onlyKeys(value, ["stage", "revision", "annotations", "editTransactions", "redoTransactionIds", "sourceInsightReviews", "humanInsights", "insightRevisionHistory", "appliedPrivacyDecisions", "redactedBlocks", "staleTranslations", "revisionHistory", "evidenceVerified", "publicationApproved"])
    || !Array.isArray(value.annotations) || value.annotations.length > 5_000
    || !Array.isArray(value.editTransactions) || value.editTransactions.length > 5_000
    || !Array.isArray(value.staleTranslations) || value.staleTranslations.length > 1_000
    || !Array.isArray(value.revisionHistory) || value.revisionHistory.length > 5_000
    || !["reviewing", "revision_ready", "human_confirmed"].includes(String(value.stage))
    || !Number.isInteger(value.revision) || Number(value.revision) < 1
    || typeof value.evidenceVerified !== "boolean"
    || value.publicationApproved !== false) return null;
  const annotations = value.annotations.map(canonicalAnnotation);
  const editTransactions = value.editTransactions.map(canonicalEditTransaction);
  const redoTransactionIds = canonicalStringArray(value.redoTransactionIds);
  const appliedPrivacyDecisions = canonicalDecisions(value.appliedPrivacyDecisions);
  const redactedBlocks = canonicalStringArray(value.redactedBlocks);
  const revisionHistory = value.revisionHistory.map(canonicalRevision);
  const staleTranslations = value.staleTranslations.map((item) => isRecord(item) && onlyKeys(item, ["subject", "language", "count"])
    ? { subject: item.subject, language: item.language, count: item.count }
    : null);
  if (annotations.some((item) => !item) || editTransactions.some((item) => !item)
    || !redoTransactionIds || !appliedPrivacyDecisions || !redactedBlocks
    || staleTranslations.some((item) => !item) || revisionHistory.some((item) => !item)) return null;
  return {
    stage: value.stage,
    revision: Number(value.revision),
    annotations,
    editTransactions,
    redoTransactionIds,
    appliedPrivacyDecisions,
    redactedBlocks,
    staleTranslations,
    revisionHistory,
    evidenceVerified: value.evidenceVerified,
    publicationApproved: false,
  } as ChapterReviewCore;
}

function canonicalStoryInsightContent(value: unknown): StoryInsightContent | null {
  if (!isRecord(value) || !isRecord(value.quote) || !isRecord(value.quote.evidence)
    || !onlyKeys(value, ["title", "background", "anchorStoryBlockId", "quote", "directlyAcquiredExperience", "principle", "evidence"])
    || !onlyKeys(value.quote, ["text", "evidence"])
    || !onlyKeys(value.quote.evidence, ["documentId", "eventId"])) return null;
  const evidence = canonicalEvidenceList(value.evidence);
  const quoteEvidence = canonicalEvidence(value.quote.evidence);
  if (!validStableId(value.anchorStoryBlockId)
    || typeof value.quote.text !== "string" || !value.quote.text.trim() || value.quote.text.length > 20_000
    || !quoteEvidence || !validStableId(quoteEvidence.documentId) || !validStableId(quoteEvidence.eventId)
    || !evidence
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
    anchorStoryBlockId: value.anchorStoryBlockId,
    quote: { text: value.quote.text, evidence: quoteEvidence },
    directlyAcquiredExperience: value.directlyAcquiredExperience,
    principle: value.principle,
    evidence: evidence as StoryInsightContent["evidence"],
  };
}

function canonicalHumanInsightContent(value: unknown): HumanInsightContent | null {
  if (!isRecord(value) || !isRecord(value.quote) || !isRecord(value.quote.selection)
    || !onlyKeys(value, ["title", "background", "quote", "directlyAcquiredExperience", "principle", "evidence"])
    || !onlyKeys(value.quote, ["chapterKey", "storyBlockId", "selection", "baseRevision"])
    || !onlyKeys(value.quote.selection, ["start", "end", "text"])
    || !validStableId(value.quote.chapterKey) || !validStableId(value.quote.storyBlockId)) return null;
  const selectionStart = value.quote.selection.start;
  const selectionEnd = value.quote.selection.end;
  const selectionText = value.quote.selection.text;
  const baseRevision = value.quote.baseRevision;
  const evidence = canonicalEvidenceList(value.evidence);
  if (typeof selectionStart !== "number" || typeof selectionEnd !== "number"
    || typeof selectionText !== "string" || typeof baseRevision !== "number"
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
    directlyAcquiredExperience: value.directlyAcquiredExperience,
    principle: value.principle,
    evidence: evidence as HumanInsightContent["evidence"],
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
  };
}

function canonicalSourceInsightReview(value: unknown): SourceInsightReview | null {
  if (!isRecord(value)
    || !onlyKeys(value, ["origin", "version", "decision", "resolution", "editedContent", "appliedVersion", "appliedRevision"])
    || value.origin !== "source_ai"
    || !Number.isInteger(value.version) || Number(value.version) < 1
    || !["pending", "accepted", "rejected"].includes(String(value.decision))
    || (value.resolution !== "pending" && value.resolution !== "applied")) return null;
  const editedContent = value.editedContent === undefined ? undefined : canonicalStoryInsightContent(value.editedContent);
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
    decision: value.decision as SourceInsightReview["decision"],
    resolution: value.resolution,
    ...(editedContent ? { editedContent } : {}),
    ...(value.appliedVersion === undefined ? {} : { appliedVersion: Number(value.appliedVersion) }),
    ...(value.appliedRevision === undefined ? {} : { appliedRevision: Number(value.appliedRevision) }),
  };
}

function canonicalHumanInsightReview(value: unknown): HumanInsightReview | null {
  if (!isRecord(value)
    || !onlyKeys(value, ["origin", "version", "decision", "resolution", "content", "appliedVersion", "appliedRevision"])
    || value.origin !== "human_created"
    || !Number.isInteger(value.version) || Number(value.version) < 1
    || (value.decision !== "draft" && value.decision !== "human_approved")
    || (value.resolution !== "pending" && value.resolution !== "applied")) return null;
  const content = canonicalHumanInsightContent(value.content);
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

function canonicalInsightRevision(value: unknown): InsightRevisionRecord | null {
  if (!isRecord(value)
    || !onlyKeys(value, ["revision", "insightId", "origin", "version", "decision"])
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
    decision: value.decision as InsightRevisionRecord["decision"],
  };
}

function canonicalChapterReview(value: unknown): ChapterReviewState | null {
  if (!isRecord(value)
    || !isRecord(value.sourceInsightReviews) || Object.keys(value.sourceInsightReviews).length > 500
    || !isRecord(value.humanInsights) || Object.keys(value.humanInsights).length > 500
    || !Array.isArray(value.insightRevisionHistory)
    || value.insightRevisionHistory.length > 5_000) return null;
  const common = canonicalChapterReviewCore(value);
  if (!common) return null;
  const sourceEntries = Object.entries(value.sourceInsightReviews).sort(([left], [right]) => left.localeCompare(right));
  const humanEntries = Object.entries(value.humanInsights).sort(([left], [right]) => left.localeCompare(right));
  if (sourceEntries.some(([id]) => !validStableId(id))
    || humanEntries.some(([id]) => !validStableId(id) || !id.startsWith("human:"))) return null;
  const sourceReviews = sourceEntries.map(([id, review]) => [id, canonicalSourceInsightReview(review)] as const);
  const humanReviews = humanEntries.map(([id, review]) => [id, canonicalHumanInsightReview(review)] as const);
  const history = value.insightRevisionHistory.map(canonicalInsightRevision);
  if (sourceReviews.some(([, review]) => !review)
    || humanReviews.some(([, review]) => !review)
    || history.some((record) => !record)) return null;
  const sortedHistory = (history as InsightRevisionRecord[]).sort((left, right) => (
    left.revision - right.revision
      || left.origin.localeCompare(right.origin)
      || left.insightId.localeCompare(right.insightId)
  ));
  if (new Set(sortedHistory.map((record) => JSON.stringify([record.revision, record.origin, record.insightId]))).size
    !== sortedHistory.length) return null;
  return {
    ...common,
    sourceInsightReviews: Object.fromEntries(sourceReviews) as Record<string, SourceInsightReview>,
    humanInsights: Object.fromEntries(humanReviews) as Record<string, HumanInsightReview>,
    insightRevisionHistory: sortedHistory,
  };
}

/** Reconstruct the canonical session from an exact allowlist. Unknown fields
 * fail closed before source-bound hydration or persistence. */
export function canonicalizeStoryReviewSession(value: unknown): StoryReviewSession | null {
  if (!isRecord(value)
    || !onlyKeys(value, ["schema", "workflowRunId", "chapterReviews", "privacyDecisions", "updatedAt"])
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
  for (const [storyKey, rawReview] of Object.entries(value.chapterReviews).sort(([left], [right]) => left.localeCompare(right))) {
    if (!validStableId(storyKey)) return null;
    const review = canonicalChapterReview(rawReview);
    if (!review) return null;
    chapterReviews[storyKey] = review;
  }
  return {
    schema: STORY_REVIEW_SESSION_SCHEMA,
    workflowRunId: value.workflowRunId,
    chapterReviews,
    privacyDecisions: Object.fromEntries(Object.entries(privacyDecisions).sort(([left], [right]) => left.localeCompare(right))),
    updatedAt: value.updatedAt,
  };
}

export function parseStoryReviewSession(value: unknown): StoryReviewSession | null {
  return canonicalizeStoryReviewSession(value);
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

/** Compare canonical review meaning while excluding the server-owned timestamp. */
export function storyReviewSessionSemanticJson(value: unknown) {
  const session = canonicalizeStoryReviewSession(value);
  return session ? JSON.stringify(stableJsonValue({ ...session, updatedAt: "" })) : null;
}

function chapterReviewContext(source: StorySource): ChapterReviewContext {
  const blocks = storyBlocks(source);
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

function validPersistedReview(state: ChapterReviewState, source: StorySource) {
  if (![
    "reviewing", "revision_ready", "human_confirmed",
  ].includes(state.stage)
    || typeof state.evidenceVerified !== "boolean"
    || state.publicationApproved !== false
    || Object.keys(state.appliedPrivacyDecisions || {}).length !== 0
    || !Array.isArray(state.redactedBlocks) || state.redactedBlocks.length !== 0
    || !Array.isArray(state.staleTranslations)) return false;
  const storyIds = new Set(source.story.blocks.map((block) => block.id));
  if (state.staleTranslations.some((item) => !item
    || (item.language !== "en" && item.language !== "zh")
    || !Number.isInteger(item.count) || item.count < 1
    || typeof item.subject !== "string"
    || !item.subject.startsWith("story:")
    || !storyIds.has(item.subject.slice("story:".length)))) return false;
  const allowedEvidence = new Set([source.evidence.primary, ...source.evidence.supporting]
    .map((item) => JSON.stringify([item.documentId, item.eventId])));
  const reviewEvidence = [...state.annotations.flatMap((item) => item.supportingEvidence || []),
    ...state.editTransactions.flatMap((item) => item.supportingEvidence || [])];
  if (reviewEvidence.some((item) => !allowedEvidence.has(JSON.stringify([item.documentId, item.eventId])))) return false;
  if (!validateChapterReviewLedger(state, source, true)) return false;
  if (Object.values(state.sourceInsightReviews).some((review) => (
    review.resolution === "applied" && review.appliedVersion !== review.version
  )) || Object.values(state.humanInsights).some((review) => (
    review.resolution === "applied" && review.appliedVersion !== review.version
  ))) return false;
  const context = chapterReviewContext(source);
  return state.stage === "reviewing" || validateChapterReviewCompletion(state, context);
}

/** Hydrate the exact Story Chapter set only. Any version, identity,
 * anchor, Evidence, or provenance mismatch fails the whole Story session. */
export function hydrateStoryReviewSession(
  value: unknown,
  workflowRunId: string,
  rawSources: unknown[],
): HydratedStoryReviewSession {
  const empty = { chapterReviews: {}, privacyDecisions: {} };
  const session = canonicalizeStoryReviewSession(value);
  if (!session || session.workflowRunId !== workflowRunId || Object.keys(session.privacyDecisions).length !== 0
    || !Array.isArray(rawSources) || rawSources.length === 0 || rawSources.length > 500) return empty;
  const sources: StorySource[] = [];
  for (const rawSource of rawSources) {
    let parsed: StorySource | null = null;
    try {
      parsed = parseStorySource(`${STORY_PREFIX}${JSON.stringify(rawSource)}`);
    } catch {
      return empty;
    }
    if (!parsed) return empty;
    sources.push(parsed);
  }
  const sourceMap = new Map<string, StorySource>();
  for (const source of sources) {
    if (sourceMap.has(source.key)) return empty;
    sourceMap.set(source.key, source);
  }
  const sourceKeys = [...sourceMap.keys()].sort();
  const reviewKeys = Object.keys(session.chapterReviews).sort();
  if (sourceKeys.length !== reviewKeys.length || sourceKeys.some((key, index) => key !== reviewKeys[index])) return empty;
  const chapterReviews: Record<string, ChapterReviewState> = {};
  for (const storyKey of sourceKeys) {
    const source = sourceMap.get(storyKey)!;
    const review = session.chapterReviews[storyKey];
    if (!validPersistedReview(review, source)) return empty;
    chapterReviews[storyKey] = review;
  }
  return { chapterReviews, privacyDecisions: {} };
}
