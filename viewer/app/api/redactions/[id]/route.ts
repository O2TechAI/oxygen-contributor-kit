import { getLocalDatabase } from "../../../../db";
import {
  WORKFLOW_RUN_AUTHORITY,
  requireEstablishedWorkflowRun,
  workflowRunErrorResponse,
} from "../../../../lib/workflow-run-server";

const DECISIONS = new Set(["keep", "redact"]);

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = await getLocalDatabase();
  const authority = await requireEstablishedWorkflowRun(db);
  if (authority.state !== WORKFLOW_RUN_AUTHORITY.exactRun) {
    return workflowRunErrorResponse(authority);
  }
  const body = await request.json() as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).length !== 1 || !("decision" in body)
      || !DECISIONS.has(String((body as { decision?: unknown }).decision || ""))) {
    return Response.json({ error: "Exactly one keep or redact decision is required" }, { status: 400 });
  }
  const decision = String((body as { decision: unknown }).decision);
  const reviewState = decision === "keep" ? "confirmed_keep" : "confirmed_redact";
  const status = decision === "keep" ? "removed" : "active";
  const result = await db.prepare(
    `UPDATE redactions
        SET review_state=?, status=?, created_by='contributor', updated_at=?
      WHERE id=? AND review_state='needs_confirmation'`
  ).bind(
    reviewState, status, new Date().toISOString(), id,
  ).run();
  if (Number(result.meta.changes) !== 1) {
    const existing = await db.prepare("SELECT id,review_state FROM redactions WHERE id=?").bind(id).first();
    if (!existing) return Response.json({ error: "Redaction not found" }, { status: 404 });
    return Response.json({ error: "Only a pending redaction can receive a decision" }, { status: 409 });
  }

  const updated = await db.prepare("SELECT * FROM redactions WHERE id=?").bind(id).first();
  return Response.json(updated);
}

export async function DELETE() {
  const db = await getLocalDatabase();
  const authority = await requireEstablishedWorkflowRun(db);
  if (authority.state !== WORKFLOW_RUN_AUTHORITY.exactRun) {
    return workflowRunErrorResponse(authority);
  }
  return Response.json(
    { error: "DELETE is not supported; submit one keep or redact decision" },
    { status: 405, headers: { allow: "PATCH" } },
  );
}
