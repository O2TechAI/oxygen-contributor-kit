import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { testStoryCoverage } from "./fixtures/story-coverage.mjs";
import { readFile } from "node:fs/promises";
import { STORY_PREFIX } from "../lib/timeline.ts";
import {
  createStoryReviewSession,
  STORY_REVIEW_SESSION_SCHEMA,
  storyReviewSessionSemanticJson,
} from "../lib/story-review-session.ts";
import {
  editHumanInsight,
  emptyChapterReview,
} from "../lib/story-review.ts";

const serverModule = await import("../lib/story-review-session-server.ts")
  .catch((importError) => ({ importError }));

function serverContract() {
  assert.equal(serverModule.importError, undefined, "server-owned review-session CAS helper must exist");
  return {
    ...serverModule,
    persistStoryReviewSessionCas: (db, request, serverNow) => serverModule.persistStoryReviewSessionCas(db, {
      storySessionSchema: request.session.schema,
      ...request,
    }, serverNow),
  };
}

const storyEvidence = { documentId: "story-doc", eventId: "story-doc:story-item" };
const storySource = {
  schema: "oxygen.story",
  key: "story-chapter",
  phase: { id: "phase-review", label: "Review" },
  title: "Synthetic story Chapter",
  overview: "A public-safe synthetic source exercises exact session dispatch.",
  people: [{
    id: "person-owner",
    releaseLabel: "Owner",
    role: "Reviewer",
    description: "Reviews the synthetic package.",
    localIdentityState: "not_identified",
    evidence: [storyEvidence],
  }],
  story: { blocks: [{ id: "block-safe", text: "A synthetic Story block.", evidence: [storyEvidence] }] },
  insights: [],
  evidence: { primary: storyEvidence, supporting: [] },
  coverage: testStoryCoverage(),
};

function storySession(label = "", updatedAt = "2099-01-01T00:00:00.000Z") {
  let review = emptyChapterReview(storySource);
  if (label) {
    review = editHumanInsight(review, storySource, `human:${label}`, {
      background: `A bounded ${label} context.`,
      quote: {
        chapterKey: storySource.key,
        storyBlockId: "block-safe",
        selection: { start: 2, end: 17, text: "synthetic Story" },
        baseRevision: 1,
      },
      directlyAcquiredExperience: "The exact source changed the reviewed decision.",
      principle: "Validate durable review state against its exact source.",
      evidence: [storyEvidence],
    });
  }
  return createStoryReviewSession("review-run", { [storySource.key]: review }, {}, updatedAt);
}

const session = storySession;

class SqliteReviewDb {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec(`
      CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY,
        story_generation_status TEXT,
        story_source_revision INTEGER
      );
      CREATE TABLE items (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        timestamp TEXT,
        event_type TEXT,
        actor_id TEXT,
        actor_type TEXT,
        organization_reason TEXT
      );
      CREATE TABLE story_review_sessions (
        workflow_run_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        server_version INTEGER NOT NULL
      );
    `);
    this.sqlite.prepare(`INSERT INTO workflow_runs
      (id,story_generation_status,story_source_revision) VALUES (?,?,?)`)
      .run("review-run", "ready_for_human_review", 1);
    this.sqlite.prepare(`INSERT INTO items
      (id,document_id,sequence,event_type,actor_id,actor_type,organization_reason)
      VALUES (?,?,?,?,?,?,?)`).run(
        storyEvidence.eventId,
        storyEvidence.documentId,
        1,
        "message",
        "owner",
        "user",
        `${STORY_PREFIX}${JSON.stringify(storySource)}`,
      );
  }

  prepare(sql) {
    const statement = this.sqlite.prepare(sql);
    let values = [];
    return {
      bind(...next) { values = next; return this; },
      all: async () => ({ results: statement.all(...values) }),
      first: async () => statement.get(...values) ?? null,
      run: async () => {
        const result = statement.run(...values);
        return { meta: { changes: Number(result.changes) } };
      },
    };
  }

  close() {
    this.sqlite.close();
  }
}

