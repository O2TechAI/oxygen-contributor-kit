#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { storyPreparationDigest } from "../../../viewer/lib/story-preparation.ts";

const [snapshotInput, outputInput] = process.argv.slice(2);
const hex = /^[0-9a-f]{64}$/;
const MAX_SHARD_CONTENT_BYTES = 1_000_000;
const MAX_SHARD_TARGETS = 64;
const exact = (value, keys) => Boolean(value) && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const fail = (code) => { throw new Error(code); };
const safeId = (value) => typeof value === "string" && Boolean(value.trim())
  && !/[\u0000-\u001f\u007f]/u.test(value);
const compareUtf8 = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));
const samePath = (left, right) => process.platform === "win32"
  ? left.replaceAll("/", "\\").toLowerCase() === right.replaceAll("/", "\\").toLowerCase()
  : left === right;

async function regular(path) {
  const physical = await realpath(path).catch(() => fail("FILE_UNREADABLE"));
  const stat = await lstat(path).catch(() => fail("FILE_UNREADABLE"));
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1
    || !samePath(physical, resolve(path))) fail("FILE_TOPOLOGY_INVALID");
  return physical;
}

function shardTargets(targets) {
  const bins = [];
  const ranked = targets.map((target, order) => ({
    target, order, bytes: Buffer.byteLength(target.content, "utf8"),
  })).sort((left, right) => right.bytes - left.bytes
    || compareUtf8(left.target.id, right.target.id));
  for (const entry of ranked) {
    let bin = bins.find((candidate) => candidate.targets.length < MAX_SHARD_TARGETS
      && candidate.bytes + entry.bytes <= MAX_SHARD_CONTENT_BYTES);
    if (!bin) {
      bin = { bytes: 0, targets: [] };
      bins.push(bin);
    }
    bin.bytes += entry.bytes;
    bin.targets.push(entry);
  }
  return bins.map((bin) => bin.targets.sort((left, right) => left.order - right.order)
    .map((entry) => entry.target));
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
  "changedTargetCount", "previousCandidateDigest",
];
if (!exact(snapshot, ["schema", "binding", "targetTransitions", "changedTargets"])
  || snapshot.schema !== "oxygen.reviewed-story-privacy-snapshot"
  || !exact(snapshot.binding, bindingKeys) || !Array.isArray(snapshot.targetTransitions)
  || !Array.isArray(snapshot.changedTargets)
  || !safeId(snapshot.binding.workflowRunId)
  || !Number.isSafeInteger(snapshot.binding.sourceRevision) || snapshot.binding.sourceRevision <= 0
  || !Number.isSafeInteger(snapshot.binding.serverVersion) || snapshot.binding.serverVersion < 1
  || !Number.isSafeInteger(snapshot.binding.changedTargetCount)
  || snapshot.binding.changedTargetCount !== snapshot.targetTransitions.length
  || snapshot.targetTransitions.length === 0 || snapshot.targetTransitions.length > 4_000
  || ![snapshot.binding.activeStoryDigest, snapshot.binding.reviewedStoryDigest,
    snapshot.binding.targetCatalogDigest, snapshot.binding.changedTargetDigest,
    snapshot.binding.previousCandidateDigest].every((value) => typeof value === "string" && hex.test(value))) {
  fail("SNAPSHOT_INVALID");
}
const transitions = [];
for (const transition of snapshot.targetTransitions) {
  if (!exact(transition, ["id", "previousContentDigest", "contentDigest"])
    || !safeId(transition.id)
    || (transition.previousContentDigest !== null && !hex.test(transition.previousContentDigest))
    || (transition.contentDigest !== null && !hex.test(transition.contentDigest))
    || transition.previousContentDigest === transition.contentDigest) fail("TRANSITION_INVALID");
  transitions.push(transition);
}
if (new Set(transitions.map((target) => target.id)).size !== transitions.length
  || transitions.some((target, index) => index > 0
    && compareUtf8(transitions[index - 1].id, target.id) >= 0)
  || await storyPreparationDigest(transitions) !== snapshot.binding.changedTargetDigest) {
  fail("TRANSITION_SET_INVALID");
}
const currentTransition = new Map(transitions.filter((target) => target.contentDigest !== null)
  .map((target) => [target.id, target.contentDigest]));
