#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalizeAutoRemoved } from "../../../viewer/lib/auto-removed.mjs";
import {
  canonicalPreferenceQuestionBatch,
  deriveStoryReleaseTargetCatalog,
} from "../../../viewer/lib/story-preparation.ts";
import {
  normalizeBulkPreferencePresentations,
  normalizeProbePresentations,
} from "../../../viewer/lib/preference-presentation.ts";
import {
  canonicalAuthorityJson,
  validateStorySourcePackage,
} from "../../../viewer/lib/story-readiness.ts";
import { parseStorySource, STORY_PREFIX } from "../../../viewer/lib/timeline.ts";
import {
  StoryPreparationTransportError,
  canonicalDigest,
  compareUtf8,
  exactKeys,
  fail,
  isObject,
  readStrictJson,
  stableId,
  MAX_STORY_PREPARATION_FILE_BYTES,
} from "./story_preparation_transport.mjs";
import {
  LANES,
  laneDirectory,
  readLaneAuthority,
  readPreparedShard,
  relativeLanePath,
} from "./story_preparation_protocol.mjs";
import {
  readStoryValidationAuthority,
  storyCompletenessAuthority,
  storyEvidenceRows,
} from "./story_preparation_validation_authority.mjs";

const metadataKeys = new Set([
  "raworiginal", "original", "evidence", "provider", "model", "prompt", "rewrite",
  "recommendation", "execution", "agent", "duration", "token", "cost", "log",
]);
const preferenceKeys = [
  "workflowRunId", "sourceRevision", "inputDigest", "outputDigest", "outputCount",
  "setAside", "probes", "bulkDecisions", "autoRemoved",
];
const probeKeys = [
  "id", "documentId", "documentKind", "eventIds", "timestamp", "signal", "score",
  "turns", "recap", "question", "options", "presentations", "allowOther", "allowSkip",
];
const bulkKeys = ["id", "kind", "count", "question", "evidenceSample", "presentations"];
const signals = new Set([
  "repeated_correction", "long_exchange", "late_rejection", "decision_reversal",
  "explicit_rule", "sustained_disagreement",
]);
const autoRemovedKinds = new Set([
  "credential", "private-personal", "sensitive", "internal-metric",
  "internal-timeline", "mosaic-reidentification",
]);
const genericOptions = new Set([
  "be more careful", "communicate better", "be clearer", "ask more questions",
  "do better", "follow instructions", "be consistent", "improve quality",
  "write better code", "test more", "be faster", "explain more",
]);

const safeText = (value, maximum = 20_000) => typeof value === "string" && Boolean(value.trim())
  && value.length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
const boundedId = (value, maximum = 20_000) => stableId(value) && value.length <= maximum;
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
const normalizeOptionText = (value) => value.trim().replace(/\.+$/u, "")
  .replace(/[A-Z]/gu, (character) => String.fromCharCode(character.charCodeAt(0) + 32));

