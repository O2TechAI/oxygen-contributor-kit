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

test("the reusable narrative contract separates full-history derivation from concise copy", async () => {
  const [product, data, bilingual, validation] = await Promise.all([
    read("../../skills/oxygen-storytelling-review/references/product-contract.md"),
    read("../../skills/oxygen-storytelling-review/references/story-data-contract.md"),
    read("../../skills/oxygen-storytelling-review/references/bilingual-contract.md"),
    read("../../skills/oxygen-storytelling-review/references/validation-checklist.md"),
  ]);
  for (const contract of [
    "Every reviewed historical record", "2–3 concise sentences", "one or two scannable English words",
    "Narrative coherence without fictionalization", "What mattered is normally one concise sentence",
    "one or two short, project-specific sentences",
  ]) assert.match(product, new RegExp(contract));
  assert.match(data, /canonical narrative-compression and voice rules/);
  assert.match(bilingual, /same start, turn, and current boundary/);
  assert.match(validation, /visible copy compresses routine history/);
  assert.doesNotMatch([product, data, bilingual, validation].join("\n"), /BOM Sourcing Benchmark|127\.0\.0\.1:326[14]/);

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
  assert.match(skill, /Canonical Toolkit runtime/);
  assert.match(skill, /viewer\/app\/workspace\.tsx[\s\S]*InlineWorkspace/);
  assert.match(skill, /viewer\/app\/story-chapter-editor\.tsx[\s\S]*StoryChapterEditor/);
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
