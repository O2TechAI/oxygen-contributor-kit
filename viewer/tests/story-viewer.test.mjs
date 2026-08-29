import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { timelinePresentation } from "../lib/timeline.ts";
import {
  emptyChapterReview,
  saveHumanInsight,
  storyBlocks,
} from "../lib/story-review.ts";
import { testStoryCoverage } from "./fixtures/story-coverage.mjs";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL && specifier.startsWith(".")) {
      const resolvedPath = fileURLToPath(new URL(specifier, context.parentURL));
      if (!extname(resolvedPath)) {
        for (const extension of [".ts", ".tsx"]) {
          if (existsSync(`${resolvedPath}${extension}`)) return nextResolve(`${specifier}${extension}`, context);
        }
        if (existsSync(join(resolvedPath, "index.ts"))) return nextResolve(`${specifier}/index.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx")) {
      const source = readFileSync(fileURLToPath(url), "utf8");
      return {
        format: "module",
        shortCircuit: true,
        source: ts.transpileModule(source, {
          compilerOptions: {
            jsx: ts.JsxEmit.ReactJSX,
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
          },
          fileName: fileURLToPath(url),
        }).outputText,
      };
    }
    return nextLoad(url, context);
  },
});

const { StoryChapterEditor } = await import("../app/story-chapter-editor.tsx");

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
  assert.match(storyEditor, /const ownerBlockId = insight\.anchorStoryBlockId/);
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

test("the rendered editor keeps paragraph-owned Insight cards in a separate responsive companion area", async () => {
  const evidence = { documentId: "render-document", eventId: "render-document:event" };
  const source = {
    schema: "oxygen.story",
    key: "rendered-paragraph-ownership",
    phase: { id: "proof", label: "Proof" },
    title: "Paragraph-owned Insight cards",
    overview: "Two paragraphs prove exact ownership without inline or aggregate insertion.",
    people: [],
    story: { blocks: [{
      id: "paragraph-one",
      text: "The first paragraph remains uninterrupted.",
      evidence: [evidence],
    }, {
      id: "paragraph-two",
      text: "The second paragraph owns both separate Insight cards.",
      evidence: [evidence],
    }] },
    insights: [{
      id: "ai:paragraph-two",
      background: "The second paragraph supplies the bounded context.",
      anchorStoryBlockId: "paragraph-two",
      quote: {
        text: "Another reviewer challenged the assumption.",
        evidence,
      },
      directlyAcquiredExperience: "The exact paragraph changed the next check.",
      principle: "Keep the card beside its supporting paragraph.",
      evidence: [evidence],
    }],
    evidence: { primary: evidence, supporting: [] },
    coverage: testStoryCoverage(),
  };
  const text = source.story.blocks[1].text;
  const selected = "second paragraph";
  const start = text.indexOf(selected);
  const initial = emptyChapterReview(source);
  const blocks = storyBlocks(source);
  const saved = saveHumanInsight(initial, {
    source,
    privacyCandidates: [],
    privacyDecisions: {},
    targetCatalog: new Map(),
    evidenceResolved: true,
    supportedAddIds: [],
    supportedEditIds: [],
    sourceBlocks: blocks,
    reviewedBlocks: blocks,
  }, "human:paragraph-two", {
    background: "A human reviewer selected the exact supporting paragraph.",
    quote: {
      chapterKey: source.key,
      storyBlockId: "paragraph-two",
      selection: { start, end: start + selected.length, text: selected },
      baseRevision: initial.revision,
    },
    directlyAcquiredExperience: "The human selection retained the paragraph boundary.",
    principle: "Keep human interpretation separate from Story prose.",
    evidence: [evidence],
  });
  assert.equal(saved.blockedReason, undefined);

  const html = renderToStaticMarkup(createElement(StoryChapterEditor, {
    source,
    position: 1,
    total: 1,
    chapterReview: saved.state,
    onChapterReview() {},
    onClose() {},
    onPrevious() {},
    onNext() {},
    language: "en",
  }));
  const firstRowStart = html.indexOf('data-insight-owner-block="paragraph-one"');
  const secondRowStart = html.indexOf('data-insight-owner-block="paragraph-two"');
  const secondRowEnd = html.indexOf('<section class="chapterCompletion"', secondRowStart);
  assert.ok(firstRowStart >= 0 && secondRowStart > firstRowStart && secondRowEnd > secondRowStart,
    JSON.stringify({ firstRowStart, secondRowStart, secondRowEnd }));
  const firstRow = html.slice(firstRowStart, secondRowStart);
  const secondRow = html.slice(secondRowStart, secondRowEnd);
  assert.match(firstRow, /data-story-block="paragraph-one"[\s\S]*?<p data-story-copy="true">The first paragraph remains uninterrupted\.<\/p>/);
  assert.doesNotMatch(firstRow, /storyInsightCard|storyAnchoredInsights/);
  assert.match(secondRow, /data-story-block="paragraph-two"[\s\S]*?<p data-story-copy="true">The second paragraph owns both separate Insight cards\.<\/p><\/div><aside class="storyAnchoredInsights"/);
  assert.match(secondRow, /data-story-insight="ai:paragraph-two"[^>]*data-insight-origin="source_ai"/);
  assert.match(secondRow, /data-story-insight="human:paragraph-two"[^>]*data-insight-origin="human_created"/);
  assert.match(secondRow, /<dt>Quote<\/dt><dd><blockquote>Another reviewer challenged the assumption\.<\/blockquote><\/dd>/);
  assert.doesNotMatch(secondRow, /<blockquote>The second paragraph owns both separate Insight cards\.<\/blockquote>/);
  assert.equal((html.match(/data-story-insight="ai:paragraph-two"/g) || []).length, 1);
  assert.equal((html.match(/data-story-insight="human:paragraph-two"/g) || []).length, 1);
  assert.doesNotMatch(html.slice(secondRowEnd), /storyInsightCard|storyAnchoredInsights/);

  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.storyNarrativeRow\{display:grid;grid-template-columns:minmax\(0,720px\) minmax\(280px,360px\)/);
  assert.match(css, /\.storyAnchoredInsights\{display:grid;gap:16px;min-width:0;align-self:start\}/);
  assert.match(css, /@media\(max-width:1050px\)\{\.storyNarrativeRow\{grid-template-columns:minmax\(0,720px\)\}\.storyAnchoredInsights\{margin:0 0 14px 8px\}/);
  assert.match(css, /@media\(max-width:760px\)\{\.storyNarrativeRow\{grid-template-columns:1fr\}/);
  assert.ok(secondRow.indexOf('class="storyBlock"') < secondRow.indexOf('class="storyAnchoredInsights"'),
    "desktop and narrow layouts preserve a separate prose component followed by its owned card component");
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

test("AI source Quote is read-only trajectory text while Human Quote keeps exact Story selection", () => {
  for (const label of ["Background", "Quote", "Directly Acquired Experience", "Principle"]) {
    assert.match(editor, new RegExp(label));
  }
  assert.match(editor, /<blockquote>\{sourceContent\.quote\.text\}<\/blockquote>/);
  assert.match(editor, /fixedQuote=\{sourceContent\.quote\.text\}/);
  assert.match(editor, /Quote · read-only/);
  assert.match(editor, /humanQuoteText\(chapterReview, source, review\.content\)/);
  assert.match(editor, /fixedQuote=\{humanDraft\.quote\.selection\.text\}/);
  assert.doesNotMatch(editor, /QuoteFields|storyBlockIds/);
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
  assert.match(download, /createStoryReviewSession\(workflowRunId,current\.chapterReviews,\{\}\)/);
  assert.doesNotMatch(download, /current\.privacyDecisions/);
  assert.match(download, /body:JSON\.stringify\(\{workflowRunId,serverVersion,sourceRevision\}\)/);
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
