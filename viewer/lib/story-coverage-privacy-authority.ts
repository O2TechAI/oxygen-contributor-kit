import type { getLocalDatabase } from "../db";
import { computeSourceDigest } from "./redaction-pass.mjs";
import type { SemanticManifestAuthority } from "./story-readiness.ts";
import { validActivatedSourceRevision } from "./authority-validation.mjs";
import {
  buildCurrentSourcePrivacyDialogue,
  validateStoredSourcePrivacyReceipt,
  type CurrentSourceRow,
  type PersistedSourcePrivacyRedaction,
} from "./source-privacy-receipt.ts";

type CoveragePrivacyDatabase = Awaited<ReturnType<typeof getLocalDatabase>>;
type JsonRecord = Record<string, unknown>;

export const MAX_SOURCE_PRIVACY_AUTHORITY_BYTES = 8_000_000;

const JOB_KEYS = [
  "id", "status", "stage", "model", "completed", "total", "rejected",
  "source_revision", "source_digest", "receipt_digest", "started_at", "updated_at",
  "completed_at",
] as const;
const REDACTION_KEYS = [
  "id", "item_id", "document_id", "start_offset", "end_offset", "category", "confidence",
  "reason", "review_state", "uncertainty_reason", "status", "created_by", "created_at",
  "updated_at",
] as const;
const SOURCE_PRIVACY_CATEGORIES = new Set([
  "credential", "private-personal", "sensitive", "internal-metric", "internal-timeline",
  "mosaic-reidentification",
]);
const FINAL_REDACTION_STATES = new Set(["deterministic", "confirmed_redact"]);
const PERSISTED_REDACTION_STATES = new Set([
  "deterministic", "needs_confirmation", "confirmed_keep", "confirmed_redact",
]);
const encoder = new TextEncoder();
const hexDigest = (value: unknown): value is string => typeof value === "string"
  && /^[0-9a-f]{64}$/.test(value);
const boundedId = (value: unknown): value is string => typeof value === "string"
  && Boolean(value.trim()) && encoder.encode(value).byteLength <= 300;
const exactKeys = (value: JsonRecord, keys: readonly string[]) => (
  Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key))
);

