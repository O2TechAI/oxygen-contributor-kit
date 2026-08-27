import test from "node:test";
import assert from "node:assert/strict";
import { getLocalDatabase } from "../db/index.ts";
import {
  applyChapterReview,
  applyStoryReviewToBlock,
  emptyChapterReview,
  markChapterReady,
  recordStoryEdit,
  returnChapterToReview,
  storyBlocks,
} from "../lib/story-review.ts";
import { createStoryReviewSession } from "../lib/story-review-session.ts";
import { computeSourceDigest } from "../lib/redaction-pass.mjs";
import {
  deriveStoryReleaseTargetCatalog,
  storyPreparationDigest,
} from "../lib/story-preparation.ts";
import {
  confirmProjectReleaseConfirmation,
  readProjectReleaseConfirmation,
} from "../lib/project-release-confirmation.ts";
import {
  RELEASE_ERROR,
  reconstructReviewedStoryReleaseFromDatabase,
} from "../lib/story-release-server.ts";
import { validateStorySourcePackage } from "../lib/story-readiness.ts";
import { STORY_PREFIX } from "../lib/timeline.ts";
import { testStoryCoverage } from "./fixtures/story-coverage.mjs";
import { buildPackageFromDatabase } from "../app/api/package/route.ts";
import { renderReviewedStoryHtml } from "../app/api/organization/export/route.ts";
import {
  buildReviewedStoryPrivacyPreparationSnapshot,
  decideStoryPrivacyCandidate,
  importReviewedStoryPrivacyAuthority,
  STORY_PRIVACY_ERROR,
} from "../lib/story-privacy-authority.ts";
import { loadWorkflowProgress } from "../lib/workflow-progress-server.ts";
import { startWorkflowPolling } from "../lib/workflow-progress.ts";

const RUN = "release-confirmation-run";
const REVISION = 7;
const VERSION = 1;
const NOW = "2026-08-27T08:00:00.000Z";

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function completedPrivacyImport(snapshot, candidates = [], completedAt = "2026-08-27T08:00:02.000Z") {
  candidates = [...candidates].sort((left, right) => Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)));
  const terminalReceipt = {
    schema: "oxygen.reviewed-story-privacy-terminal-receipt",
    status: "complete",
    ...Object.fromEntries(Object.entries(snapshot.binding).filter(([key]) => key !== "previousCandidateDigest")),
    outputDigest: await storyPreparationDigest(candidates),
    outputCount: candidates.length,
    completedAt,
  };
  const receiptDigest = await storyPreparationDigest(terminalReceipt);
  const core = {
    schema: "oxygen.reviewed-story-privacy-import",
    binding: snapshot.binding,
    receiptDigest,
    candidates,
  };
  return {
    ...core,
    terminalReceipt,
    importDigest: await storyPreparationDigest(core),
  };
}

function source(key, itemId, index) {
  const evidence = { documentId: "release-doc", eventId: itemId };
  return {
    schema: "oxygen.story",
    key,
    phase: { id: `phase-${index}`, label: `Phase ${index}` },
    kind: "validation",
    title: `Release title ${index}`,
    overview: `Release overview ${index}`,
    transition: { before: `Before ${index}`, after: `After ${index}` },
    people: [{
      id: `person-${index}`, releaseLabel: `Contributor ${index}`, role: "Owner",
      description: `Owned release ${index}.`, localIdentityState: "not_identified", evidence: [evidence],
    }],
    story: {
      blocks: [{ id: `block-${key}`, text: `Safe release paragraph ${index}.`, evidence: [evidence] }],
      uncertainty: `Optional uncertainty ${index}.`,
    },
    insights: [],
    evidence: { primary: evidence, supporting: [] },
    coverage: testStoryCoverage(),
  };
}

function reviewContext(story, state = null) {
  const blocks = storyBlocks(story);
  return {
    source: story,
    privacyCandidates: [], privacyDecisions: {}, targetCatalog: new Map(),
    evidenceResolved: true, supportedAddIds: [], supportedEditIds: [],
    sourceBlocks: blocks,
    reviewedBlocks: state ? {
      en: Object.fromEntries(story.story.blocks.map((block) => [block.id, block.text])),
      zh: {},
    } : blocks,
  };
}

async function clear(db) {
  for (const table of [
    "project_release_confirmations", "story_privacy_authorities", "story_privacy_candidates", "story_preparation_receipts",
    "probe_runs", "probe_bulk_decisions", "probes", "story_review_sessions",
    "redactions", "redaction_jobs", "workflow_runs", "items", "documents",
  ]) await db.prepare(`DELETE FROM ${table}`).run();
}

function observeDatabase(db) {
  const originalPrepare = db.prepare;
  const originalBatch = db.batch;
  const originalTransaction = db.transaction;
  const counts = {
    queries: 0,
    confirmationQueries: 0,
    storySnapshotQueries: 0,
    packageSnapshotQueries: 0,
    batchWriteTransactions: 0,
    longWriteTransactions: 0,
  };
  db.prepare = function observedPrepare(sql) {
    counts.queries += 1;
    if (/FROM project_release_confirmations/.test(sql)) counts.confirmationQueries += 1;
    if (/SELECT id,document_id,sequence,event_type,actor_id,actor_type,timestamp,[\s\S]*organization_reason FROM items/.test(sql)) {
      counts.storySnapshotQueries += 1;
    }
    if (/SELECT id,kind,title,source_system,source_timestamp,item_count,[\s\S]*FROM documents/.test(sql)) {
      counts.packageSnapshotQueries += 1;
    }
    return originalPrepare.call(this, sql);
  };
  db.batch = function observedBatch(statements) {
    counts.batchWriteTransactions += 1;
    return originalBatch.call(this, statements);
  };
  db.transaction = function observedTransaction(operation) {
    counts.longWriteTransactions += 1;
    return originalTransaction.call(this, operation);
  };
  return {
    counts,
    restore() {
      db.prepare = originalPrepare;
      db.batch = originalBatch;
      db.transaction = originalTransaction;
    },
  };
}

