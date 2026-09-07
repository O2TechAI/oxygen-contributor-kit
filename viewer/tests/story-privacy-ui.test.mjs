import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  storyPrivacyTargetView,
  storyPrivacyChanges,
  storyPrivacyNeedsDecision,
  parseStoryPrivacyAuthority,
  storyPrivacyAuthorityCurrent,
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
  assert.equal(storyPrivacyAuthorityCurrent({status:"ready",authority,message:""},"run-current"),true);
  assert.equal(storyPrivacyAuthorityCurrent({status:"ready",authority,message:""},"foreign-run"),false);
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
  assert.equal(storyPrivacyAuthorityCurrent({
    status:"ready",authority:preparationRequired,message:"",
  },"run-current"),false);
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

test("Release Preview is read-only; Chapter target cards stage visible choices", async () => {
  const component = await read("../app/story-privacy-review.tsx");
  const preview = component.slice(component.indexOf("export function StoryPrivacyReview"));
  assert.match(preview, /PreviewTarget/);
  assert.doesNotMatch(preview, /<button|<textarea|TargetChoiceCard/);
  assert.match(component, /Local original/);
  assert.match(component, /AI recommendation/);
  assert.match(component, /storyPrivacyTargetView/);
  assert.match(component, /publicSpans.map/);
  assert.doesNotMatch(component, /setPublicSelections|Choice pending Apply review/);
  assert.match(component, /Credentials stay hidden/);
  assert.match(component, /privacyDecisionCard/);
  assert.match(component, /selectedEdit \? target.selectedText/);
  assert.match(component, /disabled=\{busy \|\| selectedEdit/);
  assert.match(component, /\?\? firstPending/);
  assert.match(component, />Accept<|>Accept<\/button>/);
  assert.match(component, />Reject</);
  assert.match(component, />Edit</);

});

test("Workspace stages durable Privacy and sends one Chapter Apply CAS without retry", async () => {
  const workspace = await read("../app/workspace.tsx");
  const stage = workspace.slice(workspace.indexOf("const decideStoryPrivacyTarget"), workspace.indexOf("const applyChapter"));
  assert.match(stage, /setPrivacyDrafts/);
  assert.doesNotMatch(stage, /fetch\(/);
  const apply = workspace.slice(workspace.indexOf("const applyChapter"), workspace.indexOf("const acceptEditedPrivacyTarget"));
  assert.match(apply, /await storyPersistence.flush\(snapshot\)/);
  assert.match(apply, /fetch\("\/api\/story-review-session\/apply"/);
  assert.match(apply, /expectedVersion: requestedVersion/);
  assert.match(apply, /next.workflowRunId !== workflowRunId/);
  assert.match(apply, /next.sourceRevision !== current.sourceRevision/);
  assert.match(apply, /storyPersistence.getState\(\).sourceRevision !== current.sourceRevision/);
  assert.match(apply, /storyPersistence.getState\(\).serverVersion !== requestedVersion/);
  assert.match(apply, /\[chapterKey\]: session.chapterReviews\[chapterKey\]/);
  assert.equal((apply.match(/fetch\(/g) || []).length, 1);
  assert.doesNotMatch(workspace, /fetch\(`\/api\/story-privacy\/|onTargetChoice=/);
  assert.match(workspace, /applyPending=\{storyPrivacyBusy === activeSourceChapter.source.key\}/);
  assert.doesNotMatch(workspace, /Other text in this Chapter|renderPrivacyTarget/);
  assert.match(workspace, /<ChapterPrivacyReview/);

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

test("Chapter completion owns Privacy controls and retains paragraph-owned Insights", async () => {
  const editor = await read("../app/story-chapter-editor.tsx");
  assert.match(editor, /\{privacyControls\}/);
  assert.match(editor, /<fieldset disabled=\{applying\}/);
  assert.match(editor, /const applying = localApplying \|\| applyPending/);
  assert.match(editor, /disabled=\{!storyPrivacyComplete \|\| !canMarkChapterReady/);
  const apply = editor.slice(editor.indexOf("const applyReview"), editor.indexOf('return <section className="simpleEpisode'));
  assert.match(apply, /await onApplyReview\(\)/);
  assert.doesNotMatch(apply, /fetch\(|privacyComplete/);
  assert.doesNotMatch(editor, /Open global Release Preview|storyPrivacyCandidates\.map/);
  assert.match(editor, /Evidence will be checked when you Apply this review/);
});

test("Privacy preview keeps pending suggestions and distinguishes exact choices from human Apply", () => {
  const original = target("chapter-a::title", "Alice planned a demo");
  const draft = { targetContentDigest: original.targetContentDigest, proposedText: original.proposedText,
    editedText: null, publicOverrides: [] };
  const legacy = storyPrivacyTargetView(original);
  assert.equal(legacy.text, original.proposedText);
  assert.match(legacy.status, /Suggested/);
  assert.match(storyPrivacyTargetView(original, undefined, { stage: "reviewing", evidenceVerified: false }).status, /Suggested/);
  assert.equal(storyPrivacyTargetView(original, undefined, { stage: "revision_ready", evidenceVerified: true }).status, "Applied");
  assert.match(storyPrivacyTargetView(original, draft).status, /Draft/);
  const publicDraft = { ...draft, publicOverrides: [{ originalStartOffset: 0, originalEndOffset: 5, category: "person-name" }] };
  const kept = storyPrivacyTargetView(original, publicDraft);
  assert.equal(kept.text, original.originalText);
  assert.match(kept.label, /Original retained/);
  assert.deepEqual(storyPrivacyChanges(original, kept.text), []);
  assert.equal(storyPrivacyChanges(original, original.proposedText).length, 1);
  const stale = storyPrivacyTargetView(original, { ...publicDraft, targetContentDigest: "old" });
  assert.equal(stale.text, original.proposedText);
  assert.match(stale.status, /Earlier choice/);
  const edit = { ...draft, editedText: "A team planned a demo", reviewedEditText: "A team planned a demo" };
  const checked = { ...original, editedProposal: { inputDigest: "matching-input", text: edit.editedText } };
  assert.match(storyPrivacyTargetView(checked, edit, undefined, "wrong-input").status, /waiting/);
  assert.match(storyPrivacyTargetView(checked, edit, undefined, "matching-input").status, /ready for Apply/);
  assert.equal(storyPrivacyTargetView(checked, edit, undefined, "wrong-input").label, "Your edit");
});

test("Privacy deck hides automatic coverage but preserves every required confirmation", () => {
  const item = target("chapter-a::title", "Alice planned a demo", { pending: true });
  const candidate = { reviewState: "deterministic", releaseTargets: [item.targetId] };
  assert.equal(storyPrivacyNeedsDecision(item, [candidate]), false);
  assert.equal(storyPrivacyNeedsDecision(item, [{ ...candidate, reviewState: "needs_confirmation" }]), true);
  const credential = { ...item, occurrences: item.occurrences.map((span) => ({ ...span, canPublish: false })) };
  assert.equal(storyPrivacyNeedsDecision(credential, [{ ...candidate, reviewState: "needs_confirmation" }]), true);
  assert.equal(storyPrivacyNeedsDecision(item, [], { editedText: "Draft" }), true);
});

test("partial original retention is not a full Reject and highlights only actual replacements", () => {
  const item = { ...target("a::story:passage", "Alice"), originalText: "🙂 Alice used key42.", proposedText: "🙂 Person A used [hidden].", selectedText: null,
    occurrences: [{ originalStartOffset: 2, originalEndOffset: 7, proposalStartOffset: 2, proposalEndOffset: 10, category: "person-name", canPublish: true, isPublic: false },
      { originalStartOffset: 13, originalEndOffset: 18, proposalStartOffset: 16, proposalEndOffset: 24, category: "credential", canPublish: false, isPublic: false }] };
  const draft = { targetContentDigest: item.targetContentDigest, proposedText: item.proposedText, editedText: null,
    publicOverrides: [{ originalStartOffset: 2, originalEndOffset: 7, category: "person-name" }] };
  const kept = storyPrivacyTargetView(item, draft);
  assert.equal(kept.choice, "reject");
  assert.equal(kept.text, "🙂 Alice used [hidden].");
  assert.deepEqual(storyPrivacyChanges(item, kept.text), [{ originalStart: 13, originalEnd: 18, start: 13, end: 21 }]);
  const twoSelectable = { ...item, occurrences: item.occurrences.map((span) => ({ ...span, canPublish: true })) };
  assert.equal(storyPrivacyTargetView(twoSelectable, draft).choice, "partial");
  const saved = { ...item, selectedText: "A team held a public test.", edited: true };
  const applied = storyPrivacyTargetView(saved, undefined, { stage: "revision_ready", evidenceVerified: true });
  assert.equal(applied.text, saved.selectedText);
  assert.equal(applied.label, "Reviewed edit");
  assert.equal(applied.status, "Applied");
  const longText = "x".repeat(200_000);
  assert.deepEqual(storyPrivacyChanges({ ...item, originalText: longText, proposedText: longText, occurrences: [] }, longText), []);
});