function compareUtf8(left: string, right: string) {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.length - rightBytes.length;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("Authority value is not JSON-compatible");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as JsonRecord;
  return `{${Object.keys(record).sort(compareUtf8).map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(",")}}`;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type CoveragePrivacySemanticAuthority = SemanticManifestAuthority;

type SourcePrivacyRow = {
  id: string;
  item_id: string;
  document_id: string;
  start_offset: number;
  end_offset: number;
  category: string;
  confidence: string | null;
  reason: string | null;
  review_state: string;
  uncertainty_reason: string | null;
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
};

type SourcePrivacyJob = {
  id: string;
  status: string;
  stage: string;
  model: string | null;
  completed: number;
  total: number;
  rejected: number;
  source_revision: number;
  source_digest: string;
  receipt_digest: string;
  started_at: string;
  updated_at: string;
  completed_at: string;
};

type CurrentItemAuthority = {
  id: string;
  documentId: string;
  contentLength: number;
};

export type CoveragePrivacyAuthority = {
  authorizedUnitIds: ReadonlySet<string>;
  snapshotDigest: string;
  sourceDigest: string;
  semanticProjectId?: string;
  semanticSourceDigest?: string;
  semanticUniverseDigest?: string;
  semanticUnitCount?: number;
  semanticManifestRevision: number;
  semanticManifestDigest: string;
  redactionWitnessJson?: string;
  semanticUnitWitnessJson?: string;
  membershipWitnessJson?: string;
  sourcePrivacyJobWitnessJson?: string;
  sourcePrivacyReceiptWitnessJson?: string;
  sourceItemWitnessJson?: string;
  storedCoverageManifestWitnessJson?: string;
  storedCoverageRowsWitnessJson?: string;
  reviewedNarrativeByItemId?: ReadonlyMap<string, string>;
  workflowRunId?: string;
  storySourceRevision?: number;
  corpusRevision?: number;
  corpusDigest?: string;
};

export type CoveragePrivacyAuthorityValidation =
  | { ok: true; authority: CoveragePrivacyAuthority }
  | { ok: false; code: "COVERAGE_PRIVACY_AUTHORITY_MISSING" };

function invalid(): CoveragePrivacyAuthorityValidation {
  return { ok: false, code: "COVERAGE_PRIVACY_AUTHORITY_MISSING" };
}

/** Structural projection for the provider-free coverage finalizer. This is not
 * semantic authority validation: only the server reader below may turn it into
 * durable readiness, after `readSemanticManifestAuthority` has checked every
 * source and membership digest. */
function projectSemanticMembershipStructure(
  semanticManifest: CoveragePrivacySemanticAuthority,
) {
  if (!semanticManifest || typeof semanticManifest !== "object"
    || !Array.isArray(semanticManifest.units)) return null;
  const memberToUnit = new Map<string, string>();
  for (const unit of semanticManifest.units) {
    if (!unit || !boundedId(unit.id) || !Array.isArray(unit.members)) return null;
    for (const member of unit.members) {
      if (!boundedId(member) || memberToUnit.has(member)) return null;
      memberToUnit.set(member, unit.id);
    }
  }
  const canonicalManifest = {
    projectId: semanticManifest.projectId,
    revision: semanticManifest.revision,
    sourceDigest: semanticManifest.sourceDigest,
    universeDigest: semanticManifest.universeDigest,
    units: semanticManifest.units,
  };
  return {
    canonicalManifest,
    memberToUnit,
    universe: [...memberToUnit.keys()].sort(compareUtf8),
  };
}

function parseSourcePrivacyProjection(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const projection = input as JsonRecord;
  if (!exactKeys(projection, ["redactions", "job"]) || !Array.isArray(projection.redactions)
    || !projection.job || typeof projection.job !== "object" || Array.isArray(projection.job)) {
    return null;
  }
  const job = projection.job as JsonRecord;
  if (!exactKeys(job, JOB_KEYS) || !boundedId(job.id) || job.status !== "complete"
    || typeof job.stage !== "string" || !job.stage.trim()
    || (job.model !== null && typeof job.model !== "string")
    || !Number.isSafeInteger(job.completed) || Number(job.completed) < 0
    || !Number.isSafeInteger(job.total) || Number(job.total) < 0
    || job.completed !== job.total || job.rejected !== 0
    || !validActivatedSourceRevision(job.source_revision)
    || !hexDigest(job.source_digest) || !hexDigest(job.receipt_digest)
    || typeof job.started_at !== "string" || typeof job.updated_at !== "string"
    || typeof job.completed_at !== "string") return null;
  const rows: SourcePrivacyRow[] = [];
  const ids = new Set<string>();
  let previous: SourcePrivacyRow | null = null;
  const lastEnd = new Map<string, number>();
  for (const candidate of projection.redactions) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const row = candidate as JsonRecord;
    if (!exactKeys(row, REDACTION_KEYS) || !boundedId(row.id) || ids.has(row.id)
      || !boundedId(row.item_id) || !boundedId(row.document_id)
      || !Number.isSafeInteger(row.start_offset) || !Number.isSafeInteger(row.end_offset)
      || Number(row.start_offset) < 0 || Number(row.end_offset) <= Number(row.start_offset)
      || typeof row.category !== "string" || !SOURCE_PRIVACY_CATEGORIES.has(row.category)
      || (row.confidence !== null && typeof row.confidence !== "string")
      || (row.reason !== null && typeof row.reason !== "string")
      || typeof row.review_state !== "string" || !PERSISTED_REDACTION_STATES.has(row.review_state)
      || (row.uncertainty_reason !== null && typeof row.uncertainty_reason !== "string")
      || typeof row.status !== "string" || typeof row.created_by !== "string"
      || typeof row.created_at !== "string" || typeof row.updated_at !== "string") return null;
    const normalized = row as unknown as SourcePrivacyRow;
    const expectedStatus = normalized.review_state === "confirmed_keep" ? "removed" : "active";
    if (normalized.status !== expectedStatus
      || (normalized.review_state === "deterministic" && normalized.uncertainty_reason !== null)
      || (normalized.review_state === "needs_confirmation"
        && !normalized.uncertainty_reason?.trim())) return null;
    if (previous && (compareUtf8(previous.document_id, normalized.document_id)
      || compareUtf8(previous.item_id, normalized.item_id)
      || previous.start_offset - normalized.start_offset
      || compareUtf8(previous.id, normalized.id)) > 0) return null;
    if (normalized.start_offset < (lastEnd.get(normalized.item_id) || 0)) return null;
    lastEnd.set(normalized.item_id, normalized.end_offset);
    ids.add(normalized.id);
    rows.push(normalized);
    previous = normalized;
  }
  if (job.completed !== rows.length) return null;
  return { job: job as unknown as SourcePrivacyJob, rows };
}

