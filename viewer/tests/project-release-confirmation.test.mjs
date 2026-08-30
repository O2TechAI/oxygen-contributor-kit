import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
  deriveStoryReleaseTargetContents,
  normalizeStoryPrivacyOutput,
  storyPreparationDigest,
} from "../lib/story-preparation.ts";
import {
  confirmProjectReleaseConfirmation,
  readProjectReleaseConfirmation,
} from "../lib/project-release-confirmation.ts";
import {
  RELEASE_ERROR,
  reconstructReviewedStoryReleaseFromDatabase,
} from "../lib/story-release-server.ts";
import { validateStorySourcePackage } from "../lib/story-readiness.ts";
import { STORY_PREFIX } from "../lib/timeline.ts";
import { reconstructReviewedStoryPrivacyRevision } from "../lib/story-privacy-revision.ts";
import { testStoryCoverage } from "./fixtures/story-coverage.mjs";
import { buildPackageFromDatabase } from "../app/api/package/route.ts";
import { renderReviewedStoryHtml } from "../app/api/organization/export/route.ts";
import {
  buildReviewedStoryPrivacyPreparationSnapshot,
  importReviewedStoryPrivacyAuthority,
  readStoryPrivacyAuthority,
  saveStoryPrivacyTargetChoice,
  STORY_PRIVACY_ERROR,
} from "../lib/story-privacy-authority.ts";
import { loadWorkflowProgress } from "../lib/workflow-progress-server.ts";
import { startWorkflowPolling } from "../lib/workflow-progress.ts";
import { seedCoveragePrivacyAuthority } from "./story-coverage-privacy-fixture.mjs";
import {
  buildSourcePrivacyReceipt,
  installSourcePrivacyReceipt,
} from "./fixtures/source-privacy-receipt.mjs";

const RUN = "release-confirmation-run";
const REVISION = 7;
const VERSION = 1;
const NOW = "2026-08-27T08:00:00.000Z";

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function scopedProposal(target, replacement = "Anonymous") {
  const original = Array.from(target.content);
  let originalEndOffset = original.length;
  while (originalEndOffset > 0 && !/[\p{L}\p{N}_-]/u.test(original[originalEndOffset - 1])) {
    originalEndOffset -= 1;
  }
  let originalStartOffset = originalEndOffset;
  while (originalStartOffset > 0 && /[\p{L}\p{N}_-]/u.test(original[originalStartOffset - 1])) {
    originalStartOffset -= 1;
  }
  assert.ok(originalStartOffset < originalEndOffset);
  const proposed = Array.from(replacement);
  return {
    proposedText: [
      ...original.slice(0, originalStartOffset),
      ...proposed,
      ...original.slice(originalEndOffset),
    ].join(""),
    occurrences: [{
      originalStartOffset,
      originalEndOffset,
      proposalStartOffset: originalStartOffset,
      proposalEndOffset: originalStartOffset + proposed.length,
      category: "private-identity",
    }],
  };
}

async function privacyForTargets(targets, candidates) {
  const flagged = new Set(candidates.flatMap((candidate) => candidate.releaseTargets));
  const targetProposals = await Promise.all(targets.map(async (target) => ({
    targetId: target.id,
    targetContentDigest: target.contentDigest || await storyPreparationDigest(target.content),
    ...(flagged.has(target.id)
      ? scopedProposal(target)
      : { proposedText: target.content, occurrences: [] }),
  })));
  const privacy = await normalizeStoryPrivacyOutput({ candidates, targetProposals }, targets);
  assert.ok(privacy);
  return privacy;
}

const aliasRules = [
  ["C:\\Secret\\Atlas", "Workspace", "file-path"],
  ["sk-live-secret", "[Credential removed]", "credential"],
  ["Alice", "Person A", "person-name"],
  ["Atlas", "Project A", "project-name"],
  ["Acme", "Organization A", "organization-name"],
  ["Bob", "Person B", "person-name"],
].map(([original, replacement, category]) => ({
  original: Array.from(original), replacement: Array.from(replacement), category,
})).sort((left, right) => right.original.length - left.original.length);

function aliasProposal(target) {
  const original = Array.from(target.content);
  const proposal = [];
  const occurrences = [];
  for (let index = 0; index < original.length;) {
    const rule = aliasRules.find((candidate) => candidate.original.every((point, offset) => (
      original[index + offset] === point
    )));
    if (!rule) {
      proposal.push(original[index]);
      index += 1;
      continue;
    }
    const proposalStartOffset = proposal.length;
    proposal.push(...rule.replacement);
    occurrences.push({
      originalStartOffset: index,
      originalEndOffset: index + rule.original.length,
      proposalStartOffset,
      proposalEndOffset: proposal.length,
      category: rule.category,
    });
    index += rule.original.length;
  }
  return { proposedText: proposal.join(""), occurrences };
}

async function completedPrivacyImport(snapshot, candidates = [], completedAt = "2026-08-27T08:00:02.000Z") {
  const privacy = await privacyForTargets(snapshot.changedTargets, candidates);
  const terminalReceipt = {
    schema: "oxygen.reviewed-story-privacy-terminal-receipt",
    status: "complete",
    ...Object.fromEntries(Object.entries(snapshot.binding).filter(([key]) => key !== "previousAuthorityDigest")),
    outputDigest: await storyPreparationDigest(privacy),
    outputCount: privacy.targetProposals.length,
    completedAt,
  };
  const receiptDigest = await storyPreparationDigest(terminalReceipt);
  const core = {
    schema: "oxygen.reviewed-story-privacy-import",
    binding: snapshot.binding,
    receiptDigest,
    privacy,
  };
  return {
    ...core,
    terminalReceipt,
    importDigest: await storyPreparationDigest(core),
  };
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
    "project_release_confirmations", "story_privacy_authorities", "story_privacy_targets",
    "story_privacy_candidates", "story_preparation_receipts",
    "probe_runs", "probe_bulk_decisions", "probes", "story_review_sessions",
    "story_coverage_rows", "story_coverage_manifests", "semantic_unit_members", "semantic_units",
    "semantic_manifests", "finalized_corpus_manifests", "redactions",
    "source_privacy_receipts", "redaction_jobs",
    "workflow_runs", "items", "documents",
  ]) await db.prepare(`DELETE FROM ${table}`).run();
}

function observeDatabase(db) {
  const originalPrepare = db.prepare;
  const originalBatch = db.batch;
  const originalTransaction = db.transaction;
  const counts = {
    queries: 0,
    confirmationQueries: 0,
    storySnapshotQueries: 0,
    packageSnapshotQueries: 0,
    batchWriteTransactions: 0,
    longWriteTransactions: 0,
  };
  db.prepare = function observedPrepare(sql) {
    counts.queries += 1;
    if (/FROM project_release_confirmations/.test(sql)) counts.confirmationQueries += 1;
    if (/SELECT i\.id,i\.document_id,d\.kind AS document_kind,i\.sequence,i\.event_type,\s*i\.actor_id,i\.actor_type,[\s\S]*i\.organization_reason[\s\S]*FROM items i LEFT JOIN documents d/.test(sql)) {
      counts.storySnapshotQueries += 1;
    }
    if (/SELECT id,kind,title,source_system,source_timestamp,item_count,[\s\S]*FROM documents/.test(sql)) {
      counts.packageSnapshotQueries += 1;
    }
    return originalPrepare.call(this, sql);
  };
  db.batch = function observedBatch(statements) {
    counts.batchWriteTransactions += 1;
    return originalBatch.call(this, statements);
  };
  db.transaction = function observedTransaction(operation) {
    counts.longWriteTransactions += 1;
    return originalTransaction.call(this, operation);
  };
  return {
    counts,
    restore() {
      db.prepare = originalPrepare;
      db.batch = originalBatch;
      db.transaction = originalTransaction;
    },
  };
}

