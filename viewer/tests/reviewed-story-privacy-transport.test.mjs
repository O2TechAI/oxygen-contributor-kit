import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import {
  deriveStoryReleaseTargetContents,
  normalizeStoryPrivacyOutput,
  storyPreparationDigest,
} from "../lib/story-preparation.ts";
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
  importReviewedStoryPrivacyAuthority,
  parseImportBundle,
  readStoryPrivacyAuthority,
} = await import("../lib/story-privacy-authority.ts");
const { reconstructReviewedStoryPrivacyRevision } = await import("../lib/story-privacy-revision.ts");
const importRoute = await import("../app/api/story-privacy/import/route.ts");
const exportRoute = await import("../app/api/story-privacy/export/route.ts");
const sourcePrivacyRoute = await import("../app/api/redactions/route.ts");
const execFile = promisify(execFileCallback);

const RUN_ID = "reviewed-story-privacy-run";
const SOURCE_REVISION = 19;
const NOW = "2044-01-01T00:00:00.000Z";
const LEGACY_CANDIDATES = `CREATE TABLE story_privacy_candidates (
  workflow_run_id TEXT NOT NULL, candidate_id TEXT NOT NULL,
  candidate_json TEXT NOT NULL,
  decision TEXT CHECK(decision IN ('keep','redact')),
  decision_version INTEGER NOT NULL DEFAULT 0 CHECK(decision_version IN (0,1)),
  decided_at TEXT,
  CHECK (
    (decision IS NULL AND decision_version=0 AND decided_at IS NULL)
    OR
    (decision IS NOT NULL AND decision_version=1 AND decided_at IS NOT NULL)
  ),
  PRIMARY KEY (workflow_run_id, candidate_id)
)`;
const LEGACY_AUTHORITIES = `CREATE TABLE story_privacy_authorities (
  workflow_run_id TEXT PRIMARY KEY,
  source_revision INTEGER NOT NULL CHECK(source_revision > 0),
  active_story_digest TEXT NOT NULL,
  server_version INTEGER NOT NULL CHECK(server_version >= 0),
  reviewed_story_digest TEXT NOT NULL,
  target_catalog_json TEXT NOT NULL,
  target_catalog_digest TEXT NOT NULL,
  changed_target_digest TEXT NOT NULL,
  changed_target_count INTEGER NOT NULL CHECK(changed_target_count >= 0),
  receipt_digest TEXT NOT NULL,
  batch_digest TEXT NOT NULL,
  candidate_digest TEXT NOT NULL,
  candidate_count INTEGER NOT NULL CHECK(candidate_count >= 0),
  imported_at TEXT NOT NULL
)`;
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
let inputDigest = "";

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
  const edited = {
    ...sourceInsight,
    title: insightTitle,
    background: "Edited source insight background",
  };
  delete edited.id;
  state = editAiInsight(state, source, sourceInsight.id, edited);
  state = updateAiInsightDecision(state, source, sourceInsight.id, "accepted");
  const quoteText = "exact quotation";
  const quoteStart = source.story.blocks[1].text.indexOf(quoteText);
  state = saveHumanInsight(state, context(state), "human:added", {
    background: "PRIVATE_REVIEWED_TEXT_SENTINEL",
    quote: {
      chapterKey: source.key,
      storyBlockId: "block-two",
      selection: { start: quoteStart, end: quoteStart + quoteText.length, text: quoteText },
      baseRevision: state.revision,
    },
    directlyAcquiredExperience: "Human direct experience",
    principle: "Human principle",
    evidence: [evidence],
  }).state;
  const edit = recordStoryEdit(state, {
    storyKey: source.key,
    blockId: "block-one",
    sourceLanguage: "en",
    baseText: source.story.blocks[0].text,
    nextText: blockText,
    supportingEvidence: [evidence],
    now: 100,
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
    storyKey: source.key,
    blockId: "block-one",
    sourceLanguage: "en",
    baseText: source.story.blocks[0].text,
    nextText: blockText,
    supportingEvidence: [evidence],
    now: 200,
  });
  state = applyChapterReview(edit.state, context(edit.state, [edit.transactionId])).state;
  return markChapterReady(state, context(state));
}

const unchanged = {
  id: "unchanged-candidate",
  reviewState: "needs_confirmation",
  title: "Stable finding",
  whyFlagged: "Stable title requires one decision.",
  uncertaintyReason: "Confirmation required.",
  releaseTargets: ["chapter-one::title"],
};
const changed = {
  id: "same-id-replacement",
  reviewState: "needs_confirmation",
  title: "Old block finding",
  whyFlagged: "The original block required one decision.",
  uncertaintyReason: "Confirmation required.",
  releaseTargets: ["chapter-one::story:block-one"],
};

async function privacyForTargets(targets, candidates) {
  const flagged = new Set(candidates.flatMap((candidate) => candidate.releaseTargets));
  const targetProposals = await Promise.all(targets.map(async (target) => {
    const targetContentDigest = target.contentDigest || await storyPreparationDigest(target.content);
    if (!flagged.has(target.id)) {
      return { targetId: target.id, targetContentDigest, proposedText: target.content, occurrences: [] };
    }
    const original = Array.from(target.content);
    let originalEndOffset = original.length;
    while (originalEndOffset > 0 && !/[\p{L}\p{N}_-]/u.test(original[originalEndOffset - 1])) {
      originalEndOffset -= 1;
    }
    let originalStartOffset = originalEndOffset;
    while (originalStartOffset > 0 && /[\p{L}\p{N}_-]/u.test(original[originalStartOffset - 1])) {
      originalStartOffset -= 1;
    }
    assert.ok(originalStartOffset < originalEndOffset);
    const replacement = Array.from("Anonymous");
    return {
      targetId: target.id,
      targetContentDigest,
      proposedText: [
        ...original.slice(0, originalStartOffset),
        ...replacement,
        ...original.slice(originalEndOffset),
      ].join(""),
      occurrences: [{
        originalStartOffset,
        originalEndOffset,
        proposalStartOffset: originalStartOffset,
        proposalEndOffset: originalStartOffset + replacement.length,
        category: "private-identity",
      }],
    };
  }));
  const privacy = await normalizeStoryPrivacyOutput({ candidates, targetProposals }, targets);
  assert.ok(privacy);
  return privacy;
}

