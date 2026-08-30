import type { getLocalDatabase } from "../db";
import {
  hydrateStoryReviewSession,
  parseStoryReviewSession,
  storyReviewSessionSemanticJson,
  STORY_REVIEW_SESSION_SCHEMA,
  type StoryReviewSession,
} from "./story-review-session.ts";
import {
  readReservedStoryCandidateRows,
  validateCurrentStorySourcePackage,
  type StoryEvidenceRow,
} from "./story-readiness.ts";
import { parseStorySource } from "./timeline.ts";
import {
  validActivatedSourceRevision,
  validNonnegativeAuthorityCounter,
} from "./authority-validation.mjs";

type ReviewSessionDatabase = Awaited<ReturnType<typeof getLocalDatabase>>;

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
  session: StoryReviewSession | null;
  serverVersion: number;
  sourceRevision: number | null;
  persistedAt: string | null;
};

type StoredStoryReviewSession = {
  sourceRevision: number;
  session: StoryReviewSession;
};

const validCounter = (value: unknown): value is number => (
  typeof value === "number" && validNonnegativeAuthorityCounter(value)
);
const validSourceRevision = (value: unknown): value is number => (
  typeof value === "number" && validActivatedSourceRevision(value)
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Read only the source-bound internal storage envelope. */
export function parseStoredStoryReviewSession(value: unknown): {
  session: StoryReviewSession | null;
  sourceRevision: number | null;
} {
  if (!isRecord(value)) {
    return { session: null, sourceRevision: null };
  }
  const sourceRevision = value.sourceRevision;
  if (Object.keys(value).some((key) => key !== "sourceRevision" && key !== "session")
    || !validSourceRevision(sourceRevision)) return { session: null, sourceRevision: null };
  const session = parseStoryReviewSession(value.session);
  return session
    ? { session, sourceRevision }
    : { session: null, sourceRevision };
}

function serializeStoredStoryReviewSession(sourceRevision: number, session: StoryReviewSession) {
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
    serverVersion: validCounter(row.server_version) ? row.server_version : 0,
    sourceRevision: stored.sourceRevision,
    persistedAt: typeof row.updated_at === "string" && row.updated_at ? row.updated_at : null,
  };
}

export async function readActiveStoryReviewSource(
  db: ReviewSessionDatabase,
  workflowRunId: string,
): Promise<{ ready: boolean; sourceRevision: number | null }> {
  const row = await db.prepare(`SELECT story_generation_status,story_source_revision
    FROM workflow_runs WHERE id=?`).bind(workflowRunId).first<SourceRow>();
  const rawSourceRevision = row?.story_source_revision;
  const sourceRevision = validSourceRevision(rawSourceRevision) ? rawSourceRevision : null;
  return {
    ready: row?.story_generation_status === "ready_for_human_review" && sourceRevision !== null,
    sourceRevision,
  };
}

/** Derive the active source/session contract from the complete recognized
 * package. The version is never selected by the browser or persisted twice. */
export async function readActiveStoryReviewPackage(
  db: ReviewSessionDatabase,
  workflowRunId: string,
  options: { verifyCurrentSource?: boolean } = {},
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
  const validation = await validateCurrentStorySourcePackage(
    db,
    workflowRunId,
    candidateRows,
    evidenceResult.results || [],
    options,
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
        storySourceSchema: "oxygen.story" as const,
        storySessionSchema: STORY_REVIEW_SESSION_SCHEMA,
      }
    : { ...active, storySourceSchema: null, storySessionSchema: null };
}

/** Sanitized polling projection. It consumes the same persisted semantic,
 * coverage, and source-Privacy rows without selecting or hashing source text;
 * every Story-bearing hydration re-runs the deep contract above. */
export async function readPassiveActiveStoryReviewContract(
  db: ReviewSessionDatabase,
  workflowRunId: string,
) {
  const { active, validation } = await readActiveStoryReviewPackage(
    db,
    workflowRunId,
    { verifyCurrentSource: false },
  );
  return validation
    ? {
        ...active,
        storySourceSchema: "oxygen.story" as const,
        storySessionSchema: STORY_REVIEW_SESSION_SCHEMA,
      }
    : { ...active, storySourceSchema: null, storySessionSchema: null };
}

type CasRequest = {
  workflowRunId: string;
  expectedVersion: number;
  sourceRevision: number;
  storySessionSchema: typeof STORY_REVIEW_SESSION_SCHEMA;
  session: StoryReviewSession;
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
  return session ? storyReviewSessionSemanticJson(session) : null;
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
  if (!validNonnegativeAuthorityCounter(request.expectedVersion)) {
    return { ok: false, code: STORY_SESSION_ERROR.versionInvalid };
  }
  if (!validActivatedSourceRevision(request.sourceRevision)) {
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
  if (current.persistedAt && (!current.session
    || !validActivatedSourceRevision(current.sourceRevision))) {
    return failure(STORY_SESSION_ERROR.stateInvalid, current, active.sourceRevision);
  }
  if (!validation || request.storySessionSchema !== STORY_REVIEW_SESSION_SCHEMA) {
    return failure(STORY_SESSION_ERROR.stateInvalid, current, active.sourceRevision);
  }
  if (request.expectedVersion !== current.serverVersion) {
    return failure(STORY_SESSION_ERROR.versionConflict, current, active.sourceRevision);
  }
  const sources = candidateRows.map((row) => parseStorySource(row.summary));
  if (sources.some((source) => !source)) {
    return failure(STORY_SESSION_ERROR.stateInvalid, current, active.sourceRevision);
  }
  const exactSources = sources.flatMap((source) => source ? [source] : []);
  const hydrated = hydrateStoryReviewSession(canonical, request.workflowRunId, exactSources);
  if (Object.keys(hydrated.chapterReviews).length !== exactSources.length) {
    return failure(STORY_SESSION_ERROR.stateInvalid, current, active.sourceRevision);
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

  if (!validNonnegativeAuthorityCounter(request.expectedVersion + 1)) {
    return failure(STORY_SESSION_ERROR.versionInvalid, current, active.sourceRevision);
  }

  const updated = await db.prepare(`UPDATE story_review_sessions
    SET state_json=?,updated_at=?,server_version=server_version+1
    WHERE workflow_run_id=? AND server_version=?
      AND server_version<9007199254740991
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
