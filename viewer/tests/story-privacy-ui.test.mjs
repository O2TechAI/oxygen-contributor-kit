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
const decidedAt = "2036-01-01T00:00:00.000Z";
const target = (targetId, originalText, { pending = false, category = "person-name" } = {}) => {
  const proposedText = originalText.replace("Alice", "Person A");
  return {
    targetId,
    targetContentDigest: "f".repeat(64),
    originalText,
    proposedText,
    selectedText: pending ? null : proposedText,
    edited: false,
    occurrences: originalText.includes("Alice") ? [{
      originalStartOffset: 0, originalEndOffset: 5,
      proposalStartOffset: 0, proposalEndOffset: 8,
      category, originalText: "Alice", proposedText: "Person A",
      canPublish: category !== "credential", isPublic: false,
    }] : [],
    decidedAt: pending ? null : decidedAt,
  };
};

const authority = {
  workflowRunId: "run-current",
  sourceRevision: 3,
  activeStoryDigest: "a".repeat(64),
  authorityDigest: "b".repeat(64),
  status: "completed_with_candidates",
  candidates: [{
    id: "automatic",
    reviewState: "deterministic",
    title: "Deterministic anonymization",
    whyFlagged: "The Agent proposal removes this value.",
    uncertaintyReason: null,
    releaseTargets: ["chapter-a::overview"],
    resolved: true,
  }, {
    id: "cross-chapter",
    reviewState: "needs_confirmation",
    title: "Release identity",
    whyFlagged: "The same safe choice affects two Story targets.",
    uncertaintyReason: "Contributor intent cannot be derived deterministically.",
    releaseTargets: ["chapter-a::title", "chapter-b::overview"],
    resolved: false,
  }],
  targets: [
    target("chapter-a::overview", "Alice overview"),
    target("chapter-a::title", "Alice title", { pending:true }),
    target("chapter-b::overview", "Alice outcome"),
  ],
};

const clone = (value) => structuredClone(value);

test("Story Privacy UI accepts exact target authority and total completed-empty state", () => {
  assert.deepEqual(parseStoryPrivacyAuthority(authority), authority);
  assert.equal(storyPrivacyAuthorityComplete(authority), false);
  assert.equal(parseStoryPrivacyAuthority({ ...authority, privateOriginal:"PRIVATE_ORIGINAL" }), null);
  assert.equal(parseStoryPrivacyAuthority({ ...authority, sourceRevision:Number.MAX_SAFE_INTEGER + 1 }), null);

  const empty = {
    ...authority,
    authorityDigest: "c".repeat(64),
    status: "completed_empty",
    candidates: [],
    targets: authority.targets.map((value) => ({
      ...value,
      proposedText: value.originalText,
      selectedText: value.originalText,
      occurrences: [],
      decidedAt,
    })),
  };
  assert.deepEqual(parseStoryPrivacyAuthority(empty), empty);
  assert.equal(storyPrivacyAuthorityComplete(empty), true);
  const preparationRequired = { ...authority, authorityDigest:"d".repeat(64), status:"preparation_required" };
  assert.deepEqual(parseStoryPrivacyAuthority(preparationRequired), preparationRequired);
  assert.equal(storyPrivacyAuthorityComplete(preparationRequired), false);
  const contractRefresh = {
    ...preparationRequired,
    authorityDigest: "e".repeat(64),
    candidates: [],
    targets: [],
  };
  assert.deepEqual(parseStoryPrivacyAuthority(contractRefresh), contractRefresh);
  assert.equal(storyPrivacyAuthorityComplete(contractRefresh), false);
  assert.equal(parseStoryPrivacyAuthority({ ...empty, status:"completed_with_candidates" }), null);
});

