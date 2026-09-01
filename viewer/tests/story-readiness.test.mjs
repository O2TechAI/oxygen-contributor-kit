import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { testStoryCoverage } from "./fixtures/story-coverage.mjs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  STORY_PREFIX,
  parseStorySource,
} from "../lib/timeline.ts";
import { validateStorySourcePackage } from "../lib/story-readiness.ts";
import { storyFirstSemanticCases } from "./fixtures/story-first-semantic-cases.mjs";
import {
  storyFirstSemanticExpectations,
  storyLifecycleCases,
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

const evidenceReference = (documentId, eventId) => ({ documentId, eventId });
const opaqueActorId = (value) => `actor-${createHash("sha256").update(value).digest("hex")}`;

function buildStoryFixture(caseId) {
  const fixture = storyFirstSemanticCases.find((item) => item.id === caseId);
  const expectation = storyFirstSemanticExpectations.find((item) => item.caseId === caseId);
  const documentId = `fixture-${caseId}`;
  const records = new Map(fixture.input.records.map((item) => [item.id, item]));
  const evidenceRows = fixture.input.records.map((item) => ({
    id: item.id,
    documentId,
    eventType: "message",
    actorId: opaqueActorId(item.actorId),
    actorType: "human",
    reviewedNarrative: item.text,
  }));
  const candidateRows = expectation.chapters.map((chapterItem, index) => {
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
    schema: "oxygen.story",
    language: "en",
    languagePolicyDigest: "f".repeat(64),
      key: chapterItem.id,
      phase: { id: phase.id, label: phase.label },
      title: fixture.title,
      overview: `${fixture.input.projectLabel} retains this supported synthetic narrative arc.`,
      people: chapterItem.people.map((personItem) => ({
        id: personItem.id,
        releaseLabel: personItem.id,
        role: personItem.id.replace(/^person-/, "").replaceAll("-", " "),
        description: `In this Chapter, the recorded involvement was: ${
          records.get(personItem.recordIds[0]).text
        }`,
        localIdentityState: "not_identified",
        evidence: personItem.recordIds.map((recordId) => evidenceReference(documentId, recordId)),
      })),
      story: { blocks },
      insights: chapterItem.insights.map((item) => {
        const anchoredEvidence = [...new Map(item.background.supportingStoryBlockIds.flatMap((blockId) => (
          blocks.find((block) => block.id === blockId).evidence
        )).map((reference) => [JSON.stringify(reference), reference])).values()];
        const anchorStoryBlockId = item.anchorStoryBlockId;
        const quoteEvidence = blocks.find((block) => block.id === anchorStoryBlockId).evidence[0];
        return {
          id: item.id,
          background: item.background.requiredConcepts.join("; "),
          anchorStoryBlockId,
          quote: {
            text: records.get(quoteEvidence.eventId).text,
            evidence: quoteEvidence,
          },
          directlyAcquiredExperience: item.directlyAcquiredExperience.requiredConcepts.join("; "),
          principle: `When ${item.principle.requiredCondition}, ${item.principle.requiredResponse}, because ${item.principle.boundedReason}.`,
          evidence: anchoredEvidence,
        };
      }),
      evidence: {
        primary: evidenceReference(documentId, chapterRecordIds[0]),
        supporting: chapterRecordIds.slice(1).map((recordId) => evidenceReference(documentId, recordId)),
      },
      coverage: testStoryCoverage({ representedUnitIds: [`unit-${index + 1}`] }),
    };
    return {
      id: chapterRecordIds[0],
      documentId,
      sequence: index + 1,
      summary: STORY_PREFIX + JSON.stringify(source),
    };
  });
  return { candidateRows, evidenceRows };
}

function sourceFromRow(row) {
  return JSON.parse(row.summary.slice(STORY_PREFIX.length));
}

