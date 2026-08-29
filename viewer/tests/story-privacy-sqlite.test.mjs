import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { storyPreparationDigest } from "../lib/story-preparation.ts";
import { seedCoveragePrivacyAuthority } from "./story-coverage-privacy-fixture.mjs";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL && specifier.startsWith(".")) {
      const resolvedPath = fileURLToPath(new URL(specifier, context.parentURL));
      if (!extname(resolvedPath)) {
        if (existsSync(`${resolvedPath}.ts`)) return nextResolve(`${specifier}.ts`, context);
        if (existsSync(join(resolvedPath, "index.ts"))) return nextResolve(`${specifier}/index.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const RUN_ID = "story-privacy-sqlite-run";
const SOURCE_REVISION = 11;

function story() {
  const evidence = { documentId: "doc", eventId: "event-a" };
  return {
    schema: "oxygen.story",
    key: "chapter-a",
    phase: { id: "phase-a", label: "Build" },
    title: "Chapter A",
    overview: "Overview A.",
    people: [{
      id: "person-a", releaseLabel: "Contributor", role: "Owner",
      description: "Owner A.", localIdentityState: "not_identified", evidence: [evidence],
    }],
    story: { blocks: [{ id: "block-a", text: "Block A.", evidence: [evidence] }] },
    insights: [],
    evidence: { primary: evidence, supporting: [] },
    coverage: {
      semanticManifest: { revision: 1, digest: "5".repeat(64) },
      coverageManifest: { revision: 1, digest: "6".repeat(64) },
      representedUnitIds: [], excludedUnits: [],
    },
  };
}

const SOURCE = story();
let STORY_SUMMARY = `oxygen.story:${JSON.stringify(SOURCE)}`;
let ACTIVE_DIGEST = await storyPreparationDigest([{ id: "event-a", summary: STORY_SUMMARY }]);
let STORY_PRIVACY_INPUT_DIGEST = await storyPreparationDigest([{
  id: "event-a",
  story: SOURCE,
}]);
let MUTATED_STORY_SUMMARY = `oxygen.story:${JSON.stringify({
  ...SOURCE,
  overview: "Changed Story text with the same release targets.",
})}`;

const candidate = {
  id: "same-candidate-id",
  reviewState: "needs_confirmation",
  title: "Current candidate",
  whyFlagged: "Contributor confirmation is required.",
  uncertaintyReason: "The final decision is not known.",
  releaseTargets: ["chapter-a::title"],
};

async function putReceipt(db, candidateValue, revision = SOURCE_REVISION) {
  const digest = await storyPreparationDigest([candidateValue]);
  await db.prepare("DELETE FROM story_preparation_receipts WHERE workflow_run_id=?").bind(RUN_ID).run();
  await db.prepare(`INSERT INTO story_preparation_receipts
    (workflow_run_id,lane,source_revision,input_digest,scope_digest,scope_count,
     output_digest,output_count,completed_at) VALUES (?,'story_privacy',?,?,?,?,?,1,?)`)
    .bind(RUN_ID, revision, STORY_PRIVACY_INPUT_DIGEST, "8".repeat(64), 1,
      digest, "2042-01-01T00:00:00.000Z").run();
  return digest;
}

const requestBody = (candidateDigest, overrides = {}) => ({
  workflowRunId: RUN_ID,
  sourceRevision: SOURCE_REVISION,
  activeStoryDigest: ACTIVE_DIGEST,
  candidateDigest,
  expectedVersion: 0,
  decision: "keep",
  ...overrides,
});

const patch = (route, body) => route.PATCH(new Request(
  "http://localhost/api/story-privacy/same-candidate-id",
  { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
), { params: Promise.resolve({ id: candidate.id }) });

test("fresh SQLite defaults, immutable CAS, replacement reset, and mutation-boundary guards are real", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "oxygen-story-privacy-sqlite-"));
  const previousStateDir = process.env.OXYGEN_VIEWER_STATE_DIR;
  process.env.OXYGEN_VIEWER_STATE_DIR = stateDir;
  try {
    const [{ getLocalDatabase }, candidateRoute, { readStoryPrivacyAuthority }] = await Promise.all([
      import("../db/index.ts"),
      import("../app/api/story-privacy/[id]/route.ts"),
      import("../lib/story-privacy-authority.ts"),
    ]);
    const db = await getLocalDatabase();
    const columns = (await db.prepare("PRAGMA table_info(story_privacy_candidates)").all()).results;
    assert.deepEqual(columns.slice(-3).map((column) => ({
      name: column.name, notnull: column.notnull, default: column.dflt_value,
    })), [
      { name: "decision", notnull: 0, default: null },
      { name: "decision_version", notnull: 1, default: "0" },
      { name: "decided_at", notnull: 0, default: null },
    ]);

    await db.prepare(`INSERT INTO workflow_runs
      (id,story_generation_status,story_source_revision,active_story_digest,created_at,updated_at)
      VALUES (?,'ready_for_human_review',?,?,?,?)`)
      .bind(RUN_ID, SOURCE_REVISION, ACTIVE_DIGEST,
        "2042-01-01T00:00:00.000Z", "2042-01-01T00:00:00.000Z").run();
    await db.prepare(`INSERT INTO items
      (id,document_id,sequence,content,original_json,organization_reason,
       event_type,actor_id,actor_type)
      VALUES ('event-a','doc',0,'source','{}',?,'message','contributor-a','human')`)
      .bind(STORY_SUMMARY).run();
    const seeded = await seedCoveragePrivacyAuthority(db, {
      workflowRunId: RUN_ID,
      sourceRevision: SOURCE_REVISION,
      stories: [SOURCE],
      now: "2042-01-01T00:00:00.000Z",
    });
    ACTIVE_DIGEST = seeded.activeStoryDigest;
    STORY_PRIVACY_INPUT_DIGEST = seeded.storyPrivacyInputDigest;
    STORY_SUMMARY = `oxygen.story:${JSON.stringify(SOURCE)}`;
    MUTATED_STORY_SUMMARY = `oxygen.story:${JSON.stringify({
      ...SOURCE,
      overview: "Changed Story text with the same release targets.",
    })}`;
    let receiptOutputDigest = await putReceipt(db, candidate);

    // This is the unchanged Core activation insert shape.
    await db.prepare(`INSERT INTO story_privacy_candidates
      (workflow_run_id,candidate_id,candidate_json) VALUES (?,?,?)`)
      .bind(RUN_ID, candidate.id, JSON.stringify(candidate)).run();
    let currentAuthority = await readStoryPrivacyAuthority(db, RUN_ID);
    assert.equal(currentAuthority.ok, true);
    let candidateDigest = currentAuthority.authority.candidateDigest;
    assert.deepEqual(await db.prepare(`SELECT decision,decision_version,decided_at
      FROM story_privacy_candidates WHERE candidate_id=?`).bind(candidate.id).first(), {
      decision: null, decision_version: 0, decided_at: null,
    });
    await assert.rejects(
      db.prepare(`UPDATE story_privacy_candidates SET decision='keep',decision_version=0
        WHERE candidate_id=?`).bind(candidate.id).run(),
    );
    await assert.rejects(
      db.prepare(`UPDATE story_privacy_candidates SET decision_version=2
        WHERE candidate_id=?`).bind(candidate.id).run(),
    );

    const concurrent = await Promise.all([
      patch(candidateRoute, requestBody(candidateDigest, { decision: "keep" })),
      patch(candidateRoute, requestBody(candidateDigest, { decision: "redact" })),
    ]);
    assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 409]);
    const winner = await db.prepare(`SELECT decision,decision_version,decided_at
      FROM story_privacy_candidates WHERE candidate_id=?`).bind(candidate.id).first();
    assert.ok(winner.decision === "keep" || winner.decision === "redact");
    assert.equal(winner.decision_version, 1);
    assert.equal(new Date(winner.decided_at).toISOString(), winner.decided_at);
    assert.equal((await patch(candidateRoute, requestBody(candidateDigest))).status, 409);
    assert.deepEqual(await db.prepare(`SELECT decision,decision_version,decided_at
      FROM story_privacy_candidates WHERE candidate_id=?`).bind(candidate.id).first(), winner);

    // Core activation's DELETE + unchanged three-column INSERT resets final state.
    await db.prepare("DELETE FROM story_privacy_candidates WHERE workflow_run_id=?").bind(RUN_ID).run();
    await db.prepare(`INSERT INTO story_privacy_candidates
      (workflow_run_id,candidate_id,candidate_json) VALUES (?,?,?)`)
      .bind(RUN_ID, candidate.id, JSON.stringify(candidate)).run();
    assert.deepEqual(await db.prepare(`SELECT decision,decision_version,decided_at
      FROM story_privacy_candidates WHERE candidate_id=?`).bind(candidate.id).first(), {
      decision: null, decision_version: 0, decided_at: null,
    });

    const oldBrowserBody = requestBody(candidateDigest);
    const replacement = {
      ...candidate,
      title: "Replacement candidate",
      whyFlagged: "The same ID now refers to newly activated authority.",
    };
    await db.prepare("DELETE FROM story_privacy_candidates WHERE workflow_run_id=?").bind(RUN_ID).run();
    await db.prepare(`INSERT INTO story_privacy_candidates
      (workflow_run_id,candidate_id,candidate_json) VALUES (?,?,?)`)
      .bind(RUN_ID, replacement.id, JSON.stringify(replacement)).run();
    receiptOutputDigest = await putReceipt(db, replacement);
    currentAuthority = await readStoryPrivacyAuthority(db, RUN_ID);
    assert.equal(currentAuthority.ok, true);
    candidateDigest = currentAuthority.authority.candidateDigest;
    assert.equal((await patch(candidateRoute, oldBrowserBody)).status, 409);
    assert.deepEqual(await db.prepare(`SELECT decision,decision_version,decided_at
      FROM story_privacy_candidates WHERE candidate_id=?`).bind(candidate.id).first(), {
      decision: null, decision_version: 0, decided_at: null,
    });

    const currentBody = requestBody(candidateDigest);
    const boundaryCases = [{
      mutate: "UPDATE workflow_runs SET story_generation_status='blocked' WHERE id=?",
      bindings: [RUN_ID],
      restore: "UPDATE workflow_runs SET story_generation_status='ready_for_human_review' WHERE id=?",
      restoreBindings: [RUN_ID],
    }, {
      mutate: "UPDATE workflow_runs SET story_source_revision=? WHERE id=?",
      bindings: [SOURCE_REVISION + 1, RUN_ID],
      restore: "UPDATE workflow_runs SET story_source_revision=? WHERE id=?",
      restoreBindings: [SOURCE_REVISION, RUN_ID],
    }, {
      mutate: "UPDATE workflow_runs SET active_story_digest=? WHERE id=?",
      bindings: ["9".repeat(64), RUN_ID],
      restore: "UPDATE workflow_runs SET active_story_digest=? WHERE id=?",
      restoreBindings: [ACTIVE_DIGEST, RUN_ID],
    }, {
      mutate: "UPDATE story_preparation_receipts SET input_digest=? WHERE workflow_run_id=?",
      bindings: ["1".repeat(64), RUN_ID],
      restore: "UPDATE story_preparation_receipts SET input_digest=? WHERE workflow_run_id=?",
      restoreBindings: [STORY_PRIVACY_INPUT_DIGEST, RUN_ID],
    }, {
      mutate: "UPDATE story_preparation_receipts SET output_digest=? WHERE workflow_run_id=?",
      bindings: ["0".repeat(64), RUN_ID],
      restore: "UPDATE story_preparation_receipts SET output_digest=? WHERE workflow_run_id=?",
      restoreBindings: [receiptOutputDigest, RUN_ID],
    }, {
      mutate: "UPDATE items SET organization_reason=? WHERE id='event-a'",
      bindings: [MUTATED_STORY_SUMMARY],
      restore: "UPDATE items SET organization_reason=? WHERE id='event-a'",
      restoreBindings: [STORY_SUMMARY],
    }];
    for (const boundary of boundaryCases) {
      const realPrepare = db.prepare.bind(db);
      let injected = false;
      db.prepare = (sql) => {
        if (!injected && /^UPDATE story_privacy_candidates/u.test(sql)) {
          injected = true;
          realPrepare(boundary.mutate).bind(...boundary.bindings).run();
        }
        return realPrepare(sql);
      };
      const response = await patch(candidateRoute, currentBody);
      db.prepare = realPrepare;
      assert.equal(injected, true);
      assert.equal(response.status, 409);
      assert.deepEqual(await db.prepare(`SELECT decision,decision_version,decided_at
        FROM story_privacy_candidates WHERE candidate_id=?`).bind(candidate.id).first(), {
        decision: null, decision_version: 0, decided_at: null,
      });
      await db.prepare(boundary.restore).bind(...boundary.restoreBindings).run();
    }

    const final = await patch(candidateRoute, requestBody(candidateDigest, { decision: "redact" }));
    assert.equal(final.status, 200);
    assert.equal((await final.json()).decision, "redact");
    assert.equal((await db.prepare(`SELECT COUNT(*) AS count FROM story_privacy_candidates
      WHERE workflow_run_id=? AND candidate_id=?`).bind(RUN_ID, candidate.id).first()).count, 1);
  } finally {
    globalThis.__oxygenLocalSqlite?.database.close();
    delete globalThis.__oxygenLocalSqlite;
    if (previousStateDir === undefined) delete process.env.OXYGEN_VIEWER_STATE_DIR;
    else process.env.OXYGEN_VIEWER_STATE_DIR = previousStateDir;
    await rm(stateDir, { recursive: true, force: true });
  }
});
