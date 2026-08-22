import test from "node:test";
import assert from "node:assert/strict";
import {
  addStoryAnnotation,
  applyAnnotationsToBlock,
  applyChapterReview,
  canMarkChapterReady,
  cancelStoryAnnotation,
  createStoryAnnotation,
  emptyChapterReview,
  markChapterReady,
  privacyReviewState,
  returnChapterToReview,
  reviseHighlight,
  storyAnnotationSegments,
  updateInsightReview,
} from "../lib/story-review.ts";

const evidence = { documentId: "doc", eventId: "event" };
const context = (privacyCandidates = [], privacyDecisions = {}, chapterEvidence = [evidence]) => ({
  privacyCandidates, privacyDecisions, chapterEvidence,
});
const privacyCandidate = (releaseTargets = ["scene"]) => ({
  id: "metric", title: "Metric", explanation: "Internal", recommendation: "redact",
  releaseTargets, original: { availability: "unavailable" }, whyFlagged: "Internal",
});
const highlight = {
  id: "shared-lesson",
  title: "Reproducibility changed the discussion",
  noticed: "The benchmark became a shared contract.",
  lesson: "Define success before dividing the work.",
};

test("AI-directed revision immediately returns human-directed wording", () => {
  assert.equal(reviseHighlight(highlight, "   ", "en"), null);
  const revised = reviseHighlight(highlight, "Focus on reproducibility.", "en");
  assert.equal(revised.id, highlight.id);
  assert.equal(revised.lesson, "Focus on reproducibility.");
  assert.match(revised.noticed, /Revised emphasis/);
  const chinese = reviseHighlight(highlight, "重点写可复现性。", "zh");
  assert.equal(chinese.lesson, "重点写可复现性。");
  assert.match(chinese.noticed, /人工要求/);
});

test("privacy review advances one candidate at a time and zero candidates are complete", () => {
  const candidates = [privacyCandidate([]), { ...privacyCandidate([]), id: "name", title: "Name" }];
  assert.equal(privacyReviewState(candidates, {}).active.id, "metric");
  const second = privacyReviewState(candidates, { metric: "redact" });
  assert.equal(second.reviewed, 1);
  assert.equal(second.active.id, "name");
  const complete = privacyReviewState(candidates, { metric: "redact", name: "keep" });
  assert.equal(complete.complete, true);
  assert.equal(complete.active, null);
  assert.deepEqual(privacyReviewState([], {}), { reviewed: 0, activeIndex: -1, active: null, complete: true });
});

test("iterative bilingual review produces two revisions before explicit human confirmation", () => {
  let state = emptyChapterReview();
  assert.equal(state.stage, "reviewing");
  assert.equal(state.revision, 1);
  assert.equal(state.publicationApproved, false);

  const enSource = "The draft changed.";
  const zhSource = "这份草稿发生变化。";
  const enRemoval = createStoryAnnotation({
    blockId: "scene", type: "delete", sourceLanguage: "en", baseRevision: 1,
    selection: { start: 4, end: 10, text: "draft " },
  });
  const zhStart = zhSource.indexOf("草稿");
  const zhRemoval = createStoryAnnotation({
    blockId: "scene", type: "delete", sourceLanguage: "zh", baseRevision: 1,
    selection: { start: zhStart, end: zhStart + 2, text: "草稿" },
  });
  state = addStoryAnnotation(addStoryAnnotation(state, enRemoval), zhRemoval);
  const requiredPrivacy = context([privacyCandidate()], {});
  assert.equal(applyChapterReview(state, requiredPrivacy).blockedReason, "privacy");
  assert.equal(canMarkChapterReady(state, context()), false);

  state = applyChapterReview(state, context()).state;
  assert.equal(state.stage, "revision_ready");
  assert.equal(state.revision, 2);
  assert.equal(state.staleTranslations.length, 0);
  assert.equal(applyAnnotationsToBlock(enSource, "scene", "en", state.annotations), "The changed.");
  assert.equal(applyAnnotationsToBlock(zhSource, "scene", "zh", state.annotations), "这份发生变化。");

  const enCorrection = createStoryAnnotation({
    blockId: "scene", type: "revise", sourceLanguage: "en", baseRevision: 2,
    selection: { start: 4, end: 11, text: "changed" }, instruction: "remained provisional",
  });
  const zhRevised = "这份发生变化。";
  const zhChangeStart = zhRevised.indexOf("发生变化");
  const zhCorrection = createStoryAnnotation({
    blockId: "scene", type: "revise", sourceLanguage: "zh", baseRevision: 2,
    selection: { start: zhChangeStart, end: zhChangeStart + 4, text: "发生变化" }, instruction: "仍处于假设阶段",
  });
  state = addStoryAnnotation(addStoryAnnotation(state, enCorrection), zhCorrection);
  assert.equal(state.stage, "reviewing");
  assert.equal(canMarkChapterReady(state, context()), false);

  state = applyChapterReview(state, context()).state;
  assert.equal(state.revision, 3);
  assert.equal(state.revisionHistory.length, 2);
  assert.deepEqual(state.revisionHistory.map((record) => record.revision), [2, 3]);
  assert.equal(applyAnnotationsToBlock(enSource, "scene", "en", state.annotations), "The remained provisional.");
  assert.equal(applyAnnotationsToBlock(zhSource, "scene", "zh", state.annotations), "这份仍处于假设阶段。");
  assert.equal(canMarkChapterReady(state, context()), true);

  state = markChapterReady(state, context());
  assert.equal(state.stage, "human_confirmed");
  assert.equal(state.publicationApproved, false);
  assert.equal(addStoryAnnotation(state, enCorrection), state);

  state = returnChapterToReview(state);
  assert.equal(state.stage, "reviewing");
  assert.equal(state.revision, 3);
  assert.equal(state.publicationApproved, false);
});

