import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { testStoryCoverage } from "./fixtures/story-coverage.mjs";
import {
  applyChapterReview,
  chapterReviewCompletionBlockers,
  emptyChapterReview,
  markChapterReady,
  storyBlocks,
  updateAiInsightDecision,
} from "../lib/story-review.ts";
import { groupDownloadReviewBlockers } from "../lib/story-navigation.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const evidence = { documentId: "doc", eventId: "doc:event" };
const insightId = "safe-insight";
const source = {
    schema: "oxygen.story",
    language: "en",
    languagePolicyDigest: "f".repeat(64),
  key: "chapter-one",
  phase: { id: "review", label: "Review" },
  title: "Synthetic Chapter",
  overview: "A bounded Story used only for blocker behavior.",
  people: [],
  story: { blocks: [{ id: "scene", text: "Safe source.", evidence: [evidence] }] },
  insights: [{
    id: insightId,
    background: "A synthetic review context.",
    anchorStoryBlockId: "scene",
    quote: { text: "Safe source.", evidence },
    directlyAcquiredExperience: "The exact bounded review was exercised.",
    principle: "Block release until every Insight decision is applied.",
    evidence: [evidence],
  }],
  evidence: { primary: evidence, supporting: [] },
  coverage: testStoryCoverage(),
};
const blocks = storyBlocks(source);
const completionContext = {
  source,
  privacyCandidates: [],
  privacyDecisions: {},
  targetCatalog: new Map(),
  evidenceResolved: true,
  supportedAddIds: [],
  supportedEditIds: [],
  sourceBlocks: blocks,
  reviewedBlocks: blocks,
};


test("download aggregation preserves completion semantics and adds only the release-stage blocker", () => {
  const accepted = updateAiInsightDecision(emptyChapterReview(source), source, insightId, "accepted");
  const applied = applyChapterReview(accepted, completionContext).state;
  const confirmed = markChapterReady(applied, completionContext);
  assert.equal(confirmed.sourceInsightReviews[insightId].resolution, "applied");
  assert.deepEqual(chapterReviewCompletionBlockers(confirmed, completionContext), []);
  assert.deepEqual(groupDownloadReviewBlockers([{
    project: "Project", chapterKey: source.key, stage: confirmed.stage, completionBlockers: [],
  }]), []);

  const revisionReady = groupDownloadReviewBlockers([{
    project: "Project", chapterKey: source.key, stage: "revision_ready", completionBlockers: [],
  }]);
  assert.deepEqual(revisionReady[0].blockers, [{ code: "chapter_not_confirmed", targetKind: "chapter" }]);

  const pending = emptyChapterReview(source);
  const completionBlockers = chapterReviewCompletionBlockers(pending, completionContext);
  assert.deepEqual(completionBlockers, [{
    code: "evidence_unverified", chapterKey: source.key, targetKind: "chapter",
  }, {
    code: "revision_provenance_mismatch", chapterKey: source.key, targetKind: "chapter",
  }, {
    code: "ai_insight_decision_pending", chapterKey: source.key, targetKind: "insight", targetId: insightId,
  }]);
  assert.deepEqual(groupDownloadReviewBlockers([{
    project: "Project", chapterKey: source.key, stage: pending.stage, completionBlockers,
  }])[0].blockers, [
    { code: "evidence_unverified", targetKind: "chapter" },
    { code: "revision_provenance_mismatch", targetKind: "chapter" },
    { code: "ai_insight_decision_pending", targetKind: "insight", targetId: insightId },
    { code: "chapter_not_confirmed", targetKind: "chapter" },
  ]);
});

test("malformed review state collapses to safe generic blocker data", () => {
  const malformed = { ...emptyChapterReview(source), annotations: [{ instruction: "PRIVATE_REJECTED_COPY" }] };
  const completionBlockers = chapterReviewCompletionBlockers(malformed, completionContext);
  assert.deepEqual(completionBlockers, [{
    code: "review_state_invalid", chapterKey: source.key, targetKind: "chapter",
  }]);
  const serialized = JSON.stringify(groupDownloadReviewBlockers([{
    project: "Project", chapterKey: source.key, stage: "reviewing", completionBlockers,
  }]));
  assert.equal(serialized.includes("PRIVATE_REJECTED_COPY"), false);
});

test("blocker projection excludes private source copy and keeps only safe identities", () => {
  const privateTitle = "PRIVATE_CHAPTER_TITLE_SENTINEL";
  const groups = groupDownloadReviewBlockers([{
    project: "Project",
    chapterKey: source.key,
    stage: "reviewing",
    completionBlockers: [{
      code: "ai_insight_decision_pending",
      chapterKey: source.key,
      targetKind: "insight",
      targetId: insightId,
    }],
    title: privateTitle,
  }]);
  assert.deepEqual(groups, [{
    project: "Project",
    chapterKey: source.key,
    blockers: [
      { code: "ai_insight_decision_pending", targetKind: "insight", targetId: insightId },
      { code: "chapter_not_confirmed", targetKind: "chapter" },
    ],
  }]);
  assert.equal(JSON.stringify(groups).includes(privateTitle), false);
});

