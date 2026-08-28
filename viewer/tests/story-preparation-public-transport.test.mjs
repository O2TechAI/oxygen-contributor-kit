import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  canonicalAuthorityJson,
  finalizeCoverageManifestAuthority,
  validateStoryActivationAuthority,
  validateStorySourcePackage,
} from "../lib/story-readiness.ts";
import { computeSourceDigest } from "../lib/redaction-pass.mjs";
import { parseStorySource } from "../lib/timeline.ts";

const repository = resolve(import.meta.dirname, "../..");
const scripts = join(repository, "skills", "oxygen-storytelling-review", "scripts");
const prepare = join(scripts, "prepare_story_preparation.mjs");
const record = join(scripts, "record_story_preparation.mjs");
const finalize = join(scripts, "finalize_story_preparation.mjs");
const preferenceScripts = join(repository, "skills", "oxygen-elicit-contributor-preferences", "scripts");
const preparePreferenceContext = join(preferenceScripts, "prepare_preference_context.py");
const validateProbes = join(preferenceScripts, "validate_probes.py");
const digest = (value) => createHash("sha256").update(canonicalAuthorityJson(value)).digest("hex");
const json = (path, value) => writeFile(path, JSON.stringify(value), "utf8");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

function run(command, args) {
  return spawnSync(command, args, { cwd: repository, encoding: "utf8" });
}

function runOk(command, args) {
  const result = run(command, args);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

const laneDirectory = {
  story: "story", insight: "insight", story_privacy: "story-privacy", preference: "preference",
};

function phaseFreeProposal(record) {
  const { schema, key, coverage, ...chapter } = record.story;
  assert.equal(schema, "oxygen.story");
  assert.ok(coverage);
  delete chapter.phase;
  return { ownerId: key, chapter };
}

async function recordLane(transport, lane, root, proposalForInput) {
  const directory = laneDirectory[lane];
  const manifest = await readJson(join(transport, directory, "shards.json"));
  if (lane === "story") {
    const proposalDirectory = join(root, `story-proposals-${manifest.inputDigest.slice(0, 12)}`);
    await mkdir(proposalDirectory);
    const phases = new Map();
    for (const shard of manifest.shards) {
      const input = await readJson(join(transport, ...shard.inputPath.split("/")));
      const records = proposalForInput(input);
      for (const record of records) phases.set(record.story.key, record.story.phase);
      await json(join(proposalDirectory, `${shard.id}.json`), records.map(phaseFreeProposal));
    }
    const phasePath = join(root, `story-phases-${manifest.inputDigest.slice(0, 12)}.json`);
    await json(phasePath, [...phases].map(([ownerId, phase]) => ({ ownerId, phase })));
    runOk(process.execPath, [record, transport, "story", proposalDirectory, phasePath,
      "--correction-attempt-count", "0"]);
    return manifest;
  }
  for (const shard of manifest.shards) {
    const input = await readJson(join(transport, ...shard.inputPath.split("/")));
    const proposal = join(root, `${shard.id}-proposal.json`);
    await json(proposal, proposalForInput(input));
    runOk(process.execPath, [record, transport, lane, shard.id, proposal]);
  }
  return manifest;
}

async function storyBatchFiles(transport, root, records, tag = "batch") {
  const manifest = await readJson(join(transport, "story", "shards.json"));
  const proposalDirectory = join(root, `${tag}-proposals`);
  await mkdir(proposalDirectory);
  const byOwner = new Map(records.map((record) => [record.story.key, record]));
  for (const shard of manifest.shards) {
    await json(join(proposalDirectory, `${shard.id}.json`), shard.unitIds.map((ownerId) => (
      phaseFreeProposal(byOwner.get(ownerId))
    )));
  }
  const phasePath = join(root, `${tag}-phases.json`);
  await json(phasePath, records.map((record) => ({
    ownerId: record.story.key,
    phase: record.story.phase,
  })));
  return { manifest, proposalDirectory, phasePath };
}

async function reverseLaneManifest(transport, lane) {
  const path = join(transport, laneDirectory[lane], "shards.json");
  const manifest = await readJson(path);
  manifest.shards.reverse();
  await json(path, manifest);
}

function semanticAuthority({
  suffixes = ["a", "b"], projectId = "Synthetic Canary", kinds = ["decision_episode"],
} = {}) {
  const units = suffixes.map((suffix, index) => ({
    id: `unit-${suffix}`,
    revision: 1,
    projectId,
    kind: kinds[index % kinds.length],
    members: [`event-${suffix}`],
    memberCount: 1,
    membershipDigest: digest([{ id: `event-${suffix}`, sourceDigest: digest({ suffix }) }]),
    storyProjection: {
      label: `Canary ${suffix.toUpperCase()}`,
      summary: `A reviewed synthetic event records canary ${suffix.toUpperCase()}.`,
    },
  })).sort((left, right) => Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)));
  const core = {
    projectId,
    revision: 1,
    sourceDigest: digest(units.map((unit) => unit.members[0])),
    universeDigest: digest(units.flatMap((unit) => unit.members)),
    units,
  };
  return { ...core, manifestDigest: digest(core) };
}

function storySource(suffix, semantic, coverage, insights = [], {
  documentId = "doc-canary", language = "en",
} = {}) {
  const evidence = { documentId, eventId: `event-${suffix}` };
  const localized = language === "es" ? {
    phase: "Ensayo revisado",
    title: `Ensayo ${suffix.toUpperCase()}`,
    overview: `Una nota de laboratorio revisada ${suffix.toUpperCase()}.`,
    person: `Investigador ${suffix.toUpperCase()}`,
    role: "investigador",
    description: `El investigador documentó el ensayo ${suffix.toUpperCase()}.`,
    block: `Observación revisada ${suffix.toUpperCase()}.`,
  } : {
    phase: "Reviewed phase",
    title: `Canary ${suffix.toUpperCase()}`,
    overview: `A domain-neutral reviewed canary ${suffix.toUpperCase()}.`,
    person: `Canary participant ${suffix.toUpperCase()}`,
    role: "reviewed participant",
    description: `The participant contributed canary ${suffix.toUpperCase()}.`,
    block: `Reviewed canary text ${suffix.toUpperCase()}.`,
  };
  return {
    schema: "oxygen.story",
    key: `story-${suffix}`,
    phase: { id: `phase-${suffix}`, label: localized.phase },
    title: localized.title,
    overview: localized.overview,
    people: [{
      id: `person-${suffix}`,
      releaseLabel: localized.person,
      role: localized.role,
      description: localized.description,
      localIdentityState: "not_identified",
      evidence: [evidence],
    }],
    story: {
      blocks: [{ id: `block-${suffix}`, text: localized.block, evidence: [evidence] }],
    },
    insights,
    evidence: { primary: evidence, supporting: [] },
    coverage: {
      semanticManifest: { revision: semantic.revision, digest: semantic.manifestDigest },
      coverageManifest: { revision: coverage.revision, digest: coverage.coverageDigest },
      representedUnitIds: [`unit-${suffix}`],
      excludedUnits: [],
    },
  };
}

async function reviewedBoundary(root, projectMap, semantic, coverageRows = null, {
  documentId = "doc-canary", language = "en", narrativeBytes = 0,
} = {}) {
  const review = join(root, "review");
  const trajectory = join(review, "trajectories", documentId);
  await mkdir(trajectory, { recursive: true });
  await json(join(review, "project-map.json"), projectMap);
  const events = semantic.units.map((unit, index) => {
    const suffix = unit.id.slice("unit-".length);
    const actorType = index % 2 === 0 ? "user" : "assistant";
    return {
    event_id: `event-${suffix}`,
    trajectory_id: documentId,
    turn_id: `turn-${suffix}`,
    sequence: index + 1,
    event_type: "message",
    actor: { type: actorType },
    timestamp: null,
    payload: { role: actorType, text: `${language === "es"
      ? `observación segura revisada ${suffix}` : `safe reviewed canary ${suffix}`}${
      narrativeBytes ? ` ${"x".repeat(narrativeBytes)}` : ""}` },
    relations: [],
    };
  });
  await writeFile(join(trajectory, "events.jsonl"), `${events.map(JSON.stringify).join("\n")}\n`, "utf8");
  const sourceRows = events.map((event) => ({
    id: event.event_id,
    document_id: event.trajectory_id,
    sequence: event.sequence,
    event_type: event.event_type,
    actor_type: event.actor.type,
    timestamp: null,
    content: event.payload.text,
  }));
  const sourcePrivacy = join(root, "source-privacy.json");
  await json(sourcePrivacy, {
    redactions: [],
    job: {
      id: "source-privacy-current", status: "complete", stage: "complete", model: null,
      completed: 0, total: 0, rejected: 0,
      source_digest: await computeSourceDigest(sourceRows),
      started_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:01Z",
      completed_at: "2026-01-01T00:00:01Z",
    },
  });
  const requestedCoverage = coverageRows ?? semantic.units.map((unit) => ({
    unitId: unit.id, disposition: "represented", ownerId: `story-${unit.id.slice("unit-".length)}`,
  }));
  const coverageResult = await finalizeCoverageManifestAuthority({ rows: requestedCoverage }, semantic);
  assert.equal(coverageResult.ok, true);
  const coverage = join(root, "coverage.json");
  const authority = coverageResult.authority;
  await json(coverage, {
    revision: authority.revision,
    semanticManifestRevision: authority.semanticManifestRevision,
    semanticManifestDigest: authority.semanticManifestDigest,
    coverageDigest: authority.coverageDigest,
    rows: authority.rows.map((row) => row.disposition === "represented" ? {
      unitId: row.unitId, disposition: row.disposition, ownerId: row.ownerId,
    } : {
      unitId: row.unitId, disposition: row.disposition, exclusionReason: row.exclusionReason,
    }),
  });
  return { review, sourcePrivacy, coverage, coverageAuthority: authority };
}

