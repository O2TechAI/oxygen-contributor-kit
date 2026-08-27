import test from "node:test";
import assert from "node:assert/strict";
import { computeSourceDigest } from "../lib/redaction-pass.mjs";
import { capturePackageReleasePrivacySnapshot } from "../lib/release-privacy-snapshot.ts";

const PRIVATE = "PRIVATE_NON_STORY_EVENT_SENTINEL";

class FakePackageDb {
  constructor(redactions = []) {
    this.documents = [{
      id: "document-source", kind: "trajectory", title: "Synthetic source",
      source_system: "local-agent-history", source_timestamp: "2026-08-25T00:00:00.000Z",
      item_count: 1, metadata_json: "{}", formatted_summary_json: "{}",
    }];
    this.items = [{
      id: "document-source:event-1", document_id: "document-source", sequence: 1,
      event_type: "message", actor_type: "user", timestamp: "2026-08-25T00:00:00.000Z",
      content: PRIVATE, organization_category: "Unclassified", organization_confidence: 100,
      organization_reason: "Ordinary progress event",
    }];
    this.redactions = redactions;
    this.probes = [];
    this.bulk = [];
    this.probeRuns = [];
  }

  async initialize() {
    this.redactionJob = {
      id: "redaction-job", status: "complete", stage: "complete",
      completed: this.redactions.length, total: this.redactions.length, rejected: 0,
      source_digest: await computeSourceDigest(this.items),
      started_at: "2026-08-25T00:00:01.000Z", updated_at: "2026-08-25T00:00:02.000Z",
      completed_at: "2026-08-25T00:00:02.000Z",
    };
    return this;
  }

  prepare(sql) {
    return { all: async () => {
      if (/FROM redaction_jobs/.test(sql)) return { results: [structuredClone(this.redactionJob)] };
      if (/FROM documents/.test(sql)) return { results: structuredClone(this.documents) };
      if (/FROM items/.test(sql)) return { results: structuredClone(this.items) };
      if (/FROM redactions/.test(sql)) return { results: structuredClone(this.redactions) };
      if (/FROM probe_bulk_decisions/.test(sql)) return { results: structuredClone(this.bulk) };
      if (/FROM probe_runs/.test(sql)) return { results: structuredClone(this.probeRuns) };
      if (/FROM probes/.test(sql)) return { results: structuredClone(this.probes) };
      throw new Error(`Unexpected package snapshot SQL: ${sql}`);
    } };
  }

  batch(statements) { return Promise.all(statements.map((statement) => statement.all())); }
}

const activeRedaction = () => ({
  id: "sentinel-redaction", item_id: "document-source:event-1", document_id: "document-source",
  start_offset: 0, end_offset: PRIVATE.length, category: "sensitive", confidence: "high",
  reason: "Synthetic concurrency coverage", review_state: "confirmed_redact",
  uncertainty_reason: null, status: "active", created_by: "contributor",
  created_at: "2026-08-25T00:00:03.000Z", updated_at: "2026-08-25T00:00:03.000Z",
});

test("package snapshot digest binds non-Story Privacy mutation", async () => {
  const db = await new FakePackageDb().initialize();
  const before = await capturePackageReleasePrivacySnapshot(db);
  db.redactions = [activeRedaction()];
  const after = await capturePackageReleasePrivacySnapshot(db);
  assert.notEqual(after.digest, before.digest);
});

test("unchanged package authority produces a stable digest", async () => {
  const db = await new FakePackageDb([activeRedaction()]).initialize();
  const first = await capturePackageReleasePrivacySnapshot(db);
  const second = await capturePackageReleasePrivacySnapshot(db);
  assert.equal(second.digest, first.digest);
  assert.equal(first.redactionRows.length, 1);
});
