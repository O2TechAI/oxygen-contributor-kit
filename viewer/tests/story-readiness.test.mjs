import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { syntheticStoryEvents } from "./fixtures/synthetic-story-project.mjs";
import {
  selectReviewableStoryTimeline,
  validateStoryCandidatePackage,
} from "../lib/story-readiness.ts";
import { STORY_PREFIX } from "../lib/timeline.ts";
import {
  deriveWorkflowProgress,
  isStoryReviewReady,
  isStoryWorkspaceReady,
} from "../lib/workflow-progress.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const candidates = syntheticStoryEvents.map((event) => ({
  id: `${event.document_id}:${event.id}`,
  documentId: event.document_id,
  summary: event.summary,
}));
const evidence = syntheticStoryEvents.map((event) => ({
  id: `${event.document_id}:${event.id}`,
  documentId: event.document_id,
}));

function changedCandidate(index, change) {
  const copy = candidates.map((candidate) => ({ ...candidate }));
  const annotation = JSON.parse(copy[index].summary.slice(STORY_PREFIX.length));
  change(annotation);
  copy[index].summary = STORY_PREFIX + JSON.stringify(annotation);
  return copy;
}

const reviewedFacts = (overrides = {}) => ({
  workflowRunId: "synthetic-ready-run",
  targetConfirmed: true,
  collectionStatus: "complete",
  collectionCompleted: 3,
  collectionTotal: 3,
  documentCount: 1,
  itemCount: 3,
  organizedItemCount: 3,
  organizationStatus: "complete",
  redactionStatus: "complete",
  storyGenerationStatus: "not_started",
  storyGenerationCompleted: 0,
  storyGenerationTotal: 0,
  updatedAt: "2031-03-12T00:00:00.000Z",
  ...overrides,
});

test("organization, fallback milestones, and partial generation stay on Build Project Story", () => {
  for (const status of ["not_started", "running", "blocked"]) {
    const progress = deriveWorkflowProgress(reviewedFacts({
      storyGenerationStatus: status,
      storyGenerationCompleted: status === "running" ? 1 : 0,
      storyGenerationTotal: status === "running" ? 3 : 0,
    }));
    assert.equal(progress.currentStageId, "story");
    assert.equal(isStoryReviewReady(progress), false);
  }
  const fallback = selectReviewableStoryTimeline([
    { id: "raw-organization-row", sequence: 1, summary: "A loose organization milestone", content: "A state changed after a routine operation." },
  ]);
  assert.deepEqual(fallback, []);
});

test("the complete package validator rejects partial Chapter structures and unresolved evidence", () => {
  assert.deepEqual(validateStoryCandidatePackage([], evidence), {
    ok: false, code: "STORY_CANDIDATE_MISSING",
  });
  assert.equal(validateStoryCandidatePackage([
    { ...candidates[0], summary: "oxygen.story-milestone/1:{}" },
  ], evidence).ok, false);

  const missingPassage = changedCandidate(0, (annotation) => {
    delete annotation.reviewPresentation.en.passageContext.scene;
  });
  assert.deepEqual(validateStoryCandidatePackage(missingPassage, evidence), {
    ok: false, code: "STORY_CHAPTER_INVALID",
  });

  const missingSummary = changedCandidate(0, (annotation) => {
    delete annotation.reviewPresentation.projectSummary;
  });
  assert.deepEqual(validateStoryCandidatePackage(missingSummary, evidence), {
    ok: false, code: "STORY_SUMMARY_MISSING",
  });

  const invalidPrivacy = changedCandidate(0, (annotation) => {
    annotation.reviewPresentation.en.privacy.candidates = [{ id: "partial" }];
  });
  assert.deepEqual(validateStoryCandidatePackage(invalidPrivacy, evidence), {
    ok: false, code: "STORY_CHAPTER_INVALID",
  });

  assert.deepEqual(validateStoryCandidatePackage(candidates, evidence.slice(1)), {
    ok: false, code: "STORY_EVIDENCE_UNRESOLVED",
  });
});

test("malformed truthy Story fields fail closed without throwing", () => {
  const malformedCandidates = [
    changedCandidate(0, (annotation) => { annotation.title = 1; }),
    changedCandidate(0, (annotation) => { annotation.releaseEpisode.scene = { copy: "not text" }; }),
    changedCandidate(0, (annotation) => { annotation.releaseEpisode.readingTimeMinutes = "soon"; }),
    changedCandidate(0, (annotation) => { annotation.reviewPresentation.en.title = 1; }),
    changedCandidate(0, (annotation) => { annotation.reviewPresentation.en.privacy.summary = 1; }),
  ];
  for (const malformed of malformedCandidates) {
    assert.doesNotThrow(() => validateStoryCandidatePackage(malformed, evidence));
    assert.deepEqual(validateStoryCandidatePackage(malformed, evidence), {
      ok: false, code: "STORY_CHAPTER_INVALID",
    });
  }
});

