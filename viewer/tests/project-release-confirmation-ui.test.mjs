import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import {
  ProjectReleaseConfirmationRequestGate,
  projectReleaseConfirmationPreferencesComplete,
} from "../app/project-release-confirmation-ui.ts";

const workspace = await readFile(new URL("../app/workspace.tsx", import.meta.url), "utf8");

test("project release confirmation sends one exact server-owned POST only after the durable Story barrier", () => {
  const action = workspace.slice(workspace.indexOf("const confirmProjectRelease"), workspace.indexOf("const openDownloadReviewBlocker"));
  assert.match(action, /if \(!releaseConfirmationEligible \|\| releaseConfirmed\)/);
  assert.match(action, /runDurableStoryReviewHandoff/);
  assert.match(action, /fetch\("\/api\/release-confirmation",\{[\s\S]*method:"POST"/);
  assert.match(action, /body:JSON\.stringify\(\{workflowRunId,serverVersion,sourceRevision\}\)/);
  assert.doesNotMatch(action, /activeStoryDigest|candidateDigest|receipt|privacyDecisions|method:"GET"/i);
  assert.equal((action.match(/fetch\("\/api\/release-confirmation"/g) || []).length, 1);
});

test("durable server progress is the only project release confirmation and gates release", () => {
  assert.match(workspace, /const releaseConfirmed = workflow\.releaseConfirmed === true/);
  assert.doesNotMatch(workspace, /setReleaseConfirmed/);
  const download = workspace.slice(workspace.indexOf("const downloadReviewed"), workspace.indexOf("const ready ="));
  assert.match(download, /if \(!releaseConfirmed\)[\s\S]*return;/);
  assert.match(workspace, /const projectReleaseReady = releaseConfirmed && releaseConfirmationEligible/);
  assert.match(workspace, /disabled=\{!projectReleaseReady\}[\s\S]*?>Download HTML<\/button>/);
  assert.match(workspace, /disabled=\{!projectReleaseReady\}[\s\S]*?>Download ZIP<\/button>/);
  assert.match(workspace, /const refreshed=await loadCurrentWorkflow\(request\.signal\)/);
  assert.match(workspace, /refreshed\.releaseConfirmed !== true/);
  assert.match(workspace, /response\.status === 409 && scopedWorkflowRunId[\s\S]*fetch\("\/api\/workflow"/);
});

test("Chapter All set, Story Privacy, and explicit completed Preferences remain separate prerequisites", () => {
  assert.match(workspace, /confirmRelease:"Confirm ready for release"/);
  assert.match(workspace, /allCurrentChaptersConfirmed[\s\S]*storyPrivacyReleaseReady[\s\S]*allCurrentPreferencesComplete/);
  assert.match(workspace, /chapterReviewCompletionBlockers\(state,completionContext\(chapter\.source\)\)/);
  assert.match(workspace, /projectReleaseConfirmationPreferencesComplete\(probeRun, probes, bulkDecisions\)/);
  const completedZero = { status:"complete", stage:"preference", generated:0, set_aside:0 };
  assert.equal(projectReleaseConfirmationPreferencesComplete(completedZero, [], []), true);
  assert.equal(projectReleaseConfirmationPreferencesComplete(null, [], []), false);
  assert.equal(projectReleaseConfirmationPreferencesComplete(completedZero, [{ answered_at:null, answer_choice:null }], []), false);
  assert.equal(projectReleaseConfirmationPreferencesComplete(completedZero, [], [{ answered_at:null, answer:null }]), false);
});

test("project release confirmation request epochs are single-flight, abortable, and retire stale success", () => {
  const gate = new ProjectReleaseConfirmationRequestGate();
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
  const action = workspace.slice(workspace.indexOf("const confirmProjectRelease"), workspace.indexOf("const openDownloadReviewBlocker"));
  assert.match(action, /if \(response\.status===409\) \{[\s\S]*await rehydrateCurrentAuthority\(\);[\s\S]*return;/);
  assert.match(action, /storyPersistenceRef\.current\?\.invalidate\(\)/);
  assert.match(action, /setStorySessionReadyRunId\(""\)/);
  assert.match(action, /loadCurrentWorkflow\(request\.signal\)/);
  assert.match(action, /loadStoryPrivacy\("Release authority changed\.[\s\S]*true\)/);
  assert.match(action, /loadProbes\(request\.signal\)/);
  assert.equal((action.match(/fetch\("\/api\/release-confirmation"/g) || []).length, 1, "the mutation is never retried");
});

test("project release confirmation has no legacy production, route, type, or test namespace", async () => {
  const forbidden = [
    "project_" + "all_set",
    "project-" + "all-set",
    "Project" + "AllSet",
    "/api/" + "all-set",
    "allSet" + "Confirmed",
    "ALL_SET_" + "AUTHORITY_STALE",
  ];
  const files = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (["node_modules", ".next"].includes(entry.name)) continue;
      const target = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
      if (entry.isDirectory()) await visit(target);
      else if (/\.(?:ts|tsx|mjs)$/.test(entry.name)) files.push(target);
    }
  };
  await visit(new URL("../", import.meta.url));
  const residuals = [];
  for (const file of files) {
    const contents = await readFile(file, "utf8");
    for (const term of forbidden) {
      if (contents.includes(term)) residuals.push(`${decodeURIComponent(file.pathname)}: ${term}`);
    }
  }
  assert.deepEqual(residuals, []);
});
