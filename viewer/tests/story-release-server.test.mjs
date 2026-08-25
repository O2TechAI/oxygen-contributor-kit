import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { syntheticStoryEvents } from "./fixtures/synthetic-story-project.mjs";
import {
  applyChapterReview,
  emptyChapterReview,
  markChapterReady,
} from "../lib/story-review.ts";
import { createStoryReviewSession } from "../lib/story-review-session.ts";
import { computeSourceDigest } from "../lib/redaction-pass.mjs";
import { reviewedStoryPackageEntry } from "../lib/story-release.ts";
import {
  selectReviewableStoryTimeline,
  validateStoryCandidatePackage,
} from "../lib/story-readiness.ts";
import { storyReleaseTargetCatalog } from "../lib/timeline.ts";

const releaseServerModule = await import("../lib/story-release-server.ts")
  .catch((importError) => ({ importError }));

function serverContract() {
  assert.equal(
    releaseServerModule.importError,
    undefined,
    "server-owned Story release reconstruction helper must exist",
  );
  return releaseServerModule;
}

const WORKFLOW_RUN_ID = "review-run";
const SOURCE_REVISION = 7;
const SERVER_VERSION = 4;

const sourceBlocks = (milestone) => Object.fromEntries(["en", "zh"].map((language) => {
  const presentation = milestone.story.reviewPresentation[language];
  return [language, {
    scene: presentation.story.scene,
    ...Object.fromEntries(presentation.story.reconstruction
      .map((copy, index) => [`reconstruction-${index}`, copy])),
    ...Object.fromEntries(presentation.story.importantDetails
      .map((copy, index) => [`detail-${index}`, copy])),
    outcome: presentation.story.decisionOutcome,
    ...(presentation.story.uncertainty ? { uncertainty: presentation.story.uncertainty } : {}),
  }];
}));

