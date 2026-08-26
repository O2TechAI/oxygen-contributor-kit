import type {
  EvidenceReference,
  SuccessorStoryInsight,
  SuccessorStorySource,
  StoryHighlightItem,
  StoryLanguage,
  StoryPrivacyCandidate,
  StoryReleaseTargetCatalog,
} from "./timeline";

export type PrivacyDecision = "keep" | "redact";

export type StoryAnnotationType = "delete" | "revise" | "add";
export type StoryAnnotationResolution = "pending" | "applied" | "needs_evidence" | "cancelled";

export type StoryTextSelection = { start: number; end: number; text: string };

export type StoryReviewAnnotation = {
  id: string;
  blockId: string;
  type: StoryAnnotationType;
  sourceLanguage: StoryLanguage;
  selection: StoryTextSelection;
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

export type StoryEditOperation = "insert" | "delete" | "replace";
export type StoryEditResolution = "pending" | "applied" | "reverted" | "needs_evidence";
export type StoryEditRange = { start: number; end: number };

/** A direct edit is a reversible plain-text patch anchored to one stable Story
 * block in one applied Chapter revision. Patch ranges are relative to the
 * applied block at `baseRevision`; browser selection state never becomes its
 * identity. */
export type StoryEditTransaction = {
  id: string;
  storyKey: string;
  blockId: string;
  sourceLanguage: StoryLanguage;
  baseRevision: number;
  operation: StoryEditOperation;
  beforeText: string;
  afterText: string;
  beforeRange: StoryEditRange;
  afterRange: StoryEditRange;
  resolution: StoryEditResolution;
  requiresEvidence: boolean;
  supportingEvidence?: EvidenceReference[];
  appliedRevision?: number;
  revertsTransactionId?: string;
  createdAt: number;
  updatedAt: number;
};

export type StoryEditSegment = {
  text: string;
  transactionIds: string[];
};

export type RecordStoryEditInput = {
  storyKey: string;
  blockId: string;
  sourceLanguage: StoryLanguage;
  baseText: string;
  nextText: string;
  workingRange?: StoryEditRange;
  insertedText?: string;
  supportingEvidence?: EvidenceReference[];
  now?: number;
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

export type InsightReviewFeedbackState =
  | "none"
  | "accepted_pending"
  | "rejected_pending"
  | "changed_pending"
  | "accepted_applied"
  | "rejected_applied"
  | "changed_applied";

/** Derive visible feedback from the persisted review state. Copy remains in the
 * component so this semantic state hydrates identically in both languages. */
export function insightReviewFeedbackState(review?: InsightReview): InsightReviewFeedbackState {
  if (!review) return "none";
  const decision = review.status === "accepted"
    ? "accepted"
    : review.status === "rejected" ? "rejected" : "changed";
  return `${decision}_${review.resolution}` as InsightReviewFeedbackState;
}

export type TranslationStaleness = {
  subject: `story:${string}` | `insight:${string}`;
  language: StoryLanguage;
  count: number;
};

export type ChapterRevisionRecord = {
  revision: number;
  annotationIds: string[];
  editTransactionIds?: string[];
  insightIds: string[];
  privacyDecisions: Record<string, PrivacyDecision>;
};

export type ChapterReviewStage = "reviewing" | "revision_ready" | "human_confirmed";

export type ChapterReviewState = {
  stage: ChapterReviewStage;
  revision: number;
  annotations: StoryReviewAnnotation[];
  editTransactions: StoryEditTransaction[];
  redoTransactionIds: string[];
  insightReviews: Record<string, InsightReview>;
  appliedPrivacyDecisions: Record<string, PrivacyDecision>;
  redactedBlocks: string[];
  staleTranslations: TranslationStaleness[];
  revisionHistory: ChapterRevisionRecord[];
  evidenceVerified: boolean;
  publicationApproved: false;
};

type StoryBlockCollection = Record<StoryLanguage, Record<string, string>>;

export type ChapterReviewCompletionContext = {
  storyKey: string;
  privacyCandidates: StoryPrivacyCandidate[];
  privacyDecisions: Record<string, PrivacyDecision>;
  targetCatalog: StoryReleaseTargetCatalog;
  reviewableInsightIds: string[];
  sourceBlocks: StoryBlockCollection;
  reviewedBlocks: StoryBlockCollection;
};

export type ChapterReviewBlocker = {
  code:
    | "review_state_invalid"
    | "privacy_incomplete"
    | "evidence_unverified"
    | "annotation_pending"
    | "annotation_needs_evidence"
    | "direct_edit_pending"
    | "direct_edit_needs_evidence"
    | "insight_pending"
    | "privacy_decisions_stale"
    | "revision_provenance_mismatch"
    | "redaction_targets_mismatch";
  chapterKey: string;
  targetKind: "chapter" | "story_block" | "insight";
  targetId?: string;
  itemId?: string;
};

export type SuccessorChapterReviewBlocker = Omit<ChapterReviewBlocker, "code"> & {
  code: ChapterReviewBlocker["code"]
    | "ai_insight_decision_missing"
    | "ai_insight_decision_pending"
    | "ai_insight_reaccept_required"
    | "human_insight_pending";
};

export type ApplyReviewContext = ChapterReviewCompletionContext & {
  chapterEvidence: EvidenceReference[];
  evidenceResolved: boolean;
  supportedAddIds: string[];
  supportedEditIds?: string[];
};

export type SuccessorInsightContent = Omit<SuccessorStoryInsight, "id">;
export type SuccessorHumanInsightContent = Omit<SuccessorInsightContent, "quote"> & {
  quote: {
    chapterKey: string;
    storyBlockId: string;
    selection: StoryTextSelection;
    baseRevision: number;
  };
};

export type SuccessorSourceInsightReview = {
  origin: "source_ai";
  version: number;
  decision: "pending" | "accepted" | "rejected";
  resolution: "pending" | "applied";
  editedContent?: SuccessorInsightContent;
  appliedVersion?: number;
  appliedRevision?: number;
};

export type SuccessorHumanInsightReview = {
  origin: "human_created";
  version: number;
  decision: "draft" | "human_approved";
  resolution: "pending" | "applied";
  content: SuccessorHumanInsightContent;
  appliedVersion?: number;
  appliedRevision?: number;
};

export type SuccessorInsightRevisionRecord = {
  revision: number;
  insightId: string;
  origin: "source_ai" | "human_created";
  version: number;
  decision: "accepted" | "rejected" | "human_approved";
};

export type SuccessorChapterReviewState = ChapterReviewState & {
  sourceInsightReviews: Record<string, SuccessorSourceInsightReview>;
  humanInsights: Record<string, SuccessorHumanInsightReview>;
  successorInsightRevisionHistory: SuccessorInsightRevisionRecord[];
};

export type SuccessorChapterReviewContext = Omit<
  ApplyReviewContext,
  "storyKey" | "reviewableInsightIds" | "chapterEvidence"
> & {
  source: SuccessorStorySource;
};

export const emptyChapterReview = (): ChapterReviewState => ({
  stage: "reviewing",
  revision: 1,
  annotations: [],
  editTransactions: [],
  redoTransactionIds: [],
  insightReviews: {},
  appliedPrivacyDecisions: {},
  redactedBlocks: [],
  staleTranslations: [],
  revisionHistory: [],
  evidenceVerified: false,
  publicationApproved: false,
});

export function emptySuccessorChapterReview(source: SuccessorStorySource): SuccessorChapterReviewState {
  return {
    ...emptyChapterReview(),
    sourceInsightReviews: Object.fromEntries([...source.insights]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((insight) => [insight.id, {
        origin: "source_ai" as const,
        version: 1,
        decision: "pending" as const,
        resolution: "pending" as const,
      }])),
    humanInsights: {},
    successorInsightRevisionHistory: [],
  };
}

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

const activeEditResolution = (resolution: StoryEditResolution) => resolution === "pending" || resolution === "needs_evidence";

const editRangesConflict = (left: StoryEditTransaction, right: StoryEditTransaction) => {
  const leftEmpty = left.beforeRange.start === left.beforeRange.end;
  const rightEmpty = right.beforeRange.start === right.beforeRange.end;
  if (leftEmpty && rightEmpty) return left.beforeRange.start === right.beforeRange.start;
  if (leftEmpty) return left.beforeRange.start >= right.beforeRange.start && left.beforeRange.start <= right.beforeRange.end;
  if (rightEmpty) return right.beforeRange.start >= left.beforeRange.start && right.beforeRange.start <= left.beforeRange.end;
  return left.beforeRange.start < right.beforeRange.end && right.beforeRange.start < left.beforeRange.end;
};

type EditProjection = {
  transaction: StoryEditTransaction;
  workStart: number;
  workEnd: number;
};

function projectDirectEditGroup(source: string, transactions: StoryEditTransaction[]) {
  const ordered = [...transactions].sort((left, right) => left.beforeRange.start - right.beforeRange.start
    || left.beforeRange.end - right.beforeRange.end);
  if (ordered.some((transaction, index) => ordered.slice(index + 1).some((other) => editRangesConflict(transaction, other)))) {
    return null;
  }
  let sourceCursor = 0;
  let result = "";
  const projections: EditProjection[] = [];
  for (const transaction of ordered) {
    const { start, end } = transaction.beforeRange;
    if (start < sourceCursor || start < 0 || end < start || end > source.length
      || source.slice(start, end) !== transaction.beforeText) return null;
    result += source.slice(sourceCursor, start);
    const workStart = result.length;
    result += transaction.afterText;
    projections.push({ transaction, workStart, workEnd: result.length });
    sourceCursor = end;
  }
  result += source.slice(sourceCursor);
  return { text: result, projections };
}

function applyDirectEditGroup(source: string, transactions: StoryEditTransaction[]) {
  return projectDirectEditGroup(source, transactions)?.text ?? null;
}

function editOperation(beforeText: string, afterText: string): StoryEditOperation {
  if (!beforeText) return "insert";
  if (!afterText) return "delete";
  return "replace";
}

function plainTextDiff(before: string, after: string) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  return {
    start,
    beforeEnd,
    afterEnd,
    beforeText: before.slice(start, beforeEnd),
    afterText: after.slice(start, afterEnd),
  };
}

export type DirectInputEditCategory = "insert" | "replace" | "delete" | "history" | "composition" | "unknown";

export type DirectStoryMutation = {
  start: number;
  end: number;
  insertedText: string;
};

export type SafeDirectInputMetadata = {
  inputTypeMissing: boolean;
  dataState: "missing" | "null" | "string" | "other";
  selectionStart: number;
  selectionEnd: number;
  editCategory: DirectInputEditCategory;
  isComposing: boolean;
};

type NormalizeDirectBeforeInput = {
  nativeEvent: unknown;
  selectionStart: number;
  selectionEnd: number;
  valueLength: number;
};

/** Normalize only the browser metadata needed to optimize one controlled
 * mutation. The returned diagnostic projection deliberately contains no Story
 * text. Reduced SyntheticEvent/nativeEvent shapes are ordinary fallback cases,
 * not fatal errors. */
export function normalizeDirectBeforeInput(input: NormalizeDirectBeforeInput): {
  metadata: SafeDirectInputMetadata;
  mutation: DirectStoryMutation | null;
} {
  const native = input.nativeEvent && typeof input.nativeEvent === "object"
    ? input.nativeEvent as Record<string, unknown>
    : {};
  const inputType = typeof native.inputType === "string" ? native.inputType : "";
  const hasData = Object.prototype.hasOwnProperty.call(native, "data") && native.data !== undefined;
  const dataState: SafeDirectInputMetadata["dataState"] = !hasData
    ? "missing"
    : native.data === null ? "null" : typeof native.data === "string" ? "string" : "other";
  const length = Number.isInteger(input.valueLength) && input.valueLength >= 0 ? input.valueLength : 0;
  const selectionStart = Math.max(0, Math.min(length, Number.isInteger(input.selectionStart) ? input.selectionStart : 0));
  const selectionEnd = Math.max(selectionStart, Math.min(length, Number.isInteger(input.selectionEnd) ? input.selectionEnd : selectionStart));
  const isComposing = native.isComposing === true || inputType.includes("Composition");
  const editCategory: DirectInputEditCategory = isComposing
    ? "composition"
    : inputType === "historyUndo" || inputType === "historyRedo"
      ? "history"
      : inputType.startsWith("delete")
        ? "delete"
        : inputType === "insertReplacementText" || (inputType.startsWith("insert") && selectionEnd > selectionStart)
          ? "replace"
          : inputType.startsWith("insert")
            ? "insert"
            : "unknown";
  const metadata: SafeDirectInputMetadata = {
    inputTypeMissing: typeof native.inputType !== "string",
    dataState,
    selectionStart,
    selectionEnd,
    editCategory,
    isComposing,
  };
  if (isComposing || editCategory === "history" || editCategory === "unknown") return { metadata, mutation: null };

  if (editCategory === "delete") {
    let start = selectionStart;
    let end = selectionEnd;
    if (start === end && inputType === "deleteContentBackward" && start > 0) start -= 1;
    if (start === end && inputType === "deleteContentForward" && end < length) end += 1;
    return { metadata, mutation: { start, end, insertedText: "" } };
  }

  if (inputType === "insertLineBreak" || inputType === "insertParagraph") {
    return { metadata, mutation: { start: selectionStart, end: selectionEnd, insertedText: "\n" } };
  }
  if (typeof native.data !== "string") return { metadata, mutation: null };
  return {
    metadata,
    mutation: { start: selectionStart, end: selectionEnd, insertedText: native.data },
  };
}

type DeriveDirectStoryMutation = {
  previousText: string;
  nextText: string;
  selectionAfter: number;
  beforeInputMutation?: DirectStoryMutation | null;
};

/** Resolve exactly one plain-text splice. `beforeinput` is accepted only when
 * it reproduces the controlled next value; otherwise the minimal mutation is
 * derived from previous/next text with the post-edit caret as a tie-breaker. */
export function deriveDirectStoryMutation(input: DeriveDirectStoryMutation): DirectStoryMutation | null {
  const { previousText, nextText } = input;
  if (previousText === nextText) return null;
  const pending = input.beforeInputMutation;
  if (pending
    && Number.isInteger(pending.start) && Number.isInteger(pending.end)
    && pending.start >= 0 && pending.end >= pending.start && pending.end <= previousText.length
    && typeof pending.insertedText === "string"
    && `${previousText.slice(0, pending.start)}${pending.insertedText}${previousText.slice(pending.end)}` === nextText) {
    return pending;
  }

  if (Number.isInteger(input.selectionAfter) && input.selectionAfter >= 0 && input.selectionAfter <= nextText.length) {
    const selectionAfter = input.selectionAfter;
    const suffixLength = nextText.length - selectionAfter;
    const end = previousText.length - suffixLength;
    if (end >= 0 && previousText.slice(end) === nextText.slice(selectionAfter)) {
      for (let start = Math.min(selectionAfter, end); start >= 0; start -= 1) {
        if (previousText.slice(0, start) !== nextText.slice(0, start)) continue;
        const mutation = { start, end, insertedText: nextText.slice(start, selectionAfter) };
        if (`${previousText.slice(0, start)}${mutation.insertedText}${previousText.slice(end)}` === nextText) return mutation;
      }
    }
  }

  const diff = plainTextDiff(previousText, nextText);
  return { start: diff.start, end: diff.beforeEnd, insertedText: diff.afterText };
}

/** Paste remains editorial plain text. Markup, script/style bodies, NUL bytes,
 * and browser-specific CR line endings are removed while paragraph breaks are
 * preserved. */
export function sanitizeStoryPaste(value: string) {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "");
}

