import type { getLocalDatabase } from "../db";
import {
  validActivatedSourceRevision,
  validNonnegativeAuthorityCounter,
} from "./authority-validation.mjs";
import {
  buildCurrentSourcePrivacyDialogue,
  validateStoredSourcePrivacyReceipt,
  type CurrentSourceRow,
  type PersistedSourcePrivacyRedaction,
} from "./source-privacy-receipt.ts";

type ReleaseDatabase = Awaited<ReturnType<typeof getLocalDatabase>>;
type SnapshotRow = Record<string, unknown>;
type BatchResult = { results?: SnapshotRow[] };

export type ReleaseSnapshotTestOptions = {
  afterInitialStoryReconstruction?: () => void | Promise<void>;
  beforeFinalPrivacyCheck?: () => void | Promise<void>;
  exportedAt?: string;
};

const redactionJobSql = `SELECT j.id,j.status,j.stage,j.model,j.completed,j.total,j.rejected,
  p.source_revision,j.source_digest,p.receipt_digest,j.started_at,j.updated_at,j.completed_at
  FROM redaction_jobs j LEFT JOIN source_privacy_receipts p ON p.job_id=j.id
  ORDER BY j.started_at DESC,j.id DESC`;

const sourcePrivacyReceiptSql = `SELECT job_id,workflow_run_id,source_revision,source_digest,
  receipt_digest,receipt_json,created_at FROM source_privacy_receipts ORDER BY job_id`;

const finalizedCorpusSql = `SELECT workflow_run_id,corpus_revision,corpus_digest,document_count,
  item_count,finalized_at,(SELECT COUNT(*) FROM documents) AS current_document_count,
  (SELECT COUNT(*) FROM items) AS current_item_count
  FROM finalized_corpus_manifests ORDER BY workflow_run_id`;

const reviewRedactionsSql = `SELECT id,item_id,document_id,start_offset,end_offset,category,
  confidence,reason,review_state,uncertainty_reason,status,created_by,created_at,updated_at
  FROM redactions ORDER BY item_id,start_offset,id`;

const activeRedactionsSql = `SELECT id,item_id,document_id,start_offset,end_offset,category,status,
  review_state FROM redactions WHERE status='active'
  AND review_state IN ('deterministic','confirmed_redact') ORDER BY item_id,start_offset,id`;

const storyItemsSql = `SELECT i.id,i.document_id,d.kind AS document_kind,i.sequence,i.event_type,
  i.actor_id,i.actor_type,i.timestamp,i.content,i.original_json,i.organization_reason
  FROM items i LEFT JOIN documents d ON d.id=i.document_id
  ORDER BY i.document_id,i.sequence,i.id`;

const preparationReceiptsSql = `SELECT workflow_run_id,lane,source_revision,input_digest,
  scope_digest,scope_count,output_digest,output_count,completed_at
  FROM story_preparation_receipts WHERE workflow_run_id=? ORDER BY lane`;

const storyPrivacyCandidatesSql = `SELECT workflow_run_id,candidate_id,candidate_json
  FROM story_privacy_candidates
  WHERE workflow_run_id=? ORDER BY candidate_id`;

const storyPrivacyAuthoritySql = `SELECT workflow_run_id,source_revision,active_story_digest,
  server_version,reviewed_story_digest,target_catalog_json,target_catalog_digest,
  changed_target_digest,changed_target_count,receipt_digest,proposal_digest,
  proposal_count,imported_at FROM story_privacy_authorities WHERE workflow_run_id=?`;

const storyPrivacyTargetsSql = `SELECT workflow_run_id,target_id,target_content_digest,
  proposed_text,occurrences_json,selected_text,public_overrides_json,decided_at
  FROM story_privacy_targets
  WHERE workflow_run_id=? ORDER BY target_id`;

const releaseProbeRunSql = `SELECT workflow_run_id,id,source_revision,input_digest,output_digest,
  output_count,status,stage,model,generated,set_aside,auto_removed_json,started_at,updated_at,
  completed_at FROM probe_runs WHERE workflow_run_id=?`;

const releaseProbesSql = `SELECT id,document_id,document_kind,event_ids_json,timestamp,signal,
  score,turns,recap,question,options_json,presentations_json,allow_other,allow_skip,
  answer_choice,answer_text,answered_at,created_at FROM probes ORDER BY id`;

const releaseBulkSql = `SELECT id,kind,count,question,default_answer,answer,answered_at,
  evidence_sample_json,presentations_json,created_at FROM probe_bulk_decisions ORDER BY id`;

const releaseConfirmationSql = `SELECT workflow_run_id,review_gate_digest,confirmed_at
  FROM project_release_confirmations WHERE workflow_run_id=?`;

const packageDocumentsSql = `SELECT id,kind,title,source_system,source_timestamp,item_count,
  metadata_json,formatted_summary_json FROM documents ORDER BY source_timestamp,title,id`;