async function insertInitial(db) {
  const summary = `oxygen.story:${JSON.stringify(source)}`;
  await db.prepare(`INSERT INTO workflow_runs
    (id,story_generation_status,story_source_revision,active_story_digest,created_at,updated_at)
    VALUES (?,'ready_for_human_review',?,?,?,?)`)
    .bind(RUN_ID, SOURCE_REVISION, "0".repeat(64), NOW, NOW).run();
  await db.prepare(`INSERT INTO documents
    (id,kind,title,source_system,item_count,imported_at,updated_at)
    VALUES ('doc','trajectory','Synthetic source','test',1,?,?)`).bind(NOW, NOW).run();
  await db.prepare(`INSERT INTO items
    (id,document_id,sequence,content,original_json,organization_reason,event_type,actor_id,actor_type)
    VALUES (?,'doc',1,'PRIVATE_SOURCE_SENTINEL exact quotation','{}',?,'message','person','human')`)
    .bind(evidence.eventId, summary).run();
  const seeded = await seedCoveragePrivacyAuthority(db, {
    workflowRunId: RUN_ID,
    sourceRevision: SOURCE_REVISION,
    stories: [source],
    now: NOW,
  });
  inputDigest = seeded.storyPrivacyInputDigest;
  const targets = deriveStoryReleaseTargetContents([source]);
  assert.ok(targets);
  const privacy = await privacyForTargets(targets, [changed, unchanged]);
  await db.prepare(`INSERT INTO story_preparation_receipts
    (workflow_run_id,lane,source_revision,input_digest,scope_digest,scope_count,
     output_digest,output_count,completed_at) VALUES (?,'story_privacy',?,?,?,?,?,?,?)`).bind(
    RUN_ID,
    SOURCE_REVISION,
    inputDigest,
    await storyPreparationDigest(targets.map((target) => target.id)),
    targets.length,
    await storyPreparationDigest(privacy),
    privacy.targetProposals.length,
    NOW,
  ).run();
  for (const candidate of privacy.candidates) {
    await db.prepare(`INSERT INTO story_privacy_candidates
      (workflow_run_id,candidate_id,candidate_json) VALUES (?,?,?)`)
      .bind(RUN_ID, candidate.id, JSON.stringify(candidate)).run();
  }
  for (const proposal of privacy.targetProposals) {
    await db.prepare(`INSERT INTO story_privacy_targets
      (workflow_run_id,target_id,target_content_digest,proposed_text,occurrences_json,
       selected_text,public_overrides_json,decided_at) VALUES (?,?,?,?,?,?,'[]',?)`).bind(
      RUN_ID,
      proposal.targetId,
      proposal.targetContentDigest,
      proposal.proposedText,
      JSON.stringify(proposal.occurrences),
      proposal.proposedText,
      NOW,
    ).run();
  }
  return seeded;
}

async function bundle(snapshot, candidates, completedAt = "2044-01-02T00:00:00.000Z") {
  const privacy = await privacyForTargets(snapshot.changedTargets, candidates);
  const terminalReceipt = {
    schema: "oxygen.reviewed-story-privacy-terminal-receipt",
    status: "complete",
    ...Object.fromEntries(Object.entries(snapshot.binding)
      .filter(([key]) => key !== "previousAuthorityDigest")),
    outputDigest: await storyPreparationDigest(privacy),
    outputCount: privacy.targetProposals.length,
    completedAt,
  };
  const receiptDigest = await storyPreparationDigest(terminalReceipt);
  const core = {
    schema: "oxygen.reviewed-story-privacy-import",
    binding: snapshot.binding,
    receiptDigest,
    privacy,
  };
  return {
    ...core,
    terminalReceipt,
    importDigest: await storyPreparationDigest(core),
  };
}

const authorityRows = async (db) => ({
  candidates: (await db.prepare(`SELECT candidate_id,candidate_json
    FROM story_privacy_candidates ORDER BY candidate_id`).all()).results,
  targets: (await db.prepare(`SELECT target_id,target_content_digest,proposed_text,
    occurrences_json,selected_text,public_overrides_json,decided_at
    FROM story_privacy_targets ORDER BY target_id`).all()).results,
  authorities: (await db.prepare("SELECT * FROM story_privacy_authorities ORDER BY workflow_run_id").all())
    .results,
});

test("Story Privacy import rejects source revision zero before database initialization", async () => {
  const binding = {
    workflowRunId: "zero-import-run",
    sourceRevision: 1,
    activeStoryDigest: "a".repeat(64),
    serverVersion: 0,
    reviewedStoryDigest: "b".repeat(64),
    targetCatalogDigest: "c".repeat(64),
    changedTargetDigest: "d".repeat(64),
    changedTargetCount: 0,
    previousAuthorityDigest: "e".repeat(64),
  };
  const terminalReceipt = {
    schema: "oxygen.reviewed-story-privacy-terminal-receipt",
    status: "complete",
    ...Object.fromEntries(Object.entries(binding).filter(([key]) => key !== "previousAuthorityDigest")),
    outputDigest: "f".repeat(64),
    outputCount: 0,
    completedAt: NOW,
  };
  const value = {
    schema: "oxygen.reviewed-story-privacy-import",
    binding,
    terminalReceipt,
    receiptDigest: "1".repeat(64),
    privacy: { candidates: [], targetProposals: [] },
    importDigest: "2".repeat(64),
  };
  assert.ok(parseImportBundle(value), "server-version zero remains valid with activated source one");
  const revisionZero = structuredClone(value);
  revisionZero.binding.sourceRevision = 0;
  revisionZero.terminalReceipt.sourceRevision = 0;
  assert.equal(parseImportBundle(revisionZero), null);
  const stateDir = join(tmpdir(), `oxygen-story-privacy-zero-${process.pid}-${Date.now()}`);
  assert.equal(existsSync(stateDir), false);
  const previous = process.env.OXYGEN_VIEWER_STATE_DIR;
  process.env.OXYGEN_VIEWER_STATE_DIR = stateDir;
  try {
    const response = await importRoute.POST(new Request("http://localhost/api/story-privacy/import", {
      method: "POST",
      body: JSON.stringify(revisionZero),
    }));
    assert.equal(response.status, 400);
    assert.equal(existsSync(stateDir), false);
  } finally {
    if (previous === undefined) delete process.env.OXYGEN_VIEWER_STATE_DIR;
    else process.env.OXYGEN_VIEWER_STATE_DIR = previous;
  }
});

