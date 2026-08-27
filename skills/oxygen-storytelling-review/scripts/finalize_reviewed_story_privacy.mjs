#!/usr/bin/env node
import { link, lstat, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { storyPreparationDigest } from "../../../viewer/lib/story-preparation.ts";

const [rootInput, outputInput] = process.argv.slice(2);
const hex = /^[0-9a-f]{64}$/;
const exact = (value, keys) => Boolean(value) && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const fail = (code) => { throw new Error(code); };
const safeId = (value) => typeof value === "string" && Boolean(value.trim())
  && !/[\u0000-\u001f\u007f]/u.test(value);
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
  const physical = await realpath(resolve(root, value)).catch(() => fail("FILE_UNREADABLE"));
  const rel = relative(root, physical);
  const stat = await lstat(physical).catch(() => fail("FILE_UNREADABLE"));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)
    || !stat.isFile() || stat.nlink !== 1) fail("FILE_TOPOLOGY_INVALID");
  return physical;
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
const root = await realpath(resolve(rootInput)).catch(() => fail("ROOT_INVALID"));
const manifestPath = await contained(root, "manifest.json");
const manifest = await json(manifestPath);
const bindingKeys = [
  "workflowRunId", "sourceRevision", "activeStoryDigest", "serverVersion",
  "reviewedStoryDigest", "targetCatalogDigest", "changedTargetDigest",
  "changedTargetCount", "previousBatchDigest",
];
if (!exact(manifest, ["schema", "binding", "changedTargetIds", "shards", "manifestDigest"])
  || manifest.schema !== "oxygen.reviewed-story-privacy-preparation"
  || !exact(manifest.binding, bindingKeys) || !Array.isArray(manifest.changedTargetIds)
  || !Array.isArray(manifest.shards) || manifest.shards.length === 0
  || !hex.test(manifest.manifestDigest)) fail("MANIFEST_INVALID");
const { manifestDigest, ...manifestCore } = manifest;
if (await storyPreparationDigest(manifestCore) !== manifestDigest
  || manifest.binding.changedTargetCount !== manifest.changedTargetIds.length
  || await storyPreparationDigest(manifest.changedTargetIds) !== manifest.binding.changedTargetDigest
  || new Set(manifest.changedTargetIds).size !== manifest.changedTargetIds.length) fail("MANIFEST_STALE");
const changed = new Set(manifest.changedTargetIds);
const assigned = [];
const candidates = [];
for (const shard of manifest.shards) {
  if (!exact(shard, ["id", "targetIds", "inputPath", "receiptPath"])
    || !safeId(shard.id) || !Array.isArray(shard.targetIds) || shard.targetIds.length === 0
    || shard.targetIds.some((id) => !changed.has(id))
    || new Set(shard.targetIds).size !== shard.targetIds.length) fail("SHARD_INVALID");
  assigned.push(...shard.targetIds);
  const input = await json(await contained(root, shard.inputPath));
  if (!exact(input, ["schema", "shardId", "binding", "targets"])
    || input.schema !== "oxygen.reviewed-story-privacy-shard-input" || input.shardId !== shard.id
    || JSON.stringify(input.binding) !== JSON.stringify(manifest.binding)
    || !Array.isArray(input.targets)
    || JSON.stringify(input.targets.map((target) => target.id)) !== JSON.stringify(shard.targetIds)) {
    fail("SHARD_INPUT_INVALID");
  }
  const receipt = await json(await contained(root, shard.receiptPath));
  if (!exact(receipt, ["schema", "shardId", "status", "manifestDigest", "targetIds",
    "outputPath", "outputDigest", "outputCount"])
    || receipt.schema !== "oxygen.reviewed-story-privacy-shard-receipt"
    || receipt.shardId !== shard.id || receipt.status !== "complete"
    || receipt.manifestDigest !== manifestDigest
    || JSON.stringify(receipt.targetIds) !== JSON.stringify(shard.targetIds)
    || !hex.test(receipt.outputDigest) || !Number.isSafeInteger(receipt.outputCount)
    || receipt.outputCount < 0) fail("SHARD_RECEIPT_INVALID");
  const output = await json(await contained(root, receipt.outputPath));
  if (!Array.isArray(output) || output.length !== receipt.outputCount
    || await storyPreparationDigest(output) !== receipt.outputDigest) fail("SHARD_OUTPUT_INVALID");
  candidates.push(...output.map((value) => candidate(value, changed)));
}
if (assigned.length !== new Set(assigned).size
  || JSON.stringify([...assigned].sort()) !== JSON.stringify([...changed].sort())) fail("SHARD_UNION_INVALID");
candidates.sort((left, right) => Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)));
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
  batchDigest: await storyPreparationDigest(core) };
// Match the API's exact key order without making order part of the semantic digest.
const ordered = {
  schema: bundle.schema, binding: bundle.binding, terminalReceipt: bundle.terminalReceipt,
  receiptDigest: bundle.receiptDigest, candidates: bundle.candidates, batchDigest: bundle.batchDigest,
};
const parent = await realpath(dirname(resolve(outputInput))).catch(() => fail("OUTPUT_PARENT_INVALID"));
const output = resolve(parent, basename(outputInput));
if (win32.isAbsolute(basename(outputInput)) || isAbsolute(basename(outputInput))) fail("OUTPUT_INVALID");
const temporary = resolve(parent, `.${basename(outputInput)}.${process.pid}.tmp`);
await writeFile(temporary, `${JSON.stringify(ordered)}\n`, { flag: "wx" });
try {
  await link(temporary, output);
} finally {
  await rm(temporary, { force: true });
}
console.log(JSON.stringify({ output, batchDigest: ordered.batchDigest, outputCount: candidates.length }));
