import { getLocalDatabase } from "../../../db";
import {
  readStoredSemanticManifestAuthority,
  contributionRecordSourceDigest,
  MAX_SEMANTIC_EVIDENCE_ITEM_BYTES,
  validateSemanticRevisionTransition,
  validateSemanticManifestAuthority,
  type SemanticManifestAuthority,
} from "../../../lib/story-readiness";
import {
  WORKFLOW_RUN_AUTHORITY,
  requireEstablishedWorkflowRun,
  workflowRunErrorResponse,
} from "../../../lib/workflow-run-server";
import {
  STORY_SOURCE_WRITE_STATUS,
  abortStorySourceMutation,
  beginStorySourceMutation,
  isStorySourceWriteInProgress,
  publishCompletedSemanticSourceMutation,
} from "../../../lib/story-source-publication";
import { validActivatedSourceRevision } from "../../../lib/authority-validation.mjs";

const JOB_ID = "default";
const MAX_SEMANTIC_EVIDENCE_PAGE_MEMBERS = 50;
const MAX_SEMANTIC_EVIDENCE_RESPONSE_BYTES = 500_000;

type FinalizedCorpusAuthority = {
  corpusRevision: number;
  corpusDigest: string;
  documentCount: number;
  itemCount: number;
  currentDocumentCount: number;
  currentItemCount: number;
  storyGenerationStatus: string;
  storySourceRevision: number;
};

async function readFinalizedCorpusAuthority(
  db: Awaited<ReturnType<typeof getLocalDatabase>>,
  workflowRunId: string,
): Promise<FinalizedCorpusAuthority | null> {
  const row = await db.prepare(`SELECT r.story_generation_status,r.story_source_revision,
      m.corpus_revision,m.corpus_digest,m.document_count,m.item_count,
      (SELECT COUNT(*) FROM documents) AS current_document_count,
      (SELECT COUNT(*) FROM items) AS current_item_count
    FROM workflow_runs r LEFT JOIN finalized_corpus_manifests m ON m.workflow_run_id=r.id
    WHERE r.id=?`).bind(workflowRunId).first<Record<string, unknown>>();
  if (!row || !Number.isSafeInteger(Number(row.corpus_revision))
    || Number(row.corpus_revision) < 1
    || !validActivatedSourceRevision(Number(row.story_source_revision))
    || !/^[0-9a-f]{64}$/.test(String(row.corpus_digest || ""))) return null;
  return {
    corpusRevision: Number(row.corpus_revision),
    corpusDigest: String(row.corpus_digest),
    documentCount: Number(row.document_count),
    itemCount: Number(row.item_count),
    currentDocumentCount: Number(row.current_document_count),
    currentItemCount: Number(row.current_item_count),
    storyGenerationStatus: String(row.story_generation_status || ""),
    storySourceRevision: Number(row.story_source_revision),
  };
}

function finalizedCorpusCountsMatch(authority: FinalizedCorpusAuthority) {
  return authority.documentCount === authority.currentDocumentCount
    && authority.itemCount === authority.currentItemCount;
}

type ContributionItemRow = {
  id: string;
  document_id: string;
  sequence: number;
  event_type: string | null;
  actor_id: string | null;
  actor_type: string | null;
  timestamp: string | null;
  content: string;
  original_json: string;
};

