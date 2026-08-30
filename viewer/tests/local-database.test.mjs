import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const NOW = "2036-01-01T00:00:00.000Z";
const SCHEMA_ERROR = "STORY_PRIVACY_SCHEMA_UNSUPPORTED: Story Privacy SQLite state is unknown or partially migrated; restore a known PR10/current backup before reopening Oxygen.";
const CURRENT_CANDIDATES = `CREATE TABLE story_privacy_candidates (
  workflow_run_id TEXT NOT NULL, candidate_id TEXT NOT NULL,
  candidate_json TEXT NOT NULL,
  PRIMARY KEY (workflow_run_id, candidate_id)
)`;
const CURRENT_AUTHORITIES = `CREATE TABLE story_privacy_authorities (
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
  proposal_digest TEXT NOT NULL,
  proposal_count INTEGER NOT NULL CHECK(proposal_count >= 0),
  imported_at TEXT NOT NULL
)`;
const CURRENT_TARGETS = `CREATE TABLE story_privacy_targets (
  workflow_run_id TEXT NOT NULL, target_id TEXT NOT NULL,
  target_content_digest TEXT NOT NULL,
  proposed_text TEXT NOT NULL,
  occurrences_json TEXT NOT NULL CHECK(json_valid(occurrences_json)),
  selected_text TEXT,
  public_overrides_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(public_overrides_json)),
  decided_at TEXT,
  CHECK (
    (selected_text IS NULL AND public_overrides_json='[]' AND decided_at IS NULL)
    OR
    (selected_text IS NOT NULL AND decided_at IS NOT NULL)
  ),
  PRIMARY KEY (workflow_run_id, target_id)
)`;
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

const normalizeSql = (sql) => sql.replace(/\s+/gu, " ").trim();

function closeLocalDatabase() {
  globalThis.__oxygenLocalSqlite?.database.close();
  delete globalThis.__oxygenLocalSqlite;
}

async function openLocalDatabase() {
  const { getLocalDatabase } = await import("../db/index.ts");
  return getLocalDatabase();
}

async function withStateDirectory(prefix, operation) {
  const stateDir = await mkdtemp(join(tmpdir(), prefix));
  const previous = process.env.OXYGEN_VIEWER_STATE_DIR;
  closeLocalDatabase();
  process.env.OXYGEN_VIEWER_STATE_DIR = stateDir;
  try {
    return await operation(stateDir, join(stateDir, "oxygen.sqlite"));
  } finally {
    closeLocalDatabase();
    if (previous === undefined) delete process.env.OXYGEN_VIEWER_STATE_DIR;
    else process.env.OXYGEN_VIEWER_STATE_DIR = previous;
    await rm(stateDir, { recursive: true, force: true });
  }
}

