import test from "node:test";
import assert from "node:assert/strict";
import {
  applyChapterReview,
  emptyChapterReview,
  markChapterReady,
  privacyDecisionKey,
} from "../lib/story-review.ts";
import {
  STORY_REVIEW_SESSION_SCHEMA,
  canonicalizeStoryReviewSession,
  hydrateStoryReviewSession,
} from "../lib/story-review-session.ts";
import { buildReviewedStoryRelease } from "../lib/story-release.ts";
import { STORY_PREFIX, parseStoryAnnotation, selectProjectTimeline } from "../lib/timeline.ts";

const WORKFLOW_RUN_ID = "st14-target-roundtrip-run";
const UPDATED_AT = "2032-01-02T03:04:05.000Z";
const DOCUMENT_ID = "synthetic-target-document";
const EVENT_ID = `${DOCUMENT_ID}:synthetic-target-evidence`;
const EVIDENCE = { documentId: DOCUMENT_ID, eventId: EVENT_ID };
const BODY_TARGETS = [
  "scene",
  "reconstruction-0",
  "reconstruction-1",
  "detail-0",
  "detail-1",
  "outcome",
  "uncertainty",
];

// This is the test-owned acceptance matrix. It is deliberately explicit and
// does not derive legal identities from a production target-map helper.
const LEGAL_TARGET_CASES = [
  { caseId: "fixed-phase", target: "phase", targetFamily: "fixed", effect: "empty_scalar", expectedCurrentFailure: true },
  { caseId: "fixed-title", target: "title", targetFamily: "fixed", effect: "empty_scalar", expectedCurrentFailure: true },
  { caseId: "fixed-overview", target: "overview", targetFamily: "fixed", effect: "empty_scalar", expectedCurrentFailure: true },
  { caseId: "fixed-before", target: "before", targetFamily: "fixed", effect: "empty_scalar", expectedCurrentFailure: true },
  { caseId: "fixed-after", target: "after", targetFamily: "fixed", effect: "empty_scalar", expectedCurrentFailure: true },
  { caseId: "fixed-scene", target: "scene", targetFamily: "fixed", effect: "empty_scalar", expectedCurrentFailure: false },
  { caseId: "fixed-outcome", target: "outcome", targetFamily: "fixed", effect: "empty_scalar", expectedCurrentFailure: false },
  { caseId: "fixed-uncertainty", target: "uncertainty", targetFamily: "fixed", effect: "empty_scalar", expectedCurrentFailure: false },
  { caseId: "indexed-reconstruction-0", target: "reconstruction-0", targetFamily: "indexed", effect: "omit_array_item", expectedCurrentFailure: false },
  { caseId: "indexed-reconstruction-1", target: "reconstruction-1", targetFamily: "indexed", effect: "omit_array_item", expectedCurrentFailure: false },
  { caseId: "indexed-detail-0", target: "detail-0", targetFamily: "indexed", effect: "omit_array_item", expectedCurrentFailure: false },
  { caseId: "indexed-detail-1", target: "detail-1", targetFamily: "indexed", effect: "omit_array_item", expectedCurrentFailure: false },
  { caseId: "stable-person-alpha", target: "people:person-alpha", targetFamily: "people_stable_id", effect: "omit_record", expectedCurrentFailure: true },
  { caseId: "stable-person-beta", target: "people:person-beta", targetFamily: "people_stable_id", effect: "omit_record", expectedCurrentFailure: true },
  { caseId: "stable-insight-alpha", target: "insight:insight-alpha", targetFamily: "insight_stable_id", effect: "omit_record", insightId: "insight-alpha", expectedCurrentFailure: true },
  { caseId: "stable-insight-beta", target: "insight:insight-beta", targetFamily: "insight_stable_id", effect: "omit_record", insightId: "insight-beta", expectedCurrentFailure: true },
];

