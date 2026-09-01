import type { getLocalDatabase } from "../db";
import {
  compareUtf8,
  deriveStoryReleaseTargetContents,
  normalizeStoryPrivacyOutput,
  storyPreparationDigest,
  type StoryPreparationPrivacyCandidate,
  type StoryPreparationPrivacyOutput,
  type StoryPreparationPrivacyTargetProposal,
} from "./story-preparation.ts";
import {
  compareStorySourceIdentity,
  parseStorySource,
  type StoryReleaseTarget,
} from "./timeline.ts";
import {
  reconstructReviewedStoryPrivacyRevision,
  type ReviewedStoryPrivacyRevision,
  type ReviewedStoryPrivacyTarget,
} from "./story-privacy-revision.ts";
import { activeRedactionFragments } from "./release.mjs";
import {
  applyStoryPrivacyPublicOverrides,
  storyPrivacyCredentialCategory,
  storyPrivacyCredentialText,
  storyPrivacyOccurrenceReviews,
  storyPrivacyOverrideKey,
  storyPrivacyTextAllowed,
  type StoryPrivacyOccurrence,
  type StoryPrivacyPublicOverride,
  type StoryPrivacyTargetReview,
} from "./story-privacy-projection.ts";

type StoryPrivacyDatabase = Awaited<ReturnType<typeof getLocalDatabase>>;
type Row = Record<string, unknown>;
type BatchResult = { results?: Row[] };

export type StoryPrivacyCandidateResponse = StoryPreparationPrivacyCandidate & {
  resolved: boolean;
};

export type StoryPrivacyAuthorityResponse = {
  workflowRunId: string;
  sourceRevision: number;
  activeStoryDigest: string;
  authorityDigest: string;
  status: "preparation_required" | "completed_empty" | "completed_with_candidates";
  candidates: StoryPrivacyCandidateResponse[];
  targets: StoryPrivacyTargetReview[];
};

export const STORY_PRIVACY_ERROR = {
  invalidAuthority: "STORY_PRIVACY_AUTHORITY_INVALID",
  foreignWorkflow: "STORY_PRIVACY_WORKFLOW_NOT_FOUND",
  targetNotFound: "STORY_PRIVACY_TARGET_NOT_FOUND",
  staleAuthority: "STORY_PRIVACY_AUTHORITY_STALE",
  notActionable: "STORY_PRIVACY_TARGET_NOT_ACTIONABLE",
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
};
type TargetRow = {
  workflow_run_id: string;
  target_id: string;
  target_content_digest: string;
  proposed_text: string;
  occurrences_json: string;
  selected_text: string | null;
  public_overrides_json: string;
  decided_at: string | null;
};
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
  proposal_digest: string;
  proposal_count: number;
  imported_at: string;
};
type KnownFragment = { text: string; category: string };
type CapturedAuthority = {
  response: StoryPrivacyAuthorityResponse;
  revision: ReviewedStoryPrivacyRevision;
  rawCandidates: StoryPreparationPrivacyCandidate[];
  rawCandidateRows: CandidateRow[];
  rawTargetRows: TargetRow[];
  retainedCandidates: StoryPreparationPrivacyCandidate[];
  retainedTargetRows: TargetRow[];
  knownFragments: KnownFragment[];
};

const digestPattern = /^[0-9a-f]{64}$/;
const candidateKeys = [
  "id", "reviewState", "title", "whyFlagged", "uncertaintyReason", "releaseTargets",
];
const occurrenceKeys = [
  "originalStartOffset", "originalEndOffset", "proposalStartOffset", "proposalEndOffset", "category",
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

function exactTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function parseCandidate(value: unknown): StoryPreparationPrivacyCandidate | null {
  if (!isRecord(value) || !onlyKeys(value, candidateKeys) || !stableId(value.id)
    || value.id.length > 1_000
    || (value.reviewState !== "deterministic" && value.reviewState !== "needs_confirmation")
    || !safeText(value.title) || value.title.length > 500
    || !safeText(value.whyFlagged) || value.whyFlagged.length > 4_000
    || (value.reviewState === "deterministic" && value.uncertaintyReason !== null)
    || (value.reviewState === "needs_confirmation" && (!safeText(value.uncertaintyReason)
      || value.uncertaintyReason.length > 4_000))
    || !Array.isArray(value.releaseTargets) || value.releaseTargets.length === 0
    || value.releaseTargets.length > 2_000
    || value.releaseTargets.some((target) => !stableId(target))
    || new Set(value.releaseTargets).size !== value.releaseTargets.length) return null;
  return {
    id: value.id,
    reviewState: value.reviewState,
    title: value.title,
    whyFlagged: value.whyFlagged,
    uncertaintyReason: value.uncertaintyReason as string | null,
    releaseTargets: value.releaseTargets as StoryReleaseTarget[],
  };
}

function parseOccurrence(value: unknown): StoryPrivacyOccurrence | null {
  if (!isRecord(value) || !onlyKeys(value, occurrenceKeys)
    || !Number.isSafeInteger(value.originalStartOffset) || Number(value.originalStartOffset) < 0
    || !Number.isSafeInteger(value.originalEndOffset)
    || Number(value.originalEndOffset) <= Number(value.originalStartOffset)
    || !Number.isSafeInteger(value.proposalStartOffset) || Number(value.proposalStartOffset) < 0
    || !Number.isSafeInteger(value.proposalEndOffset)
    || Number(value.proposalEndOffset) <= Number(value.proposalStartOffset)
    || typeof value.category !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value.category)) {
    return null;
  }
  return value as StoryPrivacyOccurrence;
}

