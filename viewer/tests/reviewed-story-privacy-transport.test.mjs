import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
import { seedCoveragePrivacyAuthority } from "./story-coverage-privacy-fixture.mjs";

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
const sourcePrivacyRoute = await import("../app/api/redactions/route.ts");
const execFile = promisify(execFileCallback);

const RUN_ID = "reviewed-story-privacy-run";
const SOURCE_REVISION = 19;
const NOW = "2044-01-01T00:00:00.000Z";
const evidence = { documentId: "doc", eventId: "doc:event" };
const sourceInsight = {
  id: "source-insight",
  title: "Initial insight title",
  background: "Initial insight background",
  anchorStoryBlockId: "block-two",
  quote: { text: "exact quotation", evidence },
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
let activeDigest = await storyPreparationDigest([{ id: evidence.eventId, summary }]);
let inputDigest = await storyPreparationDigest([{ id: evidence.eventId, story: source }]);

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

function reviewedState(
  blockText = "The first block is reviewed.",
  insightTitle = "Edited insight title",
) {
  let state = emptyChapterReview(source);
  state = updateAiInsightDecision(state, source, sourceInsight.id, "accepted");
  state = applyChapterReview(state, context(state)).state;
  state.stage = "revision_ready";
  const edited = { ...sourceInsight,
    title: insightTitle, background: "Edited source insight background" };
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
    nextText: blockText, supportingEvidence: [evidence], now: 100,
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

function blockOnlyReviewedState(blockText) {
  let state = updateAiInsightDecision(emptyChapterReview(source), source, sourceInsight.id, "rejected");
  state = applyChapterReview(state, context(state)).state;
  const edit = recordStoryEdit(state, {
    storyKey: source.key, blockId: "block-one", sourceLanguage: "en",
    baseText: source.story.blocks[0].text, nextText: blockText,
    supportingEvidence: [evidence], now: 200,
  });
  state = applyChapterReview(edit.state, context(edit.state, [edit.transactionId])).state;
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
    VALUES (?,'doc',0,'PRIVATE_SOURCE_SENTINEL exact quotation','{}',?,'message','person','human')`)
    .bind(evidence.eventId, summary).run();
  const seeded = await seedCoveragePrivacyAuthority(db, {
    workflowRunId: RUN_ID,
    sourceRevision: SOURCE_REVISION,
    stories: [source],
    now: NOW,
  });
  activeDigest = seeded.activeStoryDigest;
  inputDigest = seeded.storyPrivacyInputDigest;
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
    candidates = [...candidates].sort((left, right) => Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)));
    const terminalReceipt = {
      schema: "oxygen.reviewed-story-privacy-terminal-receipt", status: "complete",
      ...Object.fromEntries(Object.entries(snapshot.binding).filter(([key]) => key !== "previousCandidateDigest")),
      outputDigest: await storyPreparationDigest(candidates), outputCount: candidates.length, completedAt,
    };
    const receiptDigest = await storyPreparationDigest(terminalReceipt);
    const core = {
      schema: "oxygen.reviewed-story-privacy-import", binding: snapshot.binding,
      receiptDigest, candidates,
    };
    return { schema: core.schema, binding: core.binding, terminalReceipt, receiptDigest,
      candidates, importDigest: await storyPreparationDigest(core) };
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
    assert.deepEqual(Object.keys(pending.authority), [
      "workflowRunId", "sourceRevision", "activeStoryDigest", "candidateDigest", "status", "candidates",
    ]);
    assert.equal(pending.authority.status, "preparation_required");
    assert.deepEqual(pending.authority.candidates.map((item) => [item.id, item.decision]), [[unchanged.id, "keep"]]);
    const prepared = await buildReviewedStoryPrivacyPreparationSnapshot(db, RUN_ID);
    assert.equal(prepared.ok, true);
    assert.equal(JSON.stringify(pending.authority).includes("PRIVATE_REVIEWED_TEXT_SENTINEL"), false);
    const exportScript = join(process.cwd(), "..", "skills", "oxygen-storytelling-review", "scripts",
      "export_reviewed_story_privacy_snapshot.mjs");
    const exportedPath = join(stateDir, "reviewed-privacy-snapshot.json");
    const exported = await execFile(process.execPath, [exportScript, "--workflow-run-id", RUN_ID,
      "--output", exportedPath], { env: { ...process.env, OXYGEN_VIEWER_STATE_DIR: stateDir } });
    assert.doesNotMatch(exported.stdout, /PRIVATE_SOURCE_SENTINEL|PRIVATE_REVIEWED_TEXT_SENTINEL/u);
    assert.deepEqual(JSON.parse(await readFile(exportedPath, "utf8")), prepared.snapshot);

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
    const completedZeroResult = await importReviewedStoryPrivacyAuthority(db, completedZero, NOW);
    assert.equal(completedZeroResult.ok, true, JSON.stringify(completedZeroResult));
    assert.deepEqual((await db.prepare(`SELECT candidate_id,decision FROM story_privacy_candidates
      ORDER BY candidate_id`).all()).results, [{ candidate_id: unchanged.id, decision: "keep" }]);
    const editedAgainSession = createStoryReviewSession(
      RUN_ID, { [source.key]: reviewedState(
        "The first block is reviewed again.", "Edited insight title again",
      ) }, {},
    );
    await db.prepare(`UPDATE story_review_sessions SET state_json=?,server_version=3 WHERE workflow_run_id=?`)
      .bind(JSON.stringify({ sourceRevision: SOURCE_REVISION, session: editedAgainSession }), RUN_ID).run();
    const replacementPreparation = await buildReviewedStoryPrivacyPreparationSnapshot(db, RUN_ID);
    assert.equal(replacementPreparation.ok, true);
    const insightReplacement = {
      id: "current-insight-finding", reviewState: "needs_confirmation",
      title: "Current insight finding", whyFlagged: "The current edited Insight requires confirmation.",
      uncertaintyReason: "Contributor confirmation is required.",
      releaseTargets: ["chapter-one::insight:source-insight:title"],
    };
    const validBundle = await bundle(replacementPreparation.snapshot, [replacement, insightReplacement]);
    const beforeReplacement = await db.prepare(`SELECT candidate_id,decision FROM story_privacy_candidates
      ORDER BY candidate_id`).all();

    const realTransaction = db.transaction.bind(db);
    let decisionInjected = false;
    db.transaction = async (operation) => {
      if (!decisionInjected) {
        decisionInjected = true;
        await db.prepare(`UPDATE story_privacy_candidates SET decision='redact',decided_at=?
          WHERE candidate_id=?`).bind("2044-01-02T12:00:00.000Z", unchanged.id).run();
      }
      return realTransaction(operation);
    };
    const lostToDecision = await importReviewedStoryPrivacyAuthority(db, validBundle, NOW);
    db.transaction = realTransaction;
    assert.equal(lostToDecision.ok, false);
    assert.equal(decisionInjected, true, JSON.stringify(lostToDecision));
    assert.deepEqual(await db.prepare(`SELECT decision,decision_version,decided_at
      FROM story_privacy_candidates WHERE candidate_id=?`).bind(unchanged.id).first(), {
      decision: "redact", decision_version: 1, decided_at: "2044-01-02T12:00:00.000Z",
    });
    await db.prepare(`UPDATE story_privacy_candidates SET decision='keep',decided_at=?
      WHERE candidate_id=?`).bind(NOW, unchanged.id).run();

    const mutationCases = [{
      table: "workflow_runs", column: "updated_at", where: "id=?", bindings: [RUN_ID],
      injected: "2044-01-02T13:00:00.000Z",
    }, {
      table: "story_review_sessions", column: "updated_at", where: "workflow_run_id=?", bindings: [RUN_ID],
      injected: "2044-01-02T14:00:00.000Z",
    }, {
      table: "items", column: "timestamp", where: "id=?", bindings: [evidence.eventId],
      injected: "2044-01-02T15:00:00.000Z",
    }, {
      table: "story_privacy_authorities", column: "target_catalog_json", where: "workflow_run_id=?",
      bindings: [RUN_ID], injected: "[]",
    }, {
      table: "story_preparation_receipts", column: "completed_at",
      where: "workflow_run_id=? AND lane='story_privacy'", bindings: [RUN_ID],
      injected: "2044-01-02T16:00:00.000Z",
    }, {
      table: "story_privacy_authorities", column: "batch_digest", where: "workflow_run_id=?",
      bindings: [RUN_ID], injected: "0".repeat(64),
    }, {
      table: "story_privacy_candidates", column: "candidate_json", where: "candidate_id=?",
      bindings: [unchanged.id], injected: JSON.stringify({ ...unchanged, title: "Concurrent mutation" }),
    }];
    for (const mutation of mutationCases) {
      const original = await db.prepare(`SELECT ${mutation.column} AS value FROM ${mutation.table}
        WHERE ${mutation.where}`).bind(...mutation.bindings).first();
      let injected = false;
      db.transaction = async (operation) => {
        if (!injected) {
          injected = true;
          await db.prepare(`UPDATE ${mutation.table} SET ${mutation.column}=?
            WHERE ${mutation.where}`).bind(mutation.injected, ...mutation.bindings).run();
        }
        return realTransaction(operation);
      };
      const result = await importReviewedStoryPrivacyAuthority(db, validBundle, NOW);
      db.transaction = realTransaction;
      assert.equal(result.ok, false, `${mutation.table}.${mutation.column}`);
      assert.equal((await db.prepare(`SELECT ${mutation.column} AS value FROM ${mutation.table}
        WHERE ${mutation.where}`).bind(...mutation.bindings).first()).value, mutation.injected);
      await db.prepare(`UPDATE ${mutation.table} SET ${mutation.column}=?
        WHERE ${mutation.where}`).bind(original.value, ...mutation.bindings).run();
    }

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
      [insightReplacement.id, null], [replacement.id, null], [unchanged.id, "keep"],
    ].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
    assert.notEqual(current.authority.candidateDigest, validBundle.importDigest);
    assert.notEqual(current.authority.candidateDigest, oldBrowserDigest);
    assert.equal((await decideStoryPrivacyCandidate(db, {
      workflowRunId: RUN_ID, sourceRevision: SOURCE_REVISION, activeStoryDigest: activeDigest,
      candidateDigest: oldBrowserDigest, expectedVersion: 0, decision: "redact",
    }, replacement.id, "2044-01-03T00:00:00.000Z")).ok, false);
    assert.equal((await decideStoryPrivacyCandidate(db, {
      workflowRunId: RUN_ID, sourceRevision: SOURCE_REVISION, activeStoryDigest: activeDigest,
      candidateDigest: current.authority.candidateDigest, expectedVersion: 0, decision: "keep",
    }, replacement.id, "2044-01-03T00:00:00.000Z")).ok, true);
    const removalSession = createStoryReviewSession(
      RUN_ID, { [source.key]: blockOnlyReviewedState("The first block is reviewed again.") }, {},
    );
    await db.prepare(`UPDATE story_review_sessions SET state_json=?,server_version=4 WHERE workflow_run_id=?`)
      .bind(JSON.stringify({ sourceRevision: SOURCE_REVISION, session: removalSession }), RUN_ID).run();
    const removal = await buildReviewedStoryPrivacyPreparationSnapshot(db, RUN_ID);
    assert.equal(removal.ok, true);
    assert.equal(removal.snapshot.changedTargets.length, 0);
    assert.ok(removal.snapshot.targetTransitions.length > 0);
    assert.ok(removal.snapshot.targetTransitions.every((target) => target.contentDigest === null));
    const removalZero = await bundle(removal.snapshot, []);
    assert.equal((await importReviewedStoryPrivacyAuthority(db, removalZero,
      "2044-01-04T00:00:00.000Z")).ok, true);
    const afterRemoval = await readStoryPrivacyAuthority(db, RUN_ID);
    assert.equal(afterRemoval.ok, true);
    assert.deepEqual(afterRemoval.authority.candidates.map((item) => item.id), [
      replacement.id, unchanged.id,
    ].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));

    const revertedSession = createStoryReviewSession(
      RUN_ID, { [source.key]: unchangedReviewedState() }, {},
    );
    await db.prepare(`UPDATE story_review_sessions SET state_json=?,server_version=5 WHERE workflow_run_id=?`)
      .bind(JSON.stringify({ sourceRevision: SOURCE_REVISION, session: revertedSession }), RUN_ID).run();
    const reverted = await readStoryPrivacyAuthority(db, RUN_ID);
    assert.equal(reverted.ok, true);
    assert.equal(reverted.authority.status, "preparation_required");
    assert.deepEqual(reverted.authority.candidates.map((item) => item.id), [unchanged.id]);
    assert.doesNotMatch(JSON.stringify(current.authority), /PRIVATE_SOURCE_SENTINEL|PRIVATE_REVIEWED_TEXT_SENTINEL|Evidence|provider|candidate_json/iu);

    const stalePreparation = await buildReviewedStoryPrivacyPreparationSnapshot(db, RUN_ID);
    assert.equal(stalePreparation.ok, true);
    assert.ok(stalePreparation.snapshot.changedTargets.length > 0);
    const staleImport = await bundle(stalePreparation.snapshot, [{
      id: "post-source-privacy-stale-import",
      reviewState: "needs_confirmation",
      title: "Current reviewed change",
      whyFlagged: "The current reviewed target requires confirmation.",
      uncertaintyReason: "Contributor confirmation is required.",
      releaseTargets: [stalePreparation.snapshot.changedTargets[0].id],
    }]);
    const authorityRowsBefore = await db.prepare(`SELECT candidate_id,candidate_json,decision,
      decision_version,decided_at FROM story_privacy_candidates ORDER BY candidate_id`).all();
    assert.equal((await db.prepare(
      "SELECT COUNT(*) AS total FROM story_privacy_authorities",
    ).first()).total, 1);

    const sourcePrivacy = await sourcePrivacyRoute.POST(new Request(
      "http://localhost/api/redactions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          replaceAll: true,
          job: { status: "complete", stage: "done", total: 0, rejected: 0 },
          redactions: [],
        }),
      },
    ));
    assert.equal(sourcePrivacy.status, 200, await sourcePrivacy.text());
    assert.deepEqual(await db.prepare(`SELECT story_generation_status,story_source_revision,
      active_story_digest FROM workflow_runs WHERE id=?`).bind(RUN_ID).first(), {
      story_generation_status: "blocked",
      story_source_revision: SOURCE_REVISION,
      active_story_digest: null,
    });
    assert.equal((await db.prepare(
      "SELECT COUNT(*) AS total FROM story_privacy_authorities",
    ).first()).total, 0);
    const lostImport = await importReviewedStoryPrivacyAuthority(db, staleImport, NOW);
    assert.equal(lostImport.ok, false);
    assert.deepEqual((await db.prepare(`SELECT candidate_id,candidate_json,decision,
      decision_version,decided_at FROM story_privacy_candidates ORDER BY candidate_id`).all()).results,
    authorityRowsBefore.results);
    assert.doesNotMatch(JSON.stringify(lostImport),
      /PRIVATE_SOURCE_SENTINEL|PRIVATE_REVIEWED_TEXT_SENTINEL|localhost|sqlite|trace/iu);
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
    changedTargetDigest: await storyPreparationDigest([{
      id: target.id, previousContentDigest: "e".repeat(64), contentDigest: target.contentDigest,
    }]), changedTargetCount: 1,
    previousCandidateDigest: "d".repeat(64),
  };
  const snapshotPath = join(directory, "snapshot.json");
  const root = join(directory, "prepared");
  await writeFile(snapshotPath, JSON.stringify({
    schema: "oxygen.reviewed-story-privacy-snapshot", binding,
    targetTransitions: [{
      id: target.id, previousContentDigest: "e".repeat(64), contentDigest: target.contentDigest,
    }],
    changedTargets: [target],
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
    status: "complete", manifestDigest: manifest.manifestDigest,
    inputDigest: manifest.shards[0].inputDigest, targetIds: [target.id],
    outputPath: "changed-000.output.json", outputDigest: await storyPreparationDigest(candidates),
    outputCount: candidates.length,
  }));
  await writeFile(join(root, "terminal-receipt.json"), JSON.stringify({
    schema: "oxygen.reviewed-story-privacy-terminal-receipt", status: "complete",
    ...Object.fromEntries(Object.entries(binding).filter(([key]) => key !== "previousCandidateDigest")),
    outputDigest: await storyPreparationDigest(candidates), outputCount: candidates.length,
    completedAt: "2044-02-01T00:00:00.000Z",
  }));
  return { root, outputPath };
}

async function createBalancedScriptFixture(directory, count = 130) {
  await mkdir(directory);
  const targets = await Promise.all(Array.from({ length: count }, async (_, index) => {
    const content = `${"隐私🙂".repeat(1_700 + (index % 7))}-${index}`;
    return {
      id: `chapter::story:block-${String(index).padStart(3, "0")}`,
      storyKey: "chapter", target: `story:block-${String(index).padStart(3, "0")}`,
      content, contentDigest: await storyPreparationDigest(content),
    };
  }));
  const transitions = targets.map((target) => ({
    id: target.id, previousContentDigest: null, contentDigest: target.contentDigest,
  }));
  const binding = {
    workflowRunId: "balanced-script-run", sourceRevision: 4, activeStoryDigest: "1".repeat(64),
    serverVersion: 3, reviewedStoryDigest: "2".repeat(64), targetCatalogDigest: "3".repeat(64),
    changedTargetDigest: await storyPreparationDigest(transitions), changedTargetCount: transitions.length,
    previousCandidateDigest: "4".repeat(64),
  };
  const snapshotPath = join(directory, "snapshot.json");
  const root = join(directory, "prepared");
  await writeFile(snapshotPath, JSON.stringify({
    schema: "oxygen.reviewed-story-privacy-snapshot", binding,
    targetTransitions: transitions, changedTargets: targets,
  }));
  const prepare = join(process.cwd(), "..", "skills", "oxygen-storytelling-review", "scripts",
    "prepare_reviewed_story_privacy.mjs");
  await execFile(process.execPath, [prepare, snapshotPath, root]);
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  for (const shard of manifest.shards) {
    const outputPath = `${shard.id}.output.json`;
    await writeFile(join(root, outputPath), "[]");
    await writeFile(join(root, shard.receiptPath), JSON.stringify({
      schema: "oxygen.reviewed-story-privacy-shard-receipt", shardId: shard.id,
      status: "complete", manifestDigest: manifest.manifestDigest,
      inputDigest: shard.inputDigest, targetIds: shard.targetIds,
      outputPath, outputDigest: await storyPreparationDigest([]), outputCount: 0,
    }));
  }
  await writeFile(join(root, "terminal-receipt.json"), JSON.stringify({
    schema: "oxygen.reviewed-story-privacy-terminal-receipt", status: "complete",
    ...Object.fromEntries(Object.entries(binding).filter(([key]) => key !== "previousCandidateDigest")),
    outputDigest: await storyPreparationDigest([]), outputCount: 0,
    completedAt: "2044-02-02T00:00:00.000Z",
  }));
  return { root, manifest, snapshotPath, prepare };
}

async function createRemovalOnlyScriptFixture(directory) {
  await mkdir(directory);
  const transition = {
    id: "chapter::insight:removed:background",
    previousContentDigest: "5".repeat(64), contentDigest: null,
  };
  const binding = {
    workflowRunId: "removal-script-run", sourceRevision: 5, activeStoryDigest: "6".repeat(64),
    serverVersion: 4, reviewedStoryDigest: "7".repeat(64), targetCatalogDigest: "8".repeat(64),
    changedTargetDigest: await storyPreparationDigest([transition]), changedTargetCount: 1,
    previousCandidateDigest: "9".repeat(64),
  };
  const snapshotPath = join(directory, "snapshot.json");
  const root = join(directory, "prepared");
  await writeFile(snapshotPath, JSON.stringify({
    schema: "oxygen.reviewed-story-privacy-snapshot", binding,
    targetTransitions: [transition], changedTargets: [],
  }));
  const prepare = join(process.cwd(), "..", "skills", "oxygen-storytelling-review", "scripts",
    "prepare_reviewed_story_privacy.mjs");
  await execFile(process.execPath, [prepare, snapshotPath, root]);
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  await writeFile(join(root, "terminal-receipt.json"), JSON.stringify({
    schema: "oxygen.reviewed-story-privacy-terminal-receipt", status: "complete",
    ...Object.fromEntries(Object.entries(binding).filter(([key]) => key !== "previousCandidateDigest")),
    outputDigest: await storyPreparationDigest([]), outputCount: 0,
    completedAt: "2044-02-03T00:00:00.000Z",
  }));
  return { root, manifest };
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

  const balanced = await createBalancedScriptFixture(join(directory, "balanced"));
  assert.ok(balanced.manifest.shards.length > 1);
  assert.deepEqual(balanced.manifest.shards.flatMap((shard) => shard.targetIds).sort(),
    [...balanced.manifest.changedTargetIds].sort());
  for (const shard of balanced.manifest.shards) {
    const input = JSON.parse(await readFile(join(balanced.root, shard.inputPath), "utf8"));
    assert.ok(input.targets.length > 0 && input.targets.length <= 64);
    assert.ok(input.targets.reduce((sum, target) => sum + Buffer.byteLength(target.content), 0)
      <= 1_000_000);
  }
  await execFile(process.execPath, [finalize, balanced.root, join(directory, "balanced-bundle.json")]);
  const firstShard = balanced.manifest.shards[0];
  const firstInputPath = join(balanced.root, firstShard.inputPath);
  const firstInputText = await readFile(firstInputPath, "utf8");
  const firstInput = JSON.parse(firstInputText);
  firstInput.targets[0].content += "tampered";
  await writeFile(firstInputPath, JSON.stringify(firstInput));
  await assert.rejects(execFile(process.execPath, [finalize, balanced.root,
    join(directory, "content-tampered-bundle.json")]));
  await writeFile(firstInputPath, firstInputText);
  const firstReceiptPath = join(balanced.root, firstShard.receiptPath);
  const firstReceiptText = await readFile(firstReceiptPath, "utf8");
  const firstReceipt = JSON.parse(firstReceiptText);
  firstReceipt.inputDigest = "0".repeat(64);
  await writeFile(firstReceiptPath, JSON.stringify(firstReceipt));
  await assert.rejects(execFile(process.execPath, [finalize, balanced.root,
    join(directory, "foreign-receipt-bundle.json")]));
  await writeFile(firstReceiptPath, firstReceiptText);
  await rm(firstReceiptPath);
  await assert.rejects(execFile(process.execPath, [finalize, balanced.root,
    join(directory, "missing-receipt-bundle.json")]));
  await writeFile(firstReceiptPath, firstReceiptText);

  const removal = await createRemovalOnlyScriptFixture(join(directory, "removal"));
  assert.deepEqual(removal.manifest.shards, []);
  assert.deepEqual(removal.manifest.changedTargetIds, []);
  await execFile(process.execPath, [finalize, removal.root, join(directory, "removal-bundle.json")]);

  const existingOutput = join(directory, "existing-output");
  await mkdir(existingOutput);
  await writeFile(join(existingOutput, "sentinel.txt"), "preserve");
  await assert.rejects(execFile(process.execPath, [balanced.prepare, balanced.snapshotPath, existingOutput]));
  assert.equal(await readFile(join(existingOutput, "sentinel.txt"), "utf8"), "preserve");
  assert.equal((await readdir(directory)).some((name) => name.includes("existing-output")
    && name.endsWith(".tmp")), false);

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
    readFile(join(process.cwd(), "..", "skills", "oxygen-storytelling-review", "scripts",
      "export_reviewed_story_privacy_snapshot.mjs"), "utf8"),
  ]);
  assert.doesNotMatch(sources.join("\n"), /\bfetch\b|node:https|node:http|XMLHttpRequest|WebSocket/u);
});
