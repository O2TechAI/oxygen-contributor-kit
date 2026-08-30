import { getLocalDatabase } from "../../../db";
import { loadWorkflowProgress } from "../../../lib/workflow-progress-server";
import { deriveWorkflowProgress } from "../../../lib/workflow-progress";
import {
  normalizeStoryCandidateSubmission,
  readSemanticManifestAuthority,
  readStoredCoverageManifestAuthority,
  validateCoverageRevisionTransition,
  validateStoryActivationAuthority,
  type CoverageManifestAuthority,
  type StoryCandidateItemAuthority,
  type StoryEvidenceRow,
} from "../../../lib/story-readiness";
import { isWorkflowRunId } from "../../../lib/workflow-progress";
import {
  canonicalPreferenceQuestionBatch,
  storyPreparationDigest,
  validateStoryPreparationManifest,
  type PreferenceBatchAuthority,
} from "../../../lib/story-preparation";
import {
  WORKFLOW_RUN_AUTHORITY,
  WorkflowRunAuthorityError,
  establishWorkflowRun,
  requireExactWorkflowRun,
  workflowRunErrorResponse,
} from "../../../lib/workflow-run-server";
import {
  STORY_SOURCE_WRITE_STATUS,
  abortStorySourceMutation,
  beginStoryActivationMutation,
  isStorySourceWriteInProgress,
  publishActivatedStorySourceMutation,
} from "../../../lib/story-source-publication";
import {
  coveragePrivacyAuthorityGuardStatement,
  readCoveragePrivacyAuthority,
} from "../../../lib/story-coverage-privacy-authority";
import { validActivatedSourceRevision } from "../../../lib/authority-validation.mjs";
import {
  validatePreferenceLifecycleRow,
  type PreferenceLifecycleRow,
} from "../../../lib/story-release-server";

const EVENTS = new Set([
  "target_confirmed",
  "collection_started",
  "collection_progress",
  "collection_completed",
  "collection_failed",
  "story_generation_started",
  "story_generation_progress",
  "story_generation_blocked",
  "story_ready_for_human_review",
]);
const BODY_KEYS = new Set([
  "workflowRunId", "event", "completed", "total", "coverageManifest", "storyCandidates",
  "preparationManifest",
]);
export const dynamic = "force-dynamic";