test("activation requires a passed narrative self-review with distinct complete passage interpretation", () => {
  const missingReview = changedCandidate(0, (annotation) => {
    delete annotation.narrativeReview;
  });
  assert.deepEqual(validateStoryCandidatePackage(missingReview, evidence), {
    ok: false, code: "STORY_NARRATIVE_SELF_REVIEW_MISSING",
  });

  const repeatedPassage = changedCandidate(0, (annotation) => {
    annotation.reviewPresentation.en.passageContext.scene.whatWasHappening =
      annotation.reviewPresentation.en.story.scene;
  });
  assert.deepEqual(validateStoryCandidatePackage(repeatedPassage, evidence), {
    ok: false, code: "STORY_NARRATIVE_CONTRACT_FAILED",
  });

  const incompleteInterpretation = changedCandidate(0, (annotation) => {
    delete annotation.reviewPresentation.zh.passageContext.scene.whatWeLearned;
  });
  assert.deepEqual(validateStoryCandidatePackage(incompleteInterpretation, evidence), {
    ok: false, code: "STORY_NARRATIVE_CONTRACT_FAILED",
  });

  const genericTitle = changedCandidate(0, (annotation) => {
    annotation.title = "Project update";
    annotation.reviewPresentation.en.title = "Project update";
    annotation.reviewPresentation.zh.title = "项目更新";
  });
  assert.deepEqual(validateStoryCandidatePackage(genericTitle, evidence), {
    ok: false, code: "STORY_NARRATIVE_CONTRACT_FAILED",
  });
});

test("Phase activation rejects fallback labels and incoherent grouping without forcing a count", () => {
  const fallbackPhase = changedCandidate(0, (annotation) => {
    annotation.phase = "Project evolution";
    annotation.reviewPresentation.en.phase = "Project evolution";
    annotation.reviewPresentation.zh.phase = "项目演进";
  });
  assert.deepEqual(validateStoryCandidatePackage(fallbackPhase, evidence), {
    ok: false, code: "STORY_PHASE_QUALITY_INVALID",
  });

  const incoherentPhase = changedCandidate(1, (annotation) => {
    annotation.narrativeReview.phase.rationale = "A different explanation for the same named Phase.";
  });
  assert.deepEqual(validateStoryCandidatePackage(incoherentPhase, evidence), {
    ok: false, code: "STORY_PHASE_QUALITY_INVALID",
  });

  const oneCoherentPhase = candidates.map((candidate) => {
    const copy = { ...candidate };
    const annotation = JSON.parse(copy.summary.slice(STORY_PREFIX.length));
    annotation.phase = "Calibration Gate";
    annotation.reviewPresentation.en.phase = "Calibration Gate";
    annotation.reviewPresentation.zh.phase = "校准门槛";
    annotation.narrativeReview.phase.rationale =
      "Unify calibration evidence and its release gate as one coherent decision class.";
    copy.summary = STORY_PREFIX + JSON.stringify(annotation);
    return copy;
  });
  assert.equal(validateStoryCandidatePackage(oneCoherentPhase, evidence).ok, true);
});

