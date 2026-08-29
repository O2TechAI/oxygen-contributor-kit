import test from "node:test";
import assert from "node:assert/strict";
import { testStoryCoverage } from "./fixtures/story-coverage.mjs";
import { readFile } from "node:fs/promises";
import {
  addStoryAnnotation,
  applyChapterReview,
  canRedoStoryEdit,
  canUndoStoryEdit,
  createStoryAnnotation,
  editAiInsight,
  editHumanInsight,
  emptyChapterReview,
  recordStoryEdit,
  saveHumanInsight,
  storyWorkingBlock,
  chapterReviewCompletionBlockers,
  humanQuoteText,
  storyBlocks,
  updateAiInsightDecision,
  undoStoryEdit,
  redoStoryEdit,
  validateChapterReviewCompletion,
} from "../lib/story-review.ts";
import {
  STORY_REVIEW_SESSION_SCHEMA,
  canonicalizeStoryReviewSession,
  createStoryReviewSession,
  hydrateStoryReviewSession,
  parseStoryReviewSession,
} from "../lib/story-review-session.ts";

const evidenceA = { documentId: "story-document", eventId: "event-a" };
const evidenceB = { documentId: "story-document", eventId: "event-b" };

function insight(id, blockId = "block-a") {
  return {
    id,
    background: "A bounded synthetic context.",
    anchorStoryBlockId: blockId,
    quote: {
      text: "The reviewer checked the boundary.",
      evidence: evidenceA,
    },
    directlyAcquiredExperience: "The checked boundary changed the next action.",
    principle: "Check the relevant boundary before relying on the result.",
    evidence: [evidenceA],
  };
}

function source(insightIds = [], key = "chapter-alpha") {
  return {
    schema: "oxygen.story",
    key,
    phase: { id: "phase-foundation", label: "Foundation" },
    title: "A supported synthetic Chapter",
    overview: "The safe synthetic Story preserves the supported sequence.",
    people: [{
      id: "person-reviewer",
      releaseLabel: "Reviewer",
      role: "reviewer",
      description: "Checked the synthetic boundary.",
      localIdentityState: "not_identified",
      evidence: [evidenceA],
    }],
    story: {
      blocks: [
        { id: "block-a", text: "The reviewer checked the boundary.", evidence: [evidenceA] },
        { id: "block-b", text: "The next action used the result.", evidence: [evidenceB] },
      ],
    },
    insights: insightIds.map((id) => insight(id)),
    evidence: { primary: evidenceA, supporting: [evidenceB] },
    coverage: testStoryCoverage(),
  };
}

function context(currentSource, overrides = {}) {
  const blocks = storyBlocks(currentSource);
  return {
    source: currentSource,
    privacyCandidates: [],
    privacyDecisions: {},
    targetCatalog: new Map(),
    evidenceResolved: true,
    supportedAddIds: [],
    supportedEditIds: [],
    sourceBlocks: blocks,
    reviewedBlocks: blocks,
    ...overrides,
  };
}

function humanContent(currentSource, overrides = {}) {
  return {
    background: "A human-authored bounded context.",
    quote: {
      chapterKey: currentSource.key,
      storyBlockId: "block-a",
      selection: { start: 4, end: 20, text: "reviewer checked" },
      baseRevision: 2,
    },
    directlyAcquiredExperience: "The checked boundary directly changed the decision.",
    principle: "Check the boundary when the decision depends on it.",
    evidence: [evidenceA],
    ...overrides,
  };
}

function applyBase(currentSource) {
  return applyChapterReview(emptyChapterReview(currentSource), context(currentSource)).state;
}

function resolveAll(currentSource, decision = "accepted") {
  let state = applyBase(currentSource);
  for (const item of currentSource.insights) {
    state = updateAiInsightDecision(state, currentSource, item.id, decision);
  }
  return applyChapterReview(state, context(currentSource)).state;
}

