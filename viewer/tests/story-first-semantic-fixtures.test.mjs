import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  STORY_PREFIX,
  SUCCESSOR_STORY_PREFIX,
  parseStoryAnnotation,
  parseStorySource,
  parseSuccessorStorySource,
} from "../lib/timeline.ts";
import {
  selectReviewableStoryTimeline,
  validateSuccessorStorySourcePackage,
} from "../lib/story-readiness.ts";
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
  "storyBlockEvidence",
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

const evidenceReference = (documentId, eventId) => ({ documentId, eventId });

function buildSuccessorFixture(caseId) {
  const fixture = storyFirstSemanticCases.find((item) => item.id === caseId);
  const expectation = storyFirstSemanticExpectations.find((item) => item.caseId === caseId);
  const documentId = `fixture-${caseId}`;
  const records = new Map(fixture.input.records.map((item) => [item.id, item]));
  const evidenceRows = fixture.input.records.map((item) => ({
    id: item.id,
    documentId,
    eventType: "message",
    actorId: item.actorId,
    actorType: "human",
  }));
  const candidateRows = expectation.chapters.map((chapterItem) => {
    const phase = expectation.phases.find((item) => item.id === chapterItem.phaseId);
    const blocks = chapterItem.storyBlockIds.map((blockId) => {
      const recordIds = expectation.storyBlockEvidence[blockId];
      return {
        id: blockId,
        text: recordIds.map((recordId) => records.get(recordId).text).join(" "),
        evidence: recordIds.map((recordId) => evidenceReference(documentId, recordId)),
      };
    });
    const chapterRecordIds = [...new Set(blocks.flatMap((block) => (
      block.evidence.map((reference) => reference.eventId)
    )))];
    const source = {
      schema: "oxygen.story/3",
      key: chapterItem.id,
      phase: { id: phase.id, label: phase.label },
      title: fixture.title,
      overview: `${fixture.input.projectLabel} retains this supported synthetic narrative arc.`,
      people: chapterItem.people.map((personItem) => ({
        id: personItem.id,
        releaseLabel: personItem.id,
        role: personItem.id.replace(/^person-/, "").replaceAll("-", " "),
        description: "Supported actor in this synthetic Chapter.",
        localIdentityState: "not_identified",
        evidence: personItem.recordIds.map((recordId) => evidenceReference(documentId, recordId)),
      })),
      story: { blocks },
      insights: chapterItem.insights.map((item) => {
        const anchoredEvidence = [...new Map(item.quote.storyBlockIds.flatMap((blockId) => (
          blocks.find((block) => block.id === blockId).evidence
        )).map((reference) => [JSON.stringify(reference), reference])).values()];
        return {
          id: item.id,
          background: item.background.requiredConcepts.join("; "),
          quote: { storyBlockIds: item.quote.storyBlockIds },
          directlyAcquiredExperience: item.directlyAcquiredExperience.requiredConcepts.join("; "),
          principle: `When ${item.principle.requiredCondition}, ${item.principle.requiredResponse}, because ${item.principle.boundedReason}.`,
          evidence: anchoredEvidence,
        };
      }),
      evidence: {
        primary: evidenceReference(documentId, chapterRecordIds[0]),
        supporting: chapterRecordIds.slice(1).map((recordId) => evidenceReference(documentId, recordId)),
      },
      contextRetention: { excluded: [] },
    };
    return {
      id: chapterItem.id,
      documentId,
      summary: SUCCESSOR_STORY_PREFIX + JSON.stringify(source),
    };
  });
  return { candidateRows, evidenceRows };
}

function sourceFromRow(row) {
  return JSON.parse(row.summary.slice(SUCCESSOR_STORY_PREFIX.length));
}

function rowWithSource(row, source) {
  return { ...row, summary: SUCCESSOR_STORY_PREFIX + JSON.stringify(source) };
}

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

