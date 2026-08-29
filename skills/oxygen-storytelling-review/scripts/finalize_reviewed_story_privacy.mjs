#!/usr/bin/env node
import { link, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { storyPreparationDigest } from "../../../viewer/lib/story-preparation.ts";
import {
  validActivatedSourceRevision,
  validNonnegativeAuthorityCounter,
} from "../../../viewer/lib/authority-validation.mjs";
import { directPathEntry } from "./direct_path_entry.mjs";

const [rootInput, outputInput] = process.argv.slice(2);
const hex = /^[0-9a-f]{64}$/;
const exact = (value, keys) => Boolean(value) && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const fail = (code) => { throw new Error(code); };
const safeId = (value) => typeof value === "string" && Boolean(value.trim())
  && !/[\u0000-\u001f\u007f]/u.test(value);
const compareUtf8 = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));
const forbidden = new Set(["raworiginal", "original", "evidence", "provider", "model", "prompt",
  "execution", "agent", "duration", "token", "cost", "log"]);

function rejectExtra(value) {
  if (Array.isArray(value)) return value.forEach(rejectExtra);
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (forbidden.has(key.replace(/[^a-z0-9]/giu, "").toLowerCase())) fail("OUTPUT_METADATA_FORBIDDEN");
    rejectExtra(nested);
  }
}

async function contained(root, value) {
  if (typeof value !== "string" || !value || isAbsolute(value) || win32.isAbsolute(value)
    || value.split(/[\\/]/u).some((part) => part === "..")) fail("PATH_NOT_CONTAINED");
  const requested = resolve(root, value);
  const entry = await directPathEntry(requested).catch(() => fail("FILE_UNREADABLE"));
  if (!entry) fail("FILE_TOPOLOGY_INVALID");
  const rel = relative(root, entry.physical);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)
    || !entry.state.isFile() || entry.state.nlink !== 1) fail("FILE_TOPOLOGY_INVALID");
  return entry.physical;
}
async function json(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { fail("JSON_INVALID"); }
}
function timestamp(value) {
  if (typeof value !== "string" || !value) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}
function candidate(value, changed) {
  rejectExtra(value);
  if (!exact(value, ["id", "reviewState", "title", "whyFlagged", "uncertaintyReason", "releaseTargets"])
    || !safeId(value.id) || !["deterministic", "needs_confirmation"].includes(value.reviewState)
    || !safeId(value.title) || !safeId(value.whyFlagged)
    || (value.reviewState === "deterministic" && value.uncertaintyReason !== null)
    || (value.reviewState === "needs_confirmation" && !safeId(value.uncertaintyReason))
    || !Array.isArray(value.releaseTargets) || value.releaseTargets.length === 0
    || value.releaseTargets.some((target) => !changed.has(target))
    || new Set(value.releaseTargets).size !== value.releaseTargets.length) fail("CANDIDATE_INVALID");
  return value;
}

if (!rootInput || !outputInput) fail("USAGE_FINALIZE_REVIEWED_STORY_PRIVACY_ROOT_OUTPUT");
const rootEntry = await directPathEntry(rootInput).catch(() => fail("ROOT_INVALID"));
if (!rootEntry?.state.isDirectory()) fail("ROOT_INVALID");
const root = rootEntry.physical;
const manifest = await json(await contained(root, "manifest.json"));
const bindingKeys = [
  "workflowRunId", "sourceRevision", "activeStoryDigest", "serverVersion",
  "reviewedStoryDigest", "targetCatalogDigest", "changedTargetDigest",
  "changedTargetCount", "previousCandidateDigest",
];
if (!exact(manifest, ["schema", "binding", "targetTransitions", "changedTargetIds", "shardLimits",
  "shards", "manifestDigest"])
  || manifest.schema !== "oxygen.reviewed-story-privacy-preparation"
  || !exact(manifest.binding, bindingKeys) || !Array.isArray(manifest.targetTransitions)
  || !Array.isArray(manifest.changedTargetIds) || !Array.isArray(manifest.shards)
  || !validActivatedSourceRevision(manifest.binding.sourceRevision)
  || !validNonnegativeAuthorityCounter(manifest.binding.serverVersion)
  || !validNonnegativeAuthorityCounter(manifest.binding.changedTargetCount)
  || !exact(manifest.shardLimits, ["maxContentBytes", "maxTargets"])
  || manifest.shardLimits.maxContentBytes !== 1_000_000 || manifest.shardLimits.maxTargets !== 64
  || !hex.test(manifest.manifestDigest)) fail("MANIFEST_INVALID");
