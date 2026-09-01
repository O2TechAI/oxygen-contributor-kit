import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  canonicalAuthorityJson,
  finalizeCoverageManifestAuthority,
  validateStoryActivationAuthority,
  validateStorySourcePackage,
} from "../lib/story-readiness.ts";
import { computeSourceDigest } from "../lib/redaction-pass.mjs";
import { parseStorySource, timelinePresentation } from "../lib/timeline.ts";
import { canonicalPreferenceQuestionBatch, deriveStoryReleaseTargetContents } from "../lib/story-preparation.ts";

const repository = resolve(import.meta.dirname, "../..");
const scripts = join(repository, "skills", "oxygen-storytelling-review", "scripts");
const prepare = join(scripts, "prepare_story_preparation.mjs");
const record = join(scripts, "record_story_preparation.mjs");
const finalize = join(scripts, "finalize_story_preparation.mjs");
const preferenceScripts = join(repository, "skills", "oxygen-elicit-contributor-preferences", "scripts");
const preparePreferenceContext = join(preferenceScripts, "prepare_preference_context.py");
const validateProbes = join(preferenceScripts, "validate_probes.py");
const localReview = join(repository, "skills", "oxygen-organize-review-export", "scripts", "run_local_review.py");
const digest = (value) => createHash("sha256").update(canonicalAuthorityJson(value)).digest("hex");
const json = (path, value) => writeFile(path, JSON.stringify(value), "utf8");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const storyAuthorityArgs = ["--workflow-run-id", "public-canary-run", "--source-revision", "4"];

function run(command, args) {
  return spawnSync(command, args, { cwd: repository, encoding: "utf8" });
}