const count = (value: unknown) => typeof value === "number"
  && Number.isSafeInteger(value)
  && value >= 0
  ? value
  : null;

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readPreferenceBatchAuthority(
  db: Awaited<ReturnType<typeof getLocalDatabase>>,
  workflowRunId: string,
  sourceRevision: number,
): Promise<PreferenceBatchAuthority | null> {
  const [run, probeRows, bulkRows, lifecycleRow] = await Promise.all([
    db.prepare(`SELECT workflow_run_id,source_revision,input_digest,output_digest,
        output_count,status,stage FROM probe_runs WHERE workflow_run_id=?`)
      .bind(workflowRunId).first<Record<string, unknown>>(),
    db.prepare(`SELECT id,document_id,document_kind,event_ids_json,timestamp,signal,
        score,turns,recap,question,options_json,presentations_json,allow_other,allow_skip
        FROM probes ORDER BY id`).all<Record<string, unknown>>(),
    db.prepare(`SELECT id,kind,count,question,evidence_sample_json,presentations_json
        FROM probe_bulk_decisions ORDER BY id`).all<Record<string, unknown>>(),
    db.prepare(`SELECT workflow_run_id,source_revision,active_story_digest,story_session_version,
        state_json,state_digest FROM preference_lifecycle_authorities WHERE workflow_run_id=?`)
      .bind(workflowRunId).first<PreferenceLifecycleRow>(),
  ]);
  if (!validActivatedSourceRevision(sourceRevision)
    || !run || run.workflow_run_id !== workflowRunId
    || !validActivatedSourceRevision(Number(run.source_revision))
    || Number(run.source_revision) !== sourceRevision
    || run.status !== "complete" || run.stage !== "preference"
    || typeof run.input_digest !== "string" || typeof run.output_digest !== "string") return null;
  try {
    const lifecycle = await validatePreferenceLifecycleRow(
      lifecycleRow, workflowRunId, sourceRevision, null,
    );
    if (!lifecycle || lifecycle.questions.length !== probeRows.results.length) return null;
    const bindingById = new Map(lifecycle.questions.map((question) => [question.id, question]));
    const probes = (probeRows.results || []).map((row) => ({
      id: String(row.id),
      storyKey: bindingById.get(String(row.id))?.storyKey,
      insightId: bindingById.get(String(row.id))?.insightId,
      insightAuthorityDigest: bindingById.get(String(row.id))?.insightAuthorityDigest,
      documentId: String(row.document_id),
      documentKind: String(row.document_kind),
      eventIds: JSON.parse(String(row.event_ids_json)),
      timestamp: row.timestamp === null ? null : String(row.timestamp),
      signal: String(row.signal),
      score: Number(row.score),
      turns: Number(row.turns),
      recap: String(row.recap),
      question: String(row.question),
      options: JSON.parse(String(row.options_json)),
      presentations: JSON.parse(String(row.presentations_json)),
      allowOther: Boolean(row.allow_other),
      allowSkip: Boolean(row.allow_skip),
    }));
    const bulk = (bulkRows.results || []).map((row) => ({
      id: String(row.id),
      kind: String(row.kind),
      count: Number(row.count),
      question: String(row.question),
      evidenceSample: JSON.parse(String(row.evidence_sample_json)),
      presentations: JSON.parse(String(row.presentations_json)),
    }));
    const outputCount = probes.length + bulk.length;
    const outputDigest = await storyPreparationDigest(canonicalPreferenceQuestionBatch(probes, bulk));
    if (Number(run.output_count) !== outputCount || run.output_digest !== outputDigest) return null;
    return {
      workflowRunId,
      sourceRevision,
      inputDigest: run.input_digest,
      outputDigest,
      outputCount,
      insightScope: lifecycle.generationScope,
      lifecycleDigest: lifecycleRow!.state_digest,
    };
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const requestedRunId = new URL(request.url).searchParams.get("workflowRunId");
  if (requestedRunId !== null && !isWorkflowRunId(requestedRunId)) {
    return Response.json({ error: "Invalid workflow run" }, { status: 400 });
  }
  try {
    return Response.json(await loadWorkflowProgress(requestedRunId || undefined), {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (error) {
    if (error instanceof WorkflowRunAuthorityError) {
      return workflowRunErrorResponse(error.authority);
    }
    throw error;
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid workflow event" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Invalid workflow event" }, { status: 400 });
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !BODY_KEYS.has(key))) {
    return Response.json({ error: "Unsupported workflow field" }, { status: 400 });
  }
  const workflowRunId = typeof record.workflowRunId === "string" ? record.workflowRunId : "";
  const event = typeof record.event === "string" ? record.event : "";
  if (!isWorkflowRunId(workflowRunId) || !EVENTS.has(event)) {
    return Response.json({ error: "Invalid workflow event" }, { status: 400 });
  }
  if ((record.coverageManifest !== undefined || record.storyCandidates !== undefined
      || record.preparationManifest !== undefined)
    && event !== "story_ready_for_human_review") {
    return Response.json({ error: "Story authority is only accepted at Story activation" }, { status: 400 });
  }
  if (event === "story_ready_for_human_review"
    && (record.coverageManifest === undefined || record.storyCandidates === undefined
      || !record.preparationManifest || typeof record.preparationManifest !== "object"
      || Array.isArray(record.preparationManifest)
      || !validActivatedSourceRevision(
        (record.preparationManifest as Record<string, unknown>).sourceRevision,
      ))) {
    return Response.json({
      error: "Story candidates, coverage, and preparation are required at activation",
    }, { status: 400 });
  }

  const completed = record.completed === undefined ? 0 : count(record.completed);
  const total = record.total === undefined ? 0 : count(record.total);
  const needsCounts = [
    "collection_progress", "collection_completed", "story_generation_progress",
  ].includes(event);
  if (completed === null || total === null || completed > total
    || (needsCounts && record.total === undefined)) {
    return Response.json({ error: "Invalid workflow counts" }, { status: 400 });
  }

  const db = await getLocalDatabase();
  const now = new Date().toISOString();
  if (event === "target_confirmed") {
    const authority = await establishWorkflowRun(db, workflowRunId, now);
    if (authority.state !== WORKFLOW_RUN_AUTHORITY.exactRun) {
      return workflowRunErrorResponse(authority);
    }
    return Response.json(await loadWorkflowProgress(authority.workflowRunId));
  }
  const authority = await requireExactWorkflowRun(db, workflowRunId);
  if (authority.state !== WORKFLOW_RUN_AUTHORITY.exactRun) {
    return workflowRunErrorResponse(authority);
  }
  if (event.startsWith("story_")) {
    const [run, organization, redaction] = await Promise.all([
      db.prepare(`SELECT id,target_confirmed,collection_status,collection_completed,
        collection_total,story_generation_status,story_generation_completed,
        story_generation_total,story_source_revision,updated_at
        FROM workflow_runs WHERE id=?`).bind(workflowRunId).first<{
          id: string; target_confirmed: number; collection_status: string;
          collection_completed: number; collection_total: number;
          story_generation_status: string; story_generation_completed: number;
          story_generation_total: number; story_source_revision: number; updated_at: string;
        }>(),
      db.prepare("SELECT status FROM organization_jobs ORDER BY updated_at DESC LIMIT 1")
        .first<{ status: string }>(),
      db.prepare("SELECT status FROM redaction_jobs ORDER BY started_at DESC LIMIT 1")
        .first<{ status: string }>(),
    ]);
    if (!run) return Response.json({ error: "Workflow run not found" }, { status: 404 });
    if (organization?.status !== "complete" || redaction?.status !== "complete") {
      return Response.json({ error: "Reviewed Story boundary is not ready" }, { status: 409 });
    }
    if (event === "story_generation_started") {
      const semanticManifest = await readSemanticManifestAuthority(db, workflowRunId);
      if (!semanticManifest) {
        return Response.json({ error: "Current semantic manifest is required" }, { status: 409 });
      }
      if (isStorySourceWriteInProgress(run.story_generation_status)) {
        return Response.json({ error: "Reviewed Story boundary changed" }, { status: 409 });
      }
      const privacyAuthority = await readCoveragePrivacyAuthority(
        db,
        workflowRunId,
        semanticManifest,
      );
      if (!privacyAuthority.ok) {
        return Response.json({
          error: "Current source Privacy authority is required",
          code: privacyAuthority.code,
        }, { status: 409 });
      }
      const startedBatch = await db.batch([
        coveragePrivacyAuthorityGuardStatement(
          db,
          privacyAuthority.authority,
          run.story_generation_status,
        ),
        db.prepare(`UPDATE workflow_runs
        SET story_generation_status='running',story_generation_completed=0,
            story_generation_total=0,active_story_digest=NULL,updated_at=?
        WHERE id=? AND story_generation_status=? AND story_source_revision=?
          AND EXISTS (SELECT 1 FROM organization_jobs WHERE status='complete')`)
        .bind(
          now,
          workflowRunId,
          run.story_generation_status,
          run.story_source_revision,
        ),
      ]);
      const started = startedBatch[1];
      if (Number(started.meta.changes || 0) !== 1) {
        return Response.json({ error: "Reviewed Story boundary changed" }, { status: 409 });
      }
      return Response.json(await loadWorkflowProgress(workflowRunId));
    }
    if (event === "story_generation_progress") {
      if (run.story_generation_status !== "running") {
        return Response.json({ error: "Story generation is not running" }, { status: 409 });
      }
      await db.prepare(`UPDATE workflow_runs
        SET story_generation_completed=?,story_generation_total=?,updated_at=? WHERE id=?`)
        .bind(completed, total, now, workflowRunId).run();
      return Response.json(await loadWorkflowProgress(workflowRunId));
    }
    if (event === "story_generation_blocked") {
      const blocked = await db.prepare(`UPDATE workflow_runs
        SET story_generation_status='blocked',active_story_digest=NULL,updated_at=?
        WHERE id=? AND story_generation_status='running'`)
        .bind(now, workflowRunId).run();
      if (Number(blocked.meta.changes || 0) !== 1) {
        return Response.json({ error: "Story generation is not running" }, { status: 409 });
      }
      return Response.json(await loadWorkflowProgress(workflowRunId));
    }
    if (run.story_generation_status !== "running") {
      return Response.json({ error: "Story generation is not running" }, { status: 409 });
    }
    const leasedRevision = Number(run.story_source_revision);
    const preparationSourceRevision = Number(
      (record.preparationManifest as Record<string, unknown>).sourceRevision,
    );
    if (!validActivatedSourceRevision(leasedRevision)
      || preparationSourceRevision !== leasedRevision) {
      return Response.json({ error: "Story source authority is invalid" }, { status: 409 });
    }
    const [preflightSemanticManifest, preflightPreferenceAuthority] = await Promise.all([
      readSemanticManifestAuthority(db, workflowRunId),
      readPreferenceBatchAuthority(db, workflowRunId, leasedRevision),
    ]);
    if (!preflightSemanticManifest) {
      return Response.json({ error: "Current semantic manifest is required" }, { status: 409 });
    }
    if (!preflightPreferenceAuthority) {
      return Response.json({ error: "Current Preference preparation is required" }, { status: 409 });
    }
    const preflightPrivacyAuthority = await readCoveragePrivacyAuthority(
      db,
      workflowRunId,
      preflightSemanticManifest,
    );
    if (!preflightPrivacyAuthority.ok) {
      return Response.json({
        error: "Current source Privacy authority is required",
        code: preflightPrivacyAuthority.code,
      }, { status: 409 });
    }
    if (!await beginStoryActivationMutation(db, workflowRunId, now)) {
      return Response.json({ error: "Another Story source mutation is already running" }, { status: 409 });
    }
    try {
      const [
        { results: itemRows },
        { results: documentRows },
        semanticManifest,
        preferenceAuthority,
      ] = await Promise.all([
        db.prepare(`SELECT id,document_id AS documentId,sequence,timestamp,
          organization_category AS project,event_type AS eventType,
          actor_id AS actorId,actor_type AS actorType
          FROM items ORDER BY document_id,sequence,id`)
          .all<StoryCandidateItemAuthority & StoryEvidenceRow>(),
        db.prepare("SELECT id,formatted_summary_json FROM documents ORDER BY id")
          .all<{ id: string; formatted_summary_json: string }>(),
        readSemanticManifestAuthority(db, workflowRunId),
        readPreferenceBatchAuthority(db, workflowRunId, leasedRevision),
      ]);
      if (!semanticManifest) {
        await abortStorySourceMutation(db, workflowRunId, now, leasedRevision);
        return Response.json({ error: "Current semantic manifest is required" }, { status: 409 });
      }
      const privacyAuthority = await readCoveragePrivacyAuthority(
        db,
        workflowRunId,
        semanticManifest,
      );
      if (!privacyAuthority.ok) {
        await abortStorySourceMutation(db, workflowRunId, now, leasedRevision);
        return Response.json({
          error: "Current source Privacy authority is required",
          code: privacyAuthority.code,
        }, { status: 409 });
      }
      const previousCoverage = await readStoredCoverageManifestAuthority(db, workflowRunId);
      if (!preferenceAuthority) {
        await abortStorySourceMutation(db, workflowRunId, now, leasedRevision);
        return Response.json({ error: "Current Preference preparation is required" }, { status: 409 });
      }
      const normalized = normalizeStoryCandidateSubmission(record.storyCandidates, itemRows);
      if (!normalized.ok) {
        await abortStorySourceMutation(db, workflowRunId, now, leasedRevision);
        return Response.json({
          error: "Story candidate submission validation failed",
          code: normalized.code,
        }, { status: 409 });
      }
      const activationValidation = await validateStoryActivationAuthority(
        normalized.rows,
        itemRows.map((row) => ({
          ...row,
          reviewedNarrative: privacyAuthority.authority.reviewedNarrativeByItemId?.get(row.id),
        })),
        semanticManifest,
        record.coverageManifest,
        privacyAuthority.authority.authorizedUnitIds,
      );
      if (!activationValidation.ok) {
        await abortStorySourceMutation(db, workflowRunId, now, leasedRevision);
        return Response.json({
          error: "Story activation authority validation failed",
          code: activationValidation.code,
        }, { status: 409 });
      }
      const coverageManifest: CoverageManifestAuthority = activationValidation.coverageManifest;
      const preparationValidation = await validateStoryPreparationManifest(
        record.preparationManifest,
        {
          workflowRunId,
          sourceRevision: leasedRevision,
          semanticManifestDigest: semanticManifest.manifestDigest,
          semanticUnitIds: semanticManifest.units.map((unit) => unit.id),
          storyCandidates: normalized.rows,
          preference: preferenceAuthority,
        },
      );
      if (!preparationValidation.ok) {
        await abortStorySourceMutation(db, workflowRunId, now, leasedRevision);
        return Response.json({
          error: "Story preparation authority validation failed",
          code: preparationValidation.code,
        }, { status: 409 });
      }
      const preparation = preparationValidation.authority;
      const revisionFailure = validateCoverageRevisionTransition(
        coverageManifest,
        previousCoverage,
      );
      if (revisionFailure) {
        await abortStorySourceMutation(db, workflowRunId, now, leasedRevision);
        return Response.json({
          error: "Coverage manifest revision transition failed",
          code: revisionFailure,
        }, { status: 409 });
      }
      const validation = activationValidation.source;
      const digest = await sha256(validation.canonicalCandidate);
      const leaseSql = `EXISTS (SELECT 1 FROM workflow_runs r
        JOIN semantic_manifests m ON m.workflow_run_id=r.id
        WHERE r.id=? AND r.story_source_revision=? AND r.story_generation_status=?
          AND m.source_revision=?)`;
      const leaseBindings = [
        workflowRunId,
        leasedRevision,
        STORY_SOURCE_WRITE_STATUS.resumeGeneration,
        leasedRevision,
      ];
      const statements = [
        coveragePrivacyAuthorityGuardStatement(db, privacyAuthority.authority),
        db.prepare(`UPDATE items SET organization_reason='semantic-unit:' || (
          SELECT unit_id FROM semantic_unit_members WHERE item_id=items.id
        ) WHERE organization_reason LIKE ? AND EXISTS (
          SELECT 1 FROM semantic_unit_members m
          WHERE m.item_id=items.id AND m.workflow_run_id=?
        ) AND ${leaseSql}`).bind("oxygen.story%", workflowRunId, ...leaseBindings),
        db.prepare(`DELETE FROM story_coverage_rows WHERE workflow_run_id=? AND ${leaseSql}`)
          .bind(workflowRunId, ...leaseBindings),
        db.prepare(`DELETE FROM story_coverage_manifests WHERE workflow_run_id=? AND ${leaseSql}`)
          .bind(workflowRunId, ...leaseBindings),
        db.prepare(`INSERT INTO story_coverage_manifests
          (workflow_run_id,revision,semantic_manifest_revision,semantic_manifest_digest,
           coverage_digest,privacy_authority_digest,unit_count,serialized_bytes,created_at,updated_at)
          SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${leaseSql}`).bind(
          workflowRunId,
          coverageManifest.revision,
          coverageManifest.semanticManifestRevision,
          coverageManifest.semanticManifestDigest,
          coverageManifest.coverageDigest,
          privacyAuthority.authority.snapshotDigest,
          coverageManifest.rows.length,
          coverageManifest.serializedBytes,
          now,
          now,
          ...leaseBindings,
        ),
      ];
      const candidateRows = normalized.rows.map((row) => ({ id: row.id, summary: row.summary }));
      const candidatePayload = JSON.stringify(candidateRows);
      statements.push(db.prepare(`WITH candidate_rows AS (
          SELECT json_extract(value,'$.id') AS id,
            json_extract(value,'$.summary') AS summary FROM json_each(?)
        ) UPDATE items SET organization_reason=(
          SELECT summary FROM candidate_rows WHERE candidate_rows.id=items.id
        ) WHERE id IN (SELECT id FROM candidate_rows) AND ${leaseSql}`)
          .bind(candidatePayload, ...leaseBindings));
      const documentSummaries: Array<{ id: string; formattedSummary: string }> = [];
      for (const document of documentRows) {
        let summary: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(String(document.formatted_summary_json || "{}"));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("Stored document summary is not an object");
          }
          summary = parsed;
        } catch {
          throw new Error("Stored document summary is invalid");
        }
        const formattedSummary = JSON.stringify({
          ...summary,
          highlights: normalized.storyItemsByDocument.get(document.id) || [],
        });
        documentSummaries.push({ id: document.id, formattedSummary });
      }
      const documentSummaryPayload = JSON.stringify(documentSummaries);
      statements.push(db.prepare(`WITH document_summaries AS (
          SELECT json_extract(value,'$.id') AS id,
            json_extract(value,'$.formattedSummary') AS formatted_summary
          FROM json_each(?)
        ) UPDATE documents SET
          formatted_summary_json=(SELECT formatted_summary FROM document_summaries
            WHERE document_summaries.id=documents.id),
          updated_at=?
          WHERE id IN (SELECT id FROM document_summaries) AND ${leaseSql}`)
          .bind(documentSummaryPayload, now, ...leaseBindings));
      const coveragePayload = JSON.stringify(coverageManifest.rows);
      statements.push(db.prepare(`INSERT INTO story_coverage_rows
          (unit_id,workflow_run_id,disposition,owner_id,exclusion_reason)
          SELECT json_extract(value,'$.unitId'),?,json_extract(value,'$.disposition'),
            json_extract(value,'$.ownerId'),json_extract(value,'$.exclusionReason')
          FROM json_each(?) WHERE ${leaseSql}`)
          .bind(workflowRunId, coveragePayload, ...leaseBindings));
      statements.push(
        db.prepare(`DELETE FROM story_preparation_receipts
          WHERE workflow_run_id=? AND ${leaseSql}`).bind(workflowRunId, ...leaseBindings),
        db.prepare(`DELETE FROM story_privacy_candidates
          WHERE workflow_run_id=? AND ${leaseSql}`).bind(workflowRunId, ...leaseBindings),
        db.prepare(`DELETE FROM story_privacy_targets
          WHERE workflow_run_id=? AND ${leaseSql}`).bind(workflowRunId, ...leaseBindings),
      );
      const receiptPayload = JSON.stringify(preparation.receipts);
      statements.push(db.prepare(`INSERT INTO story_preparation_receipts
          (workflow_run_id,lane,source_revision,input_digest,scope_digest,scope_count,
           output_digest,output_count,completed_at)
          SELECT ?,json_extract(value,'$.lane'),?,json_extract(value,'$.inputDigest'),
            json_extract(value,'$.scopeDigest'),json_extract(value,'$.scopeCount'),
            json_extract(value,'$.outputDigest'),json_extract(value,'$.outputCount'),?
          FROM json_each(?) WHERE ${leaseSql}`).bind(
        workflowRunId,
        leasedRevision + 1,
        now,
        receiptPayload,
        ...leaseBindings,
      ));
      const privacyCandidates = preparation.privacy.candidates.map((candidate) => ({
        candidateId: candidate.id,
        candidateJson: JSON.stringify(candidate),
      }));
      statements.push(db.prepare(`INSERT INTO story_privacy_candidates
          (workflow_run_id,candidate_id,candidate_json)
          SELECT ?,json_extract(value,'$.candidateId'),json_extract(value,'$.candidateJson')
          FROM json_each(?) WHERE ${leaseSql}`).bind(
        workflowRunId,
        JSON.stringify(privacyCandidates),
        ...leaseBindings,
      ));
      const pendingTargets = new Set(preparation.privacy.candidates
        .filter((candidate) => candidate.reviewState === "needs_confirmation")
        .flatMap((candidate) => candidate.releaseTargets));
      const privacyRows = preparation.privacy.targetProposals.map((proposal) => ({
        targetId: proposal.targetId,
        targetContentDigest: proposal.targetContentDigest,
        proposedText: proposal.proposedText,
        occurrencesJson: JSON.stringify(proposal.occurrences),
        selectedText: pendingTargets.has(proposal.targetId) ? null : proposal.proposedText,
        decidedAt: pendingTargets.has(proposal.targetId) ? null : now,
      }));
      const privacyPayload = JSON.stringify(privacyRows);
      statements.push(db.prepare(`INSERT INTO story_privacy_targets
          (workflow_run_id,target_id,target_content_digest,proposed_text,occurrences_json,
           selected_text,public_overrides_json,decided_at)
          SELECT ?,json_extract(value,'$.targetId'),json_extract(value,'$.targetContentDigest'),
            json_extract(value,'$.proposedText'),json_extract(value,'$.occurrencesJson'),
            json_extract(value,'$.selectedText'),'[]',json_extract(value,'$.decidedAt')
          FROM json_each(?) WHERE ${leaseSql}`).bind(
        workflowRunId,
        privacyPayload,
        ...leaseBindings,
      ));
      statements.push(db.prepare(`UPDATE probe_runs SET source_revision=?,updated_at=?
          WHERE workflow_run_id=? AND source_revision=? AND input_digest=?
            AND output_digest=? AND output_count=? AND ${leaseSql}`).bind(
        leasedRevision + 1,
        now,
        workflowRunId,
        leasedRevision,
        preferenceAuthority.inputDigest,
        preferenceAuthority.outputDigest,
        preferenceAuthority.outputCount,
        ...leaseBindings,
      ));
      statements.push(
        db.prepare(`UPDATE preference_lifecycle_authorities
          SET source_revision=?,active_story_digest=?,story_session_version=0,updated_at=?
          WHERE workflow_run_id=? AND source_revision=? AND active_story_digest IS NULL
            AND state_digest=? AND ${leaseSql}`).bind(
          leasedRevision + 1, digest, now, workflowRunId, leasedRevision,
          preferenceAuthority.lifecycleDigest,
          ...leaseBindings,
        ),
        db.prepare(`SELECT json_extract(CASE WHEN EXISTS (
          SELECT 1 FROM preference_lifecycle_authorities
          WHERE workflow_run_id=? AND source_revision=? AND active_story_digest=? AND state_digest=?
        ) THEN '{}' ELSE '' END,'$.preference_lifecycle') AS preference_lifecycle_assertion`).bind(
          workflowRunId, leasedRevision + 1, digest, preferenceAuthority.lifecycleDigest,
        ),
      );
      if (!await publishActivatedStorySourceMutation(
        db,
        statements,
        workflowRunId,
        leasedRevision,
        validation.chapterCount,
        digest,
        coverageManifest.revision,
        coverageManifest.coverageDigest,
        privacyRows.length,
        preferenceAuthority.outputDigest,
        preferenceAuthority.outputCount,
        now,
      )) {
        await abortStorySourceMutation(db, workflowRunId, now, leasedRevision);
        return Response.json({
          error: "Story activation authority changed before commit",
          code: "STORY_ACTIVATION_AUTHORITY_CHANGED",
        }, { status: 409 });
      }
      return Response.json(deriveWorkflowProgress({
        workflowRunId,
        targetConfirmed: Boolean(run.target_confirmed),
        collectionStatus: run.collection_status,
        collectionCompleted: Number(run.collection_completed || 0),
        collectionTotal: Number(run.collection_total || 0),
        documentCount: documentRows.length,
        itemCount: itemRows.length,
        organizedItemCount: itemRows.length,
        organizationStatus: "complete",
        redactionStatus: "complete",
        storyGenerationStatus: "ready_for_human_review",
        storyGenerationCompleted: validation.chapterCount,
        storyGenerationTotal: validation.chapterCount,
        storySourceSchema: "oxygen.story",
        storySessionSchema: "oxygen.story-review-session",
        updatedAt: now,
      }));
    } catch {
      await abortStorySourceMutation(db, workflowRunId, now, leasedRevision);
      return Response.json({
        error: "Story activation authority changed before commit",
        code: "STORY_ACTIVATION_AUTHORITY_CHANGED",
      }, { status: 409 });
    }
  }

  const existing = await db.prepare(
    "SELECT collection_status FROM workflow_runs WHERE id=?",
  ).bind(workflowRunId).first<{ collection_status: string }>();
  const nextStatus = event === "collection_failed"
    ? "failed"
    : event === "collection_completed"
      ? "complete"
      : event === "target_confirmed"
        ? "pending"
        : "running";
  if (existing && ["complete", "failed"].includes(existing.collection_status)
    && existing.collection_status !== nextStatus) {
    return Response.json({ error: "Workflow collection state is terminal" }, { status: 409 });
  }

  const blockerCode = nextStatus === "failed" ? "COLLECTION_FAILED" : null;
  await db.prepare(`UPDATE workflow_runs SET
      collection_status=?,collection_completed=?,collection_total=?,blocker_code=?,updated_at=?
      WHERE id=?`)
    .bind(nextStatus, completed, total, blockerCode, now, workflowRunId)
    .run();

  return Response.json(await loadWorkflowProgress(workflowRunId));
}