test("reviewed Story changes replace one atomic target authority", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "reviewed-story-privacy-"));
  const previous = process.env.OXYGEN_VIEWER_STATE_DIR;
  process.env.OXYGEN_VIEWER_STATE_DIR = stateDir;
  try {
    const { getLocalDatabase } = await import("../db/index.ts");
    const db = await getLocalDatabase();
    const { sourcePrivacyReceipt } = await insertInitial(db);
    const initial = await readStoryPrivacyAuthority(db, RUN_ID);
    assert.equal(initial.ok, true);
    assert.ok(initial.authority.candidates.every((candidate) => candidate.resolved));
    const initialAuthorityDigest = initial.authority.authorityDigest;

    const unchangedSession = createStoryReviewSession(
      RUN_ID,
      { [source.key]: unchangedReviewedState() },
      {},
    );
    await db.prepare(`INSERT INTO story_review_sessions
      (workflow_run_id,state_json,updated_at,server_version) VALUES (?,?,?,1)`)
      .bind(RUN_ID, JSON.stringify({ sourceRevision: SOURCE_REVISION, session: unchangedSession }), NOW)
      .run();
    const unchangedRevision = await reconstructReviewedStoryPrivacyRevision(db, RUN_ID);
    assert.equal(unchangedRevision.ok, true);
    assert.deepEqual(unchangedRevision.revision.changedTargets, []);
    assert.equal((await readStoryPrivacyAuthority(db, RUN_ID)).authority.status,
      "completed_with_candidates");

    const session = createStoryReviewSession(RUN_ID, { [source.key]: reviewedState() }, {});
    await db.prepare(`UPDATE story_review_sessions SET state_json=?,server_version=2
      WHERE workflow_run_id=?`)
      .bind(JSON.stringify({ sourceRevision: SOURCE_REVISION, session }), RUN_ID).run();
    const revision = await reconstructReviewedStoryPrivacyRevision(db, RUN_ID);
    assert.equal(revision.ok, true);
    assert.deepEqual(revision.revision.changedTargets.map((target) => target.id), [
      "chapter-one::story:block-one",
      "chapter-one::insight:source-insight:title",
      "chapter-one::insight:source-insight:background",
      "chapter-one::insight:human:added:background",
      "chapter-one::insight:human:added:quote",
      "chapter-one::insight:human:added:directlyAcquiredExperience",
      "chapter-one::insight:human:added:principle",
    ]);

    const pending = await readStoryPrivacyAuthority(db, RUN_ID);
    assert.equal(pending.ok, true);
    assert.equal(pending.authority.status, "preparation_required");
    assert.deepEqual(pending.authority.candidates.map((candidate) => candidate.id), [unchanged.id]);
    const prepared = await buildReviewedStoryPrivacyPreparationSnapshot(db, RUN_ID);
    assert.equal(prepared.ok, true);
    assert.equal(prepared.snapshot.binding.previousAuthorityDigest,
      pending.authority.authorityDigest);
    const publicExport = await exportRoute.GET(new Request(
      `http://localhost/api/story-privacy/export?workflowRunId=${RUN_ID}`,
    ));
    assert.equal(publicExport.status, 200);
    assert.match(publicExport.headers.get("cache-control"), /no-store/u);
    assert.deepEqual(await publicExport.json(), prepared.snapshot);

    const replacement = {
      ...changed,
      title: "Replacement current finding",
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
    const beforeTamper = await authorityRows(db);
    assert.equal((await importReviewedStoryPrivacyAuthority(db, tampered, NOW)).ok, false);
    const tamperedResponse = await importRoute.POST(new Request(
      "http://localhost/api/story-privacy/import",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(tampered),
      },
    ));
    assert.equal(tamperedResponse.status, 400);
    assert.deepEqual(await authorityRows(db), beforeTamper);

    const completedZero = await bundle(prepared.snapshot, []);
    const completedZeroResult = await importReviewedStoryPrivacyAuthority(db, completedZero, NOW);
    assert.equal(completedZeroResult.ok, true, JSON.stringify(completedZeroResult));
    assert.deepEqual(completedZeroResult.authority.candidates.map((candidate) => candidate.id),
      [unchanged.id]);
    assert.equal(completedZeroResult.authority.targets.length, revision.revision.targets.length);

    const editedAgainSession = createStoryReviewSession(
      RUN_ID,
      { [source.key]: reviewedState(
        "The first block is reviewed again.",
        "Edited insight title again",
      ) },
      {},
    );
    await db.prepare(`UPDATE story_review_sessions SET state_json=?,server_version=3
      WHERE workflow_run_id=?`)
      .bind(JSON.stringify({ sourceRevision: SOURCE_REVISION, session: editedAgainSession }), RUN_ID).run();
    const replacementPreparation = await buildReviewedStoryPrivacyPreparationSnapshot(db, RUN_ID);
    assert.equal(replacementPreparation.ok, true);
    const insightReplacement = {
      id: "current-insight-finding",
      reviewState: "needs_confirmation",
      title: "Current insight finding",
      whyFlagged: "The current edited Insight requires confirmation.",
      uncertaintyReason: "Contributor confirmation is required.",
      releaseTargets: ["chapter-one::insight:source-insight:title"],
    };
    const validBundle = await bundle(replacementPreparation.snapshot, [replacement, insightReplacement]);

    const titleBefore = await db.prepare(`SELECT selected_text,decided_at FROM story_privacy_targets
      WHERE workflow_run_id=? AND target_id='chapter-one::title'`).bind(RUN_ID).first();
    const realTransaction = db.transaction.bind(db);
    let choiceInjected = false;
    db.transaction = async (operation) => {
      if (!choiceInjected) {
        choiceInjected = true;
        await db.prepare(`UPDATE story_privacy_targets SET decided_at=?
          WHERE workflow_run_id=? AND target_id='chapter-one::title'`)
          .bind("2044-01-02T12:00:00.000Z", RUN_ID).run();
      }
      return realTransaction(operation);
    };
    assert.equal((await importReviewedStoryPrivacyAuthority(db, validBundle, NOW)).ok, false);
    db.transaction = realTransaction;
    assert.equal(choiceInjected, true);
    await db.prepare(`UPDATE story_privacy_targets SET selected_text=?,decided_at=?
      WHERE workflow_run_id=? AND target_id='chapter-one::title'`)
      .bind(titleBefore.selected_text, titleBefore.decided_at, RUN_ID).run();

    const beforeRollback = await authorityRows(db);
    const realPrepare = db.prepare.bind(db);
    let rollbackInjected = false;
    db.prepare = (sql) => {
      if (!rollbackInjected && /^INSERT INTO story_privacy_authorities/u.test(sql)) {
        rollbackInjected = true;
        throw new Error("injected rollback");
      }
      return realPrepare(sql);
    };
    assert.equal((await importReviewedStoryPrivacyAuthority(db, validBundle, NOW)).ok, false);
    db.prepare = realPrepare;
    assert.equal(rollbackInjected, true);
    assert.deepEqual(await authorityRows(db), beforeRollback);

    const concurrent = await Promise.all([
      importReviewedStoryPrivacyAuthority(db, validBundle, NOW),
      importReviewedStoryPrivacyAuthority(db, validBundle, NOW),
    ]);
    assert.deepEqual(concurrent.map((result) => result.ok).sort(), [false, true]);
    const current = await readStoryPrivacyAuthority(db, RUN_ID);
    assert.equal(current.ok, true);
    assert.deepEqual(current.authority.candidates.map((candidate) => [
      candidate.id,
      candidate.resolved,
    ]), [
      [insightReplacement.id, false],
      [replacement.id, false],
      [unchanged.id, true],
    ].sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right))));
    assert.notEqual(current.authority.authorityDigest, validBundle.importDigest);
    assert.notEqual(current.authority.authorityDigest, initialAuthorityDigest);

    const removalSession = createStoryReviewSession(
      RUN_ID,
      { [source.key]: blockOnlyReviewedState("The first block is reviewed again.") },
      {},
    );
    await db.prepare(`UPDATE story_review_sessions SET state_json=?,server_version=4
      WHERE workflow_run_id=?`)
      .bind(JSON.stringify({ sourceRevision: SOURCE_REVISION, session: removalSession }), RUN_ID).run();
    const removal = await buildReviewedStoryPrivacyPreparationSnapshot(db, RUN_ID);
    assert.equal(removal.ok, true);
    assert.deepEqual(removal.snapshot.changedTargets, []);
    assert.ok(removal.snapshot.targetTransitions.every((target) => target.contentDigest === null));
    assert.equal((await importReviewedStoryPrivacyAuthority(
      db,
      await bundle(removal.snapshot, []),
      "2044-01-04T00:00:00.000Z",
    )).ok, true);
    const afterRemoval = await readStoryPrivacyAuthority(db, RUN_ID);
    assert.equal(afterRemoval.ok, true);
    assert.deepEqual(afterRemoval.authority.candidates.map((candidate) => candidate.id), [
      replacement.id,
      unchanged.id,
    ].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))));

    const revertedSession = createStoryReviewSession(
      RUN_ID,
      { [source.key]: unchangedReviewedState() },
      {},
    );
    await db.prepare(`UPDATE story_review_sessions SET state_json=?,server_version=5
      WHERE workflow_run_id=?`)
      .bind(JSON.stringify({ sourceRevision: SOURCE_REVISION, session: revertedSession }), RUN_ID).run();
    const reverted = await readStoryPrivacyAuthority(db, RUN_ID);
    assert.equal(reverted.ok, true);
    assert.equal(reverted.authority.status, "preparation_required");
    assert.deepEqual(reverted.authority.candidates.map((candidate) => candidate.id), [unchanged.id]);

    const stalePreparation = await buildReviewedStoryPrivacyPreparationSnapshot(db, RUN_ID);
    assert.equal(stalePreparation.ok, true);
    const staleImport = await bundle(stalePreparation.snapshot, [{
      id: "post-source-privacy-stale-import",
      reviewState: "needs_confirmation",
      title: "Current reviewed change",
      whyFlagged: "The current reviewed target requires confirmation.",
      uncertaintyReason: "Contributor confirmation is required.",
      releaseTargets: [stalePreparation.snapshot.changedTargets[0].id],
    }]);
    const sourcePrivacy = await sourcePrivacyRoute.POST(new Request(
      "http://localhost/api/redactions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          replaceAll: true,
          job: { status: "complete", stage: "done", total: 0, rejected: 0 },
          redactions: [],
          receipt: sourcePrivacyReceipt,
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
    assert.equal(Number((await db.prepare(`SELECT
      (SELECT COUNT(*) FROM story_privacy_authorities)
      +(SELECT COUNT(*) FROM story_privacy_candidates)
      +(SELECT COUNT(*) FROM story_privacy_targets) AS count`).first()).count), 0);
    const lostImport = await importReviewedStoryPrivacyAuthority(db, staleImport, NOW);
    assert.equal(lostImport.ok, false);
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

test("PR10 refresh exports every current target and accepts only a fresh total proposal", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "reviewed-story-privacy-contract-refresh-"));
  const databasePath = join(stateDir, "oxygen.sqlite");
  const previous = process.env.OXYGEN_VIEWER_STATE_DIR;
  process.env.OXYGEN_VIEWER_STATE_DIR = stateDir;
  let raw = null;
  try {
    const { getLocalDatabase } = await import("../db/index.ts");
    let db = await getLocalDatabase();
    await insertInitial(db);
    const session = createStoryReviewSession(
      RUN_ID,
      { [source.key]: unchangedReviewedState() },
      {},
    );
    await db.prepare(`INSERT INTO story_review_sessions
      (workflow_run_id,state_json,updated_at,server_version) VALUES (?,?,?,1)`)
      .bind(RUN_ID, JSON.stringify({ sourceRevision: SOURCE_REVISION, session }), NOW).run();
    await db.prepare(`INSERT INTO project_release_confirmations
      (workflow_run_id,review_gate_digest,confirmed_at) VALUES (?,?,?)`)
      .bind(RUN_ID, "9".repeat(64), NOW).run();

    globalThis.__oxygenLocalSqlite?.database.close();
    delete globalThis.__oxygenLocalSqlite;
    raw = new DatabaseSync(databasePath);
    raw.exec(`DROP TABLE story_privacy_targets;
      DROP TABLE story_privacy_authorities;
      DROP TABLE story_privacy_candidates;
      ${LEGACY_CANDIDATES};
      ${LEGACY_AUTHORITIES}`);
    raw.prepare(`INSERT INTO story_privacy_candidates
      (workflow_run_id,candidate_id,candidate_json,decision,decision_version,decided_at)
      VALUES (?,?,?,NULL,0,NULL)`).run(
      RUN_ID,
      "legacy-proposal",
      JSON.stringify({ proposedText:"LEGACY_PROPOSAL_SENTINEL" }),
    );
    raw.close();
    raw = null;

    db = await getLocalDatabase();
    const pending = await readStoryPrivacyAuthority(db, RUN_ID);
    assert.equal(pending.ok, true, JSON.stringify(pending));
    assert.equal(pending.authority.status, "preparation_required");
    assert.deepEqual(pending.authority.candidates, []);
    assert.deepEqual(pending.authority.targets, []);
    assert.equal((await db.prepare(`SELECT COUNT(*) AS count FROM story_preparation_receipts
      WHERE workflow_run_id=? AND lane='story_privacy'`).bind(RUN_ID).first()).count, 0);
    assert.equal((await db.prepare(`SELECT COUNT(*) AS count FROM project_release_confirmations
      WHERE workflow_run_id=?`).bind(RUN_ID).first()).count, 0);

    const current = await reconstructReviewedStoryPrivacyRevision(db, RUN_ID);
    assert.equal(current.ok, true, JSON.stringify(current));
    const currentById = new Map(current.revision.targets.map((target) => [target.id, target]));
    const publicExport = await exportRoute.GET(new Request(
      `http://localhost/api/story-privacy/export?workflowRunId=${RUN_ID}`,
    ));
    assert.equal(publicExport.status, 200);
    const snapshot = await publicExport.json();
    assert.equal(snapshot.binding.changedTargetCount, currentById.size);
    assert.equal(snapshot.changedTargets.length, currentById.size);
    assert.deepEqual(
      snapshot.changedTargets.map((target) => target.id).sort(),
      [...currentById.keys()].sort(),
    );
    assert.deepEqual(
      snapshot.targetTransitions.map((transition) => transition.id).sort(),
      [...currentById.keys()].sort(),
    );
    for (const transition of snapshot.targetTransitions) {
      assert.equal(transition.previousContentDigest, null);
      assert.equal(transition.contentDigest, currentById.get(transition.id).contentDigest);
    }
    for (const target of snapshot.changedTargets) {
      assert.deepEqual(target, currentById.get(target.id));
    }
    assert.doesNotMatch(JSON.stringify(snapshot), /LEGACY_PROPOSAL_SENTINEL/u);

    const snapshotPath = join(stateDir, "contract-refresh-snapshot.json");
    const root = join(stateDir, "contract-refresh-prepared");
    const proposals = join(stateDir, "contract-refresh-proposals");
    const bundlePath = join(stateDir, "contract-refresh-import.json");
    await writeFile(snapshotPath, JSON.stringify(snapshot));
    await mkdir(proposals);
    const prepare = join(process.cwd(), "..", "skills", "oxygen-storytelling-review", "scripts",
      "prepare_reviewed_story_privacy.mjs");
    const finalize = join(process.cwd(), "..", "skills", "oxygen-storytelling-review", "scripts",
      "finalize_reviewed_story_privacy.mjs");
    await execFile(process.execPath, [prepare, snapshotPath, root]);
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    assert.deepEqual([...manifest.changedTargetIds].sort(), [...currentById.keys()].sort());
    const reviewShard = manifest.shards[0];
    assert.ok(reviewShard?.targetIds.length > 0);
    const freshCandidate = {
      id: "fresh-contract-review",
      reviewState: "needs_confirmation",
      title: "Fresh current finding",
      whyFlagged: "The current target requires contributor review.",
      uncertaintyReason: "Contributor confirmation is required.",
      releaseTargets: [reviewShard.targetIds[0]],
    };
    for (const shard of manifest.shards) {
      const input = JSON.parse(await readFile(join(root, shard.inputPath), "utf8"));
      await writeFile(join(proposals, `${shard.id}.proposals.json`), JSON.stringify(
        await privacyForTargets(input.targets, shard.id === reviewShard.id ? [freshCandidate] : []),
      ));
    }
    await execFile(process.execPath, [finalize, root, proposals, bundlePath]);
    const freshBundle = JSON.parse(await readFile(bundlePath, "utf8"));
    assert.equal(freshBundle.privacy.targetProposals.length, currentById.size);
    assert.deepEqual(
      freshBundle.privacy.targetProposals.map((proposal) => proposal.targetId).sort(),
      [...currentById.keys()].sort(),
    );
    assert.doesNotMatch(JSON.stringify(freshBundle), /LEGACY_PROPOSAL_SENTINEL/u);
    const importedResponse = await importRoute.POST(new Request(
      "http://localhost/api/story-privacy/import",
      {
        method: "POST",
        headers: { "content-type":"application/json" },
        body: JSON.stringify(freshBundle),
      },
    ));
    assert.equal(importedResponse.status, 200);
    const imported = await importedResponse.json();
    assert.equal(imported.status, "completed_with_candidates");
    assert.deepEqual(imported.candidates.map((candidate) => candidate.id), [freshCandidate.id]);
    assert.equal(imported.candidates[0].resolved, false);
    assert.equal(imported.targets.length, currentById.size);
    assert.equal(imported.targets.find((target) => (
      target.targetId === freshCandidate.releaseTargets[0]
    )).selectedText, null);
    assert.equal((await db.prepare(`SELECT COUNT(*) AS count FROM story_privacy_authorities
      WHERE workflow_run_id=?`).bind(RUN_ID).first()).count, 1);
    assert.equal((await db.prepare(`SELECT COUNT(*) AS count FROM story_preparation_receipts
      WHERE workflow_run_id=? AND lane='story_privacy'`).bind(RUN_ID).first()).count, 0);
    assert.equal((await db.prepare(`SELECT COUNT(*) AS count FROM project_release_confirmations
      WHERE workflow_run_id=?`).bind(RUN_ID).first()).count, 0);
    assert.doesNotMatch(JSON.stringify(await authorityRows(db)), /LEGACY_PROPOSAL_SENTINEL/u);
  } finally {
    raw?.close();
    globalThis.__oxygenLocalSqlite?.database.close();
    delete globalThis.__oxygenLocalSqlite;
    if (previous === undefined) delete process.env.OXYGEN_VIEWER_STATE_DIR;
    else process.env.OXYGEN_VIEWER_STATE_DIR = previous;
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("public multi-target finalization preserves consumer target order and imports", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "reviewed-story-privacy-multi-order-"));
  const previous = process.env.OXYGEN_VIEWER_STATE_DIR;
  process.env.OXYGEN_VIEWER_STATE_DIR = stateDir;
  try {
    const { getLocalDatabase } = await import("../db/index.ts");
    const db = await getLocalDatabase();
    await insertInitial(db);
    const unchangedSession = createStoryReviewSession(
      RUN_ID,
      { [source.key]: unchangedReviewedState() },
      {},
    );
    await db.prepare(`INSERT INTO story_review_sessions
      (workflow_run_id,state_json,updated_at,server_version) VALUES (?,?,?,1)`)
      .bind(RUN_ID, JSON.stringify({ sourceRevision: SOURCE_REVISION, session: unchangedSession }), NOW)
      .run();
    const changedSession = createStoryReviewSession(RUN_ID, { [source.key]: reviewedState() }, {});
    await db.prepare(`UPDATE story_review_sessions SET state_json=?,server_version=2
      WHERE workflow_run_id=?`)
      .bind(JSON.stringify({ sourceRevision: SOURCE_REVISION, session: changedSession }), RUN_ID).run();
    const prepared = await buildReviewedStoryPrivacyPreparationSnapshot(db, RUN_ID);
    assert.equal(prepared.ok, true);
    const catalogOrder = prepared.snapshot.changedTargets.map((target) => target.id);
    assert.notDeepEqual(catalogOrder, [...catalogOrder].sort((left, right) => (
      Buffer.compare(Buffer.from(left), Buffer.from(right))
    )), "fixture must prove catalog order differs from UTF-8 order");

    const snapshotPath = join(stateDir, "multi-order-snapshot.json");
    const root = join(stateDir, "multi-order-prepared");
    const proposals = join(stateDir, "multi-order-proposals");
    const bundlePath = join(stateDir, "multi-order-import.json");
    await writeFile(snapshotPath, JSON.stringify(prepared.snapshot));
    await mkdir(proposals);
    const prepare = join(process.cwd(), "..", "skills", "oxygen-storytelling-review", "scripts",
      "prepare_reviewed_story_privacy.mjs");
    const finalize = join(process.cwd(), "..", "skills", "oxygen-storytelling-review", "scripts",
      "finalize_reviewed_story_privacy.mjs");
    await execFile(process.execPath, [prepare, snapshotPath, root]);
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.changedTargetIds, catalogOrder);
    const candidateShard = manifest.shards.find((shard) => shard.targetIds.length >= 2);
    assert.ok(candidateShard);
    const canonicalTargets = candidateShard.targetIds.slice(0, 2);
    const proposed = {
      id: "multi-target-order",
      reviewState: "needs_confirmation",
      title: "Cross-target current finding",
      whyFlagged: "One current finding affects two reviewed targets.",
      uncertaintyReason: "Contributor confirmation is required.",
      releaseTargets: [...canonicalTargets].reverse(),
    };
    for (const shard of manifest.shards) {
      const input = JSON.parse(await readFile(join(root, shard.inputPath), "utf8"));
      await writeFile(join(proposals, `${shard.id}.proposals.json`), JSON.stringify(
        await privacyForTargets(input.targets, shard.id === candidateShard.id ? [proposed] : []),
      ));
    }
    await execFile(process.execPath, [finalize, root, proposals, bundlePath]);
    const publicBundle = JSON.parse(await readFile(bundlePath, "utf8"));
    assert.deepEqual(publicBundle.privacy.candidates[0].releaseTargets, canonicalTargets);
    const imported = await importReviewedStoryPrivacyAuthority(
      db,
      publicBundle,
      "2044-01-01T00:00:01.000Z",
    );
    assert.equal(imported.ok, true, JSON.stringify(imported));
    assert.deepEqual(imported.authority.candidates.find((candidate) => (
      candidate.id === proposed.id
    )).releaseTargets, canonicalTargets);
  } finally {
    globalThis.__oxygenLocalSqlite?.database.close();
    delete globalThis.__oxygenLocalSqlite;
    if (previous === undefined) delete process.env.OXYGEN_VIEWER_STATE_DIR;
    else process.env.OXYGEN_VIEWER_STATE_DIR = previous;
    await rm(stateDir, { recursive: true, force: true });
  }
});

