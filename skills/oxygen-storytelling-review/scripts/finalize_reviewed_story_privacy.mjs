#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import {
  normalizeStoryPrivacyOutput,
  storyPreparationDigest,
} from "../../../viewer/lib/story-preparation.ts";
import {
  validActivatedSourceRevision,
  validNonnegativeAuthorityCounter,
} from "../../../viewer/lib/authority-validation.mjs";
import { directPathEntry } from "./direct_path_entry.mjs";
import { publishDirectoryNoReplace } from "./atomic_publish.mjs";

class CliFailure extends Error {}
const fail = (code) => { throw new CliFailure(code); };
async function main() {
const inputs = process.argv.slice(2);
if (inputs.length !== 3) {
  fail("USAGE_FINALIZE_REVIEWED_STORY_PRIVACY_ROOT_PROPOSALS_OUTPUT");
}
const [rootInput, proposalInput, outputInput] = inputs;
const hex = /^[0-9a-f]{64}$/;
const exact = (value, keys) => Boolean(value) && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const safeId = (value) => typeof value === "string" && Boolean(value.trim())
  && !/[\u0000-\u001f\u007f]/u.test(value);
const compareUtf8 = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));

async function contained(root, value) {
  if (typeof value !== "string" || !value || isAbsolute(value) || win32.isAbsolute(value)
    || value.split(/[\\/]/u).some((part) => part === "..")) fail("PATH_NOT_CONTAINED");
  const entry = await directPathEntry(resolve(root, value)).catch(() => fail("FILE_UNREADABLE"));
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

const rootEntry = await directPathEntry(rootInput).catch(() => fail("ROOT_INVALID"));
if (!rootEntry?.state.isDirectory()) fail("ROOT_INVALID");
const root = rootEntry.physical;
const manifest = await json(await contained(root, "manifest.json"));
const bindingKeys = [
  "workflowRunId", "sourceRevision", "activeStoryDigest", "serverVersion",
  "reviewedStoryDigest", "targetCatalogDigest", "changedTargetDigest",
  "changedTargetCount", "previousAuthorityDigest",
];
if (!exact(manifest, ["schema", "binding", "targetTransitions", "changedTargetIds", "shardLimits",
  "shards", "manifestDigest"])
  || manifest.schema !== "oxygen.reviewed-story-privacy-preparation"
  || !exact(manifest.binding, bindingKeys) || !safeId(manifest.binding.workflowRunId)
  || !validActivatedSourceRevision(manifest.binding.sourceRevision)
  || !validNonnegativeAuthorityCounter(manifest.binding.serverVersion)
  || !validNonnegativeAuthorityCounter(manifest.binding.changedTargetCount)
  || ![manifest.binding.activeStoryDigest, manifest.binding.reviewedStoryDigest,
    manifest.binding.targetCatalogDigest, manifest.binding.changedTargetDigest,
    manifest.binding.previousAuthorityDigest].every((value) => typeof value === "string" && hex.test(value))
  || !Array.isArray(manifest.targetTransitions) || !Array.isArray(manifest.changedTargetIds)
  || !Array.isArray(manifest.shards) || !exact(manifest.shardLimits, ["maxContentBytes", "maxTargets"])
  || manifest.shardLimits.maxContentBytes !== 1_000_000 || manifest.shardLimits.maxTargets !== 64
  || typeof manifest.manifestDigest !== "string" || !hex.test(manifest.manifestDigest)) {
  fail("MANIFEST_INVALID");
}
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
if (new Set(manifest.changedTargetIds).size !== manifest.changedTargetIds.length
  || manifest.changedTargetIds.some((id) => !safeId(id))
  || manifest.changedTargetIds.length !== scanTransitions.length
  || manifest.changedTargetIds.some((id) => !scanTransitions.some((target) => target.id === id))
  || (manifest.changedTargetIds.length === 0) !== (manifest.shards.length === 0)) {
  fail("MANIFEST_STALE");
}

const changed = new Set(manifest.changedTargetIds);
const targetOrder = new Map(manifest.changedTargetIds.map((id, index) => [id, index]));
const assigned = [];
const validatedInputs = new Map();
const targetById = new Map();
for (const shard of manifest.shards) {
  if (!exact(shard, ["id", "targetIds", "inputPath", "inputDigest"])
    || !safeId(shard.id) || !Array.isArray(shard.targetIds) || shard.targetIds.length === 0
    || shard.targetIds.length > manifest.shardLimits.maxTargets || !hex.test(shard.inputDigest)
    || shard.targetIds.some((id) => !changed.has(id))
    || new Set(shard.targetIds).size !== shard.targetIds.length
    || shard.targetIds.some((id, index) => index > 0
      && targetOrder.get(shard.targetIds[index - 1]) >= targetOrder.get(id))) fail("SHARD_INVALID");
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
    targetById.set(target.id, target);
  }
  if (contentBytes > manifest.shardLimits.maxContentBytes) fail("SHARD_BOUND_EXCEEDED");
  validatedInputs.set(shard.id, input);
}
if (assigned.length !== new Set(assigned).size
  || JSON.stringify([...assigned].sort(compareUtf8))
    !== JSON.stringify([...changed].sort(compareUtf8))) fail("SHARD_UNION_INVALID");