function confirmedReview(milestone) {
  const presentation = milestone.story.reviewPresentation.en;
  const privacyDecisions = Object.fromEntries(
    presentation.privacy.candidates.map((candidate) => [candidate.id, "keep"]),
  );
  const sources = sourceBlocks(milestone);
  const context = {
    storyKey: milestone.story.key,
    privacyCandidates: presentation.privacy.candidates,
    privacyDecisions,
    targetCatalog: storyReleaseTargetCatalog(presentation),
    reviewableInsightIds: presentation.highlights.map((highlight) => highlight.id),
    chapterEvidence: [milestone.story.evidence.primary, ...milestone.story.evidence.supporting],
    evidenceResolved: true,
    supportedAddIds: [],
    sourceBlocks: sources,
    reviewedBlocks: sources,
  };
  return markChapterReady(applyChapterReview(emptyChapterReview(), context).state, context);
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

class FakeReleaseDb {
  constructor({ items, run, session, redactionJob }) {
    this.items = items;
    this.runs = new Map([[run.id, run]]);
    this.session = session;
    this.redactionJob = redactionJob;
  }

  prepare(sql) {
    let values = [];
    return {
      bind(...next) { values = next; return this; },
      all: async () => {
        if (/SELECT id FROM workflow_runs ORDER BY id LIMIT 2/.test(sql)) {
          return { results: [...this.runs.keys()].sort().slice(0, 2).map((id) => ({ id })) };
        }
        if (/FROM items/.test(sql)) return { results: structuredClone(this.items) };
        throw new Error(`Unexpected release all SQL: ${sql}`);
      },
      first: async () => {
        if (/FROM workflow_runs WHERE id=\?/.test(sql)) {
          const run = this.runs.get(values[0]);
          return run ? {
            id: run.id,
            story_generation_status: run.status,
            story_source_revision: run.sourceRevision,
            active_story_digest: run.activeStoryDigest,
          } : null;
        }
        if (/FROM story_review_sessions WHERE workflow_run_id=\?/.test(sql)) {
          return this.session ? structuredClone(this.session) : null;
        }
        if (/FROM redaction_jobs/.test(sql)) {
          return this.redactionJob ? structuredClone(this.redactionJob) : null;
        }
        throw new Error(`Unexpected release first SQL: ${sql}`);
      },
    };
  }
}

async function validFixture() {
  const items = syntheticStoryEvents.map((event) => ({
    id: `${event.document_id}:${event.id}`,
    document_id: event.document_id,
    sequence: event.sequence,
    event_type: event.event_type,
    actor_id: event.actor_id,
    actor_type: event.actor_type,
    timestamp: event.timestamp,
    content: event.content,
    organization_reason: event.summary,
  }));
  const candidateRows = items.map((item) => ({
    id: item.id,
    documentId: item.document_id,
    summary: item.organization_reason,
  }));
  const evidenceRows = items.map((item) => ({
    id: item.id,
    documentId: item.document_id,
    eventType: item.event_type,
    actorId: item.actor_id,
    actorType: item.actor_type,
  }));
  const validation = validateStoryCandidatePackage(candidateRows, evidenceRows);
  assert.equal(validation.ok, true);
  const milestones = selectReviewableStoryTimeline(candidateRows.map((row, index) => ({
    ...row,
    sequence: items[index].sequence,
    timestamp: items[index].timestamp,
  })));
  const reviews = Object.fromEntries(milestones.map((milestone) => [
    milestone.story.key,
    confirmedReview(milestone),
  ]));
  assert.ok(Object.values(reviews).every((review) => review.stage === "human_confirmed"));
  const session = createStoryReviewSession(WORKFLOW_RUN_ID, reviews, {});
  const sourceDigest = await computeSourceDigest(items);
  const db = new FakeReleaseDb({
    items,
    run: {
      id: WORKFLOW_RUN_ID,
      status: "ready_for_human_review",
      sourceRevision: SOURCE_REVISION,
      activeStoryDigest: await sha256(validation.canonicalCandidate),
    },
    session: {
      state_json: JSON.stringify({ sourceRevision: SOURCE_REVISION, session }),
      updated_at: "2035-01-01T00:00:04.000Z",
      server_version: SERVER_VERSION,
    },
    redactionJob: {
      status: "complete",
      completed: items.length,
      total: items.length,
      rejected: 0,
      source_digest: sourceDigest,
    },
  });
  return { db, items, milestones, reviews };
}

const request = (overrides = {}) => ({
  workflowRunId: WORKFLOW_RUN_ID,
  serverVersion: SERVER_VERSION,
  sourceRevision: SOURCE_REVISION,
  ...overrides,
});

async function reconstruct(db, value = request()) {
  const { reconstructReviewedStoryReleaseFromDatabase } = serverContract();
  assert.equal(typeof reconstructReviewedStoryReleaseFromDatabase, "function");
  return reconstructReviewedStoryReleaseFromDatabase(db, value);
}

function mutateStoredSession(db, mutation) {
  const stored = JSON.parse(db.session.state_json);
  mutation(stored.session, stored);
  db.session.state_json = JSON.stringify(stored);
}

test("exact run/version/source reconstructs one deterministic canonical release", async () => {
  const { db, milestones } = await validFixture();
  const first = await reconstruct(db);
  const second = await reconstruct(db);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(second, first);
  assert.equal(first.story.publication_approved, false);
  assert.equal(first.story.chapters.length, milestones.length);
  assert.deepEqual(first.story.chapters.map((chapter) => chapter.key), milestones.map((item) => item.story.key));
  assert.equal(first.serializedStory, JSON.stringify(first.story, null, 2));
});

test("wrong, nonexistent, and unsupported multiple workflow runs fail closed", async () => {
  const { RELEASE_ERROR } = serverContract();
  const wrong = await validFixture();
  assert.equal((await reconstruct(wrong.db, request({ workflowRunId: "wrong-run" }))).code, RELEASE_ERROR.runConflict);

  const missing = await validFixture();
  missing.db.runs.clear();
  assert.equal((await reconstruct(missing.db)).code, RELEASE_ERROR.runConflict);

  const multiple = await validFixture();
  multiple.db.runs.set("second-run", { id: "second-run" });
  assert.equal((await reconstruct(multiple.db)).code, RELEASE_ERROR.runConflict);
});

test("stale, future, missing, and invalid server versions reject", async () => {
  const { RELEASE_ERROR } = serverContract();
  const { db } = await validFixture();
  for (const serverVersion of [SERVER_VERSION - 1, SERVER_VERSION + 1]) {
    const result = await reconstruct(db, request({ serverVersion }));
    assert.equal(result.code, RELEASE_ERROR.versionConflict);
    assert.equal(result.serverVersion, SERVER_VERSION);
  }
  for (const value of [
    { workflowRunId: WORKFLOW_RUN_ID, sourceRevision: SOURCE_REVISION },
    request({ serverVersion: -1 }),
    request({ serverVersion: 1.5 }),
  ]) {
    assert.equal((await reconstruct(db, value)).code, RELEASE_ERROR.requestInvalid);
  }
});

test("stale source, source mismatch, not-ready state, and active-package digest drift reject", async () => {
  const { RELEASE_ERROR } = serverContract();
  const stale = await validFixture();
  assert.equal(
    (await reconstruct(stale.db, request({ sourceRevision: SOURCE_REVISION - 1 }))).code,
    RELEASE_ERROR.sourceConflict,
  );

  const oldSession = await validFixture();
  mutateStoredSession(oldSession.db, (_session, stored) => { stored.sourceRevision = SOURCE_REVISION - 1; });
  assert.equal((await reconstruct(oldSession.db)).code, RELEASE_ERROR.sourceConflict);

  const notReady = await validFixture();
  notReady.db.runs.get(WORKFLOW_RUN_ID).status = "running";
  assert.equal((await reconstruct(notReady.db)).code, RELEASE_ERROR.storyNotReady);

  const drift = await validFixture();
  drift.db.runs.get(WORKFLOW_RUN_ID).activeStoryDigest = "0".repeat(64);
  assert.equal((await reconstruct(drift.db)).code, RELEASE_ERROR.stateInvalid);
});

test("current Privacy/source state is required without exposing its contents", async () => {
  const { RELEASE_ERROR } = serverContract();
  for (const mutation of [
    (fixture) => { fixture.db.redactionJob = null; },
    (fixture) => { fixture.db.redactionJob.status = "running"; },
    (fixture) => { fixture.db.redactionJob.source_digest = "f".repeat(64); },
  ]) {
    const fixture = await validFixture();
    mutation(fixture);
    const result = await reconstruct(fixture.db);
    assert.equal(result.code, RELEASE_ERROR.storyNotReady);
    assert.doesNotMatch(JSON.stringify(result), /synthetic|Harbor|source_digest|content/i);
  }
});

test("missing and malformed persisted review sessions reject distinctly", async () => {
  const { RELEASE_ERROR } = serverContract();
  const missing = await validFixture();
  missing.db.session = null;
  assert.equal((await reconstruct(missing.db)).code, RELEASE_ERROR.sessionMissing);

  const malformed = await validFixture();
  malformed.db.session.state_json = "{";
  assert.equal((await reconstruct(malformed.db)).code, RELEASE_ERROR.stateInvalid);
});

test("persisted and hydrated Chapter keys must exactly equal the active package", async () => {
  const { RELEASE_ERROR } = serverContract();
  const partial = await validFixture();
  mutateStoredSession(partial.db, (session) => { delete session.chapterReviews[Object.keys(session.chapterReviews)[0]]; });
  assert.equal((await reconstruct(partial.db)).code, RELEASE_ERROR.reviewIncomplete);

  const extra = await validFixture();
  mutateStoredSession(extra.db, (session) => {
    session.chapterReviews["unknown-chapter"] = structuredClone(Object.values(session.chapterReviews)[0]);
  });
  assert.equal((await reconstruct(extra.db)).code, RELEASE_ERROR.reviewIncomplete);

  const invalidTarget = await validFixture();
  mutateStoredSession(invalidTarget.db, (session) => {
    Object.values(session.chapterReviews)[0].redactedBlocks.push("people:ghost");
  });
  assert.equal((await reconstruct(invalidTarget.db)).code, RELEASE_ERROR.reviewIncomplete);
});

test("unconfirmed, reviewing, pending, Privacy-incomplete, and unresolved Insight state reject", async () => {
  const { RELEASE_ERROR } = serverContract();
  for (const mutation of [
    (session) => { Object.values(session.chapterReviews)[0].stage = "revision_ready"; },
    (session) => { Object.values(session.chapterReviews)[0].stage = "reviewing"; },
    (session) => {
      const review = Object.values(session.chapterReviews)[0];
      review.stage = "reviewing";
      const scene = selectReviewableStoryTimeline(syntheticStoryEvents)[0]
        .story.reviewPresentation.en.story.scene;
      review.annotations.push({
        id: "pending-annotation",
        blockId: "scene",
        type: "delete",
        sourceLanguage: "en",
        selection: { start: 0, end: 3, text: scene.slice(0, 3) },
        resolution: "pending",
        baseRevision: review.revision,
      });
    },
    (session) => {
      const review = Object.values(session.chapterReviews).find((value) => Object.keys(value.appliedPrivacyDecisions).length);
      delete review.appliedPrivacyDecisions[Object.keys(review.appliedPrivacyDecisions)[0]];
    },
    (session) => {
      const [storyKey, review] = Object.entries(session.chapterReviews)[0];
      const milestone = selectReviewableStoryTimeline(syntheticStoryEvents).find((item) => item.story.key === storyKey);
      const insight = milestone.story.reviewPresentation.en.highlights[0];
      review.stage = "reviewing";
      review.insightReviews[insight.id] = {
        status: "needs_changes",
        text: "Synthetic pending Insight review",
        localized: {},
        pendingLanguages: [],
        resolution: "pending",
      };
    },
  ]) {
    const fixture = await validFixture();
    mutateStoredSession(fixture.db, mutation);
    assert.equal((await reconstruct(fixture.db)).code, RELEASE_ERROR.reviewIncomplete);
  }
});

test("strict request envelope rejects every browser authority field", async () => {
  const { RELEASE_ERROR } = serverContract();
  const { db } = await validFixture();
  for (const [field, value] of Object.entries({
    reviewedStory: {},
    chapters: [],
    projects: [],
    people: [{ releaseLabel: "FORGED_PERSON" }],
    insights: [{ title: "FORGED_INSIGHT" }],
    publication_approved: true,
    revision: 999,
    releaseMetadata: { title: "FORGED_TITLE", body: "FORGED_BODY" },
    unknown: "FORGED_UNKNOWN",
  })) {
    const result = await reconstruct(db, { ...request(), [field]: value });
    assert.equal(result.code, RELEASE_ERROR.requestInvalid, field);
    assert.doesNotMatch(JSON.stringify(result), /FORGED_/);
  }
});

test("release output excludes Evidence, originals, review ledgers, local identities, and CAS metadata", async () => {
  const { db } = await validFixture();
  const result = await reconstruct(db);
  assert.equal(result.ok, true);
  for (const forbidden of [
    "documentId", "eventId", "original", "passageContext", "editTransactions",
    "annotations", "privacyDecisions", "serverVersion", "sourceRevision",
    "localIdentityState", "Synthetic dock code",
  ]) assert.doesNotMatch(result.serializedStory, new RegExp(forbidden, "i"));
  assert.equal(result.story.publication_approved, false);
  assert.ok(result.story.chapters.every((chapter) => chapter.en));
});

test("HTML and ZIP representations consume the same canonical serialized Story", async () => {
  const { db } = await validFixture();
  const result = await reconstruct(db);
  assert.equal(result.ok, true);
  const htmlModule = await import("../app/api/organization/export/route.ts");
  assert.equal(typeof htmlModule.renderReviewedStoryHtml, "function");
  const html = htmlModule.renderReviewedStoryHtml(result.serializedStory);
  const embedded = html.match(/const STORY=([\s\S]*?);const view=/)?.[1];
  assert.ok(embedded);
  const zipEntry = reviewedStoryPackageEntry(result.story);
  assert.equal(zipEntry.name, "story/reviewed-project-story.json");
  assert.equal(zipEntry.data, result.serializedStory);
  assert.deepEqual(JSON.parse(embedded), JSON.parse(zipEntry.data));
});

test("both POST routes share reconstruction while GET and heuristic timeline remain unchanged", async () => {
  const [html, zip, workspace] = await Promise.all([
    readFile(new URL("../app/api/organization/export/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/package/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/workspace.tsx", import.meta.url), "utf8"),
  ]);
  for (const source of [html, zip]) {
    const post = source.slice(source.indexOf("export async function POST"));
    assert.match(post, /reconstructReviewedStoryRelease/);
    assert.doesNotMatch(post, /reviewedStory|sanitizeReviewedStoryRelease/);
  }
  assert.match(html, /export async function GET\(\)[\s\S]*renderReviewedStoryHtml\(JSON\.stringify\(emptyStory\(\)\)\)/);
  assert.doesNotMatch(html, /JSON\.stringify\(emptyStory\(\), null, 2\)/);
  assert.match(zip, /export async function GET\(\)\s*\{\s*return buildPackage\(\);\s*\}/);
  assert.match(zip, /reconstructReviewedStoryReleaseFromDatabase\(db, releaseRequest\)/);
  assert.match(zip, /finalReconstruction\.serializedStory !== reviewedStoryJson/);
  assert.match(zip, /timeline: selectProjectTimeline/);
  const handoff = workspace.slice(workspace.indexOf("const downloadReviewed"), workspace.indexOf("const ready ="));
  assert.match(handoff, /serverVersion/);
  assert.match(handoff, /sourceRevision/);
  assert.doesNotMatch(handoff, /reviewedStory/);
});
