import type { getLocalDatabase } from "../db";
import {
  deriveStoryReleaseTargetCatalog,
  storyPreparationDigest,
  type StoryPreparationPrivacyCandidate,
} from "./story-preparation.ts";
import {
  validateCurrentStorySourcePackage,
  type StoryEvidenceRow,
} from "./story-readiness.ts";
import {
  compareStorySourceIdentity,
  parseStorySource,
  type StoryReleaseTarget,
  type StorySource,
} from "./timeline.ts";
import {
  reconstructReviewedStoryPrivacyRevision,
  type ReviewedStoryPrivacyRevision,
} from "./story-privacy-revision.ts";

type StoryPrivacyDatabase = Awaited<ReturnType<typeof getLocalDatabase>>;
type Row = Record<string, unknown>;
type BatchResult = { results?: Row[] };

export type StoryPrivacyCandidateResponse = StoryPreparationPrivacyCandidate & {
  decision: "keep" | "redact" | null;
  decisionVersion: 0 | 1;
  decidedAt: string | null;
};

export type StoryPrivacyAuthorityResponse = {
  workflowRunId: string;
  sourceRevision: number;
  activeStoryDigest: string;
  candidateDigest: string;
  status: "preparation_required" | "completed_empty" | "completed_with_candidates";
  candidates: StoryPrivacyCandidateResponse[];
};

export const STORY_PRIVACY_ERROR = {
  invalidAuthority: "STORY_PRIVACY_AUTHORITY_INVALID",
  foreignWorkflow: "STORY_PRIVACY_WORKFLOW_NOT_FOUND",
  candidateNotFound: "STORY_PRIVACY_CANDIDATE_NOT_FOUND",
  staleAuthority: "STORY_PRIVACY_AUTHORITY_STALE",
  notActionable: "STORY_PRIVACY_CANDIDATE_NOT_ACTIONABLE",
  lostCas: "STORY_PRIVACY_DECISION_CONFLICT",
  importInvalid: "STORY_PRIVACY_IMPORT_INVALID",
  importStale: "STORY_PRIVACY_IMPORT_STALE",
  reviewIncomplete: "STORY_PRIVACY_REVIEW_INCOMPLETE",
} as const;

type StoryPrivacyErrorCode = typeof STORY_PRIVACY_ERROR[keyof typeof STORY_PRIVACY_ERROR];
type AuthorityFailure = { ok: false; code: StoryPrivacyErrorCode };
type CandidateRow = {
  workflow_run_id: string;
  candidate_id: string;
  candidate_json: string;
  decision: string | null;
  decision_version: number;
  decided_at: string | null;
};
type StoryRow = {
  id: string;
  documentId: string;
  sequence: number;
  timestamp: string | null;
  summary: string;
};
type CurrentAuthority = {
  response: StoryPrivacyAuthorityResponse;
  candidateRows: CandidateRow[];
  allCandidateRows: CandidateRow[];
  storyRows: StoryRow[];
  receiptInputDigest: string;
  candidateOutputDigest: string;
  receiptDigest: string;
  revision?: ReviewedStoryPrivacyRevision;
  actionable?: boolean;
};

const digestPattern = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const exactCandidateKeys = [
  "id", "reviewState", "title", "whyFlagged", "uncertaintyReason", "releaseTargets",
];

