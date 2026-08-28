import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import {
  createStoryReviewSession,
  STORY_REVIEW_SESSION_SCHEMA,
} from "../lib/story-review-session.ts";
import {
  deriveStoryReleaseTargetCatalog,
  storyPreparationDigest,
} from "../lib/story-preparation.ts";
import { confirmProjectAllSet } from "../lib/project-all-set.ts";
import {
  RELEASE_ERROR,
  reconstructReviewedStoryReleaseFromDatabase,
} from "../lib/story-release-server.ts";
import {
  readSemanticManifestAuthority,
  validateStorySourcePackage,
} from "../lib/story-readiness.ts";
import { readCoveragePrivacyAuthority } from "../lib/story-coverage-privacy-authority.ts";
import {
  persistStoryReviewSessionCas,
  readActiveStoryReviewContract,
  readStoryReviewSessionRecord,
  STORY_SESSION_ERROR,
} from "../lib/story-review-session-server.ts";
import { STORY_PREFIX } from "../lib/timeline.ts";
import { testStoryCoverage } from "./fixtures/story-coverage.mjs";
import {
  POST as packagePost,
  buildPackageFromDatabase,
} from "../app/api/package/route.ts";
import {
  POST as htmlPost,
  renderReviewedStoryHtml,
} from "../app/api/organization/export/route.ts";
import { seedCoveragePrivacyAuthority } from "./story-coverage-privacy-fixture.mjs";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL && specifier.startsWith(".")) {
      const path = fileURLToPath(new URL(specifier, context.parentURL));
      if (!extname(path)) {
        if (existsSync(`${path}.ts`)) return nextResolve(`${specifier}.ts`, context);
        if (existsSync(join(path, "index.ts"))) return nextResolve(`${specifier}/index.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const {
  decideStoryPrivacyCandidate,
  readStoryPrivacyAuthority,
} = await import("../lib/story-privacy-authority.ts");
const { loadWorkspaceBootstrap } = await import("../lib/workflow-progress-server.ts");
const sourcePrivacyDecisionRoute = await import("../app/api/redactions/[id]/route.ts");
const workflowRoute = await import("../app/api/workflow/route.ts");

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
    "story_coverage_rows", "story_coverage_manifests", "semantic_unit_members",
    "semantic_units", "semantic_manifests", "finalized_corpus_manifests",
    "redactions", "redaction_jobs", "organization_jobs", "workflow_runs", "items", "documents",
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
  await seedCoveragePrivacyAuthority(db, {
    workflowRunId: RUN,
    sourceRevision: REVISION,
    stories,
    now: NOW,
  });
  const sourcePrivacyStart = items[0].content.indexOf("reviewed");
  await db.prepare(`INSERT INTO redactions
    (id,item_id,document_id,start_offset,end_offset,category,confidence,reason,
     review_state,uncertainty_reason,status,created_by,created_at,updated_at)
    VALUES ('source-privacy-release',?,?,?,?,?,'high',NULL,'confirmed_redact',NULL,
      'active','contributor',?,?)`).bind(
    items[0].id,
    items[0].document_id,
    sourcePrivacyStart,
    sourcePrivacyStart + "reviewed".length,
    "sensitive",
    NOW,
    NOW,
  ).run();
  await db.prepare(`UPDATE redaction_jobs SET completed=1,total=1 WHERE id=?`)
    .bind(`privacy-${RUN}`).run();
  const semanticAuthority = await readSemanticManifestAuthority(db, RUN);
  assert.ok(semanticAuthority);
  const sourcePrivacyAuthority = await readCoveragePrivacyAuthority(db, RUN, semanticAuthority);
  assert.equal(sourcePrivacyAuthority.ok, true);
  await db.prepare(`UPDATE story_coverage_manifests SET privacy_authority_digest=?
    WHERE workflow_run_id=?`).bind(sourcePrivacyAuthority.authority.snapshotDigest, RUN).run();
  candidateRows.forEach((row, index) => {
    row.summary = `${STORY_PREFIX}${JSON.stringify(stories[index])}`;
  });
  await db.prepare(`UPDATE documents SET formatted_summary_json=? WHERE id='release-doc'`)
    .bind(JSON.stringify({
      primary_project: "Release Project",
      project_summary: "Safe release project.",
      highlights: candidateRows.map((row) => ({
        id: row.id,
        sequence: row.sequence,
        timestamp: row.timestamp,
        summary: row.summary,
      })),
    })).run();
  await db.prepare(`INSERT INTO organization_jobs
    (id,status,stage,completed,total,warnings_json,started_at,updated_at,completed_at)
    VALUES ('release-organization','complete','done',2,2,'[]',?,?,?)`)
    .bind(NOW, NOW, NOW).run();

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

async function preparePendingSourcePrivacy(db) {
  await db.prepare(`UPDATE redactions SET review_state='needs_confirmation',status='active',
    uncertainty_reason='Contributor confirmation required',created_by='llm',updated_at=?
    WHERE id='source-privacy-release'`).bind("2026-08-27T08:00:01.000Z").run();
  const semantic = await readSemanticManifestAuthority(db, RUN);
  assert.ok(semantic);
  const authority = await readCoveragePrivacyAuthority(db, RUN, semantic);
  assert.equal(authority.ok, true, JSON.stringify(authority));
  await db.prepare(`UPDATE story_coverage_manifests SET privacy_authority_digest=?
    WHERE workflow_run_id=?`).bind(authority.authority.snapshotDigest, RUN).run();
}

function decideSourcePrivacy() {
  return sourcePrivacyDecisionRoute.PATCH(new Request(
    "http://localhost/api/redactions/source-privacy-release",
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "keep" }),
    },
  ), { params: Promise.resolve({ id: "source-privacy-release" }) });
}

function rawSessionRow(db) {
  return db.prepare(`SELECT state_json,updated_at,server_version FROM story_review_sessions
    WHERE workflow_run_id=?`).bind(RUN).first();
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

test("current Coverage Privacy authority gates hydration, CAS, Privacy, confirmation, HTML, and ZIP", async () => {
  const { db, request } = await setup();
  await db.prepare(`UPDATE story_privacy_candidates
    SET decision='keep',decision_version=1,decided_at=? WHERE candidate_id='candidate-human'`)
    .bind(NOW).run();
  assert.equal((await confirmProjectAllSet(db, request, NOW)).ok, true);
  const baselineRecord = await readStoryReviewSessionRecord(db, RUN);
  assert.ok(baselineRecord.session);
  assert.equal((await readActiveStoryReviewContract(db, RUN)).storySourceSchema, "oxygen.story");
  assert.equal((await loadWorkspaceBootstrap()).storySessionReadyRunId, RUN);
  assert.equal((await readStoryPrivacyAuthority(db, RUN)).ok, true);
  const baselineRelease = await reconstructReviewedStoryReleaseFromDatabase(db, request);
  assert.equal(baselineRelease.ok, true);

  const redaction = await db.prepare("SELECT * FROM redactions WHERE id='source-privacy-release'").first();
  const privacyJob = await db.prepare("SELECT * FROM redaction_jobs WHERE id=?")
    .bind(`privacy-${RUN}`).first();
  const semanticUnit = await db.prepare("SELECT * FROM semantic_units ORDER BY id LIMIT 1").first();
  const member = await db.prepare("SELECT * FROM semantic_unit_members ORDER BY item_id LIMIT 1").first();
  const semantic = await db.prepare("SELECT manifest_digest FROM semantic_manifests WHERE workflow_run_id=?")
    .bind(RUN).first();
  const coverageRow = await db.prepare("SELECT * FROM story_coverage_rows ORDER BY unit_id LIMIT 1").first();
  const content = await db.prepare("SELECT content FROM items WHERE id='release-doc:event-1'").first();

  const mutations = [{
    label: "confirmed redact to confirmed keep",
    mutate: () => db.prepare(`UPDATE redactions SET review_state='confirmed_keep',status='removed',
      updated_at='2026-08-27T08:00:01.000Z' WHERE id='source-privacy-release'`).run(),
    restore: () => db.prepare(`UPDATE redactions SET review_state='confirmed_redact',status='active',
      updated_at=? WHERE id='source-privacy-release'`).bind(NOW).run(),
  }, {
    label: "redaction deletion",
    mutate: () => db.prepare("DELETE FROM redactions WHERE id='source-privacy-release'").run(),
    restore: () => db.prepare(`INSERT INTO redactions
      (id,item_id,document_id,start_offset,end_offset,category,confidence,reason,review_state,
       uncertainty_reason,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(...[
        "id", "item_id", "document_id", "start_offset", "end_offset", "category",
        "confidence", "reason", "review_state", "uncertainty_reason", "status",
        "created_by", "created_at", "updated_at",
      ].map((key) => redaction[key])).run(),
  }, {
    label: "Privacy job missing",
    mutate: () => db.prepare("DELETE FROM redaction_jobs WHERE id=?").bind(privacyJob.id).run(),
    restore: () => db.prepare(`INSERT INTO redaction_jobs
      (id,status,stage,model,completed,total,rejected,source_digest,started_at,updated_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(...[
        "id", "status", "stage", "model", "completed", "total", "rejected", "source_digest",
        "started_at", "updated_at", "completed_at",
      ].map((key) => privacyJob[key])).run(),
  }, {
    label: "Privacy job change",
    mutate: () => db.prepare("UPDATE redaction_jobs SET updated_at=? WHERE id=?")
      .bind("2026-08-27T08:00:02.000Z", privacyJob.id).run(),
    restore: () => db.prepare("UPDATE redaction_jobs SET updated_at=? WHERE id=?")
      .bind(privacyJob.updated_at, privacyJob.id).run(),
  }, {
    label: "current content mutation",
    mutate: () => db.prepare("UPDATE items SET content='mutated current content' WHERE id='release-doc:event-1'").run(),
    restore: () => db.prepare("UPDATE items SET content=? WHERE id='release-doc:event-1'")
      .bind(content.content).run(),
  }, {
    label: "semantic unit missing",
    mutate: () => db.prepare("DELETE FROM semantic_units WHERE id=?").bind(semanticUnit.id).run(),
    restore: () => db.prepare(`INSERT INTO semantic_units
      (id,workflow_run_id,revision,project_id,kind,member_count,membership_digest,
       duplicate_of_unit_id,story_projection_json) VALUES (?,?,?,?,?,?,?,?,?)`).bind(...[
        "id", "workflow_run_id", "revision", "project_id", "kind", "member_count",
        "membership_digest", "duplicate_of_unit_id", "story_projection_json",
      ].map((key) => semanticUnit[key])).run(),
  }, {
    label: "semantic membership missing",
    mutate: () => db.prepare("DELETE FROM semantic_unit_members WHERE item_id=?").bind(member.item_id).run(),
    restore: () => db.prepare(`INSERT INTO semantic_unit_members
      (item_id,workflow_run_id,unit_id,source_digest) VALUES (?,?,?,?)`).bind(
      member.item_id, member.workflow_run_id, member.unit_id, member.source_digest,
    ).run(),
  }, {
    label: "semantic membership mutation",
    mutate: () => db.prepare("UPDATE semantic_unit_members SET source_digest=? WHERE item_id=?")
      .bind("f".repeat(64), member.item_id).run(),
    restore: () => db.prepare("UPDATE semantic_unit_members SET source_digest=? WHERE item_id=?")
      .bind(member.source_digest, member.item_id).run(),
  }, {
    label: "semantic manifest mutation",
    mutate: () => db.prepare("UPDATE semantic_manifests SET manifest_digest=? WHERE workflow_run_id=?")
      .bind("f".repeat(64), RUN).run(),
    restore: () => db.prepare("UPDATE semantic_manifests SET manifest_digest=? WHERE workflow_run_id=?")
      .bind(semantic.manifest_digest, RUN).run(),
  }, {
    label: "coverage row missing",
    mutate: () => db.prepare("DELETE FROM story_coverage_rows WHERE unit_id=?")
      .bind(coverageRow.unit_id).run(),
    restore: () => db.prepare(`INSERT INTO story_coverage_rows
      (unit_id,workflow_run_id,disposition,owner_id,exclusion_reason) VALUES (?,?,?,?,?)`).bind(
      coverageRow.unit_id, coverageRow.workflow_run_id, coverageRow.disposition,
      coverageRow.owner_id, coverageRow.exclusion_reason,
    ).run(),
  }, {
    label: "coverage row mutation",
    mutate: () => db.prepare("UPDATE story_coverage_rows SET owner_id='foreign-owner' WHERE unit_id=?")
      .bind(coverageRow.unit_id).run(),
    restore: () => db.prepare("UPDATE story_coverage_rows SET owner_id=? WHERE unit_id=?")
      .bind(coverageRow.owner_id, coverageRow.unit_id).run(),
  }];

  for (const mutation of mutations) {
    await mutation.mutate();
    const contract = await readActiveStoryReviewContract(db, RUN);
    assert.equal(contract.storySourceSchema, null, mutation.label);
    assert.equal((await loadWorkspaceBootstrap()).storySessionReadyRunId, "", mutation.label);
    const cas = await persistStoryReviewSessionCas(db, {
      workflowRunId: RUN,
      expectedVersion: VERSION,
      sourceRevision: REVISION,
      storySessionSchema: STORY_REVIEW_SESSION_SCHEMA,
      session: baselineRecord.session,
    }, "2026-08-27T08:00:03.000Z");
    assert.equal(cas.ok, false, mutation.label);
    assert.equal(cas.code, STORY_SESSION_ERROR.stateInvalid, mutation.label);
    assert.equal((await readStoryPrivacyAuthority(db, RUN)).ok, false, mutation.label);
    assert.equal((await reconstructReviewedStoryReleaseFromDatabase(db, request)).ok, false, mutation.label);
    assert.equal((await confirmProjectAllSet(db, request, NOW)).ok, false, mutation.label);
    const html = await htmlPost(new Request("http://localhost/api/organization/export", {
      method: "POST", body: JSON.stringify(request),
    }));
    const zip = await packagePost(new Request("http://localhost/api/package", {
      method: "POST", body: JSON.stringify(request),
    }));
    assert.equal(html.status, 409, mutation.label);
    assert.equal(zip.status, 409, mutation.label);
    assert.doesNotMatch(`${await html.text()}${await zip.text()}`,
      /source-privacy-release|privacy_authority_digest|confirmed_redact|mutated current content/i,
      mutation.label);
    await mutation.restore();
    assert.equal((await readActiveStoryReviewContract(db, RUN)).storySourceSchema,
      "oxygen.story", mutation.label);
    assert.equal((await reconstructReviewedStoryReleaseFromDatabase(db, request)).ok,
      true, mutation.label);
  }
});

test("source Privacy commits first and every active-Story writer loses the same token", async () => {
  {
    const { db } = await setup();
    await preparePendingSourcePrivacy(db);
    const prior = await readStoryReviewSessionRecord(db, RUN);
    assert.ok(prior.session);
    await db.prepare("DELETE FROM story_review_sessions WHERE workflow_run_id=?").bind(RUN).run();
    const privacy = await decideSourcePrivacy();
    assert.equal(privacy.status, 200, await privacy.text());
    const create = await persistStoryReviewSessionCas(db, {
      workflowRunId: RUN,
      expectedVersion: 0,
      sourceRevision: REVISION,
      storySessionSchema: STORY_REVIEW_SESSION_SCHEMA,
      session: prior.session,
    }, "2026-08-27T08:00:02.000Z");
    assert.equal(create.ok, false);
    assert.equal(create.code, STORY_SESSION_ERROR.notReady);
    assert.equal(await rawSessionRow(db), null);
  }

  {
    const { db } = await setup();
    await preparePendingSourcePrivacy(db);
    const prior = await readStoryReviewSessionRecord(db, RUN);
    const durableBefore = await rawSessionRow(db);
    const privacyAuthority = await readStoryPrivacyAuthority(db, RUN);
    assert.equal(privacyAuthority.ok, true);
    const privacy = await decideSourcePrivacy();
    assert.equal(privacy.status, 200, await privacy.text());

    const noOp = await persistStoryReviewSessionCas(db, {
      workflowRunId: RUN,
      expectedVersion: VERSION,
      sourceRevision: REVISION,
      storySessionSchema: STORY_REVIEW_SESSION_SCHEMA,
      session: { ...prior.session, updatedAt: "2099-01-01T00:00:00.000Z" },
    }, "2026-08-27T08:00:03.000Z");
    assert.equal(noOp.ok, false);
    assert.equal(noOp.code, STORY_SESSION_ERROR.notReady);

    const changed = structuredClone(prior.session);
    changed.chapterReviews["chapter-one"] = returnChapterToReview(
      changed.chapterReviews["chapter-one"],
    );
    const update = await persistStoryReviewSessionCas(db, {
      workflowRunId: RUN,
      expectedVersion: VERSION,
      sourceRevision: REVISION,
      storySessionSchema: STORY_REVIEW_SESSION_SCHEMA,
      session: changed,
    }, "2026-08-27T08:00:04.000Z");
    assert.equal(update.ok, false);
    assert.equal(update.code, STORY_SESSION_ERROR.notReady);
    assert.deepEqual(await rawSessionRow(db), durableBefore,
      "failed semantic and no-op CAS paths preserve exact durable bytes/version");

    const pendingCandidate = privacyAuthority.authority.candidates.find(
      (candidate) => candidate.id === "candidate-human",
    );
    assert.ok(pendingCandidate);
    const storyPrivacy = await decideStoryPrivacyCandidate(db, {
      workflowRunId: RUN,
      sourceRevision: REVISION,
      activeStoryDigest: privacyAuthority.authority.activeStoryDigest,
      candidateDigest: privacyAuthority.authority.candidateDigest,
      expectedVersion: 0,
      decision: "keep",
    }, pendingCandidate.id, "2026-08-27T08:00:05.000Z");
    assert.equal(storyPrivacy.ok, false);
    const candidateRow = await db.prepare(`SELECT decision,decision_version,decided_at
      FROM story_privacy_candidates WHERE candidate_id='candidate-human'`).first();
    assert.deepEqual(candidateRow, { decision: null, decision_version: 0, decided_at: null });
  }
});

test("dependent write first then source Privacy invalidates hydration, Privacy, All set, HTML, and ZIP", async () => {
  const { db, request } = await setup();
  await db.prepare(`UPDATE story_privacy_candidates
    SET decision='keep',decision_version=1,decided_at=? WHERE candidate_id='candidate-human'`)
    .bind(NOW).run();
  assert.equal((await confirmProjectAllSet(db, request, NOW)).ok, true);
  await preparePendingSourcePrivacy(db);

  const record = await readStoryReviewSessionRecord(db, RUN);
  const dependent = await persistStoryReviewSessionCas(db, {
    workflowRunId: RUN,
    expectedVersion: VERSION,
    sourceRevision: REVISION,
    storySessionSchema: STORY_REVIEW_SESSION_SCHEMA,
    session: { ...record.session, updatedAt: "2099-01-01T00:00:00.000Z" },
  }, "2026-08-27T08:00:06.000Z");
  assert.equal(dependent.ok, true);
  assert.equal(dependent.noChange, true);

  const privacy = await decideSourcePrivacy();
  assert.equal(privacy.status, 200, await privacy.text());
  assert.deepEqual(await db.prepare(`SELECT story_generation_status,story_source_revision,
    active_story_digest FROM workflow_runs WHERE id=?`).bind(RUN).first(), {
    story_generation_status: "blocked",
    story_source_revision: REVISION,
    active_story_digest: null,
  });
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM project_all_set").first()).total, 0);
  assert.equal((await db.prepare(
    "SELECT COUNT(*) AS total FROM story_privacy_authorities",
  ).first()).total, 0);
  assert.equal((await readActiveStoryReviewContract(db, RUN)).storySourceSchema, null);
  assert.equal((await loadWorkspaceBootstrap()).storySessionReadyRunId, "");
  assert.equal((await readStoryPrivacyAuthority(db, RUN)).ok, false);
  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(db, request)).ok, false);
  assert.equal((await confirmProjectAllSet(db, request, NOW)).ok, false);

  const html = await htmlPost(new Request("http://localhost/api/organization/export", {
    method: "POST", body: JSON.stringify(request),
  }));
  const zip = await packagePost(new Request("http://localhost/api/package", {
    method: "POST", body: JSON.stringify(request),
  }));
  assert.equal(html.status, 409);
  assert.equal(zip.status, 409);
  const failures = `${await html.text()}${await zip.text()}`;
  assert.doesNotMatch(failures,
    /source-privacy-release|Contributor confirmation|required|localhost|sqlite|trace|\.sqlite/iu);

  const restart = await workflowRoute.POST(new Request("http://localhost/api/workflow", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workflowRunId: RUN, event: "story_generation_started" }),
  }));
  assert.equal(restart.status, 200, await restart.text());
  assert.equal((await db.prepare(
    "SELECT story_generation_status FROM workflow_runs WHERE id=?",
  ).bind(RUN).first()).story_generation_status, "running");
});

test("real SQLite concurrent source Privacy and session CAS has exactly one legal ordering", async () => {
  const { db } = await setup();
  await preparePendingSourcePrivacy(db);
  const prior = await readStoryReviewSessionRecord(db, RUN);
  await db.prepare("DELETE FROM story_review_sessions WHERE workflow_run_id=?").bind(RUN).run();
  const [privacy, session] = await Promise.all([
    decideSourcePrivacy(),
    persistStoryReviewSessionCas(db, {
      workflowRunId: RUN,
      expectedVersion: 0,
      sourceRevision: REVISION,
      storySessionSchema: STORY_REVIEW_SESSION_SCHEMA,
      session: prior.session,
    }, "2026-08-27T08:00:07.000Z"),
  ]);
  assert.equal(privacy.status, 200, await privacy.text());
  const durableCount = Number((await db.prepare(
    "SELECT COUNT(*) AS total FROM story_review_sessions WHERE workflow_run_id=?",
  ).bind(RUN).first()).total);
  const sessionCommitted = session.ok && session.saved;
  assert.equal(durableCount, sessionCommitted ? 1 : 0);
  assert.equal(sessionCommitted, false);
  assert.equal(session.code, STORY_SESSION_ERROR.stateInvalid,
    "the scheduled privacy-first ordering is detected during canonical authority validation");
  assert.equal((await db.prepare(
    "SELECT story_generation_status FROM workflow_runs WHERE id=?",
  ).bind(RUN).first()).story_generation_status, "blocked");

  await setup();
  await preparePendingSourcePrivacy(db);
  const [unrelatedOrganization, unrelatedProbe, secondPrivacy] = await Promise.all([
    db.prepare(`INSERT INTO organization_jobs
      (id,status,stage,completed,total,warnings_json,started_at,updated_at,completed_at)
      VALUES ('unrelated-organization','complete','done',0,0,'[]',?,?,?)`)
      .bind(NOW, NOW, NOW).run(),
    db.prepare(`INSERT INTO probes
      (id,document_id,document_kind,event_ids_json,signal,recap,question,options_json,
       presentations_json,created_at) VALUES
      ('unrelated-probe','release-doc','trajectory','[]','preference','recap',
       'Question?','[]','{}',?)`).bind(NOW).run(),
    decideSourcePrivacy(),
  ]);
  assert.equal(Number(unrelatedOrganization.meta.changes), 1);
  assert.equal(Number(unrelatedProbe.meta.changes), 1);
  assert.equal(secondPrivacy.status, 200, await secondPrivacy.text());
});