const INVALID_TARGET_CASES = [
  { caseId: "invalid-arbitrary", target: "not-a-story-target", invalidKind: "malformed", boundary: "parser" },
  { caseId: "invalid-reconstruction-negative", target: "reconstruction--1", invalidKind: "below_zero", boundary: "parser" },
  { caseId: "invalid-detail-negative", target: "detail--1", invalidKind: "below_zero", boundary: "parser" },
  { caseId: "invalid-empty-stable-id", target: "people:", invalidKind: "empty_stable_id", boundary: "parser" },
  { caseId: "invalid-people-ghost", target: "people:ghost", invalidKind: "nonexistent_dynamic", boundary: "apply" },
  { caseId: "invalid-insight-ghost", target: "insight:ghost", invalidKind: "nonexistent_dynamic", boundary: "apply" },
  { caseId: "invalid-reconstruction-length", target: "reconstruction-2", invalidKind: "index_equal_length", boundary: "apply" },
  { caseId: "invalid-reconstruction-far", target: "reconstruction-999", invalidKind: "index_far_above", boundary: "apply" },
  { caseId: "invalid-detail-length", target: "detail-2", invalidKind: "index_equal_length", boundary: "apply" },
  { caseId: "invalid-detail-far", target: "detail-999", invalidKind: "index_far_above", boundary: "apply" },
  { caseId: "invalid-malformed-stable-id", target: "people:   ", invalidKind: "malformed_stable_id", boundary: "apply" },
  { caseId: "invalid-other-chapter-owner", target: "insight:insight-beta", invalidKind: "owned_by_other_chapter", boundary: "apply" },
];

const SENTINELS = {
  phase: "SENTINEL_PHASE",
  title: "SENTINEL_CHAPTER_TITLE",
  overview: "SENTINEL_OVERVIEW",
  before: "SENTINEL_BEFORE",
  after: "SENTINEL_AFTER",
  scene: "SENTINEL_SCENE",
  reconstruction0: "SENTINEL_RECONSTRUCTION_ZERO",
  reconstruction1: "SENTINEL_RECONSTRUCTION_ONE",
  detail0: "SENTINEL_DETAIL_ZERO",
  detail1: "SENTINEL_DETAIL_ONE",
  outcome: "SENTINEL_OUTCOME",
  uncertainty: "SENTINEL_UNCERTAINTY",
  personAlphaLabel: "SENTINEL_PERSON_ALPHA_LABEL",
  personBetaLabel: "SENTINEL_PERSON_BETA_LABEL",
};

function coverageLedger() {
  return {
    mainProblem: { state: "represented", blockIds: ["scene"], evidence: [EVIDENCE] },
    participants: { state: "represented", blockIds: ["people:person-alpha", "people:person-beta"], evidence: [EVIDENCE] },
    startingPosition: { state: "represented", blockIds: ["scene"], evidence: [EVIDENCE] },
    alternatives: { state: "not_supported" },
    objectionOrDisagreement: { state: "not_supported" },
    failedAttempt: { state: "not_supported" },
    correction: { state: "represented", blockIds: ["reconstruction-0"], evidence: [EVIDENCE] },
    decisionChangingEvidence: { state: "represented", blockIds: ["detail-0"], evidence: [EVIDENCE] },
    quantitativeResult: { state: "not_supported" },
    finalAction: { state: "represented", blockIds: ["outcome"], evidence: [EVIDENCE] },
    result: { state: "represented", blockIds: ["outcome"], evidence: [EVIDENCE] },
    remainingUncertainty: { state: "represented", blockIds: ["uncertainty"], evidence: [EVIDENCE] },
  };
}