function rows(results: unknown[], index: number) {
  return ((results[index] as BatchResult | undefined)?.results || []) as Row[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function safeText(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim())
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function stableId(value: unknown): value is string {
  return safeText(value) && !/[\u0009\u000a\u000d]/u.test(value);
}

function compareUtf8(left: string, right: string) {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function exactTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function parseCandidate(
  candidateJson: unknown,
  validTargets: Set<string>,
  targetOrder: Map<string, number>,
): StoryPreparationPrivacyCandidate | null {
  if (typeof candidateJson !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(candidateJson);
  } catch {
    return null;
  }
  if (!isRecord(value) || !onlyKeys(value, exactCandidateKeys)
    || !stableId(value.id) || value.id.length > 1_000
    || (value.reviewState !== "deterministic" && value.reviewState !== "needs_confirmation")
    || !safeText(value.title) || value.title.length > 500
    || !safeText(value.whyFlagged) || value.whyFlagged.length > 4_000
    || (value.reviewState === "deterministic" && value.uncertaintyReason !== null)
    || (value.reviewState === "needs_confirmation" && (!safeText(value.uncertaintyReason)
      || value.uncertaintyReason.length > 4_000))
    || !Array.isArray(value.releaseTargets) || value.releaseTargets.length === 0
    || value.releaseTargets.length > 2_000
    || !value.releaseTargets.every((target) => typeof target === "string" && validTargets.has(target))
    || new Set(value.releaseTargets).size !== value.releaseTargets.length) return null;
  const orders = value.releaseTargets.map((target) => targetOrder.get(String(target)) ?? -1);
  if (orders.some((order, index) => index > 0 && orders[index - 1] >= order)) return null;
  return {
    id: value.id,
    reviewState: value.reviewState,
    title: value.title,
    whyFlagged: value.whyFlagged,
    uncertaintyReason: value.uncertaintyReason as string | null,
    releaseTargets: [...value.releaseTargets] as StoryReleaseTarget[],
  };
}

function validDecisionState(candidate: StoryPreparationPrivacyCandidate, row: CandidateRow) {
  if (candidate.reviewState === "deterministic") {
    return row.decision === null && row.decision_version === 0 && row.decided_at === null;
  }
  if (row.decision === null) {
    return row.decision_version === 0 && row.decided_at === null;
  }
  return (row.decision === "keep" || row.decision === "redact")
    && row.decision_version === 1 && exactTimestamp(row.decided_at);
}

async function captureInitialAuthority(
  db: StoryPrivacyDatabase,
  workflowRunId: string,
): Promise<CurrentAuthority | AuthorityFailure> {
  const results = await db.batch([
    db.prepare("SELECT id FROM workflow_runs ORDER BY id LIMIT 2"),
    db.prepare(`SELECT id,story_generation_status,story_source_revision,active_story_digest
      FROM workflow_runs WHERE id=?`).bind(workflowRunId),
    db.prepare(`SELECT workflow_run_id,lane,source_revision,input_digest,output_digest,output_count,completed_at
      FROM story_preparation_receipts WHERE workflow_run_id=? AND lane='story_privacy'`)
      .bind(workflowRunId),
    db.prepare(`SELECT workflow_run_id,candidate_id,candidate_json,decision,decision_version,decided_at
      FROM story_privacy_candidates WHERE workflow_run_id=?`).bind(workflowRunId),
    db.prepare(`SELECT id,document_id AS documentId,sequence,timestamp,
        organization_reason AS summary FROM items WHERE organization_reason LIKE ?`)
      .bind("oxygen.story%"),
    db.prepare(`SELECT id,document_id AS documentId,event_type AS eventType,
        actor_id AS actorId,actor_type AS actorType FROM items ORDER BY document_id,sequence`),
  ]);
  const runAuthorities = rows(results, 0);
  if (runAuthorities.length !== 1) return { ok: false, code: STORY_PRIVACY_ERROR.invalidAuthority };
  if (runAuthorities[0].id !== workflowRunId) {
    return { ok: false, code: STORY_PRIVACY_ERROR.foreignWorkflow };
  }
  const runRows = rows(results, 1);
  const receiptRows = rows(results, 2);
  const rawCandidateRows = rows(results, 3);
  const rawStoryRows = rows(results, 4);
  const rawEvidenceRows = rows(results, 5);
  if (runRows.length !== 1 || receiptRows.length !== 1) {
    return { ok: false, code: STORY_PRIVACY_ERROR.invalidAuthority };
  }
  const run = runRows[0];
  const receipt = receiptRows[0];
  const sourceRevision = Number(run.story_source_revision);
  const activeStoryDigest = run.active_story_digest;
  if (run.id !== workflowRunId || run.story_generation_status !== "ready_for_human_review"
    || !Number.isSafeInteger(sourceRevision) || sourceRevision <= 0
    || typeof activeStoryDigest !== "string" || !digestPattern.test(activeStoryDigest)
    || receipt.workflow_run_id !== workflowRunId || receipt.lane !== "story_privacy"
    || Number(receipt.source_revision) !== sourceRevision
    || typeof receipt.input_digest !== "string" || !digestPattern.test(receipt.input_digest)
    || typeof receipt.output_digest !== "string" || !digestPattern.test(receipt.output_digest)
    || !Number.isSafeInteger(Number(receipt.output_count)) || Number(receipt.output_count) < 0
    || !exactTimestamp(receipt.completed_at)) {
    return { ok: false, code: STORY_PRIVACY_ERROR.invalidAuthority };
  }

  const storyRows: StoryRow[] = [];
  for (const row of rawStoryRows) {
    const sequence = Number(row.sequence);
    if (!stableId(row.id) || !stableId(row.documentId) || !Number.isSafeInteger(sequence)
      || sequence < 0 || (row.timestamp !== null && typeof row.timestamp !== "string")
      || typeof row.summary !== "string") {
      return { ok: false, code: STORY_PRIVACY_ERROR.invalidAuthority };
    }
    storyRows.push({
      id: row.id,
      documentId: row.documentId,
      sequence,
      timestamp: row.timestamp as string | null,
      summary: row.summary,
    });
  }
  storyRows.sort(compareStorySourceIdentity);
  const stories: StorySource[] = [];
  for (const row of storyRows) {
    const story = parseStorySource(row.summary);
    if (!story) return { ok: false, code: STORY_PRIVACY_ERROR.invalidAuthority };
    stories.push(story);
  }
  const evidenceRows: StoryEvidenceRow[] = [];
  for (const row of rawEvidenceRows) {
    if (!stableId(row.id) || !stableId(row.documentId)
      || ![row.eventType, row.actorId, row.actorType].every((value) => (
        value === null || typeof value === "string"
      ))) {
      return { ok: false, code: STORY_PRIVACY_ERROR.invalidAuthority };
    }
    evidenceRows.push({
      id: row.id,
      documentId: row.documentId,
      eventType: row.eventType as string | null,
      actorId: row.actorId as string | null,
      actorType: row.actorType as string | null,
    });
  }
  const storyValidation = await validateCurrentStorySourcePackage(
    db,
    workflowRunId,
    storyRows,
    evidenceRows,
  );
  if (!storyValidation.ok
    || await storyPreparationDigest(JSON.parse(storyValidation.canonicalCandidate)) !== activeStoryDigest
    || await storyPreparationDigest(storyRows.map((row, index) => ({
      id: row.id,
      story: stories[index],
    }))) !== receipt.input_digest) {
    return { ok: false, code: STORY_PRIVACY_ERROR.invalidAuthority };
  }
  const targetCatalog = stories.length > 0 ? deriveStoryReleaseTargetCatalog(stories) : null;
  if (!targetCatalog) return { ok: false, code: STORY_PRIVACY_ERROR.invalidAuthority };
  const validTargets = new Set(targetCatalog.map((target) => target.id));
  const targetOrder = new Map(targetCatalog.map((target, index) => [target.id, index]));

  const candidateRows: CandidateRow[] = [];
  const parsedCandidates: StoryPrivacyCandidateResponse[] = [];
  for (const rawRow of rawCandidateRows) {
    const row: CandidateRow = {
      workflow_run_id: String(rawRow.workflow_run_id),
      candidate_id: String(rawRow.candidate_id),
      candidate_json: String(rawRow.candidate_json),
      decision: rawRow.decision === null ? null : String(rawRow.decision),
      decision_version: Number(rawRow.decision_version),
      decided_at: rawRow.decided_at === null ? null : String(rawRow.decided_at),
    };
    const candidate = parseCandidate(rawRow.candidate_json, validTargets, targetOrder);
    if (!candidate || row.workflow_run_id !== workflowRunId || row.candidate_id !== candidate.id
      || !validDecisionState(candidate, row)) {
      return { ok: false, code: STORY_PRIVACY_ERROR.invalidAuthority };
    }
    candidateRows.push(row);
    parsedCandidates.push({
      ...candidate,
      decision: row.decision as "keep" | "redact" | null,
      decisionVersion: row.decision_version as 0 | 1,
      decidedAt: row.decided_at,
    });
  }
  candidateRows.sort((left, right) => compareUtf8(left.candidate_id, right.candidate_id));
  parsedCandidates.sort((left, right) => compareUtf8(left.id, right.id));
  if (Number(receipt.output_count) !== parsedCandidates.length
    || await storyPreparationDigest(parsedCandidates.map((candidate) => ({
      id: candidate.id,
      reviewState: candidate.reviewState,
      title: candidate.title,
      whyFlagged: candidate.whyFlagged,
      uncertaintyReason: candidate.uncertaintyReason,
      releaseTargets: candidate.releaseTargets,
    }))) !== receipt.output_digest) {
    return { ok: false, code: STORY_PRIVACY_ERROR.invalidAuthority };
  }
  return {
    response: {
      workflowRunId,
      sourceRevision,
      activeStoryDigest,
      candidateDigest: receipt.output_digest,
      status: parsedCandidates.length === 0 ? "completed_empty" : "completed_with_candidates",
      candidates: parsedCandidates,
    },
    candidateRows,
    allCandidateRows: candidateRows,
    storyRows,
    receiptInputDigest: receipt.input_digest,
    candidateOutputDigest: receipt.output_digest,
    receiptDigest: await storyPreparationDigest(receipt),
  };
}

type StoredAuthorityRow = {
  workflow_run_id: string;
  source_revision: number;
  active_story_digest: string;
  server_version: number;
  reviewed_story_digest: string;
  target_catalog_json: string;
  target_catalog_digest: string;
  changed_target_digest: string;
  changed_target_count: number;
  receipt_digest: string;
  batch_digest: string;
  candidate_digest: string;
  candidate_count: number;
  imported_at: string;
};

function revisionFields(revision: ReviewedStoryPrivacyRevision) {
  return {
    serverVersion: revision.serverVersion,
    reviewedStoryDigest: revision.reviewedStoryDigest,
    targetCatalogDigest: revision.targetCatalogDigest,
    changedTargetDigest: revision.changedTargetDigest,
    changedTargetCount: revision.targetTransitions.length,
  };
}

async function authorityDigest(
  revision: ReviewedStoryPrivacyRevision,
  receiptDigest: string,
  candidateDigest: string,
) {
  return storyPreparationDigest({
    workflowRunId: revision.workflowRunId,
    sourceRevision: revision.sourceRevision,
    activeStoryDigest: revision.activeStoryDigest,
    ...revisionFields(revision),
    receiptDigest,
    candidateDigest,
  });
}

function retainedCurrentCandidates(
  current: CurrentAuthority,
  revision: ReviewedStoryPrivacyRevision,
) {
  const changed = new Set(revision.targetTransitions.map((target) => target.id));
  const valid = new Set(revision.targetCatalog.map((target) => target.id));
  const candidates = current.response.candidates.filter((candidate) => (
    candidate.releaseTargets.every((target) => valid.has(target) && !changed.has(target))
  ));
  const ids = new Set(candidates.map((candidate) => candidate.id));
  return {
    candidates,
    rows: current.candidateRows.filter((row) => ids.has(row.candidate_id)),
  };
}

async function captureStoredAuthority(
  db: StoryPrivacyDatabase,
  workflowRunId: string,
  revision: ReviewedStoryPrivacyRevision,
  row: StoredAuthorityRow,
): Promise<CurrentAuthority | AuthorityFailure> {
  if (row.workflow_run_id !== workflowRunId
    || Number(row.source_revision) !== revision.sourceRevision
    || row.active_story_digest !== revision.activeStoryDigest
    || Number(row.server_version) !== revision.serverVersion
    || row.reviewed_story_digest !== revision.reviewedStoryDigest
    || row.target_catalog_digest !== revision.targetCatalogDigest
    || !Number.isSafeInteger(Number(row.changed_target_count)) || Number(row.changed_target_count) <= 0
    || ![row.receipt_digest, row.batch_digest, row.candidate_digest]
      .every((value) => digestPattern.test(value))
    || !exactTimestamp(row.imported_at)) {
    return { ok: false, code: STORY_PRIVACY_ERROR.staleAuthority };
  }
  let storedCatalog: unknown;
  try { storedCatalog = JSON.parse(row.target_catalog_json); } catch { return { ok: false, code: STORY_PRIVACY_ERROR.invalidAuthority }; }
  if (await storyPreparationDigest(storedCatalog) !== row.target_catalog_digest
    || JSON.stringify(storedCatalog) !== JSON.stringify(revision.targetCatalog)) {
    return { ok: false, code: STORY_PRIVACY_ERROR.invalidAuthority };
  }
  const rawRows = (await db.prepare(`SELECT workflow_run_id,candidate_id,candidate_json,
      decision,decision_version,decided_at FROM story_privacy_candidates
      WHERE workflow_run_id=?`).bind(workflowRunId).all<CandidateRow>()).results || [];
  const validTargets = new Set(revision.targetCatalog.map((target) => target.id));
  const targetOrder = new Map(revision.targetCatalog.map((target, index) => [target.id, index]));
  const parsed: StoryPrivacyCandidateResponse[] = [];
  const candidateRows: CandidateRow[] = [];
  for (const raw of rawRows) {
    const candidate = parseCandidate(raw.candidate_json, validTargets, targetOrder);
    const normalized: CandidateRow = {
      workflow_run_id: String(raw.workflow_run_id),
      candidate_id: String(raw.candidate_id),
      candidate_json: String(raw.candidate_json),
      decision: raw.decision === null ? null : String(raw.decision),
      decision_version: Number(raw.decision_version),
      decided_at: raw.decided_at === null ? null : String(raw.decided_at),
    };
    if (!candidate || normalized.workflow_run_id !== workflowRunId
      || normalized.candidate_id !== candidate.id || !validDecisionState(candidate, normalized)) {
      return { ok: false, code: STORY_PRIVACY_ERROR.invalidAuthority };
    }
    candidateRows.push(normalized);
    parsed.push({ ...candidate, decision: normalized.decision as "keep" | "redact" | null,
      decisionVersion: normalized.decision_version as 0 | 1, decidedAt: normalized.decided_at });
  }
  parsed.sort((left, right) => compareUtf8(left.id, right.id));
  candidateRows.sort((left, right) => compareUtf8(left.candidate_id, right.candidate_id));
  const products = parsed.map(candidateProduct);
  if (Number(row.candidate_count) !== parsed.length
    || await storyPreparationDigest(products) !== row.candidate_digest
    || await storyPreparationDigest({
      workflowRunId, sourceRevision: revision.sourceRevision,
      activeStoryDigest: revision.activeStoryDigest, serverVersion: revision.serverVersion,
      reviewedStoryDigest: revision.reviewedStoryDigest,
      targetCatalogDigest: revision.targetCatalogDigest,
      changedTargetDigest: row.changed_target_digest,
      changedTargetCount: Number(row.changed_target_count),
      receiptDigest: row.receipt_digest,
      candidateDigest: row.candidate_digest,
    }) !== row.batch_digest) {
    return { ok: false, code: STORY_PRIVACY_ERROR.invalidAuthority };
  }
  return {
    response: {
      workflowRunId,
      sourceRevision: revision.sourceRevision,
      activeStoryDigest: revision.activeStoryDigest,
      candidateDigest: row.batch_digest,
      status: parsed.length === 0 ? "completed_empty" : "completed_with_candidates",
      candidates: parsed,
    },
    candidateRows,
    allCandidateRows: candidateRows,
    storyRows: [],
    receiptInputDigest: "",
    candidateOutputDigest: row.candidate_digest,
    receiptDigest: row.receipt_digest,
    revision,
    actionable: true,
  };
}

async function captureStoredSnapshot(
  db: StoryPrivacyDatabase,
  workflowRunId: string,
  row: StoredAuthorityRow,
): Promise<CurrentAuthority | AuthorityFailure> {
  if (row.workflow_run_id !== workflowRunId || !Number.isSafeInteger(Number(row.source_revision))
    || Number(row.source_revision) <= 0 || !Number.isSafeInteger(Number(row.server_version))
    || Number(row.server_version) < 0 || !Number.isSafeInteger(Number(row.changed_target_count))
    || Number(row.changed_target_count) <= 0 || !Number.isSafeInteger(Number(row.candidate_count))
    || Number(row.candidate_count) < 0 || !exactTimestamp(row.imported_at)
    || ![row.active_story_digest, row.reviewed_story_digest, row.target_catalog_digest,
      row.changed_target_digest, row.receipt_digest, row.batch_digest,
      row.candidate_digest].every((value) => digestPattern.test(value))) {
    return { ok: false, code: STORY_PRIVACY_ERROR.invalidAuthority };
  }
  let catalog: Array<{ id: StoryReleaseTarget; contentDigest: string }>;
  try { catalog = JSON.parse(row.target_catalog_json); } catch {
    return { ok: false, code: STORY_PRIVACY_ERROR.invalidAuthority };
  }
  if (!Array.isArray(catalog) || await storyPreparationDigest(catalog) !== row.target_catalog_digest
    || catalog.some((target) => !isRecord(target) || !onlyKeys(target, ["id", "contentDigest"])
      || !stableId(target.id) || !isStoryPrivacyDigest(target.contentDigest))) {
    return { ok: false, code: STORY_PRIVACY_ERROR.invalidAuthority };
  }
  const rawRows = (await db.prepare(`SELECT workflow_run_id,candidate_id,candidate_json,
      decision,decision_version,decided_at FROM story_privacy_candidates
      WHERE workflow_run_id=?`).bind(workflowRunId).all<CandidateRow>()).results || [];
  const validTargets = new Set(catalog.map((target) => target.id));
  const targetOrder = new Map(catalog.map((target, index) => [target.id, index]));
  const candidates: StoryPrivacyCandidateResponse[] = [];
  const candidateRows: CandidateRow[] = [];
  for (const raw of rawRows) {
    const parsed = parseCandidate(raw.candidate_json, validTargets, targetOrder);
    const normalized: CandidateRow = {
      workflow_run_id: String(raw.workflow_run_id), candidate_id: String(raw.candidate_id),
      candidate_json: String(raw.candidate_json),
      decision: raw.decision === null ? null : String(raw.decision),
      decision_version: Number(raw.decision_version),
      decided_at: raw.decided_at === null ? null : String(raw.decided_at),
    };
    if (!parsed || normalized.workflow_run_id !== workflowRunId
      || normalized.candidate_id !== parsed.id || !validDecisionState(parsed, normalized)) {
      return { ok: false, code: STORY_PRIVACY_ERROR.invalidAuthority };
    }
    candidateRows.push(normalized);
    candidates.push({ ...parsed, decision: normalized.decision as "keep" | "redact" | null,
      decisionVersion: normalized.decision_version as 0 | 1, decidedAt: normalized.decided_at });
  }
  candidates.sort((left, right) => compareUtf8(left.id, right.id));
  candidateRows.sort((left, right) => compareUtf8(left.candidate_id, right.candidate_id));
  if (candidates.length !== Number(row.candidate_count)
    || await storyPreparationDigest(candidates.map(candidateProduct)) !== row.candidate_digest
    || await storyPreparationDigest({
      workflowRunId, sourceRevision: Number(row.source_revision),
      activeStoryDigest: row.active_story_digest, serverVersion: Number(row.server_version),
      reviewedStoryDigest: row.reviewed_story_digest,
      targetCatalogDigest: row.target_catalog_digest,
      changedTargetDigest: row.changed_target_digest,
      changedTargetCount: Number(row.changed_target_count),
      receiptDigest: row.receipt_digest,
      candidateDigest: row.candidate_digest,
    }) !== row.batch_digest) {
    return { ok: false, code: STORY_PRIVACY_ERROR.invalidAuthority };
  }
  return {
    response: {
      workflowRunId, sourceRevision: Number(row.source_revision),
      activeStoryDigest: row.active_story_digest, candidateDigest: row.batch_digest,
      status: candidates.length === 0 ? "completed_empty" : "completed_with_candidates",
      candidates,
    },
    candidateRows, allCandidateRows: candidateRows, storyRows: [], receiptInputDigest: "",
    candidateOutputDigest: row.candidate_digest, receiptDigest: row.receipt_digest,
    actionable: false,
  };
}

async function captureCurrentAuthority(
  db: StoryPrivacyDatabase,
  workflowRunId: string,
): Promise<CurrentAuthority | AuthorityFailure> {
  const revisionResult = await reconstructReviewedStoryPrivacyRevision(db, workflowRunId);
  if (!revisionResult.ok) return { ok: false, code: revisionResult.code };
  const revision = revisionResult.revision;
  const stored = await db.prepare(`SELECT * FROM story_privacy_authorities
    WHERE workflow_run_id=?`).bind(workflowRunId).first<StoredAuthorityRow>();
  let prior: CurrentAuthority | AuthorityFailure;
  if (stored) {
    const exact = await captureStoredAuthority(db, workflowRunId, revision, stored);
    if ("response" in exact) return exact;
    if (exact.code !== STORY_PRIVACY_ERROR.staleAuthority) return exact;
    prior = await captureStoredSnapshot(db, workflowRunId, stored);
  } else {
    prior = await captureInitialAuthority(db, workflowRunId);
  }
  if (!("response" in prior)) return prior;
  const retained = retainedCurrentCandidates(prior, revision);
  const receipt = await db.prepare(`SELECT source_revision,input_digest,scope_digest,scope_count,
      output_digest,output_count,completed_at FROM story_preparation_receipts
      WHERE workflow_run_id=? AND lane='story_privacy'`).bind(workflowRunId).first<Row>();
  if (!receipt) return { ok: false, code: STORY_PRIVACY_ERROR.invalidAuthority };
  const receiptDigest = prior.receiptDigest || await storyPreparationDigest(receipt);
  const candidateOutputDigest = await storyPreparationDigest(retained.candidates.map((candidate) => ({
    id: candidate.id, reviewState: candidate.reviewState, title: candidate.title,
    whyFlagged: candidate.whyFlagged, uncertaintyReason: candidate.uncertaintyReason,
    releaseTargets: candidate.releaseTargets,
  })));
  const candidateDigest = await authorityDigest(revision, receiptDigest, candidateOutputDigest);
  return {
    response: {
      workflowRunId,
      sourceRevision: revision.sourceRevision,
      activeStoryDigest: revision.activeStoryDigest,
      candidateDigest,
      status: revision.targetTransitions.length === 0
        ? (retained.candidates.length === 0 ? "completed_empty" : "completed_with_candidates")
        : "preparation_required",
      candidates: retained.candidates,
    },
    candidateRows: retained.rows,
    allCandidateRows: prior.allCandidateRows,
    storyRows: prior.storyRows,
    receiptInputDigest: prior.receiptInputDigest,
    candidateOutputDigest,
    receiptDigest,
    revision,
    actionable: revision.targetTransitions.length === 0,
  };
}

export async function readStoryPrivacyAuthority(
  db: StoryPrivacyDatabase,
  workflowRunId: string,
): Promise<{ ok: true; authority: StoryPrivacyAuthorityResponse } | AuthorityFailure> {
  const current = await captureCurrentAuthority(db, workflowRunId);
  return "response" in current
    ? { ok: true, authority: current.response }
    : current;
}

export async function buildReviewedStoryPrivacyPreparationSnapshot(
  db: StoryPrivacyDatabase,
  workflowRunId: string,
) {
  const [revisionResult, current] = await Promise.all([
    reconstructReviewedStoryPrivacyRevision(db, workflowRunId),
    captureCurrentAuthority(db, workflowRunId),
  ]);
  if (!revisionResult.ok) return revisionResult;
  if (!("response" in current)) return current;
  const revision = revisionResult.revision;
  if (revision.targetTransitions.length === 0) {
    return { ok: false as const, code: STORY_PRIVACY_ERROR.notActionable };
  }
  return {
    ok: true as const,
    snapshot: {
      schema: "oxygen.reviewed-story-privacy-snapshot" as const,
      binding: {
        workflowRunId,
        sourceRevision: revision.sourceRevision,
        activeStoryDigest: revision.activeStoryDigest,
        serverVersion: revision.serverVersion,
        reviewedStoryDigest: revision.reviewedStoryDigest,
        targetCatalogDigest: revision.targetCatalogDigest,
        changedTargetDigest: revision.changedTargetDigest,
        changedTargetCount: revision.targetTransitions.length,
        previousCandidateDigest: current.response.candidateDigest,
      },
      targetTransitions: revision.targetTransitions,
      changedTargets: revision.changedTargets,
    },
  };
}

const importBindingKeys = [
  "workflowRunId", "sourceRevision", "activeStoryDigest", "serverVersion",
  "reviewedStoryDigest", "targetCatalogDigest", "changedTargetDigest",
  "changedTargetCount", "previousCandidateDigest",
];
const terminalReceiptKeys = [
  "schema", "status", "workflowRunId", "sourceRevision", "activeStoryDigest",
  "serverVersion", "reviewedStoryDigest", "targetCatalogDigest", "changedTargetDigest",
  "changedTargetCount", "outputDigest", "outputCount", "completedAt",
];

type ReviewedStoryPrivacyImport = {
  schema: "oxygen.reviewed-story-privacy-import";
  binding: {
    workflowRunId: string;
    sourceRevision: number;
    activeStoryDigest: string;
    serverVersion: number;
    reviewedStoryDigest: string;
    targetCatalogDigest: string;
    changedTargetDigest: string;
    changedTargetCount: number;
    previousCandidateDigest: string;
  };
  terminalReceipt: Record<string, unknown>;
  receiptDigest: string;
  candidates: StoryPreparationPrivacyCandidate[];
  importDigest: string;
};

export function parseImportBundle(value: unknown): ReviewedStoryPrivacyImport | null {
  if (!isRecord(value) || !onlyKeys(value, [
    "schema", "binding", "terminalReceipt", "receiptDigest", "candidates", "importDigest",
  ]) || value.schema !== "oxygen.reviewed-story-privacy-import"
    || !isRecord(value.binding) || !onlyKeys(value.binding, importBindingKeys)
    || !isRecord(value.terminalReceipt) || !onlyKeys(value.terminalReceipt, terminalReceiptKeys)
    || !Array.isArray(value.candidates)
    || ![value.receiptDigest, value.importDigest].every((digest) => isStoryPrivacyDigest(digest))) {
    return null;
  }
  const binding = value.binding;
  if (!stableId(binding.workflowRunId)
    || !Number.isSafeInteger(binding.sourceRevision) || Number(binding.sourceRevision) <= 0
    || !Number.isSafeInteger(binding.serverVersion) || Number(binding.serverVersion) < 0
    || !Number.isSafeInteger(binding.changedTargetCount) || Number(binding.changedTargetCount) < 0
    || ![binding.activeStoryDigest, binding.reviewedStoryDigest, binding.targetCatalogDigest,
      binding.changedTargetDigest, binding.previousCandidateDigest].every(isStoryPrivacyDigest)) return null;
  return value as unknown as ReviewedStoryPrivacyImport;
}

function exactImportBinding(
  binding: ReviewedStoryPrivacyImport["binding"],
  revision: ReviewedStoryPrivacyRevision,
  previousCandidateDigest: string,
) {
  return binding.workflowRunId === revision.workflowRunId
    && binding.sourceRevision === revision.sourceRevision
    && binding.activeStoryDigest === revision.activeStoryDigest
    && binding.serverVersion === revision.serverVersion
    && binding.reviewedStoryDigest === revision.reviewedStoryDigest
    && binding.targetCatalogDigest === revision.targetCatalogDigest
    && binding.changedTargetDigest === revision.changedTargetDigest
    && binding.changedTargetCount === revision.targetTransitions.length
    && binding.previousCandidateDigest === previousCandidateDigest;
}

function candidateProduct(candidate: StoryPrivacyCandidateResponse | StoryPreparationPrivacyCandidate) {
  return {
    id: candidate.id,
    reviewState: candidate.reviewState,
    title: candidate.title,
    whyFlagged: candidate.whyFlagged,
    uncertaintyReason: candidate.uncertaintyReason,
    releaseTargets: candidate.releaseTargets,
  };
}

function candidateRowSnapshot(candidateRows: CandidateRow[]) {
  return candidateRows.map((row) => ({
    workflowRunId: row.workflow_run_id,
    candidateId: row.candidate_id,
    candidateJson: row.candidate_json,
    decision: row.decision,
    decisionVersion: row.decision_version,
    decidedAt: row.decided_at,
  }));
}

async function importGuardSnapshot(db: StoryPrivacyDatabase, workflowRunId: string) {
  const results = await db.batch([
    db.prepare("SELECT * FROM workflow_runs WHERE id=?").bind(workflowRunId),
    db.prepare("SELECT * FROM story_review_sessions WHERE workflow_run_id=?").bind(workflowRunId),
    db.prepare("SELECT * FROM story_privacy_authorities WHERE workflow_run_id=?").bind(workflowRunId),
    db.prepare(`SELECT * FROM story_preparation_receipts
      WHERE workflow_run_id=? AND lane='story_privacy'`).bind(workflowRunId),
    db.prepare(`SELECT workflow_run_id,candidate_id,candidate_json,decision,decision_version,decided_at
      FROM story_privacy_candidates WHERE workflow_run_id=? ORDER BY candidate_id`).bind(workflowRunId),
    db.prepare(`SELECT id,document_id,sequence,timestamp,organization_reason
      FROM items WHERE organization_reason LIKE 'oxygen.story%' ORDER BY document_id,sequence,id`),
  ]);
  const candidateRows = rows(results, 4).map((raw): CandidateRow => ({
    workflow_run_id: String(raw.workflow_run_id),
    candidate_id: String(raw.candidate_id),
    candidate_json: String(raw.candidate_json),
    decision: raw.decision === null ? null : String(raw.decision),
    decision_version: Number(raw.decision_version),
    decided_at: raw.decided_at === null ? null : String(raw.decided_at),
  }));
  return {
    candidateRows,
    digest: await storyPreparationDigest({
      workflow: rows(results, 0),
      session: rows(results, 1),
      authority: rows(results, 2),
      receipt: rows(results, 3),
      candidates: candidateRowSnapshot(candidateRows),
      stories: rows(results, 5),
    }),
  };
}

/** Atomically replace only invalidated findings. The complete current reviewed
 * snapshot and previous batch are rechecked inside one BEGIN IMMEDIATE; any
 * exception or lost CAS rolls every candidate/authority mutation back. */
export async function importReviewedStoryPrivacyAuthority(
  db: StoryPrivacyDatabase,
  input: unknown,
  importedAt: string,
): Promise<{ ok: true; authority: StoryPrivacyAuthorityResponse } | AuthorityFailure> {
  const bundle = parseImportBundle(input);
  if (!bundle || !exactTimestamp(importedAt)) {
    return { ok: false, code: STORY_PRIVACY_ERROR.importInvalid };
  }
  const revisionResult = await reconstructReviewedStoryPrivacyRevision(db, bundle.binding.workflowRunId);
  if (!revisionResult.ok) return { ok: false, code: revisionResult.code };
  const revision = revisionResult.revision;
  const before = await captureCurrentAuthority(db, revision.workflowRunId);
  if (!("response" in before)) return before;
  const previousCandidateDigest = before.response.candidateDigest;
  if (!exactImportBinding(bundle.binding, revision, previousCandidateDigest)
    || bundle.binding.changedTargetCount === 0) {
    return { ok: false, code: STORY_PRIVACY_ERROR.importStale };
  }
  const changedTargets = new Set(revision.changedTargets.map((target) => target.id));
  const changedOrder = new Map(revision.changedTargets.map((target, index) => [target.id, index]));
  const candidates: StoryPreparationPrivacyCandidate[] = [];
  for (const raw of bundle.candidates) {
    const parsed = parseCandidate(JSON.stringify(raw), changedTargets, changedOrder);
    if (!parsed) return { ok: false, code: STORY_PRIVACY_ERROR.importInvalid };
    candidates.push(parsed);
  }
  candidates.sort((left, right) => compareUtf8(left.id, right.id));
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) {
    return { ok: false, code: STORY_PRIVACY_ERROR.importInvalid };
  }
  const outputDigest = await storyPreparationDigest(candidates);
  const receipt = bundle.terminalReceipt;
  const expectedReceipt = {
    schema: "oxygen.reviewed-story-privacy-terminal-receipt",
    status: "complete",
    workflowRunId: revision.workflowRunId,
    sourceRevision: revision.sourceRevision,
    activeStoryDigest: revision.activeStoryDigest,
    serverVersion: revision.serverVersion,
    reviewedStoryDigest: revision.reviewedStoryDigest,
    targetCatalogDigest: revision.targetCatalogDigest,
    changedTargetDigest: revision.changedTargetDigest,
    changedTargetCount: revision.targetTransitions.length,
    outputDigest,
    outputCount: candidates.length,
    completedAt: receipt.completedAt,
  };
  if (!exactTimestamp(receipt.completedAt)
    || JSON.stringify(receipt) !== JSON.stringify(expectedReceipt)
    || await storyPreparationDigest(receipt) !== bundle.receiptDigest
    || await storyPreparationDigest({
      schema: bundle.schema,
      binding: bundle.binding,
      receiptDigest: bundle.receiptDigest,
      candidates,
    }) !== bundle.importDigest) {
    return { ok: false, code: STORY_PRIVACY_ERROR.importInvalid };
  }
  const retained = before.response.candidates;
  const retainedIds = new Set(retained.map((candidate) => candidate.id));
  if (candidates.some((candidate) => retainedIds.has(candidate.id))) {
    return { ok: false, code: STORY_PRIVACY_ERROR.importInvalid };
  }
  const merged = [
    ...retained,
    ...candidates.map((candidate) => ({
      ...candidate, decision: null, decisionVersion: 0 as const, decidedAt: null,
    })),
  ].sort((left, right) => compareUtf8(left.id, right.id));
  const candidateDigest = await storyPreparationDigest(merged.map(candidateProduct));
  const storedAuthorityDigest = await authorityDigest(revision, bundle.receiptDigest, candidateDigest);

  const beforeGuard = await importGuardSnapshot(db, revision.workflowRunId);
  if (await storyPreparationDigest(candidateRowSnapshot(before.allCandidateRows))
    !== await storyPreparationDigest(candidateRowSnapshot(beforeGuard.candidateRows))) {
    return { ok: false, code: STORY_PRIVACY_ERROR.importStale };
  }
  try {
    await db.transaction(async () => {
      const currentRevision = await reconstructReviewedStoryPrivacyRevision(db, revision.workflowRunId);
      const current = await captureCurrentAuthority(db, revision.workflowRunId);
      const currentGuard = await importGuardSnapshot(db, revision.workflowRunId);
      if (currentGuard.digest !== beforeGuard.digest) {
        throw new Error(STORY_PRIVACY_ERROR.importStale);
      }
      if (!currentRevision.ok || !("response" in current)
        || !exactImportBinding(bundle.binding, currentRevision.revision,
          current.response.candidateDigest)) {
        throw new Error(STORY_PRIVACY_ERROR.importStale);
      }
      await db.prepare("DELETE FROM story_privacy_candidates WHERE workflow_run_id=?")
        .bind(revision.workflowRunId).run();
      for (const candidate of merged) {
        await db.prepare(`INSERT INTO story_privacy_candidates
          (workflow_run_id,candidate_id,candidate_json,decision,decision_version,decided_at)
          VALUES (?,?,?,?,?,?)`).bind(
          revision.workflowRunId, candidate.id, JSON.stringify(candidateProduct(candidate)),
          candidate.decision, candidate.decisionVersion, candidate.decidedAt,
        ).run();
      }
      await db.prepare(`INSERT INTO story_privacy_authorities
        (workflow_run_id,source_revision,active_story_digest,server_version,
         reviewed_story_digest,target_catalog_json,target_catalog_digest,
          changed_target_digest,changed_target_count,receipt_digest,batch_digest,
          candidate_digest,candidate_count,imported_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(workflow_run_id) DO UPDATE SET
          source_revision=excluded.source_revision,
          active_story_digest=excluded.active_story_digest,
          server_version=excluded.server_version,
          reviewed_story_digest=excluded.reviewed_story_digest,
          target_catalog_json=excluded.target_catalog_json,
          target_catalog_digest=excluded.target_catalog_digest,
          changed_target_digest=excluded.changed_target_digest,
          changed_target_count=excluded.changed_target_count,
          receipt_digest=excluded.receipt_digest,
          batch_digest=excluded.batch_digest,
          candidate_digest=excluded.candidate_digest,
          candidate_count=excluded.candidate_count,
          imported_at=excluded.imported_at`).bind(
          revision.workflowRunId, revision.sourceRevision, revision.activeStoryDigest,
          revision.serverVersion, revision.reviewedStoryDigest,
          JSON.stringify(revision.targetCatalog), revision.targetCatalogDigest,
          revision.changedTargetDigest, revision.targetTransitions.length,
          bundle.receiptDigest, storedAuthorityDigest, candidateDigest, merged.length, importedAt,
        ).run();
    });
  } catch (error) {
    return { ok: false, code: error instanceof Error && error.message === STORY_PRIVACY_ERROR.importStale
      ? STORY_PRIVACY_ERROR.importStale : STORY_PRIVACY_ERROR.lostCas };
  }
  return readStoryPrivacyAuthority(db, revision.workflowRunId);
}

export async function decideStoryPrivacyCandidate(
  db: StoryPrivacyDatabase,
  input: {
    workflowRunId: string;
    sourceRevision: number;
    activeStoryDigest: string;
    candidateDigest: string;
    expectedVersion: 0;
    decision: "keep" | "redact";
  },
  candidateId: string,
  decidedAt: string,
): Promise<{ ok: true; candidate: StoryPrivacyCandidateResponse } | AuthorityFailure> {
  const current = await captureCurrentAuthority(db, input.workflowRunId);
  if (!("response" in current)) return current;
  if (current.actionable === false) return { ok: false, code: STORY_PRIVACY_ERROR.staleAuthority };
  const authority = current.response;
  if (authority.sourceRevision !== input.sourceRevision
    || authority.activeStoryDigest !== input.activeStoryDigest
    || authority.candidateDigest !== input.candidateDigest) {
    return { ok: false, code: STORY_PRIVACY_ERROR.staleAuthority };
  }
  const candidateIndex = authority.candidates.findIndex((candidate) => candidate.id === candidateId);
  if (candidateIndex < 0) return { ok: false, code: STORY_PRIVACY_ERROR.candidateNotFound };
  const candidate = authority.candidates[candidateIndex];
  const candidateRow = current.candidateRows.find((row) => row.candidate_id === candidateId)!;
  if (candidate.reviewState !== "needs_confirmation" || candidate.decision !== null
    || candidate.decisionVersion !== 0 || candidate.decidedAt !== null) {
    return { ok: false, code: STORY_PRIVACY_ERROR.notActionable };
  }

  const candidateSnapshot = JSON.stringify(current.candidateRows.map((row) => ({
    candidateId: row.candidate_id,
    candidateJson: row.candidate_json,
    decision: row.decision,
    decisionVersion: row.decision_version,
    decidedAt: row.decided_at,
  })));
  const storySnapshot = JSON.stringify(current.storyRows);
  if (current.revision && current.revision.serverVersion > 0) {
    const revision = current.revision;
    const sessionRow = await db.prepare(`SELECT state_json,server_version FROM story_review_sessions
      WHERE workflow_run_id=?`).bind(input.workflowRunId)
      .first<{ state_json?: string; server_version?: number }>();
    const storedAuthority = await db.prepare(`SELECT batch_digest FROM story_privacy_authorities
      WHERE workflow_run_id=?`).bind(input.workflowRunId).first<{ batch_digest?: string }>();
    const storedGuard = storedAuthority?.batch_digest === input.candidateDigest;
    const virtualGuard = !storedAuthority && authority.candidateDigest === input.candidateDigest;
    if ((!storedGuard && !virtualGuard) || !sessionRow
      || Number(sessionRow.server_version) !== revision.serverVersion) {
      return { ok: false, code: STORY_PRIVACY_ERROR.lostCas };
    }
    const result = await db.prepare(`UPDATE story_privacy_candidates
      SET decision=?,decision_version=1,decided_at=?
      WHERE workflow_run_id=? AND candidate_id=? AND candidate_json=?
        AND json_extract(candidate_json,'$.id')=?
        AND json_extract(candidate_json,'$.reviewState')='needs_confirmation'
        AND decision IS NULL AND decision_version=0 AND decided_at IS NULL
        AND EXISTS (SELECT 1 FROM workflow_runs r WHERE r.id=?
          AND (SELECT COUNT(*) FROM workflow_runs)=1
          AND r.story_generation_status='ready_for_human_review'
          AND r.story_source_revision=? AND r.active_story_digest=?)
        AND EXISTS (SELECT 1 FROM story_review_sessions s WHERE s.workflow_run_id=?
          AND s.server_version=? AND s.state_json=?)
        AND (SELECT COUNT(*) FROM story_privacy_candidates c WHERE c.workflow_run_id=?)
          =json_array_length(?)
        AND NOT EXISTS (SELECT 1 FROM story_privacy_candidates c
          WHERE c.workflow_run_id=? AND NOT EXISTS (
            SELECT 1 FROM json_each(?) expected
            WHERE json_extract(expected.value,'$.candidateId')=c.candidate_id
              AND json_extract(expected.value,'$.candidateJson')=c.candidate_json
              AND json_extract(expected.value,'$.decision') IS c.decision
              AND json_extract(expected.value,'$.decisionVersion')=c.decision_version
              AND json_extract(expected.value,'$.decidedAt') IS c.decided_at))
        AND (?=0 OR EXISTS (SELECT 1 FROM story_privacy_authorities a
          WHERE a.workflow_run_id=? AND a.batch_digest=? AND a.server_version=?
            AND a.reviewed_story_digest=? AND a.target_catalog_digest=?))`)
      .bind(
        input.decision, decidedAt, input.workflowRunId, candidateId,
        candidateRow.candidate_json, candidateId,
        input.workflowRunId, input.sourceRevision, input.activeStoryDigest,
        input.workflowRunId, revision.serverVersion, String(sessionRow.state_json || ""),
        input.workflowRunId, candidateSnapshot, input.workflowRunId, candidateSnapshot,
        storedGuard ? 1 : 0, input.workflowRunId, input.candidateDigest,
        revision.serverVersion, revision.reviewedStoryDigest, revision.targetCatalogDigest,
      ).run();
    if (Number(result.meta.changes) !== 1) {
      return { ok: false, code: STORY_PRIVACY_ERROR.lostCas };
    }
    return { ok: true, candidate: { ...candidate, decision: input.decision,
      decisionVersion: 1, decidedAt } };
  }
  const result = await db.prepare(`UPDATE story_privacy_candidates
    SET decision=?,decision_version=1,decided_at=?
    WHERE workflow_run_id=? AND candidate_id=? AND candidate_json=?
      AND json_extract(candidate_json,'$.id')=?
      AND json_extract(candidate_json,'$.reviewState')='needs_confirmation'
      AND decision IS NULL AND decision_version=0 AND decided_at IS NULL
      AND EXISTS (SELECT 1 FROM workflow_runs r WHERE r.id=?
        AND (SELECT COUNT(*) FROM workflow_runs)=1
        AND r.story_generation_status='ready_for_human_review'
        AND r.story_source_revision=? AND r.active_story_digest=?)
      AND EXISTS (SELECT 1 FROM story_preparation_receipts p
        WHERE p.workflow_run_id=? AND p.lane='story_privacy'
          AND p.source_revision=? AND p.input_digest=? AND p.output_digest=?
          AND p.output_count=(SELECT COUNT(*) FROM story_privacy_candidates c
            WHERE c.workflow_run_id=?)
          AND typeof(p.completed_at)='text' AND length(trim(p.completed_at))>0)
      AND (SELECT COUNT(*) FROM story_privacy_candidates c
        WHERE c.workflow_run_id=?)=json_array_length(?)
      AND NOT EXISTS (SELECT 1 FROM story_privacy_candidates c
        WHERE c.workflow_run_id=? AND NOT EXISTS (
          SELECT 1 FROM json_each(?) expected
          WHERE json_extract(expected.value,'$.candidateId')=c.candidate_id
            AND json_extract(expected.value,'$.candidateJson')=c.candidate_json
            AND json_extract(expected.value,'$.decision') IS c.decision
            AND json_extract(expected.value,'$.decisionVersion')=c.decision_version
            AND json_extract(expected.value,'$.decidedAt') IS c.decided_at))
      AND (SELECT COUNT(*) FROM items WHERE organization_reason LIKE 'oxygen.story%')
        =json_array_length(?)
      AND NOT EXISTS (SELECT 1 FROM items current_story
        WHERE current_story.organization_reason LIKE 'oxygen.story%'
          AND NOT EXISTS (SELECT 1 FROM json_each(?) expected_story
            WHERE json_extract(expected_story.value,'$.id')=current_story.id
              AND json_extract(expected_story.value,'$.documentId')=current_story.document_id
              AND json_extract(expected_story.value,'$.sequence')=current_story.sequence
              AND json_extract(expected_story.value,'$.timestamp') IS current_story.timestamp
              AND json_extract(expected_story.value,'$.summary')=current_story.organization_reason))`)
    .bind(
      input.decision, decidedAt,
      input.workflowRunId, candidateId, candidateRow.candidate_json, candidateId,
      input.workflowRunId, input.sourceRevision, input.activeStoryDigest,
      input.workflowRunId, input.sourceRevision, current.receiptInputDigest,
      current.candidateOutputDigest, input.workflowRunId,
      input.workflowRunId, candidateSnapshot,
      input.workflowRunId, candidateSnapshot,
      storySnapshot, storySnapshot,
    ).run();
  if (Number(result.meta.changes) !== 1) {
    return { ok: false, code: STORY_PRIVACY_ERROR.lostCas };
  }
  return {
    ok: true,
    candidate: {
      ...candidate,
      decision: input.decision,
      decisionVersion: 1,
      decidedAt,
    },
  };
}

export function isStoryPrivacyDigest(value: unknown): value is string {
  return typeof value === "string" && digestPattern.test(value);
}

export function isStoryPrivacyCandidateId(value: unknown): value is string {
  return stableId(value);
}
