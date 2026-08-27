import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL && specifier.startsWith(".")) {
      const resolvedPath = fileURLToPath(new URL(specifier, context.parentURL));
      if (!extname(resolvedPath)) {
        if (existsSync(`${resolvedPath}.ts`)) return nextResolve(`${specifier}.ts`, context);
        if (existsSync(join(resolvedPath, "index.ts"))) {
          return nextResolve(`${specifier}/index.ts`, context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const RUN_ID = "local-story-sqlite-authority";
const INITIAL_SOURCE_REVISION = 4;
const COVERAGE_REVISION = 1;
const SEMANTIC_DIGEST = "a".repeat(64);
const COVERAGE_DIGEST = "b".repeat(64);
const ACTIVATED_AT = "2038-01-01T00:00:00.000Z";
const DOCUMENT_ID = "synthetic-reviewed-document";
const STORY_ITEM_ID = `${DOCUMENT_ID}:story-authority`;
const EMPTY_DIGEST = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

function currentStorySource() {
  const evidence = { documentId: DOCUMENT_ID, eventId: STORY_ITEM_ID };
  return `oxygen.story:${JSON.stringify({
    schema: "oxygen.story",
    key: "story-authority",
    phase: { id: "activation", label: "Activation" },
    kind: "decision",
    title: "SQLite source authority",
    overview: "A synthetic current Story chapter validates local SQLite source authority.",
    people: [{
      id: "reviewer",
      releaseLabel: "Reviewer",
      role: "reviewer",
      description: "The reviewer confirms the exact local SQLite source boundary.",
      localIdentityState: "not_identified",
      evidence: [evidence],
    }],
    story: { blocks: [{
      id: "source-check",
      text: "The reviewer confirmed the local SQLite source boundary.",
      evidence: [evidence],
    }] },
    insights: [],
    evidence: { primary: evidence, supporting: [] },
    coverage: {
      semanticManifest: { revision: 1, digest: SEMANTIC_DIGEST },
      coverageManifest: { revision: COVERAGE_REVISION, digest: COVERAGE_DIGEST },
      representedUnitIds: [],
      excludedUnits: [],
    },
  })}`;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function activationSnapshot(db) {
  const [run, semantic, coverage, items, receipts, candidates, probeRun] = await Promise.all([
    db.prepare(`SELECT story_generation_status,story_generation_completed,
      story_generation_total,story_source_revision,active_story_digest,updated_at
      FROM workflow_runs WHERE id=?`).bind(RUN_ID).first(),
    db.prepare(`SELECT source_revision,updated_at FROM semantic_manifests
      WHERE workflow_run_id=?`).bind(RUN_ID).first(),
    db.prepare(`SELECT revision,coverage_digest,updated_at FROM story_coverage_manifests
      WHERE workflow_run_id=?`).bind(RUN_ID).first(),
    db.prepare(`SELECT id,organization_reason FROM items ORDER BY id`).all(),
    db.prepare(`SELECT lane,source_revision FROM story_preparation_receipts
      WHERE workflow_run_id=? ORDER BY lane`).bind(RUN_ID).all(),
    db.prepare(`SELECT story_key,candidate_id FROM story_privacy_candidates
      WHERE workflow_run_id=? ORDER BY story_key,candidate_id`).bind(RUN_ID).all(),
    db.prepare(`SELECT source_revision,output_digest,output_count FROM probe_runs
      WHERE workflow_run_id=?`).bind(RUN_ID).first(),
  ]);
  return {
    run,
    semantic,
    coverage,
    items: items.results,
    receipts: receipts.results,
    candidates: candidates.results,
    probeRun,
  };
}

test("real SQLite enforces Story activation and review-session CAS authority", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "oxygen-story-sqlite-"));
  const previousStateDir = process.env.OXYGEN_VIEWER_STATE_DIR;
  process.env.OXYGEN_VIEWER_STATE_DIR = stateDir;

  try {
    const [
      { getLocalDatabase },
      { readReservedStoryCandidateRows, validateStorySourcePackage },
      {
        beginStoryActivationMutation,
        publishActivatedStorySourceMutation,
      },
      {
        createStoryReviewSession,
        STORY_REVIEW_SESSION_SCHEMA,
      },
      { emptyChapterReview },
      {
        persistStoryReviewSessionCas,
        readStoryReviewSessionRecord,
        STORY_SESSION_ERROR,
      },
    ] = await Promise.all([
      import("../db/index.ts"),
      import("../lib/story-readiness.ts"),
      import("../lib/story-source-publication.ts"),
      import("../lib/story-review-session.ts"),
      import("../lib/story-review.ts"),
      import("../lib/story-review-session-server.ts"),
    ]);
    const db = await getLocalDatabase();

    await db.prepare(`INSERT INTO workflow_runs
      (id,story_generation_status,story_source_revision,created_at,updated_at)
      VALUES (?,?,?,?,?)`).bind(
      RUN_ID,
      "running",
      INITIAL_SOURCE_REVISION,
      "2037-12-31T00:00:00.000Z",
      "2037-12-31T00:00:00.000Z",
    ).run();
    await db.prepare(`INSERT INTO semantic_manifests
      (workflow_run_id,project_id,revision,source_revision,source_digest,universe_digest,
       manifest_digest,unit_count,serialized_bytes,story_projection_bytes,corpus_revision,
       corpus_digest,corpus_document_count,corpus_item_count,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      RUN_ID, "synthetic-project", 1, INITIAL_SOURCE_REVISION,
      "c".repeat(64), "d".repeat(64), SEMANTIC_DIGEST,
      0, 2, 2, 1, "e".repeat(64), 1, 1,
      "2037-12-31T00:00:00.000Z", "2037-12-31T00:00:00.000Z",
    ).run();
    await db.prepare(`INSERT INTO story_coverage_manifests
      (workflow_run_id,revision,semantic_manifest_revision,semantic_manifest_digest,
       coverage_digest,unit_count,serialized_bytes,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).bind(
      RUN_ID, COVERAGE_REVISION, 1, SEMANTIC_DIGEST, COVERAGE_DIGEST,
      0, 2, "2037-12-31T00:00:00.000Z", "2037-12-31T00:00:00.000Z",
    ).run();

    await db.prepare(`INSERT INTO documents
      (id,kind,title,item_count,imported_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(
      DOCUMENT_ID, "synthetic", "Synthetic reviewed Story", 1,
      "2037-12-31T00:00:00.000Z", "2037-12-31T00:00:00.000Z",
    ).run();
    await db.prepare(`INSERT INTO items
      (id,document_id,sequence,event_type,actor_id,actor_type,timestamp,content,
       original_json,organization_reason) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
      STORY_ITEM_ID,
      DOCUMENT_ID,
      1,
      "decision",
      "reviewer",
      "human",
      "2038-01-01T00:00:00.000Z",
      "Safe synthetic reviewed event.",
      "{}",
      currentStorySource(),
    ).run();

    const candidateRows = await readReservedStoryCandidateRows(db);
    const evidenceRows = (await db.prepare(`SELECT id,document_id AS documentId,
      event_type AS eventType,actor_id AS actorId,actor_type AS actorType
      FROM items ORDER BY document_id,sequence`).all()).results;
    const validation = validateStorySourcePackage(candidateRows, evidenceRows);
    assert.equal(validation.ok, true, validation.code);
    const activeStoryDigest = await sha256(validation.canonicalCandidate);

    await db.prepare(`INSERT INTO probe_runs
      (workflow_run_id,id,source_revision,input_digest,output_digest,output_count,
       status,stage,generated,set_aside,auto_removed_json,started_at,updated_at,completed_at)
      VALUES (?,?,?,?,?,?,'complete','preference',0,0,?,?,?,?)`).bind(
      RUN_ID,
      RUN_ID,
      INITIAL_SOURCE_REVISION,
      "f".repeat(64),
      EMPTY_DIGEST,
      0,
      JSON.stringify({ total: 0, reversible: true, categories: [] }),
      ACTIVATED_AT,
      ACTIVATED_AT,
      ACTIVATED_AT,
    ).run();

    assert.equal(await beginStoryActivationMutation(db, RUN_ID, ACTIVATED_AT), true);
    assert.equal(
      await beginStoryActivationMutation(db, RUN_ID, "2038-01-01T00:00:00.100Z"),
      false,
      "only one activation request can claim the production lease",
    );
    const activationStatements = () => [
      ...["story", "insight", "story_privacy", "preference"].map((lane) => (
        db.prepare(`INSERT INTO story_preparation_receipts
          (workflow_run_id,lane,source_revision,input_digest,scope_digest,scope_count,
           output_digest,output_count,completed_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(
          RUN_ID,
          lane,
          INITIAL_SOURCE_REVISION + 1,
          "f".repeat(64),
          "1".repeat(64),
          lane === "story" ? 1 : 0,
          lane === "story" ? "2".repeat(64) : EMPTY_DIGEST,
          lane === "story" || lane === "story_privacy" ? 1 : 0,
          ACTIVATED_AT,
        )
      )),
      db.prepare(`INSERT INTO story_privacy_candidates
        (workflow_run_id,story_key,candidate_id,candidate_json) VALUES (?,?,?,?)`).bind(
        RUN_ID,
        "story-authority",
        "privacy-authority",
        JSON.stringify({ id: "privacy-authority" }),
      ),
      db.prepare(`UPDATE probe_runs SET source_revision=?
        WHERE workflow_run_id=? AND source_revision=?`).bind(
        INITIAL_SOURCE_REVISION + 1,
        RUN_ID,
        INITIAL_SOURCE_REVISION,
      ),
    ];
    const beforeFailedBatch = await activationSnapshot(db);
    const forcedFailureStatements = activationStatements();
    forcedFailureStatements.push(db.prepare(`INSERT INTO story_preparation_receipts
      (workflow_run_id,lane,source_revision,input_digest,scope_digest,scope_count,
       output_digest,output_count,completed_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(
      RUN_ID, "story", INITIAL_SOURCE_REVISION + 1, "f".repeat(64), "1".repeat(64),
      1, "2".repeat(64), 1, ACTIVATED_AT,
    ));
    assert.equal(await publishActivatedStorySourceMutation(
      db,
      forcedFailureStatements,
      RUN_ID,
      INITIAL_SOURCE_REVISION,
      validation.chapterCount,
      activeStoryDigest,
      COVERAGE_REVISION,
      COVERAGE_DIGEST,
      1,
      EMPTY_DIGEST,
      0,
      ACTIVATED_AT,
    ), false, "a real SQLite constraint failure rolls back the complete activation batch");
    assert.deepEqual(await activationSnapshot(db), beforeFailedBatch);
    assert.equal(await publishActivatedStorySourceMutation(
      db,
      activationStatements(),
      RUN_ID,
      INITIAL_SOURCE_REVISION,
      validation.chapterCount,
      activeStoryDigest,
      COVERAGE_REVISION,
      COVERAGE_DIGEST,
      1,
      EMPTY_DIGEST,
      0,
      ACTIVATED_AT,
    ), true);

    const activated = await activationSnapshot(db);
    assert.deepEqual(activated.run, {
      story_generation_status: "ready_for_human_review",
      story_generation_completed: validation.chapterCount,
      story_generation_total: validation.chapterCount,
      story_source_revision: INITIAL_SOURCE_REVISION + 1,
      active_story_digest: activeStoryDigest,
      updated_at: ACTIVATED_AT,
    });
    assert.deepEqual(activated.semantic, {
      source_revision: INITIAL_SOURCE_REVISION + 1,
      updated_at: ACTIVATED_AT,
    });
    assert.deepEqual(activated.receipts, [
      { lane: "insight", source_revision: INITIAL_SOURCE_REVISION + 1 },
      { lane: "preference", source_revision: INITIAL_SOURCE_REVISION + 1 },
      { lane: "story", source_revision: INITIAL_SOURCE_REVISION + 1 },
      { lane: "story_privacy", source_revision: INITIAL_SOURCE_REVISION + 1 },
    ]);
    assert.deepEqual(activated.candidates, [{
      story_key: "story-authority",
      candidate_id: "privacy-authority",
    }]);
    assert.deepEqual(activated.probeRun, {
      source_revision: INITIAL_SOURCE_REVISION + 1,
      output_digest: EMPTY_DIGEST,
      output_count: 0,
    });

    assert.equal(
      await beginStoryActivationMutation(db, RUN_ID, "2038-01-01T00:00:01.000Z"),
      false,
    );
    assert.equal(await publishActivatedStorySourceMutation(
      db,
      [],
      RUN_ID,
      INITIAL_SOURCE_REVISION,
      validation.chapterCount,
      "f".repeat(64),
      COVERAGE_REVISION,
      COVERAGE_DIGEST,
      0,
      EMPTY_DIGEST,
      0,
      "2038-01-01T00:00:02.000Z",
    ), false);
    assert.deepEqual(await activationSnapshot(db), activated);

    const session = (label) => {
      const review = emptyChapterReview(JSON.parse(currentStorySource().slice("oxygen.story:".length)));
      review.evidenceVerified = label === "writer-a";
      return createStoryReviewSession(RUN_ID, { "story-authority": review }, {}, "2099-01-01T00:00:00.000Z");
    };
    const sessions = [session("writer-a"), session("writer-b")];
    const serverTimes = [
      "2038-01-01T00:00:03.000Z",
      "2038-01-01T00:00:04.000Z",
    ];
    const results = await Promise.all(sessions.map((value, index) => (
      persistStoryReviewSessionCas(db, {
        workflowRunId: RUN_ID,
        expectedVersion: 0,
        sourceRevision: INITIAL_SOURCE_REVISION + 1,
        storySessionSchema: STORY_REVIEW_SESSION_SCHEMA,
        session: value,
      }, serverTimes[index])
    )));

    const winnerIndex = results.findIndex((result) => result.ok && result.saved);
    const loserIndex = results.findIndex((result) => (
      !result.ok && result.code === STORY_SESSION_ERROR.versionConflict
    ));
    assert.notEqual(winnerIndex, -1);
    assert.notEqual(loserIndex, -1);
    assert.notEqual(winnerIndex, loserIndex);
    assert.equal(results.filter((result) => result.ok && result.saved).length, 1);
    assert.equal(results.filter((result) => (
      !result.ok && result.code === STORY_SESSION_ERROR.versionConflict
    )).length, 1);

    const durableRows = await db.prepare(`SELECT state_json,updated_at,server_version
      FROM story_review_sessions WHERE workflow_run_id=?`).bind(RUN_ID).all();
    assert.equal(durableRows.results.length, 1);
    assert.equal(durableRows.results[0].server_version, 1);
    assert.equal(durableRows.results[0].updated_at, serverTimes[winnerIndex]);

    const record = await readStoryReviewSessionRecord(db, RUN_ID);
    assert.equal(record.serverVersion, 1);
    assert.equal(record.sourceRevision, INITIAL_SOURCE_REVISION + 1);
    assert.equal(record.persistedAt, serverTimes[winnerIndex]);
    assert.equal(record.session.updatedAt, serverTimes[winnerIndex]);
    assert.notEqual(record.session.updatedAt, sessions[winnerIndex].updatedAt);
    assert.deepEqual(record.session.chapterReviews, sessions[winnerIndex].chapterReviews);
    assert.notDeepEqual(record.session.chapterReviews, sessions[loserIndex].chapterReviews);

    context.diagnostic(JSON.stringify({
      activation: {
        firstLease: true,
        secondLease: false,
        firstPublish: true,
        stalePublish: false,
        sourceRevision: activated.run.story_source_revision,
        activeStoryDigest,
      },
      reviewSession: {
        winner: winnerIndex,
        staleLoser: loserIndex,
        durableRows: durableRows.results.length,
        serverVersion: record.serverVersion,
        persistedAt: record.persistedAt,
      },
    }));
  } finally {
    globalThis.__oxygenLocalSqlite?.database.close();
    delete globalThis.__oxygenLocalSqlite;
    if (previousStateDir === undefined) delete process.env.OXYGEN_VIEWER_STATE_DIR;
    else process.env.OXYGEN_VIEWER_STATE_DIR = previousStateDir;
    await rm(stateDir, { recursive: true, force: true });
  }
});
