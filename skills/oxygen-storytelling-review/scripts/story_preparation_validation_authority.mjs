import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { applyActiveRedactions } from "../../../viewer/lib/release.mjs";
import { computeSourceDigest } from "../../../viewer/lib/redaction-pass.mjs";
import {
  MAX_COVERAGE_MANIFEST_BYTES,
  validateCoverageManifestAuthority,
} from "../../../viewer/lib/story-readiness.ts";
import {
  MAX_SOURCE_PRIVACY_AUTHORITY_BYTES,
  deriveCoveragePrivacyAuthority,
} from "../../../viewer/lib/story-coverage-privacy-authority.ts";
import {
  MAX_PROJECT_MAP_BYTES,
  canonicalDigest,
  canonicalJsonEqual,
  compareUtf8,
  fail,
  isObject,
  readSemanticTransport,
  readStrictJson,
  serializedBytes,
  stableId,
} from "./story_preparation_transport.mjs";

export const MAX_STORY_VALIDATION_AUTHORITY_BYTES = 12_000_000;
export const MAX_STORY_REVIEW_SOURCE_BYTES = 64_000_000;
export const MAX_STORY_REVIEWED_NARRATIVE_BYTES = 24_000_000;

async function directDirectory(parent, name, optional = false) {
  const candidate = resolve(parent, name);
  let state;
  try {
    state = await lstat(candidate);
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    fail("REVIEWED_SOURCE_INVALID");
  }
  if (!state.isDirectory() || state.isSymbolicLink()) fail("REVIEWED_SOURCE_INVALID");
  const physical = await realpath(candidate).catch(() => fail("REVIEWED_SOURCE_INVALID"));
  if (physical !== candidate) fail("REVIEWED_SOURCE_INVALID");
  return physical;
}

async function directFile(parent, name) {
  const candidate = resolve(parent, name);
  let state;
  try {
    state = await lstat(candidate);
  } catch {
    fail("REVIEWED_SOURCE_INVALID");
  }
  if (!state.isFile() || state.isSymbolicLink()) fail("REVIEWED_SOURCE_INVALID");
  const physical = await realpath(candidate).catch(() => fail("REVIEWED_SOURCE_INVALID"));
  if (physical !== candidate) fail("REVIEWED_SOURCE_INVALID");
  return physical;
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
      if (actor.id !== undefined
        || (eventType === "message"
          ? !["user", "assistant"].includes(actorType) || payload.role !== actorType
          : eventType !== "action_label" || actorType !== "tool")) {
        fail("REVIEWED_SOURCE_INVALID");
      }
      rows.push(sourceRow({
        id: event?.event_id,
        documentId: name,
        sequence: event?.sequence,
        eventType,
        actorId: null,
        actorType,
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
        actorId: record.speaker === "participant" ? "participant" : null,
        actorType: "human",
        timestamp: typeof (record.timestamp ?? record.started_at) === "string"
          ? (record.timestamp ?? record.started_at) : null,
        content: record.text,
      }));
      if (record.speaker !== "participant") fail("REVIEWED_SOURCE_INVALID");
    }
  }
  return rows;
}

async function reviewedSourceRows(reviewRootInput, semantic) {
  const root = resolve(reviewRootInput);
  const physical = await realpath(root).catch(() => fail("REVIEWED_SOURCE_INVALID"));
  if (physical !== root) fail("REVIEWED_SOURCE_INVALID");
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
  const semanticIds = semantic.units.flatMap((unit) => unit.members).sort(compareUtf8);
  const sourceIds = rows.map((row) => row.id).sort(compareUtf8);
  if (!canonicalJsonEqual(sourceIds, semanticIds)) fail("REVIEWED_SOURCE_AUTHORITY_STALE");
  return rows;
}

function equalityTokens(rows) {
  const signatures = [...new Set(rows.map((row) => JSON.stringify([
    row.actorType || "", row.actorId || "", row.actorId ? "" : row.eventType || "",
  ])))].sort(compareUtf8);
  return new Map(signatures.map((signature, index) => [
    signature, `actor-${String(index + 1).padStart(6, "0")}`,
  ]));
}

function projectEvidence(rows, sourcePrivacy) {
  if (sourcePrivacy.redactions.some((row) => row.review_state === "needs_confirmation")) {
    fail("SOURCE_PRIVACY_REVIEW_INCOMPLETE");
  }
  const spans = new Map();
  for (const row of sourcePrivacy.redactions) {
    if (row.status === "active" && ["deterministic", "confirmed_redact"].includes(row.review_state)) {
      if (!spans.has(row.item_id)) spans.set(row.item_id, []);
      spans.get(row.item_id).push(row);
    }
  }
  const tokens = equalityTokens(rows);
  const evidence = [];
  const reviewedNarrative = [];
  for (const row of rows) {
    const signature = JSON.stringify([
      row.actorType || "", row.actorId || "", row.actorId ? "" : row.eventType || "",
    ]);
    evidence.push({
      id: row.id,
      documentId: row.documentId,
      eventType: row.eventType,
      actorType: row.actorType,
      actorEquivalence: tokens.get(signature),
    });
    reviewedNarrative.push({
      id: row.id,
      documentId: row.documentId,
      narrative: applyActiveRedactions(row.content, spans.get(row.id) || []),
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
  }));
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
  const { evidence, reviewedNarrative } = projectEvidence(rows, sourcePrivacy);
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
  const { containedJson } = await import("./story_preparation_protocol.mjs");
  const authority = await containedJson(prepared.root, path, MAX_STORY_VALIDATION_AUTHORITY_BYTES);
  if (canonicalDigest(authority) !== digest) fail("STORY_VALIDATION_AUTHORITY_TAMPERED");
  storyEvidenceRows(authority);
  storyCompletenessAuthority(authority);
  return authority;
}
