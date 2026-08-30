import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildSourcePrivacyReceipt,
  seedFinalizedCorpusManifest,
} from "./fixtures/source-privacy-receipt.mjs";
import {
  canonicalSourcePrivacyJson,
  sourcePrivacyDigest,
} from "../lib/source-privacy-receipt.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[^/]+$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        return nextResolve(`${specifier}/index.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const oldTime = "2036-01-01T00:00:00.000Z";
const LOCAL_REASON_SENTINEL = "LOCAL_REASON_SENTINEL";
const LOCAL_UNCERTAINTY_SENTINEL = "LOCAL_UNCERTAINTY_SENTINEL";

function span(overrides = {}) {
  return {
    id: "new-redaction",
    itemId: "item-alpha",
    documentId: "document-alpha",
    startOffset: 6,
    endOffset: 12,
    category: "sensitive",
    confidence: "high",
    reason: LOCAL_REASON_SENTINEL,
    reviewState: "deterministic",
    uncertaintyReason: null,
    createdBy: "llm",
    ...overrides,
  };
}

function payload(redactions, receipt, overrides = {}) {
  const { job = {}, ...rest } = overrides;
  return {
    replaceAll: true,
    job: {
      status: "complete",
      stage: "done",
      model: "fixture-model",
      total: redactions.length,
      rejected: 0,
      ...job,
    },
    redactions,
    receipt,
    ...rest,
  };
}

async function resignReceipt(receipt) {
  const core = { ...receipt };
  delete core.receiptDigest;
  return { ...core, receiptDigest: await sourcePrivacyDigest(core) };
}