async function createScriptFixture(directory, { sourceRevision = 3, serverVersion = 2 } = {}) {
  if (!existsSync(directory)) await mkdir(directory);
  const target = {
    id: "chapter::story:block",
    storyKey: "chapter",
    target: "story:block",
    content: "Reviewed private candidate input",
    contentDigest: await storyPreparationDigest("Reviewed private candidate input"),
  };
  const transition = {
    id: target.id,
    previousContentDigest: "e".repeat(64),
    contentDigest: target.contentDigest,
  };
  const binding = {
    workflowRunId: "script-run",
    sourceRevision,
    activeStoryDigest: "a".repeat(64),
    serverVersion,
    reviewedStoryDigest: "b".repeat(64),
    targetCatalogDigest: "c".repeat(64),
    changedTargetDigest: await storyPreparationDigest([transition]),
    changedTargetCount: 1,
    previousAuthorityDigest: "d".repeat(64),
  };
  const snapshotPath = join(directory, "snapshot.json");
  const root = join(directory, "prepared");
  const proposals = join(directory, "proposals");
  await writeFile(snapshotPath, JSON.stringify({
    schema: "oxygen.reviewed-story-privacy-snapshot",
    binding,
    targetTransitions: [transition],
    changedTargets: [target],
  }));
  const prepare = join(process.cwd(), "..", "skills", "oxygen-storytelling-review", "scripts",
    "prepare_reviewed_story_privacy.mjs");
  await execFile(process.execPath, [prepare, snapshotPath, root]);
  await mkdir(proposals);
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  const candidates = [{
    id: "candidate",
    reviewState: "needs_confirmation",
    title: "Bounded finding",
    whyFlagged: "The reviewed block requires confirmation.",
    uncertaintyReason: "Contributor confirmation is required.",
    releaseTargets: [target.id],
  }];
  const privacy = await privacyForTargets([target], candidates);
  await writeFile(join(proposals, "changed-000.proposals.json"), JSON.stringify(privacy));
  return { root, proposals, snapshotPath, prepare, manifest, target, privacy };
}