/** Conservative evidence gate for new standalone claims. Inline wording edits
 * remain ordinary revisions, while new sentences, numbers, links/paths, or
 * paragraph-level additions require exact reviewed support before Apply. */
export function directStoryEditNeedsEvidence(
  operation: StoryEditOperation,
  beforeText: string,
  afterText: string,
  range: StoryEditRange,
  blockLength: number,
) {
  if (operation === "delete" || !afterText.trim()) return false;
  const introducesNumber = /\d/u.test(afterText) && !/\d/u.test(beforeText);
  const introducesLocator = /https?:\/\/|[A-Za-z]:\\|\/(?:[^\s/]+\/){2,}/u.test(afterText);
  const introducesParagraph = /\n/u.test(afterText) && !/\n/u.test(beforeText);
  const newSentenceCount = (afterText.match(/[.!?。！？](?:\s|$)/gu) || []).length
    - (beforeText.match(/[.!?。！？](?:\s|$)/gu) || []).length;
  const standaloneBoundary = (range.start === 0 || range.end === blockLength)
    && afterText.trim().length >= 32
    && /[.!?。！？]$/u.test(afterText.trim());
  return introducesNumber || introducesLocator || introducesParagraph || newSentenceCount > 0 || standaloneBoundary;
}

function activeDirectEdits(
  state: ChapterReviewState,
  storyKey: string,
  blockId: string,
  language: StoryLanguage,
) {
  return state.editTransactions.filter((transaction) => transaction.storyKey === storyKey
    && transaction.blockId === blockId
    && transaction.sourceLanguage === language
    && transaction.baseRevision === state.revision
    && activeEditResolution(transaction.resolution));
}

function normalizeCurrentEditRanges(state: ChapterReviewState, baseText: string, storyKey: string, blockId: string, language: StoryLanguage) {
  const active = activeDirectEdits(state, storyKey, blockId, language);
  const projection = projectDirectEditGroup(baseText, active);
  if (!projection) return null;
  const projectedRanges = new Map(projection.projections.map(({ transaction, workStart, workEnd }) => (
    [transaction.id, { start: workStart, end: workEnd }] as const
  )));
  return {
    ...state,
    editTransactions: state.editTransactions.map((transaction) => projectedRanges.has(transaction.id)
      ? { ...transaction, afterRange: projectedRanges.get(transaction.id)! }
      : transaction),
  };
}

function unchangedProjectionGaps(baseText: string, projection: NonNullable<ReturnType<typeof projectDirectEditGroup>>) {
  const ordered = projection.projections;
  let baseCursor = 0;
  let workCursor = 0;
  const gaps: Array<{ baseStart: number; baseEnd: number; workStart: number; workEnd: number }> = [];
  for (const item of ordered) {
    const baseStart = item.transaction.beforeRange.start;
    const length = baseStart - baseCursor;
    gaps.push({ baseStart: baseCursor, baseEnd: baseStart, workStart: workCursor, workEnd: workCursor + length });
    baseCursor = item.transaction.beforeRange.end;
    workCursor = item.workEnd;
  }
  gaps.push({ baseStart: baseCursor, baseEnd: baseText.length, workStart: workCursor, workEnd: projection.text.length });
  return gaps;
}

function transactionResult(
  transaction: StoryEditTransaction,
  afterText: string,
  baseText: string,
  now: number,
  supportingEvidence?: EvidenceReference[],
): StoryEditTransaction {
  const operation = editOperation(transaction.beforeText, afterText);
  const requiresEvidence = directStoryEditNeedsEvidence(
    operation,
    transaction.beforeText,
    afterText,
    transaction.beforeRange,
    baseText.length,
  );
  return {
    ...transaction,
    operation,
    afterText,
    resolution: afterText === transaction.beforeText ? "reverted" : "pending",
    requiresEvidence,
    ...(requiresEvidence && supportingEvidence?.length ? { supportingEvidence } : { supportingEvidence: undefined }),
    appliedRevision: undefined,
    updatedAt: now,
  };
}

export type RecordStoryEditResult = {
  state: ChapterReviewState;
  transactionId?: string;
  blockedReason?: "invalid" | "overlap" | "annotation" | "confirmed";
};

/** Record one browser mutation as a controlled, block-local patch. Existing
 * changes inside the same replacement are coalesced; independent base ranges
 * remain independent notes and can be discarded without rebasing one another. */
