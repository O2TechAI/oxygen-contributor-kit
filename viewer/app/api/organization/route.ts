import { getD1 } from "../../../db";

const JOB_ID = "default";
const BATCH_SIZE = 250;

type Row = {
  id: string; document_id: string; event_type: string | null;
  actor_type: string | null; content: string; original_json: string;
};

function classify(row: Row, primaryProject: string) {
  const type = row.event_type || "record";
  if (["system", "artifact", "tool_call", "tool_result"].includes(type)) {
    return [primaryProject, 72, `Supporting ${type.replace("_", " ")} activity for the surrounding project work`] as const;
  }
  return [primaryProject, 80, "Assigned to the dominant project in this conversation; review this label if the thread changes topics"] as const;
}

async function status(db: Awaited<ReturnType<typeof getD1>>) {
  const job = await db.prepare("SELECT * FROM organization_jobs WHERE id=?").bind(JOB_ID).first<Record<string, unknown>>();
  const counts = await db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN organization_category IS NOT NULL THEN 1 ELSE 0 END) AS completed
       FROM items`
  ).first<{ total: number; completed: number }>();
  const documents = await db.prepare("SELECT COUNT(*) AS count FROM documents").first<{ count: number }>();
  const total = Number(counts?.total || 0);
  const completed = Number(counts?.completed || 0);
  const recordedStatus = String(job?.status || (total ? "idle" : "empty"));
  return {
    status: total && completed < total && recordedStatus === "complete" ? "idle" : recordedStatus,
    stage: job?.stage || "discover",
    completed,
    total,
    percent: total ? Math.round(completed / total * 100) : 0,
    documentCount: Number(documents?.count || 0),
    warnings: JSON.parse(String(job?.warnings_json || "[]")),
  };
}

export async function GET(request: Request) {
  void request;
  return Response.json(await status(await getD1()));
}

export async function POST(request: Request) {
  const db = await getD1();
  const now = new Date().toISOString();
  const body = await request.json().catch(() => ({})) as { restart?: boolean };
  if (body.restart) {
    await db.batch([
      db.prepare("UPDATE items SET organization_category=NULL, organization_confidence=NULL, organization_reason=NULL"),
      db.prepare("UPDATE documents SET organization_status='pending', formatted_summary_json='{}'"),
      db.prepare("DELETE FROM organization_jobs WHERE id=?").bind(JOB_ID),
    ]);
  }
  const totalRow = await db.prepare("SELECT COUNT(*) AS count FROM items").first<{ count: number }>();
  const total = Number(totalRow?.count || 0);
  await db.prepare(
    `INSERT INTO organization_jobs
      (id,status,stage,completed,total,warnings_json,started_at,updated_at)
     VALUES (?,'running','classify',0,?,'[]',?,?)
     ON CONFLICT(id) DO UPDATE SET status='running',stage='classify',total=excluded.total,updated_at=excluded.updated_at`
  ).bind(JOB_ID, total, now, now).run();

  const primaryRow = await db.prepare(
    `SELECT metadata_json FROM documents ORDER BY item_count DESC LIMIT 1`
  ).first<{ metadata_json: string }>();
  const primaryMetadata = JSON.parse(String(primaryRow?.metadata_json || "{}"));
  const primaryProject = String(
    primaryMetadata?.project_organization?.primary_project || "Primary project"
  );
  const { results } = await db.prepare(
    `SELECT id, document_id, event_type, actor_type, content, original_json
       FROM items WHERE organization_category IS NULL
      ORDER BY document_id, sequence LIMIT ?`
  ).bind(BATCH_SIZE).all<Row>();
  if (results.length) {
    await db.batch(results.map((row) => {
      const [category, confidence, reason] = classify(row, primaryProject);
      return db.prepare(
        "UPDATE items SET organization_category=?,organization_confidence=?,organization_reason=? WHERE id=?"
      ).bind(category, confidence, reason, row.id);
    }));
  }

  const remaining = await db.prepare(
    "SELECT COUNT(*) AS count FROM items WHERE organization_category IS NULL"
  ).first<{ count: number }>();
  const completed = total - Number(remaining?.count || 0);
  if (completed < total) {
    await db.prepare("UPDATE organization_jobs SET completed=?,updated_at=? WHERE id=?")
      .bind(completed, now, JOB_ID).run();
    return Response.json(await status(db));
  }

  const { results: docs } = await db.prepare(
      `SELECT id,title,kind,source_user,source_system,source_timestamp,item_count,metadata_json
       FROM documents ORDER BY source_timestamp,title`
  ).all<Record<string, unknown>>();
  for (const doc of docs) {
    const { results: categoryRows } = await db.prepare(
      `SELECT organization_category AS category, COUNT(*) AS count
         FROM items WHERE document_id=? GROUP BY organization_category`
    ).bind(doc.id).all<{ category: string; count: number }>();
    const metadata = JSON.parse(String(doc.metadata_json || "{}"));
    const primary = String(metadata?.project_organization?.primary_project || primaryProject);
    const { results: highlights } = await db.prepare(
      `SELECT id,sequence,timestamp,organization_category AS project,content,
              organization_confidence AS confidence,organization_reason AS summary
         FROM items
        WHERE document_id=?
          AND event_type IN ('message','record','git') AND LENGTH(TRIM(content)) > 20
        ORDER BY COALESCE(timestamp,''),sequence`
    ).bind(doc.id).all();
    const range = await db.prepare(
      "SELECT MIN(timestamp) AS started_at,MAX(timestamp) AS ended_at FROM items WHERE document_id=? AND timestamp IS NOT NULL"
    ).bind(doc.id).first();
    const summary = {
      title: doc.title, kind: doc.kind, source_user: doc.source_user,
      source_system: doc.source_system, source_timestamp: doc.source_timestamp,
      item_count: doc.item_count,
      time_range: range,
      primary_project: primary,
      project_summary: metadata?.project_organization?.summary || "",
      projects: categoryRows.map((row) => ({
        name: row.category, event_count: row.count, primary: row.category === primary,
      })).sort((a, b) => Number(b.primary) - Number(a.primary) || b.event_count - a.event_count),
      categories: Object.fromEntries(categoryRows.map((row) => [row.category, row.count])),
      highlights: highlights.map((value) => ({
        ...value,
        content: String(value.content || "").replace(/\s+/g, " ").slice(0, 320),
      })),
    };
    await db.prepare(
      "UPDATE documents SET organization_status='complete',formatted_summary_json=? WHERE id=?"
    ).bind(JSON.stringify(summary), doc.id).run();
  }
  await db.prepare(
    "UPDATE organization_jobs SET status='complete',stage='complete',completed=?,updated_at=?,completed_at=? WHERE id=?"
  ).bind(total, now, now, JOB_ID).run();
  return Response.json(await status(db));
}
