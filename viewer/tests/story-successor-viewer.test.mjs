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
  assert.match(successorEditor, /aiInsights\.length > 0 \|\| humanInsightIds\.length > 0/);
  assert.match(successorEditor, /<aside className="successorAnchoredInsights"/);
  assert.doesNotMatch(successorEditor, /approve no Insight|placeholder Insight|fake empty Insight/i);
});

test("successor People render safe source copy once without the legacy clipped marker or generic role", () => {
  const people = successorEditor.slice(
    successorEditor.indexOf("successor-people-heading"),
    successorEditor.indexOf("successor-story-heading"),
  );
  assert.match(people, /className="successorPeopleList"/);
  assert.match(people, /<strong>\{person\.releaseLabel\}<\/strong>/);
  assert.match(people, /<p>\{person\.description\}<\/p>/);
  assert.equal((people.match(/person\.releaseLabel/g) || []).length, 1);
  assert.equal((people.match(/person\.description/g) || []).length, 1);
  assert.doesNotMatch(people, /person\.role|className="personRow"|aria-label=\{person\.releaseLabel\}/);
});

test("AI and human Insights are owned by their exact Story anchors and rendered once in narrative order", () => {
  assert.match(successorEditor, /const ownerBlockId = \(chapterReview\.sourceInsightReviews\[insight\.id\]\?\.editedContent \|\| insight\)\.quote\.storyBlockIds\[0\]/);
  assert.match(successorEditor, /\(result\[ownerBlockId\] \|\|= \[\]\)\.push\(insight\)/);
  assert.match(successorEditor, /const ownerBlockId = chapterReview\.humanInsights\[insightId\]\.content\.quote\.storyBlockId/);
  assert.match(successorEditor, /Object\.keys\(chapterReview\.humanInsights\)\.sort\(\)/);
  assert.match(successorEditor, /const aiInsights = aiInsightsByBlock\[block\.id\] \|\| \[\]/);
  assert.match(successorEditor, /const humanInsightIds = humanInsightIdsByBlock\[block\.id\] \|\| \[\]/);
  assert.match(successorEditor, /data-insight-owner-block=\{block\.id\}/);
  assert.match(successorEditor, /aiInsights\.map\(\(insight\) => <SuccessorAiInsightCard/);
  assert.match(successorEditor, /humanInsightIds\.map\(\(insightId\) => <SuccessorHumanInsightCard/);
  assert.doesNotMatch(successorEditor, /Object\.keys\(chapterReview\.humanInsights\)\.sort\(\)\.map/);
});

test("successor Story exposes explicit and double-click edit entry through the common ledger", () => {
  assert.match(successorEditor, />Edit Story<\/button>/);
  assert.match(successorEditor, /onDoubleClick=\{handleStoryDoubleClick\}/);
  assert.match(successorEditor, /recordStoryEdit\(chapterReview/);
  assert.match(successorEditor, /storyWorkingBlock\(sourceBlock\.text, source\.key, blockId, "en", chapterReview\)/);
  assert.match(successorEditor, /undoStoryEdit\(chapterReview, "en"\)/);
  assert.match(successorEditor, /redoStoryEdit\(chapterReview, "en"\)/);
  assert.match(successorEditor, /applySuccessorChapterReview\(chapterReview/);
  assert.match(successorEditor, /onMouseUp=\{editMode \? undefined : captureSelection\}/);
  assert.match(successorEditor, /!editMode && selection\?\.blockId === block\.id/);
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
  assert.match(editor, /startCopy !== endCopy/);
  assert.match(editor, /root\.contains\(startCopy\).*root\.contains\(endCopy\)/);
  assert.match(editor, /selection: \{ start, end, text \}/);
  assert.match(editor, /reviewed\.slice\(current\.selection\.start, current\.selection\.end\) !== current\.selection\.text/);
  assert.match(editor, /id: `human:\$\{crypto\.randomUUID\(\)\}`/);
  assert.match(editor, /saveSuccessorHumanInsight/);
  assert.match(editor, /baseRevision: chapterReview\.revision/);
  assert.match(editor, /Human-created · approved on Save/);
  assert.doesNotMatch(editor, /Accept human Insight|redundant Accept/);
});

test("four meanings use safe Story grounding without raw Evidence copy", () => {
  for (const label of ["Background", "Quote", "Directly Acquired Experience", "Principle"]) {
    assert.match(editor, new RegExp(label));
  }
  assert.match(editor, /quoteText\(source, visible\.quote\.storyBlockIds\)/);
  assert.match(editor, /successorHumanQuoteText\(chapterReview, source, review\.content\)/);
  assert.match(editor, /fixedQuote=\{humanDraft\.quote\.selection\.text\}/);
  assert.match(editor, /Raw Evidence is never shown/);
  assert.doesNotMatch(successorEditor, /eventId\}|documentId\}|Inspect exact evidence/);
});

test("completion and blocker focus consume the central successor evaluator with safe code copy", () => {
  assert.match(successorEditor, /successorChapterReviewCompletionBlockers\(chapterReview, context\)/);
  assert.match(successorEditor, /successorBlockerCopy\[blocker\.code\]/);
  assert.doesNotMatch(successorEditor, /blocker\.(?:text|content|quote|evidence)/);
  assert.match(navigation, /SuccessorChapterReviewBlocker/);
});

test("workspace consumes the server-owned exact contract and releases both mapped versions", () => {
  assert.match(workspace, /const storyLane = compatibilityContract && compatibilityPackageReady[\s\S]*?successorContract && successorPackageReady/);
  assert.match(workspace, /parsedSession\.schema !== expectedSchema/);
  assert.match(workspace, /payload\.storySourceSchema !== workflow\.storySourceSchema/);
  assert.match(workspace, /hydrateSuccessorStoryReviewSession/);
  const download = workspace.slice(workspace.indexOf("const downloadReviewed"), workspace.indexOf("const ready ="));
  assert.match(download, /storyLane === "successor"[\s\S]*?createSuccessorStoryReviewSession/);
  assert.match(download, /body:JSON\.stringify\(\{workflowRunId,serverVersion,sourceRevision\}\)/);
  assert.doesNotMatch(download, /inactive in this Viewer lane/);
});

test("successor progress counts resolved AI versions and presents zero as affirmative", () => {
  assert.match(workspace, /const successorInsightProgress = successorProjectChapters\.reduce/);
  assert.match(workspace, /progress\.total\+=chapter\.source\.insights\.length/);
  assert.match(workspace, /review\?\.resolution==="applied" && review\.appliedVersion===review\.version/);
  assert.match(workspace, /reviewedInsightTotal = storyLane === "legacy" \? viewerChapters\.length : successorInsightProgress\.total/);
  assert.match(workspace, /No AI Insights required/);
  assert.match(successorEditor, /Review the Story as-is, and add a human Insight from selected Story text only if useful/);
  assert.doesNotMatch(successorEditor, /source\.insights\.length\s*\?\s*"No AI Insights required"/);
});

test("successor Timeline preserves source metadata without manufacturing markers or labels", () => {
  const successorTimeline = workspace.slice(
    workspace.indexOf("}) : successorProjectChapters.map"),
    workspace.indexOf("const phaseGroups"),
  );
  const timelineRows = workspace.slice(
    workspace.indexOf('<div className="milestoneMeta">'),
    workspace.indexOf("<footer>"),
  );
  assert.match(successorTimeline, /kind:chapter\.source\.kind,/);
  assert.match(successorTimeline, /before:chapter\.source\.transition\?\.before,/);
  assert.match(successorTimeline, /after:chapter\.source\.transition\?\.after,/);
  assert.match(successorTimeline, /chips:chapter\.source\.chips,/);
  assert.doesNotMatch(successorTimeline, /kind:chapter\.source\.kind \|\| "foundation"|chips:\[\]/);
  assert.doesNotMatch(successorTimeline, /transition\?\.(?:before|after)\s*\|\||chips:chapter\.source\.chips\s*\|\|/);
  assert.match(timelineRows, /event\.kind && <span>\{milestoneKindLabel\(event\.kind,storyLanguage\)\}<\/span>/);
  assert.match(timelineRows, /storyLane==="successor" && event\.successor && event\.successor\.source\.insights\.length > 0 && <strong>AI Insight<\/strong>/);
  assert.doesNotMatch(timelineRows, /Story Chapter|successorChapterReviews/);
  assert.match(timelineRows, /storyLane==="legacy" && <strong>\{labels\.selected\}<\/strong>/);
});

test("successor handoff progress uses the canonical completion evaluator", () => {
  assert.match(workspace, /state\?\.stage === "human_confirmed"[\s\S]*successorChapterReviewCompletionBlockers\(state,successorCompletionContext\(chapter\.source\)\)\.length === 0/);
  assert.doesNotMatch(workspace, /successorProjectChapters\.filter\(\(chapter\) => successorChapterReviews\[chapter\.source\.key\]\?\.stage === "human_confirmed"\)/);
});

test("the route accepts only explicit canonical schema dispatch", () => {
  assert.match(route, /parseStoryReviewSession\(body\.session\)/);
  assert.match(route, /session\.schema !== active\.storySessionSchema/);
  assert.doesNotMatch(route, /canonicalizeStoryReviewSession\(body\.session\)/);
});
