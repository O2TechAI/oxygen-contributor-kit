import type { getD1 } from "../db";

type SourcePublicationDatabase = Awaited<ReturnType<typeof getD1>>;

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
          WHEN story_generation_status='running' THEN ? ELSE ? END,
        story_generation_completed=0,story_generation_total=0,
        active_story_digest=NULL,updated_at=?
    WHERE id=? AND story_generation_status NOT IN (?,?)`)
    .bind(
      STORY_SOURCE_WRITE_STATUS.resumeGeneration,
      STORY_SOURCE_WRITE_STATUS.idle,
      now,
      workflowRunId,
      STORY_SOURCE_WRITE_STATUS.idle,
      STORY_SOURCE_WRITE_STATUS.resumeGeneration,
    ).run();
  return Number(result.meta.changes || 0) === 1;
}

/** Publish exactly one revision only after the complete logical write set is
 * durable, restoring an interrupted Story generation when applicable. */
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

/** A failed chunk leaves no activatable source package and publishes no new
 * revision. A later complete mutation may safely retry from blocked state. */
export async function abortStorySourceMutation(
  db: SourcePublicationDatabase,
  workflowRunId: string,
  now: string,
) {
  await db.prepare(`UPDATE workflow_runs
    SET story_generation_status='blocked',active_story_digest=NULL,updated_at=?
    WHERE id=? AND story_generation_status IN (?,?)`)
    .bind(
      now,
      workflowRunId,
      STORY_SOURCE_WRITE_STATUS.idle,
      STORY_SOURCE_WRITE_STATUS.resumeGeneration,
    ).run();
}