const { manifestDigest, ...manifestCore } = manifest;
if (await storyPreparationDigest(manifestCore) !== manifestDigest
  || manifest.binding.changedTargetCount !== manifest.targetTransitions.length
  || await storyPreparationDigest(manifest.targetTransitions) !== manifest.binding.changedTargetDigest
  || new Set(manifest.targetTransitions.map((target) => target.id)).size !== manifest.targetTransitions.length
  || manifest.targetTransitions.some((target, index) => !exact(target,
    ["id", "previousContentDigest", "contentDigest"]) || !safeId(target.id)
    || (target.previousContentDigest !== null && !hex.test(target.previousContentDigest))
    || (target.contentDigest !== null && !hex.test(target.contentDigest))
    || target.previousContentDigest === target.contentDigest
    || (index > 0 && compareUtf8(manifest.targetTransitions[index - 1].id, target.id) >= 0))) {
  fail("MANIFEST_STALE");
}
const transitionById = new Map(manifest.targetTransitions.map((target) => [target.id, target]));
const scanTransitions = manifest.targetTransitions.filter((target) => target.contentDigest !== null);
if (JSON.stringify(manifest.changedTargetIds) !== JSON.stringify(scanTransitions.map((target) => target.id))
  || new Set(manifest.changedTargetIds).size !== manifest.changedTargetIds.length
  || (manifest.changedTargetIds.length === 0) !== (manifest.shards.length === 0)) {
  fail("MANIFEST_STALE");
}
const changed = new Set(manifest.changedTargetIds);
const assigned = [];
const candidates = [];
for (const shard of manifest.shards) {
  if (!exact(shard, ["id", "targetIds", "inputPath", "inputDigest", "receiptPath"])
    || !safeId(shard.id) || !Array.isArray(shard.targetIds) || shard.targetIds.length === 0
    || shard.targetIds.length > manifest.shardLimits.maxTargets || !hex.test(shard.inputDigest)
    || shard.targetIds.some((id) => !changed.has(id))
    || new Set(shard.targetIds).size !== shard.targetIds.length) fail("SHARD_INVALID");
  assigned.push(...shard.targetIds);
  const input = await json(await contained(root, shard.inputPath));
  if (!exact(input, ["schema", "shardId", "binding", "targets", "inputDigest"])
    || input.schema !== "oxygen.reviewed-story-privacy-shard-input" || input.shardId !== shard.id
    || JSON.stringify(input.binding) !== JSON.stringify(manifest.binding)
    || !Array.isArray(input.targets)
    || JSON.stringify(input.targets.map((target) => target.id)) !== JSON.stringify(shard.targetIds)
    || input.inputDigest !== shard.inputDigest) fail("SHARD_INPUT_INVALID");
  const { inputDigest, ...inputCore } = input;
  if (await storyPreparationDigest(inputCore) !== inputDigest) fail("SHARD_INPUT_STALE");
  let contentBytes = 0;
  for (const target of input.targets) {
    const transition = transitionById.get(target.id);
    if (!exact(target, ["id", "storyKey", "target", "content", "contentDigest"])
      || ![target.id, target.storyKey, target.target].every(safeId)
      || typeof target.content !== "string" || target.content.length === 0
      || !hex.test(target.contentDigest) || transition?.contentDigest !== target.contentDigest
      || await storyPreparationDigest(target.content) !== target.contentDigest) fail("SHARD_TARGET_INVALID");
    contentBytes += Buffer.byteLength(target.content, "utf8");
  }
  if (contentBytes > manifest.shardLimits.maxContentBytes) fail("SHARD_BOUND_EXCEEDED");
  const receipt = await json(await contained(root, shard.receiptPath));
  if (!exact(receipt, ["schema", "shardId", "status", "manifestDigest", "inputDigest", "targetIds",
    "outputPath", "outputDigest", "outputCount"])
    || receipt.schema !== "oxygen.reviewed-story-privacy-shard-receipt"
    || receipt.shardId !== shard.id || receipt.status !== "complete"
    || receipt.manifestDigest !== manifestDigest || receipt.inputDigest !== shard.inputDigest
    || JSON.stringify(receipt.targetIds) !== JSON.stringify(shard.targetIds)
    || !hex.test(receipt.outputDigest) || !Number.isSafeInteger(receipt.outputCount)
    || receipt.outputCount < 0) fail("SHARD_RECEIPT_INVALID");
  const output = await json(await contained(root, receipt.outputPath));
  if (!Array.isArray(output) || output.length !== receipt.outputCount
    || await storyPreparationDigest(output) !== receipt.outputDigest) fail("SHARD_OUTPUT_INVALID");
  candidates.push(...output.map((value) => candidate(value, changed)));
}
if (assigned.length !== new Set(assigned).size
  || JSON.stringify([...assigned].sort(compareUtf8))
    !== JSON.stringify([...changed].sort(compareUtf8))) fail("SHARD_UNION_INVALID");
