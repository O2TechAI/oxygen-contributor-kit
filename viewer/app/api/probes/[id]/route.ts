import { getLocalDatabase } from "../../../../db";
import {
  WORKFLOW_RUN_AUTHORITY,
  requireEstablishedWorkflowRun,
  workflowRunErrorResponse,
} from "../../../../lib/workflow-run-server";
import { readCurrentPreferenceLifecycle } from "../../../../lib/story-release-server";

// Record, change, or withdraw one answer. Only an explicit answer becomes a
// confirmed preference -- clearing it returns the probe to unanswered rather
// than recording "no".
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = await getLocalDatabase();
  const authority = await requireEstablishedWorkflowRun(db);
  if (authority.state !== WORKFLOW_RUN_AUTHORITY.exactRun) {
    return workflowRunErrorResponse(authority);
  }
  const currentAuthoritySql = `EXISTS (SELECT 1 FROM workflow_runs workflow
    JOIN probe_runs probe_run ON probe_run.workflow_run_id=workflow.id
    WHERE workflow.id=? AND workflow.story_generation_status='ready_for_human_review'
      AND probe_run.status='complete' AND probe_run.stage='preference'
      AND workflow.story_source_revision>0 AND probe_run.source_revision>0
      AND probe_run.source_revision=workflow.story_source_revision)`;
  const currentAuthority = await db.prepare(`SELECT 1 AS current
    WHERE ${currentAuthoritySql}`).bind(authority.workflowRunId).first();
  if (!currentAuthority) {
    return Response.json({ error: "Preference source authority is stale" }, { status: 409 });
  }
  const body = await request.json() as {
    choice?: string | null;
    text?: string | null;
    clear?: boolean;
    bulk?: boolean;
  };

  const now = new Date().toISOString();
  try {
    return await db.transaction(async () => {
  if (body.bulk) {
    const decision = await db.prepare(
      "SELECT id FROM probe_bulk_decisions WHERE id=?").bind(id).first();
    if (!decision) return Response.json({ error: "Bulk decision not found" }, { status: 404 });
    if (body.clear) {
      const updated = await db.prepare(`UPDATE probe_bulk_decisions
        SET answer=NULL,answered_at=NULL WHERE id=? AND ${currentAuthoritySql}`)
        .bind(id, authority.workflowRunId).run();
      if (Number(updated.meta.changes || 0) !== 1) {
        return Response.json({ error: "Preference source authority is stale" }, { status: 409 });
      }
    } else {
      if (!["remove", "keep", "inspect"].includes(String(body.choice))) {
        return Response.json(
          { error: "Bulk answer must be 'remove', 'keep' or 'inspect'" }, { status: 400 });
      }
      const updated = await db.prepare(`UPDATE probe_bulk_decisions
        SET answer=?,answered_at=? WHERE id=? AND ${currentAuthoritySql}`)
        .bind(body.choice, now, id, authority.workflowRunId).run();
      if (Number(updated.meta.changes || 0) !== 1) {
        return Response.json({ error: "Preference source authority is stale" }, { status: 409 });
      }
    }
    await db.prepare("DELETE FROM project_release_confirmations WHERE workflow_run_id=?")
      .bind(authority.workflowRunId).run();
    const updated = await db.prepare(
      "SELECT * FROM probe_bulk_decisions WHERE id=?").bind(id).first();
    return Response.json(updated);
  }

  const lifecycle = await readCurrentPreferenceLifecycle(db, authority.workflowRunId);
  const current = lifecycle.ok
    ? lifecycle.current.find((item) => item.id === id && item.lifecycle_status === "active") : null;
  if (!current) return Response.json({ error: "Preference requires an accepted unchanged Insight" }, { status: 409 });
  const probe = await db.prepare(
    "SELECT options_json FROM probes WHERE id=?").bind(id).first<{ options_json: string }>();
  if (!probe) return Response.json({ error: "Probe not found" }, { status: 404 });

  if (body.clear) {
    const updated = await db.prepare(`UPDATE probes
      SET answer_choice=NULL,answer_text=NULL,answered_at=NULL
      WHERE id=? AND ${currentAuthoritySql}`).bind(id, authority.workflowRunId).run();
    if (Number(updated.meta.changes || 0) !== 1) {
      return Response.json({ error: "Preference source authority is stale" }, { status: 409 });
    }
    await db.prepare("DELETE FROM project_release_confirmations WHERE workflow_run_id=?")
      .bind(authority.workflowRunId).run();
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

  const updated = await db.prepare(`UPDATE probes
    SET answer_choice=?,answer_text=?,answered_at=? WHERE id=? AND ${currentAuthoritySql}`)
    .bind(
      body.choice,
      body.choice === "other" ? String(body.text).trim() : null,
      now,
      id,
      authority.workflowRunId,
    ).run();
  if (Number(updated.meta.changes || 0) !== 1) {
    return Response.json({ error: "Preference source authority is stale" }, { status: 409 });
  }
  await db.prepare("DELETE FROM project_release_confirmations WHERE workflow_run_id=?")
    .bind(authority.workflowRunId).run();

  return Response.json(await db.prepare("SELECT * FROM probes WHERE id=?").bind(id).first());
    });
  } catch {
    return Response.json({ error: "Preference answer conflicted" }, { status: 409 });
  }
}
