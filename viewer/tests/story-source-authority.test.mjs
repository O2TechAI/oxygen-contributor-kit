import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { testStoryCoverage } from "./fixtures/story-coverage.mjs";
import {
  isReservedStoryOrganizationReason,
  readReservedStoryCandidateRows,
  selectReservedStorySourceItems,
  selectViewerChapters,
  validateStorySourcePackage,
} from "../lib/story-readiness.ts";
import { releaseOrganizationReason } from "../lib/story-release.ts";
import { readActiveStoryReviewContract } from "../lib/story-review-session-server.ts";
import {
  STORY_SOURCE_WRITE_STATUS,
  abortStorySourceMutation,
  beginStoryActivationMutation,
  beginStorySourceMutation,
  publishActivatedStorySourceMutation,
  publishCompletedStorySourceMutation,
} from "../lib/story-source-publication.ts";
import { STORY_PREFIX } from "../lib/timeline.ts";
import { STORY_PREPARATION_EMPTY_ARRAY_DIGEST } from "../lib/story-preparation.ts";

const RUN_ID = "source-authority-run";
const ORIGINAL_SENTINEL = "PRIVATE_ORIGINAL_SENTINEL";
const EVIDENCE_SENTINEL = "PRIVATE_EVIDENCE_SENTINEL";

