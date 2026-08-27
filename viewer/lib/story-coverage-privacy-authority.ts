import type { getLocalDatabase } from "../db";
import { computeSourceDigest } from "./redaction-pass.mjs";

type CoveragePrivacyDatabase = Awaited<ReturnType<typeof getLocalDatabase>>;
type JsonRecord = Record<string, unknown>;

export const MAX_SOURCE_PRIVACY_AUTHORITY_BYTES = 8_000_000;

const JOB_KEYS = [
  "id", "status", "stage", "model", "completed", "total", "rejected", "source_digest",
  "started_at", "updated_at", "completed_at",
] as const;
const REDACTION_KEYS = [
  "id", "item_id", "document_id", "start_offset", "end_offset", "category", "confidence",
  "reason", "review_state", "uncertainty_reason", "status", "created_by", "created_at",
  "updated_at",
] as const;
const SEMANTIC_MANIFEST_KEYS = [
  "projectId", "revision", "sourceDigest", "universeDigest", "manifestDigest", "units",
  "serializedBytes",
] as const;
const SEMANTIC_UNIT_KEYS = [
  "id", "revision", "projectId", "kind", "members", "memberCount", "membershipDigest",
  "duplicateOfUnitId", "storyProjection",
] as const;
const SEMANTIC_UNIT_KINDS = new Set([
  "discussion", "decision_episode", "failed_attempt", "experiment", "correction", "handoff",
  "review_cycle", "progression", "routine", "duplicate",
]);
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

type SemanticUnitMembership = {
  id: string;
  revision: number;
  projectId: string;
  kind: string;
  members: string[];
  memberCount: number;
  membershipDigest: string;
  duplicateOfUnitId?: string;
  storyProjection?: { label: string; summary: string };
};

export type CoveragePrivacySemanticAuthority = {
  projectId: string;
  revision: number;
  sourceDigest: string;
  universeDigest: string;
  manifestDigest: string;
  units: SemanticUnitMembership[];
};

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
  source_digest: string;
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
  semanticManifestRevision: number;
  semanticManifestDigest: string;
  mutationVersion?: number;
  redactionWitnessJson?: string;
  membershipWitnessJson?: string;
  sourcePrivacyJobWitnessJson?: string;
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

function normalizedSemanticMembership(
  semanticManifest: CoveragePrivacySemanticAuthority,
) {
  const manifestRecord = semanticManifest as unknown as JsonRecord;
  if (!semanticManifest || typeof semanticManifest !== "object"
    || Object.keys(manifestRecord).some((key) => (
      !(SEMANTIC_MANIFEST_KEYS as readonly string[]).includes(key)
    ))
    || !boundedId(semanticManifest.projectId)
    || !Number.isSafeInteger(semanticManifest.revision) || semanticManifest.revision < 1
    || !hexDigest(semanticManifest.sourceDigest) || !hexDigest(semanticManifest.universeDigest)
    || !hexDigest(semanticManifest.manifestDigest) || !Array.isArray(semanticManifest.units)
    || (manifestRecord.serializedBytes !== undefined
      && (!Number.isSafeInteger(manifestRecord.serializedBytes)
        || Number(manifestRecord.serializedBytes) < 0))
    || semanticManifest.units.length > 512) return null;
  const units: SemanticUnitMembership[] = [];
  const memberToUnit = new Map<string, string>();
  let previousUnitId: string | null = null;
  for (const candidate of semanticManifest.units) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
      || Object.keys(candidate).some((key) => (
        !(SEMANTIC_UNIT_KEYS as readonly string[]).includes(key)
      ))
      || !boundedId(candidate.id) || !Number.isSafeInteger(candidate.revision)
      || candidate.revision < 1 || candidate.projectId !== semanticManifest.projectId
      || typeof candidate.kind !== "string" || !SEMANTIC_UNIT_KINDS.has(candidate.kind)
      || !Array.isArray(candidate.members)
      || candidate.members.length === 0 || candidate.memberCount !== candidate.members.length
      || !hexDigest(candidate.membershipDigest)
      || (candidate.duplicateOfUnitId !== undefined && !boundedId(candidate.duplicateOfUnitId))
      || (candidate.storyProjection !== undefined && (
        !candidate.storyProjection || typeof candidate.storyProjection !== "object"
        || Array.isArray(candidate.storyProjection)
        || !exactKeys(candidate.storyProjection as unknown as JsonRecord, ["label", "summary"])
        || typeof candidate.storyProjection.label !== "string"
        || typeof candidate.storyProjection.summary !== "string"
      ))
      || (previousUnitId !== null && compareUtf8(previousUnitId, candidate.id) >= 0)) return null;
    previousUnitId = candidate.id;
    let previousMemberId: string | null = null;
    for (const member of candidate.members) {
      if (!boundedId(member) || memberToUnit.has(member)
        || (previousMemberId !== null && compareUtf8(previousMemberId, member) >= 0)) return null;
      previousMemberId = member;
      memberToUnit.set(member, candidate.id);
    }
    units.push(candidate);
  }
  const unitsById = new Map(units.map((unit) => [unit.id, unit]));
  for (const unit of units) {
    if (unit.kind === "duplicate") {
      const target = unit.duplicateOfUnitId ? unitsById.get(unit.duplicateOfUnitId) : undefined;
      if (!target || target.kind === "duplicate" || target.id === unit.id) return null;
    } else if (unit.duplicateOfUnitId !== undefined) return null;
  }
  const canonicalManifest = {
    projectId: semanticManifest.projectId,
    revision: semanticManifest.revision,
    sourceDigest: semanticManifest.sourceDigest,
    universeDigest: semanticManifest.universeDigest,
    units,
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
    || job.completed !== job.total || job.rejected !== 0 || !hexDigest(job.source_digest)
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
    currentItems?: CurrentItemAuthority[];
  } = {},
): Promise<CoveragePrivacyAuthorityValidation> {
  const semantic = normalizedSemanticMembership(semanticManifest);
  const privacy = parseSourcePrivacyProjection(sourcePrivacyProjection);
  if (!semantic || !privacy
    || await sha256(canonicalJson(semantic.canonicalManifest)) !== semanticManifest.manifestDigest
    || await sha256(canonicalJson(semantic.universe)) !== semanticManifest.universeDigest
    || (options.expectedSourceDigest !== undefined
      && privacy.job.source_digest !== options.expectedSourceDigest)) return invalid();
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
  sequence: number;
  event_type: string | null;
  actor_type: string | null;
  timestamp: string | null;
  content: string;
  content_length: number;
};

