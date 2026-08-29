#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  deriveStoryReleaseTargetCatalog,
} from "../../../viewer/lib/story-preparation.ts";
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
  readSemanticTransport,
  readStrictJson,
  serializedBytes,
  stableId,
  MAX_STORY_PREPARATION_FILE_BYTES,
} from "./story_preparation_transport.mjs";
import {
  LANES,
  laneDirectory,
  readLaneAuthority,
  relativeLanePath,
} from "./story_preparation_protocol.mjs";
import {
  buildStoryValidationAuthority,
  insightReviewedNarrative,
} from "./story_preparation_validation_authority.mjs";

export const TARGET_STORY_PREPARATION_SHARD_BYTES = 1_000_000;
export const MAX_GENERIC_STORY_PREPARATION_SHARD_IDENTITIES = 4;

function orderedIds(values) {
  const result = [...values].sort(compareUtf8);
  if (result.some((id) => !stableId(id)) || new Set(result).size !== result.length) {
    fail("IDENTITY_SET_INVALID");
  }
  return result;
}

function storyFromObject(value) {
  if (!isObject(value)) fail("STORY_OUTPUT_INVALID");
  const story = parseStorySource(`${STORY_PREFIX}${JSON.stringify(value)}`);
  if (!story || !stableId(story.key)) fail("STORY_OUTPUT_INVALID");
  return story;
}

function baseRecords(value) {
  if (!Array.isArray(value) || value.length === 0) fail("STORY_OUTPUT_INVALID");
  const records = value.map((record) => {
    if (!exactKeys(record, ["id", "story"]) || !stableId(record.id)) fail("STORY_OUTPUT_INVALID");
    const story = storyFromObject(record.story);
    if (story.insights.length !== 0) fail("STORY_OUTPUT_INVALID");
    return { id: record.id, story };
  });
  if (new Set(records.map((record) => record.id)).size !== records.length
    || new Set(records.map((record) => record.story.key)).size !== records.length) {
    fail("STORY_OUTPUT_IDENTITY_INVALID");
  }
  return records;
}

function candidateRows(value, requireInsights = false) {
  if (!Array.isArray(value) || value.length === 0) fail("STORY_CANDIDATES_INVALID");
  const rows = value.map((row) => {
    if (!exactKeys(row, ["id", "summary"]) || !stableId(row.id) || typeof row.summary !== "string") {
      fail("STORY_CANDIDATES_INVALID");
    }
    const story = parseStorySource(row.summary);
    if (!story || !stableId(story.key) || (!requireInsights && story.insights.length !== 0)) {
      fail("STORY_CANDIDATES_INVALID");
    }
    return { id: row.id, summary: row.summary, story };
  });
  if (new Set(rows.map((row) => row.id)).size !== rows.length
    || new Set(rows.map((row) => row.story.key)).size !== rows.length) fail("STORY_CANDIDATES_IDENTITY_INVALID");
  return rows;
}

function candidateRowsFromBase(records) {
  return records.map(({ id, story }) => ({
    id,
    summary: `${STORY_PREFIX}${canonicalAuthorityJson(story)}`,
  }));
}

function orderStoryRecords(records, validationAuthority) {
  const evidence = new Map(validationAuthority.evidence.map((row) => [row.id, row]));
  return [...records].sort((left, right) => {
    const a = evidence.get(left.story.evidence.primary.eventId);
    const b = evidence.get(right.story.evidence.primary.eventId);
    if (!a || !b) fail("STORY_OUTPUT_FOREIGN_IDENTITY");
    return compareStorySourceIdentity(a, b);
  });
}

