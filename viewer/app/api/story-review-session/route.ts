import { getLocalDatabase } from "../../../db";
import { validActivatedSourceRevision } from "../../../lib/authority-validation.mjs";
import {
  MAX_STORY_REVIEW_SESSION_BYTES,
  parseStoryReviewSession,
  STORY_REVIEW_SESSION_SCHEMA,
} from "../../../lib/story-review-session";
import {
  STORY_SESSION_ERROR,
  persistStoryReviewSessionCas,
  readActiveStoryReviewContract,
  readStoryReviewSessionRecord,
  type StorySessionErrorCode,
} from "../../../lib/story-review-session-server";
import { isWorkflowRunId } from "../../../lib/workflow-progress";
import {
  WORKFLOW_RUN_AUTHORITY,
  requireExactWorkflowRun,
  workflowRunErrorResponse,
} from "../../../lib/workflow-run-server";

const MAX_STORY_REVIEW_SESSION_REQUEST_BYTES = MAX_STORY_REVIEW_SESSION_BYTES + 10_000;

const messages: Record<StorySessionErrorCode, string> = {
  [STORY_SESSION_ERROR.versionRequired]: "Story review session version is required",
  [STORY_SESSION_ERROR.versionInvalid]: "Story review session version is invalid",
  [STORY_SESSION_ERROR.versionConflict]: "Story review session changed; reload before saving",
  [STORY_SESSION_ERROR.sourceConflict]: "Story review source changed; reload before saving",
  [STORY_SESSION_ERROR.notReady]: "Story review is not ready",
  [STORY_SESSION_ERROR.stateInvalid]: "Invalid Story review session",
};

function sessionErrorResponse(
  code: StorySessionErrorCode,
  metadata: { serverVersion?: number; sourceRevision?: number } = {},
) {
  const status = code === STORY_SESSION_ERROR.versionRequired
    || code === STORY_SESSION_ERROR.versionInvalid
    || code === STORY_SESSION_ERROR.stateInvalid
    ? 400
    : 409;
  return Response.json({ error: messages[code], code, ...metadata }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function GET(request: Request) {
  const workflowRunId = new URL(request.url).searchParams.get("workflowRunId");
  if (!isWorkflowRunId(workflowRunId)) {
    return Response.json({ error: "A valid workflow run is required" }, { status: 400 });
  }
  const db = await getLocalDatabase();
  const authority = await requireExactWorkflowRun(db, workflowRunId);
  if (authority.state !== WORKFLOW_RUN_AUTHORITY.exactRun) {
    return workflowRunErrorResponse(authority);
  }
  const [active, record] = await Promise.all([
    readActiveStoryReviewContract(db, workflowRunId),
    readStoryReviewSessionRecord(db, workflowRunId),
  ]);
  if (!active.ready || active.sourceRevision === null) {
    return sessionErrorResponse(STORY_SESSION_ERROR.notReady);
  }
  if (active.storySourceSchema !== "oxygen.story"
    || active.storySessionSchema !== STORY_REVIEW_SESSION_SCHEMA) {
    return sessionErrorResponse(STORY_SESSION_ERROR.stateInvalid);
  }
  const revisionMatches = record.sourceRevision === active.sourceRevision;
  const session = revisionMatches
    ? record.session
    : null;
  if (session && session.schema !== active.storySessionSchema) {
    return sessionErrorResponse(STORY_SESSION_ERROR.stateInvalid);
  }
  return Response.json({
    session,
    serverVersion: record.serverVersion,
    sourceRevision: active.sourceRevision,
    persistedAt: record.persistedAt,
    storySourceSchema: active.storySourceSchema,
    storySessionSchema: active.storySessionSchema,
  }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}

export async function POST(request: Request) {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_STORY_REVIEW_SESSION_REQUEST_BYTES) {
    return Response.json({ error: "Story review session is too large" }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return sessionErrorResponse(STORY_SESSION_ERROR.stateInvalid);
  }
  if (!isRecord(body)
    || Object.keys(body).some((key) => ![
      "workflowRunId", "expectedVersion", "sourceRevision", "session",
    ].includes(key))) return sessionErrorResponse(STORY_SESSION_ERROR.stateInvalid);
  if (!("expectedVersion" in body)) {
    return sessionErrorResponse(STORY_SESSION_ERROR.versionRequired);
  }
  if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 0) {
    return sessionErrorResponse(STORY_SESSION_ERROR.versionInvalid);
  }
  const workflowRunId = typeof body.workflowRunId === "string" ? body.workflowRunId : "";
  if (!isWorkflowRunId(workflowRunId)
    || !validActivatedSourceRevision(body.sourceRevision)) {
    return sessionErrorResponse(STORY_SESSION_ERROR.stateInvalid);
  }
  const session = parseStoryReviewSession(body.session);
  if (!session || session.workflowRunId !== workflowRunId) {
    return sessionErrorResponse(STORY_SESSION_ERROR.stateInvalid);
  }

  const db = await getLocalDatabase();
  const authority = await requireExactWorkflowRun(db, workflowRunId);
  if (authority.state !== WORKFLOW_RUN_AUTHORITY.exactRun) {
    return workflowRunErrorResponse(authority);
  }
  const active = await readActiveStoryReviewContract(db, workflowRunId);
  if (!active.ready || active.sourceRevision === null) {
    return sessionErrorResponse(STORY_SESSION_ERROR.notReady);
  }
  if (active.storySourceSchema !== "oxygen.story"
    || active.storySessionSchema !== STORY_REVIEW_SESSION_SCHEMA
    || session.schema !== active.storySessionSchema) {
    return sessionErrorResponse(STORY_SESSION_ERROR.stateInvalid);
  }
  const result = await persistStoryReviewSessionCas(db, {
    workflowRunId,
    expectedVersion: Number(body.expectedVersion),
    sourceRevision: Number(body.sourceRevision),
    storySessionSchema: active.storySessionSchema,
    session,
  }, new Date().toISOString());
  if (!result.ok) {
    return sessionErrorResponse(result.code, {
      ...(result.serverVersion === undefined ? {} : { serverVersion: result.serverVersion }),
      ...(result.sourceRevision === undefined ? {} : { sourceRevision: result.sourceRevision }),
    });
  }
  return Response.json({
    saved: result.saved,
    noChange: result.noChange,
    serverVersion: result.serverVersion,
    sourceRevision: result.sourceRevision,
    persistedAt: result.persistedAt,
  });
}
