import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { computeSourceDigest } from "../../../viewer/lib/redaction-pass.mjs";
import {
  canonicalAuthorityJson,
  MAX_COVERAGE_MANIFEST_BYTES,
  validateCoverageManifestAuthority,
} from "../../../viewer/lib/story-readiness.ts";
import { parseStorySource, STORY_PREFIX } from "../../../viewer/lib/timeline.ts";
import {
  MAX_SOURCE_PRIVACY_AUTHORITY_BYTES,
  deriveCoveragePrivacyAuthority,
} from "../../../viewer/lib/story-coverage-privacy-authority.ts";
import {
  MAX_PROJECT_MAP_BYTES,
  canonicalDigest,
  canonicalJsonEqual,
  compareUtf8,
  exactKeys,
  fail,
  isObject,
  readSemanticTransport,
  readStrictJson,
  serializedBytes,
  stableId,
} from "./story_preparation_transport.mjs";
import { directPathEntry } from "./direct_path_entry.mjs";

export const MAX_STORY_VALIDATION_AUTHORITY_BYTES = 12_000_000;
export const MAX_STORY_REVIEW_SOURCE_BYTES = 64_000_000;
export const MAX_STORY_REVIEWED_NARRATIVE_BYTES = 24_000_000;
const opaqueActorId = /^actor-[0-9a-f]{64}$/u;
const opaqueEventId = /^event-[0-9a-f]{64}$/u;
const interactionDirections = new Set([
  "human_to_agent", "agent_to_human", "agent_to_subagent", "subagent_to_agent",
  "agent_to_agent", "agent_internal_reasoning", "subagent_internal_reasoning",
  "agent_internal_progress", "subagent_internal_progress",
]);
const relationTypes = new Set(["reply_to", "produced", "result_of", "observed"]);

export function storyLanguageProjection(policy, storyKeys) {
  if (!isObject(policy) || policy.schema !== "oxygen.story-language-policy"
    || !Array.isArray(policy.stories) || !stableId(policy.workflowRunId)
    || !Number.isSafeInteger(policy.sourceRevision) || policy.sourceRevision < 1) {
    fail("STORY_LANGUAGE_POLICY_INVALID");
  }
  const wanted = new Set(storyKeys);
  const stories = policy.stories.filter((story) => wanted.has(story.storyKey));
  if (stories.length !== wanted.size) fail("STORY_LANGUAGE_POLICY_STALE");
  return {
    workflowRunId: policy.workflowRunId,
    sourceRevision: policy.sourceRevision,
    selection: policy.selection,
    policyDigest: canonicalDigest(policy),
    stories,
  };
}

export function validateStoryLanguageProjection(value, policy, storyKeys) {
  if (!canonicalJsonEqual(value, storyLanguageProjection(policy, storyKeys))) {
    fail("STORY_LANGUAGE_POLICY_STALE");
  }
}

async function directDirectory(parent, name, optional = false) {
  const candidate = resolve(parent, name);
  let entry;
  try {
    entry = await directPathEntry(candidate);
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    fail("REVIEWED_SOURCE_INVALID");
  }
  if (!entry?.state.isDirectory()) fail("REVIEWED_SOURCE_INVALID");
  return entry.physical;
}

async function directFile(parent, name) {
  const candidate = resolve(parent, name);
  let entry;
  try {
    entry = await directPathEntry(candidate);
  } catch {
    fail("REVIEWED_SOURCE_INVALID");
  }
  if (!entry?.state.isFile()) fail("REVIEWED_SOURCE_INVALID");
  return entry.physical;
}

function sourceText(value) {
  return typeof value === "string" && value.trim() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    ? value : null;
}

