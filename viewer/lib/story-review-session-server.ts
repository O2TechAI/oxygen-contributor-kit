import type { getD1 } from "../db";
import {
  hydrateSuccessorStoryReviewSession,
  parseStoryReviewSession,
  storyReviewSessionSemanticJson,
  STORY_REVIEW_SESSION_SCHEMA,
  SUCCESSOR_STORY_REVIEW_SESSION_SCHEMA,
  type AnyStoryReviewSession,
} from "./story-review-session.ts";
import {
  readReservedStoryCandidateRows,
  validateRecognizedStorySourcePackage,
  type StoryEvidenceRow,
} from "./story-readiness.ts";
import { parseSuccessorStorySource } from "./timeline.ts";

type ReviewSessionDatabase = Awaited<ReturnType<typeof getD1>>;

type SessionRow = {
  state_json?: string;
  updated_at?: string;
  server_version?: number;
};

type SourceRow = {
  story_generation_status?: string;
  story_source_revision?: number;
};

export const STORY_SESSION_ERROR = {
  versionRequired: "STORY_SESSION_VERSION_REQUIRED",
  versionInvalid: "STORY_SESSION_VERSION_INVALID",
  versionConflict: "STORY_SESSION_VERSION_CONFLICT",
  sourceConflict: "STORY_SESSION_SOURCE_CONFLICT",
  notReady: "STORY_SESSION_NOT_READY",
  stateInvalid: "STORY_SESSION_STATE_INVALID",
} as const;

export type StorySessionErrorCode = typeof STORY_SESSION_ERROR[keyof typeof STORY_SESSION_ERROR];

export type StoryReviewSessionRecord = {
  session: AnyStoryReviewSession | null;
  serverVersion: number;
  sourceRevision: number | null;
  persistedAt: string | null;
};

type StoredStoryReviewSession = {
  sourceRevision: number;
  session: AnyStoryReviewSession;
};

const validRevision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Read both legacy direct schema-1 rows and the source-bound internal storage
 * envelope. The public Story session schema itself remains unchanged. */
export function parseStoredStoryReviewSession(value: unknown): {
  session: AnyStoryReviewSession | null;
  sourceRevision: number | null;
} {
  const direct = parseStoryReviewSession(value);
  if (direct) return { session: direct, sourceRevision: null };
  if (!isRecord(value) || !validRevision(value.sourceRevision)) {
    return { session: null, sourceRevision: null };
  }
  const session = parseStoryReviewSession(value.session);
  return session
    ? { session, sourceRevision: value.sourceRevision }
    : { session: null, sourceRevision: value.sourceRevision };
}

function serializeStoredStoryReviewSession(sourceRevision: number, session: AnyStoryReviewSession) {
  const stored: StoredStoryReviewSession = { sourceRevision, session };
  return JSON.stringify(stored);
}

export async function readStoryReviewSessionRecord(
  db: ReviewSessionDatabase,
  workflowRunId: string,
): Promise<StoryReviewSessionRecord> {
  const row = await db.prepare(`SELECT state_json,updated_at,server_version
    FROM story_review_sessions WHERE workflow_run_id=?`)
    .bind(workflowRunId).first<SessionRow>();
  if (!row) return { session: null, serverVersion: 0, sourceRevision: null, persistedAt: null };
  let stored: ReturnType<typeof parseStoredStoryReviewSession> = { session: null, sourceRevision: null };
  try {
    stored = parseStoredStoryReviewSession(JSON.parse(String(row.state_json || "")));
  } catch {
    // Malformed historical state remains fail-closed while bounded metadata is retained.
  }
  return {
    session: stored.session,
    serverVersion: validRevision(row.server_version) ? row.server_version : 0,
    sourceRevision: stored.sourceRevision,
    persistedAt: typeof row.updated_at === "string" && row.updated_at ? row.updated_at : null,
  };
}

export async function readActiveStoryReviewSource(
  db: ReviewSessionDatabase,
  workflowRunId: string,
) {
  const row = await db.prepare(`SELECT story_generation_status,story_source_revision
    FROM workflow_runs WHERE id=?`).bind(workflowRunId).first<SourceRow>();
  return {
    ready: row?.story_generation_status === "ready_for_human_review",
    sourceRevision: validRevision(row?.story_source_revision) ? row.story_source_revision : null,
  };
}

/** Derive the active source/session contract from the complete recognized
 * package. The version is never selected by the browser or persisted twice. */
