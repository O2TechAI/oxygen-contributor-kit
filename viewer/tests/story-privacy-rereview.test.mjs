import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { recordStoryEdit } from "../lib/story-review.ts";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedChapterPrivacy, syntheticInheritedMatches } from "./fixtures/chapter-privacy.mjs";
import { normalizeStoryPrivacyOutput, storyPreparationDigest } from "../lib/story-preparation.ts";
import { parseStoryPrivacyRereviewRequest } from "../lib/story-privacy-projection.ts";
import { applyStoryChapterReview, buildReviewedStoryPrivacyPreparationSnapshot,
  importReviewedStoryPrivacyAuthority, readStoryPrivacyAuthority } from "../lib/story-privacy-authority.ts";
import { readStoryReviewSessionRecord, persistStoryReviewSessionCas } from "../lib/story-review-session-server.ts";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL && specifier.startsWith(".")) {
    const path = fileURLToPath(new URL(specifier, context.parentURL));
    if (!extname(path)) {
      if (existsSync(`${path}.ts`)) return next(`${specifier}.ts`, context);
      if (existsSync(join(path, "index.ts"))) return next(`${specifier}/index.ts`, context);
    }
  }
  return next(specifier, context);
} });
const { POST: requestRereview } = await import("../app/api/story-privacy/export/route.ts");
import { storyPrivacyTargetView } from "../app/story-privacy-ui.ts";

const execFile = promisify(execFileCallback);
const scripts = join(import.meta.dirname, "../../skills/oxygen-storytelling-review/scripts");

