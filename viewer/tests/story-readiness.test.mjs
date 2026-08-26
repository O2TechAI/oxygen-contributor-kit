import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { syntheticStoryEvents } from "./fixtures/synthetic-story-project.mjs";
import {
  selectReviewableStoryTimeline,
  validateStoryCandidatePackage,
} from "../lib/story-readiness.ts";
import { STORY_PREFIX } from "../lib/timeline.ts";
import {
  deriveWorkflowProgress,
  isStoryReviewReady,
  isStoryWorkspaceReady,
} from "../lib/workflow-progress.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const candidates = syntheticStoryEvents.map((event) => ({
  id: `${event.document_id}:${event.id}`,
  documentId: event.document_id,
  summary: event.summary,
}));
const evidence = syntheticStoryEvents.map((event) => ({
  id: `${event.document_id}:${event.id}`,
  documentId: event.document_id,
  eventType: event.event_type,
  actorId: event.actor_id,
  actorType: event.actor_type,
  sequence: event.sequence,
}));

function changedCandidates(changes) {
  const copy = candidates.map((candidate) => ({ ...candidate }));
  for (const [index, change] of changes) {
    const annotation = JSON.parse(copy[index].summary.slice(STORY_PREFIX.length));
    change(annotation);
    copy[index].summary = STORY_PREFIX + JSON.stringify(annotation);
  }
  return copy;
}

function changedCandidate(index, change) {
  return changedCandidates([[index, change]]);
}

function addParticipantProof(annotation, personId, reference) {
  annotation.narrativeReview.coverageLedger.participants.blockIds.push(`people:${personId}`);
  annotation.narrativeReview.coverageLedger.participants.evidence.push(reference);
  annotation.narrativeReview.claimTraceability.push({
    id: `claim-${annotation.key}-person-${personId}`,
    kind: "factual_claim",
    blockId: `people:${personId}`,
    evidence: [reference],
  });
}

function removeParticipantProof(annotation) {
  delete annotation.narrativeReview.coverageLedger;
  annotation.narrativeReview.claimTraceability = annotation.narrativeReview.claimTraceability
    .filter((claim) => !claim.blockId.startsWith("people:"));
}

function addJudgmentBlock(annotation, english, chinese, evidenceReference, includeTrace = true) {
  const index = annotation.reviewPresentation.en.story.reconstruction.length;
  const blockId = `reconstruction-${index}`;
  annotation.reviewPresentation.en.story.reconstruction.push(english);
  annotation.reviewPresentation.zh.story.reconstruction.push(chinese);
  annotation.releaseEpisode.reconstruction.push(english);
  annotation.reviewPresentation.en.passageContext[blockId] = {
    whatWasHappening: `A reviewed role recorded the next supported step for ${blockId}.`,
    whyItMattered: `The step changed the synthetic decision sequence associated with ${blockId}.`,
    whatWeLearned: `The reviewed comparison preserved a distinct judgment at ${blockId}.`,
    reusableLesson: `Retain a supported judgment when it changes the action at ${blockId}.`,
  };
  annotation.reviewPresentation.zh.passageContext[blockId] = {
    whatWasHappening: `已审阅角色记录了 ${blockId} 对应的下一项支持步骤。`,
    whyItMattered: `该步骤改变了 ${blockId} 对应的合成决策顺序。`,
    whatWeLearned: `已审阅比较保留了 ${blockId} 对应的独立判断。`,
    reusableLesson: `当支持的判断改变后续行动时，应保留 ${blockId} 对应内容。`,
  };
  annotation.narrativeReview.roles.evidenceThread.push(blockId);
  if (includeTrace) annotation.narrativeReview.claimTraceability.push({
    id: `claim-${annotation.key}-${blockId}`,
    kind: "factual_claim",
    blockId,
    evidence: [evidenceReference],
  });
  return blockId;
}

const reviewedFacts = (overrides = {}) => ({
  workflowRunId: "synthetic-ready-run",
  targetConfirmed: true,
  collectionStatus: "complete",
  collectionCompleted: 3,
  collectionTotal: 3,
  documentCount: 1,
  itemCount: 3,
  organizedItemCount: 3,
  organizationStatus: "complete",
  redactionStatus: "complete",
  storyGenerationStatus: "not_started",
  storyGenerationCompleted: 0,
  storyGenerationTotal: 0,
  updatedAt: "2031-03-12T00:00:00.000Z",
  ...overrides,
});

test("organization, fallback milestones, and partial generation stay on Build Project Story", () => {
  for (const status of ["not_started", "running", "blocked"]) {
    const progress = deriveWorkflowProgress(reviewedFacts({
      storyGenerationStatus: status,
      storyGenerationCompleted: status === "running" ? 1 : 0,
      storyGenerationTotal: status === "running" ? 3 : 0,
    }));
    assert.equal(progress.currentStageId, "story");
    assert.equal(isStoryReviewReady(progress), false);
  }
  const fallback = selectReviewableStoryTimeline([
    { id: "raw-organization-row", sequence: 1, summary: "A loose organization milestone", content: "A state changed after a routine operation." },
  ]);
  assert.deepEqual(fallback, []);
});

