import { getLocalDatabase } from "../../../../db";
import {
  WORKFLOW_RUN_AUTHORITY,
  requireEstablishedWorkflowRun,
  workflowRunErrorResponse,
} from "../../../../lib/workflow-run-server";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = await getLocalDatabase();
  const authority = await requireEstablishedWorkflowRun(db);
  if (authority.state !== WORKFLOW_RUN_AUTHORITY.exactRun) {
    return workflowRunErrorResponse(authority);
  }
  const document = await db.prepare(
    `SELECT id,kind,title,source_user,source_system,source_timestamp,item_count,
            metadata_json,updated_at,organization_status,formatted_summary_json
       FROM documents WHERE id=?`
  ).bind(id).first<Record<string, unknown>>();
  if (!document) return Response.json({ error: "Not found" }, { status: 404 });
  const { results: items } = await db.prepare(
    `SELECT id,sequence,event_type,actor_id,actor_type,timestamp,content,
            organization_category,organization_confidence,organization_reason
       FROM items WHERE document_id=? ORDER BY sequence`
  ).bind(id).all();
  document.metadata = JSON.parse(String(document.metadata_json || "{}"));
  document.formatted_summary = JSON.parse(String(document.formatted_summary_json || "{}"));
  delete document.metadata_json;
  delete document.formatted_summary_json;
  return Response.json({ document, items });
}