test("Review Session parsing accepts only the canonical schema", () => {
  const session = createStoryReviewSession("reviewed-run", {}, {}, "2026-08-25T00:00:00.000Z");
  assert.equal(parseStoryReviewSession(session).schema, STORY_REVIEW_SESSION_SCHEMA);
  assert.equal(parseStoryReviewSession({ schema: "oxygen.story-review-session.foreign" }), null);
  assert.equal(parseStoryReviewSession({ ...session, chapterReviews: null }), null);
  const structurallyValid = parseStoryReviewSession({
    ...session,
    chapterReviews: { forged: emptyChapterReview(source([], "forged")) },
  });
  assert.ok(structurallyValid);
  assert.deepEqual(hydrateStoryReviewSession(structurallyValid, "reviewed-run", [source([], "expected")]), {
    chapterReviews: {}, privacyDecisions: {},
  });
});

test("zero source Insights create zero Insight obligations", () => {
  const currentSource = source([]);
  const state = applyBase(currentSource);
  const blockers = chapterReviewCompletionBlockers(state, context(currentSource));
  assert.equal(blockers.some((blocker) => blocker.targetKind === "insight"), false);
  assert.equal(validateChapterReviewCompletion(state, context(currentSource)), true);
  assert.deepEqual(state.sourceInsightReviews, {});
});

test("one AI Insight requires an explicit applied accept or reject decision", () => {
  const currentSource = source(["insight-one"]);
  const pending = applyBase(currentSource);
  assert.deepEqual(chapterReviewCompletionBlockers(pending, context(currentSource)), [{
    code: "ai_insight_decision_pending",
    chapterKey: currentSource.key,
    targetKind: "insight",
    targetId: "insight-one",
  }]);
  const missing = structuredClone(pending);
  delete missing.sourceInsightReviews["insight-one"];
  assert.equal(chapterReviewCompletionBlockers(missing, context(currentSource))[0].code, "ai_insight_decision_missing");
  const acceptedPending = updateAiInsightDecision(pending, currentSource, "insight-one", "accepted");
  assert.equal(chapterReviewCompletionBlockers(acceptedPending, context(currentSource))[0].code,
    "ai_insight_decision_pending");
  for (const decision of ["accepted", "rejected"]) {
    const resolved = resolveAll(currentSource, decision);
    assert.equal(resolved.sourceInsightReviews["insight-one"].decision, decision);
    assert.equal(resolved.sourceInsightReviews["insight-one"].resolution, "applied");
    assert.equal(validateChapterReviewCompletion(resolved, context(currentSource)), true);
  }
});

test("multiple AI Insights resolve independently and one pending or missing remains incomplete", () => {
  const currentSource = source(["insight-a", "insight-b", "insight-c"]);
  const resolved = resolveAll(currentSource);
  assert.equal(validateChapterReviewCompletion(resolved, context(currentSource)), true);

  let onePending = applyBase(currentSource);
  for (const id of ["insight-a", "insight-b"]) {
    onePending = updateAiInsightDecision(onePending, currentSource, id, "accepted");
  }
  onePending = applyChapterReview(onePending, context(currentSource)).state;
  assert.equal(validateChapterReviewCompletion(onePending, context(currentSource)), false);
  assert.equal(chapterReviewCompletionBlockers(onePending, context(currentSource))[0].targetId, "insight-c");

  const oneMissing = structuredClone(resolved);
  delete oneMissing.sourceInsightReviews["insight-b"];
  assert.equal(chapterReviewCompletionBlockers(oneMissing, context(currentSource))[0].code, "ai_insight_decision_missing");
  const foreign = structuredClone(resolved);
  foreign.sourceInsightReviews.foreign = foreign.sourceInsightReviews["insight-a"];
  assert.equal(chapterReviewCompletionBlockers(foreign, context(currentSource))[0].code, "review_state_invalid");
});