const targets = [];
for (const target of snapshot.changedTargets) {
  if (!exact(target, ["id", "storyKey", "target", "content", "contentDigest"])
    || ![target.id, target.storyKey, target.target].every(safeId)
    || typeof target.content !== "string" || target.content.length === 0
    || Buffer.byteLength(target.content, "utf8") > MAX_SHARD_CONTENT_BYTES
    || !hex.test(target.contentDigest)
    || currentTransition.get(target.id) !== target.contentDigest
    || await storyPreparationDigest(target.content) !== target.contentDigest) fail("TARGET_INVALID");
  targets.push(target);
}
targets.sort((left, right) => compareUtf8(left.id, right.id));
if (new Set(targets.map((target) => target.id)).size !== targets.length
  || targets.length !== currentTransition.size
  || targets.some((target) => !currentTransition.has(target.id))) fail("TARGET_SET_INVALID");

if (isAbsolute(basename(outputInput)) || win32.isAbsolute(basename(outputInput))) fail("OUTPUT_INVALID");
const requestedParent = dirname(resolve(outputInput));
const parent = await realpath(requestedParent).catch(() => fail("OUTPUT_PARENT_INVALID"));
const parentStat = await lstat(requestedParent).catch(() => fail("OUTPUT_PARENT_INVALID"));
if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) fail("OUTPUT_PARENT_INVALID");
if (!samePath(parent, resolve(requestedParent))) fail("OUTPUT_PARENT_INVALID");
const output = resolve(parent, basename(outputInput));
const rel = relative(parent, output);
if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail("OUTPUT_INVALID");
const temporary = resolve(parent, `.${basename(output)}.${process.pid}-${randomUUID()}.tmp`);
await mkdir(temporary, { recursive: false });
try {
  const shards = [];
  const groups = shardTargets(targets);
  for (let index = 0; index < groups.length; index += 1) {
    const shardTargetsValue = groups[index];
    const id = `changed-${String(index).padStart(3, "0")}`;
    const core = {
      schema: "oxygen.reviewed-story-privacy-shard-input",
      shardId: id,
      binding: snapshot.binding,
      targets: shardTargetsValue,
    };
    const inputDigest = await storyPreparationDigest(core);
    const inputPath = `${id}.input.json`;
    await writeFile(resolve(temporary, inputPath), `${JSON.stringify({ ...core, inputDigest })}\n`, { flag: "wx" });
    shards.push({
      id,
      targetIds: shardTargetsValue.map((target) => target.id),
      inputPath,
      inputDigest,
      receiptPath: `${id}.receipt.json`,
    });
  }
  const manifestCore = {
    schema: "oxygen.reviewed-story-privacy-preparation",
    binding: snapshot.binding,
    targetTransitions: transitions,
    changedTargetIds: targets.map((target) => target.id),
    shardLimits: { maxContentBytes: MAX_SHARD_CONTENT_BYTES, maxTargets: MAX_SHARD_TARGETS },
    shards,
  };
  const manifest = { ...manifestCore, manifestDigest: await storyPreparationDigest(manifestCore) };
  await writeFile(resolve(temporary, "manifest.json"), `${JSON.stringify(manifest)}\n`, { flag: "wx" });
  await rename(temporary, output);
  console.log(JSON.stringify({ output, manifestDigest: manifest.manifestDigest,
    changedTargetCount: transitions.length, scanTargetCount: targets.length, shardCount: shards.length }));
} catch (error) {
  await rm(temporary, { recursive: true, force: true });
  throw error;
}
