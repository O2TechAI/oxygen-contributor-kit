import test from "node:test";
import assert from "node:assert/strict";
import { testStoryCoverage } from "./fixtures/story-coverage.mjs";
import { STORY_PREFIX, parseStorySource } from "../lib/timeline.ts";
import { validateStorySourcePackage } from "../lib/story-readiness.ts";

const evidenceA = { documentId: "meeting-doc", eventId: "meeting-event-a" };
const evidenceB = { documentId: "meeting-doc", eventId: "meeting-event-b" };
const reviewedA = "One participant proposed the narrow repair before the review.";
const reviewedB = "Another reviewer challenged the assumption and requested direct evidence.";

function source(insights = [insight()]) {
  return {
    schema: "oxygen.story",
    key: "chapter-quote-grounding",
    phase: { id: "phase-quote-grounding", label: "Quote Grounding" },
    title: "The evidence changed the repair",
    overview: "A reviewer challenged an unsupported assumption before the repair was accepted.",
    people: [{
      id: "person-participant",
      releaseLabel: "One participant",
      role: "Contributor",
      description: "Proposed the initial repair and responded to the evidence request.",
      localIdentityState: "not_identified",
      evidence: [evidenceA, evidenceB],
    }],
    story: {
      blocks: [
        {
          id: "block-proposal",
          text: "One participant proposed a narrow repair.",
          evidence: [evidenceA],
        },
        {
          id: "block-objection",
          text: "A reviewer asked for direct evidence before accepting it.",
          evidence: [evidenceB],
        },
      ],
    },
    insights,
    evidence: { primary: evidenceA, supporting: [evidenceB] },
    coverage: testStoryCoverage({ representedUnitIds: ["unit-quote-grounding"] }),
  };
}

function insight(overrides = {}) {
  return {
    id: "insight-source-quote",
    title: "Evidence before acceptance",
    background: "The initial proposal depended on an assumption that had not been demonstrated.",
    anchorStoryBlockId: "block-objection",
    quote: { text: "challenged the assumption", evidence: evidenceB },
    directlyAcquiredExperience: "The objection redirected the repair toward direct evidence.",
    principle: "When a repair depends on an assumption, verify that assumption before acceptance.",
    evidence: [],
    ...overrides,
  };
}

function evidenceRows(overrides = {}) {
  return [
    {
      id: evidenceA.eventId,
      documentId: evidenceA.documentId,
      eventType: "message",
      actorId: "participant-one",
      actorType: "participant",
      reviewedNarrative: reviewedA,
    },
    {
      id: evidenceB.eventId,
      documentId: evidenceB.documentId,
      eventType: "message",
      actorId: "participant-one",
      actorType: "participant",
      reviewedNarrative: reviewedB,
    },
  ].map((row) => ({ ...row, ...(overrides[row.id] || {}) }));
}

function candidate(story = source()) {
  return [{
    id: evidenceA.eventId,
    documentId: evidenceA.documentId,
    sequence: 1,
    summary: STORY_PREFIX + JSON.stringify(story),
  }];
}

const groundingFailure = { ok: false, code: "STORY_INSIGHT_GROUNDING_INVALID" };

test("an exact nonempty substring of the bound reviewed source grounds an anchored AI Insight", () => {
  const story = source();
  assert.ok(parseStorySource(candidate(story)[0].summary));
  assert.equal(story.story.blocks.some((block) => block.text === story.insights[0].quote.text), false);
  assert.equal(validateStorySourcePackage(candidate(story), evidenceRows()).ok, true);
});

test("Story paraphrases, modified source text, text outside the exact bound reviewed narrative, and absent current narrative fail before authority", () => {
  for (const quoteText of [
    "A reviewer asked for direct evidence before accepting it.",
    "challenged an assumption",
    "OUTSIDE EXACT BOUND REVIEWED NARRATIVE",
  ]) {
    const story = source([insight({ quote: { text: quoteText, evidence: evidenceB } })]);
    assert.deepEqual(validateStorySourcePackage(candidate(story), evidenceRows()), groundingFailure);
  }
  assert.deepEqual(validateStorySourcePackage(candidate(), evidenceRows({
    [evidenceB.eventId]: { reviewedNarrative: undefined },
  })), groundingFailure);
});

test("foreign or stale Quote Evidence, invalid anchors, and quote-anchor mismatch fail closed", () => {
  const foreignEvidence = { documentId: "foreign-doc", eventId: "foreign-event" };
  const cases = [
    insight({ quote: { text: "challenged the assumption", evidence: foreignEvidence } }),
    insight({ quote: { text: "challenged the assumption", evidence: { ...evidenceB, documentId: "stale-doc" } } }),
    insight({ anchorStoryBlockId: "missing-block" }),
    insight({ anchorStoryBlockId: "block-proposal" }),
  ];
  for (const candidateInsight of cases) {
    assert.deepEqual(validateStorySourcePackage(
      candidate(source([candidateInsight])),
      evidenceRows(),
    ), groundingFailure);
  }
});

test("top-level broader grounding stays same-Chapter and completed-zero requires no Quote narrative", () => {
  assert.equal(validateStorySourcePackage(
    candidate(source([insight({ evidence: [evidenceA] })])),
    evidenceRows(),
  ).ok, true);

  assert.deepEqual(validateStorySourcePackage(
    candidate(source([insight({ evidence: [{ documentId: "foreign-doc", eventId: "foreign-event" }] })])),
    evidenceRows(),
  ), groundingFailure);

  const rowsWithoutNarrative = evidenceRows({
    [evidenceA.eventId]: { reviewedNarrative: undefined },
    [evidenceB.eventId]: { reviewedNarrative: undefined },
  });
  assert.equal(validateStorySourcePackage(candidate(source([])), rowsWithoutNarrative).ok, true);
});
