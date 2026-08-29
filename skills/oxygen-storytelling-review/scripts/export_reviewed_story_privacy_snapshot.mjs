#!/usr/bin/env node
import { link, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { storyPreparationDigest } from "../../../viewer/lib/story-preparation.ts";
import { directPathEntry } from "./direct_path_entry.mjs";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL && specifier.startsWith(".")) {
      const path = fileURLToPath(new URL(specifier, context.parentURL));
      if (!extname(path)) {
        if (existsSync(`${path}.ts`)) return nextResolve(`${specifier}.ts`, context);
        if (existsSync(resolve(path, "index.ts"))) return nextResolve(`${specifier}/index.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const args = process.argv.slice(2);
const fail = (code) => { throw new Error(code); };
const safeId = (value) => typeof value === "string" && Boolean(value.trim())
  && !/[\u0000-\u001f\u007f]/u.test(value);
const samePath = (left, right) => process.platform === "win32"
  ? left.replaceAll("/", "\\").toLowerCase() === right.replaceAll("/", "\\").toLowerCase()
  : left === right;

if (args.length !== 4 || args[0] !== "--workflow-run-id" || args[2] !== "--output"
  || !safeId(args[1]) || !args[3]) {
  fail("USAGE_EXPORT_REVIEWED_STORY_PRIVACY_SNAPSHOT_WORKFLOW_RUN_ID_OUTPUT");
}
const workflowRunId = args[1];
const stateInput = process.env.OXYGEN_VIEWER_STATE_DIR;
if (!stateInput || !isAbsolute(stateInput) || win32.isAbsolute(basename(stateInput))) {
  fail("VIEWER_STATE_DIR_INVALID");
}
const requestedState = resolve(stateInput);
const stateEntry = await directPathEntry(requestedState).catch(() => fail("VIEWER_STATE_DIR_INVALID"));
if (!stateEntry?.state.isDirectory()) {
  fail("VIEWER_STATE_TOPOLOGY_INVALID");
}
const stateDir = stateEntry.physical;
const databaseInput = resolve(stateDir, "oxygen.sqlite");
const databaseEntry = await directPathEntry(databaseInput).catch(() => fail("VIEWER_DATABASE_INVALID"));
if (!databaseEntry) fail("VIEWER_DATABASE_TOPOLOGY_INVALID");
const databaseStat = databaseEntry.state;
const databasePath = databaseEntry.physical;
const databaseRelative = relative(stateDir, databasePath);
if (!databaseStat.isFile() || databaseStat.nlink !== 1
  || databaseRelative === ".." || databaseRelative.startsWith(`..${sep}`)
  || isAbsolute(databaseRelative)) {
  fail("VIEWER_DATABASE_TOPOLOGY_INVALID");
}

const outputInput = resolve(args[3]);
const requestedParent = dirname(outputInput);
const parentEntry = await directPathEntry(requestedParent).catch(() => fail("OUTPUT_PARENT_INVALID"));
if (!parentEntry?.state.isDirectory()) fail("OUTPUT_PARENT_INVALID");
const parent = parentEntry.physical;
const output = resolve(parent, basename(outputInput));
const outputRelative = relative(parent, output);
if (!outputRelative || outputRelative === ".." || outputRelative.startsWith(`..${sep}`)
  || isAbsolute(outputRelative) || samePath(output, databasePath)) fail("OUTPUT_INVALID");

const [{ getLocalDatabase }, { buildReviewedStoryPrivacyPreparationSnapshot }] = await Promise.all([
  import("../../../viewer/db/index.ts"),
  import("../../../viewer/lib/story-privacy-authority.ts"),
]);
const result = await buildReviewedStoryPrivacyPreparationSnapshot(await getLocalDatabase(), workflowRunId);
if (!result.ok) fail(result.code);
const bytes = `${JSON.stringify(result.snapshot)}\n`;
const temporary = resolve(parent, `.${basename(output)}.${process.pid}.tmp`);
await writeFile(temporary, bytes, { flag: "wx" });
try {
  await link(temporary, output);
} finally {
  await rm(temporary, { force: true });
}
console.log(JSON.stringify({
  output,
  snapshotDigest: await storyPreparationDigest(result.snapshot),
  changedTargetCount: result.snapshot.binding.changedTargetCount,
  scanTargetCount: result.snapshot.changedTargets.length,
}));