export async function deriveCoveragePrivacyAuthority(
  sourcePrivacyProjection: unknown,
  semanticManifest: CoveragePrivacySemanticAuthority,
  options: {
    expectedSourceDigest?: string;
    expectedSourceRevision?: number;
    currentItems?: CurrentItemAuthority[];
  } = {},
): Promise<CoveragePrivacyAuthorityValidation> {
  const semantic = projectSemanticMembershipStructure(semanticManifest);
  const privacy = parseSourcePrivacyProjection(sourcePrivacyProjection);
  if (!semantic || !privacy
    || await sha256(canonicalJson(semantic.canonicalManifest)) !== semanticManifest.manifestDigest
    || await sha256(canonicalJson(semantic.universe)) !== semanticManifest.universeDigest
    || (options.expectedSourceDigest !== undefined
      && privacy.job.source_digest !== options.expectedSourceDigest)
    || (options.expectedSourceRevision !== undefined
      && privacy.job.source_revision !== options.expectedSourceRevision)) return invalid();
  const currentItems = options.currentItems
    ? new Map(options.currentItems.map((item) => [item.id, item]))
    : null;
  if (currentItems && currentItems.size !== options.currentItems!.length) return invalid();
  const authorizedUnitIds = new Set<string>();
  for (const row of privacy.rows) {
    const unitId = semantic.memberToUnit.get(row.item_id);
    const item = currentItems?.get(row.item_id);
    if (!unitId || (currentItems && (!item || item.documentId !== row.document_id
      || row.end_offset > item.contentLength))) return invalid();
    if (FINAL_REDACTION_STATES.has(row.review_state)) authorizedUnitIds.add(unitId);
  }
  const authorized = [...authorizedUnitIds].sort(compareUtf8);
  const snapshot = {
    sourcePrivacyJob: privacy.job,
    redactions: privacy.rows,
    semanticManifest: semantic.canonicalManifest,
    semanticManifestDigest: semanticManifest.manifestDigest,
    authorizedUnitIds: authorized,
  };
  return {
    ok: true,
    authority: {
      authorizedUnitIds: new Set(authorized),
      snapshotDigest: await sha256(canonicalJson(snapshot)),
      sourceDigest: privacy.job.source_digest,
      semanticManifestRevision: semanticManifest.revision,
      semanticManifestDigest: semanticManifest.manifestDigest,
    },
  };
}

type SourceItemRow = {
  id: string;
  document_id: string;
  document_kind: string;
  sequence: number;
  event_type: string | null;
  actor_type: string | null;
  timestamp: string | null;
  content: string;
  original_json: string;
  content_length: number;
};

function privacyReviewedNarrative(
  items: SourceItemRow[],
) {
  return new Map(items.map((row) => [
    row.id,
    row.content,
  ]));
}

