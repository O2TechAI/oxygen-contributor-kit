import test from "node:test";
import assert from "node:assert/strict";
import { getLocalDatabase } from "../db/index.ts";
import {
  applyChapterReview,
  applyStoryReviewToBlock,
  emptyChapterReview,
  markChapterReady,
  recordStoryEdit,
  returnChapterToReview,
  storyBlocks,
} from "../lib/story-review.ts";
import { createStoryReviewSession } from "../lib/story-review-session.ts";
import { computeSourceDigest } from "../lib/redaction-pass.mjs";
import {
  deriveStoryReleaseTargetCatalog,
  storyPreparationDigest,
} from "../lib/story-preparation.ts";
import { confirmProjectAllSet } from "../lib/project-all-set.ts";
import {
  RELEASE_ERROR,
  reconstructReviewedStoryReleaseFromDatabase,
} from "../lib/story-release-server.ts";
import { validateStorySourcePackage } from "../lib/story-readiness.ts";
import { STORY_PREFIX } from "../lib/timeline.ts";
import { testStoryCoverage } from "./fixtures/story-coverage.mjs";
import { buildPackageFromDatabase } from "../app/api/package/route.ts";
import { renderReviewedStoryHtml } from "../app/api/organization/export/route.ts";

const RUN = "release-all-set-run";
const REVISION = 7;
const VERSION = 1;
const NOW = "2026-08-27T08:00:00.000Z";

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function source(key, itemId, index) {
  const evidence = { documentId: "release-doc", eventId: itemId };
  return {
    schema: "oxygen.story",
    key,
    phase: { id: `phase-${index}`, label: `Phase ${index}` },
    kind: "validation",
    title: `Release title ${index}`,
    overview: `Release overview ${index}`,
    transition: { before: `Before ${index}`, after: `After ${index}` },
    people: [{
      id: `person-${index}`, releaseLabel: `Contributor ${index}`, role: "Owner",
      description: `Owned release ${index}.`, localIdentityState: "not_identified", evidence: [evidence],
    }],
    story: {
      blocks: [{ id: `block-${key}`, text: `Safe release paragraph ${index}.`, evidence: [evidence] }],
      uncertainty: `Optional uncertainty ${index}.`,
    },
    insights: [],
    evidence: { primary: evidence, supporting: [] },
    coverage: testStoryCoverage(),
  };
}

function reviewContext(story, state = null) {
  const blocks = storyBlocks(story);
  return {
    source: story,
    privacyCandidates: [], privacyDecisions: {}, targetCatalog: new Map(),
    evidenceResolved: true, supportedAddIds: [], supportedEditIds: [],
    sourceBlocks: blocks,
    reviewedBlocks: state ? {
      en: Object.fromEntries(story.story.blocks.map((block) => [block.id, block.text])),
      zh: {},
    } : blocks,
  };
}

async function clear(db) {
  for (const table of [
    "project_all_set", "story_privacy_candidates", "story_preparation_receipts",
    "probe_runs", "probe_bulk_decisions", "probes", "story_review_sessions",
    "redactions", "redaction_jobs", "workflow_runs", "items", "documents",
  ]) await db.prepare(`DELETE FROM ${table}`).run();
}

