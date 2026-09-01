import test from "node:test";
import assert from "node:assert/strict";
import { testStoryCoverage } from "./fixtures/story-coverage.mjs";
import {
  STORY_PREFIX,
  classifyStoryLanguageText,
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
  anchorStoryBlockId: "scene",
  quote: { text: "reviewed exact evidence", evidence },
  directlyAcquiredExperience: "The exact source was reviewed.",
  principle: "Preserve exact source ownership.",
  evidence: [evidence],
};

function story(overrides = {}) {
  return {
    schema: "oxygen.story",
    language: "en",
    languagePolicyDigest: "f".repeat(64),
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

test("canonical Story language classification uses one exact 80-percent Han/Latin rule", () => {
  assert.equal(classifyStoryLanguageText("abcdefgh中中"), "en");
  assert.equal(classifyStoryLanguageText("中文中文中文中文ab"), "zh");
  assert.equal(classifyStoryLanguageText("abcde中文中文中"), "mixed");
  assert.equal(classifyStoryLanguageText("123 --"), "mixed");
});

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

  const unknownBlock = story({ insights: [{ ...insight, anchorStoryBlockId: "absent" }] });
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

test("strict absolute Story timestamps normalize offsets across documents", () => {
  const identities = [
    { id: "later", timestamp: "2025-12-31T20:30:00-04:00", documentId: "doc-c", sequence: 1 },
    { id: "first-b", timestamp: "2026-01-01T00:00:00Z", documentId: "doc-b", sequence: 1 },
    { id: "first-a", timestamp: "2026-01-01T01:00:00+01:00", documentId: "doc-a", sequence: 1 },
    { id: "middle", timestamp: "2026-01-01T00:15:00.250Z", documentId: "doc-z", sequence: 1 },
  ];
  assert.deepEqual(identities.sort(compareStorySourceIdentity).map((item) => item.id), [
    "first-a", "first-b", "middle", "later",
  ]);
});

test("absolute Story fractions remain exact while unknown or excess precision stays scoped", () => {
  const identities = [
    { id: "equivalent-b", timestamp: "2026-01-01T00:00:01.1Z", documentId: "doc-b", sequence: 1 },
    { id: "later-sub-ms", timestamp: "2026-01-01T00:00:00.0009Z", documentId: "doc-a", sequence: 1 },
    { id: "excess-precision", timestamp: "2026-01-01T00:00:00.1234567890Z", documentId: "doc-a", sequence: 2 },
    { id: "equivalent-a", timestamp: "2026-01-01T00:00:01.100+00:00", documentId: "doc-a", sequence: 1 },
    { id: "earlier-sub-ms", timestamp: "2026-01-01T00:00:00.0001Z", documentId: "doc-z", sequence: 1 },
    { id: "unknown-offset", timestamp: "2026-01-01T00:00:00-00:00", documentId: "doc-a", sequence: 1 },
  ];
  assert.deepEqual(identities.sort(compareStorySourceIdentity).map((item) => item.id), [
    "unknown-offset", "excess-precision", "earlier-sub-ms", "later-sub-ms",
    "equivalent-a", "equivalent-b",
  ]);
});

test("local, missing, and malformed Story timestamps remain document-scoped", () => {
  const identities = [
    { id: "doc-b-local", timestamp: "8:00 AM", documentId: "doc-b", sequence: 1 },
    { id: "time-only", timestamp: "09:00:00", documentId: "doc-a", sequence: 5 },
    { id: "date-only", timestamp: "2026-01-01", documentId: "doc-a", sequence: 4 },
    { id: "timezone-less", timestamp: "2026-01-01T09:00:00", documentId: "doc-a", sequence: 3 },
    { id: "invalid-calendar", timestamp: "2026-02-30T09:00:00Z", documentId: "doc-a", sequence: 2 },
    { id: "missing", timestamp: null, documentId: "doc-a", sequence: 1 },
    { id: "absolute", timestamp: "2020-01-01T00:00:00Z", documentId: "doc-0", sequence: 1 },
  ];
  assert.deepEqual(identities.sort(compareStorySourceIdentity).map((item) => item.id), [
    "missing", "invalid-calendar", "timezone-less", "date-only", "time-only",
    "doc-b-local", "absolute",
  ]);
});

test("meeting-local clocks use document and source sequence, not clock text", () => {
  const identities = [
    { id: "doc-b-early-clock", timestamp: "8:00 AM", documentId: "doc-b", sequence: 1 },
    { id: "doc-a-second", timestamp: "10:00 AM", documentId: "doc-a", sequence: 2 },
    { id: "doc-a-first", timestamp: "9:00 PM", documentId: "doc-a", sequence: 1 },
  ];
  assert.deepEqual(identities.sort(compareStorySourceIdentity).map((item) => item.id), [
    "doc-a-first", "doc-a-second", "doc-b-early-clock",
  ]);
});

test("mixed Story identity keys form an exhaustive bounded total order", () => {
  const identities = [
    { id: "local-b", timestamp: "08:00", documentId: "doc-b", sequence: 1 },
    { id: "local-a2", timestamp: "9:00 PM", documentId: "doc-a", sequence: 2 },
    { id: "local-a1", timestamp: null, documentId: "doc-a", sequence: 1 },
    { id: "absolute-later", timestamp: "2026-01-01T00:00:01Z", documentId: "doc-a", sequence: 1 },
    { id: "absolute-b", timestamp: "2026-01-01T01:00:00+01:00", documentId: "doc-b", sequence: 1 },
    { id: "absolute-a", timestamp: "2026-01-01T00:00:00Z", documentId: "doc-a", sequence: 1 },
  ];
  const expected = ["local-a1", "local-a2", "local-b", "absolute-a", "absolute-b", "absolute-later"];
  for (const left of identities) for (const right of identities) {
    const forward = Math.sign(compareStorySourceIdentity(left, right));
    const reverse = Math.sign(compareStorySourceIdentity(right, left));
    if (left === right) assert.equal(forward, reverse);
    else {
      assert.equal(forward, -reverse);
      assert.notEqual(forward, 0);
    }
  }
  for (const left of identities) for (const middle of identities) for (const right of identities) {
    if (compareStorySourceIdentity(left, middle) <= 0
      && compareStorySourceIdentity(middle, right) <= 0) {
      assert.ok(compareStorySourceIdentity(left, right) <= 0);
    }
  }
  const permutations = (rows) => rows.length < 2 ? [rows] : rows.flatMap((row, index) => (
    permutations(rows.toSpliced(index, 1)).map((tail) => [row, ...tail])
  ));
  for (const permutation of permutations(identities)) {
    assert.deepEqual(permutation.sort(compareStorySourceIdentity).map((item) => item.id), expected);
  }
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
