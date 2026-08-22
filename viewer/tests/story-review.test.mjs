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
  hasStoryAnnotationConflict,
  markChapterReady,
  privacyReviewState,
  returnChapterToReview,
  reviseHighlight,
  storyAnnotationSegments,
  updateInsightReview,
} from "../lib/story-review.ts";

const evidence = { documentId: "doc", eventId: "event" };
const context = (privacyCandidates = [], privacyDecisions = {}, chapterEvidence = [evidence], overrides = {}) => {
  const reviewedBlocks = overrides.reviewedBlocks || { en: {}, zh: {} };
  return {
    privacyCandidates, privacyDecisions, chapterEvidence,
    evidenceResolved: overrides.evidenceResolved ?? true,
    supportedAddIds: overrides.supportedAddIds || [],
    sourceBlocks: overrides.sourceBlocks || reviewedBlocks,
    reviewedBlocks,
  };
};
const blocks = (en = {}, zh = {}) => ({ sourceBlocks: { en, zh }, reviewedBlocks: { en, zh } });
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
  assert.equal(privacyReviewState([privacyCandidate([])], { metric: "invalid" }).complete, false);

  const duplicateIds = [privacyCandidate([]), { ...privacyCandidate([]), title: "Duplicate" }];
  assert.deepEqual(privacyReviewState(duplicateIds, { metric: "redact" }), {
    reviewed: 0, activeIndex: 0, active: duplicateIds[0], complete: false,
  });
  assert.equal(applyChapterReview(emptyChapterReview(), context(duplicateIds, { metric: "redact" })).blockedReason, "privacy");
  assert.equal(applyChapterReview(emptyChapterReview(), context([privacyCandidate()], { metric: "invalid" })).blockedReason, "privacy");
});

test("unresolved Chapter evidence blocks Apply and release-ready confirmation", () => {
  const source = "The draft changed.";
  const removal = createStoryAnnotation({
    blockId: "scene", type: "delete", sourceLanguage: "en", baseRevision: 1,
    selection: { start: 4, end: 10, text: "draft " },
  });
  const reviewing = addStoryAnnotation(emptyChapterReview(), removal);
  const unresolved = context([], {}, [evidence], {
    ...blocks({ scene: source }, { scene: "草稿发生变化。" }),
    evidenceResolved: false,
  });
  const result = applyChapterReview(reviewing, unresolved);
  assert.equal(result.blockedReason, "evidence");
  assert.equal(result.state, reviewing);
  assert.equal(result.state.revision, 1);
  assert.equal(result.state.evidenceVerified, false);
  assert.equal(canMarkChapterReady({ ...reviewing, stage: "revision_ready" }, unresolved), false);
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

  state = applyChapterReview(state, context([], {}, [evidence], blocks({ scene: enSource }, { scene: zhSource }))).state;
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

  state = applyChapterReview(state, context([], {}, [evidence], {
    ...blocks({ scene: "The changed." }, { scene: zhRevised }),
    sourceBlocks: { en: { scene: enSource }, zh: { scene: zhSource } },
  })).state;
  assert.equal(state.revision, 3);
  assert.equal(state.revisionHistory.length, 2);
  assert.deepEqual(state.revisionHistory.map((record) => record.revision), [2, 3]);
  assert.equal(applyAnnotationsToBlock(enSource, "scene", "en", state.annotations), "The remained provisional.");
  assert.equal(applyAnnotationsToBlock(zhSource, "scene", "zh", state.annotations), "这份仍处于假设阶段。");
  const finalContext = context([], {}, [evidence], {
    sourceBlocks: { en: { scene: enSource }, zh: { scene: zhSource } },
    reviewedBlocks: { en: { scene: "The remained provisional." }, zh: { scene: "这份仍处于假设阶段。" } },
  });
  assert.equal(canMarkChapterReady(state, finalContext), true);

  state = markChapterReady(state, finalContext);
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
    supportingEvidence: [evidence],
  });
  state = applyChapterReview(
    addStoryAnnotation(state, unsupported),
    context([], {}, [evidence], blocks({ outcome: "Decision followed." }, { outcome: "决定随后形成。" })),
  ).state;
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
  state = applyChapterReview(
    addStoryAnnotation(state, supported),
    context([], {}, [evidence], { ...blocks({ outcome: enSource }, { outcome: "决定随后形成。" }), supportedAddIds: [supported.id] }),
  ).state;
  assert.equal(state.annotations.at(-1).resolution, "applied");
  assert.equal(applyAnnotationsToBlock(enSource, "outcome", "en", state.annotations), "Decision The holdout evidence remained visible. followed.");
  assert.deepEqual(state.staleTranslations, [{ subject: "story:outcome", language: "zh", count: 1 }]);

  const zhSource = "决定随后形成。";
  const paired = createStoryAnnotation({
    blockId: "outcome", type: "add", sourceLanguage: "zh", baseRevision: 3,
    selection: { start: 0, end: 2, text: "决定" }, instruction: "留存 holdout 证据。",
    supportingEvidence: [evidence],
  });
  state = applyChapterReview(
    addStoryAnnotation(state, paired),
    context([], {}, [evidence], {
      ...blocks({ outcome: "Decision The holdout evidence remained visible. followed." }, { outcome: zhSource }),
      sourceBlocks: { en: { outcome: enSource }, zh: { outcome: zhSource } },
      supportedAddIds: [paired.id],
    }),
  ).state;
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
  const state = applyChapterReview(
    addStoryAnnotation(emptyChapterReview(), correction),
    context([], {}, [evidence], blocks({ outcome: english }, { outcome: chinese })),
  ).state;
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
  state = applyChapterReview(
    addStoryAnnotation(state, removal),
    context([], {}, [evidence], blocks({ scene: "The draft changed." }, { scene: "草稿发生变化。" })),
  ).state;
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