test("editing an accepted AI Insight invalidates old approval until the exact new version is accepted", () => {
  const currentSource = source(["insight-one"]);
  const accepted = resolveAll(currentSource);
  const editedContent = { ...insight("unused"), id: undefined };
  delete editedContent.id;
  const edited = editAiInsight(accepted, currentSource, "insight-one", editedContent);
  assert.equal(edited.sourceInsightReviews["insight-one"].version, 2);
  assert.equal(edited.sourceInsightReviews["insight-one"].decision, "pending");
  assert.equal(chapterReviewCompletionBlockers(edited, context(currentSource))[0].code, "ai_insight_reaccept_required");

  const stale = structuredClone(edited);
  stale.sourceInsightReviews["insight-one"] = {
    ...stale.sourceInsightReviews["insight-one"],
    decision: "accepted",
    resolution: "applied",
    appliedVersion: 1,
    appliedRevision: accepted.sourceInsightReviews["insight-one"].appliedRevision,
  };
  assert.equal(chapterReviewCompletionBlockers(stale, context(currentSource))[0].code, "ai_insight_reaccept_required");

  let reapplied = updateAiInsightDecision(edited, currentSource, "insight-one", "accepted");
  reapplied = applyChapterReview(reapplied, context(currentSource)).state;
  assert.equal(reapplied.sourceInsightReviews["insight-one"].appliedVersion, 2);
  assert.equal(validateChapterReviewCompletion(reapplied, context(currentSource)), true);
});

test("human Save creates a distinct human-approved stable Insight without redundant Accept", () => {
  const currentSource = source([]);
  const base = applyBase(currentSource);
  const saved = saveHumanInsight(base, context(currentSource), "human:boundary", humanContent(currentSource));
  assert.equal(saved.blockedReason, undefined);
  const review = saved.state.humanInsights["human:boundary"];
  assert.equal(review.origin, "human_created");
  assert.equal(review.decision, "human_approved");
  assert.equal(review.resolution, "applied");
  assert.equal(review.version, 1);
  assert.equal(review.appliedVersion, 1);
  assert.deepEqual(review.content.quote, humanContent(currentSource).quote);
  assert.equal(humanQuoteText(saved.state, currentSource, review.content), "reviewer checked");
  assert.equal(validateChapterReviewCompletion(saved.state, context(currentSource)), true);
  assert.equal(saved.state.sourceInsightReviews["human:boundary"], undefined);

  const session = createStoryReviewSession("reviewed-run", {
    [currentSource.key]: saved.state,
  }, {}, "2026-08-25T00:00:00.000Z");
  const roundtrip = canonicalizeStoryReviewSession(structuredClone(session));
  assert.equal(roundtrip.chapterReviews[currentSource.key].humanInsights["human:boundary"].version, 1);
  assert.deepEqual(
    roundtrip.chapterReviews[currentSource.key].humanInsights["human:boundary"].content.quote,
    humanContent(currentSource).quote,
  );
  const hydrated = hydrateStoryReviewSession(session, "reviewed-run", [currentSource]);
  assert.equal(humanQuoteText(
    hydrated.chapterReviews[currentSource.key],
    currentSource,
    hydrated.chapterReviews[currentSource.key].humanInsights["human:boundary"].content,
  ), "reviewer checked");
});

test("human Save applies only the targeted human Insight", () => {
  const currentSource = source(["insight-a", "insight-b"]);
  let state = applyBase(currentSource);
  state = updateAiInsightDecision(state, currentSource, "insight-b", "accepted");
  state = editHumanInsight(
    state,
    currentSource,
    "human:draft",
    humanContent(currentSource, { principle: "Keep this separate draft pending." }),
  );
  const unrelatedBefore = structuredClone({
    pendingAi: state.sourceInsightReviews["insight-a"],
    acceptedAi: state.sourceInsightReviews["insight-b"],
    draftHuman: state.humanInsights["human:draft"],
  });

  const saved = saveHumanInsight(
    state,
    context(currentSource),
    "human:target",
    humanContent(currentSource),
  );

  assert.equal(saved.blockedReason, undefined);
  assert.deepEqual({
    pendingAi: saved.state.sourceInsightReviews["insight-a"],
    acceptedAi: saved.state.sourceInsightReviews["insight-b"],
    draftHuman: saved.state.humanInsights["human:draft"],
  }, unrelatedBefore);
  assert.deepEqual(saved.state.insightRevisionHistory.slice(-1), [{
    revision: saved.state.revision,
    insightId: "human:target",
    origin: "human_created",
    version: 1,
    decision: "human_approved",
  }]);
  assert.equal(saved.state.humanInsights["human:target"].resolution, "applied");
});