async function resolveHumanStoryPrivacy(db, decision = "keep", decidedAt = NOW) {
  await db.prepare(`UPDATE story_privacy_candidates SET decision=?,decision_version=1,decided_at=?
    WHERE candidate_id='candidate-human'`).bind(decision, decidedAt).run();
}

async function setup() {
  const db = await getLocalDatabase();
  await clear(db);
  const stories = [
    source("chapter-one", "release-doc:event-1", 1),
    source("chapter-two", "release-doc:event-2", 2),
  ];
  const items = stories.map((story, index) => ({
    id: `release-doc:event-${index + 1}`,
    document_id: "release-doc",
    sequence: index + 1,
    event_type: "message",
    actor_id: "contributor",
    actor_type: "user",
    timestamp: `2026-08-27T07:00:0${index}.000Z`,
    content: `Safe reviewed evidence ${index + 1}.`,
    organization_category: "Release Project",
    organization_confidence: 100,
    organization_reason: `${STORY_PREFIX}${JSON.stringify(story)}`,
  }));
  const candidateRows = items.map((item) => ({
    id: item.id, documentId: item.document_id, sequence: item.sequence,
    timestamp: item.timestamp, summary: item.organization_reason,
  }));
  const evidenceRows = items.map((item) => ({
    id: item.id, documentId: item.document_id, eventType: item.event_type,
    actorId: item.actor_id, actorType: item.actor_type,
  }));
  const validation = validateStorySourcePackage(candidateRows, evidenceRows);
  assert.equal(validation.ok, true);
  const activeDigest = await sha256(validation.canonicalCandidate);

  await db.prepare(`INSERT INTO documents
    (id,kind,title,source_system,source_timestamp,item_count,metadata_json,
     original_envelope_json,imported_at,updated_at,organization_status,formatted_summary_json)
    VALUES ('release-doc','trajectory','Release source','local-agent-history',?,2,?,'{}',?,?,'complete',?)`)
    .bind(NOW, "{}", NOW, NOW, JSON.stringify({
      primary_project: "Release Project", project_summary: "Safe release project.",
    })).run();
  for (const item of items) {
    await db.prepare(`INSERT INTO items
      (id,document_id,sequence,event_type,actor_id,actor_type,timestamp,content,original_json,
       organization_category,organization_confidence,organization_reason)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      item.id, item.document_id, item.sequence, item.event_type, item.actor_id, item.actor_type,
      item.timestamp, item.content, "{}", item.organization_category,
      item.organization_confidence, item.organization_reason,
    ).run();
  }
  await db.prepare(`INSERT INTO workflow_runs
    (id,target_confirmed,collection_status,collection_completed,collection_total,
     story_generation_status,story_generation_completed,story_generation_total,
     story_source_revision,active_story_digest,created_at,updated_at)
    VALUES (?,1,'complete',2,2,'ready_for_human_review',2,2,?,?,?,?)`)
    .bind(RUN, REVISION, activeDigest, NOW, NOW).run();

  const reviews = {};
  for (const story of stories) {
    const applied = applyChapterReview(emptyChapterReview(story), reviewContext(story));
    assert.equal(applied.blockedReason, undefined);
    reviews[story.key] = markChapterReady(applied.state, reviewContext(story, applied.state));
  }
  const session = createStoryReviewSession(RUN, reviews, {}, NOW);
  await db.prepare(`INSERT INTO story_review_sessions
    (workflow_run_id,state_json,updated_at,server_version) VALUES (?,?,?,?)`)
    .bind(RUN, JSON.stringify({ sourceRevision: REVISION, session }), NOW, VERSION).run();

  const sourceDigest = await computeSourceDigest(items);
  await db.prepare(`INSERT INTO redaction_jobs
    (id,status,stage,completed,total,rejected,source_digest,started_at,updated_at,completed_at)
    VALUES ('redaction-release','complete','complete',0,0,0,?,?,?,?)`)
    .bind(sourceDigest, NOW, NOW, NOW).run();

  const catalog = deriveStoryReleaseTargetCatalog(stories);
  assert.ok(catalog);
  const privacyProducts = [
    {
      id: "candidate-auto", reviewState: "deterministic", title: "Automatic suppression",
      whyFlagged: "Exact target is always excluded.", uncertaintyReason: null,
      releaseTargets: ["chapter-one::title", "chapter-two::story:block-chapter-two"],
    },
    {
      id: "candidate-human", reviewState: "needs_confirmation", title: "Contributor decision",
      whyFlagged: "Contributor decides whether the overview remains.",
      uncertaintyReason: "Context is ambiguous.", releaseTargets: ["chapter-one::overview"],
    },
  ];
  for (const candidate of privacyProducts) {
    await db.prepare(`INSERT INTO story_privacy_candidates
      (workflow_run_id,candidate_id,candidate_json) VALUES (?,?,?)`)
      .bind(RUN, candidate.id, JSON.stringify(candidate)).run();
  }
  const emptyDigest = await storyPreparationDigest([]);
  const otherDigest = "a".repeat(64);
  const completeDigest = await storyPreparationDigest(candidateRows.map((row, index) => ({
    id: row.id, story: stories[index],
  })));
  const privacyDigest = await storyPreparationDigest(privacyProducts);
  const scopeDigest = await storyPreparationDigest(catalog.map((target) => target.id));
  const receipts = [
    ["story", otherDigest, otherDigest, 2, otherDigest, 2],
    ["insight", otherDigest, otherDigest, 2, emptyDigest, 0],
    ["story_privacy", completeDigest, scopeDigest, catalog.length, privacyDigest, 2],
    ["preference", emptyDigest, emptyDigest, 0, emptyDigest, 0],
  ];
  for (const [lane, input, scope, scopeCount, output, outputCount] of receipts) {
    await db.prepare(`INSERT INTO story_preparation_receipts
      (workflow_run_id,lane,source_revision,input_digest,scope_digest,scope_count,
       output_digest,output_count,completed_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(RUN, lane, REVISION, input, scope, scopeCount, output, outputCount, NOW).run();
  }
  await db.prepare(`INSERT INTO probe_runs
    (workflow_run_id,id,source_revision,input_digest,output_digest,output_count,status,stage,
     generated,set_aside,auto_removed_json,started_at,updated_at,completed_at)
    VALUES (?,?,?,?,?,0,'complete','preference',0,0,?,?,?,?)`)
    .bind(RUN, RUN, REVISION, emptyDigest, emptyDigest,
      JSON.stringify({ total: 0, reversible: true, categories: [] }), NOW, NOW, NOW).run();
  return { db, stories, reviews, request: {
    workflowRunId: RUN, serverVersion: VERSION, sourceRevision: REVISION,
  } };
}

test("active Story with no confirmation row performs no release reconstruction or write transaction", async () => {
  const { db } = await setup();
  const observation = observeDatabase(db);
  let workflow;
  try {
    workflow = await loadWorkflowProgress(RUN);
  } finally {
    observation.restore();
  }
  assert.equal(workflow.releaseConfirmed, false);
  assert.equal(observation.counts.confirmationQueries, 1);
  assert.equal(observation.counts.storySnapshotQueries, 0);
  assert.equal(observation.counts.packageSnapshotQueries, 0);
  assert.equal(observation.counts.batchWriteTransactions, 0);
  assert.equal(observation.counts.longWriteTransactions, 0);
});

test("present confirmation reconstructs outside a long write transaction and mutation fails closed", async () => {
  const { db, request } = await setup();
  await resolveHumanStoryPrivacy(db);
  assert.equal((await confirmProjectReleaseConfirmation(db, request, NOW)).ok, true);

  const observation = observeDatabase(db);
  let confirmed;
  try {
    confirmed = await readProjectReleaseConfirmation(db, request);
  } finally {
    observation.restore();
  }
  assert.equal(confirmed, true);
  assert.equal(observation.counts.storySnapshotQueries, 2);
  assert.equal(observation.counts.packageSnapshotQueries, 2);
  assert.equal(observation.counts.batchWriteTransactions, 5,
    "only bounded Story, package, and Story Privacy batches open short BEGIN IMMEDIATE scopes");
  assert.equal(observation.counts.longWriteTransactions, 0,
    "no BEGIN IMMEDIATE transaction covers passive reconstruction");

  const beforeChapterBytes = (await db.prepare(
    "SELECT state_json FROM story_review_sessions WHERE workflow_run_id=?",
  ).bind(RUN).first()).state_json;
  const raced = await readProjectReleaseConfirmation(db, request, {
    beforeFinalPrivacyCheck: () => db.prepare(`UPDATE project_release_confirmations
      SET confirmed_at=? WHERE workflow_run_id=?`)
      .bind("2026-08-27T08:00:01.000Z", RUN).run(),
  });
  assert.equal(raced, false);
  assert.equal((await db.prepare(
    "SELECT state_json FROM story_review_sessions WHERE workflow_run_id=?",
  ).bind(RUN).first()).state_json, beforeChapterBytes);
});

test("real SQLite release confirmation is fail-closed, concurrent-idempotent, and globally suppresses Privacy", async () => {
  const { db, request } = await setup();
  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(db, request)).code,
    RELEASE_ERROR.storyPrivacyPending);
  const pending = await confirmProjectReleaseConfirmation(db, request, NOW);
  assert.equal(pending.code, RELEASE_ERROR.storyPrivacyPending);
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM project_release_confirmations").first()).total, 0);

  await db.prepare(`UPDATE story_privacy_candidates
    SET decision='keep',decision_version=1,decided_at=? WHERE candidate_id='candidate-human'`)
    .bind(NOW).run();
  const insightReceipt = await db.prepare(
    "SELECT * FROM story_preparation_receipts WHERE workflow_run_id=? AND lane='insight'",
  ).bind(RUN).first();
  await db.prepare("DELETE FROM story_preparation_receipts WHERE workflow_run_id=? AND lane='insight'")
    .bind(RUN).run();
  assert.equal((await confirmProjectReleaseConfirmation(db, request, NOW)).ok, false);
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM project_release_confirmations").first()).total, 0);
  await db.prepare(`INSERT INTO story_preparation_receipts
    (workflow_run_id,lane,source_revision,input_digest,scope_digest,scope_count,
     output_digest,output_count,completed_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(
    insightReceipt.workflow_run_id, insightReceipt.lane, insightReceipt.source_revision,
    insightReceipt.input_digest, insightReceipt.scope_digest, insightReceipt.scope_count,
    insightReceipt.output_digest, insightReceipt.output_count, insightReceipt.completed_at,
  ).run();
  await db.prepare("UPDATE story_preparation_receipts SET output_digest='corrupt' WHERE lane='insight'")
    .run();
  assert.equal((await confirmProjectReleaseConfirmation(db, request, NOW)).ok, false);
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM project_release_confirmations").first()).total, 0);
  await db.prepare("UPDATE story_preparation_receipts SET output_digest=? WHERE lane='insight'")
    .bind(insightReceipt.output_digest).run();

  await db.prepare(`CREATE TRIGGER fail_project_release_confirmation
    BEFORE INSERT ON project_release_confirmations
    BEGIN SELECT RAISE(ABORT, 'forced release confirmation failure'); END`).run();
  assert.equal((await confirmProjectReleaseConfirmation(db, request, NOW)).code,
    "RELEASE_CONFIRMATION_CONFLICT");
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM project_release_confirmations").first()).total, 0);
  await db.prepare("DROP TRIGGER fail_project_release_confirmation").run();
  const concurrent = await Promise.all([
    confirmProjectReleaseConfirmation(db, request, NOW),
    confirmProjectReleaseConfirmation(db, request, NOW),
  ]);
  assert.ok(concurrent.every((result) => result.ok));
  assert.deepEqual(concurrent.map((result) => result.idempotent).sort(), [false, true]);
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM project_release_confirmations").first()).total, 1);

  const release = await reconstructReviewedStoryReleaseFromDatabase(db, request);
  assert.equal(release.ok, true);
  assert.equal(release.story.chapters[0].en.title, "[Redacted]");
  assert.equal(release.story.chapters[0].en.overview, "Release overview 1");
  assert.deepEqual(release.story.chapters[1].en.story.blocks, []);
  assert.equal(JSON.stringify(release.story).includes("candidate-auto"), false);
  assert.equal((await confirmProjectReleaseConfirmation(db, request, NOW)).idempotent, true);
});

test("Preference, receipt, session, edit, and final snapshot mutations block without stale bytes", async () => {
  const { db, stories, reviews, request } = await setup();
  await db.prepare(`UPDATE story_privacy_candidates SET decision='redact',decision_version=1,decided_at=?
    WHERE candidate_id='candidate-human'`).bind(NOW).run();
  assert.equal((await confirmProjectReleaseConfirmation(db, request, NOW)).ok, true);
  assert.equal(await readProjectReleaseConfirmation(db, request), true);

  await db.prepare(`INSERT INTO probes
    (id,document_id,document_kind,event_ids_json,signal,recap,question,options_json,
     presentations_json,created_at) VALUES ('probe-unanswered','release-doc','trajectory','[]',
     'preference','recap','Question?','[]','{}',?)`).bind(NOW).run();
  await db.prepare("UPDATE probe_runs SET output_count=1,output_digest=? WHERE workflow_run_id=?")
    .bind("c".repeat(64), RUN).run();
  await db.prepare("UPDATE story_preparation_receipts SET output_count=1,output_digest=? WHERE lane='preference'")
    .bind("c".repeat(64)).run();
  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(db, request)).code,
    RELEASE_ERROR.preferencePending);
  await db.prepare("UPDATE probes SET answer_choice='skip',answered_at=? WHERE id='probe-unanswered'")
    .bind(NOW).run();
  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(db, request)).code,
    RELEASE_ERROR.releaseConfirmationRequired);
  assert.equal(await readProjectReleaseConfirmation(db, request), false);
  assert.equal((await confirmProjectReleaseConfirmation(db, request, "2026-08-27T08:00:01.000Z")).ok, true);
  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(db, request)).ok, true);
  const chapterStateBeforePreferenceChange = (await db.prepare(
    "SELECT state_json FROM story_review_sessions WHERE workflow_run_id=?",
  ).bind(RUN).first()).state_json;
  await db.prepare("UPDATE probes SET answer_choice='keep',answered_at=? WHERE id='probe-unanswered'")
    .bind("2026-08-27T08:00:02.000Z").run();
  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(db, request)).code,
    RELEASE_ERROR.releaseConfirmationRequired);
  assert.equal((await db.prepare("SELECT state_json FROM story_review_sessions WHERE workflow_run_id=?")
    .bind(RUN).first()).state_json, chapterStateBeforePreferenceChange);
  assert.equal((await confirmProjectReleaseConfirmation(db, request, "2026-08-27T08:00:03.000Z")).ok, true);
  assert.equal(await readProjectReleaseConfirmation(db, request), true);

  const raced = await reconstructReviewedStoryReleaseFromDatabase(db, request, {
    beforeFinalPrivacyCheck: () => db.prepare(
      "UPDATE story_preparation_receipts SET completed_at=? WHERE lane='story'",
    ).bind("2026-08-27T08:00:01.000Z").run(),
  });
  assert.equal(raced.code, RELEASE_ERROR.privacyConflict);
  await db.prepare("UPDATE story_preparation_receipts SET completed_at=? WHERE lane='story'")
    .bind(NOW).run();

  const currentGate = await db.prepare("SELECT review_gate_digest FROM project_release_confirmations WHERE workflow_run_id=?")
    .bind(RUN).first();
  const finalSnapshotRaces = [
    [
      "UPDATE story_privacy_candidates SET decision='keep' WHERE candidate_id='candidate-human'",
      "UPDATE story_privacy_candidates SET decision='redact' WHERE candidate_id='candidate-human'",
    ],
    [
      "UPDATE probes SET answer_choice='skip' WHERE id='probe-unanswered'",
      "UPDATE probes SET answer_choice='keep' WHERE id='probe-unanswered'",
    ],
    [
      "UPDATE story_review_sessions SET updated_at='2026-08-27T08:00:01.000Z' WHERE workflow_run_id='release-confirmation-run'",
      "UPDATE story_review_sessions SET updated_at='2026-08-27T08:00:00.000Z' WHERE workflow_run_id='release-confirmation-run'",
    ],
    [
      "UPDATE project_release_confirmations SET review_gate_digest='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' WHERE workflow_run_id='release-confirmation-run'",
      `UPDATE project_release_confirmations SET review_gate_digest='${currentGate.review_gate_digest}' WHERE workflow_run_id='release-confirmation-run'`,
    ],
  ];
  for (const [mutate, restore] of finalSnapshotRaces) {
    const conflict = await reconstructReviewedStoryReleaseFromDatabase(db, request, {
      beforeFinalPrivacyCheck: () => db.prepare(mutate).run(),
    });
    assert.equal(conflict.code, RELEASE_ERROR.privacyConflict);
    await db.prepare(restore).run();
  }

  await db.prepare("DELETE FROM project_release_confirmations").run();
  const editedStory = stories[0];
  const unconfirmedSession = createStoryReviewSession(RUN, {
    ...reviews, [editedStory.key]: returnChapterToReview(reviews[editedStory.key]),
  }, {}, NOW);
  await db.prepare("UPDATE story_review_sessions SET state_json=?,server_version=2 WHERE workflow_run_id=?")
    .bind(JSON.stringify({ sourceRevision: REVISION, session: unconfirmedSession }), RUN).run();
  assert.equal((await confirmProjectReleaseConfirmation(db, { ...request, serverVersion: 2 }, NOW)).code,
    RELEASE_ERROR.reviewIncomplete);

  const edited = recordStoryEdit(returnChapterToReview(reviews[editedStory.key]), {
    storyKey: editedStory.key,
    blockId: editedStory.story.blocks[0].id,
    sourceLanguage: "en",
    baseText: editedStory.story.blocks[0].text,
    nextText: editedStory.story.blocks[0].text.replace("Safe ", ""),
    workingRange: { start: 0, end: 5 },
    insertedText: "",
    now: 1,
  });
  assert.equal(edited.blockedReason, undefined);
  const applied = applyChapterReview(edited.state, reviewContext(editedStory, edited.state));
  assert.equal(applied.blockedReason, undefined);
  const confirmed = markChapterReady(applied.state, reviewContext(editedStory, applied.state));
  assert.equal(confirmed.stage, "human_confirmed");
  assert.notEqual(applyStoryReviewToBlock(
    editedStory.story.blocks[0].text,
    editedStory.story.blocks[0].id,
    "en",
    confirmed,
  ), editedStory.story.blocks[0].text);
  const editedSession = createStoryReviewSession(RUN, {
    ...reviews, [editedStory.key]: confirmed,
  }, {}, NOW);
  await db.prepare("UPDATE story_review_sessions SET state_json=?,server_version=2 WHERE workflow_run_id=?")
    .bind(JSON.stringify({ sourceRevision: REVISION, session: editedSession }), RUN).run();
  assert.equal((await confirmProjectReleaseConfirmation(db, { ...request, serverVersion: 2 }, NOW)).code,
    RELEASE_ERROR.preparationInvalid);

  const privacyPreparation = await buildReviewedStoryPrivacyPreparationSnapshot(db, RUN);
  assert.equal(privacyPreparation.ok, true);
  assert.ok(privacyPreparation.snapshot.binding.changedTargetCount > 0);
  const imported = await importReviewedStoryPrivacyAuthority(
    db,
    await completedPrivacyImport(privacyPreparation.snapshot),
    "2026-08-27T08:00:02.000Z",
  );
  assert.equal(imported.ok, true);
  const chapterBytesBeforeReconfirm = (await db.prepare(
    "SELECT state_json FROM story_review_sessions WHERE workflow_run_id=?",
  ).bind(RUN).first()).state_json;
  assert.equal((await confirmProjectReleaseConfirmation(db, { ...request, serverVersion: 2 },
    "2026-08-27T08:00:03.000Z")).ok, true);
  assert.equal((await db.prepare("SELECT state_json FROM story_review_sessions WHERE workflow_run_id=?")
    .bind(RUN).first()).state_json, chapterBytesBeforeReconfirm);
  const editedRelease = await reconstructReviewedStoryReleaseFromDatabase(
    db,
    { ...request, serverVersion: 2 },
  );
  assert.equal(editedRelease.ok, true);
  assert.match(editedRelease.serializedStory, /release paragraph 1/i);

  await db.prepare("UPDATE story_review_sessions SET state_json='not-json' WHERE workflow_run_id=?")
    .bind(RUN).run();
  assert.equal((await confirmProjectReleaseConfirmation(db, { ...request, serverVersion: 2 }, NOW)).code,
    RELEASE_ERROR.stateInvalid);
});

test("every bound authority invalidates only project release confirmation, never Chapter bytes", async () => {
  const { db, request } = await setup();
  await resolveHumanStoryPrivacy(db);
  assert.equal((await confirmProjectReleaseConfirmation(db, request, NOW)).ok, true);
  let currentRequest = request;
  const chapterBytes = (await db.prepare(
    "SELECT state_json FROM story_review_sessions WHERE workflow_run_id=?",
  ).bind(RUN).first()).state_json;
  const invalidated = async (label, mutate, nextRequest = currentRequest) => {
    await mutate();
    assert.equal(await readProjectReleaseConfirmation(db, nextRequest), false, label);
    assert.equal((await db.prepare(
      "SELECT state_json FROM story_review_sessions WHERE workflow_run_id=?",
    ).bind(RUN).first()).state_json, chapterBytes, `${label} changed Chapter confirmation bytes`);
    assert.equal((await confirmProjectReleaseConfirmation(
      db,
      nextRequest,
      new Date(Date.parse(NOW) + 10_000).toISOString(),
    )).ok, true, `${label} could not be explicitly reconfirmed`);
    currentRequest = nextRequest;
  };

  await invalidated("Preference mutation", async () => {
    await db.prepare(`INSERT INTO probes
      (id,document_id,document_kind,event_ids_json,signal,recap,question,options_json,
       presentations_json,answer_choice,answered_at,created_at)
      VALUES ('probe-bound','release-doc','trajectory','[]','preference','recap','Question?',
       '[]','{}','keep',?,?)`).bind(NOW, NOW).run();
    await db.prepare("UPDATE probe_runs SET output_count=1,output_digest=? WHERE workflow_run_id=?")
      .bind("c".repeat(64), RUN).run();
    await db.prepare(`UPDATE story_preparation_receipts SET output_count=1,output_digest=?
      WHERE workflow_run_id=? AND lane='preference'`).bind("c".repeat(64), RUN).run();
  });
  await invalidated("source Privacy mutation", () => db.prepare(
    "UPDATE redaction_jobs SET updated_at=? WHERE id='redaction-release'",
  ).bind("2026-08-27T08:00:04.000Z").run());
  await invalidated("Story Privacy mutation", () => db.prepare(`UPDATE story_privacy_candidates
    SET decision='redact',decided_at=? WHERE candidate_id='candidate-human'`)
    .bind("2026-08-27T08:00:05.000Z").run());
  await invalidated("receipt mutation", () => db.prepare(`UPDATE story_preparation_receipts
    SET completed_at=? WHERE workflow_run_id=? AND lane='insight'`)
    .bind("2026-08-27T08:00:06.000Z", RUN).run());
  await invalidated("package mutation", () => db.prepare(
    "UPDATE documents SET title='Release source revised' WHERE id='release-doc'",
  ).run());
  await invalidated("Story/session mutation", () => db.prepare(`UPDATE story_review_sessions
    SET updated_at=?,server_version=2 WHERE workflow_run_id=?`)
    .bind("2026-08-27T08:00:07.000Z", RUN).run(), { ...request, serverVersion: 2 });

  const storyBytes = (await db.prepare(
    "SELECT organization_reason FROM items WHERE id='release-doc:event-1'",
  ).first()).organization_reason;
  await db.prepare("UPDATE items SET organization_reason=? WHERE id='release-doc:event-1'")
    .bind(`${storyBytes} `).run();
  assert.equal(await readProjectReleaseConfirmation(db, currentRequest), false,
    "Story-byte mutation did not invalidate release confirmation");
  assert.equal((await db.prepare(
    "SELECT state_json FROM story_review_sessions WHERE workflow_run_id=?",
  ).bind(RUN).first()).state_json, chapterBytes);
  await db.prepare("UPDATE items SET organization_reason=? WHERE id='release-doc:event-1'")
    .bind(storyBytes).run();
  assert.equal(await readProjectReleaseConfirmation(db, currentRequest), true,
    "restoring exact Story bytes did not restore the current confirmation binding");
});

test("HTML and ZIP are POST-only, byte-identical for reviewed Story, and exclude authority sentinels", async () => {
  const { db, request } = await setup();
  await db.prepare(`UPDATE story_privacy_candidates SET decision='keep',decision_version=1,decided_at=?
    WHERE candidate_id='candidate-human'`).bind(NOW).run();
  assert.equal((await confirmProjectReleaseConfirmation(db, request, NOW)).ok, true);
  const release = await reconstructReviewedStoryReleaseFromDatabase(db, request);
  assert.equal(release.ok, true);
  const completedZero = await buildReviewedStoryPrivacyPreparationSnapshot(db, RUN);
  assert.equal(completedZero.ok, false);
  assert.equal(completedZero.code, STORY_PRIVACY_ERROR.notActionable,
    "zero changed targets must require no successor preparation and still release");
  const html = renderReviewedStoryHtml(release.serializedStory);
  const embedded = html.match(/const STORY=([\s\S]*?);const view=/)?.[1];
  assert.deepEqual(JSON.parse(embedded), JSON.parse(release.serializedStory));
  assert.match(html, /story-row/);
  assert.match(html, /grid-template-columns/);

  const zipResponse = await buildPackageFromDatabase(db, release.serializedStory, request, {
    exportedAt: NOW,
  });
  assert.equal(zipResponse.status, 200);
  const zipText = new TextDecoder().decode(await zipResponse.arrayBuffer());
  assert.match(zipText, /oxygen\.reviewed-story/);
  assert.match(zipText, /"publication_approved": false/);
  assert.doesNotMatch(zipText, /candidate-auto|candidate-human|whyFlagged|releaseTargets|decisionVersion|reviewGateDigest|review_gate_digest/);
  assert.doesNotMatch(zipText, /provider|model|evidence_sample|PRIVATE_/i);

  const racedZip = await buildPackageFromDatabase(db, release.serializedStory, request, {
    exportedAt: NOW,
    beforeFinalPrivacyCheck: () => db.prepare(
      "UPDATE project_release_confirmations SET review_gate_digest='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' WHERE workflow_run_id=?",
    ).bind(RUN).run(),
  });
  assert.equal(racedZip.status, 409);
  assert.equal((await racedZip.text()).includes("oxygen.reviewed-story"), false);

  const packageRoute = await import("../app/api/package/route.ts");
  const htmlRoute = await import("../app/api/organization/export/route.ts");
  assert.equal((await packageRoute.GET()).status, 405);
  assert.equal((await htmlRoute.GET()).status, 405);
});

test("edited Story release accepts one exact nonzero changed-block authority after its decision", async () => {
  const { db, stories, reviews, request } = await setup();
  await db.prepare(`UPDATE story_privacy_candidates SET decision='keep',decision_version=1,decided_at=?
    WHERE candidate_id='candidate-human'`).bind(NOW).run();
  const editedStory = stories[0];
  const editing = recordStoryEdit(returnChapterToReview(reviews[editedStory.key]), {
    storyKey: editedStory.key,
    blockId: editedStory.story.blocks[0].id,
    sourceLanguage: "en",
    baseText: editedStory.story.blocks[0].text,
    nextText: editedStory.story.blocks[0].text.replace("Safe ", ""),
    workingRange: { start: 0, end: 5 },
    insertedText: "",
    now: 2,
  });
  assert.equal(editing.blockedReason, undefined);
  const applied = applyChapterReview(editing.state, reviewContext(editedStory, editing.state));
  assert.equal(applied.blockedReason, undefined);
  const confirmed = markChapterReady(applied.state, reviewContext(editedStory, applied.state));
  assert.equal(confirmed.stage, "human_confirmed");
  const session = createStoryReviewSession(RUN, {
    ...reviews,
    [editedStory.key]: confirmed,
  }, {}, NOW);
  await db.prepare("UPDATE story_review_sessions SET state_json=?,server_version=2 WHERE workflow_run_id=?")
    .bind(JSON.stringify({ sourceRevision: REVISION, session }), RUN).run();

  const preparation = await buildReviewedStoryPrivacyPreparationSnapshot(db, RUN);
  assert.equal(preparation.ok, true);
  const target = preparation.snapshot.changedTargets[0].id;
  const changedCandidate = {
    id: "changed-block-current-candidate",
    reviewState: "needs_confirmation",
    title: "Current changed block",
    whyFlagged: "The exact changed target requires one decision.",
    uncertaintyReason: "Contributor confirmation is required.",
    releaseTargets: [target],
  };
  const imported = await importReviewedStoryPrivacyAuthority(
    db,
    await completedPrivacyImport(preparation.snapshot, [changedCandidate]),
    "2026-08-27T08:00:02.000Z",
  );
  assert.equal(imported.ok, true);
  assert.equal((await confirmProjectReleaseConfirmation(db, { ...request, serverVersion: 2 }, NOW)).code,
    RELEASE_ERROR.storyPrivacyPending);
  const decided = await decideStoryPrivacyCandidate(db, {
    workflowRunId: RUN,
    sourceRevision: REVISION,
    activeStoryDigest: imported.authority.activeStoryDigest,
    candidateDigest: imported.authority.candidateDigest,
    expectedVersion: 0,
    decision: "keep",
  }, changedCandidate.id, "2026-08-27T08:00:03.000Z");
  assert.equal(decided.ok, true);
  assert.equal((await confirmProjectReleaseConfirmation(db, { ...request, serverVersion: 2 },
    "2026-08-27T08:00:04.000Z")).ok, true);
  const release = await reconstructReviewedStoryReleaseFromDatabase(
    db,
    { ...request, serverVersion: 2 },
  );
  assert.equal(release.ok, true);
  assert.match(release.serializedStory, /release paragraph 1/);
  const html = renderReviewedStoryHtml(release.serializedStory);
  assert.match(html, /story-row/);
  const zipResponse = await buildPackageFromDatabase(
    db,
    release.serializedStory,
    { ...request, serverVersion: 2 },
    { exportedAt: "2026-08-27T08:00:05.000Z" },
  );
  assert.equal(zipResponse.status, 200, "completed-nonzero changed-block authority must package");
  const zipText = new TextDecoder().decode(await zipResponse.arrayBuffer());
  assert.match(zipText, /oxygen\.reviewed-story/);
  assert.match(zipText, /"publication_approved": false/);
  assert.doesNotMatch(zipText, /changed-block-current-candidate|releaseTargets|candidateDigest/);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS count FROM story_privacy_candidates
    WHERE candidate_id=?`).bind(changedCandidate.id).first()).count, 1);
});

