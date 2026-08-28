#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
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
import {
  compareStorySourceIdentity,
  parseStorySource,
  STORY_PREFIX,
} from "../../../viewer/lib/timeline.ts";
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
  readPreparedManifest,
  readPreparedShard,
  readShardAuthority,
  relativeLanePath,
} from "./story_preparation_protocol.mjs";
import {
  readStoryValidationAuthority,
  storyCompletenessAuthority,
  storyEvidenceRows,
  storyValidationScope,
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

const storyChapterRequiredKeys = ["title", "overview", "people", "story", "insights", "evidence"];
const storyChapterOptionalKeys = ["kind", "transition", "chips"];
const storyParentKeys = new Set([
  "schema", "key", "phase", "coverage", "exclusions", "receipt", "authority",
]);

function exactAllowedKeys(value, required, optional) {
  if (!isObject(value) || required.some((key) => !Object.hasOwn(value, key))) return false;
  const allowed = new Set([...required, ...optional]);
  return Object.keys(value).every((key) => allowed.has(key));
}

function evidenceReference(value) {
  if (!isObject(value) || !stableId(value.documentId) || !stableId(value.eventId)) return false;
  const keys = Object.keys(value);
  return (keys.length === 2 && keys.every((key) => ["documentId", "eventId"].includes(key)))
    || (keys.length === 3 && keys.every((key) => ["documentId", "eventId", "label"].includes(key))
      && typeof value.label === "string");
}

function storyProposal(value) {
  if (!exactKeys(value, ["ownerId", "chapter"]) || !stableId(value.ownerId)
    || !isObject(value.chapter)) fail("STORY_PROPOSAL_INVALID");
  if (Object.keys(value.chapter).some((key) => storyParentKeys.has(key))) {
    fail("STORY_PROPOSAL_PARENT_FIELD_FORBIDDEN");
  }
  if (!exactAllowedKeys(value.chapter, storyChapterRequiredKeys, storyChapterOptionalKeys)
    || !Array.isArray(value.chapter.insights) || value.chapter.insights.length !== 0
    || !isObject(value.chapter.evidence)
    || !exactKeys(value.chapter.evidence, ["primary", "supporting"])
    || !evidenceReference(value.chapter.evidence.primary)
    || !Array.isArray(value.chapter.evidence.supporting)
    || value.chapter.evidence.supporting.some((reference) => !evidenceReference(reference))) {
    fail("STORY_PROPOSAL_INVALID");
  }
  return value;
}

async function directProposalDirectory(path, shardIds) {
  const requested = resolve(path);
  let state;
  let physical;
  try {
    state = await lstat(requested);
    physical = await realpath(requested);
  } catch {
    fail("STORY_PROPOSAL_SET_INVALID");
  }
  if (!state.isDirectory() || state.isSymbolicLink() || physical !== requested) {
    fail("STORY_PROPOSAL_SET_INVALID");
  }
  const expected = shardIds.map((id) => `${id}.json`).sort(compareUtf8);
  const entries = await readdir(physical, { withFileTypes: true }).catch(() => (
    fail("STORY_PROPOSAL_SET_INVALID")
  ));
  const names = entries.map((entry) => entry.name).sort(compareUtf8);
  if (canonicalAuthorityJson(names) !== canonicalAuthorityJson(expected)
    || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    fail("STORY_PROPOSAL_SET_INVALID");
  }
  return physical;
}

function validateStoryOwnerBundles(prepared, authority) {
  const semanticById = new Map(authority.semanticManifest.units.map((unit) => [unit.id, unit]));
  const coverageById = new Map(authority.coverageManifest.rows.map((row) => [row.unitId, row]));
  const expectedOwners = [...new Set(authority.coverageManifest.rows
    .filter((row) => row.disposition === "represented").map((row) => row.ownerId))].sort(compareUtf8);
  if (expectedOwners.length === 0) fail("STORY_ZERO_REPRESENTED_OWNER_UNSUPPORTED");
  const ownerBundles = new Map();
  for (const shard of prepared.shards) {
    const input = prepared.inputs.find((candidate) => candidate.shardId === shard.id);
    if (!input || !exactKeys(input.payload, [
      "validationAuthorityPath", "validationAuthorityDigest", "ownerBundles",
    ]) || !Array.isArray(input.payload.ownerBundles) || input.payload.ownerBundles.length === 0) {
      fail("WORKER_INPUT_TAMPERED");
    }
    const shardOwners = [];
    for (const bundle of input.payload.ownerBundles) {
      if (!exactKeys(bundle, [
        "ownerId", "semanticManifest", "coverageManifest", "semanticUnits", "reviewedNarrative",
      ]) || !stableId(bundle.ownerId) || ownerBundles.has(bundle.ownerId)
        || !Array.isArray(bundle.semanticUnits) || bundle.semanticUnits.length === 0
        || !Array.isArray(bundle.reviewedNarrative)) fail("WORKER_INPUT_TAMPERED");
      if (canonicalAuthorityJson(bundle.semanticManifest) !== canonicalAuthorityJson({
        revision: authority.semanticManifest.revision,
        digest: authority.semanticManifest.manifestDigest,
      }) || canonicalAuthorityJson(bundle.coverageManifest) !== canonicalAuthorityJson({
        revision: authority.coverageManifest.revision,
        digest: authority.coverageManifest.coverageDigest,
      })) fail("WORKER_INPUT_TAMPERED");
      const unitIds = bundle.semanticUnits.map((unit) => unit?.id).sort(compareUtf8);
      if (unitIds.some((id) => !stableId(id)) || new Set(unitIds).size !== unitIds.length
        || bundle.semanticUnits.some((unit) => (
          canonicalAuthorityJson(unit) !== canonicalAuthorityJson(semanticById.get(unit.id))
          || coverageById.get(unit.id)?.disposition !== "represented"
          || coverageById.get(unit.id)?.ownerId !== bundle.ownerId
        ))) fail("WORKER_INPUT_TAMPERED");
      const memberIds = bundle.semanticUnits.flatMap((unit) => unit.members).sort(compareUtf8);
      const narrativeIds = bundle.reviewedNarrative.map((row) => row?.id).sort(compareUtf8);
      if (new Set(memberIds).size !== memberIds.length
        || canonicalAuthorityJson(narrativeIds) !== canonicalAuthorityJson(memberIds)) {
        fail("WORKER_INPUT_TAMPERED");
      }
      ownerBundles.set(bundle.ownerId, {
        ...bundle,
        shardId: shard.id,
        unitIds,
        memberIds: new Set(memberIds),
      });
      shardOwners.push(bundle.ownerId);
    }
    if (canonicalAuthorityJson(shardOwners.sort(compareUtf8))
      !== canonicalAuthorityJson(input.unitIds)) fail("WORKER_INPUT_TAMPERED");
  }
  if (canonicalAuthorityJson([...ownerBundles.keys()].sort(compareUtf8))
    !== canonicalAuthorityJson(expectedOwners)
    || canonicalAuthorityJson(prepared.manifest.unitIds) !== canonicalAuthorityJson(expectedOwners)) {
    fail("STORY_OWNER_AUTHORITY_INVALID");
  }
  return ownerBundles;
}

function phaseAssignments(value, ownerIds) {
  if (!Array.isArray(value) || value.length !== ownerIds.length) fail("STORY_PHASE_ASSIGNMENT_INVALID");
  const phases = new Map();
  for (const assignment of value) {
    if (!exactKeys(assignment, ["ownerId", "phase"]) || !stableId(assignment.ownerId)
      || phases.has(assignment.ownerId) || !exactKeys(assignment.phase, ["id", "label"])
      || !stableId(assignment.phase.id) || !stableId(assignment.phase.label)) {
      fail("STORY_PHASE_ASSIGNMENT_INVALID");
    }
    phases.set(assignment.ownerId, assignment.phase);
  }
  if (canonicalAuthorityJson([...phases.keys()].sort(compareUtf8))
    !== canonicalAuthorityJson([...ownerIds].sort(compareUtf8))) {
    fail("STORY_PHASE_ASSIGNMENT_INVALID");
  }
  return phases;
}

async function storyBatchProposal(rootInput, proposalDirectory, phasePath) {
  const manifest = await readPreparedManifest(rootInput, "story");
  const inputs = [];
  for (const shard of manifest.shards) {
    inputs.push((await readPreparedShard(manifest.root, "story", shard.id)).input);
  }
  const prepared = { ...manifest, inputs, input: inputs[0] };
  const authority = await readStoryValidationAuthority(prepared);
  const bundles = validateStoryOwnerBundles(prepared, authority);
  const proposalRoot = await directProposalDirectory(proposalDirectory, manifest.shards.map((shard) => shard.id));
  const proposals = new Map();
  for (const shard of manifest.shards) {
    const value = (await readStrictJson(resolve(proposalRoot, `${shard.id}.json`),
      MAX_STORY_PREPARATION_FILE_BYTES, {
        invalid: "PROPOSAL_UNREADABLE", changed: "PROPOSAL_CHANGED",
        oversized: "PROPOSAL_TOO_LARGE", jsonInvalid: "PROPOSAL_JSON_INVALID",
      })).value;
    if (!Array.isArray(value) || value.length === 0) fail("STORY_PROPOSAL_INVALID");
    const shardProposals = value.map(storyProposal);
    const proposalOwners = shardProposals.map((proposal) => proposal.ownerId).sort(compareUtf8);
    if (new Set(proposalOwners).size !== proposalOwners.length
      || canonicalAuthorityJson(proposalOwners) !== canonicalAuthorityJson(shard.unitIds)) {
      fail("STORY_PROPOSAL_OWNER_INVALID");
    }
    for (const proposal of shardProposals) {
      if (proposals.has(proposal.ownerId)) fail("STORY_PROPOSAL_OWNER_INVALID");
      proposals.set(proposal.ownerId, proposal);
    }
  }
  const phaseValue = (await readStrictJson(phasePath, MAX_STORY_PREPARATION_FILE_BYTES, {
    invalid: "STORY_PHASE_ASSIGNMENT_INVALID", changed: "STORY_PHASE_ASSIGNMENT_CHANGED",
    oversized: "STORY_PHASE_ASSIGNMENT_TOO_LARGE", jsonInvalid: "STORY_PHASE_ASSIGNMENT_INVALID",
  })).value;
  const phases = phaseAssignments(phaseValue, [...bundles.keys()]);
  const evidenceById = new Map(authority.evidence.map((row) => [row.id, row]));
  const candidates = [];
  for (const [ownerId, bundle] of bundles) {
    const proposal = proposals.get(ownerId);
    if (!proposal) fail("STORY_PROPOSAL_OWNER_INVALID");
    const references = [proposal.chapter.evidence.primary, ...proposal.chapter.evidence.supporting];
    if (references.some((reference) => !bundle.memberIds.has(reference.eventId))) {
      fail("STORY_PROPOSAL_EVIDENCE_INVALID");
    }
    const primary = evidenceById.get(proposal.chapter.evidence.primary.eventId);
    if (!primary || primary.documentId !== proposal.chapter.evidence.primary.documentId) {
      fail("STORY_PROPOSAL_EVIDENCE_INVALID");
    }
    candidates.push({
      ownerId,
      shardId: bundle.shardId,
      proposal,
      id: primary.id,
      documentId: primary.documentId,
      sequence: primary.sequence,
      timestamp: primary.timestamp,
    });
  }
  candidates.sort(compareStorySourceIdentity);
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) {
    fail("STORY_OUTPUT_IDENTITY_INVALID");
  }
  const exclusions = authority.coverageManifest.rows.filter((row) => row.disposition === "excluded")
    .map((row) => ({ unitId: row.unitId, reason: row.exclusionReason }))
    .sort((left, right) => compareUtf8(left.unitId, right.unitId) || compareUtf8(left.reason, right.reason));
  const output = candidates.map((candidate, index) => {
    const bundle = bundles.get(candidate.ownerId);
    const chapter = candidate.proposal.chapter;
    const story = parseStory({
      schema: "oxygen.story",
      key: candidate.ownerId,
      phase: phases.get(candidate.ownerId),
      ...(chapter.kind === undefined ? {} : { kind: chapter.kind }),
      title: chapter.title,
      overview: chapter.overview,
      ...(chapter.transition === undefined ? {} : { transition: chapter.transition }),
      ...(chapter.chips === undefined ? {} : { chips: chapter.chips }),
      people: chapter.people,
      story: chapter.story,
      insights: [],
      evidence: chapter.evidence,
      coverage: {
        semanticManifest: bundle.semanticManifest,
        coverageManifest: bundle.coverageManifest,
        representedUnitIds: bundle.unitIds,
        excludedUnits: index === 0 ? exclusions : [],
      },
    });
    return { ...candidate, record: { id: candidate.id, story } };
  });
  const validation = validateStorySourcePackage(output.map((candidate) => ({
    id: candidate.id,
    documentId: candidate.documentId,
    sequence: candidate.sequence,
    timestamp: candidate.timestamp,
    summary: `${STORY_PREFIX}${canonicalAuthorityJson(candidate.record.story)}`,
  })), storyEvidenceRows(authority), storyCompletenessAuthority(authority));
  if (!validation.ok) fail(validation.code);
  const outputs = new Map(manifest.shards.map((shard) => [
    shard.id,
    output.filter((candidate) => candidate.shardId === shard.id).map((candidate) => candidate.record),
  ]));
  return { prepared, outputs };
}

