import type { getD1 } from "../db";

type SourcePublicationDatabase = Awaited<ReturnType<typeof getD1>>;
type SourcePublicationStatement = Parameters<SourcePublicationDatabase["batch"]>[0][number];

export const D1_JSON_PARAMETER_BYTES = 1_750_000;
export const STORY_SOURCE_LEASE_STALE_MINUTES = 30;
export const STORY_ACTIVATION_MAX_PACKAGE_STATEMENTS = 33;

/** Encode many bounded rows behind one D1 parameter. D1's JSON extension
 * expands each payload with json_each, keeping both parameter and query counts
 * below platform limits without introducing another persistence schema. */
export function jsonParameterBatches<T>(rows: readonly T[]): string[] {
  const batches: string[] = [];
  let parts: string[] = [];
  let bytes = 2;
  for (const row of rows) {
    const serialized = JSON.stringify(row);
    const rowBytes = new TextEncoder().encode(serialized).byteLength;
    if (rowBytes + 2 > D1_JSON_PARAMETER_BYTES) {
      throw new Error("D1 JSON row exceeds the bounded parameter size");
    }
    const addition = rowBytes + (parts.length ? 1 : 0);
    if (parts.length && bytes + addition > D1_JSON_PARAMETER_BYTES) {
      batches.push(`[${parts.join(",")}]`);
      parts = [];
      bytes = 2;
    }
    parts.push(serialized);
    bytes += rowBytes + (parts.length > 1 ? 1 : 0);
  }
  if (parts.length) batches.push(`[${parts.join(",")}]`);
  return batches;
}

/** Keep Story activation below D1's 50-query invocation limit. The route has
 * a conservatively counted 16 non-package queries (including final publish),
 * so 33 package statements leave one query of operational margin. */
export function assertStoryActivationQueryBudget(packageStatementCount: number) {
  if (!Number.isSafeInteger(packageStatementCount)
    || packageStatementCount < 0
    || packageStatementCount > STORY_ACTIVATION_MAX_PACKAGE_STATEMENTS) {
    throw new Error("Story activation exceeds the bounded D1 query budget");
  }
}

export const STORY_SOURCE_WRITE_STATUS = {
  idle: "source_writing",
  resumeGeneration: "source_writing_generation",
} as const;

export function isStorySourceWriteInProgress(value: unknown) {
  return value === STORY_SOURCE_WRITE_STATUS.idle
    || value === STORY_SOURCE_WRITE_STATUS.resumeGeneration;
}

/** Claim the existing Story generation status as a non-activatable source-write
 * boundary. A second mutation cannot overlap the first one. */
export async function beginStorySourceMutation(
  db: SourcePublicationDatabase,
  workflowRunId: string,
  now: string,
) {
  const result = await db.prepare(`UPDATE workflow_runs
    SET story_generation_status=CASE
          WHEN story_generation_status IN ('running',?) THEN ? ELSE ? END,
        story_generation_completed=0,story_generation_total=0,
        story_source_revision=story_source_revision+CASE
          WHEN story_generation_status IN (?,?) THEN 1 ELSE 0 END,
        active_story_digest=NULL,updated_at=?
    WHERE id=? AND (
      story_generation_status NOT IN (?,?)
      OR datetime(updated_at)<=datetime(?,'-${STORY_SOURCE_LEASE_STALE_MINUTES} minutes')
    )`)
    .bind(
      STORY_SOURCE_WRITE_STATUS.resumeGeneration,
      STORY_SOURCE_WRITE_STATUS.resumeGeneration,
      STORY_SOURCE_WRITE_STATUS.idle,
      STORY_SOURCE_WRITE_STATUS.idle,
      STORY_SOURCE_WRITE_STATUS.resumeGeneration,
      now,
      workflowRunId,
      STORY_SOURCE_WRITE_STATUS.idle,
      STORY_SOURCE_WRITE_STATUS.resumeGeneration,
      now,
    ).run();
  return Number(result.meta.changes || 0) === 1;
}

/** Claim Story activation only from active generation. Unlike the generic
 * import lease, a stale second ready request cannot reopen reviewed source. */
export async function beginStoryActivationMutation(
  db: SourcePublicationDatabase,
  workflowRunId: string,
  now: string,
) {
  const result = await db.prepare(`UPDATE workflow_runs
    SET story_generation_status=?,story_generation_completed=0,
        story_generation_total=0,active_story_digest=NULL,updated_at=?
    WHERE id=? AND story_generation_status='running'`)
    .bind(STORY_SOURCE_WRITE_STATUS.resumeGeneration, now, workflowRunId).run();
  return Number(result.meta.changes || 0) === 1;
}

