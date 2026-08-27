#!/usr/bin/env node
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { storyPreparationDigest } from "../../../viewer/lib/story-preparation.ts";

const [snapshotInput, outputInput] = process.argv.slice(2);
const hex = /^[0-9a-f]{64}$/;
const exact = (value, keys) => Boolean(value) && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const fail = (code) => { throw new Error(code); };
const safeId = (value) => typeof value === "string" && Boolean(value.trim())
  && !/[\u0000-\u001f\u007f]/u.test(value);

async function regular(path) {
  const physical = await realpath(path).catch(() => fail("FILE_UNREADABLE"));
  const stat = await lstat(physical).catch(() => fail("FILE_UNREADABLE"));
  if (!stat.isFile() || stat.nlink !== 1) fail("FILE_TOPOLOGY_INVALID");
  return physical;
}

if (!snapshotInput || !outputInput) {
  fail("USAGE_PREPARE_REVIEWED_STORY_PRIVACY_SNAPSHOT_OUTPUT_DIRECTORY");
}
const snapshotPath = await regular(resolve(snapshotInput));
let snapshot;
try { snapshot = JSON.parse(await readFile(snapshotPath, "utf8")); } catch { fail("SNAPSHOT_INVALID"); }
const bindingKeys = [
  "workflowRunId", "sourceRevision", "activeStoryDigest", "serverVersion",
  "reviewedStoryDigest", "targetCatalogDigest", "changedTargetDigest",
  "changedTargetCount", "previousBatchDigest",
];
if (!exact(snapshot, ["schema", "binding", "changedTargets"])
  || snapshot.schema !== "oxygen.reviewed-story-privacy-snapshot"
  || !exact(snapshot.binding, bindingKeys) || !Array.isArray(snapshot.changedTargets)
  || !safeId(snapshot.binding.workflowRunId)
  || !Number.isSafeInteger(snapshot.binding.sourceRevision) || snapshot.binding.sourceRevision <= 0
  || !Number.isSafeInteger(snapshot.binding.serverVersion) || snapshot.binding.serverVersion < 1
  || !Number.isSafeInteger(snapshot.binding.changedTargetCount)
  || snapshot.binding.changedTargetCount !== snapshot.changedTargets.length
  || snapshot.changedTargets.length === 0 || snapshot.changedTargets.length > 2_000
  || ![snapshot.binding.activeStoryDigest, snapshot.binding.reviewedStoryDigest,
    snapshot.binding.targetCatalogDigest, snapshot.binding.changedTargetDigest,
    snapshot.binding.previousBatchDigest].every((value) => typeof value === "string" && hex.test(value))) {
  fail("SNAPSHOT_INVALID");
}
const targets = [];
for (const target of snapshot.changedTargets) {
  if (!exact(target, ["id", "storyKey", "target", "content", "contentDigest"])
    || ![target.id, target.storyKey, target.target].every(safeId)
    || typeof target.content !== "string" || target.content.length === 0 || target.content.length > 1_000_000
    || !hex.test(target.contentDigest)
    || await storyPreparationDigest(target.content) !== target.contentDigest) fail("TARGET_INVALID");
  targets.push(target);
}
if (new Set(targets.map((target) => target.id)).size !== targets.length
  || await storyPreparationDigest(targets.map((target) => target.id))
    !== snapshot.binding.changedTargetDigest) fail("TARGET_SET_INVALID");

if (isAbsolute(basename(outputInput)) || win32.isAbsolute(basename(outputInput))) fail("OUTPUT_INVALID");
const parent = await realpath(dirname(resolve(outputInput))).catch(() => fail("OUTPUT_PARENT_INVALID"));
const output = resolve(parent, basename(outputInput));
const rel = relative(parent, output);
if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail("OUTPUT_INVALID");
await mkdir(output, { recursive: false });
const shard = {
  schema: "oxygen.reviewed-story-privacy-shard-input",
  shardId: "changed-000",
  binding: snapshot.binding,
  targets,
};
await writeFile(resolve(output, "changed-000.input.json"), `${JSON.stringify(shard)}\n`, { flag: "wx" });
const core = {
  schema: "oxygen.reviewed-story-privacy-preparation",
  binding: snapshot.binding,
  changedTargetIds: targets.map((target) => target.id),
  shards: [{
    id: "changed-000",
    targetIds: targets.map((target) => target.id),
    inputPath: "changed-000.input.json",
    receiptPath: "changed-000.receipt.json",
  }],
};
const manifest = { ...core, manifestDigest: await storyPreparationDigest(core) };
await writeFile(resolve(output, "manifest.json"), `${JSON.stringify(manifest)}\n`, { flag: "wx" });
console.log(JSON.stringify({ output, manifestDigest: manifest.manifestDigest,
  changedTargetCount: targets.length }));
