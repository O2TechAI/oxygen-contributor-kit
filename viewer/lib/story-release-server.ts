import type { getD1 } from "../db";
import { computeSourceDigest, redactionReleaseError } from "./redaction-pass.mjs";
import { activeRedactionFragments, redactKnownFragments } from "./release.mjs";
import {
  buildReviewedStoryRelease,
  buildSuccessorReviewedStoryRelease,
  sanitizeReviewedStoryRelease,
  sanitizeSuccessorReviewedStoryRelease,
  serializeReviewedStoryRelease,
  serializeSuccessorReviewedStoryRelease,
} from "./story-release.ts";
import {
  STORY_REVIEW_SESSION_SCHEMA,
  SUCCESSOR_STORY_REVIEW_SESSION_SCHEMA,
  hydrateStoryReviewSession,
  hydrateSuccessorStoryReviewSession,
  parseStoryReviewSession,
  type AnyStoryReviewSession,
} from "./story-review-session.ts";
import {
  selectReviewableStoryTimeline,
  validateStoryCandidatePackage,
  validateSuccessorStorySourcePackage,
  type StoryCandidateRow,
  type StoryEvidenceRow,
} from "./story-readiness.ts";
import {
  LEGACY_STORY_PREFIX,
  SUCCESSOR_STORY_PREFIX,
  STORY_PREFIX,
  parseSuccessorStorySource,
} from "./timeline.ts";
import { isWorkflowRunId } from "./workflow-progress.ts";
import {
  WORKFLOW_RUN_AUTHORITY,
  requireExactWorkflowRun,
} from "./workflow-run-server.ts";

type ReleaseDatabase = Awaited<ReturnType<typeof getD1>>;

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
  session: AnyStoryReviewSession | null;
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
  story: NonNullable<ReturnType<typeof sanitizeReviewedStoryRelease>>
    | NonNullable<ReturnType<typeof sanitizeSuccessorReviewedStoryRelease>>;
  serializedStory: string;
};

export type ServerOwnedReleaseResult = ReleaseSuccess | ReleaseFailure;

