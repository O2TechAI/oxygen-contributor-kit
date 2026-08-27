import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { storyPreparationDigest } from "../lib/story-preparation.ts";

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

const RUN_ID = "story-privacy-run";
const SOURCE_REVISION = 7;
const EMPTY_DIGEST = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
const utf8Sort = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));

function story(key) {
  const evidence = { documentId: "doc", eventId: `doc:${key}` };
  return {
    schema: "oxygen.story",
    key,
    phase: { id: `phase-${key}`, label: "Build" },
    title: `Chapter ${key}`,
    overview: key === "a" ? "PRIVATE_SOURCE_SENTINEL" : `Overview ${key}.`,
    people: [{
      id: `person-${key}`, releaseLabel: "Contributor", role: "Owner",
      description: `Owner ${key}.`, localIdentityState: "not_identified", evidence: [evidence],
    }],
    story: { blocks: [{ id: `block-${key}`, text: `Block ${key}.`, evidence: [evidence] }] },
    insights: [],
    evidence: { primary: evidence, supporting: [] },
    coverage: {
      semanticManifest: { revision: 1, digest: "b".repeat(64) },
      coverageManifest: { revision: 1, digest: "c".repeat(64) },
      representedUnitIds: [], excludedUnits: [],
    },
  };
}

const STORIES = [story("a"), story("b")];
const STORY_ROWS = STORIES.map((source) => ({
  id: `doc:${source.key}`,
  summary: `oxygen.story:${JSON.stringify(source)}`,
}));
const ACTIVE_DIGEST = await storyPreparationDigest(STORY_ROWS);
const STORY_PRIVACY_INPUT_DIGEST = await storyPreparationDigest(STORIES.map((source) => ({
  id: `doc:${source.key}`,
  story: source,
})));

const deterministic = {
  id: "deterministic-candidate",
  reviewState: "deterministic",
  title: "Already safe",
  whyFlagged: "A deterministic rule already resolved this target.",
  uncertaintyReason: null,
  releaseTargets: ["a::overview"],
};
const crossChapter = {
  id: "candidate-cross-chapter",
  reviewState: "needs_confirmation",
  title: "One global decision",
  whyFlagged: "The candidate affects two Chapters.",
  uncertaintyReason: "Contributor confirmation is required.",
  releaseTargets: ["a::title", "b::story:block-b"],
};
const privateUseId = {
  id: "\uE000-candidate",
  reviewState: "needs_confirmation",
  title: "First by UTF-8",
  whyFlagged: "Ordering proof.",
  uncertaintyReason: "Contributor confirmation is required.",
  releaseTargets: ["a::title"],
};
const astralId = {
  id: "\u{10000}-candidate",
  reviewState: "needs_confirmation",
  title: "Second by UTF-8",
  whyFlagged: "Ordering proof.",
  uncertaintyReason: "Contributor confirmation is required.",
  releaseTargets: ["b::title"],
};

