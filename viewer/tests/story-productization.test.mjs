import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { syntheticStoryEvents, syntheticStoryProject } from "./fixtures/synthetic-story-project.mjs";
import { buildReviewedStoryRelease } from "../lib/story-release.ts";
import { applyChapterReview, emptyChapterReview, markChapterReady } from "../lib/story-review.ts";
import { STORY_PREFIX, parseStoryAnnotation, resolveEvidenceTarget, selectProjectTimeline } from "../lib/timeline.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("a non-Golden synthetic project exercises dynamic Story shapes", () => {
  const milestones = selectProjectTimeline(syntheticStoryEvents);
  assert.equal(syntheticStoryProject.name, "Harbor Sensor Calibration");
  assert.equal(milestones.length, 3);
  assert.equal(new Set(milestones.map((milestone) => milestone.story.phase)).size, 2);
  assert.ok(milestones.every((milestone) => milestone.story.reviewPresentation.en.phase.split(/\s+/).length <= 2));
  assert.ok(milestones.every((milestone) => milestone.story.reviewPresentation.en.story.importantDetails.length === 1));
  assert.deepEqual(milestones[0].story.reviewPresentation.projectSummary, syntheticStoryProject.overview);
  const malformedSummary = JSON.parse(syntheticStoryEvents[0].summary.slice(STORY_PREFIX.length));
  malformedSummary.reviewPresentation.projectSummary = null;
  assert.equal(parseStoryAnnotation(STORY_PREFIX + JSON.stringify(malformedSummary)), null);
  assert.deepEqual(milestones.map((milestone) => milestone.story.reviewPresentation.en.people.length), [1, 2, 0]);
  assert.deepEqual(milestones.map((milestone) => milestone.story.reviewPresentation.en.privacy.candidates.length), [0, 1, 1]);
  assert.ok(milestones.every((milestone) => milestone.story.reviewPresentation.en.highlights.length === 1));
  assert.ok(milestones.every((milestone) => milestone.story.reviewPresentation.zh.highlights.length === 1));
  assert.deepEqual(milestones.map((milestone) => milestone.story.evidence.primary.eventId), [
    "synthetic-evidence-alpha", "synthetic-evidence-beta", "synthetic-evidence-gamma",
  ]);

  const reviewedItems = syntheticStoryEvents.map((event) => ({ id: `${event.document_id}:${event.id}` }));
  for (const milestone of milestones) {
    assert.equal(resolveEvidenceTarget(reviewedItems, milestone.story.evidence.primary.eventId).status, "resolved");
  }
});

