import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  chapterStoryPrivacyCandidates,
  parseStoryPrivacyAuthority,
  storyPrivacyAuthorityComplete,
  storyPrivacyCandidateResolved,
  StoryPrivacyRequestGate,
} from "../app/story-privacy-ui.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const authority = {
  workflowRunId: "run-current",
  sourceRevision: 3,
  activeStoryDigest: "a".repeat(64),
  candidateDigest: "b".repeat(64),
  status: "completed_with_candidates",
  candidates: [{
    id: "automatic",
    reviewState: "deterministic",
    title: "Deterministic removal",
    whyFlagged: "The final projection removes this value.",
    uncertaintyReason: null,
    releaseTargets: ["chapter-a::overview"],
    decision: null,
    decisionVersion: 0,
    decidedAt: null,
  }, {
    id: "cross-chapter",
    reviewState: "needs_confirmation",
    title: "Release identity",
    whyFlagged: "The same safe decision affects two Story targets.",
    uncertaintyReason: "Contributor intent cannot be derived deterministically.",
    releaseTargets: ["chapter-a::title", "chapter-b::overview"],
    decision: null,
    decisionVersion: 0,
    decidedAt: null,
  }],
};

test("Story Privacy UI accepts only the exact safe authority and affirmative completed-empty state", () => {
  assert.deepEqual(parseStoryPrivacyAuthority(authority), authority);
  assert.equal(storyPrivacyAuthorityComplete(authority), false);
  assert.equal(parseStoryPrivacyAuthority({ ...authority, privateOriginal: "PRIVATE_ORIGINAL" }), null);
  assert.equal(parseStoryPrivacyAuthority({ ...authority, sourceRevision: Number.MAX_SAFE_INTEGER + 1 }), null);
  const empty = {
    ...authority,
    candidateDigest: "c".repeat(64),
    status: "completed_empty",
    candidates: [],
  };
  assert.deepEqual(parseStoryPrivacyAuthority(empty), empty);
  assert.equal(storyPrivacyAuthorityComplete(empty), true);
  const preparationRequired = {
    ...empty,
    candidateDigest: "d".repeat(64),
    status: "preparation_required",
  };
  assert.deepEqual(parseStoryPrivacyAuthority(preparationRequired), preparationRequired);
  assert.equal(storyPrivacyAuthorityComplete(preparationRequired), false);
  assert.equal(parseStoryPrivacyAuthority({ ...empty, status: "completed_with_candidates" }), null);
});

test("cross-Chapter candidates remain one global identity while Chapter references use exact prefixes", () => {
  assert.deepEqual(chapterStoryPrivacyCandidates(authority, "chapter-a").map(({ id }) => id), [
    "automatic", "cross-chapter",
  ]);
  assert.deepEqual(chapterStoryPrivacyCandidates(authority, "chapter-b").map(({ id }) => id), ["cross-chapter"]);
  assert.deepEqual(chapterStoryPrivacyCandidates(authority, "chapter"), []);
});

test("an unrelated-Chapter pending candidate blocks the whole Story authority", () => {
  const globallyPending = {
    ...authority,
    candidates: [{ ...authority.candidates[0] }, {
      ...authority.candidates[1],
      id: "unrelated-pending",
      releaseTargets: ["chapter-b::overview"],
    }],
  };
  const chapterA = chapterStoryPrivacyCandidates(globallyPending, "chapter-a");
  assert.deepEqual(chapterA.map(({ id }) => id), ["automatic"]);
  assert.equal(chapterA.every(storyPrivacyCandidateResolved), true);
  assert.equal(storyPrivacyAuthorityComplete(globallyPending), false);
});

test("Story Privacy request epochs stay single-flight and suppress a slow replaced response", async () => {
  const gate = new StoryPrivacyRequestGate();
  const accepted = [];
  let resolveOld;
  let resolveCurrent;
  const oldAuthority = new Promise((resolve) => { resolveOld = resolve; });
  const currentAuthority = new Promise((resolve) => { resolveCurrent = resolve; });
  const oldTicket = gate.begin();
  assert.ok(oldTicket);
  assert.equal(gate.begin(), null, "a poll cannot overlap the active request");
  const oldCommit = oldAuthority.then((value) => {
    if (gate.isCurrent(oldTicket)) accepted.push(value);
    gate.finish(oldTicket);
  });
  const currentTicket = gate.begin(true);
  assert.ok(currentTicket);
  assert.equal(oldTicket.signal.aborted, true);
  const currentCommit = currentAuthority.then((value) => {
    if (gate.isCurrent(currentTicket)) accepted.push(value);
    gate.finish(currentTicket);
  });
  const replacement = {
    ...authority,
    sourceRevision: 4,
    activeStoryDigest: "d".repeat(64),
    candidateDigest: "e".repeat(64),
  };
  resolveCurrent(parseStoryPrivacyAuthority(replacement));
  await currentCommit;
  resolveOld(parseStoryPrivacyAuthority(authority));
  await oldCommit;
  assert.deepEqual(accepted, [replacement]);
  const retired = gate.begin();
  assert.ok(retired);
  gate.retire();
  assert.equal(retired.signal.aborted, true);
  assert.equal(gate.isCurrent(retired), false);
});

