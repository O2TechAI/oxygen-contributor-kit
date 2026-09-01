import type { getLocalDatabase } from "../db";
import { applyStoryReviewToBlock, humanQuoteText } from "./story-review.ts";
import {
  hydrateStoryReviewSession,
  type StoryReviewSession,
} from "./story-review-session.ts";
import { readStoryReviewSessionRecord } from "./story-review-session-server.ts";
import {
  compareUtf8,
  storyPreparationDigest,
  storyReleaseTargetId,
} from "./story-preparation.ts";
import {
  readReservedStoryCandidateRows,
  validateCurrentStorySourcePackage,
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
  targets: ReviewedStoryPrivacyTarget[];
  changedTargetDigest: string;
  targetTransitions: Array<{
    id: StoryReleaseTarget;
    previousContentDigest: string | null;
    contentDigest: string | null;
  }>;
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
function sourceInsightContent(source: StorySource, review: StoryReviewSession["chapterReviews"][string] | null) {
  return source.insights.flatMap((insight) => {
    if (!review) return [];
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
    values.push({ id: storyReleaseTargetId(storyKey, target), storyKey, target, content });
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
        ? applyStoryReviewToBlock(block.text, block.id, source.language, review)
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
      add(source.key, `insight:${insight.id}:quote`, insight.content.quote.text);
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
        const quote = humanQuoteText(review, source, current.content);
        if (quote !== null) add(source.key, `insight:${insightId}:quote`, quote);
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
  const validation = await validateCurrentStorySourcePackage(
    db,
    workflowRunId,
    storyRows,
    evidenceResult.results || [],
  );
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
    if (Object.keys(hydrated.chapterReviews).sort(compareUtf8).join("\n") !== keys.join("\n")) {
      return { ok: false, code: STORY_PRIVACY_REVISION_ERROR.reviewIncomplete };
    }
    reviews = hydrated.chapterReviews;
  }

  const baseline = await digestTargets(targetValues(exactSources, null));
  const current = reviews ? await digestTargets(targetValues(exactSources, reviews)) : baseline;
  const targetCatalog = current.map((target) => ({ id: target.id, contentDigest: target.contentDigest }));
  const storedAuthority = await db.prepare(`SELECT target_catalog_json,target_catalog_digest
    FROM story_privacy_authorities WHERE workflow_run_id=?`).bind(workflowRunId)
    .first<{ target_catalog_json?: string; target_catalog_digest?: string }>();
  let previousCatalog = baseline.map(({ id, contentDigest }) => ({ id, contentDigest }));
  if (storedAuthority) {
    try {
      const parsed = JSON.parse(String(storedAuthority.target_catalog_json));
      if (!Array.isArray(parsed)
        || parsed.some((target) => !target || typeof target !== "object" || Array.isArray(target)
          || Object.keys(target).length !== 2 || typeof target.id !== "string"
          || typeof target.contentDigest !== "string" || !digestPattern.test(target.contentDigest))
        || await storyPreparationDigest(parsed) !== storedAuthority.target_catalog_digest) {
        return { ok: false, code: STORY_PRIVACY_REVISION_ERROR.invalidAuthority };
      }
      previousCatalog = parsed;
    } catch {
      return { ok: false, code: STORY_PRIVACY_REVISION_ERROR.invalidAuthority };
    }
  }
  const previousById = new Map(previousCatalog.map((target) => [target.id, target.contentDigest]));
  const currentById = new Map(targetCatalog.map((target) => [target.id, target.contentDigest]));
  const targetTransitions = [
    ...targetCatalog.filter((target) => previousById.get(target.id) !== target.contentDigest)
      .map((target) => ({
        id: target.id,
        previousContentDigest: previousById.get(target.id) || null,
        contentDigest: target.contentDigest,
      })),
    ...previousCatalog.filter((target) => !currentById.has(target.id)).map((target) => ({
      id: target.id,
      previousContentDigest: target.contentDigest,
      contentDigest: null,
    })),
  ].sort((left, right) => compareUtf8(left.id, right.id));
  const changedIds = new Set(targetTransitions.filter((target) => target.contentDigest !== null)
    .map((target) => target.id));
  const changedTargets = current.filter((target) => changedIds.has(target.id));
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
      targets: current,
      changedTargetDigest: await storyPreparationDigest(targetTransitions),
      targetTransitions,
      changedTargets,
    },
  };
}
