import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { syntheticPrivacyOutput, syntheticInheritedMatches } from "./fixtures/chapter-privacy.mjs";
import { deriveStoryReleaseTargetContents, normalizeStoryPrivacyOutput, storyPreparationDigest } from "../lib/story-preparation.ts";
import { storyPrivacyTargetView } from "../app/story-privacy-ui.ts";
import { updateAiInsightDecision } from "../lib/story-review.ts";
import { buildReviewedStoryPrivacyPreparationSnapshot, importReviewedStoryPrivacyAuthority } from "../lib/story-privacy-authority.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedChapterPrivacy } from "./fixtures/chapter-privacy.mjs";
import { applyStoryChapterReview, readStoryPrivacyAuthority } from "../lib/story-privacy-authority.ts";
import { readStoryReviewSessionRecord } from "../lib/story-review-session-server.ts";
import { reconstructReviewedStoryReleaseFromDatabase } from "../lib/story-release-server.ts";

test("Chapter Apply rolls back every write, retains drafts on CAS loss, and isolates a bad sibling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oxygen-chapter-apply-"));
  const previous = process.env.OXYGEN_VIEWER_STATE_DIR;
  process.env.OXYGEN_VIEWER_STATE_DIR = directory;
  try {
    const { getLocalDatabase } = await import("../db/index.ts");
    const db = await getLocalDatabase();
    const fixture = await seedChapterPrivacy(db);
    fixture.session.privacyDrafts = Object.fromEntries(["a", "b"].map((key) => {
      const target = fixture.sources.find((source) => source.key === key);
      return [`${key}::overview`, { targetContentDigest: null, proposedText: target.overview, editedText: null, publicOverrides: [] }];
    }));
    const { storyPreparationDigest } = await import("../lib/story-preparation.ts");
    for (const draft of Object.values(fixture.session.privacyDrafts)) draft.targetContentDigest = await storyPreparationDigest(draft.proposedText);
    await db.prepare("UPDATE story_review_sessions SET state_json=? WHERE workflow_run_id=?")
      .bind(JSON.stringify({ sourceRevision: fixture.sourceRevision, session: fixture.session }), fixture.run).run();
    const current = await readStoryPrivacyAuthority(db, fixture.run);
    assert.ok(current.ok, JSON.stringify(current));
    assert.equal(current.authority.chapterErrors.b, "direct_evidence");
    const input = { workflowRunId: fixture.run, sourceRevision: fixture.sourceRevision,
      chapterKey: "a", expectedVersion: 1, authorityDigest: current.authority.authorityDigest,
      choices: current.authority.targets.filter((target) => target.targetId.startsWith("a::"))
        .map((target) => ({ targetId: target.targetId, targetContentDigest: target.targetContentDigest,
          editedText: null, publicOverrides: [] })) };
    const snapshot = async () => ({ session: await readStoryReviewSessionRecord(db, fixture.run),
      rows: (await db.prepare("SELECT * FROM story_privacy_targets ORDER BY target_id").all()).results });
    const before = await snapshot();
    await db.prepare(`CREATE TRIGGER synthetic_apply_failure BEFORE UPDATE ON story_review_sessions
      BEGIN SELECT RAISE(ABORT,'Synthetic write failure'); END`).run();
    assert.equal((await applyStoryChapterReview(db, input, fixture.now)).ok, false);
    assert.deepEqual(await snapshot(), before);
    await db.prepare("DROP TRIGGER synthetic_apply_failure").run();
    const originalPrepare = db.prepare.bind(db); let sourceReads = 0;
    db.prepare = (sql) => { if (sql.includes("SELECT id,document_id,content FROM items")) sourceReads++; return originalPrepare(sql); };
    const applied = await applyStoryChapterReview(db, input, fixture.now);
    db.prepare = originalPrepare;
    assert.ok(input.choices.length > 5);
    assert.equal(sourceReads, 2, "the whole-run Privacy snapshot is read once before and once after, independent of target count");
    assert.ok(applied.ok, JSON.stringify(applied));
    assert.equal(applied.session.chapterReviews.a.stage, "revision_ready");
    assert.deepEqual(applied.session.chapterReviews.b, before.session.session.chapterReviews.b);
    assert.deepEqual(applied.session.privacyDrafts, { "b::overview": before.session.session.privacyDrafts["b::overview"] });
    assert.ok(applied.authority.targets.filter((target) => target.targetId.startsWith("a::")).every((target) => target.selectedText !== null));
    assert.ok(applied.authority.targets.filter((target) => target.targetId.startsWith("b::")).every((target) => target.selectedText === null));
    const after = await snapshot();
    assert.equal((await applyStoryChapterReview(db, input, fixture.now)).ok, false);
    assert.deepEqual(await snapshot(), after);
    const release = await reconstructReviewedStoryReleaseFromDatabase(db, {
      workflowRunId: fixture.run, sourceRevision: fixture.sourceRevision, serverVersion: applied.serverVersion,
    });
    assert.equal(release.ok, false, "the unapplied sibling cannot enter release");
    const { PATCH } = await import("../app/api/story-privacy/[id]/route.ts");
    assert.equal((await PATCH()).status, 405);
    assert.deepEqual(await snapshot(), after);
  } finally {
    globalThis.__oxygenLocalSqlite?.database.close(); delete globalThis.__oxygenLocalSqlite;
    if (previous === undefined) delete process.env.OXYGEN_VIEWER_STATE_DIR; else process.env.OXYGEN_VIEWER_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});


