import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
