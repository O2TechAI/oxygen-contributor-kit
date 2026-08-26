import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { STORY_PREFIX, parseStoryAnnotation } from "../lib/timeline.ts";
import { storyFirstSemanticCases } from "./fixtures/story-first-semantic-cases.mjs";
import {
  storyFirstSemanticExpectations,
  successorLifecycleCases,
} from "./fixtures/story-first-semantic-expectations.mjs";

const genericPhaseLabels = new Set(["project evolution", "general work", "other", "later stage"]);
const insightMeanings = ["background", "quote", "directlyAcquiredExperience", "principle"];
const evaluatorOnlyKeys = [
  "required_story_context",
  "required_failure",
  "required_transition",
  "required_current_boundary",
  "eligible_insight_moment",
  "must_not_insight",
  "routine_noise",
  "required_role_relation",
  "unsupported_relationship",
];

function allChapters() {
  return storyFirstSemanticExpectations.flatMap((fixture) => fixture.chapters);
}

function allInsights() {
  return allChapters().flatMap((chapter) => chapter.insights);
}

function currentRuntimeProbe(highlights) {
  const presentation = {
    phase: "Validation",
    title: "A supported synthetic turn",
    timelineSummary: "Synthetic evidence changed the test.",
    before: "The test used an unchecked assumption.",
    after: "The assumption became a checked boundary.",
    timelineChips: ["1 synthetic check"],
    overview: "CURRENT-PROBE explains how synthetic evidence changed the test.",
    people: [{
      id: "probe-reviewer",
      releaseLabel: "A",
      role: "Reviewer",
      description: "Checked the synthetic boundary.",
      localIdentityState: "not_identified",
      evidence: [{ documentId: "probe-document", eventId: "probe-event" }],
    }],
    story: {
      scene: "The reviewer checked a synthetic boundary.",
      reconstruction: ["The check exposed an unsupported assumption."],
      importantDetails: ["The result changed the next test."],
      decisionOutcome: "The next test used the checked boundary.",
    },
    passageContext: {
      scene: { whatWasHappening: "A boundary was under review.", whyItMattered: "The test depended on it." },
      "reconstruction-0": { whatWasHappening: "The assumption was checked.", whyItMattered: "The check changed the plan." },
      "detail-0": { whatWasHappening: "The result changed the next test.", whyItMattered: "The next action became evidence-bound." },
      outcome: { whatWasHappening: "The checked boundary was used.", whyItMattered: "The test no longer depended on the unsupported assumption." },
    },
    highlights,
    privacy: { summary: "No synthetic candidates.", candidates: [] },
  };
  return STORY_PREFIX + JSON.stringify({
    schema: "oxygen.story-highlight/2",
    key: "current-cardinality-probe",
    phase: "Validation",
    kind: "validation",
    title: "A supported synthetic turn",
    timelineSummary: "Synthetic evidence changed the test.",
    whyThisMatters: "The checked boundary changed the next test.",
    before: "The test used an unchecked assumption.",
    after: "The assumption became a checked boundary.",
    importance: 2,
    releaseEpisode: {
      readingTimeMinutes: 1,
      scene: presentation.story.scene,
      reconstruction: presentation.story.reconstruction,
      importantDetails: presentation.story.importantDetails,
      decisionOutcome: presentation.story.decisionOutcome,
      compression: {
        sourceScope: "One safe synthetic event",
        retained: ["Decision"],
        omittedLowValue: ["Repeated status"],
        omittedSensitive: [],
        rewriteBrief: "Preserve supported synthetic meaning.",
      },
    },
    insight: { proposal: "Check the boundary.", rationale: "The evidence changed the test.", reviewState: "ai_proposed" },
    evidence: { primary: { documentId: "probe-document", eventId: "probe-event" }, supporting: [] },
    sourceVersion: { defaultView: "release", originalState: "local_evidence_only", releaseState: "ai_prepared_draft", note: "Synthetic evidence stays local." },
    privacyReview: { state: "reviewed_release", note: "Safe synthetic boundary." },
    reviewPresentation: { en: presentation, semanticAnchors: ["CURRENT-PROBE"] },
  });
}

