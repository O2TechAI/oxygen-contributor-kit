#!/usr/bin/env node
import { rename, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
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
import {
  canonicalAuthorityJson,
  validateStorySourcePackage,
} from "../../../viewer/lib/story-readiness.ts";
import { compareStorySourceIdentity, parseStorySource } from "../../../viewer/lib/timeline.ts";
import {
  StoryPreparationTransportError,
  MAX_STORY_PREPARATION_FILE_BYTES,
  readSemanticTransport,
  readStrictJson,
} from "./story_preparation_transport.mjs";
import { readLaneAuthority } from "./story_preparation_protocol.mjs";
import {
  insightStoryEvidenceRows,
  readStoryValidationAuthority,
  storyCompletenessAuthority,
} from "./story_preparation_validation_authority.mjs";
const hex = /^[0-9a-f]{64}$/;
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
const boundedId = (value, maximum = 20_000) => stableId(value) && value.length <= maximum;
const boundedText = (value, maximum = 20_000) => safeText(value) && value.length <= maximum;
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
const normalizeOptionText = (value) => value.trim().replace(/\.+$/u, "")
  .replace(/[A-Z]/gu, (character) => String.fromCharCode(character.charCodeAt(0) + 32));

async function jsonFile(path) {
  return (await readStrictJson(path, MAX_STORY_PREPARATION_FILE_BYTES, {
    invalid: "FILE_UNREADABLE", changed: "FILE_CHANGED",
    oversized: "FILE_TOO_LARGE", jsonInvalid: "JSON_INVALID",
  })).value;
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

function finalCandidates(value) {
  if (!Array.isArray(value) || value.length === 0) fail("FINAL_STORY_CANDIDATES_INVALID");
  const rows = [];
  for (const candidate of value) {
    if (!exactKeys(candidate, ["id", "summary"])
      || !stableId(candidate.id) || typeof candidate.summary !== "string") {
      fail("FINAL_STORY_CANDIDATES_INVALID");
    }
    const story = parseStorySource(candidate.summary);
    if (!story || !stableId(story.key)) fail("FINAL_STORY_CANDIDATES_INVALID");
    rows.push({
      id: candidate.id,
      summary: candidate.summary,
      story,
    });
  }
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

function sameIds(actual, expected, code) {
  if (!Array.isArray(actual) || actual.some((id) => !stableId(id))
    || new Set(actual).size !== actual.length
    || canonicalAuthorityJson([...actual].sort(utf8)) !== canonicalAuthorityJson([...expected].sort(utf8))) {
    fail(code);
  }
}

function validateFinalStoryOwnerAuthority(storyAuthority, validationAuthority) {
  const representedRows = validationAuthority.coverageManifest.rows
    .filter((row) => row.disposition === "represented");
  const ownerIds = [...new Set(representedRows.map((row) => row.ownerId))].sort(utf8);
  if (ownerIds.length === 0) fail("STORY_ZERO_REPRESENTED_OWNER_UNSUPPORTED");
  sameIds(storyAuthority.manifest.unitIds, ownerIds, "STORY_OWNER_SCOPE_STALE");
  const unitOwner = new Map(representedRows.map((row) => [row.unitId, row.ownerId]));
  const seenOwners = new Set();
  const seenUnits = new Set();
  for (const [index, input] of storyAuthority.inputs.entries()) {
    if (!exactKeys(input.payload, [
      "validationAuthorityPath", "validationAuthorityDigest", "ownerBundles",
    ]) || !Array.isArray(input.payload.ownerBundles) || input.payload.ownerBundles.length === 0) {
      fail("STORY_INPUT_STALE");
    }
    const inputOwners = [];
    for (const bundle of input.payload.ownerBundles) {
      if (!exactKeys(bundle, [
        "ownerId", "semanticManifest", "coverageManifest", "semanticUnits", "reviewedNarrative",
      ]) || !stableId(bundle.ownerId) || seenOwners.has(bundle.ownerId)
        || !Array.isArray(bundle.semanticUnits) || bundle.semanticUnits.length === 0) {
        fail("STORY_OWNER_SCOPE_STALE");
      }
      seenOwners.add(bundle.ownerId);
      inputOwners.push(bundle.ownerId);
      for (const unit of bundle.semanticUnits) {
        if (!stableId(unit?.id) || seenUnits.has(unit.id) || unitOwner.get(unit.id) !== bundle.ownerId) {
          fail("STORY_OWNER_SCOPE_STALE");
        }
        seenUnits.add(unit.id);
      }
    }
    sameIds(inputOwners, input.unitIds, "STORY_OWNER_SCOPE_STALE");
    const shardOutput = storyAuthority.outputs[index];
    if (!Array.isArray(shardOutput)) fail("STORY_OUTPUT_INVALID");
    sameIds(shardOutput.map((record) => record?.story?.key), input.unitIds, "STORY_OWNER_SCOPE_STALE");
  }
  sameIds([...seenOwners], ownerIds, "STORY_OWNER_SCOPE_STALE");
  sameIds([...seenUnits], [...unitOwner.keys()], "STORY_SCOPE_STALE");
}

function composeInsight(output, base, complete, storyKeys) {
  if (!Array.isArray(output)) fail("INSIGHT_OUTPUT_INVALID");
  const records = output.map((record) => {
    if (!exactKeys(record, ["storyKey", "insights"]) || !stableId(record.storyKey)
      || !Array.isArray(record.insights)) fail("INSIGHT_OUTPUT_INVALID");
    return record;
  }).sort((left, right) => utf8(left.storyKey, right.storyKey));
  sameIds(records.map((record) => record.storyKey), storyKeys, "INSIGHT_OUTPUT_IDENTITY_INVALID");
  const byKey = new Map(records.map((record) => [record.storyKey, record.insights]));
  const composed = base.map((record) => ({
    id: record.id,
    story: { ...record.story, insights: byKey.get(record.story.key) },
  }));
  if (canonicalAuthorityJson(composed) !== canonicalAuthorityJson(complete)) fail("INSIGHT_OUTPUT_STALE");
  return records.reduce((total, record) => total + record.insights.length, 0);
}

function preferenceOption(value) {
  return exactKeys(value, ["id", "text"]) && boundedId(value.id, 200) && boundedText(value.text);
}

function preferenceProbe(value, evidence) {
  if (!exactKeys(value, probeKeys) || !boundedId(value.id) || !boundedId(value.documentId)
    || !["trajectory", "meeting"].includes(value.documentKind)
    || !Array.isArray(value.eventIds) || value.eventIds.length === 0
    || value.eventIds.some((eventId) => !boundedId(eventId, 1_000))
    || new Set(value.eventIds).size !== value.eventIds.length
    || value.eventIds.some((eventId) => !evidence.has(canonicalAuthorityJson([value.documentId, eventId])))
    || (value.timestamp !== null && !boundedText(value.timestamp)) || !signals.has(value.signal)
    || !nonnegative(value.score) || value.score > 100 || !nonnegative(value.turns)
    || !boundedText(value.recap) || !boundedText(value.question)
    || !Array.isArray(value.options) || ![2, 3].includes(value.options.length)
    || value.options.some((option) => !preferenceOption(option))
    || new Set(value.options.map((option) => option.id)).size !== value.options.length
    || value.allowOther !== true || value.allowSkip !== true) fail("PREFERENCE_BUNDLE_INVALID");
  const normalizedOptions = value.options.map((option) => normalizeOptionText(option.text));
  if (new Set(normalizedOptions).size !== normalizedOptions.length
    || normalizedOptions.some((option) => genericOptions.has(option))) fail("PREFERENCE_BUNDLE_INVALID");
  const presentations = normalizeProbePresentations(value.presentations, value.options);
  if (presentations === null
    || canonicalAuthorityJson(presentations) !== canonicalAuthorityJson(value.presentations)) {
    fail("PREFERENCE_BUNDLE_INVALID");
  }
  return value;
}

function preferenceBulkDecision(value, evidenceIds) {
  if (!exactKeys(value, bulkKeys) || !boundedId(value.id) || !boundedText(value.kind)
    || !nonnegative(value.count) || !boundedText(value.question) || !Array.isArray(value.evidenceSample)
    || value.evidenceSample.some((eventId) => !boundedId(eventId, 1_000) || !evidenceIds.has(eventId))
    || new Set(value.evidenceSample).size !== value.evidenceSample.length) fail("PREFERENCE_BUNDLE_INVALID");
  const presentations = normalizeBulkPreferencePresentations(value.presentations);
  if (presentations === null
    || canonicalAuthorityJson(presentations) !== canonicalAuthorityJson(value.presentations)) {
    fail("PREFERENCE_BUNDLE_INVALID");
  }
  return value;
}

async function preferenceAuthority(value, workflowRunId, sourceRevision, inputDigest, evidence, evidenceIds) {
  if (!exactKeys(value, preferenceKeys) || value.workflowRunId !== workflowRunId
    || value.sourceRevision !== sourceRevision || value.inputDigest !== inputDigest
    || !hex.test(value.outputDigest) || !nonnegative(value.outputCount)
    || !nonnegative(value.setAside) || !Array.isArray(value.probes)
    || !Array.isArray(value.bulkDecisions)) fail("PREFERENCE_BUNDLE_INVALID");
  rejectMetadata({ probes: value.probes, bulkDecisions: value.bulkDecisions });
  const probes = value.probes.map((probe) => preferenceProbe(probe, evidence));
  const bulkDecisions = value.bulkDecisions.map((decision) => preferenceBulkDecision(decision, evidenceIds));
  const ids = [...probes, ...bulkDecisions].map((item) => item.id);
  if (new Set(ids).size !== ids.length || value.outputCount !== ids.length
    || (value.outputCount === 0 && value.setAside !== 0)
    || canonicalAuthorityJson(probes) !== canonicalAuthorityJson(
      [...probes].sort((left, right) => utf8(left.id, right.id)),
    ) || canonicalAuthorityJson(bulkDecisions) !== canonicalAuthorityJson(
      [...bulkDecisions].sort((left, right) => utf8(left.id, right.id)),
    )) fail("PREFERENCE_BUNDLE_INVALID");
  try {
    const autoRemoved = canonicalizeAutoRemoved(value.autoRemoved);
    const categories = autoRemoved.categories;
    if (autoRemoved.reversible !== true
      || categories.some((category) => !autoRemovedKinds.has(category.kind) || category.count === 0)
      || canonicalAuthorityJson(categories) !== canonicalAuthorityJson(
        [...categories].sort((left, right) => utf8(left.kind, right.kind)),
      )) fail("PREFERENCE_BUNDLE_INVALID");
  } catch {
    fail("PREFERENCE_BUNDLE_INVALID");
  }
  const batch = canonicalPreferenceQuestionBatch(probes, bulkDecisions);
  if (await storyPreparationDigest(batch) !== value.outputDigest) fail("PREFERENCE_BUNDLE_INVALID");
  return value;
}

async function finalize(args) {
  const [semanticPath, candidatesPath, shardRootInput, preferencePath, outputPath, marker, workflowRunId, revisionMarker, revision] = args;
  if (args.length !== 9 || !semanticPath || !candidatesPath || !shardRootInput || !preferencePath || !outputPath
    || marker !== "--workflow-run-id" || !stableId(workflowRunId) || revisionMarker !== "--source-revision"
    || !/^[1-9][0-9]*$/u.test(revision || "")) fail("CLI_USAGE");
  const sourceRevision = Number(revision);
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 1) fail("CLI_USAGE");
  const semantic = await readSemanticTransport(semanticPath, {
    invalid: "FILE_UNREADABLE", changed: "FILE_CHANGED", jsonInvalid: "JSON_INVALID",
  });
  const semanticUnitIds = semantic.units.map((unit) => unit.id).sort(utf8);
  let rows = finalCandidates(await jsonFile(resolve(candidatesPath)));
  const storyAuthority = await readLaneAuthority(shardRootInput, "story");
  const validationAuthority = await readStoryValidationAuthority(storyAuthority);
  if (canonicalAuthorityJson(validationAuthority.semanticManifest) !== canonicalAuthorityJson(semantic)) {
    fail("STORY_INPUT_STALE");
  }
  validateFinalStoryOwnerAuthority(storyAuthority, validationAuthority);
  const sourceEvidence = new Map(validationAuthority.evidence.map((row) => [row.id, row]));
  rows = [...rows].sort((left, right) => {
    const a = sourceEvidence.get(left.story.evidence.primary.eventId);
    const b = sourceEvidence.get(right.story.evidence.primary.eventId);
    if (!a || !b) fail("FINAL_STORY_IDENTITIES_INVALID");
    return compareStorySourceIdentity(a, b);
  });
  const sourceRows = rows.map(({ story, ...row }) => row);
  const validationRows = rows.map(({ story, ...row }) => ({
    ...row,
    documentId: story.evidence.primary.documentId,
  }));
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
  const insightGrounding = rows.flatMap((row) => row.story.insights.flatMap((insight) => (
    [insight.quote.evidence, ...insight.evidence]
  )));
  const evidence = new Set(insightGrounding.map((reference) => (
    canonicalAuthorityJson([reference.documentId, reference.eventId])
  )));
  const evidenceIds = new Set(insightGrounding.map((reference) => reference.eventId));
  const preferenceInputDigest = await storyPreparationDigest(lessons);
  const preference = await preferenceAuthority(
    await jsonFile(resolve(preferencePath)), workflowRunId, sourceRevision,
    preferenceInputDigest, evidence, evidenceIds,
  );
  composeStory([storyAuthority.output], base, "STORY");
  if (storyAuthority.outputCount !== base.length) fail("STORY_RECEIPT_STALE");
  const baseDigest = await storyPreparationDigest(base);
  const insightAuthority = await readLaneAuthority(shardRootInput, "insight");
  if (insightAuthority.manifest.inputDigest !== baseDigest) fail("INSIGHT_INPUT_STALE");
  sameIds(insightAuthority.manifest.unitIds, storyKeys, "INSIGHT_SCOPE_STALE");
  const recordedInsightCount = composeInsight(insightAuthority.output, base, complete, storyKeys);
  if (recordedInsightCount !== insightCount || insightAuthority.outputCount !== insightCount) {
    fail("INSIGHT_RECEIPT_STALE");
  }
  const insightEvidenceRows = insightStoryEvidenceRows(
    validationAuthority,
    insightAuthority.inputs,
    storyAuthority.inputs,
    storyAuthority.output,
  );
  const storyValidation = validateStorySourcePackage(
    validationRows,
    insightEvidenceRows,
    storyCompletenessAuthority(validationAuthority),
  );
  if (!storyValidation.ok) fail(storyValidation.code);
  const completeDigest = await storyPreparationDigest(complete);
  const privacyAuthority = await readLaneAuthority(shardRootInput, "story_privacy");
  if (privacyAuthority.manifest.inputDigest !== completeDigest) fail("PRIVACY_INPUT_STALE");
  sameIds(privacyAuthority.manifest.unitIds, catalog.map((target) => target.id), "PRIVACY_SCOPE_STALE");
  const privacy = normalizedPrivacy(privacyAuthority.output, catalog);
  if (privacyAuthority.outputCount !== privacy.length) fail("PRIVACY_RECEIPT_STALE");
  const preferenceUniverse = rows.flatMap((row) => row.story.insights.map((insight) => ({
    storyKey: row.story.key, insightId: insight.id,
  }))).sort((a, b) => utf8(a.storyKey, b.storyKey) || utf8(a.insightId, b.insightId));
  const preferenceAuthorityRecord = await readLaneAuthority(shardRootInput, "preference");
  if (preferenceAuthorityRecord.manifest.inputDigest !== preferenceInputDigest) fail("PREFERENCE_INPUT_STALE");
  sameIds(preferenceAuthorityRecord.manifest.unitIds,
    preferenceUniverse.map((identity) => canonicalAuthorityJson(identity)), "PREFERENCE_SCOPE_STALE");
  if (canonicalAuthorityJson(preferenceAuthorityRecord.output) !== canonicalAuthorityJson(preference)
    || preferenceAuthorityRecord.receipt.outputCount !== preference.outputCount) fail("PREFERENCE_OUTPUT_STALE");
  const questions = canonicalPreferenceQuestionBatch(preference.probes, preference.bulkDecisions);
  const outputDigest = await storyPreparationDigest(questions);
  if (outputDigest !== preference.outputDigest || questions.length !== preference.outputCount) fail("PREFERENCE_BUNDLE_STALE");
  const receipts = [
    { lane: "story", status: "complete", inputDigest: semantic.manifestDigest,
      scopeDigest: await storyPreparationDigest(semanticUnitIds), scopeCount: semanticUnitIds.length,
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
    semanticUnitIds,
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
  process.stderr.write(`${error instanceof FinalizerError || error instanceof StoryPreparationTransportError
    ? error.code : "FINALIZER_FAILED"}\n`);
  process.exitCode = 1;
}
