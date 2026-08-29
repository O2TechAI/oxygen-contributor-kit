import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { publishFinalizedCorpusSourceMutation } from "../lib/story-source-publication.ts";

const routePath = fileURLToPath(new URL("../app/api/documents/route.ts", import.meta.url));
const routeSource = readFileSync(routePath, "utf8");
const organizationSource = readFileSync(
  new URL("../app/api/organization/route.ts", import.meta.url),
  "utf8",
);
const dbSource = readFileSync(new URL("../db/index.ts", import.meta.url), "utf8");

function loadCorpusHarness() {
  const start = routeSource.indexOf("type NormalizedItem");
  const end = routeSource.indexOf("function corpusErrorResponse");
  assert.ok(start >= 0 && end > start, "documents route exposes one pure validation region");
  const source = routeSource.slice(start, end).replace(/^export /gm, "");
  const javascript = stripTypeScriptTypes(source);
  return Function(`${javascript}\nreturn {
    normalizeFinalizedCorpus, finalizedCorpusDigest, canonicalCorpusJson,
    CorpusValidationError
  };`)();
}

const corpus = loadCorpusHarness();

function loadOrganizationHarness() {
  const start = organizationSource.indexOf("type FinalizedCorpusAuthority");
  const end = organizationSource.indexOf("async function status");
  assert.ok(start >= 0 && end > start, "Organization exposes one bounded corpus gate region");
  const javascript = stripTypeScriptTypes(organizationSource.slice(start, end));
  return Function(`${javascript}\nreturn {
    readFinalizedCorpusAuthority, finalizedCorpusCountsMatch
  };`)();
}

const organization = loadOrganizationHarness();

function loadOrganizationIdentityHarness() {
  const start = organizationSource.indexOf("const originalEventId = original?.event_id;");
  const end = organizationSource.indexOf("if (!identityMatches)", start);
  assert.ok(start >= 0 && end > start, "Organization exposes one source identity predicate");
  return Function("original", "row", `${organizationSource.slice(start, end)}
    return identityMatches;
  `);
}

const organizationIdentityMatches = loadOrganizationIdentityHarness();

function trajectoryEntry(documentId, itemId, overrides = {}) {
  return {
    document: {
      id: documentId,
      kind: "trajectory",
      title: `Trajectory ${documentId}`,
      sourceUser: "contributor",
      sourceSystem: "synthetic",
      sourceTimestamp: "2036-01-01T00:00:00.000Z",
      metadata: { nested: { z: 2, a: 1 } },
      envelope: { format: "oxygen-events-jsonl" },
      itemCount: 1,
    },
    items: [{
      id: itemId,
      sequence: 1,
      eventType: "message",
      actorId: "person-safe",
      actorType: "human",
      timestamp: "2036-01-01T00:00:01.000Z",
      content: "Safe synthetic contribution.",
      original: {
        trajectory_id: documentId,
        event_id: itemId,
        payload: { role: "user", text: "Safe synthetic contribution." },
      },
    }],
    ...overrides,
  };
}

function meetingEntry(documentId) {
  return {
    document: {
      id: documentId,
      kind: "meeting",
      title: `Meeting ${documentId}`,
      sourceSystem: "meeting-transcript",
      sourceTimestamp: "2036-01-02",
      metadata: { review_status: "complete" },
      envelope: { records: [] },
      itemCount: 1,
    },
    items: [{
      id: `${documentId}:rec-00001`,
      sequence: 1,
      eventType: "record",
      actorId: "speaker-safe",
      actorType: "human",
      content: "Safe synthetic meeting record.",
      original: { record_id: "rec-00001", text: "Safe synthetic meeting record." },
    }],
  };
}

function errorCode(action) {
  try {
    action();
  } catch (error) {
    return error.code;
  }
  assert.fail("expected corpus validation to fail");
}

test("one complete multi-document corpus normalizes with exact global ownership and counts", () => {
  const input = {
    documents: [
      meetingEntry("meeting-safe"),
      trajectoryEntry("trajectory-safe", "evt-safe"),
    ],
  };
  const normalized = corpus.normalizeFinalizedCorpus(input);
  assert.equal(normalized.documents.length, 2);
  assert.equal(normalized.itemCount, 2);
  assert.deepEqual(normalized.documents.map((document) => document.id), [
    "meeting-safe",
    "trajectory-safe",
  ]);
  assert.deepEqual(normalized.documents.flatMap((document) => (
    document.items.map((item) => [item.id, item.documentId])
  )), [
    ["meeting-safe:rec-00001", "meeting-safe"],
    ["evt-safe", "trajectory-safe"],
  ]);
});

