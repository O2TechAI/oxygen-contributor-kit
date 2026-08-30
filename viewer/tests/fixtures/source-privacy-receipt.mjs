import { computeSourceDigest } from "../../lib/redaction-pass.mjs";
import {
  buildCurrentSourcePrivacyDialogue,
  canonicalSourcePrivacyJson,
  canonicalSourcePrivacyRedactions,
  parseSourcePrivacyReceipt,
  sourcePrivacyDigest,
} from "../../lib/source-privacy-receipt.ts";

export async function seedFinalizedCorpusManifest(db, {
  workflowRunId,
  revision = 1,
  digest = "c".repeat(64),
  at = "2036-01-01T00:00:00.000Z",
} = {}) {
  const [documentCount, itemCount] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS count FROM documents").first(),
    db.prepare("SELECT COUNT(*) AS count FROM items").first(),
  ]);
  const value = {
    revision,
    digest,
    documentCount: Number(documentCount?.count || 0),
    itemCount: Number(itemCount?.count || 0),
  };
  await db.prepare(`INSERT INTO finalized_corpus_manifests
    (workflow_run_id,corpus_revision,corpus_digest,document_count,item_count,finalized_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(workflow_run_id) DO UPDATE SET
      corpus_revision=excluded.corpus_revision,corpus_digest=excluded.corpus_digest,
      document_count=excluded.document_count,item_count=excluded.item_count,
      finalized_at=excluded.finalized_at`).bind(
    workflowRunId, value.revision, value.digest, value.documentCount, value.itemCount, at,
  ).run();
  return value;
}

export async function buildSourcePrivacyReceipt(db, {
  workflowRunId,
  sourceRevision,
  redactions = [],
} = {}) {
  const [sourceResult, manifest, documentCount, itemCount] = await Promise.all([
    db.prepare(`SELECT i.document_id,d.kind AS document_kind,i.id,i.sequence,i.event_type,
      i.actor_type,i.timestamp,i.content,i.original_json
      FROM items i LEFT JOIN documents d ON d.id=i.document_id
      ORDER BY i.document_id,i.sequence,i.id`).all(),
    db.prepare(`SELECT corpus_revision,corpus_digest,document_count,item_count
      FROM finalized_corpus_manifests WHERE workflow_run_id=?`).bind(workflowRunId).first(),
    db.prepare("SELECT COUNT(*) AS count FROM documents").first(),
    db.prepare("SELECT COUNT(*) AS count FROM items").first(),
  ]);
  if (!manifest
    || Number(documentCount?.count) !== Number(manifest.document_count)
    || Number(itemCount?.count) !== Number(manifest.item_count)
    || sourceResult.results.length !== Number(manifest.item_count)) {
    throw new Error("Synthetic finalized corpus manifest is missing or stale");
  }
  const canonicalRedactions = canonicalSourcePrivacyRedactions(redactions);
  const core = {
    status: "complete",
    workflowRunId,
    sourceRevision,
    finalizedCorpus: {
      revision: Number(manifest.corpus_revision),
      digest: String(manifest.corpus_digest),
      documentCount: Number(manifest.document_count),
      itemCount: Number(manifest.item_count),
    },
    sourceDigest: await computeSourceDigest(sourceResult.results),
    dialogue: await buildCurrentSourcePrivacyDialogue(sourceResult.results),
    redactions: {
      count: canonicalRedactions.length,
      digest: await sourcePrivacyDigest(canonicalRedactions),
    },
  };
  return { ...core, receiptDigest: await sourcePrivacyDigest(core) };
}

export async function installSourcePrivacyReceipt(db, {
  jobId,
  workflowRunId,
  receipt,
  at = "2036-01-01T00:00:00.000Z",
} = {}) {
  const validated = await parseSourcePrivacyReceipt(receipt);
  if (!validated || validated.workflowRunId !== workflowRunId) {
    throw new Error("Synthetic Source Privacy receipt is invalid or foreign");
  }
  await db.prepare(`INSERT INTO source_privacy_receipts
    (job_id,workflow_run_id,source_revision,source_digest,receipt_digest,receipt_json,created_at)
    VALUES (?,?,?,?,?,?,?)`).bind(
    jobId, workflowRunId, receipt.sourceRevision, receipt.sourceDigest,
    receipt.receiptDigest, canonicalSourcePrivacyJson(receipt), at,
  ).run();
}