export function recordStoryEdit(state: ChapterReviewState, input: RecordStoryEditInput): RecordStoryEditResult {
  if (state.stage === "human_confirmed") return { state, blockedReason: "confirmed" };
  if (!validStableId(input.storyKey) || !validStableId(input.blockId)
    || (input.sourceLanguage !== "en" && input.sourceLanguage !== "zh")
    || typeof input.baseText !== "string" || typeof input.nextText !== "string"
    || input.baseText.length > 20_000 || input.nextText.length > 20_000
    || /\u0000/u.test(input.nextText)) return { state, blockedReason: "invalid" };
  if (state.annotations.some((annotation) => annotation.blockId === input.blockId
    && annotation.sourceLanguage === input.sourceLanguage
    && annotation.baseRevision === state.revision
    && (annotation.resolution === "pending" || annotation.resolution === "needs_evidence"))) {
    return { state, blockedReason: "annotation" };
  }

  const active = activeDirectEdits(state, input.storyKey, input.blockId, input.sourceLanguage);
  const projection = projectDirectEditGroup(input.baseText, active);
  if (!projection) return { state, blockedReason: "overlap" };
  if (projection.text === input.nextText) return { state };
  const explicitRange = input.workingRange;
  const explicitInsertedText = input.insertedText ?? "";
  const explicitMutationValid = Boolean(explicitRange)
    && Number.isInteger(explicitRange!.start) && Number.isInteger(explicitRange!.end)
    && explicitRange!.start >= 0 && explicitRange!.end >= explicitRange!.start
    && explicitRange!.end <= projection.text.length
    && `${projection.text.slice(0, explicitRange!.start)}${explicitInsertedText}${projection.text.slice(explicitRange!.end)}` === input.nextText;
  const diff = explicitMutationValid ? {
    start: explicitRange!.start,
    beforeEnd: explicitRange!.end,
    afterEnd: explicitRange!.start + explicitInsertedText.length,
    beforeText: projection.text.slice(explicitRange!.start, explicitRange!.end),
    afterText: explicitInsertedText,
  } : plainTextDiff(projection.text, input.nextText);
  const now = input.now ?? Date.now();

  const touched = projection.projections.filter(({ workStart, workEnd }) => diff.beforeEnd === diff.start
    ? diff.start >= workStart && diff.start <= workEnd
    : diff.start >= workStart && diff.beforeEnd <= workEnd);
  if (touched.length === 1) {
    const target = touched[0];
    const localStart = diff.start - target.workStart;
    const localEnd = diff.beforeEnd - target.workStart;
    const afterText = `${target.transaction.afterText.slice(0, localStart)}${diff.afterText}${target.transaction.afterText.slice(localEnd)}`;
    const updated = transactionResult(target.transaction, afterText, input.baseText, now, input.supportingEvidence);
    const next = {
      ...state,
      stage: "reviewing" as const,
      editTransactions: state.editTransactions.map((transaction) => transaction.id === updated.id ? updated : transaction),
      redoTransactionIds: state.redoTransactionIds.filter((id) => state.editTransactions.find((item) => item.id === id)?.sourceLanguage !== input.sourceLanguage),
    };
    return { state: normalizeCurrentEditRanges(next, input.baseText, input.storyKey, input.blockId, input.sourceLanguage) || state, transactionId: updated.id };
  }
  if (touched.length > 1) return { state, blockedReason: "overlap" };

  const gap = unchangedProjectionGaps(input.baseText, projection).find((candidate) => (
    diff.start >= candidate.workStart && diff.beforeEnd <= candidate.workEnd
  ));
  if (!gap) return { state, blockedReason: "overlap" };
  const start = gap.baseStart + diff.start - gap.workStart;
  const end = gap.baseStart + diff.beforeEnd - gap.workStart;
  if (input.baseText.slice(start, end) !== diff.beforeText) return { state, blockedReason: "overlap" };
  const beforeRange = { start, end };
  const operation = editOperation(diff.beforeText, diff.afterText);
  const requiresEvidence = directStoryEditNeedsEvidence(operation, diff.beforeText, diff.afterText, beforeRange, input.baseText.length);
  const transaction: StoryEditTransaction = {
    id: `${input.blockId}:edit:${now}:${Math.random().toString(36).slice(2, 7)}`,
    storyKey: input.storyKey,
    blockId: input.blockId,
    sourceLanguage: input.sourceLanguage,
    baseRevision: state.revision,
    operation,
    beforeText: diff.beforeText,
    afterText: diff.afterText,
    beforeRange,
    afterRange: { start, end: start + diff.afterText.length },
    resolution: "pending",
    requiresEvidence,
    ...(requiresEvidence && input.supportingEvidence?.length ? { supportingEvidence: input.supportingEvidence } : {}),
    createdAt: now,
    updatedAt: now,
  };
  if (active.some((candidate) => editRangesConflict(candidate, transaction))) return { state, blockedReason: "overlap" };
  const next = {
    ...state,
    stage: "reviewing" as const,
    editTransactions: [...state.editTransactions, transaction],
    redoTransactionIds: state.redoTransactionIds.filter((id) => state.editTransactions.find((item) => item.id === id)?.sourceLanguage !== input.sourceLanguage),
  };
  return { state: normalizeCurrentEditRanges(next, input.baseText, input.storyKey, input.blockId, input.sourceLanguage) || state, transactionId: transaction.id };
}

export function canUndoStoryEdit(state: ChapterReviewState, language: StoryLanguage) {
  return state.editTransactions.some((transaction) => transaction.sourceLanguage === language && activeEditResolution(transaction.resolution));
}

export function canRedoStoryEdit(state: ChapterReviewState, language: StoryLanguage) {
  return [...state.redoTransactionIds].reverse().some((id) => state.editTransactions.some((transaction) => (
    transaction.id === id && transaction.sourceLanguage === language && transaction.resolution === "reverted"
  )));
}

export function undoStoryEdit(state: ChapterReviewState, language: StoryLanguage): ChapterReviewState {
  if (state.stage === "human_confirmed") return state;
  const target = state.editTransactions
    .map((transaction, index) => ({ transaction, index }))
    .filter(({ transaction }) => transaction.sourceLanguage === language && activeEditResolution(transaction.resolution))
    .sort((left, right) => right.transaction.updatedAt - left.transaction.updatedAt || right.index - left.index)[0]?.transaction;
  if (!target) return state;
  return {
    ...state,
    stage: "reviewing",
    editTransactions: state.editTransactions.map((transaction) => transaction.id === target.id
      ? { ...transaction, resolution: "reverted" as const, appliedRevision: undefined }
      : transaction),
    redoTransactionIds: [...state.redoTransactionIds.filter((id) => id !== target.id), target.id],
  };
}

export function redoStoryEdit(state: ChapterReviewState, language: StoryLanguage): ChapterReviewState {
  if (state.stage === "human_confirmed") return state;
  const targetId = [...state.redoTransactionIds].reverse().find((id) => state.editTransactions.some((transaction) => (
    transaction.id === id && transaction.sourceLanguage === language && transaction.resolution === "reverted"
  )));
  if (!targetId) return state;
  return {
    ...state,
    stage: "reviewing",
    editTransactions: state.editTransactions.map((transaction) => transaction.id === targetId
      ? { ...transaction, resolution: "pending" as const }
      : transaction),
    redoTransactionIds: state.redoTransactionIds.filter((id) => id !== targetId),
  };
}

export function discardStoryEdit(state: ChapterReviewState, transactionId: string): ChapterReviewState {
  const target = state.editTransactions.find((transaction) => transaction.id === transactionId);
  if (!target || !activeEditResolution(target.resolution) || state.stage === "human_confirmed") return state;
  return {
    ...state,
    stage: "reviewing",
    editTransactions: state.editTransactions.map((transaction) => transaction.id === transactionId
      ? { ...transaction, resolution: "reverted" as const, appliedRevision: undefined }
      : transaction),
    redoTransactionIds: state.redoTransactionIds.filter((id) => id !== transactionId),
  };
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
  const pendingAnnotations = active.filter((annotation) => annotation.resolution === "pending" || annotation.resolution === "needs_evidence");
  const activeEdits = state.editTransactions.filter((transaction) => transaction.resolution !== "reverted");
  const pendingEdits = activeEdits.filter((transaction) => activeEditResolution(transaction.resolution));
  const pendingInsights = Object.values(state.insightReviews).filter((review) => review.resolution === "pending").length;
  return {
    delete: active.filter((annotation) => annotation.type === "delete").length
      + activeEdits.filter((transaction) => transaction.operation === "delete").length,
    revise: active.filter((annotation) => annotation.type === "revise").length
      + activeEdits.filter((transaction) => transaction.operation === "replace").length,
    add: active.filter((annotation) => annotation.type === "add").length
      + activeEdits.filter((transaction) => transaction.operation === "insert").length,
    pendingAnnotations: pendingAnnotations.length + pendingEdits.length,
    needsEvidenceAdd: pendingAnnotations.filter((annotation) => annotation.type === "add" && annotation.resolution === "needs_evidence").length
      + pendingEdits.filter((transaction) => transaction.resolution === "needs_evidence").length,
    pendingInsights,
    // Localized copy can remain stale as a visible follow-up, but it is no
    // longer part of the canonical English review-readiness gate.
    unresolved: pendingAnnotations.length + pendingEdits.length + pendingInsights,
  };
}

/** An injective, serialization-stable identity for a Chapter-local Privacy decision. */
export const privacyDecisionKey = (storyKey: string, candidateId: string) => JSON.stringify([storyKey, candidateId]);

const evidenceKey = (evidence: EvidenceReference) => JSON.stringify([evidence.documentId, evidence.eventId]);
const oppositeLanguage = (language: StoryLanguage): StoryLanguage => language === "en" ? "zh" : "en";
const validPrivacyDecision = (value: unknown): value is PrivacyDecision => value === "keep" || value === "redact";
const validStableId = (value: unknown): value is string => typeof value === "string"
  && value.trim().length > 0
  && value.length <= 300;
const validEvidenceReference = (value: unknown): value is EvidenceReference => Boolean(value)
  && typeof value === "object"
  && typeof (value as EvidenceReference).documentId === "string"
  && Boolean((value as EvidenceReference).documentId.trim())
  && typeof (value as EvidenceReference).eventId === "string"
  && Boolean((value as EvidenceReference).eventId.trim());

const onlyKeys = (value: object, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));

function validSuccessorInsightContent(value: unknown): value is SuccessorInsightContent {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !onlyKeys(value, ["title", "background", "quote", "directlyAcquiredExperience", "principle", "evidence"])) return false;
  const content = value as Partial<SuccessorInsightContent>;
  const quote = content.quote;
  return (content.title === undefined || (typeof content.title === "string" && content.title.length <= 500))
    && typeof content.background === "string" && Boolean(content.background.trim()) && content.background.length <= 4_000
    && Boolean(quote && typeof quote === "object" && !Array.isArray(quote)
      && onlyKeys(quote, ["storyBlockIds"])
      && Array.isArray(quote.storyBlockIds) && quote.storyBlockIds.length > 0 && quote.storyBlockIds.length <= 500
      && quote.storyBlockIds.every(validStableId)
      && new Set(quote.storyBlockIds).size === quote.storyBlockIds.length)
    && typeof content.directlyAcquiredExperience === "string"
    && Boolean(content.directlyAcquiredExperience.trim()) && content.directlyAcquiredExperience.length <= 4_000
    && typeof content.principle === "string" && Boolean(content.principle.trim()) && content.principle.length <= 4_000
    && Array.isArray(content.evidence) && content.evidence.length > 0 && content.evidence.length <= 500
    && content.evidence.every(validEvidenceReference)
    && new Set(content.evidence.map(evidenceKey)).size === content.evidence.length;
}

function validSuccessorHumanInsightContent(value: unknown): value is SuccessorHumanInsightContent {
  const quote = (value as { quote?: unknown } | null)?.quote;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !quote || typeof quote !== "object" || Array.isArray(quote)) return false;
  const content = value as unknown as SuccessorHumanInsightContent;
  return validStableId(content.quote.chapterKey)
    && onlyKeys(content.quote, ["chapterKey", "storyBlockId", "selection", "baseRevision"])
    && validStableId(content.quote.storyBlockId)
    && Number.isInteger(content.quote.baseRevision) && content.quote.baseRevision >= 1
    && Boolean(content.quote.selection && typeof content.quote.selection === "object"
      && !Array.isArray(content.quote.selection)
      && onlyKeys(content.quote.selection, ["start", "end", "text"])
      && Number.isInteger(content.quote.selection.start)
      && Number.isInteger(content.quote.selection.end)
      && content.quote.selection.start >= 0
      && content.quote.selection.end > content.quote.selection.start
      && typeof content.quote.selection.text === "string"
      && content.quote.selection.text.length === content.quote.selection.end - content.quote.selection.start)
    && validSuccessorInsightContent({
      ...content,
      quote: { storyBlockIds: [content.quote.storyBlockId] },
    });
}

