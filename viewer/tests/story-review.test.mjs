import test from "node:test";
import assert from "node:assert/strict";
import { testStoryCoverage } from "./fixtures/story-coverage.mjs";
import {
  addStoryAnnotation,
  applyChapterReview,
  canRedoStoryEdit,
  canUndoStoryEdit,
  createStoryAnnotation,
  deriveDirectStoryMutation,
  discardStoryEdit,
  emptyChapterReview,
  normalizeDirectBeforeInput,
  recordStoryEdit,
  redoStoryEdit,
  revertAppliedStoryEdit,
  storyEditSegments,
  storyWorkingBlock,
  sanitizeStoryPaste,
  undoStoryEdit,
} from "../lib/story-review.ts";

const evidence = { documentId: "doc", eventId: "event" };
const reviewSource = {
    schema: "oxygen.story",
    language: "en",
    languagePolicyDigest: "f".repeat(64),
  key: "chapter",
  phase: { id: "phase-review", label: "Review" },
  title: "Synthetic edit Chapter",
  overview: "A synthetic Chapter exercises the canonical edit ledger.",
  people: [],
  story: { blocks: [{ id: "scene", text: "Safe source.", evidence: [evidence] }] },
  insights: [],
  evidence: { primary: evidence, supporting: [] },
  coverage: testStoryCoverage(),
};
const emptyReview = () => emptyChapterReview(reviewSource);
const reviewableInsightId = "shared-lesson";
const targetCatalog = new Map([
  ["scene", { target: "scene", kind: "scalar", field: "scene" }],
  [`insight:${reviewableInsightId}`, { target: `insight:${reviewableInsightId}`, kind: "insight", id: reviewableInsightId }],
]);
const context = (privacyCandidates = [], privacyDecisions = {}, chapterEvidence = [evidence], overrides = {}) => {
  const reviewedBlocks = overrides.reviewedBlocks || { en: {}, zh: {} };
  const sourceBlocks = overrides.sourceBlocks || reviewedBlocks;
  const source = overrides.source || {
    ...reviewSource,
    story: {
      blocks: Object.entries(sourceBlocks.en).map(([id, text]) => ({ id, text, evidence: [evidence] })),
    },
  };
  return {
    source,
    storyKey: overrides.storyKey || "chapter",
    privacyCandidates, privacyDecisions, chapterEvidence,
    targetCatalog: overrides.targetCatalog || targetCatalog,
    reviewableInsightIds: overrides.reviewableInsightIds || [reviewableInsightId],
    evidenceResolved: overrides.evidenceResolved ?? true,
    supportedAddIds: overrides.supportedAddIds || [],
    supportedEditIds: overrides.supportedEditIds || [],
    sourceBlocks,
    reviewedBlocks,
  };
};
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
  let state = recordStoryEdit(emptyReview(), {
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
  let state = emptyReview();
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
  let state = recordStoryEdit(emptyReview(), {
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
  let state = recordStoryEdit(emptyReview(), {
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
  let state = recordStoryEdit(emptyReview(), {
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


test("applied direct history cannot be undone and Revert creates a new pending revision transaction", () => {
  const source = "The draft changed.";
  const next = "The chapter changed.";
  let state = recordStoryEdit(emptyReview(), {
    storyKey: "chapter", blockId: "scene", sourceLanguage: "en",
    baseText: source, nextText: next, now: 100,
  }).state;
  const sourceBlocks = { en: { scene: source }, zh: { scene: "草稿发生了变化。" } };
  state = applyChapterReview(state, context([], {}, [evidence], { sourceBlocks, reviewedBlocks: sourceBlocks })).state;
  const appliedId = state.editTransactions[0].id;

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


test("direct editing fails closed when a pending semantic annotation owns the same block", () => {
  const source = "One paragraph.";
  const annotation = createStoryAnnotation({
    blockId: "scene", type: "delete", sourceLanguage: "en", baseRevision: 1,
    selection: { start: 0, end: 3, text: "One" },
  });
  const state = addStoryAnnotation(emptyReview(), annotation);
  const result = recordStoryEdit(state, {
    storyKey: "chapter", blockId: "scene", sourceLanguage: "en",
    baseText: source, nextText: "A paragraph.", now: 100,
  });
  assert.equal(result.blockedReason, "annotation");
  assert.equal(result.state, state);
});
