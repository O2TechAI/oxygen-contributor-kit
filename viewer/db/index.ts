import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";

const storyPrivacyCandidatesStatement = `CREATE TABLE IF NOT EXISTS story_privacy_candidates (
  workflow_run_id TEXT NOT NULL, candidate_id TEXT NOT NULL,
  candidate_json TEXT NOT NULL,
  PRIMARY KEY (workflow_run_id, candidate_id)
)`;
const storyPrivacyAuthoritiesStatement = `CREATE TABLE IF NOT EXISTS story_privacy_authorities (
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
const storyPrivacyTargetsStatement = `CREATE TABLE IF NOT EXISTS story_privacy_targets (
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

const legacyStoryPrivacyCandidatesStatement = `CREATE TABLE story_privacy_candidates (
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
const legacyStoryPrivacyAuthoritiesStatement = `CREATE TABLE story_privacy_authorities (
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
    privacy_authority_digest TEXT NOT NULL,
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
  `CREATE TABLE IF NOT EXISTS source_privacy_receipts (
    job_id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL UNIQUE,
    source_revision INTEGER NOT NULL CHECK(source_revision > 0),
    source_digest TEXT NOT NULL, receipt_digest TEXT NOT NULL,
    receipt_json TEXT NOT NULL, created_at TEXT NOT NULL
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
    workflow_run_id TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE,
    source_revision INTEGER NOT NULL,
    input_digest TEXT NOT NULL, output_digest TEXT NOT NULL,
    output_count INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status='complete'), stage TEXT NOT NULL,
    model TEXT CHECK(model IS NULL),
    generated INTEGER NOT NULL DEFAULT 0, set_aside INTEGER NOT NULL DEFAULT 0,
    auto_removed_json TEXT NOT NULL DEFAULT '{}',
    started_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS story_preparation_receipts (
    workflow_run_id TEXT NOT NULL, lane TEXT NOT NULL,
    source_revision INTEGER NOT NULL, input_digest TEXT NOT NULL,
    scope_digest TEXT NOT NULL, scope_count INTEGER NOT NULL,
    output_digest TEXT NOT NULL, output_count INTEGER NOT NULL,
    completed_at TEXT NOT NULL,
    PRIMARY KEY (workflow_run_id, lane)
  )`,
  storyPrivacyCandidatesStatement,
  // One unversioned Story Privacy contract covers activation and each reviewed
  // Story replacement. Agent-authored proposals are the only text proposals.
  storyPrivacyAuthoritiesStatement,
  // One row binds the Agent proposal and the exact contributor-selected bytes.
  storyPrivacyTargetsStatement,
  `CREATE TABLE IF NOT EXISTS project_release_confirmations (
    workflow_run_id TEXT PRIMARY KEY,
    review_gate_digest TEXT NOT NULL,
    confirmed_at TEXT NOT NULL
  )`,
];

const STORY_PRIVACY_SCHEMA_REFRESH_REQUIRED = "STORY_PRIVACY_SCHEMA_UNSUPPORTED: Story Privacy SQLite state is unknown or partially migrated; restore a known PR10/current backup before reopening Oxygen.";
const storyPrivacyTableNames = [
  "story_privacy_candidates",
  "story_privacy_authorities",
  "story_privacy_targets",
] as const;
type StoryPrivacySchemaState = "fresh" | "current" | "legacy";
type SchemaArtifact = { type: string; name: string; tbl_name: string; sql: string | null };

function normalizeSchemaSql(sql: string) {
  return sql.replace(/\s+/gu, " ").trim()
    .replace(/^CREATE TABLE IF NOT EXISTS /u, "CREATE TABLE ");
}

function schemaSignature(rows: SchemaArtifact[]) {
  return JSON.stringify(rows.map((row) => ({
    type: row.type,
    name: row.name,
    tbl_name: row.tbl_name,
    sql: row.sql === null ? null : normalizeSchemaSql(row.sql),
  })).sort((left, right) => (
    `${left.type}\0${left.name}`.localeCompare(`${right.type}\0${right.name}`)
  )));
}

function expectedSchemaSignature(definitions: Array<readonly [string, string]>) {
  return schemaSignature(definitions.flatMap(([name, sql]) => ([
    { type: "index", name: `sqlite_autoindex_${name}_1`, tbl_name: name, sql: null },
    { type: "table", name, tbl_name: name, sql },
  ])));
}

const currentStoryPrivacySignature = expectedSchemaSignature([
  [storyPrivacyTableNames[0], storyPrivacyCandidatesStatement],
  [storyPrivacyTableNames[1], storyPrivacyAuthoritiesStatement],
  [storyPrivacyTableNames[2], storyPrivacyTargetsStatement],
]);
const legacyStoryPrivacySignature = expectedSchemaSignature([
  [storyPrivacyTableNames[0], legacyStoryPrivacyCandidatesStatement],
  [storyPrivacyTableNames[1], legacyStoryPrivacyAuthoritiesStatement],
]);
const legacyWithEmptyTargetSignature = expectedSchemaSignature([
  [storyPrivacyTableNames[0], legacyStoryPrivacyCandidatesStatement],
  [storyPrivacyTableNames[1], legacyStoryPrivacyAuthoritiesStatement],
  [storyPrivacyTableNames[2], storyPrivacyTargetsStatement],
]);

function storyPrivacySchemaError() {
  return new Error(STORY_PRIVACY_SCHEMA_REFRESH_REQUIRED);
}

function storyPrivacySchemaState(database: DatabaseSync): StoryPrivacySchemaState {
  const artifacts = database.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
    WHERE lower(name) GLOB 'story_privacy_*' OR lower(tbl_name) GLOB 'story_privacy_*'
    ORDER BY type,name`).all() as unknown as SchemaArtifact[];
  if (artifacts.length === 0) return "fresh";
  const signature = schemaSignature(artifacts);
  if (signature === currentStoryPrivacySignature) return "current";
  if (signature === legacyStoryPrivacySignature) return "legacy";
  if (signature === legacyWithEmptyTargetSignature) {
    const row = database.prepare("SELECT COUNT(*) AS count FROM story_privacy_targets").get() as
      | { count?: number | bigint }
      | undefined;
    if (Number(row?.count) === 0) return "legacy";
  }
  throw storyPrivacySchemaError();
}

function refreshLegacyStoryPrivacySchema(database: DatabaseSync) {
  let transactionOpen = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    if (storyPrivacySchemaState(database) === "legacy") {
      database.exec(`DELETE FROM project_release_confirmations
        WHERE workflow_run_id IN (
          SELECT workflow_run_id FROM story_privacy_candidates
          UNION
          SELECT workflow_run_id FROM story_privacy_authorities
          UNION
          SELECT workflow_run_id FROM story_preparation_receipts WHERE lane='story_privacy'
        );
        DELETE FROM story_preparation_receipts
        WHERE lane='story_privacy' AND workflow_run_id IN (
          SELECT workflow_run_id FROM story_privacy_candidates
          UNION
          SELECT workflow_run_id FROM story_privacy_authorities
          UNION
          SELECT workflow_run_id FROM story_preparation_receipts WHERE lane='story_privacy'
        );
        DROP TABLE IF EXISTS story_privacy_targets;
        DROP TABLE story_privacy_authorities;
        DROP TABLE story_privacy_candidates`);
      database.exec([
        storyPrivacyCandidatesStatement,
        storyPrivacyAuthoritiesStatement,
        storyPrivacyTargetsStatement,
      ].join(";\n"));
      if (storyPrivacySchemaState(database) !== "current") throw storyPrivacySchemaError();
    }
    database.exec("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try { database.exec("ROLLBACK"); } catch { /* preserve the initiating failure */ }
    }
    throw error;
  }
}

type Row = Record<string, unknown>;
type StatementResult = { success: true; meta: { changes: number }; results?: Row[] };

const ordinaryRow = <T>(row: Row): T => ({ ...row }) as T;

class LocalStatement {
  private values: unknown[] = [];
  private readonly statement: StatementSync;
  private readonly schedule: <T>(operation: () => T) => Promise<T>;

  constructor(statement: StatementSync, schedule: <T>(operation: () => T) => Promise<T>) {
    this.statement = statement;
    this.schedule = schedule;
  }

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T = Row>(): Promise<T | null> {
    return this.schedule(() => {
      const row = this.statement.get(...(this.values as never[])) as Row | undefined;
      return row ? ordinaryRow<T>(row) : null;
    });
  }

  async all<T = Row>(): Promise<{ results: T[] }> {
    return this.schedule(() => ({
      results: this.statement.all(...(this.values as never[])).map(ordinaryRow<T>),
    }));
  }

  async run() {
    return this.schedule(() => this.runSync());
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
  private readonly transactionContext = new AsyncLocalStorage<boolean>();
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  prepare(sql: string) {
    return new LocalStatement(this.database.prepare(sql), (operation) => this.serialized(operation));
  }

  async batch(statements: LocalStatement[]) {
    if (this.transactionContext.getStore()) {
      return statements.map((statement) => statement.execute());
    }
    return this.exclusive(async () => {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => statement.execute());
        this.database.exec("COMMIT");
        return results;
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async transaction<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.transactionContext.getStore()) return operation();
    return this.exclusive(async () => {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const value = await this.transactionContext.run(true, operation);
        this.database.exec("COMMIT");
        return value;
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.transactionTail;
    let release = () => {};
    this.transactionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  private serialized<T>(operation: () => T): Promise<T> {
    if (this.transactionContext.getStore()) return Promise.resolve(operation());
    return this.exclusive(async () => operation());
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
  try {
    refreshLegacyStoryPrivacySchema(database);
    database.exec(statements.join(";\n"));
    runtime.__oxygenLocalSqlite = new LocalDatabase(database);
    return runtime.__oxygenLocalSqlite;
  } catch (error) {
    database.close();
    throw error;
  }
}
