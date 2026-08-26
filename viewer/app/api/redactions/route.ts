import { getD1 } from "../../../db";
import {
  computeSourceDigest,
  finalRedactionStatus,
  partitionPersistableRedactions,
} from "../../../lib/redaction-pass.mjs";
import {
  WORKFLOW_RUN_AUTHORITY,
  requireEstablishedWorkflowRun,
  workflowRunErrorResponse,
} from "../../../lib/workflow-run-server";

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
  const authority = await requireEstablishedWorkflowRun(db);
  if (authority.state !== WORKFLOW_RUN_AUTHORITY.exactRun) {
    return workflowRunErrorResponse(authority);
  }
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
  const authority = await requireEstablishedWorkflowRun(db);
  if (authority.state !== WORKFLOW_RUN_AUTHORITY.exactRun) {
    return workflowRunErrorResponse(authority);
  }
  const body = await request.json() as {
    job?: { status: string; stage: string; model?: string; total?: number; rejected?: number };
    redactions?: IncomingRedaction[];
    replaceAll?: boolean;
  };
  const incoming = body.redactions || [];
  if (!body.job) {
    return Response.json({ error: "A redaction pass job is required" }, { status: 400 });
  }
  const total = Number(body.job.total ?? incoming.length);
  const reportedRejected = Number(body.job.rejected ?? 0);
  if (!Number.isInteger(total) || total < 0
      || !Number.isInteger(reportedRejected) || reportedRejected < 0) {
    return Response.json({ error: "Redaction totals must be non-negative integers" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const jobId = crypto.randomUUID();
  const begin = [
    db.prepare("DELETE FROM redaction_jobs"),
    db.prepare(
      `INSERT INTO redaction_jobs
        (id,status,stage,model,completed,total,rejected,source_digest,
         started_at,updated_at,completed_at)
       VALUES (?,'running','validating',?,0,?,?,NULL,?,?,NULL)`
    ).bind(
      jobId, body.job.model || null, total, reportedRejected, now, now,
    ),
  ];
  if (body.replaceAll) {
    // Replacing a pass invalidates the prior completion state and span set in
    // the same transaction. Any interruption after this point stays running.
    begin.push(db.prepare("DELETE FROM redactions"));
  }
  await db.batch(begin);

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
      db.prepare("SELECT length(content) AS len,document_id FROM items WHERE id=?").bind(span.itemId)));
    chunk.forEach((span, index) => {
      const row = rows[index]?.results?.[0] as { len?: number; document_id?: string } | undefined;
      const length = row?.len;
      if (length === undefined) {
        rejected.push({ itemId: span.itemId, reason: "unknown item" });
      } else if (row?.document_id !== span.documentId) {
        rejected.push({ itemId: span.itemId, reason: "document does not own item" });
      } else if (span.endOffset > length) {
        rejected.push({ itemId: span.itemId, reason: `offset beyond content length ${length}` });
      } else {
        verified.push(span);
      }
    });
  }

  // merge_and_apply rejects overlaps, but keep the API safe for any other
  // importer as well. Offsets are Unicode code points, matching SQLite length().
  verified.sort((a, b) => a.itemId.localeCompare(b.itemId)
    || a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  const nonOverlapping: IncomingRedaction[] = [];
  const lastEnd = new Map<string, number>();
  for (const span of verified) {
    if (span.startOffset < (lastEnd.get(span.itemId) || 0)) {
      rejected.push({ itemId: span.itemId, reason: "overlaps an earlier span" });
      continue;
    }
    nonOverlapping.push(span);
    lastEnd.set(span.itemId, span.endOffset);
  }

  // A repeated primary key would overwrite an earlier row while inflating the
  // completed count. Count only spans that can remain distinct after commit.
  const { persistable, duplicates } = partitionPersistableRedactions(nonOverlapping);
  for (const span of duplicates) {
    rejected.push({ itemId: span.itemId, reason: `duplicate redaction id ${span.id}` });
  }

  const sourceResult = await db.prepare(
    `SELECT document_id,id,sequence,event_type,actor_type,timestamp,content
       FROM items ORDER BY document_id,sequence,id`
  ).all<Record<string, unknown>>();
  const sourceDigest = await computeSourceDigest(sourceResult.results);

  for (let start = 0; start < persistable.length; start += 75) {
    await db.batch(persistable.slice(start, start + 75).map((span) => db.prepare(
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

  const rejectedCount = reportedRejected + rejected.length;
  const status = finalRedactionStatus({
    requestedStatus: body.job.status,
    completed: persistable.length,
    total,
    rejected: rejectedCount,
    sourceDigest,
  });
  const finishedAt = new Date().toISOString();
  await db.prepare(
    `UPDATE redaction_jobs
        SET status=?,stage=?,completed=?,total=?,rejected=?,source_digest=?,
            updated_at=?,completed_at=?
      WHERE id=?`
  ).bind(
    status,
    status === "complete" ? body.job.stage : status,
    persistable.length,
    total,
    rejectedCount,
    sourceDigest,
    finishedAt,
    status === "complete" ? finishedAt : null,
    jobId,
  ).run();

  return Response.json({ imported: persistable.length, rejected, status });
}