test("later human drafts block, while a later explicit Save approves that authored version", () => {
  const currentSource = source([]);
  const first = saveHumanInsight(
    applyBase(currentSource), context(currentSource), "human:boundary", humanContent(currentSource),
  ).state;
  const nextContent = humanContent(currentSource, { principle: "Use the checked boundary for the next decision." });
  const draft = editHumanInsight(first, currentSource, "human:boundary", nextContent);
  assert.equal(draft.humanInsights["human:boundary"].version, 2);
  assert.equal(chapterReviewCompletionBlockers(draft, context(currentSource))[0].code, "human_insight_pending");
  const saved = saveHumanInsight(draft, context(currentSource), "human:boundary", nextContent).state;
  assert.equal(saved.humanInsights["human:boundary"].version, 2);
  assert.equal(saved.humanInsights["human:boundary"].appliedVersion, 2);
  assert.equal(validateChapterReviewCompletion(saved, context(currentSource)), true);
});

test("human Insight anchors, Evidence, four-part content, and IDs fail closed", () => {
  const currentSource = source(["human:collision"]);
  const base = applyBase(currentSource);
  const invalid = [
    humanContent(currentSource, { quote: { ...humanContent(currentSource).quote, chapterKey: "foreign-chapter" } }),
    humanContent(currentSource, { quote: { ...humanContent(currentSource).quote, storyBlockId: "missing-block" } }),
    humanContent(currentSource, { quote: { ...humanContent(currentSource).quote, selection: { start: 4, end: 20, text: "different bytes" } } }),
    humanContent(currentSource, { quote: { ...humanContent(currentSource).quote, domain: "raw_private_input" } }),
    humanContent(currentSource, { evidence: [{ documentId: "foreign", eventId: "missing" }] }),
    humanContent(currentSource, { principle: "" }),
  ];
  for (const content of invalid) {
    assert.equal(editHumanInsight(base, currentSource, "human:new", content), base);
  }
  assert.equal(editHumanInsight(base, currentSource, "human:collision", humanContent(currentSource)), base);
});

test("human Quote offsets and exact text identity fail closed", () => {
  const currentSource = source([]);
  const base = applyBase(currentSource);
  const valid = humanContent(currentSource);
  const invalidSelections = [
    { start: 4, end: 4, text: "" },
    { start: -1, end: 4, text: "The r" },
    { start: 4.5, end: 20, text: "reviewer checked" },
    { start: 4, end: 200, text: "reviewer checked" },
    { start: 4, end: 20, text: "reviewer changed" },
  ];
  for (const selection of invalidSelections) {
    const content = humanContent(currentSource, { quote: { ...valid.quote, selection } });
    assert.equal(editHumanInsight(base, currentSource, "human:invalid-range", content), base);
  }
  const futureRevision = humanContent(currentSource, { quote: { ...valid.quote, baseRevision: 99 } });
  assert.equal(editHumanInsight(base, currentSource, "human:future-range", futureRevision), base);
});

test("Story changes reopen an invalidated human Quote without moving or widening its range", () => {
  const currentSource = source([]);
  const saved = saveHumanInsight(
    applyBase(currentSource), context(currentSource), "human:range", humanContent(currentSource),
  ).state;
  const changed = addStoryAnnotation(saved, createStoryAnnotation({
    blockId: "block-a",
    type: "revise",
    sourceLanguage: "en",
    baseRevision: saved.revision,
    selection: { start: 4, end: 20, text: "reviewer checked" },
    instruction: "contributor verified",
  }));
  const applied = applyChapterReview(changed, context(currentSource));
  assert.equal(applied.blockedReason, undefined);
  const reopened = applied.state.humanInsights["human:range"];
  assert.equal(reopened.version, 2);
  assert.equal(reopened.decision, "draft");
  assert.equal(reopened.resolution, "pending");
  assert.equal(reopened.appliedVersion, undefined);
  assert.equal(humanQuoteText(applied.state, currentSource, reopened.content), null);
  assert.equal(chapterReviewCompletionBlockers(applied.state, context(currentSource))
    .some((blocker) => blocker.code === "human_insight_pending"), true);
});