test("finalized item identity excludes and rejects Organization-owned fields", async () => {
  const input = { documents: [trajectoryEntry("trajectory-safe", "evt-safe")] };
  for (const [field, value] of [
    ["organizationCategory", "Synthetic Project"],
    ["organizationConfidence", 90],
    ["organizationReason", "Synthetic unit"],
  ]) {
    const legacy = structuredClone(input);
    legacy.documents[0].items[0][field] = value;
    assert.equal(
      errorCode(() => corpus.normalizeFinalizedCorpus(legacy)),
      "CORPUS_ITEM_INVALID",
    );
  }

  const normalized = corpus.normalizeFinalizedCorpus(input);
  const normalizedItem = normalized.documents[0].items[0];
  assert.deepEqual(Object.keys(normalizedItem).sort(), [
    "actorId", "actorType", "content", "documentId", "eventType", "id",
    "originalJson", "sequence", "timestamp",
  ]);
  assert.doesNotMatch(
    normalized.canonicalPayload,
    /organization(?:Category|Confidence|Reason)/,
  );
  const digest = await corpus.finalizedCorpusDigest(normalized);
  Object.assign(normalizedItem, {
    organizationCategory: "downstream-project",
    organizationConfidence: 100,
    organizationReason: "downstream-semantic-unit",
  });
  assert.equal(await corpus.finalizedCorpusDigest(normalized), digest);
});

test("document and item IDs preserve canonical and exact ownership grammars", () => {
  for (const documentId of ["a", "Runner.id_with-dashes", `a${"b".repeat(254)}`]) {
    assert.equal(
      corpus.normalizeFinalizedCorpus({
        documents: [trajectoryEntry(documentId, "evt-safe")],
      }).documents[0].id,
      documentId,
    );
  }

  assert.equal(errorCode(() => corpus.normalizeFinalizedCorpus({
    documents: [trajectoryEntry("trajectory:ambiguous", "evt-safe")],
  })), "CORPUS_DOCUMENT_ID_INVALID");
  assert.equal(errorCode(() => corpus.normalizeFinalizedCorpus({
    documents: [trajectoryEntry(`a${"b".repeat(255)}`, "evt-safe")],
  })), "CORPUS_DOCUMENT_ID_INVALID");

  const qualified = meetingEntry("meeting-safe");
  qualified.items[0].id = "meeting-safe:record:00001";
  assert.equal(
    corpus.normalizeFinalizedCorpus({ documents: [qualified] }).documents[0].items[0].id,
    "meeting-safe:record:00001",
  );

  const prefixConfusable = meetingEntry("meeting-safe");
  prefixConfusable.items[0].id = "meeting-safe-other:rec-00001";
  assert.equal(errorCode(() => corpus.normalizeFinalizedCorpus({
    documents: [prefixConfusable],
  })), "CORPUS_ITEM_OWNERSHIP_INVALID");

  const eventBacked = trajectoryEntry("trajectory-safe", "evt:safe");
  assert.equal(
    corpus.normalizeFinalizedCorpus({ documents: [eventBacked] }).documents[0].items[0].id,
    "evt:safe",
  );
});

test("qualified records bind supplied trajectory identity to the owning document", () => {
  for (const scenario of [
    { documentId: "meeting-absent", accepted: true },
    { documentId: "meeting-matching", trajectoryId: "meeting-matching", accepted: true },
    { documentId: "meeting-owned", trajectoryId: "meeting-foreign", accepted: false },
    { documentId: "meeting-typed", trajectoryId: 7, accepted: false },
  ]) {
    const entry = meetingEntry(scenario.documentId);
    if ("trajectoryId" in scenario) entry.items[0].original.trajectory_id = scenario.trajectoryId;
    assert.equal(organizationIdentityMatches(entry.items[0].original, {
      id: entry.items[0].id,
      document_id: entry.document.id,
    }), scenario.accepted);
    if (scenario.accepted) {
      assert.equal(
        corpus.normalizeFinalizedCorpus({ documents: [entry] }).documents[0].items[0].id,
        entry.items[0].id,
      );
    } else {
      assert.equal(errorCode(() => corpus.normalizeFinalizedCorpus({ documents: [entry] })),
        "CORPUS_ITEM_OWNERSHIP_INVALID");
    }
  }
});