function parseOverride(value: unknown): StoryPrivacyPublicOverride | null {
  if (!isRecord(value) || !onlyKeys(value, ["originalStartOffset", "originalEndOffset", "category"])) {
    return null;
  }
  const parsed = parseOccurrence({
    ...value,
    proposalStartOffset: 0,
    proposalEndOffset: 1,
  });
  return parsed ? {
    originalStartOffset: parsed.originalStartOffset,
    originalEndOffset: parsed.originalEndOffset,
    category: parsed.category,
  } : null;
}

function normalizeCandidateRows(raw: Row[], workflowRunId: string) {
  const candidateRows: CandidateRow[] = [];
  const candidates: StoryPreparationPrivacyCandidate[] = [];
  for (const value of raw) {
    const row = {
      workflow_run_id: String(value.workflow_run_id),
      candidate_id: String(value.candidate_id),
      candidate_json: String(value.candidate_json),
    };
    let parsed: unknown;
    try { parsed = JSON.parse(row.candidate_json); } catch { return null; }
    const candidate = parseCandidate(parsed);
    if (!candidate || row.workflow_run_id !== workflowRunId || row.candidate_id !== candidate.id) return null;
    candidateRows.push(row);
    candidates.push(candidate);
  }
  candidateRows.sort((left, right) => compareUtf8(left.candidate_id, right.candidate_id));
  candidates.sort((left, right) => compareUtf8(left.id, right.id));
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) return null;
  return { candidateRows, candidates };
}

function normalizeTargetRows(raw: Row[], workflowRunId: string) {
  const targetRows: TargetRow[] = [];
  for (const value of raw) {
    const row: TargetRow = {
      workflow_run_id: String(value.workflow_run_id),
      target_id: String(value.target_id),
      target_content_digest: String(value.target_content_digest),
      proposed_text: String(value.proposed_text),
      occurrences_json: String(value.occurrences_json),
      selected_text: value.selected_text === null ? null : String(value.selected_text),
      public_overrides_json: String(value.public_overrides_json),
      decided_at: value.decided_at === null ? null : String(value.decided_at),
    };
    let occurrences: unknown;
    let overrides: unknown;
    try {
      occurrences = JSON.parse(row.occurrences_json);
      overrides = JSON.parse(row.public_overrides_json);
    } catch { return null; }
    if (row.workflow_run_id !== workflowRunId || !stableId(row.target_id)
      || !isStoryPrivacyDigest(row.target_content_digest) || !safeText(row.proposed_text)
      || !Array.isArray(occurrences) || occurrences.some((item) => !parseOccurrence(item))
      || !Array.isArray(overrides) || overrides.some((item) => !parseOverride(item))
      || new Set(overrides.map((item) => storyPrivacyOverrideKey(item))).size !== overrides.length
      || (row.selected_text === null
        ? (overrides.length !== 0 || row.decided_at !== null)
        : (!safeText(row.selected_text) || !exactTimestamp(row.decided_at)))) return null;
    targetRows.push(row);
  }
  targetRows.sort((left, right) => compareUtf8(left.target_id, right.target_id));
  return new Set(targetRows.map((row) => row.target_id)).size === targetRows.length ? targetRows : null;
}

function proposalFromRow(row: TargetRow): StoryPreparationPrivacyTargetProposal {
  return {
    targetId: row.target_id as StoryReleaseTarget,
    targetContentDigest: row.target_content_digest,
    proposedText: row.proposed_text,
    occurrences: JSON.parse(row.occurrences_json) as StoryPrivacyOccurrence[],
  };
}

function privacyOutput(
  candidates: StoryPreparationPrivacyCandidate[],
  targetRows: TargetRow[],
  targetOrder?: Array<{ id: StoryReleaseTarget }>,
): StoryPreparationPrivacyOutput {
  if (!targetOrder) return { candidates, targetProposals: targetRows.map(proposalFromRow) };
  const byId = new Map(targetRows.map((row) => [row.target_id, row]));
  return {
    candidates,
    targetProposals: targetOrder.map((target) => proposalFromRow(byId.get(target.id)!)),
  };
}

function candidateRowSnapshot(rowsToSnapshot: CandidateRow[]) {
  return rowsToSnapshot.map((row) => ({
    workflowRunId: row.workflow_run_id,
    candidateId: row.candidate_id,
    candidateJson: row.candidate_json,
  }));
}

function targetRowSnapshot(rowsToSnapshot: TargetRow[]) {
  return rowsToSnapshot.map((row) => ({
    workflowRunId: row.workflow_run_id,
    targetId: row.target_id,
    targetContentDigest: row.target_content_digest,
    proposedText: row.proposed_text,
    occurrencesJson: row.occurrences_json,
    selectedText: row.selected_text,
    publicOverridesJson: row.public_overrides_json,
    decidedAt: row.decided_at,
  }));
}