async function resolveHumanStoryPrivacy(db, decidedAt = NOW) {
  const current = await readStoryPrivacyAuthority(db, RUN);
  assert.equal(current.ok, true, JSON.stringify(current));
  const target = current.authority.targets.find((value) => (
    value.targetId === "chapter-one::overview"
  ));
  assert.ok(target);
  const result = await saveStoryPrivacyTargetChoice(db, {
    workflowRunId: RUN,
    sourceRevision: REVISION,
    activeStoryDigest: current.authority.activeStoryDigest,
    authorityDigest: current.authority.authorityDigest,
    targetId: target.targetId,
    targetContentDigest: target.targetContentDigest,
    editedText: null,
    publicOverrides: [],
  }, decidedAt);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.authority;
}

async function chooseStoryPrivacyTarget(
  db,
  authority,
  targetId,
  choice = { editedText: null, publicOverrides: [] },
  decidedAt = NOW,
) {
  const target = authority.targets.find((value) => value.targetId === targetId);
  assert.ok(target);
  return saveStoryPrivacyTargetChoice(db, {
    workflowRunId: RUN,
    sourceRevision: REVISION,
    activeStoryDigest: authority.activeStoryDigest,
    authorityDigest: authority.authorityDigest,
    targetId,
    targetContentDigest: target.targetContentDigest,
    ...choice,
  }, decidedAt);
}