function insight(suffix, documentId = "doc-canary", language = "en") {
  return {
    id: `insight-${suffix}`,
    title: language === "es" ? `Lección ${suffix.toUpperCase()}` : `Canary lesson ${suffix.toUpperCase()}`,
    background: language === "es" ? `Contexto revisado ${suffix.toUpperCase()}.` : `Reviewed background ${suffix.toUpperCase()}.`,
    quote: { storyBlockIds: [`block-${suffix}`] },
    directlyAcquiredExperience: language === "es"
      ? `Experiencia revisada ${suffix.toUpperCase()}.` : `Reviewed experience ${suffix.toUpperCase()}.`,
    principle: language === "es"
      ? `Principio acotado ${suffix.toUpperCase()}.` : `Bounded principle ${suffix.toUpperCase()}.`,
    evidence: [{ documentId, eventId: `event-${suffix}` }],
  };
}

async function privacyAuthority(root, suffixes = ["a", "b"], documentId = "doc-canary") {
  const redacted = join(root, "redacted");
  await mkdir(redacted);
  const text = "safe reviewed canary";
  const turns = suffixes.map((suffix) => ({
    event_id: `event-${suffix}`,
    document_id: documentId,
    item_id: `event-${suffix}`,
    role: "user",
    timestamp: null,
    text,
    redactions: [],
    redacted_text: text,
  }));
  await json(join(redacted, `${documentId}.json`), {
    trajectory: documentId,
    document_kind: "trajectory",
    turns,
    chars: text.length * turns.length,
  });
  const report = join(root, "privacy-report.json");
  await json(report, {
    categories: {}, total_applied: 0, rejected: 0, rejects: [], missing_worker_output: [],
    per_trajectory: [{ trajectory: documentId, turns: turns.length, applied: 0 }],
  });
  return { redacted, report };
}