test("the complete package validator rejects partial Chapter structures and unresolved evidence", () => {
  assert.deepEqual(validateStoryCandidatePackage([], evidence), {
    ok: false, code: "STORY_CANDIDATE_MISSING",
  });
  assert.equal(validateStoryCandidatePackage([
    { ...candidates[0], summary: "oxygen.story-milestone/1:{}" },
  ], evidence).ok, false);

  const missingPassage = changedCandidate(0, (annotation) => {
    delete annotation.reviewPresentation.en.passageContext.scene;
  });
  assert.deepEqual(validateStoryCandidatePackage(missingPassage, evidence), {
    ok: false, code: "STORY_CHAPTER_INVALID",
  });

  const missingSummary = changedCandidate(0, (annotation) => {
    delete annotation.reviewPresentation.projectSummary;
  });
  assert.deepEqual(validateStoryCandidatePackage(missingSummary, evidence), {
    ok: false, code: "STORY_SUMMARY_MISSING",
  });

  const invalidPrivacy = changedCandidate(0, (annotation) => {
    annotation.reviewPresentation.en.privacy.candidates = [{ id: "partial" }];
  });
  assert.deepEqual(validateStoryCandidatePackage(invalidPrivacy, evidence), {
    ok: false, code: "STORY_CHAPTER_INVALID",
  });

  assert.deepEqual(validateStoryCandidatePackage(candidates, evidence.slice(1)), {
    ok: false, code: "STORY_EVIDENCE_UNRESOLVED",
  });
});

test("new Story candidates require fully qualified Evidence identities", () => {
  const unqualified = changedCandidate(0, (annotation) => {
    annotation.evidence.primary.eventId = "synthetic-evidence-alpha";
  });
  assert.deepEqual(validateStoryCandidatePackage(unqualified, evidence), {
    ok: false, code: "STORY_EVIDENCE_UNQUALIFIED",
  });

  const duplicateBareSuffix = evidence.concat({
    id: "other-reviewed-document:synthetic-evidence-alpha",
    documentId: "other-reviewed-document",
    eventType: "message",
    actorId: "other-speaker",
    actorType: "human",
  });
  assert.equal(validateStoryCandidatePackage(candidates, duplicateBareSuffix).ok, true);
});

test("only one final current-state Chapter can activate human review", () => {
  assert.equal(validateStoryCandidatePackage([candidates.at(-1)], evidence).ok, true);

  const missingCurrentState = changedCandidate(2, (annotation) => {
    annotation.kind = "validation";
  });
  assert.deepEqual(validateStoryCandidatePackage(missingCurrentState, evidence), {
    ok: false, code: "STORY_CURRENT_STATE_INVALID",
  });

  const currentStateInMiddle = changedCandidates([
    [0, (annotation) => { annotation.kind = "current_state"; }],
    [2, (annotation) => { annotation.kind = "validation"; }],
  ]);
  assert.deepEqual(validateStoryCandidatePackage(currentStateInMiddle, evidence), {
    ok: false, code: "STORY_CURRENT_STATE_INVALID",
  });

  const duplicateCurrentState = changedCandidate(0, (annotation) => {
    annotation.kind = "current_state";
  });
  assert.deepEqual(validateStoryCandidatePackage(duplicateCurrentState, evidence), {
    ok: false, code: "STORY_CURRENT_STATE_INVALID",
  });
});

test("malformed truthy Story fields fail closed without throwing", () => {
  const malformedCandidates = [
    changedCandidate(0, (annotation) => { annotation.title = 1; }),
    changedCandidate(0, (annotation) => { annotation.releaseEpisode.scene = { copy: "not text" }; }),
    changedCandidate(0, (annotation) => { annotation.releaseEpisode.readingTimeMinutes = "soon"; }),
    changedCandidate(0, (annotation) => { annotation.reviewPresentation.en.title = 1; }),
    changedCandidate(0, (annotation) => { annotation.reviewPresentation.en.privacy.summary = 1; }),
  ];
  for (const malformed of malformedCandidates) {
    assert.doesNotThrow(() => validateStoryCandidatePackage(malformed, evidence));
    assert.deepEqual(validateStoryCandidatePackage(malformed, evidence), {
      ok: false, code: "STORY_CHAPTER_INVALID",
    });
  }
});

test("activation requires a passed canonical-English self-review while localization remains non-blocking", () => {
  const missingReview = changedCandidate(0, (annotation) => {
    delete annotation.narrativeReview;
  });
  assert.deepEqual(validateStoryCandidatePackage(missingReview, evidence), {
    ok: false, code: "STORY_NARRATIVE_SELF_REVIEW_MISSING",
  });

  const repeatedPassage = changedCandidate(0, (annotation) => {
    annotation.reviewPresentation.en.passageContext.scene.whatWasHappening =
      annotation.reviewPresentation.en.story.scene;
  });
  assert.deepEqual(validateStoryCandidatePackage(repeatedPassage, evidence), {
    ok: false, code: "STORY_NARRATIVE_CONTRACT_FAILED",
  });

  const incompleteInterpretation = changedCandidate(0, (annotation) => {
    delete annotation.reviewPresentation.zh.passageContext.scene.whatWeLearned;
  });
  assert.equal(validateStoryCandidatePackage(incompleteInterpretation, evidence).ok, true);

  const numberedPassage = changedCandidate(0, (annotation) => {
    annotation.reviewPresentation.en.passageContext.scene.whatWasHappening =
      "This is semantic passage 1; it records an implementation detail.";
  });
  assert.deepEqual(validateStoryCandidatePackage(numberedPassage, evidence), {
    ok: false, code: "STORY_NARRATIVE_CONTRACT_FAILED",
  });

  const numberedPassageZh = changedCandidate(0, (annotation) => {
    annotation.reviewPresentation.zh.passageContext.scene.whatWasHappening =
      "这是本章第 1 个语义段落，记录了一项实现细节。";
  });
  assert.equal(validateStoryCandidatePackage(numberedPassageZh, evidence).ok, true);

  const englishOnly = changedCandidate(0, (annotation) => {
    delete annotation.reviewPresentation.zh;
    delete annotation.reviewPresentation.projectSummary.zh;
  });
  assert.equal(validateStoryCandidatePackage(englishOnly, evidence).ok, true);

  const genericTitle = changedCandidate(0, (annotation) => {
    annotation.title = "Project update";
    annotation.reviewPresentation.en.title = "Project update";
    annotation.reviewPresentation.zh.title = "项目更新";
  });
  assert.deepEqual(validateStoryCandidatePackage(genericTitle, evidence), {
    ok: false, code: "STORY_NARRATIVE_CONTRACT_FAILED",
  });
});

