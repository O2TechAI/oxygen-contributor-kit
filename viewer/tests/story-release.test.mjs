import test from "node:test";
import assert from "node:assert/strict";
import { testStoryCoverage } from "./fixtures/story-coverage.mjs";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import {
  applyChapterReview,
  editAiInsight,
  emptyChapterReview,
  markChapterReady,
  saveHumanInsight,
  storyBlocks,
  updateAiInsightDecision,
} from "../lib/story-review.ts";
import {
  createStoryReviewSession,
} from "../lib/story-review-session.ts";
import {
  REVIEWED_STORY_SCHEMA,
  buildReviewedStoryRelease,
  releaseOrganizationReason,
  sanitizeReviewedStoryRelease,
  serializeReviewedStoryRelease,
  reviewedStoryPackageEntry,
} from "../lib/story-release.ts";
import {
  RELEASE_ERROR,
  reconstructReviewedStoryReleaseFromDatabase,
} from "../lib/story-release-server.ts";
import { readActiveStoryReviewContract } from "../lib/story-review-session-server.ts";
import { computeSourceDigest } from "../lib/redaction-pass.mjs";
import { captureStoryReleasePrivacySnapshot } from "../lib/release-privacy-snapshot.ts";
import { validateStorySourcePackage } from "../lib/story-readiness.ts";
import { STORY_PREFIX } from "../lib/timeline.ts";

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

const RUN_ID = "story-release-run";
const SOURCE_REVISION = 9;
const SERVER_VERSION = 6;
const PRIVATE = "PRIVATE_STORY_SENTINEL";
const PRIVATE_STORY_QUOTE_SENTINEL = "PRIVATE_STORY_QUOTE_SENTINEL";
const LOCAL_REVIEW_REASON_SENTINEL = "LOCAL_REVIEW_REASON_SENTINEL";
const LOCAL_UNCERTAINTY_SENTINEL = "LOCAL_UNCERTAINTY_SENTINEL";
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

function source(insights = [], overrides = {}, privateValue = PRIVATE) {
  return {
    schema: "oxygen.story",
    key: "chapter-release",
    phase: { id: "phase-discovery", label: "Discovery" },
    kind: "decision",
    title: "Reviewed story Chapter",
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
        { id: "story-block-private", text: `The ${privateValue} was removed.`, evidence: [evidence] },
        { id: "story-block-safe", text: "The approved Story text states the safe boundary.", evidence: [evidence] },
      ],
      uncertainty: "The remaining uncertainty is explicit.",
    },
    insights,
    evidence: { primary: evidence, supporting: [] },
    coverage: testStoryCoverage(),
    ...overrides,
  };
}

function context(currentSource) {
  const blocks = storyBlocks(currentSource);
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
  const text = "approved Story text";
  const block = currentSource.story.blocks.find((item) => item.id === "story-block-safe");
  const start = block.text.indexOf(text);
  return {
    background: "Human-approved background.",
    quote: {
      chapterKey: currentSource.key,
      storyBlockId: "story-block-safe",
      selection: { start, end: start + text.length, text },
      baseRevision: 2,
    },
    directlyAcquiredExperience: "The contributor directly acquired this experience.",
    principle: "Preserve the checked boundary.",
    evidence: [evidence],
    ...overrides,
  };
}

function reviewedState(currentSource, decisions = {}, humans = []) {
  const currentContext = context(currentSource);
  let state = applyChapterReview(
    emptyChapterReview(currentSource),
    currentContext,
  ).state;
  for (const sourceInsight of currentSource.insights) {
    state = updateAiInsightDecision(
      state,
      currentSource,
      sourceInsight.id,
      decisions[sourceInsight.id] || "accepted",
    );
  }
  for (const [id, content] of humans) {
    state = saveHumanInsight(state, currentContext, id, content).state;
  }
  if (state.stage !== "revision_ready") {
    state = applyChapterReview(state, currentContext).state;
  }
  return markChapterReady(state, currentContext);
}

