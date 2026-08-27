import type { getLocalDatabase } from "../db";

type SourcePublicationDatabase = Awaited<ReturnType<typeof getLocalDatabase>>;
type SourcePublicationStatement = Parameters<SourcePublicationDatabase["batch"]>[0][number];

export const STORY_SOURCE_LEASE_STALE_MINUTES = 30;

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

/** Replace every source row, publish its finalized manifest, and advance Story
 * source authority through one guarded transaction. The transaction rolls the
 * entire replacement back if any prepared statement fails. */
export async function publishFinalizedCorpusSourceMutation(
  db: SourcePublicationDatabase,
  replacementStatements: SourcePublicationStatement[],
  workflowRunId: string,
  expectedSourceRevision: number,
  corpusRevision: number,
  corpusDigest: string,
  documentCount: number,
  itemCount: number,
  now: string,
) {
  const results = await db.batch([
    ...replacementStatements,
    db.prepare(`UPDATE workflow_runs
      SET story_generation_status=CASE
            WHEN story_generation_status=? THEN 'running' ELSE 'not_started' END,
          story_source_revision=story_source_revision+1,updated_at=?
      WHERE id=? AND story_source_revision=? AND story_generation_status IN (?,?)
        AND EXISTS (SELECT 1 FROM finalized_corpus_manifests
          WHERE workflow_run_id=? AND corpus_revision=? AND corpus_digest=?
            AND document_count=? AND item_count=?)
        AND (SELECT COUNT(*) FROM documents)=?
        AND (SELECT COUNT(*) FROM items)=?`)
      .bind(
        STORY_SOURCE_WRITE_STATUS.resumeGeneration,
        now,
        workflowRunId,
        expectedSourceRevision,
        STORY_SOURCE_WRITE_STATUS.idle,
        STORY_SOURCE_WRITE_STATUS.resumeGeneration,
        workflowRunId,
        corpusRevision,
        corpusDigest,
        documentCount,
        itemCount,
        documentCount,
        itemCount,
      ),
  ]);
  return Number(results.at(-1)?.meta.changes || 0) === 1;
}

/** Persist one normalized semantic package and publish its source revision in
 * the same guarded transaction. */
export async function publishCompletedSemanticSourceMutation(
  db: SourcePublicationDatabase,
  packageStatements: SourcePublicationStatement[],
  workflowRunId: string,
  expectedRevision: number,
  semanticManifestDigest: string,
  corpusRevision: number,
  corpusDigest: string,
  corpusDocumentCount: number,
  corpusItemCount: number,
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
          WHERE workflow_run_id=? AND source_revision=? AND manifest_digest=?
            AND corpus_revision=? AND corpus_digest=?
            AND corpus_document_count=? AND corpus_item_count=?)`)
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
        corpusRevision,
        corpusDigest,
        corpusDocumentCount,
        corpusItemCount,
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

/** A failed write leaves no activatable source package and publishes no new
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
