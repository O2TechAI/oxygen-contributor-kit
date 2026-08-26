import { getD1 } from "../../../../db";
import {
  WORKFLOW_RUN_AUTHORITY,
  requireEstablishedWorkflowRun,
  workflowRunErrorResponse,
} from "../../../../lib/workflow-run-server";

// Record, change, or withdraw one answer. Only an explicit answer becomes a
// confirmed preference -- clearing it returns the probe to unanswered rather
// than recording "no".
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = await getD1();
  const authority = await requireEstablishedWorkflowRun(db);
  if (authority.state !== WORKFLOW_RUN_AUTHORITY.exactRun) {
    return workflowRunErrorResponse(authority);
  }
  const body = await request.json() as {
    choice?: string | null;
    text?: string | null;
    clear?: boolean;
    bulk?: boolean;
  };

  const now = new Date().toISOString();

  if (body.bulk) {
    const decision = await db.prepare(
      "SELECT id FROM probe_bulk_decisions WHERE id=?").bind(id).first();
    if (!decision) return Response.json({ error: "Bulk decision not found" }, { status: 404 });
    if (body.clear) {
      await db.prepare(
        "UPDATE probe_bulk_decisions SET answer=NULL, answered_at=NULL WHERE id=?"
      ).bind(id).run();
    } else {
      if (!["remove", "keep", "inspect"].includes(String(body.choice))) {
        return Response.json(
          { error: "Bulk answer must be 'remove', 'keep' or 'inspect'" }, { status: 400 });
      }
      await db.prepare(
        "UPDATE probe_bulk_decisions SET answer=?, answered_at=? WHERE id=?"
      ).bind(body.choice, now, id).run();
    }
    const updated = await db.prepare(
      "SELECT * FROM probe_bulk_decisions WHERE id=?").bind(id).first();
    return Response.json(updated);
  }

  const probe = await db.prepare(
    "SELECT options_json FROM probes WHERE id=?").bind(id).first<{ options_json: string }>();
  if (!probe) return Response.json({ error: "Probe not found" }, { status: 404 });

  if (body.clear) {
    await db.prepare(
      "UPDATE probes SET answer_choice=NULL, answer_text=NULL, answered_at=NULL WHERE id=?"
    ).bind(id).run();
    return Response.json(await db.prepare("SELECT * FROM probes WHERE id=?").bind(id).first());
  }

  const options = JSON.parse(probe.options_json || "[]") as Array<{ id: string }>;
  const validChoice = body.choice === "other" || body.choice === "none"
    || options.some((option) => option.id === body.choice);
  if (!validChoice) {
    return Response.json(
      { error: "Answer must be one of the offered option ids, 'other', or 'none'" },
      { status: 400 });
  }
  if (body.choice === "other" && !String(body.text || "").trim()) {
    return Response.json({ error: "'other' requires text" }, { status: 400 });
  }

  await db.prepare(
    "UPDATE probes SET answer_choice=?, answer_text=?, answered_at=? WHERE id=?"
  ).bind(body.choice, body.choice === "other" ? String(body.text).trim() : null, now, id).run();

  return Response.json(await db.prepare("SELECT * FROM probes WHERE id=?").bind(id).first());
}