test("legacy same-byte source proof refresh and exact custom draft use the public transport before atomic Apply", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oxygen-prospective-privacy-"));
  const previous = process.env.OXYGEN_VIEWER_STATE_DIR;
  process.env.OXYGEN_VIEWER_STATE_DIR = join(directory, "state");
  try {
    const { getLocalDatabase } = await import("../db/index.ts");
    const db = await getLocalDatabase();
    const fixture = await seedChapterPrivacy(db, { interactive: true, badSecondChapter: false });
    const targetId = "a::story:passage";
    const initial = await readStoryPrivacyAuthority(db, fixture.run);
    assert.ok(initial.ok, JSON.stringify(initial));
    // A historical fixture has valid immutable receipt shape, but no source-match proof.
    const row = await db.prepare("SELECT occurrences_json FROM story_privacy_targets WHERE target_id=?").bind(targetId).first();
    await db.prepare("UPDATE story_privacy_targets SET occurrences_json=? WHERE target_id=?")
      .bind(JSON.stringify(JSON.parse(row.occurrences_json).occurrences), targetId).run();
    const targetRows = (await db.prepare("SELECT * FROM story_privacy_targets").all()).results;
    const targets = deriveStoryReleaseTargetContents(fixture.sources);
    const legacy = await normalizeStoryPrivacyOutput({
      candidates: initial.authority.candidates.map(({ resolved, ...candidate }) => candidate),
      targetProposals: targets.map((target) => {
        const row = targetRows.find((row) => row.target_id === target.id), stored = JSON.parse(row.occurrences_json);
        return { targetId: target.id, targetContentDigest: row.target_content_digest, proposedText: row.proposed_text,
          ...(Array.isArray(stored) ? { occurrences: stored } : stored) };
      }),
    }, targets);
    assert.ok(legacy);
    await db.prepare("UPDATE story_preparation_receipts SET output_digest=? WHERE lane='story_privacy'")
      .bind(await storyPreparationDigest(legacy)).run();
    const preparation = await buildReviewedStoryPrivacyPreparationSnapshot(db, fixture.run);
    assert.ok(preparation.ok, JSON.stringify(preparation));
    assert.deepEqual(preparation.snapshot.changedTargets.map((target) => target.id), [targetId]);
    assert.equal(preparation.snapshot.targetTransitions[0].contentDigest, preparation.snapshot.targetTransitions[0].previousContentDigest);
    const scripts = join(import.meta.dirname, "../../skills/oxygen-storytelling-review/scripts");
    const execFile = promisify(execFileCallback);
    const transport = async (snapshot, name, { edited = false, prepareOnly = false } = {}) => {
      const root = join(directory, name); await mkdir(root);
      const snapshotPath = join(root, "snapshot.json"), prepared = join(root, "prepared"), proposals = join(root, "proposals");
      await writeFile(snapshotPath, JSON.stringify(snapshot));
      await execFile(process.execPath, [join(scripts, "prepare_reviewed_story_privacy.mjs"), snapshotPath, prepared]);
      if (prepareOnly) return;
      await mkdir(proposals);
      const manifest = JSON.parse(await readFile(join(prepared, "manifest.json"), "utf8"));
      for (const shard of manifest.shards) {
        const input = JSON.parse(await readFile(join(prepared, shard.inputPath), "utf8"));
        const privacy = await syntheticPrivacyOutput(input.targets, input.sourceRedactions);
        if (edited) for (const target of input.targets.filter((target) => target.editedText !== undefined)) {
          const proposal = privacy.targetProposals.find((proposal) => proposal.targetId === target.id);
          proposal.editedProposal = { inputDigest: await storyPreparationDigest(target.editedText), text: target.editedText,
            sourceMatches: syntheticInheritedMatches(target.editedText, input.sourceRedactions).map((match) => ({ ...match,
              relation: "unrelated", reason: "The synthetic edited sentence names a public game label, separate from the marked internal project." })) };
        }
        await writeFile(join(proposals, `${shard.id}.proposals.json`), JSON.stringify(privacy));
      }
      const bundlePath = join(root, "bundle.json");
      await execFile(process.execPath, [join(scripts, "finalize_reviewed_story_privacy.mjs"), prepared, proposals, bundlePath]);
      return JSON.parse(await readFile(bundlePath, "utf8"));
    };
    const removed = structuredClone(preparation.snapshot); removed.sourceRedactions.pop();
    await assert.rejects(() => transport(removed, "removed-source", { prepareOnly: true }));
    const context = structuredClone(preparation.snapshot); context.sourceRedactions[0].context = "Altered synthetic context";
    await assert.rejects(() => transport(context, "altered-context", { prepareOnly: true }));
    context.binding.sourceRedactionsDigest = await storyPreparationDigest(context.sourceRedactions);
    const alteredBundle = await transport(context, "rebound-context");
    assert.equal((await importReviewedStoryPrivacyAuthority(db, alteredBundle, fixture.now)).ok, false,
      "rehashing an altered offline context cannot replace the actual verified subset binding");
    const bundle = await transport(preparation.snapshot, "legacy-refresh");
    const imported = await importReviewedStoryPrivacyAuthority(db, bundle, fixture.now);
    assert.ok(imported.ok, JSON.stringify(imported));
    assert.equal(imported.authority.targets.length, targets.length);
    assert.equal(new Set(imported.authority.targets.map((target) => target.targetId)).size, targets.length);
    assert.ok(imported.authority.targets.every((target) => target.selectedText === null));

    const custom = "Public game label Project Delta is separate from the internal project.";
    fixture.session.chapterReviews.a = updateAiInsightDecision(fixture.session.chapterReviews.a,
      fixture.sources[0], "synthetic-insight", "accepted");
    const original = imported.authority.targets.find((target) => target.targetId === targetId);
    fixture.session.privacyDrafts = { [targetId]: { targetContentDigest: original.targetContentDigest,
      proposedText: original.proposedText, editedText: custom, publicOverrides: [] } };
    await db.prepare("UPDATE story_review_sessions SET state_json=?,server_version=2 WHERE workflow_run_id=?")
      .bind(JSON.stringify({ sourceRevision: fixture.sourceRevision, session: fixture.session }), fixture.run).run();
    const prospective = await buildReviewedStoryPrivacyPreparationSnapshot(db, fixture.run);
    assert.ok(prospective.ok, JSON.stringify(prospective));
    assert.equal(prospective.snapshot.changedTargets.find((target) => target.id === targetId).editedText, custom);
    assert.equal(prospective.snapshot.changedTargets.filter((target) => target.id.includes("::insight:")).length, 5);
    const checked = await importReviewedStoryPrivacyAuthority(db,
      await transport(prospective.snapshot, "custom-and-insight", { edited: true }), fixture.now);
    assert.ok(checked.ok, JSON.stringify(checked));
    assert.equal(checked.authority.targets.find((target) => target.targetId === targetId).selectedText, null);
    const record = await readStoryReviewSessionRecord(db, fixture.run);
    assert.equal(record.session.privacyDrafts[targetId].editedText, custom);
    const applied = await applyStoryChapterReview(db, { workflowRunId: fixture.run, sourceRevision: fixture.sourceRevision,
      expectedVersion: 2, chapterKey: "a", authorityDigest: checked.authority.authorityDigest,
      choices: checked.authority.targets.filter((target) => target.targetId.startsWith("a::")).map((target) => ({
        targetId: target.targetId, targetContentDigest: target.targetContentDigest,
        editedText: target.targetId === targetId ? custom : null, publicOverrides: [],
      })) }, fixture.now);
    assert.ok(applied.ok, JSON.stringify(applied));
    assert.equal(applied.session.chapterReviews.a.sourceInsightReviews["synthetic-insight"].resolution, "applied");
    assert.equal(applied.authority.targets.find((target) => target.targetId === targetId).selectedText, custom);
    assert.equal(applied.session.privacyDrafts[targetId], undefined);
    const selected = applied.authority.targets.find((target) => target.targetId === targetId);
    const revisited = storyPrivacyTargetView(selected, undefined, applied.session.chapterReviews.a);
    assert.equal(revisited.text, custom);
    assert.equal(revisited.label, "Reviewed edit");
    assert.equal(revisited.status, "Applied");
    const reapplied = await applyStoryChapterReview(db, { workflowRunId: fixture.run, sourceRevision: fixture.sourceRevision,
      expectedVersion: applied.serverVersion, chapterKey: "a", authorityDigest: applied.authority.authorityDigest, choices: [] }, fixture.now);
    assert.ok(reapplied.ok, JSON.stringify(reapplied));
    assert.equal(reapplied.authority.targets.find((target) => target.targetId === targetId).selectedText, custom);

    assert.equal((await reconstructReviewedStoryReleaseFromDatabase(db, { workflowRunId: fixture.run,
      sourceRevision: fixture.sourceRevision, serverVersion: applied.serverVersion })).ok, false);
  } finally {
    globalThis.__oxygenLocalSqlite?.database.close(); delete globalThis.__oxygenLocalSqlite;
    if (previous === undefined) delete process.env.OXYGEN_VIEWER_STATE_DIR; else process.env.OXYGEN_VIEWER_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
