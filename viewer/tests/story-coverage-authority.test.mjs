import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  canonicalAuthorityJson,
  finalizeCoverageManifestAuthority,
  normalizeStoryCandidateSubmission,
  validateCoverageRevisionTransition,
  validateCoverageManifestAuthority,
  validateSemanticManifestAuthority,
  validateStoryActivationAuthority,
  validateStorySourcePackage,
} from "../lib/story-readiness.ts";
import { deriveCoveragePrivacyAuthority } from "../lib/story-coverage-privacy-authority.ts";
import { STORY_PREFIX } from "../lib/timeline.ts";

const hash = (value) => createHash("sha256").update(canonicalAuthorityJson(value)).digest("hex");
const contributionRecords = (ids) => ids.map((id) => ({ id, sourceDigest: hash({ id }) }));

function privacyRow(id, itemId, reviewState = "deterministic", overrides = {}) {
  return {
    id,
    item_id: itemId,
    document_id: "doc",
    start_offset: 0,
    end_offset: 1,
    category: "sensitive",
    confidence: "high",
    reason: "PRIVATE_SENTINEL_MUST_NOT_ENTER_COVERAGE",
    review_state: reviewState,
    uncertainty_reason: reviewState === "needs_confirmation" ? "Contributor decision required." : null,
    status: reviewState === "confirmed_keep" ? "removed" : "active",
    created_by: "local-test",
    created_at: "2042-01-01T00:00:00.000Z",
    updated_at: "2042-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function sourcePrivacy(redactions, jobOverrides = {}) {
  return {
    redactions,
    job: {
      id: "source-privacy-current",
      status: "complete",
      stage: "complete",
      model: null,
      completed: redactions.length,
      total: redactions.length,
      rejected: 0,
      source_digest: "9".repeat(64),
      started_at: "2042-01-01T00:00:00.000Z",
      updated_at: "2042-01-01T00:00:00.000Z",
      completed_at: "2042-01-01T00:00:00.000Z",
      ...jobOverrides,
    },
  };
}

async function semanticAuthority(unitBOverrides = {}) {
  const contributionIds = ["doc:item-a", "doc:item-b"];
  const units = [
    { id: "unit-a", kind: "discussion", members: [contributionIds[0]] },
    { id: "unit-b", kind: "routine", members: [contributionIds[1]], ...unitBOverrides },
  ].map((unit) => ({
    ...unit,
    revision: 1,
    projectId: "Synthetic Project",
    memberCount: unit.members.length,
    membershipDigest: hash(unit.members.map((id) => ({ id, sourceDigest: hash({ id }) }))),
  }));
  const core = {
    projectId: "Synthetic Project",
    revision: 1,
    sourceDigest: hash(contributionRecords(contributionIds)),
    universeDigest: hash(contributionIds),
    units,
  };
  const validation = await validateSemanticManifestAuthority(
    { ...core, manifestDigest: hash(core) },
    contributionRecords(contributionIds),
  );
  assert.equal(validation.ok, true);
  return validation.authority;
}

function coverageInput(semantic, rows, overrides = {}) {
  const normalizedRows = rows.map((row) => row.disposition === "excluded" ? {
    unitId: row.unitId,
    disposition: "excluded",
    ownerId: `excluded:${row.unitId}`,
    exclusionReason: row.exclusionReason,
  } : row).sort((left, right) => left.unitId.localeCompare(right.unitId));
  const core = {
    revision: 1,
    semanticManifestRevision: semantic.revision,
    semanticManifestDigest: semantic.manifestDigest,
    rows: normalizedRows,
  };
  return {
    revision: 1,
    semanticManifestRevision: semantic.revision,
    semanticManifestDigest: semantic.manifestDigest,
    coverageDigest: hash(core),
    rows,
    ...overrides,
  };
}

test("coverage is explicit and exhaustive; omission is never inferred complement", async () => {
  const semantic = await semanticAuthority();
  const valid = coverageInput(semantic, [
    { unitId: "unit-a", disposition: "represented", ownerId: "chapter-a" },
    { unitId: "unit-b", disposition: "excluded", exclusionReason: "routine_non_narrative" },
  ]);
  assert.equal((await validateCoverageManifestAuthority(valid, semantic)).ok, true);

  const omitted = coverageInput(semantic, [
    { unitId: "unit-a", disposition: "represented", ownerId: "chapter-a" },
  ]);
  assert.equal((await validateCoverageManifestAuthority(
    omitted, semantic,
  )).code, "COVERAGE_UNIT_MISSING");
});

test("provider-free finalization owns normalized coverage revision and digest", async () => {
  const semantic = await semanticAuthority();
  const rows = [
    { unitId: "unit-a", disposition: "represented", ownerId: "chapter-a" },
    { unitId: "unit-b", disposition: "excluded", exclusionReason: "routine_non_narrative" },
  ];
  const finalized = await finalizeCoverageManifestAuthority({ rows }, semantic);
  assert.equal(finalized.ok, true);
  const submission = {
    revision: finalized.authority.revision,
    semanticManifestRevision: finalized.authority.semanticManifestRevision,
    semanticManifestDigest: finalized.authority.semanticManifestDigest,
    coverageDigest: finalized.authority.coverageDigest,
    rows,
  };
  const validation = await validateCoverageManifestAuthority(submission, semantic);
  assert.equal(validation.ok, true);
  assert.equal(validation.authority.coverageDigest, finalized.authority.coverageDigest);

  const unchanged = await finalizeCoverageManifestAuthority({ rows }, semantic, submission);
  assert.equal(unchanged.ok, true);
  assert.equal(unchanged.authority.revision, 1);
  assert.equal(unchanged.authority.coverageDigest, finalized.authority.coverageDigest);

  const changed = await finalizeCoverageManifestAuthority({ rows: [
    { unitId: "unit-a", disposition: "represented", ownerId: "chapter-b" },
    { unitId: "unit-b", disposition: "excluded", exclusionReason: "routine_non_narrative" },
  ] }, semantic, submission);
  assert.equal(changed.ok, true);
  assert.equal(changed.authority.revision, 2);

  const rejectedActivationRetry = await finalizeCoverageManifestAuthority({ rows: [
    { unitId: "unit-a", disposition: "represented", ownerId: "chapter-b" },
    { unitId: "unit-b", disposition: "excluded", exclusionReason: "routine_non_narrative" },
  ] }, semantic);
  assert.equal(rejectedActivationRetry.ok, true);
  assert.equal(rejectedActivationRetry.authority.revision, 1);

  const nextSemantic = {
    ...semantic,
    revision: 2,
    manifestDigest: "b".repeat(64),
  };
  const semanticChange = await finalizeCoverageManifestAuthority(
    { rows }, nextSemantic, submission,
  );
  assert.equal(semanticChange.ok, true);
  assert.equal(semanticChange.authority.revision, 2);

  const stalePrior = { ...submission, coverageDigest: "f".repeat(64) };
  assert.equal((await finalizeCoverageManifestAuthority(
    { rows }, semantic, stalePrior,
  )).code, "COVERAGE_MANIFEST_DIGEST_STALE");
  const forgedForeignPrior = {
    ...submission,
    revision: 41,
    semanticManifestRevision: 9,
    semanticManifestDigest: "d".repeat(64),
    coverageDigest: "e".repeat(64),
    rows: [],
  };
  assert.equal((await finalizeCoverageManifestAuthority(
    { rows }, semantic, forgedForeignPrior,
  )).code, "COVERAGE_MANIFEST_DIGEST_STALE");
  assert.equal((await finalizeCoverageManifestAuthority(
    { revision: 1, rows }, semantic,
  )).code, "COVERAGE_MANIFEST_INVALID");
});

test("provider-free Privacy projection cannot make a forged membership digest durable", async () => {
  const semantic = await semanticAuthority();
  const forgedCore = {
    projectId: semantic.projectId,
    revision: semantic.revision,
    sourceDigest: semantic.sourceDigest,
    universeDigest: semantic.universeDigest,
    units: semantic.units.map((unit, index) => ({
      ...unit,
      membershipDigest: index === 0 ? "f".repeat(64) : unit.membershipDigest,
    })),
  };
  const forged = { ...forgedCore, manifestDigest: hash(forgedCore) };

  const projection = await deriveCoveragePrivacyAuthority(
    sourcePrivacy([privacyRow("redaction-a", "doc:item-a")]),
    forged,
  );
  assert.equal(projection.ok, true);

  const canonical = await validateSemanticManifestAuthority(
    forged,
    contributionRecords(["doc:item-a", "doc:item-b"]),
  );
  assert.equal(canonical.ok, false);
  assert.equal(canonical.code, "SEMANTIC_MEMBERSHIP_DIGEST_STALE");
});

test("coverage CLI advances only from explicitly server-accepted prior authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "oxygen-coverage-finalizer-"));
  try {
    const repository = fileURLToPath(new URL("../..", import.meta.url));
    const script = join(
      repository, "skills", "oxygen-storytelling-review", "scripts", "finalize_story_coverage.mjs",
    );
    const semantic = await semanticAuthority();
    const semanticPath = join(root, "semantic.json");
    const draftPath = join(root, "draft.json");
    const outputPath = join(root, "coverage.json");
    const acceptedPath = join(root, "accepted.json");
    const sourcePrivacyPath = join(root, "source-privacy.json");
    const firstRows = [
      { unitId: "unit-a", disposition: "represented", ownerId: "chapter-a" },
      { unitId: "unit-b", disposition: "excluded", exclusionReason: "routine_non_narrative" },
    ];
    const changedRows = [
      { unitId: "unit-a", disposition: "represented", ownerId: "chapter-b" },
      { unitId: "unit-b", disposition: "excluded", exclusionReason: "routine_non_narrative" },
    ];
    writeFileSync(semanticPath, JSON.stringify(semantic), "utf8");
    writeFileSync(draftPath, JSON.stringify({ rows: firstRows }), "utf8");
    writeFileSync(sourcePrivacyPath, JSON.stringify(sourcePrivacy([])), "utf8");
    const run = (...extra) => spawnSync(process.execPath, [
      script, semanticPath, draftPath, outputPath,
      "--source-privacy", sourcePrivacyPath,
      ...extra,
    ], { cwd: repository, encoding: "utf8" });
    const missingAuthority = spawnSync(process.execPath, [
      script, semanticPath, draftPath, outputPath,
    ], { cwd: repository, encoding: "utf8" });
    assert.equal(missingAuthority.status, 2);
    assert.match(missingAuthority.stderr, /--source-privacy/);
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const accepted = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.equal(accepted.revision, 1);
    writeFileSync(acceptedPath, JSON.stringify(accepted), "utf8");

    writeFileSync(draftPath, JSON.stringify({ rows: changedRows }), "utf8");
    const rejectedRetry = run();
    assert.equal(rejectedRetry.status, 0, rejectedRetry.stderr);
    assert.equal(JSON.parse(readFileSync(outputPath, "utf8")).revision, 1);

    const acceptedRegeneration = run("--previous", acceptedPath);
    assert.equal(acceptedRegeneration.status, 0, acceptedRegeneration.stderr);
    assert.equal(JSON.parse(readFileSync(outputPath, "utf8")).revision, 2);
    const output = readFileSync(outputPath, "utf8");
    assert.doesNotMatch(output, /PRIVATE_SENTINEL|redactions|source_digest|authorizedUnitIds/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("coverage CLI requires current Source Privacy for privacy_withheld rows and explicit zero", async () => {
  const root = mkdtempSync(join(tmpdir(), "oxygen-coverage-privacy-finalizer-"));
  try {
    const repository = fileURLToPath(new URL("../..", import.meta.url));
    const script = join(
      repository, "skills", "oxygen-storytelling-review", "scripts", "finalize_story_coverage.mjs",
    );
    const semantic = await semanticAuthority({ kind: "discussion" });
    const semanticPath = join(root, "semantic.json");
    const draftPath = join(root, "draft.json");
    const outputPath = join(root, "coverage.json");
    const sourcePrivacyPath = join(root, "source-privacy.json");
    writeFileSync(semanticPath, JSON.stringify(semantic), "utf8");
    const run = () => spawnSync(process.execPath, [
      script, semanticPath, draftPath, outputPath,
      "--source-privacy", sourcePrivacyPath,
    ], { cwd: repository, encoding: "utf8" });
    const privacyRows = [
      { unitId: "unit-a", disposition: "excluded", exclusionReason: "privacy_withheld" },
      { unitId: "unit-b", disposition: "represented", ownerId: "chapter-b" },
    ];
    writeFileSync(draftPath, JSON.stringify({ rows: privacyRows }), "utf8");

    writeFileSync(sourcePrivacyPath, JSON.stringify(sourcePrivacy([
      privacyRow("deterministic-a", "doc:item-a"),
    ])), "utf8");
    const deterministic = run();
    assert.equal(deterministic.status, 0, deterministic.stderr);
    const deterministicOutput = readFileSync(outputPath, "utf8");
    const parsedOutput = JSON.parse(deterministicOutput);
    assert.deepEqual(Object.keys(parsedOutput), [
      "revision", "semanticManifestRevision", "semanticManifestDigest", "coverageDigest", "rows",
    ]);
    assert.deepEqual(parsedOutput.rows[0], {
      unitId: "unit-a", disposition: "excluded", exclusionReason: "privacy_withheld",
    });
    assert.doesNotMatch(
      `${deterministicOutput}${deterministic.stdout}`,
      /PRIVATE_SENTINEL|start_offset|category|reason|authorizedUnitIds/,
    );

    writeFileSync(sourcePrivacyPath, JSON.stringify(sourcePrivacy([
      privacyRow("confirmed-a", "doc:item-a", "confirmed_redact"),
    ])), "utf8");
    assert.equal(run().status, 0);

    for (const state of ["needs_confirmation", "confirmed_keep"]) {
      writeFileSync(sourcePrivacyPath, JSON.stringify(sourcePrivacy([
        privacyRow(`row-${state}`, "doc:item-a", state),
      ])), "utf8");
      const rejected = run();
      assert.equal(rejected.status, 1);
      assert.match(rejected.stderr, /COVERAGE_PRIVACY_AUTHORITY_MISSING/);
    }

    writeFileSync(sourcePrivacyPath, JSON.stringify(sourcePrivacy([])), "utf8");
    const zeroWithPrivacy = run();
    assert.equal(zeroWithPrivacy.status, 1);
    assert.match(zeroWithPrivacy.stderr, /COVERAGE_PRIVACY_AUTHORITY_MISSING/);

    writeFileSync(draftPath, JSON.stringify({ rows: [
      { unitId: "unit-a", disposition: "represented", ownerId: "chapter-a" },
      { unitId: "unit-b", disposition: "represented", ownerId: "chapter-b" },
    ] }), "utf8");
    assert.equal(run().status, 0, "completed-zero is explicit authority for non-Privacy coverage");

    writeFileSync(draftPath, JSON.stringify({ rows: privacyRows }), "utf8");
    writeFileSync(sourcePrivacyPath, JSON.stringify(sourcePrivacy([
      privacyRow("wrong-unit", "doc:item-b"),
    ])), "utf8");
    const wrongUnit = run();
    assert.equal(wrongUnit.status, 1);
    assert.match(wrongUnit.stderr, /COVERAGE_PRIVACY_AUTHORITY_MISSING/);

    writeFileSync(sourcePrivacyPath, Uint8Array.from([0xc3, 0x28]));
    const invalidUtf8 = run();
    assert.equal(invalidUtf8.status, 1);
    assert.match(invalidUtf8.stderr, /encoded data was not valid|UTF-8/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("coverage revisions are monotonic server-owned authority", async () => {
  const semantic = await semanticAuthority();
  const first = await validateCoverageManifestAuthority(coverageInput(semantic, [
    { unitId: "unit-a", disposition: "represented", ownerId: "chapter-a" },
    { unitId: "unit-b", disposition: "excluded", exclusionReason: "routine_non_narrative" },
  ]), semantic);
  assert.equal(first.ok, true);
  assert.equal(validateCoverageRevisionTransition(first.authority, null), null);
  const staleInitial = { ...first.authority, revision: 2 };
  assert.equal(validateCoverageRevisionTransition(staleInitial, null), "COVERAGE_REVISION_STALE");
  assert.equal(validateCoverageRevisionTransition(first.authority, first.authority), null);
  assert.equal(validateCoverageRevisionTransition(
    { ...first.authority, revision: 2 }, first.authority,
  ), "COVERAGE_REVISION_STALE");
  const changed = structuredClone(first.authority);
  changed.revision = 2;
  changed.rows[0].ownerId = "chapter-b";
  assert.equal(validateCoverageRevisionTransition(changed, first.authority), null);
});

test("Story candidate submission derives identity and publishes no raw content", () => {
  const summary = `${STORY_PREFIX}{}`;
  const items = [{
    id: "doc:item-a", documentId: "doc", sequence: 7,
    timestamp: "2026-08-26T00:00:00Z", project: "Synthetic Project",
  }];
  const valid = normalizeStoryCandidateSubmission([{ id: "doc:item-a", summary }], items);
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.rows, [{
    id: "doc:item-a", documentId: "doc", sequence: 7,
    timestamp: "2026-08-26T00:00:00Z", summary,
  }]);
  assert.deepEqual(valid.storyItemsByDocument.get("doc"), [{
    id: "doc:item-a", sequence: 7,
    timestamp: "2026-08-26T00:00:00Z", project: "Synthetic Project", summary,
  }]);
  assert.equal(normalizeStoryCandidateSubmission([
    { id: "doc:missing", summary },
  ], items).code, "STORY_CANDIDATE_ITEM_UNKNOWN");
  assert.equal(normalizeStoryCandidateSubmission([
    { id: "doc:item-a", summary }, { id: "doc:item-a", summary },
  ], items).code, "STORY_CANDIDATE_ITEM_DUPLICATED");
  assert.equal(normalizeStoryCandidateSubmission([
    { id: "doc:item-a", summary: STORY_PREFIX + "x".repeat(2_000_000) },
  ], items).code, "STORY_CANDIDATE_SUBMISSION_TOO_LARGE");
});

test("overlap and unknown ownership fail closed", async () => {
  const semantic = await semanticAuthority();
  const overlap = coverageInput(semantic, [
    { unitId: "unit-a", disposition: "represented", ownerId: "chapter-a" },
    { unitId: "unit-a", disposition: "excluded", exclusionReason: "outside_story_scope" },
    { unitId: "unit-b", disposition: "represented", ownerId: "chapter-b" },
  ]);
  assert.equal((await validateCoverageManifestAuthority(
    overlap, semantic,
  )).code, "COVERAGE_UNIT_DOUBLE_OWNED");

  const unknown = coverageInput(semantic, [
    { unitId: "unit-a", disposition: "represented", ownerId: "chapter-a" },
    { unitId: "unit-c", disposition: "represented", ownerId: "chapter-c" },
  ]);
  assert.equal((await validateCoverageManifestAuthority(
    unknown, semantic,
  )).code, "COVERAGE_UNIT_UNKNOWN");
});

test("exclusion reasons require exact upstream authority", async () => {
  const semantic = await semanticAuthority();
  const invalidRoutine = coverageInput(semantic, [
    { unitId: "unit-a", disposition: "excluded", exclusionReason: "routine_non_narrative" },
    { unitId: "unit-b", disposition: "represented", ownerId: "chapter-b" },
  ]);
  assert.equal((await validateCoverageManifestAuthority(
    invalidRoutine, semantic,
  )).code, "COVERAGE_EXCLUSION_AUTHORITY_INVALID");

  const invalidDuplicate = coverageInput(semantic, [
    { unitId: "unit-a", disposition: "excluded", exclusionReason: "duplicate" },
    { unitId: "unit-b", disposition: "represented", ownerId: "chapter-b" },
  ]);
  assert.equal((await validateCoverageManifestAuthority(
    invalidDuplicate, semantic,
  )).code, "COVERAGE_EXCLUSION_AUTHORITY_INVALID");

  const missingPrivacy = coverageInput(semantic, [
    { unitId: "unit-a", disposition: "excluded", exclusionReason: "privacy_withheld" },
    { unitId: "unit-b", disposition: "represented", ownerId: "chapter-b" },
  ]);
  assert.equal((await validateCoverageManifestAuthority(
    missingPrivacy, semantic,
  )).code, "COVERAGE_PRIVACY_AUTHORITY_MISSING");

  const duplicateSemantic = await semanticAuthority({
    kind: "duplicate",
    duplicateOfUnitId: "unit-a",
  });
  const validDuplicate = coverageInput(duplicateSemantic, [
    { unitId: "unit-a", disposition: "represented", ownerId: "chapter-a" },
    { unitId: "unit-b", disposition: "excluded", exclusionReason: "duplicate" },
  ]);
  assert.equal((await validateCoverageManifestAuthority(
    validDuplicate, duplicateSemantic,
  )).ok, true);

  const explicitOutsideScope = coverageInput(semantic, [
    { unitId: "unit-a", disposition: "represented", ownerId: "chapter-a" },
    { unitId: "unit-b", disposition: "excluded", exclusionReason: "outside_story_scope" },
  ]);
  assert.equal((await validateCoverageManifestAuthority(
    explicitOutsideScope, semantic,
  )).ok, true);
});

test("source Privacy authorizes only exact final-redacted semantic-unit members", async () => {
  const semantic = await semanticAuthority({ kind: "discussion" });
  const deterministic = await deriveCoveragePrivacyAuthority(
    sourcePrivacy([privacyRow("redaction-a", "doc:item-a")]),
    semantic,
  );
  assert.equal(deterministic.ok, true);
  assert.deepEqual([...deterministic.authority.authorizedUnitIds], ["unit-a"]);

  const confirmed = await deriveCoveragePrivacyAuthority(
    sourcePrivacy([privacyRow("redaction-b", "doc:item-b", "confirmed_redact")]),
    semantic,
  );
  assert.equal(confirmed.ok, true);
  assert.deepEqual([...confirmed.authority.authorizedUnitIds], ["unit-b"]);

  for (const state of ["needs_confirmation", "confirmed_keep"]) {
    const result = await deriveCoveragePrivacyAuthority(
      sourcePrivacy([privacyRow(`redaction-${state}`, "doc:item-a", state)]),
      semantic,
    );
    assert.equal(result.ok, true);
    assert.deepEqual([...result.authority.authorizedUnitIds], []);
  }

  const completedZero = await deriveCoveragePrivacyAuthority(sourcePrivacy([]), semantic);
  assert.equal(completedZero.ok, true);
  assert.deepEqual([...completedZero.authority.authorizedUnitIds], []);

  const invalidCases = [
    sourcePrivacy([privacyRow("foreign", "doc:foreign")]),
    sourcePrivacy([
      privacyRow("duplicate", "doc:item-a"),
      privacyRow("duplicate", "doc:item-b", "deterministic", { start_offset: 1, end_offset: 2 }),
    ]),
    sourcePrivacy([], { completed: 1, total: 1 }),
    sourcePrivacy([privacyRow("stale", "doc:item-a")], { status: "stale" }),
    sourcePrivacy([
      privacyRow("later", "doc:item-b"),
      privacyRow("earlier", "doc:item-a"),
    ]),
  ];
  for (const candidate of invalidCases) {
    assert.equal((await deriveCoveragePrivacyAuthority(candidate, semantic)).ok, false);
  }

  const tamperedMembership = structuredClone(semantic);
  tamperedMembership.units[0].members[0] = "doc:item-tampered";
  assert.equal((await deriveCoveragePrivacyAuthority(
    sourcePrivacy([privacyRow("redaction-a", "doc:item-a")]),
    tamperedMembership,
  )).ok, false);
});

function storyCandidate(semantic, coverage, evidenceId = "doc:item-a") {
  const evidence = { documentId: "doc", eventId: evidenceId };
  const source = {
    schema: "oxygen.story",
    key: "chapter-a",
    phase: { id: "phase-a", label: "Discovery" },
    title: "A bounded synthetic chapter",
    overview: "A public-safe synthetic source validates exact coverage ownership.",
    people: [{
      id: "person-a",
      releaseLabel: "Reviewer",
      role: "reviewer",
      description: "The reviewer checked the exact synthetic boundary in this Chapter.",
      localIdentityState: "not_identified",
      evidence: [evidence],
    }],
    story: { blocks: [
      { id: "block-a", text: "The reviewer checked the boundary.", evidence: [evidence] },
      { id: "block-b", text: "The same Evidence supports a later explanation.", evidence: [evidence] },
    ] },
    insights: [],
    evidence: { primary: evidence, supporting: [] },
    coverage: {
      semanticManifest: { revision: semantic.revision, digest: semantic.manifestDigest },
      coverageManifest: { revision: coverage.revision, digest: coverage.coverageDigest },
      representedUnitIds: ["unit-a"],
      excludedUnits: [{ unitId: "unit-b", reason: "routine_non_narrative" }],
    },
  };
  return [{
    id: evidenceId,
    documentId: "doc",
    sequence: 1,
    summary: STORY_PREFIX + JSON.stringify(source),
  }];
}

test("repeat citation remains one coverage owner and excluded Evidence is forbidden", async () => {
  const semantic = await semanticAuthority();
  const coverageValidation = await validateCoverageManifestAuthority(coverageInput(semantic, [
    { unitId: "unit-a", disposition: "represented", ownerId: "chapter-a" },
    { unitId: "unit-b", disposition: "excluded", exclusionReason: "routine_non_narrative" },
  ]), semantic);
  assert.equal(coverageValidation.ok, true);
  const authority = { semanticManifest: semantic, coverageManifest: coverageValidation.authority };
  const evidenceRows = [
    { id: "doc:item-a", documentId: "doc", actorId: "reviewer", actorType: "human" },
    { id: "doc:item-b", documentId: "doc", actorId: "reviewer", actorType: "human" },
  ];
  assert.equal(validateStorySourcePackage(
    storyCandidate(semantic, coverageValidation.authority), evidenceRows, authority,
  ).ok, true);
  const mismatchedCarrier = storyCandidate(semantic, coverageValidation.authority);
  mismatchedCarrier[0].id = "doc:item-b";
  assert.equal(validateStorySourcePackage(
    mismatchedCarrier, evidenceRows, authority,
  ).code, "STORY_EVIDENCE_INVALID");
  assert.equal(validateStorySourcePackage(
    storyCandidate(semantic, coverageValidation.authority, "doc:item-b"), evidenceRows, authority,
  ).code, "STORY_EXCLUDED_EVIDENCE_INVALID");

  const activation = await validateStoryActivationAuthority(
    storyCandidate(semantic, coverageValidation.authority),
    evidenceRows,
    semantic,
    coverageInput(semantic, [
      { unitId: "unit-a", disposition: "represented", ownerId: "chapter-a" },
      { unitId: "unit-b", disposition: "excluded", exclusionReason: "routine_non_narrative" },
    ]),
  );
  assert.equal(activation.ok, true);
  assert.equal(activation.source.chapterCount, 1);
});

test("Story declarations cannot omit a normalized coverage owner", async () => {
  const semantic = await semanticAuthority();
  const coverageValidation = await validateCoverageManifestAuthority(coverageInput(semantic, [
    { unitId: "unit-a", disposition: "represented", ownerId: "chapter-a" },
    { unitId: "unit-b", disposition: "excluded", exclusionReason: "routine_non_narrative" },
  ]), semantic);
  assert.equal(coverageValidation.ok, true);
  const candidate = storyCandidate(semantic, coverageValidation.authority);
  const parsed = JSON.parse(candidate[0].summary.slice(STORY_PREFIX.length));
  parsed.coverage.excludedUnits = [];
  candidate[0].summary = STORY_PREFIX + JSON.stringify(parsed);
  const result = validateStorySourcePackage(candidate, [
    { id: "doc:item-a", documentId: "doc", actorId: "reviewer", actorType: "human" },
  ], { semanticManifest: semantic, coverageManifest: coverageValidation.authority });
  assert.equal(result.code, "STORY_COVERAGE_INVALID");
});

test("represented ownership requires narrative use, not an unused supporting inventory row", async () => {
  const semantic = await semanticAuthority({ kind: "discussion" });
  const coverageValidation = await validateCoverageManifestAuthority(coverageInput(semantic, [
    { unitId: "unit-a", disposition: "represented", ownerId: "chapter-a" },
    { unitId: "unit-b", disposition: "represented", ownerId: "chapter-a" },
  ]), semantic);
  assert.equal(coverageValidation.ok, true);
  const candidate = storyCandidate(semantic, coverageValidation.authority);
  const parsed = JSON.parse(candidate[0].summary.slice(STORY_PREFIX.length));
  parsed.coverage.representedUnitIds = ["unit-a", "unit-b"];
  parsed.coverage.excludedUnits = [];
  parsed.evidence.supporting = [{ documentId: "doc", eventId: "doc:item-b" }];
  candidate[0].summary = STORY_PREFIX + JSON.stringify(parsed);
  const evidenceRows = [
    { id: "doc:item-a", documentId: "doc", actorId: "reviewer", actorType: "human" },
    { id: "doc:item-b", documentId: "doc", actorId: "reviewer", actorType: "human" },
  ];
  const result = validateStorySourcePackage(candidate, evidenceRows, {
    semanticManifest: semantic,
    coverageManifest: coverageValidation.authority,
  });
  assert.equal(result.code, "STORY_COVERAGE_INVALID");
  parsed.story.blocks[0].evidence.push({ documentId: "doc", eventId: "doc:item-b" });
  candidate[0].summary = STORY_PREFIX + JSON.stringify(parsed);
  assert.equal(validateStorySourcePackage(candidate, evidenceRows, {
    semanticManifest: semantic,
    coverageManifest: coverageValidation.authority,
  }).ok, true);
});

test("coverage bookkeeping remains bounded at 512 units", async (context) => {
  const semantic = {
    projectId: "Synthetic Project",
    revision: 1,
    sourceDigest: "c".repeat(64),
    universeDigest: "d".repeat(64),
    manifestDigest: "e".repeat(64),
    serializedBytes: 0,
    units: Array.from({ length: 512 }, (_, index) => ({
      id: `unit-${index}`,
      revision: 1,
      projectId: "Synthetic Project",
      kind: "progression",
      members: [`source:event-${index}`],
      memberCount: 1,
      membershipDigest: "f".repeat(64),
    })),
  };
  const rows = semantic.units.map((unit, index) => ({
    unitId: unit.id,
    disposition: "represented",
    ownerId: `chapter-${index % 24}`,
  }));
  const input = coverageInput(semantic, rows);
  const started = performance.now();
  const result = await validateCoverageManifestAuthority(input, semantic);
  const elapsedMs = performance.now() - started;
  assert.equal(result.ok, true);
  assert.ok(result.authority.serializedBytes < 250_000);
  assert.equal(JSON.stringify(result.authority).includes("source:event-0"), false);
  assert.ok(elapsedMs < 5_000);
  context.diagnostic(JSON.stringify({
    coverageRows: rows.length,
    coverageBytes: result.authority.serializedBytes,
    runtimeMs: Math.round(elapsedMs * 100) / 100,
  }));

  const oversized = { ...input, padding: "x".repeat(250_000) };
  assert.equal((await validateCoverageManifestAuthority(
    oversized, semantic,
  )).code, "COVERAGE_MANIFEST_TOO_LARGE");
});
