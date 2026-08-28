import { getLocalDatabase } from "../../../db";
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
import { activeStoryPrivacyInvalidationStatements } from "../../../lib/story-source-publication";

type IncomingRedaction = {
  id?: string;
  itemId: string;
  documentId: string;
  startOffset: number;
  endOffset: number;
  category: string;
  confidence?: string;
  reason?: string;
  reviewState?: string;
  uncertaintyReason?: string | null;
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
const ALLOWED_IMPORT_REVIEW_STATES = new Set(["deterministic", "needs_confirmation"]);
const SOURCE_PRIVACY_ERROR = {
  requestInvalid: "SOURCE_PRIVACY_REQUEST_INVALID",
  replacementInvalid: "SOURCE_PRIVACY_REPLACEMENT_INVALID",
  mutationConflict: "SOURCE_PRIVACY_MUTATION_CONFLICT",
} as const;

function invalidRequest(error: string) {
  return Response.json({ error, code: SOURCE_PRIVACY_ERROR.requestInvalid }, { status: 400 });
}

export async function GET() {
  const db = await getLocalDatabase();
  const authority = await requireEstablishedWorkflowRun(db);
  if (authority.state !== WORKFLOW_RUN_AUTHORITY.exactRun) {
    return workflowRunErrorResponse(authority);
  }
  const [redactions, job] = await Promise.all([
    db.prepare(
      `SELECT id,item_id,document_id,start_offset,end_offset,category,confidence,reason,
              review_state,uncertainty_reason,status,created_by,created_at,updated_at
         FROM redactions ORDER BY document_id,item_id,start_offset,id`
    ).all(),
    db.prepare(
      "SELECT * FROM redaction_jobs ORDER BY started_at DESC LIMIT 1"
    ).first(),
  ]);
  return Response.json({ redactions: redactions.results || [], job: job || null });
}

export async function POST(request: Request) {
  const db = await getLocalDatabase();
  const authority = await requireEstablishedWorkflowRun(db);
  if (authority.state !== WORKFLOW_RUN_AUTHORITY.exactRun) {
    return workflowRunErrorResponse(authority);
  }
  let body: {
    job?: { status: string; stage: string; model?: string; total?: number; rejected?: number };
    redactions?: IncomingRedaction[];
    replaceAll?: boolean;
  };
  try {
    const parsed = await request.json() as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return invalidRequest("A valid source Privacy replacement is required");
    }
    body = parsed as typeof body;
  } catch {
    return invalidRequest("A valid source Privacy replacement is required");
  }
  const incoming = body.redactions ?? [];
  if (!body.job || typeof body.job !== "object") {
    return invalidRequest("A redaction pass job is required");
  }
  if (!Array.isArray(incoming)) {
    return invalidRequest("Redactions must be an array");
  }
  if (body.replaceAll !== true) {
    return invalidRequest("Bulk redaction imports must replace all spans");
  }
  const total = Number(body.job.total ?? incoming.length);
  const reportedRejected = Number(body.job.rejected ?? 0);
  if (!Number.isInteger(total) || total < 0
      || !Number.isInteger(reportedRejected) || reportedRejected < 0) {
    return invalidRequest("Redaction totals must be non-negative integers");
  }
  if (body.job.status !== "complete"
      || typeof body.job.stage !== "string" || body.job.stage.length === 0) {
    return invalidRequest("Redaction pass must be complete");
  }

  const rejected: Array<{ itemId: string; reason: string }> = [];
  const accepted: IncomingRedaction[] = [];

  for (const span of incoming) {
    if (!span || typeof span !== "object" || Array.isArray(span)) {
      rejected.push({ itemId: "", reason: "redaction must be an object" });
      continue;
    }
    if (!ALLOWED_CATEGORIES.has(span.category)) {
      rejected.push({ itemId: span.itemId, reason: "category not in allowlist" });
      continue;
    }
    if (!ALLOWED_IMPORT_REVIEW_STATES.has(String(span.reviewState || ""))) {
      rejected.push({ itemId: span.itemId, reason: "invalid or missing review state" });
      continue;
    }
    if (span.reviewState === "deterministic" && span.uncertaintyReason != null) {
      rejected.push({ itemId: span.itemId, reason: "deterministic span cannot have an uncertainty reason" });
      continue;
    }
    if (span.reviewState === "needs_confirmation"
        && (typeof span.uncertaintyReason !== "string" || !span.uncertaintyReason.trim())) {
      rejected.push({ itemId: span.itemId, reason: "pending span requires an uncertainty reason" });
      continue;
    }
    if (typeof span.uncertaintyReason === "string") {
      span.uncertaintyReason = span.uncertaintyReason.trim();
    }
    if (!Number.isInteger(span.startOffset) || !Number.isInteger(span.endOffset)
        || !(span.startOffset >= 0 && span.endOffset > span.startOffset)) {
      rejected.push({ itemId: span.itemId, reason: "invalid offsets" });
      continue;
    }
    accepted.push(span);
  }

  // Read the complete source identity before any mutation. The same rows both
  // validate each span and bind a successful job to the exact stored corpus.
  const sourceResult = await db.prepare(
    `SELECT document_id,id,sequence,event_type,actor_type,timestamp,content,
            length(content) AS content_length
       FROM items ORDER BY document_id,sequence,id`
  ).all<Record<string, unknown>>();
  const sourceDigest = await computeSourceDigest(sourceResult.results);
  const sourceItems = new Map(sourceResult.results.map((row) => [
    String(row.id),
    { documentId: String(row.document_id), length: Number(row.content_length) },
  ]));

  // Offsets are only meaningful against the stored content, so verify every
  // candidate rather than trusting the importer.
  const verified: IncomingRedaction[] = [];
  for (const span of accepted) {
    const sourceItem = sourceItems.get(span.itemId);
    if (!sourceItem) {
      rejected.push({ itemId: span.itemId, reason: "unknown item" });
    } else if (sourceItem.documentId !== span.documentId) {
      rejected.push({ itemId: span.itemId, reason: "document does not own item" });
    } else if (span.endOffset > sourceItem.length) {
      rejected.push({
        itemId: span.itemId,
        reason: `offset beyond content length ${sourceItem.length}`,
      });
    } else {
      verified.push(span);
    }
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

  const rejectedCount = reportedRejected + rejected.length;
  const status = finalRedactionStatus({
    requestedStatus: body.job.status,
    completed: persistable.length,
    total,
    rejected: rejectedCount,
    sourceDigest,
  });
  if (total !== incoming.length || rejectedCount > 0 || status !== "complete") {
    return Response.json({
      error: total !== incoming.length
        ? "Redaction total does not match the submitted span count"
        : "Redaction pass must be wholly valid and complete",
      imported: 0,
      code: SOURCE_PRIVACY_ERROR.replacementInvalid,
      rejectedCount,
      reportedRejected,
      status: "incomplete",
    }, { status: 400 });
  }

  const now = new Date().toISOString();
  const jobId = crypto.randomUUID();
  const statements = [
    db.prepare("DELETE FROM redactions"),
    db.prepare("DELETE FROM redaction_jobs"),
    db.prepare(
      `INSERT INTO redaction_jobs
        (id,status,stage,model,completed,total,rejected,source_digest,
         started_at,updated_at,completed_at)
       VALUES (?,'running','validating',?,0,?,?,NULL,?,?,NULL)`
    ).bind(
      jobId, body.job.model || null, total, reportedRejected, now, now,
    ),
    ...persistable.map((span) => db.prepare(
      `INSERT INTO redactions
        (id,item_id,document_id,start_offset,end_offset,category,confidence,reason,
         review_state,uncertainty_reason,status,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'active',?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         start_offset=excluded.start_offset,end_offset=excluded.end_offset,
         category=excluded.category,confidence=excluded.confidence,
         reason=excluded.reason,review_state=excluded.review_state,
         uncertainty_reason=excluded.uncertainty_reason,status='active',
         updated_at=excluded.updated_at`
    ).bind(
      span.id || crypto.randomUUID(), span.itemId, span.documentId,
      span.startOffset, span.endOffset, span.category,
      span.confidence || null, span.reason || null,
      span.reviewState, span.uncertaintyReason ?? null,
      span.createdBy || "llm", now, now,
    )),
    db.prepare(
      `UPDATE redaction_jobs
        SET status=?,stage=?,completed=?,total=?,rejected=?,source_digest=?,
            updated_at=?,completed_at=?
       WHERE id=?`
    ).bind(
      status, body.job.stage, persistable.length, total, rejectedCount,
      sourceDigest, now, now, jobId,
    ),
    ...activeStoryPrivacyInvalidationStatements(db, authority.workflowRunId, now),
  ];
  try {
    await db.batch(statements);
  } catch {
    return Response.json({
      error: "Source Privacy replacement conflicted",
      code: SOURCE_PRIVACY_ERROR.mutationConflict,
      imported: 0,
    }, { status: 409 });
  }

  return Response.json({ imported: persistable.length, rejected, status });
}