const currentInsight = (id) => ({
  id,
  title: "Checked boundary",
  noticed: "A synthetic check exposed an unsupported assumption.",
  lesson: "Check the relevant boundary before relying on the result.",
});

test("the corpus contains exactly the approved eight stable-ID quality cases", () => {
  assert.equal(storyFirstSemanticCases.length, 8);
  assert.equal(storyFirstSemanticExpectations.length, 8);
  const caseIds = storyFirstSemanticCases.map((fixture) => fixture.id);
  assert.equal(new Set(caseIds).size, 8);
  assert.deepEqual(storyFirstSemanticExpectations.map((fixture) => fixture.caseId), caseIds);
  assert.ok(storyFirstSemanticCases.every((fixture) => fixture.input.caseId === fixture.id));
  assert.ok(storyFirstSemanticCases.every((fixture) => fixture.input.records.every((item) => item.id && item.actorId)));
});

test("evaluator-only expectations are structurally isolated from model-visible data", async () => {
  const modelVisibleSource = await readFile(fileURLToPath(new URL("./fixtures/story-first-semantic-cases.mjs", import.meta.url)), "utf8");
  assert.doesNotMatch(modelVisibleSource, /semantic-expectations/);
  for (const key of evaluatorOnlyKeys) assert.doesNotMatch(modelVisibleSource, new RegExp(key));
  assert.ok(evaluatorOnlyKeys.some((key) => Object.hasOwn(storyFirstSemanticExpectations[0], key)));
});

test("every target Chapter has supported People and a derived Phase group", () => {
  for (const fixture of storyFirstSemanticExpectations) {
    assert.equal(fixture.chaptersDerivedBeforePhases, true);
    const phaseIds = new Set(fixture.phases.map((phase) => phase.id));
    for (const chapterItem of fixture.chapters) {
      assert.ok(chapterItem.people.length > 0, chapterItem.id);
      assert.ok(chapterItem.people.every((personItem) => personItem.id && personItem.recordIds.length > 0), chapterItem.id);
      assert.ok(phaseIds.has(chapterItem.phaseId), chapterItem.id);
      const phase = fixture.phases.find((item) => item.id === chapterItem.phaseId);
      assert.ok(phase.chapterIds.includes(chapterItem.id), chapterItem.id);
    }
  }
});

test("Phase labels are precise one or two word groups derived after Chapter boundaries", () => {
  const phases = storyFirstSemanticExpectations.flatMap((fixture) => fixture.phases);
  assert.ok(phases.every((phase) => phase.label.trim().split(/\s+/).length <= 2));
  assert.ok(phases.every((phase) => !genericPhaseLabels.has(phase.label.toLowerCase())));
  const mundane = storyFirstSemanticExpectations.find((fixture) => fixture.caseId === "mundane-setup");
  assert.deepEqual(mundane.phases[0].chapterIds, ["chapter-setup-install", "chapter-setup-diagnosis"]);
  assert.equal(mundane.phases[1].label, "Recovery");
});

test("the target corpus represents valid zero, one, and multiple sparse Insights", () => {
  const counts = new Map(storyFirstSemanticExpectations.map((fixture) => [
    fixture.caseId,
    fixture.chapters.reduce((total, chapterItem) => total + chapterItem.insights.length, 0),
  ]));
  assert.equal(counts.get("zero-insights"), 0);
  assert.equal(counts.get("one-insight"), 1);
  assert.ok(counts.get("multiple-sparse-insights") > 1);
  assert.equal(storyFirstSemanticExpectations.find((fixture) => fixture.caseId === "zero-insights").zeroSourceState, "no_insight_generated");
});