async function createBalancedScriptFixture(directory, count = 130) {
  await mkdir(directory);
  const targets = await Promise.all(Array.from({ length: count }, async (_, index) => {
    const content = `${"隐私🙂".repeat(1_700 + (index % 7))}-${index}`;
    return {
      id: `chapter::story:block-${String(index).padStart(3, "0")}`,
      storyKey: "chapter",
      target: `story:block-${String(index).padStart(3, "0")}`,
      content,
      contentDigest: await storyPreparationDigest(content),
    };
  }));
  const transitions = targets.map((target) => ({
    id: target.id,
    previousContentDigest: null,
    contentDigest: target.contentDigest,
  }));
  const binding = {
    workflowRunId: "balanced-script-run",
    sourceRevision: 4,
    activeStoryDigest: "1".repeat(64),
    serverVersion: 3,
    reviewedStoryDigest: "2".repeat(64),
    targetCatalogDigest: "3".repeat(64),
    changedTargetDigest: await storyPreparationDigest(transitions),
    changedTargetCount: transitions.length,
    previousAuthorityDigest: "4".repeat(64),
  };
  const snapshotPath = join(directory, "snapshot.json");
  const root = join(directory, "prepared");
  const proposals = join(directory, "proposals");
  await writeFile(snapshotPath, JSON.stringify({
    schema: "oxygen.reviewed-story-privacy-snapshot",
    binding,
    targetTransitions: transitions,
    changedTargets: targets,
  }));
  const prepare = join(process.cwd(), "..", "skills", "oxygen-storytelling-review", "scripts",
    "prepare_reviewed_story_privacy.mjs");
  await execFile(process.execPath, [prepare, snapshotPath, root]);
  await mkdir(proposals);
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  for (const shard of manifest.shards) {
    const input = JSON.parse(await readFile(join(root, shard.inputPath), "utf8"));
    await writeFile(join(proposals, `${shard.id}.proposals.json`),
      JSON.stringify(await privacyForTargets(input.targets, [])));
  }
  return { root, proposals, manifest, snapshotPath, prepare };
}

