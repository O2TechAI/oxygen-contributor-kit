import type {
  EvidenceReference,
  StoryHighlightItem,
  StoryLanguage,
  StoryPrivacyCandidate,
  StoryReleaseTargetCatalog,
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

export type ApplyReviewContext = ChapterReviewCompletionContext & {
  chapterEvidence: EvidenceReference[];
  evidenceResolved: boolean;
  supportedAddIds: string[];
  supportedEditIds?: string[];
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

/** Validate all state required for All set or release projection. Browser-owned
 * stage flags and cached redacted blocks are never sufficient by themselves. */
export function validateChapterReviewCompletion(
  state: ChapterReviewState,
  context: ChapterReviewCompletionContext,
) {
  if (!validStableId(context.storyKey)
    || !privacyComplete(context)
    || !validateChapterReviewLedger(state, context.storyKey, context.sourceBlocks, context.reviewedBlocks)
    || !validateInsightReviewLedger(state, context.reviewableInsightIds)
    || !state.evidenceVerified
    || !Array.isArray(state.staleTranslations)
    || state.annotations.some((annotation) => annotation.resolution === "pending" || annotation.resolution === "needs_evidence")
    || state.editTransactions.some((transaction) => activeEditResolution(transaction.resolution))
    || Object.values(state.insightReviews).some((review) => review.resolution === "pending")
    || !sameDecisions(state.appliedPrivacyDecisions, currentPrivacyDecisions(context))) return false;
  const latest = state.revisionHistory[state.revisionHistory.length - 1];
  return Boolean(latest)
    && latest.revision === state.revision
    && sameDecisions(latest.privacyDecisions, state.appliedPrivacyDecisions)
    && sameUniqueStrings(state.redactedBlocks, expectedRedactedBlocks(context));
}

export function applyChapterReview(
  state: ChapterReviewState,
  context: ApplyReviewContext,
): { state: ChapterReviewState; blockedReason?: "privacy" | "evidence" | "annotations" | "direct_evidence" } {
  if (!validStableId(context.storyKey)
    || state.editTransactions.some((transaction) => transaction.storyKey !== context.storyKey)) {
    return { state, blockedReason: "annotations" };
  }
  if (!privacyComplete(context)) return { state, blockedReason: "privacy" };
  if (!context.evidenceResolved) return { state, blockedReason: "evidence" };
  if (!validateChapterReviewLedger(state, context.storyKey, context.sourceBlocks, context.reviewedBlocks)
    || !validateInsightReviewLedger(state, context.reviewableInsightIds)) {
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
