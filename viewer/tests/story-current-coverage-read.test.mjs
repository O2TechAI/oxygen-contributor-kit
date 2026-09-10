import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { extname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL && specifier.startsWith(".")) {
    const path = fileURLToPath(new URL(specifier, context.parentURL));
    if (!extname(path)) {
      if (existsSync(`${path}.ts`)) return nextResolve(`${specifier}.ts`, context);
      if (existsSync(join(path, "index.ts"))) return nextResolve(`${specifier}/index.ts`, context);
    }
  }
  return nextResolve(specifier, context);
} });

const { getLocalDatabase } = await import("../db/index.ts");
const { seedChapterPrivacy } = await import("./fixtures/chapter-privacy.mjs");
const { readReservedStoryCandidateRows, readSemanticManifestAuthority, readCoverageManifestAuthority,
  validateCurrentStorySourcePackage } = await import("../lib/story-readiness.ts");
const { readCoveragePrivacyAuthority } = await import("../lib/story-coverage-privacy-authority.ts");
const { buildSourcePrivacyReceipt, installSourcePrivacyReceipt } = await import("./fixtures/source-privacy-receipt.mjs");
const decisionRoute = await import("../app/api/redactions/[id]/route.ts");

async function withFixture(interactive, operation) {
  const previous = process.env.OXYGEN_VIEWER_STATE_DIR;
  delete process.env.OXYGEN_VIEWER_STATE_DIR;
  const db = await getLocalDatabase();
  try {
    const fixture = await seedChapterPrivacy(db, { interactive, badSecondChapter: false });
    const candidates = await readReservedStoryCandidateRows(db);
    const evidence = (await db.prepare(`SELECT id,document_id AS documentId,event_type AS eventType,
      actor_id AS actorId,actor_type AS actorType FROM items ORDER BY document_id,sequence`).all()).results;
    await operation({ db, fixture, candidates, evidence });
  } finally {
    db.database.close();
    delete globalThis.__oxygenLocalSqlite;
    if (previous === undefined) delete process.env.OXYGEN_VIEWER_STATE_DIR;
    else process.env.OXYGEN_VIEWER_STATE_DIR = previous;
  }
}

async function countedValidation({ db, fixture, candidates, evidence }, options) {
  const original = db.prepare.bind(db), sql = [];
  db.prepare = (query) => { sql.push(query); return original(query); };
  try {
    const result = await validateCurrentStorySourcePackage(db, fixture.run, candidates, evidence, options);
    return { result,
      privacyReads: sql.filter((query) => query.startsWith("SELECT r.id AS workflow_run_id")).length,
      sourceReads: sql.filter((query) => query.includes("d.kind AS document_kind")).length,
      semanticReads: sql.filter((query) => query.startsWith("SELECT 1 AS current FROM semantic_manifests")).length };
  } finally { db.prepare = original; }
}

test("one fresh Privacy read supplies both Coverage and current Insight narrative without public proof fields", async () => {
  await withFixture(true, async (context) => {
    const forged = "A caller-supplied narrative cannot ground the quote.";
    context.evidence = context.evidence.map((row) => ({ ...row, reviewedNarrative: forged }));
    const checked = await countedValidation(context, { verifyCurrentSource: false });
    assert.equal(checked.result.ok, true, JSON.stringify(checked.result));
    assert.deepEqual(Object.keys(checked.result).sort(), ["canonicalCandidate", "chapterCount", "ok"]);
    assert.equal(checked.privacyReads, 1);
    assert.equal(checked.sourceReads, 1, "Insights still force a full current-source read");
    assert.equal(checked.semanticReads, 2, "the initial and current semantic checks both remain");
    context.candidates = context.candidates.map((row) => {
      const story = JSON.parse(row.summary.slice("oxygen.story:".length));
      for (const insight of story.insights) insight.quote.text = forged;
      return { ...row, summary: `oxygen.story:${JSON.stringify(story)}` };
    });
    assert.deepEqual((await countedValidation(context, {})).result,
      { ok: false, code: "STORY_INSIGHT_GROUNDING_INVALID" });
  });
});

test("deep and passive no-Insight reads each check one Privacy snapshot and preserve expected-digest compatibility", async () => {
  await withFixture(false, async (context) => {
    for (const verifyCurrentSource of [true, false]) {
      const checked = await countedValidation(context, { verifyCurrentSource });
      assert.equal(checked.result.ok, true, JSON.stringify(checked.result));
      assert.equal(checked.privacyReads, 1);
      assert.equal(checked.sourceReads, verifyCurrentSource ? 1 : 0);
      assert.equal(checked.semanticReads, 2);
    }
    const { db, fixture } = context;
    const semantic = await readSemanticManifestAuthority(db, fixture.run);
    const row = await db.prepare("SELECT privacy_authority_digest FROM story_coverage_manifests").first();
    const coverage = await readCoverageManifestAuthority(db, fixture.run, semantic,
      { expectedPrivacyAuthorityDigest: row.privacy_authority_digest });
    assert.ok(coverage);
    assert.equal(Object.hasOwn(coverage, "privacyAuthority"), false);
    assert.equal(await readCoverageManifestAuthority(db, fixture.run, semantic,
      { expectedPrivacyAuthorityDigest: "0".repeat(64) }), null);
  });
});

