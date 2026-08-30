import { getLocalDatabase } from "../../../db";
import {
  computeSourceDigest,
  partitionPersistableRedactions,
} from "../../../lib/redaction-pass.mjs";
import {
  buildCurrentSourcePrivacyDialogue,
  canonicalSourcePrivacyJson,
  canonicalSourcePrivacyRedactions,
  parseSourcePrivacyReceipt,
  sourcePrivacyDigest,
  type CurrentSourceRow,
  type SourcePrivacyReceipt,
} from "../../../lib/source-privacy-receipt";
import { validActivatedSourceRevision } from "../../../lib/authority-validation.mjs";
import {
  WORKFLOW_RUN_AUTHORITY,
  requireEstablishedWorkflowRun,
  workflowRunErrorResponse,
} from "../../../lib/workflow-run-server";
import {
  activeStoryPrivacyInvalidationStatements,
  storySourceGenerationGuardStatement,
} from "../../../lib/story-source-publication";

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
const ALLOWED_CONFIDENCE = new Set(["high", "medium", "low"]);
const REQUEST_KEYS = new Set(["job", "redactions", "replaceAll", "receipt"]);
const JOB_KEYS = new Set(["status", "stage", "model", "total", "rejected"]);
const REDACTION_KEYS = new Set([
  "id", "itemId", "documentId", "startOffset", "endOffset", "category",
  "confidence", "reason", "reviewState", "uncertaintyReason", "createdBy",
]);
const SOURCE_PRIVACY_ERROR = {
  requestInvalid: "SOURCE_PRIVACY_REQUEST_INVALID",
  replacementInvalid: "SOURCE_PRIVACY_REPLACEMENT_INVALID",
  mutationConflict: "SOURCE_PRIVACY_MUTATION_CONFLICT",
} as const;

type CurrentSourcePrivacySnapshot = {
  sourceRevision: number;
  sourceDigest: string;
  finalizedCorpus: SourcePrivacyReceipt["finalizedCorpus"];
  dialogue: SourcePrivacyReceipt["dialogue"];
  sourceRows: CurrentSourceRow[];
};

function invalidRequest(error: string) {
  return Response.json({ error, code: SOURCE_PRIVACY_ERROR.requestInvalid }, { status: 400 });
}

async function currentSourcePrivacySnapshot(
  db: Awaited<ReturnType<typeof getLocalDatabase>>,
  workflowRunId: string,
): Promise<CurrentSourcePrivacySnapshot | null> {
  const sourceSnapshot = await db.prepare(
    `SELECT i.document_id,d.kind AS document_kind,i.id,i.sequence,i.event_type,i.actor_type,
            i.timestamp,i.content,i.original_json,r.story_source_revision,
            f.corpus_revision,f.corpus_digest,f.document_count,f.item_count,
            (SELECT COUNT(*) FROM workflow_runs) AS current_run_count,
            (SELECT COUNT(*) FROM documents) AS current_document_count,
            (SELECT COUNT(*) FROM items) AS current_item_count
       FROM workflow_runs r
       LEFT JOIN finalized_corpus_manifests f ON f.workflow_run_id=r.id
       LEFT JOIN items i ON 1=1 LEFT JOIN documents d ON d.id=i.document_id
      WHERE r.id=? ORDER BY i.document_id,i.sequence,i.id`
  ).bind(workflowRunId).all<Record<string, unknown>>();
  const witness = sourceSnapshot.results[0];
  const sourceRevision = Number(witness?.story_source_revision);
  const corpusRevision = Number(witness?.corpus_revision);
  const documentCount = Number(witness?.document_count);
  const itemCount = Number(witness?.item_count);
  if (Number(witness?.current_run_count) !== 1
    || !validActivatedSourceRevision(sourceRevision)
    || !Number.isSafeInteger(corpusRevision) || corpusRevision <= 0
    || !/^[0-9a-f]{64}$/u.test(String(witness?.corpus_digest || ""))
    || !Number.isSafeInteger(documentCount) || documentCount < 0
    || !Number.isSafeInteger(itemCount) || itemCount < 0
    || Number(witness?.current_document_count) !== documentCount
    || Number(witness?.current_item_count) !== itemCount) return null;
  const sourceRows = sourceSnapshot.results.filter(
    (row) => row.id != null,
  ) as unknown as CurrentSourceRow[];
  if (sourceRows.length !== itemCount) return null;
  try {
    const [sourceDigest, dialogue] = await Promise.all([
      computeSourceDigest(sourceRows),
      buildCurrentSourcePrivacyDialogue(sourceRows),
    ]);
    if (dialogue.bundleCount < 1 || dialogue.turnCount < 1) return null;
    return {
      sourceRevision,
      sourceDigest,
      finalizedCorpus: {
        revision: corpusRevision,
        digest: String(witness.corpus_digest),
        documentCount,
        itemCount,
      },
      dialogue,
      sourceRows,
    };
  } catch {
    return null;
  }
}

