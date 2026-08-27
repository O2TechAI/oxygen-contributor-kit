#!/usr/bin/env node
import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalPreferenceQuestionBatch,
  deriveStoryReleaseTargetCatalog,
  storyPreparationDigest,
  validateStoryPreparationManifest,
} from "../../../viewer/lib/story-preparation.ts";
import { canonicalizeAutoRemoved } from "../../../viewer/lib/auto-removed.mjs";
import {
  normalizeBulkPreferencePresentations,
  normalizeProbePresentations,
} from "../../../viewer/lib/preference-presentation.ts";
import { canonicalAuthorityJson } from "../../../viewer/lib/story-readiness.ts";
import { compareStorySourceIdentity, parseStorySource } from "../../../viewer/lib/timeline.ts";

const lanes = ["story", "insight", "story_privacy", "preference"];
const laneFiles = Object.freeze({
  story: "story.shards.json",
  insight: "insight.shards.json",
  story_privacy: "story-privacy.shards.json",
  preference: "preference.shards.json",
});
const hex = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
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

class FinalizerError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const fail = (code) => { throw new FinalizerError(code); };
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => isObject(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const utf8 = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));
const stableId = (value) => typeof value === "string" && Boolean(value.trim())
  && !/[\u0000-\u001f\u007f]/u.test(value);
const safeText = (value) => typeof value === "string" && Boolean(value.trim())
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;

async function jsonFile(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    fail("FILE_UNREADABLE");
  }
  try {
    return JSON.parse(text);
  } catch {
    fail("JSON_INVALID");
  }
}

function contained(root, value) {
  if (typeof value !== "string" || !value || isAbsolute(value) || win32.isAbsolute(value)
    || value.split(/[\\/]/u).some((part) => part === "..")) fail("PATH_NOT_CONTAINED");
  const target = resolve(root, value);
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail("PATH_NOT_CONTAINED");
  return target;
}

