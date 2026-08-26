import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  applySuccessorChapterReview,
  editSuccessorAiInsight,
  emptySuccessorChapterReview,
  markSuccessorChapterReady,
  saveSuccessorHumanInsight,
  successorStoryBlocks,
  updateSuccessorAiInsightDecision,
} from "../lib/story-review.ts";
import {
  createStoryReviewSession,
  createSuccessorStoryReviewSession,
} from "../lib/story-review-session.ts";
import {
  SUCCESSOR_REVIEWED_STORY_SCHEMA,
  buildSuccessorReviewedStoryRelease,
  sanitizeSuccessorReviewedStoryRelease,
  serializeSuccessorReviewedStoryRelease,
  successorReviewedStoryPackageEntry,
} from "../lib/story-release.ts";
import {
  RELEASE_ERROR,
  reconstructReviewedStoryReleaseFromDatabase,
} from "../lib/story-release-server.ts";
import { computeSourceDigest } from "../lib/redaction-pass.mjs";
import { validateSuccessorStorySourcePackage } from "../lib/story-readiness.ts";
import { SUCCESSOR_STORY_PREFIX } from "../lib/timeline.ts";

const RUN_ID = "successor-release-run";
const SOURCE_REVISION = 9;
const SERVER_VERSION = 6;
const PRIVATE = "PRIVATE_STORY_SENTINEL";
const evidence = { documentId: "story-doc", eventId: "story-doc:chapter-item" };

function insight(id, blockId = "story-block-safe", overrides = {}) {
  return {
    id,
    title: `Title ${id}`,
    background: `Background ${id}`,
    quote: { storyBlockIds: [blockId] },
    directlyAcquiredExperience: `Experience ${id}`,
    principle: `Principle ${id}`,
    evidence: [evidence],
    ...overrides,
  };
}

function source(insights = [], overrides = {}) {
  return {
    schema: "oxygen.story/3",
    key: "chapter-release",
    phase: { id: "phase-discovery", label: "Discovery" },
    kind: "decision",
    title: "Reviewed successor Chapter",
    overview: "A complete reviewed Story-First Chapter.",
    people: [{
      id: "person-owner",
      releaseLabel: "Contributor",
      role: "Owner",
      description: "Defined and checked the release boundary.",
      localIdentityState: "not_identified",
      evidence: [evidence],
    }],
    story: {
      blocks: [
        { id: "story-block-private", text: `The ${PRIVATE} was removed.`, evidence: [evidence] },
        { id: "story-block-safe", text: "The approved Story text states the safe boundary.", evidence: [evidence] },
      ],
      uncertainty: "The remaining uncertainty is explicit.",
    },
    insights,
    evidence: { primary: evidence, supporting: [] },
    contextRetention: { excluded: [] },
    ...overrides,
  };
}

function context(currentSource) {
  const blocks = successorStoryBlocks(currentSource);
  return {
    source: currentSource,
    privacyCandidates: [],
    privacyDecisions: {},
    targetCatalog: new Map(),
    evidenceResolved: true,
    supportedAddIds: [],
    supportedEditIds: [],
    sourceBlocks: blocks,
    reviewedBlocks: blocks,
  };
}

function humanContent(currentSource, overrides = {}) {
  return {
    background: "Human-approved background.",
    quote: { chapterKey: currentSource.key, storyBlockIds: ["story-block-safe"] },
    directlyAcquiredExperience: "The contributor directly acquired this experience.",
    principle: "Preserve the checked boundary.",
    evidence: [evidence],
    ...overrides,
  };
}

function reviewedState(currentSource, decisions = {}, humans = []) {
  const currentContext = context(currentSource);
  let state = applySuccessorChapterReview(
    emptySuccessorChapterReview(currentSource),
    currentContext,
  ).state;
  for (const sourceInsight of currentSource.insights) {
    state = updateSuccessorAiInsightDecision(
      state,
      currentSource,
      sourceInsight.id,
      decisions[sourceInsight.id] || "accepted",
    );
  }
  for (const [id, content] of humans) {
    state = saveSuccessorHumanInsight(state, currentContext, id, content).state;
  }
  if (state.stage !== "revision_ready") {
    state = applySuccessorChapterReview(state, currentContext).state;
  }
  return markSuccessorChapterReady(state, currentContext);
}