function successorContentBelongsToSource(content: SuccessorInsightContent, source: SuccessorStorySource) {
  if (!validSuccessorInsightContent(content)) return false;
  const blocks = new Map(source.story.blocks.map((block) => [block.id, block]));
  const allowedEvidence = new Set([source.evidence.primary, ...source.evidence.supporting].map(evidenceKey));
  if (content.quote.storyBlockIds.some((blockId) => !blocks.has(blockId))
    || content.evidence.some((item) => !allowedEvidence.has(evidenceKey(item)))) return false;
  const anchoredEvidence = new Set(content.quote.storyBlockIds.flatMap((blockId) => (
    blocks.get(blockId)?.evidence.map(evidenceKey) || []
  )));
  return content.evidence.every((item) => anchoredEvidence.has(evidenceKey(item)));
}

function successorHumanQuoteTextForValidation(
  state: SuccessorChapterReviewState,
  source: SuccessorStorySource,
  content: SuccessorHumanInsightContent,
  allowStaleCurrent = false,
) {
  if (!validSuccessorHumanInsightContent(content) || content.quote.baseRevision > state.revision) return null;
  const snapshots = reviewSnapshots(state, successorStoryBlocks(source));
  const base = snapshots?.get(content.quote.baseRevision)?.en?.[content.quote.storyBlockId];
  const selection = content.quote.selection;
  if (typeof base !== "string" || selection.end > base.length
    || base.slice(selection.start, selection.end) !== selection.text) return null;
  const current = snapshots?.get(state.revision)?.en?.[content.quote.storyBlockId];
  if (typeof current !== "string") return null;
  return allowStaleCurrent || (selection.end <= current.length
    && current.slice(selection.start, selection.end) === selection.text)
    ? selection.text
    : null;
}

export function successorHumanQuoteText(
  state: SuccessorChapterReviewState,
  source: SuccessorStorySource,
  content: SuccessorHumanInsightContent,
) {
  return successorHumanQuoteTextForValidation(state, source, content);
}

function successorHumanContentBelongsToSource(
  content: SuccessorHumanInsightContent,
  source: SuccessorStorySource,
  state: SuccessorChapterReviewState,
  allowStaleCurrent = false,
) {
  return validSuccessorHumanInsightContent(content)
    && content.quote.chapterKey === source.key
    && successorContentBelongsToSource({
      ...content,
      quote: { storyBlockIds: [content.quote.storyBlockId] },
    }, source)
    && successorHumanQuoteTextForValidation(state, source, content, allowStaleCurrent) !== null;
}

export function successorStoryBlocks(source: SuccessorStorySource): StoryBlockCollection {
  return {
    en: Object.fromEntries(source.story.blocks.map((block) => [block.id, block.text])),
    zh: {},
  };
}

function successorRevisionOrder(left: SuccessorInsightRevisionRecord, right: SuccessorInsightRevisionRecord) {
  return left.revision - right.revision
    || left.origin.localeCompare(right.origin)
    || left.insightId.localeCompare(right.insightId);
}

/** Validate successor-only Insight identity, content, and provenance while the
 * existing Chapter annotation/direct-edit ledger remains the common owner. */
export function validateSuccessorChapterReviewLedger(
  state: SuccessorChapterReviewState,
  source: SuccessorStorySource,
  requireExactSourceIds = false,
) {
  const sourceIds = source.insights.map((insight) => insight.id);
  const reviewIds = Object.keys(state.sourceInsightReviews || {});
  const humanIds = Object.keys(state.humanInsights || {});
  if (source.schema !== "oxygen.story/3"
    || !validateChapterReviewLedger(state, source.key, successorStoryBlocks(source))
    || Object.keys(state.insightReviews || {}).length !== 0
    || !state.sourceInsightReviews || typeof state.sourceInsightReviews !== "object" || Array.isArray(state.sourceInsightReviews)
    || !state.humanInsights || typeof state.humanInsights !== "object" || Array.isArray(state.humanInsights)
    || !Array.isArray(state.successorInsightRevisionHistory)
    || reviewIds.some((id) => !sourceIds.includes(id))
    || (requireExactSourceIds && (reviewIds.length !== sourceIds.length || sourceIds.some((id) => !reviewIds.includes(id))))
    || humanIds.some((id) => !validStableId(id) || !id.startsWith("human:") || sourceIds.includes(id))
    || new Set([...reviewIds, ...humanIds]).size !== reviewIds.length + humanIds.length) return false;

  const sourceReviewsValid = Object.values(state.sourceInsightReviews).every((review) => Boolean(review)
    && review.origin === "source_ai"
    && Number.isInteger(review.version) && review.version >= 1
    && ["pending", "accepted", "rejected"].includes(review.decision)
    && (review.resolution === "pending" || review.resolution === "applied")
    && (review.editedContent === undefined
      ? review.version === 1
      : review.version >= 2 && successorContentBelongsToSource(review.editedContent, source))
    && (review.resolution === "pending"
      ? review.appliedVersion === undefined && review.appliedRevision === undefined
      : review.decision !== "pending"
        && Number.isInteger(review.appliedVersion) && review.appliedVersion! >= 1
        && Number.isInteger(review.appliedRevision) && review.appliedRevision! >= 2
        && review.appliedRevision! <= state.revision));
  if (!sourceReviewsValid) return false;

  const humanReviewsValid = Object.values(state.humanInsights).every((review) => Boolean(review)
    && review.origin === "human_created"
    && Number.isInteger(review.version) && review.version >= 1
    && (review.decision === "draft" || review.decision === "human_approved")
    && (review.resolution === "pending" || review.resolution === "applied")
    && successorHumanContentBelongsToSource(
      review.content,
      source,
      state,
      review.decision === "draft" && review.resolution === "pending",
    )
    && (review.resolution === "pending"
      ? review.appliedVersion === undefined && review.appliedRevision === undefined
      : review.decision === "human_approved"
        && Number.isInteger(review.appliedVersion) && review.appliedVersion! >= 1
        && Number.isInteger(review.appliedRevision) && review.appliedRevision! >= 2
        && review.appliedRevision! <= state.revision));
  if (!humanReviewsValid) return false;

  const history = state.successorInsightRevisionHistory;
  const canonicalHistory = [...history].sort(successorRevisionOrder);
  if (history.some((record, index) => record !== canonicalHistory[index])
    || new Set(history.map((record) => JSON.stringify([record.revision, record.origin, record.insightId]))).size !== history.length
    || history.some((record) => !Number.isInteger(record.revision) || record.revision < 2 || record.revision > state.revision
      || !validStableId(record.insightId)
      || (record.origin !== "source_ai" && record.origin !== "human_created")
      || !Number.isInteger(record.version) || record.version < 1
      || (record.origin === "source_ai" && !["accepted", "rejected"].includes(record.decision))
      || (record.origin === "human_created" && record.decision !== "human_approved")
      || !state.revisionHistory.some((chapterRecord) => chapterRecord.revision === record.revision)
      || (record.origin === "source_ai" ? !sourceIds.includes(record.insightId) : !humanIds.includes(record.insightId)))) return false;

  const latestRecord = (insightId: string, origin: SuccessorInsightRevisionRecord["origin"]) => (
    [...history].reverse().find((record) => record.insightId === insightId && record.origin === origin)
  );
  return Object.entries(state.sourceInsightReviews).every(([insightId, review]) => {
    if (review.resolution !== "applied") return true;
    const record = latestRecord(insightId, "source_ai");
    return Boolean(record
      && record!.revision === review.appliedRevision
      && record!.version === review.appliedVersion
      && record!.decision === review.decision);
  }) && Object.entries(state.humanInsights).every(([insightId, review]) => {
    if (review.resolution !== "applied") return true;
    const record = latestRecord(insightId, "human_created");
    return Boolean(record
      && record!.revision === review.appliedRevision
      && record!.version === review.appliedVersion
      && record!.decision === "human_approved");
  });
}

export function updateSuccessorAiInsightDecision(
  state: SuccessorChapterReviewState,
  source: SuccessorStorySource,
  insightId: string,
  decision: "accepted" | "rejected",
): SuccessorChapterReviewState {
  const previous = state.sourceInsightReviews[insightId];
  if (state.stage === "human_confirmed" || !source.insights.some((insight) => insight.id === insightId) || !previous) return state;
  return {
    ...state,
    stage: "reviewing",
    sourceInsightReviews: {
      ...state.sourceInsightReviews,
      [insightId]: {
        ...previous,
        decision,
        resolution: "pending",
        appliedVersion: undefined,
        appliedRevision: undefined,
      },
    },
  };
}

export function editSuccessorAiInsight(
  state: SuccessorChapterReviewState,
  source: SuccessorStorySource,
  insightId: string,
  content: SuccessorInsightContent,
): SuccessorChapterReviewState {
  const previous = state.sourceInsightReviews[insightId];
  if (state.stage === "human_confirmed" || !previous || !successorContentBelongsToSource(content, source)) return state;
  return {
    ...state,
    stage: "reviewing",
    sourceInsightReviews: {
      ...state.sourceInsightReviews,
      [insightId]: {
        origin: "source_ai",
        version: previous.version + 1,
        decision: "pending",
        resolution: "pending",
        editedContent: content,
      },
    },
  };
}

export function editSuccessorHumanInsight(
  state: SuccessorChapterReviewState,
  source: SuccessorStorySource,
  insightId: string,
  content: SuccessorHumanInsightContent,
): SuccessorChapterReviewState {
  const previous = state.humanInsights[insightId];
  if (state.stage === "human_confirmed"
    || !validStableId(insightId) || !insightId.startsWith("human:")
    || source.insights.some((insight) => insight.id === insightId)
    || !successorHumanContentBelongsToSource(content, source, state)) return state;
  return {
    ...state,
    stage: "reviewing",
    humanInsights: {
      ...state.humanInsights,
      [insightId]: {
        origin: "human_created",
        version: (previous?.version || 0) + 1,
        decision: "draft",
        resolution: "pending",
        content,
      },
    },
  };
}

function updateTranslationStaleness(
  current: TranslationStaleness[],
  subject: TranslationStaleness["subject"],
  sourceLanguage: StoryLanguage,
) {
  const resolvesPairedLocale = current.some((item) => item.subject === subject && item.language === sourceLanguage);
  if (resolvesPairedLocale) return current.filter((item) => !(item.subject === subject && item.language === sourceLanguage));
  const target = oppositeLanguage(sourceLanguage);
  return current.some((item) => item.subject === subject && item.language === target)
    ? current
    : [...current, { subject, language: target, count: 1 }];
}