test("duplicate, ambiguous, foreign, malformed, and non-JSON corpora fail before mutation", () => {
  const first = trajectoryEntry("trajectory-a", "evt-a");
  assert.equal(errorCode(() => corpus.normalizeFinalizedCorpus({
    documents: [first, structuredClone(first)],
  })), "CORPUS_DOCUMENT_ID_DUPLICATE");

  const inside = structuredClone(first);
  inside.items.push({ ...structuredClone(inside.items[0]), sequence: 2 });
  inside.document.itemCount = 2;
  assert.equal(errorCode(() => corpus.normalizeFinalizedCorpus({ documents: [inside] })),
    "CORPUS_ITEM_ID_DUPLICATE");

  const across = meetingEntry("meeting-a");
  across.items[0].id = "evt-a";
  assert.equal(errorCode(() => corpus.normalizeFinalizedCorpus({ documents: [first, across] })),
    "CORPUS_ITEM_ID_DUPLICATE");

  const foreign = structuredClone(first);
  foreign.items[0].original.trajectory_id = "trajectory-foreign";
  assert.equal(errorCode(() => corpus.normalizeFinalizedCorpus({ documents: [foreign] })),
    "CORPUS_ITEM_OWNERSHIP_INVALID");

  const countMismatch = structuredClone(first);
  countMismatch.document.itemCount = 0;
  assert.equal(errorCode(() => corpus.normalizeFinalizedCorpus({ documents: [countMismatch] })),
    "CORPUS_DOCUMENT_ITEM_COUNT_MISMATCH");

  const ambiguous = structuredClone(first);
  const secondItem = structuredClone(ambiguous.items[0]);
  secondItem.id = "evt-b";
  secondItem.original.event_id = "evt-b";
  ambiguous.items.push(secondItem);
  ambiguous.document.itemCount = 2;
  assert.equal(errorCode(() => corpus.normalizeFinalizedCorpus({ documents: [ambiguous] })),
    "CORPUS_ITEM_SEQUENCE_AMBIGUOUS");

  assert.equal(errorCode(() => corpus.normalizeFinalizedCorpus({
    document: first.document,
    items: first.items,
  })), "CORPUS_PAYLOAD_INVALID");
  assert.equal(errorCode(() => corpus.normalizeFinalizedCorpus({ documents: [] })),
    "CORPUS_DOCUMENTS_REQUIRED");

  const invalidContent = structuredClone(first);
  invalidContent.items[0].content = { text: "not a string" };
  assert.equal(errorCode(() => corpus.normalizeFinalizedCorpus({ documents: [invalidContent] })),
    "CORPUS_ITEM_CONTENT_INVALID");
  const invalidOriginal = structuredClone(first);
  invalidOriginal.items[0].original.payload.invalid = undefined;
  assert.equal(errorCode(() => corpus.normalizeFinalizedCorpus({ documents: [invalidOriginal] })),
    "CORPUS_JSON_INVALID");
});