test("actor-bearing Chapters require evidence-supported People and reject fabricated aliases", () => {
  const missingPeople = changedCandidate(0, (annotation) => {
    annotation.reviewPresentation.en.people = [];
    annotation.reviewPresentation.zh.people = [];
    removeParticipantProof(annotation);
    annotation.narrativeReview.actorCoverage = {
      state: "people_present",
      personIds: ["calibration-owner"],
    };
  });
  assert.deepEqual(validateStoryCandidatePackage(missingPeople, evidence), {
    ok: false, code: "STORY_VALIDATION_FAILED",
  });

  const fabricated = changedCandidate(0, (annotation) => {
    for (const language of ["en", "zh"]) {
      annotation.reviewPresentation[language].people.push({
        id: "unsupported-second-person",
        releaseLabel: "B",
        role: language === "zh" ? "说话者 B" : "Speaker B",
        description: language === "zh" ? "没有独立角色证据。" : "Has no independent role evidence.",
        localIdentityState: "not_identified",
        evidence: [{
          documentId: "synthetic-reviewed-document",
          eventId: "synthetic-reviewed-document:synthetic-evidence-alpha",
        }],
      });
    }
    annotation.narrativeReview.actorCoverage.personIds.push("unsupported-second-person");
    addJudgmentBlock(
      annotation,
      "Speaker B recorded a second claim without independent actor provenance.",
      "说话者 B 记录了缺少独立角色来源的第二项主张。",
      annotation.evidence.primary,
    );
  });
  assert.deepEqual(validateStoryCandidatePackage(fabricated, evidence), {
    ok: false, code: "STORY_PEOPLE_EVIDENCE_INVALID",
  });

  const mergedActors = changedCandidate(0, (annotation) => {
    const secondActor = {
      documentId: "synthetic-reviewed-document",
      eventId: "synthetic-reviewed-document:synthetic-evidence-beta",
    };
    annotation.evidence.supporting.push(secondActor);
    for (const language of ["en", "zh"]) {
      annotation.reviewPresentation[language].people[0].evidence.push(secondActor);
    }
  });
  assert.deepEqual(validateStoryCandidatePackage(mergedActors, evidence), {
    ok: false, code: "STORY_PEOPLE_EVIDENCE_INVALID",
  });
});

test("People must participate in Decision process without invented generic interaction", () => {
  const missingInteraction = changedCandidate(1, (annotation) => {
    annotation.reviewPresentation.en.story.reconstruction = [
      "A controlled trial separated temperature drift from device-to-device noise.",
    ];
    annotation.reviewPresentation.zh.story.reconstruction = [
      "对照试验把温度漂移与设备间噪声区分开来。",
    ];
    annotation.releaseEpisode.reconstruction = [...annotation.reviewPresentation.en.story.reconstruction];
  });
  assert.deepEqual(validateStoryCandidatePackage(missingInteraction, evidence), {
    ok: false, code: "STORY_NARRATIVE_CONTRACT_FAILED",
  });
});

test("Decision process may express a supported relationship through natural syntax without a connective allowlist", () => {
  const naturalRelationship = changedCandidate(1, (annotation) => {
    annotation.reviewPresentation.en.story.reconstruction = [
      "The field technician's report prompted the calibration owner to replace the validation plan with a controlled trial.",
    ];
    annotation.releaseEpisode.reconstruction = [...annotation.reviewPresentation.en.story.reconstruction];
  });
  assert.equal(validateStoryCandidatePackage(naturalRelationship, evidence).ok, true);
});

test("English participant roles require complete phrase matches in Decision process", () => {
  const substringOnlyRole = changedCandidate(0, (annotation) => {
    annotation.reviewPresentation.en.story.reconstruction = [
      "Calibration ownership established the comparison boundary. Therefore, the next action changed.",
    ];
    annotation.releaseEpisode.reconstruction = [...annotation.reviewPresentation.en.story.reconstruction];
  });
  assert.deepEqual(validateStoryCandidatePackage(substringOnlyRole, evidence), {
    ok: false, code: "STORY_NARRATIVE_CONTRACT_FAILED",
  });
});