test("Release Preview source shows one pending decision without original reconstruction or product metadata", async () => {
  const component = await read("../app/story-privacy-review.tsx");
  assert.match(component, /Candidate \{resolved \+ 1\} of \{total\}/);
  assert.match(component, /Local original unavailable/);
  assert.match(component, /Why flagged/);
  assert.match(component, /Uncertainty/);
  assert.equal((component.match(/>Keep<\/button>/g) || []).length, 1);
  assert.equal((component.match(/>Redact<\/button>/g) || []).length, 1);
  assert.match(component, /Privacy preparation required/);
  assert.match(component, /Release and review completion stay paused/);
  assert.match(component, /authority\.status === "preparation_required"[\s\S]*authority\.status === "completed_empty"/);
  assert.doesNotMatch(component, /provider|model|confidence|recommendation|rewrite|creator|category|>Delete<|v\d/i);
});

test("Workspace hydrates Story Privacy separately, sends exact CAS, and never stores it in the Story session", async () => {
  const workspace = await read("../app/workspace.tsx");
  assert.match(workspace, /fetch\(`\/api\/story-privacy\?workflowRunId=\$\{encodeURIComponent\(scopedWorkflowRunId\)\}`/);
  const decision = workspace.slice(workspace.indexOf("const decideStoryPrivacy"), workspace.indexOf("const effectiveError"));
  assert.match(decision, /method:"PATCH"/);
  assert.match(decision, /workflowRunId:authority\.workflowRunId,[\s\S]*sourceRevision:authority\.sourceRevision,[\s\S]*activeStoryDigest:authority\.activeStoryDigest,[\s\S]*candidateDigest:authority\.candidateDigest,[\s\S]*expectedVersion:0,[\s\S]*decision/);
  assert.match(decision, /response\.status === 409[\s\S]*loadStoryPrivacy\("The authority changed while deciding[\s\S]*, true\)/);
  assert.equal((decision.match(/method:"PATCH"/g) || []).length, 1, "a conflict must not retry the mutation");
  assert.doesNotMatch(workspace, /setPrivacyDecisions|current\.privacyDecisions/);
  assert.match(workspace, /createStoryReviewSession\(workflowRunId,current\.chapterReviews,\{\}\)/);
  assert.match(workspace, /if \(!storyPrivacyReleaseReady\)[\s\S]*openGlobalStoryPrivacy\(\);[\s\S]*return;/);
  assert.match(workspace, /const polling = setInterval\([\s\S]*void loadStoryPrivacy\(\);[\s\S]*2000\);/);
  assert.match(workspace, /clearInterval\(polling\);[\s\S]*storyPrivacyRequests\.retire\(\);/);
  assert.match(workspace, /storyPrivacyReady=\{storyPrivacyReleaseReady\}/);
  assert.doesNotMatch(workspace, /activeChapterPrivacyCandidates\.every\(storyPrivacyCandidateResolved\)/);
});

test("source Privacy is decision-only and surfaces API failures", async () => {
  const [workspace, compare] = await Promise.all([
    read("../app/workspace.tsx"),
    read("../app/redaction-compare.tsx"),
  ]);
  const sourceDecision = workspace.slice(workspace.indexOf("async function decideRedaction"), workspace.indexOf("const [probes"));
  assert.match(sourceDecision, /body: JSON\.stringify\(\{ decision \}\)/);
  assert.match(sourceDecision, /if \(!response\.ok\) throw new Error/);
  assert.doesNotMatch(sourceDecision, /DELETE|category|status:/);
  assert.doesNotMatch(compare, /<select|onDelete|onUpdate|>Delete<|job\.model|span\.confidence|span\.created_by|span\.reason|v0\.1/);
  assert.match(compare, /review_state === "needs_confirmation"/);
  assert.match(compare, /Minimum local original/);
  assert.match(compare, /Release-safe projection/);
});

test("Chapter completion consumes safe global references while Insight cards retain their paragraph-owned layout", async () => {
  const [editor, css] = await Promise.all([
    read("../app/story-chapter-editor.tsx"),
    read("../app/globals.css"),
  ]);
  assert.match(editor, /storyPrivacyCandidates\.map/);
  assert.match(editor, /Open global Release Preview/);
  assert.match(editor, /disabled=\{applying \|\| !storyPrivacyReady\}/);
  assert.match(editor, /disabled=\{!storyPrivacyReady \|\| !canMarkChapterReady/);
  assert.match(css, /\.storyNarrativeRow\{display:grid;grid-template-columns:minmax\(0,720px\) minmax\(280px,360px\)/);
  assert.match(css, /@media\(max-width:1050px\)\{\.storyNarrativeRow\{grid-template-columns:minmax\(0,720px\)\}/);
  assert.match(css, /\.sourcePrivacyComparison\{display:grid;grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/);
  assert.match(css, /@media\(max-width:760px\)[^\n]*\.sourcePrivacyComparison\{grid-template-columns:minmax\(0,1fr\)\}/);
});
