import test from "node:test";
import assert from "node:assert/strict";
import {
  addStoryAnnotation,
  applyAnnotationsToBlock,
  applyChapterReview,
  canMarkChapterReady,
  createStoryAnnotation,
  cancelStoryAnnotation,
  emptyChapterReview,
  markChapterReady,
  privacyReviewState,
  returnChapterToReview,
  reviseHighlight,
  storyAnnotationSegments,
} from "../lib/story-review.ts";

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

test("privacy review advances one undecided candidate at a time", () => {
  const candidates = [
    { id:"metric", title:"Metric", explanation:"Internal", recommendation:"redact", original:{availability:"unavailable"}, whyFlagged:"Internal", suggestedRelease:"Omit it" },
    { id:"name", title:"Name", explanation:"Local identity", recommendation:"redact", original:{availability:"unavailable"}, whyFlagged:"Identity", suggestedRelease:"Use a role" },
  ];
  assert.equal(privacyReviewState(candidates, {}).active.id, "metric");
  const second = privacyReviewState(candidates, { metric:"redact" });
  assert.equal(second.reviewed, 1);
  assert.equal(second.active.id, "name");
  const complete = privacyReviewState(candidates, { metric:"redact", name:"keep" });
  assert.equal(complete.complete, true);
  assert.equal(complete.active, null);
});

test("iterative review produces successive revisions before human confirmation", () => {
  let state = emptyChapterReview();
  assert.equal(state.stage, "reviewing");
  assert.equal(state.revision, 1);
  assert.equal(state.publicationApproved, false);

  const removal = createStoryAnnotation({
    blockId: "scene", type: "delete", sourceLanguage: "en", baseRevision: 1,
    selection: { start: 4, end: 10, text: "draft " },
  });
  state = addStoryAnnotation(state, removal);
  assert.equal(canMarkChapterReady(state, true), false);
  assert.equal(applyChapterReview(state, false).blockedReason, "privacy");

  state = applyChapterReview(state, true).state;
  assert.equal(state.stage, "revision_ready");
  assert.equal(state.revision, 2);
  assert.equal(state.annotations[0].appliedRevision, 2);
  assert.equal(applyAnnotationsToBlock("The draft changed.", "scene", "en", state.annotations), "The changed.");

  const correction = createStoryAnnotation({
    blockId: "scene", type: "revise", sourceLanguage: "en", baseRevision: 2,
    selection: { start: 4, end: 11, text: "changed" }, instruction: "remained provisional",
  });
  state = addStoryAnnotation(state, correction);
  assert.equal(state.stage, "reviewing");
  assert.equal(canMarkChapterReady(state, true), false);

  state = applyChapterReview(state, true).state;
  assert.equal(state.stage, "revision_ready");
  assert.equal(state.revision, 3);
  assert.equal(state.annotations[1].appliedRevision, 3);
  assert.equal(applyAnnotationsToBlock("The draft changed.", "scene", "en", state.annotations), "The remained provisional.");
  assert.equal(canMarkChapterReady(state, true), true);

  state = markChapterReady(state, true);
  assert.equal(state.stage, "human_confirmed");
  assert.equal(state.revision, 3);
  assert.equal(state.publicationApproved, false);

  state = returnChapterToReview(state);
  assert.equal(state.stage, "reviewing");
  assert.equal(state.revision, 3);
  assert.equal(state.publicationApproved, false);
});

test("English and Chinese share annotation provenance and unsupported additions block All set", () => {
  let state = emptyChapterReview();
  const addition = createStoryAnnotation({
    blockId: "outcome", type: "add", sourceLanguage: "zh", baseRevision: 1,
    selection: { start: 0, end: 2, text: "决定" }, instruction: "补充 holdout test 后来提出了挑战。",
  });
  state = addStoryAnnotation(state, addition);
  state = applyChapterReview(state, true).state;
  assert.equal(state.revision, 2);
  assert.equal(state.annotations[0].sourceLanguage, "zh");
  assert.equal(state.annotations[0].resolution, "needs_evidence");
  assert.equal(canMarkChapterReady(state, true), false);
  assert.equal(applyAnnotationsToBlock("Decision followed.", "outcome", "en", state.annotations), "Decision followed.");
  assert.equal(applyAnnotationsToBlock("决定随后形成。", "outcome", "zh", state.annotations), "决定随后形成。");
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

test("range styling rejects stale, mismatched, and cross-language offsets", () => {
  const source = "One paragraph only.";
  const mismatched = createStoryAnnotation({
    blockId: "scene", type: "delete", sourceLanguage: "en", baseRevision: 1,
    selection: { start: 4, end: 13, text: "different" },
  });
  assert.deepEqual(storyAnnotationSegments(source, "scene", "en", 1, [mismatched]), [{ text: source, annotationIds: [] }]);
  assert.deepEqual(storyAnnotationSegments(source, "scene", "zh", 1, [mismatched]), [{ text: source, annotationIds: [] }]);
  assert.deepEqual(storyAnnotationSegments(source, "other-block", "en", 1, [mismatched]), [{ text: source, annotationIds: [] }]);
});