async function readContributionRecords(itemRows: ContributionItemRow[]) {
  if (itemRows.some((row) => new TextEncoder().encode(JSON.stringify({
    id: row.id,
    documentId: row.document_id,
    eventType: row.event_type,
    actorId: row.actor_id,
    actorType: row.actor_type,
    timestamp: row.timestamp,
    content: row.content,
  })).byteLength > MAX_SEMANTIC_EVIDENCE_ITEM_BYTES)) {
    return { ok: false as const, code: "SEMANTIC_EVIDENCE_ITEM_TOO_LARGE" };
  }
  try {
    return {
      ok: true as const,
      records: await Promise.all(itemRows.map(async (row) => {
        const original = JSON.parse(row.original_json) as Record<string, unknown>;
        const originalEventId = original?.event_id;
        const originalTrajectoryId = original?.trajectory_id;
        const identityMatches = (
          typeof originalEventId === "string"
          && originalEventId === row.id
          && typeof originalTrajectoryId === "string"
          && originalTrajectoryId === row.document_id
        ) || (
          originalEventId === undefined
          && (originalTrajectoryId === undefined || originalTrajectoryId === row.document_id)
          && row.id.startsWith(`${row.document_id}:`)
        );
        if (!identityMatches) throw new Error("Contribution source identity mismatch");
        return {
          id: row.id,
          sourceDigest: await contributionRecordSourceDigest(original, {
            id: row.id,
            documentId: row.document_id,
            sequence: Number(row.sequence),
            eventType: row.event_type,
            actorId: row.actor_id,
            actorType: row.actor_type,
            timestamp: row.timestamp,
            content: row.content,
          }),
        };
      })),
    };
  } catch {
    return { ok: false as const, code: "CONTRIBUTION_SOURCE_INVALID" };
  }
}

function contributionFailureResponse(code: string) {
  return code === "SEMANTIC_EVIDENCE_ITEM_TOO_LARGE"
    ? Response.json({
      error: "Contribution Evidence exceeds the bounded semantic input",
      code,
    }, { status: 409 })
    : Response.json({
      error: "Contribution source identity validation failed",
      code,
    }, { status: 409 });
}

