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

export async function readPreparedShard(rootInput, lane) {
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
  if (!universe || manifest.shards.length !== 1) fail("SHARD_MANIFEST_UNIVERSE_INVALID");
  const shard = manifest.shards[0];
  if (!exactKeys(shard, [
    "id", "unitIds", "inputPath", "workerInputDigest", "receiptPath",
  ]) || shard.id !== `${laneDirectory[lane]}-0001` || !/^[0-9a-f]{64}$/u.test(shard.workerInputDigest)
    || JSON.stringify(canonicalIds(shard.unitIds)) !== JSON.stringify(universe)
    || shard.inputPath !== relativeLanePath(lane, `inputs/${shard.id}.json`)
    || shard.receiptPath !== relativeLanePath(lane, `records/${shard.id}/receipt.json`)) {
    fail("SHARD_INVALID");
  }
  const input = await containedJson(root, shard.inputPath);
  if (!exactKeys(input, ["schema", "lane", "shardId", "inputDigest", "unitIds", "payload"])
    || input.schema !== "oxygen.story-preparation-worker-input" || input.lane !== lane
    || input.shardId !== shard.id || input.inputDigest !== manifest.inputDigest
    || JSON.stringify(input.unitIds) !== JSON.stringify(universe)
    || canonicalDigest(input) !== shard.workerInputDigest) fail("WORKER_INPUT_TAMPERED");
  return { root, manifest, shard, input };
}

export async function readLaneAuthority(rootInput, lane) {
  const prepared = await readPreparedShard(rootInput, lane);
  const { root, manifest, shard, input } = prepared;
  const receipt = await containedJson(root, shard.receiptPath);
  const outputPath = relativeLanePath(lane, `records/${shard.id}/output.json`);
  if (!exactKeys(receipt, [
    "schema", "lane", "shardId", "status", "inputDigest", "workerInputDigest",
    "unitIds", "outputPath", "outputDigest", "outputCount",
  ]) || receipt.schema !== "oxygen.story-preparation-worker-receipt" || receipt.lane !== lane
    || receipt.shardId !== shard.id || receipt.status !== "complete"
    || receipt.inputDigest !== manifest.inputDigest || receipt.workerInputDigest !== shard.workerInputDigest
    || JSON.stringify(receipt.unitIds) !== JSON.stringify(manifest.unitIds) || receipt.outputPath !== outputPath
    || !/^[0-9a-f]{64}$/u.test(receipt.outputDigest)
    || !Number.isSafeInteger(receipt.outputCount) || receipt.outputCount < 0) fail("RECEIPT_INVALID");
  const output = await containedJson(root, receipt.outputPath);
  if (canonicalDigest(output) !== receipt.outputDigest) fail("OUTPUT_TAMPERED");
  return { ...prepared, receipt, output };
}
