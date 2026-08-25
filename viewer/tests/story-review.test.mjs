import test from "node:test";
import assert from "node:assert/strict";
import {
  addStoryAnnotation,
  applyAnnotationsToBlock,
  applyChapterReview,
  applyStoryReviewToBlock,
  canRedoStoryEdit,
  canMarkChapterReady,
  canUndoStoryEdit,
  cancelStoryAnnotation,
  chapterReviewSummary,
  createStoryAnnotation,
  directStoryEditNeedsEvidence,
  deriveDirectStoryMutation,
  discardStoryEdit,
  emptyChapterReview,
  hasStoryAnnotationConflict,
  insightReviewFeedbackState,
  markChapterReady,
  normalizeDirectBeforeInput,
  privacyReviewState,
  privacyDecisionKey,
  recordStoryEdit,
  redoStoryEdit,
  revertAppliedStoryEdit,
  returnChapterToReview,
  reviseHighlight,
  storyAnnotationSegments,
  storyEditSegments,
  storyWorkingBlock,
  sanitizeStoryPaste,
  undoStoryEdit,
  updateInsightReview,
} from "../lib/story-review.ts";

const evidence = { documentId: "doc", eventId: "event" };
const reviewableInsightId = "shared-lesson";
const targetCatalog = new Map([
  ["scene", { target: "scene", kind: "scalar", field: "scene" }],
  [`insight:${reviewableInsightId}`, { target: `insight:${reviewableInsightId}`, kind: "insight", id: reviewableInsightId }],
]);
const context = (privacyCandidates = [], privacyDecisions = {}, chapterEvidence = [evidence], overrides = {}) => {
  const reviewedBlocks = overrides.reviewedBlocks || { en: {}, zh: {} };
  return {
    storyKey: overrides.storyKey || "chapter",
    privacyCandidates, privacyDecisions, chapterEvidence,
    targetCatalog: overrides.targetCatalog || targetCatalog,
    reviewableInsightIds: overrides.reviewableInsightIds || [reviewableInsightId],
    evidenceResolved: overrides.evidenceResolved ?? true,
    supportedAddIds: overrides.supportedAddIds || [],
    supportedEditIds: overrides.supportedEditIds || [],
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
  id: reviewableInsightId,
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

test("Chapter-local Privacy decision keys are injective across delimiter-shaped identities", () => {
  const first = privacyDecisionKey("chapter:alpha", "candidate");
  const second = privacyDecisionKey("chapter", "alpha:candidate");
  assert.notEqual(first, second);
  assert.deepEqual(JSON.parse(first), ["chapter:alpha", "candidate"]);
  assert.deepEqual(JSON.parse(second), ["chapter", "alpha:candidate"]);
});

test("review summary reserves unsupported-Add guidance for actual needs-evidence additions", () => {
  const staleOnly = {
    ...emptyChapterReview(),
    staleTranslations: [{ subject: "story:scene", language: "zh", count: 1 }],
  };
  assert.deepEqual(chapterReviewSummary(staleOnly), {
    delete: 0, revise: 0, add: 0, pendingAnnotations: 0, needsEvidenceAdd: 0, pendingInsights: 0, unresolved: 0,
  });

  const unsupportedAdd = createStoryAnnotation({
    blockId: "scene", type: "add", sourceLanguage: "en", baseRevision: 1,
    selection: { start: 0, end: 3, text: "The" }, instruction: "Unsupported fact",
  });
  const addSummary = chapterReviewSummary({
    ...emptyChapterReview(),
    annotations: [{ ...unsupportedAdd, resolution: "needs_evidence" }],
  });
  assert.equal(addSummary.needsEvidenceAdd, 1);
  assert.equal(addSummary.pendingInsights, 0);

  const insightOnly = chapterReviewSummary({
    ...emptyChapterReview(),
    insightReviews: {
      lesson: {
        status: "overridden", text: "Review this", resolution: "pending",
        localized: {}, pendingLanguages: ["en"],
      },
    },
  });
  assert.equal(insightOnly.needsEvidenceAdd, 0);
  assert.equal(insightOnly.pendingInsights, 1);
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

test("one-language Revise leaves paired prose intact without blocking canonical review", () => {
  const english = "The decision was final.";
  const chinese = "这个决定当时仍是假设。";
  const correction = createStoryAnnotation({
    blockId: "outcome", type: "revise", sourceLanguage: "en", baseRevision: 1,
    selection: { start: 4, end: 12, text: "decision" }, instruction: "hypothesis",
  });
  const reviewContext = context([], {}, [evidence], blocks({ outcome: english }, { outcome: chinese }));
  const state = applyChapterReview(
    addStoryAnnotation(emptyChapterReview(), correction),
    reviewContext,
  ).state;
  assert.equal(applyAnnotationsToBlock(english, "outcome", "en", state.annotations), "The hypothesis was final.");
  assert.equal(applyAnnotationsToBlock(chinese, "outcome", "zh", state.annotations), chinese);
  assert.deepEqual(state.staleTranslations, [{ subject: "story:outcome", language: "zh", count: 1 }]);
  assert.equal(canMarkChapterReady(state, reviewContext), true);
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

test("insight edits retain localization debt without making it a readiness gate", () => {
  let state = updateInsightReview(emptyChapterReview(), highlight.id, "en", {
    status: "overridden", text: "Focus on reproducibility.",
    highlight: { ...highlight, lesson: "Focus on reproducibility." }, revision: "direct",
  });
  assert.equal(state.stage, "reviewing");
  state = applyChapterReview(state, context()).state;
  assert.deepEqual(state.staleTranslations, [{ subject: `insight:${highlight.id}`, language: "zh", count: 1 }]);
  assert.equal(canMarkChapterReady(state, context()), true);

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

test("Accept preserves non-blocking localization debt from a localized insight edit", () => {
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
  assert.equal(canMarkChapterReady(state, context()), true);
});

test("Insight feedback distinguishes pending decisions from applied revisions", () => {
  let state = emptyChapterReview();
  assert.equal(insightReviewFeedbackState(state.insightReviews[highlight.id]), "none");

  state = updateInsightReview(state, highlight.id, "en", {
    status: "accepted", text: highlight.lesson,
  });
  assert.equal(insightReviewFeedbackState(state.insightReviews[highlight.id]), "accepted_pending");
  assert.equal(chapterReviewSummary(state).pendingInsights, 1);

  state = updateInsightReview(state, highlight.id, "en", {
    status: "rejected", text: highlight.lesson,
  });
  assert.equal(insightReviewFeedbackState(state.insightReviews[highlight.id]), "rejected_pending");
  assert.equal(state.publicationApproved, false);

  state = applyChapterReview(state, context()).state;
  assert.equal(insightReviewFeedbackState(state.insightReviews[highlight.id]), "rejected_applied");
  assert.equal(state.insightReviews[highlight.id].appliedRevision, state.revision);
  assert.equal(chapterReviewSummary(state).pendingInsights, 0);
  assert.equal(state.publicationApproved, false);
});

test("Reopen restores an applied rejected insight through a new reviewed revision", () => {
  let state = updateInsightReview(emptyChapterReview(), highlight.id, "en", {
    status: "rejected", text: highlight.lesson,
  });
  state = applyChapterReview(state, context()).state;
  assert.equal(state.revision, 2);
  assert.equal(state.insightReviews[highlight.id].status, "rejected");
  assert.equal(state.insightReviews[highlight.id].resolution, "applied");
  assert.equal(canMarkChapterReady(state, context()), true);

  state = markChapterReady(state, context());
  state = returnChapterToReview(state);
  assert.equal(state.stage, "reviewing");
  assert.equal(state.revision, 2);

  state = updateInsightReview(state, highlight.id, "en", {
    status: "accepted", text: highlight.lesson,
  });
  assert.equal(state.insightReviews[highlight.id].resolution, "pending");
  assert.equal(canMarkChapterReady(state, context()), false);

  state = applyChapterReview(state, context()).state;
  assert.equal(state.revision, 3);
  assert.equal(state.insightReviews[highlight.id].status, "accepted");
  assert.equal(state.insightReviews[highlight.id].resolution, "applied");
  assert.deepEqual(state.revisionHistory.map((record) => record.insightIds), [[highlight.id], [highlight.id]]);
  assert.equal(canMarkChapterReady(state, context()), true);
  state = markChapterReady(state, context());
  assert.equal(state.stage, "human_confirmed");
  assert.equal(state.publicationApproved, false);
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

test("reduced beforeinput metadata is normalized without reading unknown fields as strings", () => {
  const missing = normalizeDirectBeforeInput({
    nativeEvent: {}, selectionStart: 2, selectionEnd: 2, valueLength: 5,
  });
  assert.deepEqual(missing.metadata, {
    inputTypeMissing: true,
    dataState: "missing",
    selectionStart: 2,
    selectionEnd: 2,
    editCategory: "unknown",
    isComposing: false,
  });
  assert.equal(missing.mutation, null);

  const nullData = normalizeDirectBeforeInput({
    nativeEvent: { inputType: "insertText", data: null },
    selectionStart: 1, selectionEnd: 1, valueLength: 3,
  });
  assert.equal(nullData.metadata.dataState, "null");
  assert.equal(nullData.mutation, null);

  const undefinedData = normalizeDirectBeforeInput({
    nativeEvent: { inputType: "insertText", data: undefined },
    selectionStart: 1, selectionEnd: 1, valueLength: 3,
  });
  assert.equal(undefinedData.metadata.dataState, "missing");
  assert.equal(undefinedData.mutation, null);
});

test("beforeinput normalization covers insert, replacement, delete, paste, and composition categories", () => {
  const normalized = (nativeEvent, selectionStart, selectionEnd, valueLength = 6) => normalizeDirectBeforeInput({
    nativeEvent, selectionStart, selectionEnd, valueLength,
  });
  assert.deepEqual(normalized({ inputType: "insertText", data: "x" }, 2, 2).mutation,
    { start: 2, end: 2, insertedText: "x" });
  assert.deepEqual(normalized({ inputType: "insertReplacementText", data: "term" }, 1, 4).mutation,
    { start: 1, end: 4, insertedText: "term" });
  assert.deepEqual(normalized({ inputType: "deleteContentBackward", data: null }, 2, 2).mutation,
    { start: 1, end: 2, insertedText: "" });
  assert.deepEqual(normalized({ inputType: "deleteContentForward" }, 2, 2).mutation,
    { start: 2, end: 3, insertedText: "" });
  assert.equal(normalized({ inputType: "insertFromPaste", data: null }, 2, 2).metadata.editCategory, "insert");
  assert.equal(normalized({ inputType: "insertFromPaste", data: null }, 2, 2).mutation, null);
  const composing = normalized({ inputType: "insertCompositionText", data: "x", isComposing: true }, 2, 2);
  assert.equal(composing.metadata.editCategory, "composition");
  assert.equal(composing.metadata.isComposing, true);
  assert.equal(composing.mutation, null);
});

test("controlled previous and next text derive one safe fallback mutation", () => {
  assert.deepEqual(deriveDirectStoryMutation({ previousText: "abcd", nextText: "abXcd", selectionAfter: 3 }),
    { start: 2, end: 2, insertedText: "X" });
  assert.deepEqual(deriveDirectStoryMutation({ previousText: "alpha beta", nextText: "alpha term", selectionAfter: 10 }),
    { start: 6, end: 10, insertedText: "term" });
  assert.deepEqual(deriveDirectStoryMutation({ previousText: "abcd", nextText: "acd", selectionAfter: 1 }),
    { start: 1, end: 2, insertedText: "" });
  assert.deepEqual(deriveDirectStoryMutation({ previousText: "abcd", nextText: "abd", selectionAfter: 2 }),
    { start: 2, end: 3, insertedText: "" });
  assert.deepEqual(deriveDirectStoryMutation({
    previousText: "abcd", nextText: "abXcd", selectionAfter: 3,
    beforeInputMutation: { start: 0, end: 0, insertedText: "wrong" },
  }), { start: 2, end: 2, insertedText: "X" });
  assert.equal(deriveDirectStoryMutation({ previousText: "same", nextText: "same", selectionAfter: 4 }), null);
});

test("fallback mutation records one transaction and preserves Undo/Redo identity", () => {
  const source = "One draft.";
  const mutation = deriveDirectStoryMutation({ previousText: source, nextText: "One revised draft.", selectionAfter: 11 });
  assert.ok(mutation);
  let state = recordStoryEdit(emptyChapterReview(), {
    storyKey: "chapter", blockId: "scene", sourceLanguage: "en",
    baseText: source, nextText: "One revised draft.", workingRange: { start: mutation.start, end: mutation.end },
    insertedText: mutation.insertedText, now: 100,
  }).state;
  assert.equal(state.editTransactions.length, 1);
  const transactionId = state.editTransactions[0].id;
  state = undoStoryEdit(state, "en");
  state = redoStoryEdit(state, "en");
  assert.equal(state.editTransactions.length, 1);
  assert.equal(state.editTransactions[0].id, transactionId);
  assert.equal(storyWorkingBlock(source, "chapter", "scene", "en", state), "One revised draft.");
});

test("direct Story typing is a controlled coalesced block-local transaction", () => {
  const source = "The draft changed.";
  let state = emptyChapterReview();
  let result = recordStoryEdit(state, {
    storyKey: "chapter", blockId: "scene", sourceLanguage: "en",
    baseText: source, nextText: "The xdraft changed.", now: 100,
  });
  assert.equal(result.blockedReason, undefined);
  state = result.state;
  assert.equal(state.editTransactions.length, 1);
  assert.equal(state.editTransactions[0].operation, "insert");
  assert.equal(storyWorkingBlock(source, "chapter", "scene", "en", state), "The xdraft changed.");

  result = recordStoryEdit(state, {
    storyKey: "chapter", blockId: "scene", sourceLanguage: "en",
    baseText: source, nextText: "The xydraft changed.", now: 120,
  });
  state = result.state;
  assert.equal(state.editTransactions.length, 1);
  assert.equal(state.editTransactions[0].afterText, "xy");
  assert.equal(storyWorkingBlock(source, "chapter", "scene", "en", state), "The xydraft changed.");
  assert.deepEqual(storyEditSegments(source, "chapter", "scene", "en", state), [
    { text: "The ", transactionIds: [] },
    { text: "xy", transactionIds: [state.editTransactions[0].id] },
    { text: "draft changed.", transactionIds: [] },
  ]);
});

test("selection replacement, keyboard deletion, and independent Discard preserve unrelated edits", () => {
  const source = "Alpha beta gamma.";
  let state = recordStoryEdit(emptyChapterReview(), {
    storyKey: "chapter", blockId: "scene", sourceLanguage: "en",
    baseText: source, nextText: "Omega beta gamma.", workingRange: { start: 0, end: 5 }, insertedText: "Omega", now: 100,
  }).state;
  const firstId = state.editTransactions[0].id;
  state = recordStoryEdit(state, {
    storyKey: "chapter", blockId: "scene", sourceLanguage: "en",
    baseText: source, nextText: "Omega beta delta.", workingRange: { start: 11, end: 16 }, insertedText: "delta", now: 5_000,
  }).state;
  assert.equal(state.editTransactions.length, 2);
  const secondId = state.editTransactions[1].id;
  assert.notEqual(firstId, secondId);
  assert.equal(storyWorkingBlock(source, "chapter", "scene", "en", state), "Omega beta delta.");

  state = discardStoryEdit(state, firstId);
  assert.equal(storyWorkingBlock(source, "chapter", "scene", "en", state), "Alpha beta delta.");
  assert.equal(state.editTransactions.find((transaction) => transaction.id === firstId).resolution, "reverted");
  assert.equal(state.editTransactions.find((transaction) => transaction.id === secondId).resolution, "pending");

  state = recordStoryEdit(state, {
    storyKey: "chapter", blockId: "scene", sourceLanguage: "en",
    baseText: source, nextText: "Alpha beta .", workingRange: { start: 11, end: 16 }, insertedText: "", now: 6_000,
  }).state;
  assert.equal(storyWorkingBlock(source, "chapter", "scene", "en", state), "Alpha beta .");
  assert.equal(state.editTransactions.at(-1).operation, "delete");
});

test("transaction-synchronized Undo and Redo restore the draft and note identity", () => {
  const source = "One useful sentence.";
  let state = recordStoryEdit(emptyChapterReview(), {
    storyKey: "chapter", blockId: "scene", sourceLanguage: "en",
    baseText: source, nextText: "One precise sentence.", now: 100,
  }).state;
  const transactionId = state.editTransactions[0].id;
  assert.equal(canUndoStoryEdit(state, "en"), true);
  assert.equal(canRedoStoryEdit(state, "en"), false);

  state = undoStoryEdit(state, "en");
  assert.equal(storyWorkingBlock(source, "chapter", "scene", "en", state), source);
  assert.equal(canUndoStoryEdit(state, "en"), false);
  assert.equal(canRedoStoryEdit(state, "en"), true);

  state = redoStoryEdit(state, "en");
  assert.equal(storyWorkingBlock(source, "chapter", "scene", "en", state), "One precise sentence.");
  assert.equal(state.editTransactions[0].id, transactionId);
  assert.equal(state.editTransactions.length, 1);
});

test("Undo targets the most recently changed transaction after coalescing", () => {
  const source = "Alpha beta gamma.";
  let state = recordStoryEdit(emptyChapterReview(), {
    storyKey: "chapter", blockId: "scene", sourceLanguage: "en",
    baseText: source, nextText: "Omega beta gamma.", workingRange: { start: 0, end: 5 }, insertedText: "Omega", now: 100,
  }).state;
  state = recordStoryEdit(state, {
    storyKey: "chapter", blockId: "scene", sourceLanguage: "en",
    baseText: source, nextText: "Omega beta delta.", workingRange: { start: 11, end: 16 }, insertedText: "delta", now: 200,
  }).state;
  state = recordStoryEdit(state, {
    storyKey: "chapter", blockId: "scene", sourceLanguage: "en",
    baseText: source, nextText: "Omegax beta delta.", workingRange: { start: 5, end: 5 }, insertedText: "x", now: 300,
  }).state;

  assert.equal(state.editTransactions.length, 2);
  assert.equal(state.editTransactions[0].updatedAt, 300);
  state = undoStoryEdit(state, "en");
  assert.equal(storyWorkingBlock(source, "chapter", "scene", "en", state), "Alpha beta delta.");
  assert.equal(state.editTransactions[0].resolution, "reverted");
  assert.equal(state.editTransactions[1].resolution, "pending");
});

test("plain-text paste strips markup and preserves safe paragraph breaks", () => {
  assert.equal(
    sanitizeStoryPaste("<b>Useful</b>\r\n<script>alert(1)</script>Second\u0000 line"),
    "Useful\nSecond line",
  );
});

test("material standalone direct additions fail visibly until reviewed Evidence supports them", () => {
  const source = "The benchmark remained provisional.";
  const next = `${source} Internal score 42.`;
  assert.equal(directStoryEditNeedsEvidence("insert", "", " Internal score 42.", { start: source.length, end: source.length }, source.length), true);
  let state = recordStoryEdit(emptyChapterReview(), {
    storyKey: "chapter", blockId: "scene", sourceLanguage: "en",
    baseText: source, nextText: next, supportingEvidence: [evidence], now: 100,
  }).state;
  const transactionId = state.editTransactions[0].id;
  const sourceBlocks = { en: { scene: source }, zh: { scene: "基准仍是临时方案。" } };
  const blocked = applyChapterReview(state, context([], {}, [evidence], {
    sourceBlocks, reviewedBlocks: sourceBlocks,
  }));
  assert.equal(blocked.blockedReason, "direct_evidence");
  assert.equal(blocked.state.revision, 1);
  assert.equal(blocked.state.editTransactions[0].resolution, "needs_evidence");

  const applied = applyChapterReview(blocked.state, context([], {}, [evidence], {
    sourceBlocks, reviewedBlocks: sourceBlocks, supportedEditIds: [transactionId],
  }));
  assert.equal(applied.blockedReason, undefined);
  assert.equal(applied.state.revision, 2);
  assert.equal(applied.state.editTransactions[0].resolution, "applied");
  assert.deepEqual(applied.state.revisionHistory[0].editTransactionIds, [transactionId]);
  assert.equal(applyStoryReviewToBlock(source, "scene", "en", applied.state), next);
  assert.deepEqual(applied.state.staleTranslations, [{ subject: "story:scene", language: "zh", count: 1 }]);
});

test("applied direct history cannot be undone and Revert creates a new pending revision transaction", () => {
  const source = "The draft changed.";
  const next = "The chapter changed.";
  let state = recordStoryEdit(emptyChapterReview(), {
    storyKey: "chapter", blockId: "scene", sourceLanguage: "en",
    baseText: source, nextText: next, now: 100,
  }).state;
  const sourceBlocks = { en: { scene: source }, zh: { scene: "草稿发生了变化。" } };
  state = applyChapterReview(state, context([], {}, [evidence], { sourceBlocks, reviewedBlocks: sourceBlocks })).state;
  const appliedId = state.editTransactions[0].id;
  assert.equal(undoStoryEdit(state, "en"), state);

  const reverted = revertAppliedStoryEdit(state, appliedId, source, 200);
  assert.equal(reverted.blockedReason, undefined);
  assert.equal(reverted.state.revision, 2);
  assert.equal(reverted.state.stage, "reviewing");
  assert.equal(reverted.state.editTransactions[0].resolution, "applied");
  assert.equal(reverted.state.editTransactions[1].resolution, "pending");
  assert.equal(reverted.state.editTransactions[1].requiresEvidence, false);
  assert.equal(reverted.state.editTransactions[1].supportingEvidence, undefined);
  assert.equal(reverted.state.editTransactions[1].revertsTransactionId, appliedId);
  assert.equal(storyWorkingBlock(source, "chapter", "scene", "en", reverted.state), source);
});

test("Revert cannot coalesce with or clear evidence debt from an unrelated pending addition", () => {
  const source = "Internal claim.";
  const deleted = " claim.";
  const sourceBlocks = { en: { scene: source }, zh: { scene: "内部主张。" } };
  let state = recordStoryEdit(emptyChapterReview(), {
    storyKey: "chapter", blockId: "scene", sourceLanguage: "en",
    baseText: source, nextText: deleted, workingRange: { start: 0, end: 8 }, insertedText: "", now: 100,
  }).state;
  state = applyChapterReview(state, context([], {}, [evidence], { sourceBlocks, reviewedBlocks: sourceBlocks })).state;
  const appliedDeleteId = state.editTransactions[0].id;
  state = recordStoryEdit(state, {
    storyKey: "chapter", blockId: "scene", sourceLanguage: "en",
    baseText: deleted, nextText: "Score 42.  claim.", workingRange: { start: 0, end: 0 }, insertedText: "Score 42. ", now: 200,
  }).state;
  const unsupportedId = state.editTransactions[1].id;
  assert.equal(state.editTransactions[1].requiresEvidence, true);

  const reverted = revertAppliedStoryEdit(state, appliedDeleteId, source, 300);
  assert.equal(reverted.blockedReason, "overlap");
  assert.equal(reverted.state, state);
  assert.equal(state.editTransactions.find((transaction) => transaction.id === unsupportedId).requiresEvidence, true);
  assert.equal(applyChapterReview(state, context([], {}, [evidence], {
    sourceBlocks, reviewedBlocks: { en: { scene: deleted }, zh: sourceBlocks.zh },
  })).blockedReason, "direct_evidence");
});

test("direct editing fails closed when a pending semantic annotation owns the same block", () => {
  const source = "One paragraph.";
  const annotation = createStoryAnnotation({
    blockId: "scene", type: "delete", sourceLanguage: "en", baseRevision: 1,
    selection: { start: 0, end: 3, text: "One" },
  });
  const state = addStoryAnnotation(emptyChapterReview(), annotation);
  const result = recordStoryEdit(state, {
    storyKey: "chapter", blockId: "scene", sourceLanguage: "en",
    baseText: source, nextText: "A paragraph.", now: 100,
  });
  assert.equal(result.blockedReason, "annotation");
  assert.equal(result.state, state);
});

test("forged duplicate, overlapping, and malformed applied direct-edit ledgers fail closed", () => {
  const source = "Alpha beta gamma.";
  const sourceBlocks = { en: { scene: source }, zh: { scene: "甲乙丙。" } };
  const reviewContext = context([], {}, [evidence], { sourceBlocks, reviewedBlocks: sourceBlocks });
  const legitimate = recordStoryEdit(emptyChapterReview(), {
    storyKey: "chapter", blockId: "scene", sourceLanguage: "en",
    baseText: source, nextText: "Omega beta gamma.",
    workingRange: { start: 0, end: 5 }, insertedText: "Omega", now: 100,
  }).state;

  const duplicate = {
    ...legitimate,
    editTransactions: [...legitimate.editTransactions, { ...legitimate.editTransactions[0] }],
  };
  assert.equal(applyChapterReview(duplicate, reviewContext).blockedReason, "annotations");

  const overlapping = {
    ...legitimate,
    editTransactions: [...legitimate.editTransactions, {
      ...legitimate.editTransactions[0],
      id: "scene:edit:101:other",
      beforeText: source.slice(2, 6),
      afterText: "XYZ",
      beforeRange: { start: 2, end: 6 },
      afterRange: { start: 2, end: 5 },
      createdAt: 101,
      updatedAt: 101,
    }],
  };
  assert.equal(applyChapterReview(overlapping, reviewContext).blockedReason, "annotations");

  const wrongChapter = structuredClone(legitimate);
  wrongChapter.editTransactions[0].storyKey = "different-chapter";
  assert.equal(applyChapterReview(wrongChapter, reviewContext).blockedReason, "annotations");

  const applied = applyChapterReview(legitimate, reviewContext).state;
  const malformedRange = structuredClone(applied);
  malformedRange.editTransactions[0].afterRange.end += 1;
  assert.equal(applyChapterReview(malformedRange, {
    ...reviewContext,
    reviewedBlocks: { en: { scene: "Omega beta gamma." }, zh: sourceBlocks.zh },
  }).blockedReason, "annotations");

  const missingRevisionOwnership = structuredClone(applied);
  missingRevisionOwnership.revisionHistory[0].editTransactionIds = [];
  assert.equal(applyChapterReview(missingRevisionOwnership, {
    ...reviewContext,
    reviewedBlocks: { en: { scene: "Omega beta gamma." }, zh: sourceBlocks.zh },
  }).blockedReason, "annotations");
});

test("English and Chinese share Undo, Redo, repeated Apply, and one completion lifecycle", () => {
  const sourceBlocks = { en: { scene: "Draft chapter." }, zh: { scene: "章节草稿。" } };
  let state = recordStoryEdit(emptyChapterReview(), {
    storyKey: "chapter", blockId: "scene", sourceLanguage: "en",
    baseText: sourceBlocks.en.scene, nextText: "Reviewed chapter.", now: 100,
  }).state;
  state = recordStoryEdit(state, {
    storyKey: "chapter", blockId: "scene", sourceLanguage: "zh",
    baseText: sourceBlocks.zh.scene, nextText: "已审阅章节。", now: 200,
  }).state;
  const sharedRevision = state.revision;
  state = undoStoryEdit(state, "en");
  assert.equal(state.revision, sharedRevision);
  assert.equal(storyWorkingBlock(sourceBlocks.en.scene, "chapter", "scene", "en", state), sourceBlocks.en.scene);
  assert.equal(storyWorkingBlock(sourceBlocks.zh.scene, "chapter", "scene", "zh", state), "已审阅章节。");
  state = redoStoryEdit(state, "en");
  assert.equal(state.revision, sharedRevision);

  const firstContext = context([], {}, [evidence], { sourceBlocks, reviewedBlocks: sourceBlocks });
  state = applyChapterReview(state, firstContext).state;
  assert.equal(state.stage, "revision_ready");
  assert.equal(state.revision, 2);
  assert.equal(canMarkChapterReady(state, {
    ...firstContext,
    reviewedBlocks: { en: { scene: "Reviewed chapter." }, zh: { scene: "已审阅章节。" } },
  }), true);

  state = recordStoryEdit(state, {
    storyKey: "chapter", blockId: "scene", sourceLanguage: "en",
    baseText: "Reviewed chapter.", nextText: "Final reviewed chapter.", now: 300,
  }).state;
  assert.equal(state.stage, "reviewing");
  assert.equal(canMarkChapterReady(state, firstContext), false);
  state = recordStoryEdit(state, {
    storyKey: "chapter", blockId: "scene", sourceLanguage: "zh",
    baseText: "已审阅章节。", nextText: "最终审阅章节。", now: 400,
  }).state;

  const secondContext = context([], {}, [evidence], {
    sourceBlocks,
    reviewedBlocks: { en: { scene: "Reviewed chapter." }, zh: { scene: "已审阅章节。" } },
  });
  state = applyChapterReview(state, secondContext).state;
  assert.equal(state.stage, "revision_ready");
  assert.equal(state.revision, 3);
  assert.deepEqual(state.staleTranslations, []);
  const finalContext = {
    ...secondContext,
    reviewedBlocks: { en: { scene: "Final reviewed chapter." }, zh: { scene: "最终审阅章节。" } },
  };
  assert.equal(canMarkChapterReady(state, finalContext), true);
  state = markChapterReady(state, finalContext);
  assert.equal(state.stage, "human_confirmed");
  assert.equal(state.publicationApproved, false);
});

test("translation debt is block-scoped and one paired-block review clears multiple source edits", () => {
  const sourceBlocks = { en: { scene: "Alpha beta gamma." }, zh: { scene: "甲乙丙。" } };
  let state = recordStoryEdit(emptyChapterReview(), {
    storyKey: "chapter", blockId: "scene", sourceLanguage: "en",
    baseText: sourceBlocks.en.scene, nextText: "Omega beta gamma.", workingRange: { start: 0, end: 5 }, insertedText: "Omega", now: 100,
  }).state;
  state = recordStoryEdit(state, {
    storyKey: "chapter", blockId: "scene", sourceLanguage: "en",
    baseText: sourceBlocks.en.scene, nextText: "Omega beta delta.", workingRange: { start: 11, end: 16 }, insertedText: "delta", now: 200,
  }).state;
  state = applyChapterReview(state, context([], {}, [evidence], { sourceBlocks, reviewedBlocks: sourceBlocks })).state;
  assert.deepEqual(state.staleTranslations, [{ subject: "story:scene", language: "zh", count: 1 }]);

  const reviewedEnglish = "Omega beta delta.";
  state = recordStoryEdit(state, {
    storyKey: "chapter", blockId: "scene", sourceLanguage: "zh",
    baseText: sourceBlocks.zh.scene, nextText: "已对齐译文。", now: 300,
  }).state;
  state = applyChapterReview(state, context([], {}, [evidence], {
    sourceBlocks,
    reviewedBlocks: { en: { scene: reviewedEnglish }, zh: sourceBlocks.zh },
  })).state;
  assert.deepEqual(state.staleTranslations, []);
});
