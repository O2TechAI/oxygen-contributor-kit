import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import ts from "typescript";
import { testStoryCoverage } from "./fixtures/story-coverage.mjs";
import {
  applyChapterReview,
  chapterReviewCompletionBlockers,
  emptyChapterReview,
  markChapterReady,
  storyBlocks,
  updateAiInsightDecision,
} from "../lib/story-review.ts";
import { groupDownloadReviewBlockers } from "../lib/story-navigation.ts";
import { createStoryReviewSession } from "../lib/story-review-session.ts";
import { deriveWorkflowProgress } from "../lib/workflow-progress.ts";

const reactMockUrl = `data:text/javascript,${encodeURIComponent(`
const runtime = () => globalThis.__STORY_UI_TEST_REACT__;
export const useState = (...args) => runtime().useState(...args);
export const useRef = (...args) => runtime().useRef(...args);
export const useMemo = (...args) => runtime().useMemo(...args);
export const useCallback = (...args) => runtime().useCallback(...args);
export const useEffect = (...args) => runtime().useEffect(...args);
export default { useState, useRef, useMemo, useCallback, useEffect };
`)}`;
const jsxMockUrl = `data:text/javascript,${encodeURIComponent(`
export const Fragment = Symbol.for("story-ui-test.fragment");
export function jsx(type, props, key) { return { type, key, props: props || {} }; }
export const jsxs = jsx;
`)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "react") return { url: reactMockUrl, shortCircuit: true };
    if (specifier === "react/jsx-runtime") return { url: jsxMockUrl, shortCircuit: true };
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
      return {
        format: "module",
        shortCircuit: true,
        source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
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

const { InlineWorkspace } = await import("../app/workspace.tsx");

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const evidence = { documentId: "doc", eventId: "doc:event" };
const insightId = "safe-insight";
const source = {
  schema: "oxygen.story",
  key: "chapter-one",
  phase: { id: "review", label: "Review" },
  title: "Synthetic Chapter",
  overview: "A bounded Story used only for blocker behavior.",
  people: [],
  story: { blocks: [{ id: "scene", text: "Safe source.", evidence: [evidence] }] },
  insights: [{
    id: insightId,
    background: "A synthetic review context.",
    quote: { storyBlockIds: ["scene"] },
    directlyAcquiredExperience: "The exact bounded review was exercised.",
    principle: "Block release until every Insight decision is applied.",
    evidence: [evidence],
  }],
  evidence: { primary: evidence, supporting: [] },
  coverage: testStoryCoverage(),
};
const blocks = storyBlocks(source);
const completionContext = {
  source,
  privacyCandidates: [],
  privacyDecisions: {},
  targetCatalog: new Map(),
  evidenceResolved: true,
  supportedAddIds: [],
  supportedEditIds: [],
  sourceBlocks: blocks,
  reviewedBlocks: blocks,
};

function createHookRuntime() {
  const slots = [];
  let index = 0;
  const next = () => index++;
  return {
    slots,
    begin() { index = 0; },
    useState(initial) {
      const slot = next();
      if (!(slot in slots)) slots[slot] = typeof initial === "function" ? initial() : initial;
      return [slots[slot], (value) => {
        slots[slot] = typeof value === "function" ? value(slots[slot]) : value;
      }];
    },
    useRef(initial) {
      const slot = next();
      if (!(slot in slots)) slots[slot] = { current: initial };
      return slots[slot];
    },
    useMemo(factory) { next(); return factory(); },
    useCallback(callback) { next(); return callback; },
    useEffect() { next(); },
  };
}

function childNodes(node) {
  if (!node || typeof node !== "object") return [];
  const children = node.props?.children;
  return Array.isArray(children) ? children : children === undefined ? [] : [children];
}

function findNodes(node, predicate, result = []) {
  if (Array.isArray(node)) {
    for (const child of node) findNodes(child, predicate, result);
    return result;
  }
  if (!node || typeof node !== "object") return result;
  if (predicate(node)) result.push(node);
  for (const child of childNodes(node)) findNodes(child, predicate, result);
  return result;
}

function nodeText(node) {
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object") return "";
  return childNodes(node).map(nodeText).join("");
}

function workspaceFixture(review) {
  const privateSentinels = {
    title: "PRIVATE_CHAPTER_TITLE_SENTINEL",
    overview: "PRIVATE_OVERVIEW_SENTINEL",
    block: "PRIVATE_STORY_COPY_SENTINEL",
    insight: "PRIVATE_INSIGHT_COPY_SENTINEL",
  };
  const uiSource = {
    ...source,
    key: "download-ui-chapter",
    title: privateSentinels.title,
    overview: privateSentinels.overview,
    story: { blocks: [{ id: "scene", text: privateSentinels.block, evidence: [evidence] }] },
    insights: [{
      ...source.insights[0],
      id: "download-ui-insight",
      background: privateSentinels.insight,
      quote: { storyBlockIds: ["scene"] },
    }],
  };
  const project = "Download UI Project";
  const event = {
    id: "download-ui-event",
    sequence: 1,
    timestamp: "2038-08-27T00:00:00.000Z",
    project,
    summary: `oxygen.story:${JSON.stringify(uiSource)}`,
  };
  const document = {
    id: evidence.documentId,
    title: "Synthetic Story document",
    item_count: 1,
    formatted_summary: {
      primary_project: project,
      project_summary: "Safe project summary",
      projects: [{ name: project, event_count: 1, primary: true }],
      highlights: [event],
    },
  };
  const workflowRunId = "download-ui-run";
  const workflow = deriveWorkflowProgress({
    workflowRunId,
    targetConfirmed: true,
    collectionStatus: "complete",
    collectionCompleted: 1,
    collectionTotal: 1,
    documentCount: 1,
    itemCount: 1,
    organizedItemCount: 1,
    organizationStatus: "complete",
    redactionStatus: "complete",
    storyGenerationStatus: "ready_for_human_review",
    storyGenerationCompleted: 1,
    storyGenerationTotal: 1,
    storySourceSchema: "oxygen.story",
    storySessionSchema: "oxygen.story-review-session",
    updatedAt: "2038-08-27T00:00:00.000Z",
  });
  return {
    uiSource,
    privateSentinels,
    workflowRunId,
    props: {
      initialWorkflow: workflow,
      initialStatus: {
        status: "complete", stage: "complete", completed: 1, total: 1,
        percent: 100, documentCount: 1, warnings: [],
      },
      initialDocuments: [document],
      initialChapterReviews: { [uiSource.key]: review || emptyChapterReview(uiSource) },
      initialPrivacyDecisions: {},
      initialStorySessionReadyRunId: workflowRunId,
    },
  };
}

function renderWorkspace(runtime, props) {
  globalThis.__STORY_UI_TEST_REACT__ = runtime;
  runtime.begin();
  return InlineWorkspace(props);
}

function buttonWithText(tree, text) {
  return findNodes(tree, (node) => node.type === "button" && nodeText(node).includes(text))[0];
}

test("download aggregation preserves completion semantics and adds only the release-stage blocker", () => {
  const accepted = updateAiInsightDecision(emptyChapterReview(source), source, insightId, "accepted");
  const applied = applyChapterReview(accepted, completionContext).state;
  const confirmed = markChapterReady(applied, completionContext);
  assert.equal(confirmed.sourceInsightReviews[insightId].resolution, "applied");
  assert.deepEqual(chapterReviewCompletionBlockers(confirmed, completionContext), []);
  assert.deepEqual(groupDownloadReviewBlockers([{
    project: "Project", chapterKey: source.key, stage: confirmed.stage, completionBlockers: [],
  }]), []);

  const revisionReady = groupDownloadReviewBlockers([{
    project: "Project", chapterKey: source.key, stage: "revision_ready", completionBlockers: [],
  }]);
  assert.deepEqual(revisionReady[0].blockers, [{ code: "chapter_not_confirmed", targetKind: "chapter" }]);

  const pending = emptyChapterReview(source);
  const completionBlockers = chapterReviewCompletionBlockers(pending, completionContext);
  assert.deepEqual(completionBlockers, [{
    code: "evidence_unverified", chapterKey: source.key, targetKind: "chapter",
  }, {
    code: "revision_provenance_mismatch", chapterKey: source.key, targetKind: "chapter",
  }, {
    code: "ai_insight_decision_pending", chapterKey: source.key, targetKind: "insight", targetId: insightId,
  }]);
  assert.deepEqual(groupDownloadReviewBlockers([{
    project: "Project", chapterKey: source.key, stage: pending.stage, completionBlockers,
  }])[0].blockers, [
    { code: "evidence_unverified", targetKind: "chapter" },
    { code: "revision_provenance_mismatch", targetKind: "chapter" },
    { code: "ai_insight_decision_pending", targetKind: "insight", targetId: insightId },
    { code: "chapter_not_confirmed", targetKind: "chapter" },
  ]);
});

test("malformed review state collapses to safe generic blocker data", () => {
  const malformed = { ...emptyChapterReview(source), annotations: [{ instruction: "PRIVATE_REJECTED_COPY" }] };
  const completionBlockers = chapterReviewCompletionBlockers(malformed, completionContext);
  assert.deepEqual(completionBlockers, [{
    code: "review_state_invalid", chapterKey: source.key, targetKind: "chapter",
  }]);
  const serialized = JSON.stringify(groupDownloadReviewBlockers([{
    project: "Project", chapterKey: source.key, stage: "reviewing", completionBlockers,
  }]));
  assert.equal(serialized.includes("PRIVATE_REJECTED_COPY"), false);
});

test("blocker projection excludes private source copy and keeps only safe identities", () => {
  const privateTitle = "PRIVATE_CHAPTER_TITLE_SENTINEL";
  const groups = groupDownloadReviewBlockers([{
    project: "Project",
    chapterKey: source.key,
    stage: "reviewing",
    completionBlockers: [{
      code: "ai_insight_decision_pending",
      chapterKey: source.key,
      targetKind: "insight",
      targetId: insightId,
    }],
    title: privateTitle,
  }]);
  assert.deepEqual(groups, [{
    project: "Project",
    chapterKey: source.key,
    blockers: [
      { code: "ai_insight_decision_pending", targetKind: "insight", targetId: insightId },
      { code: "chapter_not_confirmed", targetKind: "chapter" },
    ],
  }]);
  assert.equal(JSON.stringify(groups).includes(privateTitle), false);
});

test("HTML and ZIP share one blocker preflight before the durable handoff", async () => {
  const workspace = await read("../app/workspace.tsx");
  const aggregation = workspace.slice(workspace.indexOf("const currentDownloadReviewBlockerGroups"), workspace.indexOf("const openDownloadReviewBlocker"));
  const download = workspace.slice(workspace.indexOf("const downloadReviewed"), workspace.indexOf("const ready ="));
  assert.match(aggregation, /storySelection\.chapters\.map/);
  assert.match(aggregation, /chapterReviewCompletionBlockers\(state,completionContext\(chapter\.source\)\)/);
  assert.match(aggregation, /groupDownloadReviewBlockers/);
  assert.ok(download.indexOf("currentDownloadReviewBlockerGroups") < download.indexOf("storyPersistenceRef.current"));
  assert.ok(download.indexOf("if(blockerGroups.length)") < download.indexOf("runDurableStoryReviewHandoff"));
  assert.match(download, /if\(blockerGroups\.length\) \{[\s\S]*setDownloadBlockerGroups\(blockerGroups\);[\s\S]*return;/);
  assert.match(workspace, /downloadReviewed\("\/api\/organization\/export","oxygen-reviewed-story\.html"\)/);
  assert.match(workspace, /downloadReviewed\("\/api\/package","oxygen-contribution\.zip"\)/);
  assert.match(download, /JSON\.stringify\(\{workflowRunId,serverVersion,sourceRevision\}\)/);
  assert.doesNotMatch(download, /blockerGroups[^\n]*JSON\.stringify|reviewedStory|chapterReviews[^\n]*JSON\.stringify/);
});

test("blocker surface groups safe ordinal labels and exposes only focused actions", async () => {
  const workspace = await read("../app/workspace.tsx");
  const surface = workspace.slice(workspace.indexOf("downloadBlockerGroups.length > 0"), workspace.indexOf("workflowOpen &&"));
  assert.match(surface, /role="dialog" aria-modal="true" aria-labelledby="download-review-title"/);
  assert.match(surface, /downloadBlockerGroups\.map\(\(group,groupIndex\) => <section/);
  assert.match(surface, /<h2>\{labels\.chapter\} \{groupIndex\+1\}<\/h2>/);
  assert.match(surface, /group\.blockers\.map[\s\S]*<button className="docCard"/);
  assert.match(surface, /labels\.downloadBlockers\[blocker\.code\]/);
  assert.doesNotMatch(surface, /instruction|beforeText|afterText|original|excerpt|localized|serverVersion|sourceRevision|group\.title/);
  assert.match(workspace, /chapter:"Chapter"/);
  assert.match(workspace, /chapter:"章节"/);
});

test("blocker navigation is activated-only and carries one safe focus identity", async () => {
  const workspace = await read("../app/workspace.tsx");
  const navigation = workspace.slice(workspace.indexOf("const openDownloadReviewBlocker"), workspace.indexOf("const downloadReviewed"));
  assert.match(navigation, /navigationCandidates\.some/);
  assert.match(navigation, /chapter\.project===group\.project && chapter\.story\.key===group\.chapterKey/);
  assert.match(navigation, /setDownloadReviewFocus\(\{/);
  assert.match(navigation, /setStoryNavigation\(\{project:group\.project,storyKey:group\.chapterKey\}\)/);
  assert.doesNotMatch(navigation, /setChapterReviews|setPrivacyDecisions|storyPersistence|serverVersion|sourceRevision/);
});

test("editor focuses an exact Insight or Chapter completion without review mutation", async () => {
  const editor = await read("../app/story-chapter-editor.tsx");
  const focus = editor.slice(editor.indexOf("if (!reviewFocus) return;"), editor.indexOf("const captureSelection"));
  assert.match(focus, /reviewFocus\.targetKind === "insight" && reviewFocus\.targetId/);
  assert.match(focus, /insightRefs\.current\[reviewFocus\.targetId\]/);
  assert.match(focus, /target \|\| completionRef\.current/);
  assert.match(focus, /onReviewFocusHandled\?\.\(\)/);
  assert.doesNotMatch(focus, /onChapterReview|onPrivacyDecision|storyPersistence|fetch\(/);
});

test("actual workspace HTML and ZIP controls block safely, focus exactly, and hand off only when resolved", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  const fetchCalls = [];
  const downloads = [];
  globalThis.fetch = async (url, init = {}) => {
    fetchCalls.push({ url: String(url), init });
    return new Response(new Blob([`download:${url}`]), {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
  };
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "a");
      return {
        href: "",
        download: "",
        click() { downloads.push({ href: this.href, filename: this.download }); },
      };
    },
  };
  URL.createObjectURL = () => "blob:story-download-proof";
  URL.revokeObjectURL = () => {};
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
    delete globalThis.__STORY_UI_TEST_REACT__;
  });

  const blockedFixture = workspaceFixture();
  const blockedRuntime = createHookRuntime();
  let tree = renderWorkspace(blockedRuntime, blockedFixture.props);
  const htmlButton = buttonWithText(tree, "Download HTML");
  const zipButton = buttonWithText(tree, "Download ZIP");
  assert.ok(htmlButton && zipButton, "the real workspace renders both download controls");

  await htmlButton.props.onClick();
  assert.deepEqual(fetchCalls, [], "unresolved HTML preflight must not reach persistence or release");
  tree = renderWorkspace(blockedRuntime, blockedFixture.props);
  let dialog = findNodes(tree, (node) => node.type === "section" && node.props?.role === "dialog")[0];
  assert.ok(dialog, "HTML preflight opens the actual blocker dialog");
  const safeDialogText = nodeText(dialog);
  assert.match(safeDialogText, /Chapter 1/);
  assert.match(safeDialogText, /An AI Insight decision still needs Apply Review/);
  for (const sentinel of Object.values(blockedFixture.privateSentinels)) {
    assert.equal(safeDialogText.includes(sentinel), false, `dialog excludes ${sentinel}`);
  }

  const insightAction = buttonWithText(dialog, "An AI Insight decision still needs Apply Review");
  assert.ok(insightAction);
  insightAction.props.onClick();
  tree = renderWorkspace(blockedRuntime, blockedFixture.props);
  const editorNode = findNodes(tree, (node) => (
    typeof node.type === "function" && node.type.name === "StoryChapterEditor"
  ))[0];
  assert.ok(editorNode, "activating a blocker opens the exact Chapter editor");
  assert.equal(editorNode.props.source.key, blockedFixture.uiSource.key);
  assert.deepEqual(editorNode.props.reviewFocus, {
    chapterKey: blockedFixture.uiSource.key,
    targetKind: "insight",
    targetId: "download-ui-insight",
  });

  const blockedZipButton = buttonWithText(tree, "Download ZIP");
  await blockedZipButton.props.onClick();
  assert.deepEqual(fetchCalls, [], "unresolved ZIP preflight must not reach persistence or release");
  tree = renderWorkspace(blockedRuntime, blockedFixture.props);
  dialog = findNodes(tree, (node) => node.type === "section" && node.props?.role === "dialog")[0];
  assert.ok(dialog, "ZIP uses the same actual blocker dialog");

  const resolvedSource = blockedFixture.uiSource;
  const resolvedBlocks = storyBlocks(resolvedSource);
  const resolvedContext = {
    source: resolvedSource,
    privacyCandidates: [],
    privacyDecisions: {},
    targetCatalog: new Map(),
    evidenceResolved: true,
    supportedAddIds: [],
    supportedEditIds: [],
    sourceBlocks: resolvedBlocks,
    reviewedBlocks: resolvedBlocks,
  };
  let resolvedReview = updateAiInsightDecision(
    emptyChapterReview(resolvedSource), resolvedSource, "download-ui-insight", "accepted",
  );
  resolvedReview = applyChapterReview(resolvedReview, resolvedContext).state;
  resolvedReview = markChapterReady(resolvedReview, resolvedContext);
  assert.deepEqual(chapterReviewCompletionBlockers(resolvedReview, resolvedContext), []);

  const resolvedFixture = workspaceFixture(resolvedReview);
  const resolvedRuntime = createHookRuntime();
  tree = renderWorkspace(resolvedRuntime, resolvedFixture.props);
  const persistenceRef = resolvedRuntime.slots.find((slot) => (
    slot?.current && typeof slot.current.initialize === "function"
  ));
  assert.ok(persistenceRef, "the executed workspace constructed its real persistence queue");
  const initialSession = createStoryReviewSession(
    resolvedFixture.workflowRunId,
    resolvedFixture.props.initialChapterReviews,
    {},
    "2038-08-27T00:00:00.000Z",
  );
  persistenceRef.current.initialize({
    workflowRunId: resolvedFixture.workflowRunId,
    serverVersion: 7,
    sourceRevision: 11,
    session: initialSession,
    persistedAt: "2038-08-27T00:00:00.000Z",
  });
  for (const slot of resolvedRuntime.slots) {
    if (slot && typeof slot === "object" && Object.hasOwn(slot, "current") && slot.current === "") {
      slot.current = resolvedFixture.workflowRunId;
    }
  }

  await buttonWithText(tree, "Download HTML").props.onClick();
  await buttonWithText(tree, "Download ZIP").props.onClick();
  const releaseCalls = fetchCalls.filter(({ url }) => (
    url === "/api/organization/export" || url === "/api/package"
  ));
  assert.deepEqual(releaseCalls.map(({ url }) => url), ["/api/organization/export", "/api/package"]);
  for (const { init } of releaseCalls) {
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(init.body), {
      workflowRunId: resolvedFixture.workflowRunId,
      serverVersion: 7,
      sourceRevision: 11,
    });
  }
  assert.deepEqual(downloads.map(({ filename }) => filename), [
    "oxygen-reviewed-story.html",
    "oxygen-contribution.zip",
  ]);
});
