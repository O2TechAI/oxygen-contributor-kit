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

function span(overrides = {}) {
  return {
    id: "new-redaction",
    itemId: "item-alpha",
    documentId: "document-alpha",
    startOffset: 6,
    endOffset: 12,
    category: "sensitive",
    confidence: "high",
    reason: "synthetic fixture",
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

async function privacySnapshot(db) {
  const [jobs, redactions] = await Promise.all([
    db.prepare("SELECT * FROM redaction_jobs ORDER BY id").all(),
    db.prepare("SELECT * FROM redactions ORDER BY id").all(),
  ]);
  return { jobs: jobs.results, redactions: redactions.results };
}

test("redaction replacement validates completely and commits once with real SQLite", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "oxygen-redaction-atomicity-"));
  const previousStateDir = process.env.OXYGEN_VIEWER_STATE_DIR;
  process.env.OXYGEN_VIEWER_STATE_DIR = stateDir;

  try {
    const [{ getLocalDatabase }, { establishWorkflowRun }, { computeSourceDigest }, route] =
      await Promise.all([
        import("../db/index.ts"),
        import("../lib/workflow-run-server.ts"),
        import("../lib/redaction-pass.mjs"),
        import("../app/api/redactions/route.ts"),
      ]);
    const db = await getLocalDatabase();
    await establishWorkflowRun(db, "workflow-redaction-atomicity", oldTime);
    await db.batch([
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
      db.prepare(`INSERT INTO redaction_jobs
        (id,status,stage,model,completed,total,rejected,source_digest,
         started_at,updated_at,completed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
        "old-job", "complete", "done", "old-model", 1, 1, 0, sourceDigest,
        oldTime, oldTime, oldTime,
      ),
      db.prepare(`INSERT INTO redactions
        (id,item_id,document_id,start_offset,end_offset,category,confidence,reason,
         status,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        "old-redaction", "item-alpha", "document-alpha", 0, 5, "private-personal",
        "high", "old fixture", "active", "contributor", oldTime, oldTime,
      ),
    ]);

    const oldSnapshot = await privacySnapshot(db);
    const originalBatch = db.batch.bind(db);
    let routeBatchCalls = 0;
    db.batch = async (statements) => {
      routeBatchCalls += 1;
      return originalBatch(statements);
    };

    const invalidCases = [
      ["unknown-only", payload([span({ itemId: "missing-item" })])],
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
      ["additive bulk import", payload([span()], { replaceAll: false })],
      ["missing replacement authority", payload([span()], { replaceAll: undefined })],
      ["null member", payload([null])],
      ["non-object member", payload(["not-a-redaction"])],
    ];

    for (const [name, invalidPayload] of invalidCases) {
      const response = await post(route, invalidPayload);
      assert.equal(response.status, 400, name);
      assert.equal((await response.json()).imported ?? 0, 0, name);
      assert.deepEqual(await privacySnapshot(db), oldSnapshot, name);
      assert.equal(routeBatchCalls, 0, `${name} must not start a write batch`);
    }

    await originalBatch([
      db.prepare(`CREATE TRIGGER fail_atomic_redaction BEFORE INSERT ON redactions
        WHEN NEW.id='force-sql-failure'
        BEGIN SELECT RAISE(ABORT, 'forced redaction failure'); END`),
    ]);
    await assert.rejects(
      post(route, payload([span({ id: "force-sql-failure" })])),
      /forced redaction failure/,
    );
    assert.deepEqual(await privacySnapshot(db), oldSnapshot);
    assert.equal(routeBatchCalls, 1, "failed replacement uses one rolled-back batch");

    const validRedactions = [
      span({ id: "replacement-alpha" }),
      span({
        id: "replacement-beta", itemId: "item-beta", documentId: "document-beta",
        startOffset: 5, endOffset: 10, category: "credential",
      }),
    ];
    const response = await post(route, payload(validRedactions));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      imported: 2,
      rejected: [],
      status: "complete",
    });
    assert.equal(routeBatchCalls, 2, "successful replacement adds exactly one batch");

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
      completed: 2,
      total: 2,
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
      status: row.status,
    })), [
      {
        id: "replacement-alpha", item_id: "item-alpha", document_id: "document-alpha",
        start_offset: 6, end_offset: 12, category: "sensitive", status: "active",
      },
      {
        id: "replacement-beta", item_id: "item-beta", document_id: "document-beta",
        start_offset: 5, end_offset: 10, category: "credential", status: "active",
      },
    ]);
  } finally {
    globalThis.__oxygenLocalSqlite?.database.close();
    delete globalThis.__oxygenLocalSqlite;
    if (previousStateDir === undefined) delete process.env.OXYGEN_VIEWER_STATE_DIR;
    else process.env.OXYGEN_VIEWER_STATE_DIR = previousStateDir;
    await rm(stateDir, { recursive: true, force: true });
  }
});
