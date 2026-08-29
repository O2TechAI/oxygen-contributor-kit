import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  canonicalAuthorityJson,
  finalizeCoverageManifestAuthority,
  validateSemanticManifestAuthority,
} from "../lib/story-readiness.ts";
import { computeSourceDigest } from "../lib/redaction-pass.mjs";
import { startWorkflowPolling } from "../lib/workflow-progress.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL && specifier.startsWith(".")) {
      const path = fileURLToPath(new URL(specifier, context.parentURL));
      if (!extname(path)) {
        if (existsSync(`${path}.ts`)) return nextResolve(`${specifier}.ts`, context);
        if (existsSync(join(path, "index.ts"))) return nextResolve(`${specifier}/index.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const {
  coveragePrivacyAuthorityGuardStatement,
  readCoveragePrivacyAuthority,
} = await import("../lib/story-coverage-privacy-authority.ts");

const sha256 = async (value) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
const utf8 = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));

test("24,796-item Coverage Privacy authority is indexed, bounded, and passive-poll safe",
  { timeout: 120_000 }, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "oxygen-coverage-privacy-scale-"));
    const previousStateDir = process.env.OXYGEN_VIEWER_STATE_DIR;
    process.env.OXYGEN_VIEWER_STATE_DIR = stateDir;
    const runId = "coverage-privacy-scale-run";
    const now = "2045-01-01T00:00:00.000Z";
    const itemCount = 24_796;
    const unitCount = 512;
    try {
      const { getLocalDatabase } = await import("../db/index.ts");
      const db = await getLocalDatabase();
      const records = Array.from({ length: itemCount }, (_, index) => ({
        id: `scale:item-${String(index).padStart(5, "0")}`,
        sourceDigest: (index + 1).toString(16).padStart(64, "0"),
      }));
      const universe = records.map((record) => record.id);
      const groups = Array.from({ length: unitCount }, () => []);
      records.forEach((record, index) => groups[index % unitCount].push(record));
      const units = [];
      for (const [index, group] of groups.entries()) {
        units.push({
          id: `unit-${String(index).padStart(3, "0")}`,
          revision: 1,
          projectId: "scale-project",
          kind: "discussion",
          members: group.map((record) => record.id).sort(utf8),
          memberCount: group.length,
          membershipDigest: await sha256(canonicalAuthorityJson(group.sort((left, right) => (
            utf8(left.id, right.id)
          )))),
        });
      }
      const semanticCore = {
        projectId: "scale-project",
        revision: 1,
        sourceDigest: await sha256(canonicalAuthorityJson(records)),
        universeDigest: await sha256(canonicalAuthorityJson(universe)),
        units,
      };
      const semanticValidation = await validateSemanticManifestAuthority({
        ...semanticCore,
        manifestDigest: await sha256(canonicalAuthorityJson(semanticCore)),
      }, records);
      assert.equal(semanticValidation.ok, true, semanticValidation.code);
      const semantic = semanticValidation.authority;
      const coverageValidation = await finalizeCoverageManifestAuthority({
        rows: units.map((unit) => ({
          unitId: unit.id,
          disposition: "represented",
          ownerId: `owner-${unit.id}`,
        })),
      }, semantic);
      assert.equal(coverageValidation.ok, true, coverageValidation.code);
      const coverage = coverageValidation.authority;

      await db.prepare(`INSERT INTO documents
        (id,kind,title,item_count,imported_at,updated_at)
        VALUES ('scale-doc','synthetic','Scale document',?,?,?)`)
        .bind(itemCount, now, now).run();
      await db.prepare(`INSERT INTO workflow_runs
        (id,story_generation_status,story_source_revision,created_at,updated_at)
        VALUES (?,'source_writing_generation',1,?,?)`).bind(runId, now, now).run();
      await db.prepare(`INSERT INTO finalized_corpus_manifests
        (workflow_run_id,corpus_revision,corpus_digest,document_count,item_count,finalized_at)
        VALUES (?,1,?,1,?,?)`).bind(runId, "c".repeat(64), itemCount, now).run();
      await db.prepare(`INSERT INTO semantic_manifests
        (workflow_run_id,project_id,revision,source_revision,source_digest,universe_digest,
         manifest_digest,unit_count,serialized_bytes,story_projection_bytes,corpus_revision,
         corpus_digest,corpus_document_count,corpus_item_count,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,1,?,1,?,?,?)`).bind(
        runId, semantic.projectId, semantic.revision, 1, semantic.sourceDigest,
        semantic.universeDigest, semantic.manifestDigest, unitCount, semantic.serializedBytes,
        semanticValidation.storyProjectionBytes, "c".repeat(64), itemCount, now, now,
      ).run();
      await db.prepare(`INSERT INTO story_coverage_manifests
        (workflow_run_id,revision,semantic_manifest_revision,semantic_manifest_digest,
         coverage_digest,privacy_authority_digest,unit_count,serialized_bytes,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
        runId, coverage.revision, coverage.semanticManifestRevision,
        coverage.semanticManifestDigest, coverage.coverageDigest, "0".repeat(64),
        coverage.rows.length, coverage.serializedBytes, now, now,
      ).run();
      await db.transaction(async () => {
        for (const unit of units) {
          await db.prepare(`INSERT INTO semantic_units
            (id,workflow_run_id,revision,project_id,kind,member_count,membership_digest,
             duplicate_of_unit_id,story_projection_json) VALUES (?,?,?,?,?,?,?,NULL,'{}')`).bind(
            unit.id, runId, 1, unit.projectId, unit.kind, unit.memberCount, unit.membershipDigest,
          ).run();
          await db.prepare(`INSERT INTO story_coverage_rows
            (unit_id,workflow_run_id,disposition,owner_id,exclusion_reason)
            VALUES (?,?,'represented',?,NULL)`).bind(
            unit.id, runId, `owner-${unit.id}`,
          ).run();
        }
        const unitByItem = new Map(units.flatMap((unit) => unit.members.map((id) => [id, unit.id])));
        for (const [index, record] of records.entries()) {
          await db.prepare(`INSERT INTO items
            (id,document_id,sequence,event_type,actor_type,content,original_json)
            VALUES (?,'scale-doc',?,'message','system','x','{}')`).bind(record.id, index).run();
          await db.prepare(`INSERT INTO semantic_unit_members
            (item_id,workflow_run_id,unit_id,source_digest) VALUES (?,?,?,?)`).bind(
            record.id, runId, unitByItem.get(record.id), record.sourceDigest,
          ).run();
        }
      });
      const sourceRows = records.map((record, index) => ({
        id: record.id,
        document_id: "scale-doc",
        sequence: index,
        event_type: "message",
        actor_type: "system",
        timestamp: null,
        content: "x",
      }));
      await db.prepare(`INSERT INTO redaction_jobs
        (id,status,stage,model,completed,total,rejected,source_digest,started_at,updated_at,completed_at)
        VALUES ('scale-privacy','complete','privacy',NULL,0,0,0,?,?,?,?)`).bind(
        await computeSourceDigest(sourceRows), now, now, now,
      ).run();

      const realPrepare = db.prepare.bind(db);
      const realBatch = db.batch.bind(db);
      const counts = { queries: 0, contentQueries: 0, batches: 0 };
      db.prepare = (sql) => {
        counts.queries += 1;
        if (/SELECT id,document_id,sequence,event_type,actor_type,timestamp,content,/u.test(sql)) {
          counts.contentQueries += 1;
        }
        return realPrepare(sql);
      };
      db.batch = async (statements) => {
        counts.batches += 1;
        return realBatch(statements);
      };
      const fullStarted = performance.now();
      const full = await readCoveragePrivacyAuthority(db, runId, semantic);
      const fullRuntimeMs = performance.now() - fullStarted;
      assert.equal(full.ok, true);
      const fullCounts = { ...counts };
      await realPrepare(`UPDATE story_coverage_manifests SET privacy_authority_digest=?
        WHERE workflow_run_id=?`).bind(full.authority.snapshotDigest, runId).run();

      counts.queries = 0;
      counts.contentQueries = 0;
      counts.batches = 0;
      const passiveStarted = performance.now();
      const passive = await readCoveragePrivacyAuthority(
        db,
        runId,
        semantic,
        { verifyCurrentSource: false },
      );
      const passiveRuntimeMs = performance.now() - passiveStarted;
      assert.equal(passive.ok, true);
      assert.equal(passive.authority.snapshotDigest, full.authority.snapshotDigest);
      assert.equal(counts.contentQueries, 0);
      assert.equal(counts.batches, 0);
      const passiveCounts = { ...counts };

      await realPrepare(`INSERT INTO organization_jobs
        (id,status,stage,completed,total,warnings_json,started_at,updated_at,completed_at)
        VALUES ('scale-unrelated','complete','done',0,0,'[]',?,?,?)`)
        .bind(now, now, now).run();
      const guarded = await readCoveragePrivacyAuthority(db, runId, semantic);
      assert.equal(guarded.ok, true);
      counts.batches = 0;
      await db.batch([coveragePrivacyAuthorityGuardStatement(db, guarded.authority)]);
      assert.equal(counts.batches, 1, "the exact guard is one short batch after an unrelated write");

      const scheduled = [];
      let releasePoll;
      const delayed = new Promise((resolve) => { releasePoll = resolve; });
      let inFlight = 0;
      let maximumInFlight = 0;
      const polling = startWorkflowPolling(async () => {
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        await delayed;
        inFlight -= 1;
      }, {
        intervalMs: 2_000,
        schedule: (callback) => { scheduled.push(callback); return callback; },
        cancel: (handle) => {
          const index = scheduled.indexOf(handle);
          if (index >= 0) scheduled.splice(index, 1);
        },
      });
      scheduled.shift()();
      await Promise.resolve();
      assert.equal(scheduled.length, 0);
      releasePoll();
      await new Promise((resolve) => setImmediate(resolve));
      polling.retire();
      assert.equal(maximumInFlight, 1);

      const source = await readFile(new URL("../lib/story-coverage-privacy-authority.ts", import.meta.url), "utf8");
      assert.doesNotMatch(source, /memberResult\.results\.find|total_changes/u);
      assert.ok(fullRuntimeMs < 30_000);
      assert.ok(passiveRuntimeMs < 10_000);
      console.log("COVERAGE_PRIVACY_SCALE", JSON.stringify({
        itemCount,
        unitCount,
        fullRuntimeMs: Number(fullRuntimeMs.toFixed(2)),
        passiveRuntimeMs: Number(passiveRuntimeMs.toFixed(2)),
        full: fullCounts,
        passive: passiveCounts,
        guardBatches: counts.batches,
        maximumConcurrentWorkflowPolls: maximumInFlight,
        privateContentPrinted: false,
      }));
    } finally {
      globalThis.__oxygenLocalSqlite?.database.close();
      delete globalThis.__oxygenLocalSqlite;
      if (previousStateDir === undefined) delete process.env.OXYGEN_VIEWER_STATE_DIR;
      else process.env.OXYGEN_VIEWER_STATE_DIR = previousStateDir;
      await rm(stateDir, { recursive: true, force: true });
    }
  });
