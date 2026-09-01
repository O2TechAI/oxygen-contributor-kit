import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import test from "node:test";
import { seedCoveragePrivacyAuthority } from "./story-coverage-privacy-fixture.mjs";
import {
  buildSourcePrivacyReceipt,
  installSourcePrivacyReceipt,
} from "./fixtures/source-privacy-receipt.mjs";

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
const PRIVATE_ITEM_ID = `${DOCUMENT_ID}:privacy-authority`;
const EMPTY_DIGEST = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

function currentStorySource() {
  const evidence = { documentId: DOCUMENT_ID, eventId: STORY_ITEM_ID };
  return `oxygen.story:${JSON.stringify({
    schema: "oxygen.story",
    language: "en",
    languagePolicyDigest: "f".repeat(64),
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
  const [run, semantic, coverage, items, receipts, candidates, targets, probeRun, lifecycle] = await Promise.all([
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
    db.prepare(`SELECT candidate_id,candidate_json FROM story_privacy_candidates
      WHERE workflow_run_id=? ORDER BY candidate_id`).bind(RUN_ID).all(),
    db.prepare(`SELECT target_id FROM story_privacy_targets
      WHERE workflow_run_id=? ORDER BY target_id`).bind(RUN_ID).all(),
    db.prepare(`SELECT source_revision,output_digest,output_count FROM probe_runs
      WHERE workflow_run_id=?`).bind(RUN_ID).first(),
    db.prepare(`SELECT source_revision,active_story_digest,state_json,state_digest
      FROM preference_lifecycle_authorities WHERE workflow_run_id=?`).bind(RUN_ID).first(),
  ]);
  return {
    run,
    semantic,
    coverage,
    items: items.results,
    receipts: receipts.results,
    candidates: candidates.results,
    targets: targets.results,
    probeRun,
    lifecycle,
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
       registry_digest,manifest_digest,unit_count,serialized_bytes,story_projection_bytes,corpus_revision,
       corpus_digest,corpus_document_count,corpus_item_count,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      RUN_ID, "synthetic-project", 1, INITIAL_SOURCE_REVISION,
      "c".repeat(64), "d".repeat(64), "e".repeat(64), SEMANTIC_DIGEST,
      0, 2, 2, 1, "e".repeat(64), 1, 1,
      "2037-12-31T00:00:00.000Z", "2037-12-31T00:00:00.000Z",
    ).run();
    await db.prepare(`INSERT INTO story_coverage_manifests
      (workflow_run_id,revision,semantic_manifest_revision,semantic_manifest_digest,
       coverage_digest,privacy_authority_digest,unit_count,serialized_bytes,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
      RUN_ID, COVERAGE_REVISION, 1, SEMANTIC_DIGEST, COVERAGE_DIGEST,
      "0".repeat(64), 0, 2, "2037-12-31T00:00:00.000Z", "2037-12-31T00:00:00.000Z",
    ).run();

    await db.prepare(`INSERT INTO documents
      (id,kind,title,item_count,imported_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(
      DOCUMENT_ID, "trajectory", "Synthetic reviewed Story", 1,
      "2037-12-31T00:00:00.000Z", "2037-12-31T00:00:00.000Z",
    ).run();
    await db.prepare(`INSERT INTO items
      (id,document_id,sequence,event_type,actor_id,actor_type,timestamp,content,
       original_json,organization_reason) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
      STORY_ITEM_ID,
      DOCUMENT_ID,
      1,
      "message",
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
        (workflow_run_id,candidate_id,candidate_json) VALUES (?,?,?)`).bind(
        RUN_ID,
        "privacy-authority",
        JSON.stringify({ id: "privacy-authority" }),
      ),
      db.prepare(`INSERT INTO story_privacy_targets
        (workflow_run_id,target_id,target_content_digest,proposed_text,occurrences_json,
         selected_text,public_overrides_json,decided_at) VALUES (?,?,?,?,?,?,'[]',?)`).bind(
        RUN_ID, "story-authority::title", "3".repeat(64), "Safe title", "[]",
        "Safe title", ACTIVATED_AT,
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
      candidate_id: "privacy-authority",
      candidate_json: JSON.stringify({ id: "privacy-authority" }),
    }]);
    assert.deepEqual(activated.targets, [{ target_id: "story-authority::title" }]);
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

    const sessionSource = JSON.parse(currentStorySource().slice("oxygen.story:".length));
    for (const table of [
      "story_coverage_rows", "story_coverage_manifests", "semantic_unit_members",
      "semantic_units", "semantic_manifests",
    ]) await db.prepare(`DELETE FROM ${table}`).run();
    await seedCoveragePrivacyAuthority(db, {
      workflowRunId: RUN_ID,
      sourceRevision: INITIAL_SOURCE_REVISION + 1,
      stories: [sessionSource],
      now: ACTIVATED_AT,
      projectId: "synthetic-project",
    });

    const session = (label) => {
      const review = emptyChapterReview(sessionSource);
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

test("workflow POST atomically activates coverage, Story preparation, flat Privacy, and Preference", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "oxygen-workflow-route-sqlite-"));
  const previousStateDir = process.env.OXYGEN_VIEWER_STATE_DIR;
  process.env.OXYGEN_VIEWER_STATE_DIR = stateDir;
  try {
    const [
      { getLocalDatabase },
      workflowRoute,
      {
        canonicalAuthorityJson,
        validateSemanticManifestAuthority,
        finalizeCoverageManifestAuthority,
        readCoverageManifestAuthority,
      },
      { deriveStoryReleaseTargetContents, storyPreparationDigest },
      { computeSourceDigest },
      { loadWorkflowProgress },
      probesRoute,
    ] = await Promise.all([
      import("../db/index.ts"),
      import("../app/api/workflow/route.ts"),
      import("../lib/story-readiness.ts"),
      import("../lib/story-preparation.ts"),
      import("../lib/redaction-pass.mjs"),
      import("../lib/workflow-progress-server.ts"),
      import("../app/api/probes/route.ts"),
    ]);
    const db = await getLocalDatabase();
    const timestamp = "2041-01-01T00:00:00.000Z";
    await db.prepare(`INSERT INTO workflow_runs
      (id,target_confirmed,collection_status,collection_completed,collection_total,
       story_generation_status,story_source_revision,created_at,updated_at)
      VALUES (?,1,'complete',2,2,'running',?,?,?)`)
      .bind(RUN_ID, INITIAL_SOURCE_REVISION, timestamp, timestamp).run();
    await db.prepare(`INSERT INTO organization_jobs
      (id,status,stage,completed,total,warnings_json,started_at,updated_at,completed_at)
      VALUES ('organization','complete','done',2,2,'[]',?,?,?)`)
      .bind(timestamp, timestamp, timestamp).run();
    await db.prepare(`INSERT INTO documents
      (id,kind,title,item_count,formatted_summary_json,imported_at,updated_at)
      VALUES (?,'trajectory','Synthetic route Story',2,'{}',?,?)`)
      .bind(DOCUMENT_ID, timestamp, timestamp).run();
    await db.prepare(`INSERT INTO items
      (id,document_id,sequence,event_type,actor_id,actor_type,timestamp,content,
       original_json,organization_category,organization_reason)
      VALUES (?,?,1,'message','reviewer','human',?,'Synthetic route event.','{}','project',NULL)`)
      .bind(STORY_ITEM_ID, DOCUMENT_ID, timestamp).run();
    await db.prepare(`INSERT INTO items
      (id,document_id,sequence,event_type,actor_id,actor_type,timestamp,content,
       original_json,organization_category,organization_reason)
      VALUES (?,?,2,'message','reviewer','human',?,'Private synthetic event.','{}','project',NULL)`)
      .bind(PRIVATE_ITEM_ID, DOCUMENT_ID, timestamp).run();
    await db.prepare(`INSERT INTO finalized_corpus_manifests
      (workflow_run_id,corpus_revision,corpus_digest,document_count,item_count,finalized_at)
      VALUES (?,1,?,1,2,?)`).bind(RUN_ID, "c".repeat(64), timestamp).run();
    const sourceRows = (await db.prepare(`SELECT document_id,id,sequence,event_type,actor_type,
      timestamp,content FROM items ORDER BY document_id,sequence,id`).all()).results;
    const sourcePrivacyDigest = await computeSourceDigest(sourceRows);
    await db.prepare(`INSERT INTO redaction_jobs
      (id,status,stage,completed,total,rejected,source_digest,started_at,updated_at,completed_at)
      VALUES ('redaction','complete','done',1,1,0,?,?,?,?)`)
      .bind(sourcePrivacyDigest, timestamp, timestamp, timestamp).run();
    await db.prepare(`INSERT INTO redactions
      (id,item_id,document_id,start_offset,end_offset,category,confidence,reason,
       review_state,uncertainty_reason,status,created_by,created_at,updated_at)
      VALUES ('source-private',?,?,0,7,'sensitive','high','Local private sentinel',
        'deterministic',NULL,'active','llm',?,?)`)
      .bind(PRIVATE_ITEM_ID, DOCUMENT_ID, timestamp, timestamp).run();
    const sourcePrivacyReceipt = await buildSourcePrivacyReceipt(db, {
      workflowRunId: RUN_ID,
      sourceRevision: INITIAL_SOURCE_REVISION,
      redactions: [{
        itemId: PRIVATE_ITEM_ID,
        documentId: DOCUMENT_ID,
        startOffset: 0,
        endOffset: 7,
        category: "sensitive",
        confidence: "high",
        reason: "Local private sentinel",
        reviewState: "deterministic",
        uncertaintyReason: null,
        createdBy: "llm",
      }],
    });
    await installSourcePrivacyReceipt(db, {
      jobId: "redaction",
      workflowRunId: RUN_ID,
      receipt: sourcePrivacyReceipt,
      at: timestamp,
    });

    const hash = (value) => sha256(canonicalAuthorityJson(value));
    const storySourceDigest = await hash({ id: STORY_ITEM_ID });
    const privateSourceDigest = await hash({ id: PRIVATE_ITEM_ID });
    const contributionRecords = [
      { id: PRIVATE_ITEM_ID, sourceDigest: privateSourceDigest },
      { id: STORY_ITEM_ID, sourceDigest: storySourceDigest },
    ].sort((left, right) => left.id.localeCompare(right.id));
    const units = [{
      id: "unit-private", revision: 1, projectId: "route-project", kind: "discussion",
      members: [PRIVATE_ITEM_ID], memberCount: 1,
      membershipDigest: await hash([{ id: PRIVATE_ITEM_ID, sourceDigest: privateSourceDigest }]),
    }, {
      id: "unit-route", revision: 1, projectId: "route-project", kind: "progression",
      members: [STORY_ITEM_ID], memberCount: 1,
      membershipDigest: await hash([{ id: STORY_ITEM_ID, sourceDigest: storySourceDigest }]),
    }];
    const semanticCore = {
      projectId: "route-project",
      revision: 1,
      sourceDigest: await hash(contributionRecords),
      universeDigest: await hash(contributionRecords.map((record) => record.id)),
      registryDigest: "e".repeat(64),
      units,
    };
    const semanticValidation = await validateSemanticManifestAuthority({
      ...semanticCore,
      manifestDigest: await hash(semanticCore),
    }, contributionRecords);
    assert.equal(semanticValidation.ok, true, semanticValidation.code);
    const semantic = semanticValidation.authority;
    await db.prepare(`INSERT INTO semantic_manifests
      (workflow_run_id,project_id,revision,source_revision,source_digest,universe_digest,
       registry_digest,manifest_digest,unit_count,serialized_bytes,story_projection_bytes,corpus_revision,
       corpus_digest,corpus_document_count,corpus_item_count,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      RUN_ID, semantic.projectId, semantic.revision, INITIAL_SOURCE_REVISION,
      semantic.sourceDigest, semantic.universeDigest, semantic.registryDigest, semantic.manifestDigest,
      semantic.units.length, semantic.serializedBytes, semanticValidation.storyProjectionBytes,
      1, "c".repeat(64), 1, 2, timestamp, timestamp,
    ).run();
    for (const unit of semantic.units) {
      await db.prepare(`INSERT INTO semantic_units
        (id,workflow_run_id,revision,project_id,kind,member_count,membership_digest,
         story_projection_json) VALUES (?,?,?,?,?,?,?,'{}')`).bind(
        unit.id, RUN_ID, unit.revision, unit.projectId, unit.kind,
        unit.memberCount, unit.membershipDigest,
      ).run();
      for (const itemId of unit.members) {
        const sourceDigest = contributionRecords.find((record) => record.id === itemId).sourceDigest;
        await db.prepare(`INSERT INTO semantic_unit_members
          (item_id,workflow_run_id,unit_id,source_digest) VALUES (?,?,?,?)`)
          .bind(itemId, RUN_ID, unit.id, sourceDigest).run();
      }
    }

    const coverageValidation = await finalizeCoverageManifestAuthority({ rows: [{
      unitId: "unit-private", disposition: "excluded", exclusionReason: "privacy_withheld",
    }, {
      unitId: "unit-route", disposition: "represented", ownerId: "story-authority",
    }] }, semantic, null, new Set(["unit-private"]));
    assert.equal(coverageValidation.ok, true, coverageValidation.code);
    const coverage = coverageValidation.authority;
    const coverageInput = {
      revision: coverage.revision,
      semanticManifestRevision: coverage.semanticManifestRevision,
      semanticManifestDigest: coverage.semanticManifestDigest,
      coverageDigest: coverage.coverageDigest,
      rows: coverage.rows.map((row) => row.disposition === "represented" ? {
        unitId: row.unitId, disposition: row.disposition, ownerId: row.ownerId,
      } : {
        unitId: row.unitId, disposition: row.disposition, exclusionReason: row.exclusionReason,
      }),
    };
    const storySource = JSON.parse(currentStorySource().slice("oxygen.story:".length));
    storySource.coverage = {
      semanticManifest: { revision: semantic.revision, digest: semantic.manifestDigest },
      coverageManifest: { revision: coverage.revision, digest: coverage.coverageDigest },
      representedUnitIds: ["unit-route"],
      excludedUnits: [{ unitId: "unit-private", reason: "privacy_withheld" }],
    };
    const languagePolicy = {
      schema: "oxygen.story-language-policy",
      workflowRunId: RUN_ID,
      sourceRevision: INITIAL_SOURCE_REVISION,
      sourceDigest: semantic.sourceDigest,
      sourcePrivacyDigest: "8".repeat(64),
      sourceInputDigest: "9".repeat(64),
      detectedLanguage: "en",
      selection: "all-english",
      stories: [{ storyKey: storySource.key, language: "en" }],
    };
    storySource.languagePolicyDigest = await storyPreparationDigest(languagePolicy);
    const storySummary = `oxygen.story:${JSON.stringify(storySource)}`;
    const storyCandidates = [{ id: STORY_ITEM_ID, summary: storySummary }];
    const stories = [storySource];
    const storyOutput = [{ id: STORY_ITEM_ID, story: { ...storySource, insights: [] } }];
    const completeStoryOutput = [{ id: STORY_ITEM_ID, story: storySource }];
    const targetContents = deriveStoryReleaseTargetContents(stories);
    assert.ok(targetContents);
    const targetCatalog = targetContents.map(({ id, storyKey, target }) => ({ id, storyKey, target }));
    const privacyCandidates = [{
      id: "privacy-route",
      reviewState: "deterministic",
      title: "Route Privacy check",
      whyFlagged: "The final title requires a deterministic local check.",
      uncertaintyReason: null,
      releaseTargets: ["story-authority::title"],
    }];
    const targetProposals = await Promise.all(targetContents.map(async (target) => {
      const proposal = {
        targetId: target.id,
        targetContentDigest: await storyPreparationDigest(target.content),
        proposedText: target.content,
        occurrences: [],
      };
      if (target.id !== "story-authority::title") return proposal;
      const original = Array.from(target.content);
      const replaced = Array.from("authority");
      const replacement = Array.from("boundary");
      const start = original.length - replaced.length;
      assert.equal(original.slice(start).join(""), replaced.join(""));
      return {
        ...proposal,
        proposedText: [...original.slice(0, start), ...replacement].join(""),
        occurrences: [{
          originalStartOffset: start,
          originalEndOffset: original.length,
          proposalStartOffset: start,
          proposalEndOffset: start + replacement.length,
          category: "private-detail",
        }],
      };
    }));
    const storyPrivacy = { candidates: privacyCandidates, targetProposals };
    const preferenceInputDigest = await storyPreparationDigest([]);
    await db.prepare(`INSERT INTO probes
      (id,document_id,document_kind,event_ids_json,signal,recap,question,options_json,presentations_json,created_at)
      VALUES ('pre-feature-legacy',?,'trajectory','[]','explicit_rule','Legacy','Legacy?','[]','{}',?)`)
      .bind(DOCUMENT_ID,timestamp).run();
    const refreshed = await probesRoute.POST(new Request("http://localhost/api/probes", {
      method:"POST", body:JSON.stringify({ workflowRunId:RUN_ID, sourceRevision:INITIAL_SOURCE_REVISION,
        inputDigest:preferenceInputDigest, outputDigest:EMPTY_DIGEST, outputCount:0, setAside:0,
        insightScope:[], probes:[], bulkDecisions:[],
        autoRemoved:{ total:0, reversible:true, categories:[] } }),
    }));
    assert.equal(refreshed.status, 200, await refreshed.text());
    assert.equal(await db.prepare("SELECT 1 FROM probes WHERE id='pre-feature-legacy'").first(), null,
      "the real full refresh retires pre-feature rows even for a legitimate zero-question result");
    const preparationManifest = {
      schema: "oxygen.story-preparation",
      workflowRunId: RUN_ID,
      sourceRevision: INITIAL_SOURCE_REVISION,
      languagePolicy,
      receipts: [{
        lane: "story", status: "complete", inputDigest: semantic.manifestDigest,
        scopeDigest: await storyPreparationDigest(["unit-private", "unit-route"]), scopeCount: 2,
        outputDigest: await storyPreparationDigest(storyOutput), outputCount: 1,
      }, {
        lane: "insight", status: "complete",
        inputDigest: await storyPreparationDigest(storyOutput),
        scopeDigest: await storyPreparationDigest(["story-authority"]), scopeCount: 1,
        outputDigest: EMPTY_DIGEST, outputCount: 0,
      }, {
        lane: "story_privacy", status: "complete",
        inputDigest: await storyPreparationDigest(completeStoryOutput),
        scopeDigest: await storyPreparationDigest(targetCatalog.map((target) => target.id)),
        scopeCount: targetCatalog.length,
        outputDigest: await storyPreparationDigest(storyPrivacy),
        outputCount: targetProposals.length,
      }, {
        lane: "preference", status: "complete", inputDigest: preferenceInputDigest,
        scopeDigest: EMPTY_DIGEST, scopeCount: 0, outputDigest: EMPTY_DIGEST, outputCount: 0,
      }],
      storyPrivacy,
    };
    const body = {
      workflowRunId: RUN_ID,
      event: "story_ready_for_human_review",
      coverageManifest: coverageInput,
      storyCandidates,
      preparationManifest,
    };

    const realBatch = db.batch.bind(db);
    const completionReceipt = await db.prepare(
      "SELECT * FROM source_privacy_receipts WHERE workflow_run_id=?",
    ).bind(RUN_ID).first();
    await db.prepare("DELETE FROM source_privacy_receipts WHERE workflow_run_id=?")
      .bind(RUN_ID).run();
    const legacyProgress = await loadWorkflowProgress(RUN_ID);
    assert.equal(legacyProgress.currentStageId, "privacy");
    assert.equal(legacyProgress.safeStatusCode, "privacy_check_required");
    const legacyStartBefore = await activationSnapshot(db);
    const legacyStart = await workflowRoute.POST(new Request("http://localhost/api/workflow", {
      method: "POST",
      body: JSON.stringify({ workflowRunId: RUN_ID, event: "story_generation_started" }),
    }));
    assert.equal(legacyStart.status, 409);
    assert.deepEqual(await activationSnapshot(db), legacyStartBefore);
    await db.prepare(`INSERT INTO source_privacy_receipts
      (job_id,workflow_run_id,source_revision,source_digest,receipt_digest,receipt_json,created_at)
      VALUES (?,?,?,?,?,?,?)`).bind(
      completionReceipt.job_id,
      completionReceipt.workflow_run_id,
      completionReceipt.source_revision,
      completionReceipt.source_digest,
      completionReceipt.receipt_digest,
      completionReceipt.receipt_json,
      completionReceipt.created_at,
    ).run();
    assert.equal((await workflowRoute.POST(new Request("http://localhost/api/workflow", {
      method: "POST",
      body: JSON.stringify({ workflowRunId: RUN_ID, event: "story_generation_started" }),
    }))).status, 200);

    const beforeRevisionZero = await activationSnapshot(db);
    const realPrepare = db.prepare;
    let revisionZeroPrepareCalls = 0;
    let revisionZeroBatchCalls = 0;
    db.prepare = function observedPrepare(...args) {
      revisionZeroPrepareCalls += 1;
      return realPrepare.apply(this, args);
    };
    db.batch = async (statements) => {
      revisionZeroBatchCalls += 1;
      return realBatch(statements);
    };
    const revisionZeroBody = structuredClone(body);
    revisionZeroBody.preparationManifest.sourceRevision = 0;
    const revisionZeroResponse = await workflowRoute.POST(new Request(
      "http://localhost/api/workflow",
      { method: "POST", body: JSON.stringify(revisionZeroBody) },
    ));
    db.prepare = realPrepare;
    db.batch = realBatch;
    assert.equal(revisionZeroResponse.status, 400);
    assert.equal(revisionZeroPrepareCalls, 0);
    assert.equal(revisionZeroBatchCalls, 0);
    assert.deepEqual(await activationSnapshot(db), beforeRevisionZero);

    await db.prepare(`UPDATE workflow_runs SET story_source_revision=0 WHERE id=?`)
      .bind(RUN_ID).run();
    const zeroStoredBefore = await activationSnapshot(db);
    const zeroStoredResponse = await workflowRoute.POST(new Request(
      "http://localhost/api/workflow",
      { method: "POST", body: JSON.stringify(body) },
    ));
    assert.equal(zeroStoredResponse.status, 409);
    assert.deepEqual(await activationSnapshot(db), zeroStoredBefore);
    await db.prepare(`UPDATE workflow_runs SET story_source_revision=? WHERE id=?`)
      .bind(INITIAL_SOURCE_REVISION, RUN_ID).run();

    for (const authorityTable of ["semantic_manifests", "probe_runs"]) {
      const beforeInnerRevisionZero = await activationSnapshot(db);
      await db.prepare(`UPDATE ${authorityTable} SET source_revision=0 WHERE workflow_run_id=?`)
        .bind(RUN_ID).run();
      const afterTamper = await activationSnapshot(db);
      const innerRevisionZeroResponse = await workflowRoute.POST(new Request(
        "http://localhost/api/workflow",
        { method: "POST", body: JSON.stringify(body) },
      ));
      assert.equal(innerRevisionZeroResponse.status, 409, authorityTable);
      assert.deepEqual(await activationSnapshot(db), afterTamper,
        `${authorityTable} revision zero is rejected before any activation mutation`);
      await db.prepare(`UPDATE ${authorityTable} SET source_revision=? WHERE workflow_run_id=?`)
        .bind(INITIAL_SOURCE_REVISION, RUN_ID).run();
      assert.deepEqual(await activationSnapshot(db), beforeInnerRevisionZero, authorityTable);
    }

    const originalRedaction = await db.prepare("SELECT * FROM redactions WHERE id='source-private'").first();
    const races = [{
      label: "redaction decision",
      mutate: () => db.prepare(`UPDATE redactions SET review_state='confirmed_keep',status='removed',
        updated_at='2041-01-01T00:00:01.000Z' WHERE id='source-private'`).run(),
      restore: () => db.prepare(`UPDATE redactions SET review_state='deterministic',status='active',
        updated_at=? WHERE id='source-private'`).bind(timestamp).run(),
    }, {
      label: "redaction deletion",
      mutate: () => db.prepare("DELETE FROM redactions WHERE id='source-private'").run(),
      restore: () => db.prepare(`INSERT INTO redactions
        (id,item_id,document_id,start_offset,end_offset,category,confidence,reason,review_state,
         uncertainty_reason,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(...[
          "id", "item_id", "document_id", "start_offset", "end_offset", "category",
          "confidence", "reason", "review_state", "uncertainty_reason", "status",
          "created_by", "created_at", "updated_at",
        ].map((key) => originalRedaction[key])).run(),
    }, {
      label: "source Privacy job",
      mutate: () => db.prepare(`UPDATE redaction_jobs SET updated_at='2041-01-01T00:00:01.000Z'`).run(),
      restore: () => db.prepare("UPDATE redaction_jobs SET updated_at=?").bind(timestamp).run(),
    }, {
      label: "semantic membership",
      mutate: () => db.prepare(`UPDATE semantic_unit_members SET source_digest=?
        WHERE item_id=?`).bind("f".repeat(64), PRIVATE_ITEM_ID).run(),
      restore: () => db.prepare(`UPDATE semantic_unit_members SET source_digest=?
        WHERE item_id=?`).bind(
        contributionRecords.find((record) => record.id === PRIVATE_ITEM_ID).sourceDigest,
        PRIVATE_ITEM_ID,
      ).run(),
    }, {
      label: "semantic unit",
      mutate: () => db.prepare(`UPDATE semantic_units SET membership_digest=?
        WHERE id='unit-private'`).bind("f".repeat(64)).run(),
      restore: () => db.prepare(`UPDATE semantic_units SET membership_digest=?
        WHERE id='unit-private'`).bind(
        semantic.units.find((unit) => unit.id === "unit-private").membershipDigest,
      ).run(),
    }, {
      label: "corpus binding",
      mutate: () => db.prepare(`UPDATE finalized_corpus_manifests SET corpus_digest=?
        WHERE workflow_run_id=?`).bind("f".repeat(64), RUN_ID).run(),
      restore: () => db.prepare(`UPDATE finalized_corpus_manifests SET corpus_digest=?
        WHERE workflow_run_id=?`).bind("c".repeat(64), RUN_ID).run(),
    }, {
      label: "current source",
      mutate: () => db.prepare("UPDATE items SET content=? WHERE id=?")
        .bind("Changed private synthetic event.", PRIVATE_ITEM_ID).run(),
      restore: () => db.prepare("UPDATE items SET content=? WHERE id=?")
        .bind("Private synthetic event.", PRIVATE_ITEM_ID).run(),
    }, {
      label: "coverage binding",
      mutate: () => db.prepare(`INSERT INTO story_coverage_manifests
        (workflow_run_id,revision,semantic_manifest_revision,semantic_manifest_digest,
         coverage_digest,privacy_authority_digest,unit_count,serialized_bytes,created_at,updated_at)
        VALUES (?,99,1,?,?,?,0,2,?,?)`).bind(
        RUN_ID, semantic.manifestDigest, "f".repeat(64), "0".repeat(64), timestamp, timestamp,
      ).run(),
      restore: () => db.prepare("DELETE FROM story_coverage_manifests WHERE workflow_run_id=?")
        .bind(RUN_ID).run(),
    }];
    for (const race of races) {
      db.batch = async (statements) => {
        await race.mutate();
        return realBatch(statements);
      };
      const mutationResponse = await workflowRoute.POST(new Request("http://localhost/api/workflow", {
        method: "POST", body: JSON.stringify(body),
      }));
      db.batch = realBatch;
      assert.equal(mutationResponse.status, 409, race.label);
      const failure = await mutationResponse.json();
      assert.deepEqual(failure, {
        error: "Story activation authority changed before commit",
        code: "STORY_ACTIVATION_AUTHORITY_CHANGED",
      }, race.label);
      assert.doesNotMatch(JSON.stringify(failure), /localhost|sqlite|trace|private synthetic/i);
      await race.restore();
      const rolledBack = await activationSnapshot(db);
      assert.equal(rolledBack.coverage, null, race.label);
      assert.deepEqual(rolledBack.receipts, [], race.label);
      assert.deepEqual(rolledBack.candidates, [], race.label);
      assert.equal(rolledBack.probeRun.source_revision, INITIAL_SOURCE_REVISION, race.label);
      assert.equal(
        rolledBack.items.find((item) => item.id === STORY_ITEM_ID).organization_reason,
        null,
        race.label,
      );
      assert.equal(rolledBack.run.story_source_revision, INITIAL_SOURCE_REVISION, race.label);
      await db.prepare(`UPDATE workflow_runs
        SET story_generation_status='running',story_source_revision=? WHERE id=?`)
        .bind(INITIAL_SOURCE_REVISION, RUN_ID).run();
    }

    db.batch = async (statements) => {
      await db.prepare(`INSERT INTO organization_jobs
        (id,status,stage,completed,total,warnings_json,started_at,updated_at,completed_at)
        VALUES ('unrelated-organization','complete','done',0,0,'[]',?,?,?)`)
        .bind(timestamp, timestamp, timestamp).run();
      await db.prepare(`INSERT INTO probes
        (id,document_id,document_kind,event_ids_json,signal,recap,question,options_json,
         presentations_json,created_at) VALUES
        ('unrelated-probe',?,'synthetic','[]','preference','recap','Question?','[]','{}',?)`)
        .bind(DOCUMENT_ID, timestamp).run();
      await db.prepare(`INSERT INTO story_review_sessions
        (workflow_run_id,state_json,updated_at,server_version) VALUES (?,'{}',?,0)`)
        .bind(RUN_ID, timestamp).run();
      return realBatch(statements);
    };
    const response = await workflowRoute.POST(new Request("http://localhost/api/workflow", {
      method: "POST", body: JSON.stringify(body),
    }));
    db.batch = realBatch;
    assert.equal(response.status, 200, await response.text());
    const activated = await activationSnapshot(db);
    assert.equal(activated.run.story_generation_status, "ready_for_human_review");
    assert.equal(activated.run.story_source_revision, INITIAL_SOURCE_REVISION + 1);
    assert.deepEqual(activated.receipts.map((receipt) => receipt.lane), [
      "insight", "preference", "story", "story_privacy",
    ]);
    assert.deepEqual(activated.candidates, [{
      candidate_id: "privacy-route",
      candidate_json: JSON.stringify(privacyCandidates[0]),
    }]);
    assert.equal(activated.targets.length, targetCatalog.length);
    assert.equal(activated.probeRun.source_revision, INITIAL_SOURCE_REVISION + 1);
    assert.equal(activated.probeRun.output_digest, EMPTY_DIGEST);
    assert.equal(activated.probeRun.output_count, 0);
    assert.equal(activated.lifecycle.source_revision, INITIAL_SOURCE_REVISION + 1);
    assert.equal(activated.lifecycle.active_story_digest, activated.run.active_story_digest);
    const zeroLifecycle = JSON.parse(activated.lifecycle.state_json);
    assert.deepEqual(zeroLifecycle.generationScope, []); assert.deepEqual(zeroLifecycle.questions, []);
    assert.equal(zeroLifecycle.history[0].id, "pre-feature-legacy");
    assert.match(
      activated.items.find((item) => item.id === STORY_ITEM_ID).organization_reason,
      /^oxygen\.story:/,
    );
    const currentCoverage = await readCoverageManifestAuthority(db, RUN_ID, semantic);
    assert.ok(currentCoverage);
    assert.equal(currentCoverage.rows.find((row) => row.unitId === "unit-private")
      .exclusionReason, "privacy_withheld");

    await db.prepare(`UPDATE redactions SET review_state='confirmed_keep',status='removed',
      updated_at=? WHERE id='source-private'`)
      .bind("2041-01-01T00:00:02.000Z").run();
    assert.equal(
      await readCoverageManifestAuthority(db, RUN_ID, semantic),
      null,
      "persisted coverage fails closed after its current Source Privacy decision changes",
    );
    await db.prepare(`UPDATE redactions SET review_state='deterministic',status='active',
      updated_at=? WHERE id='source-private'`).bind(timestamp).run();
    assert.ok(await readCoverageManifestAuthority(db, RUN_ID, semantic));
    const durableReceipt = await db.prepare(
      "SELECT * FROM source_privacy_receipts WHERE workflow_run_id=?",
    ).bind(RUN_ID).first();
    await db.prepare(`UPDATE source_privacy_receipts SET receipt_json=receipt_json||' '
      WHERE workflow_run_id=?`).bind(RUN_ID).run();
    assert.equal(await readCoverageManifestAuthority(db, RUN_ID, semantic), null,
      "valid but noncanonical durable receipt JSON fails closed");
    await db.prepare("UPDATE source_privacy_receipts SET receipt_json=? WHERE workflow_run_id=?")
      .bind(durableReceipt.receipt_json, RUN_ID).run();
    assert.ok(await readCoverageManifestAuthority(db, RUN_ID, semantic));
    await db.prepare("UPDATE items SET content=? WHERE id=?")
      .bind("Changed private synthetic event.", PRIVATE_ITEM_ID).run();
    assert.equal(
      await readCoverageManifestAuthority(db, RUN_ID, semantic),
      null,
      "a current-source digest change invalidates Source Privacy authority",
    );
    await db.prepare("UPDATE items SET content=? WHERE id=?")
      .bind("Private synthetic event.", PRIVATE_ITEM_ID).run();
    assert.ok(await readCoverageManifestAuthority(db, RUN_ID, semantic));
    await db.prepare("DELETE FROM source_privacy_receipts WHERE workflow_run_id=?")
      .bind(RUN_ID).run();
    assert.equal(await readCoverageManifestAuthority(db, RUN_ID, semantic), null,
      "a completed legacy job without its normalized receipt fails closed");
    await db.prepare(`INSERT INTO source_privacy_receipts
      (job_id,workflow_run_id,source_revision,source_digest,receipt_digest,receipt_json,created_at)
      VALUES (?,?,?,?,?,?,?)`).bind(
      durableReceipt.job_id, durableReceipt.workflow_run_id, durableReceipt.source_revision,
      durableReceipt.source_digest, durableReceipt.receipt_digest, durableReceipt.receipt_json,
      durableReceipt.created_at,
    ).run();
    assert.ok(await readCoverageManifestAuthority(db, RUN_ID, semantic));
    await db.prepare("DELETE FROM redactions WHERE id='source-private'").run();
    assert.equal(
      await readCoverageManifestAuthority(db, RUN_ID, semantic),
      null,
      "deleting the final redaction removes persisted privacy_withheld authority",
    );
  } finally {
    globalThis.__oxygenLocalSqlite?.database.close();
    delete globalThis.__oxygenLocalSqlite;
    if (previousStateDir === undefined) delete process.env.OXYGEN_VIEWER_STATE_DIR;
    else process.env.OXYGEN_VIEWER_STATE_DIR = previousStateDir;
    await rm(stateDir, { recursive: true, force: true });
  }
});