function useStorySource(db) {
  db.items = [{
    id: storyEvidence.eventId,
    document_id: storyEvidence.documentId,
    event_type: "message",
    actor_id: "owner",
    actor_type: "user",
    summary: `oxygen.story:${JSON.stringify(storySource)}`,
  }];
  return db;
}

function storySessionWithHuman(updatedAt = "2099-01-01T00:00:00.000Z") {
  const base = emptyChapterReview(storySource);
  const human = editHumanInsight(base, storySource, "human:valid", {
    background: "A bounded human-authored context.",
    quote: {
      chapterKey: storySource.key,
      storyBlockId: "block-safe",
      selection: { start: 2, end: 17, text: "synthetic Story" },
      baseRevision: 1,
    },
    directlyAcquiredExperience: "The exact source changed the reviewed decision.",
    principle: "Validate durable review state against its exact source.",
    evidence: [storyEvidence],
  });
  return createStoryReviewSession("review-run", {
    [storySource.key]: human,
  }, {}, updatedAt);
}

class FakeReviewDb {
  runs = new Map([["review-run", { status: "ready_for_human_review", sourceRevision: 1 }]]);
  items = [{
    id: storyEvidence.eventId,
    document_id: storyEvidence.documentId,
    event_type: "message",
    actor_id: "owner",
    actor_type: "user",
    summary: `${STORY_PREFIX}${JSON.stringify(storySource)}`,
  }];
  sessions = new Map();
  writeQueue = Promise.resolve();

  prepare(sql) {
    let values = [];
    return {
      bind(...next) { values = next; return this; },
      all: async () => {
        if (/organization_reason AS summary/.test(sql)) return { results: this.items
          .filter((item) => /^oxygen\.story:/.test(item.summary))
          .map((item) => ({
            id: item.id.includes(":") ? item.id : `${item.document_id}:${item.id}`,
            documentId: item.document_id,
            summary: item.summary,
          })) };
        if (/event_type AS eventType/.test(sql)) return { results: this.items.map((item) => ({
          id: item.id.includes(":") ? item.id : `${item.document_id}:${item.id}`,
          documentId: item.document_id,
          eventType: item.event_type,
          actorId: item.actor_id,
          actorType: item.actor_type,
        })) };
        throw new Error(`Unexpected all SQL: ${sql}`);
      },
      first: async () => {
        if (/FROM workflow_runs/.test(sql)) {
          const run = this.runs.get(values[0]);
          return run ? {
            story_generation_status: run.status,
            story_source_revision: run.sourceRevision,
          } : null;
        }
        if (/FROM story_review_sessions/.test(sql)) {
          const row = this.sessions.get(values[0]);
          return row ? {
            state_json: row.stateJson,
            updated_at: row.updatedAt,
            server_version: row.serverVersion,
          } : null;
        }
        throw new Error(`Unexpected first SQL: ${sql}`);
      },
      run: async () => {
        const previous = this.writeQueue;
        let release;
        this.writeQueue = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
          if (/INSERT INTO story_review_sessions/.test(sql)) {
            const [workflowRunId, stateJson, updatedAt, sourceRunId, sourceRevision] = values;
            const run = this.runs.get(sourceRunId);
            if (this.sessions.has(workflowRunId)
              || !run || run.status !== "ready_for_human_review"
              || run.sourceRevision !== sourceRevision) return { meta: { changes: 0 } };
            this.sessions.set(workflowRunId, { stateJson, updatedAt, serverVersion: 1 });
            return { meta: { changes: 1 } };
          }
          if (/server_version=server_version\+1/.test(sql)) {
            const [stateJson, updatedAt, workflowRunId, expectedVersion, sourceRunId, sourceRevision] = values;
            const row = this.sessions.get(workflowRunId);
            const run = this.runs.get(sourceRunId);
            if (!row || row.serverVersion !== expectedVersion
              || !run || run.status !== "ready_for_human_review"
              || run.sourceRevision !== sourceRevision) return { meta: { changes: 0 } };
            row.stateJson = stateJson;
            row.updatedAt = updatedAt;
            row.serverVersion += 1;
            return { meta: { changes: 1 } };
          }
          if (/SET server_version=server_version/.test(sql)) {
            const [workflowRunId, expectedVersion, stateJson, sourceRunId, sourceRevision] = values;
            const row = this.sessions.get(workflowRunId);
            const run = this.runs.get(sourceRunId);
            return { meta: { changes: Number(Boolean(row
              && row.serverVersion === expectedVersion
              && row.stateJson === stateJson
              && run?.status === "ready_for_human_review"
              && run.sourceRevision === sourceRevision)) } };
          }
          throw new Error(`Unexpected run SQL: ${sql}`);
        } finally {
          release();
        }
      },
    };
  }
}