test("corpus digest ignores input array and object-key order but binds every persisted source field", async () => {
  const input = {
    documents: [
      trajectoryEntry("trajectory-z", "evt-z"),
      meetingEntry("meeting-a"),
    ],
  };
  const reordered = structuredClone(input);
  reordered.documents.reverse();
  reordered.documents[1].items.reverse();
  reordered.documents[1].document.metadata = { nested: { a: 1, z: 2 } };
  const baseline = await corpus.finalizedCorpusDigest(corpus.normalizeFinalizedCorpus(input));
  assert.equal(
    await corpus.finalizedCorpusDigest(corpus.normalizeFinalizedCorpus(reordered)),
    baseline,
  );

  const mutations = [
    (value) => { value.documents[0].document.kind = "meeting"; },
    (value) => { value.documents[0].document.title += " changed"; },
    (value) => { value.documents[0].document.sourceUser = "other"; },
    (value) => { value.documents[0].document.sourceSystem = "other"; },
    (value) => { value.documents[0].document.sourceTimestamp = "2037-01-01"; },
    (value) => { value.documents[0].document.metadata.extra = true; },
    (value) => { value.documents[0].document.envelope.extra = true; },
    (value) => { value.documents[0].items[0].sequence = 2; },
    (value) => { value.documents[0].items[0].eventType = "artifact"; },
    (value) => { value.documents[0].items[0].actorId = "other"; },
    (value) => { value.documents[0].items[0].actorType = "agent"; },
    (value) => { value.documents[0].items[0].timestamp = "2037-01-01"; },
    (value) => { value.documents[0].items[0].content += " changed"; },
    (value) => { value.documents[0].items[0].original.extra = true; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(input);
    mutate(changed);
    assert.notEqual(
      await corpus.finalizedCorpusDigest(corpus.normalizeFinalizedCorpus(changed)),
      baseline,
    );
  }
});

class AtomicPublicationDb {
  constructor() {
    this.state = {
      documents: ["stale-document"],
      items: [{ id: "foreign-item", documentId: "foreign-document" }],
      manifest: { revision: 4, digest: "old", documentCount: 1, itemCount: 1 },
      sourceRevision: 10,
    };
    this.batchCalls = 0;
  }

  statement(action) {
    return { run: async () => action(this.state) };
  }

  prepare(sql) {
    assert.match(sql, /UPDATE workflow_runs/);
    return {
      bind: () => ({
        run: async () => {
          this.state.sourceRevision += 1;
          return { meta: { changes: 1 } };
        },
      }),
    };
  }

  async batch(statements) {
    this.batchCalls += 1;
    const before = structuredClone(this.state);
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    } catch (error) {
      this.state = before;
      throw error;
    }
  }
}

test("complete replacement removes stale and foreign rows and publishes exact manifest counts once", async () => {
  const db = new AtomicPublicationDb();
  const replacement = [
    db.statement((state) => { state.items = []; return { meta: { changes: 1 } }; }),
    db.statement((state) => { state.documents = []; return { meta: { changes: 1 } }; }),
    db.statement((state) => {
      state.documents = ["document-a", "document-b"];
      return { meta: { changes: 2 } };
    }),
    db.statement((state) => {
      state.items = [
        { id: "item-a", documentId: "document-a" },
        { id: "item-b", documentId: "document-b" },
      ];
      return { meta: { changes: 2 } };
    }),
    db.statement((state) => {
      state.manifest = {
        revision: 5,
        digest: "a".repeat(64),
        documentCount: state.documents.length,
        itemCount: state.items.length,
      };
      return { meta: { changes: 1 } };
    }),
  ];
  assert.equal(await publishFinalizedCorpusSourceMutation(
    db, replacement, "run", 10, 5, "a".repeat(64), 2, 2, "2036-01-01",
  ), true);
  assert.equal(db.batchCalls, 1);
  assert.deepEqual(db.state.documents, ["document-a", "document-b"]);
  assert.deepEqual(db.state.items, [
    { id: "item-a", documentId: "document-a" },
    { id: "item-b", documentId: "document-b" },
  ]);
  assert.deepEqual(db.state.manifest, {
    revision: 5,
    digest: "a".repeat(64),
    documentCount: 2,
    itemCount: 2,
  });
  assert.equal(db.state.sourceRevision, 11);
});

test("failure during the replacement batch preserves the previous finalized corpus", async () => {
  const db = new AtomicPublicationDb();
  const previous = structuredClone(db.state);
  await assert.rejects(publishFinalizedCorpusSourceMutation(
    db,
    [
      db.statement((state) => { state.items = []; return { meta: { changes: 1 } }; }),
      db.statement(() => { throw new Error("synthetic insert failure"); }),
    ],
    "run", 10, 5, "a".repeat(64), 2, 2, "2036-01-01",
  ), /synthetic insert failure/);
  assert.equal(db.batchCalls, 1);
  assert.deepEqual(db.state, previous);
});

class CasZeroPublicationDb {
  constructor() {
    this.state = {
      documents: ["existing-document"],
      items: [{ id: "existing-item", documentId: "existing-document" }],
      manifest: { revision: 7, digest: "b".repeat(64), documentCount: 1, itemCount: 1 },
      sourceRevision: 12,
      status: "ready_for_human_review",
      organizationJob: { status: "complete" },
      redactionJob: { status: "complete", stage: "complete" },
    };
    this.guardedMutationChanges = [];
    this.leasePredicateResults = [];
    this.finalCasChanges = null;
  }