test("the canonical release permits a complete zero-Insight Story", () => {
  const currentSource = source([]);
  const release = buildReviewedStoryRelease(
    [currentSource],
    { [currentSource.key]: reviewedState(currentSource) },
  );
  assert.equal(release.schema, REVIEWED_STORY_SCHEMA);
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
  assert.doesNotMatch(JSON.stringify(release), /localIdentityState|documentId|eventId/);
});

test("multiple accepted AI Insights, rejection, optional title, and four-part Quote projection are canonical", () => {
  const currentSource = source([
    insight("insight-z", "story-block-safe", { title: undefined }),
    insight("insight-a"),
    insight("insight-rejected"),
  ]);
  const state = reviewedState(currentSource, { "insight-rejected": "rejected" });
  const release = buildReviewedStoryRelease([currentSource], { [currentSource.key]: state });
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
  const release = buildReviewedStoryRelease([currentSource], { [currentSource.key]: state });
  assert.deepEqual(release.chapters[0].en.insights, [{
    id: "human:release-boundary",
    background: human.background,
    quote: "approved Story text",
    directlyAcquiredExperience: human.directlyAcquiredExperience,
    principle: human.principle,
  }]);
  assert.doesNotMatch(JSON.stringify(release), /human_created|chapterKey|storyBlockId|selection|baseRevision|appliedRevision/);
});

test("human Quote Privacy is exact: selected bytes fail closed and redaction elsewhere does not broaden", () => {
  const privacy = { redact: (copy) => copy.replaceAll(PRIVATE, '<redacted category="secret"/>') };

  const elsewhere = source([]);
  elsewhere.story.blocks[1].text = `The approved Story text states the safe boundary. ${PRIVATE}`;
  const elsewhereHuman = humanContent(elsewhere);
  const elsewhereRelease = buildReviewedStoryRelease(
    [elsewhere],
    { [elsewhere.key]: reviewedState(elsewhere, {}, [["human:elsewhere", elsewhereHuman]]) },
    privacy,
  );
  assert.equal(elsewhereRelease.chapters[0].en.insights[0].quote, "approved Story text");
  assert.doesNotMatch(JSON.stringify(elsewhereRelease), new RegExp(PRIVATE));

  const selected = source([]);
  selected.story.blocks[1].text = `The approved ${PRIVATE} Story text states the safe boundary.`;
  const start = selected.story.blocks[1].text.indexOf(PRIVATE);
  const selectedHuman = humanContent(selected, {
    quote: {
      chapterKey: selected.key,
      storyBlockId: "story-block-safe",
      selection: { start, end: start + PRIVATE.length, text: PRIVATE },
      baseRevision: 2,
    },
  });
  const selectedRelease = buildReviewedStoryRelease(
    [selected],
    { [selected.key]: reviewedState(selected, {}, [["human:selected-private", selectedHuman]]) },
    privacy,
  );
  assert.deepEqual(selectedRelease.chapters[0].en.insights, []);
  assert.doesNotMatch(JSON.stringify(selectedRelease), new RegExp(PRIVATE));
});