async function readActiveStoryReviewPackage(
  db: ReviewSessionDatabase,
  workflowRunId: string,
) {
  const active = await readActiveStoryReviewSource(db, workflowRunId);
  if (!active.ready || active.sourceRevision === null) {
    return { active, candidateRows: [], validation: null };
  }
  const [candidateRows, evidenceResult] = await Promise.all([
    readReservedStoryCandidateRows(db),
    db.prepare(`SELECT id,document_id AS documentId,event_type AS eventType,
      actor_id AS actorId,actor_type AS actorType FROM items ORDER BY document_id,sequence`)
      .all<StoryEvidenceRow>(),
  ]);
  const validation = validateRecognizedStorySourcePackage(
    candidateRows,
    evidenceResult.results || [],
  );
  return { active, candidateRows, validation: validation.ok ? validation : null };
}

export async function readActiveStoryReviewContract(
  db: ReviewSessionDatabase,
  workflowRunId: string,
) {
  const { active, validation } = await readActiveStoryReviewPackage(db, workflowRunId);
  return validation
    ? {
        ...active,
        storySourceSchema: validation.sourceSchema,
        storySessionSchema: validation.sessionSchema,
      }
    : { ...active, storySourceSchema: null, storySessionSchema: null };
}

type CasRequest = {
  workflowRunId: string;
  expectedVersion: number;
  sourceRevision: number;
  storySessionSchema: typeof STORY_REVIEW_SESSION_SCHEMA | typeof SUCCESSOR_STORY_REVIEW_SESSION_SCHEMA;
  session: AnyStoryReviewSession;
};

type CasSuccess = {
  ok: true;
  saved: boolean;
  noChange: boolean;
  serverVersion: number;
  sourceRevision: number;
  persistedAt: string;
};

type CasFailure = {
  ok: false;
  code: StorySessionErrorCode;
  serverVersion?: number;
  sourceRevision?: number;
};

const changes = (result: { meta?: { changes?: number } }) => Number(result.meta?.changes || 0);

function reviewSessionSemanticJson(value: unknown) {
  const session = parseStoryReviewSession(value);
  if (!session) return null;
  return session.schema === STORY_REVIEW_SESSION_SCHEMA
    ? storyReviewSessionSemanticJson(session)
    : JSON.stringify({ ...session, updatedAt: "" });
}

function failure(
  code: StorySessionErrorCode,
  current: StoryReviewSessionRecord,
  sourceRevision: number | null,
): CasFailure {
  return {
    ok: false,
    code,
    serverVersion: current.serverVersion,
    ...(sourceRevision === null ? {} : { sourceRevision }),
  };
}

async function resolveZeroChange(
  db: ReviewSessionDatabase,
  request: CasRequest,
  allowConcurrentFirstCreateNoChange = false,
): Promise<CasSuccess | CasFailure> {
  const [active, current] = await Promise.all([
    readActiveStoryReviewSource(db, request.workflowRunId),
    readStoryReviewSessionRecord(db, request.workflowRunId),
  ]);
  if (!active.ready) return failure(STORY_SESSION_ERROR.notReady, current, active.sourceRevision);
  if (active.sourceRevision !== request.sourceRevision) {
    return failure(STORY_SESSION_ERROR.sourceConflict, current, active.sourceRevision);
  }
  const exactVersion = current.serverVersion === request.expectedVersion;
  const concurrentFirstCreate = allowConcurrentFirstCreateNoChange
    && request.expectedVersion === 0 && current.serverVersion === 1;
  if ((exactVersion || concurrentFirstCreate)
    && current.sourceRevision === request.sourceRevision
    && reviewSessionSemanticJson(current.session) === reviewSessionSemanticJson(request.session)) {
    return {
      ok: true,
      saved: false,
      noChange: true,
      serverVersion: current.serverVersion,
      sourceRevision: request.sourceRevision,
      persistedAt: current.persistedAt || request.session.updatedAt,
    };
  }
  return failure(STORY_SESSION_ERROR.versionConflict, current, active.sourceRevision);
}

/** Persist one canonical session through an exact version and source CAS. Both
 * first create and update recheck ready/source state inside their SQL statement. */