async function createFlow({
  reverse = false,
  completedZero = false,
  suffixes = ["a", "b"],
  projectId = "Synthetic Canary",
  kinds = ["decision_episode"],
  documentId = "doc-canary",
  language = "en",
  narrativeBytes = 0,
  insightSuffixes = suffixes,
  reverseManifests = false,
  deferPreferenceRecord = false,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "story-public-transport-"));
  const semantic = semanticAuthority({ suffixes, projectId, kinds });
  const semanticPath = join(root, "semantic.json");
  const projectMapPath = join(root, "project-map.json");
  const transport = join(root, "transport");
  await json(semanticPath, semantic);
  await json(projectMapPath, {
    primary_project: semantic.projectId,
    summary: "Domain-neutral synthetic canary.",
    projects: [{ name: semantic.projectId, event_count: suffixes.length, reason: "One reviewed contribution universe." }],
    source_authority: { sourceDigest: semantic.sourceDigest, sourceCount: 1, contributionCount: suffixes.length },
    semantic_units: semantic.units.map((unit) => ({ id: unit.id, kind: unit.kind, members: unit.members })),
    semantic_manifest: semantic,
  });
  const projectMap = await readJson(projectMapPath);
  const boundary = await reviewedBoundary(root, projectMap, semantic, null, {
    documentId, language, narrativeBytes,
  });

  runOk(process.execPath, [prepare, "prepare", "story", projectMapPath,
    boundary.coverage, boundary.sourcePrivacy, boundary.review, transport]);
  if (reverseManifests) await reverseLaneManifest(transport, "story");
  const storyProposal = join(root, "story-proposal.json");
  const storyRecords = suffixes.map((suffix) => ({
    id: `event-${suffix}`,
    story: storySource(suffix, semantic, boundary.coverageAuthority, [], { documentId, language }),
  }));
  const submittedStoryRecords = reverse ? [...storyRecords].reverse() : storyRecords;
  await json(storyProposal, submittedStoryRecords);
  await recordLane(transport, "story", root, (input) => submittedStoryRecords.filter((record) => (
    input.unitIds.includes(record.story.key)
  )));
  const baseCandidates = join(root, "story-base-candidates.json");
  runOk(process.execPath, [prepare, "compose", "story", transport, baseCandidates]);

  runOk(process.execPath, [prepare, "prepare", "insight", baseCandidates, transport]);
  if (reverseManifests) await reverseLaneManifest(transport, "insight");
  const insightProposal = join(root, "insight-proposal.json");
  const insightRecords = suffixes.map((suffix) => ({
    storyKey: `story-${suffix}`,
    insights: completedZero || !insightSuffixes.includes(suffix) ? [] : [insight(suffix, documentId, language)],
  }));
  const submittedInsightRecords = reverse ? [...insightRecords].reverse() : insightRecords;
  await json(insightProposal, submittedInsightRecords);
  await recordLane(transport, "insight", root, (input) => submittedInsightRecords.filter((item) => (
    input.unitIds.includes(item.storyKey)
  )));
  const candidates = join(root, "story-candidates.json");
  runOk(process.execPath, [prepare, "compose", "final", transport, candidates]);

  const privacy = await privacyAuthority(root, suffixes, documentId);
  const preferenceContext = join(root, "preference-context.json");
  runOk("python", [preparePreferenceContext,
    "--story-candidates", candidates,
    "--redacted", privacy.redacted,
    "--privacy-report", privacy.report,
    "--output", preferenceContext,
  ]);

  // These siblings are ready after final Story composition and may be prepared in either order.
  runOk(process.execPath, [prepare, "prepare", "preference", candidates, preferenceContext, transport]);
  runOk(process.execPath, [prepare, "prepare", "story_privacy", candidates, transport]);
  if (reverseManifests) {
    await reverseLaneManifest(transport, "preference");
    await reverseLaneManifest(transport, "story_privacy");
  }

  const privacyProposal = join(root, "story-privacy-proposal.json");
  await json(privacyProposal, completedZero ? [] : [{
    id: "privacy-canary",
    reviewState: "needs_confirmation",
    title: "Review synthetic title",
    whyFlagged: "The reviewed canary requests a release decision.",
    uncertaintyReason: "Confirm the synthetic title.",
    releaseTargets: [`story-${suffixes[0]}::title`],
  }]);
  const privacyCandidates = await readJson(privacyProposal);
  await recordLane(transport, "story_privacy", root, (input) => privacyCandidates.filter((candidate) => (
    candidate.releaseTargets.every((target) => input.unitIds.includes(target))
  )));

  const preferenceCandidates = join(root, "preference-candidates.json");
  await json(preferenceCandidates, completedZero ? {
    probes: [], bulkDecisions: [], setAside: 0,
  } : {
    probes: [{
      id: "probe-canary",
      documentId,
      documentKind: "trajectory",
      eventIds: [`event-${suffixes[0]}`],
      timestamp: null,
      signal: "explicit_rule",
      score: 80,
      turns: 1,
      recap: "A reviewed canary records a bounded choice.",
      question: "Which bounded canary behavior should be retained?",
      options: [
        { id: "one", text: "Retain the reviewed canary boundary." },
        { id: "two", text: "Request confirmation before changing the boundary." },
      ],
      presentations: {},
      allowOther: true,
      allowSkip: true,
    }],
    bulkDecisions: [],
    setAside: 0,
  });
  const preferenceBundle = join(root, "preference-bundle.json");
  runOk("python", [validateProbes,
    "--context", preferenceContext,
    "--candidates", preferenceCandidates,
    "--workflow-run-id", "public-canary-run",
    "--source-revision", "4",
    "--output", preferenceBundle,
  ]);
  const preferenceManifest = await readJson(join(transport, "preference", "shards.json"));
  assert.equal(preferenceManifest.shards.length, 1);

  const preparationManifest = join(root, "story-preparation-manifest.json");
  if (!deferPreferenceRecord) {
    runOk(process.execPath, [record, transport, "preference", preferenceManifest.shards[0].id, preferenceBundle]);
    runOk(process.execPath, [finalize,
      projectMapPath, candidates, transport, preferenceBundle, preparationManifest,
      "--workflow-run-id", "public-canary-run", "--source-revision", "4",
    ]);
  }
  return {
    root, semanticPath, projectMapPath, transport, candidates,
    preferenceContext, preferenceCandidates, preferenceBundle, preferenceManifest,
    preparationManifest,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function prepareStoryOnly({
  suffixes = ["a", "b"], coverageRows = null, narrativeBytes = 0,
  reverseTransportInputs = false,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "story-owner-batch-"));
  const semantic = semanticAuthority({ suffixes });
  const projectMap = {
    primary_project: semantic.projectId,
    summary: "Owner-atomic canary.",
    projects: [{ name: semantic.projectId, event_count: suffixes.length, reason: "Reviewed boundary." }],
    source_authority: {
      sourceDigest: semantic.sourceDigest, sourceCount: 1, contributionCount: suffixes.length,
    },
    semantic_units: semantic.units.map((unit) => ({ id: unit.id, kind: unit.kind, members: unit.members })),
    semantic_manifest: semantic,
  };
  const projectMapPath = join(root, "project-map.json");
  await json(projectMapPath, projectMap);
  const boundary = await reviewedBoundary(root, projectMap, semantic, coverageRows, { narrativeBytes });
  if (reverseTransportInputs) {
    const reversedMap = structuredClone(projectMap);
    reversedMap.semantic_manifest.units.reverse();
    reversedMap.semantic_units.reverse();
    await json(projectMapPath, reversedMap);
    await json(join(boundary.review, "project-map.json"), reversedMap);
    const coverage = await readJson(boundary.coverage);
    coverage.rows.reverse();
    await json(boundary.coverage, coverage);
    const eventsPath = join(boundary.review, "trajectories", "doc-canary", "events.jsonl");
    const lines = (await readFile(eventsPath, "utf8")).trimEnd().split("\n").reverse();
    await writeFile(eventsPath, `${lines.join("\n")}\n`, "utf8");
  }
  const transport = join(root, "transport");
  const prepared = run(process.execPath, [prepare, "prepare", "story", projectMapPath,
    boundary.coverage, boundary.sourcePrivacy, boundary.review, transport]);
  return {
    root, semantic, projectMapPath, boundary, transport, prepared,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("public commands execute the nonempty four-lane dependency chain deterministically", async () => {
  const first = await createFlow();
  const reordered = await createFlow({ reverse: true });
  try {
    assert.equal(await readFile(first.candidates, "utf8"), await readFile(reordered.candidates, "utf8"));
    assert.equal(await readFile(first.preferenceBundle, "utf8"), await readFile(reordered.preferenceBundle, "utf8"));
    assert.equal(await readFile(first.preparationManifest, "utf8"), await readFile(reordered.preparationManifest, "utf8"));
    const manifest = await readJson(first.preparationManifest);
    assert.equal(manifest.schema, "oxygen.story-preparation");
    assert.deepEqual(manifest.receipts.map((receipt) => receipt.lane), [
      "story", "insight", "story_privacy", "preference",
    ]);
    assert.ok(manifest.receipts.every((receipt) => receipt.outputCount > 0));
    assert.ok((await readJson(first.candidates)).every((row) => parseStorySource(row.summary)));
    const compactStoryManifest = await readJson(join(first.transport, "story", "shards.json"));
    assert.equal(compactStoryManifest.shards.length, 1);
    assert.equal(compactStoryManifest.shards[0].unitIds.length, 2);
    const finalBytes = [
      await readFile(first.candidates, "utf8"),
      await readFile(first.preferenceBundle, "utf8"),
      await readFile(first.preparationManifest, "utf8"),
    ].join("\n");
    assert.doesNotMatch(finalBytes, /provider|model|prompt|token|publication_approved|safe reviewed canary/u);

    const parityRoot = join(first.root, "bare-transport");
    const boundary = {
      coverage: join(first.root, "coverage.json"),
      sourcePrivacy: join(first.root, "source-privacy.json"),
      review: join(first.root, "review"),
    };
    runOk(process.execPath, [prepare, "prepare", "story", first.semanticPath,
      boundary.coverage, boundary.sourcePrivacy, boundary.review, parityRoot]);
    assert.equal(
      await readFile(join(first.transport, "story", "shards.json"), "utf8"),
      await readFile(join(parityRoot, "story", "shards.json"), "utf8"),
    );
    assert.equal(
      await readFile(join(first.transport, "story", "inputs", "story-0001.json"), "utf8"),
      await readFile(join(parityRoot, "story", "inputs", "story-0001.json"), "utf8"),
    );
  } finally {
    await first.cleanup();
    await reordered.cleanup();
  }
});

test("finalized Coverage owner IDs form indivisible self-contained Story bundles", async () => {
  const suffixes = ["a", "b", "c", "d", "e"];
  const value = await prepareStoryOnly({
    suffixes,
    coverageRows: suffixes.map((suffix) => ({
      unitId: `unit-${suffix}`, disposition: "represented", ownerId: "story-complete-owner",
    })),
  });
  try {
    assert.equal(value.prepared.status, 0, value.prepared.stderr);
    const manifest = await readJson(join(value.transport, "story", "shards.json"));
    assert.equal(manifest.shards.length, 1);
    assert.deepEqual(manifest.unitIds, ["story-complete-owner"]);
    const input = await readJson(join(value.transport, ...manifest.shards[0].inputPath.split("/")));
    assert.deepEqual(input.unitIds, ["story-complete-owner"]);
    assert.equal(input.payload.ownerBundles.length, 1);
    const bundle = input.payload.ownerBundles[0];
    assert.equal(bundle.ownerId, "story-complete-owner");
    assert.deepEqual(bundle.semanticUnits.map((unit) => unit.id), suffixes.map((suffix) => `unit-${suffix}`));
    assert.deepEqual(bundle.reviewedNarrative.map((row) => row.id), suffixes.map((suffix) => `event-${suffix}`));
    assert.ok(bundle.reviewedNarrative.every((row) => (
      row.actorEquivalence.startsWith("actor-") && !Object.hasOwn(row, "actorId")
    )));
    const workerBytes = await readFile(join(value.transport, ...manifest.shards[0].inputPath.split("/")), "utf8");
    assert.doesNotMatch(workerBytes, /sourcePrivacy|redactions|provider|model|PRIVATE-SENTINEL/u);
  } finally {
    await value.cleanup();
  }
});

test("reordered equivalent semantic, Coverage, and reviewed inputs produce byte-identical Story authority", async () => {
  const first = await prepareStoryOnly({ suffixes: ["a", "b", "c"] });
  const reordered = await prepareStoryOnly({
    suffixes: ["a", "b", "c"], reverseTransportInputs: true,
  });
  try {
    assert.equal(first.prepared.status, 0, first.prepared.stderr);
    assert.equal(reordered.prepared.status, 0, reordered.prepared.stderr);
    const firstManifest = await readJson(join(first.transport, "story", "shards.json"));
    const secondManifest = await readJson(join(reordered.transport, "story", "shards.json"));
    assert.deepEqual(secondManifest, firstManifest);
    assert.deepEqual(
      await readFile(join(reordered.transport, "story", "validation-authority.json")),
      await readFile(join(first.transport, "story", "validation-authority.json")),
    );
    for (const shard of firstManifest.shards) {
      assert.deepEqual(
        await readFile(join(reordered.transport, ...shard.inputPath.split("/"))),
        await readFile(join(first.transport, ...shard.inputPath.split("/"))),
      );
    }
  } finally {
    await first.cleanup();
    await reordered.cleanup();
  }
});

test("zero represented owners fail before Story lane installation without inventing a carrier", async () => {
  const value = await prepareStoryOnly({
    coverageRows: ["a", "b"].map((suffix) => ({
      unitId: `unit-${suffix}`, disposition: "excluded", exclusionReason: "outside_story_scope",
    })),
  });
  try {
    assert.notEqual(value.prepared.status, 0);
    assert.match(value.prepared.stderr, /^STORY_ZERO_REPRESENTED_OWNER_UNSUPPORTED\r?\n$/u);
    assert.equal(existsSync(join(value.transport, "story")), false);
  } finally {
    await value.cleanup();
  }
});

test("one oversized owner bundle fails before Story lane installation instead of splitting", async () => {
  const root = await mkdtemp(join(tmpdir(), "story-oversized-owner-"));
  try {
    const suffixes = ["a", "b", "c", "d", "e", "f", "g"];
    const initial = semanticAuthority({ suffixes });
    const units = initial.units.map((unit) => ({
      ...unit,
      storyProjection: {
        label: unit.storyProjection.label,
        summary: "y".repeat(300_000),
      },
    }));
    const core = {
      projectId: initial.projectId,
      revision: initial.revision,
      sourceDigest: initial.sourceDigest,
      universeDigest: initial.universeDigest,
      units,
    };
    const semantic = { ...core, manifestDigest: digest(core) };
    const projectMap = {
      primary_project: semantic.projectId,
      summary: "Oversized owner canary.",
      projects: [{ name: semantic.projectId, event_count: suffixes.length, reason: "Reviewed boundary." }],
      source_authority: { sourceDigest: semantic.sourceDigest, sourceCount: 1, contributionCount: suffixes.length },
      semantic_units: units.map((unit) => ({ id: unit.id, kind: unit.kind, members: unit.members })),
      semantic_manifest: semantic,
    };
    const projectMapPath = join(root, "project-map.json");
    await json(projectMapPath, projectMap);
    const boundary = await reviewedBoundary(root, projectMap, semantic, suffixes.map((suffix) => ({
      unitId: `unit-${suffix}`, disposition: "represented", ownerId: "story-oversized-owner",
    })), { narrativeBytes: 3_350_000 });
    const transport = join(root, "transport");
    const result = run(process.execPath, [prepare, "prepare", "story", projectMapPath,
      boundary.coverage, boundary.sourcePrivacy, boundary.review, transport]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /^STORY_OWNER_BUNDLE_TOO_LARGE\r?\n$/u);
    assert.equal(existsSync(join(transport, "story")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("laboratory notes cross real Story and Insight shard waves without domain special cases", async () => {
  const options = {
    suffixes: ["uno", "dos", "tres", "cuatro", "cinco"],
    projectId: "Cuaderno de Laboratorio",
    kinds: ["experiment_observation", "instrument_calibration", "hypothesis_revision"],
    documentId: "notas-laboratorio",
    language: "es",
    narrativeBytes: 300_000,
    insightSuffixes: ["uno", "tres"],
  };
  const first = await createFlow(options);
  const reordered = await createFlow({ ...options, reverse: true, reverseManifests: true });
  try {
    const storyManifest = await readJson(join(first.transport, "story", "shards.json"));
    const insightManifest = await readJson(join(first.transport, "insight", "shards.json"));
    assert.ok(storyManifest.shards.length >= 2);
    assert.ok(insightManifest.shards.length >= 2);
    assert.equal(await readFile(first.candidates, "utf8"), await readFile(reordered.candidates, "utf8"));
    assert.equal(await readFile(first.preparationManifest, "utf8"),
      await readFile(reordered.preparationManifest, "utf8"));
    const candidates = await readJson(first.candidates);
    assert.equal(candidates.length, 5);
    assert.equal(candidates.reduce((total, row) => (
      total + parseStorySource(row.summary).insights.length
    ), 0), 2);
    assert.match(candidates[0].summary, /laboratorio|Ensayo|Observación/u);
    console.log("THIRD_DOMAIN_CANARY", JSON.stringify({
      domain: "laboratory-notes", language: "es", records: options.suffixes.length,
      semanticKinds: new Set(options.kinds).size, chapters: candidates.length, insights: 2,
      storyShards: storyManifest.shards.length, insightShards: insightManifest.shards.length,
      reorderedCandidatesByteIdentical: true, reorderedAuthorityByteIdentical: true,
    }));
  } finally {
    await first.cleanup();
    await reordered.cleanup();
  }
});

test("multi-owner multi-shard recording accepts one cross-shard Phase and injects exclusions once", async () => {
  const value = await prepareStoryOnly({
    suffixes: ["a", "b", "c"],
    narrativeBytes: 600_000,
    coverageRows: [
      { unitId: "unit-a", disposition: "represented", ownerId: "story-a" },
      { unitId: "unit-b", disposition: "represented", ownerId: "story-b" },
      { unitId: "unit-c", disposition: "excluded", exclusionReason: "outside_story_scope" },
    ],
  });
  try {
    assert.equal(value.prepared.status, 0, value.prepared.stderr);
    const stories = ["a", "b"].map((suffix) => ({
      id: `event-${suffix}`,
      story: {
        ...storySource(suffix, value.semantic, value.boundary.coverageAuthority),
        phase: { id: "phase-shared", label: "Shared build" },
      },
    }));
    const batch = await storyBatchFiles(value.transport, value.root, stories, "cross-shard");
    assert.ok(batch.manifest.shards.length >= 2);
    assert.ok(batch.manifest.shards.every((shard) => shard.unitIds.length === 1));
    const workerBytes = (await Promise.all(batch.manifest.shards.map((shard) => (
      readFile(join(value.transport, ...shard.inputPath.split("/")), "utf8")
    )))).join("\n");
    assert.doesNotMatch(workerBytes, /event-c|safe reviewed canary c/u);
    runOk(process.execPath, [record, value.transport, "story", batch.proposalDirectory,
      batch.phasePath, "--correction-attempt-count", "0"]);
    const recordsRoot = join(value.transport, "story", "records");
    assert.equal((await Promise.all(batch.manifest.shards.map((shard) => (
      readJson(join(recordsRoot, shard.id, "receipt.json"))
    )))).length, batch.manifest.shards.length);
    const baseCandidates = join(value.root, "base.json");
    runOk(process.execPath, [prepare, "compose", "story", value.transport, baseCandidates]);
    const chapters = (await readJson(baseCandidates)).map((row) => parseStorySource(row.summary));
    assert.ok(chapters.every((chapter) => chapter.phase.id === "phase-shared"));
    assert.deepEqual(chapters[0].coverage.excludedUnits, [{
      unitId: "unit-c", reason: "outside_story_scope",
    }]);
    assert.ok(chapters.slice(1).every((chapter) => chapter.coverage.excludedUnits.length === 0));
    assert.ok(chapters.every((chapter) => !chapter.story.blocks.some((block) => /canary c/u.test(block.text))));
  } finally {
    await value.cleanup();
  }
});

test("real multi-shard manifests reject missing, duplicate, overlap, and foreign assignments", async () => {
  const flow = await createFlow({
    suffixes: ["a", "b", "c", "d", "e"], narrativeBytes: 300_000,
  });
  try {
    const mutations = {
      missing: (manifest) => { manifest.shards.pop(); },
      duplicate: (manifest) => { manifest.shards.push({ ...manifest.shards[0] }); },
      overlap: (manifest) => { manifest.shards[1].unitIds.push(manifest.shards[0].unitIds[0]); },
      foreign: (manifest) => { manifest.shards[1].unitIds[0] = "unit-foreign"; },
    };
    for (const [name, mutate] of Object.entries(mutations)) {
      const variant = join(flow.root, `transport-${name}`);
      await cp(flow.transport, variant, { recursive: true });
      const manifestPath = join(variant, "story", "shards.json");
      const manifest = await readJson(manifestPath);
      assert.ok(manifest.shards.length >= 2);
      mutate(manifest);
      await json(manifestPath, manifest);
      const destination = join(flow.root, `terminal-${name}.json`);
      await writeFile(destination, "sentinel\n", "utf8");
      const rejected = run(process.execPath, [finalize,
        flow.projectMapPath, flow.candidates, variant, flow.preferenceBundle, destination,
        "--workflow-run-id", "public-canary-run", "--source-revision", "4",
      ]);
      assert.notEqual(rejected.status, 0, name);
      assert.match(rejected.stderr, /^(SHARD_INVALID|SHARD_MANIFEST_UNIVERSE_INVALID)\r?\n$/u);
      assert.equal(await readFile(destination, "utf8"), "sentinel\n");
    }
  } finally {
    await flow.cleanup();
  }
});

test("public commands bind completed-zero Insight, Story Privacy, and Preference results", async () => {
  const flow = await createFlow({ completedZero: true });
  try {
    const manifest = await readJson(flow.preparationManifest);
    for (const lane of ["insight", "story_privacy", "preference"]) {
      const receipt = manifest.receipts.find((item) => item.lane === lane);
      assert.equal(receipt.outputCount, 0);
      assert.equal(receipt.outputDigest, "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
    }
  } finally {
    await flow.cleanup();
  }
});

test("Preference recorder rejects zero before receipt, accepts corrected authority, and stays immutable", async () => {
  const flow = await createFlow({ deferPreferenceRecord: true });
  try {
    const shard = flow.preferenceManifest.shards[0];
    const inputPath = join(flow.transport, ...shard.inputPath.split("/"));
    const recordRoot = join(flow.transport, "preference", "records", shard.id);
    const outputPath = join(recordRoot, "output.json");
    const receiptPath = join(recordRoot, "receipt.json");
    const inputBefore = await readFile(inputPath);
    const validBundle = await readJson(flow.preferenceBundle);
    await json(flow.preferenceBundle, { ...validBundle, sourceRevision: 0 });

    const rejected = run(process.execPath, [record, flow.transport, "preference", shard.id,
      flow.preferenceBundle]);
    assert.notEqual(rejected.status, 0);
    assert.equal(rejected.stdout, "");
    assert.match(rejected.stderr, /^PREFERENCE_BUNDLE_INVALID\r?\n$/u);
    assert.equal(existsSync(outputPath), false);
    assert.equal(existsSync(receiptPath), false);
    assert.deepEqual(await readFile(inputPath), inputBefore);

    runOk("python", [validateProbes,
      "--context", flow.preferenceContext,
      "--candidates", flow.preferenceCandidates,
      "--workflow-run-id", "public-canary-run",
      "--source-revision", "4",
      "--output", flow.preferenceBundle,
    ]);
    runOk(process.execPath, [record, flow.transport, "preference", shard.id,
      flow.preferenceBundle]);
    assert.deepEqual(await readFile(inputPath), inputBefore);
    const outputBefore = await readFile(outputPath);
    const receiptBefore = await readFile(receiptPath);

    const differingCandidates = await readJson(flow.preferenceCandidates);
    differingCandidates.probes[0].question = "Which reviewed boundary should the agent retain?";
    await json(flow.preferenceCandidates, differingCandidates);
    runOk("python", [validateProbes,
      "--context", flow.preferenceContext,
      "--candidates", flow.preferenceCandidates,
      "--workflow-run-id", "public-canary-run",
      "--source-revision", "4",
      "--output", flow.preferenceBundle,
    ]);
    const immutable = run(process.execPath, [record, flow.transport, "preference", shard.id,
      flow.preferenceBundle]);
    assert.notEqual(immutable.status, 0);
    assert.match(immutable.stderr, /^AUTHORITY_IMMUTABLE\r?\n$/u);
    assert.deepEqual(await readFile(outputPath), outputBefore);
    assert.deepEqual(await readFile(receiptPath), receiptBefore);
    assert.deepEqual(await readFile(inputPath), inputBefore);
  } finally {
    await flow.cleanup();
  }
});

test("Story batch recorder permits pre-receipt correction and makes the complete authority immutable", async () => {
  const root = await mkdtemp(join(tmpdir(), "story-recorder-atomic-"));
  try {
    const semantic = semanticAuthority();
    const semanticPath = join(root, "semantic.json");
    const transport = join(root, "transport");
    await json(semanticPath, semantic);
    const projectMapPath = join(root, "project-map.json");
    await json(projectMapPath, {
      primary_project: semantic.projectId, summary: "Synthetic.",
      projects: [{ name: semantic.projectId, event_count: 2, reason: "One repo-scoped projected contribution universe." }],
      source_authority: { sourceDigest: semantic.sourceDigest, sourceCount: 1, contributionCount: 2 },
      semantic_units: semantic.units.map((unit) => ({ id: unit.id, kind: unit.kind, members: unit.members })),
      semantic_manifest: semantic,
    });
    const boundary = await reviewedBoundary(root, await readJson(projectMapPath), semantic);
    runOk(process.execPath, [prepare, "prepare", "story", semanticPath,
      boundary.coverage, boundary.sourcePrivacy, boundary.review, transport]);
    const validRecords = ["a", "b"].map((suffix) => ({
      id: `event-${suffix}`,
      story: storySource(suffix, semantic, boundary.coverageAuthority),
    }));
    const batch = await storyBatchFiles(transport, root, validRecords, "correction");
    const firstProposalPath = join(batch.proposalDirectory, `${batch.manifest.shards[0].id}.json`);
    const invalidProposal = await readJson(firstProposalPath);
    invalidProposal[0].ownerId = "foreign";
    await json(firstProposalPath, invalidProposal);
    const invalid = run(process.execPath, [record, transport, "story",
      batch.proposalDirectory, batch.phasePath, "--correction-attempt-count", "0"]);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /^STORY_PROPOSAL_OWNER_INVALID\r?\n$/u);
    assert.equal(existsSync(join(transport, "story", "records")), false);

    await json(firstProposalPath, batch.manifest.shards[0].unitIds.map((ownerId) => (
      phaseFreeProposal(validRecords.find((candidate) => candidate.story.key === ownerId))
    )));
    runOk(process.execPath, [record, transport, "story", batch.proposalDirectory, batch.phasePath,
      "--correction-attempt-count", "1"]);
    const recordRoot = join(transport, "story", "records", batch.manifest.shards[0].id);
    const outputPath = join(recordRoot, "output.json");
    const receiptPath = join(recordRoot, "receipt.json");
    const beforeOutput = await readFile(outputPath);
    const beforeReceipt = await readFile(receiptPath);

    const differing = await readJson(firstProposalPath);
    differing[0].chapter.title = "Different but structurally valid";
    await json(firstProposalPath, differing);
    const immutable = run(process.execPath, [record, transport, "story",
      batch.proposalDirectory, batch.phasePath, "--correction-attempt-count", "1"]);
    assert.notEqual(immutable.status, 0);
    assert.match(immutable.stderr, /^AUTHORITY_IMMUTABLE\r?\n$/u);
    assert.deepEqual(await readFile(outputPath), beforeOutput);
    assert.deepEqual(await readFile(receiptPath), beforeReceipt);

    await rm(receiptPath);
    const partial = run(process.execPath, [record, transport, "story",
      batch.proposalDirectory, batch.phasePath, "--correction-attempt-count", "1"]);
    assert.notEqual(partial.status, 0);
    assert.match(partial.stderr, /^PARTIAL_BATCH_REJECTED\r?\n$/u);
    assert.deepEqual(await readFile(outputPath), beforeOutput);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Story batch rejects incomplete or parent-authored proposals and shares one correction budget with Phase", async () => {
  const value = await prepareStoryOnly({ suffixes: ["a", "b", "c"] });
  try {
    assert.equal(value.prepared.status, 0, value.prepared.stderr);
    const records = ["a", "b", "c"].map((suffix) => ({
      id: `event-${suffix}`,
      story: storySource(suffix, value.semantic, value.boundary.coverageAuthority),
    }));
    const batch = await storyBatchFiles(value.transport, value.root, records, "rejections");
    const shard = batch.manifest.shards[0];
    const proposalPath = join(batch.proposalDirectory, `${shard.id}.json`);
    const validProposalBytes = await readFile(proposalPath);
    const validPhaseBytes = await readFile(batch.phasePath);
    const invoke = (count = 0) => run(process.execPath, [record, value.transport, "story",
      batch.proposalDirectory, batch.phasePath, "--correction-attempt-count", String(count)]);
    const assertNoAuthority = () => assert.equal(existsSync(join(value.transport, "story", "records")), false);

    const exhausted = invoke(3);
    assert.notEqual(exhausted.status, 0);
    assert.match(exhausted.stderr, /^STORY_CORRECTION_EXHAUSTED\r?\n$/u);
    assertNoAuthority();

    for (const [field, forbiddenValue] of Object.entries({
      phase: { id: "forbidden", label: "Forbidden phase" },
      schema: "oxygen.story",
      key: "story-a",
      coverage: {},
      exclusions: [],
      receipt: {},
      authority: {},
    })) {
      const parentAuthored = JSON.parse(validProposalBytes);
      parentAuthored[0].chapter[field] = forbiddenValue;
      await json(proposalPath, parentAuthored);
      const forbidden = invoke(0);
      assert.notEqual(forbidden.status, 0, field);
      assert.match(forbidden.stderr, /^STORY_PROPOSAL_PARENT_FIELD_FORBIDDEN\r?\n$/u, field);
      assertNoAuthority();
    }

    const movedEvidence = JSON.parse(validProposalBytes);
    movedEvidence[0].chapter.evidence.primary = { documentId: "doc-canary", eventId: "event-b" };
    await json(proposalPath, movedEvidence);
    const foreignEvidence = invoke(0);
    assert.notEqual(foreignEvidence.status, 0);
    assert.match(foreignEvidence.stderr, /^STORY_PROPOSAL_EVIDENCE_INVALID\r?\n$/u);
    assertNoAuthority();

    const duplicateOwner = JSON.parse(validProposalBytes);
    duplicateOwner[1].ownerId = duplicateOwner[0].ownerId;
    await json(proposalPath, duplicateOwner);
    const duplicate = invoke(0);
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /^STORY_PROPOSAL_OWNER_INVALID\r?\n$/u);
    assertNoAuthority();

    await writeFile(proposalPath, validProposalBytes);
    await writeFile(join(batch.proposalDirectory, "extra.json"), "[]", "utf8");
    const extra = invoke(0);
    assert.notEqual(extra.status, 0);
    assert.match(extra.stderr, /^STORY_PROPOSAL_SET_INVALID\r?\n$/u);
    assertNoAuthority();
    await rm(join(batch.proposalDirectory, "extra.json"));

    await rm(proposalPath);
    const missing = invoke(0);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /^STORY_PROPOSAL_SET_INVALID\r?\n$/u);
    assertNoAuthority();

    await writeFile(proposalPath, " ".repeat(25_000_001), "utf8");
    const oversized = invoke(0);
    assert.notEqual(oversized.status, 0);
    assert.match(oversized.stderr, /^PROPOSAL_TOO_LARGE\r?\n$/u);
    assertNoAuthority();

    await writeFile(proposalPath, "{", "utf8");
    const malformed = invoke(0);
    assert.notEqual(malformed.status, 0);
    assert.match(malformed.stderr, /^PROPOSAL_JSON_INVALID\r?\n$/u);
    assertNoAuthority();

    await writeFile(proposalPath, validProposalBytes);
    const validPhases = JSON.parse(validPhaseBytes);
    const phaseCases = [
      ["missing", validPhases.slice(0, -1), /^STORY_PHASE_ASSIGNMENT_INVALID\r?\n$/u],
      ["duplicate", [validPhases[0], validPhases[0], validPhases[2]], /^STORY_PHASE_ASSIGNMENT_INVALID\r?\n$/u],
      ["foreign", [{ ...validPhases[0], ownerId: "foreign" }, validPhases[1], validPhases[2]], /^STORY_PHASE_ASSIGNMENT_INVALID\r?\n$/u],
      ["invalid", validPhases.map((item) => ({ ...item, phase: { id: "phase-other", label: "Other" } })), /^STORY_PHASE_INVALID\r?\n$/u],
      ["inconsistent", validPhases.map((item, index) => ({
        ...item, phase: { id: "phase-one", label: index === 1 ? "Second phase" : "First phase" },
      })), /^STORY_PHASE_INVALID\r?\n$/u],
    ];
    for (const [name, phases, error] of phaseCases) {
      await json(batch.phasePath, phases);
      const rejected = invoke(0);
      assert.notEqual(rejected.status, 0, name);
      assert.match(rejected.stderr, error, name);
      assertNoAuthority();
    }
    const invalidPhases = [
      { ownerId: "story-a", phase: { id: "phase-one", label: "First phase" } },
      { ownerId: "story-b", phase: { id: "phase-two", label: "Second phase" } },
      { ownerId: "story-c", phase: { id: "phase-one", label: "First phase" } },
    ];
    await json(batch.phasePath, invalidPhases);
    const phaseRejected = invoke(0);
    assert.notEqual(phaseRejected.status, 0);
    assert.match(phaseRejected.stderr, /^STORY_PHASE_ORDER_INVALID\r?\n$/u);
    assertNoAuthority();
    const phaseRejectedAgain = invoke(1);
    assert.notEqual(phaseRejectedAgain.status, 0);
    assert.match(phaseRejectedAgain.stderr, /^STORY_PHASE_ORDER_INVALID\r?\n$/u);
    assertNoAuthority();
    assert.deepEqual(await readFile(proposalPath), validProposalBytes);

    await writeFile(batch.phasePath, validPhaseBytes);
    runOk(process.execPath, [record, value.transport, "story", batch.proposalDirectory,
      batch.phasePath, "--correction-attempt-count", "2"]);
    assert.deepEqual(await readFile(proposalPath), validProposalBytes);
    assert.equal(existsSync(join(value.transport, "story", "records")), true);
  } finally {
    await value.cleanup();
  }
});

test("injected filesystem failure leaves the complete Story records directory absent", async () => {
  const value = await prepareStoryOnly({
    suffixes: ["a", "b", "c"], narrativeBytes: 600_000,
  });
  try {
    assert.equal(value.prepared.status, 0, value.prepared.stderr);
    const records = ["a", "b", "c"].map((suffix) => ({
      id: `event-${suffix}`,
      story: storySource(suffix, value.semantic, value.boundary.coverageAuthority),
    }));
    const batch = await storyBatchFiles(value.transport, value.root, records, "filesystem-failure");
    assert.ok(batch.manifest.shards.length >= 2);
    const hook = join(value.root, "inject-story-write-failure.mjs");
    await writeFile(hook, `import fs from "node:fs";\nimport { syncBuiltinESMExports } from "node:module";\nconst original = fs.promises.open.bind(fs.promises);\nlet outputs = 0;\nfs.promises.open = async (path, ...args) => {\n  if (String(path).includes(".records.") && String(path).endsWith("output.json")) {\n    outputs += 1;\n    if (outputs === 2) throw new Error("injected");\n  }\n  return original(path, ...args);\n};\nsyncBuiltinESMExports();\n`, "utf8");
    const failed = run(process.execPath, ["--import", pathToFileURL(hook).href, record, value.transport, "story",
      batch.proposalDirectory, batch.phasePath, "--correction-attempt-count", "0"]);
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /^STORY_PREPARATION_RECORD_FAILED\r?\n$/u);
    assert.equal(existsSync(join(value.transport, "story", "records")), false);
    assert.ok((await readdir(join(value.transport, "story"))).every((name) => !name.startsWith(".records.")));

    runOk(process.execPath, [record, value.transport, "story", batch.proposalDirectory,
      batch.phasePath, "--correction-attempt-count", "1"]);
    assert.equal(existsSync(join(value.transport, "story", "records")), true);
  } finally {
    await value.cleanup();
  }
});

function combinedStory(semantic, coverage, collapsed) {
  const references = ["a", "b"].map((suffix) => ({
    documentId: "doc-canary", eventId: `event-${suffix}`,
  }));
  const person = (suffix, evidence) => ({
    id: `person-${suffix}`,
    releaseLabel: `Canary participant ${suffix.toUpperCase()}`,
    role: "reviewed participant",
    description: `The participant contributed canary ${suffix.toUpperCase()}.`,
    localIdentityState: "not_identified",
    evidence,
  });
  return {
    schema: "oxygen.story",
    key: "story-combined",
    phase: { id: "phase-combined", label: "Reviewed phase" },
    title: "Combined canary",
    overview: "Two reviewed actor signatures remain distinct.",
    people: collapsed
      ? [person("combined", references)]
      : [person("a", [references[0]]), person("b", [references[1]])],
    story: {
      blocks: [{ id: "block-combined", text: "Both reviewed contributions shaped the canary.", evidence: references }],
    },
    insights: [],
    evidence: { primary: references[0], supporting: [references[1]] },
    coverage: {
      semanticManifest: { revision: semantic.revision, digest: semantic.manifestDigest },
      coverageManifest: { revision: coverage.revision, digest: coverage.coverageDigest },
      representedUnitIds: ["unit-a", "unit-b"],
      excludedUnits: [],
    },
  };
}

test("shared Story validation rejects collapsed People before receipt and accepts only corrected proposal", async () => {
  const root = await mkdtemp(join(tmpdir(), "story-people-authority-"));
  try {
    const semantic = semanticAuthority();
    const semanticPath = join(root, "semantic.json");
    const projectMapPath = join(root, "project-map.json");
    const transport = join(root, "transport");
    await json(semanticPath, semantic);
    await json(projectMapPath, {
      primary_project: semantic.projectId, summary: "Synthetic.",
      projects: [{ name: semantic.projectId, event_count: 2, reason: "One repo-scoped projected contribution universe." }],
      source_authority: { sourceDigest: semantic.sourceDigest, sourceCount: 1, contributionCount: 2 },
      semantic_units: semantic.units.map((unit) => ({ id: unit.id, kind: unit.kind, members: unit.members })),
      semantic_manifest: semantic,
    });
    const boundary = await reviewedBoundary(root, await readJson(projectMapPath), semantic, [
      { unitId: "unit-a", disposition: "represented", ownerId: "story-combined" },
      { unitId: "unit-b", disposition: "represented", ownerId: "story-combined" },
    ]);
    runOk(process.execPath, [prepare, "prepare", "story", semanticPath,
      boundary.coverage, boundary.sourcePrivacy, boundary.review, transport]);
    const inputBefore = await readFile(join(transport, "story", "inputs", "story-0001.json"));
    const invalidRecord = {
      id: "event-a", story: combinedStory(semantic, boundary.coverageAuthority, true),
    };
    const correctedRecord = {
      id: "event-a", story: combinedStory(semantic, boundary.coverageAuthority, false),
    };
    const batch = await storyBatchFiles(transport, root, [correctedRecord], "people");
    const proposal = join(batch.proposalDirectory, "story-0001.json");
    await json(proposal, [phaseFreeProposal(invalidRecord)]);
    const rejected = run(process.execPath, [record, transport, "story",
      batch.proposalDirectory, batch.phasePath, "--correction-attempt-count", "0"]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /^STORY_PEOPLE_INVALID\r?\n$/u);
    assert.equal(existsSync(join(transport, "story", "records")), false);

    await json(proposal, [phaseFreeProposal(correctedRecord)]);
    runOk(process.execPath, [record, transport, "story", batch.proposalDirectory, batch.phasePath,
      "--correction-attempt-count", "1"]);
    assert.deepEqual(
      await readFile(join(transport, "story", "inputs", "story-0001.json")), inputBefore,
    );
    const recordRoot = join(transport, "story", "records", "story-0001");
    const outputBefore = await readFile(join(recordRoot, "output.json"));
    const receiptBefore = await readFile(join(recordRoot, "receipt.json"));
    const changed = combinedStory(semantic, boundary.coverageAuthority, false);
    changed.title = "A different valid title";
    await json(proposal, [phaseFreeProposal({ id: "event-a", story: changed })]);
    const immutable = run(process.execPath, [record, transport, "story",
      batch.proposalDirectory, batch.phasePath, "--correction-attempt-count", "1"]);
    assert.notEqual(immutable.status, 0);
    assert.match(immutable.stderr, /^AUTHORITY_IMMUTABLE\r?\n$/u);
    assert.deepEqual(await readFile(join(recordRoot, "output.json")), outputBefore);
    assert.deepEqual(await readFile(join(recordRoot, "receipt.json")), receiptBefore);

    const authorityBytes = await readFile(join(transport, "story", "validation-authority.json"), "utf8");
    const inputBytes = inputBefore.toString("utf8");
    assert.doesNotMatch(authorityBytes, /safe reviewed canary/u);
    assert.match(inputBytes, /safe reviewed canary a/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Insight grounding fails before receipt, permits proposal-only correction, then becomes immutable", async () => {
  const root = await mkdtemp(join(tmpdir(), "story-insight-validation-"));
  try {
    const semantic = semanticAuthority();
    const projectMap = {
      primary_project: semantic.projectId, summary: "Synthetic.",
      projects: [{ name: semantic.projectId, event_count: 2, reason: "Reviewed boundary." }],
      source_authority: { sourceDigest: semantic.sourceDigest, sourceCount: 1, contributionCount: 2 },
      semantic_units: semantic.units.map((unit) => ({ id: unit.id, kind: unit.kind, members: unit.members })),
      semantic_manifest: semantic,
    };
    const projectMapPath = join(root, "project-map.json");
    await json(projectMapPath, projectMap);
    const boundary = await reviewedBoundary(root, projectMap, semantic);
    const transport = join(root, "transport");
    runOk(process.execPath, [prepare, "prepare", "story", projectMapPath,
      boundary.coverage, boundary.sourcePrivacy, boundary.review, transport]);
    const stories = ["a", "b"].map((suffix) => ({
      id: `event-${suffix}`, story: storySource(suffix, semantic, boundary.coverageAuthority),
    }));
    await recordLane(transport, "story", root, (input) => stories.filter((item) => (
      input.unitIds.includes(item.story.key)
    )));
    const baseCandidates = join(root, "story-base.json");
    runOk(process.execPath, [prepare, "compose", "story", transport, baseCandidates]);
    runOk(process.execPath, [prepare, "prepare", "insight", baseCandidates, transport]);
    const manifest = await readJson(join(transport, "insight", "shards.json"));
    assert.equal(manifest.shards.length, 1);
    const shard = manifest.shards[0];
    const inputPath = join(transport, ...shard.inputPath.split("/"));
    const inputBefore = await readFile(inputPath);
    const recordRoot = join(transport, "insight", "records", shard.id);
    const valid = [
      { storyKey: "story-a", insights: [insight("a")] },
      { storyKey: "story-b", insights: [] },
    ];
    const invalid = [
      { ...insight("a"), evidence: [{ documentId: "doc-canary", eventId: "event-foreign" }] },
      { ...insight("a"), evidence: [{ documentId: "doc-canary", eventId: "event-b" }] },
      { ...insight("a"), quote: { storyBlockIds: ["block-foreign"] } },
    ];
    for (const [index, badInsight] of invalid.entries()) {
      const proposal = join(root, `invalid-insight-${index}.json`);
      await json(proposal, [
        { storyKey: "story-a", insights: [badInsight] },
        { storyKey: "story-b", insights: [] },
      ]);
      const rejected = run(process.execPath, [record, transport, "insight", shard.id, proposal]);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /^STORY_INSIGHT_GROUNDING_INVALID\r?\n$/u);
      assert.equal(existsSync(recordRoot), false);
      assert.deepEqual(await readFile(inputPath), inputBefore);
    }
    const corrected = join(root, "corrected-insight.json");
    await json(corrected, valid);
    runOk(process.execPath, [record, transport, "insight", shard.id, corrected]);
    assert.deepEqual(await readFile(inputPath), inputBefore);
    const outputPath = join(recordRoot, "output.json");
    const receiptPath = join(recordRoot, "receipt.json");
    const outputBefore = await readFile(outputPath);
    const receiptBefore = await readFile(receiptPath);
    const differing = join(root, "differing-insight.json");
    await json(differing, [
      { storyKey: "story-a", insights: [{ ...insight("a"), title: "Different valid title" }] },
      { storyKey: "story-b", insights: [] },
    ]);
    const immutable = run(process.execPath, [record, transport, "insight", shard.id, differing]);
    assert.notEqual(immutable.status, 0);
    assert.match(immutable.stderr, /^AUTHORITY_IMMUTABLE\r?\n$/u);
    assert.deepEqual(await readFile(outputPath), outputBefore);
    assert.deepEqual(await readFile(receiptPath), receiptBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("finalizer repeats shared Story validation before replacing terminal authority", async () => {
  const flow = await createFlow();
  try {
    const storyOutputPath = join(flow.transport, "story", "records", "story-0001", "output.json");
    const storyReceiptPath = join(flow.transport, "story", "records", "story-0001", "receipt.json");
    const output = await readJson(storyOutputPath);
    const candidates = await readJson(flow.candidates);
    const finalStory = parseStorySource(candidates[0].summary);
    const baseStory = output[0].story;
    const foreign = { documentId: "doc-canary", eventId: "event-b" };
    for (const story of [baseStory, finalStory]) {
      story.evidence.supporting.push(foreign);
      story.people[0].evidence.push(foreign);
    }
    candidates[0].summary = `oxygen.story:${canonicalAuthorityJson(finalStory)}`;
    await json(storyOutputPath, output);
    await json(flow.candidates, candidates);
    const receipt = await readJson(storyReceiptPath);
    receipt.outputDigest = digest(output);
    await json(storyReceiptPath, receipt);
    const destination = flow.preparationManifest;
    const sentinel = Buffer.from("existing-terminal-authority\n");
    await writeFile(destination, sentinel);
    const rejected = run(process.execPath, [finalize,
      flow.projectMapPath, flow.candidates, flow.transport, flow.preferenceBundle, destination,
      "--workflow-run-id", "public-canary-run", "--source-revision", "4",
    ]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /^STORY_PEOPLE_INVALID\r?\n$/u);
    assert.deepEqual(await readFile(destination), sentinel);

    const rawEvidence = [
      { id: "event-a", documentId: "doc-canary", eventType: "message", actorId: "raw-a", actorType: "user" },
      { id: "event-b", documentId: "doc-canary", eventType: "message", actorId: "raw-b", actorType: "assistant" },
    ];
    const viewerCheck = validateStorySourcePackage([{
      id: "event-a", documentId: "doc-canary", summary: candidates[0].summary,
    }], rawEvidence);
    assert.deepEqual(viewerCheck, { ok: false, code: "STORY_PEOPLE_INVALID" });
    const activationCheck = await validateStoryActivationAuthority([{
      id: "event-a", documentId: "doc-canary", summary: candidates[0].summary,
    }], rawEvidence, await readJson(flow.semanticPath), await readJson(join(flow.root, "coverage.json")));
    assert.deepEqual(activationCheck, { ok: false, code: "STORY_PEOPLE_INVALID" });
  } finally {
    await flow.cleanup();
  }
});

test("24,796-item validation authority is bounded and raw reviewed content is not replicated", async () => {
  const root = await mkdtemp(join(tmpdir(), "story-authority-scale-"));
  try {
    const count = 24_796;
    const unitCount = 64;
    const ids = Array.from({ length: count }, (_, index) => `item-${String(index).padStart(5, "0")}`);
    const units = Array.from({ length: unitCount }, (_, index) => {
      const members = ids.filter((_, memberIndex) => memberIndex % unitCount === index);
      return {
        id: `unit-${String(index).padStart(2, "0")}`,
        revision: 1,
        projectId: "Scale Canary",
        kind: "decision_episode",
        members,
        memberCount: members.length,
        membershipDigest: digest(members.map((id) => ({ id, sourceDigest: digest(id) }))),
      };
    });
    const core = {
      projectId: "Scale Canary", revision: 1, sourceDigest: digest(ids),
      universeDigest: digest(ids), units,
    };
    const semantic = { ...core, manifestDigest: digest(core) };
    const projectMap = {
      primary_project: semantic.projectId, summary: "Bounded scale canary.",
      projects: [{ name: semantic.projectId, event_count: count, reason: "One repo-scoped projected contribution universe." }],
      source_authority: { sourceDigest: semantic.sourceDigest, sourceCount: 1, contributionCount: count },
      semantic_units: units.map((unit) => ({ id: unit.id, kind: unit.kind, members: unit.members })),
      semantic_manifest: semantic,
    };
    const semanticPath = join(root, "project-map.json");
    const review = join(root, "review");
    const trajectory = join(review, "trajectories", "doc-scale");
    await mkdir(trajectory, { recursive: true });
    await json(semanticPath, projectMap);
    await json(join(review, "project-map.json"), projectMap);
    const events = ids.map((id, index) => ({
      event_id: id, trajectory_id: "doc-scale",
      turn_id: `turn-${String(index).padStart(5, "0")}`, sequence: index + 1,
      event_type: "message", actor: { type: "user" }, timestamp: null,
      payload: { role: "user", text: index === 0
        ? "PRIVATE-SENTINEL reviewed item 00000" : `reviewed item ${String(index).padStart(5, "0")}` },
      relations: [],
    }));
    await writeFile(join(trajectory, "events.jsonl"), `${events.map(JSON.stringify).join("\n")}\n`, "utf8");
    const sourceRows = events.map((event) => ({
      id: event.event_id, document_id: event.trajectory_id, sequence: event.sequence,
      event_type: event.event_type, actor_type: event.actor.type, timestamp: null,
      content: event.payload.text,
    }));
    const sourcePrivacy = join(root, "source-privacy.json");
    await json(sourcePrivacy, {
      redactions: [{
        id: "redaction-scale", item_id: ids[0], document_id: "doc-scale",
        start_offset: 0, end_offset: 16, category: "private-personal", confidence: "high",
        reason: "Synthetic scale canary.", review_state: "deterministic", uncertainty_reason: null,
        status: "active", created_by: "scale-canary", created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      }],
      job: {
        id: "source-privacy-scale", status: "complete", stage: "complete", model: null,
        completed: 1, total: 1, rejected: 0, source_digest: await computeSourceDigest(sourceRows),
        started_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:01Z",
        completed_at: "2026-01-01T00:00:01Z",
      },
    });
    const coverageResult = await finalizeCoverageManifestAuthority({ rows: units.map((unit) => ({
      unitId: unit.id, disposition: "represented", ownerId: `story-${unit.id}`,
    })) }, semantic);
    assert.equal(coverageResult.ok, true);
    const coverage = join(root, "coverage.json");
    await json(coverage, {
      revision: coverageResult.authority.revision,
      semanticManifestRevision: coverageResult.authority.semanticManifestRevision,
      semanticManifestDigest: coverageResult.authority.semanticManifestDigest,
      coverageDigest: coverageResult.authority.coverageDigest,
      rows: coverageResult.authority.rows,
    });
    const transport = join(root, "transport");
    runOk(process.execPath, [prepare, "prepare", "story", semanticPath,
      coverage, sourcePrivacy, review, transport]);
    const authorityBytes = await readFile(join(transport, "story", "validation-authority.json"));
    const manifest = await readJson(join(transport, "story", "shards.json"));
    const inputBytes = await Promise.all(manifest.shards.map((shard) => (
      readFile(join(transport, ...shard.inputPath.split("/")))
    )));
    const authority = JSON.parse(authorityBytes);
    const inputs = inputBytes.map((bytes) => JSON.parse(bytes));
    assert.equal(authority.evidence.length, count);
    assert.ok(manifest.shards.length > 1);
    const ownerBundles = inputs.flatMap((input) => input.payload.ownerBundles);
    const narrative = ownerBundles.flatMap((bundle) => bundle.reviewedNarrative);
    assert.equal(ownerBundles.length, unitCount);
    assert.equal(new Set(ownerBundles.map((bundle) => bundle.ownerId)).size, unitCount);
    assert.equal(ownerBundles.reduce((total, bundle) => total + bundle.semanticUnits.length, 0), unitCount);
    assert.equal(narrative.length, count);
    assert.equal(new Set(narrative.map((row) => row.id)).size, count);
    assert.ok(authorityBytes.byteLength <= 12_000_000);
    assert.ok(inputBytes.every((bytes) => bytes.byteLength <= 25_000_000));
    assert.doesNotMatch(authorityBytes.toString("utf8"), /PRIVATE-SENTINEL|reviewed item 00001/u);
    const allInputs = Buffer.concat(inputBytes).toString("utf8");
    assert.doesNotMatch(allInputs, /PRIVATE-SENTINEL/u);
    assert.match(allInputs, /<redacted category=\\"private-personal\\"\/>/u);

    const inputSizes = inputBytes.map((bytes) => bytes.byteLength);
    const ownerBundleSizes = ownerBundles.map((bundle) => Buffer.byteLength(canonicalAuthorityJson(bundle)));
    assert.ok(Math.max(...inputSizes) - Math.min(...inputSizes) <= Math.max(...ownerBundleSizes));
    const stories = units.map((unit) => {
      const evidence = { documentId: "doc-scale", eventId: unit.members[0] };
      return {
        id: unit.members[0],
        story: {
          schema: "oxygen.story",
          key: `story-${unit.id}`,
          phase: { id: "phase-scale", label: "Scale study" },
          title: `Scale ${unit.id}`,
          overview: `A bounded reviewed scale chapter for ${unit.id}.`,
          people: [{
            id: `person-${unit.id}`,
            releaseLabel: `Scale contributor ${unit.id}`,
            role: "reviewed contributor",
            description: `The contributor supplied reviewed evidence for ${unit.id}.`,
            localIdentityState: "not_identified",
            evidence: [evidence],
          }],
          story: {
            blocks: [{
              id: `block-${unit.id}`,
              text: `Reviewed scale observation for ${unit.id}.`,
              evidence: [evidence],
            }],
          },
          insights: [],
          evidence: { primary: evidence, supporting: [] },
          coverage: {
            semanticManifest: { revision: semantic.revision, digest: semantic.manifestDigest },
            coverageManifest: {
              revision: coverageResult.authority.revision,
              digest: coverageResult.authority.coverageDigest,
            },
            representedUnitIds: [unit.id],
            excludedUnits: [],
          },
        },
      };
    });
    const storyManifest = await recordLane(transport, "story", root, (input) => stories.filter((record) => (
      input.unitIds.includes(record.story.key)
    )));
    assert.equal(storyManifest.shards.length, manifest.shards.length);
    const baseCandidates = join(root, "story-base-candidates.json");
    runOk(process.execPath, [prepare, "compose", "story", transport, baseCandidates]);

    runOk(process.execPath, [prepare, "prepare", "insight", baseCandidates, transport]);
    const insightManifest = await recordLane(transport, "insight", root, (input) => (
      input.unitIds.map((storyKey) => ({ storyKey, insights: [] }))
    ));
    assert.ok(insightManifest.shards.length > 1);
    const candidates = join(root, "story-candidates.json");
    runOk(process.execPath, [prepare, "compose", "final", transport, candidates]);

    const redacted = join(root, "redacted");
    await mkdir(redacted);
    const reviewedTurns = events.map((event, index) => ({
      event_id: event.event_id,
      document_id: "doc-scale",
      item_id: event.event_id,
      role: "user",
      timestamp: null,
      text: event.payload.text,
      redactions: index === 0 ? [{
        start: 0, end: 16, category: "private-personal", confidence: "high",
        reason: "Synthetic scale canary.", review_state: "deterministic", uncertainty_reason: null,
      }] : [],
      redacted_text: index === 0
        ? '<redacted category="private-personal"/> reviewed item 00000'
        : event.payload.text,
    }));
    await json(join(redacted, "doc-scale.json"), {
      trajectory: "doc-scale",
      document_kind: "trajectory",
      turns: reviewedTurns,
      chars: events.reduce((total, event) => total + event.payload.text.length, 0),
    });
    const privacyReport = join(root, "privacy-report.json");
    await json(privacyReport, {
      categories: { "private-personal": 1 },
      total_applied: 1,
      rejected: 0,
      rejects: [],
      missing_worker_output: [],
      per_trajectory: [{ trajectory: "doc-scale", turns: count, applied: 1 }],
    });
    const preferenceContext = join(root, "preference-context.json");
    runOk("python", [preparePreferenceContext,
      "--story-candidates", candidates,
      "--redacted", redacted,
      "--privacy-report", privacyReport,
      "--output", preferenceContext,
    ]);

    runOk(process.execPath, [prepare, "prepare", "story_privacy", candidates, transport]);
    const privacyManifest = await recordLane(transport, "story_privacy", root, () => []);
    runOk(process.execPath, [prepare, "prepare", "preference", candidates, preferenceContext, transport]);
    const preferenceCandidates = join(root, "preference-candidates.json");
    await json(preferenceCandidates, { probes: [], bulkDecisions: [], setAside: 0 });
    const preferenceBundle = join(root, "preference-bundle.json");
    runOk("python", [validateProbes,
      "--context", preferenceContext,
      "--candidates", preferenceCandidates,
      "--workflow-run-id", "scale-run",
      "--source-revision", "4",
      "--output", preferenceBundle,
    ]);
    const completedPreference = await readJson(preferenceBundle);
    const preferenceManifest = await recordLane(transport, "preference", root, () => completedPreference);
    const preparationManifest = join(root, "story-preparation-manifest.json");
    runOk(process.execPath, [finalize,
      semanticPath, candidates, transport, preferenceBundle, preparationManifest,
      "--workflow-run-id", "scale-run", "--source-revision", "4",
    ]);
    const terminal = await readJson(preparationManifest);
    assert.deepEqual(terminal.receipts.map((receipt) => receipt.lane), [
      "story", "insight", "story_privacy", "preference",
    ]);
    assert.equal(storyManifest.shards.length,
      (await readJson(join(transport, "story", "shards.json"))).shards.length);
    assert.equal(insightManifest.shards.length,
      (await readJson(join(transport, "insight", "shards.json"))).shards.length);
    assert.equal(privacyManifest.shards.length,
      (await readJson(join(transport, "story-privacy", "shards.json"))).shards.length);
    assert.equal(preferenceManifest.shards.length, 1);
    for (const [lane, laneManifest] of [
      ["story", storyManifest], ["insight", insightManifest],
      ["story_privacy", privacyManifest], ["preference", preferenceManifest],
    ]) {
      const recordDirectory = join(transport, laneDirectory[lane], "records");
      assert.ok((await Promise.all(laneManifest.shards.map((shard) => (
        readJson(join(recordDirectory, shard.id, "receipt.json"))
      )))).every((receipt) => receipt.status === "complete"));
    }
    console.log("STORY_PREPARATION_SCALE", JSON.stringify({
      itemCount: count,
      semanticUnitCount: unitCount,
      ownerCount: ownerBundles.length,
      maximumOwnerBundleBytes: Math.max(...ownerBundleSizes),
      validationAuthorityBytes: authorityBytes.byteLength,
      storyShardCount: storyManifest.shards.length,
      insightShardCount: insightManifest.shards.length,
      storyPrivacyShardCount: privacyManifest.shards.length,
      preferenceShardCount: preferenceManifest.shards.length,
      storyInputBytesMinimum: Math.min(...inputSizes),
      storyInputBytesMaximum: Math.max(...inputSizes),
      storyInputBytesTotal: inputSizes.reduce((total, size) => total + size, 0),
      reviewedNarrativeCount: narrative.length,
      reviewedNarrativeUniqueCount: new Set(narrative.map((row) => row.id)).size,
      exactOwnerUnion: new Set(ownerBundles.map((bundle) => bundle.ownerId)).size === ownerBundles.length,
      noOwnerSplitting: ownerBundles.length === new Set(ownerBundles.map((bundle) => bundle.ownerId)).size,
      terminalReceiptCount: storyManifest.shards.length + insightManifest.shards.length
        + privacyManifest.shards.length + preferenceManifest.shards.length,
      aggregateCoreReceiptCount: terminal.receipts.length,
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
