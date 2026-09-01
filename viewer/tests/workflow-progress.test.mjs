import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseWorkspaceStatus } from "../lib/workspace-types.ts";
import {
  WORKFLOW_STAGE_IDS,
  deriveWorkflowProgress,
  startWorkflowPolling,
  withHumanReviewProgress,
} from "../lib/workflow-progress.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("organization polling accepts only complete structured status payloads", () => {
  const valid = {
    status: "running", stage: "classify", completed: 1, total: 2,
    percent: 50, documentCount: 1, warnings: [],
  };
  assert.deepEqual(parseWorkspaceStatus(valid), valid);
  assert.equal(parseWorkspaceStatus({ error: "server failed" }), null);
  assert.equal(parseWorkspaceStatus({ ...valid, status: "unexpected" }), null);
  assert.equal(parseWorkspaceStatus({ ...valid, completed: "1" }), null);
});

const facts = (overrides = {}) => ({
  workflowRunId: "reviewed-run",
  collectionFinalized: true,
  documentCount: 2,
  itemCount: 10,
  organizedItemCount: 0,
  organizationStatus: "running",
  redactionStatus: null,
  storyGenerationStatus: "not_started",
  storyGenerationCompleted: 0,
  storyGenerationTotal: 0,
  updatedAt: "2026-08-23T10:00:00.000Z",
  ...overrides,
});

test("workflow progress derives completed, current, next, waiting, and blocked states from persistent facts", () => {
  const boundary = deriveWorkflowProgress(facts({
    targetConfirmed: true, collectionFinalized: false,
    documentCount: 0, itemCount: 0, organizationStatus: null,
  }));
  assert.equal(boundary.currentStageId, "collect");
  assert.equal(boundary.safeStatusCode, "target_working_folder_confirmed");
  assert.equal(boundary.requiresHumanAction, false);

  const collecting = deriveWorkflowProgress(facts({
    targetConfirmed: true, collectionStatus: "running", collectionCompleted: 3,
    collectionTotal: 8, collectionFinalized: false,
    documentCount: 0, itemCount: 0, organizationStatus: null,
  }));
  assert.equal(collecting.currentStageId, "collect");
  assert.deepEqual(collecting.stages[0].progress, { completed: 3, total: 8 });

  const empty = deriveWorkflowProgress(facts({
    targetConfirmed: true, collectionStatus: "pending", collectionCompleted: 0,
    collectionTotal: 0, documentCount: 0, itemCount: 0, organizationStatus: null,
  }));
  assert.equal(empty.status, "blocked");
  assert.equal(empty.blockedReasonCode, "COLLECTION_EMPTY");

  const collected = deriveWorkflowProgress(facts({
    targetConfirmed: true, collectionStatus: "failed", collectionCompleted: 0,
    collectionTotal: 0, documentCount: 2, itemCount: 10, organizationStatus: null,
  }));
  assert.equal(collected.currentStageId, "organize");
  assert.equal(collected.completedStages, 1);

  const organizing = deriveWorkflowProgress(facts({ organizedItemCount: 4 }));
  assert.equal(organizing.currentStageId, "organize");
  assert.deepEqual(organizing.stages.find((stage) => stage.id === "organize")?.progress, { completed: 4, total: 10 });
  assert.equal(organizing.stages.find((stage) => stage.id === "collect")?.status, "complete");
  assert.equal(organizing.stages.find((stage) => stage.id === "privacy")?.status, "up_next");

  const blocked = deriveWorkflowProgress(facts({ organizationStatus: "failed" }));
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blockedReasonCode, "ORGANIZATION_FAILED");

  const privacy = deriveWorkflowProgress(facts({ organizedItemCount: 10, organizationStatus: "complete", redactionStatus: "running" }));
  assert.equal(privacy.currentStageId, "privacy");
  assert.equal(privacy.safeStatusCode, "checking_privacy");

  const building = deriveWorkflowProgress(facts({
    organizedItemCount: 10, organizationStatus: "complete", redactionStatus: "complete",
    storyGenerationStatus: "running", storyGenerationCompleted: 8, storyGenerationTotal: 14,
  }));
  assert.equal(building.currentStageId, "story");
  assert.equal(building.requiresHumanAction, false);
  assert.deepEqual(building.stages.find((stage) => stage.id === "story")?.progress, { completed: 8, total: 14 });

  const reviewing = deriveWorkflowProgress(facts({
    organizedItemCount: 10, organizationStatus: "complete", redactionStatus: "complete",
    storyGenerationStatus: "ready_for_human_review", storyGenerationCompleted: 14,
    storyGenerationTotal: 14, storySourceSchema: "oxygen.story",
    storySessionSchema: "oxygen.story-review-session",
  }));
  assert.equal(reviewing.currentStageId, "review");
  assert.equal(reviewing.status, "waiting");
  assert.equal(reviewing.requiresHumanAction, true);
  assert.deepEqual(reviewing.stages.map((stage) => stage.id), WORKFLOW_STAGE_IDS);

  assert.equal(withHumanReviewProgress(reviewing, 14, 14).currentStageId, "review",
    "Chapter count alone is not project release-confirmation authority");
  const handoff = withHumanReviewProgress(reviewing, 14, 14, true);
  assert.equal(handoff.currentStageId, "handoff");
  assert.equal(handoff.safeStatusCode, "release_handoff_ready");
  assert.equal(handoff.completedStages, 5);
});