test("story direct Story edit uses common Undo, Redo, Apply, revision, and completion semantics", () => {
  const currentSource = source([]);
  const initial = applyBase(currentSource);
  const block = currentSource.story.blocks[0];
  const before = block.text;
  const after = before.replace("reviewer", "contributor");
  const recorded = recordStoryEdit(initial, {
    storyKey: currentSource.key,
    blockId: block.id,
    sourceLanguage: "en",
    baseText: before,
    nextText: after,
    workingRange: { start: 4, end: 12 },
    insertedText: "contributor",
    now: 100,
  });
  assert.equal(recorded.blockedReason, undefined);
  assert.equal(recorded.state.stage, "reviewing");
  assert.equal(canUndoStoryEdit(recorded.state, "en"), true);
  assert.equal(storyWorkingBlock(before, currentSource.key, block.id, "en", recorded.state), after);
  assert.equal(chapterReviewCompletionBlockers(recorded.state, context(currentSource))[0].code, "direct_edit_pending");

  const undone = undoStoryEdit(recorded.state, "en");
  assert.equal(storyWorkingBlock(before, currentSource.key, block.id, "en", undone), before);
  assert.equal(canRedoStoryEdit(undone, "en"), true);
  const redone = redoStoryEdit(undone, "en");
  assert.equal(storyWorkingBlock(before, currentSource.key, block.id, "en", redone), after);

  const applied = applyChapterReview(redone, context(currentSource));
  assert.equal(applied.blockedReason, undefined);
  assert.equal(applied.state.revision, initial.revision + 1);
  assert.equal(applied.state.stage, "revision_ready");
  assert.equal(applied.state.editTransactions[0].resolution, "applied");
  assert.equal(chapterReviewCompletionBlockers(applied.state, context(currentSource)).length, 0);
});

test("story direct Story edit invalidating an exact human Quote reopens only that durable Insight", () => {
  const currentSource = source([]);
  const saved = saveHumanInsight(
    applyBase(currentSource), context(currentSource), "human:range", humanContent(currentSource),
  ).state;
  const block = currentSource.story.blocks[0];
  const before = block.text;
  const insertedText = "contributor verified";
  const recorded = recordStoryEdit(saved, {
    storyKey: currentSource.key,
    blockId: block.id,
    sourceLanguage: "en",
    baseText: before,
    nextText: `${before.slice(0, 4)}${insertedText}${before.slice(20)}`,
    workingRange: { start: 4, end: 20 },
    insertedText,
    now: 200,
  });
  assert.equal(recorded.blockedReason, undefined);
  const applied = applyChapterReview(recorded.state, context(currentSource));
  assert.equal(applied.blockedReason, undefined);
  const reopened = applied.state.humanInsights["human:range"];
  assert.equal(reopened.decision, "draft");
  assert.equal(reopened.resolution, "pending");
  assert.equal(humanQuoteText(applied.state, currentSource, reopened.content), null);
  assert.equal(chapterReviewCompletionBlockers(applied.state, context(currentSource))
    .some((blocker) => blocker.code === "human_insight_pending" && blocker.targetId === "human:range"), true);
});

test("an unrelated Story change after the selected bytes preserves the exact human Quote", () => {
  const currentSource = source([]);
  const saved = saveHumanInsight(
    applyBase(currentSource), context(currentSource), "human:range", humanContent(currentSource),
  ).state;
  const changed = addStoryAnnotation(saved, createStoryAnnotation({
    blockId: "block-a",
    type: "revise",
    sourceLanguage: "en",
    baseRevision: saved.revision,
    selection: { start: 25, end: 33, text: "boundary" },
    instruction: "limit",
  }));
  const applied = applyChapterReview(changed, context(currentSource));
  assert.equal(applied.blockedReason, undefined);
  const preserved = applied.state.humanInsights["human:range"];
  assert.equal(preserved.decision, "human_approved");
  assert.equal(preserved.resolution, "applied");
  assert.equal(humanQuoteText(applied.state, currentSource, preserved.content), "reviewer checked");
});

