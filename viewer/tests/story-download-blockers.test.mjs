import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  applyChapterReview,
  chapterReviewCompletionBlockers,
  emptyChapterReview,
  markChapterReady,
  updateInsightReview,
} from "../lib/story-review.ts";
import { groupDownloadReviewBlockers } from "../lib/story-navigation.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const insightId = "safe-insight";
const sourceBlocks = { en:{ scene:"Safe source." }, zh:{} };
const completionContext = {
  storyKey:"chapter-one",
  privacyCandidates:[],
  privacyDecisions:{},
  targetCatalog:new Map([
    ["scene",{ target:"scene",kind:"scalar",field:"scene" }],
    [`insight:${insightId}`,{ target:`insight:${insightId}`,kind:"insight",id:insightId }],
  ]),
  reviewableInsightIds:[insightId],
  sourceBlocks,
  reviewedBlocks:sourceBlocks,
};
const applyContext = {
  ...completionContext,
  chapterEvidence:[{ documentId:"doc",eventId:"event" }],
  evidenceResolved:true,
  supportedAddIds:[],
  supportedEditIds:[],
};

test("download aggregation preserves current completion semantics and adds only the release-stage blocker", () => {
  const applied=applyChapterReview(emptyChapterReview(),applyContext).state;
  const confirmed=markChapterReady(applied,completionContext);
  assert.deepEqual(confirmed.insightReviews,{});
  assert.deepEqual(chapterReviewCompletionBlockers(confirmed,completionContext),[]);
  assert.deepEqual(groupDownloadReviewBlockers([{
    project:"Project",chapterKey:"chapter-one",stage:confirmed.stage,completionBlockers:[],
  }]),[]);

  const revisionReady=groupDownloadReviewBlockers([{
    project:"Project",chapterKey:"chapter-one",stage:"revision_ready",completionBlockers:[],
  }]);
  assert.deepEqual(revisionReady[0].blockers,[{code:"chapter_not_confirmed",targetKind:"chapter"}]);

  const pending=updateInsightReview(applied,insightId,"en",{status:"accepted",text:"Safe Insight"});
  const completionBlockers=chapterReviewCompletionBlockers(pending,completionContext);
  assert.deepEqual(completionBlockers,[{
    code:"insight_pending",chapterKey:"chapter-one",targetKind:"insight",targetId:insightId,
  }]);
  assert.deepEqual(groupDownloadReviewBlockers([{
    project:"Project",chapterKey:"chapter-one",stage:pending.stage,completionBlockers,
  }])[0].blockers,[
    {code:"insight_pending",targetKind:"insight",targetId:insightId},
    {code:"chapter_not_confirmed",targetKind:"chapter"},
  ]);
});

test("malformed review state collapses to safe generic blocker data", () => {
  const applied=applyChapterReview(emptyChapterReview(),applyContext).state;
  const malformed={...applied,annotations:[{instruction:"PRIVATE_REJECTED_COPY"}]};
  const completionBlockers=chapterReviewCompletionBlockers(malformed,completionContext);
  assert.deepEqual(completionBlockers,[{
    code:"review_state_invalid",chapterKey:"chapter-one",targetKind:"chapter",
  }]);
  const serialized=JSON.stringify(groupDownloadReviewBlockers([{
    project:"Project",chapterKey:"chapter-one",stage:"reviewing",completionBlockers,
  }]));
  assert.equal(serialized.includes("PRIVATE_REJECTED_COPY"),false);
});