candidates.sort((left, right) => compareUtf8(left.id, right.id));
if (new Set(candidates.map((value) => value.id)).size !== candidates.length) fail("CANDIDATE_ID_CONFLICT");
const outputDigest = await storyPreparationDigest(candidates);
const terminal = await json(await contained(root, "terminal-receipt.json"));
const terminalKeys = [
  "schema", "status", "workflowRunId", "sourceRevision", "activeStoryDigest",
  "serverVersion", "reviewedStoryDigest", "targetCatalogDigest", "changedTargetDigest",
  "changedTargetCount", "outputDigest", "outputCount", "completedAt",
];
const expectedTerminal = {
  schema: "oxygen.reviewed-story-privacy-terminal-receipt",
  status: "complete",
  workflowRunId: manifest.binding.workflowRunId,
  sourceRevision: manifest.binding.sourceRevision,
  activeStoryDigest: manifest.binding.activeStoryDigest,
  serverVersion: manifest.binding.serverVersion,
  reviewedStoryDigest: manifest.binding.reviewedStoryDigest,
  targetCatalogDigest: manifest.binding.targetCatalogDigest,
  changedTargetDigest: manifest.binding.changedTargetDigest,
  changedTargetCount: manifest.binding.changedTargetCount,
  outputDigest,
  outputCount: candidates.length,
  completedAt: terminal.completedAt,
};
if (!exact(terminal, terminalKeys) || !timestamp(terminal.completedAt)
  || JSON.stringify(terminal) !== JSON.stringify(expectedTerminal)) fail("TERMINAL_RECEIPT_INVALID");
const receiptDigest = await storyPreparationDigest(terminal);
const core = {
  schema: "oxygen.reviewed-story-privacy-import",
  binding: manifest.binding,
  receiptDigest,
  candidates,
};
const bundle = { ...core, terminalReceipt: terminal,
  importDigest: await storyPreparationDigest(core) };
const ordered = {
  schema: bundle.schema, binding: bundle.binding, terminalReceipt: bundle.terminalReceipt,
  receiptDigest: bundle.receiptDigest, candidates: bundle.candidates,
  importDigest: bundle.importDigest,
};
const parentEntry = await directPathEntry(dirname(resolve(outputInput)))
  .catch(() => fail("OUTPUT_PARENT_INVALID"));
if (!parentEntry?.state.isDirectory()) fail("OUTPUT_PARENT_INVALID");
const parent = parentEntry.physical;
const output = resolve(parent, basename(outputInput));
if (win32.isAbsolute(basename(outputInput)) || isAbsolute(basename(outputInput))) fail("OUTPUT_INVALID");
const temporary = resolve(parent, `.${basename(outputInput)}.${process.pid}.tmp`);
await writeFile(temporary, `${JSON.stringify(ordered)}\n`, { flag: "wx" });
try {
  await link(temporary, output);
} finally {
  await rm(temporary, { force: true });
}
console.log(JSON.stringify({ output, importDigest: ordered.importDigest,
  outputCount: candidates.length }));
