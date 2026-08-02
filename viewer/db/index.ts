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
];

export async function getD1() {
  if (!env.DB) throw new Error("D1 binding DB is unavailable");
  if (!initialized) {
    await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
    initialized = true;
  }
  return env.DB;
}
