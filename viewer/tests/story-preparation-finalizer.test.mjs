import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  canonicalPreferenceQuestionBatch,
  deriveStoryReleaseTargetCatalog,
  deriveStoryReleaseTargetContents,
  insightAuthorityValue,
} from "../lib/story-preparation.ts";

const root = resolve(import.meta.dirname, "../..");
const script = join(root, "skills/oxygen-storytelling-review/scripts/finalize_story_preparation.mjs");
const utf8 = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));
const canonical = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort(utf8).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
};
const digest = (value) => createHash("sha256").update(canonical(value)).digest("hex");
const json = (path, value) => writeFile(path, JSON.stringify(value), "utf8");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

function source(key, insightId = "shared", semanticDigest = "a".repeat(64),
  coverageDigest = "b".repeat(64), eventId = `event:${key}`) {
  const evidence = { documentId: "doc", eventId };
  return {
    schema: "oxygen.story", key,
    phase: { id: `phase-${key}`, label: "Build" }, title: `Chapter ${key}`,
    overview: `Overview ${key}`, people: [{
      id: `person-${key}`, releaseLabel: `Person ${key}`, role: "reviewed participant",
      description: `The reviewed participant supports ${key}.`, localIdentityState: "not_identified",
      evidence: [evidence],
    }],
    story: { blocks: [{ id: `block-${key}`, text: `Text ${key}`, evidence: [evidence] }] },
    insights: insightId === null ? [] : [{
      id: insightId, background: `Background ${key}`,
      anchorStoryBlockId: `block-${key}`,
      quote: { text: `Reviewed unit-${key}.`, evidence },
      directlyAcquiredExperience: `Experience ${key}`,
      principle: `Principle ${key}`, evidence: [evidence],
    }],
    evidence: { primary: evidence, supporting: [] },
    coverage: { semanticManifest: { revision: 1, digest: semanticDigest },
      coverageManifest: { revision: 1, digest: coverageDigest },
      representedUnitIds: [`unit-${key}`], excludedUnits: [] },
  };
}

function rowsFor(stories) {
  return stories.map((story) => ({
    id: story.evidence.primary.eventId,
    summary: `oxygen.story:${JSON.stringify(story)}`,
  }));
}

function lessons(stories) {
  return stories.flatMap((story) => story.insights.map((insight) => ({
    storyKey: story.key, insightId: insight.id,
    insightAuthorityDigest: digest(insightAuthorityValue(story.key, insight)), background: insight.background,
    directlyAcquiredExperience: insight.directlyAcquiredExperience, principle: insight.principle,
  })));
}

function probe(documentKind = "trajectory", binding = {}) {
  const options = [
    { id: "one", text: "Ask before editing deployment files." },
    { id: "two", text: "Put deployment work on a separate branch." },
  ];
  return {
    id: "probe-a", ...binding, documentId: "doc", documentKind, eventIds: ["event:é"],
    timestamp: "2026-08-27T12:00:00Z", signal: "explicit_rule", score: 80, turns: 2,
    recap: "The reviewed event records a deployment boundary.",
    question: "What should the agent remember?", options,
    presentations: { zh: {
      recap: "已审阅事件记录了部署边界。", question: "代理应该记住什么？",
      options: [{ id: "one", text: "修改部署文件前先询问。" }, { id: "two", text: "把部署工作放在单独分支。" }],
    } },
    allowOther: true, allowSkip: true,
  };
}

function bulkDecision() {
  return {
    id: "bulk-a", kind: "privacy", count: 1, question: "Keep this reviewed group?",
    evidenceSample: ["event:z"], presentations: { zh: { question: "保留这组已审阅内容吗？" } },
  };
}