test("the reusable narrative contract separates a scan-first homepage from evidence-driven Chapter memory", async () => {
  const [product, data, bilingual, validation, narrative, lifecycle, interaction] = await Promise.all([
    read("../../skills/oxygen-storytelling-review/references/product-contract.md"),
    read("../../skills/oxygen-storytelling-review/references/story-data-contract.md"),
    read("../../skills/oxygen-storytelling-review/references/bilingual-contract.md"),
    read("../../skills/oxygen-storytelling-review/references/validation-checklist.md"),
    read("../../skills/oxygen-storytelling-review/references/narrative-writing-contract.md"),
    read("../../skills/oxygen-storytelling-review/references/chapter-review-lifecycle.md"),
    read("../../skills/oxygen-storytelling-review/references/ui-interaction-contract.md"),
  ]);
  for (const contract of [
    "Every reviewed historical record", "2–3 concise sentences", "one or two scannable English words",
    "Rich context without fictionalization", "durable project memory for humans and future Agents",
    "problem,", "constraints", "rejected approaches", "private[\\s\\n]+latent model reasoning",
  ]) assert.match(product, new RegExp(contract));
  assert.match(data, /canonical narrative-compression and voice rules/);
  assert.match(data, /context-sufficient coherent article/);
  assert.match(data, /passage context for every Story-content block/);
  assert.match(data, /A missing map, missing key, or extra key[\s\S]*no valid empty or silent fallback/);
  assert.match(bilingual, /same start, turn, and current boundary/);
  assert.match(bilingual, /Chapter depth remains semantically equivalent/);
  assert.match(validation, /visible copy compresses routine history/);
  assert.match(validation, /## Workflow progress/);
  for (const contract of ["Background", "Evidence thread", "The turn", "Direct learning", "Reusable principle", "Open tension", "Show the conflict, the turn, the result, and the reusable principle"]) {
    assert.match(narrative, new RegExp(contract));
  }
  assert.match(narrative, /three to five concise sentences/);
  assert.match(narrative, /exactly one reviewable canonical Insight/);
  assert.match(lifecycle, /## Direct-edit transaction model/);
  assert.match(lifecycle, /Direct editing is the primary current lifecycle/);
  assert.match(lifecycle, /pending or needs evidence[\s\S]*paired locale is stale[\s\S]*evidence\/ledger provenance fails validation/);
  assert.match(lifecycle, /Undo marks the most recently changed active-locale pending transaction reverted/);
  assert.match(interaction, /current\/total position plus[\s\S]*Previous\/Next controls/);
  assert.match(validation, /## Direct Story editing/);
  assert.doesNotMatch([product, data, bilingual, validation, narrative, lifecycle, interaction].join("\n"), /BOM Sourcing Benchmark|127\.0\.0\.1:326[14]/);

  const sentences = syntheticStoryProject.overview.en.match(/[^.!?]+[.!?]+/g) || [];
  assert.ok(sentences.length >= 2 && sentences.length <= 3);
});

test("the synthetic project completes through the shared review and release runtime", () => {
  const milestones = selectProjectTimeline(syntheticStoryEvents);
  const reviews = {};
  for (const milestone of milestones) {
    const presentation = milestone.story.reviewPresentation.en;
    const privacyDecisions = Object.fromEntries(presentation.privacy.candidates.map((candidate) => [
      candidate.id,
      candidate.id === "removed-demo-metric" ? "redact" : "keep",
    ]));
    const context = {
      storyKey: milestone.story.key,
      privacyCandidates: presentation.privacy.candidates,
      privacyDecisions,
      reviewableInsightIds: presentation.highlights.map((highlight) => highlight.id),
      chapterEvidence: [milestone.story.evidence.primary],
      evidenceResolved: true,
      supportedAddIds: [],
      sourceBlocks: { en: {}, zh: {} },
      reviewedBlocks: { en: {}, zh: {} },
    };
    let review = applyChapterReview(emptyChapterReview(), context).state;
    review = markChapterReady(review, context);
    assert.equal(review.stage, "human_confirmed");
    assert.equal(review.publicationApproved, false);
    reviews[milestone.story.key] = review;
  }

  const release = buildReviewedStoryRelease(milestones, reviews);
  assert.equal(release.publication_approved, false);
  assert.equal(release.chapters.length, 3);
  assert.equal(release.chapters[1].en.people.length, 2);
  assert.deepEqual(release.chapters[2].en.story.importantDetails, []);
  assert.doesNotMatch(JSON.stringify(release), /Synthetic dock code|synthetic-reviewed-document|synthetic-evidence-/);
});

test("the normal workflow delegates to the canonical repository Story runtime", async () => {
  const [agents, sop, organizer, skill, workspace, editor] = await Promise.all([
    read("../../AGENTS.md"),
    read("../../SOP.md"),
    read("../../skills/oxygen-organize-review-export/SKILL.md"),
    read("../../skills/oxygen-storytelling-review/SKILL.md"),
    read("../app/workspace.tsx"),
    read("../app/story-chapter-editor.tsx"),
  ]);
  assert.match(agents, /delegate Project[\s\S]*skills\/oxygen-storytelling-review\/SKILL\.md/);
  assert.match(sop, /Prepare Storytelling Review[\s\S]*skills\/oxygen-storytelling-review\/SKILL\.md/);
  assert.match(organizer, /Delegate Storytelling after the reviewed boundary/);
  assert.match(organizer, /does not need to know or manually name the delegated Skill/);
  assert.match(agents, /sanitized stage\/state/);
  assert.match(sop, /workflow-progress surface/);
  assert.match(organizer, /Never expose chain-of-thought/);
  assert.match(skill, /Canonical Toolkit runtime/);
  assert.match(skill, /viewer\/app\/workspace\.tsx[\s\S]*InlineWorkspace/);
  assert.match(skill, /viewer\/app\/story-chapter-editor\.tsx[\s\S]*StoryChapterEditor/);
  assert.match(skill, /passage-context/);
  assert.match(skill, /narrative-writing-contract\.md/);
  assert.match(skill, /Direct typing, caret insertion, selection replacement\/deletion/);
  assert.match(skill, /human direct edits and\/or compatible legacy review records/);
  assert.match(skill, /completely fresh, contextless Agent[\s\S]*normal public Oxygen workflow request/);
  assert.match(skill, /Missing or unsupported context makes that Chapter[\s\S]*incomplete/);
  assert.match(skill, /private latent reasoning/);
  assert.match(workspace, /export function InlineWorkspace/);
  assert.match(editor, /export function StoryChapterEditor/);
  for (const contract of ["storyOrientation", "storyCanvasGrid", "phaseHeading", "milestoneList", "transition", "phaseDirectory"]) {
    assert.match(workspace, new RegExp(contract));
  }
  assert.doesNotMatch(workspace, /storyTimelineLayout|timelineEvent|timelineBody/);
  await access(new URL("../../skills/oxygen-storytelling-review/SKILL.md", import.meta.url));

  const reusableSource = [skill, workspace, editor].join("\n");
  assert.doesNotMatch(reusableSource, /BOM Sourcing Benchmark|127\.0\.0\.1:3264|13 meaningful milestones|14 meaningful milestones|34 source records/);
});