test("pending, missing, and edited-without-reaccept story Insight state blocks release", () => {
  const currentSource = source([insight("insight-pending")]);
  const pending = emptyChapterReview(currentSource);
  pending.stage = "human_confirmed";
  assert.deepEqual(buildReviewedStoryRelease([currentSource], {
    [currentSource.key]: pending,
  }).chapters, []);

  const missing = reviewedState(currentSource);
  delete missing.sourceInsightReviews["insight-pending"];
  assert.deepEqual(buildReviewedStoryRelease([currentSource], {
    [currentSource.key]: missing,
  }).chapters, []);

  const accepted = reviewedState(currentSource);
  accepted.stage = "revision_ready";
  const editedContent = { ...currentSource.insights[0], title: "Edited title" };
  delete editedContent.id;
  const edited = editAiInsight(accepted, currentSource, "insight-pending", editedContent);
  edited.stage = "human_confirmed";
  assert.deepEqual(buildReviewedStoryRelease([currentSource], {
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
  const release = buildReviewedStoryRelease([currentSource], { [currentSource.key]: state }, privacy);
  const serialized = serializeReviewedStoryRelease(release);
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

test("story sanitizer strips every non-product field and canonicalizes Insight order", () => {
  const currentSource = source([insight("insight-b"), insight("insight-a")]);
  const release = buildReviewedStoryRelease(
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
  const sanitized = sanitizeReviewedStoryRelease(untrusted);
  assert.ok(sanitized);
  assert.deepEqual(sanitized.chapters[0].en.insights.map((item) => item.id), ["insight-a", "insight-b"]);
  assert.doesNotMatch(JSON.stringify(sanitized), new RegExp(`${PRIVATE}|privateEvidence|anchors|origin|"zh"|"id":"${PRIVATE}"`));
  assert.equal(sanitizeReviewedStoryRelease({ ...release, publication_approved: true }), null);
  assert.equal(sanitizeReviewedStoryRelease({ ...release, schema: "oxygen.reviewed-story.invalid" }), null);
});

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}


class FakeStoryReleaseDb {
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
        if (/FROM workflow_runs WHERE id=\?/.test(sql)) {
          const run = this.runs.get(values[0]);
          return { results: run ? [{
            id: run.id,
            story_generation_status: run.status,
            story_source_revision: run.sourceRevision,
            active_story_digest: run.activeStoryDigest,
          }] : [] };
        }
        if (/FROM story_review_sessions WHERE workflow_run_id=\?/.test(sql)) {
          return { results: this.session ? [structuredClone(this.session)] : [] };
        }
        if (/FROM redaction_jobs/.test(sql)) {
          return { results: this.redactionJob ? [structuredClone(this.redactionJob)] : [] };
        }
        if (/organization_reason AS summary/.test(sql)) return { results: this.items.map((item) => ({
          id: item.id, documentId: item.document_id, summary: item.organization_reason,
        })) };
        if (/event_type AS eventType/.test(sql)) return { results: this.items.map((item) => ({
          id: item.id, documentId: item.document_id, eventType: item.event_type,
          actorId: item.actor_id, actorType: item.actor_type,
        })) };
        if (/FROM items/.test(sql)) return { results: structuredClone(this.items) };
        if (/FROM redactions/.test(sql)) return { results: structuredClone(this.redactions) };
        throw new Error(`Unexpected story release all SQL: ${sql}`);
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
        throw new Error(`Unexpected story release first SQL: ${sql}`);
      },
    };
  }

  batch(statements) {
    return Promise.all(statements.map((statement) => statement.all()));
  }
}

async function serverFixture({
  sourceInsights = [
    insight("insight-private-anchor", "story-block-private"),
    insight("insight-safe-anchor", "story-block-safe"),
  ],
  decisions = {},
  includeHuman = false,
  storyPrivate = PRIVATE,
  initiallyRedacted = true,
} = {}) {
  const currentSource = source(sourceInsights, {}, storyPrivate);
  const humans = includeHuman
    ? [["human:approved", humanContent(currentSource)]] : [];
  const state = reviewedState(currentSource, decisions, humans);
  const session = createStoryReviewSession(RUN_ID, { [currentSource.key]: state }, {});
  const item = {
    id: evidence.eventId,
    document_id: evidence.documentId,
    sequence: 1,
    event_type: "message",
    actor_id: "contributor",
    actor_type: "user",
    timestamp: "2026-08-25T00:00:00.000Z",
    content: `${storyPrivate} supporting evidence`,
    organization_reason: `${STORY_PREFIX}${JSON.stringify(currentSource)}`,
  };
  const candidateRows = [{ id: item.id, documentId: item.document_id, summary: item.organization_reason }];
  const evidenceRows = [{
    id: item.id,
    documentId: item.document_id,
    eventType: item.event_type,
    actorId: item.actor_id,
    actorType: item.actor_type,
  }];
  const validation = validateStorySourcePackage(candidateRows, evidenceRows);
  assert.equal(validation.ok, true);
  assert.equal(validation.chapterCount, 1);
  const sourceDigest = await computeSourceDigest([item]);
  const db = new FakeStoryReleaseDb({
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
      completed: initiallyRedacted ? 1 : 0,
      total: initiallyRedacted ? 1 : 0,
      rejected: 0,
      source_digest: sourceDigest,
    },
    redactions: initiallyRedacted ? [{
      item_id: item.id,
      start_offset: 0,
      end_offset: storyPrivate.length,
      category: "secret",
      review_state: "deterministic",
      status: "active",
    }] : [],
  });
  return { db, currentSource };
}

const request = (overrides = {}) => ({
  workflowRunId: RUN_ID,
  serverVersion: SERVER_VERSION,
  sourceRevision: SOURCE_REVISION,
  ...overrides,
});

test("server accepts only the canonical contracts and rechecks run, version, source, and digest", async () => {
  const { db } = await serverFixture();
  assert.deepEqual(await readActiveStoryReviewContract(db, RUN_ID), {
    ready: true,
    sourceRevision: SOURCE_REVISION,
    storySourceSchema: "oxygen.story",
    storySessionSchema: "oxygen.story-review-session",
  });
  const release = await reconstructReviewedStoryReleaseFromDatabase(db, request());
  assert.equal(release.ok, true);
  assert.equal(release.story.schema, REVIEWED_STORY_SCHEMA);
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

test("missing, unknown, or pending Privacy blocks release while confirmed keep and redact are exact", async () => {
  const keepFixture = await serverFixture({ initiallyRedacted: false });
  const keepItem = keepFixture.db.items[0];
  keepFixture.db.redactionJob.completed = 1;
  keepFixture.db.redactionJob.total = 1;
  const privacySpan = {
    id: "review-keep",
    item_id: keepItem.id,
    document_id: keepItem.document_id,
    start_offset: 0,
    end_offset: PRIVATE.length,
    category: "sensitive",
    confidence: "high",
    reason: LOCAL_REVIEW_REASON_SENTINEL,
    uncertainty_reason: LOCAL_UNCERTAINTY_SENTINEL,
    status: "active",
    created_by: "llm",
    created_at: "2026-08-25T00:00:03.000Z",
    updated_at: "2026-08-25T00:00:03.000Z",
  };
  keepFixture.db.redactions = [privacySpan];
  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(
    keepFixture.db, request(),
  )).code, RELEASE_ERROR.storyNotReady, "a missing Privacy state must block an active span");
  keepFixture.db.redactions = [{ ...privacySpan, review_state: "unknown_future_state" }];
  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(
    keepFixture.db, request(),
  )).code, RELEASE_ERROR.storyNotReady, "an unknown Privacy state must block release");

  keepFixture.db.redactions = [{ ...privacySpan, review_state: "needs_confirmation" }];
  const pendingSnapshot = await captureStoryReleasePrivacySnapshot(keepFixture.db, RUN_ID);
  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(
    keepFixture.db, request(),
  )).code, RELEASE_ERROR.storyNotReady);

  keepFixture.db.redactions[0] = {
    ...keepFixture.db.redactions[0],
    review_state: "confirmed_keep",
    status: "removed",
    created_by: "contributor",
    updated_at: "2026-08-25T00:00:04.000Z",
  };
  const keepSnapshot = await captureStoryReleasePrivacySnapshot(keepFixture.db, RUN_ID);
  assert.notEqual(keepSnapshot.digest, pendingSnapshot.digest);
  const kept = await reconstructReviewedStoryReleaseFromDatabase(keepFixture.db, request());
  assert.equal(kept.ok, true);
  assert.match(kept.serializedStory, new RegExp(PRIVATE));
  assert.equal(kept.story.chapters[0].en.story.blocks[0], `The ${PRIVATE} was removed.`);

  const redactFixture = await serverFixture({ initiallyRedacted: false });
  const redactItem = redactFixture.db.items[0];
  assert.match(redactItem.content, new RegExp(PRIVATE), "the private sentinel must exist in the reconstructed input");
  assert.match(redactItem.organization_reason, new RegExp(PRIVATE), "the private sentinel must exist in the Story source input");
  redactFixture.db.redactionJob.completed = 1;
  redactFixture.db.redactionJob.total = 1;
  redactFixture.db.redactions = [{
    ...keepFixture.db.redactions[0],
    id: "review-redact",
    item_id: redactItem.id,
    document_id: redactItem.document_id,
    review_state: "confirmed_redact",
    status: "active",
  }];
  const redacted = await reconstructReviewedStoryReleaseFromDatabase(redactFixture.db, request());
  assert.equal(redacted.ok, true);
  assert.doesNotMatch(redacted.serializedStory, new RegExp(PRIVATE));

  const { renderReviewedStoryHtml } = await import("../app/api/organization/export/route.ts");
  const html = renderReviewedStoryHtml(redacted.serializedStory);
  const zipEntry = reviewedStoryPackageEntry(redacted.story);
  const publicationBytes = [redacted.serializedStory, html, zipEntry.data].join("\n");
  assert.doesNotMatch(publicationBytes, new RegExp(
    `${LOCAL_REVIEW_REASON_SENTINEL}|${LOCAL_UNCERTAINTY_SENTINEL}`,
  ));
  assert.doesNotMatch(publicationBytes, /review_state|uncertainty_reason|created_by/);
  assert.equal(redacted.story.publication_approved, false);
});

