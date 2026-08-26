import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [editor, workspace, navigation, route] = await Promise.all([
  readFile(new URL("../app/story-chapter-editor.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/workspace.tsx", import.meta.url), "utf8"),
  readFile(new URL("../lib/story-navigation.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/story-review-session/route.ts", import.meta.url), "utf8"),
]);

const successorEditor = editor.slice(editor.indexOf("export function SuccessorStoryChapterEditor"));

test("zero-Insight Story rendering is independent from Insight cardinality", () => {
  assert.match(successorEditor, /source\.story\.blocks\.map/);
  assert.match(successorEditor, /source\.insights\.map/);
  assert.ok(successorEditor.indexOf("source.story.blocks.map") < successorEditor.indexOf("source.insights.map"));
  assert.doesNotMatch(successorEditor, /approve no Insight|placeholder Insight|fake empty Insight/i);
});

test("source and human Insight cards are keyed and focused only by stable IDs", () => {
  assert.match(successorEditor, /key=\{insight\.id\}/);
  assert.match(successorEditor, /key=\{insightId\}/);
  assert.match(successorEditor, /insightRefs\.current\[reviewFocus\.targetId\]/);
  assert.doesNotMatch(successorEditor, /key=\{(?:index|activeStoryIndex)\}/);
});

test("AI cards expose exact Accept, Edit, and Do-not-preserve actions through successor reducers", () => {
  assert.match(editor, /updateSuccessorAiInsightDecision\(reopen\(\), source, insight\.id, decision\)/);
  assert.match(editor, /editSuccessorAiInsight\(reopen\(\), source, insight\.id/);
  assert.match(editor, />✓ Accept<\/button>/);
  assert.match(editor, />Edit<\/button>/);
  assert.match(editor, />× Do not preserve<\/button>/);
  assert.match(editor, /Edited version \$\{review\.version\} · Accept required/);
});

test("confirmed Insight changes reopen review before edited bytes enter session state", () => {
  assert.match(editor, /chapterReview\.stage === "human_confirmed"[\s\S]*?returnChapterToReview\(chapterReview\)/);
  assert.match(editor, /const beginEdit = \(\) => \{[\s\S]*?onChapterReview\(reopen\(\)\)/);
});

test("human Add Insight uses one native same-block selection and a stable human identity", () => {
  assert.match(editor, /selection\.rangeCount !== 1/);
  assert.match(editor, /start !== end/);
  assert.match(editor, /root\.contains\(start\).*root\.contains\(end\)/);
  assert.match(editor, /block\.text\.includes\(current\.quote\)/);
  assert.match(editor, /id: `human:\$\{crypto\.randomUUID\(\)\}`/);
  assert.match(editor, /saveSuccessorHumanInsight/);
  assert.match(editor, /Human-created · approved on Save/);
  assert.doesNotMatch(editor, /Accept human Insight|redundant Accept/);
});

test("four meanings use safe Story grounding without raw Evidence copy", () => {
  for (const label of ["Background", "Quote", "Directly Acquired Experience", "Principle"]) {
    assert.match(editor, new RegExp(label));
  }
  assert.match(editor, /quoteText\(source, visible\.quote\.storyBlockIds\)/);
  assert.match(editor, /Raw Evidence is never shown/);
  assert.doesNotMatch(successorEditor, /eventId\}|documentId\}|Inspect exact evidence/);
});

test("completion and blocker focus consume the central successor evaluator with safe code copy", () => {
  assert.match(successorEditor, /successorChapterReviewCompletionBlockers\(chapterReview, context\)/);
  assert.match(successorEditor, /successorBlockerCopy\[blocker\.code\]/);
  assert.doesNotMatch(successorEditor, /blocker\.(?:text|content|quote|evidence)/);
  assert.match(navigation, /SuccessorChapterReviewBlocker/);
});

test("workspace exact-dispatches v1 and v2, preserves legacy priority, and never releases successor", () => {
  assert.match(workspace, /const storyLane = activatedStoryHighlights\.length[\s\S]*?"legacy"[\s\S]*?"successor"/);
  assert.match(workspace, /parsedSession\.schema !== expectedSchema/);
  assert.match(workspace, /hydrateSuccessorStoryReviewSession/);
  const download = workspace.slice(workspace.indexOf("const downloadReviewed"), workspace.indexOf("const ready ="));
  assert.ok(download.indexOf("storyLane === \"successor\"") < download.indexOf("runDurableStoryReviewHandoff"));
  assert.match(download, /Successor download and release remain inactive/);
});

test("successor progress counts independently resolved AI Insight versions, including zero-of-zero", () => {
  assert.match(workspace, /const successorInsightProgress = successorProjectChapters\.reduce/);
  assert.match(workspace, /progress\.total\+=chapter\.source\.insights\.length/);
  assert.match(workspace, /review\?\.resolution==="applied" && review\.appliedVersion===review\.version/);
  assert.match(workspace, /reviewedInsightTotal = storyLane === "legacy" \? viewerChapters\.length : successorInsightProgress\.total/);
  assert.match(workspace, /reviewedInsights\}\/\{reviewedInsightTotal\}/);
});

test("the route accepts only explicit canonical schema dispatch", () => {
  assert.match(route, /parseStoryReviewSession\(body\.session\)/);
  assert.doesNotMatch(route, /canonicalizeStoryReviewSession\(body\.session\)/);
});