function rowWithSource(row, source) {
  return { ...row, summary: STORY_PREFIX + JSON.stringify(source) };
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
    assert.ok(item.background.supportingStoryBlockIds.length > 0);
    assert.equal(item.quote.source, "privacy_reviewed_trajectory");
    assert.equal(item.quote.evidenceStoryBlockId, item.anchorStoryBlockId);
    assert.equal(item.quote.exactSubstringRequired, true);
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
  const byId = new Map(storyLifecycleCases.map((item) => [item.id, item]));
  assert.equal(byId.get("ai-pending").expectedChapterState, "incomplete");
  assert.equal(byId.get("ai-accepted").expectedInsightState, "resolved_approved");
  assert.equal(byId.get("ai-rejected").expectedInsightState, "resolved_not_preserved");
  assert.equal(byId.get("ai-edited-after-approval").expectedChapterState, "incomplete");
  assert.notEqual(byId.get("ai-edited-after-approval").insightVersions[0].version, byId.get("ai-edited-after-approval").insightVersions[0].reviewedVersion);
  assert.equal(byId.get("zero-source-insights").expectedResolutionObligations, 0);
  assert.equal(byId.get("multiple-one-pending").expectedChapterState, "incomplete");
});

test("human Add Insight uses a valid safe Story anchor and Save is human-approved", () => {
  const byId = new Map(storyLifecycleCases.map((item) => [item.id, item]));
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
    assert.equal(storyLifecycleCases.find((item) => item.id === id).expectedActionState, "invalid");
  }
});

test("all eight frozen cases execute through story production parser and readiness", () => {
  for (const fixture of storyFirstSemanticCases) {
    const { candidateRows, evidenceRows } = buildStoryFixture(fixture.id);
    assert.ok(candidateRows.every((row) => parseStorySource(row.summary)), fixture.id);
    assert.equal(validateStorySourcePackage(candidateRows, evidenceRows).ok, true, fixture.id);
  }
});

test("story readiness accepts zero, one, and multiple sparse Insights", () => {
  for (const caseId of ["zero-insights", "one-insight", "multiple-sparse-insights"]) {
    const { candidateRows, evidenceRows } = buildStoryFixture(caseId);
    const insightCount = candidateRows.reduce((total, row) => (
      total + sourceFromRow(row).insights.length
    ), 0);
    assert.equal(insightCount, { "zero-insights": 0, "one-insight": 1, "multiple-sparse-insights": 2 }[caseId]);
    assert.equal(validateStorySourcePackage(candidateRows, evidenceRows).ok, true);
  }
});

test("story Insight IDs are stable and Chapter-local unique", () => {
  const { candidateRows } = buildStoryFixture("multiple-sparse-insights");
  const source = sourceFromRow(candidateRows[0]);
  source.insights[1].id = source.insights[0].id;
  assert.equal(parseStorySource(rowWithSource(candidateRows[0], source).summary), null);
});

test("the four-part story Insight contract is structural and title is metadata", () => {
  const { candidateRows } = buildStoryFixture("one-insight");
  const source = sourceFromRow(candidateRows[0]);
  assert.equal(Object.hasOwn(source.insights[0], "title"), false);
  assert.ok(parseStorySource(candidateRows[0].summary));
  for (const field of ["background", "quote", "directlyAcquiredExperience", "principle"]) {
    const malformed = structuredClone(source);
    delete malformed.insights[0][field];
    assert.equal(parseStorySource(rowWithSource(candidateRows[0], malformed).summary), null, field);
  }
});

