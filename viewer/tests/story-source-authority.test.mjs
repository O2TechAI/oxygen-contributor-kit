import test from "node:test";
import assert from "node:assert/strict";
import {
  isReservedStoryOrganizationReason,
  readReservedStoryCandidateRows,
  selectReservedStorySourceItems,
  selectSuccessorViewerChapters,
  validateRecognizedStorySourcePackage,
} from "../lib/story-readiness.ts";
import { releaseOrganizationReason } from "../lib/story-release.ts";
import { readActiveStoryReviewContract } from "../lib/story-review-session-server.ts";
import {
  STORY_SOURCE_WRITE_STATUS,
  abortStorySourceMutation,
  beginStorySourceMutation,
  publishCompletedStorySourceMutation,
} from "../lib/story-source-publication.ts";
import { SUCCESSOR_STORY_PREFIX } from "../lib/timeline.ts";

const RUN_ID = "source-authority-run";
const ORIGINAL_SENTINEL = "PRIVATE_ORIGINAL_SENTINEL";
const EVIDENCE_SENTINEL = "PRIVATE_EVIDENCE_SENTINEL";

function sourceFor(identity) {
  const evidence = { documentId: identity.document_id, eventId: identity.id };
  return {
    schema: "oxygen.story/3",
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
    contextRetention: { excluded: [] },
  };
}

function itemFor(identity) {
  return {
    ...identity,
    event_type: "message",
    actor_id: `actor-${identity.key}`,
    actor_type: "user",
    organization_reason: `${SUCCESSOR_STORY_PREFIX}${JSON.stringify(sourceFor(identity))}`,
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
    organization_reason: `oxygen.story/99:${JSON.stringify({
      original: ORIGINAL_SENTINEL,
      evidence: EVIDENCE_SENTINEL,
    })}`,
  };
  const db = new SourceSelectorDb([valid, unknown]);
  const selected = await readReservedStoryCandidateRows(db);
  assert.deepEqual(selected.map((row) => row.id), [unknown.id, valid.id]);
  assert.equal(validateRecognizedStorySourcePackage(selected, [valid, unknown].map(evidence)).ok, false);
  assert.deepEqual(await readActiveStoryReviewContract(db, RUN_ID), {
    ready: true,
    sourceRevision: 4,
    storySourceSchema: null,
    storySessionSchema: null,
  });

  for (const value of [
    valid.organization_reason,
    unknown.organization_reason,
    "oxygen.story-foo/4:malformed",
    "oxygen.story malformed",
  ]) assert.equal(isReservedStoryOrganizationReason(value), true);
  assert.equal(isReservedStoryOrganizationReason("ordinary story project metadata"), false);
  assert.equal(releaseOrganizationReason("ordinary story project metadata"), "ordinary story project metadata");
  const releasedUnknown = releaseOrganizationReason(unknown.organization_reason);
  assert.equal(releasedUnknown, "Reviewed project milestone");
  assert.doesNotMatch(releasedUnknown, new RegExp(`${ORIGINAL_SENTINEL}|${EVIDENCE_SENTINEL}`));
});

class PublicationDb {
  constructor(status = "running", revision = 11) {
    this.status = status;
    this.revision = revision;
    this.digest = "previous-ready-digest";
  }

  prepare(sql) {
    let values = [];
    return {
      bind(...next) { values = next; return this; },
      run: async () => {
        if (/story_source_revision=story_source_revision\+1/.test(sql)) {
          if (![STORY_SOURCE_WRITE_STATUS.idle, STORY_SOURCE_WRITE_STATUS.resumeGeneration]
            .includes(this.status)) return { meta: { changes: 0 } };
          this.status = this.status === STORY_SOURCE_WRITE_STATUS.resumeGeneration
            ? "running" : "not_started";
          this.revision += 1;
          return { meta: { changes: 1 } };
        }
        if (/story_generation_status='blocked'/.test(sql)) {
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
        throw new Error(`Unexpected publication SQL: ${sql}`);
      },
    };
  }
}

async function activationAttempt(db, items) {
  const rows = await readReservedStoryCandidateRows(new SourceSelectorDb(items));
  const validation = validateRecognizedStorySourcePackage(rows, items.map(evidence));
  if (db.status !== "running" || !validation.ok) return false;
  db.status = "ready_for_human_review";
  db.digest = validation.canonicalCandidate;
  return true;
}

test("source revision publishes once after all chunks and partial valid rows cannot activate", async () => {
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
  const partial = validateRecognizedStorySourcePackage([candidate(items[0])], [evidence(items[0])]);
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

test("failed chunk writes remain non-ready and publish no source revision", async () => {
  const db = new PublicationDb("not_started", 20);
  assert.equal(await beginStorySourceMutation(db, RUN_ID, "2036-02-04T00:00:00.000Z"), true);
  await abortStorySourceMutation(db, RUN_ID, "2036-02-04T00:00:01.000Z");
  assert.equal(db.status, "blocked");
  assert.equal(db.revision, 20);
  assert.equal(await activationAttempt(db, []), false);
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
    const validation = validateRecognizedStorySourcePackage(activationRows, items.map(evidence));
    assert.equal(validation.ok, true);
    const viewer = selectSuccessorViewerChapters(items.map((item) => ({
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