async function createRemovalOnlyScriptFixture(directory) {
  await mkdir(directory);
  const transition = {
    id: "chapter::insight:removed:background",
    previousContentDigest: "5".repeat(64),
    contentDigest: null,
  };
  const binding = {
    workflowRunId: "removal-script-run",
    sourceRevision: 5,
    activeStoryDigest: "6".repeat(64),
    serverVersion: 4,
    reviewedStoryDigest: "7".repeat(64),
    targetCatalogDigest: "8".repeat(64),
    changedTargetDigest: await storyPreparationDigest([transition]),
    changedTargetCount: 1,
    previousAuthorityDigest: "9".repeat(64),
  };
  const snapshotPath = join(directory, "snapshot.json");
  const root = join(directory, "prepared");
  const proposals = join(directory, "proposals");
  await writeFile(snapshotPath, JSON.stringify({
    schema: "oxygen.reviewed-story-privacy-snapshot",
    binding,
    targetTransitions: [transition],
    changedTargets: [],
  }));
  const prepare = join(process.cwd(), "..", "skills", "oxygen-storytelling-review", "scripts",
    "prepare_reviewed_story_privacy.mjs");
  await execFile(process.execPath, [prepare, snapshotPath, root]);
  await mkdir(proposals);
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  return { root, proposals, manifest };
}