/** Publish exactly one revision only after a complete source write. */
export async function publishCompletedStorySourceMutation(
  db: SourcePublicationDatabase,
  workflowRunId: string,
  now: string,
) {
  const result = await db.prepare(`UPDATE workflow_runs
    SET story_generation_status=CASE
          WHEN story_generation_status=? THEN 'running' ELSE 'not_started' END,
        story_source_revision=story_source_revision+1,updated_at=?
    WHERE id=? AND story_generation_status IN (?,?)`)
    .bind(
      STORY_SOURCE_WRITE_STATUS.resumeGeneration,
      now,
      workflowRunId,
      STORY_SOURCE_WRITE_STATUS.idle,
      STORY_SOURCE_WRITE_STATUS.resumeGeneration,
    ).run();
  return Number(result.meta.changes || 0) === 1;
}

/** Persist one normalized semantic package and publish its source revision in
 * the same guarded D1 batch. */
export async function publishCompletedSemanticSourceMutation(
  db: SourcePublicationDatabase,
  packageStatements: SourcePublicationStatement[],
  workflowRunId: string,
  expectedRevision: number,
  semanticManifestDigest: string,
  now: string,
) {
  const results = await db.batch([
    ...packageStatements,
    db.prepare(`UPDATE workflow_runs
      SET story_generation_status=CASE
            WHEN story_generation_status=? THEN 'running' ELSE 'not_started' END,
          story_source_revision=story_source_revision+1,updated_at=?
      WHERE id=? AND story_source_revision=? AND story_generation_status IN (?,?)
        AND EXISTS (SELECT 1 FROM semantic_manifests
          WHERE workflow_run_id=? AND source_revision=? AND manifest_digest=?)`)
      .bind(
        STORY_SOURCE_WRITE_STATUS.resumeGeneration,
        now,
        workflowRunId,
        expectedRevision,
        STORY_SOURCE_WRITE_STATUS.idle,
        STORY_SOURCE_WRITE_STATUS.resumeGeneration,
        workflowRunId,
        expectedRevision + 1,
        semanticManifestDigest,
      ),
  ]);
  return Number(results.at(-1)?.meta.changes || 0) === 1;
}

/** Publish a validated Story package and enter human review in one CAS. The
 * caller has already written the complete package under the generation lease. */
export async function publishActivatedStorySourceMutation(
  db: SourcePublicationDatabase,
  packageStatements: SourcePublicationStatement[],
  workflowRunId: string,
  expectedRevision: number,
  chapterCount: number,
  activeStoryDigest: string,
  coverageRevision: number,
  coverageDigest: string,
  now: string,
) {
  const results = await db.batch([
    ...packageStatements,
    db.prepare(`UPDATE semantic_manifests SET source_revision=?,updated_at=?
      WHERE workflow_run_id=? AND source_revision=?
        AND EXISTS (SELECT 1 FROM workflow_runs
          WHERE id=? AND story_source_revision=? AND story_generation_status=?)
        AND EXISTS (SELECT 1 FROM story_coverage_manifests
          WHERE workflow_run_id=? AND revision=? AND coverage_digest=?)`)
      .bind(
        expectedRevision + 1,
        now,
        workflowRunId,
        expectedRevision,
        workflowRunId,
        expectedRevision,
        STORY_SOURCE_WRITE_STATUS.resumeGeneration,
        workflowRunId,
        coverageRevision,
        coverageDigest,
      ),
    db.prepare(`UPDATE workflow_runs
      SET story_generation_status='ready_for_human_review',
          story_generation_completed=?,story_generation_total=?,
          active_story_digest=?,story_source_revision=story_source_revision+1,updated_at=?
      WHERE id=? AND story_source_revision=? AND story_generation_status=?
        AND EXISTS (SELECT 1 FROM semantic_manifests
          WHERE workflow_run_id=? AND source_revision=?)
        AND EXISTS (SELECT 1 FROM story_coverage_manifests
          WHERE workflow_run_id=? AND revision=? AND coverage_digest=?)`)
      .bind(
        chapterCount,
        chapterCount,
        activeStoryDigest,
        now,
        workflowRunId,
        expectedRevision,
        STORY_SOURCE_WRITE_STATUS.resumeGeneration,
        workflowRunId,
        expectedRevision + 1,
        workflowRunId,
        coverageRevision,
        coverageDigest,
      ),
  ]);
  return results.slice(-2).every((result) => Number(result.meta.changes || 0) === 1);
}

/** A failed chunk leaves no activatable source package and publishes no new
 * revision. A later complete mutation may safely retry from blocked state. */
export async function abortStorySourceMutation(
  db: SourcePublicationDatabase,
  workflowRunId: string,
  now: string,
  expectedRevision?: number,
) {
  const revisionGuard = expectedRevision === undefined ? "" : " AND story_source_revision=?";
  const statement = db.prepare(`UPDATE workflow_runs
    SET story_generation_status='blocked',active_story_digest=NULL,updated_at=?
    WHERE id=? AND story_generation_status IN (?,?)${revisionGuard}`);
  await statement.bind(
    now,
    workflowRunId,
    STORY_SOURCE_WRITE_STATUS.idle,
    STORY_SOURCE_WRITE_STATUS.resumeGeneration,
    ...(expectedRevision === undefined ? [] : [expectedRevision]),
  ).run();
}