test("meeting and coding trajectories retain supported roles, uncertainty, and safe aliases", () => {
  assert.equal(validateStoryCandidatePackage(candidates, evidence).ok, true);
  const codingTrajectory = changedCandidate(0, (annotation) => {
    const agentReference = {
      documentId: "synthetic-reviewed-document",
      eventId: "synthetic-reviewed-document:synthetic-agent-action",
    };
    annotation.evidence.supporting.push(agentReference);
    annotation.narrativeReview.contextRetention.sourceScope.push(agentReference);
    for (const language of ["en", "zh"]) {
      annotation.reviewPresentation[language].people[0].releaseLabel = "Speaker A";
      annotation.reviewPresentation[language].people[0].role = language === "zh" ? "项目负责人" : "Project owner";
      annotation.reviewPresentation[language].people[0].localIdentityState = "local_only";
      annotation.reviewPresentation[language].people.push({
        id: "implementation-agent",
        releaseLabel: "Implementation agent",
        role: language === "zh" ? "实施 Agent" : "Implementation agent",
        description: language === "zh" ? "根据已审阅指令执行更改。" : "Applied changes from the reviewed instruction.",
        localIdentityState: "not_identified",
        evidence: [agentReference],
      });
    }
    annotation.narrativeReview.actorCoverage.personIds = ["calibration-owner", "implementation-agent"];
    addParticipantProof(annotation, "implementation-agent", agentReference);
    addJudgmentBlock(
      annotation,
      "The Project owner defined the reviewed instruction and its boundary.",
      "项目负责人明确了已审阅指令及其边界。",
      annotation.evidence.primary,
    );
    addJudgmentBlock(
      annotation,
      "The Implementation agent applied the reviewed instruction and reported the resulting state.",
      "实施 Agent 执行了已审阅指令，并报告了结果状态。",
      agentReference,
    );
  });
  const codingEvidence = evidence.map((row) => row.id.endsWith("synthetic-evidence-alpha") ? {
    ...row, eventType: "message", actorId: "project-owner", actorType: "user",
  } : row).concat({
    id: "synthetic-reviewed-document:synthetic-agent-action",
    documentId: "synthetic-reviewed-document",
    eventType: "message",
    actorId: "implementation-agent",
    actorType: "assistant",
  });
  assert.equal(validateStoryCandidatePackage(codingTrajectory, codingEvidence).ok, true);

  const reviewedCorrection = changedCandidate(2, (annotation) => {
    const implementationReference = {
      documentId: "synthetic-reviewed-document",
      eventId: "synthetic-reviewed-document:synthetic-correction-action",
    };
    annotation.evidence.supporting.push(implementationReference);
    annotation.narrativeReview.contextRetention.sourceScope.push(implementationReference);
    for (const language of ["en", "zh"]) {
      annotation.reviewPresentation[language].people.push({
        id: "correction-agent",
        releaseLabel: "Implementation agent",
        role: language === "zh" ? "实施 Agent" : "Implementation agent",
        description: language === "zh" ? "根据审阅意见修正了实现。" : "Corrected the implementation after review.",
        localIdentityState: "not_identified",
        evidence: [implementationReference],
      });
    }
    annotation.narrativeReview.actorCoverage.personIds.push("correction-agent");
    addParticipantProof(annotation, "correction-agent", implementationReference);
    addJudgmentBlock(
      annotation,
      "The Implementation agent corrected the implementation after the Reviewer identified the issue.",
      "审阅者指出问题后，实施 Agent 修正了实现。",
      implementationReference,
    );
  });
  const correctionEvidence = evidence.concat({
    id: "synthetic-reviewed-document:synthetic-correction-action",
    documentId: "synthetic-reviewed-document",
    eventType: "message",
    actorId: "correction-agent",
    actorType: "assistant",
  });
  assert.equal(validateStoryCandidatePackage(reviewedCorrection, correctionEvidence).ok, true);
});

test("routine machine-only events cannot become Chapters, but actor response may use them as support", () => {
  const machineOnly = changedCandidate(2, (annotation) => {
    annotation.reviewPresentation.en.people = [];
    annotation.reviewPresentation.zh.people = [];
    removeParticipantProof(annotation);
    delete annotation.narrativeReview.actorCoverage;
  });
  const machineEvidence = evidence.map((row) => row.id.endsWith("synthetic-evidence-gamma") ? {
    ...row, eventType: "action_label", actorId: "validation-tool", actorType: "tool",
  } : row);
  assert.deepEqual(validateStoryCandidatePackage(machineOnly, machineEvidence), {
    ok: false, code: "STORY_VALIDATION_FAILED",
  });

  const diagnosedFailure = changedCandidate(2, (annotation) => {
    const machineReference = {
      documentId: "synthetic-reviewed-document",
      eventId: "synthetic-reviewed-document:synthetic-machine-failure",
    };
    annotation.evidence.supporting.push(machineReference);
    const retention = annotation.narrativeReview.contextRetention;
    const unitId = "source-unit-diagnosed-machine-failure";
    retention.sourceScope.push(machineReference);
    retention.sourceUnitCount += 1;
    retention.representedUnitCount += 1;
    retention.units.push({
      id: unitId,
      kind: "failure",
      evidence: machineReference,
      state: "represented",
      blockIds: ["detail-0"],
    });
    const detailClaim = annotation.narrativeReview.claimTraceability
      .find((claim) => claim.blockId === "detail-0");
    detailClaim.evidence.push(machineReference);
    detailClaim.unitIds.push(unitId);
  });
  const diagnosisEvidence = evidence.concat({
    id: "synthetic-reviewed-document:synthetic-machine-failure",
    documentId: "synthetic-reviewed-document",
    eventType: "action_label",
    actorId: "validation-tool",
    actorType: "tool",
  });
  assert.equal(validateStoryCandidatePackage(diagnosedFailure, diagnosisEvidence).ok, true);
});

test("activation rejects prohibited editorial formulas even when self-review claims success", () => {
  const contrastFormula = changedCandidate(0, (annotation) => {
    annotation.reviewPresentation.en.story.scene = "The group repaired the environment, not the reviewed data.";
    annotation.releaseEpisode.scene = annotation.reviewPresentation.en.story.scene;
  });
  assert.deepEqual(validateStoryCandidatePackage(contrastFormula, evidence), {
    ok: false, code: "STORY_NARRATIVE_CONTRACT_FAILED",
  });

  const boilerplate = changedCandidate(0, (annotation) => {
    annotation.reviewPresentation.zh.passageContext.scene.whatWeLearned = "这段文字表明应当检查证据。";
  });
  assert.equal(validateStoryCandidatePackage(boilerplate, evidence).ok, true);
});