async function readBounded(path) {
  return (await readStrictJson(path, MAX_STORY_PREPARATION_FILE_BYTES)).value;
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

async function writeDestination(path, value) {
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = resolve(dirname(destination), `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeSynced(temporary, value);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function balancedGroups(entries, {
  maximumIdentities = MAX_GENERIC_STORY_PREPARATION_SHARD_IDENTITIES,
  targetBytes = TARGET_STORY_PREPARATION_SHARD_BYTES,
} = {}) {
  if (!entries.length) return [[]];
  const weighted = entries.map((entry) => ({ ...entry, weight: serializedBytes(entry.value) }))
    .sort((left, right) => right.weight - left.weight || compareUtf8(left.id, right.id));
  const totalBytes = weighted.reduce((total, entry) => total + entry.weight, 0);
  const count = Math.min(weighted.length, Math.max(1,
    Math.ceil(weighted.length / maximumIdentities),
    Math.ceil(totalBytes / targetBytes)));
  const groups = Array.from({ length: count }, () => ({ bytes: 0, entries: [] }));
  for (const entry of weighted) {
    const group = [...groups].sort((left, right) => left.bytes - right.bytes
      || left.entries.length - right.entries.length)[0];
    group.entries.push(entry);
    group.bytes += entry.weight;
  }
  return groups.map((group) => group.entries.sort((left, right) => compareUtf8(left.id, right.id)));
}

function storyOwnerGroups(entries) {
  return balancedGroups(entries, {
    maximumIdentities: Number.MAX_SAFE_INTEGER,
    targetBytes: TARGET_STORY_PREPARATION_SHARD_BYTES,
  });
}

async function installLane(rootInput, lane, inputDigest, partitions, files = []) {
  if (!LANES.includes(lane) || !/^[0-9a-f]{64}$/u.test(inputDigest)) fail("LANE_INPUT_INVALID");
  if (!Array.isArray(partitions) || partitions.length === 0) fail("LANE_INPUT_INVALID");
  const rootPath = resolve(rootInput);
  await mkdir(rootPath, { recursive: true });
  const root = await import("node:fs/promises").then(({ realpath }) => realpath(rootPath));
  const directory = laneDirectory[lane];
  const destination = resolve(root, directory);
  const temporary = resolve(root, `.${directory}.${process.pid}.${randomUUID()}.tmp`);
  const shards = [];
  const workerInputs = [];
  const assigned = new Set();
  for (const [index, partition] of partitions.entries()) {
    if (!isObject(partition) || !Array.isArray(partition.unitIds) || !isObject(partition.payload)) {
      fail("LANE_INPUT_INVALID");
    }
    const shardId = `${directory}-${String(index + 1).padStart(4, "0")}`;
    const canonicalUnitIds = orderedIds(partition.unitIds);
    for (const unitId of canonicalUnitIds) {
      if (assigned.has(unitId)) fail("IDENTITY_SET_INVALID");
      assigned.add(unitId);
    }
    const workerInput = {
      schema: "oxygen.story-preparation-worker-input",
      lane,
      shardId,
      inputDigest,
      unitIds: canonicalUnitIds,
      payload: partition.payload,
    };
    if (serializedBytes(workerInput) > MAX_STORY_PREPARATION_FILE_BYTES) fail("WORKER_INPUT_TOO_LARGE");
    const shard = {
      id: shardId,
      unitIds: canonicalUnitIds,
      inputPath: relativeLanePath(lane, `inputs/${shardId}.json`),
      workerInputDigest: canonicalDigest(workerInput),
      receiptPath: relativeLanePath(lane, `records/${shardId}/receipt.json`),
    };
    shards.push(shard);
    workerInputs.push(workerInput);
  }
  const canonicalUnitIds = orderedIds([...assigned]);
  const manifest = {
    schema: "oxygen.story-preparation-shards",
    lane,
    inputDigest,
    unitIds: canonicalUnitIds,
    shards,
  };
  try {
    await mkdir(resolve(temporary, "inputs"), { recursive: true });
    for (const file of files) {
      await writeSynced(resolve(temporary, file.name), file.value);
    }
    for (const workerInput of workerInputs) {
      await writeSynced(resolve(temporary, "inputs", `${workerInput.shardId}.json`), workerInput);
    }
    await writeSynced(resolve(temporary, "shards.json"), manifest);
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (error?.code === "EEXIST" || error?.code === "ENOTEMPTY") fail("LANE_ALREADY_PREPARED");
      throw error;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
  return {
    lane,
    shardCount: shards.length,
    shards: shards.map((shard) => ({ id: shard.id, inputPath: shard.inputPath })),
  };
}

function semanticMembers(semantic) {
  const members = new Set();
  for (const unit of semantic.units) {
    if (!isObject(unit) || !Array.isArray(unit.members)
      || unit.members.some((id) => !stableId(id))) fail("SEMANTIC_UNIT_MEMBERS_INVALID");
    for (const id of unit.members) {
      if (members.has(id)) fail("SEMANTIC_UNIT_MEMBERS_INVALID");
      members.add(id);
    }
  }
  return members;
}

async function prepareStory(semanticPath, coveragePath, sourcePrivacyPath, reviewRoot, root) {
  const { semantic, authority, reviewedNarrative } = await buildStoryValidationAuthority(
    semanticPath, coveragePath, sourcePrivacyPath, reviewRoot,
  );
  semanticMembers(semantic);
  const validationAuthorityDigest = canonicalDigest(authority);
  const narrativeDigest = canonicalDigest(reviewedNarrative);
  const narrativeById = new Map(reviewedNarrative.map((row) => [row.id, row]));
  const unitsById = new Map(semantic.units.map((unit) => [unit.id, unit]));
  const represented = authority.coverageManifest.rows.filter((row) => row.disposition === "represented");
  if (represented.length === 0) fail("STORY_ZERO_REPRESENTED_OWNER_UNSUPPORTED");
  const unitsByOwner = new Map();
  for (const row of represented) {
    const unit = unitsById.get(row.unitId);
    if (!unit || !stableId(row.ownerId)) fail("STORY_OWNER_AUTHORITY_INVALID");
    const owned = unitsByOwner.get(row.ownerId) || [];
    owned.push(unit);
    unitsByOwner.set(row.ownerId, owned);
  }
  const ownerBundles = [...unitsByOwner].sort(([left], [right]) => compareUtf8(left, right))
    .map(([ownerId, ownedUnits]) => {
      const semanticUnits = [...ownedUnits].sort((left, right) => compareUtf8(left.id, right.id));
      const memberIds = semanticUnits.flatMap((unit) => unit.members);
      const narrative = memberIds.map((id) => narrativeById.get(id));
      if (narrative.some((row) => !row) || new Set(memberIds).size !== memberIds.length) {
        fail("REVIEWED_SOURCE_AUTHORITY_STALE");
      }
      return {
        ownerId,
        semanticManifest: {
          revision: authority.semanticManifest.revision,
          digest: authority.semanticManifest.manifestDigest,
        },
        coverageManifest: {
          revision: authority.coverageManifest.revision,
          digest: authority.coverageManifest.coverageDigest,
        },
        semanticUnits,
        reviewedNarrative: narrative.sort((left, right) => (
          compareUtf8(left.documentId, right.documentId)
          || left.sequence - right.sequence
          || compareUtf8(left.id, right.id)
        )),
      };
    });
  const inputDigest = canonicalDigest({ validationAuthorityDigest, narrativeDigest });
  for (const bundle of ownerBundles) {
    const singleOwnerInput = {
      schema: "oxygen.story-preparation-worker-input",
      lane: "story",
      shardId: "story-0001",
      inputDigest,
      unitIds: [bundle.ownerId],
      payload: {
        validationAuthorityPath: "story/validation-authority.json",
        validationAuthorityDigest,
        ownerBundles: [bundle],
      },
    };
    if (serializedBytes(singleOwnerInput) > MAX_STORY_PREPARATION_FILE_BYTES) {
      fail("STORY_OWNER_BUNDLE_TOO_LARGE");
    }
  }
  const groups = storyOwnerGroups(ownerBundles.map((bundle) => ({
    id: bundle.ownerId,
    value: bundle,
  })));
  const partitions = groups.map((group) => ({
    unitIds: group.map((entry) => entry.id),
    payload: {
      validationAuthorityPath: "story/validation-authority.json",
      validationAuthorityDigest,
      ownerBundles: group.map((entry) => entry.value),
    },
  }));
  return installLane(root, "story", inputDigest,
    partitions, [{ name: "validation-authority.json", value: authority }]);
}

async function prepareInsight(candidatesPath, root) {
  const rows = candidateRows(await readBounded(candidatesPath));
  const records = rows.map(({ id, story }) => ({ id, story }));
  const storyAuthority = await readLaneAuthority(root, "story");
  const { validationAuthorityPath, validationAuthorityDigest } = storyAuthority.input.payload;
  const groups = balancedGroups(rows.map((row) => ({ id: row.story.key, value: row })));
  return installLane(root, "insight", canonicalDigest(records), groups.map((group) => {
    const storyCandidates = group.map(({ value: { id, summary } }) => ({ id, summary }));
    return {
      unitIds: group.map((entry) => entry.id),
      payload: {
        validationAuthorityPath,
        validationAuthorityDigest,
        storyCandidates,
        reviewedNarrative: insightReviewedNarrative(storyAuthority.inputs, storyCandidates),
      },
    };
  }));
}

async function preparePrivacy(candidatesPath, root) {
  const rows = candidateRows(await readBounded(candidatesPath), true);
  const records = rows.map(({ id, story }) => ({ id, story }));
  const catalog = deriveStoryReleaseTargetCatalog(rows.map((row) => row.story));
  if (!catalog) fail("PRIVACY_CATALOG_INVALID");
  const storyByTarget = new Map();
  for (const row of rows) {
    const targets = deriveStoryReleaseTargetCatalog([row.story]);
    if (!targets) fail("PRIVACY_CATALOG_INVALID");
    targets.forEach((target) => storyByTarget.set(target.id, row));
  }
  const groups = balancedGroups(catalog.map((target) => ({ id: target.id, value: target })), {
    maximumIdentities: 64,
  });
  return installLane(root, "story_privacy", canonicalDigest(records), groups.map((group) => {
    const targetIds = new Set(group.map((entry) => entry.id));
    const shardRows = [...new Map(group.map((entry) => {
      const row = storyByTarget.get(entry.id);
      if (!row) fail("PRIVACY_CATALOG_INVALID");
      return [row.id, row];
    })).values()].sort((left, right) => compareUtf8(left.id, right.id));
    return {
      unitIds: [...targetIds],
      payload: {
        storyCandidates: shardRows.map(({ id, summary }) => ({ id, summary })),
        releaseTargetCatalog: catalog.filter((target) => targetIds.has(target.id)),
      },
    };
  }));
}

function lessonProjection(rows) {
  return rows.flatMap((row) => row.story.insights.map((insight) => ({
    storyKey: row.story.key,
    insightId: insight.id,
    ...(insight.title === undefined ? {} : { title: insight.title }),
    background: insight.background,
    directlyAcquiredExperience: insight.directlyAcquiredExperience,
    principle: insight.principle,
  })));
}

async function preparePreference(candidatesPath, contextPath, root) {
  const rows = candidateRows(await readBounded(candidatesPath), true);
  const context = await readBounded(contextPath);
  if (!exactKeys(context, [
    "schema", "reusableLessons", "insightIdentities", "reviewedEvidence", "autoRemoved",
  ]) || context.schema !== "oxygen.preference-context" || !Array.isArray(context.reusableLessons)
    || !Array.isArray(context.insightIdentities) || !Array.isArray(context.reviewedEvidence)) {
    fail("PREFERENCE_CONTEXT_INVALID");
  }
  const lessons = lessonProjection(rows);
  const identities = lessons.map((lesson) => ({ storyKey: lesson.storyKey, insightId: lesson.insightId }));
  if (canonicalAuthorityJson(context.reusableLessons) !== canonicalAuthorityJson(lessons)
    || canonicalAuthorityJson(context.insightIdentities) !== canonicalAuthorityJson(identities)) {
    fail("PREFERENCE_CONTEXT_STALE");
  }
  return installLane(root, "preference", canonicalDigest(lessons), [{
    unitIds: identities.map((identity) => canonicalAuthorityJson(identity)),
    payload: { preferenceContext: context },
  }]);
}

async function composeStory(root, outputPath) {
  const authority = await readLaneAuthority(root, "story");
  const validationModule = await import("./story_preparation_validation_authority.mjs");
  const validation = await validationModule.readStoryValidationAuthority(authority);
  const records = orderStoryRecords(baseRecords(authority.output), validation);
  const memberIds = semanticMembers(validation.semanticManifest);
  if (records.some((record) => !memberIds.has(record.id))) fail("STORY_OUTPUT_FOREIGN_IDENTITY");
  const rows = candidateRowsFromBase(records);
  const evidenceById = new Map(validation.evidence.map((row) => [row.id, row]));
  const storyValidation = validateStorySourcePackage(rows.map((row, index) => ({
    ...row,
    documentId: records[index].story.evidence.primary.documentId,
    sequence: evidenceById.get(row.id)?.sequence,
    timestamp: evidenceById.get(row.id)?.timestamp,
  })), validationModule.storyEvidenceRows(validation),
  validationModule.storyCompletenessAuthority(validation));
  if (!storyValidation.ok) fail(storyValidation.code);
  await writeDestination(outputPath, rows);
  return { outputCount: rows.length, outputDigest: canonicalDigest(records) };
}

function insightRecords(value, storyKeys) {
  if (!Array.isArray(value)) fail("INSIGHT_OUTPUT_INVALID");
  const records = value.map((record) => {
    if (!exactKeys(record, ["storyKey", "insights"]) || !stableId(record.storyKey)
      || !Array.isArray(record.insights)) fail("INSIGHT_OUTPUT_INVALID");
    return record;
  }).sort((left, right) => compareUtf8(left.storyKey, right.storyKey));
  if (canonicalAuthorityJson(records.map((record) => record.storyKey)) !== canonicalAuthorityJson(storyKeys)) {
    fail("INSIGHT_OUTPUT_IDENTITY_INVALID");
  }
  return records;
}

async function composeFinal(root, outputPath) {
  const story = await readLaneAuthority(root, "story");
  const insight = await readLaneAuthority(root, "insight");
  const validation = await import("./story_preparation_validation_authority.mjs")
    .then(({ readStoryValidationAuthority }) => readStoryValidationAuthority(story));
  const bases = orderStoryRecords(baseRecords(story.output), validation);
  if (insight.manifest.inputDigest !== canonicalDigest(bases)) fail("INSIGHT_INPUT_STALE");
  const keys = bases.map((record) => record.story.key).sort(compareUtf8);
  const records = insightRecords(insight.output, keys);
  const insights = new Map(records.map((record) => [record.storyKey, record.insights]));
  const complete = bases.map((record) => ({
    id: record.id,
    story: storyFromObject({ ...record.story, insights: insights.get(record.story.key) }),
  }));
  const rows = candidateRowsFromBase(complete);
  await writeDestination(outputPath, rows);
  return {
    outputCount: complete.reduce((total, record) => total + record.story.insights.length, 0),
    outputDigest: canonicalDigest(complete),
  };
}

async function main(args) {
  const [action, lane, ...rest] = args;
  if (action === "prepare" && lane === "story" && rest.length === 5) {
    return prepareStory(rest[0], rest[1], rest[2], rest[3], rest[4]);
  }
  if (action === "prepare" && lane === "insight" && rest.length === 2) {
    return prepareInsight(rest[0], rest[1]);
  }
  if (action === "prepare" && lane === "story_privacy" && rest.length === 2) {
    return preparePrivacy(rest[0], rest[1]);
  }
  if (action === "prepare" && lane === "preference" && rest.length === 3) {
    return preparePreference(rest[0], rest[1], rest[2]);
  }
  if (action === "compose" && lane === "story" && rest.length === 2) {
    return composeStory(rest[0], rest[1]);
  }
  if (action === "compose" && lane === "final" && rest.length === 2) {
    return composeFinal(rest[0], rest[1]);
  }
  fail("CLI_USAGE");
}

try {
  const result = await main(process.argv.slice(2));
  process.stdout.write(`${canonicalAuthorityJson({ ok: true, ...result })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof StoryPreparationTransportError ? error.code : "STORY_PREPARATION_FAILED"}\n`);
  process.exitCode = 1;
}