async function status(db: Awaited<ReturnType<typeof getLocalDatabase>>, workflowRunId: string) {
  const [job, counts, documents, manifest] = await Promise.all([
    db.prepare("SELECT * FROM organization_jobs WHERE id=?").bind(JOB_ID)
      .first<Record<string, unknown>>(),
    db.prepare(`SELECT
        (SELECT COUNT(*) FROM items) AS total,
        (SELECT COUNT(*) FROM semantic_unit_members WHERE workflow_run_id=?) AS completed`)
      .bind(workflowRunId).first<{ total: number; completed: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM documents").first<{ count: number }>(),
    db.prepare(`SELECT m.revision,m.source_revision,m.registry_digest,m.manifest_digest,m.unit_count,
        m.corpus_revision,m.corpus_digest,m.corpus_document_count,m.corpus_item_count,
        r.story_source_revision,f.corpus_revision AS finalized_corpus_revision,
        f.corpus_digest AS finalized_corpus_digest,
        f.document_count AS finalized_document_count,f.item_count AS finalized_item_count,
        (SELECT COUNT(*) FROM documents) AS current_document_count,
        (SELECT COUNT(*) FROM items) AS current_item_count
      FROM semantic_manifests m JOIN workflow_runs r ON r.id=m.workflow_run_id
      JOIN finalized_corpus_manifests f ON f.workflow_run_id=m.workflow_run_id
      WHERE m.workflow_run_id=?`).bind(workflowRunId)
      .first<Record<string, unknown>>(),
  ]);
  const total = Number(counts?.total || 0);
  const completed = Number(counts?.completed || 0);
  const recordedStatus = String(job?.status || (total ? "idle" : "empty"));
  const currentManifest = manifest
    && validActivatedSourceRevision(Number(manifest.source_revision))
    && validActivatedSourceRevision(Number(manifest.story_source_revision))
    && Number(manifest.source_revision) === Number(manifest.story_source_revision)
    && Number(manifest.corpus_revision) === Number(manifest.finalized_corpus_revision)
    && String(manifest.corpus_digest) === String(manifest.finalized_corpus_digest)
    && Number(manifest.corpus_document_count) === Number(manifest.finalized_document_count)
    && Number(manifest.corpus_item_count) === Number(manifest.finalized_item_count)
    && Number(manifest.current_document_count) === Number(manifest.finalized_document_count)
    && Number(manifest.current_item_count) === Number(manifest.finalized_item_count)
    && typeof manifest.registry_digest === "string"
    && /^[0-9a-f]{64}$/.test(manifest.registry_digest);
  const complete = Boolean(currentManifest && completed === total);
  return {
    status: complete ? "complete" : recordedStatus === "complete" ? "idle" : recordedStatus,
    stage: complete ? "complete" : "semantic_grouping",
    completed,
    total,
    percent: total ? Math.round(completed / total * 100) : 0,
    documentCount: Number(documents?.count || 0),
    semanticManifest: currentManifest ? {
      revision: Number(manifest.revision),
      sourceRevision: Number(manifest.source_revision),
      registryDigest: String(manifest.registry_digest),
      digest: String(manifest.manifest_digest),
      unitCount: Number(manifest.unit_count),
      finalizedCorpus: {
        revision: Number(manifest.corpus_revision),
        digest: String(manifest.corpus_digest),
        documentCount: Number(manifest.corpus_document_count),
        itemCount: Number(manifest.corpus_item_count),
      },
    } : null,
    warnings: JSON.parse(String(job?.warnings_json || "[]")),
  };
}

async function exactCurrentSemanticResponse(
  db: Awaited<ReturnType<typeof getLocalDatabase>>,
  workflowRunId: string,
  submittedManifest: unknown,
) {
  return db.transaction(async () => {
    const [finalizedCorpus, { results: itemRows }, binding] = await Promise.all([
      readFinalizedCorpusAuthority(db, workflowRunId),
      db.prepare(`SELECT id,document_id,sequence,event_type,actor_id,actor_type,
          timestamp,content,original_json FROM items ORDER BY id`)
        .all<ContributionItemRow>(),
      db.prepare(`SELECT m.project_id,m.revision,m.source_revision,m.source_digest,
          m.universe_digest,m.registry_digest,m.manifest_digest,m.unit_count,m.serialized_bytes,
          m.story_projection_bytes,
          m.corpus_revision,m.corpus_digest,m.corpus_document_count,m.corpus_item_count,
          (SELECT COUNT(*) FROM semantic_units) AS current_unit_count,
          (SELECT COUNT(*) FROM semantic_unit_members) AS current_member_count
        FROM semantic_manifests m WHERE m.workflow_run_id=?`).bind(workflowRunId)
        .first<Record<string, unknown>>(),
    ]);
    if (!finalizedCorpus) {
      return Response.json({
        error: "A finalized source corpus is required before Organization",
        code: "FINALIZED_CORPUS_REQUIRED",
      }, { status: 409 });
    }
    if (!finalizedCorpusCountsMatch(finalizedCorpus)) {
      return Response.json({
        error: "Finalized source corpus counts do not match current source rows",
        code: "FINALIZED_CORPUS_COUNT_MISMATCH",
      }, { status: 409 });
    }
    if (isStorySourceWriteInProgress(finalizedCorpus.storyGenerationStatus)) {
      return Response.json({
        error: "Finalized source corpus replacement is still running",
        code: "FINALIZED_CORPUS_NOT_CURRENT",
      }, { status: 409 });
    }
    if (itemRows.length !== finalizedCorpus.itemCount) {
      return Response.json({
        error: "Finalized source corpus authority changed before Organization",
        code: "FINALIZED_CORPUS_NOT_CURRENT",
      }, { status: 409 });
    }
    const contributions = await readContributionRecords(itemRows);
    if (!contributions.ok) return null;
    const validation = await validateSemanticManifestAuthority(
      submittedManifest,
      contributions.records,
    );
    if (!validation.ok) return null;
    let storedManifest: SemanticManifestAuthority | null = null;
    try {
      storedManifest = await readStoredSemanticManifestAuthority(db, workflowRunId);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    const manifest = validation.authority;
    if (!binding || !storedManifest
      || Number(binding.revision) !== manifest.revision
      || storedManifest.revision !== manifest.revision
      || binding.registry_digest !== manifest.registryDigest
      || storedManifest.registryDigest !== manifest.registryDigest
      || binding.manifest_digest !== manifest.manifestDigest
      || storedManifest.manifestDigest !== manifest.manifestDigest
      || Number(binding.source_revision) !== finalizedCorpus.storySourceRevision
      || Number(binding.corpus_revision) !== finalizedCorpus.corpusRevision
      || binding.corpus_digest !== finalizedCorpus.corpusDigest
      || Number(binding.corpus_document_count) !== finalizedCorpus.documentCount
      || Number(binding.corpus_item_count) !== finalizedCorpus.itemCount
      || Number(binding.unit_count) !== manifest.units.length
      || Number(binding.current_unit_count) !== manifest.units.length
      || Number(binding.current_member_count) !== itemRows.length
      || Number(binding.serialized_bytes) !== manifest.serializedBytes
      || storedManifest.serializedBytes !== manifest.serializedBytes
      || Number(binding.story_projection_bytes) !== validation.storyProjectionBytes
    ) {
      return null;
    }
    return Response.json(await status(db, workflowRunId));
  });
}

async function readSemanticProjection(
  db: Awaited<ReturnType<typeof getLocalDatabase>>,
  workflowRunId: string,
) {
  const manifest = await db.prepare(`SELECT m.project_id,m.revision,m.source_revision,m.source_digest,
      m.universe_digest,m.registry_digest,m.manifest_digest,m.unit_count,m.serialized_bytes,m.story_projection_bytes,
      m.corpus_revision,m.corpus_digest,m.corpus_document_count,m.corpus_item_count,
      r.story_source_revision,f.corpus_revision AS finalized_corpus_revision,
      f.corpus_digest AS finalized_corpus_digest,
      f.document_count AS finalized_document_count,f.item_count AS finalized_item_count,
      (SELECT COUNT(*) FROM documents) AS current_document_count,
      (SELECT COUNT(*) FROM items) AS current_item_count
      FROM semantic_manifests m JOIN workflow_runs r ON r.id=m.workflow_run_id
      JOIN finalized_corpus_manifests f ON f.workflow_run_id=m.workflow_run_id
      WHERE m.workflow_run_id=?`).bind(workflowRunId)
    .first<Record<string, unknown>>();
  if (!manifest || !validActivatedSourceRevision(Number(manifest.source_revision))
    || !validActivatedSourceRevision(Number(manifest.story_source_revision))
    || Number(manifest.source_revision) !== Number(manifest.story_source_revision)
    || Number(manifest.corpus_revision) !== Number(manifest.finalized_corpus_revision)
    || String(manifest.corpus_digest) !== String(manifest.finalized_corpus_digest)
    || Number(manifest.corpus_document_count) !== Number(manifest.finalized_document_count)
    || Number(manifest.corpus_item_count) !== Number(manifest.finalized_item_count)
    || Number(manifest.current_document_count) !== Number(manifest.finalized_document_count)
    || Number(manifest.current_item_count) !== Number(manifest.finalized_item_count)
    || typeof manifest.registry_digest !== "string"
    || !/^[0-9a-f]{64}$/.test(manifest.registry_digest)) return null;
  const { results } = await db.prepare(`SELECT id,revision,kind,member_count,membership_digest,
      duplicate_of_unit_id,story_projection_json
      FROM semantic_units WHERE workflow_run_id=? ORDER BY id`).bind(workflowRunId)
    .all<Record<string, unknown>>();
  return {
    projectId: manifest.project_id,
    revision: Number(manifest.revision),
    sourceRevision: Number(manifest.source_revision),
    sourceDigest: manifest.source_digest,
    universeDigest: manifest.universe_digest,
    registryDigest: manifest.registry_digest,
    manifestDigest: manifest.manifest_digest,
    unitCount: Number(manifest.unit_count),
    serializedBytes: Number(manifest.serialized_bytes),
    storyProjectionBytes: Number(manifest.story_projection_bytes),
    finalizedCorpus: {
      revision: Number(manifest.corpus_revision),
      digest: manifest.corpus_digest,
      documentCount: Number(manifest.corpus_document_count),
      itemCount: Number(manifest.corpus_item_count),
    },
    units: results.map((row) => ({
      id: row.id,
      revision: Number(row.revision),
      kind: row.kind,
      memberCount: Number(row.member_count),
      membershipDigest: row.membership_digest,
      ...(row.duplicate_of_unit_id ? { duplicateOfUnitId: row.duplicate_of_unit_id } : {}),
      ...(() => {
        const projection = JSON.parse(String(row.story_projection_json || "{}"));
        return Object.keys(projection).length ? { storyProjection: projection } : {};
      })(),
    })),
  };
}

export async function GET(request: Request) {
  const db = await getLocalDatabase();
  const authority = await requireEstablishedWorkflowRun(db);
  if (authority.state !== WORKFLOW_RUN_AUTHORITY.exactRun) {
    return workflowRunErrorResponse(authority);
  }
  const unitId = new URL(request.url).searchParams.get("unitId");
  if (unitId !== null) {
    const search = new URL(request.url).searchParams;
    const requestedRevision = Number(search.get("revision"));
    const requestedDigest = search.get("membershipDigest");
    const cursor = Number(search.get("cursor") || "0");
    const requestedLimit = Number(search.get("limit") || "25");
    if (!unitId.trim() || unitId.length > 300) {
      return Response.json({ error: "Invalid semantic unit" }, { status: 400 });
    }
    if (!Number.isSafeInteger(requestedRevision) || requestedRevision < 1
      || !requestedDigest || !/^[0-9a-f]{64}$/.test(requestedDigest)
      || !Number.isSafeInteger(cursor) || cursor < 0
      || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1
      || requestedLimit > MAX_SEMANTIC_EVIDENCE_PAGE_MEMBERS) {
      return Response.json({ error: "Invalid semantic Evidence page" }, { status: 400 });
    }
    const current = await db.prepare(`SELECT 1 AS current FROM semantic_manifests m
        JOIN workflow_runs r ON r.id=m.workflow_run_id
        JOIN finalized_corpus_manifests f ON f.workflow_run_id=m.workflow_run_id
        WHERE m.workflow_run_id=? AND m.source_revision=r.story_source_revision
          AND m.source_revision>0 AND r.story_source_revision>0
          AND m.corpus_revision=f.corpus_revision AND m.corpus_digest=f.corpus_digest
          AND m.corpus_document_count=f.document_count AND m.corpus_item_count=f.item_count
          AND f.document_count=(SELECT COUNT(*) FROM documents)
          AND f.item_count=(SELECT COUNT(*) FROM items)`)
      .bind(authority.workflowRunId).first<{ current: number }>();
    if (!current) return Response.json({ error: "Semantic manifest is stale" }, { status: 409 });
    const unit = await db.prepare(`SELECT id,revision,project_id,kind,member_count,
        membership_digest,duplicate_of_unit_id,story_projection_json
        FROM semantic_units WHERE workflow_run_id=? AND id=?`)
      .bind(authority.workflowRunId, unitId).first<Record<string, unknown>>();
    if (!unit) return Response.json({ error: "Semantic unit not found" }, { status: 404 });
    if (Number(unit.revision) !== requestedRevision
      || String(unit.membership_digest) !== requestedDigest) {
      return Response.json({ error: "Semantic unit authority is stale" }, { status: 409 });
    }
    const memberCount = Number(unit.member_count);
    if (cursor > memberCount) {
      return Response.json({ error: "Semantic Evidence cursor is outside the unit" }, { status: 400 });
    }
    const { results } = await db.prepare(`SELECT i.id,i.document_id AS documentId,
        i.event_type AS eventType,i.actor_id AS actorId,i.actor_type AS actorType,
        i.timestamp,i.content
        FROM semantic_unit_members m JOIN items i ON i.id=m.item_id
        WHERE m.workflow_run_id=? AND m.unit_id=?
        ORDER BY i.document_id,i.sequence,i.id LIMIT ? OFFSET ?`)
      .bind(authority.workflowRunId, unitId, requestedLimit, cursor).all();
    const expectedRows = Math.min(requestedLimit, memberCount - cursor);
    if (results.length !== expectedRows) {
      return Response.json({ error: "Semantic Evidence membership is stale" }, { status: 409 });
    }
    const unitProjection = {
      id: unit.id,
      revision: Number(unit.revision),
      projectId: unit.project_id,
      kind: unit.kind,
      memberCount,
      membershipDigest: unit.membership_digest,
      ...(unit.duplicate_of_unit_id ? { duplicateOfUnitId: unit.duplicate_of_unit_id } : {}),
    };
    const evidence: unknown[] = [];
    for (const row of results) {
      const candidate = {
        unit: unitProjection,
        evidence: [...evidence, row],
        nextCursor: null,
      };
      if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength
        > MAX_SEMANTIC_EVIDENCE_RESPONSE_BYTES) break;
      evidence.push(row);
    }
    if (results.length && !evidence.length) {
      return Response.json({ error: "Semantic Evidence row exceeds response bound" }, { status: 413 });
    }
    const nextOffset = cursor + evidence.length;
    return Response.json({
      unit: unitProjection,
      evidence,
      nextCursor: nextOffset < memberCount ? String(nextOffset) : null,
    });
  }
  return Response.json({
    ...(await status(db, authority.workflowRunId)),
    semanticProjection: await readSemanticProjection(db, authority.workflowRunId),
  });
}

export async function POST(request: Request) {
  const db = await getLocalDatabase();
  const authority = await requireEstablishedWorkflowRun(db);
  if (authority.state !== WORKFLOW_RUN_AUTHORITY.exactRun) {
    return workflowRunErrorResponse(authority);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid semantic manifest" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some((key) => !["semanticManifest"].includes(key))) {
    return Response.json({ error: "Invalid semantic manifest" }, { status: 400 });
  }
  const exactCurrent = await exactCurrentSemanticResponse(
    db,
    authority.workflowRunId,
    (body as { semanticManifest?: unknown }).semanticManifest,
  );
  if (exactCurrent) return exactCurrent;
  const finalizedCorpus = await readFinalizedCorpusAuthority(db, authority.workflowRunId);
  if (!finalizedCorpus) {
    return Response.json({
      error: "A finalized source corpus is required before Organization",
      code: "FINALIZED_CORPUS_REQUIRED",
    }, { status: 409 });
  }
  if (!finalizedCorpusCountsMatch(finalizedCorpus)) {
    return Response.json({
      error: "Finalized source corpus counts do not match current source rows",
      code: "FINALIZED_CORPUS_COUNT_MISMATCH",
    }, { status: 409 });
  }
  if (isStorySourceWriteInProgress(finalizedCorpus.storyGenerationStatus)) {
    return Response.json({
      error: "Finalized source corpus replacement is still running",
      code: "FINALIZED_CORPUS_NOT_CURRENT",
    }, { status: 409 });
  }
  const now = new Date().toISOString();
  if (!await beginStorySourceMutation(db, authority.workflowRunId, now)) {
    return Response.json({ error: "Another Story source mutation is already running" }, { status: 409 });
  }
  let leasedRevision: number | undefined;
  try {
    const [{ results: itemRows }, run, storedPreviousManifest, leasedCorpus] = await Promise.all([
      db.prepare(`SELECT id,document_id,sequence,event_type,actor_id,actor_type,
          timestamp,content,original_json FROM items ORDER BY id`)
        .all<ContributionItemRow>(),
      db.prepare(`SELECT story_source_revision FROM workflow_runs WHERE id=?`)
        .bind(authority.workflowRunId).first<{ story_source_revision: number }>(),
      readStoredSemanticManifestAuthority(db, authority.workflowRunId),
      readFinalizedCorpusAuthority(db, authority.workflowRunId),
    ]);
    if (!run) throw new Error("Workflow run not found");
    leasedRevision = Number(run.story_source_revision);
    if (!leasedCorpus || !finalizedCorpusCountsMatch(leasedCorpus)
      || leasedCorpus.corpusRevision !== finalizedCorpus.corpusRevision
      || leasedCorpus.corpusDigest !== finalizedCorpus.corpusDigest
      || leasedCorpus.documentCount !== finalizedCorpus.documentCount
      || leasedCorpus.itemCount !== finalizedCorpus.itemCount
      || itemRows.length !== leasedCorpus.itemCount) {
      await abortStorySourceMutation(db, authority.workflowRunId, now, leasedRevision);
      return Response.json({
        error: "Finalized source corpus authority changed before Organization",
        code: "FINALIZED_CORPUS_NOT_CURRENT",
      }, { status: 409 });
    }
    // The stored snapshot is revision lineage only. Current authority remains
    // the leased finalized corpus and the complete next-manifest validation.
    const previousManifest = storedPreviousManifest;
    const contributions = await readContributionRecords(itemRows);
    if (!contributions.ok) {
      await abortStorySourceMutation(db, authority.workflowRunId, now, leasedRevision);
      return contributionFailureResponse(contributions.code);
    }
    const contributionRecords = contributions.records;
    const validation = await validateSemanticManifestAuthority(
      (body as { semanticManifest?: unknown }).semanticManifest,
      contributionRecords,
    );
    if (!validation.ok) {
      await abortStorySourceMutation(db, authority.workflowRunId, now, leasedRevision);
      return Response.json({ error: "Semantic manifest validation failed", code: validation.code }, { status: 409 });
    }
    const manifest: SemanticManifestAuthority = validation.authority;
    const revisionFailure = validateSemanticRevisionTransition(manifest, previousManifest);
    if (revisionFailure) {
      await abortStorySourceMutation(db, authority.workflowRunId, now, leasedRevision);
      return Response.json({
        error: "Semantic manifest revision transition failed",
        code: revisionFailure,
      }, { status: 409 });
    }
    const sourceDigests = new Map(contributionRecords.map((record) => [record.id, record.sourceDigest]));
    const leaseSql = `EXISTS (SELECT 1 FROM workflow_runs
      WHERE id=? AND story_source_revision=? AND story_generation_status IN (?,?))`;
    const leaseBindings = [
      authority.workflowRunId,
      leasedRevision,
      STORY_SOURCE_WRITE_STATUS.idle,
      STORY_SOURCE_WRITE_STATUS.resumeGeneration,
    ];
    const statements: ReturnType<typeof db.prepare>[] = [
      db.prepare(`DELETE FROM semantic_unit_members WHERE workflow_run_id=? AND ${leaseSql}`)
        .bind(authority.workflowRunId, ...leaseBindings),
      db.prepare(`DELETE FROM semantic_units WHERE workflow_run_id=? AND ${leaseSql}`)
        .bind(authority.workflowRunId, ...leaseBindings),
      db.prepare(`DELETE FROM semantic_manifests WHERE workflow_run_id=? AND ${leaseSql}`)
        .bind(authority.workflowRunId, ...leaseBindings),
      db.prepare(`INSERT INTO semantic_manifests
        (workflow_run_id,project_id,revision,source_revision,source_digest,universe_digest,
         registry_digest,manifest_digest,unit_count,serialized_bytes,story_projection_bytes,
         corpus_revision,corpus_digest,corpus_document_count,corpus_item_count,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${leaseSql}`).bind(
        authority.workflowRunId,
        manifest.projectId,
        manifest.revision,
        leasedRevision + 1,
        manifest.sourceDigest,
        manifest.universeDigest,
        manifest.registryDigest,
        manifest.manifestDigest,
        manifest.units.length,
        manifest.serializedBytes,
        validation.storyProjectionBytes,
        leasedCorpus.corpusRevision,
        leasedCorpus.corpusDigest,
        leasedCorpus.documentCount,
        leasedCorpus.itemCount,
        now,
        now,
        ...leaseBindings,
      ),
    ];
    const persistedUnits = manifest.units.map((unit) => ({
      id: unit.id,
      revision: unit.revision,
      projectId: unit.projectId,
      kind: unit.kind,
      memberCount: unit.memberCount,
      membershipDigest: unit.membershipDigest,
      duplicateOfUnitId: unit.duplicateOfUnitId || null,
      storyProjectionJson: JSON.stringify(unit.storyProjection || {}),
    }));
    const unitPayload = JSON.stringify(persistedUnits);
    statements.push(db.prepare(`INSERT INTO semantic_units
        (id,workflow_run_id,revision,project_id,kind,member_count,membership_digest,
          duplicate_of_unit_id,story_projection_json)
        SELECT json_extract(value,'$.id'),?,json_extract(value,'$.revision'),
          json_extract(value,'$.projectId'),json_extract(value,'$.kind'),
          json_extract(value,'$.memberCount'),json_extract(value,'$.membershipDigest'),
          json_extract(value,'$.duplicateOfUnitId'),json_extract(value,'$.storyProjectionJson')
        FROM json_each(?) WHERE ${leaseSql}`)
        .bind(authority.workflowRunId, unitPayload, ...leaseBindings));
    const members = manifest.units.flatMap((unit) => (
      unit.members.map((itemId) => ({
        itemId,
        unitId: unit.id,
        sourceDigest: sourceDigests.get(itemId)!,
      }))
    ));
    const memberPayload = JSON.stringify(members);
    statements.push(db.prepare(`INSERT INTO semantic_unit_members
        (item_id,workflow_run_id,unit_id,source_digest)
        SELECT json_extract(value,'$.itemId'),?,json_extract(value,'$.unitId'),
          json_extract(value,'$.sourceDigest') FROM json_each(?) WHERE ${leaseSql}`)
        .bind(authority.workflowRunId, memberPayload, ...leaseBindings));
    statements.push(
      db.prepare(`UPDATE items SET
        organization_category=?,organization_confidence=100,
        organization_reason='semantic-unit:' || (
          SELECT unit_id FROM semantic_unit_members WHERE item_id=items.id
        ) WHERE id IN (SELECT item_id FROM semantic_unit_members WHERE workflow_run_id=?)
          AND ${leaseSql}`)
        .bind(manifest.projectId, authority.workflowRunId, ...leaseBindings),
      db.prepare(`UPDATE documents SET organization_status='complete',formatted_summary_json=?
        WHERE ${leaseSql}`)
        .bind(JSON.stringify({
          primary_project: manifest.projectId,
          semantic_manifest_revision: manifest.revision,
          semantic_manifest_digest: manifest.manifestDigest,
          semantic_unit_count: manifest.units.length,
        }), ...leaseBindings),
      db.prepare(`DELETE FROM organization_jobs WHERE id=? AND ${leaseSql}`)
        .bind(JOB_ID, ...leaseBindings),
      db.prepare(`INSERT INTO organization_jobs
        (id,status,stage,completed,total,warnings_json,started_at,updated_at,completed_at)
        SELECT ?,'complete','complete',?,?,'[]',?,?,? WHERE ${leaseSql}`).bind(
        JOB_ID,
        members.length,
        itemRows.length,
        now,
        now,
        now,
        ...leaseBindings,
      ),
    );
    if (!await publishCompletedSemanticSourceMutation(
      db,
      statements,
      authority.workflowRunId,
      leasedRevision,
      manifest.manifestDigest,
      leasedCorpus.corpusRevision,
      leasedCorpus.corpusDigest,
      leasedCorpus.documentCount,
      leasedCorpus.itemCount,
      now,
    )) {
      throw new Error("Story source publication boundary changed during semantic organization");
    }
    return Response.json(await status(db, authority.workflowRunId));
  } catch (error) {
    await abortStorySourceMutation(db, authority.workflowRunId, now, leasedRevision);
    throw error;
  }
}