test("successor release is explicit /2 and zero Insights is a complete release", () => {
  const currentSource = source([]);
  const release = buildSuccessorReviewedStoryRelease(
    [currentSource],
    { [currentSource.key]: reviewedState(currentSource) },
  );
  assert.equal(release.schema_version, SUCCESSOR_REVIEWED_STORY_SCHEMA);
  assert.equal(release.publication_approved, false);
  assert.equal(release.chapters.length, 1);
  assert.deepEqual(release.chapters[0].phase, { id: "phase-discovery", label: "Discovery" });
  assert.deepEqual(release.chapters[0].en.people, [{
    releaseLabel: "Contributor",
    role: "Owner",
    description: "Defined and checked the release boundary.",
  }]);
  assert.deepEqual(release.chapters[0].en.insights, []);
  assert.deepEqual(release.chapters[0].en.story.blocks, currentSource.story.blocks.map((block) => block.text));
  assert.doesNotMatch(JSON.stringify(release), /oxygen\.reviewed-story\/1|localIdentityState|documentId|eventId/);
});

test("multiple accepted AI Insights, rejection, optional title, and four-part Quote projection are canonical", () => {
  const currentSource = source([
    insight("insight-z", "story-block-safe", { title: undefined }),
    insight("insight-a"),
    insight("insight-rejected"),
  ]);
  const state = reviewedState(currentSource, { "insight-rejected": "rejected" });
  const release = buildSuccessorReviewedStoryRelease([currentSource], { [currentSource.key]: state });
  const projected = release.chapters[0].en.insights;
  assert.deepEqual(projected.map((item) => item.id), ["insight-a", "insight-z"]);
  assert.equal(projected[0].quote, "The approved Story text states the safe boundary.");
  assert.deepEqual(Object.keys(projected[0]).sort(), [
    "background", "directlyAcquiredExperience", "id", "principle", "quote", "title",
  ]);
  assert.equal("title" in projected[1], false);
  assert.doesNotMatch(JSON.stringify(projected), /story-block-|evidence|origin|appliedVersion|revisionHistory/);
});

test("human-approved Insight releases with stable identity and no review provenance", () => {
  const currentSource = source([]);
  const human = humanContent(currentSource);
  const state = reviewedState(currentSource, {}, [["human:release-boundary", human]]);
  const release = buildSuccessorReviewedStoryRelease([currentSource], { [currentSource.key]: state });
  assert.deepEqual(release.chapters[0].en.insights, [{
    id: "human:release-boundary",
    background: human.background,
    quote: "The approved Story text states the safe boundary.",
    directlyAcquiredExperience: human.directlyAcquiredExperience,
    principle: human.principle,
  }]);
  assert.doesNotMatch(JSON.stringify(release), /human_created|chapterKey|storyBlockIds|appliedRevision/);
});

test("pending, missing, and edited-without-reaccept successor Insight state blocks release", () => {
  const currentSource = source([insight("insight-pending")]);
  const pending = emptySuccessorChapterReview(currentSource);
  pending.stage = "human_confirmed";
  assert.deepEqual(buildSuccessorReviewedStoryRelease([currentSource], {
    [currentSource.key]: pending,
  }).chapters, []);

  const missing = reviewedState(currentSource);
  delete missing.sourceInsightReviews["insight-pending"];
  assert.deepEqual(buildSuccessorReviewedStoryRelease([currentSource], {
    [currentSource.key]: missing,
  }).chapters, []);

  const accepted = reviewedState(currentSource);
  accepted.stage = "revision_ready";
  const editedContent = { ...currentSource.insights[0], title: "Edited title" };
  delete editedContent.id;
  const edited = editSuccessorAiInsight(accepted, currentSource, "insight-pending", editedContent);
  edited.stage = "human_confirmed";
  assert.deepEqual(buildSuccessorReviewedStoryRelease([currentSource], {
    [currentSource.key]: edited,
  }).chapters, []);
});