test("public refresh finalization publishes immutable records and exact replay", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "reviewed-story-privacy-public-finalize-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await createScriptFixture(join(directory, "fixture"));
  const finalize = join(process.cwd(), "..", "skills", "oxygen-storytelling-review", "scripts",
    "finalize_reviewed_story_privacy.mjs");
  const bundlePath = join(directory, "import.json");
  await execFile(process.execPath, [finalize, fixture.root, fixture.proposals, bundlePath]);
  const recordNames = (await readdir(join(fixture.root, "records"))).sort();
  assert.deepEqual(recordNames, [
    "changed-000.output.json",
    "changed-000.receipt.json",
    "terminal-receipt.json",
  ]);
  const publicBundle = JSON.parse(await readFile(bundlePath, "utf8"));
  assert.equal(publicBundle.schema, "oxygen.reviewed-story-privacy-import");
  assert.deepEqual(publicBundle.privacy, fixture.privacy);

  const retryPath = join(directory, "retry-import.json");
  await execFile(process.execPath, [finalize, fixture.root, fixture.proposals, retryPath]);
  assert.deepEqual(JSON.parse(await readFile(retryPath, "utf8")), publicBundle);
  await writeFile(join(fixture.proposals, "changed-000.proposals.json"),
    JSON.stringify(await privacyForTargets([fixture.target], [])));
  const recordsBefore = await Promise.all(recordNames.map((name) => (
    readFile(join(fixture.root, "records", name), "utf8")
  )));
  await assert.rejects(execFile(process.execPath, [
    finalize,
    fixture.root,
    fixture.proposals,
    join(directory, "conflict.json"),
  ]));
  assert.deepEqual(await Promise.all(recordNames.map((name) => (
    readFile(join(fixture.root, "records", name), "utf8")
  ))), recordsBefore);

  const collision = await createScriptFixture(join(directory, "records-collision"));
  const emptyRecords = join(collision.root, "records");
  await mkdir(emptyRecords);
  await assert.rejects(execFile(process.execPath, [
    finalize,
    collision.root,
    collision.proposals,
    join(directory, "collision-import.json"),
  ]));
  assert.deepEqual(await readdir(emptyRecords), []);
  assert.equal(existsSync(join(directory, "collision-import.json")), false);
});