function presentation(releaseTargets, insightId) {
  const story = {
    scene: SENTINELS.scene,
    reconstruction: [SENTINELS.reconstruction0, SENTINELS.reconstruction1],
    importantDetails: [SENTINELS.detail0, SENTINELS.detail1],
    decisionOutcome: SENTINELS.outcome,
    uncertainty: SENTINELS.uncertainty,
  };
  const passageContext = Object.fromEntries(BODY_TARGETS.map((blockId) => [blockId, {
    whatWasHappening: `SENTINEL_CONTEXT_${blockId}_STATE`,
    whyItMattered: `SENTINEL_CONTEXT_${blockId}_IMPORTANCE`,
  }]));
  return {
    phase: SENTINELS.phase,
    title: SENTINELS.title,
    timelineSummary: "SENTINEL_TIMELINE_SUMMARY",
    before: SENTINELS.before,
    after: SENTINELS.after,
    timelineChips: ["SENTINEL_CHIP"],
    overview: SENTINELS.overview,
    people: [
      {
        id: "person-alpha",
        releaseLabel: SENTINELS.personAlphaLabel,
        role: "SENTINEL_PERSON_ALPHA_ROLE",
        description: "SENTINEL_PERSON_ALPHA_DESCRIPTION",
        localIdentityState: "not_identified",
        evidence: [EVIDENCE],
      },
      {
        id: "person-beta",
        releaseLabel: SENTINELS.personBetaLabel,
        role: "SENTINEL_PERSON_BETA_ROLE",
        description: "SENTINEL_PERSON_BETA_DESCRIPTION",
        localIdentityState: "not_identified",
        evidence: [EVIDENCE],
      },
    ],
    story,
    passageContext,
    highlights: [{
      id: insightId,
      title: `SENTINEL_${insightId}_TITLE`,
      noticed: `SENTINEL_${insightId}_NOTICED`,
      lesson: `SENTINEL_${insightId}_LESSON`,
    }],
    privacy: {
      summary: "SENTINEL_PRIVACY_SUMMARY",
      candidates: [{
        id: "target-candidate",
        title: "SENTINEL_PRIVACY_TITLE",
        explanation: "SENTINEL_PRIVACY_EXPLANATION",
        recommendation: "redact",
        releaseTargets,
        original: { availability: "unavailable" },
        whyFlagged: "SENTINEL_PRIVACY_REASON",
      }],
    },
  };
}

function syntheticEvent(releaseTargets, { storyKey = "sentinel-chapter", insightId = "insight-alpha" } = {}) {
  const en = presentation(releaseTargets, insightId);
  const traceableBlocks = [
    "overview",
    "people:person-alpha",
    "people:person-beta",
    ...BODY_TARGETS,
    `insight:${insightId}`,
  ];
  const annotation = {
    schema: "oxygen.story-highlight/2",
    key: storyKey,
    phase: SENTINELS.phase,
    kind: "decision",
    title: SENTINELS.title,
    timelineSummary: "SENTINEL_ROOT_TIMELINE_SUMMARY",
    whyThisMatters: "SENTINEL_WHY_THIS_MATTERS",
    before: SENTINELS.before,
    after: SENTINELS.after,
    importance: 3,
    releaseEpisode: {
      readingTimeMinutes: 1,
      ...en.story,
      compression: {
        sourceScope: "SENTINEL_SOURCE_SCOPE",
        retained: ["SENTINEL_RETAINED"],
        omittedLowValue: ["SENTINEL_OMITTED_LOW_VALUE"],
        omittedSensitive: [],
        rewriteBrief: "SENTINEL_REWRITE_BRIEF",
      },
    },
    insight: {
      proposal: "SENTINEL_INSIGHT_PROPOSAL",
      rationale: "SENTINEL_INSIGHT_RATIONALE",
      reviewState: "ai_proposed",
    },
    evidence: { primary: EVIDENCE, supporting: [] },
    sourceVersion: {
      defaultView: "release",
      originalState: "local_evidence_only",
      releaseState: "ai_prepared_draft",
      note: "SENTINEL_SOURCE_VERSION_NOTE",
    },
    privacyReview: { state: "reviewed_release", note: "SENTINEL_PRIVACY_REVIEW_NOTE" },
    reviewPresentation: { en, semanticAnchors: ["SENTINEL_CHAPTER"] },
    narrativeReview: {
      schema: "oxygen.story-narrative-review/1",
      status: "passed",
      title: { tensionAndOutcome: true },
      roles: {
        background: ["scene"],
        evidenceThread: ["reconstruction-0", "detail-0"],
        turn: ["reconstruction-0"],
        result: ["outcome"],
        directLearning: [`insight:${insightId}`],
        reusablePrinciple: [`insight:${insightId}`],
        openTension: { state: "supported", blockIds: ["uncertainty"] },
      },
      phase: {
        rationale: "SENTINEL_PHASE_RATIONALE_IS_COMPLETE",
        assignmentCoherent: true,
        adjacentBoundaryReviewed: true,
      },
      passageInsightsDistinct: true,
      actorCoverage: { state: "people_present", personIds: ["person-alpha", "person-beta"] },
      editorial: {
        standardTerminology: true,
        neutralStructure: true,
        factualClaimsEvidenceBound: true,
        interpretationSeparated: true,
        uncertaintyPreserved: true,
        prohibitedStyleChecked: true,
      },
      coverageLedger: coverageLedger(),
      claimTraceability: traceableBlocks.map((blockId, index) => ({
        id: `claim-${index}`,
        kind: blockId.startsWith("insight:") ? "insight_input" : "factual_claim",
        blockId,
        evidence: [EVIDENCE],
        ...(BODY_TARGETS.includes(blockId) ? { unitIds: ["source-unit-target"] } : {}),
      })),
      contextRetention: {
        schema: "oxygen.story-context-retention/1",
        sourceScope: [EVIDENCE],
        sourceUnitCount: 1,
        representedUnitCount: 1,
        excludedUnitCount: 0,
        units: [{
          id: "source-unit-target",
          kind: "decision",
          evidence: EVIDENCE,
          state: "represented",
          blockIds: BODY_TARGETS,
        }],
      },
    },
  };
  return {
    id: EVENT_ID,
    document_id: DOCUMENT_ID,
    sequence: 1,
    timestamp: "2032-01-01T00:00:00Z",
    summary: STORY_PREFIX + JSON.stringify(annotation),
    content: "SENTINEL_EVENT_CONTENT",
  };
}

