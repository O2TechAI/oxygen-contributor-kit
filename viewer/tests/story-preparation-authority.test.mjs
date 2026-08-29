import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const utf8Sort = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));
const independentCanonicalJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(independentCanonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort(utf8Sort).map((key) => (
    `${JSON.stringify(key)}:${independentCanonicalJson(value[key])}`
  )).join(",")}}`;
};
const independentDigest = (value) => createHash("sha256")
  .update(independentCanonicalJson(value)).digest("hex");

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
      anchorStoryBlockId: `block-${key}`,
      quote: { text: `Story block ${key}.`, evidence },
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
    id: "candidate-cross-chapter",
    reviewState: "needs_confirmation",
    title: "One decision spans Chapters",
    whyFlagged: "The same privacy decision affects two final targets.",
    uncertaintyReason: "A contributor decision is required.",
    releaseTargets: ["a::title", "b::story:block-b"],
  }];
  const preferenceOutput = preferenceCount === 0 ? [] : [{ id: "question-1" }];
  const lessonOutput = stories.flatMap((source) => source.insights.map((insight) => ({
    storyKey: source.key,
    insightId: insight.id,
    ...(insight.title === undefined ? {} : { title: insight.title }),
    background: insight.background,
    directlyAcquiredExperience: insight.directlyAcquiredExperience,
    principle: insight.principle,
  })));
  const preference = {
    workflowRunId: RUN_ID,
    sourceRevision: SOURCE_REVISION,
    inputDigest: independentDigest(lessonOutput),
    outputDigest: independentDigest(preferenceOutput),
    outputCount: preferenceCount,
  };
  const storyOutput = storyCandidates.map((row, index) => ({
    id: row.id,
    story: { ...stories[index], insights: [] },
  }));
  const completeStoryOutput = storyCandidates.map((row, index) => ({
    id: row.id,
    story: stories[index],
  }));
  const insightCount = stories.reduce((total, source) => total + source.insights.length, 0);
  const insightOutput = insightCount === 0 ? [] : completeStoryOutput;
  const insightIdentities = stories.flatMap((source) => source.insights.map((insight) => ({
    storyKey: source.key,
    insightId: insight.id,
  }))).sort((left, right) => utf8Sort(left.storyKey, right.storyKey)
    || utf8Sort(left.insightId, right.insightId));
  const receipts = [{
    lane: "story",
    status: "complete",
    inputDigest: SEMANTIC_DIGEST,
    scopeDigest: independentDigest(semanticUnitIds),
    scopeCount: semanticUnitIds.length,
    outputDigest: independentDigest(storyOutput),
    outputCount: stories.length,
  }, {
    lane: "insight",
    status: "complete",
    inputDigest: independentDigest(storyOutput),
    scopeDigest: independentDigest(stories.map((source) => source.key).sort(utf8Sort)),
    scopeCount: stories.length,
    outputDigest: independentDigest(insightOutput),
    outputCount: insightCount,
  }, {
    lane: "story_privacy",
    status: "complete",
    inputDigest: independentDigest(completeStoryOutput),
    scopeDigest: independentDigest(targetCatalog.map((target) => target.id)),
    scopeCount: targetCatalog.length,
    outputDigest: independentDigest(privacy),
    outputCount: privacy.length,
  }, {
    lane: "preference",
    status: "complete",
    inputDigest: preference.inputDigest,
    scopeDigest: independentDigest(insightIdentities),
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
  assert.equal(result.authority.privacyCandidates.length, 1);
  assert.deepEqual(result.authority.privacyCandidates[0].releaseTargets, [
    "a::title", "b::story:block-b",
  ]);
});

test("fixed zero-Insight final Story structure independently binds Story Privacy input", async () => {
  const source = story("a", { insight: false });
  const expectedFinalStoryCandidates = [{ id: "doc:a", story: source }];
  const fixedDigest = "aed4c537c334b83d4de87a16446f4aa3a58b44708e8528a549d74c4f29afcf90";
  assert.equal(independentDigest(expectedFinalStoryCandidates), fixedDigest);
  const fixture = await authorityFixture({
    stories: [source], privacyCandidates: [], preferenceCount: 0,
  });
  assert.equal(
    fixture.manifest.receipts.find((receipt) => receipt.lane === "story_privacy").inputDigest,
    fixedDigest,
  );
  assert.equal((await validateStoryPreparationManifest(fixture.manifest, fixture.context)).ok, true);
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
  const privacyReceipt = result.authority.receipts.find((item) => item.lane === "story_privacy");
  assert.notEqual(privacyReceipt.inputDigest, STORY_PREPARATION_EMPTY_ARRAY_DIGEST);
  const emptyStory = clone(fixture);
  emptyStory.context.storyCandidates = [];
  assert.equal((await validateStoryPreparationManifest(emptyStory.manifest, emptyStory.context)).ok, false);
});

test("zero-Insight Story text changes invalidate completed-zero Privacy authority", async () => {
  const first = story("a", { insight: false });
  const second = clone(first);
  second.story.blocks[0].text = "A different final Story text must change Privacy authority.";
  const firstFixture = await authorityFixture({ stories: [first], privacyCandidates: [], preferenceCount: 0 });
  const secondFixture = await authorityFixture({ stories: [second], privacyCandidates: [], preferenceCount: 0 });
  const firstDigest = firstFixture.manifest.receipts.find((receipt) => receipt.lane === "story_privacy").inputDigest;
  const secondDigest = secondFixture.manifest.receipts.find((receipt) => receipt.lane === "story_privacy").inputDigest;
  assert.notEqual(firstDigest, secondDigest);
  assert.equal((await validateStoryPreparationManifest(firstFixture.manifest, secondFixture.context)).ok, false);
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

test("scope omission, duplicate, foreign, overlapping Story keys, and Chapter-local Insight IDs", async (t) => {
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
  await t.test("the same local Insight ID in two Chapters is valid", async () => {
    const first = story("a");
    const second = story("b");
    first.insights[0].id = "local-insight";
    second.insights[0].id = "local-insight";
    const stories = [first, second];
    const current = await authorityFixture({ stories, privacyCandidates: [], preferenceCount: 1 });
    const result = await validateStoryPreparationManifest(current.manifest, current.context);
    assert.equal(result.ok, true, result.code);
    const receipt = result.authority.receipts.find((item) => item.lane === "preference");
    assert.equal(receipt.scopeCount, 2);
    assert.equal(receipt.scopeDigest, independentDigest([
      { storyKey: "a", insightId: "local-insight" },
      { storyKey: "b", insightId: "local-insight" },
    ]));
  });
  await t.test("duplicate Insight IDs inside one Chapter remain invalid", async () => {
    const current = await authorityFixture();
    const duplicate = JSON.parse(current.context.storyCandidates[0].summary.slice("oxygen.story:".length));
    duplicate.insights.push(clone(duplicate.insights[0]));
    current.context.storyCandidates[0].summary = `oxygen.story:${JSON.stringify(duplicate)}`;
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
    "a::insight:insight-a:quote",
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
    manifest.storyPrivacyCandidates[0][field] = "PRIVATE-SENTINEL";
    assert.equal((await validateStoryPreparationManifest(manifest, fixture.context)).ok, false);
  });
  for (const mutate of [
    (candidate) => { candidate.reviewState = "pending"; },
    (candidate) => { candidate.reviewState = "deterministic"; candidate.uncertaintyReason = "not null"; },
    (candidate) => { candidate.reviewState = "needs_confirmation"; candidate.uncertaintyReason = ""; },
  ]) {
    const manifest = clone(fixture.manifest);
    mutate(manifest.storyPrivacyCandidates[0]);
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
    manifest.storyPrivacyCandidates[0].releaseTargets = targets;
    assert.equal((await validateStoryPreparationManifest(manifest, fixture.context)).ok, false);
  }
});

async function sqliteSnapshot(db) {
  const [probes, bulk, run] = await Promise.all([
    db.prepare(`SELECT * FROM probes ORDER BY id`).all(),
    db.prepare(`SELECT * FROM probe_bulk_decisions ORDER BY id`).all(),
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
    await db.prepare(`INSERT INTO documents
      (id,kind,title,item_count,imported_at,updated_at) VALUES (?,'trajectory','Synthetic',1,?,?)`)
      .bind("doc", "2039-01-01", "2039-01-01").run();
    await db.prepare(`INSERT INTO items
      (id,document_id,sequence,content,original_json) VALUES (?,?,1,'Synthetic event','{}')`)
      .bind("doc:event", "doc").run();
    const probeAuthority = {
      id: "probe-1", documentId: "doc", documentKind: "trajectory", eventIds: ["doc:event"],
      timestamp: null, signal: "explicit_rule", score: 3, turns: 2,
      recap: "A contributor stated a rule.", question: "Keep this rule?",
      options: [{ id: "yes", text: "Yes" }, { id: "no", text: "No" }], presentations: {},
      allowOther: true, allowSkip: true,
    };
    const bulkAuthority = {
      id: "bulk-1", kind: "repeated_rule", count: 1,
      question: "Keep this repeated rule?", evidenceSample: ["doc:event"], presentations: {},
    };
    const outputDigest = await preparation.storyPreparationDigest(
      preparation.canonicalPreferenceQuestionBatch([probeAuthority], [bulkAuthority]),
    );
    const payload = {
      workflowRunId: RUN_ID,
      sourceRevision: SOURCE_REVISION,
      inputDigest: "c".repeat(64),
      outputDigest,
      outputCount: 2,
      setAside: 1,
      probes: [probeAuthority],
      bulkDecisions: [bulkAuthority],
      autoRemoved: { total: 2, reversible: true, categories: [
        { kind: "credential", count: 1 },
        { kind: "private-personal", count: 1 },
      ] },
    };
    assert.equal((await route.POST(new Request("http://localhost/api/probes", {
      method: "POST", body: JSON.stringify(payload),
    }))).status, 200);
    await db.prepare(`UPDATE probes SET answer_choice='yes',answer_text='kept',answered_at='2039-01-02'
      WHERE id='probe-1'`).run();
    await db.prepare(`UPDATE probe_bulk_decisions SET answer='keep',answered_at='2039-01-02'
      WHERE id='bulk-1'`).run();
    const answered = await sqliteSnapshot(db);

    const racedReplacement = clone(payload);
    racedReplacement.probes[0].id = "probe-raced";
    racedReplacement.bulkDecisions[0].id = "bulk-raced";
    racedReplacement.outputDigest = await preparation.storyPreparationDigest(
      preparation.canonicalPreferenceQuestionBatch(
        racedReplacement.probes,
        racedReplacement.bulkDecisions,
      ),
    );
    const realBatch = db.batch.bind(db);
    db.batch = async (statements) => {
      await db.prepare(`UPDATE workflow_runs
        SET story_generation_status='blocked',story_source_revision=? WHERE id=?`)
        .bind(SOURCE_REVISION + 1, RUN_ID).run();
      return realBatch(statements);
    };
    assert.equal((await route.POST(new Request("http://localhost/api/probes", {
      method: "POST", body: JSON.stringify(racedReplacement),
    }))).status, 409);
    assert.deepEqual(await sqliteSnapshot(db), answered);
    db.batch = realBatch;
    await db.prepare(`UPDATE workflow_runs
      SET story_generation_status='running',story_source_revision=? WHERE id=?`)
      .bind(SOURCE_REVISION, RUN_ID).run();

    const duplicatePayload = clone(payload);
    duplicatePayload.probes.push(clone(duplicatePayload.probes[0]));
    duplicatePayload.outputCount = 2;
    duplicatePayload.outputDigest = await preparation.storyPreparationDigest(
      preparation.canonicalPreferenceQuestionBatch(duplicatePayload.probes, duplicatePayload.bulkDecisions),
    );
    assert.equal((await route.POST(new Request("http://localhost/api/probes", {
      method: "POST", body: JSON.stringify(duplicatePayload),
    }))).status, 400);
    assert.deepEqual(await sqliteSnapshot(db), answered);

    for (const mutate of [
      (candidate) => { delete candidate.probes[0].timestamp; },
      (candidate) => { candidate.probes[0].options = [{ id: "only", text: "Only" }]; },
      (candidate) => { candidate.probes[0].eventIds = ["foreign:event"]; },
      (candidate) => { candidate.bulkDecisions[0].evidenceSample = ["foreign:event"]; },
      (candidate) => { candidate.probes[0].documentKind = "meeting"; },
      (candidate) => { candidate.setAside = Number.MAX_SAFE_INTEGER + 1; },
      (candidate) => { candidate.autoRemoved.reversible = false; },
      (candidate) => { candidate.autoRemoved = {
        total: 1, reversible: true, categories: [{ kind: "user_path", count: 1 }],
      }; },
      (candidate) => { candidate.autoRemoved = {
        total: 1, reversible: true, categories: [{ kind: "third_party_contact", count: 1 }],
      }; },
      (candidate) => { candidate.autoRemoved = {
        total: 0, reversible: true, categories: [{ kind: "credential", count: 0 }],
      }; },
      (candidate) => { candidate.autoRemoved = {
        total: Number.MAX_SAFE_INTEGER + 1, reversible: true,
        categories: [{ kind: "credential", count: Number.MAX_SAFE_INTEGER + 1 }],
      }; },
      (candidate) => { candidate.autoRemoved = {
        total: 2, reversible: true, categories: [
          { kind: "private-personal", count: 1 },
          { kind: "credential", count: 1 },
        ],
      }; },
      (candidate) => { candidate.autoRemoved.removed_text = "old-private-field"; },
    ]) {
      const invalid = clone(payload);
      mutate(invalid);
      invalid.outputDigest = await preparation.storyPreparationDigest(
        preparation.canonicalPreferenceQuestionBatch(invalid.probes, invalid.bulkDecisions),
      );
      assert.equal((await route.POST(new Request("http://localhost/api/probes", {
        method: "POST", body: JSON.stringify(invalid),
      }))).status, 400);
      assert.deepEqual(await sqliteSnapshot(db), answered);
    }

    await db.prepare(`CREATE TRIGGER force_probe_failure BEFORE INSERT ON probes
      BEGIN SELECT RAISE(ABORT,'forced Preference failure'); END`).run();
    const replacement = clone(payload);
    replacement.probes[0].id = "probe-2";
    replacement.outputDigest = await preparation.storyPreparationDigest(
      preparation.canonicalPreferenceQuestionBatch(replacement.probes, replacement.bulkDecisions),
    );
    assert.equal((await route.POST(new Request("http://localhost/api/probes", {
      method: "POST", body: JSON.stringify(replacement),
    }))).status, 409);
    assert.deepEqual(await sqliteSnapshot(db), answered);
    await db.prepare("DROP TRIGGER force_probe_failure").run();

    const completedZeroSetAside = {
      workflowRunId: RUN_ID,
      sourceRevision: SOURCE_REVISION,
      inputDigest: "d".repeat(64),
      outputDigest: STORY_PREPARATION_EMPTY_ARRAY_DIGEST,
      outputCount: 0,
      setAside: 1,
      probes: [],
      bulkDecisions: [],
      autoRemoved: { total: 0, reversible: true, categories: [] },
    };
    assert.equal((await route.POST(new Request("http://localhost/api/probes", {
      method: "POST", body: JSON.stringify(completedZeroSetAside),
    }))).status, 400);
    assert.deepEqual(await sqliteSnapshot(db), answered);

    const zero = {
      workflowRunId: RUN_ID,
      sourceRevision: SOURCE_REVISION,
      inputDigest: "d".repeat(64),
      outputDigest: STORY_PREPARATION_EMPTY_ARRAY_DIGEST,
      outputCount: 0,
      setAside: 0,
      probes: [],
      bulkDecisions: [],
      autoRemoved: { total: 0, reversible: true, categories: [] },
    };
    let revisionZeroBatchCalls = 0;
    db.batch = async (statements) => {
      revisionZeroBatchCalls += 1;
      return realBatch(statements);
    };
    assert.equal((await route.POST(new Request("http://localhost/api/probes", {
      method: "POST", body: JSON.stringify({ ...zero, sourceRevision: 0 }),
    }))).status, 400);
    assert.equal(revisionZeroBatchCalls, 0);
    assert.deepEqual(await sqliteSnapshot(db), answered);
    db.batch = realBatch;

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

test("Preference GET and PATCH expose and mutate only current ready authority", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "oxygen-preference-current-"));
  const previousStateDir = process.env.OXYGEN_VIEWER_STATE_DIR;
  process.env.OXYGEN_VIEWER_STATE_DIR = stateDir;
  try {
    const [{ getLocalDatabase }, collectionRoute, itemRoute, preparation] = await Promise.all([
      import("../db/index.ts"),
      import("../app/api/probes/route.ts"),
      import("../app/api/probes/[id]/route.ts"),
      import("../lib/story-preparation.ts"),
    ]);
    const db = await getLocalDatabase();
    await db.prepare(`INSERT INTO workflow_runs
      (id,story_generation_status,story_source_revision,created_at,updated_at)
      VALUES (?,'running',?,?,?)`).bind(RUN_ID, SOURCE_REVISION, "2040-01-01", "2040-01-01").run();
    await db.prepare(`INSERT INTO documents
      (id,kind,title,item_count,imported_at,updated_at) VALUES (?,'meeting','Synthetic',1,?,?)`)
      .bind("meeting-doc", "2040-01-01", "2040-01-01").run();
    await db.prepare(`INSERT INTO items
      (id,document_id,sequence,content,original_json) VALUES (?,?,1,'Synthetic event','{}')`)
      .bind("meeting:event", "meeting-doc").run();
    const probe = {
      id: "current-probe", documentId: "meeting-doc", documentKind: "meeting",
      eventIds: ["meeting:event"], timestamp: null, signal: "explicit_rule", score: 50,
      turns: 1, recap: "A current rule.", question: "Keep the current rule?",
      options: [{ id: "yes", text: "Yes" }, { id: "no", text: "No" }],
      presentations: {}, allowOther: true, allowSkip: true,
    };
    const payload = {
      workflowRunId: RUN_ID,
      sourceRevision: SOURCE_REVISION,
      inputDigest: "e".repeat(64),
      outputDigest: await preparation.storyPreparationDigest(
        preparation.canonicalPreferenceQuestionBatch([probe], []),
      ),
      outputCount: 1,
      setAside: 0,
      probes: [probe],
      bulkDecisions: [],
      autoRemoved: { total: 0, reversible: true, categories: [] },
    };
    assert.equal((await collectionRoute.POST(new Request("http://localhost/api/probes", {
      method: "POST", body: JSON.stringify(payload),
    }))).status, 200);
    await db.prepare(`UPDATE workflow_runs SET story_generation_status='ready_for_human_review'
      WHERE id=?`).bind(RUN_ID).run();

    const currentProjection = await (await collectionRoute.GET()).json();
    assert.equal(currentProjection.probes.length, 1);
    assert.equal(currentProjection.run.source_revision, SOURCE_REVISION);
    const answer = await itemRoute.PATCH(new Request("http://localhost/api/probes/current-probe", {
      method: "PATCH", body: JSON.stringify({ choice: "yes" }),
    }), { params: Promise.resolve({ id: "current-probe" }) });
    assert.equal(answer.status, 200);
    assert.equal((await answer.json()).answer_choice, "yes");
    const clear = await itemRoute.PATCH(new Request("http://localhost/api/probes/current-probe", {
      method: "PATCH", body: JSON.stringify({ clear: true }),
    }), { params: Promise.resolve({ id: "current-probe" }) });
    assert.equal(clear.status, 200);
    assert.equal((await clear.json()).answer_choice, null);
    await itemRoute.PATCH(new Request("http://localhost/api/probes/current-probe", {
      method: "PATCH", body: JSON.stringify({ choice: "no" }),
    }), { params: Promise.resolve({ id: "current-probe" }) });
    const beforeStalePatch = await db.prepare(`SELECT answer_choice,answer_text,answered_at
      FROM probes WHERE id='current-probe'`).first();

    await db.prepare(`UPDATE workflow_runs SET story_source_revision=0 WHERE id=?`)
      .bind(RUN_ID).run();
    await db.prepare(`UPDATE probe_runs SET source_revision=0 WHERE workflow_run_id=?`)
      .bind(RUN_ID).run();
    assert.deepEqual(await (await collectionRoute.GET()).json(), {
      probes: [], bulkDecisions: [], run: null,
    });
    assert.equal((await itemRoute.PATCH(new Request("http://localhost/api/probes/current-probe", {
      method: "PATCH", body: JSON.stringify({ clear: true }),
    }), { params: Promise.resolve({ id: "current-probe" }) })).status, 409);
    assert.deepEqual(await db.prepare(`SELECT answer_choice,answer_text,answered_at
      FROM probes WHERE id='current-probe'`).first(), beforeStalePatch);
    await db.prepare(`UPDATE workflow_runs SET story_source_revision=? WHERE id=?`)
      .bind(SOURCE_REVISION, RUN_ID).run();
    await db.prepare(`UPDATE probe_runs SET source_revision=? WHERE workflow_run_id=?`)
      .bind(SOURCE_REVISION, RUN_ID).run();

    await db.prepare(`UPDATE workflow_runs SET story_source_revision=? WHERE id=?`)
      .bind(SOURCE_REVISION + 1, RUN_ID).run();
    assert.deepEqual(await (await collectionRoute.GET()).json(), {
      probes: [], bulkDecisions: [], run: null,
    });
    assert.equal((await itemRoute.PATCH(new Request("http://localhost/api/probes/current-probe", {
      method: "PATCH", body: JSON.stringify({ clear: true }),
    }), { params: Promise.resolve({ id: "current-probe" }) })).status, 409);
    assert.deepEqual(await db.prepare(`SELECT answer_choice,answer_text,answered_at
      FROM probes WHERE id='current-probe'`).first(), beforeStalePatch);

    await db.prepare(`UPDATE workflow_runs
      SET story_source_revision=?,story_generation_status='blocked' WHERE id=?`)
      .bind(SOURCE_REVISION, RUN_ID).run();
    assert.equal((await itemRoute.PATCH(new Request("http://localhost/api/probes/current-probe", {
      method: "PATCH", body: JSON.stringify({ clear: true }),
    }), { params: Promise.resolve({ id: "current-probe" }) })).status, 409);
    assert.deepEqual(await db.prepare(`SELECT answer_choice,answer_text,answered_at
      FROM probes WHERE id='current-probe'`).first(), beforeStalePatch);
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
