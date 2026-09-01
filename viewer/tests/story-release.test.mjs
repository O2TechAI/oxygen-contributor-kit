import test from "node:test";
import assert from "node:assert/strict";
import { testStoryCoverage } from "./fixtures/story-coverage.mjs";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";
import {
  applyChapterReview,
  editAiInsight,
  emptyChapterReview,
  markChapterReady,
  recordStoryEdit,
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
  parseServerOwnedReleaseRequest,
  reconstructReviewedStoryRelease,
  reconstructReviewedStoryReleaseFromDatabase,
} from "../lib/story-release-server.ts";
import { readActiveStoryReviewContract } from "../lib/story-review-session-server.ts";
import { computeSourceDigest } from "../lib/redaction-pass.mjs";
import { captureStoryReleasePrivacySnapshot } from "../lib/release-privacy-snapshot.ts";
import {
  createPreferenceLifecycleState,
  parsePreferenceLifecycleState,
  preferenceInsightScope,
  projectPreferenceLifecycle,
} from "../lib/story-release-server.ts";
import { readCoveragePrivacyAuthority } from "../lib/story-coverage-privacy-authority.ts";
import {
  buildCurrentSourcePrivacyDialogue,
  canonicalSourcePrivacyJson,
  canonicalSourcePrivacyRedactions,
  sourcePrivacyDigest,
} from "../lib/source-privacy-receipt.ts";
import {
  canonicalAuthorityJson,
  contributionRecordSourceDigest,
  finalizeCoverageManifestAuthority,
  validateSemanticManifestAuthority,
  validateCurrentStorySourcePackage,
  validateStorySourcePackage,
} from "../lib/story-readiness.ts";
import { STORY_PREFIX } from "../lib/timeline.ts";
import {
  deriveStoryReleaseTargetContents,
  deriveStoryReleaseTargetCatalog,
  insightAuthorityValue,
  storyPreparationDigest,
} from "../lib/story-preparation.ts";

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
    anchorStoryBlockId: blockId,
    quote: { text: "supporting evidence", evidence },
    directlyAcquiredExperience: `Experience ${id}`,
    principle: `Principle ${id}`,
    evidence: [evidence],
    ...overrides,
  };
}

function source(insights = [], overrides = {}, privateValue = PRIVATE) {
  return {
    schema: "oxygen.story",
    language: "en",
    languagePolicyDigest: "f".repeat(64),
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

const releaseInsights = (release) => release.chapters
  .flatMap((chapter) => chapter.en.story.blocks.flatMap((block) => block.insights));

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
  assert.equal(release.chapters[0].phase, "Discovery");
  assert.deepEqual(release.chapters[0].en.people, [{
    releaseLabel: "Contributor",
    role: "Owner",
    description: "Defined and checked the release boundary.",
  }]);
  assert.deepEqual(releaseInsights(release), []);
  assert.deepEqual(release.chapters[0].en.story.blocks.map((block) => block.text),
    currentSource.story.blocks.map((block) => block.text));
  assert.doesNotMatch(JSON.stringify(release), /localIdentityState|documentId|eventId/);
});

test("Chinese canonical Story blocks and edits survive the single review and release authority", () => {
  const currentSource = source([], {
    language: "zh",
    title: "经过审阅的中文章节",
    overview: "这是一段完整的中文章节概述。",
    people: [{
      id: "person-owner", releaseLabel: "贡献者", role: "负责人",
      description: "负责人定义并检查了发布边界。", localIdentityState: "not_identified",
      evidence: [evidence],
    }],
    story: { blocks: [
      { id: "story-block-private", text: "敏感内容已经移除。", evidence: [evidence] },
      { id: "story-block-safe", text: "经过审阅的故事说明了安全边界。", evidence: [evidence] },
    ], uncertainty: "剩余的不确定性已经明确记录。" },
  });
  assert.deepEqual(Object.keys(storyBlocks(currentSource).en), []);
  assert.deepEqual(Object.keys(storyBlocks(currentSource).zh), ["story-block-private", "story-block-safe"]);
  let state = recordStoryEdit(emptyChapterReview(currentSource), {
    storyKey: currentSource.key,
    blockId: "story-block-safe",
    sourceLanguage: "zh",
    baseText: "经过审阅的故事说明了安全边界。",
    nextText: "经过审阅的故事明确说明了安全边界。",
    now: 100,
  }).state;
  state = applyChapterReview(state, context(currentSource)).state;
  state = markChapterReady(state, context(currentSource));
  const release = buildReviewedStoryRelease([currentSource], { [currentSource.key]: state });
  assert.equal(release.chapters[0].phase, "Discovery");
  assert.deepEqual(release.chapters[0].en.story.blocks.map((block) => block.text), [
    "敏感内容已经移除。", "经过审阅的故事明确说明了安全边界。",
  ]);
});

test("multiple accepted AI Insights, rejection, optional title, and four-part Quote projection are canonical", () => {
  const currentSource = source([
    insight("insight-z", "story-block-safe", { title: undefined }),
    insight("insight-a"),
    insight("insight-rejected"),
  ]);
  const state = reviewedState(currentSource, { "insight-rejected": "rejected" });
  const release = buildReviewedStoryRelease([currentSource], { [currentSource.key]: state });
  const projected = releaseInsights(release);
  assert.deepEqual(projected.map((item) => item.background), ["Background insight-z", "Background insight-a"]);
  assert.equal(projected[0].quote, "supporting evidence");
  assert.deepEqual(Object.keys(projected[0]).sort(), [
    "background", "directlyAcquiredExperience", "principle", "quote",
  ]);
  assert.equal("title" in projected[0], false);
  assert.equal(projected[1].title, "Title insight-a");
  assert.doesNotMatch(JSON.stringify(projected), /"(?:anchorStoryBlockId|documentId|eventId|evidence|origin|appliedVersion|revisionHistory)"/);
});

