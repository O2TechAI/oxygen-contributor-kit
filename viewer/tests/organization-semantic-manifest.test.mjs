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
  projectSemanticManifestForStory,
  validateSemanticRevisionTransition,
  validateSemanticManifestAuthority,
} from "../lib/story-readiness.ts";

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
        schema_version: "0.2",
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
      schema_version: "0.2",
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
    writeFileSync(join(root, "project-map.json"), JSON.stringify({
      semantic_units: [{
        id: "unit-parity", kind: "discussion", members: [contributionId],
      }],
    }), "utf8");
    const finalized = spawnSync("python", [
      script, root, "--primary-project", "Synthetic Project",
      "--summary", "Cross-runtime parity.", "--finalize",
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
    schema_version: "0.2",
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
    schema_version: "0.2",
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