export async function readCoveragePrivacyAuthority(
  db: CoveragePrivacyDatabase,
  workflowRunId: string,
  semanticManifest: CoveragePrivacySemanticAuthority,
  options: { verifyCurrentSource?: boolean } = {},
): Promise<CoveragePrivacyAuthorityValidation> {
  const { readSemanticManifestAuthority } = await import("./story-readiness.ts");
  const currentSemanticManifest = await readSemanticManifestAuthority(db, workflowRunId);
  if (!currentSemanticManifest
    || currentSemanticManifest.projectId !== semanticManifest.projectId
    || currentSemanticManifest.revision !== semanticManifest.revision
    || currentSemanticManifest.manifestDigest !== semanticManifest.manifestDigest) return invalid();
  semanticManifest = currentSemanticManifest;
  const verifyCurrentSource = options.verifyCurrentSource !== false;
  const [binding, jobResult, receiptResult, redactionResult, itemResult, unitResult, memberResult,
    storedCoverageManifest, storedCoverageRows] = await Promise.all([
    db.prepare(`SELECT r.id AS workflow_run_id,r.story_generation_status,r.story_source_revision,
        m.source_revision,m.project_id,m.revision,m.source_digest,m.universe_digest,
        m.manifest_digest,m.unit_count,m.serialized_bytes,m.story_projection_bytes,
        m.corpus_revision,m.corpus_digest,
        m.corpus_document_count,m.corpus_item_count,f.corpus_revision AS finalized_revision,
        f.corpus_digest AS finalized_digest,f.document_count,f.item_count,
        (SELECT COUNT(*) FROM documents) AS current_document_count,
        (SELECT COUNT(*) FROM items) AS current_item_count,
        (SELECT COUNT(*) FROM semantic_units WHERE workflow_run_id=?) AS current_unit_count,
        (SELECT COUNT(*) FROM semantic_unit_members WHERE workflow_run_id=?) AS current_member_count
      FROM workflow_runs r JOIN semantic_manifests m ON m.workflow_run_id=r.id
      JOIN finalized_corpus_manifests f ON f.workflow_run_id=r.id WHERE r.id=?`)
      .bind(workflowRunId, workflowRunId, workflowRunId).first<JsonRecord>(),
    db.prepare(`SELECT j.id,j.status,j.stage,j.model,j.completed,j.total,j.rejected,
        p.source_revision,j.source_digest,p.receipt_digest,j.started_at,j.updated_at,j.completed_at
      FROM redaction_jobs j LEFT JOIN source_privacy_receipts p ON p.job_id=j.id
      ORDER BY j.started_at DESC,j.id DESC`)
      .all<JsonRecord>(),
    db.prepare(`SELECT job_id,workflow_run_id,source_revision,source_digest,receipt_digest,
        receipt_json,created_at FROM source_privacy_receipts ORDER BY job_id`)
      .all<JsonRecord>(),
    db.prepare(`SELECT id,item_id,document_id,start_offset,end_offset,category,confidence,reason,
        review_state,uncertainty_reason,status,created_by,created_at,updated_at
      FROM redactions ORDER BY document_id,item_id,start_offset,id`).all<JsonRecord>(),
    db.prepare(verifyCurrentSource
      ? `SELECT i.id,i.document_id,d.kind AS document_kind,i.sequence,i.event_type,i.actor_type,
          i.timestamp,i.content,i.original_json,length(i.content) AS content_length
          FROM items i LEFT JOIN documents d ON d.id=i.document_id
          ORDER BY i.document_id,i.sequence,i.id`
      : `SELECT i.id,i.document_id,'' AS document_kind,i.sequence,i.event_type,i.actor_type,
          i.timestamp,'' AS content,'' AS original_json,0 AS content_length
          FROM items i ORDER BY i.document_id,i.sequence,i.id`)
      .all<SourceItemRow>(),
    db.prepare(`SELECT id,workflow_run_id,revision,project_id,kind,member_count,
        membership_digest,duplicate_of_unit_id,story_projection_json
      FROM semantic_units WHERE workflow_run_id=? ORDER BY id`)
      .bind(workflowRunId).all<JsonRecord>(),
    db.prepare(`SELECT unit_id,item_id,source_digest FROM semantic_unit_members
      WHERE workflow_run_id=? ORDER BY unit_id,item_id`).bind(workflowRunId).all<JsonRecord>(),
    db.prepare(`SELECT revision,semantic_manifest_revision,semantic_manifest_digest,
        coverage_digest,privacy_authority_digest,unit_count,serialized_bytes
      FROM story_coverage_manifests WHERE workflow_run_id=?`)
      .bind(workflowRunId).first<JsonRecord>(),
    db.prepare(`SELECT unit_id,disposition,owner_id,exclusion_reason
      FROM story_coverage_rows WHERE workflow_run_id=? ORDER BY unit_id`)
      .bind(workflowRunId).all<JsonRecord>(),
  ]);
  if (!binding || jobResult.results.length !== 1 || receiptResult.results.length !== 1
    || !validActivatedSourceRevision(Number(binding.story_source_revision))
    || Number(binding.story_source_revision) !== Number(binding.source_revision)
    || binding.project_id !== semanticManifest.projectId
    || Number(binding.revision) !== semanticManifest.revision
    || binding.source_digest !== semanticManifest.sourceDigest
    || binding.universe_digest !== semanticManifest.universeDigest
    || binding.manifest_digest !== semanticManifest.manifestDigest
    || Number(binding.unit_count) !== semanticManifest.units.length
    || Number(binding.corpus_revision) !== Number(binding.finalized_revision)
    || binding.corpus_digest !== binding.finalized_digest
    || Number(binding.corpus_document_count) !== Number(binding.document_count)
    || Number(binding.corpus_item_count) !== Number(binding.item_count)
    || Number(binding.current_document_count) !== Number(binding.document_count)
    || Number(binding.current_item_count) !== Number(binding.item_count)
    || Number(binding.current_unit_count) !== semanticManifest.units.length
    || Number(binding.current_member_count) !== itemResult.results.length) return invalid();

  const storedMemberByItem = new Map<string, JsonRecord>();
  for (const row of memberResult.results) {
    const itemId = String(row.item_id);
    if (storedMemberByItem.has(itemId)) return invalid();
    storedMemberByItem.set(itemId, row);
  }
  const expectedMembers = semanticManifest.units.flatMap((unit) => unit.members.map((itemId) => {
    const stored = storedMemberByItem.get(itemId);
    return { unit_id: unit.id, item_id: itemId, source_digest: stored?.source_digest };
  }));
  if (expectedMembers.some((row) => typeof row.source_digest !== "string")) return invalid();
  const expectedUnits = semanticManifest.units.map((unit) => ({
    id: unit.id,
    workflow_run_id: workflowRunId,
    revision: unit.revision,
    project_id: unit.projectId,
    kind: unit.kind,
    member_count: unit.memberCount,
    membership_digest: unit.membershipDigest,
    duplicate_of_unit_id: unit.duplicateOfUnitId ?? null,
    story_projection_json: JSON.stringify(unit.storyProjection || {}),
  }));
  const sourceItemIds = itemResult.results.map((row) => row.id).sort(compareUtf8);
  const semanticMemberIds = memberResult.results.map((row) => String(row.item_id)).sort(compareUtf8);
  if (canonicalJson(expectedUnits) !== canonicalJson(unitResult.results)
    || canonicalJson(expectedMembers) !== canonicalJson(memberResult.results)
    || canonicalJson(sourceItemIds) !== canonicalJson(semanticMemberIds)) return invalid();
  const currentSourceDigest = verifyCurrentSource
    ? await computeSourceDigest(itemResult.results)
    : undefined;
  let currentDialogue;
  if (verifyCurrentSource) {
    try {
      currentDialogue = await buildCurrentSourcePrivacyDialogue(
        itemResult.results as unknown as CurrentSourceRow[],
      );
    } catch {
      return invalid();
    }
  }
  const derived = await deriveCoveragePrivacyAuthority({
    job: jobResult.results[0],
    redactions: redactionResult.results,
  }, semanticManifest, {
    expectedSourceDigest: currentSourceDigest,
    ...(verifyCurrentSource ? {
      currentItems: itemResult.results.map((row) => ({
        id: row.id,
        documentId: row.document_id,
        contentLength: Number(row.content_length),
      })),
    } : {}),
  });
  if (!derived.ok) return derived;
  const receiptSourceRevision = Number(receiptResult.results[0].source_revision);
  if (!validActivatedSourceRevision(receiptSourceRevision)
    || receiptSourceRevision > Number(binding.story_source_revision)) return invalid();
  const receipt = await validateStoredSourcePrivacyReceipt(receiptResult.results[0], {
    jobId: String(jobResult.results[0].id),
    workflowRunId,
    sourceRevision: receiptSourceRevision,
    sourceDigest: currentSourceDigest || String(jobResult.results[0].source_digest),
    finalizedCorpus: {
      revision: Number(binding.finalized_revision),
      digest: String(binding.finalized_digest),
      documentCount: Number(binding.document_count),
      itemCount: Number(binding.item_count),
    },
    ...(currentDialogue ? { dialogue: currentDialogue } : {}),
    redactions: redactionResult.results as unknown as PersistedSourcePrivacyRedaction[],
  });
  if (!receipt) return invalid();
  const redactionWitnessJson = JSON.stringify(redactionResult.results);
  const semanticUnitWitnessJson = JSON.stringify(unitResult.results);
  const membershipWitnessJson = JSON.stringify(memberResult.results);
  const sourcePrivacyJobWitnessJson = JSON.stringify(jobResult.results);
  const sourcePrivacyReceiptWitnessJson = JSON.stringify(receiptResult.results);
  const sourceItemWitnessJson = verifyCurrentSource ? JSON.stringify(itemResult.results.map((row) => ({
    id: row.id,
    document_id: row.document_id,
    sequence: row.sequence,
    event_type: row.event_type,
    actor_type: row.actor_type,
    timestamp: row.timestamp,
    content: row.content,
  }))) : undefined;
  const reviewedNarrativeByItemId = verifyCurrentSource
    ? privacyReviewedNarrative(itemResult.results)
    : null;
  const storedCoverageManifestWitnessJson = JSON.stringify(storedCoverageManifest || null);
  const storedCoverageRowsWitnessJson = JSON.stringify(storedCoverageRows.results);
  const bindingSnapshot = {
    workflowRunId,
    corpusRevision: Number(binding.corpus_revision),
    corpusDigest: String(binding.corpus_digest),
    currentSourceDigest: currentSourceDigest || derived.authority.sourceDigest,
    redactionWitnessJson,
    semanticUnitWitnessJson,
    membershipWitnessJson,
    sourcePrivacyJobWitnessJson,
    sourcePrivacyReceiptWitnessJson,
  };
  const snapshotDigest = await sha256(canonicalJson({
    derived: derived.authority.snapshotDigest,
    binding: bindingSnapshot,
  }));
  if (!verifyCurrentSource && (!storedCoverageManifest
    || storedCoverageManifest.privacy_authority_digest !== snapshotDigest)) return invalid();
  return {
    ok: true,
    authority: {
      ...derived.authority,
      semanticProjectId: semanticManifest.projectId,
      semanticSourceDigest: semanticManifest.sourceDigest,
      semanticUniverseDigest: semanticManifest.universeDigest,
      semanticUnitCount: semanticManifest.units.length,
      snapshotDigest,
      redactionWitnessJson,
      semanticUnitWitnessJson,
      membershipWitnessJson,
      sourcePrivacyJobWitnessJson,
      sourcePrivacyReceiptWitnessJson,
      sourceItemWitnessJson,
      ...(reviewedNarrativeByItemId ? { reviewedNarrativeByItemId } : {}),
      storedCoverageManifestWitnessJson,
      storedCoverageRowsWitnessJson,
      workflowRunId,
      storySourceRevision: Number(binding.story_source_revision),
      corpusRevision: Number(binding.corpus_revision),
      corpusDigest: String(binding.corpus_digest),
    },
  };
}