test("AI source Quote uses its own exact release Privacy target", () => {
  const currentSource = source([insight("insight-quote-target")]);
  const quoteTarget = `${currentSource.key}::insight:insight-quote-target:quote`;
  assert.ok(deriveStoryReleaseTargetCatalog([currentSource]).some((target) => (
    target.id === quoteTarget && target.target === "insight:insight-quote-target:quote"
  )));

  const release = buildReviewedStoryRelease(
    [currentSource],
    { [currentSource.key]: reviewedState(currentSource) },
    { project: (target, copy) => target === quoteTarget ? "Anonymous quotation" : copy },
  );
  assert.equal(releaseInsights(release)[0].quote, "Anonymous quotation");
  assert.deepEqual(release.chapters[0].en.story.blocks.map((block) => block.text),
    currentSource.story.blocks.map((block) => block.text));
});

test("human-approved Insight releases with stable identity and no review provenance", () => {
  const currentSource = source([]);
  const human = humanContent(currentSource);
  const state = reviewedState(currentSource, {}, [["human:release-boundary", human]]);
  const quoteTarget = `${currentSource.key}::insight:human:release-boundary:quote`;
  const release = buildReviewedStoryRelease(
    [currentSource],
    { [currentSource.key]: state },
    { project: (target, copy) => target === quoteTarget ? "Anonymous human quotation" : copy },
  );
  assert.deepEqual(releaseInsights(release), [{
    background: human.background,
    quote: "Anonymous human quotation",
    directlyAcquiredExperience: human.directlyAcquiredExperience,
    principle: human.principle,
  }]);
  assert.doesNotMatch(JSON.stringify(release), /human_created|chapterKey|storyBlockId|selection|baseRevision|appliedRevision/);
});