test("a complex Chapter can retain several connected judgment moments without a sentence ceiling", () => {
  const complex = changedCandidate(1, (annotation) => {
    const primary = annotation.evidence.primary;
    const alternative = addJudgmentBlock(
      annotation,
      "The calibration owner proposed a wider uncontrolled sample as the first option.",
      "校准负责人首先提出扩大非受控样本。",
      primary,
    );
    const objection = addJudgmentBlock(
      annotation,
      "The field technician questioned that option because temperature still varied across readings.",
      "现场技术员指出，该方案中的温度仍会随读数变化。",
      primary,
    );
    const correction = addJudgmentBlock(
      annotation,
      "The calibration owner narrowed the next test to one controlled temperature range.",
      "校准负责人随后把下一项测试限定在一个受控温度范围内。",
      primary,
    );
    annotation.narrativeReview.coverageLedger.alternatives = {
      state: "represented", blockIds: [alternative], evidence: [primary],
    };
    annotation.narrativeReview.coverageLedger.objectionOrDisagreement = {
      state: "represented", blockIds: [objection], evidence: [primary],
    };
    annotation.narrativeReview.coverageLedger.correction = {
      state: "represented", blockIds: [correction], evidence: [primary],
    };
    annotation.reviewPresentation.en.highlights[0].noticed = [
      "The initial sample mixed operating temperatures.",
      "The calibration owner proposed a wider sample.",
      "The field technician identified the uncontrolled variable.",
      "A controlled trial isolated temperature.",
      "The measured swing exceeded the prior assumption.",
      "The validation plan changed.",
      "The revised plan retained comparable readings.",
      "The evidence bounded the conclusion.",
      "The holdout remained unresolved.",
    ].join(" ");
    annotation.reviewPresentation.zh.highlights[0].noticed = [
      "初始样本混合了不同运行温度。",
      "校准负责人提出扩大样本。",
      "现场技术员指出未受控变量。",
      "对照试验隔离了温度。",
      "测得波动超过原有假设。",
      "验证计划因此改变。",
      "修订后的计划保留了可比较读数。",
      "证据限定了结论范围。",
      "留出验证仍未完成。",
    ].join("");
  });
  assert.equal(validateStoryCandidatePackage(complex, evidence).ok, true);
});

test("supported judgment coverage cannot point to an untraced Story claim", () => {
  const omittedObjection = changedCandidate(1, (annotation) => {
    annotation.narrativeReview.coverageLedger.objectionOrDisagreement = {
      state: "represented",
      blockIds: ["detail-0"],
      evidence: [annotation.evidence.supporting[0]],
    };
  });
  assert.deepEqual(validateStoryCandidatePackage(omittedObjection, evidence), {
    ok: false, code: "STORY_JUDGMENT_COVERAGE_INVALID",
  });
});

test("supported explanatory context cannot be hidden as supporting detail", () => {
  const compressedFailure = changedCandidate(1, (annotation) => {
    annotation.narrativeReview.coverageLedger.failedAttempt = {
      state: "supporting_detail",
      evidence: [annotation.evidence.primary],
      justification: "The failed attempt was left outside the visible Chapter.",
    };
  });
  assert.deepEqual(validateStoryCandidatePackage(compressedFailure, evidence), {
    ok: false, code: "STORY_CONTEXT_RETENTION_INVALID",
  });
});

test("context retention proves distinct source units even when they share one Evidence event", () => {
  const annotation = JSON.parse(candidates[0].summary.slice(STORY_PREFIX.length));
  const retention = annotation.narrativeReview.contextRetention;
  assert.equal(retention.sourceScope.length, 1);
  assert.equal(retention.sourceUnitCount, 2);
  assert.equal(retention.representedUnitCount, 2);
  assert.equal(new Set(retention.units.map((unit) => unit.id)).size, 2);
  assert.equal(new Set(retention.units.map((unit) => unit.evidence.eventId)).size, 1);
  assert.equal(validateStoryCandidatePackage(candidates, evidence).ok, true);
});

test("context retention scope equals the complete required Chapter Evidence set", () => {
  const missingPrimary = changedCandidate(1, (annotation) => {
    annotation.narrativeReview.contextRetention.sourceScope = [annotation.evidence.supporting[0]];
  });
  assert.deepEqual(validateStoryCandidatePackage(missingPrimary, evidence), {
    ok: false, code: "STORY_CONTEXT_RETENTION_INVALID",
  });

  const missingSupporting = changedCandidate(1, (annotation) => {
    annotation.narrativeReview.contextRetention.sourceScope = [annotation.evidence.primary];
  });
  assert.deepEqual(validateStoryCandidatePackage(missingSupporting, evidence), {
    ok: false, code: "STORY_CONTEXT_RETENTION_INVALID",
  });

  const unrelatedReference = {
    documentId: "synthetic-support-document",
    eventId: "synthetic-support-document:unrelated-event",
  };
  const unrelatedEvidence = evidence.concat({
    id: unrelatedReference.eventId,
    documentId: unrelatedReference.documentId,
    eventType: "artifact",
    actorId: null,
    actorType: "system",
  });
  const extraUnrelated = changedCandidate(0, (annotation) => {
    annotation.evidence.supporting.push(unrelatedReference);
    annotation.narrativeReview.contextRetention.sourceScope.push(unrelatedReference);
  });
  assert.deepEqual(validateStoryCandidatePackage(extraUnrelated, unrelatedEvidence), {
    ok: false, code: "STORY_CONTEXT_RETENTION_INVALID",
  });
});