/** This statement must be first in the activation batch. It contains no raw
 * source text and turns a late authority mutation into a transaction rollback. */
export function coveragePrivacyAuthorityGuardStatement(
  db: CoveragePrivacyDatabase,
  authority: CoveragePrivacyAuthority,
  expectedStoryGenerationStatus = "source_writing_generation",
) {
  if (!authority.sourceItemWitnessJson) {
    throw new Error("Current source verification is required for activation");
  }
  return db.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM workflow_runs r
        JOIN semantic_manifests m ON m.workflow_run_id=r.id
        JOIN finalized_corpus_manifests f ON f.workflow_run_id=r.id
        WHERE r.id=? AND r.story_source_revision=?
          AND r.story_generation_status=?
          AND m.source_revision=? AND m.project_id=? AND m.revision=?
          AND m.source_digest=? AND m.universe_digest=? AND m.manifest_digest=?
          AND m.unit_count=?
          AND m.corpus_revision=? AND m.corpus_digest=?
          AND m.corpus_revision=f.corpus_revision AND m.corpus_digest=f.corpus_digest
          AND m.corpus_document_count=f.document_count AND m.corpus_item_count=f.item_count
          AND f.document_count=(SELECT COUNT(*) FROM documents)
          AND f.item_count=(SELECT COUNT(*) FROM items))
      AND (SELECT COALESCE(json_group_array(json_object(
          'id',id,'item_id',item_id,'document_id',document_id,
          'start_offset',start_offset,'end_offset',end_offset,'category',category,
          'confidence',confidence,'reason',reason,'review_state',review_state,
          'uncertainty_reason',uncertainty_reason,'status',status,'created_by',created_by,
          'created_at',created_at,'updated_at',updated_at)), '[]')
        FROM (SELECT id,item_id,document_id,start_offset,end_offset,category,confidence,reason,
          review_state,uncertainty_reason,status,created_by,created_at,updated_at
          FROM redactions ORDER BY document_id,item_id,start_offset,id))=?
      AND (SELECT COALESCE(json_group_array(json_object(
          'id',id,'workflow_run_id',workflow_run_id,'revision',revision,
          'project_id',project_id,'kind',kind,'member_count',member_count,
          'membership_digest',membership_digest,'duplicate_of_unit_id',duplicate_of_unit_id,
          'story_projection_json',story_projection_json)), '[]')
        FROM (SELECT id,workflow_run_id,revision,project_id,kind,member_count,
          membership_digest,duplicate_of_unit_id,story_projection_json FROM semantic_units
          WHERE workflow_run_id=? ORDER BY id))=?
      AND (SELECT COALESCE(json_group_array(json_object(
          'unit_id',unit_id,'item_id',item_id,'source_digest',source_digest)), '[]')
        FROM (SELECT unit_id,item_id,source_digest FROM semantic_unit_members
          WHERE workflow_run_id=? ORDER BY unit_id,item_id))=?
      AND (SELECT COALESCE(json_group_array(json_object(
          'id',id,'status',status,'stage',stage,'model',model,'completed',completed,
          'total',total,'rejected',rejected,'source_revision',source_revision,
          'source_digest',source_digest,'receipt_digest',receipt_digest,
          'started_at',started_at,'updated_at',updated_at,'completed_at',completed_at)), '[]')
        FROM (SELECT j.id,j.status,j.stage,j.model,j.completed,j.total,j.rejected,
          p.source_revision,j.source_digest,p.receipt_digest,j.started_at,j.updated_at,j.completed_at
          FROM redaction_jobs j LEFT JOIN source_privacy_receipts p ON p.job_id=j.id
           ORDER BY j.started_at DESC,j.id DESC))=?
      AND (SELECT COALESCE(json_group_array(json_object(
          'job_id',job_id,'workflow_run_id',workflow_run_id,'source_revision',source_revision,
          'source_digest',source_digest,'receipt_digest',receipt_digest,
          'receipt_json',receipt_json,'created_at',created_at)), '[]')
        FROM (SELECT job_id,workflow_run_id,source_revision,source_digest,receipt_digest,
          receipt_json,created_at FROM source_privacy_receipts ORDER BY job_id))=?
      AND (SELECT COALESCE(json_group_array(json_object(
          'id',id,'document_id',document_id,'sequence',sequence,'event_type',event_type,
          'actor_type',actor_type,'timestamp',timestamp,'content',content)), '[]')
        FROM (SELECT id,document_id,sequence,event_type,actor_type,timestamp,content
          FROM items ORDER BY document_id,sequence,id))=?
      AND COALESCE((SELECT json_object('revision',revision,
          'semantic_manifest_revision',semantic_manifest_revision,
          'semantic_manifest_digest',semantic_manifest_digest,'coverage_digest',coverage_digest,
          'privacy_authority_digest',privacy_authority_digest,
          'unit_count',unit_count,'serialized_bytes',serialized_bytes)
        FROM story_coverage_manifests WHERE workflow_run_id=?), 'null')=?
      AND (SELECT COALESCE(json_group_array(json_object(
          'unit_id',unit_id,'disposition',disposition,'owner_id',owner_id,
          'exclusion_reason',exclusion_reason)), '[]')
        FROM (SELECT unit_id,disposition,owner_id,exclusion_reason
          FROM story_coverage_rows WHERE workflow_run_id=? ORDER BY unit_id))=?
    THEN 1 ELSE json_extract('coverage privacy authority changed','$') END AS authority_guard`)
    .bind(
      authority.workflowRunId,
      authority.storySourceRevision,
      expectedStoryGenerationStatus,
      authority.storySourceRevision,
      authority.semanticProjectId,
      authority.semanticManifestRevision,
      authority.semanticSourceDigest,
      authority.semanticUniverseDigest,
      authority.semanticManifestDigest,
      authority.semanticUnitCount,
      authority.corpusRevision,
      authority.corpusDigest,
      authority.redactionWitnessJson,
      authority.workflowRunId,
      authority.semanticUnitWitnessJson,
      authority.workflowRunId,
      authority.membershipWitnessJson,
      authority.sourcePrivacyJobWitnessJson,
      authority.sourcePrivacyReceiptWitnessJson,
      authority.sourceItemWitnessJson,
      authority.workflowRunId,
      authority.storedCoverageManifestWitnessJson,
      authority.workflowRunId,
      authority.storedCoverageRowsWitnessJson,
    );
}
