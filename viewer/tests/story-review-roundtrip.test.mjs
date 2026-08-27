import test from "node:test";
import assert from "node:assert/strict";
import { testStoryCoverage } from "./fixtures/story-coverage.mjs";
import {
  applyChapterReview,
  applyStoryReviewToBlock,
  emptyChapterReview,
  markChapterReady,
  recordStoryEdit,
  saveHumanInsight,
  storyBlocks,
  updateAiInsightDecision,
} from "../lib/story-review.ts";
import {
  createStoryReviewSession,
  hydrateStoryReviewSession,
  parseStoryReviewSession,
  STORY_REVIEW_SESSION_SCHEMA,
} from "../lib/story-review-session.ts";
import {
  buildReviewedStoryRelease,
  REVIEWED_STORY_SCHEMA,
} from "../lib/story-release.ts";
import {
  parseStorySource,
  STORY_PREFIX,
  timelinePresentation,
} from "../lib/timeline.ts";

const workflowRunId = "story-review-roundtrip";
const primaryEvidence = { documentId: "roundtrip-document", eventId: "roundtrip-document:event-primary" };
const detailEvidence = { documentId: "roundtrip-document", eventId: "roundtrip-document:event-detail" };

function sourceFixture({ insights = true } = {}) {
  return {
    schema: "oxygen.story",
    key: "final-roundtrip-chapter",
    phase: { id: "proof", label: "Final Proof" },
    kind: "validation",
    title: "The final Story path retained every supported field",
    overview: "A synthetic Chapter exercises the canonical reducer, session, hydration, and release path.",
    transition: { before: "Targets were unproved", after: "One final path is executable" },
    chips: ["final schema", "roundtrip"],
    people: [{
      id: "reviewer",
      releaseLabel: "Reviewer",
      role: "Human reviewer",
      description: "Confirmed the final unversioned Story.",
      localIdentityState: "not_identified",
      evidence: [primaryEvidence],
    }],
    story: {
      blocks: [
        { id: "scene", text: "The scene established a safe baseline.", evidence: [primaryEvidence] },
        { id: "reconstruction-0", text: "The first reconstruction preserved the observed turn.", evidence: [primaryEvidence] },
        { id: "reconstruction-1", text: "The second reconstruction linked the turn to the decision.", evidence: [detailEvidence] },
        { id: "detail-0", text: "The Detail recorded the exact bounded result.", evidence: [detailEvidence] },
        { id: "outcome", text: "The outcome made the final release path explicit.", evidence: [primaryEvidence] },
      ],
      uncertainty: "The proof does not grant publication approval.",
    },
    insights: insights ? [{
      id: "ai:detail-proof",
      title: "Bounded AI observation",
      background: "The Detail changed the release decision.",
      quote: { storyBlockIds: ["detail-0"] },
      directlyAcquiredExperience: "The reviewer checked the exact Detail before continuing.",
      principle: "Keep every Insight owned by the Story paragraph that supports it.",
      evidence: [detailEvidence],
    }] : [],
    evidence: { primary: primaryEvidence, supporting: [detailEvidence] },
    coverage: testStoryCoverage({ representedUnitIds: ["roundtrip-primary", "roundtrip-detail"] }),
  };
}

function context(source, state = null) {
  const sourceCollection = storyBlocks(source);
  return {
    source,
    privacyCandidates: [],
    privacyDecisions: {},
    targetCatalog: new Map(),
    evidenceResolved: true,
    supportedAddIds: [],
    supportedEditIds: [],
    sourceBlocks: sourceCollection,
    reviewedBlocks: state ? {
      en: Object.fromEntries(source.story.blocks.map((block) => [
        block.id,
        applyStoryReviewToBlock(block.text, block.id, "en", state),
      ])),
      zh: {},
    } : sourceCollection,
  };
}