function parsedMilestone(releaseTargets, options) {
  const milestones = selectProjectTimeline([syntheticEvent(releaseTargets, options)]);
  assert.equal(milestones.length, 1, `synthetic target fixture must parse: ${releaseTargets.join(",")}`);
  return milestones[0];
}

function sourceBlocks(milestone) {
  const en = milestone.story.reviewPresentation.en.story;
  return {
    en: {
      scene: en.scene,
      "reconstruction-0": en.reconstruction[0],
      "reconstruction-1": en.reconstruction[1],
      "detail-0": en.importantDetails[0],
      "detail-1": en.importantDetails[1],
      outcome: en.decisionOutcome,
      uncertainty: en.uncertainty,
    },
    zh: {},
  };
}

function reviewContext(milestone, decision = "redact") {
  const en = milestone.story.reviewPresentation.en;
  const sources = sourceBlocks(milestone);
  return {
    storyKey: milestone.story.key,
    privacyCandidates: en.privacy.candidates,
    privacyDecisions: { "target-candidate": decision },
    reviewableInsightIds: en.highlights.map((highlight) => highlight.id),
    chapterEvidence: [milestone.story.evidence.primary, ...milestone.story.evidence.supporting],
    evidenceResolved: true,
    supportedAddIds: [],
    sourceBlocks: sources,
    reviewedBlocks: sources,
  };
}

function applyAndConfirm(milestone, decision = "redact") {
  const context = reviewContext(milestone, decision);
  const applied = applyChapterReview(emptyChapterReview(), context);
  assert.equal(applied.blockedReason, undefined, "a legal target must be accepted by Apply");
  assert.equal(applied.state.stage, "revision_ready");
  assert.equal(applied.state.revision, 2);
  const confirmed = markChapterReady(applied.state, context);
  assert.equal(confirmed.stage, "human_confirmed");
  assert.equal(confirmed.publicationApproved, false);
  return { context, review: confirmed };
}

