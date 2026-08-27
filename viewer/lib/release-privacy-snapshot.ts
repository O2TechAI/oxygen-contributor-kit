import type { getLocalDatabase } from "../db";

type ReleaseDatabase = Awaited<ReturnType<typeof getLocalDatabase>>;
type SnapshotRow = Record<string, unknown>;
type BatchResult = { results?: SnapshotRow[] };

export type ReleaseSnapshotTestOptions = {
  beforeFinalPrivacyCheck?: () => void | Promise<void>;
  exportedAt?: string;
};

const redactionJobSql = `SELECT id,status,stage,model,completed,total,rejected,source_digest,
  started_at,updated_at,completed_at
  FROM redaction_jobs ORDER BY started_at DESC LIMIT 1`;

const reviewRedactionsSql = `SELECT id,item_id,document_id,start_offset,end_offset,category,
  confidence,reason,review_state,uncertainty_reason,status,created_by,created_at,updated_at
  FROM redactions ORDER BY item_id,start_offset,id`;

const activeRedactionsSql = `SELECT id,item_id,document_id,start_offset,end_offset,category,status,
  review_state FROM redactions WHERE status='active'
  AND review_state IN ('deterministic','confirmed_redact') ORDER BY item_id,start_offset,id`;

const storyItemsSql = `SELECT id,document_id,sequence,event_type,actor_id,actor_type,timestamp,
  content,organization_reason FROM items ORDER BY document_id,sequence`;

const packageDocumentsSql = `SELECT id,kind,title,source_system,source_timestamp,item_count,
  metadata_json,formatted_summary_json FROM documents ORDER BY source_timestamp,title`;

const packageItemsSql = `SELECT id,document_id,sequence,event_type,actor_type,timestamp,content,
  organization_category,organization_confidence,organization_reason
  FROM items ORDER BY document_id,sequence`;

const packageProbesSql = `SELECT id,document_id,document_kind,event_ids_json,timestamp,signal,
  score,turns,recap,question,options_json,allow_other,allow_skip,answer_choice,answer_text,
  answered_at,created_at FROM probes ORDER BY score DESC,created_at`;

const packageBulkSql = `SELECT id,kind,count,question,default_answer,answer,answered_at,
  evidence_sample_json,created_at FROM probe_bulk_decisions ORDER BY count DESC`;

const packageProbeRunSql = `SELECT id,status,stage,model,generated,set_aside,auto_removed_json,
  started_at,updated_at,completed_at FROM probe_runs ORDER BY started_at DESC LIMIT 1`;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as SnapshotRow).sort()
      .map((key) => [key, canonicalize((value as SnapshotRow)[key])]));
  }
  return value;
}

async function snapshotDigest(kind: "story" | "package", value: unknown) {
  const serialized = JSON.stringify(canonicalize({
    schema: "oxygen.release-privacy-snapshot/1",
    kind,
    value,
  }));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rows(results: unknown[], index: number): SnapshotRow[] {
  return ((results[index] as BatchResult | undefined)?.results || []) as SnapshotRow[];
}

function safeActiveRows(results: unknown[], index: number): SnapshotRow[] {
  return rows(results, index).filter((row) => row.status === "active"
    && ["deterministic", "confirmed_redact"].includes(String(row.review_state)));
}

/** Capture every database row that governs reviewed Story reconstruction in one
 * local SQLite transaction, so the returned rows cannot combine pre- and
 * post-mutation Privacy state. */
export async function captureStoryReleasePrivacySnapshot(
  db: ReleaseDatabase,
  workflowRunId: string,
) {
  const results = await db.batch([
    db.prepare("SELECT id FROM workflow_runs ORDER BY id LIMIT 2"),
    db.prepare(`SELECT id,story_generation_status,story_source_revision,active_story_digest
      FROM workflow_runs WHERE id=?`).bind(workflowRunId),
    db.prepare(`SELECT state_json,updated_at,server_version
      FROM story_review_sessions WHERE workflow_run_id=?`).bind(workflowRunId),
    db.prepare(redactionJobSql),
    db.prepare(storyItemsSql),
    db.prepare(reviewRedactionsSql),
    db.prepare(activeRedactionsSql),
  ]);
  const authorityRows = rows(results, 0);
  const runRows = rows(results, 1);
  const sessionRows = rows(results, 2);
  const redactionJobRows = rows(results, 3);
  const itemRows = rows(results, 4);
  const redactionReviewRows = rows(results, 5);
  const redactionRows = safeActiveRows(results, 6);
  const value = {
    authorityRows,
    runRows,
    sessionRows,
    redactionJobRows,
    itemRows,
    redactionReviewRows,
  };
  return {
    ...value,
    run: runRows[0] || null,
    session: sessionRows[0] || null,
    redactionJob: redactionJobRows[0] || null,
    redactionRows,
    digest: await snapshotDigest("story", value),
  };
}

/** Capture the complete server-owned input ledger for the downloadable package.
 * The digest binds general events, derived organization text, document metadata,
 * preference text, active spans, and the redaction job that approved the source. */
export async function capturePackageReleasePrivacySnapshot(db: ReleaseDatabase) {
  const results = await db.batch([
    db.prepare(redactionJobSql),
    db.prepare(packageDocumentsSql),
    db.prepare(packageItemsSql),
    db.prepare(reviewRedactionsSql),
    db.prepare(activeRedactionsSql),
    db.prepare(packageProbesSql),
    db.prepare(packageBulkSql),
    db.prepare(packageProbeRunSql),
  ]);
  const redactionJobRows = rows(results, 0);
  const documentRows = rows(results, 1);
  const itemRows = rows(results, 2);
  const redactionReviewRows = rows(results, 3);
  const redactionRows = safeActiveRows(results, 4);
  const probeRows = rows(results, 5);
  const bulkRows = rows(results, 6);
  const probeRunRows = rows(results, 7);
  const value = {
    redactionJobRows,
    documentRows,
    itemRows,
    redactionReviewRows,
    probeRows,
    bulkRows,
    probeRunRows,
  };
  return {
    ...value,
    redactionJob: redactionJobRows[0] || null,
    redactionRows,
    probeRun: probeRunRows[0] || null,
    digest: await snapshotDigest("package", value),
  };
}