test("qualified multi-document supporting Evidence can satisfy complete scope equality", () => {
  const supportingReference = {
    documentId: "synthetic-support-document",
    eventId: "synthetic-support-document:decision-context",
  };
  const multiDocumentEvidence = evidence.concat({
    id: supportingReference.eventId,
    documentId: supportingReference.documentId,
    eventType: "artifact",
    actorId: null,
    actorType: "system",
  });
  const multiDocument = changedCandidate(0, (annotation) => {
    const retention = annotation.narrativeReview.contextRetention;
    const unitId = "source-unit-multi-document-context";
    annotation.evidence.supporting.push(supportingReference);
    retention.sourceScope.push(supportingReference);
    retention.sourceUnitCount += 1;
    retention.representedUnitCount += 1;
    retention.units.push({
      id: unitId,
      kind: "decision",
      evidence: supportingReference,
      state: "represented",
      blockIds: ["detail-0"],
    });
    annotation.narrativeReview.claimTraceability.push({
      id: "claim-multi-document-context",
      kind: "factual_claim",
      blockId: "detail-0",
      evidence: [supportingReference],
      unitIds: [unitId],
    });
  });

  assert.equal(validateStoryCandidatePackage(multiDocument, multiDocumentEvidence).ok, true);
});

test("context retention is mandatory and every represented unit must own a traced Story block", () => {
  const missingLedger = changedCandidate(0, (annotation) => {
    delete annotation.narrativeReview.contextRetention;
  });
  assert.deepEqual(validateStoryCandidatePackage(missingLedger, evidence), {
    ok: false, code: "STORY_CONTEXT_RETENTION_INVALID",
  });

  const missingUnitTrace = changedCandidate(0, (annotation) => {
    annotation.narrativeReview.claimTraceability
      .find((claim) => claim.blockId === "scene").unitIds = [];
  });
  assert.deepEqual(validateStoryCandidatePackage(missingUnitTrace, evidence), {
    ok: false, code: "STORY_CHAPTER_INVALID",
  });

  const forgedUnitTrace = changedCandidate(0, (annotation) => {
    annotation.narrativeReview.claimTraceability
      .find((claim) => claim.blockId === "scene").unitIds = ["source-unit-forged"];
  });
  assert.deepEqual(validateStoryCandidatePackage(forgedUnitTrace, evidence), {
    ok: false, code: "STORY_CONTEXT_RETENTION_INVALID",
  });
});

test("only fixed privacy-safe reasons may exclude a classified source unit", () => {
  const allowedExclusion = changedCandidate(0, (annotation) => {
    const retention = annotation.narrativeReview.contextRetention;
    retention.sourceUnitCount += 2;
    retention.excludedUnitCount += 2;
    retention.units.push(
      {
        id: "source-unit-calibration-duplicate",
        kind: "response",
        evidence: annotation.evidence.primary,
        state: "excluded",
        reason: "duplicate",
      },
      {
        id: "source-unit-calibration-routine",
        kind: "progress",
        evidence: annotation.evidence.primary,
        state: "excluded",
        reason: "routine_status",
      },
    );
  });
  assert.equal(validateStoryCandidatePackage(allowedExclusion, evidence).ok, true);

  const inventedReason = changedCandidate(0, (annotation) => {
    const retention = annotation.narrativeReview.contextRetention;
    retention.sourceUnitCount += 1;
    retention.excludedUnitCount += 1;
    retention.units.push({
      id: "source-unit-calibration-concise",
      kind: "response",
      evidence: annotation.evidence.primary,
      state: "excluded",
      reason: "too_long",
    });
  });
  assert.deepEqual(validateStoryCandidatePackage(inventedReason, evidence), {
    ok: false, code: "STORY_CHAPTER_INVALID",
  });
});

test("Privacy-withheld source units stay excluded without expanding Chapter Evidence scope", () => {
  const withheldReference = {
    documentId: "synthetic-private-boundary",
    eventId: "synthetic-private-boundary:withheld-unit",
  };
  const localEvidence = evidence.concat({
    id: withheldReference.eventId,
    documentId: withheldReference.documentId,
    eventType: "record",
    actorId: "withheld-actor",
    actorType: "human",
  });
  const privacyWithheld = changedCandidate(0, (annotation) => {
    const retention = annotation.narrativeReview.contextRetention;
    retention.sourceUnitCount += 1;
    retention.excludedUnitCount += 1;
    retention.units.push({
      id: "source-unit-privacy-withheld",
      kind: "response",
      evidence: withheldReference,
      state: "excluded",
      reason: "privacy_withheld",
    });
  });
  const annotation = JSON.parse(privacyWithheld[0].summary.slice(STORY_PREFIX.length));
  assert.ok(!annotation.narrativeReview.contextRetention.sourceScope.some(
    (reference) => reference.eventId === withheldReference.eventId,
  ));
  assert.equal(validateStoryCandidatePackage(privacyWithheld, localEvidence).ok, true);
});

test("Chapter overviews are specific, unique, and Evidence-traced summaries", () => {
  const navigationPrompt = changedCandidate(0, (annotation) => {
    annotation.reviewPresentation.en.overview = "Open this Chapter for the complete reviewed decision sequence.";
    annotation.reviewPresentation.zh.overview = "打开本章可查看完整的已审阅决策过程。";
  });
  assert.deepEqual(validateStoryCandidatePackage(navigationPrompt, evidence), {
    ok: false, code: "STORY_CHAPTER_OVERVIEW_INVALID",
  });

  const duplicateOverview = changedCandidate(1, (annotation) => {
    const first = JSON.parse(candidates[0].summary.slice(STORY_PREFIX.length));
    annotation.reviewPresentation.en.overview = first.reviewPresentation.en.overview;
    annotation.reviewPresentation.zh.overview = first.reviewPresentation.zh.overview;
  });
  assert.deepEqual(validateStoryCandidatePackage(duplicateOverview, evidence), {
    ok: false, code: "STORY_CHAPTER_OVERVIEW_INVALID",
  });

  const untracedOverview = changedCandidate(0, (annotation) => {
    annotation.narrativeReview.claimTraceability = annotation.narrativeReview.claimTraceability
      .filter((claim) => claim.blockId !== "overview");
  });
  assert.deepEqual(validateStoryCandidatePackage(untracedOverview, evidence), {
    ok: false, code: "STORY_CLAIM_TRACEABILITY_INVALID",
  });
});