test("unsupported Add blocks confirmation while reviewed-evidence Add can apply", () => {
  let state = emptyChapterReview();
  const unsupported = createStoryAnnotation({
    blockId: "outcome", type: "add", sourceLanguage: "zh", baseRevision: 1,
    selection: { start: 0, end: 2, text: "决定" }, instruction: "补充 holdout test 后来提出了挑战。",
  });
  state = applyChapterReview(addStoryAnnotation(state, unsupported), context()).state;
  assert.equal(state.annotations[0].resolution, "needs_evidence");
  assert.equal(canMarkChapterReady(state, context()), false);
  assert.equal(applyAnnotationsToBlock("决定随后形成。", "outcome", "zh", state.annotations), "决定随后形成。");

  state = cancelStoryAnnotation(state, unsupported.id);
  const enSource = "Decision followed.";
  const supported = createStoryAnnotation({
    blockId: "outcome", type: "add", sourceLanguage: "en", baseRevision: 2,
    selection: { start: 0, end: 8, text: "Decision" }, instruction: "The holdout evidence remained visible.",
    supportingEvidence: [evidence],
  });
  state = applyChapterReview(addStoryAnnotation(state, supported), context()).state;
  assert.equal(state.annotations.at(-1).resolution, "applied");
  assert.equal(applyAnnotationsToBlock(enSource, "outcome", "en", state.annotations), "Decision The holdout evidence remained visible. followed.");
  assert.deepEqual(state.staleTranslations, [{ subject: "story:outcome", language: "zh", count: 1 }]);

  const zhSource = "决定随后形成。";
  const paired = createStoryAnnotation({
    blockId: "outcome", type: "add", sourceLanguage: "zh", baseRevision: 3,
    selection: { start: 0, end: 2, text: "决定" }, instruction: "留存 holdout 证据。",
    supportingEvidence: [evidence],
  });
  state = applyChapterReview(addStoryAnnotation(state, paired), context()).state;
  assert.equal(state.staleTranslations.length, 0);
  assert.equal(applyAnnotationsToBlock(zhSource, "outcome", "zh", state.annotations), "决定 留存 holdout 证据。随后形成。");
});

test("one-language Revise leaves paired prose intact and blocks confirmation as stale", () => {
  const english = "The decision was final.";
  const chinese = "这个决定当时仍是假设。";
  const correction = createStoryAnnotation({
    blockId: "outcome", type: "revise", sourceLanguage: "en", baseRevision: 1,
    selection: { start: 4, end: 12, text: "decision" }, instruction: "hypothesis",
  });
  const state = applyChapterReview(addStoryAnnotation(emptyChapterReview(), correction), context()).state;
  assert.equal(applyAnnotationsToBlock(english, "outcome", "en", state.annotations), "The hypothesis was final.");
  assert.equal(applyAnnotationsToBlock(chinese, "outcome", "zh", state.annotations), chinese);
  assert.deepEqual(state.staleTranslations, [{ subject: "story:outcome", language: "zh", count: 1 }]);
  assert.equal(canMarkChapterReady(state, context()), false);
});

test("applied annotations cannot be cancelled without a new revision", () => {
  let state = emptyChapterReview();
  const removal = createStoryAnnotation({
    blockId: "scene", type: "delete", sourceLanguage: "en", baseRevision: 1,
    selection: { start: 4, end: 10, text: "draft " },
  });
  state = applyChapterReview(addStoryAnnotation(state, removal), context()).state;
  const unchanged = cancelStoryAnnotation(state, removal.id);
  assert.equal(unchanged, state);
  assert.equal(unchanged.annotations[0].resolution, "applied");
  assert.equal(unchanged.revision, 2);
});