export async function GET(request?: Request) {
  const db = await getLocalDatabase();
  const authority = await requireEstablishedWorkflowRun(db);
  if (authority.state !== WORKFLOW_RUN_AUTHORITY.exactRun) {
    return workflowRunErrorResponse(authority);
  }
  if (request && new URL(request.url).searchParams.get("sourceAuthority") === "1") {
    const snapshot = await db.transaction(() => (
      currentSourcePrivacySnapshot(db, authority.workflowRunId)
    ));
    if (!snapshot) {
      return Response.json({
        error: "Activated source Privacy authority is unavailable",
        code: SOURCE_PRIVACY_ERROR.mutationConflict,
      }, { status: 409 });
    }
    return Response.json({
      sourceAuthority: {
        workflowRunId: authority.workflowRunId,
        sourceRevision: snapshot.sourceRevision,
        finalizedCorpus: snapshot.finalizedCorpus,
        sourceDigest: snapshot.sourceDigest,
      },
    });
  }
  const [redactions, job] = await Promise.all([
    db.prepare(
      `SELECT id,item_id,document_id,start_offset,end_offset,category,confidence,reason,
              review_state,uncertainty_reason,status,created_by,created_at,updated_at
         FROM redactions ORDER BY document_id,item_id,start_offset,id`
    ).all(),
    db.prepare(
      `SELECT j.*,p.source_revision,p.receipt_digest
        FROM redaction_jobs j LEFT JOIN source_privacy_receipts p ON p.job_id=j.id
        ORDER BY j.started_at DESC,j.id DESC LIMIT 1`
    ).first(),
  ]);
  return Response.json({ redactions: redactions.results || [], job: job || null });
}