function residualCandidates(candidates: StoryPreparationPrivacyCandidate[], retained: Set<string>) {
  const output: StoryPreparationPrivacyCandidate[] = [];
  const ids = new Set<string>();
  for (const candidate of candidates) {
    const releaseTargets = candidate.releaseTargets.filter((target) => retained.has(target));
    if (releaseTargets.length === 0) continue;
    const partial = releaseTargets.length !== candidate.releaseTargets.length;
    const id = partial && !candidate.id.endsWith("::retained") ? `${candidate.id}::retained` : candidate.id;
    if (id.length > 1_000 || ids.has(id)) return null;
    ids.add(id);
    output.push({ ...candidate, id, releaseTargets });
  }
  return output.sort((left, right) => compareUtf8(left.id, right.id));
}

function scalarRanges(value: string, fragment: string) {
  const source = Array.from(value);
  const needle = Array.from(fragment);
  const ranges: Array<{ startOffset: number; endOffset: number }> = [];
  if (needle.length === 0) return ranges;
  for (let index = 0; index + needle.length <= source.length; index += 1) {
    if (needle.every((point, offset) => source[index + offset] === point)) {
      ranges.push({ startOffset:index, endOffset:index + needle.length });
    }
  }
  return ranges;
}

async function knownFragments(resultRows: Row[], redactionRows: Row[]) {
  const byItem = new Map<string, Row[]>();
  for (const row of redactionRows) {
    const itemId = String(row.item_id || "");
    byItem.set(itemId, [...(byItem.get(itemId) || []), row]);
  }
  try {
    return resultRows.flatMap((item) => activeRedactionFragments(
      String(item.content || ""),
      byItem.get(String(item.id || "")) || [],
    )) as KnownFragment[];
  } catch {
    return null;
  }
}

function decorateTarget(
  target: ReviewedStoryPrivacyTarget,
  row: TargetRow,
  fragments: KnownFragment[],
): StoryPrivacyTargetReview | null {
  const proposal = proposalFromRow(row);
  const occurrences = proposal.occurrences;
  const relevant = fragments.flatMap((fragment) => scalarRanges(target.content, fragment.text)
    .map((range) => ({ ...fragment, ...range })));
  if (relevant.some((range) => !occurrences.some((occurrence) => (
    occurrence.originalStartOffset <= range.startOffset
    && occurrence.originalEndOffset >= range.endOffset
  ))) || !storyPrivacyTextAllowed(proposal.proposedText, fragments.map((fragment) => fragment.text))) {
    return null;
  }
  const credentialRanges = relevant.filter((range) => (
    storyPrivacyCredentialCategory(range.category) || storyPrivacyCredentialText(range.text)
  ));
  const overrides = JSON.parse(row.public_overrides_json) as StoryPrivacyPublicOverride[];
  const reviews = storyPrivacyOccurrenceReviews(
    target.content,
    proposal.proposedText,
    occurrences,
    overrides,
    credentialRanges,
  );
  if (overrides.some((override) => !reviews.some((review) => (
    storyPrivacyOverrideKey(review) === storyPrivacyOverrideKey(override) && review.canPublish
  )))) return null;
  if (row.selected_text !== null) {
    if (overrides.length > 0) {
      if (applyStoryPrivacyPublicOverrides(target.content, proposal.proposedText, occurrences, overrides)
        !== row.selected_text) return null;
    } else if (row.selected_text !== proposal.proposedText && !storyPrivacyTextAllowed(
      row.selected_text,
      [...fragments.map((fragment) => fragment.text), ...reviews.map((review) => review.originalText)],
    )) return null;
  }
  return {
    targetId: target.id,
    targetContentDigest: target.contentDigest,
    originalText: target.content,
    proposedText: proposal.proposedText,
    selectedText: row.selected_text,
    edited: row.selected_text !== null && row.selected_text !== proposal.proposedText
      && overrides.length === 0,
    occurrences: reviews,
    decidedAt: row.decided_at,
  };
}

function validTargetRows(
  targets: ReviewedStoryPrivacyTarget[],
  targetRows: TargetRow[],
  fragments: KnownFragment[],
) {
  if (targets.length !== targetRows.length) return false;
  const rowById = new Map(targetRows.map((row) => [row.target_id, row]));
  return targets.every((target) => {
    const row = rowById.get(target.id);
    return Boolean(row && row.target_content_digest === target.contentDigest
      && decorateTarget(target, row, fragments));
  });
}

function parseStoredCatalog(value: string) {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.some((target) => !isRecord(target)
    || !onlyKeys(target, ["id", "contentDigest"]) || !stableId(target.id)
    || !isStoryPrivacyDigest(target.contentDigest))) return null;
  const catalog = parsed as Array<{ id: StoryReleaseTarget; contentDigest: string }>;
  return new Set(catalog.map((target) => target.id)).size === catalog.length ? catalog : null;
}