test("Accept cannot erase translation debt from a pending localized insight edit", () => {
  let state = updateInsightReview(emptyChapterReview(), highlight.id, "en", {
    status: "overridden", text: "Focus on reproducibility.",
    highlight: { ...highlight, lesson: "Focus on reproducibility." }, revision: "direct",
  });
  state = updateInsightReview(state, highlight.id, "en", {
    status: "accepted", text: "Focus on reproducibility.",
  });
  assert.deepEqual(state.insightReviews[highlight.id].pendingLanguages, ["en"]);
  state = applyChapterReview(state, context()).state;
  assert.deepEqual(state.staleTranslations, [{ subject: `insight:${highlight.id}`, language: "zh", count: 1 }]);
  assert.equal(canMarkChapterReady(state, context()), false);
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

test("overlapping or stale ranges are rejected atomically before revision provenance", () => {
  const source = "abcdef";
  const removal = createStoryAnnotation({
    blockId: "scene", type: "delete", sourceLanguage: "en", baseRevision: 1,
    selection: { start: 1, end: 4, text: "bcd" },
  });
  const correction = createStoryAnnotation({
    blockId: "scene", type: "revise", sourceLanguage: "en", baseRevision: 1,
    selection: { start: 3, end: 5, text: "de" }, instruction: "X",
  });
  const first = addStoryAnnotation(emptyChapterReview(), removal);
  assert.equal(hasStoryAnnotationConflict(first, correction), true);
  assert.equal(addStoryAnnotation(first, correction), first);
  const duplicateId = { ...correction, id: removal.id, selection: { start: 4, end: 5, text: "e" } };
  assert.equal(hasStoryAnnotationConflict(first, duplicateId), true);

  const adversarial = { ...emptyChapterReview(), annotations: [removal, correction] };
  const result = applyChapterReview(
    adversarial,
    context([], {}, [evidence], blocks({ scene: source }, { scene: "uvwxyz" })),
  );
  assert.equal(result.blockedReason, "annotations");
  assert.equal(result.state, adversarial);
  assert.deepEqual(result.state.annotations.map((annotation) => annotation.resolution), ["pending", "pending"]);
  assert.equal(result.state.revision, 1);

  const mismatched = { ...emptyChapterReview(), annotations: [{
    ...removal,
    id: "mismatched",
    selection: { start: 1, end: 4, text: "wrong" },
  }] };
  assert.equal(applyChapterReview(
    mismatched,
    context([], {}, [evidence], blocks({ scene: source }, { scene: "uvwxyz" })),
  ).blockedReason, "annotations");

  const duplicatedIds = { ...emptyChapterReview(), annotations: [removal, duplicateId] };
  assert.equal(applyChapterReview(
    duplicatedIds,
    context([], {}, [evidence], blocks({ scene: source }, { scene: "uvwxyz" })),
  ).blockedReason, "annotations");

  const missingInstruction = { ...emptyChapterReview(), annotations: [{
    ...correction,
    id: "missing-instruction",
    instruction: undefined,
    selection: { start: 4, end: 5, text: "e" },
  }] };
  assert.equal(applyChapterReview(
    missingInstruction,
    context([], {}, [evidence], blocks({ scene: source }, { scene: "uvwxyz" })),
  ).blockedReason, "annotations");
});

test("the complete annotation ledger rejects malformed applied records and mixed-resolution ID collisions", () => {
  const sourceBlocks = { en: { scene: "abc" }, zh: { scene: "甲乙丙" } };
  const malformedApplied = {
    ...emptyChapterReview(),
    stage: "revision_ready",
    revision: 2,
    evidenceVerified: true,
    annotations: [{
      id: "bad", blockId: "scene", type: "delete", sourceLanguage: "en",
      selection: { start: 0, end: 2, text: "WR" },
      resolution: "applied", baseRevision: 1, appliedRevision: 2,
    }],
    revisionHistory: [{ revision: 2, annotationIds: ["bad"], insightIds: [], privacyDecisions: {} }],
  };
  const malformedContext = context([], {}, [evidence], { sourceBlocks, reviewedBlocks: sourceBlocks });
  const malformedResult = applyChapterReview(malformedApplied, malformedContext);
  assert.equal(malformedResult.blockedReason, "annotations");
  assert.equal(malformedResult.state, malformedApplied);
  assert.equal(malformedResult.state.revision, 2);
  assert.equal(canMarkChapterReady(malformedApplied, malformedContext), false);

  const pending = createStoryAnnotation({
    blockId: "scene", type: "delete", sourceLanguage: "en", baseRevision: 1,
    selection: { start: 0, end: 1, text: "a" },
  });
  const collision = {
    ...emptyChapterReview(),
    annotations: [{ ...pending, resolution: "cancelled" }, pending],
  };
  const collisionResult = applyChapterReview(collision, malformedContext);
  assert.equal(collisionResult.blockedReason, "annotations");
  assert.equal(collisionResult.state, collision);

  const bogusResolution = {
    ...emptyChapterReview(),
    annotations: [{ ...pending, id: "bogus", resolution: "silently_skipped" }],
  };
  assert.equal(applyChapterReview(bogusResolution, malformedContext).blockedReason, "annotations");
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