test("human Insight release ordering is UTF-8 byte stable across insertion order", () => {
  const currentSource = source([]);
  const accented = humanContent(currentSource, { background: "accented-first" });
  const cjk = humanContent(currentSource, { background: "cjk-second" });
  const left = reviewedState(currentSource, {}, [["human:中", cjk], ["human:é", accented]]);
  const right = reviewedState(currentSource, {}, [["human:é", accented], ["human:中", cjk]]);
  const leftBytes = serializeReviewedStoryRelease(buildReviewedStoryRelease(
    [currentSource], { [currentSource.key]: left },
  ));
  const rightBytes = serializeReviewedStoryRelease(buildReviewedStoryRelease(
    [currentSource], { [currentSource.key]: right },
  ));
  assert.equal(leftBytes, rightBytes);
  assert.deepEqual(releaseInsights(JSON.parse(leftBytes)).map((item) => item.background), [
    "accented-first", "cjk-second",
  ]);
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

test("Preference lifecycle projects accepted, rejected, and accepted-edited Insights exactly", async () => {
  const currentSource = source([insight("insight-preference")]);
  const scope = await preferenceInsightScope([currentSource]);
  const probe = { id: "preference-question", ...scope[0], question: "Keep this rule?",
    options: [{ id: "yes", text: "Yes" }, { id: "no", text: "No" }],
    presentations: { en: { recap: "Reviewed recap.", question: "Keep this rule?",
      options: [{ id: "yes", text: "Yes" }, { id: "no", text: "No" }] } } };
  const state = await createPreferenceLifecycleState(scope, [probe]);
  const project = (review) => projectPreferenceLifecycle(
    [currentSource], { [currentSource.key]: review }, state, [probe],
  );
  assert.equal((await project(reviewedState(currentSource)))[0].lifecycle_status, "active");
  assert.equal(await projectPreferenceLifecycle(
    [currentSource], { [currentSource.key]: reviewedState(currentSource) }, state, [],
  ), null);
  assert.equal((await projectPreferenceLifecycle(
    [currentSource], { [currentSource.key]: reviewedState(currentSource) }, state,
    [{ ...probe, question: "Tampered question" }],
  ))[0].lifecycle_status, "needs_update");
  assert.equal((await project(reviewedState(currentSource, { "insight-preference": "rejected" })))[0].lifecycle_status, "inactive");
  let edited = { ...reviewedState(currentSource), stage: "revision_ready" };
  const content = { ...currentSource.insights[0], title: "Accepted edited title" };
  delete content.id;
  edited = editAiInsight(edited, currentSource, "insight-preference", content);
  edited = updateAiInsightDecision(edited, currentSource, "insight-preference", "accepted");
  edited = applyChapterReview(edited, context(currentSource)).state;
  assert.equal((await project(edited))[0].lifecycle_status, "needs_update");
  const editedInsight = { ...currentSource.insights[0], ...content, id:"insight-preference" };
  const regeneratedScope = [{ storyKey:currentSource.key, insightId:editedInsight.id,
    insightAuthorityDigest:await storyPreparationDigest(insightAuthorityValue(currentSource.key, editedInsight)) }];
  const regeneratedProbe = { ...probe, ...regeneratedScope[0], question:"Keep the edited rule?" };
  const regenerated = await createPreferenceLifecycleState(regeneratedScope, [regeneratedProbe]);
  assert.equal((await projectPreferenceLifecycle([currentSource], { [currentSource.key]:edited }, regenerated,
    [regeneratedProbe]))[0].lifecycle_status, "active");
});

test("Preference lifecycle stores and reads only canonical identity-digest scope", async () => {
  const stories = [
    source([insight("insight-c")], { key: "zeta" }),
    source([insight("insight-a")], { key: "故事" }),
    source([insight("insight-b")], { key: "alpha" }),
  ];
  const scope = await preferenceInsightScope(stories);
  assert.deepEqual(scope.map((item) => item.storyKey), ["alpha", "zeta", "故事"]);
  const probe = { id: "preference-alpha", ...scope[0], question: "Keep this rule?",
    options: [{ id: "yes", text: "Yes" }, { id: "no", text: "No" }],
    presentations: { en: { recap: "Reviewed recap.", question: "Keep this rule?",
      options: [{ id: "yes", text: "Yes" }, { id: "no", text: "No" }] } } };
  const state = await createPreferenceLifecycleState(scope, [probe]);
  assert.ok(parsePreferenceLifecycleState(state));

  const noncanonical = structuredClone(state);
  noncanonical.generationScope.reverse();
  assert.equal(parsePreferenceLifecycleState(noncanonical), null);

  const staleQuestion = structuredClone(state);
  staleQuestion.questions[0].insightAuthorityDigest = "0".repeat(64);
  assert.equal(parsePreferenceLifecycleState(staleQuestion), null);
});

test("story sanitizer strips every non-product field and canonicalizes Insight order", () => {
  const currentSource = source([insight("insight-b"), insight("insight-a")], {}, "Safe detail");
  const release = buildReviewedStoryRelease(
    [currentSource],
    { [currentSource.key]: reviewedState(currentSource) },
  );
  const untrusted = structuredClone(release);
  untrusted.privateEvidence = PRIVATE;
  untrusted.chapters[0].anchors = [PRIVATE];
  untrusted.chapters[0].zh = { title: PRIVATE };
  untrusted.chapters[0].en.people[0].id = PRIVATE;
  untrusted.chapters[0].en.story.blocks.find((block) => block.insights.length > 0)
    .insights[0].origin = "source_ai";
  const sanitized = sanitizeReviewedStoryRelease(untrusted);
  assert.ok(sanitized);
  assert.equal(releaseInsights(sanitized).length, 2);
  assert.doesNotMatch(JSON.stringify(sanitized), new RegExp(`${PRIVATE}|privateEvidence|anchors|origin|"zh"|"id":"${PRIVATE}"`));
  assert.equal(sanitizeReviewedStoryRelease({ ...release, publication_approved: true }), null);
  assert.equal(sanitizeReviewedStoryRelease({ ...release, schema: "oxygen.reviewed-story.invalid" }), null);
});

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}


class FakeStoryReleaseDb {
  constructor({ items, run, session, redactionJob, redactions = [], receipts, probeRun, preferenceLifecycle,
    releaseConfirmation, completeness, sourcePrivacyReceipt, finalizedCorpus,
    storyPrivacyCandidates = [], storyPrivacyTargets = [] }) {
    this.items = items;
    this.runs = new Map([[run.id, run]]);
    this.session = session;
    this.redactionJob = redactionJob;
    this.redactions = redactions;
    this.sourcePrivacyReceipt = sourcePrivacyReceipt;
    this.finalizedCorpus = finalizedCorpus;
    this.receipts = receipts;
    this.probeRun = probeRun;
    this.preferenceLifecycle = preferenceLifecycle;
    this.releaseConfirmation = releaseConfirmation;
    this.completeness = completeness;
    this.storyPrivacyCandidates = storyPrivacyCandidates;
    this.storyPrivacyTargets = storyPrivacyTargets;
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
        if (/FROM story_preparation_receipts/.test(sql)) return { results: structuredClone(
          /lane='story_privacy'/.test(sql)
            ? this.receipts.filter((receipt) => receipt.lane === "story_privacy")
            : this.receipts,
        ) };
        if (/FROM semantic_units WHERE workflow_run_id=/.test(sql)) {
          return { results: structuredClone(this.completeness.unitRows) };
        }
        if (/FROM semantic_unit_members/.test(sql)) {
          return { results: structuredClone(this.completeness.memberRows) };
        }
        if (/FROM story_coverage_rows/.test(sql)) {
          return { results: structuredClone(this.completeness.coverageRows) };
        }
        if (/FROM story_privacy_authorities/.test(sql)) return { results: [] };
        if (/FROM story_privacy_candidates/.test(sql)) {
          return { results: structuredClone(this.storyPrivacyCandidates) };
        }
        if (/FROM story_privacy_targets/.test(sql)) {
          return { results: structuredClone(this.storyPrivacyTargets) };
        }
        if (/FROM probe_runs/.test(sql)) return { results: this.probeRun ? [structuredClone(this.probeRun)] : [] };
        if (/FROM probes/.test(sql)) return { results: [] };
        if (/FROM probe_bulk_decisions/.test(sql)) return { results: [] };
        if (/FROM preference_lifecycle_authorities/.test(sql)) {
          return { results: this.preferenceLifecycle ? [structuredClone(this.preferenceLifecycle)] : [] };
        }
        if (/FROM project_release_confirmations/.test(sql)) {
          return { results: this.releaseConfirmation ? [structuredClone(this.releaseConfirmation)] : [] };
        }
        if (/FROM source_privacy_receipts/.test(sql)) {
          return { results: this.sourcePrivacyReceipt ? [structuredClone(this.sourcePrivacyReceipt)] : [] };
        }
        if (/FROM finalized_corpus_manifests/.test(sql)) {
          return { results: this.finalizedCorpus ? [structuredClone(this.finalizedCorpus)] : [] };
        }
        if (/FROM documents/.test(sql)) return { results: [] };
        if (/FROM redaction_jobs/.test(sql)) {
          return { results: this.redactionJob ? [structuredClone(this.redactionJob)] : [] };
        }
        if (/organization_reason AS summary/.test(sql)) return { results: this.items.map((item) => ({
          id: item.id, documentId: item.document_id, sequence: item.sequence,
          timestamp: item.timestamp, summary: item.organization_reason,
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
        if (/SELECT 1 AS current FROM semantic_manifests/.test(sql)) return { current: 1 };
        if (/FROM workflow_runs r JOIN semantic_manifests/.test(sql)) {
          return structuredClone(this.completeness.binding);
        }
        if (/FROM semantic_manifests WHERE workflow_run_id=/.test(sql)) {
          return structuredClone(this.completeness.manifestRow);
        }
        if (/FROM story_coverage_manifests WHERE workflow_run_id=/.test(sql)) {
          return structuredClone(this.completeness.coverageManifestRow);
        }
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
        if (/FROM story_privacy_authorities/.test(sql)) return null;
        if (/FROM story_preparation_receipts/.test(sql)) {
          return structuredClone(this.receipts.find((receipt) => receipt.lane === "story_privacy") || null);
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
  const item = {
    id: evidence.eventId,
    document_id: evidence.documentId,
    document_kind: "trajectory",
    sequence: 1,
    event_type: "message",
    actor_id: "contributor",
    actor_type: "user",
    timestamp: "2026-08-25T00:00:00.000Z",
    content: `${storyPrivate} supporting evidence`,
    original_json: "{}",
  };
  const contribution = {
    id: item.id,
    sourceDigest: await contributionRecordSourceDigest({}, {
      id: item.id, documentId: item.document_id, sequence: item.sequence,
      eventType: item.event_type, actorId: item.actor_id, actorType: item.actor_type,
      timestamp: item.timestamp, content: item.content,
    }),
  };
  const semanticUnit = {
    id: "unit-release",
    revision: 1,
    projectId: "story-release-test",
    kind: "discussion",
    members: [item.id],
    memberCount: 1,
    membershipDigest: await sha256(canonicalAuthorityJson([contribution])),
  };
  const semanticCore = {
    projectId: semanticUnit.projectId,
    revision: 1,
    sourceDigest: await sha256(canonicalAuthorityJson([contribution])),
    universeDigest: await sha256(canonicalAuthorityJson([item.id])),
    registryDigest: "d".repeat(64),
    units: [semanticUnit],
  };
  const semanticValidation = await validateSemanticManifestAuthority({
    ...semanticCore,
    manifestDigest: await sha256(canonicalAuthorityJson(semanticCore)),
  }, [contribution]);
  assert.equal(semanticValidation.ok, true);
  const semantic = semanticValidation.authority;
  const coverageValidation = await finalizeCoverageManifestAuthority({ rows: [{
    unitId: semanticUnit.id, disposition: "represented", ownerId: currentSource.key,
  }] }, semantic);
  assert.equal(coverageValidation.ok, true);
  const coverage = coverageValidation.authority;
  currentSource.coverage = {
    semanticManifest: { revision: semantic.revision, digest: semantic.manifestDigest },
    coverageManifest: { revision: coverage.revision, digest: coverage.coverageDigest },
    representedUnitIds: [semanticUnit.id],
    excludedUnits: [],
  };
  item.organization_reason = `${STORY_PREFIX}${JSON.stringify(currentSource)}`;
  item.content_length = item.content.length;
  const humans = includeHuman
    ? [["human:approved", humanContent(currentSource)]] : [];
  const state = reviewedState(currentSource, decisions, humans);
  const session = createStoryReviewSession(RUN_ID, { [currentSource.key]: state }, {});
  const candidateRows = [{ id: item.id, documentId: item.document_id, summary: item.organization_reason }];
  const evidenceRows = [{
    id: item.id,
    documentId: item.document_id,
    eventType: item.event_type,
    actorId: item.actor_id,
    actorType: item.actor_type,
    reviewedNarrative: `${storyPrivate} supporting evidence`,
  }];
  const validation = validateStorySourcePackage(candidateRows, evidenceRows);
  assert.equal(validation.ok, true);
  assert.equal(validation.chapterCount, 1);
  const sourceDigest = await computeSourceDigest([item]);
  const sourceRedactions = initiallyRedacted ? [{
    id: "redaction-story-release",
    item_id: item.id,
    document_id: item.document_id,
    start_offset: 0,
    end_offset: storyPrivate.length,
    category: "sensitive",
    confidence: null,
    reason: null,
    review_state: "deterministic",
    uncertainty_reason: null,
    status: "active",
    created_by: "llm",
    created_at: "2026-08-25T00:00:09.000Z",
    updated_at: "2026-08-25T00:00:09.000Z",
  }] : [];
  const sourceTransport = canonicalSourcePrivacyRedactions(sourceRedactions.map((row) => ({
    itemId: row.item_id,
    documentId: row.document_id,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    category: row.category,
    confidence: row.confidence,
    reason: row.reason,
    reviewState: row.review_state,
    uncertaintyReason: row.uncertainty_reason,
    createdBy: "llm",
  })));
  const sourceReceiptCore = {
    status: "complete",
    workflowRunId: RUN_ID,
    sourceRevision: SOURCE_REVISION,
    finalizedCorpus: {
      revision: 1,
      digest: "c".repeat(64),
      documentCount: 1,
      itemCount: 1,
    },
    sourceDigest,
    dialogue: await buildCurrentSourcePrivacyDialogue([item]),
    redactions: {
      count: sourceTransport.length,
      digest: await sourcePrivacyDigest(sourceTransport),
    },
  };
  const sourceReceipt = {
    ...sourceReceiptCore,
    receiptDigest: await sourcePrivacyDigest(sourceReceiptCore),
  };
  const emptyDigest = await storyPreparationDigest([]);
  const completeDigest = await storyPreparationDigest([{ id: item.id, story: currentSource }]);
  const completedAt = "2026-08-25T00:00:09.000Z";
  const targetContents = deriveStoryReleaseTargetContents([currentSource]);
  assert.ok(targetContents);
  const catalog = targetContents.map(({ id, storyKey, target }) => ({ id, storyKey, target }));
  const privateTargetId = `${currentSource.key}::story:story-block-private`;
  const privacyCandidates = initiallyRedacted ? [{
    id: "story-private-detail",
    reviewState: "deterministic",
    title: "Private source detail",
    whyFlagged: "The exact private source fragment has a bounded Agent proposal.",
    uncertaintyReason: null,
    releaseTargets: [privateTargetId],
  }] : [];
  const targetProposals = await Promise.all(targetContents.map(async (target) => {
    const targetContentDigest = await storyPreparationDigest(target.content);
    if (!initiallyRedacted || target.id !== privateTargetId) {
      return { targetId: target.id, targetContentDigest, proposedText: target.content, occurrences: [] };
    }
    const start = Array.from("The ").length;
    const end = start + Array.from(storyPrivate).length;
    const replacement = "[Private detail abstracted]";
    return {
      targetId: target.id,
      targetContentDigest,
      proposedText: `The ${replacement} was removed.`,
      occurrences: [{
        originalStartOffset: start,
        originalEndOffset: end,
        proposalStartOffset: start,
        proposalEndOffset: start + Array.from(replacement).length,
        category: "sensitive",
      }],
    };
  }));
  const privacy = { candidates: privacyCandidates, targetProposals };
  const storyPrivacyCandidates = privacyCandidates.map((candidate) => ({
    workflow_run_id: RUN_ID,
    candidate_id: candidate.id,
    candidate_json: JSON.stringify(candidate),
  }));
  const storyPrivacyTargets = targetProposals.map((proposal) => ({
    workflow_run_id: RUN_ID,
    target_id: proposal.targetId,
    target_content_digest: proposal.targetContentDigest,
    proposed_text: proposal.proposedText,
    occurrences_json: JSON.stringify(proposal.occurrences),
    selected_text: proposal.proposedText,
    public_overrides_json: "[]",
    decided_at: completedAt,
  }));
  const scopeDigest = await storyPreparationDigest(catalog.map((target) => target.id));
  const otherDigest = "a".repeat(64);
  const receipts = [
    { workflow_run_id: RUN_ID, lane: "story", source_revision: SOURCE_REVISION,
      input_digest: otherDigest, scope_digest: otherDigest, scope_count: 1,
      output_digest: otherDigest, output_count: 1, completed_at: completedAt },
    { workflow_run_id: RUN_ID, lane: "insight", source_revision: SOURCE_REVISION,
      input_digest: otherDigest, scope_digest: otherDigest, scope_count: 1,
      output_digest: sourceInsights.length ? otherDigest : emptyDigest,
      output_count: sourceInsights.length, completed_at: completedAt },
    { workflow_run_id: RUN_ID, lane: "story_privacy", source_revision: SOURCE_REVISION,
      input_digest: completeDigest, scope_digest: scopeDigest, scope_count: catalog.length,
      output_digest: await storyPreparationDigest(privacy), output_count: targetProposals.length,
      completed_at: completedAt },
    { workflow_run_id: RUN_ID, lane: "preference", source_revision: SOURCE_REVISION,
      input_digest: emptyDigest, scope_digest: emptyDigest, scope_count: 0,
      output_digest: emptyDigest, output_count: 0, completed_at: completedAt },
  ];
  const activeStoryDigest = await sha256(validation.canonicalCandidate);
  const preferenceState = {
    generationScope: await preferenceInsightScope([currentSource]), questions: [], history: [],
  };
  const db = new FakeStoryReleaseDb({
    items: [item],
    run: {
      id: RUN_ID,
      status: "ready_for_human_review",
      sourceRevision: SOURCE_REVISION,
      activeStoryDigest,
    },
    session: {
      state_json: JSON.stringify({ sourceRevision: SOURCE_REVISION, session }),
      updated_at: "2026-08-25T00:00:10.000Z",
      server_version: SERVER_VERSION,
    },
    redactionJob: {
      id: "privacy-story-release",
      status: "complete",
      stage: "privacy",
      model: null,
      completed: initiallyRedacted ? 1 : 0,
      total: initiallyRedacted ? 1 : 0,
      rejected: 0,
      source_revision: SOURCE_REVISION,
      source_digest: sourceDigest,
      receipt_digest: sourceReceipt.receiptDigest,
      started_at: completedAt,
      updated_at: completedAt,
      completed_at: completedAt,
    },
    redactions: sourceRedactions,
    sourcePrivacyReceipt: {
      job_id: "privacy-story-release",
      workflow_run_id: RUN_ID,
      source_revision: SOURCE_REVISION,
      source_digest: sourceDigest,
      receipt_digest: sourceReceipt.receiptDigest,
      receipt_json: canonicalSourcePrivacyJson(sourceReceipt),
      created_at: completedAt,
    },
    finalizedCorpus: {
      workflow_run_id: RUN_ID,
      corpus_revision: 1,
      corpus_digest: "c".repeat(64),
      document_count: 1,
      item_count: 1,
      finalized_at: completedAt,
      current_document_count: 1,
      current_item_count: 1,
    },
    receipts,
    probeRun: {
      workflow_run_id: RUN_ID, id: RUN_ID, source_revision: SOURCE_REVISION,
      input_digest: emptyDigest, output_digest: emptyDigest, output_count: 0,
      status: "complete", stage: "preference", model: null, generated: 0, set_aside: 0,
    },
    preferenceLifecycle: {
      workflow_run_id: RUN_ID, source_revision: SOURCE_REVISION,
      active_story_digest: activeStoryDigest, story_session_version: SERVER_VERSION,
      state_json: canonicalAuthorityJson(preferenceState),
      state_digest: await storyPreparationDigest(preferenceState),
    },
    releaseConfirmation: null,
    storyPrivacyCandidates,
    storyPrivacyTargets,
    completeness: {
      semantic,
      manifestRow: {
        project_id: semantic.projectId,
        revision: semantic.revision,
        source_digest: semantic.sourceDigest,
        universe_digest: semantic.universeDigest,
        registry_digest: semantic.registryDigest,
        manifest_digest: semantic.manifestDigest,
        serialized_bytes: semantic.serializedBytes,
      },
      unitRows: [{
        id: semanticUnit.id,
        workflow_run_id: RUN_ID,
        revision: semanticUnit.revision,
        project_id: semanticUnit.projectId,
        kind: semanticUnit.kind,
        member_count: semanticUnit.memberCount,
        membership_digest: semanticUnit.membershipDigest,
        duplicate_of_unit_id: null,
        story_projection_json: "{}",
      }],
      memberRows: [{
        unit_id: semanticUnit.id,
        item_id: item.id,
        source_digest: contribution.sourceDigest,
      }],
      coverageManifestRow: {
        revision: coverage.revision,
        semantic_manifest_revision: coverage.semanticManifestRevision,
        semantic_manifest_digest: coverage.semanticManifestDigest,
        coverage_digest: coverage.coverageDigest,
        privacy_authority_digest: "0".repeat(64),
        unit_count: coverage.rows.length,
        serialized_bytes: coverage.serializedBytes,
      },
      coverageRows: [{
        unit_id: semanticUnit.id,
        disposition: "represented",
        owner_id: currentSource.key,
        exclusion_reason: null,
      }],
      binding: {
        workflow_run_id: RUN_ID,
        story_generation_status: "ready_for_human_review",
        story_source_revision: SOURCE_REVISION,
        source_revision: SOURCE_REVISION,
        project_id: semantic.projectId,
        revision: semantic.revision,
        source_digest: semantic.sourceDigest,
        universe_digest: semantic.universeDigest,
        registry_digest: semantic.registryDigest,
        manifest_digest: semantic.manifestDigest,
        unit_count: semantic.units.length,
        serialized_bytes: semantic.serializedBytes,
        story_projection_bytes: semanticValidation.storyProjectionBytes,
        corpus_revision: 1,
        corpus_digest: "c".repeat(64),
        corpus_document_count: 1,
        corpus_item_count: 1,
        finalized_revision: 1,
        finalized_digest: "c".repeat(64),
        document_count: 1,
        item_count: 1,
        current_document_count: 1,
        current_item_count: 1,
        current_unit_count: 1,
        current_member_count: 1,
      },
    },
  });
  const privacyAuthority = await readCoveragePrivacyAuthority(db, RUN_ID, semantic);
  assert.equal(privacyAuthority.ok, true);
  db.completeness.coverageManifestRow.privacy_authority_digest =
    privacyAuthority.authority.snapshotDigest;
  const current = await reconstructReviewedStoryReleaseFromDatabase(db, request(), {
    allowUnsetReleaseConfirmation: true,
  });
  if (current.ok) {
    db.releaseConfirmation = {
      workflow_run_id: RUN_ID,
      review_gate_digest: current.binding.reviewGateDigest,
      confirmed_at: "2026-08-25T00:00:11.000Z",
    };
  } else {
    assert.equal(includeHuman, true, JSON.stringify(current));
    assert.equal(current.code, RELEASE_ERROR.preparationInvalid);
  }
  return { db, currentSource };
}

async function rebindFixtureCoveragePrivacy(fixture) {
  const privacyAuthority = await readCoveragePrivacyAuthority(
    fixture.db,
    RUN_ID,
    fixture.db.completeness.semantic,
  );
  assert.equal(privacyAuthority.ok, true);
  fixture.db.completeness.coverageManifestRow.privacy_authority_digest =
    privacyAuthority.authority.snapshotDigest;
}

async function rebindFakeSourcePrivacyReceipt(fixture) {
  const { db } = fixture;
  const sourceDigest = await computeSourceDigest(db.items);
  const transport = canonicalSourcePrivacyRedactions(db.redactions.map((row) => ({
    itemId: row.item_id,
    documentId: row.document_id,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    category: row.category,
    confidence: row.confidence ?? null,
    reason: row.reason ?? null,
    reviewState: row.review_state === "deterministic" ? "deterministic" : "needs_confirmation",
    uncertaintyReason: row.uncertainty_reason ?? null,
    createdBy: "llm",
  })));
  const documentCount = new Set(db.items.map((item) => item.document_id)).size;
  const core = {
    status: "complete",
    workflowRunId: RUN_ID,
    sourceRevision: SOURCE_REVISION,
    finalizedCorpus: {
      revision: 1,
      digest: "c".repeat(64),
      documentCount,
      itemCount: db.items.length,
    },
    sourceDigest,
    dialogue: await buildCurrentSourcePrivacyDialogue(db.items),
    redactions: {
      count: transport.length,
      digest: await sourcePrivacyDigest(transport),
    },
  };
  const receipt = { ...core, receiptDigest: await sourcePrivacyDigest(core) };
  db.redactionJob.completed = transport.length;
  db.redactionJob.total = transport.length;
  db.redactionJob.source_revision = SOURCE_REVISION;
  db.redactionJob.source_digest = sourceDigest;
  db.redactionJob.receipt_digest = receipt.receiptDigest;
  db.sourcePrivacyReceipt = {
    job_id: db.redactionJob.id,
    workflow_run_id: RUN_ID,
    source_revision: SOURCE_REVISION,
    source_digest: sourceDigest,
    receipt_digest: receipt.receiptDigest,
    receipt_json: canonicalSourcePrivacyJson(receipt),
    created_at: db.redactionJob.completed_at,
  };
  db.finalizedCorpus = {
    workflow_run_id: RUN_ID,
    corpus_revision: 1,
    corpus_digest: "c".repeat(64),
    document_count: documentCount,
    item_count: db.items.length,
    finalized_at: db.redactionJob.completed_at,
    current_document_count: documentCount,
    current_item_count: db.items.length,
  };
}

const request = (overrides = {}) => ({
  workflowRunId: RUN_ID,
  serverVersion: SERVER_VERSION,
  sourceRevision: SOURCE_REVISION,
  ...overrides,
});

test("release request rejects source revision zero before runtime database initialization", async () => {
  assert.deepEqual(parseServerOwnedReleaseRequest({
    workflowRunId: RUN_ID,
    serverVersion: 0,
    sourceRevision: 1,
  }), {
    workflowRunId: RUN_ID,
    serverVersion: 0,
    sourceRevision: 1,
  });
  assert.equal(parseServerOwnedReleaseRequest({
    workflowRunId: RUN_ID,
    serverVersion: 0,
    sourceRevision: 0,
  }), null);

  const stateDir = join(tmpdir(), `oxygen-release-revision-zero-${process.pid}-${Date.now()}`);
  assert.equal(existsSync(stateDir), false);
  const previousStateDir = process.env.OXYGEN_VIEWER_STATE_DIR;
  process.env.OXYGEN_VIEWER_STATE_DIR = stateDir;
  try {
    assert.deepEqual(await reconstructReviewedStoryRelease({
      workflowRunId: RUN_ID,
      serverVersion: 0,
      sourceRevision: 0,
    }), { ok: false, code: RELEASE_ERROR.requestInvalid });
    assert.equal(existsSync(stateDir), false);
  } finally {
    if (previousStateDir === undefined) delete process.env.OXYGEN_VIEWER_STATE_DIR;
    else process.env.OXYGEN_VIEWER_STATE_DIR = previousStateDir;
  }
});

async function refreshFakeGate(db) {
  const current = await reconstructReviewedStoryReleaseFromDatabase(db, request(), {
    allowUnsetReleaseConfirmation: true,
  });
  assert.equal(current.ok, true, JSON.stringify(current));
  db.releaseConfirmation = {
    workflow_run_id: RUN_ID,
    review_gate_digest: current.binding.reviewGateDigest,
    confirmed_at: "2026-08-25T00:00:11.000Z",
  };
}

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
  assert.deepEqual(releaseInsights(release.story).map((item) => item.background), [
    "Background insight-private-anchor", "Background insight-safe-anchor",
  ]);
  assert.equal(release.story.chapters[0].en.story.blocks[0].text,
    "The [Private detail abstracted] was removed.");
  assert.doesNotMatch(release.serializedStory, new RegExp(`${PRIVATE}|documentId|eventId|story-block-|source_ai`));

  const pendingRow = db.storyPrivacyTargets[0];
  const selectedText = pendingRow.selected_text;
  const decidedAt = pendingRow.decided_at;
  pendingRow.selected_text = null;
  pendingRow.decided_at = null;
  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(db, request())).code,
    RELEASE_ERROR.storyPrivacyPending);
  pendingRow.selected_text = selectedText;
  pendingRow.decided_at = decidedAt;
  const missingTarget = db.storyPrivacyTargets.pop();
  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(db, request())).code,
    RELEASE_ERROR.preparationInvalid);
  db.storyPrivacyTargets.push(missingTarget);

  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(db,
    request({ workflowRunId: "wrong-run" }))).code, RELEASE_ERROR.runConflict);
  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(db,
    request({ serverVersion: SERVER_VERSION - 1 }))).code, RELEASE_ERROR.versionConflict);
  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(db,
    request({ sourceRevision: SOURCE_REVISION - 1 }))).code, RELEASE_ERROR.sourceConflict);
  db.runs.get(RUN_ID).activeStoryDigest = "0".repeat(64);
  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(db, request())).code, RELEASE_ERROR.stateInvalid);
});