function post(route, body) {
  return route.POST(new Request("http://localhost/api/redactions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

function decide(route, id, body) {
  return route.PATCH(new Request(`http://localhost/api/redactions/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) });
}

async function privacySnapshot(db) {
  const [jobs, redactions, receipts] = await Promise.all([
    db.prepare("SELECT * FROM redaction_jobs ORDER BY id").all(),
    db.prepare("SELECT * FROM redactions ORDER BY id").all(),
    db.prepare("SELECT * FROM source_privacy_receipts ORDER BY job_id").all(),
  ]);
  return { jobs: jobs.results, redactions: redactions.results, receipts: receipts.results };
}

async function storyAuthoritySnapshot(db) {
  return db.prepare(`SELECT story_generation_status,story_source_revision,
    active_story_digest FROM workflow_runs WHERE id='workflow-redaction-atomicity'`).first();
}

async function seedReleaseConfirmation(db, workflowRunId = "workflow-redaction-atomicity") {
  await db.prepare(`INSERT INTO project_release_confirmations
    (workflow_run_id,review_gate_digest,confirmed_at) VALUES (?,?,?)
    ON CONFLICT(workflow_run_id) DO UPDATE SET
      review_gate_digest=excluded.review_gate_digest,confirmed_at=excluded.confirmed_at`)
    .bind(workflowRunId, "9".repeat(64), oldTime).run();
}

async function releaseConfirmationSnapshot(db) {
  const rows = await db.prepare(
    "SELECT * FROM project_release_confirmations ORDER BY workflow_run_id",
  ).all();
  return rows.results;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function corpusEntry(documentId, itemId, content) {
  return {
    document: {
      id: documentId,
      kind: "trajectory",
      title: `Replacement ${documentId}`,
      sourceUser: "fixture-user",
      sourceSystem: "fixture-system",
      sourceTimestamp: oldTime,
      metadata: { fixture: documentId },
      envelope: { source: "redaction-atomicity-sqlite" },
      itemCount: 1,
    },
    items: [{
      id: itemId,
      sequence: 1,
      eventType: "message",
      actorId: "fixture-actor",
      actorType: "assistant",
      timestamp: oldTime,
      content,
      original: { event_id: itemId, trajectory_id: documentId },
    }],
  };
}

function postDocuments(route, documents) {
  return route.POST(new Request("http://localhost/api/documents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ documents }),
  }));
}

async function seedConcurrentPrivacyState(db, establishWorkflowRun, computeSourceDigest) {
  const workflowRunId = "workflow-redaction-atomicity";
  const sourceRevision = 7;
  const activeStoryDigest = "a".repeat(64);
  await establishWorkflowRun(db, workflowRunId, oldTime);
  await db.batch([
    db.prepare(`INSERT INTO documents
      (id,kind,title,source_system,item_count,metadata_json,original_envelope_json,
       imported_at,updated_at,formatted_summary_json) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .bind("document-old", "trajectory", "Old source", "fixture", 1,
        "{}", "{}", oldTime, oldTime, "{}"),
    db.prepare(`INSERT INTO items
      (id,document_id,sequence,event_type,actor_id,actor_type,timestamp,content,original_json)
      VALUES (?,?,?,?,?,?,?,?,?)`).bind(
        "item-old", "document-old", 1, "message", "fixture-actor", "assistant",
        oldTime, "old private source", "{}",
      ),
  ]);
  const sourceRows = await db.prepare(
    `SELECT document_id,id,sequence,event_type,actor_type,timestamp,content
       FROM items ORDER BY document_id,sequence,id`,
  ).all();
  const sourceDigest = await computeSourceDigest(sourceRows.results);
  await db.batch([
    db.prepare(`INSERT INTO redactions
      (id,item_id,document_id,start_offset,end_offset,category,confidence,reason,
       review_state,uncertainty_reason,status,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        "race-candidate", "item-old", "document-old", 4, 11, "sensitive", "high",
        LOCAL_REASON_SENTINEL, "needs_confirmation", LOCAL_UNCERTAINTY_SENTINEL,
        "active", "llm", oldTime, oldTime,
      ),
    db.prepare(`INSERT INTO redaction_jobs
      (id,status,stage,model,completed,total,rejected,source_digest,
       started_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
        "job-old", "complete", "done", "fixture-model", 1, 1, 0, sourceDigest,
        oldTime, oldTime, oldTime,
      ),
    db.prepare(`UPDATE workflow_runs SET story_generation_status='ready_for_human_review',
      story_source_revision=?,active_story_digest=? WHERE id=?`)
      .bind(sourceRevision, activeStoryDigest, workflowRunId),
    db.prepare(`INSERT INTO story_privacy_authorities
      (workflow_run_id,source_revision,active_story_digest,server_version,
       reviewed_story_digest,target_catalog_json,target_catalog_digest,changed_target_digest,
       changed_target_count,receipt_digest,proposal_digest,proposal_count,imported_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        workflowRunId, sourceRevision, activeStoryDigest, 1, "b".repeat(64), "[]",
        "c".repeat(64), "d".repeat(64), 0, "e".repeat(64), "f".repeat(64), 0, oldTime,
      ),
    db.prepare(`INSERT INTO project_release_confirmations
      (workflow_run_id,review_gate_digest,confirmed_at)
      VALUES (?,?,?)`).bind(workflowRunId, "9".repeat(64), oldTime),
  ]);
  await seedFinalizedCorpusManifest(db, { workflowRunId, at: oldTime });
  return { workflowRunId, sourceRevision, sourceDigest, activeStoryDigest };
}

async function completeAuthoritySnapshot(db) {
  return db.transaction(async () => {
    const [documents, items, jobs, redactions, receipts, workflow, storyPrivacy,
      releaseConfirmation, manifest] =
      await Promise.all([
        db.prepare("SELECT * FROM documents ORDER BY id").all(),
        db.prepare("SELECT * FROM items ORDER BY id").all(),
        db.prepare("SELECT * FROM redaction_jobs ORDER BY id").all(),
        db.prepare("SELECT * FROM redactions ORDER BY id").all(),
        db.prepare("SELECT * FROM source_privacy_receipts ORDER BY job_id").all(),
        db.prepare("SELECT * FROM workflow_runs ORDER BY id").all(),
        db.prepare("SELECT * FROM story_privacy_authorities ORDER BY workflow_run_id").all(),
        db.prepare("SELECT * FROM project_release_confirmations ORDER BY workflow_run_id").all(),
        db.prepare("SELECT * FROM finalized_corpus_manifests ORDER BY workflow_run_id").all(),
      ]);
    return {
      documents: documents.results,
      items: items.results,
      jobs: jobs.results,
      redactions: redactions.results,
      receipts: receipts.results,
      workflow: workflow.results,
      storyPrivacy: storyPrivacy.results,
      releaseConfirmation: releaseConfirmation.results,
      manifest: manifest.results,
    };
  });
}

async function withFreshDatabase(prefix, operation) {
  const stateDir = await mkdtemp(join(tmpdir(), prefix));
  const previousStateDir = process.env.OXYGEN_VIEWER_STATE_DIR;
  process.env.OXYGEN_VIEWER_STATE_DIR = stateDir;
  try {
    const [{ getLocalDatabase }, { establishWorkflowRun }, { computeSourceDigest },
      redactionRoute, decisionRoute, documentsRoute] = await Promise.all([
      import("../db/index.ts"),
      import("../lib/workflow-run-server.ts"),
      import("../lib/redaction-pass.mjs"),
      import("../app/api/redactions/route.ts"),
      import("../app/api/redactions/[id]/route.ts"),
      import("../app/api/documents/route.ts"),
    ]);
    const db = await getLocalDatabase();
    return await operation({
      db, establishWorkflowRun, computeSourceDigest,
      redactionRoute, decisionRoute, documentsRoute,
    });
  } finally {
    globalThis.__oxygenLocalSqlite?.database.close();
    delete globalThis.__oxygenLocalSqlite;
    if (previousStateDir === undefined) delete process.env.OXYGEN_VIEWER_STATE_DIR;
    else process.env.OXYGEN_VIEWER_STATE_DIR = previousStateDir;
    await rm(stateDir, { recursive: true, force: true });
  }
}

test("redaction replacement validates completely and commits once with real SQLite", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "oxygen-redaction-atomicity-"));
  const previousStateDir = process.env.OXYGEN_VIEWER_STATE_DIR;
  process.env.OXYGEN_VIEWER_STATE_DIR = stateDir;

  try {
    const [
      { getLocalDatabase },
      { establishWorkflowRun },
      { computeSourceDigest, redactionReleaseError },
      route,
      decisionRoute,
      { buildPackageFromDatabase },
      { capturePackageReleasePrivacySnapshot, validateReleaseSourcePrivacyReceipt },
    ] =
      await Promise.all([
        import("../db/index.ts"),
        import("../lib/workflow-run-server.ts"),
        import("../lib/redaction-pass.mjs"),
        import("../app/api/redactions/route.ts"),
        import("../app/api/redactions/[id]/route.ts"),
        import("../app/api/package/route.ts"),
        import("../lib/release-privacy-snapshot.ts"),
      ]);
    const db = await getLocalDatabase();
    await establishWorkflowRun(db, "workflow-redaction-atomicity", oldTime);
    await db.batch([
      db.prepare(`INSERT INTO documents
        (id,kind,title,source_system,item_count,metadata_json,original_envelope_json,
         imported_at,updated_at,formatted_summary_json)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
        "document-alpha", "trajectory", "Alpha", "local-agent-history", 1,
        "{}", "{}", oldTime, oldTime, "{}",
      ),
      db.prepare(`INSERT INTO documents
        (id,kind,title,source_system,item_count,metadata_json,original_envelope_json,
         imported_at,updated_at,formatted_summary_json)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
        "document-beta", "trajectory", "Beta", "local-agent-history", 1,
        "{}", "{}", oldTime, oldTime, "{}",
      ),
      db.prepare(`INSERT INTO items
        (id,document_id,sequence,event_type,actor_id,actor_type,timestamp,content,original_json)
        VALUES (?,?,?,?,?,?,?,?,?)`).bind(
        "item-alpha", "document-alpha", 1, "message", "actor-alpha", "assistant",
        oldTime, "alpha secret omega", "{}",
      ),
      db.prepare(`INSERT INTO items
        (id,document_id,sequence,event_type,actor_id,actor_type,timestamp,content,original_json)
        VALUES (?,?,?,?,?,?,?,?,?)`).bind(
        "item-beta", "document-beta", 1, "message", "actor-beta", "user",
        oldTime, "beta token", "{}",
      ),
    ]);
    const sourceRows = await db.prepare(
      `SELECT document_id,id,sequence,event_type,actor_type,timestamp,content
         FROM items ORDER BY document_id,sequence,id`,
    ).all();
    const sourceDigest = await computeSourceDigest(sourceRows.results);
    await db.batch([
      db.prepare(`INSERT INTO redactions
        (id,item_id,document_id,start_offset,end_offset,category,confidence,reason,
         review_state,uncertainty_reason,status,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        "prior-redaction", "item-alpha", "document-alpha", 0, 5,
        "private-personal", "low", "prior fresh-schema redaction",
        "deterministic", null, "active", "llm", oldTime, oldTime,
      ),
      db.prepare(`INSERT INTO redaction_jobs
        (id,status,stage,model,completed,total,rejected,source_digest,
         started_at,updated_at,completed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
        "prior-job", "complete", "done", "old-model", 1, 1, 0, sourceDigest,
        oldTime, oldTime, oldTime,
      ),
    ]);
    const sourceRevision = 3;
    const activeStoryDigest = "a".repeat(64);
    const activateStory = () => db.prepare(`UPDATE workflow_runs
      SET story_generation_status='ready_for_human_review',story_source_revision=?,
          active_story_digest=? WHERE id='workflow-redaction-atomicity'`)
      .bind(sourceRevision, activeStoryDigest).run();
    await activateStory();
    await seedFinalizedCorpusManifest(db, {
      workflowRunId: "workflow-redaction-atomicity",
      at: oldTime,
    });
    await seedReleaseConfirmation(db);
    const receiptFor = (redactions, revision = sourceRevision) => buildSourcePrivacyReceipt(db, {
      workflowRunId: "workflow-redaction-atomicity",
      sourceRevision: revision,
      redactions,
    });
    const baseReceipt = await receiptFor([span()]);

    const oldSnapshot = await privacySnapshot(db);
    const oldStoryAuthority = await storyAuthoritySnapshot(db);
    const oldReleaseConfirmation = await releaseConfirmationSnapshot(db);
    const originalBatch = db.batch.bind(db);
    let routeBatchCalls = 0;
    db.batch = async (statements) => {
      routeBatchCalls += 1;
      return originalBatch(statements);
    };

    const invalidCases = [
      ["unknown-only", payload([span({
        itemId: "https://private.invalid/RAW_PRIVACY_URL",
        reason: "RAW_PRIVACY_REASON",
      })], baseReceipt)],
      ["mixed valid and invalid", payload([
        span({ id: "valid-span" }),
        span({ id: "invalid-span", category: "invented-category" }),
      ], baseReceipt)],
      ["wrong document", payload([span({ documentId: "document-beta" })], baseReceipt)],
      ["stored-content length", payload([span({ endOffset: 99 })], baseReceipt)],
      ["overlap", payload([
        span({ id: "overlap-a", startOffset: 0, endOffset: 7 }),
        span({ id: "overlap-b", startOffset: 6, endOffset: 12 }),
      ], baseReceipt)],
      ["duplicate identity", payload([
        span({ id: "duplicate", startOffset: 0, endOffset: 5 }),
        span({
          id: "duplicate", itemId: "item-beta", documentId: "document-beta",
          startOffset: 0, endOffset: 4,
        }),
      ], baseReceipt)],
      ["reported rejection", payload([span()], baseReceipt, { job: { rejected: 1 } })],
      ["wrong total", payload([span()], baseReceipt, { job: { total: 2 } })],
      ["missing review state", payload([span({ reviewState: undefined })], baseReceipt)],
      ["unsupported review state", payload([span({ reviewState: "confirmed_keep" })], baseReceipt)],
      ["unsupported confidence", payload([span({ confidence: "bogus" })], baseReceipt)],
      ["deterministic uncertainty", payload([
        span({ uncertaintyReason: LOCAL_UNCERTAINTY_SENTINEL }),
      ], baseReceipt)],
      ["pending without uncertainty", payload([
        span({ reviewState: "needs_confirmation", uncertaintyReason: null }),
      ], baseReceipt)],
      ["pending blank uncertainty", payload([
        span({ reviewState: "needs_confirmation", uncertaintyReason: "   " }),
      ], baseReceipt)],
      ["additive bulk import", payload([span()], baseReceipt, { replaceAll: false })],
      ["missing replacement authority", payload([span()], baseReceipt, { replaceAll: undefined })],
      ["null member", payload([null], baseReceipt)],
      ["non-object member", payload(["not-a-redaction"], baseReceipt)],
    ];

    for (const [name, invalidPayload] of invalidCases) {
      const response = await post(route, invalidPayload);
      assert.equal(response.status, 400, name);
      const failure = await response.json();
      assert.equal(failure.imported ?? 0, 0, name);
      assert.match(failure.code, /^SOURCE_PRIVACY_(REQUEST|REPLACEMENT)_INVALID$/u, name);
      assert.doesNotMatch(JSON.stringify(failure),
        /RAW_PRIVACY_URL|RAW_PRIVACY_REASON|private\.invalid|sqlite|trace/iu, name);
      assert.deepEqual(await privacySnapshot(db), oldSnapshot, name);
      assert.deepEqual(await storyAuthoritySnapshot(db), oldStoryAuthority, name);
      assert.deepEqual(await releaseConfirmationSnapshot(db), oldReleaseConfirmation, name);
      assert.equal(routeBatchCalls, 0, `${name} must not start a write batch`);
    }

    const zeroRevisionReceipt = await resignReceipt({
      ...await receiptFor([]), sourceRevision: 0,
    });
    const zeroRevisionResponse = await post(route, payload([], zeroRevisionReceipt));
    assert.equal(zeroRevisionResponse.status, 400);
    assert.equal((await zeroRevisionResponse.json()).code, "SOURCE_PRIVACY_REQUEST_INVALID");
    assert.deepEqual(await privacySnapshot(db), oldSnapshot);
    assert.equal(routeBatchCalls, 0, "revision zero must fail before a write batch");

    const tamperedRedactionReceipt = await resignReceipt({
      ...baseReceipt,
      redactions: { ...baseReceipt.redactions, digest: "0".repeat(64) },
    });
    const tamperedReceiptResponse = await post(
      route,
      payload([span()], tamperedRedactionReceipt),
    );
    assert.equal(tamperedReceiptResponse.status, 400);
    assert.equal((await tamperedReceiptResponse.json()).code,
      "SOURCE_PRIVACY_REPLACEMENT_INVALID");
    assert.deepEqual(await privacySnapshot(db), oldSnapshot);
    assert.equal(routeBatchCalls, 0, "tampered receipt must fail before a write batch");

    const missingBundleDialogue = {
      ...baseReceipt.dialogue,
      bundleCount: 1,
      turnCount: baseReceipt.dialogue.bundles[0].turns.length,
      bundles: [baseReceipt.dialogue.bundles[0]],
    };
    missingBundleDialogue.digest = await sourcePrivacyDigest(missingBundleDialogue.bundles);
    const missingBundleReceipt = await resignReceipt({
      ...baseReceipt,
      dialogue: missingBundleDialogue,
    });
    const missingBundleResponse = await post(route, payload([span()], missingBundleReceipt));
    assert.equal(missingBundleResponse.status, 409);
    assert.equal((await missingBundleResponse.json()).code, "SOURCE_PRIVACY_MUTATION_CONFLICT");
    assert.deepEqual(await privacySnapshot(db), oldSnapshot);
    assert.equal(routeBatchCalls, 0, "incomplete reviewed set must not start a write batch");

    await db.prepare("UPDATE items SET content='alpha public omega' WHERE id='item-alpha'").run();
    const equalLengthSourceSnapshot = await privacySnapshot(db);
    const equalLengthResponse = await post(route, payload([span()], baseReceipt));
    assert.equal(equalLengthResponse.status, 409);
    assert.equal((await equalLengthResponse.json()).code, "SOURCE_PRIVACY_MUTATION_CONFLICT");
    assert.deepEqual(await privacySnapshot(db), equalLengthSourceSnapshot);
    assert.equal(routeBatchCalls, 0, "equal-length source mutation must not start a write batch");
    await db.prepare("UPDATE items SET content='alpha secret omega' WHERE id='item-alpha'").run();

    const malformed = await route.POST(new Request("http://localhost/api/redactions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: '{"private":"RAW_PRIVACY_BODY"',
    }));
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), {
      error: "A valid source Privacy replacement is required",
      code: "SOURCE_PRIVACY_REQUEST_INVALID",
    });
    assert.deepEqual(await privacySnapshot(db), oldSnapshot);
    assert.deepEqual(await storyAuthoritySnapshot(db), oldStoryAuthority);
    assert.deepEqual(await releaseConfirmationSnapshot(db), oldReleaseConfirmation);

    await originalBatch([
      db.prepare(`CREATE TRIGGER fail_atomic_redaction BEFORE INSERT ON redactions
        WHEN NEW.id='force-sql-failure'
        BEGIN SELECT RAISE(ABORT, 'forced redaction failure'); END`),
    ]);
    const failedSqlRedactions = [span({ id: "force-sql-failure" })];
    const failedSql = await post(route, payload(
      failedSqlRedactions,
      await receiptFor(failedSqlRedactions),
    ));
    assert.equal(failedSql.status, 409);
    const failedSqlBody = await failedSql.json();
    assert.deepEqual(failedSqlBody, {
      error: "Source Privacy replacement conflicted",
      code: "SOURCE_PRIVACY_MUTATION_CONFLICT",
      imported: 0,
    });
    assert.doesNotMatch(JSON.stringify(failedSqlBody), /forced|sqlite|trigger|trace/iu);
    assert.deepEqual(await privacySnapshot(db), oldSnapshot);
    assert.deepEqual(await storyAuthoritySnapshot(db), oldStoryAuthority);
    assert.deepEqual(await releaseConfirmationSnapshot(db), oldReleaseConfirmation,
      "failed Privacy SQL preserves release confirmation");
    assert.equal(routeBatchCalls, 1, "failed replacement uses one rolled-back batch");

    const validRedactions = [
      span({ id: "replacement-alpha", confidence: "low" }),
      span({
        id: "replacement-keep", itemId: "item-beta", documentId: "document-beta",
        startOffset: 0, endOffset: 4, category: "credential", confidence: "high",
        reviewState: "needs_confirmation", uncertaintyReason: LOCAL_UNCERTAINTY_SENTINEL,
      }),
      span({
        id: "replacement-redact", startOffset: 13, endOffset: 18,
        confidence: "low", reviewState: "needs_confirmation",
        uncertaintyReason: LOCAL_UNCERTAINTY_SENTINEL,
      }),
    ];
    const validReceipt = await receiptFor(validRedactions);
    await originalBatch([
      db.prepare(`CREATE TRIGGER fail_release_confirmation_invalidation
        BEFORE DELETE ON project_release_confirmations
        BEGIN SELECT RAISE(ABORT, 'RAW_SQLITE_PATH_D:/private/oxygen.sqlite'); END`),
    ]);
    const failedInvalidation = await post(route, payload(validRedactions, validReceipt));
    assert.equal(failedInvalidation.status, 409);
    const failedInvalidationBody = await failedInvalidation.json();
    assert.equal(failedInvalidationBody.code, "SOURCE_PRIVACY_MUTATION_CONFLICT");
    assert.doesNotMatch(JSON.stringify(failedInvalidationBody),
      /RAW_SQLITE_PATH|private|oxygen\.sqlite|trace/iu);
    assert.deepEqual(await privacySnapshot(db), oldSnapshot,
      "failed release-confirmation invalidation rolls back the complete valid Privacy replacement");
    assert.deepEqual(await storyAuthoritySnapshot(db), oldStoryAuthority);
    assert.deepEqual(await releaseConfirmationSnapshot(db), oldReleaseConfirmation);
    await originalBatch([db.prepare("DROP TRIGGER fail_release_confirmation_invalidation")]);
    const response = await post(route, payload(validRedactions, validReceipt));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      imported: 3,
      rejected: [],
      status: "complete",
    });
    assert.equal(routeBatchCalls, 3, "each replacement attempt uses exactly one batch");
    assert.deepEqual(await storyAuthoritySnapshot(db), {
      story_generation_status: "blocked",
      story_source_revision: sourceRevision,
      active_story_digest: null,
    });
    assert.deepEqual(await releaseConfirmationSnapshot(db), [],
      "POST replacement retires final release confirmation atomically");

    const replacement = await privacySnapshot(db);
    assert.equal(replacement.jobs.length, 1);
    assert.deepEqual({
      status: replacement.jobs[0].status,
      stage: replacement.jobs[0].stage,
      model: replacement.jobs[0].model,
      completed: replacement.jobs[0].completed,
      total: replacement.jobs[0].total,
      rejected: replacement.jobs[0].rejected,
      source_digest: replacement.jobs[0].source_digest,
      completed_at: replacement.jobs[0].completed_at,
    }, {
      status: "complete",
      stage: "done",
      model: "fixture-model",
      completed: 3,
      total: 3,
      rejected: 0,
      source_digest: sourceDigest,
      completed_at: replacement.jobs[0].updated_at,
    });
    assert.deepEqual(replacement.redactions.map((row) => ({
      id: row.id,
      item_id: row.item_id,
      document_id: row.document_id,
      start_offset: row.start_offset,
      end_offset: row.end_offset,
      category: row.category,
      confidence: row.confidence,
      review_state: row.review_state,
      uncertainty_reason: row.uncertainty_reason,
      status: row.status,
    })), [
      {
        id: "replacement-alpha", item_id: "item-alpha", document_id: "document-alpha",
        start_offset: 6, end_offset: 12, category: "sensitive", confidence: "low",
        review_state: "deterministic", uncertainty_reason: null, status: "active",
      },
      {
        id: "replacement-keep", item_id: "item-beta", document_id: "document-beta",
        start_offset: 0, end_offset: 4, category: "credential", confidence: "high",
        review_state: "needs_confirmation",
        uncertainty_reason: LOCAL_UNCERTAINTY_SENTINEL, status: "active",
      },
      {
        id: "replacement-redact", item_id: "item-alpha", document_id: "document-alpha",
        start_offset: 13, end_offset: 18, category: "sensitive", confidence: "low",
        review_state: "needs_confirmation",
        uncertainty_reason: LOCAL_UNCERTAINTY_SENTINEL, status: "active",
      },
    ]);

    const blockedPackage = await buildPackageFromDatabase(db, undefined, undefined, {
      exportedAt: oldTime,
    });
    assert.equal(blockedPackage.status, 400);
    assert.match(await blockedPackage.text(), /Invalid reviewed Story release request/);

    const beforeDelete = await privacySnapshot(db);
    const rejectedDelete = await decisionRoute.DELETE();
    assert.equal(rejectedDelete.status, 405);
    assert.deepEqual(await privacySnapshot(db), beforeDelete, "obsolete DELETE cannot mutate review state");
    const beforeRejectedDecisions = await privacySnapshot(db);
    await activateStory();
    await seedReleaseConfirmation(db);
    const beforeRejectedAuthority = await storyAuthoritySnapshot(db);
    const beforeRejectedReleaseConfirmation = await releaseConfirmationSnapshot(db);
    for (const body of [
      { status: "removed" },
      { review_state: "confirmed_keep" },
      { reviewState: "confirmed_keep" },
      { category: "credential" },
      { decision: "keep", status: "removed" },
      {},
    ]) {
      const rejectedDecision = await decide(decisionRoute, "replacement-keep", body);
      assert.equal(rejectedDecision.status, 400, JSON.stringify(body));
      assert.equal((await rejectedDecision.json()).code, "SOURCE_PRIVACY_DECISION_INVALID");
      assert.deepEqual(await privacySnapshot(db), beforeRejectedDecisions);
      assert.deepEqual(await storyAuthoritySnapshot(db), beforeRejectedAuthority);
      assert.deepEqual(await releaseConfirmationSnapshot(db), beforeRejectedReleaseConfirmation);
    }
    const malformedDecision = await decisionRoute.PATCH(new Request(
      "http://localhost/api/redactions/replacement-keep",
      { method: "PATCH", body: '{"decision":"RAW_PRIVACY_DECISION"' },
    ), { params: Promise.resolve({ id: "replacement-keep" }) });
    assert.equal(malformedDecision.status, 400);
    assert.equal((await malformedDecision.json()).code, "SOURCE_PRIVACY_DECISION_INVALID");
    assert.deepEqual(await storyAuthoritySnapshot(db), beforeRejectedAuthority);
    assert.deepEqual(await releaseConfirmationSnapshot(db), beforeRejectedReleaseConfirmation);
    const deterministicDecision = await decide(decisionRoute, "replacement-alpha", {
      decision: "keep",
    });
    assert.equal(deterministicDecision.status, 409);
    assert.equal((await deterministicDecision.json()).code,
      "SOURCE_PRIVACY_DECISION_NOT_ACTIONABLE");
    assert.deepEqual(await privacySnapshot(db), beforeRejectedDecisions);
    assert.deepEqual(await storyAuthoritySnapshot(db), beforeRejectedAuthority);
    assert.deepEqual(await releaseConfirmationSnapshot(db), beforeRejectedReleaseConfirmation);

    await originalBatch([
      db.prepare(`CREATE TRIGGER fail_release_confirmation_decision_invalidation
        BEFORE DELETE ON project_release_confirmations
        BEGIN SELECT RAISE(ABORT, 'RAW_PRIVACY_TRACE_SQLITE_PATH'); END`),
    ]);
    const failedDecision = await decide(decisionRoute, "replacement-keep", { decision: "keep" });
    assert.equal(failedDecision.status, 409);
    const failedDecisionBody = await failedDecision.json();
    assert.equal(failedDecisionBody.code, "SOURCE_PRIVACY_MUTATION_CONFLICT");
    assert.doesNotMatch(JSON.stringify(failedDecisionBody), /RAW_PRIVACY_TRACE|sqlite|path/iu);
    assert.deepEqual(await privacySnapshot(db), beforeRejectedDecisions,
      "failed release-confirmation invalidation rolls back the contributor Privacy decision");
    assert.deepEqual(await storyAuthoritySnapshot(db), beforeRejectedAuthority);
    assert.deepEqual(await releaseConfirmationSnapshot(db), beforeRejectedReleaseConfirmation);
    await originalBatch([db.prepare("DROP TRIGGER fail_release_confirmation_decision_invalidation")]);

    await db.prepare("UPDATE redaction_jobs SET completed=2,total=2").run();
    const countPairPrivacyBefore = await privacySnapshot(db);
    const countPairAuthorityBefore = await storyAuthoritySnapshot(db);
    const countPairConfirmationBefore = await releaseConfirmationSnapshot(db);
    const countPairSnapshot = await capturePackageReleasePrivacySnapshot(db);
    assert.equal(await validateReleaseSourcePrivacyReceipt(
      countPairSnapshot,
      "workflow-redaction-atomicity",
      sourceRevision,
      sourceDigest,
    ), false, "release receipt rejects a self-consistent but false job count pair");
    assert.match(redactionReleaseError(
      countPairSnapshot.redactionJob,
      sourceDigest,
      countPairSnapshot.redactionReviewRows,
      sourceRevision,
    ), /counts do not match/);
    const countPairPackage = await buildPackageFromDatabase(db, undefined, undefined, {
      exportedAt: oldTime,
    });
    assert.equal(countPairPackage.status, 400,
      "package release fails closed when job counts do not equal persisted redactions");
    const countPairDecision = await decide(decisionRoute, "replacement-keep", { decision: "keep" });
    assert.equal(countPairDecision.status, 409);
    assert.equal((await countPairDecision.json()).code, "SOURCE_PRIVACY_MUTATION_CONFLICT");
    assert.deepEqual(await privacySnapshot(db), countPairPrivacyBefore);
    assert.deepEqual(await storyAuthoritySnapshot(db), countPairAuthorityBefore);
    assert.deepEqual(await releaseConfirmationSnapshot(db), countPairConfirmationBefore);
    await db.prepare("UPDATE redaction_jobs SET completed=3,total=3").run();

    const beforeKeepDigest = (await capturePackageReleasePrivacySnapshot(db)).digest;
    const keepResponse = await decide(decisionRoute, "replacement-keep", { decision: "keep" });
    assert.equal(keepResponse.status, 200);
    assert.deepEqual((({ review_state, status, created_by }) => ({
      review_state, status, created_by,
    }))(await keepResponse.json()), {
      review_state: "confirmed_keep",
      status: "removed",
      created_by: "contributor",
    });
    assert.deepEqual(await storyAuthoritySnapshot(db), {
      story_generation_status: "blocked",
      story_source_revision: sourceRevision,
      active_story_digest: null,
    });
    assert.deepEqual(await releaseConfirmationSnapshot(db), [],
      "PATCH keep retires final release confirmation atomically");
    const afterKeepDigest = (await capturePackageReleasePrivacySnapshot(db)).digest;
    assert.notEqual(afterKeepDigest, beforeKeepDigest, "a review decision changes the snapshot digest");

    await activateStory();
    await seedReleaseConfirmation(db);
    const redactResponse = await decide(decisionRoute, "replacement-redact", {
      decision: "redact",
    });
    assert.equal(redactResponse.status, 200);
    assert.deepEqual((({ review_state, status, created_by }) => ({
      review_state, status, created_by,
    }))(await redactResponse.json()), {
      review_state: "confirmed_redact",
      status: "active",
      created_by: "contributor",
    });
    assert.deepEqual(await storyAuthoritySnapshot(db), {
      story_generation_status: "blocked",
      story_source_revision: sourceRevision,
      active_story_digest: null,
    });
    assert.deepEqual(await releaseConfirmationSnapshot(db), [],
      "PATCH redact retires final release confirmation atomically");

    const readResponse = await route.GET();
    assert.equal(readResponse.status, 200);
    const readState = await readResponse.json();
    assert.deepEqual(readState.redactions.map((row) => [row.id, row.review_state, row.status]), [
      ["replacement-alpha", "deterministic", "active"],
      ["replacement-redact", "confirmed_redact", "active"],
      ["replacement-keep", "confirmed_keep", "removed"],
    ]);

    const releasedPackage = await buildPackageFromDatabase(db, undefined, undefined, {
      exportedAt: oldTime,
    });
    assert.equal(releasedPackage.status, 400,
      "resolved source redactions cannot bypass final Story and release-confirmation authority");

    await activateStory();
    await seedReleaseConfirmation(db);
    const zeroReceipt = await receiptFor([]);
    const zeroResponse = await post(route, payload([], zeroReceipt));
    assert.equal(zeroResponse.status, 200);
    assert.deepEqual(await zeroResponse.json(), { imported: 0, rejected: [], status: "complete" });
    const completedZero = await privacySnapshot(db);
    assert.equal(completedZero.jobs.length, 1);
    assert.deepEqual({
      status: completedZero.jobs[0].status,
      completed: completedZero.jobs[0].completed,
      total: completedZero.jobs[0].total,
      rejected: completedZero.jobs[0].rejected,
    }, { status: "complete", completed: 0, total: 0, rejected: 0 });
    assert.deepEqual(completedZero.redactions, []);
    assert.equal(completedZero.receipts.length, 1);
    assert.equal(completedZero.receipts[0].job_id, completedZero.jobs[0].id);
    assert.equal(completedZero.receipts[0].workflow_run_id, "workflow-redaction-atomicity");
    assert.equal(completedZero.receipts[0].source_revision, sourceRevision);
    assert.equal(completedZero.receipts[0].source_digest, zeroReceipt.sourceDigest);
    assert.equal(completedZero.receipts[0].receipt_digest, zeroReceipt.receiptDigest);
    assert.equal(completedZero.receipts[0].receipt_json,
      canonicalSourcePrivacyJson(zeroReceipt));
    assert.deepEqual(await storyAuthoritySnapshot(db), {
      story_generation_status: "blocked",
      story_source_revision: sourceRevision,
      active_story_digest: null,
    });
    assert.deepEqual(await releaseConfirmationSnapshot(db), [],
      "completed-zero POST retires final release confirmation atomically");
  } finally {
    globalThis.__oxygenLocalSqlite?.database.close();
    delete globalThis.__oxygenLocalSqlite;
    if (previousStateDir === undefined) delete process.env.OXYGEN_VIEWER_STATE_DIR;
    else process.env.OXYGEN_VIEWER_STATE_DIR = previousStateDir;
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("source-first publication makes a stale bulk Privacy replacement lose without mutation", async () => {
  await withFreshDatabase("oxygen-redaction-source-first-", async ({
    db, establishWorkflowRun, computeSourceDigest, redactionRoute, documentsRoute,
  }) => {
    await seedConcurrentPrivacyState(db, establishWorkflowRun, computeSourceDigest);
    const staleRedactions = [span({
      id: "race-candidate", itemId: "item-old", documentId: "document-old",
      startOffset: 4, endOffset: 11, reviewState: "needs_confirmation",
      uncertaintyReason: LOCAL_UNCERTAINTY_SENTINEL,
    })];
    const staleReceipt = await buildSourcePrivacyReceipt(db, {
      workflowRunId: "workflow-redaction-atomicity",
      sourceRevision: 7,
      redactions: staleRedactions,
    });
    const sourceResponse = await postDocuments(documentsRoute, [
      corpusEntry("document-new", "item-new", "new public source"),
    ]);
    assert.equal(sourceResponse.status, 200);
    const afterSource = await completeAuthoritySnapshot(db);
    const response = await post(redactionRoute, payload(staleRedactions, staleReceipt));
    assert.equal(response.status, 409);
    const failure = await response.json();
    assert.deepEqual(failure, {
      error: "Source Privacy replacement conflicted",
      code: "SOURCE_PRIVACY_MUTATION_CONFLICT",
      imported: 0,
    });
    assert.doesNotMatch(JSON.stringify(failure),
      /LOCAL_REASON|LOCAL_UNCERTAINTY|document|item|sqlite|path|trace/iu);
    assert.deepEqual(await completeAuthoritySnapshot(db), afterSource,
      "the rejected replacement must preserve the exact source-first committed state");
    assert.deepEqual(afterSource.jobs.map(({ status, stage, completed_at }) => ({
      status, stage, completed_at,
    })), [{ status: "stale", stage: "source_changed", completed_at: null }]);
    assert.deepEqual(afterSource.redactions.map((row) => row.id), ["race-candidate"]);
    assert.equal(afterSource.workflow[0].story_source_revision, 8);
    assert.equal(afterSource.workflow[0].active_story_digest, null);
    assert.notEqual(afterSource.workflow[0].story_generation_status, "ready_for_human_review");
  });
});

test("Privacy-first replacement linearizes before source publication and unrelated writes do not conflict", async () => {
  await withFreshDatabase("oxygen-redaction-privacy-first-", async ({
    db, establishWorkflowRun, computeSourceDigest, redactionRoute, documentsRoute,
  }) => {
    const seeded = await seedConcurrentPrivacyState(db, establishWorkflowRun, computeSourceDigest);
    const currentRedactions = [span({
      id: "privacy-first", itemId: "item-old", documentId: "document-old",
      startOffset: 4, endOffset: 11,
    })];
    const currentReceipt = await buildSourcePrivacyReceipt(db, {
      workflowRunId: "workflow-redaction-atomicity",
      sourceRevision: seeded.sourceRevision,
      redactions: currentRedactions,
    });
    const privacyResponse = await post(redactionRoute, payload(currentRedactions, currentReceipt));
    assert.equal(privacyResponse.status, 200);
    assert.equal((await privacyResponse.json()).imported, 1);
    await db.prepare(`INSERT INTO organization_jobs
      (id,status,stage,started_at,updated_at) VALUES (?,?,?,?,?)`)
      .bind("unrelated-write", "complete", "done", oldTime, oldTime).run();
    await db.prepare(`INSERT INTO probe_runs
      (workflow_run_id,id,source_revision,input_digest,output_digest,output_count,status,stage,
       generated,set_aside,auto_removed_json,started_at,updated_at,completed_at)
      VALUES (?,?,?,?,?,0,'complete','preference',0,0,'{}',?,?,?)`)
      .bind("unrelated-probe-run", "unrelated-probe-run", 1,
        "b".repeat(64), "c".repeat(64), oldTime, oldTime, oldTime).run();
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM organization_jobs").first()).count, 1);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM probe_runs WHERE workflow_run_id=?")
      .bind("unrelated-probe-run").first()).count, 1);
    const completed = await privacySnapshot(db);
    assert.equal(completed.jobs[0].status, "complete");
    assert.equal(completed.jobs[0].source_digest, seeded.sourceDigest);

    const sourceResponse = await postDocuments(documentsRoute, [
      corpusEntry("document-after-privacy", "item-after-privacy", "later source generation"),
    ]);
    assert.equal(sourceResponse.status, 200);
    const afterSource = await completeAuthoritySnapshot(db);
    assert.equal(afterSource.jobs[0].status, "stale");
    assert.equal(afterSource.jobs[0].stage, "source_changed");
    assert.equal(afterSource.workflow[0].story_source_revision, seeded.sourceRevision + 1);
    assert.equal(afterSource.workflow[0].active_story_digest, null);
    assert.notEqual(afterSource.workflow[0].story_generation_status, "ready_for_human_review");
  });
});

test("PATCH loses stale-source and same-id replacement races with exact CAS", async () => {
  for (const race of ["source", "same-id"]) {
    await withFreshDatabase(`oxygen-redaction-patch-${race}-`, async ({
      db, establishWorkflowRun, computeSourceDigest,
      redactionRoute, decisionRoute, documentsRoute,
    }) => {
      await seedConcurrentPrivacyState(db, establishWorkflowRun, computeSourceDigest);
      const snapshotRead = deferred();
      const releaseDecision = deferred();
      const realTransaction = db.transaction.bind(db);
      let interceptSnapshot = true;
      db.transaction = async (operation) => {
        const result = await realTransaction(operation);
        if (interceptSnapshot) {
          interceptSnapshot = false;
          snapshotRead.resolve();
          await releaseDecision.promise;
        }
        return result;
      };
      const pendingDecision = decide(decisionRoute, "race-candidate", { decision: "keep" });
      await Promise.race([
        snapshotRead.promise,
        pendingDecision.then(() => assert.fail(`PATCH completed before ${race} barrier`)),
      ]);
      if (race === "source") {
        const sourceResponse = await postDocuments(documentsRoute, [
          corpusEntry("document-patch-new", "item-patch-new", "new PATCH source"),
        ]);
        assert.equal(sourceResponse.status, 200);
      } else {
        const replacementRedactions = [span({
          id: "race-candidate", itemId: "item-old", documentId: "document-old",
          startOffset: 0, endOffset: 3, category: "credential",
          reviewState: "needs_confirmation", uncertaintyReason: "replacement uncertainty",
        })];
        const replacementReceipt = await buildSourcePrivacyReceipt(db, {
          workflowRunId: "workflow-redaction-atomicity",
          sourceRevision: 7,
          redactions: replacementRedactions,
        });
        const replacement = await post(
          redactionRoute,
          payload(replacementRedactions, replacementReceipt),
        );
        assert.equal(replacement.status, 200);
      }
      db.transaction = realTransaction;
      const afterConcurrentMutation = await completeAuthoritySnapshot(db);
      releaseDecision.resolve();
      const decisionResponse = await pendingDecision;
      assert.equal(decisionResponse.status, 409, race);
      const failure = await decisionResponse.json();
      assert.deepEqual(failure, {
        error: "Source Privacy decision conflicted",
        code: "SOURCE_PRIVACY_MUTATION_CONFLICT",
      });
      assert.doesNotMatch(JSON.stringify(failure),
        /LOCAL_REASON|LOCAL_UNCERTAINTY|replacement uncertainty|document|item|sqlite|path|trace/iu);
      assert.deepEqual(await completeAuthoritySnapshot(db), afterConcurrentMutation,
        `${race} race must leave the winning generation byte-for-byte unchanged`);
    });
  }
});

test("24,796-item explicit replacement stays bounded while passive polling avoids source scans", async (t) => {
  await withFreshDatabase("oxygen-redaction-scale-", async ({
    db, establishWorkflowRun, computeSourceDigest, redactionRoute,
  }) => {
    const itemCount = 24_796;
    await establishWorkflowRun(db, "workflow-redaction-atomicity", oldTime);
    await db.prepare(`INSERT INTO documents
      (id,kind,title,source_system,item_count,metadata_json,original_envelope_json,
       imported_at,updated_at,formatted_summary_json) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .bind("document-scale", "trajectory", "Scale source", "fixture", itemCount,
        "{}", "{}", oldTime, oldTime, "{}").run();
    const items = Array.from({ length: itemCount }, (_, index) => ({
      id: `scale-item-${String(index).padStart(5, "0")}`,
      documentId: "document-scale",
      sequence: index + 1,
      eventType: "message",
      actorId: "fixture-actor",
      actorType: index % 2 === 0 ? "assistant" : "user",
      timestamp: oldTime,
      content: `public scale content ${String(index).padStart(5, "0")}`,
      originalJson: "{}",
    }));
    await db.prepare(`INSERT INTO items
      (id,document_id,sequence,event_type,actor_id,actor_type,timestamp,content,original_json)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.documentId'),
        json_extract(value,'$.sequence'),json_extract(value,'$.eventType'),
        json_extract(value,'$.actorId'),json_extract(value,'$.actorType'),
        json_extract(value,'$.timestamp'),json_extract(value,'$.content'),
        json_extract(value,'$.originalJson') FROM json_each(?)`)
      .bind(JSON.stringify(items)).run();
    await db.prepare(`UPDATE workflow_runs SET story_source_revision=1,
      story_generation_status='ready_for_human_review' WHERE id=?`)
      .bind("workflow-redaction-atomicity").run();
    await seedFinalizedCorpusManifest(db, {
      workflowRunId: "workflow-redaction-atomicity",
      at: oldTime,
    });
    const scaleRedactions = [span({
      id: "scale-redaction", itemId: "scale-item-00000", documentId: "document-scale",
      startOffset: 0, endOffset: 6,
    })];
    const scaleReceipt = await buildSourcePrivacyReceipt(db, {
      workflowRunId: "workflow-redaction-atomicity",
      sourceRevision: 1,
      redactions: scaleRedactions,
    });
    const started = performance.now();
    const response = await post(redactionRoute, payload(scaleRedactions, scaleReceipt));
    const elapsedMs = performance.now() - started;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { imported: 1, rejected: [], status: "complete" });
    const stored = await privacySnapshot(db);
    assert.equal(stored.jobs[0].status, "complete");
    assert.equal(stored.jobs[0].completed, 1);
    const sourceRows = await db.prepare(
      `SELECT document_id,id,sequence,event_type,actor_type,timestamp,content
         FROM items ORDER BY document_id,sequence,id`,
    ).all();
    assert.equal(sourceRows.results.length, itemCount);
    assert.equal(stored.jobs[0].source_digest, await computeSourceDigest(sourceRows.results));

    const observedSql = [];
    const realPrepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      observedSql.push(sql);
      return realPrepare(sql);
    };
    const polling = await redactionRoute.GET();
    db.prepare = realPrepare;
    assert.equal(polling.status, 200);
    assert.equal(observedSql.some((sql) => /\bFROM items\b/iu.test(sql)), false,
      "passive source Privacy polling must not scan the source corpus");
    t.diagnostic(`24,796-item replacement elapsed ${elapsedMs.toFixed(1)} ms`);
  });
});

test("fresh SQLite requires an explicit redaction review state with no default", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "oxygen-redaction-fresh-schema-"));
  const previousStateDir = process.env.OXYGEN_VIEWER_STATE_DIR;
  process.env.OXYGEN_VIEWER_STATE_DIR = stateDir;

  try {
    const { getLocalDatabase } = await import("../db/index.ts");
    const db = await getLocalDatabase();
    const columns = await db.prepare("PRAGMA table_info(redactions)").all();
    const reviewState = columns.results.find((column) => column.name === "review_state");
    assert.deepEqual({
      notnull: reviewState.notnull,
      defaultValue: reviewState.dflt_value,
    }, { notnull: 1, defaultValue: null });
    await assert.rejects(
      db.prepare(`INSERT INTO redactions
        (id,item_id,document_id,start_offset,end_offset,category,status,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
        "missing-state", "item", "document", 0, 1, "sensitive", "active", "llm", oldTime, oldTime,
      ).run(),
      /NOT NULL constraint failed: redactions\.review_state/,
    );
    await db.prepare(`INSERT INTO redactions
      (id,item_id,document_id,start_offset,end_offset,category,review_state,
       status,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
      "explicit-state", "item", "document", 0, 1, "sensitive", "deterministic",
      "active", "llm", oldTime, oldTime,
    ).run();
    assert.equal((await db.prepare(
      "SELECT review_state FROM redactions WHERE id='explicit-state'",
    ).first()).review_state, "deterministic");
  } finally {
    globalThis.__oxygenLocalSqlite?.database.close();
    delete globalThis.__oxygenLocalSqlite;
    if (previousStateDir === undefined) delete process.env.OXYGEN_VIEWER_STATE_DIR;
    else process.env.OXYGEN_VIEWER_STATE_DIR = previousStateDir;
    await rm(stateDir, { recursive: true, force: true });
  }
});