function editBlock(state, source, blockId, nextText, now) {
  const block = source.story.blocks.find((item) => item.id === blockId);
  assert.ok(block, `fixture owns ${blockId}`);
  let start = 0;
  while (start < block.text.length && block.text[start] === nextText[start]) start += 1;
  let oldEnd = block.text.length;
  let newEnd = nextText.length;
  while (oldEnd > start && newEnd > start && block.text[oldEnd - 1] === nextText[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const result = recordStoryEdit(state, {
    storyKey: source.key,
    blockId,
    sourceLanguage: "en",
    baseText: block.text,
    nextText,
    workingRange: { start, end: oldEnd },
    insertedText: nextText.slice(start, newEnd),
    now,
  });
  assert.equal(result.blockedReason, undefined);
  return result.state;
}

function buildConfirmedReview(source) {
  let state = emptyChapterReview(source);
  state = editBlock(state, source, "reconstruction-1", "The reviewed reconstruction linked the turn to the final decision.", 100);
  state = editBlock(state, source, "detail-0", "The reviewed Detail recorded the exact bounded result.", 200);
  state = updateAiInsightDecision(state, source, "ai:detail-proof", "accepted");
  const applied = applyChapterReview(state, context(source, state));
  assert.equal(applied.blockedReason, undefined);
  assert.equal(applied.state.stage, "revision_ready");

  const scene = source.story.blocks[0].text;
  const selected = "safe baseline";
  const start = scene.indexOf(selected);
  const human = saveHumanInsight(applied.state, context(source, applied.state), "human:scene-proof", {
    title: "Human-owned observation",
    background: "The baseline established the boundary for the later result.",
    quote: {
      chapterKey: source.key,
      storyBlockId: "scene",
      selection: { start, end: start + selected.length, text: selected },
      baseRevision: applied.state.revision,
    },
    directlyAcquiredExperience: "The human reviewer used the baseline to check the later reconstruction.",
    principle: "Retain the baseline when it determines how a result is interpreted.",
    evidence: [primaryEvidence],
  });
  assert.equal(human.blockedReason, undefined);
  return markChapterReady(human.state, context(source, human.state));
}

// Story/Release Privacy target roundtrip is deferred until Wave B supplies its real candidate authority.
test("Story edit and review data survive Apply, canonical session JSON, hydration, and reviewed Story reconstruction", () => {
  const source = parseStorySource(`${STORY_PREFIX}${JSON.stringify(sourceFixture())}`);
  assert.ok(source);
  const presentation = timelinePresentation(source);
  assert.deepEqual({ before: presentation.before, after: presentation.after }, {
    before: "Targets were unproved",
    after: "One final path is executable",
  });

  const confirmed = buildConfirmedReview(source);
  assert.equal(confirmed.stage, "human_confirmed");
  const session = createStoryReviewSession(
    workflowRunId,
    { [source.key]: confirmed },
    {},
    "2038-08-27T00:00:00.000Z",
  );
  assert.equal(session.schema, STORY_REVIEW_SESSION_SCHEMA);
  const transported = JSON.parse(JSON.stringify(session));
  assert.deepEqual(parseStoryReviewSession(transported), session);

  const hydrated = hydrateStoryReviewSession(transported, workflowRunId, [source]);
  assert.deepEqual(Object.keys(hydrated.chapterReviews), [source.key]);
  const release = buildReviewedStoryRelease([source], hydrated.chapterReviews);
  assert.equal(release.schema, REVIEWED_STORY_SCHEMA);
  assert.equal(release.publication_approved, false);
  assert.equal(release.chapters.length, 1);

  const chapter = release.chapters[0];
  assert.deepEqual(chapter.phase, { id: "proof", label: "Final Proof" });
  assert.equal(chapter.en.title, source.title);
  assert.equal(chapter.en.overview, source.overview);
  assert.deepEqual(chapter.en.people, [{
    releaseLabel: "Reviewer",
    role: "Human reviewer",
    description: "Confirmed the final unversioned Story.",
  }]);
  assert.deepEqual(chapter.en.story.blocks, [
    "The scene established a safe baseline.",
    "The first reconstruction preserved the observed turn.",
    "The reviewed reconstruction linked the turn to the final decision.",
    "The reviewed Detail recorded the exact bounded result.",
    "The outcome made the final release path explicit.",
  ]);
  assert.equal(chapter.en.story.uncertainty, "The proof does not grant publication approval.");
  assert.deepEqual(chapter.en.insights.map(({ id, quote }) => ({ id, quote })), [{
    id: "ai:detail-proof",
    quote: "The reviewed Detail recorded the exact bounded result.",
  }, {
    id: "human:scene-proof",
    quote: "safe baseline",
  }]);
  assert.deepEqual(buildReviewedStoryRelease([source], { [source.key]: confirmed }), release);
});

test("the same canonical path preserves a sparse zero-Insight Chapter", () => {
  const source = parseStorySource(`${STORY_PREFIX}${JSON.stringify(sourceFixture({ insights: false }))}`);
  assert.ok(source);
  const applied = applyChapterReview(emptyChapterReview(source), context(source));
  assert.equal(applied.blockedReason, undefined);
  const confirmed = markChapterReady(applied.state, context(source, applied.state));
  const session = createStoryReviewSession(workflowRunId, { [source.key]: confirmed }, {}, "2038-08-27T00:00:00.000Z");
  const hydrated = hydrateStoryReviewSession(JSON.parse(JSON.stringify(session)), workflowRunId, [source]);
  assert.deepEqual(buildReviewedStoryRelease([source], hydrated.chapterReviews).chapters[0].en.insights, []);
});

test("invalid and foreign Story targets fail closed before or during hydration", () => {
  const source = parseStorySource(`${STORY_PREFIX}${JSON.stringify(sourceFixture())}`);
  assert.ok(source);
  const initial = emptyChapterReview(source);
  for (const target of [
    { storyKey: "foreign-chapter", blockId: "scene" },
    { storyKey: source.key, blockId: "foreign-block" },
  ]) {
    const attempted = recordStoryEdit(initial, {
      ...target,
      sourceLanguage: "en",
      baseText: source.story.blocks[0].text,
      nextText: "Foreign target content",
      workingRange: { start: 0, end: 1 },
      insertedText: "F",
      now: 300,
    });
    assert.equal(attempted.blockedReason, undefined);
    const applied = applyChapterReview(attempted.state, context(source, attempted.state));
    assert.ok(applied.blockedReason);
    assert.strictEqual(applied.state, attempted.state);
  }
  assert.strictEqual(updateAiInsightDecision(initial, source, "foreign-insight", "accepted"), initial);

  const confirmed = buildConfirmedReview(source);
  const session = createStoryReviewSession(workflowRunId, { [source.key]: confirmed }, {}, "2038-08-27T00:00:00.000Z");
  const foreignChapter = structuredClone(session);
  foreignChapter.chapterReviews = { "foreign-chapter": confirmed };
  assert.deepEqual(hydrateStoryReviewSession(foreignChapter, workflowRunId, [source]), {
    chapterReviews: {}, privacyDecisions: {},
  });
  assert.deepEqual(hydrateStoryReviewSession(session, workflowRunId, [{
    ...source,
    schema: "oxygen.story.foreign",
  }]), { chapterReviews: {}, privacyDecisions: {} });
});