test("local preparation/finalization is exact, bounded, and topology-contained", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "reviewed-story-privacy-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const finalize = join(process.cwd(), "..", "skills", "oxygen-storytelling-review", "scripts",
    "finalize_reviewed_story_privacy.mjs");
  const valid = await createScriptFixture(join(directory, "valid"));
  const bundlePath = join(directory, "bundle.json");
  await execFile(process.execPath, [finalize, valid.root, valid.proposals, bundlePath]);
  const bundleValue = JSON.parse(await readFile(bundlePath, "utf8"));
  assert.equal(bundleValue.terminalReceipt.outputCount, 1);
  await assert.rejects(execFile(process.execPath, [
    finalize,
    valid.root,
    join(directory, "obsolete-two-argument.json"),
  ]));

  const zeroSourceSnapshot = JSON.parse(await readFile(valid.snapshotPath, "utf8"));
  zeroSourceSnapshot.binding.sourceRevision = 0;
  zeroSourceSnapshot.binding.serverVersion = 0;
  const zeroSourceSnapshotPath = join(directory, "zero-source-snapshot.json");
  const zeroSourceRoot = join(directory, "zero-source-prepared");
  await writeFile(zeroSourceSnapshotPath, JSON.stringify(zeroSourceSnapshot));
  await assert.rejects(execFile(process.execPath, [
    valid.prepare,
    zeroSourceSnapshotPath,
    zeroSourceRoot,
  ]));
  assert.equal(existsSync(zeroSourceRoot), false);

  const validManifestPath = join(valid.root, "manifest.json");
  const validManifestText = await readFile(validManifestPath, "utf8");
  const zeroSourceManifest = JSON.parse(validManifestText);
  zeroSourceManifest.binding.sourceRevision = 0;
  await writeFile(validManifestPath, JSON.stringify(zeroSourceManifest));
  await assert.rejects(execFile(process.execPath, [
    finalize,
    valid.root,
    valid.proposals,
    join(directory, "zero-source-bundle.json"),
  ]));
  await writeFile(validManifestPath, validManifestText);

  const serverZero = await createScriptFixture(join(directory, "server-zero"), {
    sourceRevision: 1,
    serverVersion: 0,
  });
  const serverZeroBundle = join(directory, "server-zero-bundle.json");
  await execFile(process.execPath, [
    finalize,
    serverZero.root,
    serverZero.proposals,
    serverZeroBundle,
  ]);
  assert.deepEqual(JSON.parse(await readFile(serverZeroBundle, "utf8")).binding,
    JSON.parse(await readFile(serverZero.snapshotPath, "utf8")).binding);

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
  await execFile(process.execPath, [
    finalize,
    balanced.root,
    balanced.proposals,
    join(directory, "balanced-bundle.json"),
  ]);
  const firstShard = balanced.manifest.shards[0];
  const firstInputPath = join(balanced.root, firstShard.inputPath);
  const firstInputText = await readFile(firstInputPath, "utf8");
  const firstInput = JSON.parse(firstInputText);
  firstInput.targets[0].content += "tampered";
  await writeFile(firstInputPath, JSON.stringify(firstInput));
  await assert.rejects(execFile(process.execPath, [
    finalize,
    balanced.root,
    balanced.proposals,
    join(directory, "content-tampered-bundle.json"),
  ]));
  await writeFile(firstInputPath, firstInputText);

  const firstReceiptPath = join(balanced.root, "records", `${firstShard.id}.receipt.json`);
  const firstReceiptText = await readFile(firstReceiptPath, "utf8");
  const firstReceipt = JSON.parse(firstReceiptText);
  firstReceipt.inputDigest = "0".repeat(64);
  await writeFile(firstReceiptPath, JSON.stringify(firstReceipt));
  await assert.rejects(execFile(process.execPath, [
    finalize,
    balanced.root,
    balanced.proposals,
    join(directory, "foreign-receipt-bundle.json"),
  ]));
  await writeFile(firstReceiptPath, firstReceiptText);
  await rm(firstReceiptPath);
  await assert.rejects(execFile(process.execPath, [
    finalize,
    balanced.root,
    balanced.proposals,
    join(directory, "missing-receipt-bundle.json"),
  ]));
  await writeFile(firstReceiptPath, firstReceiptText);

  const removal = await createRemovalOnlyScriptFixture(join(directory, "removal"));
  assert.deepEqual(removal.manifest.shards, []);
  assert.deepEqual(removal.manifest.changedTargetIds, []);
  await execFile(process.execPath, [
    finalize,
    removal.root,
    removal.proposals,
    join(directory, "removal-bundle.json"),
  ]);

  const existingOutput = join(directory, "existing-bundle.json");
  await writeFile(existingOutput, "preserve");
  await assert.rejects(execFile(process.execPath, [
    finalize,
    valid.root,
    valid.proposals,
    existingOutput,
  ]));
  assert.equal(await readFile(existingOutput, "utf8"), "preserve");

  const existingDirectory = join(directory, "existing-output");
  await mkdir(existingDirectory);
  await writeFile(join(existingDirectory, "sentinel.txt"), "preserve");
  await assert.rejects(execFile(process.execPath, [
    balanced.prepare,
    balanced.snapshotPath,
    existingDirectory,
  ]));
  assert.equal(await readFile(join(existingDirectory, "sentinel.txt"), "utf8"), "preserve");
  const existingEmpty = join(directory, "existing-empty-output");
  await mkdir(existingEmpty);
  await assert.rejects(execFile(process.execPath, [
    balanced.prepare,
    balanced.snapshotPath,
    existingEmpty,
  ]));
  assert.deepEqual(await readdir(existingEmpty), []);

  const hardlinkFixture = await createScriptFixture(join(directory, "hardlink"));
  await link(
    join(hardlinkFixture.proposals, "changed-000.proposals.json"),
    join(directory, "hardlinked-proposal.json"),
  );
  await assert.rejects(execFile(process.execPath, [
    finalize,
    hardlinkFixture.root,
    hardlinkFixture.proposals,
    join(directory, "hardlink-bundle.json"),
  ]));

  const junctionFixture = await createScriptFixture(join(directory, "junction"));
  const alias = join(directory, "proposal-alias");
  try {
    await symlink(
      junctionFixture.proposals,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(execFile(process.execPath, [
      finalize,
      junctionFixture.root,
      alias,
      join(directory, "junction-bundle.json"),
    ]));
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