export async function persistStoryReviewSessionCas(
  db: ReviewSessionDatabase,
  request: CasRequest,
  serverNow: string,
): Promise<CasSuccess | CasFailure> {
  if (!validRevision(request.expectedVersion)) {
    return { ok: false, code: STORY_SESSION_ERROR.versionInvalid };
  }
  if (!validRevision(request.sourceRevision)) {
    return { ok: false, code: STORY_SESSION_ERROR.sourceConflict };
  }
  const canonical = parseStoryReviewSession(request.session);
  if (!canonical || canonical.workflowRunId !== request.workflowRunId
    || canonical.schema !== request.storySessionSchema) {
    return { ok: false, code: STORY_SESSION_ERROR.stateInvalid };
  }
  const [activePackage, current] = await Promise.all([
    readActiveStoryReviewPackage(db, request.workflowRunId),
    readStoryReviewSessionRecord(db, request.workflowRunId),
  ]);
  const { active, candidateRows, validation } = activePackage;
  if (!active.ready || active.sourceRevision === null) {
    return failure(STORY_SESSION_ERROR.notReady, current, active.sourceRevision);
  }
  if (active.sourceRevision !== request.sourceRevision) {
    return failure(STORY_SESSION_ERROR.sourceConflict, current, active.sourceRevision);
  }
  if (!validation || validation.sessionSchema !== request.storySessionSchema) {
    return failure(STORY_SESSION_ERROR.stateInvalid, current, active.sourceRevision);
  }
  if (request.expectedVersion !== current.serverVersion) {
    return failure(STORY_SESSION_ERROR.versionConflict, current, active.sourceRevision);
  }
  if (current.session && current.session.schema !== canonical.schema
    && (current.sourceRevision === null || current.sourceRevision === request.sourceRevision)) {
    return failure(STORY_SESSION_ERROR.stateInvalid, current, active.sourceRevision);
  }
  if (canonical.schema === SUCCESSOR_STORY_REVIEW_SESSION_SCHEMA) {
    if (validation.sourceSchema !== "oxygen.story/3") {
      return failure(STORY_SESSION_ERROR.stateInvalid, current, active.sourceRevision);
    }
    const sources = candidateRows.map((row) => parseSuccessorStorySource(row.summary));
    if (sources.some((source) => !source)) {
      return failure(STORY_SESSION_ERROR.stateInvalid, current, active.sourceRevision);
    }
    const exactSources = sources.flatMap((source) => source ? [source] : []);
    const hydrated = hydrateSuccessorStoryReviewSession(
      canonical,
      request.workflowRunId,
      exactSources,
    );
    if (Object.keys(hydrated.chapterReviews).length !== exactSources.length) {
      return failure(STORY_SESSION_ERROR.stateInvalid, current, active.sourceRevision);
    }
  }

  const persistedSession = parseStoryReviewSession({ ...canonical, updatedAt: serverNow });
  if (!persistedSession) return { ok: false, code: STORY_SESSION_ERROR.stateInvalid };
  const stateJson = serializeStoredStoryReviewSession(request.sourceRevision, persistedSession);

  if (!current.persistedAt) {
    const inserted = await db.prepare(`INSERT INTO story_review_sessions
        (workflow_run_id,state_json,updated_at,server_version)
      SELECT ?,?,?,1
      WHERE EXISTS (SELECT 1 FROM workflow_runs
        WHERE id=? AND story_generation_status='ready_for_human_review' AND story_source_revision=?)
        AND NOT EXISTS (SELECT 1 FROM story_review_sessions WHERE workflow_run_id=?)`)
      .bind(request.workflowRunId, stateJson, serverNow,
        request.workflowRunId, request.sourceRevision, request.workflowRunId).run();
    if (changes(inserted) === 1) {
      return {
        ok: true, saved: true, noChange: false, serverVersion: 1,
        sourceRevision: request.sourceRevision, persistedAt: serverNow,
      };
    }
    return resolveZeroChange(db, request, true);
  }

  const sameMeaning = current.sourceRevision === request.sourceRevision
    && reviewSessionSemanticJson(current.session) === reviewSessionSemanticJson(canonical);
  if (sameMeaning) {
    const row = await db.prepare(`SELECT state_json FROM story_review_sessions WHERE workflow_run_id=?`)
      .bind(request.workflowRunId).first<{ state_json?: string }>();
    const guarded = await db.prepare(`UPDATE story_review_sessions SET server_version=server_version
      WHERE workflow_run_id=? AND server_version=? AND state_json=?
        AND EXISTS (SELECT 1 FROM workflow_runs
          WHERE id=? AND story_generation_status='ready_for_human_review' AND story_source_revision=?)`)
      .bind(request.workflowRunId, request.expectedVersion, String(row?.state_json || ""),
        request.workflowRunId, request.sourceRevision).run();
    if (changes(guarded) === 1) {
      return {
        ok: true, saved: false, noChange: true,
        serverVersion: current.serverVersion,
        sourceRevision: request.sourceRevision,
        persistedAt: current.persistedAt,
      };
    }
    return resolveZeroChange(db, request);
  }

  const updated = await db.prepare(`UPDATE story_review_sessions
    SET state_json=?,updated_at=?,server_version=server_version+1
    WHERE workflow_run_id=? AND server_version=?
      AND EXISTS (SELECT 1 FROM workflow_runs
        WHERE id=? AND story_generation_status='ready_for_human_review' AND story_source_revision=?)`)
    .bind(stateJson, serverNow, request.workflowRunId, request.expectedVersion,
      request.workflowRunId, request.sourceRevision).run();
  if (changes(updated) === 1) {
    return {
      ok: true, saved: true, noChange: false,
      serverVersion: request.expectedVersion + 1,
      sourceRevision: request.sourceRevision,
      persistedAt: serverNow,
    };
  }
  return resolveZeroChange(db, request);
}