export async function readCoveragePrivacyAuthority(
  db: CoveragePrivacyDatabase,
  workflowRunId: string,
  semanticManifest: CoveragePrivacySemanticAuthority,
): Promise<CoveragePrivacyAuthorityValidation> {
  const [binding, jobResult, redactionResult, itemResult, memberResult] = await Promise.all([
    db.prepare(`SELECT r.story_source_revision,m.source_revision,m.project_id,m.revision,
        m.source_digest,m.universe_digest,m.manifest_digest,m.corpus_revision,m.corpus_digest,
        m.corpus_document_count,m.corpus_item_count,f.corpus_revision AS finalized_revision,
        f.corpus_digest AS finalized_digest,f.document_count,f.item_count,
        (SELECT COUNT(*) FROM documents) AS current_document_count,
        (SELECT COUNT(*) FROM items) AS current_item_count,
        (SELECT COUNT(*) FROM semantic_units WHERE workflow_run_id=?) AS current_unit_count,
        (SELECT COUNT(*) FROM semantic_unit_members WHERE workflow_run_id=?) AS current_member_count
      FROM workflow_runs r JOIN semantic_manifests m ON m.workflow_run_id=r.id
      JOIN finalized_corpus_manifests f ON f.workflow_run_id=r.id WHERE r.id=?`)
      .bind(workflowRunId, workflowRunId, workflowRunId).first<JsonRecord>(),
    db.prepare(`SELECT id,status,stage,model,completed,total,rejected,source_digest,
        started_at,updated_at,completed_at FROM redaction_jobs ORDER BY started_at DESC,id DESC`)
      .all<JsonRecord>(),
    db.prepare(`SELECT id,item_id,document_id,start_offset,end_offset,category,confidence,reason,
        review_state,uncertainty_reason,status,created_by,created_at,updated_at
      FROM redactions ORDER BY document_id,item_id,start_offset,id`).all<JsonRecord>(),
    db.prepare(`SELECT id,document_id,sequence,event_type,actor_type,timestamp,content,
        length(content) AS content_length FROM items ORDER BY document_id,sequence,id`)
      .all<SourceItemRow>(),
    db.prepare(`SELECT unit_id,item_id,source_digest FROM semantic_unit_members
      WHERE workflow_run_id=? ORDER BY unit_id,item_id`).bind(workflowRunId).all<JsonRecord>(),
  ]);
  if (!binding || jobResult.results.length !== 1
    || Number(binding.story_source_revision) !== Number(binding.source_revision)
    || binding.project_id !== semanticManifest.projectId
    || Number(binding.revision) !== semanticManifest.revision
    || binding.source_digest !== semanticManifest.sourceDigest
    || binding.universe_digest !== semanticManifest.universeDigest
    || binding.manifest_digest !== semanticManifest.manifestDigest
    || Number(binding.corpus_revision) !== Number(binding.finalized_revision)
    || binding.corpus_digest !== binding.finalized_digest
    || Number(binding.corpus_document_count) !== Number(binding.document_count)
    || Number(binding.corpus_item_count) !== Number(binding.item_count)
    || Number(binding.current_document_count) !== Number(binding.document_count)
    || Number(binding.current_item_count) !== Number(binding.item_count)
    || Number(binding.current_unit_count) !== semanticManifest.units.length
    || Number(binding.current_member_count) !== itemResult.results.length) return invalid();

  const expectedMembers = semanticManifest.units.flatMap((unit) => unit.members.map((itemId) => ({
    unit_id: unit.id,
    item_id: itemId,
    source_digest: memberResult.results.find((row) => row.item_id === itemId)?.source_digest,
  })));
  const sourceItemIds = itemResult.results.map((row) => row.id).sort(compareUtf8);
  const semanticMemberIds = memberResult.results.map((row) => String(row.item_id)).sort(compareUtf8);
  if (canonicalJson(expectedMembers) !== canonicalJson(memberResult.results)
    || canonicalJson(sourceItemIds) !== canonicalJson(semanticMemberIds)) return invalid();
  const currentSourceDigest = await computeSourceDigest(itemResult.results);
  const derived = await deriveCoveragePrivacyAuthority({
    job: jobResult.results[0],
    redactions: redactionResult.results,
  }, semanticManifest, {
    expectedSourceDigest: currentSourceDigest,
    currentItems: itemResult.results.map((row) => ({
      id: row.id,
      documentId: row.document_id,
      contentLength: Number(row.content_length),
    })),
  });
  if (!derived.ok) return derived;
  const version = await db.prepare("SELECT total_changes() AS mutation_version")
    .first<{ mutation_version: number }>();
  const redactionWitnessJson = JSON.stringify(redactionResult.results.map((row) => ({
    id: row.id,
    item_id: row.item_id,
    document_id: row.document_id,
    start_offset: row.start_offset,
    end_offset: row.end_offset,
    review_state: row.review_state,
    status: row.status,
    updated_at: row.updated_at,
  })));
  const membershipWitnessJson = JSON.stringify(memberResult.results);
  const sourcePrivacyJobWitnessJson = JSON.stringify(jobResult.results);
  const bindingSnapshot = {
    workflowRunId,
    storySourceRevision: Number(binding.story_source_revision),
    corpusRevision: Number(binding.corpus_revision),
    corpusDigest: String(binding.corpus_digest),
    redactionWitnessJson,
    membershipWitnessJson,
    sourcePrivacyJobWitnessJson,
  };
  return {
    ok: true,
    authority: {
      ...derived.authority,
      snapshotDigest: await sha256(canonicalJson({
        derived: derived.authority.snapshotDigest,
        binding: bindingSnapshot,
      })),
      mutationVersion: Number(version?.mutation_version ?? -1),
      redactionWitnessJson,
      membershipWitnessJson,
      sourcePrivacyJobWitnessJson,
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
) {
  return db.prepare(`SELECT CASE WHEN total_changes()=?
      AND EXISTS (SELECT 1 FROM workflow_runs r
        JOIN semantic_manifests m ON m.workflow_run_id=r.id
        JOIN finalized_corpus_manifests f ON f.workflow_run_id=r.id
        WHERE r.id=? AND r.story_source_revision=? AND m.source_revision=?
          AND m.revision=? AND m.manifest_digest=?
          AND m.corpus_revision=? AND m.corpus_digest=?
          AND m.corpus_revision=f.corpus_revision AND m.corpus_digest=f.corpus_digest
          AND m.corpus_document_count=f.document_count AND m.corpus_item_count=f.item_count
          AND f.document_count=(SELECT COUNT(*) FROM documents)
          AND f.item_count=(SELECT COUNT(*) FROM items))
      AND (SELECT COALESCE(json_group_array(json_object(
          'id',id,'item_id',item_id,'document_id',document_id,
          'start_offset',start_offset,'end_offset',end_offset,
          'review_state',review_state,'status',status,'updated_at',updated_at)), '[]')
        FROM (SELECT id,item_id,document_id,start_offset,end_offset,review_state,status,updated_at
          FROM redactions ORDER BY document_id,item_id,start_offset,id))=?
      AND (SELECT COALESCE(json_group_array(json_object(
          'unit_id',unit_id,'item_id',item_id,'source_digest',source_digest)), '[]')
        FROM (SELECT unit_id,item_id,source_digest FROM semantic_unit_members
          WHERE workflow_run_id=? ORDER BY unit_id,item_id))=?
      AND (SELECT COALESCE(json_group_array(json_object(
          'id',id,'status',status,'stage',stage,'model',model,'completed',completed,
          'total',total,'rejected',rejected,'source_digest',source_digest,
          'started_at',started_at,'updated_at',updated_at,'completed_at',completed_at)), '[]')
        FROM (SELECT id,status,stage,model,completed,total,rejected,source_digest,
          started_at,updated_at,completed_at FROM redaction_jobs
          ORDER BY started_at DESC,id DESC))=?
    THEN 1 ELSE json_extract('coverage privacy authority changed','$') END AS authority_guard`)
    .bind(
      authority.mutationVersion,
      authority.workflowRunId,
      authority.storySourceRevision,
      authority.storySourceRevision,
      authority.semanticManifestRevision,
      authority.semanticManifestDigest,
      authority.corpusRevision,
      authority.corpusDigest,
      authority.redactionWitnessJson,
      authority.workflowRunId,
      authority.membershipWitnessJson,
      authority.sourcePrivacyJobWitnessJson,
    );
}