test("every added factual Story block needs explicit reviewed-Evidence traceability", () => {
  const unsupportedClaim = changedCandidate(0, (annotation) => {
    addJudgmentBlock(
      annotation,
      "A second unsupported assertion was added to the synthetic decision process.",
      "合成决策过程新增了第二项未支持断言。",
      annotation.evidence.primary,
      false,
    );
  });
  assert.deepEqual(validateStoryCandidatePackage(unsupportedClaim, evidence), {
    ok: false, code: "STORY_CLAIM_TRACEABILITY_INVALID",
  });
});

test("Open questions may be absent, while generic structural filler still fails readiness", () => {
  const resolved = changedCandidate(0, (annotation) => {
    for (const language of ["en", "zh"]) {
      delete annotation.reviewPresentation[language].story.uncertainty;
      delete annotation.reviewPresentation[language].passageContext.uncertainty;
    }
    delete annotation.releaseEpisode.uncertainty;
    annotation.narrativeReview.roles.openTension = { state: "not_supported", blockIds: [] };
    annotation.narrativeReview.coverageLedger.remainingUncertainty = { state: "not_supported" };
    annotation.narrativeReview.claimTraceability = annotation.narrativeReview.claimTraceability
      .filter((claim) => claim.blockId !== "uncertainty");
    for (const unit of annotation.narrativeReview.contextRetention.units) {
      if (unit.state === "represented") {
        unit.blockIds = unit.blockIds.filter((blockId) => blockId !== "uncertainty");
      }
    }
  });
  assert.equal(validateStoryCandidatePackage(resolved, evidence).ok, true);

  const filler = changedCandidate(0, (annotation) => {
    annotation.reviewPresentation.en.story.scene = "The team was working on the project.";
    annotation.releaseEpisode.scene = annotation.reviewPresentation.en.story.scene;
  });
  assert.deepEqual(validateStoryCandidatePackage(filler, evidence), {
    ok: false, code: "STORY_NARRATIVE_CONTRACT_FAILED",
  });
});

test("an unresolved cause remains a supported open question", () => {
  const unresolved = changedCandidate(2, (annotation) => {
    annotation.reviewPresentation.en.story.uncertainty = "Cause not determined.";
    annotation.reviewPresentation.zh.story.uncertainty = "原因尚未确定。";
    annotation.releaseEpisode.uncertainty = annotation.reviewPresentation.en.story.uncertainty;
  });
  assert.equal(validateStoryCandidatePackage(unresolved, evidence).ok, true);
});

test("Phase activation rejects fallback labels and incoherent grouping without forcing a count", () => {
  const fallbackPhase = changedCandidate(0, (annotation) => {
    annotation.phase = "Project evolution";
    annotation.reviewPresentation.en.phase = "Project evolution";
    annotation.reviewPresentation.zh.phase = "项目演进";
  });
  assert.deepEqual(validateStoryCandidatePackage(fallbackPhase, evidence), {
    ok: false, code: "STORY_PHASE_QUALITY_INVALID",
  });

  const incoherentPhase = changedCandidate(1, (annotation) => {
    annotation.narrativeReview.phase.rationale = "A different explanation for the same named Phase.";
  });
  assert.deepEqual(validateStoryCandidatePackage(incoherentPhase, evidence), {
    ok: false, code: "STORY_PHASE_QUALITY_INVALID",
  });

  const oneCoherentPhase = candidates.map((candidate) => {
    const copy = { ...candidate };
    const annotation = JSON.parse(copy.summary.slice(STORY_PREFIX.length));
    annotation.phase = "Calibration Gate";
    annotation.reviewPresentation.en.phase = "Calibration Gate";
    annotation.reviewPresentation.zh.phase = "校准门槛";
    annotation.narrativeReview.phase.rationale =
      "Unify calibration evidence and its release gate as one coherent decision class.";
    copy.summary = STORY_PREFIX + JSON.stringify(annotation);
    return copy;
  });
  assert.equal(validateStoryCandidatePackage(oneCoherentPhase, evidence).ok, true);
});

