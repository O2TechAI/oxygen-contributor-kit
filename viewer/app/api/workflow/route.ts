import { getD1 } from "../../../db";
import { deriveWorkflowProgress } from "../../../lib/workflow-progress";

type CountRow = { total: number; completed: number };
type JobRow = { id?: string; status?: string; updated_at?: string };

export async function GET() {
  const db = await getD1();
  const [items, documents, organization, redaction, chapters] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN organization_category IS NOT NULL THEN 1 ELSE 0 END) AS completed
      FROM items`).first<CountRow>(),
    db.prepare("SELECT COUNT(*) AS total FROM documents").first<{ total: number }>(),
    db.prepare("SELECT id,status,updated_at FROM organization_jobs ORDER BY updated_at DESC LIMIT 1").first<JobRow>(),
    db.prepare("SELECT id,status,updated_at FROM redaction_jobs ORDER BY started_at DESC LIMIT 1").first<JobRow>(),
    db.prepare("SELECT COUNT(*) AS total FROM items WHERE organization_reason LIKE 'oxygen.story-highlight/2:%'").first<{ total: number }>(),
  ]);
  const updatedAt = [organization?.updated_at, redaction?.updated_at]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) || null;
  return Response.json(deriveWorkflowProgress({
    workflowRunId: JSON.stringify([organization?.id || null, redaction?.id || null]),
    documentCount: Number(documents?.total || 0),
    itemCount: Number(items?.total || 0),
    organizedItemCount: Number(items?.completed || 0),
    organizationStatus: organization?.status || null,
    redactionStatus: redaction?.status || null,
    storyChapterCount: Number(chapters?.total || 0),
    updatedAt,
  }));
}
