import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import {
  applyChapterReview,
  editAiInsight,
  emptyChapterReview,
  markChapterReady,
  recordStoryEdit,
  saveHumanInsight,
  storyBlocks,
  updateAiInsightDecision,
} from "../lib/story-review.ts";
import { createStoryReviewSession } from "../lib/story-review-session.ts";
import { storyPreparationDigest } from "../lib/story-preparation.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL && specifier.startsWith(".")) {
      const path = fileURLToPath(new URL(specifier, context.parentURL));
      if (!extname(path)) {
        if (existsSync(`${path}.ts`)) return nextResolve(`${specifier}.ts`, context);
        if (existsSync(join(path, "index.ts"))) return nextResolve(`${specifier}/index.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const {
  buildReviewedStoryPrivacyPreparationSnapshot,
  decideStoryPrivacyCandidate,
  importReviewedStoryPrivacyAuthority,
  readStoryPrivacyAuthority,
} = await import("../lib/story-privacy-authority.ts");
const { reconstructReviewedStoryPrivacyRevision } = await import("../lib/story-privacy-revision.ts");
const importRoute = await import("../app/api/story-privacy/import/route.ts");
const execFile = promisify(execFileCallback);

const RUN_ID = "reviewed-story-privacy-run";
const SOURCE_REVISION = 19;
const NOW = "2044-01-01T00:00:00.000Z";
const evidence = { documentId: "doc", eventId: "doc:event" };
const sourceInsight = {
  id: "source-insight",
  title: "Initial insight title",
  background: "Initial insight background",
  quote: { storyBlockIds: ["block-two"] },
  directlyAcquiredExperience: "Initial direct experience",
  principle: "Initial principle",
  evidence: [evidence],
};
const source = {
  schema: "oxygen.story",
  key: "chapter-one",
  phase: { id: "phase-one", label: "Build" },
  title: "Stable title",
  overview: "Stable overview",
  people: [{
    id: "person", releaseLabel: "Contributor", role: "Owner", description: "Stable person",
    localIdentityState: "not_identified", evidence: [evidence],
  }],
  story: { blocks: [
    { id: "block-one", text: "The first block is original.", evidence: [evidence] },
    { id: "block-two", text: "The second block contains an exact quotation.", evidence: [evidence] },
  ] },
  insights: [sourceInsight],
  evidence: { primary: evidence, supporting: [] },
  coverage: {
    semanticManifest: { revision: 1, digest: "a".repeat(64) },
    coverageManifest: { revision: 1, digest: "b".repeat(64) },
    representedUnitIds: [], excludedUnits: [],
  },
};
const summary = `oxygen.story:${JSON.stringify(source)}`;
const activeDigest = await storyPreparationDigest([{ id: evidence.eventId, summary }]);
const inputDigest = await storyPreparationDigest([{ id: evidence.eventId, story: source }]);

function context(state = null, supportedEditIds = []) {
  const blocks = storyBlocks(source);
  return {
    source, privacyCandidates: [], privacyDecisions: {}, targetCatalog: new Map(),
    evidenceResolved: true, supportedAddIds: [], supportedEditIds,
    sourceBlocks: blocks,
    reviewedBlocks: state ? {
      en: Object.fromEntries(source.story.blocks.map((block) => [block.id, block.text])), zh: {},
    } : blocks,
  };
}

function reviewedState() {
  let state = emptyChapterReview(source);
  state = updateAiInsightDecision(state, source, sourceInsight.id, "accepted");
  state = applyChapterReview(state, context(state)).state;
  state.stage = "revision_ready";
  const edited = { ...sourceInsight,
    title: "Edited insight title", background: "Edited source insight background" };
  delete edited.id;
  state = editAiInsight(state, source, sourceInsight.id, edited);
  state = updateAiInsightDecision(state, source, sourceInsight.id, "accepted");
  const quoteText = "exact quotation";
  const quoteStart = source.story.blocks[1].text.indexOf(quoteText);
  state = saveHumanInsight(state, context(state), "human:added", {
    background: "PRIVATE_REVIEWED_TEXT_SENTINEL",
    quote: {
      chapterKey: source.key, storyBlockId: "block-two",
      selection: { start: quoteStart, end: quoteStart + quoteText.length, text: quoteText },
      baseRevision: state.revision,
    },
    directlyAcquiredExperience: "Human direct experience",
    principle: "Human principle",
    evidence: [evidence],
  }).state;
  const edit = recordStoryEdit(state, {
    storyKey: source.key, blockId: "block-one", sourceLanguage: "en",
    baseText: source.story.blocks[0].text,
    nextText: "The first block is reviewed.", supportingEvidence: [evidence], now: 100,
  });
  assert.ok(edit.transactionId);
  state = applyChapterReview(edit.state, context(edit.state, [edit.transactionId])).state;
  if (state.stage !== "revision_ready") state = applyChapterReview(state, context(state)).state;
  const confirmed = markChapterReady(state, context(state));
  assert.equal(confirmed.stage, "human_confirmed");
  return confirmed;
}

function unchangedReviewedState() {
  let state = updateAiInsightDecision(emptyChapterReview(source), source, sourceInsight.id, "accepted");
  state = applyChapterReview(state, context(state)).state;
  return markChapterReady(state, context(state));
}

const unchanged = {
  id: "unchanged-candidate", reviewState: "needs_confirmation", title: "Stable finding",
  whyFlagged: "Stable title requires one decision.", uncertaintyReason: "Confirmation required.",
  releaseTargets: ["chapter-one::title"],
};
const changed = {
  id: "same-id-replacement", reviewState: "needs_confirmation", title: "Old block finding",
  whyFlagged: "The original block required one decision.", uncertaintyReason: "Confirmation required.",
  releaseTargets: ["chapter-one::story:block-one"],
};

async function insertInitial(db) {
  await db.prepare(`INSERT INTO workflow_runs
    (id,story_generation_status,story_source_revision,active_story_digest,created_at,updated_at)
    VALUES (?,'ready_for_human_review',?,?,?,?)`)
    .bind(RUN_ID, SOURCE_REVISION, activeDigest, NOW, NOW).run();
  await db.prepare(`INSERT INTO items
    (id,document_id,sequence,content,original_json,organization_reason,event_type,actor_id,actor_type)
    VALUES (?,'doc',0,'PRIVATE_SOURCE_SENTINEL','{}',?,'message','person','human')`)
    .bind(evidence.eventId, summary).run();
  const candidates = [changed, unchanged].sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
  const outputDigest = await storyPreparationDigest(candidates);
  await db.prepare(`INSERT INTO story_preparation_receipts
    (workflow_run_id,lane,source_revision,input_digest,scope_digest,scope_count,
     output_digest,output_count,completed_at) VALUES (?,'story_privacy',?,?,?,?,?,?,?)`)
    .bind(RUN_ID, SOURCE_REVISION, inputDigest, "c".repeat(64), 1,
      outputDigest, candidates.length, NOW).run();
  for (const candidate of candidates) {
    await db.prepare(`INSERT INTO story_privacy_candidates
      (workflow_run_id,candidate_id,candidate_json) VALUES (?,?,?)`)
      .bind(RUN_ID, candidate.id, JSON.stringify(candidate)).run();
  }
  await db.prepare(`UPDATE story_privacy_candidates
    SET decision='keep',decision_version=1,decided_at=? WHERE candidate_id=?`)
    .bind(NOW, unchanged.id).run();
  await db.prepare(`UPDATE story_privacy_candidates
    SET decision='redact',decision_version=1,decided_at=? WHERE candidate_id=?`)
    .bind(NOW, changed.id).run();
}

function bundle(snapshot, candidates, completedAt = "2044-01-02T00:00:00.000Z") {
  return (async () => {
    const terminalReceipt = {
      schema: "oxygen.reviewed-story-privacy-terminal-receipt", status: "complete",
      ...Object.fromEntries(Object.entries(snapshot.binding).filter(([key]) => key !== "previousBatchDigest")),
      outputDigest: await storyPreparationDigest(candidates), outputCount: candidates.length, completedAt,
    };
    const receiptDigest = await storyPreparationDigest(terminalReceipt);
    const core = {
      schema: "oxygen.reviewed-story-privacy-import", binding: snapshot.binding,
      receiptDigest, candidates,
    };
    return { schema: core.schema, binding: core.binding, terminalReceipt, receiptDigest,
      candidates, batchDigest: await storyPreparationDigest(core) };
  })();
}

test("reviewed Story changes use one atomic current Privacy authority", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "reviewed-story-privacy-"));
  const previous = process.env.OXYGEN_VIEWER_STATE_DIR;
  process.env.OXYGEN_VIEWER_STATE_DIR = stateDir;
  try {
    const { getLocalDatabase } = await import("../db/index.ts");
    const db = await getLocalDatabase();
    await insertInitial(db);
    const initial = await readStoryPrivacyAuthority(db, RUN_ID);
    assert.equal(initial.ok, true);
    assert.equal(initial.authority.candidates.find((item) => item.id === unchanged.id).decision, "keep");
    const oldBrowserDigest = initial.authority.candidateDigest;

    const unchangedSession = createStoryReviewSession(
      RUN_ID, { [source.key]: unchangedReviewedState() }, {},
    );
    await db.prepare(`INSERT INTO story_review_sessions
      (workflow_run_id,state_json,updated_at,server_version) VALUES (?,?,?,1)`)
      .bind(RUN_ID, JSON.stringify({ sourceRevision: SOURCE_REVISION, session: unchangedSession }), NOW).run();
    const unchangedRevision = await reconstructReviewedStoryPrivacyRevision(db, RUN_ID);
    assert.equal(unchangedRevision.ok, true);
    assert.deepEqual(unchangedRevision.revision.changedTargets, []);
    const unchangedAuthority = await readStoryPrivacyAuthority(db, RUN_ID);
    assert.equal(unchangedAuthority.ok, true);
    assert.equal(unchangedAuthority.authority.status, "completed_with_candidates");
    assert.equal(unchangedAuthority.authority.candidates.find((item) => item.id === unchanged.id).decision, "keep");

    const session = createStoryReviewSession(RUN_ID, { [source.key]: reviewedState() }, {});
    await db.prepare(`UPDATE story_review_sessions SET state_json=?,server_version=2 WHERE workflow_run_id=?`)
      .bind(JSON.stringify({ sourceRevision: SOURCE_REVISION, session }), RUN_ID).run();

    const revision = await reconstructReviewedStoryPrivacyRevision(db, RUN_ID);
    assert.equal(revision.ok, true);
    const changedIds = new Set(revision.revision.changedTargets.map((target) => target.id));
    assert.deepEqual([...changedIds], [
      "chapter-one::story:block-one",
      "chapter-one::insight:source-insight:title",
      "chapter-one::insight:source-insight:background",
      "chapter-one::insight:human:added:background",
      "chapter-one::insight:human:added:directlyAcquiredExperience",
      "chapter-one::insight:human:added:principle",
    ]);

    const pending = await readStoryPrivacyAuthority(db, RUN_ID);
    assert.equal(pending.ok, true);
    assert.equal(pending.authority.status, "preparation_required");
    assert.deepEqual(pending.authority.candidates.map((item) => [item.id, item.decision]), [[unchanged.id, "keep"]]);
    const prepared = await buildReviewedStoryPrivacyPreparationSnapshot(db, RUN_ID);
    assert.equal(prepared.ok, true);
    assert.equal(JSON.stringify(pending.authority).includes("PRIVATE_REVIEWED_TEXT_SENTINEL"), false);

    const replacement = {
      ...changed, title: "Replacement current finding",
      whyFlagged: "Only the reviewed block is current.",
    };
    const firstBundle = await bundle(prepared.snapshot, [replacement]);
    await db.prepare("UPDATE story_review_sessions SET server_version=3 WHERE workflow_run_id=?")
      .bind(RUN_ID).run();
    assert.equal((await importReviewedStoryPrivacyAuthority(db, firstBundle, NOW)).ok, false);
    await db.prepare("UPDATE story_review_sessions SET server_version=2 WHERE workflow_run_id=?")
      .bind(RUN_ID).run();
    await db.prepare("UPDATE workflow_runs SET story_source_revision=? WHERE id=?")
      .bind(SOURCE_REVISION + 1, RUN_ID).run();
    assert.equal((await importReviewedStoryPrivacyAuthority(db, firstBundle, NOW)).ok, false);
    await db.prepare("UPDATE workflow_runs SET story_source_revision=? WHERE id=?")
      .bind(SOURCE_REVISION, RUN_ID).run();
    const tampered = structuredClone(firstBundle);
    tampered.terminalReceipt.outputCount = 0;
    const before = await db.prepare(`SELECT candidate_id,decision FROM story_privacy_candidates
      ORDER BY candidate_id`).all();
    assert.equal((await importReviewedStoryPrivacyAuthority(db, tampered, NOW)).ok, false);
    const tamperedResponse = await importRoute.POST(new Request("http://localhost/api/story-privacy/import", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(tampered),
    }));
    assert.equal(tamperedResponse.status, 400);
    assert.deepEqual((await db.prepare(`SELECT candidate_id,decision FROM story_privacy_candidates
      ORDER BY candidate_id`).all()).results, before.results);

    const completedZero = await bundle(prepared.snapshot, []);
    assert.equal((await importReviewedStoryPrivacyAuthority(db, completedZero, NOW)).ok, true);
    assert.deepEqual((await db.prepare(`SELECT candidate_id,decision FROM story_privacy_candidates
      ORDER BY candidate_id`).all()).results, [{ candidate_id: unchanged.id, decision: "keep" }]);
    const replacementPreparation = await buildReviewedStoryPrivacyPreparationSnapshot(db, RUN_ID);
    assert.equal(replacementPreparation.ok, true);
    const validBundle = await bundle(replacementPreparation.snapshot, [replacement]);
    const beforeReplacement = await db.prepare(`SELECT candidate_id,decision FROM story_privacy_candidates
      ORDER BY candidate_id`).all();

    const realPrepare = db.prepare.bind(db);
    let injected = false;
    db.prepare = (sql) => {
      if (!injected && /^INSERT INTO story_privacy_authorities/u.test(sql)) {
        injected = true;
        throw new Error("injected rollback");
      }
      return realPrepare(sql);
    };
    assert.equal((await importReviewedStoryPrivacyAuthority(db, validBundle, NOW)).ok, false);
    db.prepare = realPrepare;
    assert.equal(injected, true);
    assert.deepEqual((await db.prepare(`SELECT candidate_id,decision FROM story_privacy_candidates
      ORDER BY candidate_id`).all()).results, beforeReplacement.results);

    const concurrent = await Promise.all([
      importReviewedStoryPrivacyAuthority(db, validBundle, NOW),
      importReviewedStoryPrivacyAuthority(db, validBundle, NOW),
    ]);
    assert.deepEqual(concurrent.map((result) => result.ok).sort(), [false, true]);
    const current = await readStoryPrivacyAuthority(db, RUN_ID);
    assert.equal(current.ok, true);
    assert.deepEqual(current.authority.candidates.map((item) => [item.id, item.decision]), [
      [replacement.id, null], [unchanged.id, "keep"],
    ].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
    assert.equal(current.authority.candidateDigest, validBundle.batchDigest);
    assert.notEqual(current.authority.candidateDigest, oldBrowserDigest);
    assert.equal((await decideStoryPrivacyCandidate(db, {
      workflowRunId: RUN_ID, sourceRevision: SOURCE_REVISION, activeStoryDigest: activeDigest,
      candidateDigest: oldBrowserDigest, expectedVersion: 0, decision: "redact",
    }, replacement.id, "2044-01-03T00:00:00.000Z")).ok, false);
    assert.equal((await decideStoryPrivacyCandidate(db, {
      workflowRunId: RUN_ID, sourceRevision: SOURCE_REVISION, activeStoryDigest: activeDigest,
      candidateDigest: current.authority.candidateDigest, expectedVersion: 0, decision: "keep",
    }, replacement.id, "2044-01-03T00:00:00.000Z")).ok, true);
    assert.doesNotMatch(JSON.stringify(current.authority), /PRIVATE_SOURCE_SENTINEL|PRIVATE_REVIEWED_TEXT_SENTINEL|Evidence|provider|candidate_json/iu);
  } finally {
    globalThis.__oxygenLocalSqlite?.database.close();
    delete globalThis.__oxygenLocalSqlite;
    if (previous === undefined) delete process.env.OXYGEN_VIEWER_STATE_DIR;
    else process.env.OXYGEN_VIEWER_STATE_DIR = previous;
    await rm(stateDir, { recursive: true, force: true });
  }
});

async function createScriptFixture(directory) {
  if (!existsSync(directory)) await mkdir(directory);
  const target = {
    id: "chapter::story:block", storyKey: "chapter", target: "story:block",
    content: "Reviewed private candidate input", contentDigest: await storyPreparationDigest("Reviewed private candidate input"),
  };
  const binding = {
    workflowRunId: "script-run", sourceRevision: 3, activeStoryDigest: "a".repeat(64),
    serverVersion: 2, reviewedStoryDigest: "b".repeat(64), targetCatalogDigest: "c".repeat(64),
    changedTargetDigest: await storyPreparationDigest([target.id]), changedTargetCount: 1,
    previousBatchDigest: "d".repeat(64),
  };
  const snapshotPath = join(directory, "snapshot.json");
  const root = join(directory, "prepared");
  await writeFile(snapshotPath, JSON.stringify({
    schema: "oxygen.reviewed-story-privacy-snapshot", binding, changedTargets: [target],
  }));
  const prepare = join(process.cwd(), "..", "skills", "oxygen-storytelling-review", "scripts",
    "prepare_reviewed_story_privacy.mjs");
  await execFile(process.execPath, [prepare, snapshotPath, root]);
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  const candidates = [{
    id: "candidate", reviewState: "needs_confirmation", title: "Bounded finding",
    whyFlagged: "The reviewed block requires confirmation.",
    uncertaintyReason: "Contributor confirmation is required.", releaseTargets: [target.id],
  }];
  const outputPath = join(root, "changed-000.output.json");
  await writeFile(outputPath, JSON.stringify(candidates));
  await writeFile(join(root, "changed-000.receipt.json"), JSON.stringify({
    schema: "oxygen.reviewed-story-privacy-shard-receipt", shardId: "changed-000",
    status: "complete", manifestDigest: manifest.manifestDigest, targetIds: [target.id],
    outputPath: "changed-000.output.json", outputDigest: await storyPreparationDigest(candidates),
    outputCount: candidates.length,
  }));
  await writeFile(join(root, "terminal-receipt.json"), JSON.stringify({
    schema: "oxygen.reviewed-story-privacy-terminal-receipt", status: "complete",
    ...Object.fromEntries(Object.entries(binding).filter(([key]) => key !== "previousBatchDigest")),
    outputDigest: await storyPreparationDigest(candidates), outputCount: candidates.length,
    completedAt: "2044-02-01T00:00:00.000Z",
  }));
  return { root, outputPath };
}

test("local preparation/finalization is exact, terminal, and topology-contained", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "reviewed-story-privacy-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const finalize = join(process.cwd(), "..", "skills", "oxygen-storytelling-review", "scripts",
    "finalize_reviewed_story_privacy.mjs");
  const valid = await createScriptFixture(join(directory, "valid"));
  const bundlePath = join(directory, "bundle.json");
  await execFile(process.execPath, [finalize, valid.root, bundlePath]);
  const bundleValue = JSON.parse(await readFile(bundlePath, "utf8"));
  assert.equal(bundleValue.schema, "oxygen.reviewed-story-privacy-import");
  assert.equal(bundleValue.terminalReceipt.outputCount, 1);

  const hardlinkFixtureDir = join(directory, "hardlink");
  await mkdir(hardlinkFixtureDir);
  const hardlinkFixture = await createScriptFixture(hardlinkFixtureDir);
  const hardlinkPath = join(hardlinkFixture.root, "hardlinked-output.json");
  await link(hardlinkFixture.outputPath, hardlinkPath);
  const hardReceiptPath = join(hardlinkFixture.root, "changed-000.receipt.json");
  const hardReceipt = JSON.parse(await readFile(hardReceiptPath, "utf8"));
  hardReceipt.outputPath = "hardlinked-output.json";
  await writeFile(hardReceiptPath, JSON.stringify(hardReceipt));
  await assert.rejects(execFile(process.execPath, [finalize, hardlinkFixture.root,
    join(directory, "hardlink-bundle.json")]));

  const junctionFixtureDir = join(directory, "junction");
  await mkdir(junctionFixtureDir);
  const junctionFixture = await createScriptFixture(junctionFixtureDir);
  const outside = join(directory, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "foreign.json"), "[]");
  try {
    await symlink(outside, join(junctionFixture.root, "escape"), process.platform === "win32" ? "junction" : "dir");
    const receiptPath = join(junctionFixture.root, "changed-000.receipt.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.outputPath = "escape/foreign.json";
    receipt.outputDigest = await storyPreparationDigest([]);
    receipt.outputCount = 0;
    await writeFile(receiptPath, JSON.stringify(receipt));
    await assert.rejects(execFile(process.execPath, [finalize, junctionFixture.root,
      join(directory, "junction-bundle.json")]));
  } catch (error) {
    if (process.platform !== "win32") throw error;
    t.diagnostic(`junction creation unavailable: ${error.code || error.message}`);
  }

  const sources = await Promise.all([
    readFile(join(process.cwd(), "..", "skills", "oxygen-storytelling-review", "scripts",
      "prepare_reviewed_story_privacy.mjs"), "utf8"),
    readFile(finalize, "utf8"),
  ]);
  assert.doesNotMatch(sources.join("\n"), /\bfetch\b|node:https|node:http|XMLHttpRequest|WebSocket/u);
});