const targetCatalog = manifest.changedTargetIds.map((id) => targetById.get(id));
if (targetCatalog.some((target) => !target)) fail("SHARD_UNION_INVALID");

const proposalEntry = await directPathEntry(proposalInput).catch(() => fail("PROPOSAL_ROOT_INVALID"));
if (!proposalEntry?.state.isDirectory()) fail("PROPOSAL_ROOT_INVALID");
const proposalRoot = proposalEntry.physical;
const expectedFiles = manifest.shards.map((shard) => `${shard.id}.proposals.json`).sort(compareUtf8);
if (JSON.stringify((await readdir(proposalRoot)).sort(compareUtf8)) !== JSON.stringify(expectedFiles)) {
  fail("PROPOSAL_SET_INVALID");
}
const proposalOutputs = new Map();
for (const shard of manifest.shards) {
  const input = validatedInputs.get(shard.id);
  const normalized = await normalizeStoryPrivacyOutput(
    await json(await contained(proposalRoot, `${shard.id}.proposals.json`)),
    input.targets,
  );
  if (!normalized) fail("PROPOSAL_INVALID");
  proposalOutputs.set(shard.id, normalized);
}
const privacy = await normalizeStoryPrivacyOutput({
  candidates: [...proposalOutputs.values()].flatMap((output) => output.candidates),
  targetProposals: [...proposalOutputs.values()].flatMap((output) => output.targetProposals),
}, targetCatalog);
if (!privacy) fail("PROPOSAL_INVALID");

const records = resolve(root, "records");
const existing = await directPathEntry(records).catch((error) => (
  error?.code === "ENOENT" ? undefined : fail("RECORDS_TOPOLOGY_INVALID")
));
if (existing === null || (existing && !existing.state.isDirectory())) fail("RECORDS_TOPOLOGY_INVALID");
if (existing === undefined) {
  const temporaryRecords = resolve(root, `.records.${process.pid}-${randomUUID()}.tmp`);
  await mkdir(temporaryRecords, { recursive:false });
  try {
    for (const shard of manifest.shards) {
      const output = proposalOutputs.get(shard.id);
      await writeFile(resolve(temporaryRecords, `${shard.id}.output.json`),
        `${JSON.stringify(output)}\n`, { flag:"wx" });
      await writeFile(resolve(temporaryRecords, `${shard.id}.receipt.json`), `${JSON.stringify({
        schema: "oxygen.reviewed-story-privacy-shard-receipt",
        shardId: shard.id,
        status: "complete",
        manifestDigest,
        inputDigest: shard.inputDigest,
        targetIds: shard.targetIds,
        outputDigest: await storyPreparationDigest(output),
        outputCount: output.targetProposals.length,
      })}\n`, { flag:"wx" });
    }
    await writeFile(resolve(temporaryRecords, "terminal-receipt.json"), `${JSON.stringify({
      schema: "oxygen.reviewed-story-privacy-terminal-receipt",
      status: "complete",
      ...Object.fromEntries(Object.entries(manifest.binding)
        .filter(([key]) => key !== "previousAuthorityDigest")),
      outputDigest: await storyPreparationDigest(privacy),
      outputCount: privacy.targetProposals.length,
      completedAt: new Date().toISOString(),
    })}\n`, { flag:"wx" });
    publishDirectoryNoReplace(temporaryRecords, records, fail, {
      exists:"RECORDS_EXISTS", unavailable:"RECORDS_ATOMIC_PUBLICATION_UNAVAILABLE",
    });
  } catch (error) {
    await rm(temporaryRecords, { recursive:true, force:true });
    throw error;
  }
}