test("successor version dispatch is explicit and fails closed", () => {
  const { candidateRows } = buildSuccessorFixture("one-insight");
  const successor = candidateRows[0].summary;
  assert.equal(parseStoryAnnotation(successor), null);
  assert.equal(parseSuccessorStorySource(successor)?.schema, "oxygen.story/3");
  assert.equal(parseStorySource(successor)?.schema, "oxygen.story/3");
  assert.equal(parseStorySource(`oxygen.story/4:${successor.slice(SUCCESSOR_STORY_PREFIX.length)}`), null);

  const malformedSuccessor = SUCCESSOR_STORY_PREFIX
    + currentRuntimeProbe([currentInsight("probe-one")]).slice(STORY_PREFIX.length);
  assert.equal(parseSuccessorStorySource(malformedSuccessor), null);
  assert.equal(parseStorySource(malformedSuccessor), null);
});

test("all eight frozen cases execute through successor production parser and readiness", () => {
  for (const fixture of storyFirstSemanticCases) {
    const { candidateRows, evidenceRows } = buildSuccessorFixture(fixture.id);
    assert.ok(candidateRows.every((row) => parseSuccessorStorySource(row.summary)), fixture.id);
    assert.equal(validateSuccessorStorySourcePackage(candidateRows, evidenceRows).ok, true, fixture.id);
  }
});

test("successor readiness accepts zero, one, and multiple sparse Insights", () => {
  for (const caseId of ["zero-insights", "one-insight", "multiple-sparse-insights"]) {
    const { candidateRows, evidenceRows } = buildSuccessorFixture(caseId);
    const insightCount = candidateRows.reduce((total, row) => (
      total + sourceFromRow(row).insights.length
    ), 0);
    assert.equal(insightCount, { "zero-insights": 0, "one-insight": 1, "multiple-sparse-insights": 2 }[caseId]);
    assert.equal(validateSuccessorStorySourcePackage(candidateRows, evidenceRows).ok, true);
  }
});

test("successor Insight IDs are stable and Chapter-local unique", () => {
  const { candidateRows } = buildSuccessorFixture("multiple-sparse-insights");
  const source = sourceFromRow(candidateRows[0]);
  source.insights[1].id = source.insights[0].id;
  assert.equal(parseSuccessorStorySource(rowWithSource(candidateRows[0], source).summary), null);
});

test("the four-part successor Insight contract is structural and title is metadata", () => {
  const { candidateRows } = buildSuccessorFixture("one-insight");
  const source = sourceFromRow(candidateRows[0]);
  assert.equal(Object.hasOwn(source.insights[0], "title"), false);
  assert.ok(parseSuccessorStorySource(candidateRows[0].summary));
  for (const field of ["background", "quote", "directlyAcquiredExperience", "principle"]) {
    const malformed = structuredClone(source);
    delete malformed.insights[0][field];
    assert.equal(parseSuccessorStorySource(rowWithSource(candidateRows[0], malformed).summary), null, field);
  }
});

test("successor Story and Evidence anchors are exact and same-Chapter", () => {
  const { candidateRows, evidenceRows } = buildSuccessorFixture("one-insight");
  assert.equal(validateSuccessorStorySourcePackage(candidateRows, evidenceRows).ok, true);

  const foreignChapterBlock = sourceFromRow(candidateRows[0]);
  const foreignPackage = buildSuccessorFixture("mundane-setup");
  foreignChapterBlock.insights[0].quote.storyBlockIds = [
    sourceFromRow(foreignPackage.candidateRows[1]).story.blocks[0].id,
  ];
  assert.deepEqual(validateSuccessorStorySourcePackage(
    [rowWithSource(candidateRows[0], foreignChapterBlock)], evidenceRows,
  ), { ok: false, code: "SUCCESSOR_STORY_INSIGHT_GROUNDING_INVALID" });

  const missingBlock = sourceFromRow(candidateRows[0]);
  missingBlock.insights[0].quote.storyBlockIds = ["missing-story-block"];
  assert.deepEqual(validateSuccessorStorySourcePackage(
    [rowWithSource(candidateRows[0], missingBlock)], evidenceRows,
  ), { ok: false, code: "SUCCESSOR_STORY_INSIGHT_GROUNDING_INVALID" });

  const duplicateAnchor = sourceFromRow(candidateRows[0]);
  duplicateAnchor.insights[0].quote.storyBlockIds.push(duplicateAnchor.insights[0].quote.storyBlockIds[0]);
  assert.equal(parseSuccessorStorySource(rowWithSource(candidateRows[0], duplicateAnchor).summary), null);

  const foreignEvidence = sourceFromRow(candidateRows[0]);
  foreignEvidence.insights[0].evidence = [{ documentId: "fixture-foreign", eventId: "foreign-record" }];
  assert.deepEqual(validateSuccessorStorySourcePackage(
    [rowWithSource(candidateRows[0], foreignEvidence)], evidenceRows,
  ), { ok: false, code: "SUCCESSOR_STORY_INSIGHT_GROUNDING_INVALID" });
});