async function baselineTargets(storyRows: Row[]) {
  const parsed = [];
  for (const row of storyRows) {
    const sequence = Number(row.sequence);
    if (!stableId(row.id) || !stableId(row.documentId) || !Number.isSafeInteger(sequence)
      || sequence < 0 || (row.timestamp !== null && typeof row.timestamp !== "string")
      || typeof row.summary !== "string") return null;
    const story = parseStorySource(row.summary);
    if (!story) return null;
    parsed.push({
      id: row.id as string,
      documentId: row.documentId as string,
      sequence,
      timestamp: row.timestamp as string | null,
      summary: row.summary,
      story,
    });
  }
  parsed.sort(compareStorySourceIdentity);
  const targets = deriveStoryReleaseTargetContents(parsed.map((row) => row.story));
  return targets ? {
    targets,
    inputDigest: await storyPreparationDigest(parsed.map((row) => ({ id:row.id, story:row.story }))),
  } : null;
}

async function captureAuthority(
  db: StoryPrivacyDatabase,
  workflowRunId: string,
): Promise<CapturedAuthority | AuthorityFailure> {
  const revisionResult = await reconstructReviewedStoryPrivacyRevision(db, workflowRunId);
  if (!revisionResult.ok) return { ok: false, code: revisionResult.code };
  let revision = revisionResult.revision;
  const results = await db.batch([
    db.prepare(`SELECT workflow_run_id,candidate_id,candidate_json FROM story_privacy_candidates
      WHERE workflow_run_id=? ORDER BY candidate_id`).bind(workflowRunId),
    db.prepare(`SELECT workflow_run_id,target_id,target_content_digest,proposed_text,
      occurrences_json,selected_text,public_overrides_json,decided_at FROM story_privacy_targets
      WHERE workflow_run_id=? ORDER BY target_id`).bind(workflowRunId),
    db.prepare("SELECT * FROM story_privacy_authorities WHERE workflow_run_id=?").bind(workflowRunId),
    db.prepare(`SELECT workflow_run_id,lane,source_revision,input_digest,scope_digest,scope_count,
      output_digest,output_count,completed_at FROM story_preparation_receipts
      WHERE workflow_run_id=? AND lane='story_privacy'`).bind(workflowRunId),
    db.prepare("SELECT id,content FROM items ORDER BY document_id,sequence,id"),
    db.prepare(`SELECT item_id,start_offset,end_offset,category,status,review_state FROM redactions
      WHERE status='active' AND review_state IN ('deterministic','confirmed_redact')
      ORDER BY item_id,start_offset,end_offset,category`),
    db.prepare(`SELECT id,document_id AS documentId,sequence,timestamp,
      organization_reason AS summary FROM items WHERE organization_reason LIKE 'oxygen.story%'`),
  ]);
  const normalizedCandidates = normalizeCandidateRows(rows(results, 0), workflowRunId);
  const targetRows = normalizeTargetRows(rows(results, 1), workflowRunId);
  if (!normalizedCandidates || !targetRows) {
    return { ok: false, code: STORY_PRIVACY_ERROR.invalidAuthority };
  }
  const { candidateRows, candidates } = normalizedCandidates;
  const storedRows = rows(results, 2);
  const receiptRows = rows(results, 3);
  const contractRefreshRequired = candidateRows.length === 0 && targetRows.length === 0
    && storedRows.length === 0 && receiptRows.length === 0;
  const initialBootstrap = storedRows.length === 0 && receiptRows.length === 1;
  const currentImport = storedRows.length === 1 && receiptRows.length <= 1;
  if (storedRows.length > 1 || receiptRows.length > 1
    || (!contractRefreshRequired && !initialBootstrap && !currentImport)) {
    return { ok: false, code: STORY_PRIVACY_ERROR.invalidAuthority };
  }
  if (contractRefreshRequired) {
    const targetTransitions = revision.targets.map((target) => ({
      id: target.id,
      previousContentDigest: null,
      contentDigest: target.contentDigest,
    })).sort((left, right) => compareUtf8(left.id, right.id));
    revision = {
      ...revision,
      changedTargetDigest: await storyPreparationDigest(targetTransitions),
      targetTransitions,
      changedTargets: revision.targets,
    };
  }
  const rawOutput = privacyOutput(candidates, targetRows);
  let storedMatchesCurrent = false;
  if (storedRows.length === 1) {
    const stored = storedRows[0] as unknown as StoredAuthorityRow;
    const catalog = parseStoredCatalog(String(stored.target_catalog_json));
    if (!catalog || catalog.length !== targetRows.length) {
      return { ok: false, code: STORY_PRIVACY_ERROR.invalidAuthority };
    }
    const targetById = new Map(targetRows.map((row) => [row.target_id, row]));
    if (catalog.some((target) => targetById.get(target.id)?.target_content_digest
      !== target.contentDigest)) {
      return { ok: false, code: STORY_PRIVACY_ERROR.invalidAuthority };
    }
    const storedProposalDigest = await storyPreparationDigest(
      privacyOutput(candidates, targetRows, catalog),
    );
    if (stored.workflow_run_id !== workflowRunId
      || !Number.isSafeInteger(Number(stored.source_revision)) || Number(stored.source_revision) <= 0
      || !Number.isSafeInteger(Number(stored.server_version)) || Number(stored.server_version) < 0
      || !Number.isSafeInteger(Number(stored.changed_target_count)) || Number(stored.changed_target_count) < 0
      || !Number.isSafeInteger(Number(stored.proposal_count)) || Number(stored.proposal_count) < 0
      || ![stored.active_story_digest, stored.reviewed_story_digest, stored.target_catalog_digest,
        stored.changed_target_digest, stored.receipt_digest, stored.proposal_digest]
        .every(isStoryPrivacyDigest)
      || !exactTimestamp(stored.imported_at)
      || await storyPreparationDigest(catalog) !== stored.target_catalog_digest
      || stored.proposal_digest !== storedProposalDigest
      || Number(stored.proposal_count) !== targetRows.length) {
      return { ok: false, code: STORY_PRIVACY_ERROR.invalidAuthority };
    }
    storedMatchesCurrent = Number(stored.source_revision) === revision.sourceRevision
      && stored.active_story_digest === revision.activeStoryDigest
      && Number(stored.server_version) <= revision.serverVersion
      && stored.reviewed_story_digest === revision.reviewedStoryDigest
      && stored.target_catalog_digest === revision.targetCatalogDigest
      && JSON.stringify(catalog) === JSON.stringify(revision.targetCatalog);
  } else if (!contractRefreshRequired) {
    const receipt = receiptRows[0]!;
    const baseline = await baselineTargets(rows(results, 6));
    const initial = baseline && await normalizeStoryPrivacyOutput(rawOutput, baseline.targets);
    const initialDigest = initial ? await storyPreparationDigest(initial) : null;
    if (!baseline || !initial || receipt.workflow_run_id !== workflowRunId
      || receipt.lane !== "story_privacy" || Number(receipt.source_revision) !== revision.sourceRevision
      || receipt.input_digest !== baseline.inputDigest
      || receipt.scope_digest !== await storyPreparationDigest(baseline.targets.map((target) => target.id))
      || Number(receipt.scope_count) !== baseline.targets.length
      || receipt.output_digest !== initialDigest || Number(receipt.output_count) !== targetRows.length
      || !exactTimestamp(receipt.completed_at)) {
      return { ok: false, code: STORY_PRIVACY_ERROR.invalidAuthority };
    }
  }

  const fragments = await knownFragments(rows(results, 4), rows(results, 5));
  if (!fragments) return { ok: false, code: STORY_PRIVACY_ERROR.invalidAuthority };
  const currentById = new Map(revision.targets.map((target) => [target.id, target]));
  const retainedTargetRows = targetRows.filter((row) => (
    currentById.get(row.target_id as StoryReleaseTarget)?.contentDigest === row.target_content_digest
  ));
  const retainedIds = new Set(retainedTargetRows.map((row) => row.target_id));
  const retainedCandidates = residualCandidates(candidates, retainedIds);
  if (!retainedCandidates) return { ok: false, code: STORY_PRIVACY_ERROR.invalidAuthority };
  const retainedTargets = revision.targets.filter((target) => retainedIds.has(target.id));
  if (!await normalizeStoryPrivacyOutput(
    privacyOutput(retainedCandidates, retainedTargetRows),
    retainedTargets,
  )) return { ok: false, code: STORY_PRIVACY_ERROR.invalidAuthority };
  const targetReviews: StoryPrivacyTargetReview[] = [];
  for (const target of revision.targets) {
    const row = retainedTargetRows.find((candidate) => candidate.target_id === target.id);
    if (!row) continue;
    const review = decorateTarget(target, row, fragments);
    if (!review) return { ok: false, code: STORY_PRIVACY_ERROR.invalidAuthority };
    targetReviews.push(review);
  }
  const preparationRequired = contractRefreshRequired
    || retainedTargetRows.length !== revision.targets.length
    || (storedRows.length === 1 ? !storedMatchesCurrent : revision.targetTransitions.length > 0);
  const candidateResponses = retainedCandidates.map((candidate) => ({
    ...candidate,
    resolved: candidate.releaseTargets.every((target) => (
      targetReviews.find((review) => review.targetId === target)?.selectedText !== null
    )),
  }));
  const authorityDigest = await storyPreparationDigest({
    workflowRunId,
    sourceRevision: revision.sourceRevision,
    activeStoryDigest: revision.activeStoryDigest,
    serverVersion: revision.serverVersion,
    reviewedStoryDigest: revision.reviewedStoryDigest,
    targetCatalogDigest: revision.targetCatalogDigest,
    candidates: candidateRowSnapshot(candidateRows),
    targets: targetRowSnapshot(targetRows),
  });
  return {
    response: {
      workflowRunId,
      sourceRevision: revision.sourceRevision,
      activeStoryDigest: revision.activeStoryDigest,
      authorityDigest,
      status: preparationRequired ? "preparation_required"
        : candidateResponses.length === 0 ? "completed_empty" : "completed_with_candidates",
      candidates: candidateResponses,
      targets: targetReviews,
    },
    revision,
    rawCandidates: candidates,
    rawCandidateRows: candidateRows,
    rawTargetRows: targetRows,
    retainedCandidates,
    retainedTargetRows,
    knownFragments: fragments,
  };
}

