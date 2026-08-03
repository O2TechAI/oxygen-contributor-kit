import { env } from "cloudflare:workers";

let initialized = false;

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
    options_json TEXT NOT NULL DEFAULT '[]',
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
    await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
    initialized = true;
  }
  return env.DB;
}
