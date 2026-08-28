import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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

function payload(redactions, overrides = {}) {
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
    ...rest,
  };
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
  const [jobs, redactions] = await Promise.all([
    db.prepare("SELECT * FROM redaction_jobs ORDER BY id").all(),
    db.prepare("SELECT * FROM redactions ORDER BY id").all(),
  ]);
  return { jobs: jobs.results, redactions: redactions.results };
}

async function storyAuthoritySnapshot(db) {
  return db.prepare(`SELECT story_generation_status,story_source_revision,
    active_story_digest FROM workflow_runs WHERE id='workflow-redaction-atomicity'`).first();
}

test("redaction replacement validates completely and commits once with real SQLite", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "oxygen-redaction-atomicity-"));
  const previousStateDir = process.env.OXYGEN_VIEWER_STATE_DIR;
  process.env.OXYGEN_VIEWER_STATE_DIR = stateDir;

  try {
    const [
      { getLocalDatabase },
      { establishWorkflowRun },
      { computeSourceDigest },
      route,
      decisionRoute,
      { buildPackageFromDatabase },
      { capturePackageReleasePrivacySnapshot },
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

    const oldSnapshot = await privacySnapshot(db);
    const oldStoryAuthority = await storyAuthoritySnapshot(db);
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
      })])],
      ["mixed valid and invalid", payload([
        span({ id: "valid-span" }),
        span({ id: "invalid-span", category: "invented-category" }),
      ])],
      ["wrong document", payload([span({ documentId: "document-beta" })])],
      ["stored-content length", payload([span({ endOffset: 99 })])],
      ["overlap", payload([
        span({ id: "overlap-a", startOffset: 0, endOffset: 7 }),
        span({ id: "overlap-b", startOffset: 6, endOffset: 12 }),
      ])],
      ["duplicate identity", payload([
        span({ id: "duplicate", startOffset: 0, endOffset: 5 }),
        span({
          id: "duplicate", itemId: "item-beta", documentId: "document-beta",
          startOffset: 0, endOffset: 4,
        }),
      ])],
      ["reported rejection", payload([span()], { job: { rejected: 1 } })],
      ["wrong total", payload([span()], { job: { total: 2 } })],
      ["missing review state", payload([span({ reviewState: undefined })])],
      ["unsupported review state", payload([span({ reviewState: "confirmed_keep" })])],
      ["deterministic uncertainty", payload([
        span({ uncertaintyReason: LOCAL_UNCERTAINTY_SENTINEL }),
      ])],
      ["pending without uncertainty", payload([
        span({ reviewState: "needs_confirmation", uncertaintyReason: null }),
      ])],
      ["pending blank uncertainty", payload([
        span({ reviewState: "needs_confirmation", uncertaintyReason: "   " }),
      ])],
      ["additive bulk import", payload([span()], { replaceAll: false })],
      ["missing replacement authority", payload([span()], { replaceAll: undefined })],
      ["null member", payload([null])],
      ["non-object member", payload(["not-a-redaction"])],
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
      assert.equal(routeBatchCalls, 0, `${name} must not start a write batch`);
    }

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

    await originalBatch([
      db.prepare(`CREATE TRIGGER fail_atomic_redaction BEFORE INSERT ON redactions
        WHEN NEW.id='force-sql-failure'
        BEGIN SELECT RAISE(ABORT, 'forced redaction failure'); END`),
    ]);
    const failedSql = await post(route, payload([span({ id: "force-sql-failure" })]));
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
    await originalBatch([
      db.prepare(`CREATE TRIGGER fail_story_privacy_invalidation
        BEFORE UPDATE OF story_generation_status ON workflow_runs
        WHEN OLD.story_generation_status='ready_for_human_review'
        BEGIN SELECT RAISE(ABORT, 'RAW_SQLITE_PATH_D:/private/oxygen.sqlite'); END`),
    ]);
    const failedInvalidation = await post(route, payload(validRedactions));
    assert.equal(failedInvalidation.status, 409);
    const failedInvalidationBody = await failedInvalidation.json();
    assert.equal(failedInvalidationBody.code, "SOURCE_PRIVACY_MUTATION_CONFLICT");
    assert.doesNotMatch(JSON.stringify(failedInvalidationBody),
      /RAW_SQLITE_PATH|private|oxygen\.sqlite|trace/iu);
    assert.deepEqual(await privacySnapshot(db), oldSnapshot,
      "failed Story invalidation rolls back the complete valid Privacy replacement");
    assert.deepEqual(await storyAuthoritySnapshot(db), oldStoryAuthority);
    await originalBatch([db.prepare("DROP TRIGGER fail_story_privacy_invalidation")]);
    const response = await post(route, payload(validRedactions));
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
    const beforeRejectedAuthority = await storyAuthoritySnapshot(db);
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
    }
    const malformedDecision = await decisionRoute.PATCH(new Request(
      "http://localhost/api/redactions/replacement-keep",
      { method: "PATCH", body: '{"decision":"RAW_PRIVACY_DECISION"' },
    ), { params: Promise.resolve({ id: "replacement-keep" }) });
    assert.equal(malformedDecision.status, 400);
    assert.equal((await malformedDecision.json()).code, "SOURCE_PRIVACY_DECISION_INVALID");
    assert.deepEqual(await storyAuthoritySnapshot(db), beforeRejectedAuthority);
    const deterministicDecision = await decide(decisionRoute, "replacement-alpha", {
      decision: "keep",
    });
    assert.equal(deterministicDecision.status, 409);
    assert.equal((await deterministicDecision.json()).code,
      "SOURCE_PRIVACY_DECISION_NOT_ACTIONABLE");
    assert.deepEqual(await privacySnapshot(db), beforeRejectedDecisions);
    assert.deepEqual(await storyAuthoritySnapshot(db), beforeRejectedAuthority);

    await originalBatch([
      db.prepare(`CREATE TRIGGER fail_story_privacy_decision_invalidation
        BEFORE UPDATE OF story_generation_status ON workflow_runs
        WHEN OLD.story_generation_status='ready_for_human_review'
        BEGIN SELECT RAISE(ABORT, 'RAW_PRIVACY_TRACE_SQLITE_PATH'); END`),
    ]);
    const failedDecision = await decide(decisionRoute, "replacement-keep", { decision: "keep" });
    assert.equal(failedDecision.status, 409);
    const failedDecisionBody = await failedDecision.json();
    assert.equal(failedDecisionBody.code, "SOURCE_PRIVACY_MUTATION_CONFLICT");
    assert.doesNotMatch(JSON.stringify(failedDecisionBody), /RAW_PRIVACY_TRACE|sqlite|path/iu);
    assert.deepEqual(await privacySnapshot(db), beforeRejectedDecisions,
      "failed Story invalidation rolls back the contributor Privacy decision");
    assert.deepEqual(await storyAuthoritySnapshot(db), beforeRejectedAuthority);
    await originalBatch([db.prepare("DROP TRIGGER fail_story_privacy_decision_invalidation")]);

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
    const afterKeepDigest = (await capturePackageReleasePrivacySnapshot(db)).digest;
    assert.notEqual(afterKeepDigest, beforeKeepDigest, "a review decision changes the snapshot digest");

    await activateStory();
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
      "resolved source redactions cannot bypass the final Story and All set authority");

    await activateStory();
    const zeroResponse = await post(route, payload([]));
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
    assert.deepEqual(await storyAuthoritySnapshot(db), {
      story_generation_status: "blocked",
      story_source_revision: sourceRevision,
      active_story_digest: null,
    });
  } finally {
    globalThis.__oxygenLocalSqlite?.database.close();
    delete globalThis.__oxygenLocalSqlite;
    if (previousStateDir === undefined) delete process.env.OXYGEN_VIEWER_STATE_DIR;
    else process.env.OXYGEN_VIEWER_STATE_DIR = previousStateDir;
    await rm(stateDir, { recursive: true, force: true });
  }
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
