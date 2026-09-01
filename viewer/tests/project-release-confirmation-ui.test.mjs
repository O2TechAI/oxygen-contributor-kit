import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import {
  PROJECT_RELEASE_AGENT_RESUME_INSTRUCTION,
  ProjectReleaseConfirmationRequestGate,
  ProjectReleaseDownloadRequestGate,
  projectReleaseActionBlocked,
  projectReleaseActionBlockers,
  projectReleaseConfirmationPreferencesComplete,
} from "../app/project-release-confirmation-ui.ts";

const workspace = await readFile(new URL("../app/workspace.tsx", import.meta.url), "utf8");

test("project release confirmation sends one exact server-owned POST only after the durable Story barrier", () => {
  const action = workspace.slice(workspace.indexOf("const confirmProjectRelease"), workspace.indexOf("const openDownloadReviewBlocker"));
  assert.match(action, /projectReleaseActionBlocked\(blockers\)[\s\S]*openReleaseBlockerDialog\(blockers\)[\s\S]*return;/);
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
  assert.match(download, /projectReleaseActionBlocked\(blockers\)[\s\S]*openReleaseBlockerDialog\(blockers\)[\s\S]*return;/);
  assert.match(workspace, /Download HTML<\/button>/);
  assert.match(workspace, /Download ZIP<\/button>/);
  assert.match(workspace, /disabled=\{releaseActionsBusy\} aria-disabled=\{projectReleaseActionBlocked\(htmlReleaseBlockers\)\}/);
  assert.match(workspace, /disabled=\{releaseActionsBusy\} aria-disabled=\{projectReleaseActionBlocked\(zipReleaseBlockers\)\}/);
  assert.match(workspace, /storyPersistenceStatus === "dirty" \|\| storyPersistenceStatus === "saving"/);
  assert.match(workspace, /confirm-project-release[^\n]*\.focus\(\{preventScroll:true\}\)/);
  assert.match(workspace, /const refreshed=await loadCurrentWorkflow\(request\.signal\)/);
  assert.match(workspace, /refreshed\.releaseConfirmed !== true/);
  assert.match(workspace, /response\.status === 409 && scopedWorkflowRunId[\s\S]*fetch\("\/api\/workflow"/);
});

test("release blocker dialog takes focus and restores its invoking top action on close", () => {
  const lifecycle=workspace.slice(workspace.indexOf("const openReleaseBlockerDialog"),
    workspace.indexOf("const confirmProjectRelease"));
  assert.match(lifecycle,/const activeElement=document\.activeElement[\s\S]*activeElement instanceof HTMLElement[\s\S]*setReleaseBlockers\(blockers\)/u);
  assert.match(lifecycle,/const returnFocus=restoreFocus[\s\S]*setReleaseBlockers\(null\)[\s\S]*returnFocus\.focus\(\{preventScroll:true\}\)/u);
  assert.match(workspace,/if \(releaseBlockers\) releaseBlockerDialogRef\.current\?\.focus\(\{preventScroll:true\}\)/u);
  assert.match(workspace,/ref=\{releaseBlockerDialogRef\}[^\n]*role="dialog"[^\n]*tabIndex=\{-1\}/u);
});

test("Chapter All set, Story Privacy, and explicit completed Preferences remain separate prerequisites", () => {
  assert.match(workspace, /confirmRelease:"Confirm ready for release"/);
  assert.match(workspace, /chapterGroups:currentDownloadReviewBlockerGroups\(\)[\s\S]*storyPrivacy:storyPrivacyReleaseState[\s\S]*preferences:preferenceReleaseState/);
  assert.match(workspace, /chapterReviewCompletionBlockers\(state,completionContext\(chapter\.source\)\)/);
  assert.match(workspace, /projectReleaseConfirmationPreferencesComplete\(probeRun, probes, bulkDecisions\)/);
  const completedZero = { status:"complete", stage:"preference", generated:0, set_aside:0 };
  assert.equal(projectReleaseConfirmationPreferencesComplete(completedZero, [], []), true);
  assert.equal(projectReleaseConfirmationPreferencesComplete(null, [], []), false);
  assert.equal(projectReleaseConfirmationPreferencesComplete(completedZero, [{ answered_at:null, answer_choice:null }], []), false);
  assert.equal(projectReleaseConfirmationPreferencesComplete(completedZero, [], [{ answered_at:null, answer:null }]), false);
});

test("release action preflight exposes safe complete diagnostics and zero-or-one request behavior", () => {
  const chapterGroups=[{
    project:"safe-project",chapterKey:"chapter-one",
    blockers:[{code:"chapter_not_confirmed",targetKind:"chapter"}],
  }];
  const blocked=projectReleaseActionBlockers({
    action:"download_html",
    chapterGroups,
    storyPrivacy:"preparation_required",
    preferences:"stale",
    reviewAuthorityCurrent:false,
    releaseConfirmed:false,
  });
  assert.equal(projectReleaseActionBlocked(blocked),true);
  assert.deepEqual(blocked.authority.map(({code,destination})=>({code,destination})),[
    {code:"story_privacy_preparation_required",destination:"release_preview"},
    {code:"preference_stale",destination:"preferences"},
    {code:"review_authority_mismatch",destination:"story_review"},
    {code:"release_confirmation_missing",destination:"confirm_release"},
  ]);
  assert.equal(blocked.requiresAgentRecovery,true);
  assert.doesNotMatch(JSON.stringify(blocked),/title|original|excerpt/u);
  assert.doesNotMatch(PROJECT_RELEASE_AGENT_RESUME_INSTRUCTION,/workflowRunId|serverVersion|sourceRevision/u);

  const remainingStates=[
    ["unresolved","complete","story_privacy_unresolved"],
    ["unavailable","complete","story_privacy_unavailable"],
    ["complete","unanswered","preference_unanswered"],
    ["complete","missing","preference_missing"],
  ];
  for (const [storyPrivacy,preferences,code] of remainingStates) {
    const projection=projectReleaseActionBlockers({
      action:"confirm",chapterGroups:[],storyPrivacy,preferences,
      reviewAuthorityCurrent:true,releaseConfirmed:false,
    });
    assert.deepEqual(projection.authority.map((blocker)=>blocker.code),[code]);
  }

  let requests=0;
  const click=(projection) => {
    if (projectReleaseActionBlocked(projection)) return;
    requests+=1;
  };
  click(blocked);
  assert.equal(requests,0);
  const eligible=projectReleaseActionBlockers({
    action:"confirm",chapterGroups:[],storyPrivacy:"complete",preferences:"complete",
    reviewAuthorityCurrent:true,releaseConfirmed:false,
  });
  click(eligible);
  assert.equal(requests,1);
});

test("download request gate admits one eligible action until the handoff settles", () => {
  const gate=new ProjectReleaseDownloadRequestGate();
  assert.equal(gate.begin("download_html"),true);
  assert.equal(gate.begin("download_html"),false);
  assert.equal(gate.begin("download_zip"),false);
  gate.finish("download_html");
  assert.equal(gate.begin("download_zip"),true);
  gate.retire();
  assert.equal(gate.begin("download_html"),true);
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
  assert.match(action, /storyPersistence\.invalidate\(\)/);
  assert.match(action, /setStorySessionReadyRunId\(""\)/);
  assert.match(action, /loadCurrentWorkflow\(request\.signal\)/);
  assert.match(action, /loadStoryPrivacy\("Release authority changed\.[\s\S]*true\)/);
  assert.match(action, /loadProbes\(request\.signal\)/);
  assert.equal((action.match(/fetch\("\/api\/release-confirmation"/g) || []).length, 1, "the mutation is never retried");
});

test("project release confirmation is the sole production, route, type, and test namespace", async () => {
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