test("Collection advances only from an exact finalized corpus", () => {
  for (const collectionStatus of ["pending", "complete", "failed"]) {
    const progress = deriveWorkflowProgress(facts({
      targetConfirmed: true,
      collectionStatus,
      collectionFinalized: false,
      documentCount: 2,
      itemCount: 10,
    }));
    assert.equal(progress.currentStageId, "collect");
    assert.equal(progress.completedStages, 0);
    assert.equal(progress.status, collectionStatus === "failed" ? "blocked" : "running");
  }

  for (const collectionStatus of ["pending", "running", "complete", "failed"]) {
    const progress = deriveWorkflowProgress(facts({ collectionStatus }));
    assert.equal(progress.currentStageId, "organize");
    assert.equal(progress.completedStages, 1);
  }

  const empty = deriveWorkflowProgress(facts({
    collectionStatus: "complete",
    documentCount: 0,
    itemCount: 0,
    organizedItemCount: 0,
    organizationStatus: null,
  }));
  assert.equal(empty.blockedReasonCode, "COLLECTION_EMPTY");
});

test("workflow progress is a strict sanitized operational projection", () => {
  const state = deriveWorkflowProgress(facts({
    organizedItemCount: 10, organizationStatus: "complete", redactionStatus: "complete",
    storyGenerationStatus: "ready_for_human_review",
    storySourceSchema: "oxygen.story", storySessionSchema: "oxygen.story-review-session",
  }));
  assert.deepEqual(Object.keys(state).sort(), [
    "completedStages", "currentStageId", "releaseConfirmed", "requiresHumanAction", "safeStatusCode", "stages",
    "status", "storyGenerationStatus", "storySessionSchema", "storySourceSchema",
    "totalStages", "updatedAt", "workflowRunId",
  ]);
  assert.equal(state.storySourceSchema, "oxygen.story");
  assert.equal(state.storySessionSchema, "oxygen.story-review-session");
  const mixed = deriveWorkflowProgress(facts({
    organizedItemCount: 10, organizationStatus: "complete", redactionStatus: "complete",
    storyGenerationStatus: "ready_for_human_review",
    storySourceSchema: "oxygen.story", storySessionSchema: "wrong-session-schema",
  }));
  assert.equal(mixed.storySourceSchema, null);
  assert.equal(mixed.storySessionSchema, null);
  const serialized = JSON.stringify(state);
  assert.doesNotMatch(serialized, /reasoning|chain.of.thought|prompt|tool.?arg|private.?message|story.?payload|evidence.?payload|removed.?content/i);
  assert.ok(state.stages.every((stage) => Object.keys(stage).every((key) => ["id", "status", "progress"].includes(key))));
});