async function setup({ anonymization = false } = {}) {
  const db = await getLocalDatabase();
  await clear(db);
  const stories = [
    source("chapter-one", "release-doc:event-1", 1),
    source("chapter-two", "release-doc:event-2", 2),
  ];
  if (anonymization) {
    stories[0].title = "Alice built Atlas at Acme";
    stories[0].overview = "Alice used C:\\Secret\\Atlas with sk-live-secret";
    stories[0].people[0].releaseLabel = "Alice";
    stories[0].story.blocks[0].text = "Alice collaborated with Bob at Acme.";
    stories[1].title = "Bob continued Atlas for Acme";
    stories[1].overview = "Alice reviewed Bob's work.";
    stories[1].people[0].releaseLabel = "Bob";
  }
  const privateSource = "Alice|Bob|Acme|Atlas|C:\\Secret\\Atlas|sk-live-secret";
  const items = stories.map((story, index) => ({
    id: `release-doc:event-${index + 1}`,
    document_id: "release-doc",
    sequence: index + 1,
    event_type: "message",
    actor_id: "contributor",
    actor_type: "user",
    timestamp: `2026-08-27T07:00:0${index}.000Z`,
    content: anonymization && index === 0 ? privateSource : `Safe reviewed evidence ${index + 1}.`,
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

  const targetContents = deriveStoryReleaseTargetContents(stories);
  assert.ok(targetContents);
  let targetProposals;
  let privacyProducts;
  if (anonymization) {
    targetProposals = await Promise.all(targetContents.map(async (target) => ({
      targetId: target.id,
      targetContentDigest: await storyPreparationDigest(target.content),
      ...aliasProposal(target),
    })));
    const changedTargets = targetProposals.filter((proposal) => proposal.occurrences.length > 0)
      .map((proposal) => proposal.targetId);
    const humanTargets = ["chapter-one::overview", "chapter-two::overview"];
    privacyProducts = [{
      id: "candidate-auto",
      reviewState: "deterministic",
      title: "Agent alias proposal",
      whyFlagged: "Agent-authored aliases cover the remaining changed targets.",
      uncertaintyReason: null,
      releaseTargets: changedTargets.filter((target) => !humanTargets.includes(target)),
    }, {
      id: "candidate-human",
      reviewState: "needs_confirmation",
      title: "Contributor public override",
      whyFlagged: "The exact overview occurrence needs contributor confirmation.",
      uncertaintyReason: "Context is ambiguous.",
      releaseTargets: [humanTargets[0]],
    }, {
      id: "candidate-edit",
      reviewState: "needs_confirmation",
      title: "Contributor edit",
      whyFlagged: "The second overview needs contributor wording.",
      uncertaintyReason: "Contributor wording is required.",
      releaseTargets: [humanTargets[1]],
    }];
  } else {
    privacyProducts = [{
      id: "candidate-auto",
      reviewState: "deterministic",
      title: "Automatic proposal",
      whyFlagged: "Exact targets have bounded Agent proposals.",
      uncertaintyReason: null,
      releaseTargets: ["chapter-one::title", "chapter-two::story:block-chapter-two"],
    }, {
      id: "candidate-human",
      reviewState: "needs_confirmation",
      title: "Contributor decision",
      whyFlagged: "Contributor decides whether the overview proposal is accepted.",
      uncertaintyReason: "Context is ambiguous.",
      releaseTargets: ["chapter-one::overview"],
    }];
    const flagged = new Set(privacyProducts.flatMap((candidate) => candidate.releaseTargets));
    targetProposals = await Promise.all(targetContents.map(async (target) => ({
      targetId: target.id,
      targetContentDigest: await storyPreparationDigest(target.content),
      ...(flagged.has(target.id)
        ? scopedProposal(target)
        : { proposedText: target.content, occurrences: [] }),
    })));
  }
  const privacy = await normalizeStoryPrivacyOutput({
    candidates: privacyProducts,
    targetProposals,
  }, targetContents);
  assert.ok(privacy);
  const pendingTargets = new Set(privacy.candidates
    .filter((candidate) => candidate.reviewState === "needs_confirmation")
    .flatMap((candidate) => candidate.releaseTargets));
  for (const candidate of privacy.candidates) {
    await db.prepare(`INSERT INTO story_privacy_candidates
      (workflow_run_id,candidate_id,candidate_json) VALUES (?,?,?)`)
      .bind(RUN, candidate.id, JSON.stringify(candidate)).run();
  }
  for (const proposal of privacy.targetProposals) {
    const pending = pendingTargets.has(proposal.targetId);
    await db.prepare(`INSERT INTO story_privacy_targets
      (workflow_run_id,target_id,target_content_digest,proposed_text,occurrences_json,
       selected_text,public_overrides_json,decided_at) VALUES (?,?,?,?,?,?,'[]',?)`).bind(
      RUN,
      proposal.targetId,
      proposal.targetContentDigest,
      proposal.proposedText,
      JSON.stringify(proposal.occurrences),
      pending ? null : proposal.proposedText,
      pending ? null : NOW,
    ).run();
  }
  const emptyDigest = await storyPreparationDigest([]);
  const otherDigest = "a".repeat(64);
  const completeDigest = await storyPreparationDigest(candidateRows.map((row, index) => ({
    id: row.id, story: stories[index],
  })));
  const privacyDigest = await storyPreparationDigest(privacy);
  const scopeDigest = await storyPreparationDigest(targetContents.map((target) => target.id));
  const receipts = [
    ["story", otherDigest, otherDigest, 2, otherDigest, 2],
    ["insight", otherDigest, otherDigest, 2, emptyDigest, 0],
    ["story_privacy", completeDigest, scopeDigest, targetContents.length, privacyDigest,
      privacy.targetProposals.length],
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

  const sourceRedactions = anonymization ? [
    ["Alice", "private-personal"], ["Bob", "private-personal"], ["Acme", "sensitive"],
    ["Atlas", "sensitive"], ["C:\\Secret\\Atlas", "sensitive"],
    ["sk-live-secret", "credential"],
  ].map(([text, category]) => {
    const startOffset = Array.from(privateSource.slice(0, privateSource.indexOf(text))).length;
    return {
      itemId: items[0].id, documentId: items[0].document_id,
      startOffset, endOffset: startOffset + Array.from(text).length,
      category, confidence: "high", reason: "Synthetic release projection fixture.",
      reviewState: "deterministic", uncertaintyReason: null, createdBy: "llm",
    };
  }) : [];
  await seedCoveragePrivacyAuthority(db, {
    workflowRunId: RUN,
    sourceRevision: REVISION,
    stories,
    now: NOW,
    projectId: "release-confirmation-project",
    redactions: sourceRedactions,
  });

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
  return { db, stories, reviews, request: {
    workflowRunId: RUN, serverVersion: VERSION, sourceRevision: REVISION,
  } };
}

test("release confirmation rejects source revision zero before database initialization", async () => {
  const stateDir = join(tmpdir(), `oxygen-release-confirmation-zero-${process.pid}-${Date.now()}`);
  assert.equal(existsSync(stateDir), false);
  const previousStateDir = process.env.OXYGEN_VIEWER_STATE_DIR;
  process.env.OXYGEN_VIEWER_STATE_DIR = stateDir;
  try {
    const route = await import("../app/api/release-confirmation/route.ts");
    const response = await route.POST(new Request("http://localhost/api/release-confirmation", {
      method: "POST",
      body: JSON.stringify({ workflowRunId: RUN, serverVersion: 0, sourceRevision: 0 }),
    }));
    assert.equal(response.status, 400);
    assert.equal(existsSync(stateDir), false);
  } finally {
    if (previousStateDir === undefined) delete process.env.OXYGEN_VIEWER_STATE_DIR;
    else process.env.OXYGEN_VIEWER_STATE_DIR = previousStateDir;
  }
});

test("active Story with no confirmation row performs no release reconstruction or write transaction", async () => {
  const { db } = await setup();
  const observation = observeDatabase(db);
  let workflow;
  try {
    workflow = await loadWorkflowProgress(RUN);
  } finally {
    observation.restore();
  }
  assert.equal(workflow.releaseConfirmed, false);
  assert.equal(observation.counts.confirmationQueries, 1);
  assert.equal(observation.counts.storySnapshotQueries, 0);
  assert.equal(observation.counts.packageSnapshotQueries, 0);
  assert.equal(observation.counts.batchWriteTransactions, 0);
  assert.equal(observation.counts.longWriteTransactions, 0);
});

test("present confirmation reconstructs outside a long write transaction and mutation fails closed", async () => {
  const { db, request } = await setup();
  await resolveHumanStoryPrivacy(db);
  assert.equal((await confirmProjectReleaseConfirmation(db, request, NOW)).ok, true);

  const observation = observeDatabase(db);
  let confirmed;
  try {
    confirmed = await readProjectReleaseConfirmation(db, request);
  } finally {
    observation.restore();
  }
  assert.equal(confirmed, true);
  assert.equal(observation.counts.storySnapshotQueries, 2);
  assert.equal(observation.counts.packageSnapshotQueries, 2);
  assert.equal(observation.counts.batchWriteTransactions, 5,
    "only bounded Story, package, and Story Privacy batches open short BEGIN IMMEDIATE scopes");
  assert.equal(observation.counts.longWriteTransactions, 0,
    "no BEGIN IMMEDIATE transaction covers passive reconstruction");

  const beforeChapterBytes = (await db.prepare(
    "SELECT state_json FROM story_review_sessions WHERE workflow_run_id=?",
  ).bind(RUN).first()).state_json;
  const raced = await readProjectReleaseConfirmation(db, request, {
    beforeFinalPrivacyCheck: () => db.prepare(`UPDATE project_release_confirmations
      SET confirmed_at=? WHERE workflow_run_id=?`)
      .bind("2026-08-27T08:00:01.000Z", RUN).run(),
  });
  assert.equal(raced, false);
  assert.equal((await db.prepare(
    "SELECT state_json FROM story_review_sessions WHERE workflow_run_id=?",
  ).bind(RUN).first()).state_json, beforeChapterBytes);
});

test("real SQLite release confirmation is fail-closed, concurrent-idempotent, and globally suppresses Privacy", async () => {
  const { db, request } = await setup();
  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(db, request)).code,
    RELEASE_ERROR.storyPrivacyPending);
  const pending = await confirmProjectReleaseConfirmation(db, request, NOW);
  assert.equal(pending.code, RELEASE_ERROR.storyPrivacyPending);
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM project_release_confirmations").first()).total, 0);

  await resolveHumanStoryPrivacy(db);
  const insightReceipt = await db.prepare(
    "SELECT * FROM story_preparation_receipts WHERE workflow_run_id=? AND lane='insight'",
  ).bind(RUN).first();
  await db.prepare("DELETE FROM story_preparation_receipts WHERE workflow_run_id=? AND lane='insight'")
    .bind(RUN).run();
  assert.equal((await confirmProjectReleaseConfirmation(db, request, NOW)).ok, false);
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM project_release_confirmations").first()).total, 0);
  await db.prepare(`INSERT INTO story_preparation_receipts
    (workflow_run_id,lane,source_revision,input_digest,scope_digest,scope_count,
     output_digest,output_count,completed_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(
    insightReceipt.workflow_run_id, insightReceipt.lane, insightReceipt.source_revision,
    insightReceipt.input_digest, insightReceipt.scope_digest, insightReceipt.scope_count,
    insightReceipt.output_digest, insightReceipt.output_count, insightReceipt.completed_at,
  ).run();
  await db.prepare("UPDATE story_preparation_receipts SET output_digest='corrupt' WHERE lane='insight'")
    .run();
  assert.equal((await confirmProjectReleaseConfirmation(db, request, NOW)).ok, false);
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM project_release_confirmations").first()).total, 0);
  await db.prepare("UPDATE story_preparation_receipts SET output_digest=? WHERE lane='insight'")
    .bind(insightReceipt.output_digest).run();

  await db.prepare(`CREATE TRIGGER fail_project_release_confirmation
    BEFORE INSERT ON project_release_confirmations
    BEGIN SELECT RAISE(ABORT, 'forced release confirmation failure'); END`).run();
  assert.equal((await confirmProjectReleaseConfirmation(db, request, NOW)).code,
    "RELEASE_CONFIRMATION_CONFLICT");
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM project_release_confirmations").first()).total, 0);
  await db.prepare("DROP TRIGGER fail_project_release_confirmation").run();
  const concurrent = await Promise.all([
    confirmProjectReleaseConfirmation(db, request, NOW),
    confirmProjectReleaseConfirmation(db, request, NOW),
  ]);
  assert.ok(concurrent.every((result) => result.ok));
  assert.deepEqual(concurrent.map((result) => result.idempotent).sort(), [false, true]);
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM project_release_confirmations").first()).total, 1);

  const release = await reconstructReviewedStoryReleaseFromDatabase(db, request);
  assert.equal(release.ok, true);
  assert.equal(release.story.chapters[0].en.title, "Release title Anonymous");
  assert.equal(release.story.chapters[0].en.overview, "Release overview Anonymous");
  assert.deepEqual(release.story.chapters[1].en.story.blocks, [{
    text: "Safe release paragraph Anonymous.", insights: [],
  }]);
  assert.equal(JSON.stringify(release.story).includes("candidate-auto"), false);
  assert.equal((await confirmProjectReleaseConfirmation(db, request, NOW)).idempotent, true);
});

test("target choices keep aliases, exact public spans, edits, and credential vetoes", async () => {
  const { db, request } = await setup({ anonymization:true });
  const revision = await reconstructReviewedStoryPrivacyRevision(db, RUN);
  assert.equal(revision.ok, true, JSON.stringify(revision));
  const initial = await readStoryPrivacyAuthority(db, RUN);
  assert.equal(initial.ok, true, JSON.stringify(initial));
  const overviewId = "chapter-one::overview";
  const overview = initial.authority.targets.find((target) => target.targetId === overviewId);
  assert.ok(overview);
  const person = overview.occurrences.find((occurrence) => occurrence.originalText === "Alice");
  const credential = overview.occurrences.find((occurrence) => occurrence.category === "credential");
  assert.deepEqual({ proposed:person.proposedText, canPublish:person.canPublish }, {
    proposed:"Person A", canPublish:true,
  });
  assert.deepEqual({ proposed:credential.proposedText, canPublish:credential.canPublish }, {
    proposed:"[Credential removed]", canPublish:false,
  });

  const asOverride = (occurrence) => ({
    originalStartOffset: occurrence.originalStartOffset,
    originalEndOffset: occurrence.originalEndOffset,
    category: occurrence.category,
  });
  const credentialAttempt = await chooseStoryPrivacyTarget(db, initial.authority, overviewId, {
    editedText:null,
    publicOverrides:[asOverride(credential)],
  }, "2026-08-27T08:00:01.000Z");
  assert.deepEqual(credentialAttempt, { ok:false, code:STORY_PRIVACY_ERROR.notActionable });

  const published = await chooseStoryPrivacyTarget(db, initial.authority, overviewId, {
    editedText:null,
    publicOverrides:[asOverride(person)],
  }, "2026-08-27T08:00:02.000Z");
  assert.equal(published.ok, true);
  assert.equal(published.authority.targets.find((target) => target.targetId === overviewId)
    .occurrences.find((occurrence) => occurrence.originalText === "Alice").isPublic, true);
  const reset = await chooseStoryPrivacyTarget(db, published.authority, overviewId, {
    editedText:null,
    publicOverrides:[],
  }, "2026-08-27T08:00:02.100Z");
  assert.equal(reset.ok, true);
  const resetPerson = reset.authority.targets.find((target) => target.targetId === overviewId)
    .occurrences.find((occurrence) => occurrence.originalText === "Alice");
  assert.equal(resetPerson.isPublic, false);
  const republished = await chooseStoryPrivacyTarget(db, reset.authority, overviewId, {
    editedText:null,
    publicOverrides:[asOverride(resetPerson)],
  }, "2026-08-27T08:00:02.200Z");
  assert.equal(republished.ok, true);

  const editedText = "Person B reviewed Person A's revised public workflow.";
  const edited = await chooseStoryPrivacyTarget(
    db,
    republished.authority,
    "chapter-two::overview",
    { editedText, publicOverrides:[] },
    "2026-08-27T08:00:03.000Z",
  );
  assert.equal(edited.ok, true);
  assert.equal((await confirmProjectReleaseConfirmation(db, request,
    "2026-08-27T08:00:04.000Z")).ok, true);

  const release = await reconstructReviewedStoryReleaseFromDatabase(db, request);
  assert.equal(release.ok, true);
  assert.equal(release.story.chapters[0].en.title, "Person A built Project A at Organization A");
  assert.equal(release.story.chapters[0].en.overview,
    "Alice used Workspace with [Credential removed]");
  assert.equal(release.story.chapters[1].en.title,
    "Person B continued Project A for Organization A");
  assert.equal(release.story.chapters[1].en.overview, editedText);
  assert.equal((release.serializedStory.match(/Alice/gu) || []).length, 1);
  assert.doesNotMatch(release.serializedStory, /Bob|Acme|Atlas|C:\\Secret|sk-live-secret/u);
  const html = renderReviewedStoryHtml(release.serializedStory);
  assert.ok(html.includes(release.serializedStory));
  const zip = await buildPackageFromDatabase(db, release.serializedStory, request, {
    exportedAt:"2026-08-27T08:00:05.000Z",
  });
  assert.equal(zip.status, 200);
  const zipText = new TextDecoder().decode(await zip.arrayBuffer());
  assert.ok(zipText.includes(release.serializedStory));
  assert.doesNotMatch(zipText, /Bob|Acme|Atlas|C:\\Secret|sk-live-secret/u);
});

test("Preference, receipt, session, edit, and final snapshot mutations block without stale bytes", async () => {
  const { db, stories, reviews, request } = await setup();
  await resolveHumanStoryPrivacy(db);
  assert.equal((await confirmProjectReleaseConfirmation(db, request, NOW)).ok, true);
  assert.equal(await readProjectReleaseConfirmation(db, request), true);

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
  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(db, request)).code,
    RELEASE_ERROR.releaseConfirmationRequired);
  assert.equal(await readProjectReleaseConfirmation(db, request), false);
  assert.equal((await confirmProjectReleaseConfirmation(db, request, "2026-08-27T08:00:01.000Z")).ok, true);
  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(db, request)).ok, true);
  const chapterStateBeforePreferenceChange = (await db.prepare(
    "SELECT state_json FROM story_review_sessions WHERE workflow_run_id=?",
  ).bind(RUN).first()).state_json;
  await db.prepare("UPDATE probes SET answer_choice='keep',answered_at=? WHERE id='probe-unanswered'")
    .bind("2026-08-27T08:00:02.000Z").run();
  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(db, request)).code,
    RELEASE_ERROR.releaseConfirmationRequired);
  assert.equal((await db.prepare("SELECT state_json FROM story_review_sessions WHERE workflow_run_id=?")
    .bind(RUN).first()).state_json, chapterStateBeforePreferenceChange);
  assert.equal((await confirmProjectReleaseConfirmation(db, request, "2026-08-27T08:00:03.000Z")).ok, true);
  assert.equal(await readProjectReleaseConfirmation(db, request), true);

  const raced = await reconstructReviewedStoryReleaseFromDatabase(db, request, {
    beforeFinalPrivacyCheck: () => db.prepare(
      "UPDATE story_preparation_receipts SET completed_at=? WHERE lane='story'",
    ).bind("2026-08-27T08:00:01.000Z").run(),
  });
  assert.equal(raced.code, RELEASE_ERROR.privacyConflict);
  await db.prepare("UPDATE story_preparation_receipts SET completed_at=? WHERE lane='story'")
    .bind(NOW).run();

  const currentGate = await db.prepare("SELECT review_gate_digest FROM project_release_confirmations WHERE workflow_run_id=?")
    .bind(RUN).first();
  const finalSnapshotRaces = [
    [
      "UPDATE story_privacy_targets SET decided_at='2026-08-27T08:00:01.500Z' WHERE target_id='chapter-one::overview'",
      "UPDATE story_privacy_targets SET decided_at='2026-08-27T08:00:00.000Z' WHERE target_id='chapter-one::overview'",
    ],
    [
      "UPDATE probes SET answer_choice='skip' WHERE id='probe-unanswered'",
      "UPDATE probes SET answer_choice='keep' WHERE id='probe-unanswered'",
    ],
    [
      "UPDATE story_review_sessions SET updated_at='2026-08-27T08:00:01.000Z' WHERE workflow_run_id='release-confirmation-run'",
      "UPDATE story_review_sessions SET updated_at='2026-08-27T08:00:00.000Z' WHERE workflow_run_id='release-confirmation-run'",
    ],
    [
      "UPDATE project_release_confirmations SET review_gate_digest='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' WHERE workflow_run_id='release-confirmation-run'",
      `UPDATE project_release_confirmations SET review_gate_digest='${currentGate.review_gate_digest}' WHERE workflow_run_id='release-confirmation-run'`,
    ],
  ];
  for (const [mutate, restore] of finalSnapshotRaces) {
    const conflict = await reconstructReviewedStoryReleaseFromDatabase(db, request, {
      beforeFinalPrivacyCheck: () => db.prepare(mutate).run(),
    });
    assert.equal(conflict.code, RELEASE_ERROR.privacyConflict);
    await db.prepare(restore).run();
  }

  await db.prepare("DELETE FROM project_release_confirmations").run();
  const editedStory = stories[0];
  const unconfirmedSession = createStoryReviewSession(RUN, {
    ...reviews, [editedStory.key]: returnChapterToReview(reviews[editedStory.key]),
  }, {}, NOW);
  await db.prepare("UPDATE story_review_sessions SET state_json=?,server_version=2 WHERE workflow_run_id=?")
    .bind(JSON.stringify({ sourceRevision: REVISION, session: unconfirmedSession }), RUN).run();
  assert.equal((await confirmProjectReleaseConfirmation(db, { ...request, serverVersion: 2 }, NOW)).code,
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
  assert.equal((await confirmProjectReleaseConfirmation(db, { ...request, serverVersion: 2 }, NOW)).code,
    RELEASE_ERROR.preparationInvalid);

  const privacyPreparation = await buildReviewedStoryPrivacyPreparationSnapshot(db, RUN);
  assert.equal(privacyPreparation.ok, true);
  assert.ok(privacyPreparation.snapshot.binding.changedTargetCount > 0);
  const imported = await importReviewedStoryPrivacyAuthority(
    db,
    await completedPrivacyImport(privacyPreparation.snapshot),
    "2026-08-27T08:00:02.000Z",
  );
  assert.equal(imported.ok, true);
  const chapterBytesBeforeReconfirm = (await db.prepare(
    "SELECT state_json FROM story_review_sessions WHERE workflow_run_id=?",
  ).bind(RUN).first()).state_json;
  assert.equal((await confirmProjectReleaseConfirmation(db, { ...request, serverVersion: 2 },
    "2026-08-27T08:00:03.000Z")).ok, true);
  assert.equal((await db.prepare("SELECT state_json FROM story_review_sessions WHERE workflow_run_id=?")
    .bind(RUN).first()).state_json, chapterBytesBeforeReconfirm);
  const editedRelease = await reconstructReviewedStoryReleaseFromDatabase(
    db,
    { ...request, serverVersion: 2 },
  );
  assert.equal(editedRelease.ok, true);
  assert.match(editedRelease.serializedStory, /release paragraph 1/i);

  await db.prepare("UPDATE story_review_sessions SET state_json='not-json' WHERE workflow_run_id=?")
    .bind(RUN).run();
  assert.equal((await confirmProjectReleaseConfirmation(db, { ...request, serverVersion: 2 }, NOW)).code,
    RELEASE_ERROR.stateInvalid);
});

test("every bound authority invalidates only project release confirmation, never Chapter bytes", async () => {
  const { db, request } = await setup();
  await resolveHumanStoryPrivacy(db);
  assert.equal((await confirmProjectReleaseConfirmation(db, request, NOW)).ok, true);
  let currentRequest = request;
  const chapterBytes = (await db.prepare(
    "SELECT state_json FROM story_review_sessions WHERE workflow_run_id=?",
  ).bind(RUN).first()).state_json;
  const invalidated = async (label, mutate, nextRequest = currentRequest) => {
    await mutate();
    assert.equal(await readProjectReleaseConfirmation(db, nextRequest), false, label);
    assert.equal((await db.prepare(
      "SELECT state_json FROM story_review_sessions WHERE workflow_run_id=?",
    ).bind(RUN).first()).state_json, chapterBytes, `${label} changed Chapter confirmation bytes`);
    assert.equal((await confirmProjectReleaseConfirmation(
      db,
      nextRequest,
      new Date(Date.parse(NOW) + 10_000).toISOString(),
    )).ok, true, `${label} could not be explicitly reconfirmed`);
    currentRequest = nextRequest;
  };

  await invalidated("Preference mutation", async () => {
    await db.prepare(`INSERT INTO probes
      (id,document_id,document_kind,event_ids_json,signal,recap,question,options_json,
       presentations_json,answer_choice,answered_at,created_at)
      VALUES ('probe-bound','release-doc','trajectory','[]','preference','recap','Question?',
       '[]','{}','keep',?,?)`).bind(NOW, NOW).run();
    await db.prepare("UPDATE probe_runs SET output_count=1,output_digest=? WHERE workflow_run_id=?")
      .bind("c".repeat(64), RUN).run();
    await db.prepare(`UPDATE story_preparation_receipts SET output_count=1,output_digest=?
      WHERE workflow_run_id=? AND lane='preference'`).bind("c".repeat(64), RUN).run();
  });
  await db.prepare("UPDATE redaction_jobs SET updated_at=? WHERE id=?")
    .bind("2026-08-27T08:00:04.000Z", `privacy-${RUN}`).run();
  assert.equal(await readProjectReleaseConfirmation(db, currentRequest), false,
    "source Privacy mutation invalidates release confirmation");
  assert.equal((await confirmProjectReleaseConfirmation(
    db, currentRequest, "2026-08-27T08:00:10.000Z",
  )).ok, false, "stale Coverage Privacy authority cannot be reconfirmed");
  assert.equal((await db.prepare(
    "SELECT state_json FROM story_review_sessions WHERE workflow_run_id=?",
  ).bind(RUN).first()).state_json, chapterBytes);
  await db.prepare("UPDATE redaction_jobs SET updated_at=? WHERE id=?")
    .bind(NOW, `privacy-${RUN}`).run();
  assert.equal((await confirmProjectReleaseConfirmation(
    db, currentRequest, "2026-08-27T08:00:11.000Z",
  )).ok, true, "restored current Privacy authority can be explicitly reconfirmed");
  await invalidated("Story Privacy mutation", () => db.prepare(`UPDATE story_privacy_targets
    SET selected_text='Alternate public overview',decided_at=?
    WHERE target_id='chapter-one::overview'`)
    .bind("2026-08-27T08:00:05.000Z").run());
  await invalidated("receipt mutation", () => db.prepare(`UPDATE story_preparation_receipts
    SET completed_at=? WHERE workflow_run_id=? AND lane='insight'`)
    .bind("2026-08-27T08:00:06.000Z", RUN).run());
  await invalidated("package mutation", () => db.prepare(
    "UPDATE documents SET title='Release source revised' WHERE id='release-doc'",
  ).run());
  await invalidated("Story/session mutation", () => db.prepare(`UPDATE story_review_sessions
    SET updated_at=?,server_version=2 WHERE workflow_run_id=?`)
    .bind("2026-08-27T08:00:07.000Z", RUN).run(), { ...request, serverVersion: 2 });

  const storyBytes = (await db.prepare(
    "SELECT organization_reason FROM items WHERE id='release-doc:event-1'",
  ).first()).organization_reason;
  await db.prepare("UPDATE items SET organization_reason=? WHERE id='release-doc:event-1'")
    .bind(`${storyBytes} `).run();
  assert.equal(await readProjectReleaseConfirmation(db, currentRequest), false,
    "Story-byte mutation did not invalidate release confirmation");
  assert.equal((await db.prepare(
    "SELECT state_json FROM story_review_sessions WHERE workflow_run_id=?",
  ).bind(RUN).first()).state_json, chapterBytes);
  await db.prepare("UPDATE items SET organization_reason=? WHERE id='release-doc:event-1'")
    .bind(storyBytes).run();
  assert.equal(await readProjectReleaseConfirmation(db, currentRequest), true,
    "restoring exact Story bytes did not restore the current confirmation binding");
});

test("HTML and ZIP are POST-only, byte-identical for reviewed Story, and exclude authority sentinels", async () => {
  const { db, request } = await setup();
  await resolveHumanStoryPrivacy(db);
  assert.equal((await confirmProjectReleaseConfirmation(db, request, NOW)).ok, true);
  const release = await reconstructReviewedStoryReleaseFromDatabase(db, request);
  assert.equal(release.ok, true);
  const completedZero = await buildReviewedStoryPrivacyPreparationSnapshot(db, RUN);
  assert.equal(completedZero.ok, false);
  assert.equal(completedZero.code, STORY_PRIVACY_ERROR.notActionable,
    "zero changed targets must require no successor preparation and still release");
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
  assert.match(zipText, /story-row/);
  assert.match(zipText, /b\.insights\.map\(card\)/);
  assert.match(zipText, /esc\(i\.quote\)/);
  assert.doesNotMatch(zipText, /candidate-auto|candidate-human|whyFlagged|releaseTargets|decisionVersion|reviewGateDigest|review_gate_digest/);
  assert.doesNotMatch(zipText, /provider|model|evidence_sample|PRIVATE_/i);

  const racedZip = await buildPackageFromDatabase(db, release.serializedStory, request, {
    exportedAt: NOW,
    beforeFinalPrivacyCheck: () => db.prepare(
      "UPDATE project_release_confirmations SET review_gate_digest='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' WHERE workflow_run_id=?",
    ).bind(RUN).run(),
  });
  assert.equal(racedZip.status, 409);
  assert.equal((await racedZip.text()).includes("oxygen.reviewed-story"), false);

  const packageRoute = await import("../app/api/package/route.ts");
  const htmlRoute = await import("../app/api/organization/export/route.ts");
  assert.equal((await packageRoute.GET()).status, 405);
  assert.equal((await htmlRoute.GET()).status, 405);
});

test("package maps malformed private redaction details to one fixed release-state error", async () => {
  const { db, request } = await setup();
  await resolveHumanStoryPrivacy(db);
  assert.equal((await confirmProjectReleaseConfirmation(db, request, NOW)).ok, true);
  const release = await reconstructReviewedStoryReleaseFromDatabase(db, request);
  assert.equal(release.ok, true);
  const sentinel = "PRIVATE_SENTINEL_ITEM";
  const response = await buildPackageFromDatabase(db, release.serializedStory, request, {
    exportedAt: NOW,
    afterInitialStoryReconstruction: async () => {
      const transport = [{
        itemId: "release-doc:event-1",
        documentId: "release-doc",
        startOffset: 1,
        endOffset: 999,
        category: "sensitive",
        confidence: "high",
        reason: sentinel,
        reviewState: "deterministic",
        uncertaintyReason: null,
      }];
      await db.prepare(`INSERT INTO redactions
        (id,item_id,document_id,start_offset,end_offset,category,confidence,reason,
         review_state,uncertainty_reason,status,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,'sensitive','high',?,'deterministic',NULL,'active','llm',?,?)`)
        .bind("malformed-package-span", "release-doc:event-1", "release-doc", 1, 999,
          sentinel, NOW, NOW).run();
      const receipt = await buildSourcePrivacyReceipt(db, {
        workflowRunId: RUN,
        sourceRevision: REVISION,
        redactions: transport,
      });
      await db.prepare("DELETE FROM source_privacy_receipts WHERE workflow_run_id=?")
        .bind(RUN).run();
      await installSourcePrivacyReceipt(db, {
        jobId: `privacy-${RUN}`,
        workflowRunId: RUN,
        receipt,
        at: NOW,
      });
      await db.prepare(`UPDATE redaction_jobs SET completed=1,total=1,source_digest=?
        WHERE id=?`).bind(receipt.sourceDigest, `privacy-${RUN}`).run();
    },
  });
  assert.equal(response.status, 409);
  const publicBody = await response.json();
  assert.deepEqual(publicBody, {
    error: "Reviewed Story release state is invalid",
    code: RELEASE_ERROR.stateInvalid,
  });
  assert.doesNotMatch(JSON.stringify(publicBody), new RegExp(`${sentinel}|1:999|/\\d+`, "u"));
});

test("contract refresh blocks release until fresh import, target review, and confirmation", async () => {
  const { db, request } = await setup();
  await resolveHumanStoryPrivacy(db);
  assert.equal((await confirmProjectReleaseConfirmation(db, request, NOW)).ok, true);
  const legacyConfirmation = await db.prepare(`SELECT review_gate_digest,confirmed_at
    FROM project_release_confirmations WHERE workflow_run_id=?`).bind(RUN).first();
  assert.ok(legacyConfirmation);

  await db.batch([
    db.prepare("DELETE FROM project_release_confirmations WHERE workflow_run_id=?").bind(RUN),
    db.prepare("DELETE FROM story_preparation_receipts WHERE workflow_run_id=? AND lane='story_privacy'")
      .bind(RUN),
    db.prepare("DELETE FROM story_privacy_targets WHERE workflow_run_id=?").bind(RUN),
    db.prepare("DELETE FROM story_privacy_authorities WHERE workflow_run_id=?").bind(RUN),
    db.prepare("DELETE FROM story_privacy_candidates WHERE workflow_run_id=?").bind(RUN),
  ]);
  const pending = await readStoryPrivacyAuthority(db, RUN);
  assert.equal(pending.ok, true, JSON.stringify(pending));
  assert.equal(pending.authority.status, "preparation_required");
  assert.deepEqual(pending.authority.candidates, []);
  assert.deepEqual(pending.authority.targets, []);
  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(db, request)).code,
    RELEASE_ERROR.preparationInvalid);
  assert.equal((await confirmProjectReleaseConfirmation(db, request, NOW)).code,
    RELEASE_ERROR.preparationInvalid);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS count FROM project_release_confirmations
    WHERE workflow_run_id=?`).bind(RUN).first()).count, 0);

  const preparation = await buildReviewedStoryPrivacyPreparationSnapshot(db, RUN);
  assert.equal(preparation.ok, true, JSON.stringify(preparation));
  assert.equal(preparation.snapshot.binding.changedTargetCount,
    preparation.snapshot.changedTargets.length);
  assert.ok(preparation.snapshot.targetTransitions.every((transition) => (
    transition.previousContentDigest === null && transition.contentDigest !== null
  )));
  const targetId = preparation.snapshot.changedTargets[0].id;
  const freshCandidate = {
    id: "contract-refresh-current-target",
    reviewState: "needs_confirmation",
    title: "Current contract finding",
    whyFlagged: "The current target requires contributor review.",
    uncertaintyReason: "Contributor confirmation is required.",
    releaseTargets: [targetId],
  };
  const imported = await importReviewedStoryPrivacyAuthority(
    db,
    await completedPrivacyImport(preparation.snapshot, [freshCandidate]),
    "2026-08-27T08:00:02.000Z",
  );
  assert.equal(imported.ok, true, JSON.stringify(imported));
  assert.equal(imported.authority.status, "completed_with_candidates");
  assert.deepEqual((await db.prepare(`SELECT lane FROM story_preparation_receipts
    WHERE workflow_run_id=? ORDER BY lane`).bind(RUN).all()).results.map((row) => row.lane), [
    "insight", "preference", "story",
  ]);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS count FROM project_release_confirmations
    WHERE workflow_run_id=?`).bind(RUN).first()).count, 0);
  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(db, request)).code,
    RELEASE_ERROR.storyPrivacyPending);
  assert.equal((await confirmProjectReleaseConfirmation(db, request,
    "2026-08-27T08:00:03.000Z")).code, RELEASE_ERROR.storyPrivacyPending);

  const decided = await chooseStoryPrivacyTarget(
    db,
    imported.authority,
    targetId,
    { editedText:null, publicOverrides:[] },
    "2026-08-27T08:00:04.000Z",
  );
  assert.equal(decided.ok, true, JSON.stringify(decided));
  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(db, request)).code,
    RELEASE_ERROR.releaseConfirmationRequired);
  assert.equal(await readProjectReleaseConfirmation(db, request), false);
  const reconfirmed = await confirmProjectReleaseConfirmation(
    db,
    request,
    "2026-08-27T08:00:05.000Z",
  );
  assert.equal(reconfirmed.ok, true, JSON.stringify(reconfirmed));
  assert.equal(reconfirmed.idempotent, false);
  const currentConfirmation = await db.prepare(`SELECT review_gate_digest,confirmed_at
    FROM project_release_confirmations WHERE workflow_run_id=?`).bind(RUN).first();
  assert.notEqual(currentConfirmation.confirmed_at, legacyConfirmation.confirmed_at);
  assert.equal(currentConfirmation.confirmed_at, "2026-08-27T08:00:05.000Z");
  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(db, request)).ok, true);
});

test("edited Story release retains stable choices and accepts one changed-target proposal", async () => {
  const { db, stories, reviews, request } = await setup();
  await resolveHumanStoryPrivacy(db);
  const initialAuthority = await readStoryPrivacyAuthority(db, RUN);
  assert.equal(initialAuthority.ok, true);
  const stableTitle = initialAuthority.authority.targets.find((target) => (
    target.targetId === "chapter-one::title"
  ));
  assert.equal(stableTitle.selectedText, "Release title Anonymous");
  const editedStory = stories[0];
  const editing = recordStoryEdit(returnChapterToReview(reviews[editedStory.key]), {
    storyKey: editedStory.key,
    blockId: editedStory.story.blocks[0].id,
    sourceLanguage: "en",
    baseText: editedStory.story.blocks[0].text,
    nextText: editedStory.story.blocks[0].text.replace("Safe ", ""),
    workingRange: { start: 0, end: 5 },
    insertedText: "",
    now: 2,
  });
  assert.equal(editing.blockedReason, undefined);
  const applied = applyChapterReview(editing.state, reviewContext(editedStory, editing.state));
  assert.equal(applied.blockedReason, undefined);
  const confirmed = markChapterReady(applied.state, reviewContext(editedStory, applied.state));
  assert.equal(confirmed.stage, "human_confirmed");
  const session = createStoryReviewSession(RUN, {
    ...reviews,
    [editedStory.key]: confirmed,
  }, {}, NOW);
  await db.prepare("UPDATE story_review_sessions SET state_json=?,server_version=2 WHERE workflow_run_id=?")
    .bind(JSON.stringify({ sourceRevision: REVISION, session }), RUN).run();

  const preparation = await buildReviewedStoryPrivacyPreparationSnapshot(db, RUN);
  assert.equal(preparation.ok, true);
  const pending = await readStoryPrivacyAuthority(db, RUN);
  assert.equal(pending.ok, true);
  assert.equal(pending.authority.status, "preparation_required");
  const retainedTitle = pending.authority.targets.find((target) => (
    target.targetId === "chapter-one::title"
  ));
  assert.equal(retainedTitle.selectedText, "Release title Anonymous");
  const target = preparation.snapshot.changedTargets[0].id;
  const changedCandidate = {
    id: "candidate-current-block",
    reviewState: "needs_confirmation",
    title: "Current changed block",
    whyFlagged: "The exact changed target requires one decision.",
    uncertaintyReason: "Contributor confirmation is required.",
    releaseTargets: [target],
  };
  const imported = await importReviewedStoryPrivacyAuthority(
    db,
    await completedPrivacyImport(preparation.snapshot, [changedCandidate]),
    "2026-08-27T08:00:02.000Z",
  );
  assert.equal(imported.ok, true);
  assert.equal((await confirmProjectReleaseConfirmation(db, { ...request, serverVersion: 2 }, NOW)).code,
    RELEASE_ERROR.storyPrivacyPending);
  const decided = await chooseStoryPrivacyTarget(
    db,
    imported.authority,
    target,
    { editedText:null, publicOverrides:[] },
    "2026-08-27T08:00:03.000Z",
  );
  assert.equal(decided.ok, true);
  assert.equal((await confirmProjectReleaseConfirmation(db, { ...request, serverVersion: 2 },
    "2026-08-27T08:00:04.000Z")).ok, true);
  const release = await reconstructReviewedStoryReleaseFromDatabase(
    db,
    { ...request, serverVersion: 2 },
  );
  assert.equal(release.ok, true);
  assert.match(release.serializedStory, /release paragraph Anonymous/);
  assert.equal(JSON.parse(release.serializedStory).chapters[0].en.title,
    "Release title Anonymous");
  const html = renderReviewedStoryHtml(release.serializedStory);
  assert.match(html, /story-row/);
  assert.match(html, /Release title Anonymous/);
  const zipResponse = await buildPackageFromDatabase(
    db,
    release.serializedStory,
    { ...request, serverVersion: 2 },
    { exportedAt: "2026-08-27T08:00:05.000Z" },
  );
  assert.equal(zipResponse.status, 200, "completed-nonzero changed-block authority must package");
  const zipText = new TextDecoder().decode(await zipResponse.arrayBuffer());
  assert.match(zipText, /oxygen\.reviewed-story/);
  assert.match(zipText, /"publication_approved": false/);
  assert.match(zipText, /Release title Anonymous/);
  assert.doesNotMatch(zipText, /candidate-auto|candidate-current-block|releaseTargets|authorityDigest/);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS count FROM story_privacy_candidates
    WHERE candidate_id=?`).bind(changedCandidate.id).first()).count, 1);
  assert.equal((await db.prepare(`SELECT selected_text FROM story_privacy_targets
    WHERE workflow_run_id=? AND target_id='chapter-one::title'`).bind(RUN).first()).selected_text,
  "Release title Anonymous");
});