function sourceRow(value) {
  if (!isObject(value) || !stableId(value.id) || !stableId(value.documentId)
    || !Number.isSafeInteger(value.sequence) || value.sequence < 1
    || !sourceText(value.content)
    || (value.eventType !== null && typeof value.eventType !== "string")
    || (value.actorId !== null && typeof value.actorId !== "string")
    || (value.actorType !== null && typeof value.actorType !== "string")
    || (value.parentActorId !== null && typeof value.parentActorId !== "string")
    || (value.interactionDirection !== null && typeof value.interactionDirection !== "string")
    || (value.relationId !== null && typeof value.relationId !== "string")
    || !Array.isArray(value.relations)
    || (value.timestamp !== null && typeof value.timestamp !== "string")) {
    fail("REVIEWED_SOURCE_INVALID");
  }
  return value;
}

async function trajectoryRows(root, budget) {
  const trajectories = await directDirectory(root, "trajectories", true);
  if (!trajectories) return [];
  const names = (await readdir(trajectories, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(compareUtf8);
  const rows = [];
  for (const name of names) {
    if (!stableId(name)) fail("REVIEWED_SOURCE_INVALID");
    const directory = await directDirectory(trajectories, name);
    const path = await directFile(directory, "events.jsonl");
    const bytes = await readFile(path);
    budget.used += bytes.byteLength;
    if (budget.used > MAX_STORY_REVIEW_SOURCE_BYTES) fail("REVIEWED_SOURCE_TOO_LARGE");
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      fail("REVIEWED_SOURCE_INVALID");
    }
    for (const line of text.split(/\r?\n/u).filter(Boolean)) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        fail("REVIEWED_SOURCE_INVALID");
      }
      const actor = isObject(event?.actor) ? event.actor : {};
      const payload = isObject(event?.payload) ? event.payload : {};
      const eventType = typeof event?.event_type === "string" ? event.event_type : null;
      const actorType = typeof actor.type === "string" ? actor.type : null;
      const parentActorId = actor.parent_id ?? null;
      const direction = payload.interaction_direction ?? null;
      const relations = event?.relations;
      if (!exactKeys(actor, parentActorId === null ? ["id", "type"] : ["id", "type", "parent_id"])
        || !opaqueActorId.test(actor.id || "") || !sourceText(actorType)
        || (parentActorId !== null && !opaqueActorId.test(parentActorId))
        || (direction !== null && !interactionDirections.has(direction))
        || !opaqueEventId.test(event?.relation_id || "") || !Array.isArray(relations)
        || relations.some((relation) => !isObject(relation)
          || !exactKeys(relation, ["type", "target"])
          || !relationTypes.has(relation.type) || !opaqueEventId.test(relation.target || ""))) {
        fail("REVIEWED_SOURCE_INVALID");
      }
      rows.push(sourceRow({
        id: event?.event_id,
        documentId: name,
        sequence: event?.sequence,
        eventType,
        actorId: actor.id,
        actorType,
        parentActorId,
        interactionDirection: direction,
        relationId: event.relation_id,
        relations,
        timestamp: typeof event?.timestamp === "string" ? event.timestamp : null,
        content: payload.text,
      }));
    }
  }
  return rows;
}