export async function readStoryPrivacyAuthority(
  db: StoryPrivacyDatabase,
  workflowRunId: string,
): Promise<{ ok: true; authority: StoryPrivacyAuthorityResponse } | AuthorityFailure> {
  const current = await captureAuthority(db, workflowRunId);
  return "response" in current ? { ok: true, authority: current.response } : current;
}

export async function buildReviewedStoryPrivacyPreparationSnapshot(
  db: StoryPrivacyDatabase,
  workflowRunId: string,
) {
  const current = await captureAuthority(db, workflowRunId);
  if (!("response" in current)) return current;
  if (current.revision.targetTransitions.length === 0) {
    return { ok: false as const, code: STORY_PRIVACY_ERROR.notActionable };
  }
  return {
    ok: true as const,
    snapshot: {
      schema: "oxygen.reviewed-story-privacy-snapshot" as const,
      binding: {
        workflowRunId,
        sourceRevision: current.revision.sourceRevision,
        activeStoryDigest: current.revision.activeStoryDigest,
        serverVersion: current.revision.serverVersion,
        reviewedStoryDigest: current.revision.reviewedStoryDigest,
        targetCatalogDigest: current.revision.targetCatalogDigest,
        changedTargetDigest: current.revision.changedTargetDigest,
        changedTargetCount: current.revision.targetTransitions.length,
        previousAuthorityDigest: current.response.authorityDigest,
      },
      targetTransitions: current.revision.targetTransitions,
      changedTargets: current.revision.changedTargets,
    },
  };
}

