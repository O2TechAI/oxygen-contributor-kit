import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { timelinePresentation } from "../lib/timeline.ts";

const [editor, workspace, navigation, route] = await Promise.all([
  readFile(new URL("../app/story-chapter-editor.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/workspace.tsx", import.meta.url), "utf8"),
  readFile(new URL("../lib/story-navigation.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/story-review-session/route.ts", import.meta.url), "utf8"),
]);

const storyEditor = editor.slice(editor.indexOf("export function StoryChapterEditor"));

test("zero-Insight Story rendering is independent from Insight cardinality", () => {
  assert.match(storyEditor, /source\.story\.blocks\.map/);
  assert.match(storyEditor, /aiInsights\.length > 0 \|\| humanInsightIds\.length > 0/);
  assert.match(storyEditor, /<aside className="storyAnchoredInsights"/);
  assert.doesNotMatch(storyEditor, /approve no Insight|placeholder Insight|fake empty Insight/i);
});

test("story People render safe source copy once without a clipped marker or generic role", () => {
  const people = storyEditor.slice(
    storyEditor.indexOf("story-people-heading"),
    storyEditor.indexOf("story-story-heading"),
  );
  assert.match(people, /className="storyPeopleList"/);
  assert.match(people, /<strong>\{person\.releaseLabel\}<\/strong>/);
  assert.match(people, /<p>\{person\.description\}<\/p>/);
  assert.equal((people.match(/person\.releaseLabel/g) || []).length, 1);
  assert.equal((people.match(/person\.description/g) || []).length, 1);
  assert.doesNotMatch(people, /person\.role|className="personRow"|aria-label=\{person\.releaseLabel\}/);
});

