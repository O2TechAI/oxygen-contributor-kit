import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import {
  dynamicStoryEvidenceItems,
  dynamicStoryEvents,
  dynamicStoryProject,
  dynamicStorySources,
} from "./fixtures/story-dynamic-project.mjs";
import {
  applyChapterReview,
  emptyChapterReview,
  markChapterReady,
  storyBlocks,
  updateAiInsightDecision,
} from "../lib/story-review.ts";
import {
  REVIEWED_STORY_SCHEMA,
  buildReviewedStoryRelease,
  reviewedStoryPackageEntry,
  sanitizeReviewedStoryRelease,
  serializeReviewedStoryRelease,
} from "../lib/story-release.ts";
import { selectViewerChapters } from "../lib/story-readiness.ts";
import { parseStorySource, resolveEvidenceTarget, timelinePresentation } from "../lib/timeline.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

function reviewContext(source) {
  const blocks = storyBlocks(source);
  return {
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
}

test("a non-Golden synthetic project exercises dynamic final Story shapes", () => {
  const selection = selectViewerChapters(dynamicStoryEvents, "Fallback project");
  assert.equal(dynamicStoryProject.name, "Harbor Sensor Calibration");
  assert.equal(selection.invalid, false);
  assert.equal(selection.chapters.length, 3);
  assert.deepEqual(selection.chapters.map((chapter) => chapter.project), Array(3).fill(dynamicStoryProject.name));
  assert.deepEqual(selection.chapters.map((chapter) => chapter.source.insights.length), [0, 1, 2]);
  assert.deepEqual(selection.chapters.map((chapter) => chapter.source.story.blocks.length), [1, 2, 2]);
  assert.deepEqual(selection.chapters.map((chapter) => chapter.source.people.length), [1, 2, 1]);
  assert.equal(new Set(selection.chapters.map((chapter) => chapter.source.phase.id)).size, 2);
  assert.deepEqual(selection.chapters.map((chapter) => timelinePresentation(chapter.source).marker), [undefined, "ai_insight", "ai_insight"]);
  assert.ok(dynamicStoryEvents.every((event) => parseStorySource(event.summary)));

  for (const source of dynamicStorySources) {
    assert.equal(resolveEvidenceTarget(dynamicStoryEvidenceItems, source.evidence.primary.eventId).status, "resolved");
  }
});

test("the dynamic source completes through review and deterministic release packaging", () => {
  const reviews = {};
  for (const source of dynamicStorySources) {
    const context = reviewContext(source);
    let state = emptyChapterReview(source);
    for (const insight of source.insights) {
      state = updateAiInsightDecision(state, source, insight.id, "accepted");
    }
    const applied = applyChapterReview(state, context);
    assert.equal(applied.blockedReason, undefined);
    state = markChapterReady(applied.state, context);
    assert.equal(state.stage, "human_confirmed");
    assert.equal(state.publicationApproved, false);
    reviews[source.key] = state;
  }

  const release = buildReviewedStoryRelease(dynamicStorySources, reviews);
  assert.equal(release.schema, REVIEWED_STORY_SCHEMA);
  assert.equal(release.publication_approved, false);
  assert.equal(release.chapters.length, 3);
  assert.deepEqual(release.chapters.map((chapter) => chapter.en.story.blocks
    .reduce((total, block) => total + block.insights.length, 0)), [0, 1, 2]);
  assert.equal(JSON.stringify(release).includes("documentId"), false);
  assert.equal(JSON.stringify(release).includes("eventId"), false);

  const serialized = serializeReviewedStoryRelease(release);
  assert.ok(serialized);
  assert.deepEqual(sanitizeReviewedStoryRelease(JSON.parse(serialized)), release);
  assert.deepEqual(reviewedStoryPackageEntry(release), {
    name: "story/reviewed-project-story.json",
    data: serialized,
  });
});

test("the Story Skill Routed References table keeps stage-local links and gates", async () => {
  const skill = await read("../../skills/oxygen-storytelling-review/SKILL.md");
  const routing = skill.match(/## Routed References([\s\S]*?)## Final Public Flow/)?.[1];
  assert.ok(routing);

  const rows = new Map(
    routing.split("\n").filter((line) => /^\| [^|-]/.test(line)).map((line) => {
      const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
      return [cells[0], { load: cells[1], gate: cells[2] }];
    }),
  );
  const build = rows.get("Build Story") ?? { load: "", gate: "" };
  for (const reference of [
    "product-contract.md",
    "story-data-contract.md",
    "privacy-evidence-boundary.md",
    "narrative-writing-contract.md",
  ]) assert.match(build.load, new RegExp(reference.replace(".", "\\.")));
  for (const deferred of [
    "validation-checklist.md",
    "ui-interaction-contract.md",
    "chapter-review-lifecycle.md",
    "bilingual-contract.md",
  ]) assert.doesNotMatch(build.load, new RegExp(deferred.replace(".", "\\.")));
  assert.match(build.gate, /oxygen\.story:/);
  assert.match(build.gate, /schema: "oxygen\.story"/);

  const human = rows.get("Human review") ?? { load: "", gate: "" };
  assert.match(human.load, /chapter-review-lifecycle\.md/);
  assert.match(human.load, /ui-interaction-contract\.md/);
  assert.match(human.gate, /Apply review, All set, and release are separate human gates/);
  assert.match(rows.get("Localization present")?.load ?? "", /bilingual-contract\.md/);
  assert.match(rows.get("Final acceptance")?.load ?? "", /validation-checklist\.md/);
  assert.match(rows.get("Final acceptance")?.gate ?? "", /deterministic, build, browser, clean-room, and residual-scan gates/);
});

test("public AGENTS, SOP, and organizer entrypoints delegate to the repository Story runtime", async () => {
  const [agents, sop, organizer, skill, workspace, editor] = await Promise.all([
    read("../../AGENTS.md"),
    read("../../SOP.md"),
    read("../../skills/oxygen-organize-review-export/SKILL.md"),
    read("../../skills/oxygen-storytelling-review/SKILL.md"),
    read("../app/workspace.tsx"),
    read("../app/story-chapter-editor.tsx"),
  ]);
  assert.match(agents, /Build Project Story[\s\S]*delegate to `skills\/oxygen-storytelling-review\/SKILL\.md`/);
  assert.match(sop, /Build Project Story and Review Story[\s\S]*skills\/oxygen-storytelling-review\/SKILL\.md/);
  assert.match(sop, /workflow-progress surface/);
  assert.match(organizer, /Delegate Storytelling after the reviewed boundary/);
  assert.match(organizer, /does not need to know or manually name the delegated Skill/);
  assert.match(organizer, /Never expose chain-of-thought/);
  assert.match(skill, /Activation revalidates the exact source package, semantic manifest, coverage manifest, source revision, and active digest/);
  assert.match(skill, /storySourceSchema: "oxygen\.story"[\s\S]*storySessionSchema: "oxygen\.story-review-session"/);
  assert.match(skill, /narrative-writing-contract\.md/);
  assert.match(skill, /fresh contributor Agent can execute the public workflow/);
  assert.match(workspace, /export function InlineWorkspace/);
  assert.match(editor, /export function StoryChapterEditor/);
  assert.match(editor, /normalizeDirectBeforeInput[\s\S]*deriveDirectStoryMutation/);
  assert.match(editor, /onCompositionStart[\s\S]*onCompositionEnd/);
  assert.match(workspace, /storyOrientation/);
  assert.match(workspace, /storyCanvasGrid/);
  assert.match(workspace, /storyChapterList/);
  assert.match(workspace, /transition/);
  assert.match(workspace, /phaseDirectory/);
  await access(new URL("../../skills/oxygen-storytelling-review/SKILL.md", import.meta.url));
});