test("current source, receipt, semantic and Coverage failures retain their existing precedence", async () => {
  const mutations = [
    ["UPDATE items SET content=content||' changed' WHERE id='synthetic-a'", "STORY_INSIGHT_GROUNDING_INVALID"],
    ["UPDATE items SET original_json='{\"payload\":{\"role\":\"user\"}}' WHERE id='synthetic-a'", "STORY_INSIGHT_GROUNDING_INVALID"],
    ["UPDATE documents SET kind='meeting'", "STORY_INSIGHT_GROUNDING_INVALID"],
    ["UPDATE source_privacy_receipts SET receipt_json=receipt_json||' '", "STORY_INSIGHT_GROUNDING_INVALID"],
    ["UPDATE semantic_unit_members SET source_digest='broken' WHERE item_id='synthetic-a'", "STORY_SEMANTIC_AUTHORITY_STALE"],
    ["UPDATE story_coverage_manifests SET privacy_authority_digest='broken'", "STORY_COVERAGE_INVALID"],
  ];
  for (const [sql, code] of mutations) await withFixture(false, async (context) => {
    await context.db.prepare(sql).run();
    assert.deepEqual((await countedValidation(context, {})).result, { ok: false, code });
  });
  await withFixture(false, async (context) => {
    await context.db.prepare("UPDATE source_privacy_receipts SET receipt_json=receipt_json||' '").run();
    await context.db.prepare("UPDATE story_coverage_manifests SET privacy_authority_digest='broken'").run();
    assert.deepEqual((await countedValidation(context, {})).result,
      { ok: false, code: "STORY_INSIGHT_GROUNDING_INVALID" });
    assert.deepEqual((await countedValidation(context, { verifyCurrentSource: false })).result,
      { ok: false, code: "STORY_COVERAGE_INVALID" });
  });
});

test("Source PATCH still validates original envelopes and document kinds after writing and rolls back", async () => {
  for (const mutation of [
    "UPDATE items SET original_json='{\"payload\":{\"role\":\"user\"}}' WHERE id='synthetic-a';",
    "UPDATE documents SET kind='meeting';",
  ]) await withFixture(false, async ({ db, fixture }) => {
    const span = { itemId: "synthetic-a", documentId: "synthetic-source", startOffset: 0, endOffset: 3,
      category: "sensitive", confidence: "high", reason: "Synthetic test finding.",
      reviewState: "needs_confirmation", uncertaintyReason: "Synthetic pending decision.", createdBy: "llm" };
    await db.prepare(`INSERT INTO redactions (id,item_id,document_id,start_offset,end_offset,category,
      confidence,reason,review_state,uncertainty_reason,status,created_by,created_at,updated_at)
      VALUES ('pending-source',?,?,?,?,?,?,?,?,?,'active','llm',?,?)`).bind(span.itemId, span.documentId,
      span.startOffset, span.endOffset, span.category, span.confidence, span.reason, span.reviewState,
      span.uncertaintyReason, fixture.now, fixture.now).run();
    await db.prepare("UPDATE redaction_jobs SET completed=1,total=1").run();
    const receipt = await buildSourcePrivacyReceipt(db, { workflowRunId: fixture.run,
      sourceRevision: fixture.sourceRevision, redactions: [span] });
    const job = await db.prepare("SELECT id FROM redaction_jobs").first();
    await db.prepare("DELETE FROM source_privacy_receipts").run();
    await installSourcePrivacyReceipt(db, { jobId: job.id, workflowRunId: fixture.run, receipt, at: fixture.now });
    const semantic = await readSemanticManifestAuthority(db, fixture.run);
    const privacy = await readCoveragePrivacyAuthority(db, fixture.run, semantic);
    assert.equal(privacy.ok, true);
    await db.prepare("UPDATE story_coverage_manifests SET privacy_authority_digest=?")
      .bind(privacy.authority.snapshotDigest).run();
    const tables = ["items", "documents", "redactions", "source_privacy_receipts", "workflow_runs",
      "semantic_manifests", "semantic_units", "semantic_unit_members", "story_coverage_manifests",
      "story_coverage_rows", "story_review_sessions", "story_privacy_targets", "project_release_confirmations"];
    const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async (table) =>
      [table, (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results])));
    const before = await snapshot();
    await db.prepare(`CREATE TRIGGER change_dialogue AFTER UPDATE OF review_state ON redactions
      BEGIN ${mutation} END`).run();
    const response = await decisionRoute.PATCH(new Request("http://synthetic.invalid/api/redactions/pending-source", {
      method: "PATCH", body: JSON.stringify({ decision: "keep" }),
    }), { params: Promise.resolve({ id: "pending-source" }) });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "Source Privacy decision conflicted", code: "SOURCE_PRIVACY_MUTATION_CONFLICT" });
    assert.deepEqual(await snapshot(), before);
  });
});