export async function POST(request: Request) {
  let body: {
    job?: { status: string; stage: string; model?: string; total?: number; rejected?: number };
    redactions?: IncomingRedaction[];
    replaceAll?: boolean;
    receipt?: unknown;
  };
  try {
    const parsed = await request.json() as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return invalidRequest("A valid source Privacy replacement is required");
    }
    if (Object.keys(parsed).some((key) => !REQUEST_KEYS.has(key))) {
      return invalidRequest("A valid source Privacy replacement is required");
    }
    body = parsed as typeof body;
  } catch {
    return invalidRequest("A valid source Privacy replacement is required");
  }
  const receipt = await parseSourcePrivacyReceipt(body.receipt);
  if (!receipt) return invalidRequest("A valid source Privacy receipt is required");
  const incoming = body.redactions ?? [];
  if (!body.job || typeof body.job !== "object") {
    return invalidRequest("A redaction pass job is required");
  }
  const job = body.job;
  if (Object.keys(job).some((key) => !JOB_KEYS.has(key))
    || (job.model != null && typeof job.model !== "string")) {
    return invalidRequest("A redaction pass job is required");
  }
  if (!Array.isArray(incoming)) {
    return invalidRequest("Redactions must be an array");
  }
  if (body.replaceAll !== true) {
    return invalidRequest("Bulk redaction imports must replace all spans");
  }
  const total = Number(job.total ?? incoming.length);
  const reportedRejected = Number(job.rejected ?? 0);
  if (!Number.isInteger(total) || total < 0
      || !Number.isInteger(reportedRejected) || reportedRejected < 0) {
    return invalidRequest("Redaction totals must be non-negative integers");
  }
  if (job.status !== "complete"
      || typeof job.stage !== "string" || job.stage.length === 0) {
    return invalidRequest("Redaction pass must be complete");
  }

  const rejected: Array<{ itemId: string; reason: string }> = [];
  const accepted: IncomingRedaction[] = [];

  for (const span of incoming) {
    if (!span || typeof span !== "object" || Array.isArray(span)) {
      rejected.push({ itemId: "", reason: "redaction must be an object" });
      continue;
    }
    if (Object.keys(span).some((key) => !REDACTION_KEYS.has(key))
      || (span.id != null && (typeof span.id !== "string" || !span.id))
      || (span.confidence != null && !ALLOWED_CONFIDENCE.has(span.confidence))
      || (span.reason != null && typeof span.reason !== "string")
      || (span.createdBy != null && span.createdBy !== "llm")) {
      rejected.push({ itemId: "", reason: "redaction shape is invalid" });
      continue;
    }
    if (typeof span.itemId !== "string" || !span.itemId
      || typeof span.documentId !== "string" || !span.documentId) {
      rejected.push({ itemId: "", reason: "redaction identity is invalid" });
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
    if (!Number.isInteger(span.startOffset) || !Number.isInteger(span.endOffset)
        || !(span.startOffset >= 0 && span.endOffset > span.startOffset)) {
      rejected.push({ itemId: span.itemId, reason: "invalid offsets" });
      continue;
    }
    accepted.push(span);
  }

  accepted.sort((a, b) => a.itemId.localeCompare(b.itemId)
    || a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  const nonOverlapping: IncomingRedaction[] = [];
  const lastEnd = new Map<string, number>();
  for (const span of accepted) {
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

  const submittedDigest = await sourcePrivacyDigest(canonicalSourcePrivacyRedactions(
    persistable as unknown as Array<Record<string, unknown>>,
  ));
  const rejectedCount = reportedRejected + rejected.length;
  if (total !== incoming.length || rejectedCount > 0
    || receipt.redactions.count !== persistable.length
    || receipt.redactions.digest !== submittedDigest) {
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

  const db = await getLocalDatabase();
  const authority = await requireEstablishedWorkflowRun(db);
  if (authority.state !== WORKFLOW_RUN_AUTHORITY.exactRun) {
    return workflowRunErrorResponse(authority);
  }
  const now = new Date().toISOString();
  const jobId = crypto.randomUUID();
  const receiptJson = canonicalSourcePrivacyJson(receipt);
  let outcome: { kind: "success" } | { kind: "conflict" } | {
    kind: "invalid"; rejected: Array<{ itemId: string; reason: string }>;
  };
  try {
    outcome = await db.transaction(async () => {
      const snapshot = await currentSourcePrivacySnapshot(db, authority.workflowRunId);
      if (!snapshot
        || receipt.workflowRunId !== authority.workflowRunId
        || receipt.sourceRevision !== snapshot.sourceRevision
        || receipt.sourceDigest !== snapshot.sourceDigest
        || canonicalSourcePrivacyJson(receipt.finalizedCorpus)
          !== canonicalSourcePrivacyJson(snapshot.finalizedCorpus)
        || canonicalSourcePrivacyJson(receipt.dialogue)
          !== canonicalSourcePrivacyJson(snapshot.dialogue)) return { kind: "conflict" };

      const sourceItems = new Map(snapshot.sourceRows.map((row) => [
        String(row.id),
        {
          documentId: String(row.document_id),
          length: Array.from(String(row.content ?? "")).length,
        },
      ]));
      const sourceRejected: Array<{ itemId: string; reason: string }> = [];
      for (const span of persistable) {
        const sourceItem = sourceItems.get(span.itemId);
        if (!sourceItem) {
          sourceRejected.push({ itemId: span.itemId, reason: "unknown item" });
        } else if (sourceItem.documentId !== span.documentId) {
          sourceRejected.push({ itemId: span.itemId, reason: "document does not own item" });
        } else if (span.endOffset > sourceItem.length) {
          sourceRejected.push({ itemId: span.itemId, reason: "offset beyond stored content" });
        }
      }
      if (sourceRejected.length) return { kind: "invalid", rejected: sourceRejected };

      const statements = [
        storySourceGenerationGuardStatement(
          db, authority.workflowRunId, snapshot.sourceRevision,
        ),
        db.prepare("DELETE FROM redactions"),
        db.prepare("DELETE FROM source_privacy_receipts"),
        db.prepare("DELETE FROM redaction_jobs"),
        db.prepare(
          `INSERT INTO redaction_jobs
            (id,status,stage,model,completed,total,rejected,source_digest,
             started_at,updated_at,completed_at)
           VALUES (?,'complete',?,?,?,?,0,?,?,?,?)`
        ).bind(
          jobId, job.stage, job.model || null, persistable.length, total,
          snapshot.sourceDigest, now, now, now,
        ),
        db.prepare(`INSERT INTO source_privacy_receipts
          (job_id,workflow_run_id,source_revision,source_digest,receipt_digest,
           receipt_json,created_at) VALUES (?,?,?,?,?,?,?)`).bind(
          jobId, authority.workflowRunId, snapshot.sourceRevision, snapshot.sourceDigest,
          receipt.receiptDigest, receiptJson, now,
        ),
        ...persistable.map((span) => db.prepare(
          `INSERT INTO redactions
            (id,item_id,document_id,start_offset,end_offset,category,confidence,reason,
             review_state,uncertainty_reason,status,created_by,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,'active',?,?,?)`
        ).bind(
          span.id || crypto.randomUUID(), span.itemId, span.documentId,
          span.startOffset, span.endOffset, span.category,
          span.confidence ?? null, span.reason ?? null,
          span.reviewState, span.uncertaintyReason ?? null,
          span.createdBy ?? "llm", now, now,
        )),
        ...activeStoryPrivacyInvalidationStatements(db, authority.workflowRunId, now),
        db.prepare(`SELECT CASE WHEN EXISTS (
            SELECT 1 FROM redaction_jobs j JOIN source_privacy_receipts p ON p.job_id=j.id
              WHERE j.id=? AND j.status='complete' AND j.completed=? AND j.total=?
              AND j.rejected=0 AND j.source_digest=? AND p.workflow_run_id=?
              AND p.source_revision=? AND p.source_digest=? AND p.receipt_digest=?
              AND p.receipt_json=?
          ) AND (SELECT COUNT(*) FROM redactions)=?
          THEN 1 ELSE json_extract('source Privacy receipt persistence failed','$') END AS receipt_guard`)
          .bind(
            jobId, persistable.length, total, snapshot.sourceDigest,
            authority.workflowRunId, snapshot.sourceRevision, snapshot.sourceDigest,
            receipt.receiptDigest, receiptJson, persistable.length,
          ),
      ];
      await db.batch(statements);
      return { kind: "success" };
    });
  } catch {
    return Response.json({
      error: "Source Privacy replacement conflicted",
      code: SOURCE_PRIVACY_ERROR.mutationConflict,
      imported: 0,
    }, { status: 409 });
  }
  if (outcome.kind === "conflict") {
    return Response.json({
      error: "Source Privacy replacement conflicted",
      code: SOURCE_PRIVACY_ERROR.mutationConflict,
      imported: 0,
    }, { status: 409 });
  }
  if (outcome.kind === "invalid") {
    return Response.json({
      error: "Redaction pass must be wholly valid and complete",
      imported: 0,
      code: SOURCE_PRIVACY_ERROR.replacementInvalid,
      rejectedCount: outcome.rejected.length,
      reportedRejected,
      status: "incomplete",
    }, { status: 400 });
  }
  return Response.json({ imported: persistable.length, rejected: [], status: "complete" });
}
