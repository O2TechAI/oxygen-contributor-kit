import test from "node:test";
import assert from "node:assert/strict";
import { buildPackageFromDatabase } from "../app/api/package/route.ts";
import { computeSourceDigest } from "../lib/redaction-pass.mjs";

const PRIVATE_NON_STORY_EVENT_SENTINEL = "PRIVATE_NON_STORY_EVENT_SENTINEL";
const FIXED_EXPORT_TIME = "2026-08-26T00:00:00.000Z";

class FakePackageDb {
  constructor({ redactions = [] } = {}) {
    this.documents = [{
      id: "document-source",
      kind: "trajectory",
      title: "Synthetic source",
      source_system: "local-agent-history",
      source_timestamp: "2026-08-25T00:00:00.000Z",
      item_count: 1,
      metadata_json: "{}",
      formatted_summary_json: "{}",
    }];
    this.items = [{
      id: "document-source:event-1",
      document_id: "document-source",
      sequence: 1,
      event_type: "message",
      actor_type: "user",
      timestamp: "2026-08-25T00:00:00.000Z",
      content: PRIVATE_NON_STORY_EVENT_SENTINEL,
      organization_category: "Unclassified",
      organization_confidence: 100,
      organization_reason: "Ordinary non-Story progress event",
    }];
    this.redactions = redactions;
    this.probes = [];
    this.bulk = [];
    this.probeRuns = [];
    this.redactionJob = null;
  }

  async initialize() {
    this.redactionJob = {
      id: "redaction-job",
      status: "complete",
      stage: "complete",
      completed: this.redactions.length,
      total: this.redactions.length,
      rejected: 0,
      source_digest: await computeSourceDigest(this.items),
      started_at: "2026-08-25T00:00:01.000Z",
      updated_at: "2026-08-25T00:00:02.000Z",
      completed_at: "2026-08-25T00:00:02.000Z",
    };
    return this;
  }

  prepare(sql) {
    return {
      all: async () => {
        if (/FROM redaction_jobs/.test(sql)) {
          return { results: this.redactionJob ? [structuredClone(this.redactionJob)] : [] };
        }
        if (/FROM documents/.test(sql)) return { results: structuredClone(this.documents) };
        if (/FROM items/.test(sql)) return { results: structuredClone(this.items) };
        if (/FROM redactions/.test(sql)) return { results: structuredClone(this.redactions) };
        if (/FROM probe_bulk_decisions/.test(sql)) return { results: structuredClone(this.bulk) };
        if (/FROM probe_runs/.test(sql)) return { results: structuredClone(this.probeRuns) };
        if (/FROM probes/.test(sql)) return { results: structuredClone(this.probes) };
        throw new Error(`Unexpected package snapshot SQL: ${sql}`);
      },
    };
  }

  batch(statements) {
    return Promise.all(statements.map((statement) => statement.all()));
  }
}

const activeSentinelRedaction = () => ({
  id: "sentinel-redaction",
  item_id: "document-source:event-1",
  document_id: "document-source",
  start_offset: 0,
  end_offset: PRIVATE_NON_STORY_EVENT_SENTINEL.length,
  category: "sensitive",
  confidence: "high",
  reason: "Synthetic concurrency coverage",
  review_state: "confirmed_redact",
  uncertainty_reason: null,
  status: "active",
  created_by: "contributor",
  created_at: "2026-08-25T00:00:03.000Z",
  updated_at: "2026-08-25T00:00:03.000Z",
});

test("non-Story Privacy mutation during package assembly fails closed without returning stale bytes", async () => {
  const db = await new FakePackageDb().initialize();
  const response = await buildPackageFromDatabase(db, undefined, undefined, {
    exportedAt: FIXED_EXPORT_TIME,
    beforeFinalPrivacyCheck: () => {
      db.redactions = [activeSentinelRedaction()];
    },
  });
  assert.equal(response.status, 409);
  const body = await response.text();
  assert.match(body, /RELEASE_PRIVACY_CONFLICT/);
  assert.doesNotMatch(body, new RegExp(PRIVATE_NON_STORY_EVENT_SENTINEL));
});

test("unchanged Privacy produces stable redacted package bytes", async () => {
  const db = await new FakePackageDb({ redactions: [activeSentinelRedaction()] }).initialize();
  const first = await buildPackageFromDatabase(db, undefined, undefined, { exportedAt: FIXED_EXPORT_TIME });
  const second = await buildPackageFromDatabase(db, undefined, undefined, { exportedAt: FIXED_EXPORT_TIME });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const firstBytes = new Uint8Array(await first.arrayBuffer());
  const secondBytes = new Uint8Array(await second.arrayBuffer());
  assert.deepEqual(secondBytes, firstBytes);
  const visibleArchiveText = new TextDecoder().decode(firstBytes);
  assert.doesNotMatch(visibleArchiveText, new RegExp(PRIVATE_NON_STORY_EVENT_SENTINEL));
  assert.match(visibleArchiveText, /<redacted category=\\"sensitive\\"\/>/);
});