test("successor Chapter readiness keeps People mandatory and evidence-supported", () => {
  const { candidateRows, evidenceRows } = buildSuccessorFixture("one-insight");
  const noPeople = sourceFromRow(candidateRows[0]);
  noPeople.people = [];
  assert.deepEqual(validateSuccessorStorySourcePackage(
    [rowWithSource(candidateRows[0], noPeople)], evidenceRows,
  ), { ok: false, code: "SUCCESSOR_STORY_PEOPLE_INVALID" });

  const inventedPerson = sourceFromRow(candidateRows[0]);
  inventedPerson.people[0].evidence = [{ documentId: "fixture-one-insight", eventId: "missing-record" }];
  assert.deepEqual(validateSuccessorStorySourcePackage(
    [rowWithSource(candidateRows[0], inventedPerson)], evidenceRows,
  ), { ok: false, code: "SUCCESSOR_STORY_PEOPLE_INVALID" });
});

test("successor Phase labels are bounded and Phase identity is contiguous", () => {
  const { candidateRows, evidenceRows } = buildSuccessorFixture("mundane-setup");
  assert.equal(validateSuccessorStorySourcePackage(candidateRows, evidenceRows).ok, true);

  const twoWords = sourceFromRow(candidateRows[0]);
  twoWords.phase.label = "Early Foundation";
  const twoWordRows = [rowWithSource(candidateRows[0], twoWords), ...candidateRows.slice(1)];
  const second = sourceFromRow(twoWordRows[1]);
  second.phase.label = "Early Foundation";
  twoWordRows[1] = rowWithSource(twoWordRows[1], second);
  assert.equal(validateSuccessorStorySourcePackage(twoWordRows, evidenceRows).ok, true);

  const missingPhase = sourceFromRow(candidateRows[0]);
  delete missingPhase.phase;
  assert.equal(parseSuccessorStorySource(rowWithSource(candidateRows[0], missingPhase).summary), null);

  const genericPhase = sourceFromRow(candidateRows[0]);
  genericPhase.phase.label = "Other";
  assert.deepEqual(validateSuccessorStorySourcePackage(
    [rowWithSource(candidateRows[0], genericPhase)], evidenceRows,
  ), { ok: false, code: "SUCCESSOR_STORY_PHASE_INVALID" });

  const threeWords = sourceFromRow(candidateRows[0]);
  threeWords.phase.label = "Early Project Foundation";
  assert.deepEqual(validateSuccessorStorySourcePackage(
    [rowWithSource(candidateRows[0], threeWords)], evidenceRows,
  ), { ok: false, code: "SUCCESSOR_STORY_PHASE_INVALID" });

  const noncontiguous = candidateRows.map((row) => ({ ...row }));
  const middle = sourceFromRow(noncontiguous[1]);
  middle.phase = { id: "phase-setup-recovery", label: "Recovery" };
  noncontiguous[1] = rowWithSource(noncontiguous[1], middle);
  const last = sourceFromRow(noncontiguous[2]);
  last.phase = { id: "phase-setup-foundation", label: "Foundation" };
  noncontiguous[2] = rowWithSource(noncontiguous[2], last);
  assert.deepEqual(validateSuccessorStorySourcePackage(noncontiguous, evidenceRows), {
    ok: false,
    code: "SUCCESSOR_STORY_PHASE_ORDER_INVALID",
  });
});