function privacyOutput(stories, candidates) {
  const targets = deriveStoryReleaseTargetContents(stories);
  assert.ok(targets);
  const flagged = new Set(candidates.flatMap((candidate) => candidate.releaseTargets));
  return {
    candidates,
    targetProposals: targets.map((target) => {
      if (!flagged.has(target.id)) return {
        targetId: target.id, targetContentDigest: digest(target.content),
        proposedText: target.content, occurrences: [],
      };
      const replacement = "Anonymous";
      const original = Array.from(target.content);
      const start = original.findLastIndex((point) => /[\p{L}\p{N}]/u.test(point));
      assert.notEqual(start, -1);
      return {
        targetId: target.id,
        targetContentDigest: digest(target.content),
        proposedText: original.slice(0, start).join("") + replacement + original.slice(start + 1).join(""),
        occurrences: [{
          originalStartOffset: start, originalEndOffset: start + 1,
          proposalStartOffset: start, proposalEndOffset: start + Array.from(replacement).length,
          category: "private-identity",
        }],
      };
    }),
  };
}

async function fixture({
  insightIds = ["same", "same"], privacy = true, questions = true, reverse = false,
  candidateIds = null, documentKind = "trajectory",
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "story-finalizer-"));
  const shards = join(directory, "shards");
  await mkdir(shards);
  const eventIds = new Map([
    ["é", candidateIds?.[0] ?? "event:é"],
    ["z", candidateIds?.[1] ?? "event:z"],
  ]);
  const semanticUnits = ["z", "é"].map((key) => ({
    id: `unit-${key}`, revision: 1, projectId: "project", kind: "decision_episode",
    members: [eventIds.get(key)], memberCount: 1,
    membershipDigest: digest([{ id: eventIds.get(key), sourceDigest: digest(key) }]),
  })).sort((left, right) => utf8(left.id, right.id));
  const semanticCore = { projectId: "project", revision: 1, sourceDigest: "c".repeat(64),
    universeDigest: digest([...eventIds.values()].sort(utf8)), units: semanticUnits };
  const semantic = { ...semanticCore, manifestDigest: digest(semanticCore) };
  const coverageCore = {
    revision: 1, semanticManifestRevision: 1, semanticManifestDigest: semantic.manifestDigest,
    rows: ["z", "é"].map((key) => ({
      unitId: `unit-${key}`, disposition: "represented", ownerId: key,
    })).sort((left, right) => utf8(left.unitId, right.unitId)),
  };
  const coverage = { ...coverageCore, coverageDigest: digest(coverageCore), serializedBytes: 1 };
  const stories = [
    source("é", insightIds[0], semantic.manifestDigest, coverage.coverageDigest, eventIds.get("é")),
    source("z", insightIds[1], semantic.manifestDigest, coverage.coverageDigest, eventIds.get("z")),
  ];
  const rows = rowsFor(stories);
  const storyByRowId = new Map(rows.map((row, index) => [row.id, stories[index]]));
  const canonicalRows = [...rows].sort((left, right) => (
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  ));
  const canonicalStories = canonicalRows.map((row) => storyByRowId.get(row.id));
  const base = canonicalRows.map((row, index) => ({ id: row.id, story: { ...canonicalStories[index], insights: [] } }));
  const complete = canonicalRows.map((row, index) => ({ id: row.id, story: canonicalStories[index] }));
  const inputDigest = digest(lessons(canonicalStories));
  const lessonRows = lessons(canonicalStories);
  const probeLesson = lessonRows.find((row) => row.storyKey === "é") ?? lessonRows[0];
  const probes = questions ? [probe(documentKind, {
    storyKey: probeLesson.storyKey, insightId: probeLesson.insightId, insightAuthorityDigest: probeLesson.insightAuthorityDigest,
  })] : [];
  const bulkDecisions = questions ? [bulkDecision()] : [];
  const batch = canonicalPreferenceQuestionBatch(probes, bulkDecisions);
  const preference = {
    workflowRunId: "run-11", sourceRevision: 4, inputDigest, outputDigest: digest(batch),
    insightScope: lessonRows.map(({ storyKey, insightId, insightAuthorityDigest }) => ({ storyKey, insightId, insightAuthorityDigest })),
    outputCount: batch.length, setAside: 0, probes, bulkDecisions,
    autoRemoved: { total: 6, reversible: true, categories: [
      { kind: "credential", count: 1 },
      { kind: "internal-metric", count: 1 },
      { kind: "internal-timeline", count: 1 },
      { kind: "mosaic-reidentification", count: 1 },
      { kind: "private-personal", count: 1 },
      { kind: "sensitive", count: 1 },
    ] },
  };
  const privacyCandidates = privacy ? [{
    id: "cross-chapter", reviewState: "needs_confirmation", title: "One issue",
    whyFlagged: "The same decision affects two Chapters.", uncertaintyReason: "Confirm it.",
    releaseTargets: ["z::title", "é::story:block-é"],
  }] : [];
  await json(join(directory, "semantic.json"), semantic);
  await json(join(directory, "candidates.json"), reverse ? [...rows].reverse() : rows);
  await json(join(directory, "preference.json"), preference);
  const inputs = {
    story: semantic.manifestDigest,
    insight: digest(base),
    story_privacy: digest(complete),
    preference: inputDigest,
  };
  const units = {
    story: ["é", "z"], insight: ["é", "z"],
    story_privacy: deriveStoryReleaseTargetCatalog(stories).map((target) => target.id),
    preference: lessonRows.map(({ storyKey, insightId, insightAuthorityDigest }) => canonical({ storyKey, insightId, insightAuthorityDigest })),
  };
  const laneOutputs = {
    story: reverse ? [...base].reverse() : base,
    insight: (reverse ? [...canonicalStories].reverse() : canonicalStories).map((story) => ({
      storyKey: story.key, insights: story.insights,
    })),
    story_privacy: privacyOutput(canonicalStories, privacyCandidates),
    preference,
  };
  const validationAuthority = {
    schema: "oxygen.story-validation-authority",
    sourceDigest: "e".repeat(64), sourcePrivacyDigest: "f".repeat(64),
    semanticManifest: semantic, coverageManifest: coverage,
    evidence: ["z", "é"].map((key) => ({
      id: eventIds.get(key), documentId: "doc", eventType: "message", actorType: "human",
      actorEquivalence: `actor-${key}`,
    })).sort((left, right) => utf8(left.id, right.id)),
  };
  await mkdir(join(shards, "story"), { recursive: true });
  await json(join(shards, "story", "validation-authority.json"), validationAuthority);
  const ownerBundles = semanticUnits.map((unit) => ({
    ownerId: unit.id.slice("unit-".length),
    semanticManifest: { revision: semantic.revision, digest: semantic.manifestDigest },
    coverageManifest: { revision: coverage.revision, digest: coverage.coverageDigest },
    semanticUnits: [unit],
    reviewedNarrative: [{
      id: unit.members[0], documentId: "doc", sequence: 1, timestamp: null,
      eventType: "message", actorType: "human",
      actorEquivalence: `actor-${unit.id.slice("unit-".length)}`,
      narrative: `Reviewed ${unit.id}.`,
    }],
  })).sort((left, right) => utf8(left.ownerId, right.ownerId));
  const baseStoryCandidates = base.map(({ id, story }) => ({
    id,
    summary: `oxygen.story:${canonical(story)}`,
  }));
  const insightReviewedNarrative = ownerBundles
    .flatMap((bundle) => bundle.reviewedNarrative)
    .map(({ id, documentId, narrative }) => ({ id, documentId, narrative }))
    .sort((left, right) => utf8(
      canonical([left.documentId, left.id]),
      canonical([right.documentId, right.id]),
    ));
  for (const lane of ["story", "insight", "story_privacy", "preference"]) {
    const laneUnits = [...units[lane]].sort(utf8);
    const directoryName = lane === "story_privacy" ? "story-privacy" : lane;
    const shardId = `${directoryName}-0001`;
    const laneRoot = join(shards, directoryName);
    const recordRoot = join(laneRoot, "records", shardId);
    await mkdir(join(laneRoot, "inputs"), { recursive: true });
    await mkdir(recordRoot, { recursive: true });
    const workerInput = {
      schema: "oxygen.story-preparation-worker-input", lane, shardId,
      inputDigest: inputs[lane], unitIds: laneUnits, payload: lane === "story" ? {
        validationAuthorityPath: "story/validation-authority.json",
        validationAuthorityDigest: digest(validationAuthority),
        ownerBundles,
      } : lane === "insight" ? {
        validationAuthorityPath: "story/validation-authority.json",
        validationAuthorityDigest: digest(validationAuthority),
        storyCandidates: baseStoryCandidates,
        reviewedNarrative: insightReviewedNarrative,
      } : lane === "preference" ? {
        preferenceContext: {
          schema: "oxygen.preference-context", reusableLessons: lessonRows,
          insightScope: preference.insightScope,
          reviewedEvidence: [...eventIds.values()].map((eventId) => ({
            documentId: "doc", eventId, documentKind,
          })),
          autoRemoved: preference.autoRemoved,
        },
      } : {},
    };
    const workerInputDigest = digest(workerInput);
    await json(join(laneRoot, "inputs", `${shardId}.json`), workerInput);
    await json(join(laneRoot, "shards.json"), {
      schema: "oxygen.story-preparation-shards", lane, inputDigest: inputs[lane],
      unitIds: laneUnits, shards: [{
        id: shardId, unitIds: laneUnits, inputPath: `${directoryName}/inputs/${shardId}.json`,
        workerInputDigest, receiptPath: `${directoryName}/records/${shardId}/receipt.json`,
      }],
    });
    const output = laneOutputs[lane];
    await json(join(recordRoot, "output.json"), output);
    await json(join(recordRoot, "receipt.json"), {
      schema: "oxygen.story-preparation-worker-receipt", lane, shardId, status: "complete",
      inputDigest: inputs[lane], workerInputDigest, unitIds: laneUnits,
      outputPath: `${directoryName}/records/${shardId}/output.json`, outputDigest: digest(output),
      outputCount: lane === "insight" ? canonicalStories.reduce((total, story) => total + story.insights.length, 0)
        : lane === "preference" ? preference.outputCount
          : lane === "story_privacy" ? output.targetProposals.length : output.length,
    });
  }
  return { directory, shards, output: join(directory, "output.json"), rows, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

function runWithRevision(fixtureValue, sourceRevision, trailing = []) {
  return spawnSync(process.execPath, [script, join(fixtureValue.directory, "semantic.json"),
    join(fixtureValue.directory, "candidates.json"), fixtureValue.shards,
    join(fixtureValue.directory, "preference.json"), fixtureValue.output,
    "--workflow-run-id", "run-11", "--source-revision", sourceRevision, ...trailing], { encoding: "utf8" });
}

function run(fixtureValue, trailing = []) {
  return runWithRevision(fixtureValue, "4", trailing);
}

async function mutatePreferenceAuthority(fixtureValue, mutate) {
  const preferencePath = join(fixtureValue.directory, "preference.json");
  const preference = await readJson(preferencePath);
  mutate(preference);
  const batch = canonicalPreferenceQuestionBatch(preference.probes, preference.bulkDecisions);
  preference.outputDigest = digest(batch);
  preference.outputCount = batch.length;
  await json(preferencePath, preference);
  const manifest = await readJson(join(fixtureValue.shards, "preference", "shards.json"));
  const receiptPath = join(fixtureValue.shards, ...manifest.shards[0].receiptPath.split("/"));
  const receipt = await readJson(receiptPath);
  const outputPath = join(fixtureValue.shards, ...receipt.outputPath.split("/"));
  await json(outputPath, preference);
  receipt.outputDigest = digest(preference);
  receipt.outputCount = preference.outputCount;
  await json(receiptPath, receipt);
}

test("four lanes finalize exact public Story rows with reordered shards and cross-Chapter Insight IDs", async () => {
  const first = await fixture();
  const second = await fixture({ reverse: true });
  try {
    const firstRun = run(first);
    const secondRun = run(second);
    assert.equal(firstRun.status, 0, firstRun.stderr);
    assert.equal(secondRun.status, 0, secondRun.stderr);
    const one = await readFile(first.output, "utf8");
    assert.equal(one, await readFile(second.output, "utf8"));
    const result = JSON.parse(one);
    assert.equal(result.receipts.length, 4);
    assert.equal(result.storyPrivacy.candidates.length, 1);
    assert.deepEqual(result.storyPrivacy.candidates[0].releaseTargets, ["z::title", "é::story:block-é"]);
    const preferenceReceipt = result.receipts.find((receipt) => receipt.lane === "preference");
    assert.equal(preferenceReceipt.scopeCount, 2);
    assert.equal(preferenceReceipt.outputCount, 2);
  } finally { await first.cleanup(); await second.cleanup(); }
});

test("Story candidate order uses the production comparator for producer-identical lessons and digests", async () => {
  const candidateIds = ["\u{1f600}", "\ue000"];
  const first = await fixture({ candidateIds, questions: false });
  const second = await fixture({ candidateIds, reverse: true, questions: false });
  try {
    const firstRun = run(first);
    const secondRun = run(second);
    assert.equal(firstRun.status, 0, firstRun.stderr);
    assert.equal(secondRun.status, 0, secondRun.stderr);
    assert.equal(await readFile(first.output, "utf8"), await readFile(second.output, "utf8"));
    const result = await readJson(first.output);
    const receipt = result.receipts.find((item) => item.lane === "preference");
    assert.equal(receipt.inputDigest, digest(lessons([
      source("é", "same", "a".repeat(64), "b".repeat(64), candidateIds[0]),
      source("z", "same", "a".repeat(64), "b".repeat(64), candidateIds[1]),
    ])));
  } finally { await first.cleanup(); await second.cleanup(); }
});

test("the exact CLI rejects trailing arguments without writing output", async () => {
  const value = await fixture();
  try {
    const result = run(value, ["unexpected"]);
    assert.notEqual(result.status, 0);
    await assert.rejects(readFile(value.output, "utf8"), { code: "ENOENT" });
  } finally { await value.cleanup(); }
});

test("zero CLI source revision cannot create or replace completed-zero or nonzero terminal output", async (t) => {
  for (const [name, questions] of [["completed-zero", false], ["completed-nonzero", true]]) {
    await t.test(name, async () => {
      const value = await fixture({ questions });
      try {
        const sentinel = Buffer.from("preserve-existing-terminal-output-byte-for-byte\n");
        await writeFile(value.output, sentinel);
        const rejected = runWithRevision(value, "0");
        assert.notEqual(rejected.status, 0);
        assert.equal(rejected.stdout, "");
        assert.match(rejected.stderr, /^CLI_USAGE\r?\n$/u);
        assert.deepEqual(await readFile(value.output), sentinel);

        await rm(value.output);
        const accepted = runWithRevision(value, "4");
        assert.equal(accepted.status, 0, accepted.stderr);
        const manifest = await readJson(value.output);
        assert.equal(manifest.sourceRevision, 4);
        assert.equal(manifest.receipts.find((receipt) => receipt.lane === "preference").outputCount,
          questions ? 2 : 0);
      } finally {
        await value.cleanup();
      }
    });
  }
});

test("the sole public Story candidate input rejects every enriched or extra field", async (t) => {
  const mutations = {
    documentId: (row) => { row.documentId = "doc"; },
    sequence: (row) => { row.sequence = 0; },
    timestamp: (row) => { row.timestamp = null; },
    extra: (row) => { row.authority = "second"; },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async () => {
    const value = await fixture();
    try {
      const path = join(value.directory, "candidates.json");
      const candidates = await readJson(path);
      mutate(candidates[0]);
      await json(path, candidates);
      assert.notEqual(run(value).status, 0);
    } finally { await value.cleanup(); }
  });
});

test("completed-zero Insight/Preference and zero-candidate total Privacy are explicit", async () => {
  const emptyInsight = await fixture({ insightIds: [null, null], privacy: false, questions: false });
  const emptyQuestions = await fixture({ privacy: false, questions: false });
  try {
    const emptyInsightRun = run(emptyInsight);
    const emptyQuestionsRun = run(emptyQuestions);
    assert.equal(emptyInsightRun.status, 0, emptyInsightRun.stderr);
    assert.equal(emptyQuestionsRun.status, 0, emptyQuestionsRun.stderr);
    const manifest = await readJson(emptyQuestions.output);
    assert.equal(manifest.storyPrivacy.candidates.length, 0);
    assert.equal(manifest.receipts.find((receipt) => receipt.lane === "story_privacy").outputCount,
      manifest.storyPrivacy.targetProposals.length);
    assert.ok(manifest.storyPrivacy.targetProposals.length > 0);
    assert.equal(manifest.receipts.find((receipt) => receipt.lane === "preference").outputCount, 0);
  } finally { await emptyInsight.cleanup(); await emptyQuestions.cleanup(); }
});

test("the sole producer-shaped Preference bundle fails closed on extra authority and nested fields", async (t) => {
  const mutations = {
    extraAuthority: (value) => { value.authorityOverride = value.outputDigest; },
    answeredProbe: (value) => { value.probes[0].answer = { choice: "one" }; },
    generationMetadata: (value) => { value.probes[0].provider = "forbidden"; },
    malformedAutoRemoved: (value) => { value.autoRemoved.extra = true; },
    userPathAggregate: (value) => { value.autoRemoved = { total: 1, reversible: true, categories: [{ kind: "user_path", count: 1 }] }; },
    thirdPartyAggregate: (value) => { value.autoRemoved = { total: 1, reversible: true, categories: [{ kind: "third_party_contact", count: 1 }] }; },
    irreversibleAggregate: (value) => { value.autoRemoved.reversible = false; },
    unsortedAggregate: (value) => { value.autoRemoved = { total: 2, reversible: true, categories: [{ kind: "sensitive", count: 1 }, { kind: "credential", count: 1 }] }; },
    zeroAggregateCategory: (value) => { value.autoRemoved = { total: 0, reversible: true, categories: [{ kind: "credential", count: 0 }] }; },
    foreignProbeEvidence: (value) => { value.probes[0].eventIds = ["foreign:event"]; },
    crossDocumentProbeEvidence: (value) => { value.probes[0].documentId = "other-document"; },
    foreignBulkEvidence: (value) => { value.bulkDecisions[0].evidenceSample = ["foreign:event"]; },
    genericOption: (value) => { value.probes[0].options[0].text = "Be more careful."; },
    duplicateOptionText: (value) => { value.probes[0].options[1].text = `${value.probes[0].options[0].text}.`; },
    oversizedText: (value) => { value.probes[0].question = "x".repeat(20_001); },
    oversizedEventId: (value) => { value.probes[0].eventIds = ["x".repeat(1_001)]; },
    oversizedProbeEvidence: (value) => { value.probes[0].eventIds = Array.from({ length: 501 }, (_, index) => `event-${index}`); },
    oversizedBulkEvidence: (value) => { value.bulkDecisions[0].evidenceSample = Array.from({ length: 501 }, (_, index) => `event-${index}`); },
    tooManyQuestions: (value) => { value.probes = Array.from({ length: 21 }, (_, index) => ({ ...structuredClone(value.probes[0]), id: `probe-${index}` })); },
    malformedDocumentKind: (value) => { value.probes[0].documentKind = "Lab_notebook"; },
    mismatchedDocumentKind: (value) => { value.probes[0].documentKind = "meeting"; },
    unsortedProbes: (value) => { value.probes.push({ ...structuredClone(value.probes[0]), id: "probe-0" }); },
    unsortedBulkDecisions: (value) => { value.bulkDecisions.push({ ...structuredClone(value.bulkDecisions[0]), id: "bulk-0" }); },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async () => {
    const value = await fixture();
    try {
      await mutatePreferenceAuthority(value, mutate);
      assert.notEqual(run(value).status, 0);
      assert.equal(existsSync(value.output), false);
    } finally { await value.cleanup(); }
  });
});

test("open lab_notebook Preference kind finalizes without registration", async () => {
  const value = await fixture({ documentKind: "lab_notebook" });
  try {
    const result = run(value);
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await readJson(value.output)).receipts.find((receipt) => (
      receipt.lane === "preference"
    )).outputCount, 2);
  } finally { await value.cleanup(); }
});

