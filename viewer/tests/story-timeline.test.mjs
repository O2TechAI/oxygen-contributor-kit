import test from "node:test";
import assert from "node:assert/strict";
import { testStoryCoverage } from "./fixtures/story-coverage.mjs";
import {
  STORY_PREFIX,
  compareStorySourceIdentity,
  parseStorySource,
  resolveEvidenceTarget,
  storyKindLabel,
  timelinePresentation,
} from "../lib/timeline.ts";

const evidence = { documentId: "doc-a", eventId: "doc-a:event-1" };
const insight = {
  id: "insight-one",
  background: "A bounded source changed the decision.",
  quote: { storyBlockIds: ["scene"] },
  directlyAcquiredExperience: "The exact source was reviewed.",
  principle: "Preserve exact source ownership.",
  evidence: [evidence],
};

function story(overrides = {}) {
  return {
    schema: "oxygen.story",
    key: "chapter-one",
    phase: { id: "review", label: "Review" },
    title: "The bounded decision",
    overview: "A synthetic Story exercises the final parser and Timeline mapping.",
    people: [],
    story: { blocks: [{ id: "scene", text: "The team reviewed exact evidence.", evidence: [evidence] }] },
    insights: [],
    evidence: { primary: evidence, supporting: [] },
    coverage: testStoryCoverage(),
    ...overrides,
  };
}

const serialized = (source) => `${STORY_PREFIX}${JSON.stringify(source)}`;

test("strict final Story parser accepts only the canonical unversioned source", () => {
  const source = story();
  assert.deepEqual(parseStorySource(serialized(source)), source);
  assert.equal(parseStorySource(JSON.stringify(source)), null);
  assert.equal(parseStorySource(`${STORY_PREFIX}{not-json`), null);
  assert.equal(parseStorySource(serialized({ ...source, schema: "oxygen.unknown" })), null);
  assert.equal(parseStorySource(serialized({ ...source, unrecognized: true })), null);
});

test("strict parser permits sparse zero, one, or multiple independently owned Insights", () => {
  const zero = story();
  const one = story({ insights: [insight] });
  const two = story({ insights: [insight, { ...insight, id: "insight-two" }] });
  assert.equal(parseStorySource(serialized(zero)).insights.length, 0);
  assert.equal(parseStorySource(serialized(one)).insights.length, 1);
  assert.deepEqual(parseStorySource(serialized(two)).insights.map((item) => item.id), ["insight-one", "insight-two"]);

  const unknownBlock = story({ insights: [{ ...insight, quote: { storyBlockIds: ["absent"] } }] });
  assert.ok(parseStorySource(serialized(unknownBlock)), "syntax parsing is separate from package ownership validation");
});

test("Timeline presentation passes through transition, chips, kind, and Insight marker exactly", () => {
  const transition = { before: "Manual review", after: "Approved release" };
  const chips = ["reviewed", "local-only"];
  const source = story({ kind: "decision", transition, chips, insights: [insight] });
  const presentation = timelinePresentation(source);
  assert.deepEqual(presentation, {
    kind: "decision",
    before: transition.before,
    after: transition.after,
    chips,
    marker: "ai_insight",
  });
  assert.strictEqual(presentation.chips, chips);
  assert.deepEqual(timelinePresentation(story()), {});
});

test("Timeline kind labels and Insight markers are reachable in English and Chinese", () => {
  assert.equal(storyKindLabel("root_cause", "en"), "Root cause");
  assert.equal(storyKindLabel("root_cause", "zh"), "根因");
  assert.equal(timelinePresentation(story({ insights: [insight] })).marker, "ai_insight");
});

test("Story source identity has one permanent timestamp, document, sequence, and ID order", () => {
  const identities = [
    { id: "z", timestamp: "2026-01-02T00:00:00Z", documentId: "doc-a", sequence: 1 },
    { id: "b", timestamp: "2026-01-01T00:00:00Z", documentId: "doc-b", sequence: 1 },
    { id: "c", timestamp: "2026-01-01T00:00:00Z", documentId: "doc-a", sequence: 2 },
    { id: "a", timestamp: "2026-01-01T00:00:00Z", documentId: "doc-a", sequence: 2 },
    { id: "missing", timestamp: null, documentId: "doc-z", sequence: 9 },
  ];
  identities.sort(compareStorySourceIdentity);
  assert.deepEqual(identities.map((item) => item.id), ["missing", "a", "c", "b", "z"]);
});

test("exact Evidence resolution accepts exact or unique bare identity and rejects uncertainty", () => {
  const items = [{ id: "doc-a:event-1" }, { id: "doc-a:event-2" }];
  assert.deepEqual(resolveEvidenceTarget(items, "doc-a:event-1"), {
    status: "resolved", itemId: "doc-a:event-1", index: 0,
  });
  assert.deepEqual(resolveEvidenceTarget(items, "event-2"), {
    status: "resolved", itemId: "doc-a:event-2", index: 1,
  });
  assert.deepEqual(resolveEvidenceTarget(items, "missing"), { status: "missing" });
  assert.deepEqual(resolveEvidenceTarget([...items, { id: "doc-b:event-2" }], "event-2"), { status: "ambiguous" });
});