test("synthetic live server flow releases zero, one, and mixed multiple Insights with byte parity", async () => {
  const scenarios = [
    { options: { sourceInsights: [] }, expected: [] },
    { options: { sourceInsights: [insight("insight-one")] }, expected: ["insight-one"] },
    {
      options: {
        sourceInsights: [insight("insight-accepted"), insight("insight-rejected")],
        decisions: { "insight-rejected": "rejected" },
        includeHuman: true,
      },
      expected: ["human:approved", "insight-accepted"],
    },
  ];
  const { renderReviewedStoryHtml } = await import("../app/api/organization/export/route.ts");
  for (const { options, expected } of scenarios) {
    const { db } = await serverFixture(options);
    const release = await reconstructReviewedStoryReleaseFromDatabase(db, request());
    assert.equal(release.ok, true);
    assert.deepEqual(release.story.chapters[0].en.insights.map((item) => item.id), expected);
    if (options.includeHuman) {
      assert.equal(release.story.chapters[0].en.insights
        .find((item) => item.id === "human:approved").quote, "approved Story text");
    }
    const zipEntry = reviewedStoryPackageEntry(release.story);
    assert.equal(zipEntry.data, release.serializedStory);
    const embedded = renderReviewedStoryHtml(release.serializedStory)
      .match(/const STORY=([\s\S]*?);const view=/)?.[1];
    assert.deepEqual(JSON.parse(embedded), JSON.parse(zipEntry.data));
    if (options.includeHuman) {
      assert.equal(JSON.parse(zipEntry.data).chapters[0].en.insights
        .find((item) => item.id === "human:approved").quote, "approved Story text");
    }
    assert.equal(release.story.publication_approved, false);
  }
});