test("the canonical contract creates, saves, and refreshes one Story session", async () => {
  const { readActiveStoryReviewContract, readStoryReviewSessionRecord } = serverContract();
  const db = useStorySource(new FakeReviewDb());
  const active = await readActiveStoryReviewContract(db, "review-run");
  assert.equal(active.storySourceSchema, "oxygen.story");
  assert.equal(active.storySessionSchema, STORY_REVIEW_SESSION_SCHEMA);
  const saved = await serverModule.persistStoryReviewSessionCas(db, {
    workflowRunId: "review-run",
    expectedVersion: 0,
    sourceRevision: 1,
    storySessionSchema: active.storySessionSchema,
    session: storySession(),
  }, "2035-01-01T00:00:00.000Z");
  assert.equal(saved.ok, true);
  assert.equal(saved.serverVersion, 1);
  const refreshed = await readStoryReviewSessionRecord(db, "review-run");
  assert.equal(refreshed.session.schema, STORY_REVIEW_SESSION_SCHEMA);
  assert.equal(refreshed.sourceRevision, 1);
});

test("initial metadata is version 0 and first exact create advances 0 to 1", async () => {
  const { readStoryReviewSessionRecord, persistStoryReviewSessionCas } = serverContract();
  const db = new FakeReviewDb();
  assert.deepEqual(await readStoryReviewSessionRecord(db, "review-run"), {
    session: null, serverVersion: 0, sourceRevision: null, persistedAt: null,
  });
  const result = await persistStoryReviewSessionCas(db, {
    workflowRunId: "review-run", expectedVersion: 0, sourceRevision: 1, session: session("first"),
  }, "2035-01-01T00:00:00.000Z");
  assert.deepEqual(result, {
    ok: true, saved: true, noChange: false, serverVersion: 1,
    sourceRevision: 1, persistedAt: "2035-01-01T00:00:00.000Z",
  });
});

test("sequential semantic update advances 1 to 2 and server time owns persisted state", async () => {
  const { persistStoryReviewSessionCas, readStoryReviewSessionRecord } = serverContract();
  const db = new FakeReviewDb();
  await persistStoryReviewSessionCas(db, {
    workflowRunId: "review-run", expectedVersion: 0, sourceRevision: 1,
    session: session("first", "2999-12-31T23:59:59.999Z"),
  }, "2035-01-01T00:00:00.000Z");
  const updated = await persistStoryReviewSessionCas(db, {
    workflowRunId: "review-run", expectedVersion: 1, sourceRevision: 1,
    session: session("second", "1900-01-01T00:00:00.000Z"),
  }, "2035-01-01T00:00:01.000Z");
  assert.equal(updated.serverVersion, 2);
  const stored = await readStoryReviewSessionRecord(db, "review-run");
  assert.equal(stored.session.updatedAt, "2035-01-01T00:00:01.000Z");
  assert.equal(stored.persistedAt, "2035-01-01T00:00:01.000Z");
});

