import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { seedChapterPrivacy } from "./chapter-privacy.mjs";

const destination = process.argv[2];
if (!destination || (process.argv.length !== 3 && !(process.argv.length === 4 && process.argv[3] === "--multiple-privacy-choices"))) throw new Error("Usage: node tests/fixtures/seed-chapter-privacy.mjs <new-state-directory> [--multiple-privacy-choices]");
const directory = resolve(destination);
// Exclusive creation prevents an accidental seed into any existing Viewer run.
await mkdir(directory);
process.env.OXYGEN_VIEWER_STATE_DIR = directory;
const { getLocalDatabase } = await import("../../db/index.ts");
try {
  const db = await getLocalDatabase();
  const { run } = await seedChapterPrivacy(db, { interactive: true, badSecondChapter: false, multiplePrivacyChoices: process.argv[3] === "--multiple-privacy-choices" });
  console.log(JSON.stringify({ stateDirectory: directory, workflowRunId: run,
    launch: "Set OXYGEN_VIEWER_STATE_DIR to this directory, then node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port <free-port>" }));
} finally {
  globalThis.__oxygenLocalSqlite?.database.close(); delete globalThis.__oxygenLocalSqlite;
}