function canonicalJsonRoundTrip(milestone, review) {
  const storyKey = milestone.story.key;
  const decisionKey = privacyDecisionKey(storyKey, "target-candidate");
  const decision = review.appliedPrivacyDecisions["target-candidate"];
  const canonical = canonicalizeStoryReviewSession({
    schema: STORY_REVIEW_SESSION_SCHEMA,
    workflowRunId: WORKFLOW_RUN_ID,
    chapterReviews: { [storyKey]: { ...review, notes: "SENTINEL_PRIVATE_REVIEW_NOTE" } },
    privacyDecisions: { [decisionKey]: decision },
    updatedAt: UPDATED_AT,
    privateReviewMetadata: "SENTINEL_PRIVATE_SESSION_METADATA",
  });
  assert.ok(canonical);
  assert.equal(canonical.chapterReviews[storyKey].stage, review.stage);
  assert.equal(canonical.chapterReviews[storyKey].revision, review.revision);
  assert.deepEqual(canonical.chapterReviews[storyKey].appliedPrivacyDecisions, review.appliedPrivacyDecisions);
  assert.deepEqual(canonical.chapterReviews[storyKey].redactedBlocks, review.redactedBlocks);
  assert.deepEqual(canonical.privacyDecisions, { [decisionKey]: decision });
  const serialized = JSON.stringify(canonical);
  assert.doesNotMatch(serialized, /SENTINEL_PRIVATE_REVIEW_NOTE|SENTINEL_PRIVATE_SESSION_METADATA|notes|privateReviewMetadata/);
  return JSON.parse(serialized);
}

function targetObservations(chapter, presentation) {
  const en = chapter.en;
  const observations = {
    phase: en.phase,
    title: en.title,
    overview: en.overview,
    before: en.before,
    after: en.after,
    scene: en.story.scene,
    outcome: en.story.decisionOutcome,
    uncertainty: en.story.uncertainty,
  };
  presentation.story.reconstruction.forEach((sentinel, index) => {
    observations[`reconstruction-${index}`] = en.story.reconstruction.includes(sentinel) ? sentinel : null;
  });
  presentation.story.importantDetails.forEach((sentinel, index) => {
    observations[`detail-${index}`] = en.story.importantDetails.includes(sentinel) ? sentinel : null;
  });
  presentation.people.forEach((person) => {
    observations[`people:${person.id}`] = en.people.some((item) => item.releaseLabel === person.releaseLabel)
      ? person.releaseLabel
      : null;
  });
  presentation.highlights.forEach((insight) => {
    observations[`insight:${insight.id}`] = en.insights.some((item) => item.id === insight.id) ? insight.id : null;
  });
  return observations;
}

function expectedReleaseFromKeep(keepRelease, milestone, matrixCase) {
  const expected = structuredClone(keepRelease);
  const chapter = expected.chapters[0];
  const en = chapter.en;
  switch (matrixCase.target) {
    case "phase": en.phase = ""; break;
    case "title": en.title = ""; break;
    case "overview": en.overview = ""; break;
    case "before": en.before = ""; break;
    case "after": en.after = ""; break;
    case "scene": en.story.scene = ""; break;
    case "outcome": en.story.decisionOutcome = ""; break;
    case "uncertainty": en.story.uncertainty = ""; break;
    case "reconstruction-0": en.story.reconstruction.splice(0, 1); break;
    case "reconstruction-1": en.story.reconstruction.splice(1, 1); break;
    case "detail-0": en.story.importantDetails.splice(0, 1); break;
    case "detail-1": en.story.importantDetails.splice(1, 1); break;
    case "people:person-alpha":
    case "people:person-beta": {
      const personId = matrixCase.target.slice("people:".length);
      const presentationPerson = milestone.story.reviewPresentation.en.people.find((person) => person.id === personId);
      en.people = en.people.filter((person) => person.releaseLabel !== presentationPerson.releaseLabel);
      break;
    }
    case "insight:insight-alpha":
    case "insight:insight-beta": {
      const insightId = matrixCase.target.slice("insight:".length);
      en.insights = en.insights.filter((insight) => insight.id !== insightId);
      break;
    }
    default: assert.fail(`missing independent release expectation for ${matrixCase.target}`);
  }
  return expected;
}

function allObjectKeys(value, result = []) {
  if (!value || typeof value !== "object") return result;
  for (const [key, child] of Object.entries(value)) {
    result.push(key);
    allObjectKeys(child, result);
  }
  return result;
}

