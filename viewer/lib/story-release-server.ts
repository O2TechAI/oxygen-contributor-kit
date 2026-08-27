import type { getLocalDatabase } from "../db";
import { computeSourceDigest, redactionReleaseError } from "./redaction-pass.mjs";
import { activeRedactionFragments, redactKnownFragments } from "./release.mjs";
import {
  buildReviewedStoryRelease,
  sanitizeReviewedStoryRelease,
  serializeReviewedStoryRelease,
} from "./story-release.ts";
import { applyStoryReviewToBlock } from "./story-review.ts";
import {
  STORY_REVIEW_SESSION_SCHEMA,
  hydrateStoryReviewSession,
} from "./story-review-session.ts";
import { parseStoredStoryReviewSession } from "./story-review-session-server.ts";
import {
  selectReservedStorySourceItems,
  validateStorySourcePackage,
  type StoryCandidateRow,
  type StoryEvidenceRow,
} from "./story-readiness.ts";
import { parseStorySource, type StorySource } from "./timeline.ts";
import { isWorkflowRunId } from "./workflow-progress.ts";
import {
  captureStoryReleasePrivacySnapshot,
  type ReleaseSnapshotTestOptions,
} from "./release-privacy-snapshot.ts";
import type { StoryReleaseTarget } from "./timeline.ts";
import {
  deriveStoryReleaseTargetCatalog,
  storyPreparationDigest,
} from "./story-preparation.ts";

type ReleaseDatabase = Awaited<ReturnType<typeof getLocalDatabase>>;

type ReleaseRunRow = {
  id?: string;
  story_generation_status?: string;
  story_source_revision?: number;
  active_story_digest?: string;
};

type ReleaseItemRow = {
  id: string;
  document_id: string;
  sequence?: number;
  event_type?: string | null;
  actor_id?: string | null;
  actor_type?: string | null;
  timestamp?: string | null;
  content?: string;
  organization_reason?: string;
};

type ReleaseRedactionRow = {
  item_id?: string;
  start_offset?: number;
  end_offset?: number;
  category?: string;
  status?: string;
};

type ReleaseSessionRow = {
  state_json?: string;
  updated_at?: string;
  server_version?: number;
};

type ReleaseSessionRecord = {
  session: ReturnType<typeof parseStoredStoryReviewSession>["session"];
  serverVersion: number;
  sourceRevision: number | null;
  persistedAt: string | null;
};

export type ServerOwnedReleaseRequest = {
  workflowRunId: string;
  serverVersion: number;
  sourceRevision: number;
};

export const RELEASE_ERROR = {
  requestInvalid: "RELEASE_REQUEST_INVALID",
  runConflict: "RELEASE_RUN_CONFLICT",
  storyNotReady: "RELEASE_STORY_NOT_READY",
  versionConflict: "RELEASE_VERSION_CONFLICT",
  sourceConflict: "RELEASE_SOURCE_CONFLICT",
  sessionMissing: "RELEASE_SESSION_MISSING",
  reviewIncomplete: "RELEASE_REVIEW_INCOMPLETE",
  stateInvalid: "RELEASE_STATE_INVALID",
  privacyConflict: "RELEASE_PRIVACY_CONFLICT",
  preparationInvalid: "RELEASE_PREPARATION_INVALID",
  storyPrivacyPending: "RELEASE_STORY_PRIVACY_PENDING",
  preferencePending: "RELEASE_PREFERENCE_PENDING",
  allSetRequired: "RELEASE_ALL_SET_REQUIRED",
  editedStoryPrivacyRequired: "RELEASE_EDITED_STORY_PRIVACY_REQUIRED",
} as const;

export type ReleaseErrorCode = typeof RELEASE_ERROR[keyof typeof RELEASE_ERROR];

type ReleaseFailure = {
  ok: false;
  code: ReleaseErrorCode;
  serverVersion?: number;
  sourceRevision?: number;
};