async function setup() {
  const db = await getLocalDatabase();
  await clear(db);
  const stories = [
    source("chapter-one", "release-doc:event-1", 1),
    source("chapter-two", "release-doc:event-2", 2),
  ];
  const items = stories.map((story, index) => ({
    id: `release-doc:event-${index + 1}`,
    document_id: "release-doc",
    sequence: index + 1,
    event_type: "message",
    actor_id: "contributor",
    actor_type: "user",
    timestamp: `2026-08-27T07:00:0${index}.000Z`,
    content: `Safe reviewed evidence ${index + 1}.`,
    organization_category: "Release Project",
    organization_confidence: 100,
    organization_reason: `${STORY_PREFIX}${JSON.stringify(story)}`,
  }));
  const candidateRows = items.map((item) => ({
    id: item.id, documentId: item.document_id, sequence: item.sequence,
    timestamp: item.timestamp, summary: item.organization_reason,
  }));
  const evidenceRows = items.map((item) => ({
    id: item.id, documentId: item.document_id, eventType: item.event_type,
    actorId: item.actor_id, actorType: item.actor_type,
  }));
  const validation = validateStorySourcePackage(candidateRows, evidenceRows);
  assert.equal(validation.ok, true);
  const activeDigest = await sha256(validation.canonicalCandidate);

  await db.prepare(`INSERT INTO documents
    (id,kind,title,source_system,source_timestamp,item_count,metadata_json,
     original_envelope_json,imported_at,updated_at,organization_status,formatted_summary_json)
    VALUES ('release-doc','trajectory','Release source','local-agent-history',?,2,?,'{}',?,?,'complete',?)`)
    .bind(NOW, "{}", NOW, NOW, JSON.stringify({
      primary_project: "Release Project", project_summary: "Safe release project.",
    })).run();
  for (const item of items) {
    await db.prepare(`INSERT INTO items
      (id,document_id,sequence,event_type,actor_id,actor_type,timestamp,content,original_json,
       organization_category,organization_confidence,organization_reason)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      item.id, item.document_id, item.sequence, item.event_type, item.actor_id, item.actor_type,
      item.timestamp, item.content, "{}", item.organization_category,
      item.organization_confidence, item.organization_reason,
    ).run();
  }
  await db.prepare(`INSERT INTO workflow_runs
    (id,target_confirmed,collection_status,collection_completed,collection_total,
     story_generation_status,story_generation_completed,story_generation_total,
     story_source_revision,active_story_digest,created_at,updated_at)
    VALUES (?,1,'complete',2,2,'ready_for_human_review',2,2,?,?,?,?)`)
    .bind(RUN, REVISION, activeDigest, NOW, NOW).run();

  const reviews = {};
  for (const story of stories) {
    const applied = applyChapterReview(emptyChapterReview(story), reviewContext(story));
    assert.equal(applied.blockedReason, undefined);
    reviews[story.key] = markChapterReady(applied.state, reviewContext(story, applied.state));
  }
  const session = createStoryReviewSession(RUN, reviews, {}, NOW);
  await db.prepare(`INSERT INTO story_review_sessions
    (workflow_run_id,state_json,updated_at,server_version) VALUES (?,?,?,?)`)
    .bind(RUN, JSON.stringify({ sourceRevision: REVISION, session }), NOW, VERSION).run();

  const sourceDigest = await computeSourceDigest(items);
  await db.prepare(`INSERT INTO redaction_jobs
    (id,status,stage,completed,total,rejected,source_digest,started_at,updated_at,completed_at)
    VALUES ('redaction-release','complete','complete',0,0,0,?,?,?,?)`)
    .bind(sourceDigest, NOW, NOW, NOW).run();

  const catalog = deriveStoryReleaseTargetCatalog(stories);
  assert.ok(catalog);
  const privacyProducts = [
    {
      id: "candidate-auto", reviewState: "deterministic", title: "Automatic suppression",
      whyFlagged: "Exact target is always excluded.", uncertaintyReason: null,
      releaseTargets: ["chapter-one::title", "chapter-two::story:block-chapter-two"],
    },
    {
      id: "candidate-human", reviewState: "needs_confirmation", title: "Contributor decision",
      whyFlagged: "Contributor decides whether the overview remains.",
      uncertaintyReason: "Context is ambiguous.", releaseTargets: ["chapter-one::overview"],
    },
  ];
  for (const candidate of privacyProducts) {
    await db.prepare(`INSERT INTO story_privacy_candidates
      (workflow_run_id,candidate_id,candidate_json) VALUES (?,?,?)`)
      .bind(RUN, candidate.id, JSON.stringify(candidate)).run();
  }
  const emptyDigest = await storyPreparationDigest([]);
  const otherDigest = "a".repeat(64);
  const completeDigest = await storyPreparationDigest(candidateRows.map((row, index) => ({
    id: row.id, story: stories[index],
  })));
  const privacyDigest = await storyPreparationDigest(privacyProducts);
  const scopeDigest = await storyPreparationDigest(catalog.map((target) => target.id));
  const receipts = [
    ["story", otherDigest, otherDigest, 2, otherDigest, 2],
    ["insight", otherDigest, otherDigest, 2, emptyDigest, 0],
    ["story_privacy", completeDigest, scopeDigest, catalog.length, privacyDigest, 2],
    ["preference", emptyDigest, emptyDigest, 0, emptyDigest, 0],
  ];
  for (const [lane, input, scope, scopeCount, output, outputCount] of receipts) {
    await db.prepare(`INSERT INTO story_preparation_receipts
      (workflow_run_id,lane,source_revision,input_digest,scope_digest,scope_count,
       output_digest,output_count,completed_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(RUN, lane, REVISION, input, scope, scopeCount, output, outputCount, NOW).run();
  }
  await db.prepare(`INSERT INTO probe_runs
    (workflow_run_id,id,source_revision,input_digest,output_digest,output_count,status,stage,
     generated,set_aside,auto_removed_json,started_at,updated_at,completed_at)
    VALUES (?,?,?,?,?,0,'complete','preference',0,0,?,?,?,?)`)
    .bind(RUN, RUN, REVISION, emptyDigest, emptyDigest,
      JSON.stringify({ total: 0, reversible: true, categories: [] }), NOW, NOW, NOW).run();
  return { db, stories, reviews, request: {
    workflowRunId: RUN, serverVersion: VERSION, sourceRevision: REVISION,
  } };
}

test("real SQLite All set is fail-closed, concurrent-idempotent, and globally suppresses Privacy", async () => {
  const { db, request } = await setup();
  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(db, request)).code,
    RELEASE_ERROR.storyPrivacyPending);
  const pending = await confirmProjectAllSet(db, request, NOW);
  assert.equal(pending.code, RELEASE_ERROR.storyPrivacyPending);
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM project_all_set").first()).total, 0);

  await db.prepare(`UPDATE story_privacy_candidates
    SET decision='keep',decision_version=1,decided_at=? WHERE candidate_id='candidate-human'`)
    .bind(NOW).run();
  const insightReceipt = await db.prepare(
    "SELECT * FROM story_preparation_receipts WHERE workflow_run_id=? AND lane='insight'",
  ).bind(RUN).first();
  await db.prepare("DELETE FROM story_preparation_receipts WHERE workflow_run_id=? AND lane='insight'")
    .bind(RUN).run();
  assert.equal((await confirmProjectAllSet(db, request, NOW)).ok, false);
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM project_all_set").first()).total, 0);
  await db.prepare(`INSERT INTO story_preparation_receipts
    (workflow_run_id,lane,source_revision,input_digest,scope_digest,scope_count,
     output_digest,output_count,completed_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(
    insightReceipt.workflow_run_id, insightReceipt.lane, insightReceipt.source_revision,
    insightReceipt.input_digest, insightReceipt.scope_digest, insightReceipt.scope_count,
    insightReceipt.output_digest, insightReceipt.output_count, insightReceipt.completed_at,
  ).run();
  await db.prepare("UPDATE story_preparation_receipts SET output_digest='corrupt' WHERE lane='insight'")
    .run();
  assert.equal((await confirmProjectAllSet(db, request, NOW)).ok, false);
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM project_all_set").first()).total, 0);
  await db.prepare("UPDATE story_preparation_receipts SET output_digest=? WHERE lane='insight'")
    .bind(insightReceipt.output_digest).run();

  await db.prepare(`CREATE TRIGGER fail_project_all_set BEFORE INSERT ON project_all_set
    BEGIN SELECT RAISE(ABORT, 'forced All set failure'); END`).run();
  assert.equal((await confirmProjectAllSet(db, request, NOW)).code, "ALL_SET_CONFLICT");
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM project_all_set").first()).total, 0);
  await db.prepare("DROP TRIGGER fail_project_all_set").run();
  const concurrent = await Promise.all([
    confirmProjectAllSet(db, request, NOW),
    confirmProjectAllSet(db, request, NOW),
  ]);
  assert.ok(concurrent.every((result) => result.ok));
  assert.deepEqual(concurrent.map((result) => result.idempotent).sort(), [false, true]);
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM project_all_set").first()).total, 1);

  const release = await reconstructReviewedStoryReleaseFromDatabase(db, request);
  assert.equal(release.ok, true);
  assert.equal(release.story.chapters[0].en.title, "[Redacted]");
  assert.equal(release.story.chapters[0].en.overview, "Release overview 1");
  assert.deepEqual(release.story.chapters[1].en.story.blocks, []);
  assert.equal(JSON.stringify(release.story).includes("candidate-auto"), false);
  assert.equal((await confirmProjectAllSet(db, request, NOW)).idempotent, true);
});

test("Preference, receipt, session, edit, and final snapshot mutations block without stale bytes", async () => {
  const { db, stories, reviews, request } = await setup();
  await db.prepare(`UPDATE story_privacy_candidates SET decision='redact',decision_version=1,decided_at=?
    WHERE candidate_id='candidate-human'`).bind(NOW).run();
  assert.equal((await confirmProjectAllSet(db, request, NOW)).ok, true);

  await db.prepare(`INSERT INTO probes
    (id,document_id,document_kind,event_ids_json,signal,recap,question,options_json,
     presentations_json,created_at) VALUES ('probe-unanswered','release-doc','trajectory','[]',
     'preference','recap','Question?','[]','{}',?)`).bind(NOW).run();
  await db.prepare("UPDATE probe_runs SET output_count=1,output_digest=? WHERE workflow_run_id=?")
    .bind("c".repeat(64), RUN).run();
  await db.prepare("UPDATE story_preparation_receipts SET output_count=1,output_digest=? WHERE lane='preference'")
    .bind("c".repeat(64)).run();
  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(db, request)).code,
    RELEASE_ERROR.preferencePending);
  await db.prepare("UPDATE probes SET answer_choice='skip',answered_at=? WHERE id='probe-unanswered'")
    .bind(NOW).run();
  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(db, request)).ok, true);

  const raced = await reconstructReviewedStoryReleaseFromDatabase(db, request, {
    beforeFinalPrivacyCheck: () => db.prepare(
      "UPDATE story_preparation_receipts SET completed_at=? WHERE lane='story'",
    ).bind("2026-08-27T08:00:01.000Z").run(),
  });
  assert.equal(raced.code, RELEASE_ERROR.privacyConflict);
  await db.prepare("UPDATE story_preparation_receipts SET completed_at=? WHERE lane='story'")
    .bind(NOW).run();

  const finalSnapshotRaces = [
    [
      "UPDATE story_privacy_candidates SET decision='keep' WHERE candidate_id='candidate-human'",
      "UPDATE story_privacy_candidates SET decision='redact' WHERE candidate_id='candidate-human'",
    ],
    [
      "UPDATE probes SET answer_choice='keep' WHERE id='probe-unanswered'",
      "UPDATE probes SET answer_choice='skip' WHERE id='probe-unanswered'",
    ],
    [
      "UPDATE story_review_sessions SET updated_at='2026-08-27T08:00:01.000Z' WHERE workflow_run_id='release-all-set-run'",
      "UPDATE story_review_sessions SET updated_at='2026-08-27T08:00:00.000Z' WHERE workflow_run_id='release-all-set-run'",
    ],
    [
      "UPDATE project_all_set SET all_set_at='2026-08-27T08:00:01.000Z' WHERE workflow_run_id='release-all-set-run'",
      "UPDATE project_all_set SET all_set_at='2026-08-27T08:00:00.000Z' WHERE workflow_run_id='release-all-set-run'",
    ],
  ];
  for (const [mutate, restore] of finalSnapshotRaces) {
    const conflict = await reconstructReviewedStoryReleaseFromDatabase(db, request, {
      beforeFinalPrivacyCheck: () => db.prepare(mutate).run(),
    });
    assert.equal(conflict.code, RELEASE_ERROR.privacyConflict);
    await db.prepare(restore).run();
  }

  await db.prepare("DELETE FROM project_all_set").run();
  const editedStory = stories[0];
  const unconfirmedSession = createStoryReviewSession(RUN, {
    ...reviews, [editedStory.key]: returnChapterToReview(reviews[editedStory.key]),
  }, {}, NOW);
  await db.prepare("UPDATE story_review_sessions SET state_json=?,server_version=2 WHERE workflow_run_id=?")
    .bind(JSON.stringify({ sourceRevision: REVISION, session: unconfirmedSession }), RUN).run();
  assert.equal((await confirmProjectAllSet(db, { ...request, serverVersion: 2 }, NOW)).code,
    RELEASE_ERROR.reviewIncomplete);

  const edited = recordStoryEdit(returnChapterToReview(reviews[editedStory.key]), {
    storyKey: editedStory.key,
    blockId: editedStory.story.blocks[0].id,
    sourceLanguage: "en",
    baseText: editedStory.story.blocks[0].text,
    nextText: editedStory.story.blocks[0].text.replace("Safe ", ""),
    workingRange: { start: 0, end: 5 },
    insertedText: "",
    now: 1,
  });
  assert.equal(edited.blockedReason, undefined);
  const applied = applyChapterReview(edited.state, reviewContext(editedStory, edited.state));
  assert.equal(applied.blockedReason, undefined);
  const confirmed = markChapterReady(applied.state, reviewContext(editedStory, applied.state));
  assert.equal(confirmed.stage, "human_confirmed");
  assert.notEqual(applyStoryReviewToBlock(
    editedStory.story.blocks[0].text,
    editedStory.story.blocks[0].id,
    "en",
    confirmed,
  ), editedStory.story.blocks[0].text);
  const editedSession = createStoryReviewSession(RUN, {
    ...reviews, [editedStory.key]: confirmed,
  }, {}, NOW);
  await db.prepare("UPDATE story_review_sessions SET state_json=?,server_version=2 WHERE workflow_run_id=?")
    .bind(JSON.stringify({ sourceRevision: REVISION, session: editedSession }), RUN).run();
  assert.equal((await confirmProjectAllSet(db, { ...request, serverVersion: 2 }, NOW)).code,
    RELEASE_ERROR.editedStoryPrivacyRequired);

  await db.prepare("UPDATE story_review_sessions SET state_json='not-json' WHERE workflow_run_id=?")
    .bind(RUN).run();
  assert.equal((await confirmProjectAllSet(db, { ...request, serverVersion: 2 }, NOW)).code,
    RELEASE_ERROR.stateInvalid);
});

test("HTML and ZIP are POST-only, byte-identical for reviewed Story, and exclude authority sentinels", async () => {
  const { db, request } = await setup();
  await db.prepare(`UPDATE story_privacy_candidates SET decision='keep',decision_version=1,decided_at=?
    WHERE candidate_id='candidate-human'`).bind(NOW).run();
  assert.equal((await confirmProjectAllSet(db, request, NOW)).ok, true);
  const release = await reconstructReviewedStoryReleaseFromDatabase(db, request);
  assert.equal(release.ok, true);
  const html = renderReviewedStoryHtml(release.serializedStory);
  const embedded = html.match(/const STORY=([\s\S]*?);const view=/)?.[1];
  assert.deepEqual(JSON.parse(embedded), JSON.parse(release.serializedStory));
  assert.match(html, /story-row/);
  assert.match(html, /grid-template-columns/);

  const zipResponse = await buildPackageFromDatabase(db, release.serializedStory, request, {
    exportedAt: NOW,
  });
  assert.equal(zipResponse.status, 200);
  const zipText = new TextDecoder().decode(await zipResponse.arrayBuffer());
  assert.match(zipText, /oxygen\.reviewed-story/);
  assert.match(zipText, /"publication_approved": false/);
  assert.doesNotMatch(zipText, /candidate-auto|candidate-human|whyFlagged|releaseTargets|decisionVersion/);
  assert.doesNotMatch(zipText, /provider|model|evidence_sample|PRIVATE_/i);

  const racedZip = await buildPackageFromDatabase(db, release.serializedStory, request, {
    exportedAt: NOW,
    beforeFinalPrivacyCheck: () => db.prepare(
      "UPDATE project_all_set SET all_set_at='2026-08-27T08:00:01.000Z' WHERE workflow_run_id=?",
    ).bind(RUN).run(),
  });
  assert.equal(racedZip.status, 409);
  assert.equal((await racedZip.text()).includes("oxygen.reviewed-story"), false);

  const packageRoute = await import("../app/api/package/route.ts");
  const htmlRoute = await import("../app/api/organization/export/route.ts");
  assert.equal((await packageRoute.GET()).status, 405);
  assert.equal((await htmlRoute.GET()).status, 405);
});
