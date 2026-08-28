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

/** Retire every durable binding derived from the active Story token. Source
 * Privacy producers append these statements to the same transaction as their
 * mutation, so consumers can observe either the old Privacy/active Story or the
 * new Privacy/blocked Story, never a mixed authority. Source revision remains
 * unchanged until the canonical activation path publishes a validated source. */
export function activeStoryPrivacyInvalidationStatements(
  db: SourcePublicationDatabase,
  workflowRunId: string,
  now: string,
): SourcePublicationStatement[] {
  const activeGuard = `EXISTS (SELECT 1 FROM workflow_runs
    WHERE id=? AND story_generation_status='ready_for_human_review')`;
  return [
    db.prepare(`DELETE FROM project_all_set WHERE workflow_run_id=? AND ${activeGuard}`)
      .bind(workflowRunId, workflowRunId),
    db.prepare(`DELETE FROM story_privacy_authorities
      WHERE workflow_run_id=? AND ${activeGuard}`).bind(workflowRunId, workflowRunId),
    db.prepare(`UPDATE workflow_runs
      SET story_generation_status='blocked',active_story_digest=NULL,updated_at=?
      WHERE id=? AND story_generation_status='ready_for_human_review'`)
      .bind(now, workflowRunId),
  ];
}

/** Fail the surrounding batch unless it still owns the exact source generation
 * observed by the Privacy producer. Keep this first in the producer batch so a
 * stale source snapshot cannot delete or replace any Privacy state. */
export function storySourceGenerationGuardStatement(
  db: SourcePublicationDatabase,
  workflowRunId: string,
  expectedRevision: number,
) {
  return db.prepare(`SELECT CASE WHEN EXISTS (
      SELECT 1 FROM workflow_runs WHERE id=? AND story_source_revision=?
    ) THEN 1 ELSE json_extract('source generation changed','$') END AS source_generation_guard`)
    .bind(workflowRunId, expectedRevision);
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
  preparationCandidateCount: number,
  preferenceOutputDigest: string,
  preferenceOutputCount: number,
  now: string,
) {
  try {
    const results = await db.batch([
      ...packageStatements,
    db.prepare(`UPDATE semantic_manifests SET source_revision=?,updated_at=?
      WHERE workflow_run_id=? AND source_revision=?
        AND EXISTS (SELECT 1 FROM workflow_runs
          WHERE id=? AND story_source_revision=? AND story_generation_status=?)
        AND EXISTS (SELECT 1 FROM story_coverage_manifests
          WHERE workflow_run_id=? AND revision=? AND coverage_digest=?)
        AND (SELECT COUNT(*) FROM story_preparation_receipts
          WHERE workflow_run_id=? AND source_revision=?
            AND lane IN ('story','insight','story_privacy','preference'))=4
        AND (SELECT COUNT(*) FROM story_privacy_candidates
          WHERE workflow_run_id=?)=?
        AND EXISTS (SELECT 1 FROM probe_runs
          WHERE workflow_run_id=? AND source_revision=?
            AND input_digest=(SELECT input_digest FROM story_preparation_receipts
              WHERE workflow_run_id=? AND lane='preference' AND source_revision=?)
            AND output_digest=? AND output_count=?)`)
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
        workflowRunId,
        expectedRevision + 1,
        workflowRunId,
        preparationCandidateCount,
        workflowRunId,
        expectedRevision + 1,
        workflowRunId,
        expectedRevision + 1,
        preferenceOutputDigest,
        preferenceOutputCount,
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
      db.prepare(`SELECT CASE WHEN EXISTS (
        SELECT 1 FROM workflow_runs
        WHERE id=? AND story_source_revision=?
          AND story_generation_status='ready_for_human_review'
          AND active_story_digest=?
      ) THEN 1 ELSE json_extract('activation authority failed','$') END AS activation_guard`)
        .bind(workflowRunId, expectedRevision + 1, activeStoryDigest),
    ]);
    return results.slice(-3, -1).every((result) => Number(result.meta.changes || 0) === 1);
  } catch {
    return false;
  }
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
