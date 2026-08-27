import type { getLocalDatabase } from "../db";
import {
  RELEASE_ERROR,
  parseServerOwnedReleaseRequest,
  reconstructReviewedStoryReleaseFromDatabase,
  type ReleaseErrorCode,
  type ServerOwnedReleaseRequest,
} from "./story-release-server.ts";

type AllSetDatabase = Awaited<ReturnType<typeof getLocalDatabase>>;

type AllSetRow = {
  workflow_run_id?: string;
  review_gate_digest?: string;
  all_set_at?: string;
};

export const ALL_SET_ERROR = {
  requestInvalid: "ALL_SET_REQUEST_INVALID",
  stale: "ALL_SET_AUTHORITY_STALE",
  conflict: "ALL_SET_CONFLICT",
} as const;

export type AllSetFailure = {
  ok: false;
  code: typeof ALL_SET_ERROR[keyof typeof ALL_SET_ERROR] | ReleaseErrorCode;
  serverVersion?: number;
  sourceRevision?: number;
};

export type AllSetSuccess = {
  ok: true;
  idempotent: boolean;
  workflowRunId: string;
  reviewGateDigest: string;
  sourceRevision: number;
  serverVersion: number;
  allSetAt: string;
};

export type AllSetResult = AllSetSuccess | AllSetFailure;

function sameBinding(row: AllSetRow | null, request: ServerOwnedReleaseRequest, digest: string) {
  return row?.workflow_run_id === request.workflowRunId
    && row.review_gate_digest === digest
    && typeof row.all_set_at === "string" && Boolean(row.all_set_at);
}

/** Establish one durable final release confirmation inside a BEGIN IMMEDIATE
 * transaction. Full readiness is re-evaluated while the write lock is held;
 * therefore no checked source, receipt, decision, answer or session can change
 * between validation and the guarded insert. */
export async function confirmProjectAllSet(
  db: AllSetDatabase,
  input: unknown,
  serverNow = new Date().toISOString(),
): Promise<AllSetResult> {
  const request = parseServerOwnedReleaseRequest(input);
  if (!request) return { ok: false, code: ALL_SET_ERROR.requestInvalid };
  try {
    return await db.transaction(async () => {
      const readiness = await reconstructReviewedStoryReleaseFromDatabase(db, request, {
        allowUnsetAllSet: true,
      });
      if (!readiness.ok) return readiness;
      const current = await db.prepare(`SELECT workflow_run_id,review_gate_digest,all_set_at
        FROM project_all_set WHERE workflow_run_id=?`)
        .bind(request.workflowRunId).first<AllSetRow>();
      if (sameBinding(current, request, readiness.binding.reviewGateDigest)) {
        return {
          ok: true,
          idempotent: true,
          workflowRunId: request.workflowRunId,
          reviewGateDigest: readiness.binding.reviewGateDigest,
          sourceRevision: request.sourceRevision,
          serverVersion: request.serverVersion,
          allSetAt: String(current!.all_set_at),
        };
      }
      const inserted = await db.prepare(`INSERT INTO project_all_set
        (workflow_run_id,review_gate_digest,all_set_at) VALUES (?,?,?)
        ON CONFLICT(workflow_run_id) DO UPDATE SET
          review_gate_digest=excluded.review_gate_digest,
          all_set_at=excluded.all_set_at
        WHERE project_all_set.review_gate_digest<>excluded.review_gate_digest`).bind(
        request.workflowRunId,
        readiness.binding.reviewGateDigest,
        serverNow,
      ).run();
      if (Number(inserted.meta?.changes || 0) !== 1) {
        return { ok: false, code: ALL_SET_ERROR.conflict };
      }
      return {
        ok: true,
        idempotent: false,
        workflowRunId: request.workflowRunId,
        reviewGateDigest: readiness.binding.reviewGateDigest,
        sourceRevision: request.sourceRevision,
        serverVersion: request.serverVersion,
        allSetAt: serverNow,
      };
    });
  } catch {
    return { ok: false, code: ALL_SET_ERROR.conflict };
  }
}

const allSetMessages: Record<AllSetFailure["code"], string> = {
  [ALL_SET_ERROR.requestInvalid]: "Invalid final release confirmation request",
  [ALL_SET_ERROR.stale]: "Final release authority is stale",
  [ALL_SET_ERROR.conflict]: "Final release confirmation conflicted",
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
  [RELEASE_ERROR.allSetRequired]: "Final release confirmation is required",
};

/** Recompute the same current release gate used by confirmation and release.
 * A stale persisted row is projected as false; no Chapter state is mutated. */
export async function readProjectReleaseConfirmation(
  db: AllSetDatabase,
  input: ServerOwnedReleaseRequest,
) {
  return db.transaction(async () => {
    const current = await reconstructReviewedStoryReleaseFromDatabase(db, input, {
      allowUnsetAllSet: true,
    });
    if (!current.ok) return false;
    const row = await db.prepare(`SELECT workflow_run_id,review_gate_digest,all_set_at
      FROM project_all_set WHERE workflow_run_id=?`).bind(input.workflowRunId).first<AllSetRow>();
    return sameBinding(row, input, current.binding.reviewGateDigest);
  });
}

export function allSetErrorResponse(result: AllSetFailure) {
  return Response.json({
    error: allSetMessages[result.code],
    code: result.code,
    ...(result.serverVersion === undefined ? {} : { serverVersion: result.serverVersion }),
    ...(result.sourceRevision === undefined ? {} : { sourceRevision: result.sourceRevision }),
  }, { status: result.code === ALL_SET_ERROR.requestInvalid ? 400 : 409 });
}
