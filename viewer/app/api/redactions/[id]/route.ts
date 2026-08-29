import { getLocalDatabase } from "../../../../db";
import {
  WORKFLOW_RUN_AUTHORITY,
  requireEstablishedWorkflowRun,
  workflowRunErrorResponse,
} from "../../../../lib/workflow-run-server";
import { computeSourceDigest } from "../../../../lib/redaction-pass.mjs";
import {
  activeStoryPrivacyInvalidationStatements,
  storySourceGenerationGuardStatement,
} from "../../../../lib/story-source-publication";

const DECISIONS = new Set(["keep", "redact"]);
const SOURCE_PRIVACY_ERROR = {
  requestInvalid: "SOURCE_PRIVACY_DECISION_INVALID",
  notFound: "SOURCE_PRIVACY_CANDIDATE_NOT_FOUND",
  notActionable: "SOURCE_PRIVACY_DECISION_NOT_ACTIONABLE",
  mutationConflict: "SOURCE_PRIVACY_MUTATION_CONFLICT",
  methodNotAllowed: "SOURCE_PRIVACY_METHOD_NOT_ALLOWED",
} as const;

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = await getLocalDatabase();
  const authority = await requireEstablishedWorkflowRun(db);
  if (authority.state !== WORKFLOW_RUN_AUTHORITY.exactRun) {
    return workflowRunErrorResponse(authority);
  }
  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({
      error: "Exactly one keep or redact decision is required",
      code: SOURCE_PRIVACY_ERROR.requestInvalid,
    }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).length !== 1 || !("decision" in body)
      || !DECISIONS.has(String((body as { decision?: unknown }).decision || ""))) {
    return Response.json({
      error: "Exactly one keep or redact decision is required",
      code: SOURCE_PRIVACY_ERROR.requestInvalid,
    }, { status: 400 });
  }
  const decision = String((body as { decision: unknown }).decision);
  const reviewState = decision === "keep" ? "confirmed_keep" : "confirmed_redact";
  const status = decision === "keep" ? "removed" : "active";
  const now = new Date().toISOString();
  let snapshot: {
    sourceRevision: number;
    sourceRows: Record<string, unknown>[];
    jobs: Record<string, unknown>[];
    candidate?: Record<string, unknown>;
  };
  try {
    snapshot = await db.transaction(async () => {
      const [sourceRevisionRow, sourceResult, jobResult, candidate] = await Promise.all([
        db.prepare("SELECT story_source_revision FROM workflow_runs WHERE id=?")
          .bind(authority.workflowRunId).first<Record<string, unknown>>(),
        db.prepare(`SELECT document_id,id,sequence,event_type,actor_type,timestamp,content
          FROM items ORDER BY document_id,sequence,id`).all<Record<string, unknown>>(),
        db.prepare(`SELECT id,status,stage,model,completed,total,rejected,source_digest,
          started_at,updated_at,completed_at FROM redaction_jobs
          ORDER BY started_at DESC,id DESC LIMIT 2`).all<Record<string, unknown>>(),
        db.prepare(`SELECT id,item_id,document_id,start_offset,end_offset,category,confidence,reason,
          review_state,uncertainty_reason,status,created_by,created_at,updated_at
          FROM redactions WHERE id=?`).bind(id).first<Record<string, unknown>>(),
      ]);
      return {
        sourceRevision: Number(sourceRevisionRow?.story_source_revision),
        sourceRows: sourceResult.results,
        jobs: jobResult.results,
        candidate: candidate || undefined,
      };
    });
  } catch {
    return Response.json({
      error: "Source Privacy decision conflicted",
      code: SOURCE_PRIVACY_ERROR.mutationConflict,
    }, { status: 409 });
  }
  if (!snapshot.candidate) return Response.json({
    error: "Redaction not found",
    code: SOURCE_PRIVACY_ERROR.notFound,
  }, { status: 404 });
  if (snapshot.candidate.review_state !== "needs_confirmation") {
    return Response.json({
      error: "Only a pending redaction can receive a decision",
      code: SOURCE_PRIVACY_ERROR.notActionable,
    }, { status: 409 });
  }
  const sourceDigest = await computeSourceDigest(snapshot.sourceRows);
  const job = snapshot.jobs[0];
  if (!Number.isSafeInteger(snapshot.sourceRevision) || snapshot.sourceRevision < 0
      || snapshot.jobs.length !== 1 || job.status !== "complete"
      || Number(job.completed) !== Number(job.total) || Number(job.rejected) !== 0
      || job.source_digest !== sourceDigest) {
    return Response.json({
      error: "Source Privacy decision conflicted",
      code: SOURCE_PRIVACY_ERROR.mutationConflict,
    }, { status: 409 });
  }
  const candidate = snapshot.candidate;
  let updated: Record<string, unknown>;
  try {
    updated = await db.transaction(async () => {
      const [guard, result] = await db.batch([
        storySourceGenerationGuardStatement(
          db,
          authority.workflowRunId,
          snapshot.sourceRevision,
        ),
        db.prepare(`UPDATE redactions
            SET review_state=?,status=?,created_by='contributor',updated_at=?
          WHERE id=? AND item_id=? AND document_id=? AND start_offset=? AND end_offset=?
            AND category=? AND confidence IS ? AND reason IS ?
            AND review_state='needs_confirmation' AND uncertainty_reason IS ?
            AND status=? AND created_by=? AND created_at=? AND updated_at=?
            AND EXISTS (SELECT 1 FROM redaction_jobs
              WHERE id=? AND status=? AND stage=? AND model IS ? AND completed=? AND total=?
                AND rejected=? AND source_digest=? AND started_at=? AND updated_at=?
                AND completed_at IS ?)`)
          .bind(
            reviewState, status, now,
            candidate.id, candidate.item_id, candidate.document_id,
            candidate.start_offset, candidate.end_offset, candidate.category,
            candidate.confidence, candidate.reason, candidate.uncertainty_reason,
            candidate.status, candidate.created_by, candidate.created_at, candidate.updated_at,
            job.id, job.status, job.stage, job.model, job.completed, job.total,
            job.rejected, job.source_digest, job.started_at, job.updated_at, job.completed_at,
          ),
      ]);
      if (!guard.success || Number(result.meta.changes) !== 1) {
        throw new Error("Source Privacy decision authority changed");
      }
      await db.batch(activeStoryPrivacyInvalidationStatements(
        db,
        authority.workflowRunId,
        now,
      ));
      const persisted = await db.prepare("SELECT * FROM redactions WHERE id=?").bind(id).first();
      if (!persisted) throw new Error("Source Privacy mutation did not persist");
      return persisted;
    });
  } catch {
    return Response.json({
      error: "Source Privacy decision conflicted",
      code: SOURCE_PRIVACY_ERROR.mutationConflict,
    }, { status: 409 });
  }
  return Response.json(updated);
}

export async function DELETE() {
  const db = await getLocalDatabase();
  const authority = await requireEstablishedWorkflowRun(db);
  if (authority.state !== WORKFLOW_RUN_AUTHORITY.exactRun) {
    return workflowRunErrorResponse(authority);
  }
  return Response.json(
    {
      error: "DELETE is not supported; submit one keep or redact decision",
      code: SOURCE_PRIVACY_ERROR.methodNotAllowed,
    },
    { status: 405, headers: { allow: "PATCH" } },
  );
}
