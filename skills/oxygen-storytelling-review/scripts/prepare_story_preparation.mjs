#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  deriveStoryReleaseTargetCatalog,
} from "../../../viewer/lib/story-preparation.ts";
import { canonicalAuthorityJson } from "../../../viewer/lib/story-readiness.ts";
import { parseStorySource, STORY_PREFIX } from "../../../viewer/lib/timeline.ts";
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
} from "./story_preparation_validation_authority.mjs";

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
  }).sort((left, right) => compareUtf8(left.id, right.id));
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
  }).sort((left, right) => compareUtf8(left.id, right.id));
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

async function installLane(rootInput, lane, inputDigest, unitIds, payload, files = []) {
  if (!LANES.includes(lane) || !/^[0-9a-f]{64}$/u.test(inputDigest)) fail("LANE_INPUT_INVALID");
  if (serializedBytes(payload) > MAX_STORY_PREPARATION_FILE_BYTES) fail("WORKER_INPUT_TOO_LARGE");
  const rootPath = resolve(rootInput);
  await mkdir(rootPath, { recursive: true });
  const root = await import("node:fs/promises").then(({ realpath }) => realpath(rootPath));
  const directory = laneDirectory[lane];
  const destination = resolve(root, directory);
  const temporary = resolve(root, `.${directory}.${process.pid}.${randomUUID()}.tmp`);
  const shardId = `${directory}-0001`;
  const canonicalUnitIds = orderedIds(unitIds);
  const workerInput = {
    schema: "oxygen.story-preparation-worker-input",
    lane,
    shardId,
    inputDigest,
    unitIds: canonicalUnitIds,
    payload,
  };
  const shard = {
    id: shardId,
    unitIds: canonicalUnitIds,
    inputPath: relativeLanePath(lane, `inputs/${shardId}.json`),
    workerInputDigest: canonicalDigest(workerInput),
    receiptPath: relativeLanePath(lane, `records/${shardId}/receipt.json`),
  };
  const manifest = {
    schema: "oxygen.story-preparation-shards",
    lane,
    inputDigest,
    unitIds: canonicalUnitIds,
    shards: [shard],
  };
  try {
    await mkdir(resolve(temporary, "inputs"), { recursive: true });
    for (const file of files) {
      await writeSynced(resolve(temporary, file.name), file.value);
    }
    await writeSynced(resolve(temporary, "inputs", `${shardId}.json`), workerInput);
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
  return { lane, shardId, inputPath: shard.inputPath };
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
  return installLane(root, "story", canonicalDigest({ validationAuthorityDigest, narrativeDigest }),
    semantic.units.map((unit) => unit.id), {
      validationAuthorityPath: "story/validation-authority.json",
      validationAuthorityDigest,
      narrativeDigest,
      reviewedNarrative,
    }, [{ name: "validation-authority.json", value: authority }]);
}

async function prepareInsight(candidatesPath, root) {
  const rows = candidateRows(await readBounded(candidatesPath));
  const records = rows.map(({ id, story }) => ({ id, story }));
  return installLane(root, "insight", canonicalDigest(records),
    rows.map((row) => row.story.key), { storyCandidates: rows.map(({ id, summary }) => ({ id, summary })) });
}

async function preparePrivacy(candidatesPath, root) {
  const rows = candidateRows(await readBounded(candidatesPath), true);
  const records = rows.map(({ id, story }) => ({ id, story }));
  const catalog = deriveStoryReleaseTargetCatalog(rows.map((row) => row.story));
  if (!catalog) fail("PRIVACY_CATALOG_INVALID");
  return installLane(root, "story_privacy", canonicalDigest(records),
    catalog.map((target) => target.id), {
      storyCandidates: rows.map(({ id, summary }) => ({ id, summary })),
      releaseTargetCatalog: catalog,
    });
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
  return installLane(root, "preference", canonicalDigest(lessons),
    identities.map((identity) => canonicalAuthorityJson(identity)), { preferenceContext: context });
}

async function composeStory(root, outputPath) {
  const authority = await readLaneAuthority(root, "story");
  const records = baseRecords(authority.output);
  const validation = await import("./story_preparation_validation_authority.mjs")
    .then(({ readStoryValidationAuthority }) => readStoryValidationAuthority(authority));
  const memberIds = semanticMembers(validation.semanticManifest);
  if (records.some((record) => !memberIds.has(record.id))) fail("STORY_OUTPUT_FOREIGN_IDENTITY");
  const rows = candidateRowsFromBase(records);
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
  const bases = baseRecords(story.output);
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
