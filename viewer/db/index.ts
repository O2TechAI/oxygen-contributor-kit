import { env } from "cloudflare:workers";

let initialized = false;
let initialization: Promise<void> | null = null;

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
  // untouched original -- the tag is applied at render time so a reviewer can
  // still edit or delete the decision.
  `CREATE TABLE IF NOT EXISTS redactions (
    id TEXT PRIMARY KEY, item_id TEXT NOT NULL, document_id TEXT NOT NULL,
    start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
    category TEXT NOT NULL, confidence TEXT, reason TEXT,
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

export async function getD1() {
  if (!env.DB) throw new Error("D1 binding DB is unavailable");
  if (!initialized) {
    initialization ??= (async () => {
      await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
      const columns = await env.DB.prepare("PRAGMA table_info(redaction_jobs)")
        .all<{ name: string }>();
      if (!columns.results.some((column: { name: string }) => column.name === "source_digest")) {
        await env.DB.prepare("ALTER TABLE redaction_jobs ADD COLUMN source_digest TEXT").run();
      }
      const probeColumns = await env.DB.prepare("PRAGMA table_info(probes)")
        .all<{ name: string }>();
      if (!probeColumns.results.some((column: { name: string }) => column.name === "presentations_json")) {
        await env.DB.prepare("ALTER TABLE probes ADD COLUMN presentations_json TEXT NOT NULL DEFAULT '{}'").run();
      }
      const bulkColumns = await env.DB.prepare("PRAGMA table_info(probe_bulk_decisions)")
        .all<{ name: string }>();
      if (!bulkColumns.results.some((column: { name: string }) => column.name === "presentations_json")) {
        await env.DB.prepare("ALTER TABLE probe_bulk_decisions ADD COLUMN presentations_json TEXT NOT NULL DEFAULT '{}'").run();
      }
      const workflowColumns = await env.DB.prepare("PRAGMA table_info(workflow_runs)")
        .all<{ name: string }>();
      const workflowNames = new Set(workflowColumns.results.map((column: { name: string }) => column.name));
      const workflowMigrations = [
        ["story_generation_status", "ALTER TABLE workflow_runs ADD COLUMN story_generation_status TEXT NOT NULL DEFAULT 'not_started'"],
        ["story_generation_completed", "ALTER TABLE workflow_runs ADD COLUMN story_generation_completed INTEGER NOT NULL DEFAULT 0"],
        ["story_generation_total", "ALTER TABLE workflow_runs ADD COLUMN story_generation_total INTEGER NOT NULL DEFAULT 0"],
        ["story_source_revision", "ALTER TABLE workflow_runs ADD COLUMN story_source_revision INTEGER NOT NULL DEFAULT 0"],
        ["active_story_digest", "ALTER TABLE workflow_runs ADD COLUMN active_story_digest TEXT"],
      ] as const;
      for (const [name, sql] of workflowMigrations) {
        if (!workflowNames.has(name)) await env.DB.prepare(sql).run();
      }
      const sessionColumns = await env.DB.prepare("PRAGMA table_info(story_review_sessions)")
        .all<{ name: string }>();
      if (!sessionColumns.results.some((column: { name: string }) => column.name === "server_version")) {
        await env.DB.prepare(
          "ALTER TABLE story_review_sessions ADD COLUMN server_version INTEGER NOT NULL DEFAULT 0",
        ).run();
      }
      initialized = true;
    })().catch((error) => {
      initialization = null;
      throw error;
    });
    await initialization;
  }
  return env.DB;
}