test("story Story and Evidence anchors are exact and same-Chapter", () => {
  const { candidateRows, evidenceRows } = buildStoryFixture("one-insight");
  assert.equal(validateStorySourcePackage(candidateRows, evidenceRows).ok, true);

  const foreignChapterBlock = sourceFromRow(candidateRows[0]);
  const foreignPackage = buildStoryFixture("mundane-setup");
  foreignChapterBlock.insights[0].anchorStoryBlockId =
    sourceFromRow(foreignPackage.candidateRows[1]).story.blocks[0].id;
  assert.deepEqual(validateStorySourcePackage(
    [rowWithSource(candidateRows[0], foreignChapterBlock)], evidenceRows,
  ), { ok: false, code: "STORY_INSIGHT_GROUNDING_INVALID" });

  const missingBlock = sourceFromRow(candidateRows[0]);
  missingBlock.insights[0].anchorStoryBlockId = "missing-story-block";
  assert.deepEqual(validateStorySourcePackage(
    [rowWithSource(candidateRows[0], missingBlock)], evidenceRows,
  ), { ok: false, code: "STORY_INSIGHT_GROUNDING_INVALID" });

  const obsoleteAnchorShape = sourceFromRow(candidateRows[0]);
  obsoleteAnchorShape.insights[0].quote.obsoleteStoryAnchor = obsoleteAnchorShape.insights[0].anchorStoryBlockId;
  assert.equal(parseStorySource(rowWithSource(candidateRows[0], obsoleteAnchorShape).summary), null);

  const foreignEvidence = sourceFromRow(candidateRows[0]);
  foreignEvidence.insights[0].evidence = [{ documentId: "fixture-foreign", eventId: "foreign-record" }];
  assert.deepEqual(validateStorySourcePackage(
    [rowWithSource(candidateRows[0], foreignEvidence)], evidenceRows,
  ), { ok: false, code: "STORY_INSIGHT_GROUNDING_INVALID" });
});

test("story Chapter readiness keeps People mandatory and evidence-supported", () => {
  const { candidateRows, evidenceRows } = buildStoryFixture("one-insight");
  const noPeople = sourceFromRow(candidateRows[0]);
  noPeople.people = [];
  assert.deepEqual(validateStorySourcePackage(
    [rowWithSource(candidateRows[0], noPeople)], evidenceRows,
  ), { ok: false, code: "STORY_PEOPLE_INVALID" });

  const inventedPerson = sourceFromRow(candidateRows[0]);
  inventedPerson.people[0].evidence = [{ documentId: "fixture-one-insight", eventId: "missing-record" }];
  assert.deepEqual(validateStorySourcePackage(
    [rowWithSource(candidateRows[0], inventedPerson)], evidenceRows,
  ), { ok: false, code: "STORY_PEOPLE_INVALID" });
});

test("People cover exactly the eligible actors represented by Story blocks", () => {
  const { candidateRows, evidenceRows } = buildStoryFixture("one-insight");
  const source = sourceFromRow(candidateRows[0]);
  const supportOnly = {
    id: "support-only-actor-b",
    documentId: source.evidence.primary.documentId,
    eventType: "message",
    actorId: "actor-b",
    actorType: "human",
    reviewedNarrative: "Actor B supplied broader Chapter context.",
  };
  const supportReference = evidenceReference(supportOnly.documentId, supportOnly.id);
  source.evidence.supporting.push(supportReference);
  const rows = [...evidenceRows, supportOnly];
  const candidate = rowWithSource(candidateRows[0], source);

  assert.equal(validateStorySourcePackage([candidate], rows).ok, true);

  const representedWithoutPerson = structuredClone(source);
  representedWithoutPerson.story.blocks[0].evidence.push(supportReference);
  assert.deepEqual(validateStorySourcePackage(
    [rowWithSource(candidateRows[0], representedWithoutPerson)], rows,
  ), { ok: false, code: "STORY_PEOPLE_INVALID" });

  const unsupportedPerson = structuredClone(source);
  unsupportedPerson.people.push({
    ...unsupportedPerson.people[0],
    id: "person-support-only",
    evidence: [supportReference],
  });
  assert.deepEqual(validateStorySourcePackage(
    [rowWithSource(candidateRows[0], unsupportedPerson)], rows,
  ), { ok: false, code: "STORY_PEOPLE_INVALID" });
});