test("every target Insight carries the four frozen meanings and safe Story grounding", () => {
  for (const item of allInsights()) {
    assert.deepEqual(Object.keys(item).filter((key) => insightMeanings.includes(key)), insightMeanings);
    assert.ok(item.background.storyBlockIds.length > 0);
    assert.equal(item.quote.source, "safe_reviewed_story");
    assert.ok(item.quote.storyBlockIds.length > 0);
    assert.equal(item.directlyAcquiredExperience.generalModelKnowledgeAllowed, false);
    assert.equal(item.principle.genericSloganAllowed, false);
    assert.ok(item.principle.requiredCondition && item.principle.requiredResponse && item.principle.boundedReason);
  }
});

test("no fixture requires per-block assistance or fake placeholder Insights", () => {
  const encoded = JSON.stringify(storyFirstSemanticExpectations);
  assert.doesNotMatch(encoded, /passageContext|whatWeLearned|reusableLesson/);
  const zero = storyFirstSemanticExpectations.find((fixture) => fixture.caseId === "zero-insights");
  assert.deepEqual(zero.chapters[0].insights, []);
});

test("AI lifecycle requires explicit current-version terminal resolution", () => {
  const byId = new Map(successorLifecycleCases.map((item) => [item.id, item]));
  assert.equal(byId.get("ai-pending").expectedChapterState, "incomplete");
  assert.equal(byId.get("ai-accepted").expectedInsightState, "resolved_approved");
  assert.equal(byId.get("ai-rejected").expectedInsightState, "resolved_not_preserved");
  assert.equal(byId.get("ai-edited-after-approval").expectedChapterState, "incomplete");
  assert.notEqual(byId.get("ai-edited-after-approval").insightVersions[0].version, byId.get("ai-edited-after-approval").insightVersions[0].reviewedVersion);
  assert.equal(byId.get("zero-source-insights").expectedResolutionObligations, 0);
  assert.equal(byId.get("multiple-one-pending").expectedChapterState, "incomplete");
});

test("human Add Insight uses a valid safe Story anchor and Save is human-approved", () => {
  const byId = new Map(successorLifecycleCases.map((item) => [item.id, item]));
  const add = byId.get("human-add-valid-anchor");
  assert.equal(add.anchor.chapterId, "chapter-human");
  assert.equal(add.anchor.storyBlockId, "human-story-block");
  assert.equal(add.anchor.domain, "safe_reviewed_story");
  assert.equal(add.expectedActionState, "valid");
  const save = byId.get("human-save");
  assert.equal(save.insightVersions[0].review, "human_approved");
  assert.equal(save.requiresImmediateRedundantAccept, false);
});

test("foreign, missing, and private human Insight anchors are invalid", () => {
  for (const id of ["human-foreign-chapter-anchor", "human-missing-block-anchor", "human-private-domain-anchor"]) {
    assert.equal(successorLifecycleCases.find((item) => item.id === id).expectedActionState, "invalid");
  }
});

test("current runtime rejects future-valid zero-source and plural-source Story shapes", () => {
  assert.equal(parseStoryAnnotation(currentRuntimeProbe([])), null);
  assert.equal(parseStoryAnnotation(currentRuntimeProbe([currentInsight("probe-one"), currentInsight("probe-two")])), null);
});

test("current exact-one runtime behavior remains unchanged", () => {
  const parsed = parseStoryAnnotation(currentRuntimeProbe([currentInsight("probe-one")]));
  assert.ok(parsed);
  assert.equal(parsed.reviewPresentation.en.highlights.length, 1);
});

test("the fixture corpus is synthetic, public-safe, and free of release-visible private sentinels", () => {
  const encoded = JSON.stringify(storyFirstSemanticCases);
  assert.ok(storyFirstSemanticCases.every((fixture) => fixture.input.privacyState === "public_safe_synthetic"));
  assert.doesNotMatch(encoded, /(?:[A-Za-z]:\\|github\.com|oxygen-contributor|\bO2TechAI\b|BEGIN PRIVATE|\[REDACTED\])/i);
});