const importBindingKeys = [
  "workflowRunId", "sourceRevision", "activeStoryDigest", "serverVersion",
  "reviewedStoryDigest", "targetCatalogDigest", "changedTargetDigest",
  "changedTargetCount", "previousAuthorityDigest",
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
    previousAuthorityDigest: string;
  };
  terminalReceipt: Record<string, unknown>;
  receiptDigest: string;
  privacy: StoryPreparationPrivacyOutput;
  importDigest: string;
};

export function parseImportBundle(value: unknown): ReviewedStoryPrivacyImport | null {
  if (!isRecord(value) || !onlyKeys(value, [
    "schema", "binding", "terminalReceipt", "receiptDigest", "privacy", "importDigest",
  ]) || value.schema !== "oxygen.reviewed-story-privacy-import"
    || !isRecord(value.binding) || !onlyKeys(value.binding, importBindingKeys)
    || !isRecord(value.terminalReceipt) || !onlyKeys(value.terminalReceipt, terminalReceiptKeys)
    || !isRecord(value.privacy)
    || ![value.receiptDigest, value.importDigest].every(isStoryPrivacyDigest)) return null;
  const binding = value.binding;
  if (!stableId(binding.workflowRunId)
    || !Number.isSafeInteger(binding.sourceRevision) || Number(binding.sourceRevision) <= 0
    || !Number.isSafeInteger(binding.serverVersion) || Number(binding.serverVersion) < 0
    || !Number.isSafeInteger(binding.changedTargetCount) || Number(binding.changedTargetCount) < 0
    || ![binding.activeStoryDigest, binding.reviewedStoryDigest, binding.targetCatalogDigest,
      binding.changedTargetDigest, binding.previousAuthorityDigest].every(isStoryPrivacyDigest)) return null;
  return value as unknown as ReviewedStoryPrivacyImport;
}

function exactImportBinding(
  binding: ReviewedStoryPrivacyImport["binding"],
  revision: ReviewedStoryPrivacyRevision,
  authorityDigest: string,
) {
  return binding.workflowRunId === revision.workflowRunId
    && binding.sourceRevision === revision.sourceRevision
    && binding.activeStoryDigest === revision.activeStoryDigest
    && binding.serverVersion === revision.serverVersion
    && binding.reviewedStoryDigest === revision.reviewedStoryDigest
    && binding.targetCatalogDigest === revision.targetCatalogDigest
    && binding.changedTargetDigest === revision.changedTargetDigest
    && binding.changedTargetCount === revision.targetTransitions.length
    && binding.previousAuthorityDigest === authorityDigest;
}

function newTargetRows(
  workflowRunId: string,
  privacy: StoryPreparationPrivacyOutput,
  now: string,
) {
  const pending = new Set(privacy.candidates
    .filter((candidate) => candidate.reviewState === "needs_confirmation")
    .flatMap((candidate) => candidate.releaseTargets));
  return privacy.targetProposals.map((proposal): TargetRow => ({
    workflow_run_id: workflowRunId,
    target_id: proposal.targetId,
    target_content_digest: proposal.targetContentDigest,
    proposed_text: proposal.proposedText,
    occurrences_json: JSON.stringify(proposal.occurrences),
    selected_text: pending.has(proposal.targetId) ? null : proposal.proposedText,
    public_overrides_json: "[]",
    decided_at: pending.has(proposal.targetId) ? null : now,
  }));
}

