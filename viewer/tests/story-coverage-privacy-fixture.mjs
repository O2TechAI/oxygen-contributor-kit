import {
  canonicalAuthorityJson,
  contributionRecordSourceDigest,
  finalizeCoverageManifestAuthority,
  validateSemanticManifestAuthority,
} from "../lib/story-readiness.ts";
import { computeSourceDigest } from "../lib/redaction-pass.mjs";
import { storyPreparationDigest } from "../lib/story-preparation.ts";

const sha256 = async (value) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const utf8 = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));

/** Seed the fresh-SQLite canonical authority required by production Story
 * consumers. The helper mutates only synthetic test Story carriers. */
export async function seedCoveragePrivacyAuthority(db, {
  workflowRunId,
  sourceRevision,
  stories,
  now,
  projectId = "test-project",
}) {
  const itemResult = await db.prepare(`SELECT id,document_id,sequence,event_type,actor_id,
    actor_type,timestamp,content,original_json,organization_reason
    FROM items ORDER BY document_id,sequence,id`).all();
  const items = itemResult.results;
  const records = [];
  for (const item of items) {
    let original = {};
    try { original = JSON.parse(String(item.original_json || "{}")); } catch { original = {}; }
    records.push({
      id: item.id,
      sourceDigest: await contributionRecordSourceDigest(original, {
        id: item.id,
        documentId: item.document_id,
        sequence: Number(item.sequence),
        eventType: item.event_type ?? null,
        actorId: item.actor_id ?? null,
        actorType: item.actor_type ?? null,
        timestamp: item.timestamp ?? null,
        content: String(item.content || ""),
      }),
    });
  }
  records.sort((left, right) => utf8(left.id, right.id));
  const recordById = new Map(records.map((record) => [record.id, record]));
  const claimed = new Set();
  const referencedByStory = stories.map((story) => {
    const referenced = [story.evidence.primary, ...story.evidence.supporting]
      .map((reference) => reference.eventId)
      .filter((id, index, all) => recordById.has(id) && all.indexOf(id) === index);
    referenced.forEach((id) => {
      if (claimed.has(id)) throw new Error("Synthetic Story fixtures double-own one item");
      claimed.add(id);
    });
    return referenced;
  });
  const extras = records.map((record) => record.id).filter((id) => !claimed.has(id));
  const units = stories.map((story, index) => {
    const members = [...referencedByStory[index], ...(index === 0 ? extras : [])].sort(utf8);
    return { story, members };
  });
  extras.forEach((id) => claimed.add(id));
  if (units.some((unit) => unit.members.length === 0) || claimed.size !== records.length) {
    throw new Error("Synthetic Story fixture does not exhaust its item universe");
  }
  const semanticUnits = [];
  for (const [index, entry] of units.entries()) {
    const id = `unit-${index + 1}`;
    const memberAuthority = entry.members.map((memberId) => recordById.get(memberId));
    semanticUnits.push({
      id,
      revision: 1,
      projectId,
      kind: "discussion",
      members: entry.members,
      memberCount: entry.members.length,
      membershipDigest: await sha256(canonicalAuthorityJson(memberAuthority)),
    });
  }
  const semanticCore = {
    projectId,
    revision: 1,
    sourceDigest: await sha256(canonicalAuthorityJson(records)),
    universeDigest: await sha256(canonicalAuthorityJson(records.map((record) => record.id))),
    units: semanticUnits,
  };
  const semanticInput = {
    ...semanticCore,
    manifestDigest: await sha256(canonicalAuthorityJson(semanticCore)),
  };
  const semanticValidation = await validateSemanticManifestAuthority(semanticInput, records);
  if (!semanticValidation.ok) throw new Error(semanticValidation.code);
  const semantic = semanticValidation.authority;
  const coverageValidation = await finalizeCoverageManifestAuthority({
    rows: semantic.units.map((unit, index) => ({
      unitId: unit.id,
      disposition: "represented",
      ownerId: stories[index].key,
    })),
  }, semantic);
  if (!coverageValidation.ok) throw new Error(coverageValidation.code);
  const coverage = coverageValidation.authority;
  for (const [index, story] of stories.entries()) {
    story.coverage = {
      semanticManifest: { revision: semantic.revision, digest: semantic.manifestDigest },
      coverageManifest: { revision: coverage.revision, digest: coverage.coverageDigest },
      representedUnitIds: [semantic.units[index].id],
      excludedUnits: [],
    };
    await db.prepare("UPDATE items SET organization_reason=? WHERE id=?")
      .bind(`oxygen.story:${JSON.stringify(story)}`, story.evidence.primary.eventId).run();
  }
  const candidateRows = stories.map((story) => ({
    id: story.evidence.primary.eventId,
    summary: `oxygen.story:${JSON.stringify(story)}`,
  }));
  const activeStoryDigest = await storyPreparationDigest(candidateRows);
  const currentItems = (await db.prepare(`SELECT id,document_id,sequence,event_type,actor_type,
    timestamp,content FROM items ORDER BY document_id,sequence,id`).all()).results;
  const sourcePrivacyDigest = await computeSourceDigest(currentItems);
  const documentCount = Number((await db.prepare("SELECT COUNT(*) AS count FROM documents").first()).count);
  const corpusDigest = "c".repeat(64);
  await db.prepare(`INSERT INTO finalized_corpus_manifests
    (workflow_run_id,corpus_revision,corpus_digest,document_count,item_count,finalized_at)
    VALUES (?,1,?,?,?,?)`).bind(
    workflowRunId, corpusDigest, documentCount, items.length, now,
  ).run();
  await db.prepare(`INSERT INTO semantic_manifests
    (workflow_run_id,project_id,revision,source_revision,source_digest,universe_digest,
     manifest_digest,unit_count,serialized_bytes,story_projection_bytes,corpus_revision,
     corpus_digest,corpus_document_count,corpus_item_count,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?)`).bind(
    workflowRunId, projectId, 1, sourceRevision, semantic.sourceDigest,
    semantic.universeDigest, semantic.manifestDigest, semantic.units.length,
    semantic.serializedBytes, semanticValidation.storyProjectionBytes, corpusDigest,
    documentCount, items.length, now, now,
  ).run();
  for (const unit of semantic.units) {
    await db.prepare(`INSERT INTO semantic_units
      (id,workflow_run_id,revision,project_id,kind,member_count,membership_digest,
       duplicate_of_unit_id,story_projection_json) VALUES (?,?,?,?,?,?,?,NULL,'{}')`).bind(
      unit.id, workflowRunId, unit.revision, unit.projectId, unit.kind,
      unit.memberCount, unit.membershipDigest,
    ).run();
    for (const itemId of unit.members) {
      await db.prepare(`INSERT INTO semantic_unit_members
        (item_id,workflow_run_id,unit_id,source_digest) VALUES (?,?,?,?)`).bind(
        itemId, workflowRunId, unit.id, recordById.get(itemId).sourceDigest,
      ).run();
    }
  }
  await db.prepare(`INSERT INTO story_coverage_manifests
    (workflow_run_id,revision,semantic_manifest_revision,semantic_manifest_digest,
     coverage_digest,privacy_authority_digest,unit_count,serialized_bytes,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
    workflowRunId, coverage.revision, coverage.semanticManifestRevision,
    coverage.semanticManifestDigest, coverage.coverageDigest, "0".repeat(64),
    coverage.rows.length,
    coverage.serializedBytes, now, now,
  ).run();
  for (const row of coverage.rows) {
    await db.prepare(`INSERT INTO story_coverage_rows
      (unit_id,workflow_run_id,disposition,owner_id,exclusion_reason)
      VALUES (?,?,?,?,NULL)`).bind(row.unitId, workflowRunId, row.disposition, row.ownerId).run();
  }
  await db.prepare(`INSERT INTO redaction_jobs
    (id,status,stage,model,completed,total,rejected,source_digest,started_at,updated_at,completed_at)
    VALUES (?,'complete','privacy',NULL,0,0,0,?,?,?,?)`).bind(
    `privacy-${workflowRunId}`, sourcePrivacyDigest, now, now, now,
  ).run();
  const { readCoveragePrivacyAuthority } = await import(
    "../lib/story-coverage-privacy-authority.ts"
  );
  const privacyAuthority = await readCoveragePrivacyAuthority(db, workflowRunId, semantic);
  if (!privacyAuthority.ok) throw new Error(privacyAuthority.code);
  await db.prepare(`UPDATE story_coverage_manifests SET privacy_authority_digest=?
    WHERE workflow_run_id=?`).bind(
    privacyAuthority.authority.snapshotDigest, workflowRunId,
  ).run();
  await db.prepare(`UPDATE workflow_runs SET active_story_digest=? WHERE id=?`)
    .bind(activeStoryDigest, workflowRunId).run();
  const storyPrivacyInputDigest = await storyPreparationDigest(stories.map((story) => ({
    id: story.evidence.primary.eventId,
    story,
  })));
  await db.prepare(`UPDATE story_preparation_receipts SET input_digest=?
    WHERE workflow_run_id=? AND lane='story_privacy'`).bind(
    storyPrivacyInputDigest, workflowRunId,
  ).run();
  return { semantic, coverage, activeStoryDigest, storyPrivacyInputDigest };
}