async function insertAuthority(db, candidates) {
  await db.prepare(`INSERT INTO workflow_runs
    (id,story_generation_status,story_source_revision,active_story_digest,created_at,updated_at)
    VALUES (?,'ready_for_human_review',?,?,?,?)`)
    .bind(RUN_ID, SOURCE_REVISION, ACTIVE_DIGEST, "2041-01-01T00:00:00.000Z", "2041-01-01T00:00:00.000Z").run();
  for (const [sequence, source] of STORIES.entries()) {
    await db.prepare(`INSERT INTO items
      (id,document_id,sequence,timestamp,content,original_json,organization_reason,
       event_type,actor_id,actor_type)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
      `doc:${source.key}`, "doc", sequence, null, "private source", "{}",
      `oxygen.story:${JSON.stringify(source)}`,
      "message", `contributor-${source.key}`, "human",
    ).run();
  }
  return replaceCandidates(db, candidates);
}

async function replaceCandidates(db, candidates) {
  const ordered = structuredClone(candidates).sort((left, right) => utf8Sort(left.id, right.id));
  const digest = await storyPreparationDigest(ordered);
  await db.prepare("DELETE FROM story_privacy_candidates WHERE workflow_run_id=?").bind(RUN_ID).run();
  await db.prepare("DELETE FROM story_preparation_receipts WHERE workflow_run_id=? AND lane='story_privacy'")
    .bind(RUN_ID).run();
  await db.prepare(`INSERT INTO story_preparation_receipts
    (workflow_run_id,lane,source_revision,input_digest,scope_digest,scope_count,
     output_digest,output_count,completed_at) VALUES (?,'story_privacy',?,?,?,?,?,?,?)`)
    .bind(RUN_ID, SOURCE_REVISION, STORY_PRIVACY_INPUT_DIGEST, "e".repeat(64), 1,
      digest, ordered.length, "2041-01-01T00:00:00.000Z").run();
  for (const candidate of ordered) {
    await db.prepare(`INSERT INTO story_privacy_candidates
      (workflow_run_id,candidate_id,candidate_json) VALUES (?,?,?)`)
      .bind(RUN_ID, candidate.id, JSON.stringify(candidate)).run();
  }
  return digest;
}

const get = (route, workflowRunId = RUN_ID) => route.GET(new Request(
  `http://localhost/api/story-privacy?workflowRunId=${encodeURIComponent(workflowRunId)}`,
));
const patch = (route, id, body) => route.PATCH(new Request(
  `http://localhost/api/story-privacy/${encodeURIComponent(id)}`,
  { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
), { params: Promise.resolve({ id }) });

test("Story Privacy routes expose only current flat authority and fail closed", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "oxygen-story-privacy-authority-"));
  const previousStateDir = process.env.OXYGEN_VIEWER_STATE_DIR;
  process.env.OXYGEN_VIEWER_STATE_DIR = stateDir;
  try {
    const [{ getLocalDatabase }, collectionRoute, candidateRoute] = await Promise.all([
      import("../db/index.ts"),
      import("../app/api/story-privacy/route.ts"),
      import("../app/api/story-privacy/[id]/route.ts"),
    ]);
    assert.equal("DELETE" in candidateRoute, false);
    const db = await getLocalDatabase();
    const candidates = [astralId, crossChapter, deterministic, privateUseId];
    await insertAuthority(db, candidates);

    const currentResponse = await get(collectionRoute);
    assert.equal(currentResponse.status, 200);
    assert.equal(currentResponse.headers.get("cache-control"), "no-store, max-age=0");
    const current = await currentResponse.json();
    const candidateDigest = current.candidateDigest;
    assert.deepEqual(current, {
      workflowRunId: RUN_ID,
      sourceRevision: SOURCE_REVISION,
      activeStoryDigest: ACTIVE_DIGEST,
      candidateDigest,
      status: "completed_with_candidates",
      candidates: [crossChapter, deterministic, privateUseId, astralId]
        .sort((left, right) => utf8Sort(left.id, right.id))
        .map((candidate) => ({ ...candidate, decision: null, decisionVersion: 0, decidedAt: null })),
    });
    assert.equal(current.candidates.filter((candidate) => candidate.id === crossChapter.id).length, 1);
    assert.equal(JSON.stringify(current).includes("PRIVATE_SOURCE_SENTINEL"), false);
    assert.equal(JSON.stringify(current).includes("candidate_json"), false);
    assert.deepEqual(Object.keys(current.candidates[0]).sort(), [
      "decidedAt", "decision", "decisionVersion", "id", "releaseTargets", "reviewState",
      "title", "uncertaintyReason", "whyFlagged",
    ].sort());
    await db.prepare(`UPDATE story_privacy_candidates
      SET decision='keep',decision_version=1,decided_at='2041-01-02T00:00:00.000Z'
      WHERE candidate_id=?`).bind(deterministic.id).run();
    assert.equal((await get(collectionRoute)).status, 409);
    await db.prepare(`UPDATE story_privacy_candidates
      SET decision=NULL,decision_version=0,decided_at=NULL WHERE candidate_id=?`)
      .bind(deterministic.id).run();

    const binding = {
      workflowRunId: RUN_ID,
      sourceRevision: SOURCE_REVISION,
      activeStoryDigest: ACTIVE_DIGEST,
      candidateDigest,
      expectedVersion: 0,
      decision: "keep",
    };
    const undecided = {
      decision: null, decision_version: 0, decided_at: null,
    };
    await db.prepare("UPDATE workflow_runs SET active_story_digest=? WHERE id=?")
      .bind("f".repeat(64), RUN_ID).run();
    assert.equal((await get(collectionRoute)).status, 409);
    assert.equal((await patch(candidateRoute, crossChapter.id, binding)).status, 409);
    assert.deepEqual(await db.prepare(`SELECT decision,decision_version,decided_at
      FROM story_privacy_candidates WHERE candidate_id=?`).bind(crossChapter.id).first(), undecided);
    await db.prepare("UPDATE workflow_runs SET active_story_digest=? WHERE id=?")
      .bind(ACTIVE_DIGEST, RUN_ID).run();

    const mutatedStory = { ...STORIES[0], overview: "Changed Story text with the same release targets." };
    await db.prepare("UPDATE items SET organization_reason=? WHERE id=?")
      .bind(`oxygen.story:${JSON.stringify(mutatedStory)}`, STORY_ROWS[0].id).run();
    assert.equal((await get(collectionRoute)).status, 409);
    assert.equal((await patch(candidateRoute, crossChapter.id, binding)).status, 409);
    assert.deepEqual(await db.prepare(`SELECT decision,decision_version,decided_at
      FROM story_privacy_candidates WHERE candidate_id=?`).bind(crossChapter.id).first(), undecided);
    await db.prepare("UPDATE items SET organization_reason=? WHERE id=?")
      .bind(STORY_ROWS[0].summary, STORY_ROWS[0].id).run();

    assert.equal((await patch(candidateRoute, deterministic.id, binding)).status, 409);
    assert.equal((await patch(candidateRoute, "missing-candidate", binding)).status, 404);

    for (const invalid of [
      { ...binding, decision: "toggle" },
      { ...binding, expectedVersion: 1 },
      { ...binding, decidedAt: "1999-01-01T00:00:00.000Z" },
      { ...binding, clear: true },
      { ...binding, candidateDigest: "not-a-digest" },
      Object.fromEntries(Object.entries(binding).filter(([key]) => key !== "activeStoryDigest")),
    ]) {
      assert.equal((await patch(candidateRoute, crossChapter.id, invalid)).status, 400);
    }
    for (const stale of [
      { ...binding, sourceRevision: SOURCE_REVISION - 1 },
      { ...binding, activeStoryDigest: "f".repeat(64) },
      { ...binding, candidateDigest: "0".repeat(64) },
    ]) {
      assert.equal((await patch(candidateRoute, crossChapter.id, stale)).status, 409);
    }

    const started = Date.now();
    const keptResponse = await patch(candidateRoute, crossChapter.id, binding);
    assert.equal(keptResponse.status, 200);
    const kept = await keptResponse.json();
    assert.equal(kept.decision, "keep");
    assert.equal(kept.decisionVersion, 1);
    assert.ok(Date.parse(kept.decidedAt) >= started);
    assert.notEqual(kept.decidedAt, "1999-01-01T00:00:00.000Z");
    assert.equal((await patch(candidateRoute, crossChapter.id, binding)).status, 409);
    const persistedKeep = await db.prepare(`SELECT decision,decision_version,decided_at
      FROM story_privacy_candidates WHERE candidate_id=?`).bind(crossChapter.id).first();
    assert.deepEqual(persistedKeep, {
      decision: "keep", decision_version: 1, decided_at: kept.decidedAt,
    });

    const redactBinding = { ...binding, decision: "redact" };
    assert.equal((await patch(candidateRoute, privateUseId.id, redactBinding)).status, 200);
    assert.equal((await patch(candidateRoute, privateUseId.id, binding)).status, 409);

    const zeroDigest = await replaceCandidates(db, []);
    assert.equal(zeroDigest, EMPTY_DIGEST);
    const emptyResponse = await get(collectionRoute);
    assert.equal(emptyResponse.status, 200);
    const emptyAuthority = await emptyResponse.json();
    assert.match(emptyAuthority.candidateDigest, /^[0-9a-f]{64}$/u);
    assert.deepEqual(emptyAuthority, {
      workflowRunId: RUN_ID,
      sourceRevision: SOURCE_REVISION,
      activeStoryDigest: ACTIVE_DIGEST,
      candidateDigest: emptyAuthority.candidateDigest,
      status: "completed_empty",
      candidates: [],
    });
    await db.prepare("DELETE FROM story_preparation_receipts WHERE workflow_run_id=?").bind(RUN_ID).run();
    assert.equal((await get(collectionRoute)).status, 409);

    const validDigest = await replaceCandidates(db, [crossChapter]);
    const receipt = await db.prepare(`SELECT * FROM story_preparation_receipts
      WHERE workflow_run_id=? AND lane='story_privacy'`).bind(RUN_ID).first();
    const candidateRow = await db.prepare(`SELECT candidate_json FROM story_privacy_candidates
      WHERE workflow_run_id=? AND candidate_id=?`).bind(RUN_ID, crossChapter.id).first();
    const assertClosed = async (mutate, restore) => {
      await mutate();
      assert.equal((await get(collectionRoute)).status, 409);
      await restore();
    };
    await assertClosed(
      () => db.prepare("UPDATE story_preparation_receipts SET source_revision=? WHERE workflow_run_id=?")
        .bind(SOURCE_REVISION - 1, RUN_ID).run(),
      () => db.prepare("UPDATE story_preparation_receipts SET source_revision=? WHERE workflow_run_id=?")
        .bind(SOURCE_REVISION, RUN_ID).run(),
    );
    await assertClosed(
      () => db.prepare("UPDATE story_preparation_receipts SET input_digest=? WHERE workflow_run_id=?")
        .bind("1".repeat(64), RUN_ID).run(),
      () => db.prepare("UPDATE story_preparation_receipts SET input_digest=? WHERE workflow_run_id=?")
        .bind(STORY_PRIVACY_INPUT_DIGEST, RUN_ID).run(),
    );
    await assertClosed(
      () => db.prepare("UPDATE workflow_runs SET story_generation_status='blocked' WHERE id=?").bind(RUN_ID).run(),
      () => db.prepare("UPDATE workflow_runs SET story_generation_status='ready_for_human_review' WHERE id=?")
        .bind(RUN_ID).run(),
    );
    await assertClosed(
      () => db.prepare("UPDATE workflow_runs SET active_story_digest=NULL WHERE id=?").bind(RUN_ID).run(),
      () => db.prepare("UPDATE workflow_runs SET active_story_digest=? WHERE id=?").bind(ACTIVE_DIGEST, RUN_ID).run(),
    );
    await assertClosed(
      () => db.prepare("UPDATE story_preparation_receipts SET output_count=2 WHERE workflow_run_id=?")
        .bind(RUN_ID).run(),
      () => db.prepare("UPDATE story_preparation_receipts SET output_count=1 WHERE workflow_run_id=?")
        .bind(RUN_ID).run(),
    );
    await assertClosed(
      () => db.prepare("UPDATE story_preparation_receipts SET output_digest=? WHERE workflow_run_id=?")
        .bind("1".repeat(64), RUN_ID).run(),
      () => db.prepare("UPDATE story_preparation_receipts SET output_digest=? WHERE workflow_run_id=?")
        .bind(validDigest, RUN_ID).run(),
    );
    await assertClosed(
      () => db.prepare("UPDATE story_privacy_candidates SET candidate_json='{' WHERE candidate_id=?")
        .bind(crossChapter.id).run(),
      () => db.prepare("UPDATE story_privacy_candidates SET candidate_json=? WHERE candidate_id=?")
        .bind(candidateRow.candidate_json, crossChapter.id).run(),
    );
    const arbitraryCandidate = { ...crossChapter, providerOutput: "PRIVATE_PROVIDER_SENTINEL" };
    await db.prepare("UPDATE story_privacy_candidates SET candidate_json=? WHERE candidate_id=?")
      .bind(JSON.stringify(arbitraryCandidate), crossChapter.id).run();
    await db.prepare("UPDATE story_preparation_receipts SET output_digest=? WHERE workflow_run_id=?")
      .bind(await storyPreparationDigest([arbitraryCandidate]), RUN_ID).run();
    assert.equal((await get(collectionRoute)).status, 409);
    await db.prepare("UPDATE story_privacy_candidates SET candidate_json=? WHERE candidate_id=?")
      .bind(candidateRow.candidate_json, crossChapter.id).run();
    await db.prepare("UPDATE story_preparation_receipts SET output_digest=? WHERE workflow_run_id=?")
      .bind(receipt.output_digest, RUN_ID).run();
    const foreignTarget = { ...crossChapter, releaseTargets: ["foreign::title"] };
    await db.prepare("UPDATE story_privacy_candidates SET candidate_json=? WHERE candidate_id=?")
      .bind(JSON.stringify(foreignTarget), crossChapter.id).run();
    await db.prepare("UPDATE story_preparation_receipts SET output_digest=? WHERE workflow_run_id=?")
      .bind(await storyPreparationDigest([foreignTarget]), RUN_ID).run();
    assert.equal((await get(collectionRoute)).status, 409);
    await db.prepare("UPDATE story_privacy_candidates SET candidate_json=? WHERE candidate_id=?")
      .bind(candidateRow.candidate_json, crossChapter.id).run();
    await db.prepare("UPDATE story_preparation_receipts SET output_digest=? WHERE workflow_run_id=?")
      .bind(receipt.output_digest, RUN_ID).run();

    assert.equal((await get(collectionRoute, "foreign-run")).status, 404);
    await db.prepare(`INSERT INTO workflow_runs (id,created_at,updated_at) VALUES ('second-run','x','x')`).run();
    assert.equal((await get(collectionRoute)).status, 409);
  } finally {
    globalThis.__oxygenLocalSqlite?.database.close();
    delete globalThis.__oxygenLocalSqlite;
    if (previousStateDir === undefined) delete process.env.OXYGEN_VIEWER_STATE_DIR;
    else process.env.OXYGEN_VIEWER_STATE_DIR = previousStateDir;
    await rm(stateDir, { recursive: true, force: true });
  }
});