test("ordered explicit Phases and one complete bilingual Chapter per milestone activate atomically", () => {
  const firstPhase = JSON.parse(candidates[0].summary.slice(STORY_PREFIX.length));
  const finalPhase = JSON.parse(candidates[2].summary.slice(STORY_PREFIX.length));
  const invalidOrder = changedCandidate(1, (annotation) => {
    annotation.phase = finalPhase.phase;
    annotation.reviewPresentation.en.phase = finalPhase.reviewPresentation.en.phase;
    annotation.reviewPresentation.zh.phase = finalPhase.reviewPresentation.zh.phase;
    annotation.narrativeReview.phase.rationale = finalPhase.narrativeReview.phase.rationale;
  });
  const lastAnnotation = JSON.parse(invalidOrder[2].summary.slice(STORY_PREFIX.length));
  lastAnnotation.phase = firstPhase.phase;
  lastAnnotation.reviewPresentation.en.phase = firstPhase.reviewPresentation.en.phase;
  lastAnnotation.reviewPresentation.zh.phase = firstPhase.reviewPresentation.zh.phase;
  lastAnnotation.narrativeReview.phase.rationale = firstPhase.narrativeReview.phase.rationale;
  invalidOrder[2].summary = STORY_PREFIX + JSON.stringify(lastAnnotation);
  assert.deepEqual(validateStoryCandidatePackage(invalidOrder, evidence), {
    ok: false, code: "STORY_PHASE_ORDER_INVALID",
  });

  const validation = validateStoryCandidatePackage(candidates, evidence);
  assert.equal(validation.ok, true);
  assert.equal(validation.chapterCount, syntheticStoryEvents.length);
  const milestones = selectReviewableStoryTimeline(syntheticStoryEvents);
  assert.equal(milestones.length, syntheticStoryEvents.length);
  assert.ok(milestones.every((milestone) => milestone.story.explicit));

  const ready = deriveWorkflowProgress(reviewedFacts({
    storyGenerationStatus: "ready_for_human_review",
    storyGenerationCompleted: milestones.length,
    storyGenerationTotal: milestones.length,
  }));
  assert.equal(ready.currentStageId, "review");
  assert.equal(ready.requiresHumanAction, true);
  assert.equal(isStoryReviewReady(ready), true);
  assert.equal(isStoryReviewReady({ ...ready, currentStageId: "story" }), false);
  assert.equal(isStoryReviewReady({ ...ready, requiresHumanAction: false }), false);

  const hydrated = {
    storyDataReadyRunId: ready.workflowRunId,
    storySessionReadyRunId: ready.workflowRunId,
    documentCount: 1,
    organizationStatus: "complete",
  };
  assert.equal(isStoryWorkspaceReady(ready, hydrated), true);
  assert.equal(isStoryWorkspaceReady(ready, { ...hydrated, storyDataReadyRunId: "" }), false);
  assert.equal(isStoryWorkspaceReady(ready, { ...hydrated, storySessionReadyRunId: "" }), false);
  assert.equal(isStoryWorkspaceReady(ready, { ...hydrated, documentCount: 0 }), false);
  assert.equal(isStoryWorkspaceReady(ready, { ...hydrated, organizationStatus: "running" }), false);
});

test("refresh, direct navigation, activation, and progress remain persisted and fail closed", async () => {
  const [workspace, page, workflowRoute, workflowLoader, sessionRoute, database] = await Promise.all([
    read("../app/workspace.tsx"),
    read("../app/page.tsx"),
    read("../app/api/workflow/route.ts"),
    read("../lib/workflow-progress-server.ts"),
    read("../app/api/story-review-session/route.ts"),
    read("../db/index.ts"),
  ]);
  assert.match(workspace, /const storyReviewReady = isStoryReviewReady\(workflow\)/);
  assert.match(workspace, /const storyWorkspaceReady = isStoryWorkspaceReady\(workflow/);
  assert.match(workspace, /if \(!storyWorkspaceReady\)[\s\S]*return <WorkflowProgress/);
  assert.match(workspace, /selectReviewableStoryTimeline/);
  assert.doesNotMatch(workspace, /if \(!docs\.length \|\| !status/);
  assert.match(workspace, /useState<WorkflowProgressState>\(initialWorkflow\)/);
  assert.match(page, /await loadWorkspaceBootstrap\(\)/);
  assert.match(page, /initialWorkflow=\{initial\.workflow\}/);
  assert.match(page, /initialDocuments=\{initial\.documents\}/);
  assert.match(workflowLoader, /deriveWorkflowProgress/);
  assert.match(workflowLoader, /if \(!isStoryReviewReady\(workflow\)\)/);
  assert.match(workflowLoader, /storySessionReadyRunId: ready \? workflow\.workflowRunId : ""/);
  assert.match(workflowLoader, /Promise\.all/);
  assert.doesNotMatch(workflowLoader, /SELECT\s+content|original_json|reasoning|prompt|tool.?arg/i);
  assert.match(database, /story_generation_status TEXT NOT NULL DEFAULT 'not_started'/);
  assert.match(database, /active_story_digest TEXT/);
  assert.match(workflowRoute, /validateStoryCandidatePackage/);
  assert.match(workflowRoute, /story_source_revision=\?/);
  assert.match(workflowRoute, /story_generation_status='ready_for_human_review'/);
  assert.match(workflowRoute, /Cache-Control": "no-store, max-age=0"/);
  assert.match(workflowRoute, /loadWorkflowProgress\(requestedRunId \|\| undefined\)/);
  assert.match(sessionRoute, /story_generation_status/);
  assert.match(sessionRoute, /Story review is not ready/);
  assert.doesNotMatch(workflowRoute, /SELECT\s+content|original_json|reasoning|prompt|tool.?arg|private.?message/i);
  assert.match(workspace, /const loadActivatedStory = async/);
  assert.match(workspace, /if \(!response\.ok\) throw new Error\("Organization could not be prepared"\)/);
  assert.match(workspace, /fetchOrganizationStatus\(\{ method:"POST" \}\)/);
  assert.match(workspace, /setStoryDataReadyRunId\(workflowRunId\)/);
  assert.match(workspace, /storyDataReadyRunId !== workflowRunId/);
});