test("People use exact actor IDs, accept open labels, and exclude machine evidence", () => {
  let selected;
  for (const fixture of storyFirstSemanticCases) {
    const built = buildStoryFixture(fixture.id);
    const index = built.candidateRows.findIndex((row) => sourceFromRow(row).people.length >= 2);
    if (index !== -1) {
      selected = { ...built, candidateRows: [built.candidateRows[index]] };
      break;
    }
  }
  assert.ok(selected);
  const source = sourceFromRow(selected.candidateRows[0]);
  const referenced = new Set([
    source.evidence.primary, ...source.evidence.supporting,
  ].map((reference) => reference.eventId));
  const rows = selected.evidenceRows.filter((row) => referenced.has(row.id));
  const identities = ["actor.alpha", "actor-alpha"];
  source.people.forEach((person, index) => {
    for (const reference of person.evidence) {
      const row = rows.find((candidate) => candidate.id === reference.eventId);
      row.actorId = identities[index] ?? opaqueActorId(`extra-${index}`);
      row.actorType = index === 0 ? "field researcher" : "研究员";
      row.eventType = index === 0 ? "field_note" : "观察记录";
    }
  });
  const candidate = rowWithSource(selected.candidateRows[0], source);
  assert.equal(validateStorySourcePackage([candidate], rows).ok, true);

  const collapsed = structuredClone(rows);
  for (const row of collapsed) {
    if (row.actorId === "actor-alpha") row.actorId = "actor.alpha";
  }
  assert.deepEqual(validateStorySourcePackage([candidate], collapsed), {
    ok: false, code: "STORY_PEOPLE_INVALID",
  });

  const targetId = source.people[0].evidence[0].eventId;
  for (const [field, value] of [
    ["actorType", "tool"], ["actorType", "system"], ["eventType", "action_label"],
    ["eventType", "tool_result"], ["eventType", "artifact"],
    ["eventType", "agent_event"], ["eventType", "reviewer_action"],
  ]) {
    const machine = structuredClone(rows);
    machine.find((row) => row.id === targetId)[field] = value;
    assert.deepEqual(validateStorySourcePackage([candidate], machine), {
      ok: false, code: "STORY_PEOPLE_INVALID",
    });
  }
});

test("story Phase labels are bounded and Phase identity is contiguous", () => {
  const { candidateRows, evidenceRows } = buildStoryFixture("mundane-setup");
  assert.equal(validateStorySourcePackage(candidateRows, evidenceRows).ok, true);

  const twoWords = sourceFromRow(candidateRows[0]);
  twoWords.phase.label = "Early Foundation";
  const twoWordRows = [rowWithSource(candidateRows[0], twoWords), ...candidateRows.slice(1)];
  const second = sourceFromRow(twoWordRows[1]);
  second.phase.label = "Early Foundation";
  twoWordRows[1] = rowWithSource(twoWordRows[1], second);
  assert.equal(validateStorySourcePackage(twoWordRows, evidenceRows).ok, true);

  const missingPhase = sourceFromRow(candidateRows[0]);
  delete missingPhase.phase;
  assert.equal(parseStorySource(rowWithSource(candidateRows[0], missingPhase).summary), null);

  const genericPhase = sourceFromRow(candidateRows[0]);
  genericPhase.phase.label = "Other";
  assert.deepEqual(validateStorySourcePackage(
    [rowWithSource(candidateRows[0], genericPhase)], evidenceRows,
  ), { ok: false, code: "STORY_PHASE_INVALID" });

  const threeWords = sourceFromRow(candidateRows[0]);
  threeWords.phase.label = "Early Project Foundation";
  assert.deepEqual(validateStorySourcePackage(
    [rowWithSource(candidateRows[0], threeWords)], evidenceRows,
  ), { ok: false, code: "STORY_PHASE_INVALID" });

  const noncontiguous = candidateRows.map((row) => ({ ...row }));
  const middle = sourceFromRow(noncontiguous[1]);
  middle.phase = { id: "phase-setup-recovery", label: "Recovery" };
  noncontiguous[1] = rowWithSource(noncontiguous[1], middle);
  const last = sourceFromRow(noncontiguous[2]);
  last.phase = { id: "phase-setup-foundation", label: "Foundation" };
  noncontiguous[2] = rowWithSource(noncontiguous[2], last);
  assert.deepEqual(validateStorySourcePackage(noncontiguous, evidenceRows), {
    ok: false,
    code: "STORY_PHASE_ORDER_INVALID",
  });
});

