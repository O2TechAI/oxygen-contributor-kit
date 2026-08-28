import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

function semanticAuthority() {
  const units = ["a", "b"].map((suffix) => ({
    id: `unit-${suffix}`,
    revision: 1,
    projectId: "Synthetic Canary",
    kind: "decision_episode",
    members: [`event-${suffix}`],
    memberCount: 1,
    membershipDigest: digest([{ id: `event-${suffix}`, sourceDigest: digest({ suffix }) }]),
    storyProjection: {
      label: `Canary ${suffix.toUpperCase()}`,
      summary: `A reviewed synthetic event records canary ${suffix.toUpperCase()}.`,
    },
  }));
  const core = {
    projectId: "Synthetic Canary",
    revision: 1,
    sourceDigest: digest(units.map((unit) => unit.members[0])),
    universeDigest: digest(units.flatMap((unit) => unit.members)),
    units,
  };
  return { ...core, manifestDigest: digest(core) };
}

function storySource(suffix, semantic, coverage, insights = []) {
  const evidence = { documentId: "doc-canary", eventId: `event-${suffix}` };
  return {
    schema: "oxygen.story",
    key: `story-${suffix}`,
    phase: { id: `phase-${suffix}`, label: "Reviewed phase" },
    title: `Canary ${suffix.toUpperCase()}`,
    overview: `A domain-neutral reviewed canary ${suffix.toUpperCase()}.`,
    people: [{
      id: `person-${suffix}`,
      releaseLabel: `Canary participant ${suffix.toUpperCase()}`,
      role: "reviewed participant",
      description: `The participant contributed canary ${suffix.toUpperCase()}.`,
      localIdentityState: "not_identified",
      evidence: [evidence],
    }],
    story: {
      blocks: [{ id: `block-${suffix}`, text: `Reviewed canary text ${suffix.toUpperCase()}.`, evidence: [evidence] }],
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

async function reviewedBoundary(root, projectMap, semantic, coverageRows = [
  { unitId: "unit-a", disposition: "represented", ownerId: "story-a" },
  { unitId: "unit-b", disposition: "represented", ownerId: "story-b" },
]) {
  const review = join(root, "review");
  const trajectory = join(review, "trajectories", "doc-canary");
  await mkdir(trajectory, { recursive: true });
  await json(join(review, "project-map.json"), projectMap);
  const events = [
    { suffix: "a", actorType: "user" },
    { suffix: "b", actorType: "assistant" },
  ].map(({ suffix, actorType }, index) => ({
    schema_version: "ai-review.event/1",
    event_id: `event-${suffix}`,
    trajectory_id: "doc-canary",
    turn_id: `turn-${suffix}`,
    sequence: index + 1,
    event_type: "message",
    actor: { type: actorType },
    timestamp: null,
    payload: { role: actorType, text: `safe reviewed canary ${suffix}` },
    relations: [],
  }));
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
  const coverageResult = await finalizeCoverageManifestAuthority({ rows: coverageRows }, semantic);
  assert.equal(coverageResult.ok, true);
  const coverage = join(root, "coverage.json");
  const authority = coverageResult.authority;
  await json(coverage, {
    revision: authority.revision,
    semanticManifestRevision: authority.semanticManifestRevision,
    semanticManifestDigest: authority.semanticManifestDigest,
    coverageDigest: authority.coverageDigest,
    rows: authority.rows,
  });
  return { review, sourcePrivacy, coverage, coverageAuthority: authority };
}

function insight(suffix) {
  return {
    id: `insight-${suffix}`,
    title: `Canary lesson ${suffix.toUpperCase()}`,
    background: `Reviewed background ${suffix.toUpperCase()}.`,
    quote: { storyBlockIds: [`block-${suffix}`] },
    directlyAcquiredExperience: `Reviewed experience ${suffix.toUpperCase()}.`,
    principle: `Bounded principle ${suffix.toUpperCase()}.`,
    evidence: [{ documentId: "doc-canary", eventId: `event-${suffix}` }],
  };
}

async function privacyAuthority(root) {
  const redacted = join(root, "redacted");
  await mkdir(redacted);
  const text = "safe reviewed canary";
  const turns = ["a", "b"].map((suffix) => ({
    event_id: `event-${suffix}`,
    document_id: "doc-canary",
    item_id: `event-${suffix}`,
    role: "user",
    timestamp: null,
    text,
    redactions: [],
    redacted_text: text,
  }));
  await json(join(redacted, "doc-canary.json"), {
    trajectory: "doc-canary",
    document_kind: "trajectory",
    turns,
    chars: text.length * turns.length,
  });
  const report = join(root, "privacy-report.json");
  await json(report, {
    categories: {}, total_applied: 0, rejected: 0, rejects: [], missing_worker_output: [],
    per_trajectory: [{ trajectory: "doc-canary", turns: turns.length, applied: 0 }],
  });
  return { redacted, report };
}

async function createFlow({ reverse = false, completedZero = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "story-public-transport-"));
  const semantic = semanticAuthority();
  const semanticPath = join(root, "semantic.json");
  const projectMapPath = join(root, "project-map.json");
  const transport = join(root, "transport");
  await json(semanticPath, semantic);
  await json(projectMapPath, {
    schema_version: "1",
    primary_project: semantic.projectId,
    summary: "Domain-neutral synthetic canary.",
    projects: [{ name: semantic.projectId, event_count: 2, reason: "One repo-scoped projected contribution universe." }],
    source_authority: { sourceDigest: semantic.sourceDigest, sourceCount: 1, contributionCount: 2 },
    semantic_units: semantic.units.map((unit) => ({ id: unit.id, kind: unit.kind, members: unit.members })),
    semantic_manifest: semantic,
  });
  const projectMap = await readJson(projectMapPath);
  const boundary = await reviewedBoundary(root, projectMap, semantic);

  runOk(process.execPath, [prepare, "prepare", "story", projectMapPath,
    boundary.coverage, boundary.sourcePrivacy, boundary.review, transport]);
  const storyProposal = join(root, "story-proposal.json");
  const storyRecords = ["a", "b"].map((suffix) => ({
    id: `event-${suffix}`,
    story: storySource(suffix, semantic, boundary.coverageAuthority),
  }));
  await json(storyProposal, reverse ? [...storyRecords].reverse() : storyRecords);
  runOk(process.execPath, [record, transport, "story", "story-0001", storyProposal]);
  const baseCandidates = join(root, "story-base-candidates.json");
  runOk(process.execPath, [prepare, "compose", "story", transport, baseCandidates]);

  runOk(process.execPath, [prepare, "prepare", "insight", baseCandidates, transport]);
  const insightProposal = join(root, "insight-proposal.json");
  const insightRecords = ["a", "b"].map((suffix) => ({
    storyKey: `story-${suffix}`,
    insights: completedZero ? [] : [insight(suffix)],
  }));
  await json(insightProposal, reverse ? [...insightRecords].reverse() : insightRecords);
  runOk(process.execPath, [record, transport, "insight", "insight-0001", insightProposal]);
  const candidates = join(root, "story-candidates.json");
  runOk(process.execPath, [prepare, "compose", "final", transport, candidates]);

  const privacy = await privacyAuthority(root);
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

  const privacyProposal = join(root, "story-privacy-proposal.json");
  await json(privacyProposal, completedZero ? [] : [{
    id: "privacy-canary",
    reviewState: "needs_confirmation",
    title: "Review synthetic title",
    whyFlagged: "The reviewed canary requests a release decision.",
    uncertaintyReason: "Confirm the synthetic title.",
    releaseTargets: ["story-a::title"],
  }]);
  runOk(process.execPath, [record, transport, "story_privacy", "story-privacy-0001", privacyProposal]);

  const preferenceCandidates = join(root, "preference-candidates.json");
  await json(preferenceCandidates, completedZero ? {
    probes: [], bulkDecisions: [], setAside: 0,
  } : {
    probes: [{
      id: "probe-canary",
      documentId: "doc-canary",
      documentKind: "trajectory",
      eventIds: ["event-a"],
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
  runOk(process.execPath, [record, transport, "preference", "preference-0001", preferenceBundle]);

  const preparationManifest = join(root, "story-preparation-manifest.json");
  runOk(process.execPath, [finalize,
    projectMapPath, candidates, transport, preferenceBundle, preparationManifest,
    "--workflow-run-id", "public-canary-run", "--source-revision", "4",
  ]);
  return {
    root, semanticPath, projectMapPath, transport, candidates,
    preferenceBundle, preparationManifest,
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

test("recorder permits pre-receipt correction and makes the installed pair immutable", async () => {
  const root = await mkdtemp(join(tmpdir(), "story-recorder-atomic-"));
  try {
    const semantic = semanticAuthority();
    const semanticPath = join(root, "semantic.json");
    const transport = join(root, "transport");
    await json(semanticPath, semantic);
    const projectMapPath = join(root, "project-map.json");
    await json(projectMapPath, {
      schema_version: "1", primary_project: semantic.projectId, summary: "Synthetic.",
      projects: [{ name: semantic.projectId, event_count: 2, reason: "One repo-scoped projected contribution universe." }],
      source_authority: { sourceDigest: semantic.sourceDigest, sourceCount: 1, contributionCount: 2 },
      semantic_units: semantic.units.map((unit) => ({ id: unit.id, kind: unit.kind, members: unit.members })),
      semantic_manifest: semantic,
    });
    const boundary = await reviewedBoundary(root, await readJson(projectMapPath), semantic);
    runOk(process.execPath, [prepare, "prepare", "story", semanticPath,
      boundary.coverage, boundary.sourcePrivacy, boundary.review, transport]);
    const proposalPath = join(root, "proposal.json");
    await json(proposalPath, [{ id: "foreign", story: storySource("a", semantic, boundary.coverageAuthority) }]);
    const invalid = run(process.execPath, [record, transport, "story", "story-0001", proposalPath]);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /^STORY_OUTPUT_INVALID\r?\n$/u);
    const recordRoot = join(transport, "story", "records", "story-0001");
    assert.equal(existsSync(recordRoot), false);

    const validProposal = [
      { id: "event-a", story: storySource("a", semantic, boundary.coverageAuthority) },
      { id: "event-b", story: storySource("b", semantic, boundary.coverageAuthority) },
    ];
    await json(proposalPath, validProposal);
    runOk(process.execPath, [record, transport, "story", "story-0001", proposalPath]);
    const outputPath = join(recordRoot, "output.json");
    const receiptPath = join(recordRoot, "receipt.json");
    const beforeOutput = await readFile(outputPath);
    const beforeReceipt = await readFile(receiptPath);

    validProposal[0].story.title = "Different but structurally valid";
    await json(proposalPath, validProposal);
    const immutable = run(process.execPath, [record, transport, "story", "story-0001", proposalPath]);
    assert.notEqual(immutable.status, 0);
    assert.match(immutable.stderr, /^AUTHORITY_IMMUTABLE\r?\n$/u);
    assert.deepEqual(await readFile(outputPath), beforeOutput);
    assert.deepEqual(await readFile(receiptPath), beforeReceipt);

    await rm(receiptPath);
    const partial = run(process.execPath, [record, transport, "story", "story-0001", proposalPath]);
    assert.notEqual(partial.status, 0);
    assert.match(partial.stderr, /^PARTIAL_PAIR_REJECTED\r?\n$/u);
    assert.deepEqual(await readFile(outputPath), beforeOutput);
  } finally {
    await rm(root, { recursive: true, force: true });
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
      schema_version: "1", primary_project: semantic.projectId, summary: "Synthetic.",
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
    const proposal = join(root, "proposal.json");
    await json(proposal, [{
      id: "event-a", story: combinedStory(semantic, boundary.coverageAuthority, true),
    }]);
    const rejected = run(process.execPath, [record, transport, "story", "story-0001", proposal]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /^STORY_PEOPLE_INVALID\r?\n$/u);
    assert.equal(existsSync(join(transport, "story", "records", "story-0001")), false);

    await json(proposal, [{
      id: "event-a", story: combinedStory(semantic, boundary.coverageAuthority, false),
    }]);
    runOk(process.execPath, [record, transport, "story", "story-0001", proposal]);
    assert.deepEqual(
      await readFile(join(transport, "story", "inputs", "story-0001.json")), inputBefore,
    );
    const recordRoot = join(transport, "story", "records", "story-0001");
    const outputBefore = await readFile(join(recordRoot, "output.json"));
    const receiptBefore = await readFile(join(recordRoot, "receipt.json"));
    const changed = combinedStory(semantic, boundary.coverageAuthority, false);
    changed.title = "A different valid title";
    await json(proposal, [{ id: "event-a", story: changed }]);
    const immutable = run(process.execPath, [record, transport, "story", "story-0001", proposal]);
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
      schema_version: "1", primary_project: semantic.projectId, summary: "Bounded scale canary.",
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
      schema_version: "ai-review.event/1", event_id: id, trajectory_id: "doc-scale",
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
    const inputBytes = await readFile(join(transport, "story", "inputs", "story-0001.json"));
    const authority = JSON.parse(authorityBytes);
    const input = JSON.parse(inputBytes);
    assert.equal(authority.evidence.length, count);
    assert.equal(input.payload.reviewedNarrative.length, count);
    assert.ok(authorityBytes.byteLength <= 12_000_000);
    assert.ok(inputBytes.byteLength <= 25_000_000);
    assert.doesNotMatch(authorityBytes.toString("utf8"), /PRIVATE-SENTINEL|reviewed item 00001/u);
    assert.doesNotMatch(inputBytes.toString("utf8"), /PRIVATE-SENTINEL/u);
    assert.match(inputBytes.toString("utf8"), /<redacted category=\\"private-personal\\"\/>/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
