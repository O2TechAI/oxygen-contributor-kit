import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import {
  MAX_STORY_PREPARATION_FILE_BYTES,
  canonicalDigest,
  compareUtf8,
  exactKeys,
  fail,
  readStrictJson,
  stableId,
} from "./story_preparation_transport.mjs";

export const LANES = Object.freeze(["story", "insight", "story_privacy", "preference"]);
export const laneDirectory = Object.freeze({
  story: "story",
  insight: "insight",
  story_privacy: "story-privacy",
  preference: "preference",
});

export async function physicalRoot(path) {
  try {
    return await realpath(resolve(path));
  } catch {
    fail("TRANSPORT_ROOT_INVALID");
  }
}

export function relativeLanePath(lane, suffix) {
  const directory = laneDirectory[lane];
  if (!directory) fail("LANE_INVALID");
  return `${directory}/${suffix}`;
}

export async function contained(root, value) {
  if (typeof value !== "string" || !value || isAbsolute(value) || win32.isAbsolute(value)
    || value.split(/[\\/]/u).some((part) => part === "..")) fail("PATH_NOT_CONTAINED");
  let physical;
  try {
    physical = await realpath(resolve(root, value));
  } catch {
    fail("FILE_UNREADABLE");
  }
  const rel = relative(root, physical);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail("PATH_NOT_CONTAINED");
  }
  return physical;
}

export async function containedJson(root, value, maximumBytes = MAX_STORY_PREPARATION_FILE_BYTES) {
  const path = await contained(root, value);
  return (await readStrictJson(path, maximumBytes, {
    invalid: "FILE_UNREADABLE",
    changed: "FILE_CHANGED",
    oversized: "FILE_TOO_LARGE",
    jsonInvalid: "JSON_INVALID",
  })).value;
}

function canonicalIds(value) {
  if (!Array.isArray(value) || value.some((id) => !stableId(id))
    || new Set(value).size !== value.length) return null;
  const sorted = [...value].sort(compareUtf8);
  return JSON.stringify(sorted) === JSON.stringify(value) ? sorted : null;
}

async function readPreparedManifest(rootInput, lane) {
  if (!LANES.includes(lane)) fail("LANE_INVALID");
  const root = await physicalRoot(rootInput);
  const manifestPath = relativeLanePath(lane, "shards.json");
  const manifest = await containedJson(root, manifestPath);
  if (!exactKeys(manifest, ["schema", "lane", "inputDigest", "unitIds", "shards"])
    || manifest.schema !== "oxygen.story-preparation-shards" || manifest.lane !== lane
    || !/^[0-9a-f]{64}$/u.test(manifest.inputDigest) || !Array.isArray(manifest.shards)) {
    fail("SHARD_MANIFEST_INVALID");
  }
  const universe = canonicalIds(manifest.unitIds);
  if (!universe || manifest.shards.length === 0) fail("SHARD_MANIFEST_UNIVERSE_INVALID");
  const shards = [];
  const assigned = new Set();
  const ids = new Set();
  for (const shard of manifest.shards) {
    const shardUnitIds = canonicalIds(shard?.unitIds);
    if (!exactKeys(shard, [
      "id", "unitIds", "inputPath", "workerInputDigest", "receiptPath",
    ]) || !new RegExp(`^${laneDirectory[lane]}-[0-9]{4}$`, "u").test(shard.id)
      || ids.has(shard.id) || !/^[0-9a-f]{64}$/u.test(shard.workerInputDigest)
      || !shardUnitIds
      || shard.inputPath !== relativeLanePath(lane, `inputs/${shard.id}.json`)
      || shard.receiptPath !== relativeLanePath(lane, `records/${shard.id}/receipt.json`)) {
      fail("SHARD_INVALID");
    }
    ids.add(shard.id);
    for (const unitId of shardUnitIds) {
      if (assigned.has(unitId)) fail("SHARD_MANIFEST_UNIVERSE_INVALID");
      assigned.add(unitId);
    }
    shards.push({ ...shard, unitIds: shardUnitIds });
  }
  const orderedShards = shards.sort((left, right) => compareUtf8(left.id, right.id));
  const expectedIds = orderedShards.map((_, index) => (
    `${laneDirectory[lane]}-${String(index + 1).padStart(4, "0")}`
  ));
  if (JSON.stringify(orderedShards.map((shard) => shard.id)) !== JSON.stringify(expectedIds)
    || JSON.stringify([...assigned].sort(compareUtf8)) !== JSON.stringify(universe)) {
    fail("SHARD_MANIFEST_UNIVERSE_INVALID");
  }
  return { root, manifest: { ...manifest, unitIds: universe }, shards: orderedShards };
}

