import test from "node:test";
import assert from "node:assert/strict";
import { normalizeStoryPrivacyOutput, storyPreparationDigest } from "../lib/story-preparation.ts";
import { storyPrivacySourceRedactions, storyPrivacySourceRanges } from "../lib/story-privacy-projection.ts";

test("source ranges preserve overlapping code-point matches and surrogate boundaries", () => {
  const cases = [
    ["abc", "missing", []],
    ["aaa", "aa", [[0, 2], [1, 3]]],
    ["ababa", "aba", [[0, 3], [2, 5]]],
    ["😀a😀a", "😀a", [[0, 2], [2, 4]]],
    ["a😀a", "a", [[0, 1], [2, 3]]],
    ["😀", "\ud83d", []],
    ["😀", "\ude00", []],
    ["\ud83dx", "\ud83d", [[0, 1]]],
    ["x\ude00", "\ude00", [[1, 2]]],
    ["abc", "", []],
    ["", "", []],
    ["", "a", []],
  ];
  for (const [text, fragment, expected] of cases) {
    assert.deepEqual(storyPrivacySourceRanges(text, fragment), expected.map(([start, end]) => ({
      originalStartOffset: start, originalEndOffset: end,
    })), JSON.stringify({ text, fragment }));
  }
});

test("source inheritance distinguishes same-text contexts and covers final and edited proposal bytes", async () => {
  const source = { id: "metric", documentId: "source", itemId: "one", startOffset: 0,
    endOffset: 3, category: "internal-metric", text: "4.7", context: "An internal benchmark rate." };
  const target = { id: "chapter::overview", storyKey: "chapter", target: "overview",
    content: "Internal rate 4.7; public label 4.7." };
  const ranges = storyPrivacySourceRanges(target.content, source.text);
  const proposedText = "Internal rate [rate]; public label 4.7.";
  const match = (range, relation) => ({ ...range, sourceRedactionId: source.id,
    relation, reason: relation === "inherited" ? "This reports the marked benchmark." : "This is an unrelated public label." });
  const output = { candidates: [{ id: "rate", reviewState: "needs_confirmation", title: "Benchmark",
    whyFlagged: "The internal rate is inherited.", uncertaintyReason: "Confirm the anonymized rate.",
    releaseTargets: [target.id] }], targetProposals: [{ targetId: target.id,
    targetContentDigest: await storyPreparationDigest(target.content), proposedText,
    occurrences: [{ ...ranges[0], proposalStartOffset: ranges[0].originalStartOffset,
      proposalEndOffset: ranges[0].originalStartOffset + 6, category: "internal-metric" }],
    sourceMatches: [match(ranges[0], "inherited"), match(ranges[1], "unrelated")],
    proposalSourceMatches: storyPrivacySourceRanges(proposedText, source.text).map((range) => match(range, "unrelated")) }] };
  assert.ok(await normalizeStoryPrivacyOutput(output, [target], [source]));
  const missing = structuredClone(output); missing.targetProposals[0].sourceMatches.pop();
  assert.equal(await normalizeStoryPrivacyOutput(missing, [target], [source]), null);
  const missingFinal = structuredClone(output); delete missingFinal.targetProposals[0].proposalSourceMatches;
  assert.equal(await normalizeStoryPrivacyOutput(missingFinal, [target], [source]), null);
  const falselyInheritedFinal = structuredClone(output);
  falselyInheritedFinal.targetProposals[0].proposalSourceMatches[0].relation = "inherited";
  assert.equal(await normalizeStoryPrivacyOutput(falselyInheritedFinal, [target], [source]), null);
  assert.equal(await normalizeStoryPrivacyOutput(output, [target], [{ ...source, category: "credential" }]), null);

  const edited = { ...target, editedText: "A revised public label 4.7." };
  const withEdit = structuredClone(output);
  withEdit.targetProposals[0].editedProposal = { inputDigest: await storyPreparationDigest(edited.editedText),
    text: edited.editedText, sourceMatches: storyPrivacySourceRanges(edited.editedText, source.text).map((range) => match(range, "unrelated")) };
  assert.ok(await normalizeStoryPrivacyOutput(withEdit, [edited], [source]));
  withEdit.targetProposals[0].editedProposal.text += " Copied internal rate 4.7.";
  assert.equal(await normalizeStoryPrivacyOutput(withEdit, [edited], [source]), null);
  withEdit.targetProposals[0].editedProposal.text = edited.editedText;
  assert.ok(await normalizeStoryPrivacyOutput(withEdit, [edited], [source]));
  withEdit.targetProposals[0].editedProposal.inputDigest = "0".repeat(64);
  assert.equal(await normalizeStoryPrivacyOutput(withEdit, [edited], [source]), null);
});

test("fragmented source context crosses bounded adjacent items but never documents", () => {
  const rows = [{ id: "other", documentId: "outside", content: "Outside document sentinel" },
    ...Array.from({ length: 8 }, (_, index) => ({ id: `item-${index}`, documentId: "source",
      content: index === 1 ? "Public purchase context." : index === 6 ? "ten" : "Fragment." }))];
  const result = storyPrivacySourceRedactions(rows, [{ id: "mark", document_id: "source", item_id: "item-6",
    start_offset: 0, end_offset: 3, category: "internal-metric", status: "active", review_state: "deterministic" }]);
  assert.match(result[0].context, /Public purchase context/);
  assert.doesNotMatch(result[0].context, /Outside document sentinel/);
});