async function validateInsight(value, input, prepared) {
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
  const completeRows = output.map((record) => {
    const story = parseStory({ ...baseByKey.get(record.storyKey), insights: record.insights });
    const candidate = input.payload.storyCandidates.find((row) => parseStorySource(row.summary)?.key === record.storyKey);
    if (!candidate) fail("WORKER_INPUT_TAMPERED");
    return {
      id: candidate.id,
      documentId: story.evidence.primary.documentId,
      summary: `${STORY_PREFIX}${canonicalAuthorityJson(story)}`,
      story,
    };
  });
  const unitIds = completeRows.flatMap(({ story }) => [
    ...story.coverage.representedUnitIds,
    ...story.coverage.excludedUnits.map((excluded) => excluded.unitId),
  ]);
  if (new Set(unitIds).size !== unitIds.length) fail("STORY_COVERAGE_INVALID");
  const authority = await readStoryValidationAuthority(prepared);
  const scope = storyValidationScope(authority, unitIds);
  const validation = validateStorySourcePackage(
    completeRows.map(({ story, ...row }) => row),
    scope.evidenceRows,
    scope.completenessAuthority,
  );
  if (!validation.ok) fail(validation.code);
  return { output, count: output.reduce((total, record) => total + record.insights.length, 0) };
}

