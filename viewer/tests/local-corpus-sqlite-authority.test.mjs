import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[^/]+$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        return nextResolve(`${specifier}/index.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const now = "2036-01-01T00:00:00.000Z";

function corpusEntry(id, itemId, content) {
  return {
    document: {
      id,
      kind: "trajectory",
      title: `Synthetic ${id}`,
      sourceUser: "fixture-user",
      sourceSystem: "fixture-system",
      sourceTimestamp: now,
      metadata: { fixture: id },
      envelope: { source: "local-corpus-sqlite-authority" },
      itemCount: 1,
    },
    items: [{
      id: itemId,
      sequence: 1,
      eventType: "message",
      actorId: "fixture-actor",
      actorType: "assistant",
      timestamp: now,
      content,
      original: { event_id: itemId, trajectory_id: id },
    }],
  };
}

function storedCorpus(db, workflowRunId) {
  return Promise.all([
    db.prepare(`SELECT id,kind,title,source_user,source_system,source_timestamp,item_count,
      metadata_json,original_envelope_json FROM documents ORDER BY id`).all(),
    db.prepare(`SELECT id,document_id,sequence,event_type,actor_id,actor_type,timestamp,content,
      original_json FROM items ORDER BY id`).all(),
    db.prepare(`SELECT corpus_revision,corpus_digest,document_count,item_count
      FROM finalized_corpus_manifests WHERE workflow_run_id=?`).bind(workflowRunId).first(),
    db.prepare(`SELECT story_source_revision,story_generation_status,active_story_digest
      FROM workflow_runs WHERE id=?`).bind(workflowRunId).first(),
  ]).then(([documents, items, manifest, workflow]) => ({
    documents: documents.results,
    items: items.results,
    manifest,
    workflow,
  }));
}

async function durableCorpusSnapshot(db) {
  const tables = [
    "documents", "items", "finalized_corpus_manifests", "workflow_runs",
    "organization_jobs", "redaction_jobs",
  ];
  return Object.fromEntries(await Promise.all(tables.map(async (table) => {
    const { results } = await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    return [table, results];
  })));
}

function post(route, payload) {
  return route.POST(new Request("http://localhost/api/documents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }));
}

test("documents corpus replacement preserves real SQLite authority, rollback, and CAS boundaries", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "oxygen-local-corpus-authority-"));
  const priorStateDir = process.env.OXYGEN_VIEWER_STATE_DIR;
  process.env.OXYGEN_VIEWER_STATE_DIR = stateDir;

  try {
    const [{ getLocalDatabase }, { establishWorkflowRun }, route, publication] = await Promise.all([
      import("../db/index.ts"),
      import("../lib/workflow-run-server.ts"),
      import("../app/api/documents/route.ts"),
      import("../lib/story-source-publication.ts"),
    ]);
    const db = await getLocalDatabase();
    const workflowRunId = "workflow-local-corpus-sqlite";
    const established = await establishWorkflowRun(db, workflowRunId, now);
    assert.deepEqual(established, { state: "EXACT_RUN_ESTABLISHED", workflowRunId });

    const firstPayload = { documents: [
      corpusEntry("trajectory-alpha", "event-alpha", "alpha content"),
      corpusEntry("trajectory-beta", "event-beta", "beta content"),
    ] };
    const firstResponse = await post(route, firstPayload);
    assert.equal(firstResponse.status, 200);
    const firstResult = await firstResponse.json();
    const firstDigest = await route.finalizedCorpusDigest(route.normalizeFinalizedCorpus(firstPayload));
    assert.deepEqual(firstResult, {
      finalized: true,
      corpusRevision: 1,
      corpusDigest: firstDigest,
      documentCount: 2,
      itemCount: 2,
    });

    const firstStored = await storedCorpus(db, workflowRunId);
    assert.deepEqual(firstStored.documents, [
      {
        id: "trajectory-alpha", kind: "trajectory", title: "Synthetic trajectory-alpha",
        source_user: "fixture-user", source_system: "fixture-system", source_timestamp: now,
        item_count: 1, metadata_json: '{"fixture":"trajectory-alpha"}',
        original_envelope_json: '{"source":"local-corpus-sqlite-authority"}',
      },
      {
        id: "trajectory-beta", kind: "trajectory", title: "Synthetic trajectory-beta",
        source_user: "fixture-user", source_system: "fixture-system", source_timestamp: now,
        item_count: 1, metadata_json: '{"fixture":"trajectory-beta"}',
        original_envelope_json: '{"source":"local-corpus-sqlite-authority"}',
      },
    ]);
    assert.deepEqual(firstStored.items, [
      {
        id: "event-alpha", document_id: "trajectory-alpha", sequence: 1,
        event_type: "message", actor_id: "fixture-actor", actor_type: "assistant", timestamp: now,
        content: "alpha content", original_json: '{"event_id":"event-alpha","trajectory_id":"trajectory-alpha"}',
      },
      {
        id: "event-beta", document_id: "trajectory-beta", sequence: 1,
        event_type: "message", actor_id: "fixture-actor", actor_type: "assistant", timestamp: now,
        content: "beta content", original_json: '{"event_id":"event-beta","trajectory_id":"trajectory-beta"}',
      },
    ]);
    assert.deepEqual(firstStored.manifest, {
      corpus_revision: 1,
      corpus_digest: firstDigest,
      document_count: 2,
      item_count: 2,
    });
    assert.deepEqual(firstStored.workflow, {
      story_source_revision: 1,
      story_generation_status: "not_started",
      active_story_digest: null,
    });

    const beforeIdentical = await durableCorpusSnapshot(db);
    const identicalResponse = await post(route, firstPayload);
    assert.equal(identicalResponse.status, 200);
    assert.deepEqual(await identicalResponse.json(), firstResult);
    assert.deepEqual(await durableCorpusSnapshot(db), beforeIdentical,
      "an exact-current corpus attach must not rewrite any durable source authority");

    await db.prepare(`INSERT INTO organization_jobs
      (id,status,stage,started_at,updated_at) VALUES (?,?,?,?,?)`)
      .bind("organization-before-replace", "complete", "done", now, now).run();
    await db.prepare(`INSERT INTO redaction_jobs
      (id,status,stage,completed,rejected,started_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind("redaction-before-replace", "complete", "done", 1, 0, now, now, now).run();

    const replacementPayload = {
      documents: [corpusEntry("trajectory-current", "event-current", "current content")],
    };
    const replacementResponse = await post(route, replacementPayload);
    assert.equal(replacementResponse.status, 200);
    const replacementResult = await replacementResponse.json();
    const replacementDigest = await route.finalizedCorpusDigest(
      route.normalizeFinalizedCorpus(replacementPayload),
    );
    assert.deepEqual(replacementResult, {
      finalized: true,
      corpusRevision: 2,
      corpusDigest: replacementDigest,
      documentCount: 1,
      itemCount: 1,
    });
    const replacementStored = await storedCorpus(db, workflowRunId);
    assert.deepEqual(replacementStored.documents.map((row) => row.id), ["trajectory-current"]);
    assert.deepEqual(replacementStored.items.map((row) => row.id), ["event-current"]);
    assert.deepEqual(replacementStored.manifest, {
      corpus_revision: 2,
      corpus_digest: replacementDigest,
      document_count: 1,
      item_count: 1,
    });
    assert.deepEqual(replacementStored.workflow, {
      story_source_revision: 2,
      story_generation_status: "not_started",
      active_story_digest: null,
    });
    assert.equal(await db.prepare("SELECT id FROM organization_jobs").first(), null);
    assert.deepEqual(await db.prepare(`SELECT status,stage,completed_at FROM redaction_jobs
      WHERE id=?`).bind("redaction-before-replace").first(), {
      status: "stale", stage: "source_changed", completed_at: null,
    });

    await db.prepare("UPDATE items SET content=? WHERE id=?")
      .bind("tampered current content", "event-current").run();
    const drifted = await storedCorpus(db, workflowRunId);
    assert.equal(drifted.manifest.corpus_digest, replacementDigest,
      "the matching manifest remains present while its canonical row has drifted");
    const repairedResponse = await post(route, replacementPayload);
    assert.equal(repairedResponse.status, 200);
    assert.deepEqual(await repairedResponse.json(), {
      ...replacementResult,
      corpusRevision: 3,
    });
    const repaired = await storedCorpus(db, workflowRunId);
    assert.equal(repaired.items[0].content, "current content");
    assert.equal(repaired.workflow.story_source_revision, 3);

    await db.prepare(`CREATE TRIGGER fail_replacement_item BEFORE INSERT ON items
      WHEN NEW.id='event-failing' BEGIN SELECT RAISE(ABORT, 'forced replacement failure'); END`).run();
    const beforeFailure = await storedCorpus(db, workflowRunId);
    await assert.rejects(
      post(route, { documents: [corpusEntry("trajectory-failing", "event-failing", "must roll back")] }),
      /forced replacement failure/,
    );
    const afterFailure = await storedCorpus(db, workflowRunId);
    assert.deepEqual(afterFailure.documents, beforeFailure.documents);
    assert.deepEqual(afterFailure.items, beforeFailure.items);
    assert.deepEqual(afterFailure.manifest, beforeFailure.manifest);
    assert.equal(afterFailure.workflow.story_source_revision, beforeFailure.workflow.story_source_revision);
    assert.deepEqual(afterFailure.workflow, {
      ...beforeFailure.workflow,
      story_generation_status: "blocked",
      active_story_digest: null,
    });

    assert.equal(await publication.beginStorySourceMutation(db, workflowRunId, now), true);
    const beforeCasZero = await storedCorpus(db, workflowRunId);
    const activeWriterResponse = await post(route, replacementPayload);
    assert.equal(activeWriterResponse.status, 409);
    assert.deepEqual(await storedCorpus(db, workflowRunId), beforeCasZero,
      "an active source writer must never be accepted as an exact-current no-op");
    const casPublished = await publication.publishFinalizedCorpusSourceMutation(
      db,
      [
        db.prepare("UPDATE documents SET title=? WHERE id=? AND 1=0")
          .bind("must not publish", "trajectory-current"),
        db.prepare(`UPDATE finalized_corpus_manifests SET corpus_digest=?
          WHERE workflow_run_id=? AND 1=0`).bind("not-a-digest", workflowRunId),
      ],
      workflowRunId,
      Number(beforeCasZero.workflow.story_source_revision) + 1,
      Number(beforeCasZero.manifest.corpus_revision) + 1,
      "not-a-digest",
      Number(beforeCasZero.manifest.document_count),
      Number(beforeCasZero.manifest.item_count),
      now,
    );
    assert.equal(casPublished, false);
    assert.deepEqual(await storedCorpus(db, workflowRunId), beforeCasZero);
  } finally {
    globalThis.__oxygenLocalSqlite?.database.close();
    delete globalThis.__oxygenLocalSqlite;
    if (priorStateDir === undefined) delete process.env.OXYGEN_VIEWER_STATE_DIR;
    else process.env.OXYGEN_VIEWER_STATE_DIR = priorStateDir;
    await rm(stateDir, { recursive: true, force: true });
  }
});