const packageItemsSql = `SELECT i.id,i.document_id,d.kind AS document_kind,i.sequence,i.event_type,
  i.actor_type,i.timestamp,i.content,i.original_json,i.organization_category,
  i.organization_confidence,i.organization_reason
  FROM items i LEFT JOIN documents d ON d.id=i.document_id
  ORDER BY i.document_id,i.sequence,i.id`;

const packageProbesSql = `SELECT id,document_id,document_kind,event_ids_json,timestamp,signal,
  score,turns,recap,question,options_json,allow_other,allow_skip,answer_choice,answer_text,
  answered_at,created_at FROM probes ORDER BY score DESC,created_at,id`;

const packageBulkSql = `SELECT id,kind,count,question,default_answer,answer,answered_at,
  evidence_sample_json,created_at FROM probe_bulk_decisions ORDER BY count DESC,id`;

const packageProbeRunSql = `SELECT id,status,stage,model,generated,set_aside,auto_removed_json,
  started_at,updated_at,completed_at FROM probe_runs ORDER BY started_at DESC,id DESC LIMIT 1`;

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
    schema: "oxygen.release-privacy-snapshot",
    kind,
    value,
  }));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function computeReviewGateDigest(
  storySnapshot: Awaited<ReturnType<typeof captureStoryReleasePrivacySnapshot>>,
  packageSnapshotDigest: string,
  storyPrivacyAuthority: unknown,
  serializedStory: string,
) {
  return snapshotDigest("story", {
    schema: "oxygen.review-gate",
    workflow: {
      authorityRows: storySnapshot.authorityRows,
      runRows: storySnapshot.runRows,
      sessionRows: storySnapshot.sessionRows,
    },
    sourcePrivacy: {
      redactionJobRows: storySnapshot.redactionJobRows,
      sourcePrivacyReceiptRows: storySnapshot.sourcePrivacyReceiptRows,
      finalizedCorpusRows: storySnapshot.finalizedCorpusRows,
      itemRows: storySnapshot.itemRows,
      redactionReviewRows: storySnapshot.redactionReviewRows,
    },
    preparation: {
      receiptRows: storySnapshot.preparationReceiptRows,
      storyPrivacyAuthorityRows: storySnapshot.storyPrivacyAuthorityRows,
      storyPrivacyCandidateRows: storySnapshot.storyPrivacyCandidateRows,
      storyPrivacyTargetRows: storySnapshot.storyPrivacyTargetRows,
    },
    preferences: {
      probeRunRows: storySnapshot.probeRunRows,
      probeRows: storySnapshot.probeRows,
      bulkRows: storySnapshot.bulkRows,
    },
    packageSnapshotDigest,
    storyPrivacyAuthority,
    serializedStory,
  });
}

function rows(results: unknown[], index: number): SnapshotRow[] {
  return ((results[index] as BatchResult | undefined)?.results || []) as SnapshotRow[];
}

function safeActiveRows(results: unknown[], index: number): SnapshotRow[] {
  return rows(results, index).filter((row) => row.status === "active"
    && ["deterministic", "confirmed_redact"].includes(String(row.review_state)));
}