test("story source omits old drama, role, assistance, and current-state gates", () => {
  for (const fixture of storyFirstSemanticCases) {
    const { candidateRows, evidenceRows } = buildStoryFixture(fixture.id);
    for (const row of candidateRows) {
      const source = sourceFromRow(row);
      assert.equal(source.kind, undefined);
      assert.equal(source.narrativeReview, undefined);
      assert.equal(source.passageContext, undefined);
      assert.equal(source.mainProblem, undefined);
      assert.equal(source.finalAction, undefined);
      assert.equal(source.result, undefined);
    }
    assert.equal(validateStorySourcePackage(candidateRows, evidenceRows).ok, true);
  }
});

test("optional transition and bounded chips are accepted only in their canonical shape", () => {
  const { candidateRows } = buildStoryFixture("one-insight");
  const source = sourceFromRow(candidateRows[0]);
  source.transition = {
    before: "The synthetic boundary had not been checked.",
    after: "The recorded check established the next action.",
  };
  source.chips = ["boundary check", "1 decision"];
  assert.deepEqual(parseStorySource(
    STORY_PREFIX + JSON.stringify(source),
  ), source);

  const absent = sourceFromRow(candidateRows[0]);
  assert.notEqual(parseStorySource(
    STORY_PREFIX + JSON.stringify(absent),
  ), null);
  absent.chips = [];
  assert.notEqual(parseStorySource(
    STORY_PREFIX + JSON.stringify(absent),
  ), null);

  for (const invalid of [
    { ...source, transition: { before: "", after: "after" } },
    { ...source, transition: { before: "x".repeat(501), after: "after" } },
    { ...source, chips: ["duplicate", "duplicate"] },
    { ...source, chips: Array.from({ length: 13 }, (_, index) => `chip-${index}`) },
    { ...source, chips: ["x".repeat(201)] },
  ]) assert.equal(parseStorySource(
    STORY_PREFIX + JSON.stringify(invalid),
  ), null);
});

test("People descriptions are Chapter-specific and Evidence-supported", () => {
  for (const fixture of storyFirstSemanticCases) {
    const { candidateRows } = buildStoryFixture(fixture.id);
    for (const row of candidateRows) {
      const source = sourceFromRow(row);
      for (const person of source.people) {
        assert.match(person.description, /^In this Chapter, the recorded involvement was:/);
        assert.notEqual(person.description, "Supported actor in this synthetic Chapter.");
        assert.ok(person.evidence.length > 0);
      }
    }
  }
});

test("story Evidence stays exact while completeness is owned by bounded units", () => {
  const { candidateRows, evidenceRows } = buildStoryFixture("zero-insights");
  const source = sourceFromRow(candidateRows[0]);
  source.story.blocks.pop();
  assert.equal(validateStorySourcePackage(
    [rowWithSource(candidateRows[0], source)], evidenceRows,
  ).ok, true);
  assert.equal(JSON.stringify(source).includes("contextRetention"), false);
  assert.equal(JSON.stringify(source.coverage).includes("members"), false);

  const foreignBlockEvidence = sourceFromRow(candidateRows[0]);
  foreignBlockEvidence.story.blocks[0].evidence = [{ documentId: "fixture-zero-insights", eventId: "missing-record" }];
  assert.deepEqual(validateStorySourcePackage(
    [rowWithSource(candidateRows[0], foreignBlockEvidence)], evidenceRows,
  ), { ok: false, code: "STORY_EVIDENCE_INVALID" });
});

test("Story packages fail closed on unknown reserved-family and malformed inputs", () => {
  const { candidateRows, evidenceRows } = buildStoryFixture("one-insight");
  for (const summary of ["oxygen.story.future:{}", `${STORY_PREFIX}{`]) {
    assert.equal(validateStorySourcePackage([{ ...candidateRows[0], summary }], evidenceRows).ok, false);
  }
});

test("the fixture corpus is synthetic, public-safe, and free of release-visible private sentinels", () => {
  const encoded = JSON.stringify(storyFirstSemanticCases);
  assert.ok(storyFirstSemanticCases.every((fixture) => fixture.input.privacyState === "public_safe_synthetic"));
  assert.doesNotMatch(encoded, /(?:[A-Za-z]:\\|github\.com|oxygen-contributor|\bO2TechAI\b|BEGIN PRIVATE|\[REDACTED\])/i);
});