function privacyComplete(context: ChapterReviewCompletionContext) {
  if (!Array.isArray(context.privacyCandidates)
    || !context.privacyDecisions || typeof context.privacyDecisions !== "object" || Array.isArray(context.privacyDecisions)
    || !context.targetCatalog || typeof context.targetCatalog.has !== "function") return false;
  const ids = context.privacyCandidates.map((candidate) => candidate.id);
  return ids.every(validStableId)
    && new Set(ids).size === ids.length
    && context.privacyCandidates.every((candidate) => {
      const decision = context.privacyDecisions[candidate.id];
      return Array.isArray(candidate.releaseTargets)
        && candidate.releaseTargets.every((target) => validStableId(target) && context.targetCatalog.has(target))
        && new Set(candidate.releaseTargets).size === candidate.releaseTargets.length
        && validPrivacyDecision(decision);
    });
}

function currentPrivacyDecisions(context: ChapterReviewCompletionContext) {
  return Object.fromEntries(context.privacyCandidates.map((candidate) => [candidate.id, context.privacyDecisions[candidate.id]])) as Record<string, PrivacyDecision>;
}

function sameDecisions(left: unknown, right: unknown) {
  if (!left || typeof left !== "object" || Array.isArray(left)
    || !right || typeof right !== "object" || Array.isArray(right)) return false;
  const leftDecisions = left as Record<string, PrivacyDecision>;
  const rightDecisions = right as Record<string, PrivacyDecision>;
  const leftKeys = Object.keys(leftDecisions).sort();
  const rightKeys = Object.keys(rightDecisions).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && validPrivacyDecision(leftDecisions[key])
      && leftDecisions[key] === rightDecisions[key]);
}

const cloneBlocks = (source: StoryBlockCollection): StoryBlockCollection => ({
  en: { ...(source.en || {}) },
  zh: { ...(source.zh || {}) },
});

function applyAnnotationGroup(source: string, annotations: StoryReviewAnnotation[]) {
  const ordered = [...annotations].sort((left, right) => right.selection.start - left.selection.start);
  if (ordered.some((annotation, index) => ordered.slice(index + 1).some((other) => rangesOverlap(annotation, other)))) {
    return null;
  }
  let result = source;
  for (const annotation of ordered) {
    if (result.slice(annotation.selection.start, annotation.selection.end) !== annotation.selection.text) return null;
    if (annotation.type === "delete") {
      result = `${result.slice(0, annotation.selection.start)}${result.slice(annotation.selection.end)}`.replace(/\s{2,}/g, " ").trim();
    } else if (annotation.type === "revise" && annotation.instruction) {
      result = `${result.slice(0, annotation.selection.start)}${annotation.instruction}${result.slice(annotation.selection.end)}`.trim();
    } else if (annotation.type === "add" && annotation.instruction) {
      const separator = /\s$/.test(annotation.selection.text) ? "" : " ";
      result = `${result.slice(0, annotation.selection.end)}${separator}${annotation.instruction}${result.slice(annotation.selection.end)}`.trim();
    } else {
      return null;
    }
  }
  return result;
}

function reviewSnapshots(state: ChapterReviewState, sourceBlocks: StoryBlockCollection) {
  const snapshots = new Map<number, StoryBlockCollection>([[1, cloneBlocks(sourceBlocks)]]);
  for (let revision = 2; revision <= state.revision; revision += 1) {
    const previous = snapshots.get(revision - 1);
    if (!previous) return null;
    const next = cloneBlocks(previous);
    const appliedAnnotations = state.annotations.filter((annotation) => annotation.resolution === "applied"
      && annotation.appliedRevision === revision);
    const appliedEdits = state.editTransactions.filter((transaction) => transaction.resolution === "applied"
      && transaction.appliedRevision === revision);
    const groupKeys = [...new Set([
      ...appliedAnnotations.map((annotation) => JSON.stringify([annotation.sourceLanguage, annotation.blockId])),
      ...appliedEdits.map((transaction) => JSON.stringify([transaction.sourceLanguage, transaction.blockId])),
    ])];
    for (const key of groupKeys) {
      const [language, blockId] = JSON.parse(key) as [StoryLanguage, string];
      const source = next[language]?.[blockId];
      const annotationGroup = appliedAnnotations.filter((annotation) => annotation.sourceLanguage === language && annotation.blockId === blockId);
      const editGroup = appliedEdits.filter((transaction) => transaction.sourceLanguage === language && transaction.blockId === blockId);
      if (typeof source !== "string" || (annotationGroup.length > 0 && editGroup.length > 0)
        || annotationGroup.some((annotation) => annotation.baseRevision !== revision - 1)
        || editGroup.some((transaction) => transaction.baseRevision !== revision - 1)) return null;
      const projected = annotationGroup.length
        ? applyAnnotationGroup(source, annotationGroup)
        : applyDirectEditGroup(source, editGroup);
      if (projected === null) return null;
      next[language][blockId] = projected;
    }
    snapshots.set(revision, next);
  }
  return snapshots;
}

/** Validate the complete stored annotation ledger, not just work pending in the
 * current UI. This prevents malformed applied/cancelled provenance or IDs that
 * collide across resolutions from being silently skipped at final release. */
export function validateChapterReviewLedger(
  state: ChapterReviewState,
  storyKey: string,
  sourceBlocks: StoryBlockCollection,
  reviewedBlocks: StoryBlockCollection = sourceBlocks,
) {
  if (!validStableId(storyKey)
    || !Number.isInteger(state.revision) || state.revision < 1
    || !Array.isArray(state.annotations) || !Array.isArray(state.editTransactions)
    || !Array.isArray(state.redoTransactionIds) || !Array.isArray(state.revisionHistory)
    || state.publicationApproved !== false) return false;
  const annotationIds = state.annotations.map((annotation) => annotation?.id);
  const editIds = state.editTransactions.map((transaction) => transaction?.id);
  const allIds = [...annotationIds, ...editIds];
  if (!allIds.every(validStableId) || new Set(allIds).size !== allIds.length
    || !state.redoTransactionIds.every(validStableId)
    || new Set(state.redoTransactionIds).size !== state.redoTransactionIds.length
    || state.redoTransactionIds.some((id) => !state.editTransactions.some((transaction) => (
      transaction.id === id && transaction.resolution === "reverted"
    )))) return false;

  const allowedTypes: StoryAnnotationType[] = ["delete", "revise", "add"];
  const allowedResolutions: StoryAnnotationResolution[] = ["pending", "applied", "needs_evidence", "cancelled"];
  const baseShapeValid = state.annotations.every((annotation) => {
    const selection = annotation?.selection;
    const instructionRequired = annotation?.type === "revise" || annotation?.type === "add";
    const evidenceValid = annotation?.supportingEvidence === undefined
      || (Array.isArray(annotation.supportingEvidence) && annotation.supportingEvidence.every(validEvidenceReference));
    return validStableId(annotation?.blockId)
      && allowedTypes.includes(annotation?.type)
      && (annotation?.sourceLanguage === "en" || annotation?.sourceLanguage === "zh")
      && allowedResolutions.includes(annotation?.resolution)
      && Number.isInteger(annotation?.baseRevision)
      && annotation.baseRevision >= 1 && annotation.baseRevision <= state.revision
      && Boolean(selection) && Number.isInteger(selection.start) && Number.isInteger(selection.end)
      && selection.start >= 0 && selection.end > selection.start
      && typeof selection.text === "string" && selection.text.length === selection.end - selection.start
      && (!instructionRequired || Boolean(annotation.instruction?.trim()))
      && evidenceValid
      && (annotation.resolution === "applied"
        ? Number.isInteger(annotation.appliedRevision)
          && annotation.appliedRevision! >= 2
          && annotation.appliedRevision! <= state.revision
          && annotation.baseRevision === annotation.appliedRevision! - 1
        : annotation.appliedRevision === undefined)
      && (annotation.resolution !== "needs_evidence" || annotation.type === "add")
      && (annotation.resolution !== "pending" || annotation.baseRevision === state.revision);
  });
  if (!baseShapeValid) return false;

  const allowedEditOperations: StoryEditOperation[] = ["insert", "delete", "replace"];
  const allowedEditResolutions: StoryEditResolution[] = ["pending", "applied", "reverted", "needs_evidence"];
  const editShapeValid = state.editTransactions.every((transaction) => {
    const before = transaction?.beforeRange;
    const after = transaction?.afterRange;
    const evidenceValid = transaction?.supportingEvidence === undefined
      || (Array.isArray(transaction.supportingEvidence) && transaction.supportingEvidence.every(validEvidenceReference));
    return transaction?.storyKey === storyKey
      && validStableId(transaction?.blockId)
      && (transaction?.sourceLanguage === "en" || transaction?.sourceLanguage === "zh")
      && allowedEditOperations.includes(transaction?.operation)
      && allowedEditResolutions.includes(transaction?.resolution)
      && Number.isInteger(transaction?.baseRevision)
      && transaction.baseRevision >= 1 && transaction.baseRevision <= state.revision
      && Boolean(before) && Number.isInteger(before.start) && Number.isInteger(before.end)
      && before.start >= 0 && before.end >= before.start
      && Boolean(after) && Number.isInteger(after.start) && Number.isInteger(after.end)
      && after.start >= 0 && after.end >= after.start
      && typeof transaction.beforeText === "string" && transaction.beforeText.length === before.end - before.start
      && typeof transaction.afterText === "string" && transaction.afterText.length <= 20_000
      && (transaction.beforeText !== transaction.afterText || transaction.resolution === "reverted")
      && editOperation(transaction.beforeText, transaction.afterText) === transaction.operation
      && typeof transaction.requiresEvidence === "boolean"
      && evidenceValid
      && Number.isFinite(transaction.createdAt) && Number.isFinite(transaction.updatedAt)
      && transaction.createdAt >= 0 && transaction.updatedAt >= transaction.createdAt
      && (transaction.revertsTransactionId === undefined || validStableId(transaction.revertsTransactionId))
      && (transaction.resolution === "applied"
        ? Number.isInteger(transaction.appliedRevision)
          && transaction.appliedRevision! >= 2
          && transaction.appliedRevision! <= state.revision
          && transaction.baseRevision === transaction.appliedRevision! - 1
        : transaction.appliedRevision === undefined)
      && (transaction.resolution !== "needs_evidence" || transaction.requiresEvidence)
      && (!activeEditResolution(transaction.resolution) || transaction.baseRevision === state.revision);
  });
  if (!editShapeValid) return false;

  const currentActiveEdits = state.editTransactions.filter((transaction) => activeEditResolution(transaction.resolution));
  if (currentActiveEdits.some((transaction, index) => currentActiveEdits.slice(index + 1).some((other) => (
    transaction.storyKey === other.storyKey
      && transaction.blockId === other.blockId
      && transaction.sourceLanguage === other.sourceLanguage
      && editRangesConflict(transaction, other)
  ))) || state.annotations.some((annotation) => (annotation.resolution === "pending" || annotation.resolution === "needs_evidence")
    && currentActiveEdits.some((transaction) => transaction.blockId === annotation.blockId
      && transaction.sourceLanguage === annotation.sourceLanguage
      && transaction.baseRevision === annotation.baseRevision))) return false;

  if (state.revisionHistory.length !== state.revision - 1) return false;
  const recordedAnnotationIds: string[] = [];
  const recordedEditIds: string[] = [];
  for (let index = 0; index < state.revisionHistory.length; index += 1) {
    const record = state.revisionHistory[index];
    const recordEditIds = record.editTransactionIds ?? [];
    if (record.revision !== index + 2
      || !Array.isArray(record.annotationIds) || !record.annotationIds.every(validStableId)
      || new Set(record.annotationIds).size !== record.annotationIds.length
      || !Array.isArray(recordEditIds) || !recordEditIds.every(validStableId)
      || new Set(recordEditIds).size !== recordEditIds.length
      || !Array.isArray(record.insightIds) || !record.insightIds.every(validStableId)
      || new Set(record.insightIds).size !== record.insightIds.length
      || !record.privacyDecisions || typeof record.privacyDecisions !== "object"
      || Object.keys(record.privacyDecisions).some((id) => !validStableId(id) || !validPrivacyDecision(record.privacyDecisions[id]))) {
      return false;
    }
    recordedAnnotationIds.push(...record.annotationIds);
    recordedEditIds.push(...recordEditIds);
  }
  if (new Set(recordedAnnotationIds).size !== recordedAnnotationIds.length) return false;
  const appliedAnnotations = state.annotations.filter((annotation) => annotation.resolution === "applied");
  if (recordedAnnotationIds.length !== appliedAnnotations.length
    || appliedAnnotations.some((annotation) => !state.revisionHistory.some((record) => (
      record.revision === annotation.appliedRevision && record.annotationIds.includes(annotation.id)
    )))) return false;

  if (new Set(recordedEditIds).size !== recordedEditIds.length) return false;
  const appliedEdits = state.editTransactions.filter((transaction) => transaction.resolution === "applied");
  if (recordedEditIds.length !== appliedEdits.length
    || appliedEdits.some((transaction) => !state.revisionHistory.some((record) => (
      record.revision === transaction.appliedRevision && (record.editTransactionIds || []).includes(transaction.id)
    )))) return false;

  const snapshots = reviewSnapshots(state, sourceBlocks);
  if (!snapshots) return false;
  if (!state.annotations.every((annotation) => {
    const source = annotation.resolution === "pending"
      ? snapshots.get(state.revision)?.[annotation.sourceLanguage]?.[annotation.blockId]
      : snapshots.get(annotation.baseRevision)?.[annotation.sourceLanguage]?.[annotation.blockId];
    return typeof source === "string"
      && annotation.selection.end <= source.length
      && source.slice(annotation.selection.start, annotation.selection.end) === annotation.selection.text;
  })) return false;

  if (!state.editTransactions.every((transaction) => {
    const source = snapshots.get(transaction.baseRevision)?.[transaction.sourceLanguage]?.[transaction.blockId];
    return typeof source === "string"
      && transaction.beforeRange.end <= source.length
      && source.slice(transaction.beforeRange.start, transaction.beforeRange.end) === transaction.beforeText;
  })) return false;

  for (const revision of snapshots.keys()) {
    if (revision === 1) continue;
    const edits = state.editTransactions.filter((transaction) => transaction.resolution === "applied" && transaction.appliedRevision === revision);
    const groups = [...new Set(edits.map((transaction) => JSON.stringify([transaction.sourceLanguage, transaction.blockId])))];
    for (const key of groups) {
      const [language, blockId] = JSON.parse(key) as [StoryLanguage, string];
      const before = snapshots.get(revision - 1)?.[language]?.[blockId];
      const group = edits.filter((transaction) => transaction.sourceLanguage === language && transaction.blockId === blockId);
      const projection = typeof before === "string" ? projectDirectEditGroup(before, group) : null;
      if (!projection || projection.projections.some(({ transaction, workStart, workEnd }) => (
        transaction.afterRange.start !== workStart || transaction.afterRange.end !== workEnd
      ))) return false;
    }
  }

  // `reviewedBlocks` remains part of the public completion context for callers
  // that precompute the current projection. Ledger validity itself is derived
  // from immutable sources plus recorded revisions, never trusted browser copy.
  void reviewedBlocks;
  return true;
}