test("parser rejects inconsistent choices, mappings, candidate union, and credentials", () => {
  const cases = [];
  const unresolvedClaim = clone(authority);
  unresolvedClaim.candidates[1].resolved = true;
  cases.push(unresolvedClaim);
  const missingTarget = clone(authority);
  missingTarget.targets.pop();
  cases.push(missingTarget);
  const missingMapping = clone(authority);
  missingMapping.targets[2].proposedText = missingMapping.targets[2].originalText;
  missingMapping.targets[2].selectedText = missingMapping.targets[2].originalText;
  missingMapping.targets[2].occurrences = [];
  cases.push(missingMapping);
  const changedGap = clone(authority);
  changedGap.targets[0].proposedText += " changed outside mapping";
  changedGap.targets[0].selectedText = changedGap.targets[0].proposedText;
  cases.push(changedGap);
  const overlap = clone(authority);
  overlap.targets[0].occurrences.push({ ...overlap.targets[0].occurrences[0] });
  cases.push(overlap);
  const invalidCategory = clone(authority);
  invalidCategory.targets[0].occurrences[0].category = "Person Name";
  cases.push(invalidCategory);
  const nullEdited = clone(authority);
  nullEdited.targets[1].edited = true;
  cases.push(nullEdited);
  const nullPublic = clone(authority);
  nullPublic.targets[1].occurrences[0].isPublic = true;
  cases.push(nullPublic);
  const publicCredential = clone(authority);
  publicCredential.targets[0].occurrences[0].category = "credential";
  publicCredential.targets[0].occurrences[0].canPublish = false;
  publicCredential.targets[0].occurrences[0].isPublic = true;
  cases.push(publicCredential);
  const nullTimestamp = clone(authority);
  nullTimestamp.targets[1].decidedAt = decidedAt;
  cases.push(nullTimestamp);
  for (const value of cases) assert.equal(parseStoryPrivacyAuthority(value), null);
});

test("cross-Chapter metadata stays global while an unrelated pending target blocks release", () => {
  assert.deepEqual(chapterStoryPrivacyCandidates(authority, "chapter-a").map(({ id }) => id), [
    "automatic", "cross-chapter",
  ]);
  assert.deepEqual(chapterStoryPrivacyCandidates(authority, "chapter-b").map(({ id }) => id), ["cross-chapter"]);
  assert.deepEqual(chapterStoryPrivacyCandidates(authority, "chapter"), []);

  const globallyPending = {
    ...authority,
    candidates: [authority.candidates[0], {
      id: "unrelated-pending", reviewState: "needs_confirmation", title: "Other Chapter",
      whyFlagged: "A separate target needs a choice.", uncertaintyReason: "Confirm it.",
      releaseTargets: ["chapter-b::overview"], resolved: false,
    }],
    targets: [authority.targets[0], {
      ...authority.targets[1], proposedText:authority.targets[1].originalText,
      selectedText:authority.targets[1].originalText, occurrences:[], decidedAt,
    }, target("chapter-b::overview", "Alice outcome", { pending:true })],
  };
  assert.ok(parseStoryPrivacyAuthority(globallyPending));
  const chapterA = chapterStoryPrivacyCandidates(globallyPending, "chapter-a");
  assert.deepEqual(chapterA.map(({ id }) => id), ["automatic"]);
  assert.equal(chapterA.every(storyPrivacyCandidateResolved), true);
  assert.equal(storyPrivacyAuthorityComplete(globallyPending), false);
});

test("Story Privacy request epochs are single-flight and suppress replaced responses", async () => {
  const gate = new StoryPrivacyRequestGate();
  const accepted = [];
  let resolveOld;
  let resolveCurrent;
  const oldAuthority = new Promise((resolve) => { resolveOld = resolve; });
  const currentAuthority = new Promise((resolve) => { resolveCurrent = resolve; });
  const oldTicket = gate.begin();
  assert.ok(oldTicket);
  assert.equal(gate.begin(), null);
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
    ...authority, sourceRevision:4, activeStoryDigest:"d".repeat(64), authorityDigest:"e".repeat(64),
  };
  resolveCurrent(parseStoryPrivacyAuthority(replacement));
  await currentCommit;
  resolveOld(parseStoryPrivacyAuthority(authority));
  await oldCommit;
  assert.deepEqual(accepted, [replacement]);
  const retired = gate.begin();
  gate.retire();
  assert.equal(retired.signal.aborted, true);
  assert.equal(gate.isCurrent(retired), false);
});

test("Release Preview uses one Agent target-choice card and no candidate decision path", async () => {
  const component = await read("../app/story-privacy-review.tsx");
  assert.match(component, /Candidate \{resolved \+ 1\} of \{total\}/);
  assert.match(component, /Local original/);
  assert.match(component, /Agent-proposed anonymized text/);
  assert.match(component, /Use Agent proposal/);
  assert.match(component, /Edit anonymized text/);
  assert.match(component, /Save edited anonymization/);
  assert.match(component, /Publish exact original span/);
  assert.match(component, /Credential always removed/);
  assert.match(component, /Why flagged/);
  assert.match(component, /Privacy preparation required/);
  assert.match(component, /The reviewed Story content changed or the Story Privacy contract was refreshed\./);
  assert.match(component, /Export the current snapshot/);
  assert.match(component, /Prepare and finalize the reviewed target proposals/);
  assert.match(component, /Import the bundle into this same localhost Viewer and workflow run/);
  assert.match(component, /busy=\{Boolean\(busyId\)\}/);
  assert.doesNotMatch(component, /onDecision|decisionOptions|otherCandidateForcesTarget|No extra candidate anonymization/);
  assert.doesNotMatch(component, /provider|model|confidence|recommendation|rewrite|creator|>Delete<|v\d/i);
});

