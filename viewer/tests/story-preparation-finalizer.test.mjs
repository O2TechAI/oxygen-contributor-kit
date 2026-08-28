import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  canonicalPreferenceQuestionBatch,
  deriveStoryReleaseTargetCatalog,
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
      quote: { storyBlockIds: [`block-${key}`] }, directlyAcquiredExperience: `Experience ${key}`,
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
    storyKey: story.key, insightId: insight.id, background: insight.background,
    directlyAcquiredExperience: insight.directlyAcquiredExperience, principle: insight.principle,
  })));
}

function probe() {
  const options = [
    { id: "one", text: "Ask before editing deployment files." },
    { id: "two", text: "Put deployment work on a separate branch." },
  ];
  return {
    id: "probe-a", documentId: "doc", documentKind: "trajectory", eventIds: ["event:é"],
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

async function fixture({
  insightIds = ["same", "same"], privacy = true, questions = true, reverse = false,
  candidateIds = null,
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
  const canonicalRows = [...rows].sort((left, right) => utf8(left.id, right.id));
  const canonicalStories = canonicalRows.map((row) => storyByRowId.get(row.id));
  const base = canonicalRows.map((row, index) => ({ id: row.id, story: { ...canonicalStories[index], insights: [] } }));
  const complete = canonicalRows.map((row, index) => ({ id: row.id, story: canonicalStories[index] }));
  const inputDigest = digest(lessons(canonicalStories));
  const probes = questions ? [probe()] : [];
  const bulkDecisions = questions ? [bulkDecision()] : [];
  const batch = canonicalPreferenceQuestionBatch(probes, bulkDecisions);
  const preference = {
    workflowRunId: "run-11", sourceRevision: 4, inputDigest, outputDigest: digest(batch),
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
    story: ["unit-é", "unit-z"], insight: ["é", "z"],
    story_privacy: deriveStoryReleaseTargetCatalog(stories).map((target) => target.id),
    preference: insightIds[0] === null && insightIds[1] === null ? [] : [canonical({ storyKey: "é", insightId: insightIds[0] }), canonical({ storyKey: "z", insightId: insightIds[1] })],
  };
  const laneOutputs = {
    story: reverse ? [...base].reverse() : base,
    insight: (reverse ? [...canonicalStories].reverse() : canonicalStories).map((story) => ({
      storyKey: story.key, insights: story.insights,
    })),
    story_privacy: privacyCandidates,
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
        narrativeDigest: digest([]), reviewedNarrative: [],
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
        : lane === "preference" ? preference.outputCount : output.length,
    });
  }
  return { directory, shards, output: join(directory, "output.json"), rows, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

function run(fixtureValue, trailing = []) {
  return spawnSync(process.execPath, [script, join(fixtureValue.directory, "semantic.json"),
    join(fixtureValue.directory, "candidates.json"), fixtureValue.shards,
    join(fixtureValue.directory, "preference.json"), fixtureValue.output,
    "--workflow-run-id", "run-11", "--source-revision", "4", ...trailing], { encoding: "utf8" });
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
    assert.equal(result.storyPrivacyCandidates.length, 1);
    assert.deepEqual(result.storyPrivacyCandidates[0].releaseTargets, ["z::title", "é::story:block-é"]);
    const preferenceReceipt = result.receipts.find((receipt) => receipt.lane === "preference");
    assert.equal(preferenceReceipt.scopeCount, 2);
    assert.equal(preferenceReceipt.outputCount, 2);
  } finally { await first.cleanup(); await second.cleanup(); }
});

test("Story candidate order uses UTF-8 bytes for producer-identical lessons and digests", async () => {
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
    assert.equal(receipt.inputDigest, digest(lessons([source("z", "same"), source("é", "same")])));
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

test("completed-zero Insight, Story Privacy, and Preference lanes are explicit terminal results", async () => {
  const emptyInsight = await fixture({ insightIds: [null, null], privacy: false, questions: false });
  const emptyQuestions = await fixture({ privacy: false, questions: false });
  try {
    const emptyInsightRun = run(emptyInsight);
    const emptyQuestionsRun = run(emptyQuestions);
    assert.equal(emptyInsightRun.status, 0, emptyInsightRun.stderr);
    assert.equal(emptyQuestionsRun.status, 0, emptyQuestionsRun.stderr);
    const manifest = await readJson(emptyQuestions.output);
    assert.equal(manifest.receipts.find((receipt) => receipt.lane === "story_privacy").outputCount, 0);
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
    unsortedProbes: (value) => { value.probes.push({ ...structuredClone(value.probes[0]), id: "probe-0" }); },
    unsortedBulkDecisions: (value) => { value.bulkDecisions.push({ ...structuredClone(value.bulkDecisions[0]), id: "bulk-0" }); },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async () => {
    const value = await fixture();
    try {
      await mutatePreferenceAuthority(value, mutate);
      assert.notEqual(run(value).status, 0);
    } finally { await value.cleanup(); }
  });
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
      if (mode === "conflict") data.push({ ...data[0], title: "Different" });
      else data[0].provider = "forbidden";
      await json(path, data);
      assert.notEqual(run(value).status, 0);
      assert.equal(await readFile(value.output, "utf8"), "preserve-this-byte-for-byte");
    } finally { await value.cleanup(); }
  }
});