function assertExactTargetEffect(redactedRelease, keepRelease, milestone, matrixCase) {
  assert.equal(redactedRelease.publication_approved, false);
  assert.equal(redactedRelease.chapters.length, 1);
  assert.equal(keepRelease.chapters.length, 1);
  const redactedChapter = redactedRelease.chapters[0];
  const keepChapter = keepRelease.chapters[0];
  assert.equal(redactedChapter.key, keepChapter.key);
  assert.equal(redactedChapter.kind, keepChapter.kind);
  assert.equal(redactedChapter.revision, keepChapter.revision);
  const presentation = milestone.story.reviewPresentation.en;
  const actual = targetObservations(redactedChapter, presentation);
  const baseline = targetObservations(keepChapter, presentation);
  const expectedSelected = matrixCase.effect === "empty_scalar" ? "" : null;
  assert.equal(actual[matrixCase.target], expectedSelected, `${matrixCase.target} must have its explicit release effect`);
  for (const [target, value] of Object.entries(baseline)) {
    if (target !== matrixCase.target) assert.deepEqual(actual[target], value, `${matrixCase.target} must preserve ${target}`);
  }
  const selectedReconstruction = matrixCase.target.startsWith("reconstruction-")
    ? baseline[matrixCase.target]
    : undefined;
  const selectedDetail = matrixCase.target.startsWith("detail-") ? baseline[matrixCase.target] : undefined;
  assert.deepEqual(redactedChapter.en.story.reconstruction,
    keepChapter.en.story.reconstruction.filter((value) => value !== selectedReconstruction));
  assert.deepEqual(redactedChapter.en.story.importantDetails,
    keepChapter.en.story.importantDetails.filter((value) => value !== selectedDetail));
  assert.deepEqual(redactedRelease, expectedReleaseFromKeep(keepRelease, milestone, matrixCase),
    `${matrixCase.target} must be the only full-release mutation`);
  const releaseKeys = new Set(allObjectKeys(redactedRelease));
  for (const forbiddenKey of [
    "evidence", "documentId", "eventId", "original", "passageContext", "privacy",
    "notes", "localIdentityState", "publicationApproved", "privateReviewMetadata",
  ]) assert.equal(releaseKeys.has(forbiddenKey), false, `release must exclude ${forbiddenKey}`);
  assert.equal(redactedRelease.publication_approved, false);
}

function legalRoundTrip(matrixCase) {
  const milestone = parsedMilestone([matrixCase.target], { insightId: matrixCase.insightId || "insight-alpha" });
  const { review } = applyAndConfirm(milestone, "redact");
  assert.deepEqual(review.appliedPrivacyDecisions, { "target-candidate": "redact" });
  assert.deepEqual(review.redactedBlocks, [matrixCase.target]);
  const immediateRelease = buildReviewedStoryRelease([milestone], { [milestone.story.key]: review });
  const keepReview = applyAndConfirm(milestone, "keep").review;
  const keepRelease = buildReviewedStoryRelease([milestone], { [milestone.story.key]: keepReview });
  assertExactTargetEffect(immediateRelease, keepRelease, milestone, matrixCase);

  const transported = canonicalJsonRoundTrip(milestone, review);
  assert.deepEqual(transported.chapterReviews[milestone.story.key].redactedBlocks, [matrixCase.target]);
  const hydrated = hydrateStoryReviewSession(transported, WORKFLOW_RUN_ID, [milestone]);
  const hydratedReview = hydrated.chapterReviews[milestone.story.key];
  assert.ok(hydratedReview, `${matrixCase.target} must not make the Chapter disappear during hydration`);
  assert.equal(hydratedReview.stage, review.stage);
  assert.equal(hydratedReview.revision, review.revision);
  assert.deepEqual(hydratedReview.appliedPrivacyDecisions, review.appliedPrivacyDecisions);
  assert.deepEqual(hydratedReview.redactedBlocks, review.redactedBlocks);
  assert.deepEqual(hydrated.privacyDecisions, {
    [privacyDecisionKey(milestone.story.key, "target-candidate")]: "redact",
  });
  const hydratedRelease = buildReviewedStoryRelease([milestone], hydrated.chapterReviews);
  assertExactTargetEffect(hydratedRelease, keepRelease, milestone, matrixCase);
  assert.deepEqual(hydratedRelease, immediateRelease, `${matrixCase.target} must release identically before and after hydration`);
}

test("the independent ST-14 target matrix names every canonical family", () => {
  assert.deepEqual(LEGAL_TARGET_CASES.map(({ target }) => target), [
    "phase", "title", "overview", "before", "after", "scene", "outcome", "uncertainty",
    "reconstruction-0", "reconstruction-1", "detail-0", "detail-1",
    "people:person-alpha", "people:person-beta", "insight:insight-alpha", "insight:insight-beta",
  ]);
});