test("Privacy-redacted Chapter title never enters blocker presentation or rendered copy", async () => {
  const privateTitle="PRIVATE_CHAPTER_TITLE_SENTINEL";
  const syntheticChapter={project:"Project",chapterKey:"chapter-one",presentation:{title:privateTitle}};
  const privateSourceBlocks={en:{title:syntheticChapter.presentation.title,scene:"Safe source."},zh:{}};
  const privacyCandidate={
    id:"private-title",title:"Synthetic candidate",explanation:"Synthetic",recommendation:"redact",
    releaseTargets:["title"],original:{availability:"unavailable"},whyFlagged:"Synthetic",
  };
  const privateContext={
    ...completionContext,
    privacyCandidates:[privacyCandidate],
    privacyDecisions:{"private-title":"redact"},
    targetCatalog:new Map([
      ["title",{target:"title",kind:"scalar",field:"title"}],
      ["scene",{target:"scene",kind:"scalar",field:"scene"}],
      [`insight:${insightId}`,{target:`insight:${insightId}`,kind:"insight",id:insightId}],
    ]),
    sourceBlocks:privateSourceBlocks,
    reviewedBlocks:privateSourceBlocks,
  };
  const applied=applyChapterReview(emptyChapterReview(),{
    ...privateContext,chapterEvidence:[{documentId:"doc",eventId:"event"}],evidenceResolved:true,
    supportedAddIds:[],supportedEditIds:[],
  }).state;
  assert.deepEqual(applied.redactedBlocks,["title"]);
  const completionBlockers=chapterReviewCompletionBlockers(applied,{
    ...privateContext,reviewedBlocks:{en:{title:"",scene:"Safe source."},zh:{}},
  });
  const groups=groupDownloadReviewBlockers([{
    project:syntheticChapter.project,chapterKey:syntheticChapter.chapterKey,stage:applied.stage,completionBlockers,
  }]);
  assert.equal(groups[0].chapterKey,syntheticChapter.chapterKey);
  assert.deepEqual(groups[0].blockers,[{code:"chapter_not_confirmed",targetKind:"chapter"}]);
  assert.equal(JSON.stringify(groups).includes(privateTitle),false);
  assert.equal(Object.hasOwn(groups[0],"title"),false);

  const workspace=await read("../app/workspace.tsx");
  const aggregation=workspace.slice(workspace.indexOf("const currentDownloadReviewBlockerGroups"),workspace.indexOf("const openDownloadReviewBlocker"));
  const surface=workspace.slice(workspace.indexOf("downloadBlockerGroups.length > 0"),workspace.indexOf("workflowOpen &&"));
  const navigation=workspace.slice(workspace.indexOf("const openDownloadReviewBlocker"),workspace.indexOf("const downloadReviewed"));
  assert.doesNotMatch(aggregation,/title:presentation|milestone\.story\.title/);
  assert.match(surface,/downloadBlockerGroups\.map\(\(group,groupIndex\)/);
  assert.match(surface,/<h2>\{labels\.chapter\} \{groupIndex\+1\}<\/h2>/);
  assert.doesNotMatch(surface,/group\.title|presentation\.title|story\.title/);
  assert.match(surface,/labels\.downloadBlockers\[blocker\.code\]/);
  assert.match(workspace,/chapter:"Chapter"/);
  assert.match(workspace,/chapter:"章节"/);
  assert.match(navigation,/setStoryNavigation\(\{project:group\.project,storyKey:group\.chapterKey\}\)/);
  assert.equal(surface.includes(privateTitle),false);
});

test("HTML and ZIP share one blocker preflight before the unchanged durable handoff", async () => {
  const workspace=await read("../app/workspace.tsx");
  const aggregation=workspace.slice(workspace.indexOf("const currentDownloadReviewBlockerGroups"),workspace.indexOf("const openDownloadReviewBlocker"));
  const download=workspace.slice(workspace.indexOf("const downloadReviewed"),workspace.indexOf("const ready ="));
  assert.match(aggregation,/activatedStoryHighlights\.map/);
  assert.match(aggregation,/chapterReviewCompletionBlockers\(state/);
  assert.match(aggregation,/groupDownloadReviewBlockers/);
  assert.ok(download.indexOf("currentDownloadReviewBlockerGroups") < download.indexOf("storyPersistenceRef.current"));
  assert.ok(download.indexOf("if(blockerGroups.length)") < download.indexOf("runDurableStoryReviewHandoff"));
  assert.match(download,/if\(blockerGroups\.length\) \{[\s\S]*setDownloadBlockerGroups\(blockerGroups\);[\s\S]*return;/);
  assert.match(workspace,/downloadReviewed\("\/api\/organization\/export","oxygen-reviewed-story\.html"\)/);
  assert.match(workspace,/downloadReviewed\("\/api\/package","oxygen-contribution\.zip"\)/);
  assert.match(download,/JSON\.stringify\(\{workflowRunId,serverVersion,sourceRevision\}\)/);
  assert.doesNotMatch(download,/blockerGroups[^\n]*JSON\.stringify|reviewedStory|chapterReviews[^\n]*JSON\.stringify/);
});

test("blocker surface groups safe ordinal labels by Chapter and exposes only buttons", async () => {
  const workspace=await read("../app/workspace.tsx");
  const surface=workspace.slice(workspace.indexOf("downloadBlockerGroups.length > 0"),workspace.indexOf("workflowOpen &&"));
  assert.match(surface,/role="dialog" aria-modal="true" aria-labelledby="download-review-title"/);
  assert.match(surface,/downloadBlockerGroups\.map\(\(group,groupIndex\) => <section/);
  assert.match(surface,/<h2>\{labels\.chapter\} \{groupIndex\+1\}<\/h2>/);
  assert.match(surface,/group\.blockers\.map[\s\S]*<button className="docCard"/);
  assert.match(surface,/labels\.downloadBlockers\[blocker\.code\]/);
  assert.doesNotMatch(surface,/instruction|beforeText|afterText|original|excerpt|localized|serverVersion|sourceRevision/);
});

test("blocker navigation stays activated-only and carries one presentation-only focus intent", async () => {
  const workspace=await read("../app/workspace.tsx");
  const navigation=workspace.slice(workspace.indexOf("const openDownloadReviewBlocker"),workspace.indexOf("const downloadReviewed"));
  assert.match(navigation,/activatedStoryHighlights\.some/);
  assert.match(navigation,/milestone\.project===group\.project && milestone\.story\.key===group\.chapterKey/);
  assert.match(navigation,/setDownloadReviewFocus\(\{/);
  assert.match(navigation,/setStoryNavigation\(\{project:group\.project,storyKey:group\.chapterKey\}\)/);
  assert.doesNotMatch(navigation,/setChapterReviews|setPrivacyDecisions|storyPersistence|serverVersion|sourceRevision/);
});

test("editor focuses exact safe targets once and falls back to Chapter completion without review mutation", async () => {
  const editor=await read("../app/story-chapter-editor.tsx");
  const focus=editor.slice(editor.indexOf("if (!reviewFocus ||"),editor.indexOf("const candidates ="));
  assert.match(focus,/\[data-annotation-note\],\[data-edit-note\]/);
  assert.match(focus,/\[data-story-block\]/);
  assert.match(focus,/\[data-canonical-insight\]/);
  assert.match(focus,/disclosure\.open = true/);
  assert.match(focus,/\[data-chapter-completion\]/);
  assert.match(focus,/onReviewFocusHandled\?\.\(\)/);
  assert.doesNotMatch(focus,/onChapterReview|onPrivacyDecision|updateInsightReview|storyPersistence|fetch\(/);
  assert.match(editor,/const insightSuppressed = chapterReview\.redactedBlocks\.includes\(`insight:\$\{visibleHighlight\.id\}`\);/);
  assert.match(editor,/const canonicalInsightDisclosure = !insightSuppressed \?/);
});