function rejectMetadata(value) {
  if (Array.isArray(value)) {
    value.forEach(rejectMetadata);
    return;
  }
  if (!isObject(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (metadataKeys.has(key.replace(/[^a-z0-9]/giu, "").toLowerCase())) {
      fail("WORKER_METADATA_FORBIDDEN");
    }
    rejectMetadata(nested);
  }
}

function semanticAuthority(value) {
  if (!exactKeys(value, ["projectId", "revision", "sourceDigest", "universeDigest", "manifestDigest", "units"])
    || !stableId(value.projectId) || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !hex.test(value.sourceDigest) || !hex.test(value.universeDigest) || !hex.test(value.manifestDigest)
    || !Array.isArray(value.units)) fail("SEMANTIC_MANIFEST_INVALID");
  const canonical = {
    projectId: value.projectId,
    revision: value.revision,
    sourceDigest: value.sourceDigest,
    universeDigest: value.universeDigest,
    units: [...value.units].sort((left, right) => utf8(String(left?.id), String(right?.id))),
  };
  return storyPreparationDigest(canonical).then((digest) => {
    if (digest !== value.manifestDigest) fail("SEMANTIC_MANIFEST_DIGEST_STALE");
    const unitIds = canonical.units.map((unit) => unit?.id);
    if (unitIds.some((id) => !stableId(id)) || new Set(unitIds).size !== unitIds.length) {
      fail("SEMANTIC_UNIT_SET_INVALID");
    }
    return { manifestDigest: value.manifestDigest, unitIds: unitIds.sort(utf8) };
  });
}

function finalCandidates(value) {
  if (!Array.isArray(value) || value.length === 0) fail("FINAL_STORY_CANDIDATES_INVALID");
  const rows = [];
  for (const candidate of value) {
    if (!isObject(candidate)
      || !Object.keys(candidate).every((key) => ["id", "documentId", "sequence", "timestamp", "summary"].includes(key))
      || !stableId(candidate.id) || !stableId(candidate.documentId) || !nonnegative(candidate.sequence)
      || (candidate.timestamp !== undefined && candidate.timestamp !== null && typeof candidate.timestamp !== "string")
      || typeof candidate.summary !== "string") fail("FINAL_STORY_CANDIDATES_INVALID");
    const story = parseStorySource(candidate.summary);
    if (!story || !stableId(story.key)) fail("FINAL_STORY_CANDIDATES_INVALID");
    rows.push({
      id: candidate.id,
      documentId: candidate.documentId,
      sequence: candidate.sequence,
      ...(candidate.timestamp === undefined ? {} : { timestamp: candidate.timestamp }),
      summary: candidate.summary,
      story,
    });
  }
  rows.sort(compareStorySourceIdentity);
  if (new Set(rows.map((row) => row.id)).size !== rows.length
    || new Set(rows.map((row) => row.story.key)).size !== rows.length) fail("FINAL_STORY_IDENTITIES_INVALID");
  return rows;
}

function normalizedPrivacy(value, catalog) {
  if (!Array.isArray(value)) fail("PRIVACY_OUTPUT_INVALID");
  const valid = new Set(catalog.map((target) => target.id));
  const order = new Map(catalog.map((target, index) => [target.id, index]));
  const result = [];
  for (const candidate of value) {
    rejectMetadata(candidate);
    if (!exactKeys(candidate, ["id", "reviewState", "title", "whyFlagged", "uncertaintyReason", "releaseTargets"])
      || !stableId(candidate.id) || !["deterministic", "needs_confirmation"].includes(candidate.reviewState)
      || !stableId(candidate.title) || !stableId(candidate.whyFlagged)
      || (candidate.reviewState === "deterministic" && candidate.uncertaintyReason !== null)
      || (candidate.reviewState === "needs_confirmation" && !stableId(candidate.uncertaintyReason))
      || !Array.isArray(candidate.releaseTargets) || candidate.releaseTargets.length === 0
      || candidate.releaseTargets.some((target) => !valid.has(target))
      || new Set(candidate.releaseTargets).size !== candidate.releaseTargets.length) fail("PRIVACY_OUTPUT_INVALID");
    result.push({ ...candidate, releaseTargets: [...candidate.releaseTargets].sort((a, b) => order.get(a) - order.get(b)) });
  }
  return dedupe(result, (item) => item.id).sort((a, b) => utf8(a.id, b.id));
}

function dedupe(items, identity) {
  const found = new Map();
  for (const item of items) {
    const key = identity(item);
    const prior = found.get(key);
    if (prior !== undefined && canonicalAuthorityJson(prior) !== canonicalAuthorityJson(item)) {
      fail("WORKER_OUTPUT_IDENTITY_CONFLICT");
    }
    found.set(key, item);
  }
  return [...found.values()];
}

async function laneManifest(root, lane, expectedInputDigest, universe) {
  const path = contained(root, laneFiles[lane]);
  const value = await jsonFile(path);
  if (!exactKeys(value, ["schema", "lane", "inputDigest", "unitIds", "shards"])
    || value.schema !== "oxygen.story-preparation-shards" || value.lane !== lane
    || value.inputDigest !== expectedInputDigest || !Array.isArray(value.unitIds) || !Array.isArray(value.shards)) {
    fail("SHARD_MANIFEST_INVALID");
  }
  const unitIds = [...value.unitIds];
  if (unitIds.some((id) => !stableId(id)) || new Set(unitIds).size !== unitIds.length
    || canonicalAuthorityJson(unitIds.sort(utf8)) !== canonicalAuthorityJson([...universe].sort(utf8))) fail("SHARD_MANIFEST_UNIVERSE_INVALID");
  if ((universe.length === 0) !== (value.shards.length === 0)) fail("SHARD_MANIFEST_EMPTY_INVALID");
  const seenShards = new Set();
  const assigned = [];
  const outputs = [];
  for (const shard of value.shards) {
    if (!exactKeys(shard, ["id", "unitIds", "receiptPath"]) || !stableId(shard.id)
      || seenShards.has(shard.id) || !Array.isArray(shard.unitIds) || shard.unitIds.length === 0
      || shard.unitIds.some((id) => !stableId(id)) || new Set(shard.unitIds).size !== shard.unitIds.length) {
      fail("SHARD_INVALID");
    }
    seenShards.add(shard.id);
    assigned.push(...shard.unitIds);
    const receiptPath = contained(root, shard.receiptPath);
    const receipt = await jsonFile(receiptPath);
    if (!exactKeys(receipt, ["schema", "lane", "shardId", "status", "inputDigest", "unitIds", "outputPath"])
      || receipt.schema !== "oxygen.story-preparation-worker-receipt" || receipt.lane !== lane
      || receipt.shardId !== shard.id || receipt.status !== "complete" || receipt.inputDigest !== expectedInputDigest
      || !Array.isArray(receipt.unitIds) || canonicalAuthorityJson([...receipt.unitIds].sort(utf8))
        !== canonicalAuthorityJson([...shard.unitIds].sort(utf8))) fail("RECEIPT_INVALID");
    const outputPath = contained(root, receipt.outputPath);
    const output = await jsonFile(outputPath);
    outputs.push(output);
  }
  if (assigned.length !== new Set(assigned).size
    || canonicalAuthorityJson(assigned.sort(utf8)) !== canonicalAuthorityJson([...universe].sort(utf8))) fail("SHARD_UNION_INVALID");
  return outputs;
}

function expectedStoryOutputs(rows) {
  const base = rows.map((row) => ({ id: row.id, story: { ...row.story, insights: [] } }));
  const complete = rows.map((row) => ({ id: row.id, story: row.story }));
  const insightCount = rows.reduce((total, row) => total + row.story.insights.length, 0);
  return { base, complete, insightCount };
}

function composeStory(outputs, expected, label) {
  const records = outputs.flat();
  if (!records.every((record) => exactKeys(record, ["id", "story"]) && stableId(record.id))) {
    fail(`${label}_OUTPUT_INVALID`);
  }
  const actual = dedupe(records, (record) => record.id).sort((a, b) => utf8(a.id, b.id));
  const wanted = [...expected].sort((a, b) => utf8(a.id, b.id));
  if (canonicalAuthorityJson(actual) !== canonicalAuthorityJson(wanted)) fail(`${label}_OUTPUT_STALE`);
}

function preferenceOption(value) {
  return exactKeys(value, ["id", "text"]) && stableId(value.id) && safeText(value.text);
}

function preferenceProbe(value) {
  if (!exactKeys(value, probeKeys) || !stableId(value.id) || !stableId(value.documentId)
    || !["trajectory", "meeting"].includes(value.documentKind)
    || !Array.isArray(value.eventIds) || value.eventIds.length === 0
    || value.eventIds.some((eventId) => !stableId(eventId))
    || new Set(value.eventIds).size !== value.eventIds.length
    || (value.timestamp !== null && !safeText(value.timestamp)) || !signals.has(value.signal)
    || !nonnegative(value.score) || value.score > 100 || !nonnegative(value.turns)
    || !safeText(value.recap) || !safeText(value.question)
    || !Array.isArray(value.options) || ![2, 3].includes(value.options.length)
    || value.options.some((option) => !preferenceOption(option))
    || new Set(value.options.map((option) => option.id)).size !== value.options.length
    || value.allowOther !== true || value.allowSkip !== true) fail("PREFERENCE_BUNDLE_INVALID");
  const presentations = normalizeProbePresentations(value.presentations, value.options);
  if (presentations === null
    || canonicalAuthorityJson(presentations) !== canonicalAuthorityJson(value.presentations)) {
    fail("PREFERENCE_BUNDLE_INVALID");
  }
  return value;
}

function preferenceBulkDecision(value) {
  if (!exactKeys(value, bulkKeys) || !stableId(value.id) || !safeText(value.kind)
    || !nonnegative(value.count) || !safeText(value.question) || !Array.isArray(value.evidenceSample)
    || value.evidenceSample.some((eventId) => !stableId(eventId))
    || new Set(value.evidenceSample).size !== value.evidenceSample.length) fail("PREFERENCE_BUNDLE_INVALID");
  const presentations = normalizeBulkPreferencePresentations(value.presentations);
  if (presentations === null
    || canonicalAuthorityJson(presentations) !== canonicalAuthorityJson(value.presentations)) {
    fail("PREFERENCE_BUNDLE_INVALID");
  }
  return value;
}

async function preferenceAuthority(value, workflowRunId, sourceRevision, inputDigest) {
  if (!exactKeys(value, preferenceKeys) || value.workflowRunId !== workflowRunId
    || value.sourceRevision !== sourceRevision || value.inputDigest !== inputDigest
    || !hex.test(value.outputDigest) || !nonnegative(value.outputCount)
    || !nonnegative(value.setAside) || !Array.isArray(value.probes)
    || !Array.isArray(value.bulkDecisions)) fail("PREFERENCE_BUNDLE_INVALID");
  rejectMetadata({ probes: value.probes, bulkDecisions: value.bulkDecisions });
  const probes = value.probes.map(preferenceProbe);
  const bulkDecisions = value.bulkDecisions.map(preferenceBulkDecision);
  const ids = [...probes, ...bulkDecisions].map((item) => item.id);
  if (new Set(ids).size !== ids.length || value.outputCount !== ids.length
    || (value.outputCount === 0 && value.setAside !== 0)) fail("PREFERENCE_BUNDLE_INVALID");
  try {
    canonicalizeAutoRemoved(value.autoRemoved);
  } catch {
    fail("PREFERENCE_BUNDLE_INVALID");
  }
  const batch = canonicalPreferenceQuestionBatch(probes, bulkDecisions);
  if (await storyPreparationDigest(batch) !== value.outputDigest) fail("PREFERENCE_BUNDLE_INVALID");
  return value;
}

function composePreference(outputs, authority) {
  const probes = [];
  const bulkDecisions = [];
  for (const output of outputs) {
    rejectMetadata(output);
    if (!exactKeys(output, ["probes", "bulkDecisions"]) || !Array.isArray(output.probes)
      || !Array.isArray(output.bulkDecisions)) fail("PREFERENCE_OUTPUT_INVALID");
    probes.push(...output.probes);
    bulkDecisions.push(...output.bulkDecisions);
  }
  const composed = canonicalPreferenceQuestionBatch(
    dedupe(probes, (item) => typeof item?.id === "string" ? `probe:${item.id}` : fail("PREFERENCE_OUTPUT_INVALID")),
    dedupe(bulkDecisions, (item) => typeof item?.id === "string" ? `bulk:${item.id}` : fail("PREFERENCE_OUTPUT_INVALID")),
  );
  const supplied = canonicalPreferenceQuestionBatch(authority.probes, authority.bulkDecisions);
  if (canonicalAuthorityJson(composed) !== canonicalAuthorityJson(supplied)) fail("PREFERENCE_OUTPUT_STALE");
  return composed;
}

async function finalize(args) {
  const [semanticPath, candidatesPath, shardRootInput, preferencePath, outputPath, marker, workflowRunId, revisionMarker, revision] = args;
  if (!semanticPath || !candidatesPath || !shardRootInput || !preferencePath || !outputPath
    || marker !== "--workflow-run-id" || !stableId(workflowRunId) || revisionMarker !== "--source-revision"
    || !/^(0|[1-9][0-9]*)$/u.test(revision || "")) fail("CLI_USAGE");
  const sourceRevision = Number(revision);
  if (!Number.isSafeInteger(sourceRevision)) fail("CLI_USAGE");
  const shardRoot = resolve(shardRootInput);
  const semantic = await semanticAuthority(await jsonFile(resolve(semanticPath)));
  const rows = finalCandidates(await jsonFile(resolve(candidatesPath)));
  const sourceRows = rows.map(({ story, ...row }) => row);
  const { base, complete, insightCount } = expectedStoryOutputs(rows);
  const storyKeys = rows.map((row) => row.story.key).sort(utf8);
  const catalog = deriveStoryReleaseTargetCatalog(rows.map((row) => row.story));
  if (!catalog) fail("PRIVACY_CATALOG_INVALID");
  const lessons = rows.flatMap((row) => row.story.insights.map((insight) => ({
    storyKey: row.story.key,
    insightId: insight.id,
    ...(insight.title === undefined ? {} : { title: insight.title }),
    background: insight.background,
    directlyAcquiredExperience: insight.directlyAcquiredExperience,
    principle: insight.principle,
  })));
  const preferenceInputDigest = await storyPreparationDigest(lessons);
  const preference = await preferenceAuthority(await jsonFile(resolve(preferencePath)), workflowRunId, sourceRevision, preferenceInputDigest);
  const storyOutputs = await laneManifest(shardRoot, "story", semantic.manifestDigest, semantic.unitIds);
  composeStory(storyOutputs, base, "STORY");
  const baseDigest = await storyPreparationDigest(base);
  const insightOutputs = await laneManifest(shardRoot, "insight", baseDigest, storyKeys);
  composeStory(insightOutputs, insightCount === 0 ? [] : complete, "INSIGHT");
  const completeDigest = await storyPreparationDigest(complete);
  const privacyOutputs = await laneManifest(shardRoot, "story_privacy", completeDigest, catalog.map((target) => target.id));
  const privacy = normalizedPrivacy(privacyOutputs.flat(), catalog);
  const preferenceUniverse = rows.flatMap((row) => row.story.insights.map((insight) => ({
    storyKey: row.story.key, insightId: insight.id,
  }))).sort((a, b) => utf8(a.storyKey, b.storyKey) || utf8(a.insightId, b.insightId));
  const preferenceOutputs = await laneManifest(shardRoot, "preference", preferenceInputDigest,
    preferenceUniverse.map((identity) => canonicalAuthorityJson(identity)));
  const questions = composePreference(preferenceOutputs, preference);
  const outputDigest = await storyPreparationDigest(questions);
  if (outputDigest !== preference.outputDigest || questions.length !== preference.outputCount) fail("PREFERENCE_BUNDLE_STALE");
  const receipts = [
    { lane: "story", status: "complete", inputDigest: semantic.manifestDigest,
      scopeDigest: await storyPreparationDigest(semantic.unitIds), scopeCount: semantic.unitIds.length,
      outputDigest: baseDigest, outputCount: base.length },
    { lane: "insight", status: "complete", inputDigest: baseDigest,
      scopeDigest: await storyPreparationDigest(storyKeys), scopeCount: storyKeys.length,
      outputDigest: await storyPreparationDigest(insightCount === 0 ? [] : complete), outputCount: insightCount },
    { lane: "story_privacy", status: "complete", inputDigest: completeDigest,
      scopeDigest: await storyPreparationDigest(catalog.map((target) => target.id)), scopeCount: catalog.length,
      outputDigest: await storyPreparationDigest(privacy), outputCount: privacy.length },
    { lane: "preference", status: "complete", inputDigest: preferenceInputDigest,
      scopeDigest: await storyPreparationDigest(preferenceUniverse), scopeCount: preferenceUniverse.length,
      outputDigest, outputCount: questions.length },
  ];
  const manifest = { schema: "oxygen.story-preparation", workflowRunId, sourceRevision, receipts, storyPrivacyCandidates: privacy };
  const core = await validateStoryPreparationManifest(manifest, {
    workflowRunId,
    sourceRevision,
    semanticManifestDigest: semantic.manifestDigest,
    semanticUnitIds: semantic.unitIds,
    storyCandidates: sourceRows,
    preference: { workflowRunId, sourceRevision, inputDigest: preferenceInputDigest, outputDigest, outputCount: questions.length },
  });
  if (!core.ok) fail(`CORE_${core.code}`);
  const destination = resolve(outputPath);
  const temporary = resolve(dirname(destination), `.${basename(destination)}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(manifest)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, destination);
}

try {
  await finalize(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof FinalizerError ? error.code : "FINALIZER_FAILED"}\n`);
  process.exitCode = 1;
}
