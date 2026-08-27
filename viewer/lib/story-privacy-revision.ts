import type { getLocalDatabase } from "../db";
import { applyStoryReviewToBlock } from "./story-review.ts";
import {
  hydrateStoryReviewSession,
  type StoryReviewSession,
} from "./story-review-session.ts";
import { readStoryReviewSessionRecord } from "./story-review-session-server.ts";
import { storyPreparationDigest } from "./story-preparation.ts";
import {
  readReservedStoryCandidateRows,
  validateStorySourcePackage,
  type StoryEvidenceRow,
} from "./story-readiness.ts";
import {
  parseStorySource,
  type StoryReleaseTarget,
  type StoryReleaseTargetName,
  type StorySource,
} from "./timeline.ts";

type StoryPrivacyDatabase = Awaited<ReturnType<typeof getLocalDatabase>>;

export type ReviewedStoryPrivacyTarget = {
  id: StoryReleaseTarget;
  storyKey: string;
  target: StoryReleaseTargetName;
  content: string;
  contentDigest: string;
};

export type ReviewedStoryPrivacyRevision = {
  workflowRunId: string;
  sourceRevision: number;
  activeStoryDigest: string;
  serverVersion: number;
  reviewedStoryDigest: string;
  targetCatalogDigest: string;
  targetCatalog: Array<{ id: StoryReleaseTarget; contentDigest: string }>;
  changedTargetDigest: string;
  changedTargets: ReviewedStoryPrivacyTarget[];
};

export const STORY_PRIVACY_REVISION_ERROR = {
  invalidAuthority: "STORY_PRIVACY_AUTHORITY_INVALID",
  foreignWorkflow: "STORY_PRIVACY_WORKFLOW_NOT_FOUND",
  reviewIncomplete: "STORY_PRIVACY_REVIEW_INCOMPLETE",
} as const;

type RevisionFailure = {
  ok: false;
  code: typeof STORY_PRIVACY_REVISION_ERROR[keyof typeof STORY_PRIVACY_REVISION_ERROR];
};

const validRevision = (value: unknown): value is number => Number.isSafeInteger(value)
  && Number(value) >= 0;
const digestPattern = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

