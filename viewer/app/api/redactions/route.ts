import { getD1 } from "../../../db";

type IncomingRedaction = {
  id?: string;
  itemId: string;
  documentId: string;
  startOffset: number;
  endOffset: number;
  category: string;
  confidence?: string;
  reason?: string;
  createdBy?: string;
};

// Mirrors the six categories the redaction policy allows. A worker model that
// invents a seventh must not be able to write it into the review surface.
const ALLOWED_CATEGORIES = new Set([
  "credential",
  "private-personal",
  "sensitive",
  "internal-metric",
  "internal-timeline",
  "mosaic-reidentification",
]);

export async function GET() {
  const db = await getD1();
  const [redactions, job] = await Promise.all([
    db.prepare(
      `SELECT id,item_id,document_id,start_offset,end_offset,category,confidence,reason,
              status,created_by,created_at,updated_at
         FROM redactions WHERE status='active' ORDER BY item_id, start_offset`
    ).all(),
    db.prepare(
      "SELECT * FROM redaction_jobs ORDER BY started_at DESC LIMIT 1"
    ).first(),
  ]);
  return Response.json({ redactions: redactions.results || [], job: job || null });
}

export async function POST(request: Request) {
  const db = await getD1();
  const body = await request.json() as {
    job?: { status: string; stage: string; model?: string; total?: number; rejected?: number };
    redactions?: IncomingRedaction[];
    replaceAll?: boolean;
  };

  const now = new Date().toISOString();

  if (body.job) {
    const complete = body.job.status === "complete";
    await db.prepare("DELETE FROM redaction_jobs").run();
    await db.prepare(
      `INSERT INTO redaction_jobs
        (id,status,stage,model,completed,total,rejected,started_at,updated_at,completed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      crypto.randomUUID(), body.job.status, body.job.stage, body.job.model || null,
      body.redactions?.length ?? 0, body.job.total ?? 0, body.job.rejected ?? 0,
      now, now, complete ? now : null,
    ).run();
  }

  const incoming = body.redactions || [];
  if (body.replaceAll) {
    await db.prepare("DELETE FROM redactions WHERE created_by='llm'").run();
  }

  const rejected: Array<{ itemId: string; reason: string }> = [];
  const accepted: IncomingRedaction[] = [];

  for (const span of incoming) {
    if (!ALLOWED_CATEGORIES.has(span.category)) {
      rejected.push({ itemId: span.itemId, reason: "category not in allowlist" });
      continue;
    }
    if (!(span.startOffset >= 0 && span.endOffset > span.startOffset)) {
      rejected.push({ itemId: span.itemId, reason: "invalid offsets" });
      continue;
    }
    accepted.push(span);
  }

  // Offsets are only meaningful against the stored content, so verify each one
  // rather than trusting the importer.
  const verified: IncomingRedaction[] = [];
  for (let start = 0; start < accepted.length; start += 50) {
    const chunk = accepted.slice(start, start + 50);
    const rows = await db.batch(chunk.map((span) =>
      db.prepare("SELECT length(content) AS len FROM items WHERE id=?").bind(span.itemId)));
    chunk.forEach((span, index) => {
      const length = (rows[index]?.results?.[0] as { len?: number } | undefined)?.len;
      if (length === undefined) {
        rejected.push({ itemId: span.itemId, reason: "unknown item" });
      } else if (span.endOffset > length) {
        rejected.push({ itemId: span.itemId, reason: `offset beyond content length ${length}` });
      } else {
        verified.push(span);
      }
    });
  }

  for (let start = 0; start < verified.length; start += 75) {
    await db.batch(verified.slice(start, start + 75).map((span) => db.prepare(
      `INSERT INTO redactions
        (id,item_id,document_id,start_offset,end_offset,category,confidence,reason,
         status,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,'active',?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         start_offset=excluded.start_offset,end_offset=excluded.end_offset,
         category=excluded.category,confidence=excluded.confidence,
         reason=excluded.reason,updated_at=excluded.updated_at`
    ).bind(
      span.id || crypto.randomUUID(), span.itemId, span.documentId,
      span.startOffset, span.endOffset, span.category,
      span.confidence || null, span.reason || null,
      span.createdBy || "llm", now, now,
    )));
  }

  return Response.json({ imported: verified.length, rejected });
}