function exactStorySchema(database) {
  return database.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
    WHERE name GLOB 'story_privacy_*' OR tbl_name GLOB 'story_privacy_*'
    ORDER BY type,name`).all().map((row) => ({
    ...row,
    sql: row.sql === null ? null : normalizeSql(row.sql),
  }));
}

function assertCurrentStorySchema(database) {
  const tables = database.prepare(`SELECT name,sql FROM sqlite_schema
    WHERE type='table' AND name GLOB 'story_privacy_*' ORDER BY name`).all();
  assert.deepEqual(tables.map((row) => [row.name, normalizeSql(row.sql)]), [
    ["story_privacy_authorities", normalizeSql(CURRENT_AUTHORITIES)],
    ["story_privacy_candidates", normalizeSql(CURRENT_CANDIDATES)],
    ["story_privacy_targets", normalizeSql(CURRENT_TARGETS)],
  ]);
  assert.deepEqual(database.prepare(`SELECT name FROM sqlite_schema
    WHERE type='index' AND tbl_name GLOB 'story_privacy_*' ORDER BY name`).all()
    .map((row) => String(row.name)), [
    "sqlite_autoindex_story_privacy_authorities_1",
    "sqlite_autoindex_story_privacy_candidates_1",
    "sqlite_autoindex_story_privacy_targets_1",
  ]);
}

function replaceWithLegacy(database, { keepEmptyTargets = false, abortDelete = false } = {}) {
  database.exec(`DROP TABLE story_privacy_targets;
    DROP TABLE story_privacy_authorities;
    DROP TABLE story_privacy_candidates;
    ${LEGACY_CANDIDATES};
    ${LEGACY_AUTHORITIES};
    ${keepEmptyTargets ? CURRENT_TARGETS : ""}`);
  database.prepare(`INSERT INTO story_privacy_candidates
    (workflow_run_id,candidate_id,candidate_json,decision,decision_version,decided_at)
    VALUES ('authority-run','legacy-authority-candidate','{"legacy":"authority"}','keep',1,?)`).run(NOW);
  database.prepare(`INSERT INTO story_privacy_candidates
    (workflow_run_id,candidate_id,candidate_json,decision,decision_version,decided_at)
    VALUES ('candidate-only-run','legacy-candidate-only','{"legacy":"candidate-only"}',NULL,0,NULL)`).run();
  database.prepare(`INSERT INTO story_privacy_authorities
    (workflow_run_id,source_revision,active_story_digest,server_version,reviewed_story_digest,
     target_catalog_json,target_catalog_digest,changed_target_digest,changed_target_count,
     receipt_digest,batch_digest,candidate_digest,candidate_count,imported_at)
    VALUES ('authority-run',1,?,0,?,'[]',?,?,0,?,?,?,1,?)`).run(
    "a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64),
    "e".repeat(64), "f".repeat(64), "1".repeat(64), NOW,
  );
  for (const [workflowRunId, lane] of [
    ["authority-run", "story_privacy"],
    ["receipt-only-run", "story_privacy"],
    ["authority-run", "story"],
    ["authority-run", "insight"],
    ["authority-run", "preference"],
  ]) {
    database.prepare(`INSERT INTO story_preparation_receipts
      (workflow_run_id,lane,source_revision,input_digest,scope_digest,scope_count,
       output_digest,output_count,completed_at) VALUES (?,?,1,?,?,1,?,1,?)`).run(
      workflowRunId, lane, "2".repeat(64), "3".repeat(64), "4".repeat(64), NOW,
    );
  }
  for (const workflowRunId of [
    "authority-run", "receipt-only-run", "candidate-only-run", "unrelated-run",
  ]) {
    database.prepare(`INSERT INTO project_release_confirmations
      (workflow_run_id,review_gate_digest,confirmed_at) VALUES (?,?,?)`).run(
      workflowRunId, "5".repeat(64), NOW,
    );
  }
  if (abortDelete) {
    database.exec(`CREATE TRIGGER abort_story_privacy_confirmation
      BEFORE DELETE ON project_release_confirmations
      WHEN OLD.workflow_run_id='authority-run'
      BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END`);
  }
}

async function seedDurableRows(db) {
  await db.prepare("CREATE TABLE durable_sentinel (id TEXT PRIMARY KEY,payload BLOB NOT NULL)").run();
  await db.prepare("INSERT INTO durable_sentinel (id,payload) VALUES ('blob',X'00ff01fe')").run();
  await db.prepare(`INSERT INTO documents
    (id,kind,title,item_count,metadata_json,original_envelope_json,imported_at,updated_at,
     organization_status,formatted_summary_json)
    VALUES ('durable-doc','trajectory','Durable source',1,'{"organization":"sentinel"}',
      '{"source":"sentinel"}',?,?,'complete','{"story":"sentinel"}')`).bind(NOW, NOW).run();
  await db.prepare(`INSERT INTO items
    (id,document_id,sequence,event_type,actor_id,actor_type,content,original_json,
     organization_category,organization_confidence,organization_reason)
    VALUES ('durable-item','durable-doc',1,'message','durable-actor','human',
      'DURABLE_SOURCE_BYTES','{"insight":"sentinel"}','Durable project',100,
      'oxygen.story:{"edit":"sentinel"}')`).run();
  await db.prepare(`INSERT INTO organization_jobs
    (id,status,stage,completed,total,warnings_json,started_at,updated_at,completed_at)
    VALUES ('durable-org','complete','organization',1,1,'[]',?,?,?)`).bind(NOW, NOW, NOW).run();
  await db.prepare(`INSERT INTO semantic_units
    (id,workflow_run_id,revision,project_id,kind,member_count,membership_digest,story_projection_json)
    VALUES ('durable-unit','durable-workflow',9,'durable-project','semantic',1,?,
      '{"semantic":"sentinel"}')`).bind("6".repeat(64)).run();
  await db.prepare(`INSERT INTO workflow_runs
    (id,target_confirmed,collection_status,collection_completed,collection_total,
     story_generation_status,story_generation_completed,story_generation_total,
     story_source_revision,active_story_digest,created_at,updated_at)
    VALUES ('durable-workflow',1,'complete',1,1,'ready_for_human_review',1,1,9,?,?,?)`).bind(
    "7".repeat(64), NOW, NOW,
  ).run();
  await db.prepare(`INSERT INTO story_review_sessions
    (workflow_run_id,state_json,updated_at,server_version)
    VALUES ('durable-workflow','{"edits":"DURABLE_EDIT","insights":"DURABLE_INSIGHT"}',?,4)`).bind(NOW).run();
  await db.prepare(`INSERT INTO redactions
    (id,item_id,document_id,start_offset,end_offset,category,confidence,reason,
     review_state,status,created_by,created_at,updated_at)
    VALUES ('durable-redaction','durable-item','durable-doc',0,7,'private-personal','high',
      'DURABLE_REDACTION','confirmed_keep','active','human',?,?)`).bind(NOW, NOW).run();
  await db.prepare(`INSERT INTO probes
    (id,document_id,document_kind,event_ids_json,signal,score,turns,recap,question,
     options_json,presentations_json,allow_other,allow_skip,answer_choice,answer_text,answered_at,created_at)
    VALUES ('durable-preference','durable-doc','trajectory','["durable-item"]','friction',1,1,
      'DURABLE_PREFERENCE','Keep it?','["keep"]','{}',0,0,'keep','DURABLE_ANSWER',?,?)`).bind(
    NOW, NOW,
  ).run();
}

function durableSnapshot(database) {
  return {
    blob: database.prepare("SELECT id,hex(payload) AS payload FROM durable_sentinel ORDER BY id").all(),
    documents: database.prepare("SELECT * FROM documents ORDER BY id").all(),
    items: database.prepare("SELECT * FROM items ORDER BY id").all(),
    organization: database.prepare("SELECT * FROM organization_jobs ORDER BY id").all(),
    semantic: database.prepare("SELECT * FROM semantic_units ORDER BY id").all(),
    workflows: database.prepare("SELECT * FROM workflow_runs ORDER BY id").all(),
    sessions: database.prepare("SELECT * FROM story_review_sessions ORDER BY workflow_run_id").all(),
    redactions: database.prepare("SELECT * FROM redactions ORDER BY id").all(),
    preferences: database.prepare("SELECT * FROM probes ORDER BY id").all(),
  };
}

test("local SQLite preserves the viewer database contract", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "oxygen-local-sqlite-"));
  process.env.OXYGEN_VIEWER_STATE_DIR = stateDir;

  try {
    const { getLocalDatabase } = await import("../db/index.ts");
    const db = await getLocalDatabase();
    assert.equal(await getLocalDatabase(), db);
    assert.equal(existsSync(join(stateDir, "oxygen.sqlite")), true);

    const schema = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('documents', 'workflow_runs') ORDER BY name",
    ).all();
    assert.deepEqual(schema.results.map((row) => row.name), ["documents", "workflow_runs"]);

    const inserted = await db.prepare(`INSERT INTO documents
      (id,kind,title,imported_at,updated_at) VALUES (?,?,?,?,?)`)
      .bind("first", "synthetic", "First", "2036-01-01", "2036-01-01").run();
    assert.deepEqual(inserted, { success: true, meta: { changes: 1 } });

    const first = await db.prepare("SELECT id,title FROM documents WHERE id=?").bind("first").first();
    assert.deepEqual(first, { id: "first", title: "First" });
    assert.equal(Object.getPrototypeOf(first), Object.prototype);

    const all = await db.prepare("SELECT id,title FROM documents ORDER BY id").all();
    assert.deepEqual(all, { results: [{ id: "first", title: "First" }] });
    assert.equal(Object.getPrototypeOf(all.results[0]), Object.prototype);

    const mixed = await db.batch([
      db.prepare(`INSERT INTO documents
        (id,kind,title,imported_at,updated_at) VALUES (?,?,?,?,?)`)
        .bind("second", "synthetic", "Second", "2036-01-01", "2036-01-01"),
      db.prepare("SELECT id FROM documents ORDER BY id"),
    ]);
    assert.deepEqual(mixed, [
      { success: true, meta: { changes: 1 } },
      { success: true, meta: { changes: 0 }, results: [{ id: "first" }, { id: "second" }] },
    ]);

    await assert.rejects(db.batch([
      db.prepare(`INSERT INTO documents
        (id,kind,title,imported_at,updated_at) VALUES (?,?,?,?,?)`)
        .bind("rolled-back", "synthetic", "Rolled back", "2036-01-01", "2036-01-01"),
      db.prepare(`INSERT INTO documents
        (id,kind,title,imported_at,updated_at) VALUES (?,?,?,?,?)`)
        .bind("first", "synthetic", "Duplicate", "2036-01-01", "2036-01-01"),
    ]));
    assert.equal(await db.prepare("SELECT id FROM documents WHERE id=?").bind("rolled-back").first(), null);

    const [casZero, casOne] = await db.batch([
      db.prepare("UPDATE documents SET title=? WHERE id=? AND title=?").bind("Changed", "first", "stale"),
      db.prepare("UPDATE documents SET title=? WHERE id=? AND title=?").bind("Changed", "first", "First"),
    ]);
    assert.equal(casZero.meta.changes, 0);
    assert.equal(casOne.meta.changes, 1);
  } finally {
    globalThis.__oxygenLocalSqlite?.database.close();
    delete globalThis.__oxygenLocalSqlite;
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("legacy completed redaction jobs remain present but gain no forged Source Privacy receipt", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "oxygen-local-sqlite-legacy-"));
  const databasePath = join(stateDir, "oxygen.sqlite");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`CREATE TABLE redaction_jobs (
    id TEXT PRIMARY KEY, status TEXT NOT NULL, stage TEXT NOT NULL,
    model TEXT, completed INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0,
    source_digest TEXT, started_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    completed_at TEXT
  )`);
  legacy.prepare(`INSERT INTO redaction_jobs
    (id,status,stage,completed,total,rejected,source_digest,started_at,updated_at,completed_at)
    VALUES ('legacy-complete','complete','privacy',0,0,0,?,?,?,?)`).run(
    "a".repeat(64), "2036-01-01", "2036-01-01", "2036-01-01",
  );
  legacy.close();
  process.env.OXYGEN_VIEWER_STATE_DIR = stateDir;
  try {
    const { getLocalDatabase } = await import("../db/index.ts");
    const db = await getLocalDatabase();
    assert.equal((await db.prepare("SELECT status FROM redaction_jobs WHERE id='legacy-complete'")
      .first()).status, "complete");
    assert.deepEqual((await db.prepare("SELECT * FROM source_privacy_receipts").all()).results, []);
  } finally {
    globalThis.__oxygenLocalSqlite?.database.close();
    delete globalThis.__oxygenLocalSqlite;
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("fresh SQLite creates the exact current Story Privacy schema", async () => {
  await withStateDirectory("oxygen-story-privacy-fresh-", async (_stateDir, databasePath) => {
    await openLocalDatabase();
    closeLocalDatabase();
    const database = new DatabaseSync(databasePath);
    try {
      assertCurrentStorySchema(database);
      for (const table of [
        "story_privacy_candidates", "story_privacy_authorities", "story_privacy_targets",
      ]) {
        assert.equal(Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count), 0);
      }
    } finally {
      database.close();
    }
  });
});

test("exact PR10 Story Privacy state migrates narrowly and a second open is a no-op", async () => {
  await withStateDirectory("oxygen-story-privacy-legacy-", async (_stateDir, databasePath) => {
    const initial = await openLocalDatabase();
    await seedDurableRows(initial);
    closeLocalDatabase();

    let database = new DatabaseSync(databasePath);
    let durableBefore;
    try {
      replaceWithLegacy(database);
      durableBefore = durableSnapshot(database);
    } finally {
      database.close();
    }

    await openLocalDatabase();
    closeLocalDatabase();
    database = new DatabaseSync(databasePath);
    let schemaVersion;
    let migratedSchema;
    let migratedRows;
    try {
      assertCurrentStorySchema(database);
      assert.deepEqual(durableSnapshot(database), durableBefore);
      assert.deepEqual(database.prepare(`SELECT workflow_run_id FROM project_release_confirmations
        ORDER BY workflow_run_id`).all().map((row) => ({ ...row })), [
        { workflow_run_id: "unrelated-run" },
      ]);
      assert.deepEqual(database.prepare(`SELECT workflow_run_id,lane FROM story_preparation_receipts
        ORDER BY workflow_run_id,lane`).all().map((row) => ({ ...row })), [
        { workflow_run_id: "authority-run", lane: "insight" },
        { workflow_run_id: "authority-run", lane: "preference" },
        { workflow_run_id: "authority-run", lane: "story" },
      ]);
      for (const table of [
        "story_privacy_candidates", "story_privacy_authorities", "story_privacy_targets",
      ]) assert.equal(Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count), 0);
      schemaVersion = Number(database.prepare("PRAGMA schema_version").get().schema_version);
      migratedSchema = exactStorySchema(database);
      migratedRows = {
        durable: durableSnapshot(database),
        confirmations: database.prepare("SELECT * FROM project_release_confirmations ORDER BY workflow_run_id").all(),
        receipts: database.prepare(`SELECT * FROM story_preparation_receipts
          ORDER BY workflow_run_id,lane`).all(),
      };
    } finally {
      database.close();
    }
    const bytesAfterMigration = await readFile(databasePath);

    await openLocalDatabase();
    closeLocalDatabase();
    database = new DatabaseSync(databasePath);
    try {
      assert.equal(Number(database.prepare("PRAGMA schema_version").get().schema_version), schemaVersion);
      assert.deepEqual(exactStorySchema(database), migratedSchema);
      assert.deepEqual({
        durable: durableSnapshot(database),
        confirmations: database.prepare("SELECT * FROM project_release_confirmations ORDER BY workflow_run_id").all(),
        receipts: database.prepare(`SELECT * FROM story_preparation_receipts
          ORDER BY workflow_run_id,lane`).all(),
      }, migratedRows);
    } finally {
      database.close();
    }
    assert.deepEqual(await readFile(databasePath), bytesAfterMigration);
  });
});

test("exact PR10 schemas with an empty current target table migrate", async () => {
  await withStateDirectory("oxygen-story-privacy-empty-target-", async (_stateDir, databasePath) => {
    await openLocalDatabase();
    closeLocalDatabase();
    let database = new DatabaseSync(databasePath);
    replaceWithLegacy(database, { keepEmptyTargets: true });
    database.close();
    await openLocalDatabase();
    closeLocalDatabase();
    database = new DatabaseSync(databasePath);
    try {
      assertCurrentStorySchema(database);
      assert.equal(Number(database.prepare("SELECT COUNT(*) AS count FROM story_privacy_targets")
        .get().count), 0);
    } finally {
      database.close();
    }
  });
});

test("an exact current Story Privacy database is a byte-for-byte no-op", async () => {
  await withStateDirectory("oxygen-story-privacy-current-", async (_stateDir, databasePath) => {
    const current = await openLocalDatabase();
    await current.prepare(`INSERT INTO story_privacy_candidates
      (workflow_run_id,candidate_id,candidate_json) VALUES ('current-run','current-candidate','{}')`).run();
    await current.prepare(`INSERT INTO story_privacy_targets
      (workflow_run_id,target_id,target_content_digest,proposed_text,occurrences_json,
       selected_text,public_overrides_json,decided_at)
      VALUES ('current-run','current-target',?,'Current proposal','[]','Current proposal','[]',?)`).bind(
      "a".repeat(64), NOW,
    ).run();
    await current.prepare(`INSERT INTO story_privacy_authorities
      (workflow_run_id,source_revision,active_story_digest,server_version,reviewed_story_digest,
       target_catalog_json,target_catalog_digest,changed_target_digest,changed_target_count,
       receipt_digest,proposal_digest,proposal_count,imported_at)
      VALUES ('current-run',1,?,0,?,'[]',?,?,0,?,?,1,?)`).bind(
      "b".repeat(64), "c".repeat(64), "d".repeat(64), "e".repeat(64),
      "f".repeat(64), "1".repeat(64), NOW,
    ).run();
    closeLocalDatabase();
    let database = new DatabaseSync(databasePath);
    const before = {
      schemaVersion: Number(database.prepare("PRAGMA schema_version").get().schema_version),
      schema: exactStorySchema(database),
      candidates: database.prepare("SELECT * FROM story_privacy_candidates").all(),
      authorities: database.prepare("SELECT * FROM story_privacy_authorities").all(),
      targets: database.prepare("SELECT * FROM story_privacy_targets").all(),
    };
    database.close();
    const beforeBytes = await readFile(databasePath);
    await openLocalDatabase();
    closeLocalDatabase();
    database = new DatabaseSync(databasePath);
    assert.deepEqual({
      schemaVersion: Number(database.prepare("PRAGMA schema_version").get().schema_version),
      schema: exactStorySchema(database),
      candidates: database.prepare("SELECT * FROM story_privacy_candidates").all(),
      authorities: database.prepare("SELECT * FROM story_privacy_authorities").all(),
      targets: database.prepare("SELECT * FROM story_privacy_targets").all(),
    }, before);
    database.close();
    assert.deepEqual(await readFile(databasePath), beforeBytes);
  });
});

test("unknown, mixed, nonempty partial, and failed legacy refresh states preserve bytes", async (t) => {
  const cases = [
    ["lookalike candidate", (database) => {
      database.exec(`DROP TABLE story_privacy_candidates;
        ${CURRENT_CANDIDATES.replace("candidate_json TEXT NOT NULL,", "candidate_json TEXT NOT NULL, extra TEXT,")}`);
    }],
    ["case-variant candidate", (database) => {
      database.exec(`DROP TABLE story_privacy_candidates;
        ${CURRENT_CANDIDATES.replace("story_privacy_candidates", "Story_Privacy_Candidates")}`);
    }],
    ["mixed legacy candidate and current authority", (database) => {
      database.exec(`DROP TABLE story_privacy_candidates; ${LEGACY_CANDIDATES}`);
    }],
    ["missing current target", (database) => {
      database.exec("DROP TABLE story_privacy_targets");
    }],
    ["nonempty partial target", (database) => {
      replaceWithLegacy(database, { keepEmptyTargets: true });
      database.prepare(`INSERT INTO story_privacy_targets
        (workflow_run_id,target_id,target_content_digest,proposed_text,occurrences_json)
        VALUES ('partial-run','partial-target',?,'Partial','[]')`).run("a".repeat(64));
    }],
    ["transaction rollback", (database) => {
      replaceWithLegacy(database, { abortDelete: true });
    }, "synthetic rollback"],
  ];
  for (const [name, mutate, expectedError = SCHEMA_ERROR] of cases) {
    await t.test(name, async () => withStateDirectory(
      `oxygen-story-privacy-invalid-${String(name).replaceAll(" ", "-")}-`,
      async (_stateDir, databasePath) => {
        const initial = await openLocalDatabase();
        await initial.prepare("CREATE TABLE durable_sentinel (id TEXT PRIMARY KEY,payload BLOB NOT NULL)")
          .run();
        await initial.prepare("INSERT INTO durable_sentinel VALUES ('blob',X'00ff01fe')").run();
        closeLocalDatabase();
        let database = new DatabaseSync(databasePath);
        mutate(database);
        const schemaBefore = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name")
          .all();
        const sentinelBefore = database.prepare("SELECT id,hex(payload) AS payload FROM durable_sentinel")
          .all();
        database.close();
        const bytesBefore = await readFile(databasePath);
        await assert.rejects(openLocalDatabase(), (error) => {
          assert.equal(error.message, expectedError);
          return true;
        });
        assert.equal(globalThis.__oxygenLocalSqlite, undefined);
        database = new DatabaseSync(databasePath);
        assert.deepEqual(database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name")
          .all(), schemaBefore);
        assert.deepEqual(database.prepare("SELECT id,hex(payload) AS payload FROM durable_sentinel")
          .all(), sentinelBefore);
        database.close();
        assert.deepEqual(await readFile(databasePath), bytesBefore);
      },
    ));
  }
});
