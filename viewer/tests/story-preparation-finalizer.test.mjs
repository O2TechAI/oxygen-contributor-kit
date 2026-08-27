import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { canonicalPreferenceQuestionBatch } from "../lib/story-preparation.ts";

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

function source(key, insightId = "shared") {
  const evidence = { documentId: "doc", eventId: `event:${key}` };
  return {
    schema: "oxygen.story", key,
    phase: { id: `phase-${key}`, label: "Build" }, title: `Chapter ${key}`,
    overview: `Overview ${key}`, people: [],
    story: { blocks: [{ id: `block-${key}`, text: `Text ${key}`, evidence: [evidence] }] },
    insights: insightId === null ? [] : [{
      id: insightId, background: `Background ${key}`,
      quote: { storyBlockIds: [`block-${key}`] }, directlyAcquiredExperience: `Experience ${key}`,
      principle: `Principle ${key}`, evidence: [evidence],
    }],
    evidence: { primary: evidence, supporting: [] },
    coverage: { semanticManifest: { revision: 1, digest: "a".repeat(64) },
      coverageManifest: { revision: 1, digest: "b".repeat(64) }, representedUnitIds: [], excludedUnits: [] },
  };
}

function rowsFor(stories) {
  return stories.map((story) => ({
    id: `event:${story.key}`,
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

async function fixture({ insightIds = ["same", "same"], privacy = true, questions = true, reverse = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "story-finalizer-"));
  const shards = join(directory, "shards");
  await (await import("node:fs/promises")).mkdir(shards);
  const stories = [source("é", insightIds[0]), source("z", insightIds[1])];
  const rows = rowsFor(stories);
  const semanticCore = { projectId: "project", revision: 1, sourceDigest: "c".repeat(64),
    universeDigest: "d".repeat(64), units: [{ id: "unit-z" }, { id: "unit-é" }] };
  const semantic = { ...semanticCore, manifestDigest: digest(semanticCore) };
  const base = rows.map((row, index) => ({ id: row.id, story: { ...stories[index], insights: [] } }));
  const complete = rows.map((row, index) => ({ id: row.id, story: stories[index] }));
  const inputDigest = digest(lessons(stories));
  const probes = questions ? [probe()] : [];
  const bulkDecisions = questions ? [bulkDecision()] : [];
  const batch = canonicalPreferenceQuestionBatch(probes, bulkDecisions);
  const preference = {
    workflowRunId: "run-11", sourceRevision: 4, inputDigest, outputDigest: digest(batch),
    outputCount: batch.length, setAside: 0, probes, bulkDecisions,
    autoRemoved: { total: 1, reversible: true, categories: [{ kind: "credential", count: 1 }] },
  };
  const privacyCandidates = privacy ? [{
    id: "cross-chapter", reviewState: "needs_confirmation", title: "One issue",
    whyFlagged: "The same decision affects two Chapters.", uncertaintyReason: "Confirm it.",
    releaseTargets: ["z::title", "é::story:block-é"],
  }] : [];
  await json(join(directory, "semantic.json"), semantic);
  await json(join(directory, "candidates.json"), rows);
  await json(join(directory, "preference.json"), preference);
  const inputs = {
    story: semantic.manifestDigest,
    insight: digest(base),
    story_privacy: digest(complete),
    preference: inputDigest,
  };
  const units = {
    story: ["unit-é", "unit-z"], insight: ["é", "z"],
    story_privacy: stories.flatMap((story) => [
      `${story.key}::phase`, `${story.key}::title`, `${story.key}::overview`, `${story.key}::story:block-${story.key}`,
      ...story.insights.flatMap((insight) => [
        `${story.key}::insight:${insight.id}:background`,
        `${story.key}::insight:${insight.id}:directlyAcquiredExperience`,
        `${story.key}::insight:${insight.id}:principle`,
      ]),
    ]),
    preference: insightIds[0] === null && insightIds[1] === null ? [] : [canonical({ storyKey: "é", insightId: insightIds[0] }), canonical({ storyKey: "z", insightId: insightIds[1] })],
  };
  const laneOutputs = {
    story: [[base[0]], [base[1]]],
    insight: insightIds[0] === null && insightIds[1] === null ? [[], []] : [[complete[0]], [complete[1]]],
    story_privacy: [[...privacyCandidates], []],
    preference: insightIds[0] === null && insightIds[1] === null ? [] : [{ probes, bulkDecisions }, { probes: [], bulkDecisions: [] }],
  };
  for (const lane of ["story", "insight", "story_privacy", "preference"]) {
    const laneUnits = units[lane];
    const outputParts = laneOutputs[lane];
    const shardsValue = laneUnits.length === 0 ? [] : laneUnits.map((unit, index) => ({
      id: `${lane}-${index}`, unitIds: [unit], receiptPath: `${lane}-${index}.receipt.json`,
    }));
    await json(join(shards, `${lane === "story_privacy" ? "story-privacy" : lane}.shards.json`), {
      schema: "oxygen.story-preparation-shards", lane, inputDigest: inputs[lane],
      unitIds: reverse ? [...laneUnits].reverse() : laneUnits, shards: reverse ? [...shardsValue].reverse() : shardsValue,
    });
    for (let index = 0; index < shardsValue.length; index += 1) {
      const name = `${lane}-${index}`;
      await json(join(shards, `${name}.output.json`), outputParts[index] ?? (lane === "preference" ? { probes: [], bulkDecisions: [] } : []));
      await json(join(shards, `${name}.receipt.json`), {
        schema: "oxygen.story-preparation-worker-receipt", lane, shardId: name, status: "complete",
        inputDigest: inputs[lane], unitIds: [laneUnits[index]], outputPath: `${name}.output.json`,
      });
    }
  }
  return { directory, shards, output: join(directory, "output.json"), rows, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

function run(fixtureValue) {
  return spawnSync(process.execPath, [script, join(fixtureValue.directory, "semantic.json"),
    join(fixtureValue.directory, "candidates.json"), fixtureValue.shards,
    join(fixtureValue.directory, "preference.json"), fixtureValue.output,
    "--workflow-run-id", "run-11", "--source-revision", "4"], { encoding: "utf8" });
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
    assert.deepEqual(result.storyPrivacyCandidates[0].releaseTargets, ["é::story:block-é", "z::title"]);
    const preferenceReceipt = result.receipts.find((receipt) => receipt.lane === "preference");
    assert.equal(preferenceReceipt.scopeCount, 2);
    assert.equal(preferenceReceipt.outputCount, 2);
  } finally { await first.cleanup(); await second.cleanup(); }
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
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async () => {
    const value = await fixture();
    try {
      const path = join(value.directory, "preference.json");
      const preference = await readJson(path);
      mutate(preference);
      await json(path, preference);
      assert.notEqual(run(value).status, 0);
    } finally { await value.cleanup(); }
  });
});

test("missing, duplicate, overlap, foreign, stale, nonterminal, and tampered worker inputs fail closed", async (t) => {
  const mutations = {
    missing: async (value) => { const path = join(value.shards, "story-0.receipt.json"); await rm(path); },
    duplicate: async (value) => { const path = join(value.shards, "story.shards.json"); const data = await readJson(path); data.shards[1].unitIds = ["unit-é"]; await json(path, data); },
    overlap: async (value) => { const path = join(value.shards, "story.shards.json"); const data = await readJson(path); data.shards[1].unitIds = ["unit-é", "unit-z"]; await json(path, data); },
    foreign: async (value) => { const path = join(value.shards, "story.shards.json"); const data = await readJson(path); data.shards[0].unitIds = ["foreign"]; await json(path, data); },
    stale: async (value) => { const path = join(value.shards, "story.shards.json"); const data = await readJson(path); data.inputDigest = "0".repeat(64); await json(path, data); },
    nonterminal: async (value) => { const path = join(value.shards, "story-0.receipt.json"); const data = await readJson(path); data.status = "running"; await json(path, data); },
    receipt: async (value) => { const path = join(value.shards, "story-0.receipt.json"); const data = await readJson(path); data.shardId = "other"; await json(path, data); },
    output: async (value) => { const path = join(value.shards, "story-0.output.json"); const data = await readJson(path); data[0].id = "tampered"; await json(path, data); },
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
      const path = join(value.shards, "story_privacy-0.output.json");
      const data = await readJson(path);
      if (mode === "conflict") data.push({ ...data[0], title: "Different" });
      else data[0].provider = "forbidden";
      await json(path, data);
      assert.notEqual(run(value).status, 0);
      assert.equal(await readFile(value.output, "utf8"), "preserve-this-byte-for-byte");
    } finally { await value.cleanup(); }
  }
});