function rejectMetadata(value) {
  if (Array.isArray(value)) return value.forEach(rejectMetadata);
  if (!isObject(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (metadataKeys.has(key.replace(/[^a-z0-9]/giu, "").toLowerCase())) fail("WORKER_METADATA_FORBIDDEN");
    rejectMetadata(nested);
  }
}

function parseStory(value) {
  if (!isObject(value)) fail("STORY_OUTPUT_INVALID");
  const story = parseStorySource(`${STORY_PREFIX}${JSON.stringify(value)}`);
  if (!story || !stableId(story.key)) fail("STORY_OUTPUT_INVALID");
  return story;
}

async function validateStory(value, input, prepared) {
  if (!Array.isArray(value) || value.length === 0) fail("STORY_OUTPUT_INVALID");
  const authority = await readStoryValidationAuthority(prepared);
  const units = authority.semanticManifest?.units;
  if (!Array.isArray(units)) fail("WORKER_INPUT_TAMPERED");
  const memberIds = new Set(units.flatMap((unit) => Array.isArray(unit?.members) ? unit.members : []));
  const output = value.map((record) => {
    if (!exactKeys(record, ["id", "story"]) || !stableId(record.id) || !memberIds.has(record.id)) {
      fail("STORY_OUTPUT_INVALID");
    }
    const story = parseStory(record.story);
    if (story.insights.length !== 0) fail("STORY_OUTPUT_INVALID");
    return { id: record.id, story };
  }).sort((left, right) => compareUtf8(left.id, right.id));
  if (new Set(output.map((record) => record.id)).size !== output.length
    || new Set(output.map((record) => record.story.key)).size !== output.length) fail("STORY_OUTPUT_IDENTITY_INVALID");
  const validation = validateStorySourcePackage(output.map((record) => ({
    id: record.id,
    documentId: record.story.evidence.primary.documentId,
    summary: `${STORY_PREFIX}${canonicalAuthorityJson(record.story)}`,
  })), storyEvidenceRows(authority), storyCompletenessAuthority(authority));
  if (!validation.ok) fail(validation.code);
  return { output, count: output.length };
}

function validateInsight(value, input) {
  if (!Array.isArray(value) || !Array.isArray(input.payload?.storyCandidates)) fail("INSIGHT_OUTPUT_INVALID");
  const baseByKey = new Map();
  for (const row of input.payload.storyCandidates) {
    const story = parseStorySource(row?.summary);
    if (!story || story.insights.length !== 0 || baseByKey.has(story.key)) fail("WORKER_INPUT_TAMPERED");
    baseByKey.set(story.key, story);
  }
  const output = value.map((record) => {
    if (!exactKeys(record, ["storyKey", "insights"]) || !stableId(record.storyKey)
      || !Array.isArray(record.insights) || !baseByKey.has(record.storyKey)) fail("INSIGHT_OUTPUT_INVALID");
    const complete = parseStory({ ...baseByKey.get(record.storyKey), insights: record.insights });
    return { storyKey: record.storyKey, insights: complete.insights };
  }).sort((left, right) => compareUtf8(left.storyKey, right.storyKey));
  const expected = [...input.unitIds].sort(compareUtf8);
  if (canonicalAuthorityJson(output.map((record) => record.storyKey)) !== canonicalAuthorityJson(expected)) {
    fail("INSIGHT_OUTPUT_IDENTITY_INVALID");
  }
  return { output, count: output.reduce((total, record) => total + record.insights.length, 0) };
}

function validatePrivacy(value, input) {
  if (!Array.isArray(value) || !Array.isArray(input.payload?.storyCandidates)
    || !Array.isArray(input.payload?.releaseTargetCatalog)) fail("PRIVACY_OUTPUT_INVALID");
  const stories = input.payload.storyCandidates.map((row) => parseStorySource(row?.summary));
  if (stories.some((story) => !story)) fail("WORKER_INPUT_TAMPERED");
  const catalog = deriveStoryReleaseTargetCatalog(stories);
  if (!catalog || canonicalAuthorityJson(catalog) !== canonicalAuthorityJson(input.payload.releaseTargetCatalog)) {
    fail("WORKER_INPUT_TAMPERED");
  }
  const valid = new Set(input.unitIds);
  const order = new Map(catalog.map((target, index) => [target.id, index]));
  const found = new Map();
  for (const candidate of value) {
    rejectMetadata(candidate);
    if (!exactKeys(candidate, ["id", "reviewState", "title", "whyFlagged", "uncertaintyReason", "releaseTargets"])
      || !boundedId(candidate.id) || !["deterministic", "needs_confirmation"].includes(candidate.reviewState)
      || !safeText(candidate.title) || !safeText(candidate.whyFlagged)
      || (candidate.reviewState === "deterministic" && candidate.uncertaintyReason !== null)
      || (candidate.reviewState === "needs_confirmation" && !safeText(candidate.uncertaintyReason))
      || !Array.isArray(candidate.releaseTargets) || candidate.releaseTargets.length === 0
      || candidate.releaseTargets.some((target) => !valid.has(target))
      || new Set(candidate.releaseTargets).size !== candidate.releaseTargets.length) fail("PRIVACY_OUTPUT_INVALID");
    const normalized = { ...candidate, releaseTargets: [...candidate.releaseTargets]
      .sort((left, right) => order.get(left) - order.get(right)) };
    const prior = found.get(candidate.id);
    if (prior && canonicalAuthorityJson(prior) !== canonicalAuthorityJson(normalized)) {
      fail("WORKER_OUTPUT_IDENTITY_CONFLICT");
    }
    found.set(candidate.id, normalized);
  }
  const output = [...found.values()].sort((left, right) => compareUtf8(left.id, right.id));
  return { output, count: output.length };
}

function preferenceOption(value) {
  return exactKeys(value, ["id", "text"]) && boundedId(value.id, 200) && safeText(value.text);
}

function preferenceProbe(value, evidence) {
  if (!exactKeys(value, probeKeys) || !boundedId(value.id) || !boundedId(value.documentId)
    || !["trajectory", "meeting"].includes(value.documentKind)
    || !Array.isArray(value.eventIds) || value.eventIds.length === 0
    || value.eventIds.some((eventId) => !boundedId(eventId, 1_000))
    || new Set(value.eventIds).size !== value.eventIds.length
    || value.eventIds.some((eventId) => evidence.get(canonicalAuthorityJson([value.documentId, eventId])) !== value.documentKind)
    || (value.timestamp !== null && !safeText(value.timestamp)) || !signals.has(value.signal)
    || !nonnegative(value.score) || value.score > 100 || !nonnegative(value.turns)
    || !safeText(value.recap) || !safeText(value.question)
    || !Array.isArray(value.options) || ![2, 3].includes(value.options.length)
    || value.options.some((option) => !preferenceOption(option))
    || new Set(value.options.map((option) => option.id)).size !== value.options.length
    || value.allowOther !== true || value.allowSkip !== true) fail("PREFERENCE_BUNDLE_INVALID");
  const normalizedOptions = value.options.map((option) => normalizeOptionText(option.text));
  if (new Set(normalizedOptions).size !== normalizedOptions.length
    || normalizedOptions.some((option) => genericOptions.has(option))) fail("PREFERENCE_BUNDLE_INVALID");
  const presentations = normalizeProbePresentations(value.presentations, value.options);
  if (presentations === null || canonicalAuthorityJson(presentations) !== canonicalAuthorityJson(value.presentations)) {
    fail("PREFERENCE_BUNDLE_INVALID");
  }
  return value;
}

function preferenceBulk(value, evidenceIds) {
  if (!exactKeys(value, bulkKeys) || !boundedId(value.id) || !safeText(value.kind)
    || !nonnegative(value.count) || !safeText(value.question) || !Array.isArray(value.evidenceSample)
    || value.evidenceSample.some((eventId) => !boundedId(eventId, 1_000) || !evidenceIds.has(eventId))
    || new Set(value.evidenceSample).size !== value.evidenceSample.length) fail("PREFERENCE_BUNDLE_INVALID");
  const presentations = normalizeBulkPreferencePresentations(value.presentations);
  if (presentations === null || canonicalAuthorityJson(presentations) !== canonicalAuthorityJson(value.presentations)) {
    fail("PREFERENCE_BUNDLE_INVALID");
  }
  return value;
}

function validatePreference(value, input) {
  const context = input.payload?.preferenceContext;
  if (!isObject(context) || !Array.isArray(context.reviewedEvidence)
    || !exactKeys(value, preferenceKeys) || !boundedId(value.workflowRunId, 1_000)
    || !nonnegative(value.sourceRevision) || value.inputDigest !== input.inputDigest
    || !/^[0-9a-f]{64}$/u.test(value.outputDigest) || !nonnegative(value.outputCount)
    || !nonnegative(value.setAside) || !Array.isArray(value.probes) || !Array.isArray(value.bulkDecisions)) {
    fail("PREFERENCE_BUNDLE_INVALID");
  }
  rejectMetadata({ probes: value.probes, bulkDecisions: value.bulkDecisions });
  const evidence = new Map(context.reviewedEvidence.map((record) => [
    canonicalAuthorityJson([record?.documentId, record?.eventId]), record?.documentKind,
  ]));
  const evidenceIds = new Set(context.reviewedEvidence.map((record) => record?.eventId));
  const probes = value.probes.map((probe) => preferenceProbe(probe, evidence));
  const decisions = value.bulkDecisions.map((decision) => preferenceBulk(decision, evidenceIds));
  const ids = [...probes, ...decisions].map((item) => item.id);
  if (new Set(ids).size !== ids.length || value.outputCount !== ids.length
    || (value.outputCount === 0 && value.setAside !== 0)
    || canonicalAuthorityJson(probes) !== canonicalAuthorityJson([...probes].sort((a, b) => compareUtf8(a.id, b.id)))
    || canonicalAuthorityJson(decisions) !== canonicalAuthorityJson([...decisions].sort((a, b) => compareUtf8(a.id, b.id)))) {
    fail("PREFERENCE_BUNDLE_INVALID");
  }
  try {
    const aggregate = canonicalizeAutoRemoved(value.autoRemoved);
    if (canonicalAuthorityJson(aggregate) !== canonicalAuthorityJson(value.autoRemoved)
      || aggregate.reversible !== true || aggregate.categories.some((item) => (
        !autoRemovedKinds.has(item.kind) || item.count === 0
      ))) fail("PREFERENCE_BUNDLE_INVALID");
  } catch {
    fail("PREFERENCE_BUNDLE_INVALID");
  }
  const batch = canonicalPreferenceQuestionBatch(probes, decisions);
  if (canonicalDigest(batch) !== value.outputDigest) fail("PREFERENCE_BUNDLE_INVALID");
  return { output: value, count: value.outputCount };
}

async function validateProposal(lane, value, input, prepared) {
  if (lane === "story") return validateStory(value, input, prepared);
  if (lane === "insight") return validateInsight(value, input);
  if (lane === "story_privacy") return validatePrivacy(value, input);
  if (lane === "preference") return validatePreference(value, input);
  fail("LANE_INVALID");
}

async function exists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("PAIR_STATE_INVALID");
  }
}