test("ordered explicit Phases and one complete canonical English Chapter per milestone activate atomically", () => {
  const firstPhase = JSON.parse(candidates[0].summary.slice(STORY_PREFIX.length));
  const finalPhase = JSON.parse(candidates[2].summary.slice(STORY_PREFIX.length));
  const invalidOrder = changedCandidate(1, (annotation) => {
    annotation.phase = finalPhase.phase;
    annotation.reviewPresentation.en.phase = finalPhase.reviewPresentation.en.phase;
    annotation.reviewPresentation.zh.phase = finalPhase.reviewPresentation.zh.phase;
    annotation.narrativeReview.phase.rationale = finalPhase.narrativeReview.phase.rationale;
  });
  const lastAnnotation = JSON.parse(invalidOrder[2].summary.slice(STORY_PREFIX.length));
  lastAnnotation.phase = firstPhase.phase;
  lastAnnotation.reviewPresentation.en.phase = firstPhase.reviewPresentation.en.phase;
  lastAnnotation.reviewPresentation.zh.phase = firstPhase.reviewPresentation.zh.phase;
  lastAnnotation.narrativeReview.phase.rationale = firstPhase.narrativeReview.phase.rationale;
  invalidOrder[2].summary = STORY_PREFIX + JSON.stringify(lastAnnotation);
  assert.deepEqual(validateStoryCandidatePackage(invalidOrder, evidence), {
    ok: false, code: "STORY_PHASE_ORDER_INVALID",
  });

  const validation = validateStoryCandidatePackage(candidates, evidence);
  assert.equal(validation.ok, true);
  assert.equal(validation.chapterCount, syntheticStoryEvents.length);
  const milestones = selectReviewableStoryTimeline(syntheticStoryEvents);
  assert.equal(milestones.length, syntheticStoryEvents.length);
  assert.ok(milestones.every((milestone) => milestone.story.explicit));

  const ready = deriveWorkflowProgress(reviewedFacts({
    storyGenerationStatus: "ready_for_human_review",
    storyGenerationCompleted: milestones.length,
    storyGenerationTotal: milestones.length,
  }));
  assert.equal(ready.currentStageId, "review");
  assert.equal(ready.requiresHumanAction, true);
  assert.equal(isStoryReviewReady(ready), true);
  assert.equal(isStoryReviewReady({ ...ready, currentStageId: "story" }), false);
  assert.equal(isStoryReviewReady({ ...ready, requiresHumanAction: false }), false);

  const hydrated = {
    storyDataReadyRunId: ready.workflowRunId,
    storySessionReadyRunId: ready.workflowRunId,
    documentCount: 1,
    organizationStatus: "complete",
  };
  assert.equal(isStoryWorkspaceReady(ready, hydrated), true);
  assert.equal(isStoryWorkspaceReady(ready, { ...hydrated, storyDataReadyRunId: "" }), false);
  assert.equal(isStoryWorkspaceReady(ready, { ...hydrated, storySessionReadyRunId: "" }), false);
  assert.equal(isStoryWorkspaceReady(ready, { ...hydrated, documentCount: 0 }), false);
  assert.equal(isStoryWorkspaceReady(ready, { ...hydrated, organizationStatus: "running" }), false);
});

test("refresh, direct navigation, activation, and progress remain persisted and fail closed", async () => {
  const [workspace, page, workflowRoute, workflowLoader, sessionRoute, sessionServer, database] = await Promise.all([
    read("../app/workspace.tsx"),
    read("../app/page.tsx"),
    read("../app/api/workflow/route.ts"),
    read("../lib/workflow-progress-server.ts"),
    read("../app/api/story-review-session/route.ts"),
    read("../lib/story-review-session-server.ts"),
    read("../db/index.ts"),
  ]);
  assert.match(workspace, /const storyReviewReady = isStoryReviewReady\(workflow\)/);
  assert.match(workspace, /const storyWorkspaceReady = isStoryWorkspaceReady\(workflow/);
  assert.match(workspace, /if \(!storyWorkspaceReady\)[\s\S]*return <WorkflowProgress/);
  assert.match(workspace, /const activatedStoryHighlights = selectReviewableStoryTimeline\(allHighlights\)/);
  assert.match(workspace, /const storyPackageReloadKeyRef = useRef\(""\)/);
  assert.match(workspace, /previously loaded organization snapshot can finish after the exact-run/);
  assert.match(workspace, /const availableProjects = new Set[\s\S]*availableProjects\.has\(currentProject\)/);
  assert.match(workspace, /view === "timeline"[\s\S]*selectedHydrationHighlights\.length === 0/);
  assert.match(workspace, /if \(!cancelled && nextHighlights\.length === 0\)/);
  assert.match(workspace, /if \(!activatedStoryHighlights\.length[\s\S]*view === "timeline" && !highlights\.length/);
  assert.doesNotMatch(workspace, /if \(!highlights\.length \|\| storySessionReadyRunId !== workflowRunId\)/);
  assert.match(workspace, /selectReviewableStoryTimeline/);
  assert.doesNotMatch(workspace, /if \(!docs\.length \|\| !status/);
  assert.match(workspace, /useState<WorkflowProgressState>\(initialWorkflow\)/);
  assert.match(page, /await loadWorkspaceBootstrap\(\)/);
  assert.match(page, /initialWorkflow=\{initial\.workflow\}/);
  assert.match(page, /initialDocuments=\{initial\.documents\}/);
  assert.match(workflowLoader, /deriveWorkflowProgress/);
  assert.match(workflowLoader, /if \(!isStoryReviewReady\(workflow\)\)/);
  assert.match(workflowLoader, /storySessionReadyRunId: ready \? workflow\.workflowRunId : ""/);
  assert.match(workflowLoader, /Promise\.all/);
  assert.doesNotMatch(workflowLoader, /SELECT\s+content|original_json|reasoning|prompt|tool.?arg/i);
  assert.match(database, /story_generation_status TEXT NOT NULL DEFAULT 'not_started'/);
  assert.match(database, /active_story_digest TEXT/);
  assert.match(workflowRoute, /validateStoryCandidatePackage/);
  assert.match(workflowRoute, /story_source_revision=\?/);
  assert.match(workflowRoute, /story_generation_status='ready_for_human_review'/);
  assert.match(workflowRoute, /Cache-Control": "no-store, max-age=0"/);
  assert.match(workflowRoute, /loadWorkflowProgress\(requestedRunId \|\| undefined\)/);
  assert.match(sessionServer, /story_generation_status/);
  assert.match(sessionRoute, /Story review is not ready/);
  assert.doesNotMatch(workflowRoute, /SELECT\s+content|original_json|reasoning|prompt|tool.?arg|private.?message/i);
  assert.match(workspace, /const loadActivatedStory = async/);
  assert.match(workspace, /throw organizationRequestError\("Organization could not be prepared", \{ status: response\.status \}\)/);
  assert.match(workspace, /requestOrganization: fetchOrganizationStatus/);
  assert.match(workspace, /setStoryDataReadyRunId\(workflowRunId\)/);
  assert.match(workspace, /storyDataReadyRunId !== workflowRunId/);
});
