import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_SEMANTIC_UNITS,
  MAX_SEMANTIC_MANIFEST_BYTES,
  MAX_STORY_SEMANTIC_PROJECTION_BYTES,
  canonicalAuthorityJson,
  contributionRecordSourceDigest,
  contributionSourceDigest,
  finalizeCoverageManifestAuthority,
  projectSemanticManifestForStory,
  validateSemanticRevisionTransition,
  validateSemanticManifestAuthority,
} from "../lib/story-readiness.ts";
import {
  buildSourcePrivacyReceipt,
  installSourcePrivacyReceipt,
} from "./fixtures/source-privacy-receipt.mjs";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[^/]+$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        return nextResolve(`${specifier}/index.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const hash = (value) => createHash("sha256").update(canonicalAuthorityJson(value)).digest("hex");
const utf8Sort = (values) => [...values].sort((left, right) => Buffer.compare(
  Buffer.from(left), Buffer.from(right),
));
const contributionRecords = (ids) => ids.map((id) => ({ id, sourceDigest: hash({ id }) }));
const membershipAuthority = (members) => members.map((id) => ({ id, sourceDigest: hash({ id }) }));

function unit(id, members, overrides = {}) {
  const normalizedMembers = utf8Sort(members);
  return {
    id,
    revision: 1,
    projectId: "Synthetic Project",
    kind: "discussion",
    members: normalizedMembers,
    memberCount: normalizedMembers.length,
    membershipDigest: hash(membershipAuthority(normalizedMembers)),
    storyProjection: { label: id, summary: `Public-safe summary for ${id}.` },
    ...overrides,
  };
}

function manifest(contributionIds, units, overrides = {}) {
  const normalizedUnits = [...units].sort((left, right) => Buffer.compare(
    Buffer.from(left.id), Buffer.from(right.id),
  ));
  const core = {
    projectId: "Synthetic Project",
    revision: 1,
    sourceDigest: hash(contributionRecords(utf8Sort(contributionIds))),
    universeDigest: hash(utf8Sort(contributionIds)),
    registryDigest: "c".repeat(64),
    units: normalizedUnits,
  };
  return { ...core, manifestDigest: hash(core), ...overrides };
}

function lineageManifest(records, revision, unitRevision) {
  const normalizedRecords = [...records].sort((left, right) => Buffer.compare(
    Buffer.from(left.id), Buffer.from(right.id),
  ));
  const units = normalizedRecords.map((record, index) => ({
    id: `review-unit-${String(index + 1).padStart(3, "0")}`,
    revision: unitRevision,
    projectId: "Review Normalized Project",
    kind: "discussion",
    members: [record.id],
    memberCount: 1,
    membershipDigest: hash([record]),
    storyProjection: {
      label: `Review unit ${index + 1}`,
      summary: `Bounded semantic projection ${index + 1}.`,
    },
  }));
  const core = {
    projectId: "Review Normalized Project",
    revision,
    sourceDigest: hash(normalizedRecords),
    universeDigest: hash(normalizedRecords.map((record) => record.id)),
    registryDigest: "c".repeat(64),
    units,
  };
  return { ...core, manifestDigest: hash(core) };
}

function rehashManifest(value) {
  const { manifestDigest, ...core } = value;
  void manifestDigest;
  return { ...core, manifestDigest: hash(core) };
}

function reviewCorpus(version, unitCount = 203) {
  const documentId = "review-normalized-corpus";
  const items = Array.from({ length: unitCount }, (_, index) => {
    const id = `review-event-${String(index + 1).padStart(3, "0")}`;
    return {
      id,
      sequence: index + 1,
      eventType: "message",
      actorId: "fixture-reviewer",
      actorType: "human",
      timestamp: "2039-01-01T00:00:00.000Z",
      content: `Review-normalized content ${version} for unit ${index + 1}.`,
      original: {
        schema: "oxygen.trajectory-event",
        event_id: id,
        trajectory_id: documentId,
        payload: { text: `Review-normalized source ${version} for unit ${index + 1}.` },
      },
    };
  });
  return { documents: [{
    document: {
      id: documentId,
      kind: "trajectory",
      title: `Review-normalized corpus ${version}`,
      sourceUser: "fixture-reviewer",
      sourceSystem: "synthetic",
      sourceTimestamp: "2039-01-01T00:00:00.000Z",
      itemCount: items.length,
    },
    items,
  }] };
}

async function storedContributionRecords(db) {
  const { results } = await db.prepare(`SELECT id,document_id,sequence,event_type,actor_id,
      actor_type,timestamp,content,original_json FROM items ORDER BY id`).all();
  return Promise.all(results.map(async (row) => ({
    id: row.id,
    sourceDigest: await contributionRecordSourceDigest(JSON.parse(row.original_json), {
      id: row.id,
      documentId: row.document_id,
      sequence: Number(row.sequence),
      eventType: row.event_type,
      actorId: row.actor_id,
      actorType: row.actor_type,
      timestamp: row.timestamp,
      content: row.content,
    }),
  })));
}

async function completeAttachSnapshot(db) {
  const tables = [
    "documents", "items", "finalized_corpus_manifests", "workflow_runs",
    "organization_jobs", "semantic_manifests", "semantic_units", "semantic_unit_members",
    "redaction_jobs", "source_privacy_receipts", "story_privacy_authorities", "probe_runs",
    "project_release_confirmations",
  ];
  return Object.fromEntries(await Promise.all(tables.map(async (table) => {
    const { results } = await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    return [table, results];
  })));
}

function postJson(route, path, payload) {
  return route.POST(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }));
}

test("semantic manifest is the exact disjoint union of the contribution universe", async () => {
  const ids = ["doc:event-1", "doc:event-2", "doc:event-3"];
  const result = await validateSemanticManifestAuthority(
    manifest(ids, [unit("unit-a", ids.slice(0, 2)), unit("unit-b", ids.slice(2))]),
    contributionRecords(ids),
  );
  assert.equal(result.ok, true);
  assert.equal(result.authority.units.length, 2);
  const projection = projectSemanticManifestForStory(result.authority);
  assert.equal(JSON.stringify(projection).includes("doc:event-1"), false);
  assert.deepEqual(Object.keys(projection.units[0]).sort(), [
    "id", "kind", "memberCount", "membershipDigest", "revision", "storyProjection",
  ]);
});

test("semantic kind is an open lower-snake-case machine label", async () => {
  const validKinds = [
    "direction_change",
    "root_cause",
    "laboratory_observation",
    "supply_chain_exception",
  ];
  for (const kind of validKinds) {
    const ids = ["doc:event-1"];
    const result = await validateSemanticManifestAuthority(
      manifest(ids, [unit("unit-a", ids, { kind })]), contributionRecords(ids),
    );
    assert.equal(result.ok, true, kind);
    assert.equal(result.authority.units[0].kind, kind);
  }

  const invalidKinds = [
    "",
    "Direction_change",
    "1direction",
    "direction-change",
    "direction change",
    "direction_\u0000change",
    "a".repeat(65),
  ];
  for (const kind of invalidKinds) {
    const ids = ["doc:event-1"];
    const result = await validateSemanticManifestAuthority(
      manifest(ids, [unit("unit-a", ids, { kind })]), contributionRecords(ids),
    );
    assert.deepEqual(result, { ok: false, code: "SEMANTIC_WORKER_KIND_INVALID" });
  }
});

test("routine remains the only kind authorizing routine non-narrative coverage", async () => {
  const ids = ["doc:event-1", "doc:event-2"];
  const semantic = await validateSemanticManifestAuthority(manifest(ids, [
    unit("unit-laboratory", [ids[0]], { kind: "laboratory_observation" }),
    unit("unit-routine", [ids[1]], { kind: "routine" }),
  ]), contributionRecords(ids));
  assert.equal(semantic.ok, true);
  const invalid = await finalizeCoverageManifestAuthority({ rows: [
    { unitId: "unit-laboratory", disposition: "excluded", exclusionReason: "routine_non_narrative" },
    { unitId: "unit-routine", disposition: "represented", ownerId: "chapter-a" },
  ] }, semantic.authority);
  assert.deepEqual(invalid, { ok: false, code: "COVERAGE_EXCLUSION_AUTHORITY_INVALID" });
  const valid = await finalizeCoverageManifestAuthority({ rows: [
    { unitId: "unit-laboratory", disposition: "represented", ownerId: "chapter-a" },
    { unitId: "unit-routine", disposition: "excluded", exclusionReason: "routine_non_narrative" },
  ] }, semantic.authority);
  assert.equal(valid.ok, true);
});

test("missing, double-owned, unknown, and foreign members fail distinctly", async () => {
  const ids = ["doc:event-1", "doc:event-2"];
  const missingUnits = [unit("unit-a", [ids[0]])];
  assert.equal((await validateSemanticManifestAuthority(
    manifest(ids, missingUnits), contributionRecords(ids),
  )).code, "SEMANTIC_MEMBER_MISSING");

  const doubleUnits = [unit("unit-a", ids), unit("unit-b", [ids[1]])];
  assert.equal((await validateSemanticManifestAuthority(
    manifest(ids, doubleUnits), contributionRecords(ids),
  )).code, "SEMANTIC_MEMBER_DOUBLE_OWNED");

  const unknownUnits = [unit("unit-a", [...ids, "doc:event-3"] )];
  assert.equal((await validateSemanticManifestAuthority(
    manifest(ids, unknownUnits), contributionRecords(ids),
  )).code, "SEMANTIC_MEMBER_UNKNOWN");

  const foreign = unit("unit-a", ids);
  foreign.members = [ids[0], "x".repeat(301)];
  foreign.memberCount = 2;
  foreign.membershipDigest = hash(membershipAuthority(foreign.members));
  assert.equal((await validateSemanticManifestAuthority(
    manifest(ids, [foreign]), contributionRecords(ids),
  )).code, "SEMANTIC_MEMBER_FOREIGN");
});

test("duplicate unit identity, project mismatch, and stale digests fail closed", async () => {
  const ids = ["doc:event-1", "doc:event-2"];
  const duplicated = [unit("unit-a", [ids[0]]), unit("unit-a", [ids[1]])];
  assert.equal((await validateSemanticManifestAuthority(
    manifest(ids, duplicated), contributionRecords(ids),
  )).code, "SEMANTIC_UNIT_ID_DUPLICATED");

  const foreignProject = unit("unit-a", ids, { projectId: "Foreign Project" });
  assert.equal((await validateSemanticManifestAuthority(
    manifest(ids, [foreignProject]), contributionRecords(ids),
  )).code, "SEMANTIC_MANIFEST_INVALID");

  const staleMembership = unit("unit-a", ids, { membershipDigest: "d".repeat(64) });
  assert.equal((await validateSemanticManifestAuthority(
    manifest(ids, [staleMembership]), contributionRecords(ids),
  )).code, "SEMANTIC_MEMBERSHIP_DIGEST_STALE");

  const staleManifest = manifest(ids, [unit("unit-a", ids)], {
    manifestDigest: "e".repeat(64),
  });
  assert.equal((await validateSemanticManifestAuthority(
    staleManifest, contributionRecords(ids),
  )).code, "SEMANTIC_MANIFEST_DIGEST_STALE");
});

test("canonical digest and authority are independent of input order", async () => {
  const ids = ["doc:event-1", "doc:event-2", "doc:event-3"];
  const first = unit("unit-a", [ids[0], ids[1]]);
  const second = unit("unit-b", [ids[2]]);
  const canonical = manifest(ids, [first, second]);
  const shuffled = structuredClone(canonical);
  shuffled.units.reverse();
  shuffled.units[1].members.reverse();
  const [left, right] = await Promise.all([
    validateSemanticManifestAuthority(canonical, contributionRecords(ids)),
    validateSemanticManifestAuthority(shuffled, contributionRecords([...ids].reverse())),
  ]);
  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  assert.deepEqual(right.authority, left.authority);
});

test("canonical authority order matches UTF-8 byte order for Unicode identities", async () => {
  const ids = ["doc:\u{10000}", "doc:\u{e000}", "doc:A", "doc:a"];
  const input = manifest(ids, [unit("unit-unicode", ids)]);
  const result = await validateSemanticManifestAuthority(input, contributionRecords(ids).reverse());
  assert.equal(result.ok, true);
  assert.deepEqual(result.authority.units[0].members, utf8Sort(ids));
});

test("Python Organization finalizer and Viewer validator share one digest contract", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "oxygen-semantic-parity-"));
  try {
    const repository = fileURLToPath(new URL("../..", import.meta.url));
    const script = join(
      repository, "skills", "oxygen-organize-review-export", "scripts", "build_project_map.py",
    );
    const trajectory = join(root, "trajectories", "traj-parity");
    mkdirSync(trajectory, { recursive: true });
    const rawEvent = {
      schema: "oxygen.trajectory-event",
      event_id: "raw-event",
      trajectory_id: "traj-parity",
      event_type: "message",
      actor: { id: "person", type: "human" },
      source: {
        system: "synthetic", session_id: "parity-session", origin: "top_level",
        record_id: "parity-record", record_type: "message",
      },
      payload: { role: "user", confidence: 1.0, text: "Keep this." },
    };
    const projectionProbe = spawnSync("python", ["-c", [
      "import json,sys",
      `sys.path.insert(0,${JSON.stringify(join(repository, "tools"))})`,
      "from ingest.human_source_projection import canonical_json,project_events",
      "event=project_events([json.loads(sys.stdin.read())])[0][0]",
      "print(canonical_json(event))",
    ].join(";")], {
      cwd: repository, encoding: "utf8", input: JSON.stringify(rawEvent),
    });
    assert.equal(projectionProbe.status, 0, projectionProbe.stderr);
    const eventLine = projectionProbe.stdout.trim();
    const contributionId = JSON.parse(eventLine).event_id;
    writeFileSync(join(trajectory, "events.jsonl"), `${eventLine}\n`, "utf8");
    const projectedDigest = createHash("sha256").update(`${eventLine}\n`).digest("hex");
    writeFileSync(join(trajectory, "manifest.json"), JSON.stringify({
      schema: "oxygen.trajectory",
      trajectory_id: "traj-parity",
      event_count: 1,
      contribution_projection: {
        policy_id: "oxygen-human-semantic-source-boundary-2026-08-26",
        raw_source_digest: "a".repeat(64),
        projected_universe_digest: projectedDigest,
        raw_event_count: 1,
        normalized_event_count: 1,
        kept_event_count: 1,
        dropped_event_count: 0,
        cross_trajectory_semantic_replay_count: 0,
      },
    }), "utf8");
    writeFileSync(join(root, "index.json"), JSON.stringify({
      schema: "oxygen.ingest-run",
      tool: "collect_repo_trajectories",
      collection_status: "complete",
      trajectory_count: 1,
      trajectory_failures: 0,
      trajectories: [{ trajectory_id: "traj-parity", ok: true, cwd_relations: ["exact"] }],
    }), "utf8");
    const skeleton = spawnSync("python", [
      script, root, "--primary-project", "Synthetic Project",
      "--summary", "Cross-runtime parity.",
    ], { cwd: repository, encoding: "utf8" });
    assert.equal(skeleton.status, 0, skeleton.stderr);
    const semanticRoot = join(root, "semantic-transport");
    const registryPath = join(root, "semantic-registry.proposal.json");
    writeFileSync(registryPath, JSON.stringify({ units: [{
      unitId: "unit-parity",
      kind: "direction_change",
      definition: "Records describing the synthetic direction change.",
      disambiguation: "Use only for the synthetic direction-change episode.",
    }] }), "utf8");
    const prepared = spawnSync("python", [
      join(repository, "skills", "oxygen-organize-review-export", "scripts", "prepare_semantic_units.py"),
      root, semanticRoot, registryPath,
    ], { cwd: repository, encoding: "utf8" });
    assert.equal(prepared.status, 0, prepared.stderr);
    const shards = JSON.parse(readFileSync(join(semanticRoot, "shards.json"), "utf8"));
    assert.equal(shards.shards.length, 1);
    const shardId = shards.shards[0].id;
    const proposalPath = join(semanticRoot, "handoffs", `${shardId}.proposals.json`);
    writeFileSync(proposalPath, JSON.stringify([{
      unitId: "unit-parity", contributionIds: [contributionId],
    }]), "utf8");
    const receipt = spawnSync("python", [
      join(repository, "skills", "oxygen-organize-review-export", "scripts", "record_semantic_worker.py"),
      semanticRoot, shardId, proposalPath,
    ], { cwd: repository, encoding: "utf8" });
    assert.equal(receipt.status, 0, receipt.stderr);
    const finalized = spawnSync("python", [
      join(repository, "skills", "oxygen-organize-review-export", "scripts", "finalize_semantic_units.py"),
      root, semanticRoot,
    ], { cwd: repository, encoding: "utf8" });
    assert.equal(finalized.status, 0, finalized.stderr);
    const projectMap = JSON.parse(readFileSync(join(root, "project-map.json"), "utf8"));
    const projectedEvent = JSON.parse(eventLine);
    const sourceDigest = await contributionRecordSourceDigest(projectedEvent, {
      id: contributionId,
      documentId: "traj-parity",
      sequence: 1,
      eventType: "message",
      actorId: "person",
      actorType: "human",
      timestamp: null,
      content: "Keep this.",
    });
    const validation = await validateSemanticManifestAuthority(
      projectMap.semantic_manifest,
      [{ id: contributionId, sourceDigest }],
    );
    assert.equal(validation.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  context.diagnostic("Python builder output accepted by the TypeScript authority validator.");
});

test("attachment source digest ignores staging paths in both runtimes", async () => {
  const repository = fileURLToPath(new URL("../..", import.meta.url));
  const attachment = {
    schema: "oxygen.trajectory-event",
    event_id: `evt-${"a".repeat(64)}`,
    trajectory_id: "traj-stable",
    event_type: "artifact",
    actor: { id: "system", type: "system" },
    source: {
      system: "codex", session_id: "session", origin: "top_level",
      record_id: "record", record_type: "message_attachment:0",
    },
    payload: {
      artifact_id: "artifact-000001", kind: "attachment",
      stored_name: "artifact-000001.json",
      path: "artifacts/attachments/artifact-000001.json",
      media_type: "application/json", size_bytes: 12,
      sha256: "b".repeat(64), created_by_event: `evt-${"c".repeat(64)}`,
    },
    relations: [{ type: "produced", event_id: `evt-${"c".repeat(64)}` }],
  };
  const shifted = structuredClone(attachment);
  shifted.payload.artifact_id = "artifact-000099";
  shifted.payload.stored_name = "artifact-000099.json";
  shifted.payload.path = "artifacts/attachments/artifact-000099.json";
  const [left, right] = await Promise.all([
    contributionSourceDigest(attachment), contributionSourceDigest(shifted),
  ]);
  assert.equal(right, left);
  const probe = spawnSync("python", ["-c", [
    "import json,sys",
    `sys.path.insert(0,${JSON.stringify(join(repository, "tools"))})`,
    "from ingest.human_source_projection import contribution_digest_value",
    "values=json.loads(sys.stdin.read())",
    "print('\\n'.join(contribution_digest_value(value) for value in values))",
  ].join(";")], {
    cwd: repository, encoding: "utf8", input: JSON.stringify([attachment, shifted]),
  });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(probe.stdout.trim().split(/\r?\n/), [left, left]);
});

test("semantic source digest binds the exact normalized Evidence Story consumes", async () => {
  const original = {
    schema: "oxygen.trajectory-event",
    event_id: `evt-${"b".repeat(64)}`,
    trajectory_id: "traj-bound",
    event_type: "message",
    actor: { id: "person", type: "human" },
    source: { system: "synthetic", record_type: "message", record_id: "record-bound" },
    payload: { role: "user", text: "Recorded source." },
  };
  const imported = {
    id: original.event_id,
    documentId: original.trajectory_id,
    sequence: 1,
    eventType: "message",
    actorId: "person",
    actorType: "human",
    timestamp: null,
    content: "Recorded source.",
  };
  const baseline = await contributionRecordSourceDigest(original, imported);
  assert.notEqual(
    await contributionRecordSourceDigest(original, { ...imported, content: "Changed Evidence." }),
    baseline,
  );
  assert.notEqual(
    await contributionRecordSourceDigest(original, { ...imported, actorType: "ai" }),
    baseline,
  );
});

test("duplicate units require one direct non-duplicate authority target", async () => {
  const ids = ["doc:event-1", "doc:event-2", "doc:event-3"];
  const primary = unit("unit-primary", [ids[0]]);
  const duplicate = unit("unit-duplicate", [ids[1], ids[2]], {
    kind: "duplicate", duplicateOfUnitId: "unit-primary",
  });
  assert.equal((await validateSemanticManifestAuthority(
    manifest(ids, [primary, duplicate]), contributionRecords(ids),
  )).ok, true);

  const missingRelation = structuredClone(duplicate);
  delete missingRelation.duplicateOfUnitId;
  assert.equal((await validateSemanticManifestAuthority(
    manifest(ids, [primary, missingRelation]), contributionRecords(ids),
  )).code, "SEMANTIC_MANIFEST_INVALID");

  const relationOnPrimary = structuredClone(primary);
  relationOnPrimary.duplicateOfUnitId = "unit-duplicate";
  assert.equal((await validateSemanticManifestAuthority(
    manifest(ids, [relationOnPrimary, duplicate]), contributionRecords(ids),
  )).code, "SEMANTIC_MANIFEST_INVALID");

  const chainedPrimary = structuredClone(primary);
  chainedPrimary.kind = "duplicate";
  chainedPrimary.duplicateOfUnitId = "unit-duplicate";
  assert.equal((await validateSemanticManifestAuthority(
    manifest(ids, [chainedPrimary, duplicate]), contributionRecords(ids),
  )).code, "SEMANTIC_MANIFEST_INVALID");
});

test("semantic revisions are tool-owned and advance only affected authority", async () => {
  const ids = ["doc:event-1"];
  const first = await validateSemanticManifestAuthority(
    manifest(ids, [unit("unit-a", ids)]), contributionRecords(ids),
  );
  assert.equal(first.ok, true);
  assert.equal(validateSemanticRevisionTransition(first.authority, null), null);
  const staleInitial = structuredClone(first.authority);
  staleInitial.revision = 2;
  assert.equal(validateSemanticRevisionTransition(staleInitial, null), "SEMANTIC_REVISION_STALE");

  const unchanged = structuredClone(first.authority);
  assert.equal(validateSemanticRevisionTransition(unchanged, first.authority), null);
  unchanged.revision = 2;
  assert.equal(validateSemanticRevisionTransition(unchanged, first.authority), "SEMANTIC_REVISION_STALE");

  const changed = structuredClone(first.authority);
  changed.revision = 2;
  changed.units[0].revision = 2;
  changed.units[0].storyProjection.summary = "A changed bounded projection.";
  assert.equal(validateSemanticRevisionTransition(changed, first.authority), null);
});

test("Organization carries same-workflow semantic lineage across full-corpus replacement", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "oxygen-organization-lineage-"));
  const previousStateDir = process.env.OXYGEN_VIEWER_STATE_DIR;
  process.env.OXYGEN_VIEWER_STATE_DIR = stateDir;

  try {
    const [{ getLocalDatabase }, { establishWorkflowRun }, documentsRoute, organizationRoute] =
      await Promise.all([
        import("../db/index.ts"),
        import("../lib/workflow-run-server.ts"),
        import("../app/api/documents/route.ts"),
        import("../app/api/organization/route.ts"),
      ]);
    const db = await getLocalDatabase();
    const workflowRunId = "review-normalized-lineage";
    assert.deepEqual(
      await establishWorkflowRun(db, workflowRunId, "2039-01-01T00:00:00.000Z"),
      { state: "EXACT_RUN_ESTABLISHED", workflowRunId },
    );

    const firstCorpusResponse = await postJson(
      documentsRoute, "/api/documents", reviewCorpus("revision-1"),
    );
    assert.equal(firstCorpusResponse.status, 200);
    const firstCorpusAuthority = await firstCorpusResponse.json();
    assert.equal(firstCorpusAuthority.corpusRevision, 1);

    const firstRecords = await storedContributionRecords(db);
    const firstManifest = lineageManifest(firstRecords, 1, 1);
    const firstOrganizationResponse = await postJson(
      organizationRoute, "/api/organization", { semanticManifest: firstManifest },
    );
    assert.equal(firstOrganizationResponse.status, 200);
    const firstOrganization = await firstOrganizationResponse.json();
    assert.equal(firstOrganization.semanticManifest.revision, 1);
    assert.equal(firstOrganization.semanticManifest.finalizedCorpus.revision, 1);
    assert.equal(firstOrganization.completed, 203);

    const activatedSourceRevision = firstOrganization.semanticManifest.sourceRevision;
    const sourcePrivacyReceipt = await buildSourcePrivacyReceipt(db, {
      workflowRunId,
      sourceRevision: activatedSourceRevision,
    });
    await db.batch([
      db.prepare(`UPDATE workflow_runs SET story_generation_status='ready_for_human_review',
        active_story_digest=?,updated_at=? WHERE id=?`)
        .bind("a".repeat(64), "2039-02-01T00:00:00.000Z", workflowRunId),
      db.prepare(`INSERT INTO redaction_jobs
        (id,status,stage,model,completed,total,rejected,source_digest,
         started_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .bind("completed-source-privacy", "complete", "done", "fixture-model", 0, 0, 0,
          sourcePrivacyReceipt.sourceDigest, "2039-01-02T00:00:00.000Z", "2039-01-03T00:00:00.000Z",
          "2039-01-03T00:00:00.000Z"),
      db.prepare(`INSERT INTO story_privacy_authorities
        (workflow_run_id,source_revision,active_story_digest,server_version,
         reviewed_story_digest,target_catalog_json,target_catalog_digest,changed_target_digest,
         changed_target_count,receipt_digest,proposal_digest,proposal_count,imported_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        workflowRunId, activatedSourceRevision, "a".repeat(64), 1, "c".repeat(64), "[]",
        "d".repeat(64), "e".repeat(64), 0, "f".repeat(64), "1".repeat(64), 0,
        "2039-01-04T00:00:00.000Z",
      ),
      db.prepare(`INSERT INTO probe_runs
        (workflow_run_id,id,source_revision,input_digest,output_digest,output_count,status,stage,
         generated,set_aside,auto_removed_json,started_at,updated_at,completed_at)
        VALUES (?,?,?,?,?,1,'complete','preference',1,0,'{}',?,?,?)`).bind(
        workflowRunId, "completed-preference", activatedSourceRevision,
        "2".repeat(64), "3".repeat(64), "2039-01-05T00:00:00.000Z",
        "2039-01-06T00:00:00.000Z", "2039-01-06T00:00:00.000Z",
      ),
      db.prepare(`INSERT INTO project_release_confirmations
        (workflow_run_id,review_gate_digest,confirmed_at) VALUES (?,?,?)`)
        .bind(workflowRunId, "4".repeat(64), "2039-01-07T00:00:00.000Z"),
    ]);
    await installSourcePrivacyReceipt(db, {
      jobId: "completed-source-privacy",
      workflowRunId,
      receipt: sourcePrivacyReceipt,
      at: "2039-01-03T00:00:00.000Z",
    });
    const beforeIdenticalAttach = await completeAttachSnapshot(db);
    const observedOrganization = await organizationRoute.GET(
      new Request("http://localhost/api/organization"),
    );
    assert.equal(observedOrganization.status, 200);
    assert.deepEqual(await completeAttachSnapshot(db), beforeIdenticalAttach,
      "Organization GET must remain read-only");
    const identicalCorpusResponse = await postJson(
      documentsRoute, "/api/documents", reviewCorpus("revision-1"),
    );
    assert.equal(identicalCorpusResponse.status, 200);
    assert.deepEqual(await identicalCorpusResponse.json(), firstCorpusAuthority);
    const identicalOrganizationResponse = await postJson(
      organizationRoute, "/api/organization", { semanticManifest: firstManifest },
    );
    assert.equal(identicalOrganizationResponse.status, 200);
    assert.deepEqual(await identicalOrganizationResponse.json(), firstOrganization);
    assert.deepEqual(await completeAttachSnapshot(db), beforeIdenticalAttach,
      "an exact documents-plus-Organization reattach must preserve all downstream authority");

    await db.prepare(`UPDATE workflow_runs SET story_source_revision=0 WHERE id=?`)
      .bind(workflowRunId).run();
    await db.prepare(`UPDATE semantic_manifests SET source_revision=0 WHERE workflow_run_id=?`)
      .bind(workflowRunId).run();
    const zeroStatus = await (await organizationRoute.GET(
      new Request("http://localhost/api/organization"),
    )).json();
    assert.equal(zeroStatus.semanticManifest, null);
    assert.equal(zeroStatus.semanticProjection, null);
    const evidenceUnit = firstManifest.units[0];
    const zeroEvidence = await organizationRoute.GET(new Request(
      `http://localhost/api/organization?unitId=${encodeURIComponent(evidenceUnit.id)}`
      + `&revision=${evidenceUnit.revision}`
      + `&membershipDigest=${evidenceUnit.membershipDigest}`,
    ));
    assert.equal(zeroEvidence.status, 409);
    const zeroRunBeforePost = await db.prepare(`SELECT story_generation_status,story_source_revision,
      updated_at FROM workflow_runs WHERE id=?`).bind(workflowRunId).first();
    assert.equal((await postJson(
      organizationRoute, "/api/organization", { semanticManifest: firstManifest },
    )).status, 409);
    assert.deepEqual(await db.prepare(`SELECT story_generation_status,story_source_revision,
      updated_at FROM workflow_runs WHERE id=?`).bind(workflowRunId).first(), zeroRunBeforePost);
    await db.prepare(`UPDATE workflow_runs SET story_source_revision=? WHERE id=?`)
      .bind(activatedSourceRevision, workflowRunId).run();
    await db.prepare(`UPDATE semantic_manifests SET source_revision=? WHERE workflow_run_id=?`)
      .bind(activatedSourceRevision, workflowRunId).run();

    const replacementResponse = await postJson(
      documentsRoute, "/api/documents", reviewCorpus("revision-2"),
    );
    assert.equal(replacementResponse.status, 200);
    const replacementAuthority = await replacementResponse.json();
    assert.equal(replacementAuthority.corpusRevision, 2);
    assert.notEqual(replacementAuthority.corpusDigest, firstCorpusAuthority.corpusDigest);

    const staleStatusResponse = await organizationRoute.GET(
      new Request("http://localhost/api/organization"),
    );
    assert.equal(staleStatusResponse.status, 200);
    const staleStatus = await staleStatusResponse.json();
    assert.equal(staleStatus.semanticManifest, null);
    assert.equal(staleStatus.semanticProjection, null);

    const replacementRecords = await storedContributionRecords(db);
    const nextManifest = lineageManifest(replacementRecords, 2, 2);
    assert.notEqual(nextManifest.sourceDigest, firstManifest.sourceDigest);
    assert.notEqual(
      nextManifest.units[0].membershipDigest,
      firstManifest.units[0].membershipDigest,
    );
    const expectFailure = async (candidate, code) => {
      const response = await postJson(
        organizationRoute, "/api/organization", { semanticManifest: candidate },
      );
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, code);
    };

    const reset = structuredClone(nextManifest);
    reset.revision = 1;
    await expectFailure(rehashManifest(reset), "SEMANTIC_REVISION_STALE");

    const skipped = structuredClone(nextManifest);
    skipped.revision = 3;
    await expectFailure(rehashManifest(skipped), "SEMANTIC_REVISION_STALE");

    const staleSource = structuredClone(nextManifest);
    staleSource.sourceDigest = firstManifest.sourceDigest;
    const staleSourceManifest = rehashManifest(staleSource);
    assert.equal(
      (await validateSemanticManifestAuthority(staleSourceManifest, replacementRecords)).code,
      "SEMANTIC_MANIFEST_DIGEST_STALE",
    );
    await expectFailure(staleSourceManifest, "SEMANTIC_MANIFEST_DIGEST_STALE");

    const staleMembership = structuredClone(nextManifest);
    staleMembership.units[0].membershipDigest = firstManifest.units[0].membershipDigest;
    await expectFailure(rehashManifest(staleMembership), "SEMANTIC_MEMBERSHIP_DIGEST_STALE");

    const wrongPrevious = lineageManifest(firstRecords, 2, 1);
    await db.prepare(`UPDATE semantic_manifests SET revision=?,manifest_digest=?
      WHERE workflow_run_id=?`).bind(
      wrongPrevious.revision, wrongPrevious.manifestDigest, workflowRunId,
    ).run();
    await expectFailure(nextManifest, "SEMANTIC_REVISION_STALE");
    await db.prepare(`UPDATE semantic_manifests SET revision=?,manifest_digest=?
      WHERE workflow_run_id=?`).bind(
      firstManifest.revision, firstManifest.manifestDigest, workflowRunId,
    ).run();

    const foreignWorkflowRunId = "foreign-review-lineage";
    await db.prepare(`UPDATE semantic_manifests SET workflow_run_id=?
      WHERE workflow_run_id=?`).bind(foreignWorkflowRunId, workflowRunId).run();
    await expectFailure(nextManifest, "SEMANTIC_REVISION_STALE");
    assert.deepEqual(await db.prepare(`SELECT revision FROM semantic_manifests
      WHERE workflow_run_id=?`).bind(foreignWorkflowRunId).first(), { revision: 1 });
    await db.prepare(`UPDATE semantic_manifests SET workflow_run_id=?
      WHERE workflow_run_id=?`).bind(workflowRunId, foreignWorkflowRunId).run();

    const nextOrganizationResponse = await postJson(
      organizationRoute, "/api/organization", { semanticManifest: nextManifest },
    );
    assert.equal(nextOrganizationResponse.status, 200);
    const nextOrganization = await nextOrganizationResponse.json();
    assert.equal(nextOrganization.semanticManifest.revision, 2);
    const currentOrganizationResponse = await organizationRoute.GET(
      new Request("http://localhost/api/organization"),
    );
    assert.equal(currentOrganizationResponse.status, 200);
    const currentOrganization = await currentOrganizationResponse.json();
    assert.deepEqual(currentOrganization.semanticProjection.units.map((row) => row.revision),
      Array(203).fill(2));
    assert.deepEqual(nextOrganization.semanticManifest.finalizedCorpus, {
      revision: 2,
      digest: replacementAuthority.corpusDigest,
      documentCount: 1,
      itemCount: 203,
    });
    assert.deepEqual(await db.prepare(`SELECT revision,corpus_revision,corpus_digest
      FROM semantic_manifests WHERE workflow_run_id=?`).bind(workflowRunId).first(), {
      revision: 2,
      corpus_revision: 2,
      corpus_digest: replacementAuthority.corpusDigest,
    });

    const beforeSerializedDrift = await db.prepare(`SELECT m.serialized_bytes,
        r.story_source_revision FROM semantic_manifests m JOIN workflow_runs r ON r.id=m.workflow_run_id
        WHERE m.workflow_run_id=?`).bind(workflowRunId).first();
    await db.prepare(`UPDATE semantic_manifests SET serialized_bytes=serialized_bytes+1
      WHERE workflow_run_id=?`).bind(workflowRunId).run();
    const serializedDriftResponse = await postJson(
      organizationRoute, "/api/organization", { semanticManifest: nextManifest },
    );
    assert.equal(serializedDriftResponse.status, 200);
    assert.deepEqual(await db.prepare(`SELECT m.serialized_bytes,
        r.story_source_revision FROM semantic_manifests m JOIN workflow_runs r ON r.id=m.workflow_run_id
        WHERE m.workflow_run_id=?`).bind(workflowRunId).first(), {
      serialized_bytes: Buffer.byteLength(JSON.stringify(nextManifest)),
      story_source_revision: Number(beforeSerializedDrift.story_source_revision) + 1,
    }, "serialized-byte drift must use the guarded publication path and restore durable authority");

    await db.prepare(`UPDATE semantic_unit_members SET source_digest=?
      WHERE workflow_run_id=? AND item_id=?`).bind(
      "9".repeat(64), workflowRunId, nextManifest.units[0].members[0],
    ).run();
    const driftedSemanticRows = await Promise.all([
      db.prepare("SELECT * FROM semantic_manifests WHERE workflow_run_id=?")
        .bind(workflowRunId).all(),
      db.prepare("SELECT * FROM semantic_units WHERE workflow_run_id=? ORDER BY id")
        .bind(workflowRunId).all(),
      db.prepare("SELECT * FROM semantic_unit_members WHERE workflow_run_id=? ORDER BY item_id")
        .bind(workflowRunId).all(),
    ]);
    const driftResponse = await postJson(
      organizationRoute, "/api/organization", { semanticManifest: nextManifest },
    );
    assert.equal(driftResponse.status, 409);
    assert.equal((await driftResponse.json()).code, "SEMANTIC_REVISION_STALE");
    assert.deepEqual(await Promise.all([
      db.prepare("SELECT * FROM semantic_manifests WHERE workflow_run_id=?")
        .bind(workflowRunId).all(),
      db.prepare("SELECT * FROM semantic_units WHERE workflow_run_id=? ORDER BY id")
        .bind(workflowRunId).all(),
      db.prepare("SELECT * FROM semantic_unit_members WHERE workflow_run_id=? ORDER BY item_id")
        .bind(workflowRunId).all(),
    ]), driftedSemanticRows,
    "a matching manifest must not mask drift in persisted semantic member authority");
  } finally {
    globalThis.__oxygenLocalSqlite?.database.close();
    delete globalThis.__oxygenLocalSqlite;
    if (previousStateDir === undefined) delete process.env.OXYGEN_VIEWER_STATE_DIR;
    else process.env.OXYGEN_VIEWER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("unit-count and serialized-byte bounds fail before semantic processing", async () => {
  const ids = Array.from({ length: MAX_SEMANTIC_UNITS + 1 }, (_, index) => `doc:event-${index}`);
  const units = ids.map((id, index) => unit(`unit-${index}`, [id]));
  assert.equal((await validateSemanticManifestAuthority(
    manifest(ids, units), contributionRecords(ids),
  )).code, "SEMANTIC_UNIT_LIMIT_EXCEEDED");

  const huge = manifest(["doc:event-1"], [unit("unit-a", ["doc:event-1"])]);
  huge.padding = "x".repeat(MAX_SEMANTIC_MANIFEST_BYTES);
  assert.equal((await validateSemanticManifestAuthority(
    huge, contributionRecords(["doc:event-1"]),
  )).code, "SEMANTIC_MANIFEST_TOO_LARGE");
});

test("24796-record BOM projection stays bounded by 512 semantic units", async (context) => {
  const ids = Array.from({ length: 24_796 }, (_, index) => (
    `evt-${createHash("sha256").update(String(index)).digest("hex")}`
  ));
  const members = Array.from({ length: MAX_SEMANTIC_UNITS }, () => []);
  ids.forEach((id, index) => members[index % MAX_SEMANTIC_UNITS].push(id));
  const units = members.map((unitMembers, index) => unit(`unit-${index}`, unitMembers, {
    storyProjection: {
      label: `Synthetic unit ${index}`,
      summary: `Bounded public-safe semantic projection ${index} `.padEnd(300, "x"),
    },
  }));
  const input = manifest(ids, units);
  const manifestBytes = Buffer.byteLength(JSON.stringify(input));
  const started = performance.now();
  const result = await validateSemanticManifestAuthority(input, contributionRecords(ids));
  const elapsedMs = performance.now() - started;
  assert.equal(result.ok, true);
  assert.ok(manifestBytes < MAX_SEMANTIC_MANIFEST_BYTES);
  assert.ok(result.storyProjectionBytes < MAX_STORY_SEMANTIC_PROJECTION_BYTES);
  assert.equal(JSON.stringify(projectSemanticManifestForStory(result.authority)).includes(ids[0]), false);
  assert.ok(elapsedMs < 5_000);
  context.diagnostic(JSON.stringify({
    contributionRecords: ids.length,
    semanticUnits: units.length,
    manifestBytes,
    storyProjectionBytes: result.storyProjectionBytes,
    runtimeMs: Math.round(elapsedMs * 100) / 100,
  }));
});