test("Privacy precedes projection and redacted Quote anchors are omitted without substitution", () => {
  const currentSource = source([
    insight("insight-private-anchor", "story-block-private"),
    insight("insight-safe-anchor", "story-block-safe", { background: `Background ${PRIVATE}` }),
  ], { title: `Title ${PRIVATE}` });
  const state = reviewedState(currentSource);
  const privacy = { redact: (copy) => copy.replaceAll(PRIVATE, '<redacted category="secret"/>') };
  const release = buildSuccessorReviewedStoryRelease([currentSource], { [currentSource.key]: state }, privacy);
  const serialized = serializeSuccessorReviewedStoryRelease(release);
  assert.ok(serialized);
  assert.doesNotMatch(serialized, new RegExp(PRIVATE));
  assert.deepEqual(release.chapters[0].en.story.blocks, [
    "The approved Story text states the safe boundary.",
  ]);
  assert.deepEqual(release.chapters[0].en.insights.map((item) => item.id), ["insight-safe-anchor"]);
  assert.match(release.chapters[0].en.title, /<redacted category="secret"\/>/);
  assert.match(release.chapters[0].en.insights[0].background, /<redacted category="secret"\/>/);
  assert.equal(release.chapters[0].en.insights[0].quote,
    "The approved Story text states the safe boundary.");
});

test("successor sanitizer strips every non-product field and canonicalizes Insight order", () => {
  const currentSource = source([insight("insight-b"), insight("insight-a")]);
  const release = buildSuccessorReviewedStoryRelease(
    [currentSource],
    { [currentSource.key]: reviewedState(currentSource) },
    { redact: (copy) => copy.replaceAll(PRIVATE, '<redacted category="secret"/>') },
  );
  const untrusted = structuredClone(release);
  untrusted.privateEvidence = PRIVATE;
  untrusted.chapters[0].anchors = [PRIVATE];
  untrusted.chapters[0].zh = { title: PRIVATE };
  untrusted.chapters[0].en.people[0].id = PRIVATE;
  untrusted.chapters[0].en.insights[0].origin = "source_ai";
  untrusted.chapters[0].en.insights.reverse();
  const sanitized = sanitizeSuccessorReviewedStoryRelease(untrusted);
  assert.ok(sanitized);
  assert.deepEqual(sanitized.chapters[0].en.insights.map((item) => item.id), ["insight-a", "insight-b"]);
  assert.doesNotMatch(JSON.stringify(sanitized), new RegExp(`${PRIVATE}|privateEvidence|anchors|origin|"zh"|"id":"${PRIVATE}"`));
  assert.equal(sanitizeSuccessorReviewedStoryRelease({ ...release, publication_approved: true }), null);
  assert.equal(sanitizeSuccessorReviewedStoryRelease({ ...release, schema_version: "oxygen.reviewed-story/1" }), null);
});

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

class FakeSuccessorReleaseDb {
  constructor({ items, run, session, redactionJob, redactions = [] }) {
    this.items = items;
    this.runs = new Map([[run.id, run]]);
    this.session = session;
    this.redactionJob = redactionJob;
    this.redactions = redactions;
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
        if (/FROM redactions/.test(sql)) return { results: structuredClone(this.redactions) };
        throw new Error(`Unexpected successor release all SQL: ${sql}`);
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
        throw new Error(`Unexpected successor release first SQL: ${sql}`);
      },
    };
  }
}

async function serverFixture() {
  const currentSource = source([
    insight("insight-private-anchor", "story-block-private"),
    insight("insight-safe-anchor", "story-block-safe"),
  ]);
  const state = reviewedState(currentSource);
  const session = createSuccessorStoryReviewSession(RUN_ID, { [currentSource.key]: state }, {});
  const item = {
    id: evidence.eventId,
    document_id: evidence.documentId,
    sequence: 1,
    event_type: "message",
    actor_id: "contributor",
    actor_type: "user",
    timestamp: "2026-08-25T00:00:00.000Z",
    content: `${PRIVATE} supporting evidence`,
    organization_reason: `${SUCCESSOR_STORY_PREFIX}${JSON.stringify(currentSource)}`,
  };
  const candidateRows = [{ id: item.id, documentId: item.document_id, summary: item.organization_reason }];
  const evidenceRows = [{
    id: item.id,
    documentId: item.document_id,
    eventType: item.event_type,
    actorId: item.actor_id,
    actorType: item.actor_type,
  }];
  const validation = validateSuccessorStorySourcePackage(candidateRows, evidenceRows);
  assert.equal(validation.ok, true);
  const sourceDigest = await computeSourceDigest([item]);
  const db = new FakeSuccessorReleaseDb({
    items: [item],
    run: {
      id: RUN_ID,
      status: "ready_for_human_review",
      sourceRevision: SOURCE_REVISION,
      activeStoryDigest: await sha256(validation.canonicalCandidate),
    },
    session: {
      state_json: JSON.stringify({ sourceRevision: SOURCE_REVISION, session }),
      updated_at: "2026-08-25T00:00:10.000Z",
      server_version: SERVER_VERSION,
    },
    redactionJob: {
      status: "complete",
      completed: 1,
      total: 1,
      rejected: 0,
      source_digest: sourceDigest,
    },
    redactions: [{
      item_id: item.id,
      start_offset: 0,
      end_offset: PRIVATE.length,
      category: "secret",
      status: "active",
    }],
  });
  return { db, currentSource };
}

