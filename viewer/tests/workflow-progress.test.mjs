import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  WORKFLOW_STAGE_IDS,
  deriveWorkflowProgress,
  withHumanReviewProgress,
} from "../lib/workflow-progress.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const facts = (overrides = {}) => ({
  workflowRunId: "reviewed-run",
  documentCount: 2,
  itemCount: 10,
  organizedItemCount: 0,
  organizationStatus: "running",
  redactionStatus: null,
  storyChapterCount: 0,
  updatedAt: "2026-08-23T10:00:00.000Z",
  ...overrides,
});

test("workflow progress derives completed, current, next, waiting, and blocked states from persistent facts", () => {
  const importing = deriveWorkflowProgress(facts({ documentCount: 0, itemCount: 0, organizationStatus: null }));
  assert.equal(importing.currentStageId, "prepare");
  assert.equal(importing.status, "waiting");
  assert.equal(importing.requiresHumanAction, true);

  const organizing = deriveWorkflowProgress(facts({ organizedItemCount: 4 }));
  assert.equal(organizing.currentStageId, "organize");
  assert.deepEqual(organizing.stages.find((stage) => stage.id === "organize")?.progress, { completed: 4, total: 10 });
  assert.equal(organizing.stages.find((stage) => stage.id === "prepare")?.status, "complete");
  assert.equal(organizing.stages.find((stage) => stage.id === "privacy")?.status, "up_next");

  const blocked = deriveWorkflowProgress(facts({ organizationStatus: "failed" }));
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blockedReasonCode, "ORGANIZATION_FAILED");

  const privacy = deriveWorkflowProgress(facts({ organizedItemCount: 10, organizationStatus: "complete", redactionStatus: "running" }));
  assert.equal(privacy.currentStageId, "privacy");
  assert.equal(privacy.safeStatusCode, "checking_privacy");

  const reviewing = deriveWorkflowProgress(facts({ organizedItemCount: 10, organizationStatus: "complete", redactionStatus: "complete", storyChapterCount: 14 }));
  assert.equal(reviewing.currentStageId, "review");
  assert.equal(reviewing.status, "waiting");
  assert.equal(reviewing.requiresHumanAction, true);
  assert.deepEqual(reviewing.stages.map((stage) => stage.id), WORKFLOW_STAGE_IDS);

  const handoff = withHumanReviewProgress(reviewing, 14, 14);
  assert.equal(handoff.currentStageId, "handoff");
  assert.equal(handoff.safeStatusCode, "release_handoff_ready");
  assert.equal(handoff.completedStages, 5);
});

test("workflow progress is a strict sanitized operational projection", () => {
  const state = deriveWorkflowProgress(facts({ organizedItemCount: 10, organizationStatus: "complete", redactionStatus: "complete", storyChapterCount: 3 }));
  assert.deepEqual(Object.keys(state).sort(), [
    "completedStages", "currentStageId", "requiresHumanAction", "safeStatusCode", "stages",
    "status", "totalStages", "updatedAt", "workflowRunId",
  ]);
  const serialized = JSON.stringify(state);
  assert.doesNotMatch(serialized, /reasoning|chain.of.thought|prompt|tool.?arg|private.?message|story.?payload|evidence.?payload|removed.?content/i);
  assert.ok(state.stages.every((stage) => Object.keys(stage).every((key) => ["id", "status", "progress"].includes(key))));
});

test("workflow route hydrates count-only persistent state and the shell can reopen it", async () => {
  const [route, workspace, component] = await Promise.all([
    read("../app/api/workflow/route.ts"),
    read("../app/workspace.tsx"),
    read("../app/organization-progress.tsx"),
  ]);
  assert.match(route, /deriveWorkflowProgress/);
  assert.match(route, /SELECT COUNT\(\*\)/);
  assert.doesNotMatch(route, /original_json|SELECT\s+content|safeStatusMessage|reasoning|prompt/i);
  assert.match(workspace, /fetch\("\/api\/workflow"/);
  assert.match(workspace, /setWorkflowOpen\(true\)/);
  assert.match(workspace, /<WorkflowProgress/);
  assert.match(component, /data-safe-status/);
  assert.match(component, /Nothing is uploaded/);
  assert.match(component, /私密推理/);
});