test("nonempty AI Insights force current source Quote validation even for a passive caller", async () => {
  const { db, currentSource } = await serverFixture({
    sourceInsights: [insight("insight-force-current-source")],
  });
  const validation = await validateCurrentStorySourcePackage(
    db,
    RUN_ID,
    [{
      id: evidence.eventId,
      documentId: evidence.documentId,
      summary: `${STORY_PREFIX}${JSON.stringify(currentSource)}`,
    }],
    [{
      id: evidence.eventId,
      documentId: evidence.documentId,
      eventType: "message",
      actorId: "contributor",
      actorType: "user",
    }],
    { verifyCurrentSource: false },
  );
  assert.equal(validation.ok, true, validation.code);
});

test("Viewer Story activation grounds a Quote in exact reviewed source with pending source Privacy", async () => {
  const quoteText = `${PRIVATE} supporting evidence`;
  const { db, currentSource } = await serverFixture();
  db.redactions[0] = {
    ...db.redactions[0],
    review_state: "needs_confirmation",
    uncertainty_reason: "Contributor decision required.",
  };
  await rebindFakeSourcePrivacyReceipt({ db });
  await rebindFixtureCoveragePrivacy({ db });
  const candidateSource = structuredClone(currentSource);
  candidateSource.insights[0].quote = { text: quoteText, evidence };
  const privacyAuthority = await readCoveragePrivacyAuthority(
    db,
    RUN_ID,
    db.completeness.semantic,
  );
  assert.equal(privacyAuthority.ok, true);
  assert.equal(
    privacyAuthority.authority.reviewedNarrativeByItemId.get(evidence.eventId),
    quoteText,
  );
  const validation = await validateCurrentStorySourcePackage(
    db,
    RUN_ID,
    [{
      id: evidence.eventId,
      documentId: evidence.documentId,
      summary: `${STORY_PREFIX}${JSON.stringify(candidateSource)}`,
    }],
    [{
      id: evidence.eventId,
      documentId: evidence.documentId,
      eventType: "message",
      actorId: "contributor",
      actorType: "user",
    }],
  );
  assert.equal(validation.ok, true, validation.code);
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
  await rebindFakeSourcePrivacyReceipt(keepFixture);
  await rebindFixtureCoveragePrivacy(keepFixture);
  await refreshFakeGate(keepFixture.db);
  const kept = await reconstructReviewedStoryReleaseFromDatabase(keepFixture.db, request());
  assert.equal(kept.ok, true);
  assert.match(kept.serializedStory, new RegExp(PRIVATE));
  assert.equal(kept.story.chapters[0].en.story.blocks[0].text, `The ${PRIVATE} was removed.`);

  const redactFixture = await serverFixture();
  const redactItem = redactFixture.db.items[0];
  assert.match(redactItem.content, new RegExp(PRIVATE), "the private sentinel must exist in the reconstructed input");
  assert.match(redactItem.organization_reason, new RegExp(PRIVATE), "the private sentinel must exist in the Story source input");
  redactFixture.db.redactionJob.completed = 1;
  redactFixture.db.redactionJob.total = 1;
  redactFixture.db.redactions = [{
    ...redactFixture.db.redactions[0],
    id: "review-redact",
    item_id: redactItem.id,
    document_id: redactItem.document_id,
    review_state: "confirmed_redact",
    status: "active",
    reason: LOCAL_REVIEW_REASON_SENTINEL,
    uncertainty_reason: LOCAL_UNCERTAINTY_SENTINEL,
    created_by: "contributor",
  }];
  await rebindFakeSourcePrivacyReceipt(redactFixture);
  await rebindFixtureCoveragePrivacy(redactFixture);
  await refreshFakeGate(redactFixture.db);
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

test("synthetic live server flow releases zero and source Insights with byte parity", async () => {
  const scenarios = [
    { options: { sourceInsights: [] }, expected: [] },
    { options: { sourceInsights: [insight("insight-one")] }, expected: ["Background insight-one"] },
  ];
  const { renderReviewedStoryHtml } = await import("../app/api/organization/export/route.ts");
  for (const { options, expected } of scenarios) {
    const { db } = await serverFixture(options);
    const release = await reconstructReviewedStoryReleaseFromDatabase(db, request());
    assert.equal(release.ok, true);
    assert.deepEqual(releaseInsights(release.story).map((item) => item.background), expected);
    const zipEntry = reviewedStoryPackageEntry(release.story);
    assert.equal(zipEntry.data, release.serializedStory);
    const embedded = renderReviewedStoryHtml(release.serializedStory)
      .match(/const STORY=([\s\S]*?);const view=/)?.[1];
    assert.deepEqual(JSON.parse(embedded), JSON.parse(zipEntry.data));
    assert.equal(release.story.publication_approved, false);
  }
  const edited = await serverFixture({ sourceInsights: [], includeHuman: true });
  assert.equal((await reconstructReviewedStoryReleaseFromDatabase(edited.db, request())).code,
    RELEASE_ERROR.preparationInvalid);
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
  await rebindFakeSourcePrivacyReceipt(fixture);

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

test("a Story Privacy target choice during assembly fails the snapshot race closed", async () => {
  const fixture = await serverFixture();
  const target = fixture.db.storyPrivacyTargets.find((row) => (
    row.target_id === "chapter-release::overview"
  ));
  assert.ok(target);
  const result = await reconstructReviewedStoryReleaseFromDatabase(
    fixture.db,
    request(),
    {
      beforeFinalPrivacyCheck: () => {
        target.selected_text = "Late contributor-selected bytes";
        target.decided_at = "2026-08-25T00:00:20.000Z";
      },
    },
  );
  assert.equal(result.code, RELEASE_ERROR.privacyConflict);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(
    `${LOCAL_REVIEW_REASON_SENTINEL}|${LOCAL_UNCERTAINTY_SENTINEL}`,
  ));
});

test("a confirmation timestamp mutation during assembly fails closed", async () => {
  const fixture = await serverFixture();
  const result = await reconstructReviewedStoryReleaseFromDatabase(
    fixture.db,
    request(),
    {
      beforeFinalPrivacyCheck: () => {
        fixture.db.releaseConfirmation.confirmed_at = "2026-08-25T00:00:20.000Z";
      },
    },
  );
  assert.equal(result.code, RELEASE_ERROR.privacyConflict);
});

test("story HTML and ZIP use the same canonical reviewed release bytes", async () => {
  const safeHtmlEscapeSentinel = "SAFE_HTML_ESCAPE_</script><script>";
  const exactSelectedBytes = "EXACT_AGENT_SELECTED_BYTES";
  const { db } = await serverFixture({
    sourceInsights: [insight("insight-html-escape", "story-block-safe", {
      background: safeHtmlEscapeSentinel,
    })],
  });
  const selectedTarget = db.storyPrivacyTargets.find((row) => (
    row.target_id === "chapter-release::overview"
  ));
  assert.ok(selectedTarget);
  selectedTarget.selected_text = exactSelectedBytes;
  selectedTarget.decided_at = "2026-08-25T00:00:20.000Z";
  await refreshFakeGate(db);
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
  assert.match(release.serializedStory, new RegExp(exactSelectedBytes));
  assert.match(html, new RegExp(exactSelectedBytes));
  assert.match(zipEntry.data, new RegExp(exactSelectedBytes));
  assert.match(zipEntry.data, new RegExp(safeHtmlEscapeSentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(html.includes(safeHtmlEscapeSentinel), false, "HTML embedding must escape script-sensitive JSON copy");
  assert.deepEqual(JSON.parse(embedded), JSON.parse(zipEntry.data));

  const packageRoute = await readFile(new URL("../app/api/package/route.ts", import.meta.url), "utf8");
  assert.match(packageRoute, /finalReconstruction\.serializedStory !== reviewedStoryJson/);
  assert.match(packageRoute, /reconstructReviewedStoryReleaseFromDatabase\(db, parsedReleaseRequest\)/);
});