const insightStatuses: InsightReviewStatus[] = ["accepted", "needs_changes", "rejected", "overridden"];
const insightResolutions: InsightReview["resolution"][] = ["pending", "applied"];

function validLocalizedHighlight(value: unknown, insightId: string): value is StoryHighlightItem {
  if (!value || typeof value !== "object") return false;
  const highlight = value as StoryHighlightItem;
  return highlight.id === insightId
    && [highlight.title, highlight.noticed, highlight.lesson].every((copy) => (
      typeof copy === "string" && copy.trim().length > 0 && copy.length <= 20_000
    ));
}

/** Validate insight provenance independently from annotation replay. An insight
 * may appear in more than one revision record when a human reopens and reviews
 * it again, but the current applied state must point at its latest record. */
export function validateInsightReviewLedger(state: ChapterReviewState, reviewableInsightIds: string[]) {
  if (!Array.isArray(reviewableInsightIds) || reviewableInsightIds.length !== 1
    || !reviewableInsightIds.every(validStableId)
    || new Set(reviewableInsightIds).size !== reviewableInsightIds.length
    || !state.insightReviews || typeof state.insightReviews !== "object" || Array.isArray(state.insightReviews)
    || !Array.isArray(state.revisionHistory)) return false;
  const allowedIds = new Set(reviewableInsightIds);
  const reviews = Object.entries(state.insightReviews);
  if (reviews.some(([insightId]) => !allowedIds.has(insightId))) return false;

  const recordedRevisions = new Map<string, number[]>();
  for (const record of state.revisionHistory) {
    if (!Array.isArray(record?.insightIds) || record.insightIds.some((insightId) => !allowedIds.has(insightId))) return false;
    for (const insightId of record.insightIds) {
      recordedRevisions.set(insightId, [...(recordedRevisions.get(insightId) || []), record.revision]);
    }
  }
  if ([...recordedRevisions.keys()].some((insightId) => !state.insightReviews[insightId])) return false;

  return reviews.every(([insightId, review]) => {
    if (!review || !insightStatuses.includes(review.status)
      || typeof review.text !== "string" || !review.text.trim() || review.text.length > 20_000
      || !review.localized || typeof review.localized !== "object" || Array.isArray(review.localized)
      || Object.keys(review.localized).some((language) => language !== "en" && language !== "zh")
      || Object.values(review.localized).some((highlight) => !validLocalizedHighlight(highlight, insightId))
      || !Array.isArray(review.pendingLanguages)
      || review.pendingLanguages.some((language) => language !== "en" && language !== "zh")
      || new Set(review.pendingLanguages).size !== review.pendingLanguages.length
      || (review.revision !== undefined && review.revision !== "direct" && review.revision !== "ai")
      || !insightResolutions.includes(review.resolution)
      || (review.status === "overridden" && Object.keys(review.localized).length === 0)) return false;
    const history = recordedRevisions.get(insightId) || [];
    if (review.resolution === "pending") return review.appliedRevision === undefined;
    return Number.isInteger(review.appliedRevision)
      && review.appliedRevision! >= 2
      && review.appliedRevision! <= state.revision
      && review.pendingLanguages.length === 0
      && history.length > 0
      && history[history.length - 1] === review.appliedRevision;
  });
}

function expectedRedactedBlocks(context: ChapterReviewCompletionContext) {
  return [...new Set(context.privacyCandidates.flatMap((candidate) => (
    context.privacyDecisions[candidate.id] === "redact" ? candidate.releaseTargets : []
  )))];
}

function sameUniqueStrings(left: unknown, right: unknown) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.every(validStableId)
    && right.every(validStableId)
    && new Set(left).size === left.length
    && new Set(right).size === right.length
    && left.length === right.length
    && left.every((value) => right.includes(value));
}

function evaluateValidatedCommonChapterReviewCompletion(
  state: ChapterReviewState,
  context: ChapterReviewCompletionContext,
  insightBlockers: ChapterReviewBlocker[],
): ChapterReviewBlocker[] {
  const chapterKey = validStableId(context?.storyKey) ? context.storyKey : "unknown";
  const chapterBlocker = (code: ChapterReviewBlocker["code"]): ChapterReviewBlocker => ({
    code,
    chapterKey,
    targetKind: "chapter",
  });

  try {
    const blockers: ChapterReviewBlocker[] = [];
    if (!state.evidenceVerified) blockers.push(chapterBlocker("evidence_unverified"));
    blockers.push(...state.annotations
      .filter((annotation) => annotation.resolution === "pending" || annotation.resolution === "needs_evidence")
      .map((annotation) => ({
        code: annotation.resolution === "pending" ? "annotation_pending" as const : "annotation_needs_evidence" as const,
        chapterKey,
        targetKind: "story_block" as const,
        targetId: annotation.blockId,
        itemId: annotation.id,
      })));
    blockers.push(...state.editTransactions
      .filter((transaction) => activeEditResolution(transaction.resolution))
      .map((transaction) => ({
        code: transaction.resolution === "pending" ? "direct_edit_pending" as const : "direct_edit_needs_evidence" as const,
        chapterKey,
        targetKind: "story_block" as const,
        targetId: transaction.blockId,
        itemId: transaction.id,
      })));
    blockers.push(...insightBlockers);
    if (!sameDecisions(state.appliedPrivacyDecisions, currentPrivacyDecisions(context))) {
      blockers.push(chapterBlocker("privacy_decisions_stale"));
    }
    const latest = state.revisionHistory[state.revisionHistory.length - 1];
    if (!latest
      || latest.revision !== state.revision
      || !sameDecisions(latest.privacyDecisions, state.appliedPrivacyDecisions)) {
      blockers.push(chapterBlocker("revision_provenance_mismatch"));
    }
    if (!sameUniqueStrings(state.redactedBlocks, expectedRedactedBlocks(context))) {
      blockers.push(chapterBlocker("redaction_targets_mismatch"));
    }
    return blockers;
  } catch {
    return [chapterBlocker("review_state_invalid")];
  }
}

function evaluateCommonChapterReviewCompletion(
  state: ChapterReviewState,
  context: ChapterReviewCompletionContext,
  insightBlockers: ChapterReviewBlocker[] = [],
) {
  const chapterKey = validStableId(context?.storyKey) ? context.storyKey : "unknown";
  const invalid = (code: "review_state_invalid" | "privacy_incomplete"): ChapterReviewBlocker[] => [{
    code,
    chapterKey,
    targetKind: "chapter",
  }];
  try {
    if (!validStableId(context.storyKey)) return invalid("review_state_invalid");
    if (!privacyComplete(context)) return invalid("privacy_incomplete");
    if (!validateChapterReviewLedger(state, context.storyKey, context.sourceBlocks, context.reviewedBlocks)
      || !Array.isArray(state.staleTranslations)) return invalid("review_state_invalid");
    return evaluateValidatedCommonChapterReviewCompletion(state, context, insightBlockers);
  } catch {
    return invalid("review_state_invalid");
  }
}