test("successor source omits old drama, role, assistance, and current-state gates", () => {
  for (const fixture of storyFirstSemanticCases) {
    const { candidateRows, evidenceRows } = buildSuccessorFixture(fixture.id);
    for (const row of candidateRows) {
      const source = sourceFromRow(row);
      assert.equal(source.kind, undefined);
      assert.equal(source.narrativeReview, undefined);
      assert.equal(source.passageContext, undefined);
      assert.equal(source.mainProblem, undefined);
      assert.equal(source.finalAction, undefined);
      assert.equal(source.result, undefined);
    }
    assert.equal(validateSuccessorStorySourcePackage(candidateRows, evidenceRows).ok, true);
  }
});

test("successor traceability accounts for every allowed Evidence input", () => {
  const { candidateRows, evidenceRows } = buildSuccessorFixture("zero-insights");
  const source = sourceFromRow(candidateRows[0]);
  source.story.blocks.pop();
  assert.deepEqual(validateSuccessorStorySourcePackage(
    [rowWithSource(candidateRows[0], source)], evidenceRows,
  ), { ok: false, code: "SUCCESSOR_STORY_CONTEXT_RETENTION_INVALID" });

  const foreignBlockEvidence = sourceFromRow(candidateRows[0]);
  foreignBlockEvidence.story.blocks[0].evidence = [{ documentId: "fixture-zero-insights", eventId: "missing-record" }];
  assert.deepEqual(validateSuccessorStorySourcePackage(
    [rowWithSource(candidateRows[0], foreignBlockEvidence)], evidenceRows,
  ), { ok: false, code: "SUCCESSOR_STORY_EVIDENCE_INVALID" });
});

test("successor packages fail closed on mixed source versions", () => {
  const { candidateRows, evidenceRows } = buildSuccessorFixture("one-insight");
  const currentRow = {
    id: "current-row",
    documentId: "probe-document",
    summary: currentRuntimeProbe([currentInsight("probe-one")]),
  };
  assert.deepEqual(validateSuccessorStorySourcePackage(
    [...candidateRows, currentRow], evidenceRows,
  ), { ok: false, code: "SUCCESSOR_STORY_CHAPTER_INVALID" });
});

test("successor source remains staged outside current session, editor, and release consumers", async () => {
  const { candidateRows } = buildSuccessorFixture("one-insight");
  assert.deepEqual(selectReviewableStoryTimeline([{
    id: candidateRows[0].id,
    summary: candidateRows[0].summary,
  }]), []);

  const readOnlyConsumers = [
    "../lib/story-review.ts",
    "../lib/story-review-session.ts",
    "../lib/story-review-session-persistence.ts",
    "../lib/story-review-session-server.ts",
    "../app/story-chapter-editor.tsx",
    "../app/workspace.tsx",
    "../lib/story-release.ts",
    "../lib/story-release-server.ts",
    "../app/api/workflow/route.ts",
    "../app/api/organization/export/route.ts",
    "../app/api/package/route.ts",
  ];
  for (const path of readOnlyConsumers) {
    const source = await readFile(fileURLToPath(new URL(path, import.meta.url)), "utf8");
    assert.doesNotMatch(source, /oxygen\.story\/3|SUCCESSOR_STORY_PREFIX|parseSuccessorStorySource|validateSuccessorStorySourcePackage/, path);
  }
});

test("the fixture corpus is synthetic, public-safe, and free of release-visible private sentinels", () => {
  const encoded = JSON.stringify(storyFirstSemanticCases);
  assert.ok(storyFirstSemanticCases.every((fixture) => fixture.input.privacyState === "public_safe_synthetic"));
  assert.doesNotMatch(encoded, /(?:[A-Za-z]:\\|github\.com|oxygen-contributor|\bO2TechAI\b|BEGIN PRIVATE|\[REDACTED\])/i);
});