const recordedParts = [];
for (const shard of manifest.shards) {
  const input = validatedInputs.get(shard.id);
  const receipt = await json(await contained(root, `records/${shard.id}.receipt.json`));
  if (!exact(receipt, ["schema", "shardId", "status", "manifestDigest", "inputDigest", "targetIds",
    "outputDigest", "outputCount"])
    || receipt.schema !== "oxygen.reviewed-story-privacy-shard-receipt"
    || receipt.shardId !== shard.id || receipt.status !== "complete"
    || receipt.manifestDigest !== manifestDigest || receipt.inputDigest !== shard.inputDigest
    || JSON.stringify(receipt.targetIds) !== JSON.stringify(shard.targetIds)
    || !hex.test(receipt.outputDigest) || !Number.isSafeInteger(receipt.outputCount)
    || receipt.outputCount !== shard.targetIds.length) fail("SHARD_RECEIPT_INVALID");
  const output = await json(await contained(root, `records/${shard.id}.output.json`));
  const normalized = await normalizeStoryPrivacyOutput(output, input.targets);
  if (!normalized || normalized.targetProposals.length !== receipt.outputCount
    || await storyPreparationDigest(normalized) !== receipt.outputDigest) fail("SHARD_OUTPUT_INVALID");
  recordedParts.push(normalized);
}
const recordedPrivacy = await normalizeStoryPrivacyOutput({
  candidates: recordedParts.flatMap((output) => output.candidates),
  targetProposals: recordedParts.flatMap((output) => output.targetProposals),
}, targetCatalog);
if (!recordedPrivacy || JSON.stringify(recordedPrivacy) !== JSON.stringify(privacy)) {
  fail("PROPOSAL_RECORD_CONFLICT");
}

const outputDigest = await storyPreparationDigest(recordedPrivacy);
const terminal = await json(await contained(root, "records/terminal-receipt.json"));
const terminalKeys = [
  "schema", "status", "workflowRunId", "sourceRevision", "activeStoryDigest", "serverVersion",
  "reviewedStoryDigest", "targetCatalogDigest", "changedTargetDigest", "changedTargetCount",
  "outputDigest", "outputCount", "completedAt",
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
  outputCount: recordedPrivacy.targetProposals.length,
  completedAt: terminal.completedAt,
};
if (!exact(terminal, terminalKeys) || !timestamp(terminal.completedAt)
  || JSON.stringify(terminal) !== JSON.stringify(expectedTerminal)) fail("TERMINAL_RECEIPT_INVALID");
const receiptDigest = await storyPreparationDigest(terminal);
const core = {
  schema: "oxygen.reviewed-story-privacy-import",
  binding: manifest.binding,
  receiptDigest,
  privacy: recordedPrivacy,
};
const bundle = {
  schema: core.schema,
  binding: core.binding,
  terminalReceipt: terminal,
  receiptDigest,
  privacy: recordedPrivacy,
  importDigest: await storyPreparationDigest(core),
};

if (win32.isAbsolute(basename(outputInput)) || isAbsolute(basename(outputInput))) fail("OUTPUT_INVALID");
const parentEntry = await directPathEntry(dirname(resolve(outputInput)))
  .catch(() => fail("OUTPUT_PARENT_INVALID"));
if (!parentEntry?.state.isDirectory()) fail("OUTPUT_PARENT_INVALID");
const output = resolve(parentEntry.physical, basename(outputInput));
const temporary = resolve(parentEntry.physical,
  `.${basename(outputInput)}.${process.pid}-${randomUUID()}.tmp`);
await writeFile(temporary, `${JSON.stringify(bundle)}\n`, { flag:"wx" });
try {
  await link(temporary, output);
} finally {
  await rm(temporary, { force:true });
}
console.log(JSON.stringify({ output, importDigest: bundle.importDigest,
  outputCount: recordedPrivacy.targetProposals.length }));
}
await main().catch((error) => { console.error(error instanceof CliFailure
  ? error.message : "REVIEWED_STORY_PRIVACY_FINALIZE_FAILED"); process.exitCode = 1; });