test("AI and human Insights are owned by their exact Story anchors and rendered once in narrative order", () => {
  assert.match(storyEditor, /const ownerBlockId = \(chapterReview\.sourceInsightReviews\[insight\.id\]\?\.editedContent \|\| insight\)\.quote\.storyBlockIds\[0\]/);
  assert.match(storyEditor, /\(result\[ownerBlockId\] \|\|= \[\]\)\.push\(insight\)/);
  assert.match(storyEditor, /const ownerBlockId = chapterReview\.humanInsights\[insightId\]\.content\.quote\.storyBlockId/);
  assert.match(storyEditor, /Object\.keys\(chapterReview\.humanInsights\)\.sort\(\)/);
  assert.match(storyEditor, /const aiInsights = aiInsightsByBlock\[block\.id\] \|\| \[\]/);
  assert.match(storyEditor, /const humanInsightIds = humanInsightIdsByBlock\[block\.id\] \|\| \[\]/);
  assert.match(storyEditor, /data-insight-owner-block=\{block\.id\}/);
  assert.match(storyEditor, /aiInsights\.map\(\(insight\) => <AiInsightCard/);
  assert.match(storyEditor, /humanInsightIds\.map\(\(insightId\) => <HumanInsightCard/);
  assert.doesNotMatch(storyEditor, /Object\.keys\(chapterReview\.humanInsights\)\.sort\(\)\.map/);
});

test("story Story exposes explicit and double-click edit entry through the common ledger", () => {
  assert.match(storyEditor, />Edit Story<\/button>/);
  assert.match(storyEditor, /onDoubleClick=\{handleStoryDoubleClick\}/);
  assert.match(storyEditor, /recordStoryEdit\(chapterReview/);
  assert.match(storyEditor, /storyWorkingBlock\(sourceBlock\.text, source\.key, blockId, "en", chapterReview\)/);
  assert.match(storyEditor, /undoStoryEdit\(chapterReview, "en"\)/);
  assert.match(storyEditor, /redoStoryEdit\(chapterReview, "en"\)/);
  assert.match(storyEditor, /applyChapterReview\(chapterReview/);
  assert.match(storyEditor, /onMouseUp=\{editMode \? undefined : captureSelection\}/);
  assert.match(storyEditor, /!editMode && selection\?\.blockId === block\.id/);
});

test("source and human Insight cards are keyed and focused only by stable IDs", () => {
  assert.match(storyEditor, /key=\{insight\.id\}/);
  assert.match(storyEditor, /key=\{insightId\}/);
  assert.match(storyEditor, /insightRefs\.current\[reviewFocus\.targetId\]/);
  assert.doesNotMatch(storyEditor, /key=\{(?:index|activeStoryIndex)\}/);
});

test("AI cards expose exact Accept, Edit, and Do-not-preserve actions through story reducers", () => {
  assert.match(editor, /updateAiInsightDecision\(reopen\(\), source, insight\.id, decision\)/);
  assert.match(editor, /editAiInsight\(reopen\(\), source, insight\.id/);
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
  assert.match(editor, /startCopy !== endCopy/);
  assert.match(editor, /root\.contains\(startCopy\).*root\.contains\(endCopy\)/);
  assert.match(editor, /selection: \{ start, end, text \}/);
  assert.match(editor, /reviewed\.slice\(current\.selection\.start, current\.selection\.end\) !== current\.selection\.text/);
  assert.match(editor, /id: `human:\$\{crypto\.randomUUID\(\)\}`/);
  assert.match(editor, /saveHumanInsight/);
  assert.match(editor, /baseRevision: chapterReview\.revision/);
  assert.match(editor, /Human-created · approved on Save/);
  assert.doesNotMatch(editor, /Accept human Insight|redundant Accept/);
});

test("four meanings use safe Story grounding without raw Evidence copy", () => {
  for (const label of ["Background", "Quote", "Directly Acquired Experience", "Principle"]) {
    assert.match(editor, new RegExp(label));
  }
  assert.match(editor, /quoteText\(source, visible\.quote\.storyBlockIds\)/);
  assert.match(editor, /humanQuoteText\(chapterReview, source, review\.content\)/);
  assert.match(editor, /fixedQuote=\{humanDraft\.quote\.selection\.text\}/);
  assert.match(editor, /Raw Evidence is never shown/);
  assert.doesNotMatch(storyEditor, /eventId\}|documentId\}|Inspect exact evidence/);
});

test("completion and blocker focus consume the central story evaluator with safe code copy", () => {
  assert.match(storyEditor, /chapterReviewCompletionBlockers\(chapterReview, context\)/);
  assert.match(storyEditor, /storyBlockerCopy\[blocker\.code\]/);
  assert.doesNotMatch(storyEditor, /blocker\.(?:text|content|quote|evidence)/);
  assert.match(navigation, /StoryReviewFocusTarget = Pick<ChapterReviewBlocker/);
});

test("workspace consumes only the server-owned exact Story contract", () => {
  assert.match(workspace, /const storyContract = workflow\.storySourceSchema === "oxygen\.story"[\s\S]*workflow\.storySessionSchema === STORY_REVIEW_SESSION_SCHEMA/);
  assert.match(workspace, /const storyReady = storyContract && storyPackageReady/);
  assert.match(workspace, /parsedSession && parsedSession\.schema !== STORY_REVIEW_SESSION_SCHEMA/);
  assert.match(workspace, /payload\.storySourceSchema !== workflow\.storySourceSchema/);
  assert.match(workspace, /hydrateStoryReviewSession/);
  const download = workspace.slice(workspace.indexOf("const downloadReviewed"), workspace.indexOf("const ready ="));
  assert.match(download, /createStoryReviewSession\(workflowRunId,current\.chapterReviews,current\.privacyDecisions\)/);
  assert.match(download, /body:JSON\.stringify\(\{workflowRunId,serverVersion,sourceRevision\}\)/);
  assert.doesNotMatch(workspace, /compatibilityContract|compatibilityPackageReady|expectedSchema|storyLane/);
});

test("story progress counts resolved AI versions and presents zero as affirmative", () => {
  assert.match(workspace, /const insightProgress = projectChapters\.reduce/);
  assert.match(workspace, /progress\.total\+=chapter\.source\.insights\.length/);
  assert.match(workspace, /review\?\.resolution==="applied" && review\.appliedVersion===review\.version/);
  assert.match(workspace, /const reviewedInsightTotal = insightProgress\.total/);
  assert.match(workspace, /No AI Insights required/);
  assert.match(storyEditor, /Review the Story as-is, and add a human Insight from selected Story text only if useful/);
  assert.doesNotMatch(storyEditor, /source\.insights\.length\s*\?\s*"No AI Insights required"/);
});

test("story Timeline executes the exact source mapping without manufacturing fields", () => {
  const transition = { before: "Manual review", after: "Approved release" };
  const chips = ["reviewed", "local-only"];
  const present = timelinePresentation({
    kind: "decision",
    transition,
    chips,
    insights: [{ id: "insight-1" }],
  });
  const absent = timelinePresentation({ insights: [] });

  assert.equal(present.kind, "decision");
  assert.equal(present.before, transition.before);
  assert.equal(present.after, transition.after);
  assert.strictEqual(present.chips, chips);
  assert.equal(present.marker, "ai_insight");
  assert.deepEqual(absent, {});
  assert.equal(Object.hasOwn(absent, "kind"), false);
  assert.equal(Object.hasOwn(absent, "chips"), false);

  const timelineRows = workspace.slice(
    workspace.indexOf('<div className="storyChapterList">'),
    workspace.indexOf('</article>)}</div>'),
  );
  assert.match(workspace, /timelineAiInsight:"AI Insight"/);
  assert.match(workspace, /timelineAiInsight:"AI 洞察"/);
  assert.match(timelineRows, /event\.timelineMarker === "ai_insight" && <strong>\{labels\.timelineAiInsight\}<\/strong>/);
  assert.match(timelineRows, /event\.kind && <span>\{storyKindLabel\(event\.kind,storyLanguage\)\}<\/span>/);
  assert.match(timelineRows, /event\.before && event\.after/);
  assert.match(timelineRows, /event\.chips && event\.chips\.length > 0/);
  assert.doesNotMatch(timelineRows, /storyChapterReviews|storyLane/);
});

test("story handoff progress uses the canonical completion evaluator", () => {
  assert.match(workspace, /state\?\.stage === "human_confirmed"[\s\S]*chapterReviewCompletionBlockers\(state,completionContext\(chapter\.source\)\)\.length === 0/);
  assert.doesNotMatch(workspace, /storyProjectChapters\.filter\(\(chapter\) => storyChapterReviews\[chapter\.source\.key\]\?\.stage === "human_confirmed"\)/);
});

test("the route accepts only explicit canonical schema dispatch", () => {
  assert.match(route, /parseStoryReviewSession\(body\.session\)/);
  assert.match(route, /session\.schema !== active\.storySessionSchema/);
  assert.doesNotMatch(route, /canonicalizeStoryReviewSession\(body\.session\)/);
});