function runOk(command, args) {
  const result = run(command, args);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

async function runAsync(command, args) {
  const child = spawn(command, args, { cwd: repository, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [status] = await once(child, "close");
  return { status, stderr };
}

test("Preference regeneration CLI parser rejects hostile response shapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "preference-regeneration-cli-"));
  const binding = { workflowRunId: "loopback-run" };
  let mode = "valid";
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (mode === "invalid-export") response.end(JSON.stringify({ schema: "oxygen.preference-regeneration-context", binding: [] }));
    else if (mode === "invalid-import") response.end("[]");
    else response.end(JSON.stringify(request.method === "POST"
      ? { workflowRunId: binding.workflowRunId, status: "complete", regenerated: 0 }
      : { schema: "oxygen.preference-regeneration-context", binding }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  const common = [localReview, "--attach-url", url, "--workflow-run-id", binding.workflowRunId];
  try {
    const context = join(root, "context.json"),bundle = join(root, "bundle.json");
    assert.equal((await runAsync("python", [...common, "--preference-regeneration-export", context])).status, 0);
    await json(bundle, { schema: "oxygen.preference-regeneration-import", binding });
    assert.equal((await runAsync("python", [...common, "--preference-regeneration-import", bundle])).status, 0);
    mode = "invalid-export";
    assert.match(
      (await runAsync("python", [
        ...common, "--preference-regeneration-export", join(root, "bad.json"),
      ])).stderr,
      /^VIEWER_RESPONSE_INVALID: The local Viewer returned an invalid response\.\r?\n$/u,
    );
    mode = "invalid-import";
    assert.match(
      (await runAsync("python", [
        ...common, "--preference-regeneration-import", bundle,
      ])).stderr,
      /^VIEWER_RESPONSE_INVALID: The local Viewer returned an invalid response\.\r?\n$/u,
    );
  } finally {
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
});

const laneDirectory = {
  story: "story", insight: "insight", story_privacy: "story-privacy", preference: "preference",
};

function phaseFreeProposal(record) {
  const { schema, key, language, languagePolicyDigest, coverage, ...chapter } = record.story;
  assert.equal(schema, "oxygen.story");
  assert.ok(language === "en" || language === "zh");
  assert.match(languagePolicyDigest, /^[0-9a-f]{64}$/u);
  assert.ok(coverage);
  delete chapter.phase;
  return { ownerId: key, chapter };
}

const acceptedStoryEditorialCriteria = () => ({
  beginningIsUnderstandable: true,
  participantsAreIdentifiable: true,
  chronologyIsTraceable: true,
  responsesAndChangesAreExplained: true,
  arcIsCoherent: true,
  endingIsClear: true,
  claimsAreEvidenceSupported: true,
  proseIsReadable: true,
});

function storyEditorialReviews(proposals, inputDigest, criteriaOverrides = {}) {
  return proposals.map((proposal) => ({
    ownerId: proposal.ownerId,
    inputDigest,
    proposalDigest: digest(proposal),
    criteria: {
      ...acceptedStoryEditorialCriteria(),
      ...(criteriaOverrides[proposal.ownerId] ?? {}),
    },
  })).sort((left, right) => Buffer.compare(Buffer.from(left.ownerId), Buffer.from(right.ownerId)));
}

async function refreshStoryEditorialReview(batch, criteriaOverrides = {}) {
  const proposals = (await Promise.all(batch.manifest.shards.map((shard) => (
    readJson(join(batch.proposalDirectory, `${shard.id}.json`))
  )))).flat();
  await json(batch.editorialReviewPath, storyEditorialReviews(
    proposals, batch.manifest.inputDigest, criteriaOverrides,
  ));
}

async function recordLane(transport, lane, root, proposalForInput) {
  const directory = laneDirectory[lane];
  const manifest = await readJson(join(transport, directory, "shards.json"));
  if (lane === "story") {
    const proposalDirectory = join(root, `story-proposals-${manifest.inputDigest.slice(0, 12)}`);
    await mkdir(proposalDirectory);
    const phases = new Map();
    const proposals = [];
    for (const shard of manifest.shards) {
      const input = await readJson(join(transport, ...shard.inputPath.split("/")));
      const records = proposalForInput(input);
      for (const record of records) phases.set(record.story.key, record.story.phase);
      const shardProposals = records.map(phaseFreeProposal);
      proposals.push(...shardProposals);
      await json(join(proposalDirectory, `${shard.id}.json`), shardProposals);
    }
    const editorialReviewPath = join(root, `story-editorial-${manifest.inputDigest.slice(0, 12)}.json`);
    await json(editorialReviewPath, storyEditorialReviews(proposals, manifest.inputDigest));
    const phasePath = join(root, `story-phases-${manifest.inputDigest.slice(0, 12)}.json`);
    await json(phasePath, [...phases].map(([ownerId, phase]) => ({ ownerId, phase })));
    runOk(process.execPath, [record, transport, "story", proposalDirectory, editorialReviewPath, phasePath,
      "--correction-attempt-count", "0"]);
    return manifest;
  }
  for (const shard of manifest.shards) {
    const input = await readJson(join(transport, ...shard.inputPath.split("/")));
    const proposal = join(root, `${shard.id}-proposal.json`);
    await json(proposal, proposalForInput(input));
    runOk(process.execPath, [record, transport, lane, shard.id, proposal]);
  }
  return manifest;
}

function privacyEnvelopeForInput(input, candidates = []) {
  const stories = input.payload.storyCandidates.map((row) => parseStorySource(row.summary));
  assert.ok(stories.every(Boolean));
  const valid = new Set(input.unitIds);
  const targets = deriveStoryReleaseTargetContents(stories).filter((target) => valid.has(target.id));
  const shardCandidates = candidates.filter((candidate) => (
    candidate.releaseTargets.every((target) => valid.has(target))
  ));
  const flagged = new Set(shardCandidates.flatMap((candidate) => candidate.releaseTargets));
  return {
    candidates: shardCandidates,
    targetProposals: targets.map((target) => {
      if (!flagged.has(target.id)) return {
        targetId: target.id, targetContentDigest: digest(target.content),
        proposedText: target.content, occurrences: [],
      };
      const replacement = "Anonymous";
      const original = Array.from(target.content);
      const start = original.findLastIndex((point) => /[\p{L}\p{N}]/u.test(point));
      assert.notEqual(start, -1);
      return {
        targetId: target.id,
        targetContentDigest: digest(target.content),
        proposedText: original.slice(0, start).join("") + replacement + original.slice(start + 1).join(""),
        occurrences: [{
          originalStartOffset: start, originalEndOffset: start + 1,
          proposalStartOffset: start, proposalEndOffset: start + Array.from(replacement).length,
          category: "private-identity",
        }],
      };
    }),
  };
}

async function storyBatchFiles(transport, root, records, tag = "batch") {
  const manifest = await readJson(join(transport, "story", "shards.json"));
  const proposalDirectory = join(root, `${tag}-proposals`);
  await mkdir(proposalDirectory);
  const byOwner = new Map(records.map((record) => [record.story.key, record]));
  const proposals = [];
  for (const shard of manifest.shards) {
    const shardProposals = shard.unitIds.map((ownerId) => (
      phaseFreeProposal(byOwner.get(ownerId))
    ));
    proposals.push(...shardProposals);
    await json(join(proposalDirectory, `${shard.id}.json`), shardProposals);
  }
  const editorialReviewPath = join(root, `${tag}-editorial.json`);
  await json(editorialReviewPath, storyEditorialReviews(proposals, manifest.inputDigest));
  const phasePath = join(root, `${tag}-phases.json`);
  await json(phasePath, records.map((record) => ({
    ownerId: record.story.key,
    phase: record.story.phase,
  })));
  return { manifest, proposalDirectory, editorialReviewPath, phasePath };
}

async function reverseLaneManifest(transport, lane) {
  const path = join(transport, laneDirectory[lane], "shards.json");
  const manifest = await readJson(path);
  manifest.shards.reverse();
  await json(path, manifest);
}

function semanticAuthority({
  suffixes = ["a", "b"], projectId = "Synthetic Canary", kinds = ["decision_episode"],
} = {}) {
  const units = suffixes.map((suffix, index) => ({
    id: `unit-${suffix}`,
    revision: 1,
    projectId,
    kind: kinds[index % kinds.length],
    members: [`event-${suffix}`],
    memberCount: 1,
    membershipDigest: digest([{ id: `event-${suffix}`, sourceDigest: digest({ suffix }) }]),
    storyProjection: {
      label: `Canary ${suffix.toUpperCase()}`,
      summary: `A reviewed synthetic event records canary ${suffix.toUpperCase()}.`,
    },
  })).sort((left, right) => Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)));
  const core = {
    projectId,
    revision: 1,
    sourceDigest: digest(units.map((unit) => unit.members[0])),
    universeDigest: digest(units.flatMap((unit) => unit.members)),
    registryDigest: "d".repeat(64),
    units,
  };
  return { ...core, manifestDigest: digest(core) };
}

function storySource(suffix, semantic, coverage, insights = [], {
  documentId = "doc-canary", language = "en",
} = {}) {
  const evidence = { documentId, eventId: `event-${suffix}` };
  const localized = language === "zh" ? {
    phase: "Reviewed phase",
    title: "经过审阅的中文测试",
    overview: "这是一段经过审阅的中文测试说明。",
    person: "中文测试参与者",
    role: "审阅参与者",
    description: "参与者记录了这次经过审阅的中文测试。",
    block: "这是一条经过审阅的中文观察记录。",
  } : {
    phase: "Reviewed phase",
    title: `Canary ${suffix.toUpperCase()}`,
    overview: `A domain-neutral reviewed canary ${suffix.toUpperCase()}.`,
    person: `Canary participant ${suffix.toUpperCase()}`,
    role: "reviewed participant",
    description: `The participant contributed canary ${suffix.toUpperCase()}.`,
    block: `Reviewed canary text ${suffix.toUpperCase()}.`,
  };
  return {
    schema: "oxygen.story",
    language,
    languagePolicyDigest: "f".repeat(64),
    key: `story-${suffix}`,
    phase: { id: `phase-${suffix}`, label: localized.phase },
    title: localized.title,
    overview: localized.overview,
    chips: [language === "zh" ? "审阅证据" : `reviewed canary ${suffix.toUpperCase()}`],
    people: [{
      id: `person-${suffix}`,
      releaseLabel: localized.person,
      role: localized.role,
      description: localized.description,
      localIdentityState: "not_identified",
      evidence: [evidence],
    }],
    story: {
      blocks: [{ id: `block-${suffix}`, text: localized.block, evidence: [evidence] }],
    },
    insights,
    evidence: { primary: evidence, supporting: [] },
    coverage: {
      semanticManifest: { revision: semantic.revision, digest: semantic.manifestDigest },
      coverageManifest: { revision: coverage.revision, digest: coverage.coverageDigest },
      representedUnitIds: [`unit-${suffix}`],
      excludedUnits: [],
    },
  };
}

async function reviewedBoundary(root, projectMap, semantic, coverageRows = null, {
  documentId = "doc-canary", language = "en", narrativeBytes = 0, sourceRedactions = [],
  eventIdentities = {}, narratives = {},
} = {}) {
  const review = join(root, "review");
  const trajectories = join(review, "trajectories");
  await mkdir(trajectories, { recursive: true });
  await json(join(review, "project-map.json"), projectMap);
  const events = semantic.units.map((unit, index) => {
    const suffix = unit.id.slice("unit-".length);
    const actorType = index % 2 === 0 ? "user" : "assistant";
    return {
    event_id: `event-${suffix}`,
    trajectory_id: eventIdentities[suffix]?.documentId ?? documentId,
    turn_id: `turn-${suffix}`,
    sequence: eventIdentities[suffix]?.sequence ?? index + 1,
    event_type: "message",
    actor: { id: `actor-${digest([documentId, actorType])}`, type: actorType },
    relation_id: `event-${digest([documentId, `event-${suffix}`])}`,
    timestamp: eventIdentities[suffix]?.timestamp ?? null,
    payload: { role: actorType, text: `${narratives[suffix] ?? (language === "zh"
      ? `这是一条安全且经过审阅的中文观察记录${suffix}` : `safe reviewed canary ${suffix}`)}${
      narrativeBytes ? ` ${(language === "zh" ? "中" : "x").repeat(narrativeBytes)}` : ""}` },
    relations: [],
    };
  });
  for (const eventDocumentId of new Set(events.map((event) => event.trajectory_id))) {
    const trajectory = join(trajectories, eventDocumentId);
    await mkdir(trajectory);
    const documentEvents = events.filter((event) => event.trajectory_id === eventDocumentId);
    await writeFile(join(trajectory, "events.jsonl"), `${documentEvents.map(JSON.stringify).join("\n")}\n`, "utf8");
  }
  const sourceRows = events.map((event) => ({
    id: event.event_id,
    document_id: event.trajectory_id,
    sequence: event.sequence,
    event_type: event.event_type,
    actor_type: event.actor.type,
    timestamp: event.timestamp,
    content: event.payload.text,
  }));
  const sourcePrivacy = join(root, "source-privacy.json");
  const redactions = sourceRedactions.map((redaction, index) => ({
    id: `source-redaction-${index + 1}`,
    item_id: `event-${redaction.suffix}`,
    document_id: documentId,
    start_offset: redaction.startOffset,
    end_offset: redaction.endOffset,
    category: "sensitive",
    confidence: "high",
    reason: "Synthetic protected context.",
    review_state: redaction.reviewState ?? "deterministic",
    uncertainty_reason: redaction.reviewState === "needs_confirmation"
      ? "Contributor decision required." : null,
    status: "active",
    created_by: "local-test",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:01Z",
  }));
  await json(sourcePrivacy, {
    redactions,
    job: {
      id: "source-privacy-current", status: "complete", stage: "complete", model: null,
      completed: redactions.length, total: redactions.length, rejected: 0,
      source_revision: 1,
      source_digest: await computeSourceDigest(sourceRows),
      receipt_digest: "8".repeat(64),
      started_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:01Z",
      completed_at: "2026-01-01T00:00:01Z",
    },
  });
  const requestedCoverage = coverageRows ?? semantic.units.map((unit) => ({
    unitId: unit.id, disposition: "represented", ownerId: `story-${unit.id.slice("unit-".length)}`,
  }));
  const coverageResult = await finalizeCoverageManifestAuthority({ rows: requestedCoverage }, semantic);
  assert.equal(coverageResult.ok, true, JSON.stringify(coverageResult));
  const coverage = join(root, "coverage.json");
  const authority = coverageResult.authority;
  await json(coverage, {
    revision: authority.revision,
    semanticManifestRevision: authority.semanticManifestRevision,
    semanticManifestDigest: authority.semanticManifestDigest,
    coverageDigest: authority.coverageDigest,
    rows: authority.rows.map((row) => row.disposition === "represented" ? {
      unitId: row.unitId, disposition: row.disposition, ownerId: row.ownerId,
    } : {
      unitId: row.unitId, disposition: row.disposition, exclusionReason: row.exclusionReason,
    }),
  });
  return { review, sourcePrivacy, coverage, coverageAuthority: authority };
}

function insight(suffix, documentId = "doc-canary", language = "en") {
  const evidence = { documentId, eventId: `event-${suffix}` };
  return {
    id: `insight-${suffix}`,
    title: language === "zh" ? "经过审阅的中文经验" : `Canary lesson ${suffix.toUpperCase()}`,
    background: language === "zh" ? "这是经过审阅的中文背景说明。" : `Reviewed background ${suffix.toUpperCase()}.`,
    anchorStoryBlockId: `block-${suffix}`,
    quote: {
      text: language === "zh" ? `这是一条安全且经过审阅的中文观察记录${suffix}` : `safe reviewed canary ${suffix}`,
      evidence,
    },
    directlyAcquiredExperience: language === "zh"
      ? "这是一条直接获得的中文经验。" : `Reviewed experience ${suffix.toUpperCase()}.`,
    principle: language === "zh"
      ? "这是一条边界明确的中文原则。" : `Bounded principle ${suffix.toUpperCase()}.`,
    evidence: [],
  };
}

async function privacyAuthority(root, suffixes = ["a", "b"], documentId = "doc-canary",
  documentKind = "trajectory", evidenceCount = suffixes.length, language = "en") {
  const redacted = join(root, "redacted");
  await mkdir(redacted);
  const text = language === "zh" ? "这是一条安全且经过审阅的中文观察记录" : "safe reviewed canary";
  const eventIds = suffixes.map((suffix) => `event-${suffix}`);
  while (eventIds.length < evidenceCount) eventIds.push(`preference-event-${eventIds.length}`);
  const turns = eventIds.map((eventId, index) => ({
    event_id: eventId,
    document_id: documentId,
    item_id: eventId,
    sequence: index + 1,
    role: "user",
    timestamp: null,
    text,
    redactions: [],
    redacted_text: text,
  }));
  await json(join(redacted, `${documentId}.json`), {
    trajectory: documentId,
    document_kind: documentKind,
    turns,
    chars: text.length * turns.length,
  });
  const report = join(root, "privacy-report.json");
  await json(report, {
    categories: {}, total_applied: 0, rejected: 0, rejects: [], missing_worker_output: [],
    per_trajectory: [{ trajectory: documentId, turns: turns.length, applied: 0 }],
    receiptDigest: "0".repeat(64),
  });
  return { redacted, report, eventIds };
}

async function createFlow({
  reverse = false,
  completedZero = false,
  suffixes = ["a", "b"],
  projectId = "Synthetic Canary",
  kinds = ["decision_episode"],
  documentId = "doc-canary",
  language = "en",
  narrativeBytes = 0,
  insightSuffixes = suffixes,
  reverseManifests = false,
  deferPreferenceRecord = false,
  documentKind = "trajectory",
  preferenceEvidenceCount = 1,
  sourceRedactions = [],
  storyPrivacyReleaseTargets = null,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "story-public-transport-"));
  const semantic = semanticAuthority({ suffixes, projectId, kinds });
  const semanticPath = join(root, "semantic.json");
  const projectMapPath = join(root, "project-map.json");
  const transport = join(root, "transport");
  await json(semanticPath, semantic);
  await json(projectMapPath, {
    primary_project: semantic.projectId,
    summary: "Domain-neutral synthetic canary.",
    projects: [{ name: semantic.projectId, event_count: suffixes.length, reason: "One reviewed contribution universe." }],
    source_authority: { sourceDigest: semantic.sourceDigest, sourceCount: 1, contributionCount: suffixes.length },
    semantic_units: semantic.units.map((unit) => ({ id: unit.id, kind: unit.kind, members: unit.members })),
    semantic_manifest: semantic,
  });
  const projectMap = await readJson(projectMapPath);
  const boundary = await reviewedBoundary(root, projectMap, semantic, null, {
    documentId, language, narrativeBytes, sourceRedactions,
  });

  runOk(process.execPath, [prepare, "prepare", "story", projectMapPath,
    boundary.coverage, boundary.sourcePrivacy, boundary.review, transport, ...storyAuthorityArgs]);
  if (reverseManifests) await reverseLaneManifest(transport, "story");
  const storyProposal = join(root, "story-proposal.json");
  const storyRecords = suffixes.map((suffix) => ({
    id: `event-${suffix}`,
    story: storySource(suffix, semantic, boundary.coverageAuthority, [], { documentId, language }),
  }));
  const submittedStoryRecords = reverse ? [...storyRecords].reverse() : storyRecords;
  await json(storyProposal, submittedStoryRecords);
  await recordLane(transport, "story", root, (input) => submittedStoryRecords.filter((record) => (
    input.unitIds.includes(record.story.key)
  )));
  const baseCandidates = join(root, "story-base-candidates.json");
  runOk(process.execPath, [prepare, "compose", "story", transport, baseCandidates]);

  runOk(process.execPath, [prepare, "prepare", "insight", baseCandidates, transport]);
  if (reverseManifests) await reverseLaneManifest(transport, "insight");
  const insightProposal = join(root, "insight-proposal.json");
  const insightRecords = suffixes.map((suffix) => ({
    storyKey: `story-${suffix}`,
    insights: completedZero || !insightSuffixes.includes(suffix) ? [] : [insight(suffix, documentId, language)],
  }));
  const submittedInsightRecords = reverse ? [...insightRecords].reverse() : insightRecords;
  await json(insightProposal, submittedInsightRecords);
  await recordLane(transport, "insight", root, (input) => submittedInsightRecords.filter((item) => (
    input.unitIds.includes(item.storyKey)
  )));
  const candidates = join(root, "story-candidates.json");
  runOk(process.execPath, [prepare, "compose", "final", transport, candidates]);

  const privacy = await privacyAuthority(
    root, suffixes, documentId, documentKind, preferenceEvidenceCount, language,
  );
  if (preferenceEvidenceCount > suffixes.length) {
    const rows = await readJson(candidates);
    const first = JSON.parse(rows[0].summary.slice("oxygen.story:".length));
    first.insights[0].evidence = privacy.eventIds.slice(suffixes.length).map((eventId) => ({
      documentId, eventId,
    }));
    rows[0].summary = `oxygen.story:${JSON.stringify(first)}`;
    await json(candidates, rows);
  }
  const preferenceContext = join(root, "preference-context.json");
  runOk("python", [preparePreferenceContext,
    "--story-candidates", candidates,
    "--redacted", privacy.redacted,
    "--privacy-report", privacy.report,
    "--output", preferenceContext,
  ]);

  // These siblings are ready after final Story composition and may be prepared in either order.
  runOk(process.execPath, [prepare, "prepare", "preference", candidates, preferenceContext, transport]);
  runOk(process.execPath, [prepare, "prepare", "story_privacy", candidates, transport]);
  if (reverseManifests) {
    await reverseLaneManifest(transport, "preference");
    await reverseLaneManifest(transport, "story_privacy");
  }

  const privacyCandidates = completedZero ? [] : [{
    id: "privacy-canary",
    reviewState: "needs_confirmation",
    title: "Review synthetic title",
    whyFlagged: "The reviewed canary requests a release decision.",
    uncertaintyReason: "Confirm the synthetic title.",
    releaseTargets: storyPrivacyReleaseTargets ?? [`story-${suffixes[0]}::title`],
  }];
  await recordLane(transport, "story_privacy", root, (input) => (
    privacyEnvelopeForInput(input, privacyCandidates)
  ));

  const preferenceCandidates = join(root, "preference-candidates.json");
  const preferenceAuthority = await readJson(preferenceContext);
  const preferenceBinding = preferenceAuthority.insightScope[0];
  await json(preferenceCandidates, completedZero ? {
    probes: [], bulkDecisions: [], setAside: 0,
  } : {
    probes: [{
      id: "probe-canary",
      ...preferenceBinding,
      documentId,
      documentKind,
      eventIds: privacy.eventIds.slice(0, preferenceEvidenceCount),
      timestamp: null,
      signal: "explicit_rule",
      score: 80,
      turns: 1,
      recap: "A reviewed canary records a bounded choice.",
      question: "Which bounded canary behavior should be retained?",
      options: [
        { id: "one", text: "Retain the reviewed canary boundary." },
        { id: "two", text: "Request confirmation before changing the boundary." },
      ],
      presentations: {
        en: {
          recap: "A reviewed canary records a bounded choice.",
          question: "Which bounded canary behavior should be retained?",
          options: [
            { id: "one", text: "Retain the reviewed canary boundary." },
            { id: "two", text: "Request confirmation before changing the boundary." },
          ],
        },
        zh: {
          recap: "一段经过审阅的测试记录形成了明确选择。",
          question: "应该保留哪一种有边界的测试行为？",
          options: [
            { id: "one", text: "保留经过审阅的测试边界。" },
            { id: "two", text: "改变边界前请求确认。" },
          ],
        },
      },
      allowOther: true,
      allowSkip: true,
    }],
    bulkDecisions: [],
    setAside: 0,
  });
  const preferenceBundle = join(root, "preference-bundle.json");
  runOk("python", [validateProbes,
    "--context", preferenceContext,
    "--candidates", preferenceCandidates,
    "--workflow-run-id", "public-canary-run",
    "--source-revision", "4",
    "--output", preferenceBundle,
  ]);
  const preferenceManifest = await readJson(join(transport, "preference", "shards.json"));
  assert.equal(preferenceManifest.shards.length, 1);

  const preparationManifest = join(root, "story-preparation-manifest.json");
  if (!deferPreferenceRecord) {
    runOk(process.execPath, [record, transport, "preference", preferenceManifest.shards[0].id, preferenceBundle]);
    runOk(process.execPath, [finalize,
      projectMapPath, candidates, transport, preferenceBundle, preparationManifest,
      "--workflow-run-id", "public-canary-run", "--source-revision", "4",
    ]);
  }
  return {
    root, semanticPath, projectMapPath, transport, candidates,
    sourcePrivacy: boundary.sourcePrivacy,
    preferenceContext, preferenceCandidates, preferenceBundle, preferenceManifest,
    preparationManifest,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function prepareStoryOnly({
  suffixes = ["a", "b"], coverageRows = null, narrativeBytes = 0,
  reverseTransportInputs = false, sourceRedactions = [], eventIdentities = {}, language = "en",
  narratives = {}, languageChoice, storyLanguageMap,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "story-owner-batch-"));
  const semantic = semanticAuthority({ suffixes });
  const projectMap = {
    primary_project: semantic.projectId,
    summary: "Owner-atomic canary.",
    projects: [{ name: semantic.projectId, event_count: suffixes.length, reason: "Reviewed boundary." }],
    source_authority: {
      sourceDigest: semantic.sourceDigest, sourceCount: 1, contributionCount: suffixes.length,
    },
    semantic_units: semantic.units.map((unit) => ({ id: unit.id, kind: unit.kind, members: unit.members })),
    semantic_manifest: semantic,
  };
  const projectMapPath = join(root, "project-map.json");
  await json(projectMapPath, projectMap);
  const boundary = await reviewedBoundary(root, projectMap, semantic, coverageRows, {
    narrativeBytes, sourceRedactions, eventIdentities, language, narratives,
  });
  if (reverseTransportInputs) {
    const reversedMap = structuredClone(projectMap);
    reversedMap.semantic_manifest.units.reverse();
    reversedMap.semantic_units.reverse();
    await json(projectMapPath, reversedMap);
    await json(join(boundary.review, "project-map.json"), reversedMap);
    const coverage = await readJson(boundary.coverage);
    coverage.rows.reverse();
    await json(boundary.coverage, coverage);
    const eventsPath = join(boundary.review, "trajectories", "doc-canary", "events.jsonl");
    const lines = (await readFile(eventsPath, "utf8")).trimEnd().split("\n").reverse();
    await writeFile(eventsPath, `${lines.join("\n")}\n`, "utf8");
  }
  const transport = join(root, "transport");
  const languageArgs = [];
  if (languageChoice) languageArgs.push("--language-choice", languageChoice);
  if (storyLanguageMap) {
    const mappingPath = join(root, "story-language-map.json");
    await json(mappingPath, storyLanguageMap);
    languageArgs.push("--story-language-map", mappingPath);
  }
  const prepared = run(process.execPath, [prepare, "prepare", "story", projectMapPath,
    boundary.coverage, boundary.sourcePrivacy, boundary.review, transport,
    ...storyAuthorityArgs, ...languageArgs]);
  return {
    root, semantic, projectMapPath, boundary, transport, prepared,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("public commands execute the nonempty four-lane dependency chain deterministically", async () => {
  const first = await createFlow();
  const reordered = await createFlow({ reverse: true });
  try {
    assert.equal(await readFile(first.candidates, "utf8"), await readFile(reordered.candidates, "utf8"));
    assert.equal(await readFile(first.preferenceBundle, "utf8"), await readFile(reordered.preferenceBundle, "utf8"));
    assert.equal(await readFile(first.preparationManifest, "utf8"), await readFile(reordered.preparationManifest, "utf8"));
    const manifest = await readJson(first.preparationManifest);
    assert.equal(manifest.schema, "oxygen.story-preparation");
    assert.deepEqual(manifest.receipts.map((receipt) => receipt.lane), [
      "story", "insight", "story_privacy", "preference",
    ]);
    assert.ok(manifest.receipts.every((receipt) => receipt.outputCount > 0));
    const finalStories = (await readJson(first.candidates)).map((row) => parseStorySource(row.summary));
    assert.ok(finalStories.every(Boolean));
    const initialTargets = deriveStoryReleaseTargetContents(finalStories);
    assert.ok(initialTargets);
    assert.ok(initialTargets.every((target) => !target.id.includes("::insight:")));
    assert.deepEqual(
      manifest.storyPrivacy.targetProposals.map((proposal) => proposal.targetId),
      initialTargets.map((target) => target.id),
    );
    const compactStoryManifest = await readJson(join(first.transport, "story", "shards.json"));
    assert.equal(compactStoryManifest.shards.length, 1);
    assert.equal(compactStoryManifest.shards[0].unitIds.length, 2);
    const finalBytes = [
      await readFile(first.candidates, "utf8"),
      await readFile(first.preferenceBundle, "utf8"),
      await readFile(first.preparationManifest, "utf8"),
    ].join("\n");
    assert.doesNotMatch(finalBytes, /provider|model|prompt|token|publication_approved/u);
    assert.equal(finalStories[0].insights[0].quote.text, "safe reviewed canary a");

    const parityRoot = join(first.root, "bare-transport");
    const boundary = {
      coverage: join(first.root, "coverage.json"),
      sourcePrivacy: join(first.root, "source-privacy.json"),
      review: join(first.root, "review"),
    };
    runOk(process.execPath, [prepare, "prepare", "story", first.semanticPath,
      boundary.coverage, boundary.sourcePrivacy, boundary.review, parityRoot, ...storyAuthorityArgs]);
    assert.equal(
      await readFile(join(first.transport, "story", "shards.json"), "utf8"),
      await readFile(join(parityRoot, "story", "shards.json"), "utf8"),
    );
    assert.equal(
      await readFile(join(first.transport, "story", "inputs", "story-0001.json"), "utf8"),
      await readFile(join(parityRoot, "story", "inputs", "story-0001.json"), "utf8"),
    );
  } finally {
    await first.cleanup();
    await reordered.cleanup();
  }
});

test("pending Source Privacy preserves exact raw Story and Insight narrative without deciding or applying spans", async () => {
  const reviewedNarrative = "safe reviewed canary a";
  const fragmentStart = Array.from(reviewedNarrative).length - 1;
  const initialTarget = "story-a::title";
  const flow = await createFlow({
    suffixes: ["a"],
    sourceRedactions: [{
      suffix: "a", startOffset: fragmentStart, endOffset: fragmentStart + 1,
      reviewState: "needs_confirmation",
    }],
    storyPrivacyReleaseTargets: [initialTarget],
  });
  try {
    const insightManifest = await readJson(join(flow.transport, "insight", "shards.json"));
    assert.equal(insightManifest.shards.length, 1);
    const sourcePrivacy = await readJson(flow.sourcePrivacy);
    assert.deepEqual(sourcePrivacy.redactions.map((row) => ({
      reviewState: row.review_state, startOffset: row.start_offset, endOffset: row.end_offset,
    })), [{
      reviewState: "needs_confirmation", startOffset: fragmentStart, endOffset: fragmentStart + 1,
    }]);
    const storyManifest = await readJson(join(flow.transport, "story", "shards.json"));
    const storyInput = await readJson(join(flow.transport, ...storyManifest.shards[0].inputPath.split("/")));
    assert.equal(storyInput.payload.ownerBundles[0].reviewedNarrative[0].narrative, reviewedNarrative);
    const insightShard = insightManifest.shards[0];
    const input = await readJson(join(flow.transport, ...insightShard.inputPath.split("/")));
    assert.deepEqual(input.payload.reviewedNarrative, [{
      id: "event-a", documentId: "doc-canary", narrative: reviewedNarrative,
    }]);

    const recorded = await readJson(join(
      flow.transport, "insight", "records", insightShard.id, "output.json",
    ));
    assert.equal(recorded[0].insights[0].quote.text, reviewedNarrative);
    const finalizedStory = parseStorySource((await readJson(flow.candidates))[0].summary);
    assert.equal(finalizedStory.insights[0].quote.text, reviewedNarrative);

    const authority = await readJson(flow.preparationManifest);
    assert.ok(authority.storyPrivacy.targetProposals.every((row) => !row.targetId.includes("::insight:")));
    const candidate = authority.storyPrivacy.candidates.find((row) => (
      row.releaseTargets.includes(initialTarget)
    ));
    assert.equal(candidate.reviewState, "needs_confirmation");
    const proposal = authority.storyPrivacy.targetProposals.find((row) => row.targetId === initialTarget);
    assert.equal(proposal.proposedText, "Canary Anonymous");
    assert.deepEqual(proposal.occurrences.map(({ originalStartOffset, originalEndOffset }) => ({
      originalStartOffset, originalEndOffset,
    })), [{ originalStartOffset: 7, originalEndOffset: 8 }]);
  } finally {
    await flow.cleanup();
  }
});

test("finalized Coverage owner IDs form indivisible self-contained Story bundles", async () => {
  const suffixes = ["a", "b", "c", "d", "e"];
  const value = await prepareStoryOnly({
    suffixes,
    sourceRedactions: [{
      suffix: "a", startOffset: 0, endOffset: Array.from("safe reviewed canary").length,
    }],
    coverageRows: suffixes.map((suffix) => ({
      unitId: `unit-${suffix}`, disposition: "represented", ownerId: "story-complete-owner",
    })),
  });
  try {
    assert.equal(value.prepared.status, 0, value.prepared.stderr);
    const manifest = await readJson(join(value.transport, "story", "shards.json"));
    assert.equal(manifest.shards.length, 1);
    assert.deepEqual(manifest.unitIds, ["story-complete-owner"]);
    const input = await readJson(join(value.transport, ...manifest.shards[0].inputPath.split("/")));
    assert.deepEqual(input.unitIds, ["story-complete-owner"]);
    assert.equal(input.payload.ownerBundles.length, 1);
    const bundle = input.payload.ownerBundles[0];
    assert.equal(bundle.ownerId, "story-complete-owner");
    assert.deepEqual(bundle.semanticUnits.map((unit) => unit.id), suffixes.map((suffix) => `unit-${suffix}`));
    assert.deepEqual(bundle.reviewedNarrative.map((row) => row.id), suffixes.map((suffix) => `event-${suffix}`));
    assert.equal(bundle.reviewedNarrative[0].narrative, "safe reviewed canary a");
    assert.ok(bundle.reviewedNarrative.every((row) => (
      row.actorEquivalence.startsWith("actor-") && !Object.hasOwn(row, "actorId")
    )));
    const workerBytes = await readFile(join(value.transport, ...manifest.shards[0].inputPath.split("/")), "utf8");
    assert.doesNotMatch(workerBytes, /sourcePrivacy|redactions|provider|model|OUTSIDE-EXACT-BOUND-REVIEWED-NARRATIVE/u);
    const authorityBytes = await readFile(join(value.transport, "story", "validation-authority.json"), "utf8");
    assert.doesNotMatch(authorityBytes,
      /safe reviewed canary|narrative|content|actorId|OUTSIDE-EXACT-BOUND-REVIEWED-NARRATIVE/u);
  } finally {
    await value.cleanup();
  }
});

test("Story preparation preserves validated opaque actor topology and rejects raw shapes pre-authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "story-actor-topology-"));
  try {
    const semantic = semanticAuthority();
    const projectMap = {
      primary_project: semantic.projectId, summary: "Synthetic.",
      projects: [{ name: semantic.projectId, event_count: 2, reason: "Reviewed boundary." }],
      source_authority: { sourceDigest: semantic.sourceDigest, sourceCount: 1, contributionCount: 2 },
      semantic_units: semantic.units.map((unit) => ({ id: unit.id, kind: unit.kind, members: unit.members })),
      semantic_manifest: semantic,
    };
    const semanticPath = join(root, "semantic.json");
    await json(semanticPath, semantic);
    const boundary = await reviewedBoundary(root, projectMap, semantic);
    const eventsPath = join(boundary.review, "trajectories", "doc-canary", "events.jsonl");
    const events = (await readFile(eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
    const parent = `actor-${digest("parent")}`;
    events[0].actor = { id: `actor-${digest("alice.smith")}`, type: "field researcher", parent_id: parent };
    events[0].event_type = "field_note";
    events[0].payload.interaction_direction = "agent_to_subagent";
    events[0].relations = [{ type: "reply_to", target: events[1].relation_id }];
    events[1].actor = { id: `actor-${digest("alice-smith")}`, type: "研究员", parent_id: parent };
    events[1].event_type = "观察记录";
    events[1].payload.interaction_direction = "subagent_to_agent";
    const writeEvents = () => writeFile(eventsPath, `${events.map(JSON.stringify).join("\n")}\n`, "utf8");
    await writeEvents();
    const privacy = await readJson(boundary.sourcePrivacy);
    privacy.job.source_digest = await computeSourceDigest(events.map((event) => ({
      id: event.event_id, document_id: event.trajectory_id, sequence: event.sequence,
      event_type: event.event_type, actor_type: event.actor.type,
      timestamp: event.timestamp, content: event.payload.text,
    })));
    await json(boundary.sourcePrivacy, privacy);

    for (const [name, mutate] of [
      ["raw", (event) => { event.actor.id = "RAW-ACTOR-SENTINEL"; }],
      ["raw-parent", (event) => { event.actor.parent_id = "RAW-PARENT-SENTINEL"; }],
      ["unknown-shape", (event) => { event.actor.display_name = "RAW-NAME-SENTINEL"; }],
    ]) {
      const original = structuredClone(events[0].actor);
      mutate(events[0]);
      await writeEvents();
      const transport = join(root, `invalid-${name}`);
      const rejected = run(process.execPath, [prepare, "prepare", "story", semanticPath,
        boundary.coverage, boundary.sourcePrivacy, boundary.review, transport, ...storyAuthorityArgs]);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /^REVIEWED_SOURCE_INVALID\r?\n$/u);
      assert.doesNotMatch(`${rejected.stdout}${rejected.stderr}`, /RAW-/u);
      assert.equal(existsSync(join(transport, "story", "validation-authority.json")), false);
      events[0].actor = original;
    }
    for (const [name, mutate] of [
      ["foreign-relation", (rows) => { rows[0].relations[0].target = `event-${"f".repeat(64)}`; }],
      ["duplicate-relation-id", (rows) => { rows[1].relation_id = rows[0].relation_id; }],
    ]) {
      const original = structuredClone(events);
      mutate(events);
      await writeEvents();
      const transport = join(root, `invalid-${name}`);
      const rejected = run(process.execPath, [prepare, "prepare", "story", semanticPath,
        boundary.coverage, boundary.sourcePrivacy, boundary.review, transport, ...storyAuthorityArgs]);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /^REVIEWED_SOURCE_INVALID\r?\n$/u);
      assert.equal(existsSync(join(transport, "story", "validation-authority.json")), false);
      assert.equal(existsSync(join(transport, "story", "records")), false);
      events.splice(0, events.length, ...original);
    }
    await writeEvents();
    const transport = join(root, "valid");
    runOk(process.execPath, [prepare, "prepare", "story", semanticPath,
      boundary.coverage, boundary.sourcePrivacy, boundary.review, transport, ...storyAuthorityArgs]);
    const authority = await readJson(join(transport, "story", "validation-authority.json"));
    assert.notEqual(authority.evidence[0].actorEquivalence, authority.evidence[1].actorEquivalence);
    assert.equal(authority.evidence[0].parentActorEquivalence, parent);
    assert.equal(authority.evidence[1].parentActorEquivalence, parent);
    assert.equal(authority.evidence[0].interactionDirection, "agent_to_subagent");
    assert.deepEqual(authority.evidence[0].relations, [{
      type: "reply_to", target: events[1].relation_id,
    }]);
    const input = await readFile(join(transport, "story", "inputs", "story-0001.json"), "utf8");
    assert.doesNotMatch(input, /alice\.smith|alice-smith|RAW-/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reordered equivalent semantic, Coverage, and reviewed inputs produce byte-identical Story authority", async () => {
  const first = await prepareStoryOnly({ suffixes: ["a", "b", "c"] });
  const reordered = await prepareStoryOnly({
    suffixes: ["a", "b", "c"], reverseTransportInputs: true,
  });
  try {
    assert.equal(first.prepared.status, 0, first.prepared.stderr);
    assert.equal(reordered.prepared.status, 0, reordered.prepared.stderr);
    const firstManifest = await readJson(join(first.transport, "story", "shards.json"));
    const secondManifest = await readJson(join(reordered.transport, "story", "shards.json"));
    assert.deepEqual(secondManifest, firstManifest);
    assert.deepEqual(
      await readFile(join(reordered.transport, "story", "validation-authority.json")),
      await readFile(join(first.transport, "story", "validation-authority.json")),
    );
    for (const shard of firstManifest.shards) {
      assert.deepEqual(
        await readFile(join(reordered.transport, ...shard.inputPath.split("/"))),
        await readFile(join(first.transport, ...shard.inputPath.split("/"))),
      );
    }
  } finally {
    await first.cleanup();
    await reordered.cleanup();
  }
});

test("zero represented owners fail before Story lane installation without inventing a carrier", async () => {
  const value = await prepareStoryOnly({
    coverageRows: ["a", "b"].map((suffix) => ({
      unitId: `unit-${suffix}`, disposition: "excluded", exclusionReason: "outside_story_scope",
    })),
  });
  try {
    assert.notEqual(value.prepared.status, 0);
    assert.match(value.prepared.stderr, /^STORY_ZERO_REPRESENTED_OWNER_UNSUPPORTED\r?\n$/u);
    assert.equal(existsSync(join(value.transport, "story")), false);
  } finally {
    await value.cleanup();
  }
});

test("Story language policy selects strong input and stops mixed input until one explicit continuation", async () => {
  const english = await prepareStoryOnly({ suffixes: ["a"] });
  const chinese = await prepareStoryOnly({ suffixes: ["a"], language: "zh" });
  const mixedNoChoice = await prepareStoryOnly({
    narratives: { a: "englishreviewedtext", b: "中文审阅内容中文审阅内容" },
  });
  const allEnglish = await prepareStoryOnly({
    narratives: { a: "englishreviewedtext", b: "中文审阅内容中文审阅内容" },
    languageChoice: "all-english",
  });
  const allChinese = await prepareStoryOnly({
    narratives: { a: "englishreviewedtext", b: "中文审阅内容中文审阅内容" },
    languageChoice: "all-chinese",
  });
  const preserved = await prepareStoryOnly({
    narratives: { a: "englishreviewedtext", b: "中文审阅内容中文审阅内容" },
    languageChoice: "preserve-per-story",
  });
  try {
    for (const [flow, detectedLanguage, selection, languages] of [
      [english, "en", "all-english", ["en"]],
      [chinese, "zh", "all-chinese", ["zh"]],
      [allEnglish, "mixed", "all-english", ["en", "en"]],
      [allChinese, "mixed", "all-chinese", ["zh", "zh"]],
      [preserved, "mixed", "preserve-per-story", ["en", "zh"]],
    ]) {
      assert.equal(flow.prepared.status, 0, flow.prepared.stderr);
      const authority = await readJson(join(flow.transport, "story", "validation-authority.json"));
      assert.equal(authority.languagePolicy.workflowRunId, "public-canary-run");
      assert.equal(authority.languagePolicy.sourceRevision, 4);
      assert.equal(authority.languagePolicy.detectedLanguage, detectedLanguage);
      assert.equal(authority.languagePolicy.selection, selection);
      assert.deepEqual(authority.languagePolicy.stories.map((row) => row.language), languages);
      const policyDigest = digest(authority.languagePolicy);
      const manifest = await readJson(join(flow.transport, "story", "shards.json"));
      for (const shard of manifest.shards) {
        const input = await readJson(join(flow.transport, ...shard.inputPath.split("/")));
        assert.equal(input.payload.languagePolicy.policyDigest, policyDigest);
        assert.equal(input.payload.languagePolicy.workflowRunId, "public-canary-run");
        assert.equal(input.payload.languagePolicy.sourceRevision, 4);
      }
    }
    assert.notEqual(mixedNoChoice.prepared.status, 0);
    assert.match(mixedNoChoice.prepared.stderr, /^STORY_LANGUAGE_CHOICE_REQUIRED\r?\n$/u);
    assert.equal(existsSync(join(mixedNoChoice.transport, "story", "shards.json")), false);
    assert.equal(existsSync(join(mixedNoChoice.transport, "story", "records")), false);
  } finally {
    await Promise.all([english, chinese, mixedNoChoice, allEnglish, allChinese, preserved]
      .map((flow) => flow.cleanup()));
  }
});

test("preserve-per-Story requires an exact mapping for an ambiguous owner", async () => {
  const narratives = { a: "abcdefghij中文中文中文中文中文" };
  const missing = await prepareStoryOnly({
    suffixes: ["a"], narratives, languageChoice: "preserve-per-story",
  });
  const mapped = await prepareStoryOnly({
    suffixes: ["a"], narratives, languageChoice: "preserve-per-story",
    storyLanguageMap: { "story-a": "zh" },
  });
  try {
    assert.notEqual(missing.prepared.status, 0);
    assert.match(missing.prepared.stderr, /^STORY_LANGUAGE_MAPPING_REQUIRED\r?\n$/u);
    assert.equal(existsSync(join(missing.transport, "story", "shards.json")), false);
    assert.equal(mapped.prepared.status, 0, mapped.prepared.stderr);
    const authority = await readJson(join(mapped.transport, "story", "validation-authority.json"));
    assert.deepEqual(authority.languagePolicy.stories, [{ storyKey: "story-a", language: "zh" }]);
  } finally {
    await missing.cleanup();
    await mapped.cleanup();
  }
});

test("one oversized owner bundle fails before Story lane installation instead of splitting", async () => {
  const root = await mkdtemp(join(tmpdir(), "story-oversized-owner-"));
  try {
    const suffixes = ["a", "b", "c", "d", "e", "f", "g"];
    const initial = semanticAuthority({ suffixes });
    const units = initial.units.map((unit) => ({
      ...unit,
      storyProjection: {
        label: unit.storyProjection.label,
        summary: "y".repeat(300_000),
      },
    }));
    const core = {
      projectId: initial.projectId,
      revision: initial.revision,
      sourceDigest: initial.sourceDigest,
      universeDigest: initial.universeDigest,
      registryDigest: initial.registryDigest,
      units,
    };
    const semantic = { ...core, manifestDigest: digest(core) };
    const projectMap = {
      primary_project: semantic.projectId,
      summary: "Oversized owner canary.",
      projects: [{ name: semantic.projectId, event_count: suffixes.length, reason: "Reviewed boundary." }],
      source_authority: { sourceDigest: semantic.sourceDigest, sourceCount: 1, contributionCount: suffixes.length },
      semantic_units: units.map((unit) => ({ id: unit.id, kind: unit.kind, members: unit.members })),
      semantic_manifest: semantic,
    };
    const projectMapPath = join(root, "project-map.json");
    await json(projectMapPath, projectMap);
    const boundary = await reviewedBoundary(root, projectMap, semantic, suffixes.map((suffix) => ({
      unitId: `unit-${suffix}`, disposition: "represented", ownerId: "story-oversized-owner",
    })), { narrativeBytes: 3_350_000 });
    const transport = join(root, "transport");
    const result = run(process.execPath, [prepare, "prepare", "story", projectMapPath,
      boundary.coverage, boundary.sourcePrivacy, boundary.review, transport, ...storyAuthorityArgs]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /^STORY_OWNER_BUNDLE_TOO_LARGE\r?\n$/u);
    assert.equal(existsSync(join(transport, "story")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("laboratory notes cross real Story and Insight shard waves without domain special cases", async () => {
  const options = {
    suffixes: ["uno", "dos", "tres", "cuatro", "cinco"],
    projectId: "Cuaderno de Laboratorio",
    kinds: ["experiment_observation", "instrument_calibration", "hypothesis_revision"],
    documentId: "notas-laboratorio",
    language: "zh",
    narrativeBytes: 300_000,
    insightSuffixes: ["uno", "tres"],
  };
  const first = await createFlow(options);
  const reordered = await createFlow({ ...options, reverse: true, reverseManifests: true });
  try {
    const storyManifest = await readJson(join(first.transport, "story", "shards.json"));
    const insightManifest = await readJson(join(first.transport, "insight", "shards.json"));
    assert.ok(storyManifest.shards.length >= 2);
    assert.ok(insightManifest.shards.length >= 2);
    assert.equal(await readFile(first.candidates, "utf8"), await readFile(reordered.candidates, "utf8"));
    assert.equal(await readFile(first.preparationManifest, "utf8"),
      await readFile(reordered.preparationManifest, "utf8"));
    const candidates = await readJson(first.candidates);
    assert.equal(candidates.length, 5);
    assert.equal(candidates.reduce((total, row) => (
      total + parseStorySource(row.summary).insights.length
    ), 0), 2);
    assert.match(candidates[0].summary, /经过审阅|中文观察/u);
    console.log("THIRD_DOMAIN_CANARY", JSON.stringify({
      domain: "laboratory-notes", language: "zh", records: options.suffixes.length,
      semanticKinds: new Set(options.kinds).size, chapters: candidates.length, insights: 2,
      storyShards: storyManifest.shards.length, insightShards: insightManifest.shards.length,
      reorderedCandidatesByteIdentical: true, reorderedAuthorityByteIdentical: true,
    }));
  } finally {
    await first.cleanup();
    await reordered.cleanup();
  }
});

test("multi-owner multi-shard recording accepts one cross-shard Phase and injects exclusions once", async () => {
  const value = await prepareStoryOnly({
    suffixes: ["a", "b", "c"],
    narrativeBytes: 600_000,
    coverageRows: [
      { unitId: "unit-a", disposition: "represented", ownerId: "story-a" },
      { unitId: "unit-b", disposition: "represented", ownerId: "story-b" },
      { unitId: "unit-c", disposition: "excluded", exclusionReason: "outside_story_scope" },
    ],
  });
  try {
    assert.equal(value.prepared.status, 0, value.prepared.stderr);
    const stories = ["a", "b"].map((suffix) => ({
      id: `event-${suffix}`,
      story: {
        ...storySource(suffix, value.semantic, value.boundary.coverageAuthority),
        phase: { id: "phase-shared", label: "Shared build" },
      },
    }));
    const batch = await storyBatchFiles(value.transport, value.root, stories, "cross-shard");
    assert.ok(batch.manifest.shards.length >= 2);
    assert.ok(batch.manifest.shards.every((shard) => shard.unitIds.length === 1));
    const workerBytes = (await Promise.all(batch.manifest.shards.map((shard) => (
      readFile(join(value.transport, ...shard.inputPath.split("/")), "utf8")
    )))).join("\n");
    assert.doesNotMatch(workerBytes, /event-c|safe reviewed canary c/u);
    runOk(process.execPath, [record, value.transport, "story", batch.proposalDirectory,
      batch.editorialReviewPath, batch.phasePath, "--correction-attempt-count", "0"]);
    const recordsRoot = join(value.transport, "story", "records");
    assert.equal((await Promise.all(batch.manifest.shards.map((shard) => (
      readJson(join(recordsRoot, shard.id, "receipt.json"))
    )))).length, batch.manifest.shards.length);
    const baseCandidates = join(value.root, "base.json");
    runOk(process.execPath, [prepare, "compose", "story", value.transport, baseCandidates]);
    const chapters = (await readJson(baseCandidates)).map((row) => parseStorySource(row.summary));
    assert.ok(chapters.every((chapter) => chapter.phase.id === "phase-shared"));
    assert.deepEqual(chapters[0].coverage.excludedUnits, [{
      unitId: "unit-c", reason: "outside_story_scope",
    }]);
    assert.ok(chapters.slice(1).every((chapter) => chapter.coverage.excludedUnits.length === 0));
    assert.ok(chapters.every((chapter) => !chapter.story.blocks.some((block) => /canary c/u.test(block.text))));
  } finally {
    await value.cleanup();
  }
});

test("generated Story transition and supported chips survive recording and composition", async () => {
  const value = await prepareStoryOnly({ suffixes: ["a", "b"] });
  try {
    assert.equal(value.prepared.status, 0, value.prepared.stderr);
    const records = ["a", "b"].map((suffix) => ({
      id: `event-${suffix}`,
      story: storySource(suffix, value.semantic, value.boundary.coverageAuthority),
    }));
    records[0].story.transition = {
      before: "The reviewed boundary was not yet explicit.",
      after: "The reviewed boundary is explicit; release remains open pending human review.",
    };
    records[0].story.chips = ["explicit reviewed boundary", "open human review"];
    records[1].story.chips = ["reviewed evidence only"];

    const batch = await storyBatchFiles(value.transport, value.root, records, "timeline-metadata");
    runOk(process.execPath, [record, value.transport, "story", batch.proposalDirectory,
      batch.editorialReviewPath, batch.phasePath, "--correction-attempt-count", "0"]);
    const composedPath = join(value.root, "timeline-metadata-base.json");
    runOk(process.execPath, [prepare, "compose", "story", value.transport, composedPath]);
    const stories = (await readJson(composedPath)).map((row) => parseStorySource(row.summary));
    const changed = stories.find((story) => story.key === "story-a");
    const unchanged = stories.find((story) => story.key === "story-b");
    assert.deepEqual(changed.transition, records[0].story.transition);
    assert.deepEqual(changed.chips, records[0].story.chips);
    assert.deepEqual(timelinePresentation(changed), {
      before: records[0].story.transition.before,
      after: records[0].story.transition.after,
      chips: records[0].story.chips,
    });
    assert.equal(Object.hasOwn(unchanged, "transition"), false);
    assert.deepEqual(unchanged.chips, records[1].story.chips);
  } finally {
    await value.cleanup();
  }
});

test("new Story chips fail structurally or at the exact claims editorial gate before receipt", async () => {
  const value = await prepareStoryOnly({ suffixes: ["a"] });
  try {
    assert.equal(value.prepared.status, 0, value.prepared.stderr);
    const records = [{
      id: "event-a",
      story: storySource("a", value.semantic, value.boundary.coverageAuthority),
    }];
    const batch = await storyBatchFiles(value.transport, value.root, records, "chip-contract");
    const proposalPath = join(batch.proposalDirectory, `${batch.manifest.shards[0].id}.json`);
    const validProposal = await readJson(proposalPath);
    const invoke = () => run(process.execPath, [record, value.transport, "story",
      batch.proposalDirectory, batch.editorialReviewPath, batch.phasePath,
      "--correction-attempt-count", "0"]);
    const assertNoAuthority = () => {
      assert.equal(existsSync(join(value.transport, "story", "records")), false);
    };
    const invalidCases = {
      missing: (proposal) => { delete proposal[0].chapter.chips; },
      empty: (proposal) => { proposal[0].chapter.chips = []; },
      duplicate: (proposal) => { proposal[0].chapter.chips = ["supported", "supported"]; },
      malformed: (proposal) => { proposal[0].chapter.chips = ["   "]; },
      overLimit: (proposal) => { proposal[0].chapter.chips = Array.from({ length: 13 }, (_, i) => `chip-${i}`); },
      overBound: (proposal) => { proposal[0].chapter.chips = ["x".repeat(201)]; },
    };
    for (const [name, mutate] of Object.entries(invalidCases)) {
      const proposal = structuredClone(validProposal);
      mutate(proposal);
      await json(proposalPath, proposal);
      const rejected = invoke();
      assert.notEqual(rejected.status, 0, name);
      assert.match(rejected.stderr, /^STORY_PROPOSAL_INVALID\r?\n$/u, name);
      assertNoAuthority();
    }

    await json(proposalPath, validProposal);
    const obsoleteKeyReview = storyEditorialReviews(validProposal, batch.manifest.inputDigest);
    obsoleteKeyReview[0].criteria.interactionsAreEvidenceSupported = true;
    delete obsoleteKeyReview[0].criteria.claimsAreEvidenceSupported;
    await json(batch.editorialReviewPath, obsoleteKeyReview);
    const obsoleteKey = invoke();
    assert.notEqual(obsoleteKey.status, 0);
    assert.match(obsoleteKey.stderr, /^STORY_EDITORIAL_REVIEW_INVALID\r?\n$/u);
    assertNoAuthority();

    const unsupportedProposal = structuredClone(validProposal);
    unsupportedProposal[0].chapter.chips = ["Unsupported speculative success"];
    await json(proposalPath, unsupportedProposal);
    await refreshStoryEditorialReview(batch, {
      "story-a": { claimsAreEvidenceSupported: false },
    });
    const unsupported = invoke();
    assert.notEqual(unsupported.status, 0);
    assert.match(unsupported.stderr, /^STORY_EDITORIAL_REVIEW_REJECTED\r?\n$/u);
    assertNoAuthority();

    await json(proposalPath, validProposal);
    await refreshStoryEditorialReview(batch);
    runOk(process.execPath, [record, value.transport, "story", batch.proposalDirectory,
      batch.editorialReviewPath, batch.phasePath, "--correction-attempt-count", "1"]);
    const output = await readJson(join(
      value.transport, "story", "records", batch.manifest.shards[0].id, "output.json",
    ));
    assert.deepEqual(output[0].story.chips, validProposal[0].chapter.chips);
    assert.equal(existsSync(join(
      value.transport, "story", "records", batch.manifest.shards[0].id, "receipt.json",
    )), true);
  } finally {
    await value.cleanup();
  }
});

test("real multi-shard manifests reject missing, duplicate, overlap, and foreign assignments", async () => {
  const flow = await createFlow({
    suffixes: ["a", "b", "c", "d", "e"], narrativeBytes: 300_000,
  });
  try {
    const mutations = {
      missing: (manifest) => { manifest.shards.pop(); },
      duplicate: (manifest) => { manifest.shards.push({ ...manifest.shards[0] }); },
      overlap: (manifest) => { manifest.shards[1].unitIds.push(manifest.shards[0].unitIds[0]); },
      foreign: (manifest) => { manifest.shards[1].unitIds[0] = "unit-foreign"; },
    };
    for (const [name, mutate] of Object.entries(mutations)) {
      const variant = join(flow.root, `transport-${name}`);
      await cp(flow.transport, variant, { recursive: true });
      const manifestPath = join(variant, "story", "shards.json");
      const manifest = await readJson(manifestPath);
      assert.ok(manifest.shards.length >= 2);
      mutate(manifest);
      await json(manifestPath, manifest);
      const destination = join(flow.root, `terminal-${name}.json`);
      await writeFile(destination, "sentinel\n", "utf8");
      const rejected = run(process.execPath, [finalize,
        flow.projectMapPath, flow.candidates, variant, flow.preferenceBundle, destination,
        "--workflow-run-id", "public-canary-run", "--source-revision", "4",
      ]);
      assert.notEqual(rejected.status, 0, name);
      assert.match(rejected.stderr, /^(SHARD_INVALID|SHARD_MANIFEST_UNIVERSE_INVALID)\r?\n$/u);
      assert.equal(await readFile(destination, "utf8"), "sentinel\n");
    }
  } finally {
    await flow.cleanup();
  }
});

test("public commands bind zero Insight/Preference and zero-candidate total Privacy results", async () => {
  const flow = await createFlow({ completedZero: true });
  try {
    const manifest = await readJson(flow.preparationManifest);
    for (const lane of ["insight", "preference"]) {
      const receipt = manifest.receipts.find((item) => item.lane === lane);
      assert.equal(receipt.outputCount, 0);
      assert.equal(receipt.outputDigest, "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
    }
    assert.equal(manifest.storyPrivacy.candidates.length, 0);
    assert.equal(manifest.receipts.find((item) => item.lane === "story_privacy").outputCount,
      manifest.storyPrivacy.targetProposals.length);
    assert.ok(manifest.storyPrivacy.targetProposals.length > 0);
  } finally {
    await flow.cleanup();
  }
});

test("lab_notebook crosses real Preference preparation, record, and finalization", async () => {
  const flow = await createFlow({ documentKind: "lab_notebook" });
  try {
    const bundle = await readJson(flow.preferenceBundle);
    assert.equal(bundle.probes[0].documentKind, "lab_notebook");
    assert.equal((await readJson(flow.preparationManifest)).receipts.find((receipt) => (
      receipt.lane === "preference"
    )).outputCount, 1);
  } finally { await flow.cleanup(); }
});

test("Preference recorder accepts 20 questions and 500 evidence IDs, rejecting 21 and 501 before receipt", async () => {
  const flow = await createFlow({ deferPreferenceRecord: true, preferenceEvidenceCount: 500 });
  try {
    const shard = flow.preferenceManifest.shards[0];
    const recordRoot = join(flow.transport, "preference", "records", shard.id);
    const outputPath = join(recordRoot, "output.json");
    const receiptPath = join(recordRoot, "receipt.json");
    const original = await readJson(flow.preferenceBundle);
    const eventIds = original.probes[0].eventIds;
    const probes = [{ ...structuredClone(original.probes[0]), id: "probe-00" }];
    const bulkDecisions = Array.from({ length: 19 }, (_, index) => ({
      id: `bulk-${String(index).padStart(2, "0")}`, kind: "privacy", count: 1,
      question: `Keep reviewed group ${index}?`, evidenceSample: eventIds, presentations: {},
    }));
    const accepted = { ...original, probes, bulkDecisions, outputCount: 20 };
    accepted.outputDigest = digest(canonicalPreferenceQuestionBatch(probes, bulkDecisions));
    const invalid = [
      (value) => { value.probes[0].eventIds.push("event-501"); },
      (value) => { value.bulkDecisions[0].evidenceSample.push("event-501"); },
      (value) => { value.bulkDecisions.push({ ...structuredClone(value.bulkDecisions[0]), id: "bulk-20" }); value.outputCount = 21; },
    ];
    for (const mutate of invalid) {
      const candidate = structuredClone(accepted);
      mutate(candidate);
      candidate.outputDigest = digest(canonicalPreferenceQuestionBatch(candidate.probes, candidate.bulkDecisions));
      await json(flow.preferenceBundle, candidate);
      const rejected = run(process.execPath, [record, flow.transport, "preference", shard.id,
        flow.preferenceBundle]);
      assert.notEqual(rejected.status, 0);
      assert.equal(existsSync(outputPath), false);
      assert.equal(existsSync(receiptPath), false);
    }
    await json(flow.preferenceBundle, accepted);
    runOk(process.execPath, [record, flow.transport, "preference", shard.id, flow.preferenceBundle]);
    assert.equal((await readJson(receiptPath)).outputCount, 20);
  } finally { await flow.cleanup(); }
});

test("Preference recorder rejects zero before receipt, accepts corrected authority, and stays immutable", async () => {
  const flow = await createFlow({ deferPreferenceRecord: true });
  try {
    const shard = flow.preferenceManifest.shards[0];
    const inputPath = join(flow.transport, ...shard.inputPath.split("/"));
    const recordRoot = join(flow.transport, "preference", "records", shard.id);
    const outputPath = join(recordRoot, "output.json");
    const receiptPath = join(recordRoot, "receipt.json");
    const inputBefore = await readFile(inputPath);
    const validBundle = await readJson(flow.preferenceBundle);
    await json(flow.preferenceBundle, { ...validBundle, sourceRevision: 0 });

    const rejected = run(process.execPath, [record, flow.transport, "preference", shard.id,
      flow.preferenceBundle]);
    assert.notEqual(rejected.status, 0);
    assert.equal(rejected.stdout, "");
    assert.match(rejected.stderr, /^PREFERENCE_BUNDLE_INVALID\r?\n$/u);
    assert.equal(existsSync(outputPath), false);
    assert.equal(existsSync(receiptPath), false);
    assert.deepEqual(await readFile(inputPath), inputBefore);

    runOk("python", [validateProbes,
      "--context", flow.preferenceContext,
      "--candidates", flow.preferenceCandidates,
      "--workflow-run-id", "public-canary-run",
      "--source-revision", "4",
      "--output", flow.preferenceBundle,
    ]);
    runOk(process.execPath, [record, flow.transport, "preference", shard.id,
      flow.preferenceBundle]);
    assert.deepEqual(await readFile(inputPath), inputBefore);
    const outputBefore = await readFile(outputPath);
    const receiptBefore = await readFile(receiptPath);

    const differingCandidates = await readJson(flow.preferenceCandidates);
    differingCandidates.probes[0].question = "Which reviewed boundary should the agent retain?";
    await json(flow.preferenceCandidates, differingCandidates);
    runOk("python", [validateProbes,
      "--context", flow.preferenceContext,
      "--candidates", flow.preferenceCandidates,
      "--workflow-run-id", "public-canary-run",
      "--source-revision", "4",
      "--output", flow.preferenceBundle,
    ]);
    const immutable = run(process.execPath, [record, flow.transport, "preference", shard.id,
      flow.preferenceBundle]);
    assert.notEqual(immutable.status, 0);
    assert.match(immutable.stderr, /^AUTHORITY_IMMUTABLE\r?\n$/u);
    assert.deepEqual(await readFile(outputPath), outputBefore);
    assert.deepEqual(await readFile(receiptPath), receiptBefore);
    assert.deepEqual(await readFile(inputPath), inputBefore);
  } finally {
    await flow.cleanup();
  }
});

test("Story batch recorder permits pre-receipt correction and makes the complete authority immutable", async () => {
  const root = await mkdtemp(join(tmpdir(), "story-recorder-atomic-"));
  try {
    const semantic = semanticAuthority();
    const semanticPath = join(root, "semantic.json");
    const transport = join(root, "transport");
    await json(semanticPath, semantic);
    const projectMapPath = join(root, "project-map.json");
    await json(projectMapPath, {
      primary_project: semantic.projectId, summary: "Synthetic.",
      projects: [{ name: semantic.projectId, event_count: 2, reason: "One repo-scoped projected contribution universe." }],
      source_authority: { sourceDigest: semantic.sourceDigest, sourceCount: 1, contributionCount: 2 },
      semantic_units: semantic.units.map((unit) => ({ id: unit.id, kind: unit.kind, members: unit.members })),
      semantic_manifest: semantic,
    });
    const boundary = await reviewedBoundary(root, await readJson(projectMapPath), semantic);
    runOk(process.execPath, [prepare, "prepare", "story", semanticPath,
      boundary.coverage, boundary.sourcePrivacy, boundary.review, transport, ...storyAuthorityArgs]);
    const validRecords = ["a", "b"].map((suffix) => ({
      id: `event-${suffix}`,
      story: storySource(suffix, semantic, boundary.coverageAuthority),
    }));
    const batch = await storyBatchFiles(transport, root, validRecords, "correction");
    const firstProposalPath = join(batch.proposalDirectory, `${batch.manifest.shards[0].id}.json`);
    const languageMismatch = await readJson(firstProposalPath);
    languageMismatch[0].chapter.title = "中文标题";
    languageMismatch[0].chapter.overview = "这是一段完整的中文概述。";
    languageMismatch[0].chapter.people = languageMismatch[0].chapter.people.map((person) => ({
      ...person, releaseLabel: "参与者", role: "负责人", description: "负责人记录了中文过程。",
    }));
    languageMismatch[0].chapter.story.blocks = languageMismatch[0].chapter.story.blocks.map((block) => ({
      ...block, text: "这是一段完整且经过审阅的中文故事内容。",
    }));
    await json(firstProposalPath, languageMismatch);
    await refreshStoryEditorialReview(batch);
    const mismatched = run(process.execPath, [record, transport, "story",
      batch.proposalDirectory, batch.editorialReviewPath, batch.phasePath,
      "--correction-attempt-count", "0"]);
    assert.notEqual(mismatched.status, 0);
    assert.match(mismatched.stderr, /^STORY_LANGUAGE_INVALID\r?\n$/u);
    assert.equal(existsSync(join(transport, "story", "records")), false);

    await json(firstProposalPath, batch.manifest.shards[0].unitIds.map((ownerId) => (
      phaseFreeProposal(validRecords.find((candidate) => candidate.story.key === ownerId))
    )));
    await refreshStoryEditorialReview(batch);
    const invalidProposal = await readJson(firstProposalPath);
    invalidProposal[0].ownerId = "foreign";
    await json(firstProposalPath, invalidProposal);
    const invalid = run(process.execPath, [record, transport, "story",
      batch.proposalDirectory, batch.editorialReviewPath, batch.phasePath,
      "--correction-attempt-count", "0"]);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /^STORY_PROPOSAL_OWNER_INVALID\r?\n$/u);
    assert.equal(existsSync(join(transport, "story", "records")), false);

    await json(firstProposalPath, batch.manifest.shards[0].unitIds.map((ownerId) => (
      phaseFreeProposal(validRecords.find((candidate) => candidate.story.key === ownerId))
    )));
    await refreshStoryEditorialReview(batch);
    runOk(process.execPath, [record, transport, "story", batch.proposalDirectory,
      batch.editorialReviewPath, batch.phasePath, "--correction-attempt-count", "1"]);
    const recordRoot = join(transport, "story", "records", batch.manifest.shards[0].id);
    const outputPath = join(recordRoot, "output.json");
    const receiptPath = join(recordRoot, "receipt.json");
    const beforeOutput = await readFile(outputPath);
    const beforeReceipt = await readFile(receiptPath);

    const differing = await readJson(firstProposalPath);
    differing[0].chapter.title = "Different but structurally valid";
    await json(firstProposalPath, differing);
    await refreshStoryEditorialReview(batch);
    const immutable = run(process.execPath, [record, transport, "story",
      batch.proposalDirectory, batch.editorialReviewPath, batch.phasePath,
      "--correction-attempt-count", "1"]);
    assert.notEqual(immutable.status, 0);
    assert.match(immutable.stderr, /^AUTHORITY_IMMUTABLE\r?\n$/u);
    assert.deepEqual(await readFile(outputPath), beforeOutput);
    assert.deepEqual(await readFile(receiptPath), beforeReceipt);

    await rm(receiptPath);
    const partial = run(process.execPath, [record, transport, "story",
      batch.proposalDirectory, batch.editorialReviewPath, batch.phasePath,
      "--correction-attempt-count", "1"]);
    assert.notEqual(partial.status, 0);
    assert.match(partial.stderr, /^PARTIAL_BATCH_REJECTED\r?\n$/u);
    assert.deepEqual(await readFile(outputPath), beforeOutput);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Story batch recorder scopes cross-document local clocks before Phase validation", async () => {
  const eventIdentities = {
    a: { documentId: "meeting-a", timestamp: "2026-01-01T09:00:00" },
    b: { documentId: "meeting-b", timestamp: "2026-01-01T17:00:00" },
    c: { documentId: "meeting-c", timestamp: "2026-01-01T12:00:00" },
  };
  const value = await prepareStoryOnly({ suffixes: ["a", "b", "c"], eventIdentities });
  try {
    assert.equal(value.prepared.status, 0, value.prepared.stderr);
    const phaseOne = { id: "phase-one", label: "Foundation" };
    const phaseTwo = { id: "phase-two", label: "Closing" };
    const phases = { a: phaseOne, b: phaseOne, c: phaseTwo };
    const legacyClockOrder = Object.entries(eventIdentities)
      .sort(([, left], [, right]) => left.timestamp.localeCompare(right.timestamp))
      .map(([suffix]) => phases[suffix].id);
    assert.deepEqual(legacyClockOrder, ["phase-one", "phase-two", "phase-one"]);

    const records = ["a", "b", "c"].map((suffix) => {
      const story = storySource(suffix, value.semantic, value.boundary.coverageAuthority, [], {
        documentId: eventIdentities[suffix].documentId,
      });
      story.phase = phases[suffix];
      return { id: `event-${suffix}`, story };
    });
    const batch = await storyBatchFiles(value.transport, value.root, records, "local-clock-order");
    assert.equal(existsSync(join(value.transport, "story", "records")), false);
    runOk(process.execPath, [record, value.transport, "story", batch.proposalDirectory,
      batch.editorialReviewPath, batch.phasePath, "--correction-attempt-count", "0"]);
    const outputs = (await Promise.all(batch.manifest.shards.map((shard) => (
      readJson(join(value.transport, "story", "records", shard.id, "output.json"))
    )))).flat();
    assert.deepEqual(outputs.map((row) => row.story.key), ["story-a", "story-b", "story-c"]);
    assert.deepEqual(outputs.map((row) => row.story.phase.id), ["phase-one", "phase-one", "phase-two"]);
    assert.ok(batch.manifest.shards.every((shard) => existsSync(
      join(value.transport, "story", "records", shard.id, "receipt.json"),
    )));
  } finally {
    await value.cleanup();
  }
});

test("Story batch rejects incomplete proposals and parent-owned authority fields and shares one correction budget with Phase", async () => {
  const value = await prepareStoryOnly({ suffixes: ["a", "b", "c"] });
  try {
    assert.equal(value.prepared.status, 0, value.prepared.stderr);
    const records = ["a", "b", "c"].map((suffix) => ({
      id: `event-${suffix}`,
      story: storySource(suffix, value.semantic, value.boundary.coverageAuthority),
    }));
    const batch = await storyBatchFiles(value.transport, value.root, records, "rejections");
    const shard = batch.manifest.shards[0];
    const proposalPath = join(batch.proposalDirectory, `${shard.id}.json`);
    const validProposalBytes = await readFile(proposalPath);
    const validPhaseBytes = await readFile(batch.phasePath);
    const invoke = (count = 0) => run(process.execPath, [record, value.transport, "story",
      batch.proposalDirectory, batch.editorialReviewPath, batch.phasePath,
      "--correction-attempt-count", String(count)]);
    const assertNoAuthority = () => assert.equal(existsSync(join(value.transport, "story", "records")), false);

    const exhausted = invoke(3);
    assert.notEqual(exhausted.status, 0);
    assert.match(exhausted.stderr, /^STORY_CORRECTION_EXHAUSTED\r?\n$/u);
    assertNoAuthority();

    for (const [field, forbiddenValue] of Object.entries({
      phase: { id: "forbidden", label: "Forbidden phase" },
      schema: "oxygen.story",
      key: "story-a",
      coverage: {},
      exclusions: [],
      receipt: {},
      authority: {},
    })) {
      const parentAuthored = JSON.parse(validProposalBytes);
      parentAuthored[0].chapter[field] = forbiddenValue;
      await json(proposalPath, parentAuthored);
      const forbidden = invoke(0);
      assert.notEqual(forbidden.status, 0, field);
      assert.match(forbidden.stderr, /^STORY_PROPOSAL_PARENT_FIELD_FORBIDDEN\r?\n$/u, field);
      assertNoAuthority();
    }

    const movedEvidence = JSON.parse(validProposalBytes);
    movedEvidence[0].chapter.evidence.primary = { documentId: "doc-canary", eventId: "event-b" };
    await json(proposalPath, movedEvidence);
    await refreshStoryEditorialReview(batch);
    const foreignEvidence = invoke(0);
    assert.notEqual(foreignEvidence.status, 0);
    assert.match(foreignEvidence.stderr, /^STORY_PROPOSAL_EVIDENCE_INVALID\r?\n$/u);
    assertNoAuthority();

    const duplicateOwner = JSON.parse(validProposalBytes);
    duplicateOwner[1].ownerId = duplicateOwner[0].ownerId;
    await json(proposalPath, duplicateOwner);
    const duplicate = invoke(0);
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /^STORY_PROPOSAL_OWNER_INVALID\r?\n$/u);
    assertNoAuthority();

    await writeFile(proposalPath, validProposalBytes);
    await writeFile(join(batch.proposalDirectory, "extra.json"), "[]", "utf8");
    const extra = invoke(0);
    assert.notEqual(extra.status, 0);
    assert.match(extra.stderr, /^STORY_PROPOSAL_SET_INVALID\r?\n$/u);
    assertNoAuthority();
    await rm(join(batch.proposalDirectory, "extra.json"));

    await rm(proposalPath);
    const missing = invoke(0);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /^STORY_PROPOSAL_SET_INVALID\r?\n$/u);
    assertNoAuthority();

    await writeFile(proposalPath, " ".repeat(25_000_001), "utf8");
    const oversized = invoke(0);
    assert.notEqual(oversized.status, 0);
    assert.match(oversized.stderr, /^PROPOSAL_TOO_LARGE\r?\n$/u);
    assertNoAuthority();

    await writeFile(proposalPath, "{", "utf8");
    const malformed = invoke(0);
    assert.notEqual(malformed.status, 0);
    assert.match(malformed.stderr, /^PROPOSAL_JSON_INVALID\r?\n$/u);
    assertNoAuthority();

    await writeFile(proposalPath, validProposalBytes);
    await refreshStoryEditorialReview(batch);
    const validPhases = JSON.parse(validPhaseBytes);
    const phaseCases = [
      ["missing", validPhases.slice(0, -1), /^STORY_PHASE_ASSIGNMENT_INVALID\r?\n$/u],
      ["duplicate", [validPhases[0], validPhases[0], validPhases[2]], /^STORY_PHASE_ASSIGNMENT_INVALID\r?\n$/u],
      ["foreign", [{ ...validPhases[0], ownerId: "foreign" }, validPhases[1], validPhases[2]], /^STORY_PHASE_ASSIGNMENT_INVALID\r?\n$/u],
      ["invalid", validPhases.map((item) => ({ ...item, phase: { id: "phase-other", label: "Other" } })), /^STORY_PHASE_INVALID\r?\n$/u],
      ["inconsistent", validPhases.map((item, index) => ({
        ...item, phase: { id: "phase-one", label: index === 1 ? "Second phase" : "First phase" },
      })), /^STORY_PHASE_INVALID\r?\n$/u],
    ];
    for (const [name, phases, error] of phaseCases) {
      await json(batch.phasePath, phases);
      const rejected = invoke(0);
      assert.notEqual(rejected.status, 0, name);
      assert.match(rejected.stderr, error, name);
      assertNoAuthority();
    }
    const invalidPhases = [
      { ownerId: "story-a", phase: { id: "phase-one", label: "First phase" } },
      { ownerId: "story-b", phase: { id: "phase-two", label: "Second phase" } },
      { ownerId: "story-c", phase: { id: "phase-one", label: "First phase" } },
    ];
    await json(batch.phasePath, invalidPhases);
    const phaseRejected = invoke(0);
    assert.notEqual(phaseRejected.status, 0);
    assert.match(phaseRejected.stderr, /^STORY_PHASE_ORDER_INVALID\r?\n$/u);
    assertNoAuthority();
    const phaseRejectedAgain = invoke(1);
    assert.notEqual(phaseRejectedAgain.status, 0);
    assert.match(phaseRejectedAgain.stderr, /^STORY_PHASE_ORDER_INVALID\r?\n$/u);
    assertNoAuthority();
    assert.deepEqual(await readFile(proposalPath), validProposalBytes);

    await writeFile(batch.phasePath, validPhaseBytes);
    runOk(process.execPath, [record, value.transport, "story", batch.proposalDirectory,
      batch.editorialReviewPath, batch.phasePath, "--correction-attempt-count", "2"]);
    assert.deepEqual(await readFile(proposalPath), validProposalBytes);
    assert.equal(existsSync(join(value.transport, "story", "records")), true);
  } finally {
    await value.cleanup();
  }
});

test("injected filesystem failure leaves the complete Story records directory absent", async () => {
  const value = await prepareStoryOnly({
    suffixes: ["a", "b", "c"], narrativeBytes: 600_000,
  });
  try {
    assert.equal(value.prepared.status, 0, value.prepared.stderr);
    const records = ["a", "b", "c"].map((suffix) => ({
      id: `event-${suffix}`,
      story: storySource(suffix, value.semantic, value.boundary.coverageAuthority),
    }));
    const batch = await storyBatchFiles(value.transport, value.root, records, "filesystem-failure");
    assert.ok(batch.manifest.shards.length >= 2);
    const hook = join(value.root, "inject-story-write-failure.mjs");
    await writeFile(hook, `import fs from "node:fs";\nimport { syncBuiltinESMExports } from "node:module";\nconst original = fs.promises.open.bind(fs.promises);\nlet outputs = 0;\nfs.promises.open = async (path, ...args) => {\n  if (String(path).includes(".records.") && String(path).endsWith("output.json")) {\n    outputs += 1;\n    if (outputs === 2) throw new Error("injected");\n  }\n  return original(path, ...args);\n};\nsyncBuiltinESMExports();\n`, "utf8");
    const failed = run(process.execPath, ["--import", pathToFileURL(hook).href, record, value.transport, "story",
      batch.proposalDirectory, batch.editorialReviewPath, batch.phasePath,
      "--correction-attempt-count", "0"]);
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /^STORY_PREPARATION_RECORD_FAILED\r?\n$/u);
    assert.equal(existsSync(join(value.transport, "story", "records")), false);
    assert.ok((await readdir(join(value.transport, "story"))).every((name) => !name.startsWith(".records.")));

    runOk(process.execPath, [record, value.transport, "story", batch.proposalDirectory,
      batch.editorialReviewPath, batch.phasePath, "--correction-attempt-count", "1"]);
    assert.equal(existsSync(join(value.transport, "story", "records")), true);
  } finally {
    await value.cleanup();
  }
});

function combinedStory(semantic, coverage, collapsed) {
  const references = ["a", "b"].map((suffix) => ({
    documentId: "doc-canary", eventId: `event-${suffix}`,
  }));
  const person = (suffix, evidence) => ({
    id: `person-${suffix}`,
    releaseLabel: `Canary participant ${suffix.toUpperCase()}`,
    role: "reviewed participant",
    description: `The participant contributed canary ${suffix.toUpperCase()}.`,
    localIdentityState: "not_identified",
    evidence,
  });
  return {
    schema: "oxygen.story",
    language: "en",
    languagePolicyDigest: "f".repeat(64),
    key: "story-combined",
    phase: { id: "phase-combined", label: "Reviewed phase" },
    title: "Combined canary",
    overview: "Two reviewed actor signatures remain distinct.",
    chips: ["two supported participants"],
    people: collapsed
      ? [person("combined", references)]
      : [person("a", [references[0]]), person("b", [references[1]])],
    story: {
      blocks: [{ id: "block-combined", text: "Both reviewed contributions shaped the canary.", evidence: references }],
    },
    insights: [],
    evidence: { primary: references[0], supporting: [references[1]] },
    coverage: {
      semanticManifest: { revision: semantic.revision, digest: semantic.manifestDigest },
      coverageManifest: { revision: coverage.revision, digest: coverage.coverageDigest },
      representedUnitIds: ["unit-a", "unit-b"],
      excludedUnits: [],
    },
  };
}

function editorialStory(semantic, coverage, connected) {
  const references = ["a", "b"].map((suffix) => ({
    documentId: "doc-canary", eventId: `event-${suffix}`,
  }));
  return {
    ...combinedStory(semantic, coverage, false),
    title: connected ? "A bounded two-part record" : "Recorded canaries",
    overview: connected
      ? "Two safely distinct participants established the reviewed canary in sequence while leaving any stronger relationship unresolved."
      : "Canary A and Canary B were recorded.",
    story: {
      blocks: connected ? [{
        id: "block-opening",
        text: "One reviewed participant introduced canary A as the opening boundary, and another participant contributed canary B as the next recorded point.",
        evidence: references,
      }, {
        id: "block-boundary",
        text: "In that supported order, the two contributions establish the bounded reviewed record; the available Evidence does not establish disagreement or a later resolution.",
        evidence: references,
      }] : [{
        id: "block-a", text: "Canary A was recorded.", evidence: [references[0]],
      }, {
        id: "block-b", text: "Canary B was recorded.", evidence: [references[1]],
      }],
    },
  };
}

test("parent editorial gate rejects three record-by-record proposals before same-input Ultra-parent takeover", async () => {
  const root = await mkdtemp(join(tmpdir(), "story-editorial-gate-"));
  try {
    const semantic = semanticAuthority();
    const semanticPath = join(root, "semantic.json");
    const projectMapPath = join(root, "project-map.json");
    const transport = join(root, "transport");
    await json(semanticPath, semantic);
    const projectMap = {
      primary_project: semantic.projectId, summary: "Synthetic.",
      projects: [{ name: semantic.projectId, event_count: 2, reason: "One bounded reviewed arc." }],
      source_authority: { sourceDigest: semantic.sourceDigest, sourceCount: 1, contributionCount: 2 },
      semantic_units: semantic.units.map((unit) => ({ id: unit.id, kind: unit.kind, members: unit.members })),
      semantic_manifest: semantic,
    };
    await json(projectMapPath, projectMap);
    const coverageRows = [
      { unitId: "unit-a", disposition: "represented", ownerId: "story-combined" },
      { unitId: "unit-b", disposition: "represented", ownerId: "story-combined" },
    ];
    const boundary = await reviewedBoundary(root, projectMap, semantic, coverageRows);
    runOk(process.execPath, [prepare, "prepare", "story", semanticPath,
      boundary.coverage, boundary.sourcePrivacy, boundary.review, transport, ...storyAuthorityArgs]);

    const manifest = await readJson(join(transport, "story", "shards.json"));
    assert.equal(manifest.shards.length, 1);
    assert.deepEqual(manifest.shards[0].unitIds, ["story-combined"]);
    assert.notEqual(manifest.shards[0].unitIds[0], "unit-a");
    assert.notEqual(manifest.shards[0].unitIds[0], "unit-b");
    const inputPath = join(transport, ...manifest.shards[0].inputPath.split("/"));
    const inputBefore = await readFile(inputPath);
    const workerInput = JSON.parse(inputBefore.toString("utf8"));
    assert.equal(workerInput.payload.ownerBundles.length, 1);
    assert.deepEqual(workerInput.payload.ownerBundles[0].semanticUnits.map((unit) => unit.id), [
      "unit-a", "unit-b",
    ]);

    const connectedRecord = {
      id: "event-a", story: editorialStory(semantic, boundary.coverageAuthority, true),
    };
    const batch = await storyBatchFiles(transport, root, [connectedRecord], "editorial");
    const proposalPath = join(batch.proposalDirectory, manifest.shards[0].id + ".json");
    const dryRecord = {
      id: "event-a", story: editorialStory(semantic, boundary.coverageAuthority, false),
    };
    const rejectedDrafts = [dryRecord, structuredClone(dryRecord), structuredClone(dryRecord)];
    rejectedDrafts[1].story.title = "Recorded canaries, first correction";
    rejectedDrafts[2].story.title = "Recorded canaries, second correction";
    for (const [correctionAttemptCount, draft] of rejectedDrafts.entries()) {
      await json(proposalPath, [phaseFreeProposal(draft)]);
      await refreshStoryEditorialReview(batch, {
        "story-combined": {
          responsesAndChangesAreExplained: false,
          arcIsCoherent: false,
          proseIsReadable: false,
        },
      });
      const rejected = run(process.execPath, [record, transport, "story",
        batch.proposalDirectory, batch.editorialReviewPath, batch.phasePath,
        "--correction-attempt-count", String(correctionAttemptCount)]);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /^STORY_EDITORIAL_REVIEW_REJECTED\r?\n$/u);
      assert.equal(existsSync(join(transport, "story", "records")), false);
      assert.deepEqual(await readFile(inputPath), inputBefore);
    }

    // After the initial proposal and both subagent corrections are rejected, the
    // Ultra parent may author this same phase-free proposal from the same input.
    await json(proposalPath, [phaseFreeProposal(connectedRecord)]);
    const staleReview = run(process.execPath, [record, transport, "story",
      batch.proposalDirectory, batch.editorialReviewPath, batch.phasePath,
      "--correction-attempt-count", "2"]);
    assert.notEqual(staleReview.status, 0);
    assert.match(staleReview.stderr, /^STORY_EDITORIAL_REVIEW_INVALID\r?\n$/u);
    assert.equal(existsSync(join(transport, "story", "records")), false);
    await refreshStoryEditorialReview(batch);

    // The proposal bytes are unchanged, but this fresh input has different
    // Privacy-reviewed narrative authority. Replaying the old review must fail.
    const freshRoot = join(root, "fresh-input");
    const freshBoundary = await reviewedBoundary(freshRoot, projectMap, semantic, coverageRows);
    const freshEventsPath = join(
      freshBoundary.review, "trajectories", "doc-canary", "events.jsonl",
    );
    const freshEvents = (await readFile(freshEventsPath, "utf8")).trimEnd()
      .split("\n").map((line) => JSON.parse(line));
    freshEvents[0].payload.text = "fresh reviewed canary a";
    await writeFile(freshEventsPath, `${freshEvents.map(JSON.stringify).join("\n")}\n`, "utf8");
    const freshPrivacy = await readJson(freshBoundary.sourcePrivacy);
    freshPrivacy.job.source_digest = await computeSourceDigest(freshEvents.map((event) => ({
      id: event.event_id,
      document_id: event.trajectory_id,
      sequence: event.sequence,
      event_type: event.event_type,
      actor_type: event.actor.type,
      timestamp: event.timestamp,
      content: event.payload.text,
    })));
    await json(freshBoundary.sourcePrivacy, freshPrivacy);
    const freshTransport = join(freshRoot, "transport");
    runOk(process.execPath, [prepare, "prepare", "story", semanticPath,
      freshBoundary.coverage, freshBoundary.sourcePrivacy, freshBoundary.review, freshTransport,
      ...storyAuthorityArgs]);
    const freshManifest = await readJson(join(freshTransport, "story", "shards.json"));
    assert.notEqual(freshManifest.inputDigest, manifest.inputDigest);
    const replayedReview = run(process.execPath, [record, freshTransport, "story",
      batch.proposalDirectory, batch.editorialReviewPath, batch.phasePath,
      "--correction-attempt-count", "2"]);
    assert.notEqual(replayedReview.status, 0);
    assert.match(replayedReview.stderr, /^STORY_EDITORIAL_REVIEW_INVALID\r?\n$/u);
    assert.equal(existsSync(join(freshTransport, "story", "records")), false);

    runOk(process.execPath, [record, transport, "story", batch.proposalDirectory,
      batch.editorialReviewPath, batch.phasePath, "--correction-attempt-count", "2"]);
    assert.deepEqual(await readFile(inputPath), inputBefore);
    const output = await readJson(join(
      transport, "story", "records", manifest.shards[0].id, "output.json",
    ));
    assert.equal(output[0].story.story.blocks.length, 2);
    assert.equal(existsSync(join(
      transport, "story", "records", manifest.shards[0].id, "receipt.json",
    )), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shared Story validation rejects collapsed People before receipt and accepts only corrected proposal", async () => {
  const root = await mkdtemp(join(tmpdir(), "story-people-authority-"));
  try {
    const semantic = semanticAuthority();
    const semanticPath = join(root, "semantic.json");
    const projectMapPath = join(root, "project-map.json");
    const transport = join(root, "transport");
    await json(semanticPath, semantic);
    await json(projectMapPath, {
      primary_project: semantic.projectId, summary: "Synthetic.",
      projects: [{ name: semantic.projectId, event_count: 2, reason: "One repo-scoped projected contribution universe." }],
      source_authority: { sourceDigest: semantic.sourceDigest, sourceCount: 1, contributionCount: 2 },
      semantic_units: semantic.units.map((unit) => ({ id: unit.id, kind: unit.kind, members: unit.members })),
      semantic_manifest: semantic,
    });
    const boundary = await reviewedBoundary(root, await readJson(projectMapPath), semantic, [
      { unitId: "unit-a", disposition: "represented", ownerId: "story-combined" },
      { unitId: "unit-b", disposition: "represented", ownerId: "story-combined" },
    ]);
    runOk(process.execPath, [prepare, "prepare", "story", semanticPath,
      boundary.coverage, boundary.sourcePrivacy, boundary.review, transport, ...storyAuthorityArgs]);
    const inputBefore = await readFile(join(transport, "story", "inputs", "story-0001.json"));
    const invalidRecord = {
      id: "event-a", story: combinedStory(semantic, boundary.coverageAuthority, true),
    };
    const correctedRecord = {
      id: "event-a", story: combinedStory(semantic, boundary.coverageAuthority, false),
    };
    const batch = await storyBatchFiles(transport, root, [correctedRecord], "people");
    const proposal = join(batch.proposalDirectory, "story-0001.json");
    await json(proposal, [phaseFreeProposal(invalidRecord)]);
    await refreshStoryEditorialReview(batch);
    const rejected = run(process.execPath, [record, transport, "story",
      batch.proposalDirectory, batch.editorialReviewPath, batch.phasePath,
      "--correction-attempt-count", "0"]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /^STORY_PEOPLE_INVALID\r?\n$/u);
    assert.equal(existsSync(join(transport, "story", "records")), false);

    await json(proposal, [phaseFreeProposal(correctedRecord)]);
    await refreshStoryEditorialReview(batch);
    runOk(process.execPath, [record, transport, "story", batch.proposalDirectory,
      batch.editorialReviewPath, batch.phasePath, "--correction-attempt-count", "1"]);
    assert.deepEqual(
      await readFile(join(transport, "story", "inputs", "story-0001.json")), inputBefore,
    );
    const recordRoot = join(transport, "story", "records", "story-0001");
    const outputBefore = await readFile(join(recordRoot, "output.json"));
    const receiptBefore = await readFile(join(recordRoot, "receipt.json"));
    const changed = combinedStory(semantic, boundary.coverageAuthority, false);
    changed.title = "A different valid title";
    await json(proposal, [phaseFreeProposal({ id: "event-a", story: changed })]);
    await refreshStoryEditorialReview(batch);
    const immutable = run(process.execPath, [record, transport, "story",
      batch.proposalDirectory, batch.editorialReviewPath, batch.phasePath,
      "--correction-attempt-count", "1"]);
    assert.notEqual(immutable.status, 0);
    assert.match(immutable.stderr, /^AUTHORITY_IMMUTABLE\r?\n$/u);
    assert.deepEqual(await readFile(join(recordRoot, "output.json")), outputBefore);
    assert.deepEqual(await readFile(join(recordRoot, "receipt.json")), receiptBefore);

    const authorityBytes = await readFile(join(transport, "story", "validation-authority.json"), "utf8");
    const inputBytes = inputBefore.toString("utf8");
    assert.doesNotMatch(authorityBytes, /safe reviewed canary/u);
    assert.match(inputBytes, /safe reviewed canary a/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Insight source Quote matrix fails before receipt, permits proposal-only correction, then becomes immutable", async () => {
  const root = await mkdtemp(join(tmpdir(), "story-insight-validation-"));
  try {
    const semantic = semanticAuthority();
    const projectMap = {
      primary_project: semantic.projectId, summary: "Synthetic.",
      projects: [{ name: semantic.projectId, event_count: 2, reason: "Reviewed boundary." }],
      source_authority: { sourceDigest: semantic.sourceDigest, sourceCount: 1, contributionCount: 2 },
      semantic_units: semantic.units.map((unit) => ({ id: unit.id, kind: unit.kind, members: unit.members })),
      semantic_manifest: semantic,
    };
    const projectMapPath = join(root, "project-map.json");
    await json(projectMapPath, projectMap);
    const boundary = await reviewedBoundary(root, projectMap, semantic, [
      { unitId: "unit-a", disposition: "represented", ownerId: "story-combined" },
      { unitId: "unit-b", disposition: "excluded", exclusionReason: "outside_story_scope" },
    ]);
    const transport = join(root, "transport");
    runOk(process.execPath, [prepare, "prepare", "story", projectMapPath,
      boundary.coverage, boundary.sourcePrivacy, boundary.review, transport, ...storyAuthorityArgs]);
    const combined = combinedStory(semantic, boundary.coverageAuthority, false);
    // Event B belongs to broader Chapter context but is intentionally absent from every
    // Story block. It therefore is not represented as a Person, its reviewed narrative
    // must be excluded from the Insight input, and it cannot ground the anchored paragraph.
    combined.story.blocks[0].evidence = [{ documentId: "doc-canary", eventId: "event-a" }];
    combined.people = [combined.people[0]];
    combined.evidence.supporting = [];
    combined.coverage.representedUnitIds = ["unit-a"];
    combined.coverage.excludedUnits = [{ unitId: "unit-b", reason: "outside_story_scope" }];
    const stories = [{ id: "event-a", story: combined }];
    await recordLane(transport, "story", root, (input) => stories.filter((item) => (
      input.unitIds.includes(item.story.key)
    )));
    const baseCandidates = join(root, "story-base.json");
    runOk(process.execPath, [prepare, "compose", "story", transport, baseCandidates]);
    runOk(process.execPath, [prepare, "prepare", "insight", baseCandidates, transport]);
    const manifest = await readJson(join(transport, "insight", "shards.json"));
    assert.equal(manifest.shards.length, 1);
    const shard = manifest.shards[0];
    const inputPath = join(transport, ...shard.inputPath.split("/"));
    const inputBefore = await readFile(inputPath);
    const input = JSON.parse(inputBefore.toString("utf8"));
    assert.deepEqual(Object.keys(input.payload).sort(), [
      "languagePolicy", "reviewedNarrative", "storyCandidates", "validationAuthorityDigest",
      "validationAuthorityPath",
    ]);
    assert.deepEqual(input.payload.reviewedNarrative, [{
      id: "event-a", documentId: "doc-canary", narrative: "safe reviewed canary a",
    }]);
    assert.doesNotMatch(inputBefore.toString("utf8"),
      /safe reviewed canary b|sourcePrivacy|redactions|actorId|provider|model|OUTSIDE-EXACT-BOUND-REVIEWED-NARRATIVE/u);
    const recordRoot = join(transport, "insight", "records", shard.id);
    const validInsight = {
      ...insight("a"),
      anchorStoryBlockId: "block-combined",
    };
    const valid = [
      { storyKey: "story-combined", insights: [validInsight] },
    ];
    const invalid = [
      ["Story paragraph reused as Quote", {
        ...validInsight,
        quote: { ...validInsight.quote, text: combined.story.blocks[0].text },
      }],
      ["modified source Quote", {
        ...validInsight,
        quote: { ...validInsight.quote, text: "safe reviewed canary a." },
      }],
      ["foreign Quote Evidence", {
        ...validInsight,
        quote: {
          text: "safe reviewed canary a",
          evidence: { documentId: "doc-canary", eventId: "event-foreign" },
        },
      }],
      ["stale Quote Evidence", {
        ...validInsight,
        quote: {
          text: "safe reviewed canary a",
          evidence: { documentId: "doc-canary-old", eventId: "event-a" },
        },
      }],
      ["Quote outside the exact bound reviewed narrative", {
        ...validInsight,
        quote: { ...validInsight.quote, text: "OUTSIDE-EXACT-BOUND-REVIEWED-NARRATIVE" },
      }],
      ["invalid anchor", {
        ...validInsight,
        anchorStoryBlockId: "block-foreign",
      }],
      ["Quote and anchor Evidence mismatch", {
        ...validInsight,
        quote: {
          text: "safe reviewed canary b",
          evidence: { documentId: "doc-canary", eventId: "event-b" },
        },
      }],
      ["foreign top-level Insight Evidence", {
        ...validInsight,
        evidence: [{ documentId: "doc-canary", eventId: "event-foreign" }],
      }],
    ];
    for (const [index, [name, badInsight]] of invalid.entries()) {
      const proposal = join(root, `invalid-insight-${index}.json`);
      await json(proposal, [
        { storyKey: "story-combined", insights: [badInsight] },
      ]);
      const rejected = run(process.execPath, [record, transport, "insight", shard.id, proposal]);
      assert.notEqual(rejected.status, 0, name);
      assert.match(rejected.stderr, /^STORY_INSIGHT_GROUNDING_INVALID\r?\n$/u, name);
      assert.equal(existsSync(recordRoot), false, name);
      assert.deepEqual(await readFile(inputPath), inputBefore, name);
    }
    const corrected = join(root, "corrected-insight.json");
    await json(corrected, valid);
    runOk(process.execPath, [record, transport, "insight", shard.id, corrected]);
    assert.deepEqual(await readFile(inputPath), inputBefore);
    const outputPath = join(recordRoot, "output.json");
    const receiptPath = join(recordRoot, "receipt.json");
    const outputBefore = await readFile(outputPath);
    const receiptBefore = await readFile(receiptPath);
    const differing = join(root, "differing-insight.json");
    await json(differing, [
      {
        storyKey: "story-combined",
        insights: [{ ...validInsight, title: "Different valid title" }],
      },
    ]);
    const immutable = run(process.execPath, [record, transport, "insight", shard.id, differing]);
    assert.notEqual(immutable.status, 0);
    assert.match(immutable.stderr, /^AUTHORITY_IMMUTABLE\r?\n$/u);
    assert.deepEqual(await readFile(outputPath), outputBefore);
    assert.deepEqual(await readFile(receiptPath), receiptBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("finalizer reopens immutable Insight input and rejects a Story-derived Quote", async () => {
  const flow = await createFlow();
  try {
    const manifest = await readJson(join(flow.transport, "insight", "shards.json"));
    assert.equal(manifest.shards.length, 1);
    const shard = manifest.shards[0];
    const outputPath = join(flow.transport, "insight", "records", shard.id, "output.json");
    const receiptPath = join(flow.transport, "insight", "records", shard.id, "receipt.json");
    const output = await readJson(outputPath);
    const outputRecord = output.find((record) => record.storyKey === "story-a");
    assert.ok(outputRecord);
    outputRecord.insights[0].quote.text = "Reviewed canary text A.";
    await json(outputPath, output);
    const receipt = await readJson(receiptPath);
    receipt.outputDigest = digest(output);
    await json(receiptPath, receipt);

    const candidates = await readJson(flow.candidates);
    const candidate = candidates.find((row) => parseStorySource(row.summary)?.key === "story-a");
    assert.ok(candidate);
    const story = parseStorySource(candidate.summary);
    assert.ok(story);
    story.insights[0].quote.text = "Reviewed canary text A.";
    candidate.summary = `oxygen.story:${canonicalAuthorityJson(story)}`;
    await json(flow.candidates, candidates);

    const sentinel = Buffer.from("existing-terminal-authority\n");
    await writeFile(flow.preparationManifest, sentinel);
    const rejected = run(process.execPath, [finalize,
      flow.projectMapPath, flow.candidates, flow.transport, flow.preferenceBundle,
      flow.preparationManifest, "--workflow-run-id", "public-canary-run", "--source-revision", "4",
    ]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /^STORY_INSIGHT_GROUNDING_INVALID\r?\n$/u);
    assert.deepEqual(await readFile(flow.preparationManifest), sentinel);
  } finally {
    await flow.cleanup();
  }
});

test("finalizer repeats shared Story validation before replacing terminal authority", async () => {
  const flow = await createFlow();
  try {
    const storyOutputPath = join(flow.transport, "story", "records", "story-0001", "output.json");
    const storyReceiptPath = join(flow.transport, "story", "records", "story-0001", "receipt.json");
    const output = await readJson(storyOutputPath);
    const candidates = await readJson(flow.candidates);
    const finalStory = parseStorySource(candidates[0].summary);
    const baseStory = output[0].story;
    const foreign = { documentId: "doc-canary", eventId: "event-b" };
    for (const story of [baseStory, finalStory]) {
      story.evidence.supporting.push(foreign);
      story.people[0].evidence.push(foreign);
    }
    candidates[0].summary = `oxygen.story:${canonicalAuthorityJson(finalStory)}`;
    await json(storyOutputPath, output);
    await json(flow.candidates, candidates);
    const receipt = await readJson(storyReceiptPath);
    receipt.outputDigest = digest(output);
    await json(storyReceiptPath, receipt);
    const destination = flow.preparationManifest;
    const sentinel = Buffer.from("existing-terminal-authority\n");
    await writeFile(destination, sentinel);
    const rejected = run(process.execPath, [finalize,
      flow.projectMapPath, flow.candidates, flow.transport, flow.preferenceBundle, destination,
      "--workflow-run-id", "public-canary-run", "--source-revision", "4",
    ]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /^STORY_PEOPLE_INVALID\r?\n$/u);
    assert.deepEqual(await readFile(destination), sentinel);

    const rawEvidence = [
      { id: "event-a", documentId: "doc-canary", eventType: "message", actorId: "raw-a", actorType: "user" },
      { id: "event-b", documentId: "doc-canary", eventType: "message", actorId: "raw-b", actorType: "assistant" },
    ];
    const viewerCheck = validateStorySourcePackage([{
      id: "event-a", documentId: "doc-canary", summary: candidates[0].summary,
    }], rawEvidence);
    assert.deepEqual(viewerCheck, { ok: false, code: "STORY_PEOPLE_INVALID" });
    const activationCheck = await validateStoryActivationAuthority([{
      id: "event-a", documentId: "doc-canary", summary: candidates[0].summary,
    }], rawEvidence, await readJson(flow.semanticPath), await readJson(join(flow.root, "coverage.json")));
    assert.deepEqual(activationCheck, { ok: false, code: "STORY_PEOPLE_INVALID" });
  } finally {
    await flow.cleanup();
  }
});
