import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL && specifier.startsWith(".")) {
      const path = fileURLToPath(new URL(specifier, context.parentURL));
      if (!extname(path)) {
        if (existsSync(`${path}.ts`)) return nextResolve(`${specifier}.ts`, context);
        if (existsSync(join(path, "index.ts"))) return nextResolve(`${specifier}/index.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FINALIZER = join(ROOT, "skills", "oxygen-elicit-contributor-preferences", "scripts", "validate_probes.py");
const RUN_ID = "preference-producer-contract";
const INSIGHT_DIGEST = "a".repeat(64);

const context = {
  schema: "oxygen.preference-context",
  reusableLessons: [
    { storyKey: "zeta", insightId: "insight-c", insightAuthorityDigest: "c".repeat(64),
      background: "Reviewed background Z.", directlyAcquiredExperience: "Reviewed experience Z.",
      principle: "Reviewed principle Z." },
    { storyKey: "故事", insightId: "insight-a", insightAuthorityDigest: "b".repeat(64),
      background: "Reviewed background U.", directlyAcquiredExperience: "Reviewed experience U.",
      principle: "Reviewed principle U." },
    { storyKey: "chapter-a", insightId: "insight-a", insightAuthorityDigest: INSIGHT_DIGEST,
      background: "Reviewed background.", directlyAcquiredExperience: "Reviewed experience.",
      principle: "Reviewed principle." },
  ],
  insightScope: [
    { storyKey: "chapter-a", insightId: "insight-a", insightAuthorityDigest: INSIGHT_DIGEST },
    { storyKey: "zeta", insightId: "insight-c", insightAuthorityDigest: "c".repeat(64) },
    { storyKey: "故事", insightId: "insight-a", insightAuthorityDigest: "b".repeat(64) },
  ],
  reviewedEvidence: [{ documentId: "doc-a", eventId: "event-a", documentKind: "trajectory",
    sequence: 1, role: "user", timestamp: null, redactedText: "A reviewed source set a boundary." }],
  autoRemoved: { total: 0, reversible: true, categories: [] },
};
const candidates = {
  probes: [{
    id: "probe-a", storyKey: "chapter-a", insightId: "insight-a", insightAuthorityDigest: INSIGHT_DIGEST,
    documentId: "doc-a", documentKind: "trajectory", eventIds: ["event-a"], timestamp: null,
    signal: "explicit_rule", score: 90, turns: 1, recap: "A reviewed source set a boundary.",
    question: "What should the agent remember?", options: [{ id: "one", text: "Ask before changing this boundary." }, { id: "two", text: "Use a separate branch for this boundary." }],
    presentations: {}, allowOther: true, allowSkip: true,
  }],
  bulkDecisions: [], setAside: 0,
};

test("Python preference producer emits the exact Core digest batch accepted by POST /api/probes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oxygen-preference-producer-"));
  const previous = process.env.OXYGEN_VIEWER_STATE_DIR;
  process.env.OXYGEN_VIEWER_STATE_DIR = dir;
  try {
    const contextPath = join(dir, "preference-context.json");
    const candidatesPath = join(dir, "preference-candidates.json");
    const outputPath = join(dir, "preference-bundle.json");
    await writeFile(contextPath, JSON.stringify(context));
    await writeFile(candidatesPath, JSON.stringify(candidates));
    execFileSync("python", [FINALIZER, "--context", contextPath, "--candidates", candidatesPath, "--workflow-run-id", RUN_ID, "--source-revision", "3", "--output", outputPath], { stdio: "pipe" });
    const bundle = JSON.parse(await readFile(outputPath, "utf8"));
    assert.deepEqual(Object.keys(bundle).sort(), ["autoRemoved", "bulkDecisions", "inputDigest", "insightScope",
      "outputCount", "outputDigest",
      "probes", "setAside", "sourceRevision", "workflowRunId"]);
    const [{ getLocalDatabase }, route, preparation] = await Promise.all([
      import("../db/index.ts"), import("../app/api/probes/route.ts"), import("../lib/story-preparation.ts"),
    ]);
    assert.equal(bundle.outputDigest, await preparation.storyPreparationDigest(preparation.canonicalPreferenceQuestionBatch(bundle.probes, bundle.bulkDecisions)));
    const noncanonical = structuredClone(bundle);
    noncanonical.insightScope.reverse();
    assert.equal((await route.POST(new Request("http://localhost/api/probes", {
      method: "POST", body: JSON.stringify(noncanonical),
    }))).status, 400);
    const db = await getLocalDatabase();
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM probe_runs").first()).count, 0);
    await db.prepare("INSERT INTO workflow_runs (id,story_generation_status,story_source_revision,created_at,updated_at) VALUES (?,'running',?,?,?)").bind(RUN_ID, 3, "2041-01-01", "2041-01-01").run();
    await db.prepare("INSERT INTO documents (id,kind,title,item_count,imported_at,updated_at) VALUES (?,'trajectory','Synthetic',1,?,?)").bind("doc-a", "2041-01-01", "2041-01-01").run();
    await db.prepare("INSERT INTO items (id,document_id,sequence,content,original_json) VALUES (?,?,1,'Synthetic','{}')").bind("event-a", "doc-a").run();
    assert.equal((await route.POST(new Request("http://localhost/api/probes", { method: "POST", body: JSON.stringify(bundle) }))).status, 200);
  } finally {
    globalThis.__oxygenLocalSqlite?.database.close();
    if (previous === undefined) delete process.env.OXYGEN_VIEWER_STATE_DIR;
    else process.env.OXYGEN_VIEWER_STATE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("Python preference producer rejects zero source authority without creating or replacing output", async (t) => {
  for (const [name, candidateValue] of [
    ["completed-zero", { probes: [], bulkDecisions: [], setAside: 0 }],
    ["completed-nonzero", candidates],
  ]) await t.test(name, async () => {
    const dir = await mkdtemp(join(tmpdir(), "oxygen-preference-zero-authority-"));
    try {
      const contextPath = join(dir, "preference-context.json");
      const candidatesPath = join(dir, "preference-candidates.json");
      const outputPath = join(dir, "preference-bundle.json");
      await writeFile(contextPath, JSON.stringify(context));
      await writeFile(candidatesPath, JSON.stringify(candidateValue));
      const invoke = () => spawnSync("python", [FINALIZER,
        "--context", contextPath,
        "--candidates", candidatesPath,
        "--workflow-run-id", RUN_ID,
        "--source-revision", "0",
        "--output", outputPath,
      ], { encoding: "utf8" });

      const absent = invoke();
      assert.notEqual(absent.status, 0);
      assert.equal(absent.stdout, "");
      assert.match(absent.stderr, /^error: workflow authority is invalid\r?\n$/u);
      assert.equal(existsSync(outputPath), false);

      const sentinel = Buffer.from("preserve-existing-preference-output-byte-for-byte\n");
      await writeFile(outputPath, sentinel);
      const existing = invoke();
      assert.notEqual(existing.status, 0);
      assert.equal(existing.stdout, "");
      assert.match(existing.stderr, /^error: workflow authority is invalid\r?\n$/u);
      assert.deepEqual(await readFile(outputPath), sentinel);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("producer sources have no HTTP, SQLite, or provider execution surface", async () => {
  const scripts = await Promise.all([
    readFile(join(ROOT, "skills", "oxygen-elicit-contributor-preferences", "scripts", "prepare_preference_context.py"), "utf8"),
    readFile(FINALIZER, "utf8"),
  ]);
  for (const forbidden of ["urllib", "requests", "http", "sqlite", "openai", "provider"]) {
    assert.doesNotMatch(scripts.join("\n").toLowerCase(), new RegExp(forbidden));
  }
});

test("owned preference scope has no tracked retired push protocol", async () => {
  assert.equal(existsSync(join(ROOT, "tools", "llm_redact", ["push", "probes.py"].join("_"))), false);
  assert.equal(existsSync(join(ROOT, "tools", "llm_redact", ["PROBE", "PROMPT.md"].join("_"))), false);
  const owned = await Promise.all([
    readFile(join(ROOT, "skills", "oxygen-elicit-contributor-preferences", "SKILL.md"), "utf8"),
    readFile(join(ROOT, "skills", "oxygen-elicit-contributor-preferences", "references", "preference-probe-contract.md"), "utf8"),
    readFile(join(ROOT, "skills", "oxygen-elicit-contributor-preferences", "references", "preference-worker-prompt.md"), "utf8"),
  ]);
  assert.doesNotMatch(owned.join("\n"), /push_probes\.py|PROBE_PROMPT\.md/);
});
