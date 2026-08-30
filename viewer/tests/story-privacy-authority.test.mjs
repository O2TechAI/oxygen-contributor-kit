import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  deriveStoryReleaseTargetContents,
  normalizeStoryPrivacyOutput,
  storyPreparationDigest,
} from "../lib/story-preparation.ts";
import { seedCoveragePrivacyAuthority } from "./story-coverage-privacy-fixture.mjs";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL && specifier.startsWith(".")) {
      const resolvedPath = fileURLToPath(new URL(specifier, context.parentURL));
      if (!extname(resolvedPath)) {
        if (existsSync(`${resolvedPath}.ts`)) return nextResolve(`${specifier}.ts`, context);
        if (existsSync(join(resolvedPath, "index.ts"))) return nextResolve(`${specifier}/index.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const RUN_ID = "story-privacy-run";
const SOURCE_REVISION = 7;
const DECIDED_AT = "2041-01-01T00:00:00.000Z";
const utf8Sort = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));

function story(key) {
  const evidence = { documentId: "doc", eventId: `doc:${key}` };
  return {
    schema: "oxygen.story",
    key,
    phase: { id: `phase-${key}`, label: "Build" },
    title: `Chapter ${key}`,
    overview: key === "a" ? "PRIVATE_SOURCE_SENTINEL" : `Overview ${key}.`,
    people: [{
      id: `person-${key}`, releaseLabel: "Contributor", role: "Owner",
      description: `Owner ${key}.`, localIdentityState: "not_identified", evidence: [evidence],
    }],
    story: { blocks: [{ id: `block-${key}`, text: `Block ${key}.`, evidence: [evidence] }] },
    insights: [],
    evidence: { primary: evidence, supporting: [] },
    coverage: {
      semanticManifest: { revision: 1, digest: "b".repeat(64) },
      coverageManifest: { revision: 1, digest: "c".repeat(64) },
      representedUnitIds: [], excludedUnits: [],
    },
  };
}

const STORIES = [story("a"), story("b")];
let ACTIVE_DIGEST = "";
let STORY_PRIVACY_INPUT_DIGEST = "";

const deterministic = {
  id: "deterministic-candidate",
  reviewState: "deterministic",
  title: "Already safe",
  whyFlagged: "A deterministic rule already resolved this target.",
  uncertaintyReason: null,
  releaseTargets: ["a::overview"],
};
const crossChapter = {
  id: "candidate-cross-chapter",
  reviewState: "needs_confirmation",
  title: "One candidate, two target choices",
  whyFlagged: "The candidate affects two Chapters.",
  uncertaintyReason: "Contributor confirmation is required.",
  releaseTargets: ["a::title", "b::story:block-b"],
};
const privateUseId = {
  id: "\uE000-candidate",
  reviewState: "needs_confirmation",
  title: "First by UTF-8",
  whyFlagged: "Ordering proof.",
  uncertaintyReason: "Contributor confirmation is required.",
  releaseTargets: ["a::title"],
};
const astralId = {
  id: "\u{10000}-candidate",
  reviewState: "needs_confirmation",
  title: "Second by UTF-8",
  whyFlagged: "Ordering proof.",
  uncertaintyReason: "Contributor confirmation is required.",
  releaseTargets: ["b::title"],
};

async function proposalFor(target, category) {
  const targetContentDigest = await storyPreparationDigest(target.content);
  if (!category) {
    return {
      targetId: target.id,
      targetContentDigest,
      proposedText: target.content,
      occurrences: [],
    };
  }
  const original = Array.from(target.content);
  let originalEndOffset = original.length;
  while (originalEndOffset > 0 && !/[\p{L}\p{N}_-]/u.test(original[originalEndOffset - 1])) {
    originalEndOffset -= 1;
  }
  let originalStartOffset = originalEndOffset;
  while (originalStartOffset > 0 && /[\p{L}\p{N}_-]/u.test(original[originalStartOffset - 1])) {
    originalStartOffset -= 1;
  }
  assert.ok(originalStartOffset < originalEndOffset);
  const proposedText = "Anonymous";
  const proposal = [
    ...original.slice(0, originalStartOffset),
    ...Array.from(proposedText),
    ...original.slice(originalEndOffset),
  ].join("");
  return {
    targetId: target.id,
    targetContentDigest,
    proposedText: proposal,
    occurrences: [{
      originalStartOffset,
      originalEndOffset,
      proposalStartOffset: originalStartOffset,
      proposalEndOffset: originalStartOffset + Array.from(proposedText).length,
      category,
    }],
  };
}

async function replaceAuthority(db, candidates, { credentialTargets = [] } = {}) {
  const targets = deriveStoryReleaseTargetContents(STORIES);
  assert.ok(targets);
  const categories = new Map(candidates.flatMap((candidate) => candidate.releaseTargets)
    .map((targetId) => [targetId, credentialTargets.includes(targetId)
      ? "credential" : "private-identity"]));
  const privacy = await normalizeStoryPrivacyOutput({
    candidates,
    targetProposals: await Promise.all(targets
      .map((target) => proposalFor(target, categories.get(target.id)))),
  }, targets);
  assert.ok(privacy);
  const pending = new Set(privacy.candidates
    .filter((candidate) => candidate.reviewState === "needs_confirmation")
    .flatMap((candidate) => candidate.releaseTargets));

  await db.prepare("DELETE FROM story_privacy_candidates WHERE workflow_run_id=?").bind(RUN_ID).run();
  await db.prepare("DELETE FROM story_privacy_targets WHERE workflow_run_id=?").bind(RUN_ID).run();
  await db.prepare("DELETE FROM story_privacy_authorities WHERE workflow_run_id=?").bind(RUN_ID).run();
  await db.prepare("DELETE FROM story_preparation_receipts WHERE workflow_run_id=? AND lane='story_privacy'")
    .bind(RUN_ID).run();
  await db.prepare(`INSERT INTO story_preparation_receipts
    (workflow_run_id,lane,source_revision,input_digest,scope_digest,scope_count,
     output_digest,output_count,completed_at) VALUES (?,'story_privacy',?,?,?,?,?,?,?)`).bind(
    RUN_ID,
    SOURCE_REVISION,
    STORY_PRIVACY_INPUT_DIGEST,
    await storyPreparationDigest(targets.map((target) => target.id)),
    targets.length,
    await storyPreparationDigest(privacy),
    privacy.targetProposals.length,
    DECIDED_AT,
  ).run();
  for (const candidate of privacy.candidates) {
    await db.prepare(`INSERT INTO story_privacy_candidates
      (workflow_run_id,candidate_id,candidate_json) VALUES (?,?,?)`)
      .bind(RUN_ID, candidate.id, JSON.stringify(candidate)).run();
  }
  for (const proposal of privacy.targetProposals) {
    const unresolved = pending.has(proposal.targetId);
    await db.prepare(`INSERT INTO story_privacy_targets
      (workflow_run_id,target_id,target_content_digest,proposed_text,occurrences_json,
       selected_text,public_overrides_json,decided_at) VALUES (?,?,?,?,?,?,'[]',?)`).bind(
      RUN_ID,
      proposal.targetId,
      proposal.targetContentDigest,
      proposal.proposedText,
      JSON.stringify(proposal.occurrences),
      unresolved ? null : proposal.proposedText,
      unresolved ? null : DECIDED_AT,
    ).run();
  }
  return privacy;
}

async function insertAuthority(db, candidates) {
  await db.prepare(`INSERT INTO workflow_runs
    (id,story_generation_status,story_source_revision,active_story_digest,created_at,updated_at)
    VALUES (?,'ready_for_human_review',?,?,?,?)`)
    .bind(RUN_ID, SOURCE_REVISION, "0".repeat(64), DECIDED_AT, DECIDED_AT).run();
  await db.prepare(`INSERT INTO documents
    (id,kind,title,item_count,imported_at,updated_at)
    VALUES ('doc','trajectory','Synthetic source',?,?,?)`)
    .bind(STORIES.length, DECIDED_AT, DECIDED_AT).run();
  for (const [sequence, source] of STORIES.entries()) {
    await db.prepare(`INSERT INTO items
      (id,document_id,sequence,timestamp,content,original_json,organization_reason,
       event_type,actor_id,actor_type)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
      `doc:${source.key}`,
      "doc",
      sequence + 1,
      null,
      "private source",
      "{}",
      `oxygen.story:${JSON.stringify(source)}`,
      "message",
      `contributor-${source.key}`,
      "human",
    ).run();
  }
  const seeded = await seedCoveragePrivacyAuthority(db, {
    workflowRunId: RUN_ID,
    sourceRevision: SOURCE_REVISION,
    stories: STORIES,
    now: DECIDED_AT,
  });
  ACTIVE_DIGEST = seeded.activeStoryDigest;
  STORY_PRIVACY_INPUT_DIGEST = seeded.storyPrivacyInputDigest;
  return replaceAuthority(db, candidates);
}