type ReleaseSuccess = {
  ok: true;
  story: NonNullable<ReturnType<typeof sanitizeReviewedStoryRelease>>;
  serializedStory: string;
  binding: {
    workflowRunId: string;
    activeStoryDigest: string;
    sourceRevision: number;
    serverVersion: number;
  };
};

export type ServerOwnedReleaseResult = ReleaseSuccess | ReleaseFailure;

type ReleaseReconstructionOptions = ReleaseSnapshotTestOptions & {
  allowUnsetAllSet?: boolean;
};

const REQUEST_KEYS = new Set(["workflowRunId", "serverVersion", "sourceRevision"]);
const validRevision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseServerOwnedReleaseRequest(value: unknown): ServerOwnedReleaseRequest | null {
  if (!isRecord(value)
    || Object.keys(value).length !== REQUEST_KEYS.size
    || Object.keys(value).some((key) => !REQUEST_KEYS.has(key))
    || !isWorkflowRunId(value.workflowRunId)
    || !validRevision(value.serverVersion)
    || !validRevision(value.sourceRevision)) return null;
  return {
    workflowRunId: value.workflowRunId,
    serverVersion: value.serverVersion,
    sourceRevision: value.sourceRevision,
  };
}

function failure(
  code: ReleaseErrorCode,
  metadata: { serverVersion?: number; sourceRevision?: number } = {},
): ReleaseFailure {
  return { ok: false, code, ...metadata };
}

const sameKeys = (left: string[], right: string[]) => left.length === right.length
  && new Set(left).size === left.length
  && new Set(right).size === right.length
  && left.every((key) => right.includes(key));

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const digestPattern = /^[0-9a-f]{64}$/;
const preparationLanes = ["insight", "preference", "story", "story_privacy"];

function exactTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function safeText(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim())
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function compareUtf8(left: string, right: string) {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

async function releasePrivacyCandidates(
  snapshot: Awaited<ReturnType<typeof captureStoryReleasePrivacySnapshot>>,
  workflowRunId: string,
  sourceRevision: number,
  sources: StorySource[],
  storyRows: StoryCandidateRow[],
): Promise<ReleasePrivacyCandidate[] | null> {
  const receipt = snapshot.preparationReceiptRows.find((row) => row.lane === "story_privacy");
  const catalog = deriveStoryReleaseTargetCatalog(sources);
  if (!receipt || !catalog) return null;
  const targetOrder = new Map(catalog.map((target, index) => [target.id, index]));
  const candidates: ReleasePrivacyCandidate[] = [];
  const candidateProducts: Array<Record<string, unknown>> = [];
  for (const row of snapshot.storyPrivacyCandidateRows) {
    if (row.workflow_run_id !== workflowRunId || typeof row.candidate_json !== "string") return null;
    let value: unknown;
    try { value = JSON.parse(row.candidate_json); } catch { return null; }
    if (!isRecord(value)
      || Object.keys(value).sort().join("|")
        !== ["id", "releaseTargets", "reviewState", "title", "uncertaintyReason", "whyFlagged"].sort().join("|")
      || !safeText(value.id) || row.candidate_id !== value.id
      || (value.reviewState !== "deterministic" && value.reviewState !== "needs_confirmation")
      || !safeText(value.title) || !safeText(value.whyFlagged)
      || (value.reviewState === "deterministic" && value.uncertaintyReason !== null)
      || (value.reviewState === "needs_confirmation" && !safeText(value.uncertaintyReason))
      || !Array.isArray(value.releaseTargets) || value.releaseTargets.length === 0
      || value.releaseTargets.some((target) => typeof target !== "string" || !targetOrder.has(target as StoryReleaseTarget))
      || new Set(value.releaseTargets).size !== value.releaseTargets.length) return null;
    const orders = value.releaseTargets.map((target) => targetOrder.get(target as StoryReleaseTarget)!);
    if (orders.some((order, index) => index > 0 && orders[index - 1] >= order)) return null;
    const decision = row.decision;
    const decisionVersion = Number(row.decision_version);
    if (value.reviewState === "deterministic") {
      if (decision !== null || decisionVersion !== 0 || row.decided_at !== null) return null;
    } else if (decision === null) {
      if (decisionVersion !== 0 || row.decided_at !== null) return null;
    } else if ((decision !== "keep" && decision !== "redact")
      || decisionVersion !== 1 || !exactTimestamp(row.decided_at)) return null;
    const product = {
      id: value.id,
      reviewState: value.reviewState,
      title: value.title,
      whyFlagged: value.whyFlagged,
      uncertaintyReason: value.uncertaintyReason,
      releaseTargets: [...value.releaseTargets] as StoryReleaseTarget[],
    };
    candidateProducts.push(product);
    candidates.push({
      id: value.id,
      reviewState: value.reviewState,
      releaseTargets: product.releaseTargets,
      decision: decision as "keep" | "redact" | null,
    });
  }
  if (candidates.some((candidate, index) => index > 0
    && compareUtf8(candidates[index - 1].id, candidate.id) >= 0)
    || Number(receipt.source_revision) !== sourceRevision
    || Number(receipt.scope_count) !== catalog.length
    || receipt.scope_digest !== await storyPreparationDigest(catalog.map((target) => target.id))
    || receipt.input_digest !== await storyPreparationDigest(storyRows.map((row, index) => ({
      id: row.id,
      story: sources[index],
    })).sort((left, right) => compareUtf8(left.id, right.id)))
    || Number(receipt.output_count) !== candidates.length
    || receipt.output_digest !== await storyPreparationDigest(candidateProducts)) return null;
  return candidates;
}

type ReleasePrivacyCandidate = {
  id: string;
  reviewState: "deterministic" | "needs_confirmation";
  releaseTargets: StoryReleaseTarget[];
  decision: "keep" | "redact" | null;
};

function validPreparationAndPreference(
  snapshot: Awaited<ReturnType<typeof captureStoryReleasePrivacySnapshot>>,
  workflowRunId: string,
  sourceRevision: number,
  privacyCandidates: ReleasePrivacyCandidate[],
) {
  const receipts = snapshot.preparationReceiptRows;
  if (receipts.length !== 4
    || receipts.map((row) => String(row.lane)).sort().join("|") !== preparationLanes.join("|")) {
    return false;
  }
  for (const receipt of receipts) {
    if (receipt.workflow_run_id !== workflowRunId
      || !preparationLanes.includes(String(receipt.lane))
      || Number(receipt.source_revision) !== sourceRevision
      || !digestPattern.test(String(receipt.input_digest || ""))
      || !digestPattern.test(String(receipt.scope_digest || ""))
      || !digestPattern.test(String(receipt.output_digest || ""))
      || !validRevision(Number(receipt.scope_count))
      || !validRevision(Number(receipt.output_count))
      || !exactTimestamp(receipt.completed_at)) return false;
  }
  const privacyReceipt = receipts.find((row) => row.lane === "story_privacy")!;
  if (Number(privacyReceipt.output_count) !== privacyCandidates.length) return false;

  const preferenceReceipt = receipts.find((row) => row.lane === "preference")!;
  const probeRun = snapshot.probeRun;
  if (!probeRun || probeRun.workflow_run_id !== workflowRunId || probeRun.id !== workflowRunId
    || Number(probeRun.source_revision) !== sourceRevision
    || probeRun.status !== "complete" || probeRun.stage !== "preference" || probeRun.model !== null
    || probeRun.input_digest !== preferenceReceipt.input_digest
    || probeRun.output_digest !== preferenceReceipt.output_digest
    || Number(probeRun.output_count) !== Number(preferenceReceipt.output_count)
    || !validRevision(Number(probeRun.output_count))
    || Number(probeRun.output_count) !== snapshot.probeRows.length + snapshot.bulkRows.length
    || snapshot.probeRows.some((row) => row.answer_choice === null || row.answer_choice === undefined
      || !exactTimestamp(row.answered_at))
    || snapshot.bulkRows.some((row) => row.answer === null || row.answer === undefined
      || !exactTimestamp(row.answered_at))) return false;
  return true;
}

function reviewChangesReleaseCopy(
  sources: StorySource[],
  reviews: Record<string, NonNullable<ReleaseSessionRecord["session"]>["chapterReviews"][string]>,
) {
  return sources.some((source) => {
    const review = reviews[source.key];
    if (!review) return true;
    if (source.story.blocks.some((block) => (
      applyStoryReviewToBlock(block.text, block.id, "en", review) !== block.text
    ))) return true;
    if (Object.keys(review.humanInsights).length) return true;
    return Object.values(review.sourceInsightReviews).some((insight) => Boolean(insight.editedContent));
  });
}

function exactAllSetBinding(
  snapshot: Awaited<ReturnType<typeof captureStoryReleasePrivacySnapshot>>,
  request: ServerOwnedReleaseRequest,
  activeStoryDigest: string,
) {
  const row = snapshot.allSet;
  return snapshot.allSetRows.length === 1 && row?.workflow_run_id === request.workflowRunId
    && row.active_story_digest === activeStoryDigest
    && Number(row.source_revision) === request.sourceRevision
    && Number(row.server_version) === request.serverVersion
    && exactTimestamp(row.all_set_at);
}

function readReleaseSessionRecord(row: ReleaseSessionRow | null): ReleaseSessionRecord {
  if (!row) return { session: null, serverVersion: 0, sourceRevision: null, persistedAt: null };
  let session: ReleaseSessionRecord["session"] = null;
  let sourceRevision: number | null = null;
  try {
    const stored = JSON.parse(String(row.state_json || ""));
    const parsed = parseStoredStoryReviewSession(stored);
    sourceRevision = parsed.sourceRevision;
    session = parsed.session;
  } catch {
    // Malformed state remains fail-closed while bounded CAS metadata is retained.
  }
  return {
    session,
    serverVersion: validRevision(row.server_version) ? row.server_version : 0,
    sourceRevision,
    persistedAt: typeof row.updated_at === "string" && row.updated_at ? row.updated_at : null,
  };
}

/** Reconstruct the only POST-eligible reviewed Story from the exact activated
 * candidate, current Privacy source, and source-bound durable review session. */
export async function reconstructReviewedStoryReleaseFromDatabase(
  db: ReleaseDatabase,
  input: unknown,
  options: ReleaseReconstructionOptions = {},
): Promise<ServerOwnedReleaseResult> {
  const request = parseServerOwnedReleaseRequest(input);
  if (!request) return failure(RELEASE_ERROR.requestInvalid);

  const initialSnapshot = await captureStoryReleasePrivacySnapshot(db, request.workflowRunId);
  if (initialSnapshot.authorityRows.length !== 1
    || initialSnapshot.authorityRows[0]?.id !== request.workflowRunId) {
    return failure(RELEASE_ERROR.runConflict);
  }

  const run = initialSnapshot.run as ReleaseRunRow | null;
  const record = readReleaseSessionRecord(initialSnapshot.session as ReleaseSessionRow | null);
  const redactionJob = initialSnapshot.redactionJob;

  const activeSourceRevision = validRevision(run?.story_source_revision)
    ? run.story_source_revision
    : null;
  const boundedMetadata = {
    serverVersion: record.serverVersion,
    ...(activeSourceRevision === null ? {} : { sourceRevision: activeSourceRevision }),
  };
  if (!run || run.story_generation_status !== "ready_for_human_review"
    || activeSourceRevision === null) {
    return failure(RELEASE_ERROR.storyNotReady, boundedMetadata);
  }
  if (request.sourceRevision !== activeSourceRevision) {
    return failure(RELEASE_ERROR.sourceConflict, boundedMetadata);
  }
  if (!record.persistedAt) return failure(RELEASE_ERROR.sessionMissing, boundedMetadata);
  if (!record.session || record.session.schema !== STORY_REVIEW_SESSION_SCHEMA) {
    return failure(RELEASE_ERROR.stateInvalid, boundedMetadata);
  }
  if (request.serverVersion !== record.serverVersion) {
    return failure(RELEASE_ERROR.versionConflict, boundedMetadata);
  }
  if (record.sourceRevision !== activeSourceRevision) {
    return failure(RELEASE_ERROR.sourceConflict, boundedMetadata);
  }

  const items = initialSnapshot.itemRows as ReleaseItemRow[];
  const currentSourceDigest = await computeSourceDigest(items);
  if (redactionReleaseError(
    redactionJob,
    currentSourceDigest,
    initialSnapshot.redactionReviewRows,
  )) {
    return failure(RELEASE_ERROR.storyNotReady, boundedMetadata);
  }

  const candidateItems = selectReservedStorySourceItems(items);
  const candidateRows: StoryCandidateRow[] = candidateItems.map((item) => ({
    id: item.id,
    documentId: item.document_id,
    sequence: item.sequence,
    timestamp: item.timestamp,
    summary: String(item.organization_reason || ""),
  }));
  const evidenceRows: StoryEvidenceRow[] = items.map((item) => ({
    id: item.id,
    documentId: item.document_id,
    eventType: item.event_type,
    actorId: item.actor_id,
    actorType: item.actor_type,
  }));
  const validation = validateStorySourcePackage(candidateRows, evidenceRows);
  if (!validation.ok || !run.active_story_digest
    || await sha256(validation.canonicalCandidate) !== run.active_story_digest) {
    return failure(RELEASE_ERROR.stateInvalid, boundedMetadata);
  }

  const sources = candidateRows.map((row) => parseStorySource(row.summary));
  if (sources.some((source) => !source)) return failure(RELEASE_ERROR.stateInvalid, boundedMetadata);
  const exactSources = sources.flatMap((source) => source ? [source] : []);
  const expectedKeys = exactSources.map((source) => source.key);
  if (expectedKeys.length !== validation.chapterCount
    || !sameKeys(expectedKeys, Object.keys(record.session.chapterReviews))) {
    return failure(RELEASE_ERROR.reviewIncomplete, boundedMetadata);
  }

  const hydrated = hydrateStoryReviewSession(
    record.session,
    request.workflowRunId,
    exactSources,
  );
  if (!sameKeys(expectedKeys, Object.keys(hydrated.chapterReviews))
    || expectedKeys.some((key) => hydrated.chapterReviews[key]?.stage !== "human_confirmed")) {
    return failure(RELEASE_ERROR.reviewIncomplete, boundedMetadata);
  }
  if (reviewChangesReleaseCopy(exactSources, hydrated.chapterReviews)) {
    return failure(RELEASE_ERROR.editedStoryPrivacyRequired, boundedMetadata);
  }

  const privacyCandidates = await releasePrivacyCandidates(
    initialSnapshot,
    request.workflowRunId,
    activeSourceRevision,
    exactSources,
    candidateRows,
  );
  if (!privacyCandidates) return failure(RELEASE_ERROR.preparationInvalid, boundedMetadata);
  if (privacyCandidates.some((candidate) => (
    candidate.reviewState === "needs_confirmation" && candidate.decision === null
  ))) return failure(RELEASE_ERROR.storyPrivacyPending, boundedMetadata);
  if (!validPreparationAndPreference(
    initialSnapshot,
    request.workflowRunId,
    activeSourceRevision,
    privacyCandidates,
  )) return failure(RELEASE_ERROR.preferencePending, boundedMetadata);
  if (!options.allowUnsetAllSet
    && !exactAllSetBinding(initialSnapshot, request, String(run.active_story_digest))) {
    return failure(RELEASE_ERROR.allSetRequired, boundedMetadata);
  }
  const suppressedTargets = new Set<StoryReleaseTarget>();
  for (const candidate of privacyCandidates) {
    if (candidate.reviewState === "deterministic" || candidate.decision === "redact") {
      for (const target of candidate.releaseTargets) suppressedTargets.add(target);
    }
  }

  const redactionsByItem = new Map<string, ReleaseRedactionRow[]>();
  for (const span of initialSnapshot.redactionRows as ReleaseRedactionRow[]) {
    const itemId = String(span.item_id || "");
    redactionsByItem.set(itemId, [...(redactionsByItem.get(itemId) || []), span]);
  }
  let fragments: Array<{ text: string; category: string }> = [];
  try {
    fragments = items.flatMap((item) => activeRedactionFragments(
      String(item.content || ""),
      redactionsByItem.get(item.id) || [],
    ));
  } catch {
    return failure(RELEASE_ERROR.stateInvalid, boundedMetadata);
  }
  const built = buildReviewedStoryRelease(exactSources, hydrated.chapterReviews, {
    redact: (copy) => redactKnownFragments(copy, fragments),
    suppressedTargets,
  });
  const story = sanitizeReviewedStoryRelease(built);
  const serializedStory = serializeReviewedStoryRelease(story);
  if (!story || !serializedStory || story.chapters.length !== expectedKeys.length) {
    return failure(RELEASE_ERROR.reviewIncomplete, boundedMetadata);
  }
  await options.beforeFinalPrivacyCheck?.();
  const finalSnapshot = await captureStoryReleasePrivacySnapshot(db, request.workflowRunId);
  if (finalSnapshot.digest !== initialSnapshot.digest) {
    return failure(RELEASE_ERROR.privacyConflict, boundedMetadata);
  }
  return {
    ok: true,
    story,
    serializedStory,
    binding: {
      workflowRunId: request.workflowRunId,
      activeStoryDigest: String(run.active_story_digest),
      sourceRevision: request.sourceRevision,
      serverVersion: request.serverVersion,
    },
  };
}

export async function reconstructReviewedStoryRelease(input: unknown) {
  const { getLocalDatabase: getRuntimeDatabase } = await import("../db/index.ts");
  return reconstructReviewedStoryReleaseFromDatabase(await getRuntimeDatabase(), input);
}

const messages: Record<ReleaseErrorCode, string> = {
  [RELEASE_ERROR.requestInvalid]: "Invalid reviewed Story release request",
  [RELEASE_ERROR.runConflict]: "Reviewed Story workflow run is not current",
  [RELEASE_ERROR.storyNotReady]: "Reviewed Story release is not ready",
  [RELEASE_ERROR.versionConflict]: "Reviewed Story session version changed",
  [RELEASE_ERROR.sourceConflict]: "Reviewed Story source changed",
  [RELEASE_ERROR.sessionMissing]: "Reviewed Story session is missing",
  [RELEASE_ERROR.reviewIncomplete]: "Reviewed Story review is incomplete",
  [RELEASE_ERROR.stateInvalid]: "Reviewed Story release state is invalid",
  [RELEASE_ERROR.privacyConflict]: "Release Privacy state changed during assembly",
  [RELEASE_ERROR.preparationInvalid]: "Story preparation authority is invalid",
  [RELEASE_ERROR.storyPrivacyPending]: "Story Privacy decisions are incomplete",
  [RELEASE_ERROR.preferencePending]: "Preference answers are incomplete",
  [RELEASE_ERROR.allSetRequired]: "Project All set confirmation is required",
  [RELEASE_ERROR.editedStoryPrivacyRequired]: "Edited Story Privacy preparation is required",
};

export function releaseErrorResponse(result: ReleaseFailure) {
  const status = result.code === RELEASE_ERROR.requestInvalid ? 400 : 409;
  return Response.json({
    error: messages[result.code],
    code: result.code,
    ...(result.serverVersion === undefined ? {} : { serverVersion: result.serverVersion }),
    ...(result.sourceRevision === undefined ? {} : { sourceRevision: result.sourceRevision }),
  }, { status });
}