test("every extra browser authority field fails closed", async () => {
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

test("unknown reserved Story-family values cannot bypass live bootstrap or release selectors", async () => {
  const originalSentinel = "PRIVATE_ORIGINAL_SENTINEL";
  const evidenceSentinel = "PRIVATE_EVIDENCE_SENTINEL";
  const fixture = await serverFixture();
  const unknownReason = `oxygen.story.future:${JSON.stringify({
    original: originalSentinel,
    evidence: evidenceSentinel,
  })}`;
  fixture.db.items.push({
    ...fixture.db.items[0],
    id: "story-doc:unknown-story-version",
    sequence: 2,
    organization_reason: unknownReason,
  });
  fixture.db.redactionJob.source_digest = await computeSourceDigest(fixture.db.items);

  assert.deepEqual(await readActiveStoryReviewContract(fixture.db, RUN_ID), {
    ready: true,
    sourceRevision: SOURCE_REVISION,
    storySourceSchema: null,
    storySessionSchema: null,
  });
  const release = await reconstructReviewedStoryReleaseFromDatabase(fixture.db, request());
  assert.equal(release.code, RELEASE_ERROR.stateInvalid);
  assert.doesNotMatch(JSON.stringify(release), new RegExp(`${originalSentinel}|${evidenceSentinel}`));
  assert.equal(releaseOrganizationReason(unknownReason), "Reviewed project Story");
  assert.doesNotMatch(releaseOrganizationReason(unknownReason), new RegExp(`${originalSentinel}|${evidenceSentinel}`));
});

test("anchored Story Privacy mutation before finalization cannot release stale Quote bytes", async () => {
  const fixture = await serverFixture({
    storyPrivate: PRIVATE_STORY_QUOTE_SENTINEL,
    initiallyRedacted: false,
    sourceInsights: [insight("insight-private-anchor", "story-block-private")],
  });
  const item = fixture.db.items[0];
  const result = await reconstructReviewedStoryReleaseFromDatabase(
    fixture.db,
    request(),
    {
      beforeFinalPrivacyCheck: () => {
        fixture.db.redactions = [{
          id: "late-story-redaction",
          item_id: item.id,
          document_id: item.document_id,
          start_offset: 0,
          end_offset: PRIVATE_STORY_QUOTE_SENTINEL.length,
          category: "sensitive",
          status: "active",
          updated_at: "2026-08-25T00:00:20.000Z",
        }];
      },
    },
  );
  assert.equal(result.code, RELEASE_ERROR.privacyConflict);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(PRIVATE_STORY_QUOTE_SENTINEL));
});

test("a contributor review decision during Story assembly fails the snapshot race closed", async () => {
  const fixture = await serverFixture();
  fixture.db.redactions[0] = {
    ...fixture.db.redactions[0],
    id: "decision-race",
    document_id: fixture.db.items[0].document_id,
    review_state: "confirmed_redact",
    uncertainty_reason: LOCAL_UNCERTAINTY_SENTINEL,
    reason: LOCAL_REVIEW_REASON_SENTINEL,
    created_by: "contributor",
    created_at: "2026-08-25T00:00:03.000Z",
    updated_at: "2026-08-25T00:00:03.000Z",
  };
  const result = await reconstructReviewedStoryReleaseFromDatabase(
    fixture.db,
    request(),
    {
      beforeFinalPrivacyCheck: () => {
        fixture.db.redactions[0] = {
          ...fixture.db.redactions[0],
          review_state: "confirmed_keep",
          status: "removed",
          updated_at: "2026-08-25T00:00:04.000Z",
        };
      },
    },
  );
  assert.equal(result.code, RELEASE_ERROR.privacyConflict);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(
    `${LOCAL_REVIEW_REASON_SENTINEL}|${LOCAL_UNCERTAINTY_SENTINEL}`,
  ));
});