function evaluateChapterReviewCompletion(
  state: ChapterReviewState,
  context: ChapterReviewCompletionContext,
): ChapterReviewBlocker[] {
  const chapterKey = validStableId(context?.storyKey) ? context.storyKey : "unknown";
  try {
    if (!validStableId(context.storyKey)) {
      return [{ code: "review_state_invalid", chapterKey, targetKind: "chapter" }];
    }
    if (!privacyComplete(context)) {
      return [{ code: "privacy_incomplete", chapterKey, targetKind: "chapter" }];
    }
    if (!validateInsightReviewLedger(state, context.reviewableInsightIds)) {
      return [{ code: "review_state_invalid", chapterKey, targetKind: "chapter" }];
    }
    const insightBlockers: ChapterReviewBlocker[] = Object.entries(state.insightReviews)
      .filter(([, review]) => review.resolution === "pending")
      .map(([insightId]) => ({
        code: "insight_pending",
        chapterKey,
        targetKind: "insight",
        targetId: insightId,
      }));
    return evaluateCommonChapterReviewCompletion(state, context, insightBlockers);
  } catch {
    return [{ code: "review_state_invalid", chapterKey, targetKind: "chapter" }];
  }
}

function successorInsightCompletionBlockers(
  state: SuccessorChapterReviewState,
  source: SuccessorStorySource,
): SuccessorChapterReviewBlocker[] {
  const blockers: SuccessorChapterReviewBlocker[] = [];
  for (const insight of source.insights) {
    const review = state.sourceInsightReviews[insight.id];
    if (!review) {
      blockers.push({
        code: "ai_insight_decision_missing", chapterKey: source.key, targetKind: "insight", targetId: insight.id,
      });
      continue;
    }
    const currentApplied = review.resolution === "applied"
      && review.appliedVersion === review.version
      && review.appliedRevision !== undefined;
    if (currentApplied) continue;
    blockers.push({
      code: review.version > 1 || review.resolution === "applied"
        ? "ai_insight_reaccept_required"
        : "ai_insight_decision_pending",
      chapterKey: source.key,
      targetKind: "insight",
      targetId: insight.id,
    });
  }
  blockers.push(...Object.entries(state.humanInsights)
    .filter(([, review]) => review.resolution !== "applied"
      || review.decision !== "human_approved"
      || review.appliedVersion !== review.version)
    .map(([insightId]) => ({
      code: "human_insight_pending" as const,
      chapterKey: source.key,
      targetKind: "insight" as const,
      targetId: insightId,
    })));
  return blockers;
}

function evaluateSuccessorChapterReviewCompletion(
  state: SuccessorChapterReviewState,
  context: SuccessorChapterReviewContext,
): SuccessorChapterReviewBlocker[] {
  const commonContext: ChapterReviewCompletionContext = {
    ...context,
    storyKey: context.source.key,
    reviewableInsightIds: [],
  };
  if (!validateSuccessorChapterReviewLedger(state, context.source)) {
    return [{
      code: "review_state_invalid" as const,
      chapterKey: context.source.key,
      targetKind: "chapter" as const,
    }];
  }
  return [
    ...evaluateCommonChapterReviewCompletion(state, commonContext),
    ...successorInsightCompletionBlockers(state, context.source),
  ];
}

/** Project bounded successor reasons without including Insight or Evidence copy. */
export function successorChapterReviewCompletionBlockers(
  state: SuccessorChapterReviewState,
  context: SuccessorChapterReviewContext,
) {
  return evaluateSuccessorChapterReviewCompletion(state, context);
}

export function validateSuccessorChapterReviewCompletion(
  state: SuccessorChapterReviewState,
  context: SuccessorChapterReviewContext,
) {
  return evaluateSuccessorChapterReviewCompletion(state, context).length === 0;
}

/** Project bounded, display-safe reasons that the current Chapter cannot complete. */
export function chapterReviewCompletionBlockers(
  state: ChapterReviewState,
  context: ChapterReviewCompletionContext,
) {
  return evaluateChapterReviewCompletion(state, context);
}

/** Validate all state required for All set or release projection. Browser-owned
 * stage flags and cached redacted blocks are never sufficient by themselves. */
export function validateChapterReviewCompletion(
  state: ChapterReviewState,
  context: ChapterReviewCompletionContext,
) {
  return evaluateChapterReviewCompletion(state, context).length === 0;
}

