import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

const statements = [
  `CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL,
    source_user TEXT, source_system TEXT, source_timestamp TEXT,
    item_count INTEGER NOT NULL DEFAULT 0, metadata_json TEXT NOT NULL DEFAULT '{}',
    original_envelope_json TEXT NOT NULL DEFAULT '{}', imported_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, organization_status TEXT NOT NULL DEFAULT 'pending',
    formatted_summary_json TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY, document_id TEXT NOT NULL, sequence INTEGER NOT NULL,
    event_type TEXT, actor_id TEXT, actor_type TEXT, timestamp TEXT,
    content TEXT NOT NULL, original_json TEXT NOT NULL,
    organization_category TEXT, organization_confidence INTEGER,
    organization_reason TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS items_document_sequence_idx
     ON items(document_id, sequence)`,
  `CREATE TABLE IF NOT EXISTS organization_jobs (
    id TEXT PRIMARY KEY, status TEXT NOT NULL, stage TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
    warnings_json TEXT NOT NULL DEFAULT '[]', started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, completed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS finalized_corpus_manifests (
    workflow_run_id TEXT PRIMARY KEY, corpus_revision INTEGER NOT NULL,
    corpus_digest TEXT NOT NULL, document_count INTEGER NOT NULL,
    item_count INTEGER NOT NULL, finalized_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS semantic_manifests (
    workflow_run_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
    revision INTEGER NOT NULL, source_revision INTEGER NOT NULL,
    source_digest TEXT NOT NULL, universe_digest TEXT NOT NULL,
    manifest_digest TEXT NOT NULL, unit_count INTEGER NOT NULL,
    serialized_bytes INTEGER NOT NULL, story_projection_bytes INTEGER NOT NULL,
    corpus_revision INTEGER NOT NULL, corpus_digest TEXT NOT NULL,
    corpus_document_count INTEGER NOT NULL, corpus_item_count INTEGER NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS semantic_units (
    id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL,
    revision INTEGER NOT NULL, project_id TEXT NOT NULL, kind TEXT NOT NULL,
    member_count INTEGER NOT NULL, membership_digest TEXT NOT NULL,
    duplicate_of_unit_id TEXT, story_projection_json TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE TABLE IF NOT EXISTS semantic_unit_members (
    item_id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL, unit_id TEXT NOT NULL,
    source_digest TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS semantic_unit_members_unit_idx
     ON semantic_unit_members(unit_id)`,
  `CREATE TABLE IF NOT EXISTS story_coverage_manifests (
    workflow_run_id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
    semantic_manifest_revision INTEGER NOT NULL,
    semantic_manifest_digest TEXT NOT NULL, coverage_digest TEXT NOT NULL,
    unit_count INTEGER NOT NULL, serialized_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS story_coverage_rows (
    unit_id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL,
    disposition TEXT NOT NULL, owner_id TEXT NOT NULL, exclusion_reason TEXT
  )`,
  // This is the only pre-collection persistence surface. Keep it operational
  // and allowlisted: no target path, reasoning, payload, or free-form status.
  `CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY, target_confirmed INTEGER NOT NULL DEFAULT 0,
    collection_status TEXT NOT NULL DEFAULT 'pending',
    collection_completed INTEGER NOT NULL DEFAULT 0,
    collection_total INTEGER NOT NULL DEFAULT 0,
    story_generation_status TEXT NOT NULL DEFAULT 'not_started',
    story_generation_completed INTEGER NOT NULL DEFAULT 0,
    story_generation_total INTEGER NOT NULL DEFAULT 0,
    story_source_revision INTEGER NOT NULL DEFAULT 0,
    active_story_digest TEXT,
    blocker_code TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  // Local review persistence lets refresh hydrate the same validated Chapter
  // lifecycle. Package/release code never selects this table.
  `CREATE TABLE IF NOT EXISTS story_review_sessions (
    workflow_run_id TEXT PRIMARY KEY, state_json TEXT NOT NULL,
    updated_at TEXT NOT NULL, server_version INTEGER NOT NULL DEFAULT 0
  )`,
  // One row per redacted span. Offsets address items.content, which stays the
  // untouched original -- the tag is applied at render time. Only pending
  // model spans can receive one contributor Keep or Redact decision.
  `CREATE TABLE IF NOT EXISTS redactions (
    id TEXT PRIMARY KEY, item_id TEXT NOT NULL, document_id TEXT NOT NULL,
    start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
    category TEXT NOT NULL, confidence TEXT, reason TEXT,
    review_state TEXT NOT NULL
      CHECK(review_state IN ('deterministic','needs_confirmation','confirmed_keep','confirmed_redact')),
    uncertainty_reason TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_by TEXT NOT NULL DEFAULT 'llm', created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS redactions_item_idx ON redactions(item_id)`,
  `CREATE INDEX IF NOT EXISTS redactions_document_idx ON redactions(document_id)`,
  `CREATE TABLE IF NOT EXISTS redaction_jobs (
    id TEXT PRIMARY KEY, status TEXT NOT NULL, stage TEXT NOT NULL,
    model TEXT, completed INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0,
    source_digest TEXT,
    started_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
  )`,
  // Preference probes: one question per friction moment. `answer` stays NULL
  // until the contributor answers -- an unanswered probe must never be read as
  // a confirmed preference.
  `CREATE TABLE IF NOT EXISTS probes (
    id TEXT PRIMARY KEY, document_id TEXT NOT NULL, document_kind TEXT,
    event_ids_json TEXT NOT NULL DEFAULT '[]', timestamp TEXT,
    signal TEXT NOT NULL, score INTEGER NOT NULL DEFAULT 0,
    turns INTEGER NOT NULL DEFAULT 0, recap TEXT NOT NULL, question TEXT NOT NULL,
    options_json TEXT NOT NULL DEFAULT '[]', presentations_json TEXT NOT NULL DEFAULT '{}',
    allow_other INTEGER NOT NULL DEFAULT 1, allow_skip INTEGER NOT NULL DEFAULT 1,
    answer_choice TEXT, answer_text TEXT, answered_at TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS probes_document_idx ON probes(document_id)`,
  // Bulk judgement calls. `default` is always keep; removal needs an answer.
  `CREATE TABLE IF NOT EXISTS probe_bulk_decisions (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
    question TEXT NOT NULL, default_answer TEXT NOT NULL DEFAULT 'keep',
    answer TEXT, answered_at TEXT, evidence_sample_json TEXT NOT NULL DEFAULT '[]',
    presentations_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS probe_runs (
    id TEXT PRIMARY KEY, status TEXT NOT NULL, stage TEXT NOT NULL, model TEXT,
    generated INTEGER NOT NULL DEFAULT 0, set_aside INTEGER NOT NULL DEFAULT 0,
    auto_removed_json TEXT NOT NULL DEFAULT '{}',
    started_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
  )`,
];

type Row = Record<string, unknown>;
type StatementResult = { success: true; meta: { changes: number }; results?: Row[] };

const ordinaryRow = <T>(row: Row): T => ({ ...row }) as T;

class LocalStatement {
  private values: unknown[] = [];
  private readonly statement: StatementSync;

  constructor(statement: StatementSync) {
    this.statement = statement;
  }

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T = Row>(): Promise<T | null> {
    const row = this.statement.get(...(this.values as never[])) as Row | undefined;
    return row ? ordinaryRow<T>(row) : null;
  }

  async all<T = Row>(): Promise<{ results: T[] }> {
    return { results: this.statement.all(...(this.values as never[])).map(ordinaryRow<T>) };
  }

  async run() {
    return this.runSync();
  }

  execute(): StatementResult {
    return this.statement.columns().length
      ? {
        success: true as const,
        meta: { changes: 0 },
        results: this.statement.all(...(this.values as never[])).map(ordinaryRow<Row>),
      }
      : this.runSync();
  }

  private runSync() {
    const { changes } = this.statement.run(...(this.values as never[]));
    return { success: true as const, meta: { changes: Number(changes) } };
  }
}

class LocalDatabase {
  private readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  prepare(sql: string) {
    return new LocalStatement(this.database.prepare(sql));
  }

  async batch(statements: LocalStatement[]) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.execute());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

type LocalSqliteGlobal = typeof globalThis & { __oxygenLocalSqlite?: LocalDatabase };

export async function getLocalDatabase() {
  const runtime = globalThis as LocalSqliteGlobal;
  if (runtime.__oxygenLocalSqlite) return runtime.__oxygenLocalSqlite;

  const stateDir = process.env.OXYGEN_VIEWER_STATE_DIR;
  const databasePath = stateDir === undefined ? ":memory:" : join(stateDir, "oxygen.sqlite");
  if (stateDir !== undefined) mkdirSync(stateDir, { recursive: true });

  const database = new DatabaseSync(databasePath);
  database.exec(statements.join(";\n"));
  runtime.__oxygenLocalSqlite = new LocalDatabase(database);
  return runtime.__oxygenLocalSqlite;
}