export async function readPreparedShard(rootInput, lane, shardId) {
  if (!stableId(shardId)) fail("SHARD_IDENTITY_INVALID");
  const prepared = await readPreparedManifest(rootInput, lane);
  const shard = prepared.shards.find((candidate) => candidate.id === shardId);
  if (!shard) fail("SHARD_IDENTITY_INVALID");
  const { root, manifest } = prepared;
  const input = await containedJson(root, shard.inputPath);
  if (!exactKeys(input, ["schema", "lane", "shardId", "inputDigest", "unitIds", "payload"])
    || input.schema !== "oxygen.story-preparation-worker-input" || input.lane !== lane
    || input.shardId !== shard.id || input.inputDigest !== manifest.inputDigest
    || JSON.stringify(input.unitIds) !== JSON.stringify(shard.unitIds)
    || canonicalDigest(input) !== shard.workerInputDigest) fail("WORKER_INPUT_TAMPERED");
  return { root, manifest, shards: prepared.shards, shard, input };
}

export async function readShardAuthority(rootInput, lane, shardId) {
  const prepared = await readPreparedShard(rootInput, lane, shardId);
  const { root, manifest, shard, input } = prepared;
  const receipt = await containedJson(root, shard.receiptPath);
  const outputPath = relativeLanePath(lane, `records/${shard.id}/output.json`);
  if (!exactKeys(receipt, [
    "schema", "lane", "shardId", "status", "inputDigest", "workerInputDigest",
    "unitIds", "outputPath", "outputDigest", "outputCount",
  ]) || receipt.schema !== "oxygen.story-preparation-worker-receipt" || receipt.lane !== lane
    || receipt.shardId !== shard.id || receipt.status !== "complete"
    || receipt.inputDigest !== manifest.inputDigest || receipt.workerInputDigest !== shard.workerInputDigest
    || JSON.stringify(receipt.unitIds) !== JSON.stringify(shard.unitIds) || receipt.outputPath !== outputPath
    || !/^[0-9a-f]{64}$/u.test(receipt.outputDigest)
    || !Number.isSafeInteger(receipt.outputCount) || receipt.outputCount < 0) fail("RECEIPT_INVALID");
  const output = await containedJson(root, receipt.outputPath);
  if (canonicalDigest(output) !== receipt.outputDigest) fail("OUTPUT_TAMPERED");
  return { ...prepared, receipt, output };
}

export async function readLaneAuthority(rootInput, lane) {
  const prepared = await readPreparedManifest(rootInput, lane);
  const authorities = [];
  for (const shard of prepared.shards) {
    authorities.push(await readShardAuthority(prepared.root, lane, shard.id));
  }
  const receipts = authorities.map((authority) => authority.receipt);
  const outputs = authorities.map((authority) => authority.output);
  const output = outputs.every(Array.isArray) ? outputs.flat() : (outputs.length === 1 ? outputs[0] : outputs);
  return {
    ...prepared,
    shard: authorities[0].shard,
    input: authorities[0].input,
    inputs: authorities.map((authority) => authority.input),
    receipt: receipts[0],
    receipts,
    outputs,
    output,
    outputCount: receipts.reduce((total, receipt) => total + receipt.outputCount, 0),
  };
}