function compareUtf8(left: string, right: string) {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function targetId(storyKey: string, target: StoryReleaseTargetName) {
  return `${storyKey}::${target}` as StoryReleaseTarget;
}

function sourceInsightContent(source: StorySource, review: StoryReviewSession["chapterReviews"][string] | null) {
  return source.insights.flatMap((insight) => {
    if (!review) return [{ id: insight.id, content: insight }];
    const current = review.sourceInsightReviews[insight.id];
    if (!current || current.decision === "rejected") return [];
    if (current.decision !== "accepted" || current.resolution !== "applied"
      || current.appliedVersion !== current.version) return [];
    return [{ id: insight.id, content: current.editedContent || insight }];
  });
}

function targetValues(
  sources: StorySource[],
  reviews: StoryReviewSession["chapterReviews"] | null,
) {
  const values: Array<{
    id: StoryReleaseTarget;
    storyKey: string;
    target: StoryReleaseTargetName;
    content: string;
  }> = [];
  const add = (storyKey: string, target: StoryReleaseTargetName, content: string) => {
    values.push({ id: targetId(storyKey, target), storyKey, target, content });
  };
  for (const source of sources) {
    const review = reviews?.[source.key] || null;
    add(source.key, "phase", source.phase.label);
    add(source.key, "title", source.title);
    add(source.key, "overview", source.overview);
    if (source.transition) {
      add(source.key, "transition:before", source.transition.before);
      add(source.key, "transition:after", source.transition.after);
    }
    for (const person of source.people) {
      add(source.key, `people:${person.id}:releaseLabel`, person.releaseLabel);
      add(source.key, `people:${person.id}:role`, person.role);
      add(source.key, `people:${person.id}:description`, person.description);
    }
    for (const block of source.story.blocks) {
      add(source.key, `story:${block.id}`, review
        ? applyStoryReviewToBlock(block.text, block.id, "en", review)
        : block.text);
    }
    if (source.story.uncertainty !== undefined) {
      add(source.key, "uncertainty", source.story.uncertainty);
    }
    for (const insight of sourceInsightContent(source, review)) {
      if (insight.content.title !== undefined) {
        add(source.key, `insight:${insight.id}:title`, insight.content.title);
      }
      add(source.key, `insight:${insight.id}:background`, insight.content.background);
      add(source.key, `insight:${insight.id}:directlyAcquiredExperience`,
        insight.content.directlyAcquiredExperience);
      add(source.key, `insight:${insight.id}:principle`, insight.content.principle);
    }
    if (review) {
      for (const [insightId, current] of Object.entries(review.humanInsights)
        .sort(([left], [right]) => compareUtf8(left, right))) {
        if (current.decision !== "human_approved" || current.resolution !== "applied"
          || current.appliedVersion !== current.version) continue;
        if (current.content.title !== undefined) {
          add(source.key, `insight:${insightId}:title`, current.content.title);
        }
        add(source.key, `insight:${insightId}:background`, current.content.background);
        add(source.key, `insight:${insightId}:directlyAcquiredExperience`,
          current.content.directlyAcquiredExperience);
        add(source.key, `insight:${insightId}:principle`, current.content.principle);
      }
    }
  }
  return values;
}

async function digestTargets(values: ReturnType<typeof targetValues>): Promise<ReviewedStoryPrivacyTarget[]> {
  return Promise.all(values.map(async (value) => ({
    ...value,
    contentDigest: await storyPreparationDigest(value.content),
  })));
}

/** Reconstruct the exact release-visible reviewed target set from the activated
 * Story and the current durable review session. Text is returned only to the
 * local preparation/import boundary; public authority responses project it out. */
export async function reconstructReviewedStoryPrivacyRevision(
  db: StoryPrivacyDatabase,
  workflowRunId: string,
): Promise<{ ok: true; revision: ReviewedStoryPrivacyRevision } | RevisionFailure> {
  const authorityRows = (await db.prepare("SELECT id FROM workflow_runs ORDER BY id LIMIT 2").all()).results;
  if (authorityRows.length !== 1) return { ok: false, code: STORY_PRIVACY_REVISION_ERROR.invalidAuthority };
  if (authorityRows[0]?.id !== workflowRunId) {
    return { ok: false, code: STORY_PRIVACY_REVISION_ERROR.foreignWorkflow };
  }
  const [run, storyRows, evidenceResult, sessionRecord] = await Promise.all([
    db.prepare(`SELECT id,story_generation_status,story_source_revision,active_story_digest
      FROM workflow_runs WHERE id=?`).bind(workflowRunId).first<Record<string, unknown>>(),
    readReservedStoryCandidateRows(db),
    db.prepare(`SELECT id,document_id AS documentId,event_type AS eventType,
      actor_id AS actorId,actor_type AS actorType FROM items ORDER BY document_id,sequence`)
      .all<StoryEvidenceRow>(),
    readStoryReviewSessionRecord(db, workflowRunId),
  ]);
  const sourceRevision = Number(run?.story_source_revision);
  const activeStoryDigest = run?.active_story_digest;
  if (!run || run.id !== workflowRunId || run.story_generation_status !== "ready_for_human_review"
    || !validRevision(sourceRevision) || sourceRevision <= 0
    || typeof activeStoryDigest !== "string" || !digestPattern.test(activeStoryDigest)) {
    return { ok: false, code: STORY_PRIVACY_REVISION_ERROR.invalidAuthority };
  }
  const validation = validateStorySourcePackage(storyRows, evidenceResult.results || []);
  if (!validation.ok
    || await storyPreparationDigest(JSON.parse(validation.canonicalCandidate)) !== activeStoryDigest) {
    return { ok: false, code: STORY_PRIVACY_REVISION_ERROR.invalidAuthority };
  }
  const sources = storyRows.map((row) => parseStorySource(row.summary));
  if (sources.some((source) => !source)) {
    return { ok: false, code: STORY_PRIVACY_REVISION_ERROR.invalidAuthority };
  }
  const exactSources = sources.flatMap((source) => source ? [source] : []);
  let reviews: StoryReviewSession["chapterReviews"] | null = null;
  if (sessionRecord.serverVersion > 0 || sessionRecord.persistedAt !== null) {
    if (!sessionRecord.session || sessionRecord.sourceRevision !== sourceRevision) {
      return { ok: false, code: STORY_PRIVACY_REVISION_ERROR.invalidAuthority };
    }
    const hydrated = hydrateStoryReviewSession(sessionRecord.session, workflowRunId, exactSources);
    const keys = exactSources.map((source) => source.key).sort(compareUtf8);
    if (Object.keys(hydrated.chapterReviews).sort(compareUtf8).join("\n") !== keys.join("\n")
      || keys.some((key) => hydrated.chapterReviews[key]?.stage !== "human_confirmed")) {
      return { ok: false, code: STORY_PRIVACY_REVISION_ERROR.reviewIncomplete };
    }
    reviews = hydrated.chapterReviews;
  }

  const baseline = await digestTargets(targetValues(exactSources, null));
  const current = reviews ? await digestTargets(targetValues(exactSources, reviews)) : baseline;
  const baselineById = new Map(baseline.map((target) => [target.id, target.contentDigest]));
  const changedTargets = current.filter((target) => baselineById.get(target.id) !== target.contentDigest);
  const targetCatalog = current.map((target) => ({ id: target.id, contentDigest: target.contentDigest }));
  return {
    ok: true,
    revision: {
      workflowRunId,
      sourceRevision,
      activeStoryDigest,
      serverVersion: sessionRecord.serverVersion,
      reviewedStoryDigest: await storyPreparationDigest(current.map(({ id, content }) => ({ id, content }))),
      targetCatalogDigest: await storyPreparationDigest(targetCatalog),
      targetCatalog,
      changedTargetDigest: await storyPreparationDigest(changedTargets.map((target) => target.id)),
      changedTargets,
    },
  };
}