export async function validateReleaseSourcePrivacyReceipt(
  snapshot: {
    redactionJobRows: SnapshotRow[];
    sourcePrivacyReceiptRows: SnapshotRow[];
    finalizedCorpusRows: SnapshotRow[];
    itemRows: SnapshotRow[];
    redactionReviewRows: SnapshotRow[];
  },
  workflowRunId: string,
  sourceRevision: number,
  sourceDigest: string,
) {
  if (!validActivatedSourceRevision(sourceRevision)
    || snapshot.redactionJobRows.length !== 1
    || snapshot.sourcePrivacyReceiptRows.length !== 1
    || snapshot.finalizedCorpusRows.length !== 1) return false;
  const job = snapshot.redactionJobRows[0];
  const receiptSourceRevision = Number(snapshot.sourcePrivacyReceiptRows[0].source_revision);
  const corpus = snapshot.finalizedCorpusRows[0];
  const corpusRevision = Number(corpus.corpus_revision);
  const documentCount = Number(corpus.document_count);
  const itemCount = Number(corpus.item_count);
  const completed = Number(job.completed);
  const total = Number(job.total);
  const rejected = Number(job.rejected);
  if (!validActivatedSourceRevision(receiptSourceRevision)
    || receiptSourceRevision > sourceRevision
    || corpus.workflow_run_id !== workflowRunId
    || !validActivatedSourceRevision(corpusRevision)
    || !/^[0-9a-f]{64}$/u.test(String(corpus.corpus_digest || ""))
    || !Number.isSafeInteger(documentCount) || documentCount < 0
    || !Number.isSafeInteger(itemCount) || itemCount < 0
    || Number(corpus.current_document_count) !== documentCount
    || Number(corpus.current_item_count) !== itemCount
    || snapshot.itemRows.length !== itemCount
    || job.status !== "complete"
    || !validNonnegativeAuthorityCounter(completed)
    || !validNonnegativeAuthorityCounter(total)
    || !validNonnegativeAuthorityCounter(rejected)
    || completed !== total
    || completed !== snapshot.redactionReviewRows.length
    || rejected !== 0
    || Number(job.source_revision) !== receiptSourceRevision
    || job.source_digest !== sourceDigest) return false;
  let dialogue;
  try {
    dialogue = await buildCurrentSourcePrivacyDialogue(
      snapshot.itemRows as unknown as CurrentSourceRow[],
    );
  } catch {
    return false;
  }
  return Boolean(await validateStoredSourcePrivacyReceipt(
    snapshot.sourcePrivacyReceiptRows[0],
    {
      jobId: String(job.id || ""),
      workflowRunId,
      sourceRevision: receiptSourceRevision,
      sourceDigest,
      finalizedCorpus: {
        revision: corpusRevision,
        digest: String(corpus.corpus_digest),
        documentCount,
        itemCount,
      },
      dialogue,
      redactions: snapshot.redactionReviewRows as unknown as PersistedSourcePrivacyRedaction[],
    },
  ));
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
    db.prepare(sourcePrivacyReceiptSql),
    db.prepare(finalizedCorpusSql),
    db.prepare(storyItemsSql),
    db.prepare(reviewRedactionsSql),
    db.prepare(activeRedactionsSql),
    db.prepare(preparationReceiptsSql).bind(workflowRunId),
    db.prepare(storyPrivacyAuthoritySql).bind(workflowRunId),
    db.prepare(storyPrivacyCandidatesSql).bind(workflowRunId),
    db.prepare(storyPrivacyTargetsSql).bind(workflowRunId),
    db.prepare(releaseProbeRunSql).bind(workflowRunId),
    db.prepare(releaseProbesSql),
    db.prepare(releaseBulkSql),
    db.prepare(releaseConfirmationSql).bind(workflowRunId),
  ]);
  const authorityRows = rows(results, 0);
  const runRows = rows(results, 1);
  const sessionRows = rows(results, 2);
  const redactionJobRows = rows(results, 3);
  const sourcePrivacyReceiptRows = rows(results, 4);
  const finalizedCorpusRows = rows(results, 5);
  const itemRows = rows(results, 6);
  const redactionReviewRows = rows(results, 7);
  const redactionRows = safeActiveRows(results, 8);
  const preparationReceiptRows = rows(results, 9);
  const storyPrivacyAuthorityRows = rows(results, 10);
  const storyPrivacyCandidateRows = rows(results, 11);
  const storyPrivacyTargetRows = rows(results, 12);
  const probeRunRows = rows(results, 13);
  const probeRows = rows(results, 14);
  const bulkRows = rows(results, 15);
  const releaseConfirmationRows = rows(results, 16);
  const value = {
    authorityRows,
    runRows,
    sessionRows,
    redactionJobRows,
    sourcePrivacyReceiptRows,
    finalizedCorpusRows,
    itemRows,
    redactionReviewRows,
    preparationReceiptRows,
    storyPrivacyAuthorityRows,
    storyPrivacyCandidateRows,
    storyPrivacyTargetRows,
    probeRunRows,
    probeRows,
    bulkRows,
  };
  return {
    ...value,
    releaseConfirmationRows,
    run: runRows[0] || null,
    session: sessionRows[0] || null,
    redactionJob: redactionJobRows[0] || null,
    redactionRows,
    probeRun: probeRunRows[0] || null,
    releaseConfirmation: releaseConfirmationRows[0] || null,
    digest: await snapshotDigest("story", value),
  };
}

/** Capture the complete server-owned input ledger for the downloadable package.
 * The digest binds general events, derived organization text, document metadata,
 * preference text, active spans, and the redaction job that approved the source. */
export async function capturePackageReleasePrivacySnapshot(db: ReleaseDatabase) {
  const results = await db.batch([
    db.prepare(redactionJobSql),
    db.prepare(sourcePrivacyReceiptSql),
    db.prepare(finalizedCorpusSql),
    db.prepare(packageDocumentsSql),
    db.prepare(packageItemsSql),
    db.prepare(reviewRedactionsSql),
    db.prepare(activeRedactionsSql),
    db.prepare(packageProbesSql),
    db.prepare(packageBulkSql),
    db.prepare(packageProbeRunSql),
  ]);
  const redactionJobRows = rows(results, 0);
  const sourcePrivacyReceiptRows = rows(results, 1);
  const finalizedCorpusRows = rows(results, 2);
  const documentRows = rows(results, 3);
  const itemRows = rows(results, 4);
  const redactionReviewRows = rows(results, 5);
  const redactionRows = safeActiveRows(results, 6);
  const probeRows = rows(results, 7);
  const bulkRows = rows(results, 8);
  const probeRunRows = rows(results, 9);
  const value = {
    redactionJobRows,
    sourcePrivacyReceiptRows,
    finalizedCorpusRows,
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