test("AI Insight source Quote, anchor, and grounding remain immutable while explanatory fields can change", () => {
  const currentSource = source(["insight-one"]);
  currentSource.insights[0].evidence = [{ ...evidenceA, label: "Reviewed source contribution" }];
  const otherChapterEvidence = { documentId: "other-chapter-document", eventId: "other-chapter-event" };
  const base = applyBase(currentSource);
  const aiContent = (overrides = {}) => {
    const content = { ...structuredClone(currentSource.insights[0]), ...overrides };
    delete content.id;
    return content;
  };

  const editedExplanation = editAiInsight(
    base, currentSource, "insight-one", aiContent({ background: "A reviewed explanation." }),
  );
  assert.notEqual(editedExplanation, base);
  assert.deepEqual(
    editedExplanation.sourceInsightReviews["insight-one"].editedContent.evidence,
    currentSource.insights[0].evidence,
  );
  const parsedEditedSession = parseStoryReviewSession(createStoryReviewSession(
    "insight-evidence-label-run",
    { [currentSource.key]: editedExplanation },
    {},
  ));
  assert.deepEqual(
    parsedEditedSession.chapterReviews[currentSource.key]
      .sourceInsightReviews["insight-one"].editedContent.evidence,
    currentSource.insights[0].evidence,
  );
  assert.equal(editAiInsight(
    base, currentSource, "insight-one", aiContent({ anchorStoryBlockId: "block-b" }),
  ), base);
  assert.equal(editAiInsight(
    base,
    currentSource,
    "insight-one",
    aiContent({ quote: { ...currentSource.insights[0].quote, text: "A Story paraphrase." } }),
  ), base);
  assert.equal(editAiInsight(
    base,
    currentSource,
    "insight-one",
    aiContent({ quote: { ...currentSource.insights[0].quote, evidence: otherChapterEvidence } }),
  ), base);
  assert.equal(editAiInsight(
    base, currentSource, "insight-one", aiContent({ evidence: [evidenceA] }),
  ), base);
  assert.equal(editAiInsight(
    base, currentSource, "insight-one", aiContent({ evidence: [evidenceA, evidenceB] }),
  ), base);

  assert.notEqual(editHumanInsight(
    base, currentSource, "human:one-anchor", humanContent(currentSource),
  ), base);
  assert.equal(editHumanInsight(
    base,
    currentSource,
    "human:unanchored",
    humanContent(currentSource, { evidence: [evidenceA, evidenceB] }),
  ), base);
  assert.notEqual(editHumanInsight(
    base,
    currentSource,
    "human:block-b",
    humanContent(currentSource, {
      quote: {
        chapterKey: currentSource.key,
        storyBlockId: "block-b",
        selection: { start: 4, end: 15, text: "next action" },
        baseRevision: 2,
      },
      evidence: [evidenceB],
    }),
  ), base);
});

test("story blockers are bounded, content-free, and share the validation evaluator", () => {
  const currentSource = source(["insight-private"]);
  const pending = applyBase(currentSource);
  const blockers = chapterReviewCompletionBlockers(pending, context(currentSource));
  assert.equal(validateChapterReviewCompletion(pending, context(currentSource)), blockers.length === 0);
  const serialized = JSON.stringify(blockers);
  for (const privateCopy of [
    currentSource.insights[0].background,
    currentSource.insights[0].principle,
    currentSource.story.blocks[0].text,
    evidenceA.documentId,
  ]) assert.equal(serialized.includes(privateCopy), false);
  assert.deepEqual(Object.keys(blockers[0]).sort(), ["chapterKey", "code", "targetId", "targetKind"]);
});