for (const matrixCase of LEGAL_TARGET_CASES) {
  test(`legal target round trip [${matrixCase.caseId}] ${matrixCase.target}`, () => legalRoundTrip(matrixCase));
}

test("People stable IDs remove only their selected owner in immediate release", () => {
  for (const target of ["people:person-alpha", "people:person-beta"]) {
    const matrixCase = LEGAL_TARGET_CASES.find((item) => item.target === target);
    const milestone = parsedMilestone([target]);
    const { review } = applyAndConfirm(milestone);
    const immediate = buildReviewedStoryRelease([milestone], { [milestone.story.key]: review });
    const labels = immediate.chapters[0].en.people.map((person) => person.releaseLabel);
    assert.deepEqual(labels, target.endsWith("alpha") ? [SENTINELS.personBetaLabel] : [SENTINELS.personAlphaLabel]);
    assert.equal(matrixCase.effect, "omit_record");
  }
});

test("Insight stable IDs remain Chapter-local and preserve a different valid Chapter Insight", () => {
  const alpha = parsedMilestone(["insight:insight-alpha"], { storyKey: "chapter-alpha", insightId: "insight-alpha" });
  const beta = parsedMilestone(["insight:insight-beta"], { storyKey: "chapter-beta", insightId: "insight-beta" });
  const alphaReview = applyAndConfirm(alpha, "redact").review;
  const betaReview = applyAndConfirm(beta, "keep").review;
  const immediate = buildReviewedStoryRelease([alpha, beta], {
    [alpha.story.key]: alphaReview,
    [beta.story.key]: betaReview,
  });
  assert.deepEqual(immediate.chapters[0].en.insights, []);
  assert.deepEqual(immediate.chapters[1].en.insights.map((insight) => insight.id), ["insight-beta"]);

  const alphaSession = canonicalJsonRoundTrip(alpha, alphaReview);
  const betaSession = canonicalJsonRoundTrip(beta, betaReview);
  const combined = canonicalizeStoryReviewSession({
    schema: STORY_REVIEW_SESSION_SCHEMA,
    workflowRunId: WORKFLOW_RUN_ID,
    chapterReviews: {
      [alpha.story.key]: alphaSession.chapterReviews[alpha.story.key],
      [beta.story.key]: betaSession.chapterReviews[beta.story.key],
    },
    privacyDecisions: {
      ...alphaSession.privacyDecisions,
      ...betaSession.privacyDecisions,
    },
    updatedAt: UPDATED_AT,
  });
  const hydrated = hydrateStoryReviewSession(JSON.parse(JSON.stringify(combined)), WORKFLOW_RUN_ID, [alpha, beta]);
  assert.ok(hydrated.chapterReviews[alpha.story.key], "the redacted Insight Chapter must survive hydration");
  assert.ok(hydrated.chapterReviews[beta.story.key], "the unrelated Insight Chapter must survive hydration");
  const after = buildReviewedStoryRelease([alpha, beta], hydrated.chapterReviews);
  assert.deepEqual(after, immediate);
});

for (const matrixCase of INVALID_TARGET_CASES.filter((item) => item.boundary === "parser")) {
  test(`invalid target rejects before Apply [${matrixCase.caseId}] ${matrixCase.target}`, () => {
    const event = syntheticEvent([matrixCase.target]);
    assert.equal(parseStoryAnnotation(event.summary), null);
  });
}