test("Preference option normalization trims ECMAScript space, strips ASCII dots, and folds only ASCII", async () => {
  const unicodeDistinct = await fixture();
  const asciiDuplicate = await fixture();
  try {
    await mutatePreferenceAuthority(unicodeDistinct, (value) => {
      value.probes[0].options[0].text = "Äpfel";
      value.probes[0].options[1].text = "äpfel";
    });
    const accepted = run(unicodeDistinct);
    assert.equal(accepted.status, 0, accepted.stderr);

    await mutatePreferenceAuthority(asciiDuplicate, (value) => {
      value.probes[0].options[0].text = "\u00a0ÄPFEL...\ufeff";
      value.probes[0].options[1].text = "Äpfel";
    });
    const rejected = run(asciiDuplicate);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /PREFERENCE_BUNDLE_INVALID/u);
  } finally { await unicodeDistinct.cleanup(); await asciiDuplicate.cleanup(); }
});

test("physical shard containment rejects junction escapes for receipts and outputs", async (t) => {
  await t.test("receipt", async () => {
    const value = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "story-finalizer-outside-"));
    try {
      const receipt = await readJson(join(value.shards, "story", "records", "story-0001", "receipt.json"));
      await json(join(outside, "receipt.json"), receipt);
      await symlink(outside, join(value.shards, "escape"), process.platform === "win32" ? "junction" : "dir");
      const manifestPath = join(value.shards, "story", "shards.json");
      const manifest = await readJson(manifestPath);
      manifest.shards[0].receiptPath = "escape/receipt.json";
      await json(manifestPath, manifest);
      assert.notEqual(run(value).status, 0);
    } finally { await value.cleanup(); await rm(outside, { recursive: true, force: true }); }
  });

  await t.test("output", async () => {
    const value = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "story-finalizer-outside-"));
    try {
      const output = await readJson(join(value.shards, "story", "records", "story-0001", "output.json"));
      await json(join(outside, "output.json"), output);
      await symlink(outside, join(value.shards, "escape"), process.platform === "win32" ? "junction" : "dir");
      const receiptPath = join(value.shards, "story", "records", "story-0001", "receipt.json");
      const receipt = await readJson(receiptPath);
      receipt.outputPath = "escape/output.json";
      await json(receiptPath, receipt);
      assert.notEqual(run(value).status, 0);
    } finally { await value.cleanup(); await rm(outside, { recursive: true, force: true }); }
  });
});