  sharedLeasePredicate(expectedRevision) {
    const matches = this.state.sourceRevision === expectedRevision
      && ["source_writing", "source_writing_generation"].includes(this.state.status);
    this.leasePredicateResults.push(matches);
    return matches;
  }

  guardedStatement(expectedRevision, action) {
    return {
      run: async () => {
        const changes = this.sharedLeasePredicate(expectedRevision) ? action(this.state) : 0;
        this.guardedMutationChanges.push(changes);
        return { meta: { changes } };
      },
    };
  }

  prepare(sql) {
    assert.match(sql, /UPDATE workflow_runs/);
    return {
      bind: (...values) => ({
        run: async () => {
          const expectedRevision = Number(values[3]);
          const changes = this.sharedLeasePredicate(expectedRevision) ? 1 : 0;
          if (changes) this.state.sourceRevision += 1;
          this.finalCasChanges = changes;
          return { meta: { changes } };
        },
      }),
    };
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

test("CAS zero leaves every guarded corpus mutation and prior manifest unchanged", async () => {
  const db = new CasZeroPublicationDb();
  const previous = structuredClone(db.state);
  const expectedRevision = 11;
  assert.equal(db.sharedLeasePredicate(expectedRevision), false);
  const replacement = [
    db.guardedStatement(expectedRevision, (state) => { state.items = []; return 1; }),
    db.guardedStatement(expectedRevision, (state) => { state.documents = []; return 1; }),
    db.guardedStatement(expectedRevision, (state) => {
      state.documents = ["replacement-document"];
      return 1;
    }),
    db.guardedStatement(expectedRevision, (state) => {
      state.items = [{ id: "replacement-item", documentId: "replacement-document" }];
      return 1;
    }),
    db.guardedStatement(expectedRevision, (state) => { state.organizationJob = null; return 1; }),
    db.guardedStatement(expectedRevision, (state) => {
      state.redactionJob = { status: "stale", stage: "source_changed" };
      return 1;
    }),
    db.guardedStatement(expectedRevision, (state) => { state.manifest = null; return 1; }),
    db.guardedStatement(expectedRevision, (state) => {
      state.manifest = {
        revision: 8,
        digest: "c".repeat(64),
        documentCount: 1,
        itemCount: 0,
      };
      return 1;
    }),
  ];
  assert.equal(await publishFinalizedCorpusSourceMutation(
    db, replacement, "run", expectedRevision, 8, "c".repeat(64), 1, 0, "2036-01-01",
  ), false);
  assert.deepEqual(db.guardedMutationChanges, [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(db.leasePredicateResults.length, 10);
  assert.ok(db.leasePredicateResults.every((matches) => matches === false));
  assert.equal(db.finalCasChanges, 0);
  assert.deepEqual(db.state, previous);
});

test("documents route has one whole-corpus atomic single-payload POST contract", () => {
  assert.equal((routeSource.match(/export async function POST/g) || []).length, 1);
  assert.match(routeSource, /normalizeFinalizedCorpus\(await request\.json\(\)\)/);
  assert.match(routeSource, /body\.documents/);
  assert.doesNotMatch(routeSource, /body\.document\b|sourceImportMatchesExisting|ON CONFLICT/);
  assert.match(routeSource, /DELETE FROM items WHERE \$\{leaseSql\}/);
  assert.match(routeSource, /DELETE FROM documents WHERE \$\{leaseSql\}/);
  assert.match(routeSource, /FROM json_each\(\?\) WHERE \$\{leaseSql\}/);
  assert.match(routeSource, /const documentPayload = JSON\.stringify\(corpus\.documents\.map/);
  assert.match(routeSource, /const itemPayload = JSON\.stringify\(corpus\.documents\.flatMap/);
  assert.match(routeSource, /publishFinalizedCorpusSourceMutation/);
  assert.doesNotMatch(
    routeSource,
    /status:\s*413|requestBytes|content-length/,
  );
  assert.doesNotMatch(routeSource, /await db\.batch\(body\.items|start \+= 75|for \(const payload/);
  assert.doesNotMatch(
    routeSource,
    /organizationCategory|organizationConfidence|organizationReason|organization_category|organization_confidence|organization_reason/,
  );
  assert.match(dbSource, /CREATE TABLE IF NOT EXISTS finalized_corpus_manifests/);
});

test("Organization refuses absent or mismatched corpus authority and binds its semantic output", async () => {
  const database = (row) => ({
    prepare: () => ({
      bind: () => ({ first: async () => row }),
    }),
  });
  assert.equal(await organization.readFinalizedCorpusAuthority(database(null), "run"), null);
  assert.equal(await organization.readFinalizedCorpusAuthority(database({
    story_generation_status: "not_started",
    corpus_revision: null,
    corpus_digest: null,
    document_count: 0,
    item_count: 0,
    current_document_count: 0,
    current_item_count: 0,
  }), "run"), null);
  const current = await organization.readFinalizedCorpusAuthority(database({
    story_generation_status: "not_started",
    corpus_revision: 3,
    corpus_digest: "a".repeat(64),
    document_count: 2,
    item_count: 7,
    current_document_count: 2,
    current_item_count: 6,
  }), "run");
  assert.equal(organization.finalizedCorpusCountsMatch(current), false);
  current.currentItemCount = 7;
  assert.equal(organization.finalizedCorpusCountsMatch(current), true);

  const required = organizationSource.indexOf("FINALIZED_CORPUS_REQUIRED");
  const mismatch = organizationSource.indexOf("FINALIZED_CORPUS_COUNT_MISMATCH");
  const lease = organizationSource.indexOf("beginStorySourceMutation(db");
  assert.ok(required >= 0 && required < lease);
  assert.ok(mismatch >= 0 && mismatch < lease);
  assert.match(organizationSource, /FINALIZED_CORPUS_NOT_CURRENT/);
  assert.match(organizationSource, /corpus_revision,corpus_digest,corpus_document_count,corpus_item_count/);
  assert.match(organizationSource, /leasedCorpus\.corpusDigest/);
  assert.match(organizationSource, /finalizedCorpus:\s*\{/);
  assert.match(
    organizationSource,
    /UPDATE items SET\s*organization_category=\?,organization_confidence=100,\s*organization_reason=/,
  );
  assert.match(
    dbSource,
    /organization_category TEXT, organization_confidence INTEGER,\s*organization_reason TEXT/,
  );
});

test("24796-item corpus preserves exact counts and digest in one item payload", async (context) => {
  const documentId = "synthetic-bom";
  const padding = "x".repeat(128);
  const rawItems = [];
  for (let index = 0; index < 24_796; index += 1) {
    const id = `evt-${String(index).padStart(5, "0")}-${"a".repeat(56)}`;
    const original = {
      event_id: id,
      trajectory_id: documentId,
      payload: { text: padding },
    };
    rawItems.push({
      id,
      sequence: index + 1,
      eventType: "record",
      actorId: "person",
      actorType: "human",
      timestamp: "2036-01-01T00:00:00.000Z",
      content: "c".repeat(100),
      original,
    });
  }
  const request = { documents: [{
    document: {
      id: documentId,
      kind: "trajectory",
      title: "Synthetic BOM",
      itemCount: rawItems.length,
    },
    items: rawItems,
  }] };
  const normalized = corpus.normalizeFinalizedCorpus(request);
  const itemPayload = JSON.stringify(normalized.documents.flatMap((document) => document.items));
  const digest = await corpus.finalizedCorpusDigest(normalized);
  assert.equal(normalized.documents.length, 1);
  assert.equal(normalized.documents[0].itemCount, 24_796);
  assert.equal(normalized.itemCount, 24_796);
  assert.equal(JSON.parse(itemPayload).length, 24_796);
  assert.equal(await corpus.finalizedCorpusDigest(corpus.normalizeFinalizedCorpus(
    structuredClone(request),
  )), digest);
  assert.equal(digest, "41918f114f67d12ad6fc4adf1020965ad52b9a1f95d88d0efab33774c1f605dc");
  context.diagnostic(JSON.stringify({
    documentCount: normalized.documents.length,
    itemCount: normalized.itemCount,
    payloadCount: 1,
    itemPayloadBytes: Buffer.byteLength(itemPayload),
    digest,
  }));
});