for (const matrixCase of INVALID_TARGET_CASES.filter((item) => item.boundary === "apply")) {
  test(`invalid target cannot no-op or defer rejection [${matrixCase.caseId}] ${matrixCase.target}`, () => {
    const milestone = parsedMilestone([matrixCase.target]);
    const initial = emptyChapterReview();
    const context = reviewContext(milestone, "redact");
    const result = applyChapterReview(initial, context);
    const confirmed = markChapterReady(result.state, context);
    const immediate = buildReviewedStoryRelease([milestone], { [milestone.story.key]: confirmed });
    const keepReview = applyAndConfirm(milestone, "keep").review;
    const unchangedRelease = buildReviewedStoryRelease([milestone], { [milestone.story.key]: keepReview });
    const session = result.blockedReason ? null : canonicalJsonRoundTrip(milestone, confirmed);
    const hydrated = session ? hydrateStoryReviewSession(session, WORKFLOW_RUN_ID, [milestone]) : { chapterReviews: {} };
    const hydratedRelease = buildReviewedStoryRelease([milestone], hydrated.chapterReviews);
    assert.deepEqual({
      blockedBeforePersistence: Boolean(result.blockedReason),
      stateUnchanged: result.state === initial,
      revision: result.state.revision,
      appliedPrivacyDecisions: result.state.appliedPrivacyDecisions,
      redactedBlocks: result.state.redactedBlocks,
      sessionCreated: Boolean(session),
      immediateReleaseUnchanged: immediate.chapters.length === 0,
      acceptedAsVisibleNoOp: immediate.chapters.length > 0 && JSON.stringify(immediate) === JSON.stringify(unchangedRelease),
      lateChapterDrop: immediate.chapters.length > 0 && hydratedRelease.chapters.length === 0,
    }, {
      blockedBeforePersistence: true,
      stateUnchanged: true,
      revision: 1,
      appliedPrivacyDecisions: {},
      redactedBlocks: [],
      sessionCreated: false,
      immediateReleaseUnchanged: true,
      acceptedAsVisibleNoOp: false,
      lateChapterDrop: false,
    });
  });
}

test("schema-1 valid non-body targets remain readable with exact release effects", () => {
  const targets = ["title", "people:person-alpha", "insight:insight-alpha"];
  const milestone = parsedMilestone(targets);
  const historicalReview = {
    stage: "human_confirmed",
    revision: 2,
    annotations: [],
    editTransactions: [],
    redoTransactionIds: [],
    insightReviews: {},
    appliedPrivacyDecisions: { "target-candidate": "redact" },
    redactedBlocks: targets,
    staleTranslations: [],
    revisionHistory: [{
      revision: 2,
      annotationIds: [],
      editTransactionIds: [],
      insightIds: [],
      privacyDecisions: { "target-candidate": "redact" },
    }],
    evidenceVerified: true,
    publicationApproved: false,
  };
  const immediate = buildReviewedStoryRelease([milestone], { [milestone.story.key]: historicalReview });
  assert.equal(immediate.chapters[0].en.title, "");
  assert.deepEqual(immediate.chapters[0].en.people.map((person) => person.releaseLabel), [SENTINELS.personBetaLabel]);
  assert.deepEqual(immediate.chapters[0].en.insights, []);
  const transported = JSON.parse(JSON.stringify({
    schema: "oxygen.story-review-session/1",
    workflowRunId: WORKFLOW_RUN_ID,
    chapterReviews: { [milestone.story.key]: historicalReview },
    privacyDecisions: {
      [privacyDecisionKey(milestone.story.key, "target-candidate")]: "redact",
    },
    updatedAt: "2031-01-01T00:00:00.000Z",
  }));
  const hydrated = hydrateStoryReviewSession(transported, WORKFLOW_RUN_ID, [milestone]);
  assert.ok(hydrated.chapterReviews[milestone.story.key], "valid historical non-body targets must keep their Chapter");
  assert.deepEqual(buildReviewedStoryRelease([milestone], hydrated.chapterReviews), immediate);
});

test("schema-1 nonexistent targets fail closed instead of hydrating a forged Chapter", () => {
  const milestone = parsedMilestone(["people:ghost"]);
  const { review } = applyAndConfirm(milestone);
  const transported = JSON.parse(JSON.stringify({
    schema: "oxygen.story-review-session/1",
    workflowRunId: WORKFLOW_RUN_ID,
    chapterReviews: { [milestone.story.key]: review },
    privacyDecisions: {
      [privacyDecisionKey(milestone.story.key, "target-candidate")]: "redact",
    },
    updatedAt: "2031-01-01T00:00:00.000Z",
  }));
  assert.deepEqual(hydrateStoryReviewSession(transported, WORKFLOW_RUN_ID, [milestone]).chapterReviews, {});
});
