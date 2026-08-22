import test from "node:test";
import assert from "node:assert/strict";
import { phaseGroupIdentity, restoreChapterContext, restoreEvidenceOrigin } from "../lib/story-navigation.ts";

test("Evidence return state restores only its originating Chapter", () => {
  const context = { storyKey: "chapter-nine", scrollTop: 842, focusOriginId: "chapter-evidence-1" };
  assert.deepEqual(restoreChapterContext(context, "chapter-nine"), { scrollTop: 842, focusOriginId: "chapter-evidence-1" });
  assert.deepEqual(restoreChapterContext(context, "chapter-ten"), { scrollTop: 0, focusOriginId: "" });
  assert.deepEqual(restoreChapterContext(null, "chapter-nine"), { scrollTop: 0, focusOriginId: "" });
});

test("Evidence return reopens its disclosure and focuses the exact originating control", () => {
  const disclosure = { open: false };
  let originFocused = false;
  let fallbackFocused = false;
  const origin = {
    closest: (selector) => selector === "details" ? disclosure : null,
    focus: (options) => {
      originFocused = options.preventScroll;
    },
  };
  const fallback = { focus: () => { fallbackFocused = true; } };
  assert.equal(restoreEvidenceOrigin(origin, fallback), true);
  assert.equal(disclosure.open, true);
  assert.equal(originFocused, true);
  assert.equal(fallbackFocused, false);

  assert.equal(restoreEvidenceOrigin(null, fallback), false);
  assert.equal(fallbackFocused, true);
});

test("non-contiguous duplicate phase labels receive stable distinct sibling identities", () => {
  assert.deepEqual(["A", "B", "A"].map(phaseGroupIdentity), ["A:0", "B:1", "A:2"]);
});