test("semantic no-op ignores client updatedAt and does not mutate version or timestamp", async () => {
  const { persistStoryReviewSessionCas } = serverContract();
  const db = new FakeReviewDb();
  await persistStoryReviewSessionCas(db, {
    workflowRunId: "review-run", expectedVersion: 0, sourceRevision: 1, session: session("same"),
  }, "2035-01-01T00:00:00.000Z");
  const before = structuredClone(db.sessions.get("review-run"));
  const result = await persistStoryReviewSessionCas(db, {
    workflowRunId: "review-run", expectedVersion: 1, sourceRevision: 1,
    session: session("same", "9999-12-31T23:59:59.999Z"),
  }, "2035-01-01T00:00:09.000Z");
  assert.deepEqual(result, {
    ok: true, saved: false, noChange: true, serverVersion: 1,
    sourceRevision: 1, persistedAt: "2035-01-01T00:00:00.000Z",
  });
  assert.deepEqual(db.sessions.get("review-run"), before);
});

test("the canonical session uses the CAS, server timestamp, and semantic no-op path", async () => {
  const { persistStoryReviewSessionCas, readStoryReviewSessionRecord } = serverContract();
  const db = useStorySource(new FakeReviewDb());
  const created = await persistStoryReviewSessionCas(db, {
    workflowRunId: "review-run", expectedVersion: 0, sourceRevision: 1,
    session: storySession("", "2999-12-31T23:59:59.999Z"),
  }, "2035-01-01T00:00:00.000Z");
  assert.equal(created.serverVersion, 1);
  const stored = await readStoryReviewSessionRecord(db, "review-run");
  assert.equal(stored.session.schema, "oxygen.story-review-session");
  assert.equal(stored.session.updatedAt, "2035-01-01T00:00:00.000Z");
  const noChange = await persistStoryReviewSessionCas(db, {
    workflowRunId: "review-run", expectedVersion: 1, sourceRevision: 1,
    session: storySession("", "9999-12-31T23:59:59.999Z"),
  }, "2035-01-01T00:00:09.000Z");
  assert.equal(noChange.noChange, true);
  assert.equal(noChange.serverVersion, 1);
});

test("story CAS rejects source-invalid updates without changing durable state or version", async () => {
  const { persistStoryReviewSessionCas, readStoryReviewSessionRecord, STORY_SESSION_ERROR } = serverContract();
  const db = useStorySource(new FakeReviewDb());
  const valid = storySessionWithHuman();
  const created = await persistStoryReviewSessionCas(db, {
    workflowRunId: "review-run", expectedVersion: 0, sourceRevision: 1, session: valid,
  }, "2035-01-01T00:00:00.000Z");
  assert.equal(created.serverVersion, 1);
  const durableBefore = structuredClone(db.sessions.get("review-run"));
  const durableRecordBefore = await readStoryReviewSessionRecord(db, "review-run");

  const missingChapter = structuredClone(valid);
  missingChapter.chapterReviews = {};
  const foreignInsight = structuredClone(valid);
  foreignInsight.chapterReviews[storySource.key].sourceInsightReviews.foreign = {
    origin: "source_ai", version: 1, decision: "pending", resolution: "pending",
  };
  const foreignAnchor = structuredClone(valid);
  foreignAnchor.chapterReviews[storySource.key]
    .humanInsights["human:valid"].content.quote.storyBlockId = "missing-block";
  const foreignEvidence = structuredClone(valid);
  foreignEvidence.chapterReviews[storySource.key]
    .humanInsights["human:valid"].content.evidence = [{ documentId: "foreign", eventId: "missing" }];

  for (const invalid of [missingChapter, foreignInsight, foreignAnchor, foreignEvidence]) {
    const rejected = await persistStoryReviewSessionCas(db, {
      workflowRunId: "review-run", expectedVersion: 1, sourceRevision: 1, session: invalid,
    }, "2035-01-01T00:00:01.000Z");
    assert.equal(rejected.code, STORY_SESSION_ERROR.stateInvalid);
    assert.deepEqual(db.sessions.get("review-run"), durableBefore);
    const durable = await readStoryReviewSessionRecord(db, "review-run");
    assert.equal(durable.serverVersion, 1);
    assert.deepEqual(durable, durableRecordBefore);
  }
});