test("Privacy, Evidence, annotation, and direct-edit completion protections remain effective", () => {
  const currentSource = source([]);
  const complete = applyBase(currentSource);
  assert.equal(chapterReviewCompletionBlockers({ ...complete, evidenceVerified: false }, context(currentSource))[0].code,
    "evidence_unverified");
  const privacyContext = context(currentSource, {
    privacyCandidates: [{ id: "candidate", releaseTargets: ["block-a"] }],
    privacyDecisions: {},
    targetCatalog: new Map([["block-a", {}]]),
  });
  assert.equal(chapterReviewCompletionBlockers(complete, privacyContext)[0].code, "privacy_incomplete");

  const annotation = createStoryAnnotation({
    blockId: "block-a", type: "revise", sourceLanguage: "en", baseRevision: complete.revision,
    selection: { start: 4, end: 12, text: "reviewer" }, instruction: "contributor",
  });
  assert.equal(chapterReviewCompletionBlockers(
    addStoryAnnotation(complete, annotation), context(currentSource),
  )[0].code, "annotation_pending");
  const edited = recordStoryEdit(complete, {
    storyKey: currentSource.key,
    blockId: "block-a",
    sourceLanguage: "en",
    baseText: currentSource.story.blocks[0].text,
    nextText: "The reviewer checked the exact boundary.",
    now: 100,
  }).state;
  assert.equal(chapterReviewCompletionBlockers(edited, context(currentSource))[0].code, "direct_edit_pending");
});

test("story hydration requires exact Chapters, source Insight IDs, anchors, and provenance", () => {
  const alpha = source(["insight-a"], "chapter-alpha");
  const beta = source([], "chapter-beta");
  const reviews = {
    [alpha.key]: resolveAll(alpha),
    [beta.key]: saveHumanInsight(
      applyBase(beta), context(beta), "human:hydrated", humanContent(beta),
    ).state,
  };
  const session = createStoryReviewSession("reviewed-run", reviews, {}, "2026-08-25T00:00:00.000Z");
  assert.deepEqual(Object.keys(hydrateStoryReviewSession(session, "reviewed-run", [alpha, beta]).chapterReviews),
    ["chapter-alpha", "chapter-beta"]);
  assert.deepEqual(hydrateStoryReviewSession(session, "different-run", [alpha, beta]).chapterReviews, {});
  assert.deepEqual(hydrateStoryReviewSession(session, "reviewed-run", [alpha]).chapterReviews, {});
  assert.deepEqual(hydrateStoryReviewSession(session, "reviewed-run", [alpha, beta, source([], "chapter-extra")]).chapterReviews, {});

  const missingInsight = structuredClone(session);
  delete missingInsight.chapterReviews[alpha.key].sourceInsightReviews["insight-a"];
  assert.deepEqual(hydrateStoryReviewSession(missingInsight, "reviewed-run", [alpha, beta]).chapterReviews, {});
  const foreignInsight = structuredClone(session);
  foreignInsight.chapterReviews[alpha.key].sourceInsightReviews.foreign =
    foreignInsight.chapterReviews[alpha.key].sourceInsightReviews["insight-a"];
  assert.deepEqual(hydrateStoryReviewSession(foreignInsight, "reviewed-run", [alpha, beta]).chapterReviews, {});
  const staleProvenance = structuredClone(session);
  staleProvenance.chapterReviews[alpha.key].sourceInsightReviews["insight-a"].appliedVersion = 99;
  assert.deepEqual(hydrateStoryReviewSession(staleProvenance, "reviewed-run", [alpha, beta]).chapterReviews, {});
  const staleEditedVersion = structuredClone(session);
  staleEditedVersion.chapterReviews[alpha.key].sourceInsightReviews["insight-a"].version = 2;
  staleEditedVersion.chapterReviews[alpha.key].sourceInsightReviews["insight-a"].editedContent = {
    ...insight("unused"), id: undefined,
  };
  delete staleEditedVersion.chapterReviews[alpha.key].sourceInsightReviews["insight-a"].editedContent.id;
  assert.deepEqual(hydrateStoryReviewSession(staleEditedVersion, "reviewed-run", [alpha, beta]).chapterReviews, {});
  const foreignAnchor = structuredClone(session);
  foreignAnchor.chapterReviews[beta.key].humanInsights["human:hydrated"].content.quote.chapterKey = "foreign-chapter";
  assert.deepEqual(hydrateStoryReviewSession(foreignAnchor, "reviewed-run", [alpha, beta]).chapterReviews, {});
  const staleRange = structuredClone(session);
  staleRange.chapterReviews[beta.key].humanInsights["human:hydrated"].content.quote.selection.text = "changed selection";
  assert.deepEqual(hydrateStoryReviewSession(staleRange, "reviewed-run", [alpha, beta]).chapterReviews, {});
  const malformedRange = structuredClone(session);
  malformedRange.chapterReviews[beta.key].humanInsights["human:hydrated"].content.quote.selection.end = 500;
  assert.deepEqual(hydrateStoryReviewSession(malformedRange, "reviewed-run", [alpha, beta]).chapterReviews, {});
  const foreignEvidence = structuredClone(session);
  foreignEvidence.chapterReviews[beta.key].humanInsights["human:hydrated"].content.evidence = [{
    documentId: "foreign", eventId: "missing",
  }];
  assert.deepEqual(hydrateStoryReviewSession(foreignEvidence, "reviewed-run", [alpha, beta]).chapterReviews, {});
  const privateDomain = structuredClone(session);
  privateDomain.chapterReviews[beta.key].humanInsights["human:hydrated"].content.quote.domain = "raw_private_input";
  assert.equal(canonicalizeStoryReviewSession(privateDomain), null);
});