function applyChapterReviewWithInsightValidator(
  state: ChapterReviewState,
  context: ApplyReviewContext,
  insightValidator: (state: ChapterReviewState, reviewableInsightIds: string[]) => boolean,
): { state: ChapterReviewState; blockedReason?: "privacy" | "evidence" | "annotations" | "direct_evidence" } {
  if (!validStableId(context.storyKey)
    || state.editTransactions.some((transaction) => transaction.storyKey !== context.storyKey)) {
    return { state, blockedReason: "annotations" };
  }
  if (!privacyComplete(context)) return { state, blockedReason: "privacy" };
  if (!context.evidenceResolved) return { state, blockedReason: "evidence" };
  if (!validateChapterReviewLedger(state, context.storyKey, context.sourceBlocks, context.reviewedBlocks)
    || !insightValidator(state, context.reviewableInsightIds)) {
    return { state, blockedReason: "annotations" };
  }
  const availableEvidence = new Set(context.chapterEvidence.map(evidenceKey));
  const supportedAddIds = new Set(context.supportedAddIds);
  const supportedEditIds = new Set(context.supportedEditIds || []);
  const unsupportedDirectEdits = state.editTransactions.filter((transaction) => activeEditResolution(transaction.resolution)
    && transaction.requiresEvidence
    && !(supportedEditIds.has(transaction.id)
      && transaction.supportingEvidence?.length
      && transaction.supportingEvidence.every((evidence) => availableEvidence.has(evidenceKey(evidence)))));
  if (unsupportedDirectEdits.length) {
    const unsupportedIds = new Set(unsupportedDirectEdits.map((transaction) => transaction.id));
    return {
      state: {
        ...state,
        stage: "reviewing",
        editTransactions: state.editTransactions.map((transaction) => unsupportedIds.has(transaction.id)
          ? { ...transaction, resolution: "needs_evidence" as const }
          : transaction),
      },
      blockedReason: "direct_evidence",
    };
  }
  const revision = state.revision + 1;
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

  const normalizedRangeById = new Map<string, StoryEditRange>();
  const pendingEditGroups = [...new Set(state.editTransactions
    .filter((transaction) => activeEditResolution(transaction.resolution))
    .map((transaction) => JSON.stringify([transaction.storyKey, transaction.sourceLanguage, transaction.blockId])))];
  for (const key of pendingEditGroups) {
    const [storyKey, sourceLanguage, blockId] = JSON.parse(key) as [string, StoryLanguage, string];
    const group = state.editTransactions.filter((transaction) => transaction.storyKey === storyKey
      && transaction.sourceLanguage === sourceLanguage
      && transaction.blockId === blockId
      && activeEditResolution(transaction.resolution));
    const source = context.reviewedBlocks[sourceLanguage]?.[blockId];
    const projection = typeof source === "string" ? projectDirectEditGroup(source, group) : null;
    if (!projection) return { state, blockedReason: "annotations" };
    for (const item of projection.projections) {
      normalizedRangeById.set(item.transaction.id, { start: item.workStart, end: item.workEnd });
    }
  }

  const appliedEditIds: string[] = [];
  const editTransactions = state.editTransactions.map((transaction) => {
    if (!activeEditResolution(transaction.resolution)) return transaction;
    const supported = !transaction.requiresEvidence || Boolean(
      supportedEditIds.has(transaction.id)
      && transaction.supportingEvidence?.length
      && transaction.supportingEvidence.every((evidence) => availableEvidence.has(evidenceKey(evidence))),
    );
    if (!supported) return {
      ...transaction,
      afterRange: normalizedRangeById.get(transaction.id) || transaction.afterRange,
      resolution: "needs_evidence" as const,
    };
    appliedEditIds.push(transaction.id);
    staleTranslations = updateTranslationStaleness(
      staleTranslations,
      `story:${transaction.blockId}`,
      transaction.sourceLanguage,
    );
    return {
      ...transaction,
      afterRange: normalizedRangeById.get(transaction.id) || transaction.afterRange,
      resolution: "applied" as const,
      appliedRevision: revision,
    };
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
  const nextState: ChapterReviewState = {
    ...state,
    stage: "revision_ready",
    revision,
    annotations,
    editTransactions,
    redoTransactionIds: [],
    insightReviews,
    appliedPrivacyDecisions,
    redactedBlocks,
    staleTranslations,
    evidenceVerified: true,
    revisionHistory: [...state.revisionHistory, {
      revision,
      annotationIds: appliedAnnotationIds,
      editTransactionIds: appliedEditIds,
      insightIds: appliedInsightIds,
      privacyDecisions: appliedPrivacyDecisions,
    }],
  };
  return validateChapterReviewLedger(nextState, context.storyKey, context.sourceBlocks, context.reviewedBlocks)
    ? { state: nextState }
    : { state, blockedReason: "annotations" };
}

export function applyChapterReview(
  state: ChapterReviewState,
  context: ApplyReviewContext,
) {
  return applyChapterReviewWithInsightValidator(state, context, validateInsightReviewLedger);
}

export function applySuccessorChapterReview(
  state: SuccessorChapterReviewState,
  context: SuccessorChapterReviewContext,
): {
  state: SuccessorChapterReviewState;
  blockedReason?: "privacy" | "evidence" | "annotations" | "direct_evidence" | "insights";
} {
  const applyContext: ApplyReviewContext = {
    ...context,
    storyKey: context.source.key,
    reviewableInsightIds: context.source.insights.map((insight) => insight.id),
    chapterEvidence: [context.source.evidence.primary, ...context.source.evidence.supporting],
  };
  const result = applyChapterReviewWithInsightValidator(
    state,
    applyContext,
    (candidate) => validateSuccessorChapterReviewLedger(
      candidate as SuccessorChapterReviewState,
      context.source,
      true,
    ),
  );
  if (result.blockedReason) return { state, blockedReason: result.blockedReason };
  const applied = result.state as SuccessorChapterReviewState;
  const reviewWithStaleHumanQuotesReopened: SuccessorChapterReviewState = {
    ...applied,
    humanInsights: Object.fromEntries(Object.entries(applied.humanInsights).map(([insightId, review]) => (
      review.resolution === "applied" && successorHumanQuoteText(applied, context.source, review.content) === null
        ? [insightId, {
          ...review,
          version: review.version + 1,
          decision: "draft" as const,
          resolution: "pending" as const,
          appliedVersion: undefined,
          appliedRevision: undefined,
        }]
        : [insightId, review]
    ))),
  };
  const revision = applied.revision;
  const records: SuccessorInsightRevisionRecord[] = [];
  const sourceInsightReviews = Object.fromEntries(Object.entries(reviewWithStaleHumanQuotesReopened.sourceInsightReviews).map(([insightId, review]) => {
    if (review.resolution !== "pending" || review.decision === "pending") return [insightId, review];
    records.push({
      revision,
      insightId,
      origin: "source_ai",
      version: review.version,
      decision: review.decision,
    });
    return [insightId, {
      ...review,
      resolution: "applied" as const,
      appliedVersion: review.version,
      appliedRevision: revision,
    }];
  })) as Record<string, SuccessorSourceInsightReview>;
  const humanInsights = Object.fromEntries(Object.entries(reviewWithStaleHumanQuotesReopened.humanInsights).map(([insightId, review]) => {
    if (review.resolution !== "pending" || review.decision !== "human_approved") return [insightId, review];
    records.push({
      revision,
      insightId,
      origin: "human_created",
      version: review.version,
      decision: "human_approved",
    });
    return [insightId, {
      ...review,
      resolution: "applied" as const,
      appliedVersion: review.version,
      appliedRevision: revision,
    }];
  })) as Record<string, SuccessorHumanInsightReview>;
  const nextState: SuccessorChapterReviewState = {
    ...reviewWithStaleHumanQuotesReopened,
    sourceInsightReviews,
    humanInsights,
    successorInsightRevisionHistory: [
      ...reviewWithStaleHumanQuotesReopened.successorInsightRevisionHistory,
      ...records,
    ].sort(successorRevisionOrder),
  };
  return validateSuccessorChapterReviewLedger(nextState, context.source, true)
    ? { state: nextState }
    : { state, blockedReason: "insights" };
}

/** A human Save is approval for exactly the authored version and receives its
 * own applied Chapter revision; no redundant Accept transition is created. */
export function saveSuccessorHumanInsight(
  state: SuccessorChapterReviewState,
  context: SuccessorChapterReviewContext,
  insightId: string,
  content: SuccessorHumanInsightContent,
): { state: SuccessorChapterReviewState; blockedReason?: "insights" } {
  const existing = state.humanInsights[insightId];
  const reuseDraft = existing?.decision === "draft" && existing.resolution === "pending"
    && JSON.stringify(existing.content) === JSON.stringify(content);
  const draft = reuseDraft
    ? state
    : editSuccessorHumanInsight(state, context.source, insightId, content);
  if (draft === state && !reuseDraft) return { state, blockedReason: "insights" as const };
  const pendingApproval: SuccessorChapterReviewState = {
    ...draft,
    humanInsights: {
      ...draft.humanInsights,
      [insightId]: { ...draft.humanInsights[insightId], decision: "human_approved" },
    },
  };
  if (!validateSuccessorChapterReviewLedger(pendingApproval, context.source, true)) {
    return { state, blockedReason: "insights" as const };
  }
  const revision = pendingApproval.revision + 1;
  const review = pendingApproval.humanInsights[insightId];
  const nextState: SuccessorChapterReviewState = {
    ...pendingApproval,
    stage: "reviewing",
    revision,
    annotations: pendingApproval.annotations.map((annotation) => annotation.resolution === "pending"
      ? { ...annotation, baseRevision: revision }
      : annotation),
    editTransactions: pendingApproval.editTransactions.map((transaction) => activeEditResolution(transaction.resolution)
      ? { ...transaction, baseRevision: revision }
      : transaction),
    humanInsights: {
      ...pendingApproval.humanInsights,
      [insightId]: {
        ...review,
        resolution: "applied",
        appliedVersion: review.version,
        appliedRevision: revision,
      },
    },
    revisionHistory: [...pendingApproval.revisionHistory, {
      revision,
      annotationIds: [],
      editTransactionIds: [],
      insightIds: [],
      privacyDecisions: pendingApproval.appliedPrivacyDecisions,
    }],
    successorInsightRevisionHistory: [
      ...pendingApproval.successorInsightRevisionHistory,
      {
        revision,
        insightId,
        origin: "human_created" as const,
        version: review.version,
        decision: "human_approved" as const,
      },
    ].sort(successorRevisionOrder),
  };
  if (!validateSuccessorChapterReviewLedger(nextState, context.source, true)) {
    return { state, blockedReason: "insights" as const };
  }
  return {
    state: {
      ...nextState,
      stage: validateSuccessorChapterReviewCompletion(nextState, context) ? "revision_ready" : "reviewing",
    },
  };
}

export function canMarkSuccessorChapterReady(
  state: SuccessorChapterReviewState,
  context: SuccessorChapterReviewContext,
) {
  return state.stage === "revision_ready" && validateSuccessorChapterReviewCompletion(state, context);
}

export function markSuccessorChapterReady(
  state: SuccessorChapterReviewState,
  context: SuccessorChapterReviewContext,
): SuccessorChapterReviewState {
  return canMarkSuccessorChapterReady(state, context) ? { ...state, stage: "human_confirmed" } : state;
}

export function canMarkChapterReady(state: ChapterReviewState, context: ApplyReviewContext) {
  return state.stage === "revision_ready" && validateChapterReviewCompletion(state, context);
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
    const group = applicable.filter((annotation) => annotation.appliedRevision === revision);
    const projected = applyAnnotationGroup(result, group);
    if (projected === null) return source;
    result = projected;
  }
  return result;
}

/** Replay every applied review revision for one block. This is the canonical
 * Chapter/Release projection; pending edits remain a local working draft. */
export function applyStoryReviewToBlock(
  source: string,
  blockId: string,
  language: StoryLanguage,
  state: ChapterReviewState,
) {
  let result = source;
  for (let revision = 2; revision <= state.revision; revision += 1) {
    const annotations = state.annotations.filter((annotation) => annotation.blockId === blockId
      && annotation.sourceLanguage === language
      && annotation.resolution === "applied"
      && annotation.appliedRevision === revision);
    const transactions = state.editTransactions.filter((transaction) => transaction.blockId === blockId
      && transaction.sourceLanguage === language
      && transaction.resolution === "applied"
      && transaction.appliedRevision === revision);
    if (annotations.length && transactions.length) return source;
    const projected = annotations.length
      ? applyAnnotationGroup(result, annotations)
      : transactions.length ? applyDirectEditGroup(result, transactions) : result;
    if (projected === null) return source;
    result = projected;
  }
  return result;
}

/** Current editable copy for one Story block: immutable source + applied
 * revisions + active current-revision direct patches. */
export function storyWorkingBlock(
  source: string,
  storyKey: string,
  blockId: string,
  language: StoryLanguage,
  state: ChapterReviewState,
) {
  const reviewed = applyStoryReviewToBlock(source, blockId, language, state);
  const pending = activeDirectEdits(state, storyKey, blockId, language);
  return applyDirectEditGroup(reviewed, pending) ?? reviewed;
}

export function storyEditSegments(
  source: string,
  storyKey: string,
  blockId: string,
  language: StoryLanguage,
  state: ChapterReviewState,
): StoryEditSegment[] {
  const reviewed = applyStoryReviewToBlock(source, blockId, language, state);
  const pending = activeDirectEdits(state, storyKey, blockId, language);
  const projection = projectDirectEditGroup(reviewed, pending);
  if (!projection || !pending.length) return [{ text: reviewed, transactionIds: [] }];
  const segments: StoryEditSegment[] = [];
  let cursor = 0;
  for (const item of projection.projections) {
    if (item.workStart > cursor) segments.push({ text: projection.text.slice(cursor, item.workStart), transactionIds: [] });
    if (item.workEnd > item.workStart) segments.push({
      text: projection.text.slice(item.workStart, item.workEnd),
      transactionIds: [item.transaction.id],
    });
    cursor = item.workEnd;
  }
  if (cursor < projection.text.length) segments.push({ text: projection.text.slice(cursor), transactionIds: [] });
  return segments.length ? segments : [{ text: projection.text, transactionIds: [] }];
}

/** Reverse an applied edit without mutating its historical revision. Reversal
 * is available only while that transaction is the latest applied change to its
 * block; otherwise the UI must ask the reviewer to make an explicit new edit. */
export function revertAppliedStoryEdit(
  state: ChapterReviewState,
  transactionId: string,
  originalSource: string,
  now = Date.now(),
): RecordStoryEditResult {
  if (state.stage === "human_confirmed") return { state, blockedReason: "confirmed" };
  const target = state.editTransactions.find((transaction) => transaction.id === transactionId);
  if (!target || target.resolution !== "applied" || !target.appliedRevision) return { state, blockedReason: "invalid" };
  const laterApplied = state.editTransactions.some((transaction) => transaction.id !== target.id
    && transaction.blockId === target.blockId
    && transaction.sourceLanguage === target.sourceLanguage
    && transaction.resolution === "applied"
    && (transaction.appliedRevision || 0) > target.appliedRevision!);
  const laterAnnotation = state.annotations.some((annotation) => annotation.blockId === target.blockId
    && annotation.sourceLanguage === target.sourceLanguage
    && annotation.resolution === "applied"
    && (annotation.appliedRevision || 0) > target.appliedRevision!);
  if (laterApplied || laterAnnotation) return { state, blockedReason: "overlap" };

  const baseText = applyStoryReviewToBlock(originalSource, target.blockId, target.sourceLanguage, state);
  const pending = activeDirectEdits(state, target.storyKey, target.blockId, target.sourceLanguage);
  if (baseText.slice(target.afterRange.start, target.afterRange.end) !== target.afterText) {
    return { state, blockedReason: "overlap" };
  }
  const inverse: StoryEditTransaction = {
    id: `${target.blockId}:revert:${now}:${Math.random().toString(36).slice(2, 7)}`,
    storyKey: target.storyKey,
    blockId: target.blockId,
    sourceLanguage: target.sourceLanguage,
    baseRevision: state.revision,
    operation: editOperation(target.afterText, target.beforeText),
    beforeText: target.afterText,
    afterText: target.beforeText,
    beforeRange: { ...target.afterRange },
    afterRange: { start: target.afterRange.start, end: target.afterRange.start + target.beforeText.length },
    resolution: "pending",
    requiresEvidence: false,
    revertsTransactionId: target.id,
    createdAt: now,
    updatedAt: now,
  };
  if (pending.some((transaction) => editRangesConflict(transaction, inverse))) {
    return { state, blockedReason: "overlap" };
  }
  const nextState = normalizeCurrentEditRanges({
    ...state,
    stage: "reviewing",
    editTransactions: [...state.editTransactions, inverse],
    redoTransactionIds: state.redoTransactionIds.filter((id) => state.editTransactions.find((item) => item.id === id)?.sourceLanguage !== target.sourceLanguage),
  }, baseText, target.storyKey, target.blockId, target.sourceLanguage);
  if (!nextState) return { state, blockedReason: "overlap" };
  return {
    state: nextState,
    transactionId: inverse.id,
  };
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
  const ids = candidates.map((candidate) => candidate.id);
  const uniqueIds = ids.every(validStableId) && new Set(ids).size === candidates.length;
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