test("semantic comparison is deterministic across record insertion order", () => {
  const left = session("");
  left.privacyDecisions = { b: "keep", a: "redact" };
  const right = session("");
  right.privacyDecisions = { a: "redact", b: "keep" };
  assert.equal(storyReviewSessionSemanticJson(left), storyReviewSessionSemanticJson(right));
});

test("stale, future, and invalid versions fail without mutation", async () => {
  const { persistStoryReviewSessionCas, STORY_SESSION_ERROR } = serverContract();
  const db = new FakeReviewDb();
  await persistStoryReviewSessionCas(db, {
    workflowRunId: "review-run", expectedVersion: 0, sourceRevision: 1, session: session("first"),
  }, "2035-01-01T00:00:00.000Z");
  const before = structuredClone(db.sessions.get("review-run"));
  for (const expectedVersion of [0, 2]) {
    const result = await persistStoryReviewSessionCas(db, {
      workflowRunId: "review-run", expectedVersion, sourceRevision: 1, session: session("loser"),
    }, "2035-01-01T00:00:02.000Z");
    assert.equal(result.code, STORY_SESSION_ERROR.versionConflict);
    assert.equal(result.serverVersion, 1);
  }
  for (const expectedVersion of [-1, 1.5, Number.NaN]) {
    const result = await persistStoryReviewSessionCas(db, {
      workflowRunId: "review-run", expectedVersion, sourceRevision: 1, session: session("invalid"),
    }, "2035-01-01T00:00:03.000Z");
    assert.equal(result.code, STORY_SESSION_ERROR.versionInvalid);
  }
  assert.deepEqual(db.sessions.get("review-run"), before);
});

test("concurrent first writers leave one row at version 1 without overwrite", async () => {
  const { persistStoryReviewSessionCas, STORY_SESSION_ERROR } = serverContract();
  const db = new FakeReviewDb();
  const results = await Promise.all([
    persistStoryReviewSessionCas(db, {
      workflowRunId: "review-run", expectedVersion: 0, sourceRevision: 1, session: session("a"),
    }, "2035-01-01T00:00:00.000Z"),
    persistStoryReviewSessionCas(db, {
      workflowRunId: "review-run", expectedVersion: 0, sourceRevision: 1, session: session("b"),
    }, "2035-01-01T00:00:01.000Z"),
  ]);
  assert.equal(db.sessions.size, 1);
  assert.equal(db.sessions.get("review-run").serverVersion, 1);
  assert.equal(results.filter((result) => result.saved).length, 1);
  assert.equal(results.filter((result) => result.code === STORY_SESSION_ERROR.versionConflict).length, 1);
});

test("real SQLite CAS produces exactly one winner and one stale loser", async () => {
  const { persistStoryReviewSessionCas, readStoryReviewSessionRecord, STORY_SESSION_ERROR } = serverContract();
  const db = new SqliteReviewDb();
  try {
    const results = await Promise.all([
      persistStoryReviewSessionCas(db, {
        workflowRunId: "review-run", expectedVersion: 0, sourceRevision: 1, session: session("sqlite-a"),
      }, "2035-01-01T00:00:00.000Z"),
      persistStoryReviewSessionCas(db, {
        workflowRunId: "review-run", expectedVersion: 0, sourceRevision: 1, session: session("sqlite-b"),
      }, "2035-01-01T00:00:01.000Z"),
    ]);
    assert.equal(results.filter((result) => result.ok && result.saved).length, 1);
    assert.equal(results.filter((result) => !result.ok && result.code === STORY_SESSION_ERROR.versionConflict).length, 1);
    const record = await readStoryReviewSessionRecord(db, "review-run");
    assert.equal(record.serverVersion, 1);
    assert.equal(record.sourceRevision, 1);
    assert.ok(record.session);
  } finally {
    db.close();
  }
});

