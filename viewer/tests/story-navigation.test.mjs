import test from "node:test";
import assert from "node:assert/strict";
import { phaseGroupIdentity, restoreChapterContext } from "../lib/story-navigation.ts";

test("Evidence return state restores only its originating Chapter", () => {
  const context = { storyKey: "chapter-nine", scrollTop: 842, focusOriginId: "chapter-evidence-1" };
  assert.deepEqual(restoreChapterContext(context, "chapter-nine"), { scrollTop: 842, focusOriginId: "chapter-evidence-1" });
  assert.deepEqual(restoreChapterContext(context, "chapter-ten"), { scrollTop: 0, focusOriginId: "" });
  assert.deepEqual(restoreChapterContext(null, "chapter-nine"), { scrollTop: 0, focusOriginId: "" });
});

test("non-contiguous duplicate phase labels receive stable distinct sibling identities", () => {
  assert.deepEqual(["A", "B", "A"].map(phaseGroupIdentity), ["A:0", "B:1", "A:2"]);
});