test("HTML and ZIP share one blocker preflight before the durable handoff", async () => {
  const workspace = await read("../app/workspace.tsx");
  const aggregation = workspace.slice(workspace.indexOf("const currentDownloadReviewBlockerGroups"), workspace.indexOf("const openDownloadReviewBlocker"));
  const download = workspace.slice(workspace.indexOf("const downloadReviewed"), workspace.indexOf("const ready ="));
  assert.match(aggregation, /storySelection\.chapters\.map/);
  assert.match(aggregation, /chapterReviewCompletionBlockers\(state,completionContext\(chapter\.source\)\)/);
  assert.match(aggregation, /groupDownloadReviewBlockers/);
  assert.ok(download.indexOf("currentProjectReleaseActionBlockers") < download.indexOf("const persistence=storyPersistence"));
  assert.ok(download.indexOf("projectReleaseActionBlocked") < download.indexOf("runDurableStoryReviewHandoff"));
  assert.match(download, /projectReleaseActionBlocked\(blockers\)[\s\S]*openReleaseBlockerDialog\(blockers\);[\s\S]*return;/);
  assert.match(workspace, /downloadReviewed\("download_html","\/api\/organization\/export","oxygen-reviewed-story\.html"\)/);
  assert.match(workspace, /downloadReviewed\("download_zip","\/api\/package","oxygen-contribution\.zip"\)/);
  assert.match(download, /JSON\.stringify\(\{workflowRunId,serverVersion,sourceRevision\}\)/);
  assert.doesNotMatch(download, /blockerGroups[^\n]*JSON\.stringify|reviewedStory|chapterReviews[^\n]*JSON\.stringify/);
});

test("blocker surface groups safe ordinal labels and exposes only focused actions", async () => {
  const workspace = await read("../app/workspace.tsx");
  const surface = workspace.slice(workspace.indexOf("releaseBlockers &&"), workspace.indexOf("workflowOpen &&"));
  assert.match(surface, /role="dialog" aria-modal="true" aria-labelledby="download-review-title"/);
  assert.match(surface, /releaseBlockers\.chapterGroups\.map\(\(group,groupIndex\) => <section/);
  assert.match(surface, /<h2>\{labels\.chapter\} \{groupIndex\+1\}<\/h2>/);
  assert.match(surface, /group\.blockers\.map[\s\S]*<button className="docCard"/);
  assert.match(surface, /labels\.downloadBlockers\[blocker\.code\]/);
  assert.match(surface, /releaseBlockers\.authority\.map/);
  assert.match(surface, /PROJECT_RELEASE_AGENT_RESUME_INSTRUCTION/);
  assert.doesNotMatch(surface, /instruction|beforeText|afterText|original|excerpt|localized|serverVersion|sourceRevision|group\.title/);
  assert.match(workspace, /chapter:"Chapter"/);
  assert.match(workspace, /chapter:"章节"/);
});

test("blocker navigation is activated-only and carries one safe focus identity", async () => {
  const workspace = await read("../app/workspace.tsx");
  const navigation = workspace.slice(workspace.indexOf("const openDownloadReviewBlocker"), workspace.indexOf("const downloadReviewed"));
  assert.match(navigation, /navigationCandidates\.some/);
  assert.match(navigation, /chapter\.project===group\.project && chapter\.story\.key===group\.chapterKey/);
  assert.match(navigation, /setDownloadReviewFocus\(\{/);
  assert.match(navigation, /setStoryNavigation\(\{project:group\.project,storyKey:group\.chapterKey\}\)/);
  assert.doesNotMatch(navigation, /setChapterReviews|setPrivacyDecisions|storyPersistence|serverVersion|sourceRevision/);
});

test("editor focuses an exact Insight or Chapter completion without review mutation", async () => {
  const editor = await read("../app/story-chapter-editor.tsx");
  const focus = editor.slice(editor.indexOf("if (!reviewFocus) return;"), editor.indexOf("const captureSelection"));
  assert.match(focus, /reviewFocus\.targetKind === "insight" && reviewFocus\.targetId/);
  assert.match(focus, /insightRefs\.current\[reviewFocus\.targetId\]/);
  assert.match(focus, /target \|\| completionRef\.current/);
  assert.match(focus, /onReviewFocusHandled\?\.\(\)/);
  assert.doesNotMatch(focus, /onChapterReview|onPrivacyDecision|storyPersistence|fetch\(/);
});