const get = (route, workflowRunId = RUN_ID) => route.GET(new Request(
  `http://localhost/api/story-privacy?workflowRunId=${encodeURIComponent(workflowRunId)}`,
));
const patch = (route, id, body) => route.PATCH(new Request(
  `http://localhost/api/story-privacy/${encodeURIComponent(id)}`,
  { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
), { params: Promise.resolve({ id }) });
const targetChoice = (authority, targetId, choice = { editedText: null, publicOverrides: [] }) => {
  const target = authority.targets.find((value) => value.targetId === targetId);
  assert.ok(target);
  return {
    workflowRunId: authority.workflowRunId,
    sourceRevision: authority.sourceRevision,
    activeStoryDigest: authority.activeStoryDigest,
    authorityDigest: authority.authorityDigest,
    targetContentDigest: target.targetContentDigest,
    ...choice,
  };
};
const targetRow = (db, targetId) => db.prepare(`SELECT target_content_digest,proposed_text,
  occurrences_json,selected_text,public_overrides_json,decided_at
  FROM story_privacy_targets WHERE workflow_run_id=? AND target_id=?`).bind(RUN_ID, targetId).first();

test("Story Privacy routes expose one exact target-choice authority and fail closed", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "oxygen-story-privacy-authority-"));
  const previousStateDir = process.env.OXYGEN_VIEWER_STATE_DIR;
  process.env.OXYGEN_VIEWER_STATE_DIR = stateDir;
  try {
    const [{ getLocalDatabase }, collectionRoute, targetRoute] = await Promise.all([
      import("../db/index.ts"),
      import("../app/api/story-privacy/route.ts"),
      import("../app/api/story-privacy/[id]/route.ts"),
    ]);
    assert.equal("DELETE" in targetRoute, false);
    const db = await getLocalDatabase();
    const candidates = [astralId, crossChapter, deterministic, privateUseId];
    await insertAuthority(db, candidates);

    const currentResponse = await get(collectionRoute);
    assert.equal(currentResponse.status, 200);
    assert.equal(currentResponse.headers.get("cache-control"), "no-store, max-age=0");
    const current = await currentResponse.json();
    assert.deepEqual(Object.keys(current).sort(), [
      "activeStoryDigest", "authorityDigest", "candidates", "sourceRevision",
      "status", "targets", "workflowRunId",
    ].sort());
    assert.equal(current.workflowRunId, RUN_ID);
    assert.equal(current.sourceRevision, SOURCE_REVISION);
    assert.equal(current.activeStoryDigest, ACTIVE_DIGEST);
    assert.match(current.authorityDigest, /^[0-9a-f]{64}$/u);
    assert.equal(current.status, "completed_with_candidates");
    assert.deepEqual(current.candidates, candidates
      .sort((left, right) => utf8Sort(left.id, right.id))
      .map((candidate) => ({
        ...candidate,
        resolved: candidate.reviewState === "deterministic",
      })));
    assert.equal(current.targets.length, deriveStoryReleaseTargetContents(STORIES).length);
    assert.equal(current.targets.find((target) => target.targetId === "a::overview").selectedText,
      "Anonymous");
    assert.equal(current.targets.find((target) => target.targetId === "a::title").selectedText, null);
    assert.deepEqual(Object.keys(current.targets[0]).sort(), [
      "decidedAt", "edited", "occurrences", "originalText", "proposedText",
      "selectedText", "targetContentDigest", "targetId",
    ].sort());
    assert.equal(JSON.stringify(current).includes("candidate_json"), false);
    assert.equal(JSON.stringify(current).includes("PRIVATE_PROVIDER_SENTINEL"), false);

    const firstTarget = "a::title";
    const originalRow = await targetRow(db, firstTarget);
    for (const invalid of [
      { ...targetChoice(current, firstTarget), extra: true },
      { ...targetChoice(current, firstTarget), authorityDigest: "not-a-digest" },
      { ...targetChoice(current, firstTarget), editedText: "Public", publicOverrides: [{
        originalStartOffset: 0, originalEndOffset: 1, category: "private-identity",
      }] },
      Object.fromEntries(Object.entries(targetChoice(current, firstTarget))
        .filter(([key]) => key !== "activeStoryDigest")),
    ]) {
      assert.equal((await patch(targetRoute, firstTarget, invalid)).status, 400);
      assert.deepEqual(await targetRow(db, firstTarget), originalRow);
    }
    for (const stale of [
      { ...targetChoice(current, firstTarget), sourceRevision: SOURCE_REVISION - 1 },
      { ...targetChoice(current, firstTarget), activeStoryDigest: "f".repeat(64) },
      { ...targetChoice(current, firstTarget), authorityDigest: "f".repeat(64) },
    ]) {
      assert.equal((await patch(targetRoute, firstTarget, stale)).status, 409);
      assert.deepEqual(await targetRow(db, firstTarget), originalRow);
    }
    assert.equal((await patch(targetRoute, firstTarget, {
      ...targetChoice(current, firstTarget),
      targetContentDigest: "f".repeat(64),
    })).status, 404);
    assert.equal((await patch(targetRoute, "missing-target", targetChoice(current, firstTarget))).status, 404);
    assert.deepEqual(await targetRow(db, firstTarget), originalRow);

    await db.prepare(`INSERT INTO project_release_confirmations
      (workflow_run_id,review_gate_digest,confirmed_at) VALUES (?,?,?)`)
      .bind(RUN_ID, "1".repeat(64), DECIDED_AT).run();
    await db.prepare(`CREATE TRIGGER fail_story_privacy_confirmation_delete
      BEFORE DELETE ON project_release_confirmations
      WHEN OLD.workflow_run_id='story-privacy-run'
      BEGIN SELECT RAISE(ABORT,'injected rollback'); END`).run();
    assert.equal((await patch(targetRoute, firstTarget, targetChoice(current, firstTarget))).status, 409);
    assert.deepEqual(await targetRow(db, firstTarget), originalRow);
    assert.equal(Number((await db.prepare(`SELECT COUNT(*) AS count
      FROM project_release_confirmations WHERE workflow_run_id=?`).bind(RUN_ID).first()).count), 1);
    await db.prepare("DROP TRIGGER fail_story_privacy_confirmation_delete").run();

    const concurrentChoices = await Promise.all([
      patch(targetRoute, firstTarget, targetChoice(current, firstTarget)),
      patch(targetRoute, firstTarget, targetChoice(current, firstTarget)),
    ]);
    assert.deepEqual(concurrentChoices.map((response) => response.status).sort(), [200, 409]);
    const firstResponse = concurrentChoices.find((response) => response.status === 200);
    assert.ok(firstResponse);
    const first = await firstResponse.json();
    assert.notEqual(first.authorityDigest, current.authorityDigest);
    assert.equal(first.candidates.find((candidate) => candidate.id === crossChapter.id).resolved, false);
    assert.equal(first.candidates.find((candidate) => candidate.id === privateUseId.id).resolved, true);
    assert.equal(first.targets.find((target) => target.targetId === firstTarget).selectedText,
      "Chapter Anonymous");
    assert.equal(Number((await db.prepare(`SELECT COUNT(*) AS count
      FROM project_release_confirmations WHERE workflow_run_id=?`).bind(RUN_ID).first()).count), 0);

    const secondTarget = "b::story:block-b";
    const secondReview = first.targets.find((target) => target.targetId === secondTarget);
    assert.ok(secondReview);
    const publicOverrides = secondReview.occurrences.map((occurrence) => ({
      originalStartOffset: occurrence.originalStartOffset,
      originalEndOffset: occurrence.originalEndOffset,
      category: occurrence.category,
    }));
    const secondResponse = await patch(targetRoute, secondTarget, targetChoice(first, secondTarget, {
      editedText: null,
      publicOverrides,
    }));
    assert.equal(secondResponse.status, 200);
    const second = await secondResponse.json();
    assert.equal(second.candidates.find((candidate) => candidate.id === crossChapter.id).resolved, true);
    const published = second.targets.find((target) => target.targetId === secondTarget);
    assert.equal(published.selectedText, published.originalText);
    assert.equal(published.edited, false);
    assert.ok(published.occurrences.every((occurrence) => occurrence.isPublic));

    const editedResponse = await patch(targetRoute, firstTarget, targetChoice(second, firstTarget, {
      editedText: "Public wording",
      publicOverrides: [],
    }));
    assert.equal(editedResponse.status, 200);
    const edited = await editedResponse.json();
    assert.equal(edited.targets.find((target) => target.targetId === firstTarget).selectedText,
      "Public wording");
    assert.equal(edited.targets.find((target) => target.targetId === firstTarget).edited, true);
    const restoredResponse = await patch(targetRoute, firstTarget, targetChoice(edited, firstTarget));
    assert.equal(restoredResponse.status, 200);
    const restored = await restoredResponse.json();
    assert.equal(restored.targets.find((target) => target.targetId === firstTarget).selectedText,
      "Chapter Anonymous");
    assert.equal(restored.targets.find((target) => target.targetId === firstTarget).edited, false);

    const credentialTarget = "a::overview";
    const credentialCandidate = {
      ...crossChapter,
      id: "credential-candidate",
      releaseTargets: [credentialTarget],
    };
    await replaceAuthority(db, [credentialCandidate], { credentialTargets: [credentialTarget] });
    const credentialAuthority = await get(collectionRoute).then((response) => response.json());
    const credentialReview = credentialAuthority.targets
      .find((target) => target.targetId === credentialTarget);
    assert.ok(credentialReview);
    assert.equal(credentialReview.occurrences[0].canPublish, false);
    const credentialRow = await targetRow(db, credentialTarget);
    const credentialOverride = credentialReview.occurrences.map((occurrence) => ({
      originalStartOffset: occurrence.originalStartOffset,
      originalEndOffset: occurrence.originalEndOffset,
      category: occurrence.category,
    }));
    assert.equal((await patch(targetRoute, credentialTarget, targetChoice(
      credentialAuthority,
      credentialTarget,
      { editedText: null, publicOverrides: credentialOverride },
    ))).status, 409);
    assert.equal((await patch(targetRoute, credentialTarget, targetChoice(
      credentialAuthority,
      credentialTarget,
      { editedText: "Bearer eyJabcdefgh.abcdefghijkl.abcdefghijkl", publicOverrides: [] },
    ))).status, 409);
    assert.deepEqual(await targetRow(db, credentialTarget), credentialRow);

    await replaceAuthority(db, []);
    const emptyResponse = await get(collectionRoute);
    assert.equal(emptyResponse.status, 200);
    const emptyAuthority = await emptyResponse.json();
    assert.equal(emptyAuthority.status, "completed_empty");
    assert.deepEqual(emptyAuthority.candidates, []);
    assert.equal(emptyAuthority.targets.length, deriveStoryReleaseTargetContents(STORIES).length);
    assert.ok(emptyAuthority.targets.every((target) => target.selectedText === target.originalText
      && target.proposedText === target.originalText && target.occurrences.length === 0));

    const assertCorruptionClosed = async (mutate) => {
      await replaceAuthority(db, [crossChapter]);
      await mutate();
      assert.equal((await get(collectionRoute)).status, 409);
    };
    await assertCorruptionClosed(() => db.prepare(`UPDATE story_preparation_receipts
      SET output_count=output_count+1 WHERE workflow_run_id=? AND lane='story_privacy'`)
      .bind(RUN_ID).run());
    await assertCorruptionClosed(() => db.prepare(`UPDATE story_privacy_candidates
      SET candidate_json='{' WHERE workflow_run_id=? AND candidate_id=?`)
      .bind(RUN_ID, crossChapter.id).run());
    await assertCorruptionClosed(() => db.prepare(`UPDATE story_privacy_targets
      SET target_content_digest=? WHERE workflow_run_id=? AND target_id=?`)
      .bind("f".repeat(64), RUN_ID, firstTarget).run());
    await replaceAuthority(db, [crossChapter]);

    assert.equal((await get(collectionRoute, "foreign-run")).status, 404);
    await db.prepare("INSERT INTO workflow_runs (id,created_at,updated_at) VALUES ('second-run','x','x')")
      .run();
    assert.equal((await get(collectionRoute)).status, 409);
  } finally {
    globalThis.__oxygenLocalSqlite?.database.close();
    delete globalThis.__oxygenLocalSqlite;
    if (previousStateDir === undefined) delete process.env.OXYGEN_VIEWER_STATE_DIR;
    else process.env.OXYGEN_VIEWER_STATE_DIR = previousStateDir;
    await rm(stateDir, { recursive: true, force: true });
  }
});