const request = (overrides = {}) => ({
  workflowRunId: RUN_ID,
  serverVersion: SERVER_VERSION,
  sourceRevision: SOURCE_REVISION,
  ...overrides,
});

test("server accepts only exact /3 + /2 and rechecks run, version, source, and digest", async () => {
  const { db } = await serverFixture();
  const release = await reconstructReviewedStoryReleaseFromDatabase(db, request());
  assert.equal(release.ok, true);
  assert.equal(release.story.schema_version, SUCCESSOR_REVIEWED_STORY_SCHEMA);
  assert.equal(release.story.publication_approved, false);
  assert.deepEqual(release.story.chapters[0].en.insights.map((item) => item.id), ["insight-safe-anchor"]);
  assert.doesNotMatch(release.serializedStory, new RegExp(`${PRIVATE}|documentId|eventId|story-block-|source_ai`));

  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(db,
    request({ workflowRunId: "wrong-run" }))).code, RELEASE_ERROR.runConflict);
  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(db,
    request({ serverVersion: SERVER_VERSION - 1 }))).code, RELEASE_ERROR.versionConflict);
  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(db,
    request({ sourceRevision: SOURCE_REVISION - 1 }))).code, RELEASE_ERROR.sourceConflict);
  db.runs.get(RUN_ID).activeStoryDigest = "0".repeat(64);
  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(db, request())).code, RELEASE_ERROR.stateInvalid);
});

test("source/session/release mixing and every extra browser authority field fail closed", async () => {
  const legacySessionFixture = await serverFixture();
  const legacySession = createStoryReviewSession(RUN_ID, {}, {});
  legacySessionFixture.db.session.state_json = JSON.stringify({
    sourceRevision: SOURCE_REVISION,
    session: legacySession,
  });
  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(
    legacySessionFixture.db, request(),
  )).code, RELEASE_ERROR.stateInvalid);

  const mixed = await serverFixture();
  mixed.db.items.push({
    ...mixed.db.items[0],
    id: "story-doc:legacy",
    sequence: 2,
    organization_reason: "oxygen.story-highlight/2:{}",
  });
  mixed.db.redactionJob.source_digest = await computeSourceDigest(mixed.db.items);
  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(mixed.db, request())).code,
    RELEASE_ERROR.stateInvalid);

  const strict = await serverFixture();
  for (const [field, value] of Object.entries({
    story: {}, insight: {}, blocker: {}, approval: true, anchor: [], reviewState: "accepted",
    active_story_digest: "forged", publication_approved: true,
  })) {
    const result = await reconstructReviewedStoryReleaseFromDatabase(
      strict.db,
      { ...request(), [field]: value },
    );
    assert.equal(result.code, RELEASE_ERROR.requestInvalid, field);
  }
});

test("successor HTML and ZIP use the same canonical reviewed release bytes", async () => {
  const { db } = await serverFixture();
  const release = await reconstructReviewedStoryReleaseFromDatabase(db, request());
  assert.equal(release.ok, true);
  const htmlModule = await import("../app/api/organization/export/route.ts");
  const html = htmlModule.renderReviewedStoryHtml(release.serializedStory);
  const embedded = html.match(/const STORY=([\s\S]*?);const view=/)?.[1];
  assert.ok(embedded);
  const zipEntry = successorReviewedStoryPackageEntry(release.story);
  assert.equal(zipEntry.name, "story/reviewed-project-story.json");
  assert.equal(zipEntry.data, release.serializedStory);
  assert.deepEqual(JSON.parse(embedded), JSON.parse(zipEntry.data));

  const packageRoute = await readFile(new URL("../app/api/package/route.ts", import.meta.url), "utf8");
  assert.match(packageRoute, /finalReconstruction\.serializedStory !== reviewedStoryJson/);
  assert.match(packageRoute, /reconstructReviewedStoryReleaseFromDatabase\(db, releaseRequest\)/);
});
