import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ProjectAllSetRequestGate,
  projectAllSetPreferencesComplete,
} from "../app/project-all-set-ui.ts";

const workspace = await readFile(new URL("../app/workspace.tsx", import.meta.url), "utf8");

test("project All set sends one exact server-owned POST only after the durable Story barrier", () => {
  const action = workspace.slice(workspace.indexOf("const confirmProjectAllSet"), workspace.indexOf("const openDownloadReviewBlocker"));
  assert.match(action, /if \(!projectAllSetEligible \|\| projectAllSetConfirmed\)/);
  assert.match(action, /runDurableStoryReviewHandoff/);
  assert.match(action, /fetch\("\/api\/all-set",\{[\s\S]*method:"POST"/);
  assert.match(action, /body:JSON\.stringify\(\{workflowRunId,serverVersion,sourceRevision\}\)/);
  assert.doesNotMatch(action, /activeStoryDigest|candidateDigest|receipt|privacyDecisions|method:"GET"/i);
  assert.equal((action.match(/fetch\("\/api\/all-set"/g) || []).length, 1);
});

test("durable server progress is the only project All set confirmation and gates release", () => {
  assert.match(workspace, /const projectAllSetConfirmed = workflow\.allSetConfirmed === true/);
  assert.doesNotMatch(workspace, /setProjectAllSetConfirmed/);
  const download = workspace.slice(workspace.indexOf("const downloadReviewed"), workspace.indexOf("const ready ="));
  assert.match(download, /if \(!projectAllSetConfirmed\)[\s\S]*return;/);
  assert.match(workspace, /const projectReleaseReady = projectAllSetConfirmed && projectAllSetEligible/);
  assert.match(workspace, /disabled=\{!projectReleaseReady\}[\s\S]*?>Download HTML<\/button>/);
  assert.match(workspace, /disabled=\{!projectReleaseReady\}[\s\S]*?>Download ZIP<\/button>/);
  assert.match(workspace, /const refreshed=await loadCurrentWorkflow\(request\.signal\)/);
  assert.match(workspace, /refreshed\.allSetConfirmed !== true/);
  assert.match(workspace, /response\.status === 409 && scopedWorkflowRunId[\s\S]*fetch\("\/api\/workflow"/);
});

test("Chapter All set, Story Privacy, and explicit completed Preferences remain separate prerequisites", () => {
  assert.match(workspace, /projectAllSet:"Confirm ready for release"/);
  assert.doesNotMatch(workspace, /projectAllSet:"Project All set"/);
  assert.match(workspace, /allCurrentChaptersConfirmed[\s\S]*storyPrivacyReleaseReady[\s\S]*allCurrentPreferencesComplete/);
  assert.match(workspace, /chapterReviewCompletionBlockers\(state,completionContext\(chapter\.source\)\)/);
  assert.match(workspace, /projectAllSetPreferencesComplete\(probeRun, probes, bulkDecisions\)/);
  const completedZero = { status:"complete", stage:"preference", generated:0, set_aside:0 };
  assert.equal(projectAllSetPreferencesComplete(completedZero, [], []), true);
  assert.equal(projectAllSetPreferencesComplete(null, [], []), false);
  assert.equal(projectAllSetPreferencesComplete(completedZero, [{ answered_at:null, answer_choice:null }], []), false);
  assert.equal(projectAllSetPreferencesComplete(completedZero, [], [{ answered_at:null, answer:null }]), false);
});

test("project All set request epochs are single-flight, abortable, and retire stale success", () => {
  const gate = new ProjectAllSetRequestGate();
  const first = gate.begin("run-one");
  assert.ok(first);
  assert.equal(gate.begin("run-one"), null, "a second click cannot create another request");
  assert.equal(gate.isCurrent(first), true);
  gate.retire();
  assert.equal(first.signal.aborted, true);
  assert.equal(gate.isCurrent(first), false);
  const replacement = gate.begin("run-two");
  assert.ok(replacement);
  assert.equal(gate.isCurrent(replacement), true);
  gate.finish(replacement);
  assert.equal(gate.isCurrent(replacement), false);
});

test("a 409 rehydrates without retry and requires another explicit click", () => {
  const action = workspace.slice(workspace.indexOf("const confirmProjectAllSet"), workspace.indexOf("const openDownloadReviewBlocker"));
  assert.match(action, /if \(response\.status===409\) \{[\s\S]*await rehydrateCurrentAuthority\(\);[\s\S]*return;/);
  assert.match(action, /storyPersistenceRef\.current\?\.invalidate\(\)/);
  assert.match(action, /setStorySessionReadyRunId\(""\)/);
  assert.match(action, /loadCurrentWorkflow\(request\.signal\)/);
  assert.match(action, /loadStoryPrivacy\("Release authority changed\.[\s\S]*true\)/);
  assert.match(action, /loadProbes\(request\.signal\)/);
  assert.equal((action.match(/fetch\("\/api\/all-set"/g) || []).length, 1, "the mutation is never retried");
});