test("explicit same-text re-review preserves the requested name, leaves the date pending, and retains other human state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oxygen-privacy-rereview-"));
  const previous = process.env.OXYGEN_VIEWER_STATE_DIR;
  process.env.OXYGEN_VIEWER_STATE_DIR = directory;
  try {
    const { getLocalDatabase } = await import("../db/index.ts");
    const db = await getLocalDatabase();
    const fixture = await seedChapterPrivacy(db, { badSecondChapter: false, rereview: true });
    let authority = await readStoryPrivacyAuthority(db, fixture.run);
    assert.ok(authority.ok, JSON.stringify(authority));
    const applied = await applyStoryChapterReview(db, { workflowRunId: fixture.run,
      sourceRevision: fixture.sourceRevision, expectedVersion: 1, chapterKey: "b",
      authorityDigest: authority.authority.authorityDigest,
      choices: authority.authority.targets.filter((target) => target.targetId.startsWith("b::"))
        .map((target) => ({ targetId: target.targetId, targetContentDigest: target.targetContentDigest,
          editedText: null, publicOverrides: [] })) }, fixture.now);
    assert.ok(applied.ok, JSON.stringify(applied));
    const session = (await readStoryReviewSessionRecord(db, fixture.run)).session;
    const title = applied.authority.targets.find((target) => target.targetId === "a::title");
    session.privacyDrafts = { [title.targetId]: { targetContentDigest: title.targetContentDigest,
      proposedText: title.proposedText, editedText: null, publicOverrides: [] } };
    await db.prepare("UPDATE story_review_sessions SET state_json=? WHERE workflow_run_id=?")
      .bind(JSON.stringify({ sourceRevision: fixture.sourceRevision, session }), fixture.run).run();
    authority = await readStoryPrivacyAuthority(db, fixture.run);
    const selected = authority.authority.targets.filter((target) => ["a::overview", "a::story:passage"].includes(target.targetId));
    const body = { workflowRunId: fixture.run, expectedVersion: 2, sourceRevision: fixture.sourceRevision,
      authorityDigest: authority.authority.authorityDigest, rereviewRequest: {
        reason: "The contributor wants the public project name retained; the proposed paraphrase does not reduce identification risk. Dates remain undecided.",
        targets: selected.map((target) => ({ targetId: target.targetId, targetContentDigest: target.targetContentDigest,
          retainOriginal: target.occurrences.filter((span) => span.category === "project-name")
            .map(({ originalStartOffset, originalEndOffset, category, originalText }) => ({ originalStartOffset, originalEndOffset, category, originalText })) })) } };
    assert.equal(selected.length, 2);
    const anchor = async () => (await db.prepare("SELECT privacy_rereview_request_json FROM story_review_sessions WHERE workflow_run_id=?")
      .bind(fixture.run).first()).privacy_rereview_request_json;
    const snapshotState = async () => ({ session: await readStoryReviewSessionRecord(db, fixture.run),
      targets: (await db.prepare("SELECT * FROM story_privacy_targets ORDER BY target_id").all()).results,
      receipts: (await db.prepare("SELECT * FROM story_preparation_receipts ORDER BY lane").all()).results });
    const before = await snapshotState();
    const pending = structuredClone(session);
    pending.chapterReviews.a = recordStoryEdit(pending.chapterReviews.a, { storyKey: "a", blockId: "passage", sourceLanguage: "en",
      baseText: fixture.sources[0].story.blocks[0].text, nextText: "The public evaluation was discussed.",
      supportingEvidence: [fixture.sources[0].evidence.primary], now: 1 }).state;
    await db.prepare("UPDATE story_review_sessions SET state_json=? WHERE workflow_run_id=?")
      .bind(JSON.stringify({ sourceRevision: fixture.sourceRevision, session: pending }), fixture.run).run();
    const changedAuthority = await readStoryPrivacyAuthority(db, fixture.run);
    assert.equal((await buildReviewedStoryPrivacyPreparationSnapshot(db, fixture.run, {
      ...body, authorityDigest: changedAuthority.authority.authorityDigest })).ok, false,
    "an existing content transition cannot silently expand the explicit target set");
    await db.prepare("UPDATE story_review_sessions SET state_json=? WHERE workflow_run_id=?")
      .bind(JSON.stringify({ sourceRevision: fixture.sourceRevision, session }), fixture.run).run();
    assert.equal((await buildReviewedStoryPrivacyPreparationSnapshot(db, fixture.run)).ok, false);
    for (const alter of [
      (v) => { v.expectedVersion--; }, (v) => { v.sourceRevision++; },
      (v) => { v.authorityDigest = "0".repeat(64); },
      (v) => { v.rereviewRequest.targets[0].targetContentDigest = "0".repeat(64); },
      (v) => { v.rereviewRequest.targets[0].retainOriginal[0].originalText = "Different name"; },
      (v) => { v.rereviewRequest.targets[0].retainOriginal[0].originalStartOffset++; },
      (v) => { v.rereviewRequest.targets[0].retainOriginal[0].category = "date"; },
      (v) => { v.rereviewRequest.targets[0].targetId = "foreign::overview"; },
      (v) => { v.rereviewRequest.targets.push(v.rereviewRequest.targets[0]); },
      (v) => { v.rereviewRequest.targets[0] = { targetId: "b::overview", targetContentDigest:
        authority.authority.targets.find((t) => t.targetId === "b::overview").targetContentDigest, retainOriginal: [] }; },
    ]) {
      const invalid = structuredClone(body); alter(invalid);
      assert.equal((await buildReviewedStoryPrivacyPreparationSnapshot(db, fixture.run, invalid)).ok, false);
      assert.deepEqual(await snapshotState(), before);
    }
    const credential = structuredClone(body.rereviewRequest);
    credential.targets[0].retainOriginal[0].category = "credential";
    assert.equal(parseStoryPrivacyRereviewRequest(credential), null);
    await db.prepare(`CREATE TRIGGER fail_rereview_request BEFORE UPDATE OF privacy_rereview_request_json ON story_review_sessions
      BEGIN SELECT RAISE(ABORT,'PRIVATE_SYNTHETIC_ERROR_SENTINEL'); END`).run();
    const failedRequest = await requestRereview(new Request("http://localhost/api/story-privacy/export", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    assert.equal(failedRequest.status, 409);
    assert.doesNotMatch(JSON.stringify(await failedRequest.json()), /PRIVATE_SYNTHETIC_ERROR_SENTINEL/);
    assert.equal(await anchor(), null);
    await db.prepare("DROP TRIGGER fail_rereview_request").run();
    const response = await requestRereview(new Request("http://localhost/api/story-privacy/export", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    assert.equal(response.status, 200);
    const snapshot = await response.json();
    assert.deepEqual(snapshot.binding.rereviewRequest, body.rereviewRequest);
    assert.deepEqual(snapshot.changedTargets.map((target) => target.id), selected.map((target) => target.targetId));
    assert.ok(snapshot.targetTransitions.every((target) => target.previousContentDigest === target.contentDigest));
    assert.deepEqual(await snapshotState(), before, "preparing suggestions is not human Apply");
    const snapshotPath = join(directory, "snapshot.json"), root = join(directory, "prepared"), proposals = join(directory, "proposals");
    await writeFile(snapshotPath, JSON.stringify(snapshot)); await mkdir(proposals);
    await execFile(process.execPath, [join(scripts, "prepare_reviewed_story_privacy.mjs"), snapshotPath, root]);
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    const shard = manifest.shards[0];
    const input = JSON.parse(await readFile(join(root, shard.inputPath), "utf8"));
    assert.deepEqual(input.binding.rereviewRequest, body.rereviewRequest, "worker receives the exact authorized request");
    assert.deepEqual(input.targets.map((target) => target.id), selected.map((target) => target.targetId));
    const output = { candidates: [{ id: "remaining-date", reviewState: "needs_confirmation", title: "Discussion date",
      whyFlagged: "The precise date may identify the discussion.", uncertaintyReason: "Choose whether to retain the date.",
      releaseTargets: ["a::story:passage"] }], targetProposals: input.targets.map((target) => {
        const start = target.content.indexOf("May 2"), proposedText = target.content.replace("May 2", "an earlier day");
        return { targetId: target.id, targetContentDigest: target.contentDigest, proposedText,
          occurrences: start < 0 ? [] : [{ originalStartOffset: start, originalEndOffset: start + 5,
            proposalStartOffset: start, proposalEndOffset: start + 14, category: "date" }] };
      }) };
    const proposalPath = join(proposals, `${shard.id}.proposals.json`), bundlePath = join(directory, "bundle.json");
    const invalidOutput = structuredClone(output);
    const overview = invalidOutput.targetProposals.find((target) => target.targetId === "a::overview");
    overview.proposedText = overview.proposedText.replace("Project Cedar", "Cedar project");
    overview.occurrences = [{ originalStartOffset: 0, originalEndOffset: 13,
      proposalStartOffset: 0, proposalEndOffset: 13, category: "project-name" }];
    invalidOutput.candidates.push({ ...output.candidates[0], id: "unauthorized-name", releaseTargets: ["a::overview"] });
    await writeFile(proposalPath, JSON.stringify(invalidOutput));
    await assert.rejects(execFile(process.execPath, [join(scripts, "finalize_reviewed_story_privacy.mjs"), root, proposals, bundlePath]),
      (error) => error.stderr.trim() === "PROPOSAL_INVALID");
    assert.equal(existsSync(join(root, "records")), false, "invalid re-review creates no receipt");
    await writeFile(proposalPath, JSON.stringify(output));
    await execFile(process.execPath, [join(scripts, "finalize_reviewed_story_privacy.mjs"), root, proposals, bundlePath]);
    const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
    const tampered = structuredClone(bundle); tampered.binding.rereviewRequest.reason = "Unbound change";
    assert.equal((await importReviewedStoryPrivacyAuthority(db, tampered, fixture.now)).ok, false);
    assert.deepEqual(await snapshotState(), before);
    const originalAnchor = await anchor();
    // Hashes alone cannot authorize a different reason or extra public occurrence.
    tampered.terminalReceipt.rereviewRequest = tampered.binding.rereviewRequest;
    tampered.receiptDigest = await storyPreparationDigest(tampered.terminalReceipt);
    tampered.importDigest = await storyPreparationDigest({ schema: tampered.schema, binding: tampered.binding,
      receiptDigest: tampered.receiptDigest, privacy: tampered.privacy });
    assert.equal((await importReviewedStoryPrivacyAuthority(db, tampered, fixture.now)).ok, false);
    assert.equal(await anchor(), originalAnchor);
    await db.prepare(`CREATE TRIGGER fail_rereview_consumption BEFORE UPDATE OF privacy_rereview_request_json ON story_review_sessions
      WHEN NEW.privacy_rereview_request_json IS NULL BEGIN SELECT RAISE(ABORT,'Synthetic failure'); END`).run();
    assert.equal((await importReviewedStoryPrivacyAuthority(db, bundle, fixture.now)).ok, false);
    assert.deepEqual(await snapshotState(), before, "late failure rolls back proposal installation");
    assert.equal(await anchor(), originalAnchor, "failure does not consume authorization");
    await db.prepare("DROP TRIGGER fail_rereview_consumption").run();
    const transaction = db.transaction.bind(db);
    db.transaction = async (callback) => {
      const replacement = JSON.parse(originalAnchor); replacement.rereviewRequest.reason = "A newer contributor request";
      await db.prepare("UPDATE story_review_sessions SET privacy_rereview_request_json=? WHERE workflow_run_id=?")
        .bind(JSON.stringify(replacement), fixture.run).run();
      return transaction(callback);
    };
    assert.equal((await importReviewedStoryPrivacyAuthority(db, bundle, fixture.now)).ok, false);
    db.transaction = transaction;
    assert.deepEqual(await snapshotState(), before, "request replacement is rechecked inside the import transaction");
    assert.notEqual(await anchor(), originalAnchor, "newer authorization is not cleared by the older import");
    const renewed = await requestRereview(new Request("http://localhost/api/story-privacy/export", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    assert.equal(renewed.status, 200);
    const imported = await importReviewedStoryPrivacyAuthority(db, bundle, fixture.now);
    assert.ok(imported.ok, JSON.stringify(imported));
    assert.equal(await anchor(), null, "successful import consumes the exact request atomically");
    assert.deepEqual((await snapshotState()).session, before.session, "all drafts and the other applied Chapter remain intact");
    assert.deepEqual((await snapshotState()).receipts, before.receipts, "the original preparation receipts remain immutable");
    assert.deepEqual((await snapshotState()).targets.filter((target) => !selected.some((t) => t.targetId === target.target_id)),
      before.targets.filter((target) => !selected.some((t) => t.targetId === target.target_id)));
    const paragraph = imported.authority.targets.find((target) => target.targetId === "a::story:passage");
    assert.match(paragraph.proposedText, /^Project Cedar/);
    assert.deepEqual(paragraph.occurrences.map((span) => span.category), ["date"]);
    assert.equal(paragraph.selectedText, null);
    assert.equal(storyPrivacyTargetView(paragraph).ready, false);
    assert.equal(imported.authority.candidates.find((candidate) => candidate.id === "remaining-date").resolved, false);
    assert.equal(imported.authority.targets.find((target) => target.targetId === "a::overview").occurrences.length, 0);
    assert.equal((await importReviewedStoryPrivacyAuthority(db, bundle, fixture.now)).ok, false, "old binding cannot be replayed");
    assert.equal(await storyPreparationDigest(JSON.parse(await readFile(snapshotPath, "utf8"))), await storyPreparationDigest(snapshot));
  } finally {
    globalThis.__oxygenLocalSqlite?.database.close(); delete globalThis.__oxygenLocalSqlite;
    if (previous === undefined) delete process.env.OXYGEN_VIEWER_STATE_DIR; else process.env.OXYGEN_VIEWER_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("autosave expires authorization and an old request body cannot restore it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oxygen-rereview-expiry-"));
  const previous = process.env.OXYGEN_VIEWER_STATE_DIR;
  process.env.OXYGEN_VIEWER_STATE_DIR = directory;
  try {
    const { getLocalDatabase } = await import("../db/index.ts");
    const db = await getLocalDatabase();
    const fixture = await seedChapterPrivacy(db, { badSecondChapter: false, rereview: true });
    const authority = (await readStoryPrivacyAuthority(db, fixture.run)).authority;
    const target = authority.targets.find((target) => target.targetId === "a::overview");
    const body = { workflowRunId: fixture.run, expectedVersion: 1, sourceRevision: fixture.sourceRevision,
      authorityDigest: authority.authorityDigest, rereviewRequest: { reason: "Review the name suggestion again.",
        targets: [{ targetId: target.targetId, targetContentDigest: target.targetContentDigest, retainOriginal: [] }] } };
    const post = (value) => requestRereview(new Request("http://localhost/api/story-privacy/export", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
    }));
    assert.equal((await post(body)).status, 200);
    const before = await readStoryReviewSessionRecord(db, fixture.run);
    const session = structuredClone(before.session);
    session.privacyDrafts = { [target.targetId]: { targetContentDigest: target.targetContentDigest,
      proposedText: target.proposedText, editedText: null, publicOverrides: [] } };
    const saved = await persistStoryReviewSessionCas(db, { workflowRunId: fixture.run,
      expectedVersion: 1, sourceRevision: fixture.sourceRevision, storySessionSchema: session.schema, session }, fixture.now);
    assert.ok(saved.ok); assert.equal(saved.serverVersion, 2);
    const anchor = async () => (await db.prepare("SELECT privacy_rereview_request_json FROM story_review_sessions WHERE workflow_run_id=?")
      .bind(fixture.run).first()).privacy_rereview_request_json;
    const stale = await anchor();
    assert.equal((await post(body)).status, 409);
    assert.equal(await anchor(), stale, "rejected replay neither clears nor refreshes old authorization");
    const current = (await readStoryPrivacyAuthority(db, fixture.run)).authority;
    assert.equal((await post({ ...body, expectedVersion: 2, authorityDigest: current.authorityDigest })).status, 200);
    assert.equal(JSON.parse(await anchor()).serverVersion, 2);
    assert.deepEqual((await readStoryReviewSessionRecord(db, fixture.run)).session, session);
  } finally {
    globalThis.__oxygenLocalSqlite?.database.close(); delete globalThis.__oxygenLocalSqlite;
    if (previous === undefined) delete process.env.OXYGEN_VIEWER_STATE_DIR; else process.env.OXYGEN_VIEWER_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("a closed legacy SQLite copy gains the nullable request column without changing saved review bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oxygen-rereview-schema-"));
  const previous = process.env.OXYGEN_VIEWER_STATE_DIR;
  process.env.OXYGEN_VIEWER_STATE_DIR = directory;
  try {
    const originalPath = join(directory, "closed-backup.sqlite");
    const original = new DatabaseSync(originalPath);
    original.exec("CREATE TABLE story_review_sessions (workflow_run_id TEXT PRIMARY KEY,state_json TEXT NOT NULL,updated_at TEXT NOT NULL,server_version INTEGER NOT NULL DEFAULT 0)");
    original.prepare("INSERT INTO story_review_sessions VALUES (?,?,?,?)").run("saved-run", '{"saved":"exact original bytes"}', "2040-01-01T00:00:00.000Z", 7);
    original.close();
    const originalBytes = await readFile(originalPath);
    await copyFile(originalPath, join(directory, "oxygen.sqlite"));
    const { getLocalDatabase } = await import("../db/index.ts");
    let db = await getLocalDatabase();
    const row = await db.prepare("SELECT * FROM story_review_sessions").first();
    assert.deepEqual(row, { workflow_run_id: "saved-run", state_json: '{"saved":"exact original bytes"}',
      updated_at: "2040-01-01T00:00:00.000Z", server_version: 7, privacy_rereview_request_json: null });
    const schemaVersion = await db.prepare("PRAGMA schema_version").first();
    db.database.close(); delete globalThis.__oxygenLocalSqlite;
    db = await getLocalDatabase();
    assert.deepEqual(await db.prepare("PRAGMA schema_version").first(), schemaVersion, "second open is a no-op");
    assert.deepEqual(await db.prepare("SELECT * FROM story_review_sessions").first(), row);
    assert.deepEqual(await readFile(originalPath), originalBytes, "the closed backup is untouched");
  } finally {
    globalThis.__oxygenLocalSqlite?.database.close(); delete globalThis.__oxygenLocalSqlite;
    if (previous === undefined) delete process.env.OXYGEN_VIEWER_STATE_DIR; else process.env.OXYGEN_VIEWER_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("re-review uses the actual source witness and cannot retain credentials or bypass inherited obligations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oxygen-rereview-source-"));
  const previous = process.env.OXYGEN_VIEWER_STATE_DIR;
  process.env.OXYGEN_VIEWER_STATE_DIR = directory;
  try {
    const { getLocalDatabase } = await import("../db/index.ts");
    const db = await getLocalDatabase();
    const fixture = await seedChapterPrivacy(db, { badSecondChapter: false, interactive: true });
    const authority = (await readStoryPrivacyAuthority(db, fixture.run)).authority;
    const target = authority.targets.find((target) => target.targetId === "a::story:passage");
    const retained = (category) => target.occurrences.filter((span) => span.category === category)
      .map(({ originalStartOffset, originalEndOffset, category, originalText }) => ({ originalStartOffset, originalEndOffset, category, originalText }));
    const body = { workflowRunId: fixture.run, expectedVersion: 1, sourceRevision: fixture.sourceRevision,
      authorityDigest: authority.authorityDigest, rereviewRequest: { reason: "Reassess the current project-name suggestion.",
        targets: [{ targetId: target.targetId, targetContentDigest: target.targetContentDigest, retainOriginal: retained("credential") }] } };
    const post = (value) => requestRereview(new Request("http://localhost/api/story-privacy/export", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
    }));
    assert.equal((await post(body)).status, 409, "actual current credential occurrence has no retention bypass");
    body.rereviewRequest.targets[0].retainOriginal = retained("sensitive");
    const response = await post(body); assert.equal(response.status, 200);
    const snapshot = await response.json();
    assert.equal(snapshot.sourceRedactions.length, 2, "request carries the verified source subset");
    const current = snapshot.changedTargets[0], secret = snapshot.sourceRedactions.find((source) => source.category === "credential");
    const start = current.content.indexOf(secret.text), proposedText = current.content.replace(secret.text, "[credential]");
    const output = { candidates: [{ id: "protected-credential", reviewState: "needs_confirmation", title: "Credential",
      whyFlagged: "The test credential must be hidden.", uncertaintyReason: "Review the suggestion.", releaseTargets: [target.targetId] }],
    targetProposals: [{ targetId: target.targetId, targetContentDigest: target.targetContentDigest, proposedText,
      occurrences: [{ originalStartOffset: start, originalEndOffset: start + secret.text.length,
        proposalStartOffset: start, proposalEndOffset: start + 12, category: "credential" }],
      sourceMatches: syntheticInheritedMatches(current.content, snapshot.sourceRedactions) }] };
    const credentialControl = structuredClone(output);
    credentialControl.targetProposals[0].sourceMatches = credentialControl.targetProposals[0].sourceMatches
      .filter((match) => match.sourceRedactionId === secret.id);
    assert.ok(await normalizeStoryPrivacyOutput(credentialControl, [current], [secret]), "the credential itself is correctly removed");
    assert.equal(await normalizeStoryPrivacyOutput(output, [current], snapshot.sourceRedactions), null,
      "retention permission cannot silently waive the ordinary inherited-source obligation");
    await db.prepare("UPDATE redactions SET category='changed-source-category' WHERE category='sensitive'").run();
    assert.equal((await post(body)).status, 409, "changed source witness invalidates the old request");
  } finally {
    globalThis.__oxygenLocalSqlite?.database.close(); delete globalThis.__oxygenLocalSqlite;
    if (previous === undefined) delete process.env.OXYGEN_VIEWER_STATE_DIR; else process.env.OXYGEN_VIEWER_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("multi-shard re-review inputs contain only assigned retention text while parent receipts bind the whole request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oxygen-rereview-shards-"));
  try {
    const targets = await Promise.all(["Cedar", "Birch"].map(async (name, index) => {
      const content = `Project ${name} ${"Public context. ".repeat(34_000)}`;
      return { id: `chapter-${index}::overview`, storyKey: `chapter-${index}`, target: "overview",
        content, contentDigest: await storyPreparationDigest(content) };
    }));
    const rereviewRequest = { reason: "Keep only the explicitly approved project-name occurrences.",
      targets: targets.map((target) => ({ targetId: target.id, targetContentDigest: target.contentDigest,
        retainOriginal: [{ originalStartOffset: 0, originalEndOffset: 13, category: "project-name",
          originalText: target.content.slice(0, 13) }] })) };
    const targetTransitions = targets.map((target) => ({ id: target.id,
      previousContentDigest: target.contentDigest, contentDigest: target.contentDigest }));
    const snapshot = { schema: "oxygen.reviewed-story-privacy-snapshot", binding: {
      workflowRunId: "synthetic-two-shard-review", sourceRevision: 1, activeStoryDigest: "a".repeat(64), serverVersion: 1,
      reviewedStoryDigest: await storyPreparationDigest(targets.map(({ id, content }) => ({ id, content }))),
      targetCatalogDigest: await storyPreparationDigest(targets.map(({ id, contentDigest }) => ({ id, contentDigest }))),
      changedTargetDigest: await storyPreparationDigest(targetTransitions), changedTargetCount: 2,
      previousAuthorityDigest: "b".repeat(64), sourcePrivacyDigest: await storyPreparationDigest([]),
      sourceRedactionsDigest: await storyPreparationDigest([]), rereviewRequest,
    }, targetTransitions, changedTargets: targets, sourceRedactions: [] };
    const snapshotPath = join(directory, "snapshot.json"), root = join(directory, "prepared"), proposals = join(directory, "proposals");
    await writeFile(snapshotPath, JSON.stringify(snapshot)); await mkdir(proposals);
    await execFile(process.execPath, [join(scripts, "prepare_reviewed_story_privacy.mjs"), snapshotPath, root]);
    const manifestPath = join(root, "manifest.json"), manifestBytes = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.shards.length, 2);
    assert.deepEqual(manifest.binding.rereviewRequest, rereviewRequest);
    for (const shard of manifest.shards) {
      const input = JSON.parse(await readFile(join(root, shard.inputPath), "utf8"));
      assert.deepEqual(input.binding.rereviewRequest.targets.map((target) => target.targetId), shard.targetIds);
      const foreign = rereviewRequest.targets.find((target) => !shard.targetIds.includes(target.targetId));
      assert.equal(JSON.stringify(input).includes(foreign.retainOriginal[0].originalText), false,
        "another shard's authorized original is never copied into this worker input");
      await writeFile(join(proposals, `${shard.id}.proposals.json`), JSON.stringify({ candidates: [],
        targetProposals: input.targets.map((target) => ({ targetId: target.id, targetContentDigest: target.contentDigest,
          proposedText: target.content, occurrences: [] })) }));
    }
    const shard = manifest.shards[0], inputPath = join(root, shard.inputPath), inputBytes = await readFile(inputPath, "utf8");
    const input = JSON.parse(inputBytes);
    input.binding.rereviewRequest = rereviewRequest;
    const inputCore = { ...input }; delete inputCore.inputDigest;
    input.inputDigest = await storyPreparationDigest(inputCore);
    manifest.shards[0].inputDigest = input.inputDigest;
    const manifestCore = { ...manifest }; delete manifestCore.manifestDigest;
    manifest.manifestDigest = await storyPreparationDigest(manifestCore);
    await writeFile(inputPath, JSON.stringify(input)); await writeFile(manifestPath, JSON.stringify(manifest));
    const bundlePath = join(directory, "bundle.json");
    await assert.rejects(execFile(process.execPath, [join(scripts, "finalize_reviewed_story_privacy.mjs"), root, proposals, bundlePath]),
      (error) => error.stderr.trim() === "SHARD_INPUT_INVALID");
    assert.equal(existsSync(join(root, "records")), false);
    await writeFile(inputPath, inputBytes); await writeFile(manifestPath, manifestBytes);
    await execFile(process.execPath, [join(scripts, "finalize_reviewed_story_privacy.mjs"), root, proposals, bundlePath]);
    const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
    assert.deepEqual(bundle.binding.rereviewRequest, rereviewRequest);
    assert.deepEqual(bundle.terminalReceipt.rereviewRequest, rereviewRequest);
    assert.equal(bundle.privacy.targetProposals.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