test("concurrent tabs with version N allow one N+1 winner and reject the stale tab", async () => {
  const { persistStoryReviewSessionCas, readStoryReviewSessionRecord, STORY_SESSION_ERROR } = serverContract();
  const db = new FakeReviewDb();
  await persistStoryReviewSessionCas(db, {
    workflowRunId: "review-run", expectedVersion: 0, sourceRevision: 1, session: session("base"),
  }, "2035-01-01T00:00:00.000Z");
  const [a, b] = await Promise.all([
    persistStoryReviewSessionCas(db, {
      workflowRunId: "review-run", expectedVersion: 1, sourceRevision: 1, session: session("a"),
    }, "2035-01-01T00:00:01.000Z"),
    persistStoryReviewSessionCas(db, {
      workflowRunId: "review-run", expectedVersion: 1, sourceRevision: 1, session: session("b"),
    }, "2035-01-01T00:00:02.000Z"),
  ]);
  assert.equal([a, b].filter((result) => result.saved).length, 1);
  assert.equal([a, b].filter((result) => result.code === STORY_SESSION_ERROR.versionConflict).length, 1);
  assert.equal((await readStoryReviewSessionRecord(db, "review-run")).serverVersion, 2);
});

test("an identical concurrent update is still stale after another tab advances the version", async () => {
  const { persistStoryReviewSessionCas, STORY_SESSION_ERROR } = serverContract();
  const db = new FakeReviewDb();
  await persistStoryReviewSessionCas(db, {
    workflowRunId: "review-run", expectedVersion: 0, sourceRevision: 1, session: session("base"),
  }, "2035-01-01T00:00:00.000Z");
  const results = await Promise.all([
    persistStoryReviewSessionCas(db, {
      workflowRunId: "review-run", expectedVersion: 1, sourceRevision: 1, session: session("same-next"),
    }, "2035-01-01T00:00:01.000Z"),
    persistStoryReviewSessionCas(db, {
      workflowRunId: "review-run", expectedVersion: 1, sourceRevision: 1, session: session("same-next"),
    }, "2035-01-01T00:00:02.000Z"),
  ]);
  assert.equal(results.filter((result) => result.saved).length, 1);
  assert.equal(results.filter((result) => result.code === STORY_SESSION_ERROR.versionConflict).length, 1);
  assert.equal(db.sessions.get("review-run").serverVersion, 2);
});

test("source R1 to R2 rejects the old tab and advances one monotonic sequence", async () => {
  const { persistStoryReviewSessionCas, readStoryReviewSessionRecord, STORY_SESSION_ERROR } = serverContract();
  const db = new FakeReviewDb();
  await persistStoryReviewSessionCas(db, {
    workflowRunId: "review-run", expectedVersion: 0, sourceRevision: 1, session: session("r1"),
  }, "2035-01-01T00:00:00.000Z");
  db.runs.get("review-run").sourceRevision = 2;
  const old = await persistStoryReviewSessionCas(db, {
    workflowRunId: "review-run", expectedVersion: 1, sourceRevision: 1, session: session("old"),
  }, "2035-01-01T00:00:01.000Z");
  assert.equal(old.code, STORY_SESSION_ERROR.sourceConflict);
  const metadata = await readStoryReviewSessionRecord(db, "review-run");
  assert.equal(metadata.serverVersion, 1);
  assert.equal(metadata.sourceRevision, 1);
  const fresh = await persistStoryReviewSessionCas(db, {
    workflowRunId: "review-run", expectedVersion: 1, sourceRevision: 2, session: session("r2"),
  }, "2035-01-01T00:00:02.000Z");
  assert.equal(fresh.serverVersion, 2);
  assert.equal((await readStoryReviewSessionRecord(db, "review-run")).sourceRevision, 2);
});

test("current schema defines exactly one integer version field", async () => {
  const dbSource = await readFile(new URL("../db/index.ts", import.meta.url), "utf8");
  assert.equal((dbSource.match(/server_version INTEGER NOT NULL DEFAULT 0/g) || []).length, 1);
});
