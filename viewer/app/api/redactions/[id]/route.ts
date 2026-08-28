import { getLocalDatabase } from "../../../../db";
import {
  WORKFLOW_RUN_AUTHORITY,
  requireEstablishedWorkflowRun,
  workflowRunErrorResponse,
} from "../../../../lib/workflow-run-server";
import { activeStoryPrivacyInvalidationStatements } from "../../../../lib/story-source-publication";

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
  let mutation: { updated?: Record<string, unknown>; exists: boolean };
  try {
    mutation = await db.transaction(async () => {
      const result = await db.prepare(
        `UPDATE redactions
            SET review_state=?, status=?, created_by='contributor', updated_at=?
          WHERE id=? AND review_state='needs_confirmation'`
      ).bind(reviewState, status, now, id).run();
      if (Number(result.meta.changes) !== 1) {
        const existing = await db.prepare("SELECT id FROM redactions WHERE id=?").bind(id).first();
        return { exists: Boolean(existing) };
      }
      await db.batch(activeStoryPrivacyInvalidationStatements(
        db,
        authority.workflowRunId,
        now,
      ));
      const updated = await db.prepare("SELECT * FROM redactions WHERE id=?").bind(id).first();
      if (!updated) throw new Error("Source Privacy mutation did not persist");
      return { exists: true, updated };
    });
  } catch {
    return Response.json({
      error: "Source Privacy decision conflicted",
      code: SOURCE_PRIVACY_ERROR.mutationConflict,
    }, { status: 409 });
  }
  if (!mutation.updated) {
    if (!mutation.exists) return Response.json({
      error: "Redaction not found",
      code: SOURCE_PRIVACY_ERROR.notFound,
    }, { status: 404 });
    return Response.json({
      error: "Only a pending redaction can receive a decision",
      code: SOURCE_PRIVACY_ERROR.notActionable,
    }, { status: 409 });
  }
  return Response.json(mutation.updated);
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