test("missing, duplicate, overlap, foreign, stale, nonterminal, and tampered worker inputs fail closed", async (t) => {
  const mutations = {
    missing: async (value) => { const path = join(value.shards, "story", "records", "story-0001", "receipt.json"); await rm(path); },
    duplicate: async (value) => { const path = join(value.shards, "story", "shards.json"); const data = await readJson(path); data.unitIds.push(data.unitIds[0]); data.shards[0].unitIds = data.unitIds; await json(path, data); },
    overlap: async (value) => { const path = join(value.shards, "story", "shards.json"); const data = await readJson(path); data.shards.push({ ...data.shards[0], id: "story-0002", unitIds: [data.unitIds[0]] }); await json(path, data); },
    foreign: async (value) => { const path = join(value.shards, "story", "shards.json"); const data = await readJson(path); data.shards[0].unitIds = ["foreign"]; await json(path, data); },
    stale: async (value) => { const path = join(value.shards, "story", "shards.json"); const data = await readJson(path); data.inputDigest = "0".repeat(64); await json(path, data); },
    nonterminal: async (value) => { const path = join(value.shards, "story", "records", "story-0001", "receipt.json"); const data = await readJson(path); data.status = "running"; await json(path, data); },
    receipt: async (value) => { const path = join(value.shards, "story", "records", "story-0001", "receipt.json"); const data = await readJson(path); data.shardId = "other"; await json(path, data); },
    output: async (value) => { const path = join(value.shards, "story", "records", "story-0001", "output.json"); const data = await readJson(path); data[0].id = "tampered"; await json(path, data); },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async () => {
    const value = await fixture();
    try {
      await mutate(value);
      assert.notEqual(run(value).status, 0);
    } finally { await value.cleanup(); }
  });
});

test("conflicting identities and forbidden worker metadata fail without replacing an existing output", async () => {
  for (const mode of ["conflict", "metadata"]) {
    const value = await fixture();
    try {
      await writeFile(value.output, "preserve-this-byte-for-byte", "utf8");
      const path = join(value.shards, "story-privacy", "records", "story-privacy-0001", "output.json");
      const data = await readJson(path);
      if (mode === "conflict") data.candidates.push({ ...data.candidates[0], title: "Different" });
      else data.candidates[0].provider = "forbidden";
      await json(path, data);
      assert.notEqual(run(value).status, 0);
      assert.equal(await readFile(value.output, "utf8"), "preserve-this-byte-for-byte");
    } finally { await value.cleanup(); }
  }
});
