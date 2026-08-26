import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { syntheticStoryEvents } from "./fixtures/synthetic-story-project.mjs";
import {
  applyChapterReview,
  emptyChapterReview,
  markChapterReady,
  privacyDecisionKey,
} from "../lib/story-review.ts";
import {
  STORY_REVIEW_SESSION_SCHEMA,
  canonicalizeStoryReviewSession,
  createStoryReviewSession,
  hydrateStoryReviewSession,
} from "../lib/story-review-session.ts";
import { selectProjectTimeline, storyReleaseTargetCatalog } from "../lib/timeline.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const sourceBlocks = (milestone) => Object.fromEntries(["en", "zh"].map((language) => {
  const presentation = milestone.story.reviewPresentation[language];
  return [language, {
    scene: presentation.story.scene,
    ...Object.fromEntries(presentation.story.reconstruction.map((copy, index) => [`reconstruction-${index}`, copy])),
    ...Object.fromEntries(presentation.story.importantDetails.map((copy, index) => [`detail-${index}`, copy])),
    outcome: presentation.story.decisionOutcome,
    ...(presentation.story.uncertainty ? { uncertainty: presentation.story.uncertainty } : {}),
  }];
}));

function confirmedReview(milestone) {
  const presentation = milestone.story.reviewPresentation.en;
  const decisions = Object.fromEntries(presentation.privacy.candidates.map((candidate) => [candidate.id, "keep"]));
  const sources = sourceBlocks(milestone);
  const context = {
    storyKey: milestone.story.key,
    privacyCandidates: presentation.privacy.candidates,
    privacyDecisions: decisions,
    targetCatalog: storyReleaseTargetCatalog(presentation),
    reviewableInsightIds: presentation.highlights.map((highlight) => highlight.id),
    chapterEvidence: [milestone.story.evidence.primary, ...milestone.story.evidence.supporting],
    evidenceResolved: true,
    supportedAddIds: [],
    sourceBlocks: sources,
    reviewedBlocks: sources,
  };
  return markChapterReady(applyChapterReview(emptyChapterReview(), context).state, context);
}

test("Story review session survives refresh only for the exact source-valid workflow", () => {
  const milestones = selectProjectTimeline(syntheticStoryEvents);
  const milestone = milestones[0];
  const review = confirmedReview(milestone);
  assert.equal(review.stage, "human_confirmed");
  const session = createStoryReviewSession("reviewed-run", { [milestone.story.key]: review }, {});
  assert.equal(session.schema, STORY_REVIEW_SESSION_SCHEMA);

  const restored = hydrateStoryReviewSession(session, "reviewed-run", milestones);
  assert.equal(restored.chapterReviews[milestone.story.key].stage, "human_confirmed");
  assert.equal(restored.chapterReviews[milestone.story.key].publicationApproved, false);
  assert.deepEqual(hydrateStoryReviewSession(session, "different-run", milestones), {
    chapterReviews: {}, privacyDecisions: {},
  });
});

test("session canonicalization strips unknown payloads and hydration rejects forged completion", () => {
  const milestones = selectProjectTimeline(syntheticStoryEvents);
  const milestone = milestones[0];
  const session = createStoryReviewSession("reviewed-run", { [milestone.story.key]: confirmedReview(milestone) }, {});
  const untrusted = structuredClone(session);
  untrusted.privateReasoning = "never persist this";
  untrusted.chapterReviews[milestone.story.key].scratchpad = "never hydrate this";
  untrusted.privacyDecisions[privacyDecisionKey("foreign-story", "foreign-candidate")] = "keep";
  const canonical = canonicalizeStoryReviewSession(untrusted);
  assert.doesNotMatch(JSON.stringify(canonical), /privateReasoning|scratchpad|never persist|never hydrate/);
  assert.deepEqual(hydrateStoryReviewSession(canonical, "reviewed-run", milestones).privacyDecisions, {});

  const forged = createStoryReviewSession("reviewed-run", {
    [milestone.story.key]: { ...emptyChapterReview(), stage: "human_confirmed" },
  }, {});
  assert.deepEqual(hydrateStoryReviewSession(forged, "reviewed-run", milestones).chapterReviews, {});
  assert.equal(createStoryReviewSession("r".repeat(129), {}, {}), null);
});

test("Story session API is bounded, CAS-owned, local, and excluded from workflow progress and package reads", async () => {
  const [route, server, workflowRoute, packageRoute, database] = await Promise.all([
    read("../app/api/story-review-session/route.ts"),
    read("../lib/story-review-session-server.ts"),
    read("../app/api/workflow/route.ts"),
    read("../app/api/package/route.ts"),
    read("../db/index.ts"),
  ]);
  assert.match(route, /MAX_STORY_REVIEW_SESSION_BYTES/);
  assert.match(route, /parseStoryReviewSession/);
  assert.match(route, /persistStoryReviewSessionCas/);
  assert.match(route, /STORY_SESSION_ERROR\.versionRequired/);
  assert.match(server, /STORY_SESSION_VERSION_REQUIRED/);
  assert.doesNotMatch(route, /excluded\.updated_at|saved:\s*true,\s*updatedAt/);
  assert.match(server, /server_version=server_version\+1/);
  assert.match(server, /story_source_revision=\?/);
  assert.match(server, /Number\(result\.meta\?\.changes \|\| 0\)/);
  assert.match(database, /CREATE TABLE IF NOT EXISTS story_review_sessions/);
  assert.doesNotMatch(workflowRoute, /story_review_sessions|state_json/);
  assert.doesNotMatch(packageRoute, /story_review_sessions|state_json/);
});