export async function importReviewedStoryPrivacyAuthority(
  db: StoryPrivacyDatabase,
  input: unknown,
  importedAt: string,
): Promise<{ ok: true; authority: StoryPrivacyAuthorityResponse } | AuthorityFailure> {
  const bundle = parseImportBundle(input);
  if (!bundle || !exactTimestamp(importedAt)) {
    return { ok: false, code: STORY_PRIVACY_ERROR.importInvalid };
  }
  const before = await captureAuthority(db, bundle.binding.workflowRunId);
  if (!("response" in before)) return before;
  const workflowRunId = bundle.binding.workflowRunId;
  const revision = before.revision;
  if (!exactImportBinding(bundle.binding, revision, before.response.authorityDigest)
    || revision.targetTransitions.length === 0) {
    return { ok: false, code: STORY_PRIVACY_ERROR.importStale };
  }
  const importedPrivacy = await normalizeStoryPrivacyOutput(bundle.privacy, revision.changedTargets);
  if (!importedPrivacy) return { ok: false, code: STORY_PRIVACY_ERROR.importInvalid };
  const outputDigest = await storyPreparationDigest(importedPrivacy);
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
    outputCount: importedPrivacy.targetProposals.length,
    completedAt: receipt.completedAt,
  };
  const canonicalReceiptDigest = await storyPreparationDigest(receipt);
  if (!exactTimestamp(receipt.completedAt)
    || canonicalReceiptDigest !== await storyPreparationDigest(expectedReceipt)
    || canonicalReceiptDigest !== bundle.receiptDigest
    || await storyPreparationDigest({
      schema: bundle.schema,
      binding: bundle.binding,
      receiptDigest: bundle.receiptDigest,
      privacy: importedPrivacy,
    }) !== bundle.importDigest) return { ok: false, code: STORY_PRIVACY_ERROR.importInvalid };

  const currentById = new Map(revision.targets.map((target) => [target.id, target.contentDigest]));
  const retainedRows = before.rawTargetRows.filter((row) => (
    currentById.get(row.target_id as StoryReleaseTarget) === row.target_content_digest
  ));
  const retainedIds = new Set(retainedRows.map((row) => row.target_id));
  const retainedCandidates = residualCandidates(before.rawCandidates, retainedIds);
  if (!retainedCandidates) return { ok: false, code: STORY_PRIVACY_ERROR.importInvalid };
  const candidateIds = new Set(retainedCandidates.map((candidate) => candidate.id));
  if (importedPrivacy.candidates.some((candidate) => candidateIds.has(candidate.id))) {
    return { ok: false, code: STORY_PRIVACY_ERROR.importInvalid };
  }
  const mergedPrivacy: StoryPreparationPrivacyOutput = {
    candidates: [...retainedCandidates, ...importedPrivacy.candidates]
      .sort((left, right) => compareUtf8(left.id, right.id)),
    targetProposals: [...retainedRows.map(proposalFromRow), ...importedPrivacy.targetProposals]
      .sort((left, right) => compareUtf8(left.targetId, right.targetId)),
  };
  const normalizedMerged = await normalizeStoryPrivacyOutput(mergedPrivacy, revision.targets);
  if (!normalizedMerged) return { ok: false, code: STORY_PRIVACY_ERROR.importInvalid };
  const mergedRows = [...retainedRows, ...newTargetRows(workflowRunId, importedPrivacy, importedAt)]
    .sort((left, right) => compareUtf8(left.target_id, right.target_id));
  if (!validTargetRows(revision.targets, mergedRows, before.knownFragments)) {
    return { ok: false, code: STORY_PRIVACY_ERROR.importInvalid };
  }
  const proposalDigest = await storyPreparationDigest(normalizedMerged);
  try {
    await db.transaction(async () => {
      const current = await captureAuthority(db, workflowRunId);
      if (!("response" in current)
        || !exactImportBinding(bundle.binding, current.revision, current.response.authorityDigest)) {
        throw new Error(STORY_PRIVACY_ERROR.importStale);
      }
      if (!validTargetRows(current.revision.targets, mergedRows, current.knownFragments)) {
        throw new Error(STORY_PRIVACY_ERROR.importInvalid);
      }
      await db.prepare("DELETE FROM story_privacy_candidates WHERE workflow_run_id=?")
        .bind(workflowRunId).run();
      await db.prepare("DELETE FROM story_privacy_targets WHERE workflow_run_id=?")
        .bind(workflowRunId).run();
      for (const candidate of normalizedMerged.candidates) {
        await db.prepare(`INSERT INTO story_privacy_candidates
          (workflow_run_id,candidate_id,candidate_json) VALUES (?,?,?)`).bind(
          workflowRunId, candidate.id, JSON.stringify(candidate),
        ).run();
      }
      for (const row of mergedRows) {
        await db.prepare(`INSERT INTO story_privacy_targets
          (workflow_run_id,target_id,target_content_digest,proposed_text,occurrences_json,
           selected_text,public_overrides_json,decided_at) VALUES (?,?,?,?,?,?,?,?)`).bind(
          row.workflow_run_id, row.target_id, row.target_content_digest, row.proposed_text,
          row.occurrences_json, row.selected_text, row.public_overrides_json, row.decided_at,
        ).run();
      }
      await db.prepare(`INSERT INTO story_privacy_authorities
        (workflow_run_id,source_revision,active_story_digest,server_version,reviewed_story_digest,
         target_catalog_json,target_catalog_digest,changed_target_digest,changed_target_count,
         receipt_digest,proposal_digest,proposal_count,imported_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(workflow_run_id) DO UPDATE SET
          source_revision=excluded.source_revision,active_story_digest=excluded.active_story_digest,
          server_version=excluded.server_version,reviewed_story_digest=excluded.reviewed_story_digest,
          target_catalog_json=excluded.target_catalog_json,target_catalog_digest=excluded.target_catalog_digest,
          changed_target_digest=excluded.changed_target_digest,changed_target_count=excluded.changed_target_count,
          receipt_digest=excluded.receipt_digest,proposal_digest=excluded.proposal_digest,
          proposal_count=excluded.proposal_count,imported_at=excluded.imported_at`).bind(
          workflowRunId, revision.sourceRevision, revision.activeStoryDigest, revision.serverVersion,
          revision.reviewedStoryDigest, JSON.stringify(revision.targetCatalog), revision.targetCatalogDigest,
          revision.changedTargetDigest, revision.targetTransitions.length, bundle.receiptDigest,
          proposalDigest, normalizedMerged.targetProposals.length, importedAt,
        ).run();
      await db.prepare("DELETE FROM project_release_confirmations WHERE workflow_run_id=?")
        .bind(workflowRunId).run();
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    return { ok: false, code: code === STORY_PRIVACY_ERROR.importStale
      ? STORY_PRIVACY_ERROR.importStale : code === STORY_PRIVACY_ERROR.importInvalid
        ? STORY_PRIVACY_ERROR.importInvalid : STORY_PRIVACY_ERROR.lostCas };
  }
  return readStoryPrivacyAuthority(db, workflowRunId);
}

export async function saveStoryPrivacyTargetChoice(
  db: StoryPrivacyDatabase,
  input: {
    workflowRunId: string;
    sourceRevision: number;
    activeStoryDigest: string;
    authorityDigest: string;
    targetId: StoryReleaseTarget;
    targetContentDigest: string;
    editedText: string | null;
    publicOverrides: StoryPrivacyPublicOverride[];
  },
  decidedAt: string,
): Promise<{ ok: true; authority: StoryPrivacyAuthorityResponse } | AuthorityFailure> {
  if (!stableId(input.workflowRunId) || !stableId(input.targetId)
    || !Number.isSafeInteger(input.sourceRevision) || input.sourceRevision <= 0
    || ![input.activeStoryDigest, input.authorityDigest, input.targetContentDigest]
      .every(isStoryPrivacyDigest)
    || !exactTimestamp(decidedAt) || (input.editedText !== null && !safeText(input.editedText))
    || !Array.isArray(input.publicOverrides)
    || input.publicOverrides.some((override) => !parseOverride(override))
    || new Set(input.publicOverrides.map(storyPrivacyOverrideKey)).size !== input.publicOverrides.length
    || (input.editedText !== null && input.publicOverrides.length > 0)) {
    return { ok: false, code: STORY_PRIVACY_ERROR.notActionable };
  }
  const before = await captureAuthority(db, input.workflowRunId);
  if (!("response" in before)) return before;
  if (before.response.status === "preparation_required"
    || before.response.sourceRevision !== input.sourceRevision
    || before.response.activeStoryDigest !== input.activeStoryDigest
    || before.response.authorityDigest !== input.authorityDigest) {
    return { ok: false, code: STORY_PRIVACY_ERROR.staleAuthority };
  }
  const target = before.response.targets.find((value) => value.targetId === input.targetId
    && value.targetContentDigest === input.targetContentDigest);
  if (!target) return { ok: false, code: STORY_PRIVACY_ERROR.targetNotFound };
  let selectedText: string | null;
  if (input.editedText !== null) {
    selectedText = storyPrivacyTextAllowed(input.editedText, [
      ...before.knownFragments.map((fragment) => fragment.text),
      ...target.occurrences.map((occurrence) => occurrence.originalText),
    ]) ? input.editedText : null;
  } else {
    selectedText = applyStoryPrivacyPublicOverrides(
      target.originalText,
      target.proposedText,
      target.occurrences,
      input.publicOverrides,
    );
    if (input.publicOverrides.some((override) => !target.occurrences.some((occurrence) => (
      storyPrivacyOverrideKey(occurrence) === storyPrivacyOverrideKey(override) && occurrence.canPublish
    )))) selectedText = null;
  }
  if (selectedText === null) return { ok: false, code: STORY_PRIVACY_ERROR.notActionable };
  try {
    await db.transaction(async () => {
      const current = await captureAuthority(db, input.workflowRunId);
      if (!("response" in current) || current.response.authorityDigest !== input.authorityDigest
        || current.response.status === "preparation_required") {
        throw new Error(STORY_PRIVACY_ERROR.lostCas);
      }
      const result = await db.prepare(`UPDATE story_privacy_targets
        SET selected_text=?,public_overrides_json=?,decided_at=?
        WHERE workflow_run_id=? AND target_id=? AND target_content_digest=?`).bind(
          selectedText, JSON.stringify(input.publicOverrides), decidedAt,
          input.workflowRunId, input.targetId, input.targetContentDigest,
        ).run();
      if (Number(result.meta.changes) !== 1) throw new Error(STORY_PRIVACY_ERROR.lostCas);
      await db.prepare("DELETE FROM project_release_confirmations WHERE workflow_run_id=?")
        .bind(input.workflowRunId).run();
    });
  } catch {
    return { ok: false, code: STORY_PRIVACY_ERROR.lostCas };
  }
  return readStoryPrivacyAuthority(db, input.workflowRunId);
}

export function isStoryPrivacyDigest(value: unknown): value is string {
  return typeof value === "string" && digestPattern.test(value);
}

export function isStoryPrivacyCandidateId(value: unknown): value is string {
  return stableId(value) && value.length <= 1_000;
}