test("Workspace sends one exact target CAS, installs its response, and never retries a mutation", async () => {
  const workspace = await read("../app/workspace.tsx");
  assert.match(workspace, /fetch\(`\/api\/story-privacy\?workflowRunId=\$\{encodeURIComponent\(scopedWorkflowRunId\)\}`/);
  const choice = workspace.slice(workspace.indexOf("const decideStoryPrivacyTarget"),
    workspace.indexOf("const effectiveError"));
  assert.match(choice, /fetch\(`\/api\/story-privacy\/\$\{encodeURIComponent\(target\.targetId\)\}`/);
  assert.match(choice, /workflowRunId:authority\.workflowRunId,[\s\S]*sourceRevision:authority\.sourceRevision,[\s\S]*activeStoryDigest:authority\.activeStoryDigest,[\s\S]*authorityDigest:authority\.authorityDigest,[\s\S]*targetContentDigest:target\.targetContentDigest,[\s\S]*editedText:choice\.editedText,[\s\S]*publicOverrides:choice\.publicOverrides/);
  assert.match(choice, /response\.status === 409[\s\S]*loadStoryPrivacy\("The target authority changed while saving[\s\S]*, true\)/);
  assert.match(choice, /authority:next,[\s\S]*Target choice saved to the exact current release authority/);
  assert.equal((choice.match(/method:"PATCH"/g) || []).length, 1);
  assert.match(workspace, /onTargetChoice=\{\(target,choice\) => \{[\s\S]*decideStoryPrivacyTarget\(target,choice\)/);
  assert.doesNotMatch(choice, /candidateDigest|expectedVersion|editedProjections|\/projection/);
  assert.doesNotMatch(workspace, /setPrivacyDecisions|current\.privacyDecisions/);
  assert.match(workspace, /createStoryReviewSession\(workflowRunId,current\.chapterReviews,\{\}\)/);
  assert.match(workspace, /if \(!storyPrivacyReleaseReady\)[\s\S]*openGlobalStoryPrivacy\(\);[\s\S]*return;/);
  assert.match(workspace, /storyPrivacyReady=\{storyPrivacyReleaseReady\}/);
});

test("source Privacy remains decision-only and surfaces API failures", async () => {
  const [workspace, compare] = await Promise.all([
    read("../app/workspace.tsx"), read("../app/redaction-compare.tsx"),
  ]);
  const sourceDecision = workspace.slice(workspace.indexOf("async function decideRedaction"),
    workspace.indexOf("const [probes"));
  assert.match(sourceDecision, /body: JSON\.stringify\(\{ decision \}\)/);
  assert.match(sourceDecision, /if \(!response\.ok\) throw new Error/);
  assert.doesNotMatch(sourceDecision, /DELETE|category|status:/);
  assert.doesNotMatch(compare, /<select|onDelete|onUpdate|>Delete<|job\.model|span\.confidence|span\.created_by|span\.reason|v0\.1/);
  assert.match(compare, /review_state === "needs_confirmation"/);
});

test("Chapter completion consumes global target-choice references and retains paragraph-owned Insights", async () => {
  const [editor, css] = await Promise.all([
    read("../app/story-chapter-editor.tsx"), read("../app/globals.css"),
  ]);
  assert.match(editor, /storyPrivacyCandidates\.map/);
  assert.match(editor, /candidate\.resolved/);
  assert.match(editor, /Open global Release Preview/);
  assert.match(editor, /disabled=\{applying \|\| !storyPrivacyReady\}/);
  assert.match(editor, /disabled=\{!storyPrivacyReady \|\| !canMarkChapterReady/);
  assert.match(css, /\.storyNarrativeRow\{display:grid;grid-template-columns:minmax\(0,720px\) minmax\(480px,620px\)/);
  assert.match(css, /@media\(max-width:760px\)[^\n]*\.sourcePrivacyComparison,\.storyPrivacyProjectionCompare\{grid-template-columns:minmax\(0,1fr\)\}/);
});