test("story session canonicalization has deterministic Chapter, Insight, and revision ordering", () => {
  const alpha = source(["insight-b", "insight-a"], "chapter-alpha");
  const beta = source([], "chapter-beta");
  const alphaReview = resolveAll(alpha);
  const raw = {
    schema: STORY_REVIEW_SESSION_SCHEMA,
    workflowRunId: "reviewed-run",
    chapterReviews: { [beta.key]: applyBase(beta), [alpha.key]: alphaReview },
    privacyDecisions: {},
    updatedAt: "2026-08-25T00:00:00.000Z",
  };
  raw.chapterReviews[alpha.key].sourceInsightReviews = {
    "insight-b": raw.chapterReviews[alpha.key].sourceInsightReviews["insight-b"],
    "insight-a": raw.chapterReviews[alpha.key].sourceInsightReviews["insight-a"],
  };
  raw.chapterReviews[alpha.key].insightRevisionHistory.reverse();
  const canonical = canonicalizeStoryReviewSession(raw);
  assert.deepEqual(Object.keys(canonical.chapterReviews), ["chapter-alpha", "chapter-beta"]);
  assert.deepEqual(Object.keys(canonical.chapterReviews[alpha.key].sourceInsightReviews), ["insight-a", "insight-b"]);
  assert.deepEqual(canonical.chapterReviews[alpha.key].insightRevisionHistory.map((item) => item.insightId),
    ["insight-a", "insight-b"]);
});

test("Story Review Session is wired through exact workflow, Viewer, transport, and release owners", async () => {
  const wiredPaths = [
    "../app/story-chapter-editor.tsx",
    "../app/workspace.tsx",
    "../lib/story-review-session-persistence.ts",
    "../lib/story-review-session-server.ts",
    "../app/api/story-review-session/route.ts",
    "../lib/story-release.ts",
    "../lib/story-release-server.ts",
    "../app/api/workflow/route.ts",
  ];
  const wiredSources = await Promise.all(wiredPaths.map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  assert.match(wiredSources[0], /StoryChapterEditor/);
  assert.match(wiredSources[1], /hydrateStoryReviewSession/);
  assert.match(wiredSources[2], /StoryReviewSession/);
  assert.match(wiredSources[3], /parseStoryReviewSession/);
  assert.match(wiredSources[4], /parseStoryReviewSession/);
  assert.match(wiredSources[5], /REVIEWED_STORY_SCHEMA/);
  assert.match(wiredSources[6], /hydrateStoryReviewSession/);
  assert.match(wiredSources[7], /validateStoryActivationAuthority/);
});
