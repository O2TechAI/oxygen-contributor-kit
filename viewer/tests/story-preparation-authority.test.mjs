import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import test from "node:test";
import {
  STORY_PREPARATION_EMPTY_ARRAY_DIGEST,
  deriveStoryReleaseTargetCatalog,
  insightLaneOutput,
  reusableLessonOutput,
  storyLaneOutput,
  storyPreparationDigest,
  validateStoryPreparationManifest,
} from "../lib/story-preparation.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL && specifier.startsWith(".")) {
      const resolvedPath = fileURLToPath(new URL(specifier, context.parentURL));
      if (!extname(resolvedPath)) {
        if (existsSync(`${resolvedPath}.ts`)) return nextResolve(`${specifier}.ts`, context);
        if (existsSync(join(resolvedPath, "index.ts"))) return nextResolve(`${specifier}/index.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const RUN_ID = "story-preparation-authority";
const SOURCE_REVISION = 7;
const SEMANTIC_DIGEST = "a".repeat(64);

function story(key, { insight = true } = {}) {
  const eventId = `doc:${key}`;
  const evidence = { documentId: "doc", eventId };
  return {
    schema: "oxygen.story",
    key,
    phase: { id: `phase-${key}`, label: "Build" },
    title: `Chapter ${key}`,
    overview: `Overview for ${key}.`,
    transition: { before: `Before ${key}`, after: `After ${key}` },
    people: [{
      id: `person-${key}`,
      releaseLabel: "Contributor",
      role: "Owner",
      description: `Owner for ${key}.`,
      localIdentityState: "not_identified",
      evidence: [evidence],
    }],
    story: {
      blocks: [{ id: `block-${key}`, text: `Story block ${key}.`, evidence: [evidence] }],
      uncertainty: `Uncertainty for ${key}.`,
    },
    insights: insight ? [{
      id: `insight-${key}`,
      title: `Insight ${key}`,
      background: `Background ${key}.`,
      quote: { storyBlockIds: [`block-${key}`] },
      directlyAcquiredExperience: `Experience ${key}.`,
      principle: `Principle ${key}.`,
      evidence: [evidence],
    }] : [],
    evidence: { primary: evidence, supporting: [] },
    coverage: {
      semanticManifest: { revision: 1, digest: SEMANTIC_DIGEST },
      coverageManifest: { revision: 1, digest: "b".repeat(64) },
      representedUnitIds: [],
      excludedUnits: [],
    },
  };
}

const rowsFor = (stories) => stories.map((source, sequence) => ({
  id: source.evidence.primary.eventId,
  documentId: source.evidence.primary.documentId,
  sequence,
  summary: `oxygen.story:${JSON.stringify(source)}`,
}));

async function authorityFixture({
  stories = [story("a"), story("b")],
  privacyCandidates,
  preferenceCount = 1,
} = {}) {
  const storyCandidates = rowsFor(stories);
  const semanticUnitIds = ["unit-a", "unit-b"];
  const targetCatalog = deriveStoryReleaseTargetCatalog(stories);
  assert.ok(targetCatalog);
  const privacy = privacyCandidates ?? [{
    storyKey: "a",
    candidates: [{
      id: "candidate-cross-chapter",
      reviewState: "needs_confirmation",
      title: "One decision spans Chapters",
      whyFlagged: "The same privacy decision affects two final targets.",
      uncertaintyReason: "A contributor decision is required.",
      releaseTargets: ["a::title", "b::story:block-b"],
    }],
  }];
  const preferenceOutput = preferenceCount === 0 ? [] : [{ id: "question-1" }];
  const preference = {
    workflowRunId: RUN_ID,
    sourceRevision: SOURCE_REVISION,
    inputDigest: await storyPreparationDigest(reusableLessonOutput(stories)),
    outputDigest: await storyPreparationDigest(preferenceOutput),
    outputCount: preferenceCount,
  };
  const storyOutput = storyLaneOutput(storyCandidates, stories);
  const insightOutput = insightLaneOutput(storyCandidates, stories);
  const insightCount = stories.reduce((total, source) => total + source.insights.length, 0);
  const receipts = [{
    lane: "story",
    status: "complete",
    inputDigest: SEMANTIC_DIGEST,
    scopeDigest: await storyPreparationDigest(semanticUnitIds),
    scopeCount: semanticUnitIds.length,
    outputDigest: await storyPreparationDigest(storyOutput),
    outputCount: stories.length,
  }, {
    lane: "insight",
    status: "complete",
    inputDigest: await storyPreparationDigest(storyOutput),
    scopeDigest: await storyPreparationDigest(stories.map((source) => source.key).sort()),
    scopeCount: stories.length,
    outputDigest: await storyPreparationDigest(insightOutput),
    outputCount: insightCount,
  }, {
    lane: "story_privacy",
    status: "complete",
    inputDigest: await storyPreparationDigest(insightOutput),
    scopeDigest: await storyPreparationDigest(targetCatalog.map((target) => target.id)),
    scopeCount: targetCatalog.length,
    outputDigest: await storyPreparationDigest(privacy),
    outputCount: privacy.reduce((total, group) => total + group.candidates.length, 0),
  }, {
    lane: "preference",
    status: "complete",
    inputDigest: preference.inputDigest,
    scopeDigest: await storyPreparationDigest(stories.flatMap((source) => (
      source.insights.map((insight) => insight.id)
    )).sort()),
    scopeCount: insightCount,
    outputDigest: preference.outputDigest,
    outputCount: preference.outputCount,
  }];
  return {
    context: {
      workflowRunId: RUN_ID,
      sourceRevision: SOURCE_REVISION,
      semanticManifestDigest: SEMANTIC_DIGEST,
      semanticUnitIds,
      storyCandidates,
      preference,
    },
    manifest: {
      schema: "oxygen.story-preparation",
      workflowRunId: RUN_ID,
      sourceRevision: SOURCE_REVISION,
      receipts,
      storyPrivacyCandidates: privacy,
    },
    targetCatalog,
  };
}

const clone = (value) => structuredClone(value);

test("exact four terminal digest-bound receipts succeed and one candidate spans Chapters once", async () => {
  const fixture = await authorityFixture();
  const result = await validateStoryPreparationManifest(fixture.manifest, fixture.context);
  assert.equal(result.ok, true, result.code);
  assert.deepEqual(result.authority.receipts.map((receipt) => receipt.lane), [
    "story", "insight", "story_privacy", "preference",
  ]);
  assert.equal(result.authority.privacyCandidates[0].candidates.length, 1);
  assert.deepEqual(result.authority.privacyCandidates[0].candidates[0].releaseTargets, [
    "a::title", "b::story:block-b",
  ]);
});

test("Story cannot be zero while Insight, Story Privacy, and Preference complete-zero are explicit", async () => {
  const fixture = await authorityFixture({
    stories: [story("a", { insight: false })],
    privacyCandidates: [],
    preferenceCount: 0,
  });
  const result = await validateStoryPreparationManifest(fixture.manifest, fixture.context);
  assert.equal(result.ok, true, result.code);
  assert.equal(result.authority.receipts.find((receipt) => receipt.lane === "story").outputCount, 1);
  for (const lane of ["insight", "story_privacy", "preference"]) {
    const receipt = result.authority.receipts.find((item) => item.lane === lane);
    assert.equal(receipt.outputCount, 0);
    assert.equal(receipt.outputDigest, STORY_PREPARATION_EMPTY_ARRAY_DIGEST);
  }
  const emptyStory = clone(fixture);
  emptyStory.context.storyCandidates = [];
  assert.equal((await validateStoryPreparationManifest(emptyStory.manifest, emptyStory.context)).ok, false);
});

test("missing, duplicate, unknown, nonterminal, malformed, and extra receipts fail closed", async (t) => {
  const fixture = await authorityFixture();
  const cases = {
    missing: (manifest) => manifest.receipts.pop(),
    duplicate: (manifest) => { manifest.receipts[3] = clone(manifest.receipts[0]); },
    unknown: (manifest) => { manifest.receipts[0].lane = "foreign"; },
    nonterminal: (manifest) => { manifest.receipts[0].status = "running"; },
    malformed: (manifest) => { manifest.receipts[0].scopeCount = -1; },
    "extra receipt": (manifest) => manifest.receipts.push(clone(manifest.receipts[0])),
    "extra receipt field": (manifest) => { manifest.receipts[0].legacy = true; },
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, async () => {
    const manifest = clone(fixture.manifest);
    mutate(manifest);
    assert.equal((await validateStoryPreparationManifest(manifest, fixture.context)).ok, false);
  });
});

test("foreign run/revision and stale input, scope, output digest, or count are rejected", async (t) => {
  const fixture = await authorityFixture();
  for (const [name, mutate] of Object.entries({
    "foreign run": (manifest) => { manifest.workflowRunId = "foreign"; },
    "stale revision": (manifest) => { manifest.sourceRevision += 1; },
    "input digest": (manifest) => { manifest.receipts[0].inputDigest = "0".repeat(64); },
    "scope digest": (manifest) => { manifest.receipts[1].scopeDigest = "0".repeat(64); },
    "output digest": (manifest) => { manifest.receipts[2].outputDigest = "0".repeat(64); },
    "output count": (manifest) => { manifest.receipts[3].outputCount += 1; },
  })) await t.test(name, async () => {
    const manifest = clone(fixture.manifest);
    mutate(manifest);
    assert.equal((await validateStoryPreparationManifest(manifest, fixture.context)).ok, false);
  });
});

test("scope omission, duplicate, foreign, overlapping Story keys, and duplicate Insight IDs fail", async (t) => {
  const fixture = await authorityFixture();
  const omitted = clone(fixture.context);
  omitted.semanticUnitIds.pop();
  assert.equal((await validateStoryPreparationManifest(fixture.manifest, omitted)).ok, false);
  const duplicate = clone(fixture.context);
  duplicate.semanticUnitIds.push(duplicate.semanticUnitIds[0]);
  assert.equal((await validateStoryPreparationManifest(fixture.manifest, duplicate)).ok, false);
  const foreign = clone(fixture.context);
  foreign.semanticUnitIds[0] = "foreign-unit";
  assert.equal((await validateStoryPreparationManifest(fixture.manifest, foreign)).ok, false);
  await t.test("overlapping Story key", async () => {
    const current = await authorityFixture();
    const second = JSON.parse(current.context.storyCandidates[1].summary.slice("oxygen.story:".length));
    second.key = "a";
    current.context.storyCandidates[1].summary = `oxygen.story:${JSON.stringify(second)}`;
    assert.equal((await validateStoryPreparationManifest(current.manifest, current.context)).ok, false);
  });
  await t.test("duplicate Insight ID", async () => {
    const stories = [story("a"), { ...story("b"), insights: story("a").insights }];
    const current = await authorityFixture({ stories, privacyCandidates: [], preferenceCount: 1 });
    assert.equal((await validateStoryPreparationManifest(current.manifest, current.context)).ok, false);
  });
});

test("final target catalog is exact, namespaced, deterministic, and contains no retired vocabulary", async () => {
  const fixture = await authorityFixture();
  const ids = fixture.targetCatalog.map((target) => target.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const expected of [
    "a::phase", "a::title", "a::overview", "a::transition:before", "a::transition:after",
    "a::people:person-a:releaseLabel", "a::people:person-a:role",
    "a::people:person-a:description", "a::story:block-a", "a::uncertainty",
    "a::insight:insight-a:title", "a::insight:insight-a:background",
    "a::insight:insight-a:directlyAcquiredExperience", "a::insight:insight-a:principle",
  ]) assert.ok(ids.includes(expected), expected);
  assert.doesNotMatch(JSON.stringify(ids), /scene|reconstruction-|detail-|outcome/);
  assert.deepEqual(deriveStoryReleaseTargetCatalog([story("a"), story("b")]), fixture.targetCatalog);
});

test("Privacy candidate data rejects retired/private fields and invalid uncertainty states", async (t) => {
  const fixture = await authorityFixture();
  for (const field of [
    "recommendation", "suggestedRelease", "original", "evidence", "evidenceIds",
    "prompt", "provider", "model", "confidence", "rewrite", "reviewLedger",
  ]) await t.test(field, async () => {
    const manifest = clone(fixture.manifest);
    manifest.storyPrivacyCandidates[0].candidates[0][field] = "PRIVATE-SENTINEL";
    assert.equal((await validateStoryPreparationManifest(manifest, fixture.context)).ok, false);
  });
  for (const mutate of [
    (candidate) => { candidate.reviewState = "pending"; },
    (candidate) => { candidate.reviewState = "deterministic"; candidate.uncertaintyReason = "not null"; },
    (candidate) => { candidate.reviewState = "needs_confirmation"; candidate.uncertaintyReason = ""; },
  ]) {
    const manifest = clone(fixture.manifest);
    mutate(manifest.storyPrivacyCandidates[0].candidates[0]);
    assert.equal((await validateStoryPreparationManifest(manifest, fixture.context)).ok, false);
  }
});

test("Privacy target membership rejects old, foreign, duplicate, and empty target lists", async () => {
  const fixture = await authorityFixture();
  for (const targets of [
    ["a::scene"], ["a::recommendation"], ["foreign::title"],
    ["a::title", "a::title"], [],
  ]) {
    const manifest = clone(fixture.manifest);
    manifest.storyPrivacyCandidates[0].candidates[0].releaseTargets = targets;
    assert.equal((await validateStoryPreparationManifest(manifest, fixture.context)).ok, false);
  }
});

async function sqliteSnapshot(db) {
  const [probes, bulk, run] = await Promise.all([
    db.prepare(`SELECT id,answer_choice,answer_text,answered_at FROM probes ORDER BY id`).all(),
    db.prepare(`SELECT id,answer,answered_at FROM probe_bulk_decisions ORDER BY id`).all(),
    db.prepare(`SELECT * FROM probe_runs ORDER BY workflow_run_id`).all(),
  ]);
  return { probes: probes.results, bulk: bulk.results, run: run.results };
}

test("Preference import validates before mutation, supports zero, and real SQL failure preserves answers", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "oxygen-preference-authority-"));
  const previousStateDir = process.env.OXYGEN_VIEWER_STATE_DIR;
  process.env.OXYGEN_VIEWER_STATE_DIR = stateDir;
  try {
    const [{ getLocalDatabase }, route, preparation] = await Promise.all([
      import("../db/index.ts"),
      import("../app/api/probes/route.ts"),
      import("../lib/story-preparation.ts"),
    ]);
    const db = await getLocalDatabase();
    await db.prepare(`INSERT INTO workflow_runs
      (id,story_generation_status,story_source_revision,created_at,updated_at)
      VALUES (?,'running',?,?,?)`).bind(RUN_ID, SOURCE_REVISION, "2039-01-01", "2039-01-01").run();
    const probeAuthority = {
      id: "probe-1", documentId: "doc", documentKind: "trajectory", eventIds: ["doc:event"],
      timestamp: null, signal: "explicit_rule", score: 3, turns: 2,
      recap: "A contributor stated a rule.", question: "Keep this rule?",
      options: [{ id: "yes", text: "Yes" }], presentations: {},
      allowOther: true, allowSkip: true,
    };
    const outputDigest = await preparation.storyPreparationDigest(
      preparation.canonicalPreferenceQuestionBatch([probeAuthority], []),
    );
    const payload = {
      workflowRunId: RUN_ID,
      sourceRevision: SOURCE_REVISION,
      inputDigest: "c".repeat(64),
      outputDigest,
      outputCount: 1,
      probes: [probeAuthority],
      bulkDecisions: [],
      autoRemoved: { total: 0, reversible: true, categories: [] },
    };
    assert.equal((await route.POST(new Request("http://localhost/api/probes", {
      method: "POST", body: JSON.stringify(payload),
    }))).status, 200);
    await db.prepare(`UPDATE probes SET answer_choice='yes',answer_text='kept',answered_at='2039-01-02'
      WHERE id='probe-1'`).run();
    const answered = await sqliteSnapshot(db);

    const duplicatePayload = clone(payload);
    duplicatePayload.probes.push(clone(duplicatePayload.probes[0]));
    duplicatePayload.outputCount = 2;
    duplicatePayload.outputDigest = await preparation.storyPreparationDigest(
      preparation.canonicalPreferenceQuestionBatch(duplicatePayload.probes, []),
    );
    assert.equal((await route.POST(new Request("http://localhost/api/probes", {
      method: "POST", body: JSON.stringify(duplicatePayload),
    }))).status, 400);
    assert.deepEqual(await sqliteSnapshot(db), answered);

    await db.prepare(`CREATE TRIGGER force_probe_failure BEFORE INSERT ON probes
      BEGIN SELECT RAISE(ABORT,'forced Preference failure'); END`).run();
    const replacement = clone(payload);
    replacement.probes[0].id = "probe-2";
    replacement.outputDigest = await preparation.storyPreparationDigest(
      preparation.canonicalPreferenceQuestionBatch(replacement.probes, []),
    );
    assert.equal((await route.POST(new Request("http://localhost/api/probes", {
      method: "POST", body: JSON.stringify(replacement),
    }))).status, 409);
    assert.deepEqual(await sqliteSnapshot(db), answered);
    await db.prepare("DROP TRIGGER force_probe_failure").run();

    const zero = {
      workflowRunId: RUN_ID,
      sourceRevision: SOURCE_REVISION,
      inputDigest: "d".repeat(64),
      outputDigest: STORY_PREPARATION_EMPTY_ARRAY_DIGEST,
      outputCount: 0,
      probes: [],
      bulkDecisions: [],
      autoRemoved: { total: 0, reversible: true, categories: [] },
    };
    assert.equal((await route.POST(new Request("http://localhost/api/probes", {
      method: "POST", body: JSON.stringify(zero),
    }))).status, 200);
    const zeroState = await sqliteSnapshot(db);
    assert.deepEqual(zeroState.probes, []);
    assert.deepEqual(zeroState.bulk, []);
    assert.equal(zeroState.run[0].output_count, 0);
    assert.equal(zeroState.run[0].output_digest, STORY_PREPARATION_EMPTY_ARRAY_DIGEST);

    const stale = { ...zero, sourceRevision: SOURCE_REVISION + 1 };
    assert.equal((await route.POST(new Request("http://localhost/api/probes", {
      method: "POST", body: JSON.stringify(stale),
    }))).status, 409);
    assert.deepEqual(await sqliteSnapshot(db), zeroState);
  } finally {
    globalThis.__oxygenLocalSqlite?.database.close();
    delete globalThis.__oxygenLocalSqlite;
    if (previousStateDir === undefined) delete process.env.OXYGEN_VIEWER_STATE_DIR;
    else process.env.OXYGEN_VIEWER_STATE_DIR = previousStateDir;
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("preparation authority has no provider client or external network surface", async () => {
  const files = await Promise.all([
    readFile(new URL("../lib/story-preparation.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/probes/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/workflow/route.ts", import.meta.url), "utf8"),
  ]);
  const source = files.join("\n");
  assert.doesNotMatch(source, /fetch\(|axios|openai|anthropic|cloudflare|provider|modelId|model_id/i);
});
