import { getLocalDatabase } from "../../../../db";
import {
  WORKFLOW_RUN_AUTHORITY,
  requireEstablishedWorkflowRun,
  workflowRunErrorResponse,
} from "../../../../lib/workflow-run-server";

const ALLOWED_CATEGORIES = new Set([
  "credential",
  "private-personal",
  "sensitive",
  "internal-metric",
  "internal-timeline",
  "mosaic-reidentification",
]);

// Edit one decision: change its category, or reinstate one that was removed.
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = await getLocalDatabase();
  const authority = await requireEstablishedWorkflowRun(db);
  if (authority.state !== WORKFLOW_RUN_AUTHORITY.exactRun) {
    return workflowRunErrorResponse(authority);
  }
  const body = await request.json() as { category?: string; status?: string; reason?: string };

  if (body.category && !ALLOWED_CATEGORIES.has(body.category)) {
    return Response.json({ error: "Category is not in the allowlist" }, { status: 400 });
  }
  if (body.status && !["active", "removed"].includes(body.status)) {
    return Response.json({ error: "status must be 'active' or 'removed'" }, { status: 400 });
  }

  const existing = await db.prepare("SELECT id FROM redactions WHERE id=?").bind(id).first();
  if (!existing) return Response.json({ error: "Redaction not found" }, { status: 404 });

  await db.prepare(
    `UPDATE redactions
        SET category=COALESCE(?,category), status=COALESCE(?,status),
            reason=COALESCE(?,reason), created_by='contributor', updated_at=?
      WHERE id=?`
  ).bind(
    body.category || null, body.status || null, body.reason || null,
    new Date().toISOString(), id,
  ).run();

  const updated = await db.prepare("SELECT * FROM redactions WHERE id=?").bind(id).first();
  return Response.json(updated);
}

// Soft delete: the span stops being applied but the decision stays auditable.
// Pass ?hard=1 to drop the row outright.
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = await getLocalDatabase();
  const authority = await requireEstablishedWorkflowRun(db);
  if (authority.state !== WORKFLOW_RUN_AUTHORITY.exactRun) {
    return workflowRunErrorResponse(authority);
  }
  const hard = new URL(request.url).searchParams.get("hard") === "1";

  const existing = await db.prepare("SELECT id FROM redactions WHERE id=?").bind(id).first();
  if (!existing) return Response.json({ error: "Redaction not found" }, { status: 404 });

  if (hard) {
    await db.prepare("DELETE FROM redactions WHERE id=?").bind(id).run();
  } else {
    await db.prepare(
      "UPDATE redactions SET status='removed', created_by='contributor', updated_at=? WHERE id=?"
    ).bind(new Date().toISOString(), id).run();
  }
  return Response.json({ id, deleted: hard ? "hard" : "soft" });
}