function validatePrivacy(value, input) {
  if (!Array.isArray(value) || !Array.isArray(input.payload?.storyCandidates)
    || !Array.isArray(input.payload?.releaseTargetCatalog)) fail("PRIVACY_OUTPUT_INVALID");
  const stories = input.payload.storyCandidates.map((row) => parseStorySource(row?.summary));
  if (stories.some((story) => !story)) fail("WORKER_INPUT_TAMPERED");
  const fullCatalog = deriveStoryReleaseTargetCatalog(stories);
  const valid = new Set(input.unitIds);
  const catalog = fullCatalog?.filter((target) => valid.has(target.id));
  if (!catalog || catalog.length !== valid.size
    || canonicalAuthorityJson(catalog) !== canonicalAuthorityJson(input.payload.releaseTargetCatalog)) {
    fail("WORKER_INPUT_TAMPERED");
  }
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
    || !nonnegative(value.sourceRevision) || value.sourceRevision < 1
    || value.inputDigest !== input.inputDigest
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
  if (lane === "insight") return validateInsight(value, input, prepared);
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

async function recordStoryBatch(rootInput, proposalDirectory, phasePath, correctionAttemptCount) {
  if (!Number.isSafeInteger(correctionAttemptCount) || correctionAttemptCount < 0) fail("CLI_USAGE");
  if (correctionAttemptCount > 2) fail("STORY_CORRECTION_EXHAUSTED");
  const { prepared, outputs } = await storyBatchProposal(rootInput, proposalDirectory, phasePath);
  const recordsPath = resolve(prepared.root, laneDirectory.story, "records");
  const state = await exists(recordsPath);
  if (state) {
    if (!state.isDirectory() || state.isSymbolicLink()) fail("PARTIAL_BATCH_REJECTED");
    const receipts = [];
    for (const shard of prepared.shards) {
      let authority;
      try {
        authority = await readShardAuthority(prepared.root, "story", shard.id);
      } catch {
        fail("PARTIAL_BATCH_REJECTED");
      }
      if (canonicalAuthorityJson(authority.output) !== canonicalAuthorityJson(outputs.get(shard.id))) {
        fail("AUTHORITY_IMMUTABLE");
      }
      receipts.push(authority.receipt);
    }
    return receipts;
  }
  const storyRoot = resolve(prepared.root, laneDirectory.story);
  const temporary = resolve(storyRoot, `.records.${process.pid}.${randomUUID()}.tmp`);
  const receipts = [];
  try {
    await mkdir(temporary);
    for (const shard of prepared.shards) {
      const output = outputs.get(shard.id);
      const outputPath = relativeLanePath("story", `records/${shard.id}/output.json`);
      const receipt = {
        schema: "oxygen.story-preparation-worker-receipt",
        lane: "story",
        shardId: shard.id,
        status: "complete",
        inputDigest: prepared.manifest.inputDigest,
        workerInputDigest: shard.workerInputDigest,
        unitIds: shard.unitIds,
        outputPath,
        outputDigest: canonicalDigest(output),
        outputCount: output.length,
      };
      const recordRoot = resolve(temporary, shard.id);
      await mkdir(recordRoot);
      await writeSynced(resolve(recordRoot, "output.json"), output);
      await writeSynced(resolve(recordRoot, "receipt.json"), receipt);
      receipts.push(receipt);
    }
    try {
      await rename(temporary, recordsPath);
    } catch (error) {
      if (error?.code === "EEXIST" || error?.code === "ENOTEMPTY") fail("AUTHORITY_IMMUTABLE");
      throw error;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
  return receipts;
}

async function record(rootInput, lane, shardId, proposalPath) {
  if (!LANES.includes(lane) || lane === "story" || !stableId(shardId)) fail("CLI_USAGE");
  const prepared = await readPreparedShard(rootInput, lane, shardId);
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
      authority = await readShardAuthority(prepared.root, lane, shardId);
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
  const args = process.argv.slice(2);
  const [root, lane] = args;
  if (lane === "story") {
    const [storyRoot, storyLane, proposalDirectory, phasePath, marker, count, ...extra] = args;
    if (!storyRoot || storyLane !== "story" || !proposalDirectory || !phasePath
      || marker !== "--correction-attempt-count" || !/^(0|[1-9][0-9]*)$/u.test(count || "")
      || extra.length) fail("CLI_USAGE");
    const receipts = await recordStoryBatch(
      storyRoot, proposalDirectory, phasePath, Number(count),
    );
    process.stdout.write(`${canonicalAuthorityJson({
      ok: true,
      lane: "story",
      shardCount: receipts.length,
      outputCount: receipts.reduce((total, receipt) => total + receipt.outputCount, 0),
      terminalReceiptCount: receipts.length,
    })}\n`);
  } else {
    const [laneRoot, otherLane, shardId, proposalPath, ...extra] = args;
    if (!laneRoot || !otherLane || !shardId || !proposalPath || extra.length) fail("CLI_USAGE");
    const receipt = await record(laneRoot, otherLane, shardId, proposalPath);
    process.stdout.write(`${canonicalAuthorityJson({
      ok: true, lane: receipt.lane, shardId: receipt.shardId,
      outputDigest: receipt.outputDigest, outputCount: receipt.outputCount,
    })}\n`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof StoryPreparationTransportError ? error.code : "STORY_PREPARATION_RECORD_FAILED"}\n`);
  process.exitCode = 1;
}