async function meetingRows(root, budget) {
  const meetings = await directDirectory(root, "meetings", true);
  if (!meetings) return [];
  const names = (await readdir(meetings, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(compareUtf8);
  const rows = [];
  for (const name of names) {
    if (!stableId(name)) fail("REVIEWED_SOURCE_INVALID");
    const directory = await directDirectory(meetings, name);
    const path = await directFile(directory, "meeting.json");
    const document = await readStrictJson(path, MAX_STORY_REVIEW_SOURCE_BYTES, {
      invalid: "REVIEWED_SOURCE_INVALID", changed: "REVIEWED_SOURCE_CHANGED",
      oversized: "REVIEWED_SOURCE_TOO_LARGE", jsonInvalid: "REVIEWED_SOURCE_INVALID",
    });
    budget.used += document.byteLength;
    if (budget.used > MAX_STORY_REVIEW_SOURCE_BYTES || !isObject(document.value)
      || document.value.meeting_id !== name || !Array.isArray(document.value.records)) {
      fail("REVIEWED_SOURCE_INVALID");
    }
    for (const record of document.value.records) {
      if (!isObject(record) || !stableId(record.record_id)) fail("REVIEWED_SOURCE_INVALID");
      const sequence = record.order ?? record.sequence_in_meeting;
      rows.push(sourceRow({
        id: `${name}:${record.record_id}`,
        documentId: name,
        sequence,
        eventType: "record",
        actorId: record.speaker,
        actorType: "human",
        parentActorId: null,
        interactionDirection: null,
        relationId: null,
        relations: [],
        timestamp: typeof (record.timestamp ?? record.started_at) === "string"
          ? (record.timestamp ?? record.started_at) : null,
        content: record.text,
      }));
      if (!opaqueActorId.test(record.speaker || "")) fail("REVIEWED_SOURCE_INVALID");
    }
  }
  return rows;
}

async function reviewedSourceRows(reviewRootInput, semantic) {
  const entry = await directPathEntry(reviewRootInput).catch(() => fail("REVIEWED_SOURCE_INVALID"));
  if (!entry?.state.isDirectory()) fail("REVIEWED_SOURCE_INVALID");
  const root = entry.physical;
  const reviewSemantic = await readSemanticTransport(await directFile(root, "project-map.json"));
  if (!canonicalJsonEqual(reviewSemantic, semantic)) fail("REVIEWED_SOURCE_AUTHORITY_STALE");
  const budget = { used: 0 };
  const rows = [
    ...await trajectoryRows(root, budget),
    ...await meetingRows(root, budget),
  ].sort((left, right) => compareUtf8(left.documentId, right.documentId)
    || left.sequence - right.sequence || compareUtf8(left.id, right.id));
  if (!rows.length || new Set(rows.map((row) => row.id)).size !== rows.length) {
    fail("REVIEWED_SOURCE_INVALID");
  }
  const relationIds = rows.map((row) => row.relationId).filter(Boolean);
  const relationIdSet = new Set(relationIds);
  if (relationIdSet.size !== relationIds.length
    || rows.some((row) => row.relations.some((relation) => !relationIdSet.has(relation.target)))) {
    fail("REVIEWED_SOURCE_INVALID");
  }
  const semanticIds = semantic.units.flatMap((unit) => unit.members).sort(compareUtf8);
  const sourceIds = rows.map((row) => row.id).sort(compareUtf8);
  if (!canonicalJsonEqual(sourceIds, semanticIds)) fail("REVIEWED_SOURCE_AUTHORITY_STALE");
  return rows;
}

function projectEvidence(rows) {
  const evidence = [];
  const reviewedNarrative = [];
  for (const row of rows) {
    evidence.push({
      id: row.id,
      documentId: row.documentId,
      sequence: row.sequence,
      timestamp: row.timestamp,
      eventType: row.eventType,
      actorType: row.actorType,
      actorEquivalence: row.actorId,
      parentActorEquivalence: row.parentActorId,
      interactionDirection: row.interactionDirection,
      relationId: row.relationId,
      relations: row.relations,
    });
    reviewedNarrative.push({
      id: row.id,
      documentId: row.documentId,
      sequence: row.sequence,
      eventType: row.eventType,
      actorType: row.actorType,
      actorEquivalence: row.actorId,
      parentActorEquivalence: row.parentActorId,
      interactionDirection: row.interactionDirection,
      relationId: row.relationId,
      relations: row.relations,
      narrative: row.content,
    });
  }
  return { evidence, reviewedNarrative };
}

export function storyEvidenceRows(authority) {
  if (!isObject(authority) || authority.schema !== "oxygen.story-validation-authority"
    || !Array.isArray(authority.evidence)) fail("STORY_VALIDATION_AUTHORITY_INVALID");
  return authority.evidence.map((row) => ({
    id: row.id,
    documentId: row.documentId,
    eventType: row.eventType,
    actorType: row.actorType,
    actorId: row.actorEquivalence,
    parentActorId: row.parentActorEquivalence,
    interactionDirection: row.interactionDirection,
    relationId: row.relationId,
    relations: row.relations,
  }));
}

function storyInputNarrative(storyInputs) {
  if (!Array.isArray(storyInputs) || storyInputs.length === 0) fail("STORY_INPUT_STALE");
  const narrative = new Map();
  for (const input of storyInputs) {
    const bundles = input?.payload?.ownerBundles;
    if (!Array.isArray(bundles) || bundles.length === 0) fail("STORY_INPUT_STALE");
    for (const bundle of bundles) {
      if (!Array.isArray(bundle?.reviewedNarrative)) fail("STORY_INPUT_STALE");
      for (const row of bundle.reviewedNarrative) {
        if (!isObject(row) || !stableId(row.id) || !stableId(row.documentId)
          || typeof row.narrative !== "string") fail("STORY_INPUT_STALE");
        const key = canonicalAuthorityJson([row.documentId, row.id]);
        const projected = { id: row.id, documentId: row.documentId, narrative: row.narrative };
        const prior = narrative.get(key);
        if (prior && !canonicalJsonEqual(prior, projected)) fail("STORY_INPUT_STALE");
        narrative.set(key, projected);
      }
    }
  }
  return narrative;
}

function baseStoryCandidates(storyRecords) {
  if (!Array.isArray(storyRecords) || storyRecords.length === 0) fail("STORY_OUTPUT_STALE");
  const candidates = new Map();
  for (const record of storyRecords) {
    if (!isObject(record) || !exactKeys(record, ["id", "story"]) || !stableId(record.id)) {
      fail("STORY_OUTPUT_STALE");
    }
    const summary = `${STORY_PREFIX}${canonicalAuthorityJson(record.story)}`;
    const story = parseStorySource(summary);
    if (!story || story.insights.length !== 0 || candidates.has(story.key)) fail("STORY_OUTPUT_STALE");
    candidates.set(story.key, { id: record.id, summary });
  }
  return candidates;
}

export function insightReviewedNarrative(storyInputs, storyCandidates) {
  if (!Array.isArray(storyCandidates) || storyCandidates.length === 0) fail("INSIGHT_INPUT_STALE");
  const sourceNarrative = storyInputNarrative(storyInputs);
  const expected = new Set();
  for (const candidate of storyCandidates) {
    if (!isObject(candidate) || !exactKeys(candidate, ["id", "summary"])
      || !stableId(candidate.id) || typeof candidate.summary !== "string") fail("INSIGHT_INPUT_STALE");
    const story = parseStorySource(candidate.summary);
    if (!story || story.insights.length !== 0) fail("INSIGHT_INPUT_STALE");
    for (const block of story.story.blocks) {
      for (const reference of block.evidence) {
        expected.add(canonicalAuthorityJson([reference.documentId, reference.eventId]));
      }
    }
  }
  return [...expected].sort(compareUtf8).map((key) => {
    const row = sourceNarrative.get(key);
    if (!row) fail("INSIGHT_INPUT_STALE");
    return row;
  });
}

/** Reopen the immutable Story and Insight inputs and project only the
 * Privacy-reviewed narrative authorized for exact source-Quote validation. */
export function insightStoryEvidenceRows(authority, insightInputs, storyInputs, storyRecords) {
  const evidenceRows = storyEvidenceRows(authority);
  const evidenceByKey = new Map(evidenceRows.map((row) => [
    canonicalAuthorityJson([row.documentId, row.id]), row,
  ]));
  const expectedCandidates = baseStoryCandidates(storyRecords);
  const reviewedNarrative = new Map();
  const seenStoryKeys = new Set();
  if (!Array.isArray(insightInputs) || insightInputs.length === 0) fail("INSIGHT_INPUT_STALE");
  for (const input of insightInputs) {
    const payload = input?.payload;
    if (!isObject(payload) || !exactKeys(payload, [
      "validationAuthorityPath", "validationAuthorityDigest", "languagePolicy", "storyCandidates", "reviewedNarrative",
    ]) || payload.validationAuthorityPath !== "story/validation-authority.json"
      || payload.validationAuthorityDigest !== canonicalDigest(authority)
      || !Array.isArray(payload.storyCandidates) || !Array.isArray(payload.reviewedNarrative)) {
      fail("INSIGHT_INPUT_STALE");
    }
    const assignedStoryKeys = [];
    for (const candidate of payload.storyCandidates) {
      const story = parseStorySource(candidate?.summary);
      if (!story || seenStoryKeys.has(story.key)
        || !canonicalJsonEqual(candidate, expectedCandidates.get(story.key))) fail("INSIGHT_INPUT_STALE");
      seenStoryKeys.add(story.key);
      assignedStoryKeys.push(story.key);
    }
    if (!canonicalJsonEqual([...assignedStoryKeys].sort(compareUtf8), input.unitIds)) {
      fail("INSIGHT_INPUT_STALE");
    }
    validateStoryLanguageProjection(payload.languagePolicy, authority.languagePolicy, assignedStoryKeys);
    const expectedNarrative = insightReviewedNarrative(storyInputs, payload.storyCandidates);
    if (!canonicalJsonEqual(payload.reviewedNarrative, expectedNarrative)) fail("INSIGHT_INPUT_STALE");
    for (const row of payload.reviewedNarrative) {
      const key = canonicalAuthorityJson([row.documentId, row.id]);
      if (!evidenceByKey.has(key)) fail("INSIGHT_INPUT_STALE");
      const prior = reviewedNarrative.get(key);
      if (prior !== undefined && prior !== row.narrative) fail("INSIGHT_INPUT_STALE");
      reviewedNarrative.set(key, row.narrative);
    }
  }
  return evidenceRows.map((row) => {
    const narrative = reviewedNarrative.get(canonicalAuthorityJson([row.documentId, row.id]));
    return narrative === undefined ? row : { ...row, reviewedNarrative: narrative };
  });
}

export function storyCompletenessAuthority(authority) {
  if (!isObject(authority?.semanticManifest) || !isObject(authority?.coverageManifest)) {
    fail("STORY_VALIDATION_AUTHORITY_INVALID");
  }
  return {
    semanticManifest: authority.semanticManifest,
    coverageManifest: authority.coverageManifest,
  };
}

export function storyValidationScope(authority, unitIds) {
  const complete = storyCompletenessAuthority(authority);
  if (!Array.isArray(unitIds) || unitIds.some((id) => !stableId(id))
    || new Set(unitIds).size !== unitIds.length) fail("STORY_VALIDATION_SCOPE_INVALID");
  const wanted = new Set(unitIds);
  const units = complete.semanticManifest.units.filter((unit) => wanted.has(unit.id));
  const rows = complete.coverageManifest.rows.filter((row) => wanted.has(row.unitId));
  if (units.length !== wanted.size || rows.length !== wanted.size) fail("STORY_VALIDATION_SCOPE_INVALID");
  const evidenceIds = new Set(units.flatMap((unit) => unit.members));
  const evidenceRows = storyEvidenceRows(authority).filter((row) => evidenceIds.has(row.id));
  if (evidenceRows.length !== evidenceIds.size) fail("STORY_VALIDATION_SCOPE_INVALID");
  return {
    evidenceRows,
    completenessAuthority: {
      semanticManifest: { ...complete.semanticManifest, units },
      coverageManifest: { ...complete.coverageManifest, rows },
    },
  };
}

export async function buildStoryValidationAuthority(
  semanticPath, coveragePath, sourcePrivacyPath, reviewRoot,
) {
  const semantic = await readSemanticTransport(semanticPath);
  const coverage = (await readStrictJson(coveragePath, MAX_COVERAGE_MANIFEST_BYTES, {
    invalid: "COVERAGE_MANIFEST_INVALID", changed: "COVERAGE_MANIFEST_CHANGED",
    oversized: "COVERAGE_MANIFEST_TOO_LARGE", jsonInvalid: "COVERAGE_MANIFEST_INVALID",
  })).value;
  const sourcePrivacy = (await readStrictJson(sourcePrivacyPath, MAX_SOURCE_PRIVACY_AUTHORITY_BYTES, {
    invalid: "SOURCE_PRIVACY_AUTHORITY_MISSING", changed: "SOURCE_PRIVACY_AUTHORITY_CHANGED",
    oversized: "SOURCE_PRIVACY_AUTHORITY_TOO_LARGE", jsonInvalid: "SOURCE_PRIVACY_AUTHORITY_MISSING",
  })).value;
  const rows = await reviewedSourceRows(reviewRoot, semantic);
  const currentSourceDigest = await computeSourceDigest(rows.map((row) => ({
    id: row.id,
    document_id: row.documentId,
    sequence: row.sequence,
    event_type: row.eventType,
    actor_type: row.actorType,
    timestamp: row.timestamp,
    content: row.content,
  })));
  const privacy = await deriveCoveragePrivacyAuthority(sourcePrivacy, semantic, {
    expectedSourceDigest: currentSourceDigest,
    currentItems: rows.map((row) => ({
      id: row.id,
      documentId: row.documentId,
      contentLength: Array.from(row.content).length,
    })),
  });
  if (!privacy.ok) fail(privacy.code);
  const coverageValidation = await validateCoverageManifestAuthority(
    coverage, semantic, privacy.authority.authorizedUnitIds,
  );
  if (!coverageValidation.ok) fail(coverageValidation.code);
  const { evidence, reviewedNarrative } = projectEvidence(rows);
  const authority = {
    schema: "oxygen.story-validation-authority",
    sourceDigest: currentSourceDigest,
    sourcePrivacyDigest: privacy.authority.snapshotDigest,
    semanticManifest: semantic,
    coverageManifest: coverageValidation.authority,
    evidence,
  };
  if (serializedBytes(authority) > MAX_STORY_VALIDATION_AUTHORITY_BYTES) {
    fail("STORY_VALIDATION_AUTHORITY_TOO_LARGE");
  }
  if (serializedBytes(reviewedNarrative) > MAX_STORY_REVIEWED_NARRATIVE_BYTES) {
    fail("STORY_REVIEWED_NARRATIVE_TOO_LARGE");
  }
  return { semantic, authority, reviewedNarrative };
}

export async function readStoryValidationAuthority(prepared) {
  const path = prepared.input.payload?.validationAuthorityPath;
  const digest = prepared.input.payload?.validationAuthorityDigest;
  if (path !== "story/validation-authority.json" || !/^[0-9a-f]{64}$/u.test(digest || "")) {
    fail("STORY_VALIDATION_AUTHORITY_INVALID");
  }
  if (Array.isArray(prepared.inputs) && prepared.inputs.some((input) => (
    input.payload?.validationAuthorityPath !== path
    || input.payload?.validationAuthorityDigest !== digest
  ))) fail("STORY_VALIDATION_AUTHORITY_INVALID");
  const { containedJson } = await import("./story_preparation_protocol.mjs");
  const authority = await containedJson(prepared.root, path, MAX_STORY_VALIDATION_AUTHORITY_BYTES);
  if (canonicalDigest(authority) !== digest) fail("STORY_VALIDATION_AUTHORITY_TAMPERED");
  storyEvidenceRows(authority);
  storyCompletenessAuthority(authority);
  if (!isObject(authority.languagePolicy)) fail("STORY_LANGUAGE_POLICY_INVALID");
  if (Array.isArray(prepared.inputs)) {
    for (const input of prepared.inputs) {
      validateStoryLanguageProjection(
        input.payload?.languagePolicy,
        authority.languagePolicy,
        input.unitIds,
      );
    }
  }
  return authority;
}