async function writeSynced(path, value) {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(`${canonicalAuthorityJson(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function record(rootInput, lane, shardId, proposalPath) {
  if (!LANES.includes(lane) || !stableId(shardId)) fail("CLI_USAGE");
  const prepared = await readPreparedShard(rootInput, lane);
  if (prepared.shard.id !== shardId) fail("SHARD_IDENTITY_INVALID");
  const proposal = (await readStrictJson(proposalPath, MAX_STORY_PREPARATION_FILE_BYTES, {
    invalid: "PROPOSAL_UNREADABLE", changed: "PROPOSAL_CHANGED",
    oversized: "PROPOSAL_TOO_LARGE", jsonInvalid: "PROPOSAL_JSON_INVALID",
  })).value;
  const normalized = await validateProposal(lane, proposal, prepared.input, prepared);
  const recordRelative = relativeLanePath(lane, `records/${shardId}`);
  const recordPath = resolve(prepared.root, ...recordRelative.split("/"));
  const state = await exists(recordPath);
  if (state) {
    if (!state.isDirectory() || state.isSymbolicLink()) fail("PARTIAL_PAIR_REJECTED");
    let authority;
    try {
      authority = await readLaneAuthority(prepared.root, lane);
    } catch {
      fail("PARTIAL_PAIR_REJECTED");
    }
    if (canonicalAuthorityJson(authority.output) !== canonicalAuthorityJson(normalized.output)) {
      fail("AUTHORITY_IMMUTABLE");
    }
    return authority.receipt;
  }
  const recordsPath = resolve(prepared.root, laneDirectory[lane], "records");
  await mkdir(recordsPath, { recursive: true });
  const temporary = resolve(recordsPath, `.${shardId}.${process.pid}.${randomUUID()}.tmp`);
  const outputPath = relativeLanePath(lane, `records/${shardId}/output.json`);
  const receipt = {
    schema: "oxygen.story-preparation-worker-receipt",
    lane,
    shardId,
    status: "complete",
    inputDigest: prepared.manifest.inputDigest,
    workerInputDigest: prepared.shard.workerInputDigest,
    unitIds: prepared.shard.unitIds,
    outputPath,
    outputDigest: canonicalDigest(normalized.output),
    outputCount: normalized.count,
  };
  try {
    await mkdir(temporary);
    await writeSynced(resolve(temporary, "output.json"), normalized.output);
    await writeSynced(resolve(temporary, "receipt.json"), receipt);
    try {
      await rename(temporary, recordPath);
    } catch (error) {
      if (error?.code === "EEXIST" || error?.code === "ENOTEMPTY") fail("AUTHORITY_IMMUTABLE");
      throw error;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
  return receipt;
}

try {
  const [root, lane, shardId, proposalPath, ...extra] = process.argv.slice(2);
  if (!root || !lane || !shardId || !proposalPath || extra.length) fail("CLI_USAGE");
  const receipt = await record(root, lane, shardId, proposalPath);
  process.stdout.write(`${canonicalAuthorityJson({
    ok: true, lane: receipt.lane, shardId: receipt.shardId,
    outputDigest: receipt.outputDigest, outputCount: receipt.outputCount,
  })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof StoryPreparationTransportError ? error.code : "STORY_PREPARATION_RECORD_FAILED"}\n`);
  process.exitCode = 1;
}
