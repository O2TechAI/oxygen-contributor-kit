import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedChapterPrivacy } from "./fixtures/chapter-privacy.mjs";
import { applyStoryChapterReview, readStoryPrivacyAuthority } from "../lib/story-privacy-authority.ts";
import { updateAiInsightDecision } from "../lib/story-review.ts";

test("Chapter Apply checks exact authority and target choices, forbids credentials, and rejects concurrent CAS", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oxygen-privacy-authority-"));
  const previous = process.env.OXYGEN_VIEWER_STATE_DIR;
  process.env.OXYGEN_VIEWER_STATE_DIR = directory;
  try {
    const { getLocalDatabase } = await import("../db/index.ts");
    const db = await getLocalDatabase();
    const fixture = await seedChapterPrivacy(db, { interactive: true, badSecondChapter: false });
    fixture.session.chapterReviews.a = updateAiInsightDecision(fixture.session.chapterReviews.a,
      fixture.sources[0], "synthetic-insight", "rejected");
    await db.prepare("UPDATE story_review_sessions SET state_json=? WHERE workflow_run_id=?")
      .bind(JSON.stringify({ sourceRevision: fixture.sourceRevision, session: fixture.session }), fixture.run).run();
    const current = await readStoryPrivacyAuthority(db, fixture.run);
    assert.ok(current.ok, JSON.stringify(current));
    assert.deepEqual(current.authority.chapterErrors || {}, {});
    const targets = current.authority.targets.filter((target) => target.targetId.startsWith("a::"));
    const marked = targets.find((target) => target.occurrences.length);
    assert.ok(marked);
    const credential = marked.occurrences.find((span) => !span.canPublish);
    const ordinary = marked.occurrences.find((span) => span.canPublish);
    assert.ok(credential); assert.ok(ordinary);
    const span = ({ originalStartOffset, originalEndOffset, category }) => ({ originalStartOffset, originalEndOffset, category });
    const choices = targets.map((target) => ({ targetId: target.targetId,
      targetContentDigest: target.targetContentDigest, editedText: null, publicOverrides: [] }));
    const input = { workflowRunId: fixture.run, sourceRevision: fixture.sourceRevision,
      expectedVersion: 1, chapterKey: "a", authorityDigest: current.authority.authorityDigest, choices };
    const rows = async () => ({ session: (await db.prepare("SELECT * FROM story_review_sessions").all()).results,
      targets: (await db.prepare("SELECT * FROM story_privacy_targets ORDER BY target_id").all()).results });
    const before = await rows();
    const changed = (choice) => choices.map((value) => value.targetId === marked.targetId ? { ...value, ...choice } : value);
    for (const invalid of [
      { ...input, authorityDigest: "0".repeat(64) }, { ...input, sourceRevision: fixture.sourceRevision + 1 },
      { ...input, expectedVersion: 2 }, { ...input, workflowRunId: "foreign-run" },
      { ...input, choices: changed({ targetContentDigest: "0".repeat(64) }) },
      { ...input, choices: changed({ editedText: "An unreviewed custom edit" }) },
      { ...input, choices: changed({ publicOverrides: [span(credential)] }) },
      { ...input, choices: changed({ publicOverrides: [span(ordinary), span(ordinary)] }) },
      { ...input, choices: [choices[0], choices[0]] },
    ]) {
      assert.equal((await applyStoryChapterReview(db, invalid, fixture.now)).ok, false);
      assert.deepEqual(await rows(), before);
    }
    const receipt = await db.prepare("SELECT output_count FROM story_preparation_receipts WHERE lane='story_privacy'").first();
    await db.prepare("UPDATE story_preparation_receipts SET output_count=output_count+1 WHERE lane='story_privacy'").run();
    assert.equal((await readStoryPrivacyAuthority(db, fixture.run)).ok, false);
    await db.prepare("UPDATE story_preparation_receipts SET output_count=? WHERE lane='story_privacy'").bind(receipt.output_count).run();
    const candidate = await db.prepare("SELECT candidate_json FROM story_privacy_candidates LIMIT 1").first();
    await db.prepare("UPDATE story_privacy_candidates SET candidate_json='{}'").run();
    assert.equal((await readStoryPrivacyAuthority(db, fixture.run)).ok, false);
    await db.prepare("UPDATE story_privacy_candidates SET candidate_json=?").bind(candidate.candidate_json).run();
    await db.prepare("UPDATE story_privacy_targets SET target_content_digest=? WHERE target_id=?")
      .bind("0".repeat(64), marked.targetId).run();
    assert.equal((await readStoryPrivacyAuthority(db, fixture.run)).ok, false);
    await db.prepare("UPDATE story_privacy_targets SET target_content_digest=? WHERE target_id=?")
      .bind(marked.targetContentDigest, marked.targetId).run();
    assert.equal((await readStoryPrivacyAuthority(db, "foreign-run")).ok, false);
    await db.prepare("INSERT INTO workflow_runs (id,created_at,updated_at) VALUES ('second-run',?,?)")
      .bind(fixture.now, fixture.now).run();
    assert.equal((await readStoryPrivacyAuthority(db, fixture.run)).ok, false);
    await db.prepare("DELETE FROM workflow_runs WHERE id='second-run'").run();
    assert.deepEqual(await rows(), before);
    const actual = { ...input, choices: changed({ publicOverrides: [span(ordinary)] }) };
    const results = await Promise.all([applyStoryChapterReview(db, actual, fixture.now), applyStoryChapterReview(db, actual, fixture.now)]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    const success = results.find((result) => result.ok);
    const selected = success.authority.targets.find((target) => target.targetId === marked.targetId);
    assert.match(selected.selectedText, /Project Delta/);
    assert.doesNotMatch(selected.selectedText, /sk-synthetic/);
    assert.equal(selected.occurrences.find((span) => span.canPublish).isPublic, true);
    const { PATCH } = await import("../app/api/story-privacy/[id]/route.ts");
    assert.equal((await PATCH()).status, 405);
  } finally {
    globalThis.__oxygenLocalSqlite?.database.close(); delete globalThis.__oxygenLocalSqlite;
    if (previous === undefined) delete process.env.OXYGEN_VIEWER_STATE_DIR; else process.env.OXYGEN_VIEWER_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
