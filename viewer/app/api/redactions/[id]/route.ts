import { getLocalDatabase } from "../../../../db";
import {
  WORKFLOW_RUN_AUTHORITY,
  requireEstablishedWorkflowRun,
  workflowRunErrorResponse,
} from "../../../../lib/workflow-run-server";
import { computeSourceDigest } from "../../../../lib/redaction-pass.mjs";
import {
  validActivatedSourceRevision,
  validNonnegativeAuthorityCounter,
} from "../../../../lib/authority-validation.mjs";
import {
  buildCurrentSourcePrivacyDialogue,
  validateStoredSourcePrivacyReceipt,
  type CurrentSourceRow,
  type PersistedSourcePrivacyRedaction,
} from "../../../../lib/source-privacy-receipt";
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
  const db = await getLocalDatabase();
  const authority = await requireEstablishedWorkflowRun(db);
  if (authority.state !== WORKFLOW_RUN_AUTHORITY.exactRun) {
    return workflowRunErrorResponse(authority);
  }
  const now = new Date().toISOString();
  let outcome: { kind: "success"; updated: Record<string, unknown> }
    | { kind: "notFound" } | { kind: "notActionable" } | { kind: "conflict" };
  try {
    outcome = await db.transaction(async () => {
      const [sourceRevisionRow, sourceResult, jobResult, receiptResult, redactionResult,
        candidate] = await Promise.all([
        db.prepare(`SELECT r.story_source_revision,f.corpus_revision,f.corpus_digest,
          f.document_count,f.item_count,
          (SELECT COUNT(*) FROM workflow_runs) AS current_run_count,
          (SELECT COUNT(*) FROM documents) AS current_document_count,
          (SELECT COUNT(*) FROM items) AS current_item_count
          FROM workflow_runs r LEFT JOIN finalized_corpus_manifests f ON f.workflow_run_id=r.id
          WHERE r.id=?`)
          .bind(authority.workflowRunId).first<Record<string, unknown>>(),
        db.prepare(`SELECT i.document_id,d.kind AS document_kind,i.id,i.sequence,i.event_type,
          i.actor_type,i.timestamp,i.content,i.original_json
          FROM items i LEFT JOIN documents d ON d.id=i.document_id
          ORDER BY i.document_id,i.sequence,i.id`).all<Record<string, unknown>>(),
        db.prepare(`SELECT j.id,j.status,j.stage,j.model,j.completed,j.total,j.rejected,
          p.source_revision,j.source_digest,p.receipt_digest,j.started_at,j.updated_at,j.completed_at
          FROM redaction_jobs j LEFT JOIN source_privacy_receipts p ON p.job_id=j.id
          ORDER BY j.started_at DESC,j.id DESC LIMIT 2`).all<Record<string, unknown>>(),
        db.prepare(`SELECT job_id,workflow_run_id,source_revision,source_digest,receipt_digest,
          receipt_json,created_at FROM source_privacy_receipts ORDER BY job_id`)
          .all<Record<string, unknown>>(),
        db.prepare(`SELECT id,item_id,document_id,start_offset,end_offset,category,confidence,reason,
          review_state,uncertainty_reason,status,created_by,created_at,updated_at
          FROM redactions ORDER BY document_id,item_id,start_offset,id`)
          .all<Record<string, unknown>>(),
        db.prepare(`SELECT id,item_id,document_id,start_offset,end_offset,category,confidence,reason,
          review_state,uncertainty_reason,status,created_by,created_at,updated_at
          FROM redactions WHERE id=?`).bind(id).first<Record<string, unknown>>(),
      ]);
      if (!candidate) return { kind: "notFound" };
      if (candidate.review_state !== "needs_confirmation") return { kind: "notActionable" };
      const sourceRevision = Number(sourceRevisionRow?.story_source_revision);
      const corpusRevision = Number(sourceRevisionRow?.corpus_revision);
      const documentCount = Number(sourceRevisionRow?.document_count);
      const itemCount = Number(sourceRevisionRow?.item_count);
      const job = jobResult.results[0];
      const completed = Number(job?.completed);
      const total = Number(job?.total);
      const rejected = Number(job?.rejected);
      const sourceDigest = await computeSourceDigest(sourceResult.results);
      let dialogue;
      try {
        dialogue = await buildCurrentSourcePrivacyDialogue(
          sourceResult.results as unknown as CurrentSourceRow[],
        );
      } catch {
        return { kind: "conflict" };
      }
      if (Number(sourceRevisionRow?.current_run_count) !== 1
          || !validActivatedSourceRevision(sourceRevision)
          || !validActivatedSourceRevision(corpusRevision)
          || !/^[0-9a-f]{64}$/u.test(String(sourceRevisionRow?.corpus_digest || ""))
          || !Number.isSafeInteger(documentCount) || documentCount < 0
          || !Number.isSafeInteger(itemCount) || itemCount < 0
          || Number(sourceRevisionRow?.current_document_count) !== documentCount
          || Number(sourceRevisionRow?.current_item_count) !== itemCount
          || sourceResult.results.length !== itemCount
          || jobResult.results.length !== 1 || job.status !== "complete"
          || !validNonnegativeAuthorityCounter(completed)
          || !validNonnegativeAuthorityCounter(total)
          || !validNonnegativeAuthorityCounter(rejected)
          || completed !== total || completed !== redactionResult.results.length || rejected !== 0
          || Number(job.source_revision) !== sourceRevision
          || job.source_digest !== sourceDigest
          || !/^[0-9a-f]{64}$/u.test(String(job.receipt_digest || ""))
          || receiptResult.results.length !== 1) {
        return { kind: "conflict" };
      }
      const receipt = await validateStoredSourcePrivacyReceipt(receiptResult.results[0], {
        jobId: String(job.id),
        workflowRunId: authority.workflowRunId,
        sourceRevision,
        sourceDigest,
        finalizedCorpus: {
          revision: corpusRevision,
          digest: String(sourceRevisionRow?.corpus_digest),
          documentCount,
          itemCount,
        },
        dialogue,
        redactions: redactionResult.results as unknown as PersistedSourcePrivacyRedaction[],
      });
      if (!receipt) return { kind: "conflict" };
      const [guard, result] = await db.batch([
        storySourceGenerationGuardStatement(
          db,
          authority.workflowRunId,
          sourceRevision,
        ),
        db.prepare(`UPDATE redactions
            SET review_state=?,status=?,created_by='contributor',updated_at=?
          WHERE id=? AND item_id=? AND document_id=? AND start_offset=? AND end_offset=?
            AND category=? AND confidence IS ? AND reason IS ?
            AND review_state='needs_confirmation' AND uncertainty_reason IS ?
            AND status=? AND created_by=? AND created_at=? AND updated_at=?
            AND EXISTS (SELECT 1 FROM redaction_jobs j
              JOIN source_privacy_receipts p ON p.job_id=j.id
              WHERE j.id=? AND j.status=? AND j.stage=? AND j.model IS ?
                AND j.completed=? AND j.total=? AND j.rejected=?
                AND p.workflow_run_id=? AND p.source_revision=? AND j.source_digest=?
                AND p.source_digest=? AND p.receipt_digest=? AND p.receipt_json=?
                AND p.created_at=?
                AND j.started_at=? AND j.updated_at=? AND j.completed_at IS ?)`)
          .bind(
            reviewState, status, now,
            candidate.id, candidate.item_id, candidate.document_id,
            candidate.start_offset, candidate.end_offset, candidate.category,
            candidate.confidence, candidate.reason, candidate.uncertainty_reason,
            candidate.status, candidate.created_by, candidate.created_at, candidate.updated_at,
            job.id, job.status, job.stage, job.model, job.completed, job.total,
            job.rejected, authority.workflowRunId, job.source_revision, job.source_digest,
            receiptResult.results[0].source_digest, job.receipt_digest,
            receiptResult.results[0].receipt_json, receiptResult.results[0].created_at,
            job.started_at, job.updated_at, job.completed_at,
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
      return { kind: "success", updated: persisted };
    });
  } catch {
    outcome = { kind: "conflict" };
  }
  if (outcome.kind === "notFound") return Response.json({
    error: "Redaction not found",
    code: SOURCE_PRIVACY_ERROR.notFound,
  }, { status: 404 });
  if (outcome.kind === "notActionable") return Response.json({
    error: "Only a pending redaction can receive a decision",
    code: SOURCE_PRIVACY_ERROR.notActionable,
  }, { status: 409 });
  if (outcome.kind === "conflict") return Response.json({
    error: "Source Privacy decision conflicted",
    code: SOURCE_PRIVACY_ERROR.mutationConflict,
  }, { status: 409 });
  return Response.json(outcome.updated);
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
