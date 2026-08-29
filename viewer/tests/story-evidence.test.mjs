import test from "node:test";
import assert from "node:assert/strict";
import { reviewStoryEvidence } from "../lib/story-evidence.ts";

const primary = { documentId: "doc-a", eventId: "event-1" };
const supporting = { documentId: "doc-a", eventId: "event-2" };
const items = [
  { documentId: "doc-a", id: "doc-a:event-1", content: "The holdout evidence remained visible after the decision." },
  { documentId: "doc-a", id: "doc-a:event-2", content: "A second reviewed source confirmed the same boundary." },
];

test("Story evidence review resolves every Chapter reference against reviewed items", () => {
  assert.deepEqual(reviewStoryEvidence(items, [primary, supporting], []), {
    evidenceResolved: true,
    supportedAddIds: [],
  });
  assert.equal(reviewStoryEvidence(items, [{ documentId: "doc-a", eventId: "missing" }], []).evidenceResolved, false);
  assert.equal(reviewStoryEvidence(items, [primary, primary], []).evidenceResolved, false);
  assert.equal(reviewStoryEvidence([], [], []).evidenceResolved, false);
});

test("Add support requires the proposed wording in resolved reviewed evidence", () => {
  const supported = reviewStoryEvidence(items, [primary], [{
    annotationId: "supported",
    instruction: "Add that the holdout evidence remained visible after the decision.",
    supportingEvidence: [primary],
  }]);
  assert.deepEqual(supported.supportedAddIds, ["supported"]);

  const invented = reviewStoryEvidence(items, [primary], [{
    annotationId: "invented",
    instruction: "Add that an unrecorded customer approved the release.",
    supportingEvidence: [primary],
  }]);
  assert.deepEqual(invented.supportedAddIds, []);
});

test("Add support cannot cite evidence outside the Chapter or an ambiguous item", () => {
  const outsideChapter = reviewStoryEvidence(items, [primary], [{
    annotationId: "outside",
    instruction: "A second reviewed source confirmed the same boundary.",
    supportingEvidence: [supporting],
  }]);
  assert.deepEqual(outsideChapter.supportedAddIds, []);

  const ambiguousItems = [
    ...items,
    { documentId: "doc-a", id: "qualified:event-2", content: "A second reviewed source confirmed the same boundary." },
  ];
  const ambiguous = reviewStoryEvidence(ambiguousItems, [{ documentId: "doc-a", eventId: "event-2" }], []);
  assert.equal(ambiguous.evidenceResolved, false);

  const colonCollision = reviewStoryEvidence([
    { documentId: "a:b", id: "a:b:c", content: "Approved reviewed wording." },
    { documentId: "a", id: "a:b:c", content: "Invented wording should not cross documents." },
  ], [{ documentId: "a:b", eventId: "c" }], [{
    annotationId: "collision",
    instruction: "Invented wording should not cross documents.",
    supportingEvidence: [{ documentId: "a", eventId: "b:c" }],
  }]);
  assert.equal(colonCollision.evidenceResolved, true);
  assert.deepEqual(colonCollision.supportedAddIds, []);
});