test("Organization and Story activation use one JSON payload per logical row group", (context) => {
  const organizationRoute = readFileSync(
    new URL("../app/api/organization/route.ts", import.meta.url),
    "utf8",
  );
  const workflowRoute = readFileSync(new URL("../app/api/workflow/route.ts", import.meta.url), "utf8");
  assert.match(organizationRoute, /const unitPayload = JSON\.stringify\(persistedUnits\)/);
  assert.match(organizationRoute, /const memberPayload = JSON\.stringify\(members\)/);
  assert.match(workflowRoute, /const candidatePayload = JSON\.stringify\(candidateRows\)/);
  assert.match(
    workflowRoute,
    /const documentSummaryPayload = JSON\.stringify\(documentSummaries\)/,
  );
  assert.match(workflowRoute, /const coveragePayload = JSON\.stringify\(coverageManifest\.rows\)/);
  assert.doesNotMatch(`${organizationRoute}\n${workflowRoute}`, /for \(const payload/);

  const rows = Array.from({ length: 24_796 }, (_, index) => ({
    itemId: `item-${index}-${"x".repeat(280)}`,
    unitId: `unit-${index % 512}-${"y".repeat(280)}`,
    sourceDigest: "a".repeat(64),
  }));
  const payload = JSON.stringify(rows);
  assert.equal(JSON.parse(payload).length, 24_796);
  context.diagnostic(JSON.stringify({ rowCount: rows.length, payloadBytes: Buffer.byteLength(payload) }));
});

function sourceFor(identity) {
  const evidence = { documentId: identity.document_id, eventId: identity.id };
  return {
    schema: "oxygen.story",
    key: identity.key,
    phase: { id: "phase-discovery", label: "Discovery" },
    kind: "decision",
    title: `Chapter ${identity.key}`,
    overview: `A bounded source-authority chapter for ${identity.key}.`,
    people: [{
      id: `person-${identity.key}`,
      releaseLabel: "Contributor",
      role: "Owner",
      description: "Owned the verified source boundary.",
      localIdentityState: "not_identified",
      evidence: [evidence],
    }],
    story: {
      blocks: [{ id: `block-${identity.key}`, text: `Verified ${identity.key}.`, evidence: [evidence] }],
    },
    insights: [],
    evidence: { primary: evidence, supporting: [] },
    coverage: testStoryCoverage(),
  };
}

function itemFor(identity) {
  return {
    ...identity,
    event_type: "message",
    actor_id: `actor-${identity.key}`,
    actor_type: "user",
    organization_reason: `${STORY_PREFIX}${JSON.stringify(sourceFor(identity))}`,
  };
}

const candidate = (item) => ({
  id: item.id,
  documentId: item.document_id,
  sequence: item.sequence,
  timestamp: item.timestamp,
  summary: item.organization_reason,
});

const evidence = (item) => ({
  id: item.id,
  documentId: item.document_id,
  eventType: item.event_type,
  actorId: item.actor_id,
  actorType: item.actor_type,
});

class SourceSelectorDb {
  constructor(items, status = "ready_for_human_review", sourceRevision = 4) {
    this.items = items;
    this.status = status;
    this.sourceRevision = sourceRevision;
  }

  prepare(sql) {
    let values = [];
    return {
      bind(...next) { values = next; return this; },
      all: async () => {
        if (/organization_reason AS summary/.test(sql)) {
          const prefix = String(values[0]).slice(0, -1);
          return {
            results: this.items
              .filter((item) => String(item.organization_reason || "").startsWith(prefix))
              .map(candidate),
          };
        }
        if (/event_type AS eventType/.test(sql)) {
          return { results: this.items.map(evidence) };
        }
        throw new Error(`Unexpected selector all SQL: ${sql}`);
      },
      first: async () => {
        if (/story_generation_status,story_source_revision/.test(sql)) {
          return {
            story_generation_status: this.status,
            story_source_revision: this.sourceRevision,
          };
        }
        throw new Error(`Unexpected selector first SQL: ${sql}`);
      },
    };
  }
}

test("reserved Story namespace reaches activation/session classification and strips unknown release metadata", async () => {
  const valid = itemFor({
    key: "valid-chapter",
    id: "doc-valid:item-valid",
    document_id: "doc-valid",
    sequence: 1,
    timestamp: "2036-01-01T00:00:00.000Z",
  });
  const unknown = {
    ...valid,
    id: "doc-unknown:item-unknown",
    document_id: "doc-unknown",
    sequence: 2,
    organization_reason: `oxygen.story.foreign:${JSON.stringify({
      original: ORIGINAL_SENTINEL,
      evidence: EVIDENCE_SENTINEL,
    })}`,
  };
  const db = new SourceSelectorDb([valid, unknown]);
  const selected = await readReservedStoryCandidateRows(db);
  assert.deepEqual(selected.map((row) => row.id), [unknown.id, valid.id]);
  assert.equal(validateStorySourcePackage(selected, [valid, unknown].map(evidence)).ok, false);
  assert.deepEqual(await readActiveStoryReviewContract(db, RUN_ID), {
    ready: true,
    sourceRevision: 4,
    storySourceSchema: null,
    storySessionSchema: null,
  });

  for (const value of [
    valid.organization_reason,
    unknown.organization_reason,
    "oxygen.story-foreign:malformed",
    "oxygen.story malformed",
  ]) assert.equal(isReservedStoryOrganizationReason(value), true);
  assert.equal(isReservedStoryOrganizationReason("ordinary story project metadata"), false);
  assert.equal(releaseOrganizationReason("ordinary story project metadata"), "ordinary story project metadata");
  const releasedUnknown = releaseOrganizationReason(unknown.organization_reason);
  assert.equal(releasedUnknown, "Reviewed project Story");
  assert.doesNotMatch(releasedUnknown, new RegExp(`${ORIGINAL_SENTINEL}|${EVIDENCE_SENTINEL}`));
});

class PublicationDb {
  constructor(status = "running", revision = 11) {
    this.status = status;
    this.revision = revision;
    this.digest = "previous-ready-digest";
    this.semanticRevision = revision;
    this.coverageRevision = 1;
    this.coverageDigest = "c".repeat(64);
    this.batchCalls = 0;
  }

  prepare(sql) {
    let values = [];
    return {
      bind(...next) { values = next; return this; },
      run: async () => {
        if (/UPDATE semantic_manifests SET source_revision/.test(sql)) {
          const expected = Number(values[3]);
          if (this.semanticRevision !== expected
            || this.revision !== Number(values[5])
            || this.status !== values[6]
            || this.coverageRevision !== Number(values[8])
            || this.coverageDigest !== values[9]) return { meta: { changes: 0 } };
          this.semanticRevision = Number(values[0]);
          return { meta: { changes: 1 } };
        }
        if (/story_generation_status='ready_for_human_review'/.test(sql)) {
          const expected = Number(values[5]);
          if (this.status !== values[6] || this.revision !== expected
            || this.semanticRevision !== Number(values[8])
            || this.coverageRevision !== Number(values[10])
            || this.coverageDigest !== values[11]) return { meta: { changes: 0 } };
          this.status = "ready_for_human_review";
          this.revision += 1;
          this.digest = values[2];
          return { meta: { changes: 1 } };
        }
        if (/story_source_revision=story_source_revision\+1/.test(sql)) {
          if (![STORY_SOURCE_WRITE_STATUS.idle, STORY_SOURCE_WRITE_STATUS.resumeGeneration]
            .includes(this.status)) return { meta: { changes: 0 } };
          this.status = this.status === STORY_SOURCE_WRITE_STATUS.resumeGeneration
            ? "running" : "not_started";
          this.revision += 1;
          return { meta: { changes: 1 } };
        }
        if (/story_generation_status='blocked'/.test(sql)) {
          const expectedRevision = values.length > 4 ? Number(values[4]) : null;
          if (expectedRevision !== null && this.revision !== expectedRevision) {
            return { meta: { changes: 0 } };
          }
          if ([STORY_SOURCE_WRITE_STATUS.idle, STORY_SOURCE_WRITE_STATUS.resumeGeneration]
            .includes(this.status)) this.status = "blocked";
          this.digest = null;
          return { meta: { changes: 1 } };
        }
        if (/story_generation_status NOT IN/.test(sql)) {
          if ([STORY_SOURCE_WRITE_STATUS.idle, STORY_SOURCE_WRITE_STATUS.resumeGeneration]
            .includes(this.status)) return { meta: { changes: 0 } };
          this.status = this.status === "running" ? values[0] : values[1];
          this.digest = null;
          return { meta: { changes: 1 } };
        }
        if (/story_generation_status='running'/.test(sql)) {
          if (this.status !== "running") return { meta: { changes: 0 } };
          this.status = values[0];
          this.digest = null;
          return { meta: { changes: 1 } };
        }
        throw new Error(`Unexpected publication SQL: ${sql}`);
      },
    };
  }

  async batch(statements) {
    this.batchCalls += 1;
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

async function activationAttempt(db, items) {
  const rows = await readReservedStoryCandidateRows(new SourceSelectorDb(items));
  const validation = validateStorySourcePackage(rows, items.map(evidence));
  if (db.status !== "running" || !validation.ok) return false;
  db.status = "ready_for_human_review";
  db.digest = validation.canonicalCandidate;
  return true;
}

test("one complete source document publishes one revision and partial rows cannot activate", async () => {
  const db = new PublicationDb();
  const items = [
    itemFor({
      key: "chapter-a", id: "doc:item-a", document_id: "doc", sequence: 1,
      timestamp: "2036-02-01T00:00:00.000Z",
    }),
    itemFor({
      key: "chapter-b", id: "doc:item-b", document_id: "doc", sequence: 2,
      timestamp: "2036-02-02T00:00:00.000Z",
    }),
  ];
  const written = [];
  assert.equal(await beginStorySourceMutation(db, RUN_ID, "2036-02-03T00:00:00.000Z"), true);
  assert.equal(db.status, STORY_SOURCE_WRITE_STATUS.resumeGeneration);
  assert.equal(db.revision, 11);
  assert.equal(db.digest, null);

  written.push(items[0]);
  const partial = validateStorySourcePackage([candidate(items[0])], [evidence(items[0])]);
  assert.equal(partial.ok, true, "the interleaved partial package must itself be deceptively valid");
  assert.equal(await activationAttempt(db, written), false);
  assert.equal(db.revision, 11);

  written.push(items[1]);
  assert.equal(await publishCompletedStorySourceMutation(
    db, RUN_ID, "2036-02-03T00:00:01.000Z",
  ), true);
  assert.equal(db.revision, 12);
  assert.equal(db.status, "running");
  assert.equal(await activationAttempt(db, written), true);
  assert.equal(db.status, "ready_for_human_review");
});

test("failed source writes remain non-ready and publish no source revision", async () => {
  const db = new PublicationDb("not_started", 20);
  assert.equal(await beginStorySourceMutation(db, RUN_ID, "2036-02-04T00:00:00.000Z"), true);
  await abortStorySourceMutation(db, RUN_ID, "2036-02-04T00:00:01.000Z");
  assert.equal(db.status, "blocked");
  assert.equal(db.revision, 20);
  assert.equal(await activationAttempt(db, []), false);
});

test("a stale writer cannot abort a newer revision-bound source lease", async () => {
  const db = new PublicationDb(STORY_SOURCE_WRITE_STATUS.idle, 51);
  await abortStorySourceMutation(db, RUN_ID, "2036-02-04T00:00:01.000Z", 50);
  assert.equal(db.status, STORY_SOURCE_WRITE_STATUS.idle);
  await abortStorySourceMutation(db, RUN_ID, "2036-02-04T00:00:02.000Z", 51);
  assert.equal(db.status, "blocked");
});

test("Story activation lease is running-only and publishes semantic/source authority once", async () => {
  const db = new PublicationDb("running", 30);
  assert.equal(await beginStoryActivationMutation(
    db, RUN_ID, "2036-02-05T00:00:00.000Z",
  ), true);
  assert.equal(db.status, STORY_SOURCE_WRITE_STATUS.resumeGeneration);
  assert.equal(await beginStoryActivationMutation(
    db, RUN_ID, "2036-02-05T00:00:00.100Z",
  ), false, "a second ready attempt cannot claim an active lease");
  assert.equal(await publishActivatedStorySourceMutation(
    db, [], RUN_ID, 30, 2, "d".repeat(64), 1, "c".repeat(64),
    0, STORY_PREPARATION_EMPTY_ARRAY_DIGEST, 0,
    "2036-02-05T00:00:01.000Z",
  ), true);
  assert.equal(db.status, "ready_for_human_review");
  assert.equal(db.revision, 31);
  assert.equal(db.semanticRevision, 31);
  assert.equal(db.digest, "d".repeat(64));
  assert.equal(db.batchCalls, 1, "package and activation publish through one durable batch");
  assert.equal(await beginStoryActivationMutation(
    db, RUN_ID, "2036-02-05T00:00:02.000Z",
  ), false, "a stale ready request cannot reopen or block reviewed source");
  assert.equal(db.status, "ready_for_human_review");
});

test("mismatched coverage cannot partially rebind semantic authority", async () => {
  const db = new PublicationDb("running", 40);
  assert.equal(await beginStoryActivationMutation(
    db, RUN_ID, "2036-02-06T00:00:00.000Z",
  ), true);
  assert.equal(await publishActivatedStorySourceMutation(
    db, [], RUN_ID, 40, 1, "d".repeat(64), 2, "e".repeat(64),
    0, STORY_PREPARATION_EMPTY_ARRAY_DIGEST, 0,
    "2036-02-06T00:00:01.000Z",
  ), false);
  assert.equal(db.semanticRevision, 40);
  assert.equal(db.revision, 40);
  assert.equal(db.status, STORY_SOURCE_WRITE_STATUS.resumeGeneration);
});

test("activation, Viewer, release selection, and digest share one total source order", async (t) => {
  const cases = [
    {
      name: "same timestamp across documents and sequences",
      identities: [
        { key: "chapter-c", id: "doc-c:item", document_id: "doc-c", sequence: 1, timestamp: "2037-01-01T00:00:00Z" },
        { key: "chapter-a", id: "doc-a:item", document_id: "doc-a", sequence: 9, timestamp: "2037-01-01T00:00:00Z" },
        { key: "chapter-b", id: "doc-b:item", document_id: "doc-b", sequence: 0, timestamp: "2037-01-01T00:00:00Z" },
      ],
      expected: ["doc-a:item", "doc-b:item", "doc-c:item"],
    },
    {
      name: "missing and null timestamps",
      identities: [
        { key: "chapter-b", id: "doc-a:item-2", document_id: "doc-a", sequence: 2, timestamp: null },
        { key: "chapter-c", id: "doc-b:item", document_id: "doc-b", sequence: 0 },
        { key: "chapter-a", id: "doc-a:item-1", document_id: "doc-a", sequence: 1 },
      ],
      expected: ["doc-a:item-1", "doc-a:item-2", "doc-b:item"],
    },
    {
      name: "stable ID final tie-breaker",
      identities: [
        { key: "chapter-c", id: "doc:item-c", document_id: "doc", sequence: 1, timestamp: "2037-03-01T00:00:00Z" },
        { key: "chapter-a", id: "doc:item-a", document_id: "doc", sequence: 1, timestamp: "2037-03-01T00:00:00Z" },
        { key: "chapter-b", id: "doc:item-b", document_id: "doc", sequence: 1, timestamp: "2037-03-01T00:00:00Z" },
      ],
      expected: ["doc:item-a", "doc:item-b", "doc:item-c"],
    },
  ];

  for (const current of cases) await t.test(current.name, async () => {
    const items = current.identities.map(itemFor);
    const activationRows = await readReservedStoryCandidateRows(new SourceSelectorDb(items));
    const validation = validateStorySourcePackage(activationRows, items.map(evidence));
    assert.equal(validation.ok, true);
    const viewer = selectViewerChapters(items.map((item) => ({
      id: item.id,
      documentId: item.document_id,
      sequence: item.sequence,
      timestamp: item.timestamp,
      project: "Authority",
      summary: item.organization_reason,
    })), "Authority");
    const releaseRows = selectReservedStorySourceItems(items);
    const digestRows = JSON.parse(validation.canonicalCandidate);
    assert.deepEqual(activationRows.map((row) => row.id), current.expected);
    assert.deepEqual(viewer.chapters.map((chapter) => chapter.id), current.expected);
    assert.deepEqual(releaseRows.map((row) => row.id), current.expected);
    assert.deepEqual(digestRows.map((row) => row.id), current.expected);
  });
});