const REQUEST_KEYS = new Set(["workflowRunId", "serverVersion", "sourceRevision"]);
const validRevision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseRequest(value: unknown): ServerOwnedReleaseRequest | null {
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

async function readReleaseSessionRecord(
  db: ReleaseDatabase,
  workflowRunId: string,
): Promise<ReleaseSessionRecord> {
  const row = await db.prepare(`SELECT state_json,updated_at,server_version
    FROM story_review_sessions WHERE workflow_run_id=?`)
    .bind(workflowRunId).first<ReleaseSessionRow>();
  if (!row) return { session: null, serverVersion: 0, sourceRevision: null, persistedAt: null };
  let session: AnyStoryReviewSession | null = null;
  let sourceRevision: number | null = null;
  try {
    const stored = JSON.parse(String(row.state_json || ""));
    if (isRecord(stored) && validRevision(stored.sourceRevision) && "session" in stored) {
      sourceRevision = stored.sourceRevision;
      session = parseStoryReviewSession(stored.session);
    } else {
      session = parseStoryReviewSession(stored);
    }
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
): Promise<ServerOwnedReleaseResult> {
  const request = parseRequest(input);
  if (!request) return failure(RELEASE_ERROR.requestInvalid);

  const authority = await requireExactWorkflowRun(db, request.workflowRunId);
  if (authority.state !== WORKFLOW_RUN_AUTHORITY.exactRun) {
    return failure(RELEASE_ERROR.runConflict);
  }

  const [run, record, redactionJob, itemResult] = await Promise.all([
    db.prepare(`SELECT id,story_generation_status,story_source_revision,active_story_digest
      FROM workflow_runs WHERE id=?`).bind(request.workflowRunId).first<ReleaseRunRow>(),
    readReleaseSessionRecord(db, request.workflowRunId),
    db.prepare("SELECT * FROM redaction_jobs ORDER BY started_at DESC LIMIT 1")
      .first<Record<string, unknown>>(),
    db.prepare(`SELECT id,document_id,sequence,event_type,actor_id,actor_type,timestamp,
      content,organization_reason FROM items ORDER BY document_id,sequence`).all<ReleaseItemRow>(),
  ]);

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
  if (!record.session) return failure(RELEASE_ERROR.stateInvalid, boundedMetadata);
  if (request.serverVersion !== record.serverVersion) {
    return failure(RELEASE_ERROR.versionConflict, boundedMetadata);
  }
  if (record.sourceRevision !== activeSourceRevision) {
    return failure(RELEASE_ERROR.sourceConflict, boundedMetadata);
  }

  const items = itemResult.results || [];
  const currentSourceDigest = await computeSourceDigest(items);
  if (redactionReleaseError(redactionJob, currentSourceDigest)) {
    return failure(RELEASE_ERROR.storyNotReady, boundedMetadata);
  }

  const candidateItems = items.filter((item) => String(item.organization_reason || "").startsWith(STORY_PREFIX)
    || String(item.organization_reason || "").startsWith(LEGACY_STORY_PREFIX)
    || String(item.organization_reason || "").startsWith(SUCCESSOR_STORY_PREFIX))
    .sort((left, right) => String(left.timestamp || "").localeCompare(String(right.timestamp || ""))
      || left.document_id.localeCompare(right.document_id)
      || Number(left.sequence || 0) - Number(right.sequence || 0));
  const candidateRows: StoryCandidateRow[] = candidateItems.map((item) => ({
    id: item.id,
    documentId: item.document_id,
    summary: String(item.organization_reason || ""),
  }));
  const evidenceRows: StoryEvidenceRow[] = items.map((item) => ({
    id: item.id,
    documentId: item.document_id,
    eventType: item.event_type,
    actorId: item.actor_id,
    actorType: item.actor_type,
  }));
  const successorSource = candidateRows.length > 0
    && candidateRows.every((row) => row.summary.startsWith(SUCCESSOR_STORY_PREFIX));
  const legacySource = candidateRows.length > 0
    && candidateRows.every((row) => row.summary.startsWith(STORY_PREFIX)
      || row.summary.startsWith(LEGACY_STORY_PREFIX));
  if (successorSource === legacySource) {
    return failure(RELEASE_ERROR.stateInvalid, boundedMetadata);
  }

  if (successorSource) {
    if (record.session.schema !== SUCCESSOR_STORY_REVIEW_SESSION_SCHEMA) {
      return failure(RELEASE_ERROR.stateInvalid, boundedMetadata);
    }
    const validation = validateSuccessorStorySourcePackage(candidateRows, evidenceRows);
    if (!validation.ok || !run.active_story_digest
      || await sha256(validation.canonicalCandidate) !== run.active_story_digest) {
      return failure(RELEASE_ERROR.stateInvalid, boundedMetadata);
    }
    const sources = candidateRows.map((row) => parseSuccessorStorySource(row.summary));
    if (sources.some((source) => !source)) return failure(RELEASE_ERROR.stateInvalid, boundedMetadata);
    const exactSources = sources.flatMap((source) => source ? [source] : []);
    const expectedKeys = exactSources.map((source) => source.key);
    if (expectedKeys.length !== validation.chapterCount
      || !sameKeys(expectedKeys, Object.keys(record.session.chapterReviews))) {
      return failure(RELEASE_ERROR.reviewIncomplete, boundedMetadata);
    }
    const hydrated = hydrateSuccessorStoryReviewSession(
      record.session,
      request.workflowRunId,
      exactSources,
    );
    if (!sameKeys(expectedKeys, Object.keys(hydrated.chapterReviews))
      || expectedKeys.some((key) => hydrated.chapterReviews[key]?.stage !== "human_confirmed")) {
      return failure(RELEASE_ERROR.reviewIncomplete, boundedMetadata);
    }

    const redactionResult = await db.prepare(`SELECT item_id,start_offset,end_offset,category,status
      FROM redactions WHERE status='active' ORDER BY item_id,start_offset`).all<ReleaseRedactionRow>();
    const redactionsByItem = new Map<string, ReleaseRedactionRow[]>();
    for (const span of redactionResult.results || []) {
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
    const built = buildSuccessorReviewedStoryRelease(exactSources, hydrated.chapterReviews, {
      redact: (copy) => redactKnownFragments(copy, fragments),
    });
    const story = sanitizeSuccessorReviewedStoryRelease(built);
    const serializedStory = serializeSuccessorReviewedStoryRelease(story);
    if (!story || !serializedStory
      || !sameKeys(expectedKeys, story.chapters.map((chapter) => chapter.key))) {
      return failure(RELEASE_ERROR.reviewIncomplete, boundedMetadata);
    }
    return { ok: true, story, serializedStory };
  }

  if (record.session.schema !== STORY_REVIEW_SESSION_SCHEMA) {
    return failure(RELEASE_ERROR.stateInvalid, boundedMetadata);
  }
  const validation = validateStoryCandidatePackage(candidateRows, evidenceRows);
  if (!validation.ok || !run.active_story_digest
    || await sha256(validation.canonicalCandidate) !== run.active_story_digest) {
    return failure(RELEASE_ERROR.stateInvalid, boundedMetadata);
  }
  const milestones = selectReviewableStoryTimeline(candidateItems.map((item) => ({
    id: item.id,
    documentId: item.document_id,
    sequence: item.sequence,
    timestamp: item.timestamp || undefined,
    summary: String(item.organization_reason || ""),
  })));
  const expectedKeys = milestones.map((milestone) => milestone.story.key);
  if (!expectedKeys.length || expectedKeys.length !== validation.chapterCount
    || !sameKeys(expectedKeys, Object.keys(record.session.chapterReviews))) {
    return failure(RELEASE_ERROR.reviewIncomplete, boundedMetadata);
  }

  const hydrated = hydrateStoryReviewSession(record.session, request.workflowRunId, milestones);
  if (!sameKeys(expectedKeys, Object.keys(hydrated.chapterReviews))
    || expectedKeys.some((key) => hydrated.chapterReviews[key]?.stage !== "human_confirmed")) {
    return failure(RELEASE_ERROR.reviewIncomplete, boundedMetadata);
  }

  const built = buildReviewedStoryRelease(milestones, hydrated.chapterReviews);
  const story = sanitizeReviewedStoryRelease(built);
  const serializedStory = serializeReviewedStoryRelease(story);
  if (!story || !serializedStory
    || !sameKeys(expectedKeys, story.chapters.map((chapter) => chapter.key))) {
    return failure(RELEASE_ERROR.reviewIncomplete, boundedMetadata);
  }
  return { ok: true, story, serializedStory };
}

export async function reconstructReviewedStoryRelease(input: unknown) {
  const { getD1: getRuntimeD1 } = await import("../db/index.ts");
  return reconstructReviewedStoryReleaseFromDatabase(await getRuntimeD1(), input);
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
