import type { getLocalDatabase } from "../db";
import {
  RELEASE_ERROR,
  parseServerOwnedReleaseRequest,
  reconstructReviewedStoryReleaseFromDatabase,
  type ReleaseErrorCode,
  type ServerOwnedReleaseRequest,
} from "./story-release-server.ts";
import type { ReleaseSnapshotTestOptions } from "./release-privacy-snapshot.ts";

type ProjectReleaseConfirmationDatabase = Awaited<ReturnType<typeof getLocalDatabase>>;

type ProjectReleaseConfirmationRow = {
  workflow_run_id?: string;
  review_gate_digest?: string;
  confirmed_at?: string;
};

type ChangeCountRow = { total_changes?: number };

export const RELEASE_CONFIRMATION_ERROR = {
  requestInvalid: "RELEASE_CONFIRMATION_REQUEST_INVALID",
  conflict: "RELEASE_CONFIRMATION_CONFLICT",
} as const;

export type ProjectReleaseConfirmationFailure = {
  ok: false;
  code: typeof RELEASE_CONFIRMATION_ERROR[keyof typeof RELEASE_CONFIRMATION_ERROR] | ReleaseErrorCode;
  serverVersion?: number;
  sourceRevision?: number;
};

export type ProjectReleaseConfirmationSuccess = {
  ok: true;
  idempotent: boolean;
  workflowRunId: string;
  reviewGateDigest: string;
  sourceRevision: number;
  serverVersion: number;
  confirmedAt: string;
};

export type ProjectReleaseConfirmationResult =
  | ProjectReleaseConfirmationSuccess
  | ProjectReleaseConfirmationFailure;

function sameBinding(
  row: ProjectReleaseConfirmationRow | null,
  request: ServerOwnedReleaseRequest,
  digest: string,
) {
  return row?.workflow_run_id === request.workflowRunId
    && row.review_gate_digest === digest
    && typeof row.confirmed_at === "string" && Boolean(row.confirmed_at);
}

function sameRow(
  left: ProjectReleaseConfirmationRow,
  right: ProjectReleaseConfirmationRow | null,
) {
  return right !== null
    && left.workflow_run_id === right.workflow_run_id
    && left.review_gate_digest === right.review_gate_digest
    && left.confirmed_at === right.confirmed_at;
}

async function readConfirmationRow(
  db: ProjectReleaseConfirmationDatabase,
  workflowRunId: string,
) {
  return db.prepare(`SELECT workflow_run_id,review_gate_digest,confirmed_at
    FROM project_release_confirmations WHERE workflow_run_id=?`)
    .bind(workflowRunId).first<ProjectReleaseConfirmationRow>();
}

async function readTotalChanges(db: ProjectReleaseConfirmationDatabase) {
  const row = await db.prepare("SELECT total_changes() AS total_changes").first<ChangeCountRow>();
  const count = Number(row?.total_changes);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

/** Establish one durable final release confirmation inside a BEGIN IMMEDIATE
 * transaction. Full readiness is re-evaluated while the write lock is held;
 * therefore no checked source, receipt, decision, answer or session can change
 * between validation and the guarded insert. */
export async function confirmProjectReleaseConfirmation(
  db: ProjectReleaseConfirmationDatabase,
  input: unknown,
  serverNow = new Date().toISOString(),
): Promise<ProjectReleaseConfirmationResult> {
  const request = parseServerOwnedReleaseRequest(input);
  if (!request) return { ok: false, code: RELEASE_CONFIRMATION_ERROR.requestInvalid };
  try {
    return await db.transaction(async () => {
      const readiness = await reconstructReviewedStoryReleaseFromDatabase(db, request, {
        allowUnsetReleaseConfirmation: true,
      });
      if (!readiness.ok) return readiness;
      const current = await readConfirmationRow(db, request.workflowRunId);
      if (sameBinding(current, request, readiness.binding.reviewGateDigest)) {
        return {
          ok: true,
          idempotent: true,
          workflowRunId: request.workflowRunId,
          reviewGateDigest: readiness.binding.reviewGateDigest,
          sourceRevision: request.sourceRevision,
          serverVersion: request.serverVersion,
          confirmedAt: String(current!.confirmed_at),
        };
      }
      const inserted = await db.prepare(`INSERT INTO project_release_confirmations
        (workflow_run_id,review_gate_digest,confirmed_at) VALUES (?,?,?)
        ON CONFLICT(workflow_run_id) DO UPDATE SET
          review_gate_digest=excluded.review_gate_digest,
          confirmed_at=excluded.confirmed_at
        WHERE project_release_confirmations.review_gate_digest<>excluded.review_gate_digest`).bind(
        request.workflowRunId,
        readiness.binding.reviewGateDigest,
        serverNow,
      ).run();
      if (Number(inserted.meta?.changes || 0) !== 1) {
        return { ok: false, code: RELEASE_CONFIRMATION_ERROR.conflict };
      }
      return {
        ok: true,
        idempotent: false,
        workflowRunId: request.workflowRunId,
        reviewGateDigest: readiness.binding.reviewGateDigest,
        sourceRevision: request.sourceRevision,
        serverVersion: request.serverVersion,
        confirmedAt: serverNow,
      };
    });
  } catch {
    return { ok: false, code: RELEASE_CONFIRMATION_ERROR.conflict };
  }
}

const releaseConfirmationMessages: Record<ProjectReleaseConfirmationFailure["code"], string> = {
  [RELEASE_CONFIRMATION_ERROR.requestInvalid]: "Invalid final release confirmation request",
  [RELEASE_CONFIRMATION_ERROR.conflict]: "Final release confirmation conflicted",
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
  [RELEASE_ERROR.releaseConfirmationRequired]: "Final release confirmation is required",
};

/** Recompute the same current release gate used by confirmation and release.
 * A stale persisted row is projected as false; no Chapter state is mutated. */
export async function readProjectReleaseConfirmation(
  db: ProjectReleaseConfirmationDatabase,
  input: ServerOwnedReleaseRequest,
  options: ReleaseSnapshotTestOptions = {},
) {
  const beforeRow = await readConfirmationRow(db, input.workflowRunId);
  if (!beforeRow) return false;
  const beforeChanges = await readTotalChanges(db);
  if (beforeChanges === null) return false;
  const current = await reconstructReviewedStoryReleaseFromDatabase(db, input, options);
  if (!current.ok) return false;
  const afterRow = await readConfirmationRow(db, input.workflowRunId);
  const afterChanges = await readTotalChanges(db);
  return afterChanges === beforeChanges
    && sameRow(beforeRow, afterRow)
    && sameBinding(afterRow, input, current.binding.reviewGateDigest);
}

export function releaseConfirmationErrorResponse(result: ProjectReleaseConfirmationFailure) {
  return Response.json({
    error: releaseConfirmationMessages[result.code],
    code: result.code,
    ...(result.serverVersion === undefined ? {} : { serverVersion: result.serverVersion }),
    ...(result.sourceRevision === undefined ? {} : { sourceRevision: result.sourceRevision }),
  }, { status: result.code === RELEASE_CONFIRMATION_ERROR.requestInvalid ? 400 : 409 });
}