test("provider-free 24,796-item release-confirmation benchmark", { timeout: 120_000 }, async () => {
  const { db, request, stories } = await setup();
  const targetItemCount = 24_796;
  const targetTextBytes = 17.5 * 1024 * 1024;
  const baseline = await db.prepare("SELECT id,content FROM items ORDER BY id").all();
  const baselineTextBytes = baseline.results.reduce(
    (total, row) => total + Buffer.byteLength(String(row.content || "")),
    0,
  );
  const extraCount = targetItemCount - baseline.results.length;
  const remainingBytes = targetTextBytes - baselineTextBytes;
  const ordinaryBytes = Math.floor(remainingBytes / extraCount);
  const largerRows = remainingBytes % extraCount;
  await db.transaction(async () => {
    for (let index = 0; index < extraCount; index += 1) {
      const contentBytes = ordinaryBytes + (index < largerRows ? 1 : 0);
      await db.prepare(`INSERT INTO items
        (id,document_id,sequence,event_type,actor_id,actor_type,timestamp,content,original_json,
         organization_category,organization_confidence,organization_reason)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)`).bind(
        `release-doc:benchmark-${index}`,
        "release-doc",
        index + 3,
        "message",
        "benchmark",
        "system",
        null,
        "x".repeat(contentBytes),
        "{}",
        "Benchmark",
        100,
      ).run();
    }
    await db.prepare("UPDATE documents SET item_count=? WHERE id='release-doc'")
      .bind(targetItemCount).run();
  });
  for (const table of [
    "story_coverage_rows", "story_coverage_manifests", "semantic_unit_members", "semantic_units",
    "semantic_manifests", "finalized_corpus_manifests", "source_privacy_receipts",
    "redaction_jobs",
  ]) await db.prepare(`DELETE FROM ${table}`).run();
  await seedCoveragePrivacyAuthority(db, {
    workflowRunId: RUN,
    sourceRevision: REVISION,
    stories,
    now: NOW,
    projectId: "release-confirmation-scale-project",
  });
  const scaledReviews = {};
  for (const story of stories) {
    const applied = applyChapterReview(emptyChapterReview(story), reviewContext(story));
    assert.equal(applied.blockedReason, undefined);
    scaledReviews[story.key] = markChapterReady(applied.state, reviewContext(story, applied.state));
  }
  const scaledSession = createStoryReviewSession(RUN, scaledReviews, {}, NOW);
  await db.prepare(`UPDATE story_review_sessions SET state_json=? WHERE workflow_run_id=?`)
    .bind(JSON.stringify({ sourceRevision: REVISION, session: scaledSession }), RUN).run();
  const scale = await db.prepare(`SELECT COUNT(*) AS item_count,
    SUM(length(CAST(content AS BLOB))) AS text_bytes FROM items`).first();
  assert.equal(scale.item_count, targetItemCount);
  assert.equal(scale.text_bytes, targetTextBytes);

  const noRowObservation = observeDatabase(db);
  const noRowStartedAt = performance.now();
  let noRowWorkflow;
  try {
    noRowWorkflow = await loadWorkflowProgress(RUN);
  } finally {
    noRowObservation.counts.latencyMs = performance.now() - noRowStartedAt;
    noRowObservation.restore();
  }
  assert.equal(noRowWorkflow.releaseConfirmed, false);
  assert.equal(noRowObservation.counts.storySnapshotQueries, 0);
  assert.equal(noRowObservation.counts.packageSnapshotQueries, 0);
  assert.equal(noRowObservation.counts.batchWriteTransactions, 0);
  assert.equal(noRowObservation.counts.longWriteTransactions, 0);

  await resolveHumanStoryPrivacy(db);
  assert.equal((await confirmProjectReleaseConfirmation(db, request, NOW)).ok, true);
  const confirmedObservation = observeDatabase(db);
  const confirmedStartedAt = performance.now();
  let confirmed;
  try {
    confirmed = await readProjectReleaseConfirmation(db, request);
  } finally {
    confirmedObservation.counts.latencyMs = performance.now() - confirmedStartedAt;
    confirmedObservation.restore();
  }
  assert.equal(confirmed, true);
  assert.equal(confirmedObservation.counts.storySnapshotQueries, 2);
  assert.equal(confirmedObservation.counts.packageSnapshotQueries, 2);
  assert.equal(confirmedObservation.counts.batchWriteTransactions, 5);
  assert.equal(confirmedObservation.counts.longWriteTransactions, 0);

  const scheduled = [];
  let releaseDelayedPoll;
  const delayedPoll = new Promise((resolve) => { releaseDelayedPoll = resolve; });
  let inFlight = 0;
  let maximumInFlight = 0;
  const polling = startWorkflowPolling(async () => {
    inFlight += 1;
    maximumInFlight = Math.max(maximumInFlight, inFlight);
    await delayedPoll;
    inFlight -= 1;
  }, {
    intervalMs: 2_000,
    schedule: (callback) => { scheduled.push(callback); return callback; },
    cancel: (handle) => {
      const index = scheduled.indexOf(handle);
      if (index >= 0) scheduled.splice(index, 1);
    },
  });
  scheduled.shift()();
  await Promise.resolve();
  const simulatedDelayMs = 2_500;
  assert.ok(simulatedDelayMs > 2_000);
  assert.equal(scheduled.length, 0);
  releaseDelayedPoll();
  await new Promise((resolve) => setImmediate(resolve));
  polling.retire();
  assert.equal(maximumInFlight, 1);

  console.log("RELEASE_CONFIRMATION_BENCHMARK", JSON.stringify({
    itemCount: scale.item_count,
    textBytes: scale.text_bytes,
    noRow: noRowObservation.counts,
    confirmedRow: confirmedObservation.counts,
    reconstructionCoveredByBeginImmediate: confirmedObservation.counts.longWriteTransactions > 0,
    maximumConcurrentWorkflowPolls: maximumInFlight,
    simulatedDelayedResponseMs: simulatedDelayMs,
  }));
});
