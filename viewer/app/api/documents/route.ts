import { getD1 } from "../../../db";

export async function GET() {
  const db = await getD1();
  const { results } = await db.prepare(
    `SELECT id,kind,title,source_user,source_system,source_timestamp,item_count,
            updated_at,organization_status,formatted_summary_json
       FROM documents ORDER BY source_timestamp,title`
  ).all();
  return Response.json({ documents: results.map((document) => ({
    ...document,
    formatted_summary: JSON.parse(String(document.formatted_summary_json || "{}")),
    formatted_summary_json: undefined,
  })) });
}

export async function POST(request: Request) {
  const db = await getD1();
  const body = await request.json() as {
    document: {
      id: string; kind: "meeting" | "trajectory"; title: string;
      sourceUser?: string; sourceSystem?: string; sourceTimestamp?: string;
      metadata?: unknown; envelope?: unknown; itemCount?: number;
    };
    items: Array<{
      id: string; sequence: number; eventType?: string; actorId?: string;
      actorType?: string; timestamp?: string; content: string; original: unknown;
      organizationCategory?: string; organizationConfidence?: number;
      organizationReason?: string;
    }>;
  };
  const document = body.document;
  if (!document?.id || !["meeting", "trajectory"].includes(document.kind) || !Array.isArray(body.items)) {
    return Response.json({ error: "Invalid import payload" }, { status: 400 });
  }
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO documents
      (id,kind,title,source_user,source_system,source_timestamp,item_count,metadata_json,
       original_envelope_json,imported_at,updated_at,organization_status,formatted_summary_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending','{}')
     ON CONFLICT(id) DO UPDATE SET
       kind=excluded.kind,title=excluded.title,source_user=excluded.source_user,
       source_system=excluded.source_system,source_timestamp=excluded.source_timestamp,
       item_count=excluded.item_count,metadata_json=excluded.metadata_json,
       original_envelope_json=excluded.original_envelope_json,updated_at=excluded.updated_at,
       organization_status='pending',formatted_summary_json='{}'`
  ).bind(
    document.id, document.kind, document.title, document.sourceUser || null,
    document.sourceSystem || null, document.sourceTimestamp || null,
    document.itemCount ?? body.items.length, JSON.stringify(document.metadata || {}),
    JSON.stringify(document.envelope || {}), now, now,
  ).run();
  // Any import invalidates the previous organization summary, including labels
  // supplied by a newly generated project map.
  await db.prepare("DELETE FROM organization_jobs").run();

  for (let start = 0; start < body.items.length; start += 75) {
    await db.batch(body.items.slice(start, start + 75).map((item) => db.prepare(
      `INSERT INTO items
        (id,document_id,sequence,event_type,actor_id,actor_type,timestamp,content,original_json,
         organization_category,organization_confidence,organization_reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         sequence=excluded.sequence,event_type=excluded.event_type,actor_id=excluded.actor_id,
         actor_type=excluded.actor_type,timestamp=excluded.timestamp,content=excluded.content,
         original_json=excluded.original_json,
         organization_category=excluded.organization_category,
         organization_confidence=excluded.organization_confidence,
         organization_reason=excluded.organization_reason`
    ).bind(
      item.id, document.id, item.sequence, item.eventType || null, item.actorId || null,
      item.actorType || null, item.timestamp || null, item.content || "",
      JSON.stringify(item.original), item.organizationCategory || null,
      item.organizationConfidence ?? null, item.organizationReason || null,
    )));
  }
  return Response.json({ id: document.id, imported: body.items.length });
}