test("story HTML and ZIP use the same canonical reviewed release bytes", async () => {
  const safeHtmlEscapeSentinel = "SAFE_HTML_ESCAPE_</script><script>";
  const { db } = await serverFixture({
    sourceInsights: [insight("insight-html-escape", "story-block-safe", {
      background: safeHtmlEscapeSentinel,
    })],
  });
  const release = await reconstructReviewedStoryReleaseFromDatabase(db, request());
  assert.equal(release.ok, true);
  const htmlModule = await import("../app/api/organization/export/route.ts");
  const html = htmlModule.renderReviewedStoryHtml(release.serializedStory);
  assert.equal(htmlModule.renderReviewedStoryHtml(release.serializedStory), html);
  const embedded = html.match(/const STORY=([\s\S]*?);const view=/)?.[1];
  assert.ok(embedded);
  const zipEntry = reviewedStoryPackageEntry(release.story);
  assert.equal(zipEntry.name, "story/reviewed-project-story.json");
  assert.equal(zipEntry.data, release.serializedStory);
  assert.match(zipEntry.data, new RegExp(safeHtmlEscapeSentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(html.includes(safeHtmlEscapeSentinel), false, "HTML embedding must escape script-sensitive JSON copy");
  assert.deepEqual(JSON.parse(embedded), JSON.parse(zipEntry.data));

  const packageRoute = await readFile(new URL("../app/api/package/route.ts", import.meta.url), "utf8");
  assert.match(packageRoute, /finalReconstruction\.serializedStory !== reviewedStoryJson/);
  assert.match(packageRoute, /reconstructReviewedStoryReleaseFromDatabase\(db, releaseRequest\)/);
});