test("activated Story review rehydrates Preferences once without widening idle polling", async () => {
  const workspace = await read("../app/workspace.tsx");
  const lifecycle = workspace.slice(
    workspace.indexOf("const [probes"),
    workspace.indexOf("async function answerProbe"),
  );
  const rehydration = lifecycle.slice(
    lifecycle.indexOf("const readyRunId"),
    lifecycle.indexOf("useEffect(() => {", lifecycle.indexOf("const readyRunId") + 1),
  );
  const initialFetch = lifecycle.slice(
    lifecycle.indexOf("const initial ="),
    lifecycle.indexOf("useEffect(() => {", lifecycle.indexOf("const initial =") + 1),
  );
  const polling = lifecycle.slice(lifecycle.indexOf("if (probeRunStatus"));

  assert.match(lifecycle, /useRef\(storyReviewReady \? scopedWorkflowRunId : ""\)/);
  assert.match(rehydration, /const readyRunId = storyReviewReady \? scopedWorkflowRunId : "";/);
  assert.match(rehydration, /if \(!readyRunId \|\| preferenceReadyRunRef\.current === readyRunId\) return;/);
  assert.match(rehydration, /const refresh = setTimeout\(\(\) => \{/);
  assert.match(rehydration, /preferenceReadyRunRef\.current = readyRunId;/);
  assert.match(rehydration, /void loadProbes\(\);/);
  assert.match(rehydration, /return \(\) => clearTimeout\(refresh\);/);
  assert.equal((rehydration.match(/loadProbes\(\)/g) || []).length, 1);
  assert.doesNotMatch(rehydration, /setInterval/);
  assert.equal((initialFetch.match(/loadProbes\(\)/g) || []).length, 1);
  assert.doesNotMatch(initialFetch, /probeRunStatus|setInterval/);
  assert.match(polling, /if \(probeRunStatus !== "running"\) return;[\s\S]*setInterval\(\(\) => \{ void loadProbes\(\); \}, 4000\)/);
  assert.doesNotMatch(polling, /setTimeout/);
});

test("workflow route hydrates count-only persistent state and the shell can reopen it", async () => {
  const [route, loader, page, workspace, component, css, db] = await Promise.all([
    read("../app/api/workflow/route.ts"),
    read("../lib/workflow-progress-server.ts"),
    read("../app/page.tsx"),
    read("../app/workspace.tsx"),
    read("../app/organization-progress.tsx"),
    read("../app/globals.css"),
    read("../db/index.ts"),
  ]);
  assert.match(route, /loadWorkflowProgress/);
  assert.match(loader, /deriveWorkflowProgress/);
  assert.match(loader, /SELECT COUNT\(\*\)/);
  assert.match(route, /export async function POST/);
  assert.match(route, /workflow_runs/);
  assert.match(route, /validateStoryActivationAuthority/);
  assert.match(route, /readSemanticManifestAuthority/);
  assert.match(route, /coverageManifest/);
  assert.match(route, /preparationManifest/);
  assert.match(route, /readPreferenceBatchAuthority/);
  assert.match(route, /validateStoryPreparationManifest/);
  assert.match(route, /story_source_revision/);
  assert.match(route, /collectionFinalized: true/);
  assert.match(route, /BODY_KEYS/);
  assert.doesNotMatch(`${route}\n${loader}`, /original_json|SELECT\s+content|safeStatusMessage|reasoning|prompt/i);
  assert.doesNotMatch(route, /target_path|working_folder|session_name|story_payload|evidence_payload|memberIds|sourceBodies|excludedEvents/i);
  assert.match(db, /CREATE TABLE IF NOT EXISTS workflow_runs/);
  assert.doesNotMatch(db, /target_path|working_folder|session_name|free_form|payload_json/i);
  assert.match(workspace, /fetch\(`\/api\/workflow\$\{query\}`/);
  assert.match(page, /await loadWorkspaceBootstrap\(\)/);
  assert.match(page, /initialWorkflow=\{initial\.workflow\}/);
  assert.match(page, /initialStorySessionReadyRunId=\{initial\.storySessionReadyRunId\}/);
  assert.match(loader, /if \(!isStoryReviewReady\(workflow\)\)/);
  assert.match(workspace, /fetch\(`\/api\/story-review-session\?workflowRunId=/);
  assert.match(workspace, /hydrateStoryReviewSession/);
  assert.match(workspace, /runDurableStoryReviewHandoff/);
  assert.match(workspace, /setWorkflowOpen\(true\)/);
  assert.match(workspace, /<WorkflowProgress/);
  assert.match(workspace, /isStoryReviewReady\(workflow\)/);
  assert.match(workspace, /selectViewerChapters/);
  assert.match(component, /data-safe-status/);
  assert.match(component, /Nothing is uploaded/);
  assert.match(component, /Collect project history/);
  assert.match(component, /私密推理/);
  assert.match(component, /const determinate = Boolean\(currentProgress && currentProgress\.total > 0\)/);
  assert.doesNotMatch(component, /completedPercent|state\.completedStages \/ state\.totalStages/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)[\s\S]*\.progressTrack\.indeterminate div\{width:100%;animation:none/);
});

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

test("workflow polling remains single-flight after a response exceeds two seconds", async () => {
  const scheduled = [];
  const response = deferred();
  let elapsedMs = 0;
  let inFlight = 0;
  let maximumInFlight = 0;
  let completed = 0;
  const lifecycle = startWorkflowPolling(async ({ signal }) => {
    inFlight += 1;
    maximumInFlight = Math.max(maximumInFlight, inFlight);
    try {
      await response.promise;
      if (!signal.aborted) completed += 1;
    } finally {
      inFlight -= 1;
    }
  }, {
    intervalMs: 2_000,
    schedule: (callback, delay) => {
      assert.equal(delay, 2_000);
      scheduled.push(callback);
      return callback;
    },
    cancel: (handle) => {
      const index = scheduled.indexOf(handle);
      if (index >= 0) scheduled.splice(index, 1);
    },
  });

  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  await Promise.resolve();
  elapsedMs = 2_500;
  assert.ok(elapsedMs > 2_000);
  assert.equal(inFlight, 1);
  assert.equal(scheduled.length, 0, "no next timeout exists while the delayed poll is active");
  response.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, 1);
  assert.equal(maximumInFlight, 1);
  assert.equal(scheduled.length, 1, "the next poll is scheduled only after completion");
  lifecycle.retire();
  assert.equal(scheduled.length, 0);
});

test("workflow polling retirement aborts the active epoch and prevents stale updates", async () => {
  const scheduled = [];
  const response = deferred();
  let staleUpdates = 0;
  let activeSignal = null;
  const lifecycle = startWorkflowPolling(async ({ signal }) => {
    activeSignal = signal;
    await response.promise;
    if (!signal.aborted) staleUpdates += 1;
  }, {
    schedule: (callback) => { scheduled.push(callback); return callback; },
    cancel: (handle) => {
      const index = scheduled.indexOf(handle);
      if (index >= 0) scheduled.splice(index, 1);
    },
  });
  scheduled.shift()();
  await Promise.resolve();
  lifecycle.retire();
  assert.equal(activeSignal.aborted, true);
  response.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(staleUpdates, 0);
  assert.equal(scheduled.length, 0);
});
