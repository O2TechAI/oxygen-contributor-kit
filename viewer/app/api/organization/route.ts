import { getD1 } from "../../../db";
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
  jsonParameterBatches,
  publishCompletedSemanticSourceMutation,
} from "../../../lib/story-source-publication";

const JOB_ID = "default";
const MAX_SEMANTIC_EVIDENCE_PAGE_MEMBERS = 50;
const MAX_SEMANTIC_EVIDENCE_RESPONSE_BYTES = 500_000;

async function status(db: Awaited<ReturnType<typeof getD1>>, workflowRunId: string) {
  const [job, counts, documents, manifest] = await Promise.all([
    db.prepare("SELECT * FROM organization_jobs WHERE id=?").bind(JOB_ID)
      .first<Record<string, unknown>>(),
    db.prepare(`SELECT
        (SELECT COUNT(*) FROM items) AS total,
        (SELECT COUNT(*) FROM semantic_unit_members WHERE workflow_run_id=?) AS completed`)
      .bind(workflowRunId).first<{ total: number; completed: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM documents").first<{ count: number }>(),
    db.prepare(`SELECT m.revision,m.source_revision,m.manifest_digest,m.unit_count,
        r.story_source_revision FROM semantic_manifests m
        JOIN workflow_runs r ON r.id=m.workflow_run_id WHERE m.workflow_run_id=?`).bind(workflowRunId)
      .first<{ revision: number; source_revision: number; story_source_revision: number;
        manifest_digest: string; unit_count: number }>(),
  ]);
  const total = Number(counts?.total || 0);
  const completed = Number(counts?.completed || 0);
  const recordedStatus = String(job?.status || (total ? "idle" : "empty"));
  const currentManifest = manifest
    && Number(manifest.source_revision) === Number(manifest.story_source_revision);
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
      digest: String(manifest.manifest_digest),
      unitCount: Number(manifest.unit_count),
    } : null,
    warnings: JSON.parse(String(job?.warnings_json || "[]")),
  };
}

async function readSemanticProjection(
  db: Awaited<ReturnType<typeof getD1>>,
  workflowRunId: string,
) {
  const manifest = await db.prepare(`SELECT m.project_id,m.revision,m.source_revision,m.source_digest,
      m.universe_digest,m.manifest_digest,m.unit_count,m.serialized_bytes,m.story_projection_bytes,
      r.story_source_revision FROM semantic_manifests m
      JOIN workflow_runs r ON r.id=m.workflow_run_id WHERE m.workflow_run_id=?`).bind(workflowRunId)
    .first<Record<string, unknown>>();
  if (!manifest || Number(manifest.source_revision) !== Number(manifest.story_source_revision)) return null;
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
    manifestDigest: manifest.manifest_digest,
    unitCount: Number(manifest.unit_count),
    serializedBytes: Number(manifest.serialized_bytes),
    storyProjectionBytes: Number(manifest.story_projection_bytes),
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
  const db = await getD1();
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
        WHERE m.workflow_run_id=? AND m.source_revision=r.story_source_revision`)
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
  const db = await getD1();
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
  const now = new Date().toISOString();
  if (!await beginStorySourceMutation(db, authority.workflowRunId, now)) {
    return Response.json({ error: "Another Story source mutation is already running" }, { status: 409 });
  }
  let leasedRevision: number | undefined;
  try {
    const [{ results: itemRows }, run, previousManifest] = await Promise.all([
      db.prepare(`SELECT id,document_id,sequence,event_type,actor_id,actor_type,
          timestamp,content,original_json FROM items ORDER BY id`)
        .all<{ id: string; document_id: string; sequence: number; event_type: string | null;
          actor_id: string | null; actor_type: string | null; timestamp: string | null;
          content: string; original_json: string }>(),
      db.prepare("SELECT story_source_revision FROM workflow_runs WHERE id=?")
        .bind(authority.workflowRunId).first<{ story_source_revision: number }>(),
      readStoredSemanticManifestAuthority(db, authority.workflowRunId),
    ]);
    if (!run) throw new Error("Workflow run not found");
    leasedRevision = Number(run.story_source_revision);
    const oversizedEvidence = itemRows.some((row) => new TextEncoder().encode(JSON.stringify({
      id: row.id,
      documentId: row.document_id,
      eventType: row.event_type,
      actorId: row.actor_id,
      actorType: row.actor_type,
      timestamp: row.timestamp,
      content: row.content,
    })).byteLength > MAX_SEMANTIC_EVIDENCE_ITEM_BYTES);
    if (oversizedEvidence) {
      await abortStorySourceMutation(db, authority.workflowRunId, now, leasedRevision);
      return Response.json({
        error: "Contribution Evidence exceeds the bounded semantic input",
        code: "SEMANTIC_EVIDENCE_ITEM_TOO_LARGE",
      }, { status: 409 });
    }
    let contributionRecords: Array<{ id: string; sourceDigest: string }>;
    try {
      contributionRecords = await Promise.all(itemRows.map(async (row) => {
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
      }));
    } catch {
      await abortStorySourceMutation(db, authority.workflowRunId, now, leasedRevision);
      return Response.json({
        error: "Contribution source identity validation failed",
        code: "CONTRIBUTION_SOURCE_INVALID",
      }, { status: 409 });
    }
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
         manifest_digest,unit_count,serialized_bytes,story_projection_bytes,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE ${leaseSql}`).bind(
        authority.workflowRunId,
        manifest.projectId,
        manifest.revision,
        leasedRevision + 1,
        manifest.sourceDigest,
        manifest.universeDigest,
        manifest.manifestDigest,
        manifest.units.length,
        manifest.serializedBytes,
        validation.storyProjectionBytes,
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
    for (const payload of jsonParameterBatches(persistedUnits)) {
      statements.push(db.prepare(`INSERT INTO semantic_units
        (id,workflow_run_id,revision,project_id,kind,member_count,membership_digest,
          duplicate_of_unit_id,story_projection_json)
        SELECT json_extract(value,'$.id'),?,json_extract(value,'$.revision'),
          json_extract(value,'$.projectId'),json_extract(value,'$.kind'),
          json_extract(value,'$.memberCount'),json_extract(value,'$.membershipDigest'),
          json_extract(value,'$.duplicateOfUnitId'),json_extract(value,'$.storyProjectionJson')
        FROM json_each(?) WHERE ${leaseSql}`)
        .bind(authority.workflowRunId, payload, ...leaseBindings));
    }
    const members = manifest.units.flatMap((unit) => (
      unit.members.map((itemId) => ({
        itemId,
        unitId: unit.id,
        sourceDigest: sourceDigests.get(itemId)!,
      }))
    ));
    for (const payload of jsonParameterBatches(members)) {
      statements.push(db.prepare(`INSERT INTO semantic_unit_members
        (item_id,workflow_run_id,unit_id,source_digest)
        SELECT json_extract(value,'$.itemId'),?,json_extract(value,'$.unitId'),
          json_extract(value,'$.sourceDigest') FROM json_each(?) WHERE ${leaseSql}`)
        .bind(authority.workflowRunId, payload, ...leaseBindings));
    }
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