test("provider-free 24,796-item release-confirmation benchmark", { timeout: 120_000 }, async () => {
  const { db, request } = await setup();
  const targetItemCount = 24_796;
  const targetTextBytes = 17.5 * 1024 * 1024;
  const baseline = await db.prepare("SELECT id,content FROM items ORDER BY id").all();
  const baselineTextBytes = baseline.results.reduce(
    (total, row) => total + Buffer.byteLength(String(row.content || "")),
    0,
  );
  const extraCount = targetItemCount - baseline.results.length;
  const remainingBytes = targetTextBytes - baselineTextBytes;
  const ordinaryBytes = Math.floor(remainingBytes / extraCount);
  const largerRows = remainingBytes % extraCount;
  await db.transaction(async () => {
    for (let index = 0; index < extraCount; index += 1) {
      const contentBytes = ordinaryBytes + (index < largerRows ? 1 : 0);
      await db.prepare(`INSERT INTO items
        (id,document_id,sequence,event_type,actor_id,actor_type,timestamp,content,original_json,
         organization_category,organization_confidence,organization_reason)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)`).bind(
        `release-doc:benchmark-${index}`,
        "release-doc",
        index + 3,
        "message",
        "benchmark",
        "system",
        null,
        "x".repeat(contentBytes),
        "{}",
        "Benchmark",
        100,
      ).run();
    }
    await db.prepare("UPDATE documents SET item_count=? WHERE id='release-doc'")
      .bind(targetItemCount).run();
  });
  const digestRows = await db.prepare(`SELECT id,document_id,sequence,event_type,actor_id,
    actor_type,timestamp,content,organization_reason FROM items ORDER BY document_id,sequence,id`).all();
  await db.prepare("UPDATE redaction_jobs SET source_digest=? WHERE id='redaction-release'")
    .bind(await computeSourceDigest(digestRows.results)).run();
  const scale = await db.prepare(`SELECT COUNT(*) AS item_count,
    SUM(length(CAST(content AS BLOB))) AS text_bytes FROM items`).first();
  assert.equal(scale.item_count, targetItemCount);
  assert.equal(scale.text_bytes, targetTextBytes);

  const noRowObservation = observeDatabase(db);
  const noRowStartedAt = performance.now();
  let noRowWorkflow;
  try {
    noRowWorkflow = await loadWorkflowProgress(RUN);
  } finally {
    noRowObservation.counts.latencyMs = performance.now() - noRowStartedAt;
    noRowObservation.restore();
  }
  assert.equal(noRowWorkflow.releaseConfirmed, false);
  assert.equal(noRowObservation.counts.storySnapshotQueries, 0);
  assert.equal(noRowObservation.counts.packageSnapshotQueries, 0);
  assert.equal(noRowObservation.counts.batchWriteTransactions, 0);
  assert.equal(noRowObservation.counts.longWriteTransactions, 0);

  await resolveHumanStoryPrivacy(db);
  assert.equal((await confirmProjectReleaseConfirmation(db, request, NOW)).ok, true);
  const confirmedObservation = observeDatabase(db);
  const confirmedStartedAt = performance.now();
  let confirmed;
  try {
    confirmed = await readProjectReleaseConfirmation(db, request);
  } finally {
    confirmedObservation.counts.latencyMs = performance.now() - confirmedStartedAt;
    confirmedObservation.restore();
  }
  assert.equal(confirmed, true);
  assert.equal(confirmedObservation.counts.storySnapshotQueries, 2);
  assert.equal(confirmedObservation.counts.packageSnapshotQueries, 2);
  assert.equal(confirmedObservation.counts.batchWriteTransactions, 5);
  assert.equal(confirmedObservation.counts.longWriteTransactions, 0);

  const scheduled = [];
  let releaseDelayedPoll;
  const delayedPoll = new Promise((resolve) => { releaseDelayedPoll = resolve; });
  let inFlight = 0;
  let maximumInFlight = 0;
  const polling = startWorkflowPolling(async () => {
    inFlight += 1;
    maximumInFlight = Math.max(maximumInFlight, inFlight);
    await delayedPoll;
    inFlight -= 1;
  }, {
    intervalMs: 2_000,
    schedule: (callback) => { scheduled.push(callback); return callback; },
    cancel: (handle) => {
      const index = scheduled.indexOf(handle);
      if (index >= 0) scheduled.splice(index, 1);
    },
  });
  scheduled.shift()();
  await Promise.resolve();
  const simulatedDelayMs = 2_500;
  assert.ok(simulatedDelayMs > 2_000);
  assert.equal(scheduled.length, 0);
  releaseDelayedPoll();
  await new Promise((resolve) => setImmediate(resolve));
  polling.retire();
  assert.equal(maximumInFlight, 1);

  console.log("RELEASE_CONFIRMATION_BENCHMARK", JSON.stringify({
    itemCount: scale.item_count,
    textBytes: scale.text_bytes,
    noRow: noRowObservation.counts,
    confirmedRow: confirmedObservation.counts,
    reconstructionCoveredByBeginImmediate: confirmedObservation.counts.longWriteTransactions > 0,
    maximumConcurrentWorkflowPolls: maximumInFlight,
    simulatedDelayedResponseMs: simulatedDelayMs,
  }));
});