test("insight edits participate in review provenance and bilingual stale-state gating", () => {
  let state = updateInsightReview(emptyChapterReview(), highlight.id, "en", {
    status: "overridden", text: "Focus on reproducibility.",
    highlight: { ...highlight, lesson: "Focus on reproducibility." }, revision: "direct",
  });
  assert.equal(state.stage, "reviewing");
  state = applyChapterReview(state, context()).state;
  assert.deepEqual(state.staleTranslations, [{ subject: `insight:${highlight.id}`, language: "zh", count: 1 }]);
  assert.equal(canMarkChapterReady(state, context()), false);

  state = updateInsightReview(state, highlight.id, "zh", {
    status: "overridden", text: "强调可复现性。",
    highlight: { ...highlight, title: "可复现性改变了讨论", noticed: "基准成为共同契约。", lesson: "强调可复现性。" }, revision: "direct",
  });
  state = applyChapterReview(state, context()).state;
  assert.equal(state.staleTranslations.length, 0);
  assert.equal(state.insightReviews[highlight.id].localized.en.lesson, "Focus on reproducibility.");
  assert.equal(state.insightReviews[highlight.id].localized.zh.lesson, "强调可复现性。");
  state = markChapterReady(state, context());
  assert.equal(updateInsightReview(state, highlight.id, "en", { status: "rejected", text: "remove" }), state);
});

test("typed Privacy decisions are revision provenance and Redact controls release blocks", () => {
  const candidate = privacyCandidate(["scene", "insight:shared-lesson"]);
  let state = applyChapterReview(emptyChapterReview(), context([candidate], { metric: "redact" })).state;
  assert.deepEqual(state.appliedPrivacyDecisions, { metric: "redact" });
  assert.deepEqual(state.redactedBlocks, ["scene", "insight:shared-lesson"]);
  assert.deepEqual(state.revisionHistory[0].privacyDecisions, { metric: "redact" });
  assert.equal(canMarkChapterReady(state, context([candidate], { metric: "keep" })), false);

  state = returnChapterToReview(state);
  state = applyChapterReview(state, context([candidate], { metric: "keep" })).state;
  assert.deepEqual(state.redactedBlocks, []);
  assert.equal(canMarkChapterReady(state, context([candidate], { metric: "keep" })), true);
});

test("pending Story annotations preserve and render only exact independent ranges", () => {
  const source = "The benchmark remained provisional until the holdout test.";
  const holdoutStart = source.indexOf("holdout");
  let state = emptyChapterReview();
  const first = createStoryAnnotation({
    blockId: "turn", type: "revise", sourceLanguage: "en", baseRevision: 1,
    selection: { start: 4, end: 13, text: "benchmark" }, instruction: "Keep this precise.",
  });
  const second = createStoryAnnotation({
    blockId: "turn", type: "delete", sourceLanguage: "en", baseRevision: 1,
    selection: { start: holdoutStart, end: holdoutStart + "holdout".length, text: "holdout" },
  });
  state = addStoryAnnotation(addStoryAnnotation(state, first), second);

  assert.equal(state.annotations[0].selection.text, source.slice(4, 13));
  assert.equal(state.annotations[1].selection.text, source.slice(holdoutStart, holdoutStart + "holdout".length));
  assert.deepEqual(storyAnnotationSegments(source, "turn", "en", 1, state.annotations), [
    { text: "The ", annotationIds: [] },
    { text: "benchmark", annotationIds: [first.id] },
    { text: " remained provisional until the ", annotationIds: [] },
    { text: "holdout", annotationIds: [second.id] },
    { text: " test.", annotationIds: [] },
  ]);

  state = cancelStoryAnnotation(state, first.id);
  const afterCancel = storyAnnotationSegments(source, "turn", "en", 1, state.annotations);
  assert.equal(afterCancel.some((segment) => segment.annotationIds.includes(first.id)), false);
  assert.equal(afterCancel.some((segment) => segment.annotationIds.includes(second.id)), true);
});

test("range styling rejects stale, mismatched, cross-language, and cross-block offsets", () => {
  const source = "One paragraph only.";
  const mismatched = createStoryAnnotation({
    blockId: "scene", type: "delete", sourceLanguage: "en", baseRevision: 1,
    selection: { start: 4, end: 13, text: "different" },
  });
  assert.deepEqual(storyAnnotationSegments(source, "scene", "en", 1, [mismatched]), [{ text: source, annotationIds: [] }]);
  assert.deepEqual(storyAnnotationSegments(source, "scene", "zh", 1, [mismatched]), [{ text: source, annotationIds: [] }]);
  assert.deepEqual(storyAnnotationSegments(source, "other-block", "en", 1, [mismatched]), [{ text: source, annotationIds: [] }]);
});
