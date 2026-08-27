import type { getLocalDatabase } from "../db";
import {
  LEGACY_STORY_PREFIX,
  STORY_COVERAGE_KEYS,
  STORY_PREFIX,
  STORY_SEMANTIC_EXCLUSION_REASONS,
  MAX_STORY_SEMANTIC_UNIT_REFERENCES,
  SUCCESSOR_STORY_PREFIX,
  compareStorySourceIdentity,
  parseStorySource,
  parseStoryAnnotation,
  resolveEvidenceTarget,
  selectProjectTimeline,
  type StoryAnnotation,
  type SuccessorStorySource,
  type TimelineCandidate,
  type TimelineMilestone,
} from "./timeline.ts";

export type StoryCandidateRow = {
  id: string;
  documentId: string;
  sequence?: number;
  timestamp?: string | null;
  summary: string;
};

export type StoryCandidateItemAuthority = {
  id: string;
  documentId: string;
  sequence: number;
  timestamp?: string | null;
  project?: string | null;
};

export type StoryCandidateSubmissionValidation =
  | { ok: true; rows: StoryCandidateRow[]; highlightsByDocument: Map<string, TimelineCandidate[]> }
  | { ok: false; code: "STORY_CANDIDATE_SUBMISSION_INVALID" | "STORY_CANDIDATE_SUBMISSION_TOO_LARGE"
      | "STORY_CANDIDATE_ITEM_UNKNOWN" | "STORY_CANDIDATE_ITEM_DUPLICATED" };

export const MAX_STORY_CANDIDATE_SUBMISSION_BYTES = 1_500_000;

/** Accept only bounded summaries, then derive every source identity field from
 * the current item authority. The model cannot publish fabricated metadata. */
export function normalizeStoryCandidateSubmission(
  input: unknown,
  itemAuthorities: StoryCandidateItemAuthority[],
): StoryCandidateSubmissionValidation {
  let serializedBytes = MAX_STORY_CANDIDATE_SUBMISSION_BYTES + 1;
  try {
    serializedBytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
  } catch {
    return { ok: false, code: "STORY_CANDIDATE_SUBMISSION_INVALID" };
  }
  if (serializedBytes > MAX_STORY_CANDIDATE_SUBMISSION_BYTES) {
    return { ok: false, code: "STORY_CANDIDATE_SUBMISSION_TOO_LARGE" };
  }
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_STORY_SEMANTIC_UNIT_REFERENCES) {
    return { ok: false, code: "STORY_CANDIDATE_SUBMISSION_INVALID" };
  }
  const authorities = new Map(itemAuthorities.map((item) => [item.id, item]));
  if (authorities.size !== itemAuthorities.length) {
    return { ok: false, code: "STORY_CANDIDATE_SUBMISSION_INVALID" };
  }
  const seen = new Set<string>();
  const rows: StoryCandidateRow[] = [];
  const highlightsByDocument = new Map<string, TimelineCandidate[]>();
  for (const candidate of input) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return { ok: false, code: "STORY_CANDIDATE_SUBMISSION_INVALID" };
    }
    const record = candidate as Record<string, unknown>;
    if (!authorityOnlyKeys(record, ["id", "summary"])
      || !boundedAuthorityId(record.id) || typeof record.summary !== "string"
      || !record.summary.startsWith(SUCCESSOR_STORY_PREFIX)) {
      return { ok: false, code: "STORY_CANDIDATE_SUBMISSION_INVALID" };
    }
    if (seen.has(record.id)) return { ok: false, code: "STORY_CANDIDATE_ITEM_DUPLICATED" };
    seen.add(record.id);
    const authority = authorities.get(record.id);
    if (!authority) return { ok: false, code: "STORY_CANDIDATE_ITEM_UNKNOWN" };
    const row: StoryCandidateRow = {
      id: authority.id,
      documentId: authority.documentId,
      sequence: authority.sequence,
      timestamp: authority.timestamp,
      summary: record.summary,
    };
    rows.push(row);
    const highlights = highlightsByDocument.get(authority.documentId) || [];
    highlights.push({
      id: row.id,
      sequence: row.sequence,
      ...(row.timestamp ? { timestamp: row.timestamp } : {}),
      ...(authority.project ? { project: authority.project } : {}),
      summary: row.summary,
    });
    highlightsByDocument.set(authority.documentId, highlights);
  }
  rows.sort(compareStorySourceIdentity);
  for (const highlights of highlightsByDocument.values()) highlights.sort(compareStorySourceIdentity);
  return { ok: true, rows, highlightsByDocument };
}

type StorySourceDatabase = Awaited<ReturnType<typeof getLocalDatabase>>;

/** Every organization reason beginning exactly with `oxygen.story` belongs to
 * the reserved Story family. A value containing `story` elsewhere does not. */
export const RESERVED_STORY_FAMILY_PREFIX = "oxygen.story";

export function isReservedStoryOrganizationReason(value: unknown) {
  return typeof value === "string" && value.startsWith(RESERVED_STORY_FAMILY_PREFIX);
}

/** Server-owned live selector for the complete reserved Story namespace. */
export async function readReservedStoryCandidateRows(db: StorySourceDatabase) {
  const result = await db.prepare(`SELECT id,document_id AS documentId,sequence,timestamp,
      organization_reason AS summary FROM items WHERE organization_reason LIKE ?`)
    .bind(`${RESERVED_STORY_FAMILY_PREFIX}%`)
    .all<StoryCandidateRow>();
  return [...(result.results || [])].sort(compareStorySourceIdentity);
}

export function selectReservedStorySourceItems<
  T extends TimelineCandidate & { organization_reason?: string | null },
>(items: T[]) {
  return items.filter((item) => isReservedStoryOrganizationReason(item.organization_reason))
    .sort(compareStorySourceIdentity);
}

export type SuccessorViewerChapter = {
  id: string;
  sequence: number;
  timestamp?: string;
  project: string;
  documentId?: string;
  source: SuccessorStorySource;
  story: SuccessorStorySource;
};

export function selectSuccessorViewerChapters(
  highlights: TimelineCandidate[] | undefined,
  fallbackProject: string,
): { chapters: SuccessorViewerChapter[]; invalid: boolean } {
  const seen = new Map<string, string>();
  const chapters: SuccessorViewerChapter[] = [];
  for (const event of [...(highlights || [])].sort(compareStorySourceIdentity)) {
    const source = parseStorySource(event.summary);
    if (!source || source.schema !== "oxygen.story/3") {
      if (String(event.summary || "").startsWith(SUCCESSOR_STORY_PREFIX)) {
        return { chapters: [], invalid: true };
      }
      continue;
    }
    const serialized = JSON.stringify(source);
    const previous = seen.get(source.key);
    if (previous) {
      if (previous !== serialized) return { chapters: [], invalid: true };
      continue;
    }
    seen.set(source.key, serialized);
    chapters.push({
      id: event.id,
      sequence: Number(event.sequence || 0),
      ...(event.timestamp ? { timestamp: event.timestamp } : {}),
      project: event.project || fallbackProject,
      ...(event.documentId ? { documentId: event.documentId } : {}),
      source,
      story: source,
    });
  }
  return { chapters, invalid: false };
}

export type StoryEvidenceRow = {
  id: string;
  documentId: string;
  eventType?: string | null;
  actorId?: string | null;
  actorType?: string | null;
};

export const MAX_SEMANTIC_UNITS = MAX_STORY_SEMANTIC_UNIT_REFERENCES;
export const MAX_SEMANTIC_MANIFEST_BYTES = 2_200_000;
export const MAX_STORY_SEMANTIC_PROJECTION_BYTES = 325_000;
export const MAX_COVERAGE_MANIFEST_BYTES = 250_000;
export const MAX_SEMANTIC_EVIDENCE_ITEM_BYTES = 400_000;

export const SEMANTIC_UNIT_KINDS = [
  "discussion",
  "decision_episode",
  "failed_attempt",
  "experiment",
  "correction",
  "handoff",
  "review_cycle",
  "progression",
  "routine",
  "duplicate",
] as const;

export const COVERAGE_EXCLUSION_REASONS = STORY_SEMANTIC_EXCLUSION_REASONS;

export type SemanticUnitKind = typeof SEMANTIC_UNIT_KINDS[number];
export type CoverageExclusionReason = typeof COVERAGE_EXCLUSION_REASONS[number];

export type SemanticUnitAuthority = {
  id: string;
  revision: number;
  projectId: string;
  kind: SemanticUnitKind;
  members: string[];
  memberCount: number;
  membershipDigest: string;
  duplicateOfUnitId?: string;
  storyProjection?: { label: string; summary: string };
};

export type ContributionRecordAuthority = {
  id: string;
  sourceDigest: string;
};

export type SemanticManifestAuthority = {
  projectId: string;
  revision: number;
  sourceDigest: string;
  universeDigest: string;
  manifestDigest: string;
  serializedBytes: number;
  units: SemanticUnitAuthority[];
};

export function projectSemanticManifestForStory(manifest: SemanticManifestAuthority) {
  return {
    projectId: manifest.projectId,
    revision: manifest.revision,
    sourceDigest: manifest.sourceDigest,
    universeDigest: manifest.universeDigest,
    manifestDigest: manifest.manifestDigest,
    units: manifest.units.map((unit) => ({
      id: unit.id,
      revision: unit.revision,
      kind: unit.kind,
      memberCount: unit.memberCount,
      membershipDigest: unit.membershipDigest,
      ...(unit.duplicateOfUnitId ? { duplicateOfUnitId: unit.duplicateOfUnitId } : {}),
      ...(unit.storyProjection ? { storyProjection: unit.storyProjection } : {}),
    })),
  };
}

export type CoverageRowAuthority = {
  unitId: string;
  disposition: "represented" | "excluded";
  ownerId: string;
  exclusionReason?: CoverageExclusionReason;
};

export type CoverageManifestAuthority = {
  revision: number;
  semanticManifestRevision: number;
  semanticManifestDigest: string;
  coverageDigest: string;
  serializedBytes: number;
  rows: CoverageRowAuthority[];
};

export type SemanticManifestFailureCode =
  | "SEMANTIC_MANIFEST_INVALID"
  | "SEMANTIC_MANIFEST_TOO_LARGE"
  | "SEMANTIC_UNIT_LIMIT_EXCEEDED"
  | "SEMANTIC_UNIT_ID_DUPLICATED"
  | "SEMANTIC_MEMBER_MISSING"
  | "SEMANTIC_MEMBER_DOUBLE_OWNED"
  | "SEMANTIC_MEMBER_UNKNOWN"
  | "SEMANTIC_MEMBER_FOREIGN"
  | "SEMANTIC_MEMBERSHIP_DIGEST_STALE"
  | "SEMANTIC_UNIVERSE_DIGEST_STALE"
  | "SEMANTIC_MANIFEST_DIGEST_STALE"
  | "SEMANTIC_REVISION_STALE";

export type CoverageManifestFailureCode =
  | "COVERAGE_MANIFEST_INVALID"
  | "COVERAGE_MANIFEST_TOO_LARGE"
  | "COVERAGE_SEMANTIC_AUTHORITY_STALE"
  | "COVERAGE_UNIT_MISSING"
  | "COVERAGE_UNIT_DOUBLE_OWNED"
  | "COVERAGE_UNIT_UNKNOWN"
  | "COVERAGE_EXCLUSION_AUTHORITY_INVALID"
  | "COVERAGE_PRIVACY_AUTHORITY_MISSING"
  | "COVERAGE_MANIFEST_DIGEST_STALE"
  | "COVERAGE_REVISION_STALE";

export type SemanticManifestValidation =
  | { ok: true; authority: SemanticManifestAuthority; storyProjectionBytes: number }
  | { ok: false; code: SemanticManifestFailureCode };

export type CoverageManifestValidation =
  | { ok: true; authority: CoverageManifestAuthority }
  | { ok: false; code: CoverageManifestFailureCode };

const semanticKinds = new Set<string>(SEMANTIC_UNIT_KINDS);
const coverageReasons = new Set<string>(COVERAGE_EXCLUSION_REASONS);
const authorityEncoder = new TextEncoder();
const hexDigest = (value: unknown): value is string => typeof value === "string"
  && /^[0-9a-f]{64}$/.test(value);
const boundedAuthorityId = (value: unknown): value is string => typeof value === "string"
  && Boolean(value.trim()) && authorityEncoder.encode(value).byteLength <= 300;
const boundedAuthorityText = (value: unknown, bytes: number): value is string => (
  typeof value === "string" && Boolean(value.trim())
  && authorityEncoder.encode(value).byteLength <= bytes
);
const positiveRevision = (value: unknown): value is number => Number.isSafeInteger(value)
  && Number(value) > 0;
const authorityOnlyKeys = (value: Record<string, unknown>, keys: string[]) => (
  Object.keys(value).every((key) => keys.includes(key))
);
const compareAuthorityId = (left: string, right: string) => {
  const leftBytes = authorityEncoder.encode(left);
  const rightBytes = authorityEncoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.length - rightBytes.length;
};

export function canonicalAuthorityJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalAuthorityJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort(compareAuthorityId).map((key) => (
    `${JSON.stringify(key)}:${canonicalAuthorityJson(record[key])}`
  )).join(",")}}`;
}

async function authoritySha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function contributionAuthority(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const event = value as Record<string, unknown>;
  if (!("event_id" in event) || !("event_type" in event)
    || !("payload" in event) || !("source" in event)) return value;
  const source = event.source && typeof event.source === "object" && !Array.isArray(event.source)
    ? event.source as Record<string, unknown> : {};
  const authoritySource: Record<string, unknown> = {};
  for (const key of [
    "system", "session_id", "record_type", "origin", "interaction_direction",
  ]) {
    if (key in source) authoritySource[key] = source[key];
  }
  if (typeof source.record_id === "string" && source.record_id
    && !/^line-\d+(?::\d+)?$/.test(source.record_id)) {
    authoritySource.record_id = source.record_id;
  }
  let payload = event.payload;
  if (event.event_type === "artifact" && payload && typeof payload === "object"
    && !Array.isArray(payload)) {
    const original = payload as Record<string, unknown>;
    const semanticPayload: Record<string, unknown> = {};
    for (const key of [
      "kind", "original_name", "media_type", "size_bytes", "sha256", "created_by_event",
    ]) {
      if (key in original) semanticPayload[key] = original[key];
    }
    payload = semanticPayload;
  }
  const authority: Record<string, unknown> = {};
  for (const key of [
    "schema_version", "event_id", "trajectory_id", "event_type", "timestamp",
    "started_at", "turn_id", "actor", "relations",
  ]) {
    if (key in event) authority[key] = event[key];
  }
  authority.source = authoritySource;
  authority.payload = payload;
  return authority;
}

function contributionDigestNormalForm(value: unknown): unknown {
  if (value === null) return ["null"];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Contribution contains a non-finite JSON number");
    if (Number.isInteger(value)) {
      if (!Number.isSafeInteger(value)) throw new Error("Contribution contains an unsafe JSON integer");
      return ["number", `i:${value}`];
    }
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setFloat64(0, value, false);
    const encoded = Array.from(new Uint8Array(buffer), (byte) => (
      byte.toString(16).padStart(2, "0")
    )).join("");
    return ["number", `f:${encoded}`];
  }
  if (typeof value === "string") return ["string", value];
  if (Array.isArray(value)) return ["array", value.map(contributionDigestNormalForm)];
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return ["object", Object.keys(record).sort(compareAuthorityId).map((key) => (
      [key, contributionDigestNormalForm(record[key])]
    ))];
  }
  throw new Error("Contribution is not JSON-compatible");
}

export async function contributionSourceDigest(original: unknown): Promise<string> {
  return authoritySha256(canonicalAuthorityJson(
    contributionDigestNormalForm(contributionAuthority(original)),
  ));
}

export type ImportedContributionAuthority = {
  id: string;
  documentId: string;
  sequence: number;
  eventType: string | null;
  actorId: string | null;
  actorType: string | null;
  timestamp: string | null;
  content: string;
};

export async function contributionRecordSourceDigest(
  original: unknown,
  imported: ImportedContributionAuthority,
): Promise<string> {
  if (!boundedAuthorityId(imported.id) || !boundedAuthorityId(imported.documentId)
    || !Number.isSafeInteger(imported.sequence) || typeof imported.content !== "string"
    || [imported.eventType, imported.actorId, imported.actorType, imported.timestamp]
      .some((value) => value !== null && typeof value !== "string")) {
    throw new Error("Imported contribution authority is invalid");
  }
  const authority = {
    original: contributionAuthority(original),
    imported: {
      id: imported.id,
      documentId: imported.documentId,
      sequence: imported.sequence,
      eventType: imported.eventType,
      actorId: imported.actorId,
      actorType: imported.actorType,
      timestamp: imported.timestamp,
      content: imported.content,
    },
  };
  return authoritySha256(canonicalAuthorityJson(contributionDigestNormalForm(authority)));
}

export async function validateSemanticManifestAuthority(
  input: unknown,
  contributionRecords: ContributionRecordAuthority[],
): Promise<SemanticManifestValidation> {
  let serializedBytes = MAX_SEMANTIC_MANIFEST_BYTES + 1;
  try {
    serializedBytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
  } catch {
    return { ok: false, code: "SEMANTIC_MANIFEST_INVALID" };
  }
  if (serializedBytes > MAX_SEMANTIC_MANIFEST_BYTES) {
    return { ok: false, code: "SEMANTIC_MANIFEST_TOO_LARGE" };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, code: "SEMANTIC_MANIFEST_INVALID" };
  }
  const manifest = input as Record<string, unknown>;
  if (!authorityOnlyKeys(manifest, [
    "projectId", "revision", "sourceDigest", "universeDigest", "manifestDigest", "units",
  ]) || !boundedAuthorityId(manifest.projectId) || !positiveRevision(manifest.revision)
    || !hexDigest(manifest.sourceDigest) || !hexDigest(manifest.universeDigest)
    || !hexDigest(manifest.manifestDigest) || !Array.isArray(manifest.units)) {
    return { ok: false, code: "SEMANTIC_MANIFEST_INVALID" };
  }
  if (manifest.units.length > MAX_SEMANTIC_UNITS) {
    return { ok: false, code: "SEMANTIC_UNIT_LIMIT_EXCEEDED" };
  }
  const normalizedRecords = [...contributionRecords].sort((left, right) => (
    compareAuthorityId(left.id, right.id)
  ));
  const universe = normalizedRecords.map((record) => record.id);
  if (new Set(universe).size !== universe.length
    || normalizedRecords.some((record) => !boundedAuthorityId(record.id)
      || !hexDigest(record.sourceDigest))) {
    return { ok: false, code: "SEMANTIC_MANIFEST_INVALID" };
  }
  if (await authoritySha256(canonicalAuthorityJson(normalizedRecords)) !== manifest.sourceDigest) {
    return { ok: false, code: "SEMANTIC_MANIFEST_DIGEST_STALE" };
  }
  if (await authoritySha256(canonicalAuthorityJson(universe)) !== manifest.universeDigest) {
    return { ok: false, code: "SEMANTIC_UNIVERSE_DIGEST_STALE" };
  }
  const knownMembers = new Set(universe);
  const sourceDigests = new Map(normalizedRecords.map((record) => [record.id, record.sourceDigest]));
  const ownedMembers = new Set<string>();
  const unitIds = new Set<string>();
  const units: SemanticUnitAuthority[] = [];
  for (const candidate of manifest.units) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return { ok: false, code: "SEMANTIC_MANIFEST_INVALID" };
    }
    const unit = candidate as Record<string, unknown>;
    if (!authorityOnlyKeys(unit, [
      "id", "revision", "projectId", "kind", "members", "memberCount",
      "membershipDigest", "duplicateOfUnitId", "storyProjection",
    ]) || !boundedAuthorityId(unit.id) || !positiveRevision(unit.revision)
      || unit.projectId !== manifest.projectId || typeof unit.kind !== "string"
      || !semanticKinds.has(unit.kind) || !Array.isArray(unit.members)
      || unit.members.length === 0 || !Number.isSafeInteger(unit.memberCount)
      || unit.memberCount !== unit.members.length || !hexDigest(unit.membershipDigest)
      || (unit.duplicateOfUnitId !== undefined && !boundedAuthorityId(unit.duplicateOfUnitId))) {
      return { ok: false, code: "SEMANTIC_MANIFEST_INVALID" };
    }
    if (unitIds.has(unit.id)) return { ok: false, code: "SEMANTIC_UNIT_ID_DUPLICATED" };
    unitIds.add(unit.id);
    const members = [...unit.members] as unknown[];
    if (members.some((member) => !boundedAuthorityId(member))) {
      return { ok: false, code: "SEMANTIC_MEMBER_FOREIGN" };
    }
    const normalizedMembers = [...members as string[]].sort(compareAuthorityId);
    if (new Set(normalizedMembers).size !== normalizedMembers.length) {
      return { ok: false, code: "SEMANTIC_MEMBER_DOUBLE_OWNED" };
    }
    for (const member of normalizedMembers) {
      if (!knownMembers.has(member)) return { ok: false, code: "SEMANTIC_MEMBER_UNKNOWN" };
      if (ownedMembers.has(member)) return { ok: false, code: "SEMANTIC_MEMBER_DOUBLE_OWNED" };
      ownedMembers.add(member);
    }
    const memberAuthority = normalizedMembers.map((id) => ({
      id,
      sourceDigest: sourceDigests.get(id)!,
    }));
    if (await authoritySha256(canonicalAuthorityJson(memberAuthority)) !== unit.membershipDigest) {
      return { ok: false, code: "SEMANTIC_MEMBERSHIP_DIGEST_STALE" };
    }
    let storyProjection: SemanticUnitAuthority["storyProjection"];
    if (unit.storyProjection !== undefined) {
      if (!unit.storyProjection || typeof unit.storyProjection !== "object"
        || Array.isArray(unit.storyProjection)) {
        return { ok: false, code: "SEMANTIC_MANIFEST_INVALID" };
      }
      const projection = unit.storyProjection as Record<string, unknown>;
      if (!authorityOnlyKeys(projection, ["label", "summary"])
        || !boundedAuthorityText(projection.label, 120)
        || !boundedAuthorityText(projection.summary, 300)) {
        return { ok: false, code: "SEMANTIC_MANIFEST_INVALID" };
      }
      storyProjection = { label: projection.label, summary: projection.summary };
    }
    units.push({
      id: unit.id,
      revision: unit.revision,
      projectId: unit.projectId,
      kind: unit.kind as SemanticUnitKind,
      members: normalizedMembers,
      memberCount: normalizedMembers.length,
      membershipDigest: unit.membershipDigest,
      ...(unit.duplicateOfUnitId ? { duplicateOfUnitId: unit.duplicateOfUnitId } : {}),
      ...(storyProjection ? { storyProjection } : {}),
    });
  }
  if (ownedMembers.size !== knownMembers.size) {
    return { ok: false, code: "SEMANTIC_MEMBER_MISSING" };
  }
  units.sort((left, right) => compareAuthorityId(left.id, right.id));
  const unitsById = new Map(units.map((unit) => [unit.id, unit]));
  for (const unit of units) {
    if (unit.kind === "duplicate") {
      const target = unit.duplicateOfUnitId
        ? unitsById.get(unit.duplicateOfUnitId) : undefined;
      if (!target || unit.duplicateOfUnitId === unit.id || target.kind === "duplicate") {
        return { ok: false, code: "SEMANTIC_MANIFEST_INVALID" };
      }
    } else if (unit.duplicateOfUnitId !== undefined) {
      return { ok: false, code: "SEMANTIC_MANIFEST_INVALID" };
    }
  }
  const canonicalManifest = {
    projectId: manifest.projectId,
    revision: manifest.revision,
    sourceDigest: manifest.sourceDigest,
    universeDigest: manifest.universeDigest,
    units,
  };
  if (await authoritySha256(canonicalAuthorityJson(canonicalManifest)) !== manifest.manifestDigest) {
    return { ok: false, code: "SEMANTIC_MANIFEST_DIGEST_STALE" };
  }
  const storyProjection = projectSemanticManifestForStory({
    ...canonicalManifest,
    manifestDigest: manifest.manifestDigest,
    serializedBytes,
  });
  const storyProjectionBytes = new TextEncoder().encode(JSON.stringify(storyProjection)).byteLength;
  if (storyProjectionBytes > MAX_STORY_SEMANTIC_PROJECTION_BYTES) {
    return { ok: false, code: "SEMANTIC_MANIFEST_TOO_LARGE" };
  }
  return {
    ok: true,
    authority: {
      ...canonicalManifest,
      manifestDigest: manifest.manifestDigest,
      serializedBytes,
    },
    storyProjectionBytes,
  };
}

function comparableSemanticUnit(unit: SemanticUnitAuthority) {
  const { revision, ...comparable } = unit;
  void revision;
  return comparable;
}

function comparableSemanticManifest(manifest: SemanticManifestAuthority) {
  return {
    projectId: manifest.projectId,
    sourceDigest: manifest.sourceDigest,
    universeDigest: manifest.universeDigest,
    units: manifest.units.map(comparableSemanticUnit),
  };
}

export function validateSemanticRevisionTransition(
  next: SemanticManifestAuthority,
  previous: SemanticManifestAuthority | null,
): SemanticManifestFailureCode | null {
  if (!previous) {
    return next.revision === 1 && next.units.every((unit) => unit.revision === 1)
      ? null : "SEMANTIC_REVISION_STALE";
  }
  const previousUnits = new Map(previous.units.map((unit) => [unit.id, unit]));
  for (const unit of next.units) {
    const prior = previousUnits.get(unit.id);
    const expected = prior
      ? (canonicalAuthorityJson(comparableSemanticUnit(prior))
          === canonicalAuthorityJson(comparableSemanticUnit(unit))
        ? prior.revision : prior.revision + 1)
      : 1;
    if (unit.revision !== expected) return "SEMANTIC_REVISION_STALE";
  }
  const unchanged = canonicalAuthorityJson(comparableSemanticManifest(previous))
    === canonicalAuthorityJson(comparableSemanticManifest(next));
  return next.revision === (unchanged ? previous.revision : previous.revision + 1)
    ? null : "SEMANTIC_REVISION_STALE";
}

async function validateCoverageManifestAuthorityInternal(
  input: unknown,
  semanticManifest: SemanticManifestAuthority,
  privacyAuthorizedUnitIds: ReadonlySet<string> = new Set(),
  checkSubmittedDigest = true,
): Promise<CoverageManifestValidation> {
  let serializedBytes = MAX_COVERAGE_MANIFEST_BYTES + 1;
  try {
    serializedBytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
  } catch {
    return { ok: false, code: "COVERAGE_MANIFEST_INVALID" };
  }
  if (serializedBytes > MAX_COVERAGE_MANIFEST_BYTES) {
    return { ok: false, code: "COVERAGE_MANIFEST_TOO_LARGE" };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, code: "COVERAGE_MANIFEST_INVALID" };
  }
  const manifest = input as Record<string, unknown>;
  if (!authorityOnlyKeys(manifest, [
    "revision", "semanticManifestRevision", "semanticManifestDigest", "coverageDigest", "rows",
  ]) || !positiveRevision(manifest.revision)
    || manifest.semanticManifestRevision !== semanticManifest.revision
    || manifest.semanticManifestDigest !== semanticManifest.manifestDigest
    || !hexDigest(manifest.coverageDigest) || !Array.isArray(manifest.rows)) {
    return { ok: false, code: "COVERAGE_SEMANTIC_AUTHORITY_STALE" };
  }
  const units = new Map(semanticManifest.units.map((unit) => [unit.id, unit]));
  const rows: CoverageRowAuthority[] = [];
  const owned = new Set<string>();
  for (const candidate of manifest.rows) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return { ok: false, code: "COVERAGE_MANIFEST_INVALID" };
    }
    const row = candidate as Record<string, unknown>;
    if (!authorityOnlyKeys(row, ["unitId", "disposition", "ownerId", "exclusionReason"])
      || !boundedAuthorityId(row.unitId) || !units.has(row.unitId)
      || (row.disposition !== "represented" && row.disposition !== "excluded")) {
      return { ok: false, code: units.has(String(row.unitId))
        ? "COVERAGE_MANIFEST_INVALID" : "COVERAGE_UNIT_UNKNOWN" };
    }
    if (owned.has(row.unitId)) return { ok: false, code: "COVERAGE_UNIT_DOUBLE_OWNED" };
    owned.add(row.unitId);
    if (row.disposition === "represented") {
      if (!boundedAuthorityId(row.ownerId) || row.exclusionReason !== undefined) {
        return { ok: false, code: "COVERAGE_MANIFEST_INVALID" };
      }
      rows.push({ unitId: row.unitId, disposition: "represented", ownerId: row.ownerId });
      continue;
    }
    if (row.ownerId !== undefined || typeof row.exclusionReason !== "string"
      || !coverageReasons.has(row.exclusionReason)) {
      return { ok: false, code: "COVERAGE_MANIFEST_INVALID" };
    }
    const unit = units.get(row.unitId)!;
    if (row.exclusionReason === "duplicate" && !unit.duplicateOfUnitId) {
      return { ok: false, code: "COVERAGE_EXCLUSION_AUTHORITY_INVALID" };
    }
    if (row.exclusionReason === "routine_non_narrative" && unit.kind !== "routine") {
      return { ok: false, code: "COVERAGE_EXCLUSION_AUTHORITY_INVALID" };
    }
    if (row.exclusionReason === "privacy_withheld" && !privacyAuthorizedUnitIds.has(row.unitId)) {
      return { ok: false, code: "COVERAGE_PRIVACY_AUTHORITY_MISSING" };
    }
    rows.push({
      unitId: row.unitId,
      disposition: "excluded",
      ownerId: `excluded:${row.unitId}`,
      exclusionReason: row.exclusionReason as CoverageExclusionReason,
    });
  }
  if (owned.size !== units.size) return { ok: false, code: "COVERAGE_UNIT_MISSING" };
  rows.sort((left, right) => compareAuthorityId(left.unitId, right.unitId));
  const canonicalManifest = {
    revision: manifest.revision,
    semanticManifestRevision: semanticManifest.revision,
    semanticManifestDigest: semanticManifest.manifestDigest,
    rows,
  };
  const coverageDigest = await authoritySha256(canonicalAuthorityJson(canonicalManifest));
  if (checkSubmittedDigest && coverageDigest !== manifest.coverageDigest) {
    return { ok: false, code: "COVERAGE_MANIFEST_DIGEST_STALE" };
  }
  return {
    ok: true,
    authority: {
      ...canonicalManifest,
      coverageDigest,
      serializedBytes,
    },
  };
}

export async function validateCoverageManifestAuthority(
  input: unknown,
  semanticManifest: SemanticManifestAuthority,
  privacyAuthorizedUnitIds: ReadonlySet<string> = new Set(),
): Promise<CoverageManifestValidation> {
  return validateCoverageManifestAuthorityInternal(
    input,
    semanticManifest,
    privacyAuthorizedUnitIds,
    true,
  );
}

export async function finalizeCoverageManifestAuthority(
  draft: unknown,
  semanticManifest: SemanticManifestAuthority,
  previous: unknown = null,
  privacyAuthorizedUnitIds: ReadonlySet<string> = new Set(),
): Promise<CoverageManifestValidation> {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
    return { ok: false, code: "COVERAGE_MANIFEST_INVALID" };
  }
  const value = draft as Record<string, unknown>;
  if (!authorityOnlyKeys(value, ["rows"]) || !Array.isArray(value.rows)) {
    return { ok: false, code: "COVERAGE_MANIFEST_INVALID" };
  }
  let previousRevision = 0;
  let previousAuthority: CoverageManifestAuthority | null = null;
  if (previous !== null) {
    if (!previous || typeof previous !== "object" || Array.isArray(previous)) {
      return { ok: false, code: "COVERAGE_MANIFEST_INVALID" };
    }
    const prior = previous as Record<string, unknown>;
    if (!authorityOnlyKeys(prior, [
      "revision", "semanticManifestRevision", "semanticManifestDigest", "coverageDigest", "rows",
    ]) || !positiveRevision(prior.revision) || !positiveRevision(prior.semanticManifestRevision)
      || !hexDigest(prior.semanticManifestDigest) || !hexDigest(prior.coverageDigest)
      || !Array.isArray(prior.rows)) {
      return { ok: false, code: "COVERAGE_MANIFEST_INVALID" };
    }
    previousRevision = prior.revision as number;
    const priorRows: CoverageRowAuthority[] = [];
    const priorUnitIds = new Set<string>();
    for (const candidate of prior.rows as unknown[]) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        return { ok: false, code: "COVERAGE_MANIFEST_INVALID" };
      }
      const row = candidate as Record<string, unknown>;
      if (!authorityOnlyKeys(row, ["unitId", "disposition", "ownerId", "exclusionReason"])
        || !boundedAuthorityId(row.unitId) || priorUnitIds.has(row.unitId)
        || (row.disposition !== "represented" && row.disposition !== "excluded")) {
        return { ok: false, code: "COVERAGE_MANIFEST_INVALID" };
      }
      priorUnitIds.add(row.unitId);
      if (row.disposition === "represented") {
        if (!boundedAuthorityId(row.ownerId) || row.exclusionReason !== undefined) {
          return { ok: false, code: "COVERAGE_MANIFEST_INVALID" };
        }
        priorRows.push({ unitId: row.unitId, disposition: "represented", ownerId: row.ownerId });
      } else {
        if (row.ownerId !== undefined || typeof row.exclusionReason !== "string"
          || !coverageReasons.has(row.exclusionReason)) {
          return { ok: false, code: "COVERAGE_MANIFEST_INVALID" };
        }
        priorRows.push({
          unitId: row.unitId,
          disposition: "excluded",
          ownerId: `excluded:${row.unitId}`,
          exclusionReason: row.exclusionReason as CoverageExclusionReason,
        });
      }
    }
    priorRows.sort((left, right) => compareAuthorityId(left.unitId, right.unitId));
    const priorCore = {
      revision: prior.revision as number,
      semanticManifestRevision: prior.semanticManifestRevision as number,
      semanticManifestDigest: prior.semanticManifestDigest as string,
      rows: priorRows,
    };
    const priorDigest = await authoritySha256(canonicalAuthorityJson(priorCore));
    if (priorDigest !== prior.coverageDigest) {
      return { ok: false, code: "COVERAGE_MANIFEST_DIGEST_STALE" };
    }
    previousAuthority = {
      ...priorCore,
      coverageDigest: priorDigest,
      serializedBytes: new TextEncoder().encode(JSON.stringify(prior)).byteLength,
    };
    if (prior.semanticManifestRevision === semanticManifest.revision
      && prior.semanticManifestDigest === semanticManifest.manifestDigest) {
      const validatedPrevious = await validateCoverageManifestAuthority(
        prior,
        semanticManifest,
        privacyAuthorizedUnitIds,
      );
      if (!validatedPrevious.ok) return validatedPrevious;
      previousAuthority = validatedPrevious.authority;
    }
  }
  const provisional = await validateCoverageManifestAuthorityInternal({
    revision: previousRevision || 1,
    semanticManifestRevision: semanticManifest.revision,
    semanticManifestDigest: semanticManifest.manifestDigest,
    coverageDigest: "0".repeat(64),
    rows: value.rows,
  }, semanticManifest, privacyAuthorizedUnitIds, false);
  if (!provisional.ok) return provisional;
  const revision = previousRevision === 0
    ? 1
    : previousAuthority
      && canonicalAuthorityJson(comparableCoverageManifest(previousAuthority))
        === canonicalAuthorityJson(comparableCoverageManifest(provisional.authority))
      ? previousRevision
      : previousRevision + 1;
  if (revision === provisional.authority.revision) return provisional;
  return validateCoverageManifestAuthorityInternal({
    revision,
    semanticManifestRevision: semanticManifest.revision,
    semanticManifestDigest: semanticManifest.manifestDigest,
    coverageDigest: "0".repeat(64),
    rows: value.rows,
  }, semanticManifest, privacyAuthorizedUnitIds, false);
}

function comparableCoverageManifest(manifest: CoverageManifestAuthority) {
  return {
    semanticManifestRevision: manifest.semanticManifestRevision,
    semanticManifestDigest: manifest.semanticManifestDigest,
    rows: manifest.rows,
  };
}

export function validateCoverageRevisionTransition(
  next: CoverageManifestAuthority,
  previous: CoverageManifestAuthority | null,
): CoverageManifestFailureCode | null {
  if (!previous) return next.revision === 1 ? null : "COVERAGE_REVISION_STALE";
  const unchanged = canonicalAuthorityJson(comparableCoverageManifest(previous))
    === canonicalAuthorityJson(comparableCoverageManifest(next));
  return next.revision === (unchanged ? previous.revision : previous.revision + 1)
    ? null : "COVERAGE_REVISION_STALE";
}

export async function readSemanticManifestAuthority(
  db: StorySourceDatabase,
  workflowRunId: string,
): Promise<SemanticManifestAuthority | null> {
  const current = await db.prepare(`SELECT 1 AS current FROM semantic_manifests m
      JOIN workflow_runs r ON r.id=m.workflow_run_id
      WHERE m.workflow_run_id=? AND m.source_revision=r.story_source_revision`)
    .bind(workflowRunId).first<{ current: number }>();
  return current ? readStoredSemanticManifestAuthority(db, workflowRunId) : null;
}

/** Reconstruct the last persisted semantic snapshot without requiring it to
 * match current source. This is used only for monotonic revision comparison. */
export async function readStoredSemanticManifestAuthority(
  db: StorySourceDatabase,
  workflowRunId: string,
): Promise<SemanticManifestAuthority | null> {
  const manifest = await db.prepare(`SELECT project_id,revision,source_digest,
      universe_digest,manifest_digest,serialized_bytes
      FROM semantic_manifests WHERE workflow_run_id=?`)
    .bind(workflowRunId).first<Record<string, unknown>>();
  if (!manifest) return null;
  const [{ results: unitRows }, { results: memberRows }] = await Promise.all([
    db.prepare(`SELECT id,revision,project_id,kind,member_count,membership_digest,
        duplicate_of_unit_id,story_projection_json
        FROM semantic_units WHERE workflow_run_id=? ORDER BY id`)
      .bind(workflowRunId).all<Record<string, unknown>>(),
    db.prepare(`SELECT unit_id,item_id,source_digest FROM semantic_unit_members
        WHERE workflow_run_id=? ORDER BY unit_id,item_id`)
      .bind(workflowRunId).all<{ unit_id: string; item_id: string; source_digest: string }>(),
  ]);
  const members = new Map<string, string[]>();
  const sourceDigests = new Map<string, string>();
  for (const row of memberRows) {
    const target = members.get(row.unit_id) || [];
    target.push(row.item_id);
    members.set(row.unit_id, target);
    sourceDigests.set(row.item_id, row.source_digest);
  }
  const input = {
    projectId: manifest.project_id,
    revision: Number(manifest.revision),
    sourceDigest: manifest.source_digest,
    universeDigest: manifest.universe_digest,
    manifestDigest: manifest.manifest_digest,
    units: unitRows.map((row) => {
      const storyProjection = JSON.parse(String(row.story_projection_json || "{}"));
      return {
        id: row.id,
        revision: Number(row.revision),
        projectId: row.project_id,
        kind: row.kind,
        members: members.get(String(row.id)) || [],
        memberCount: Number(row.member_count),
        membershipDigest: row.membership_digest,
        ...(row.duplicate_of_unit_id ? { duplicateOfUnitId: row.duplicate_of_unit_id } : {}),
        ...(Object.keys(storyProjection).length ? { storyProjection } : {}),
      };
    }),
  };
  const validation = await validateSemanticManifestAuthority(
    input,
    [...sourceDigests].map(([id, sourceDigest]) => ({ id, sourceDigest })),
  );
  return validation.ok ? validation.authority : null;
}

export async function readCoverageManifestAuthority(
  db: StorySourceDatabase,
  workflowRunId: string,
  semanticManifest: SemanticManifestAuthority,
): Promise<CoverageManifestAuthority | null> {
  const manifest = await db.prepare(`SELECT revision,semantic_manifest_revision,
      semantic_manifest_digest,coverage_digest,serialized_bytes
      FROM story_coverage_manifests WHERE workflow_run_id=?`)
    .bind(workflowRunId).first<Record<string, unknown>>();
  if (!manifest) return null;
  const { results } = await db.prepare(`SELECT unit_id,disposition,owner_id,exclusion_reason
      FROM story_coverage_rows WHERE workflow_run_id=? ORDER BY unit_id`)
    .bind(workflowRunId).all<Record<string, unknown>>();
  const input = {
    revision: Number(manifest.revision),
    semanticManifestRevision: Number(manifest.semantic_manifest_revision),
    semanticManifestDigest: manifest.semantic_manifest_digest,
    coverageDigest: manifest.coverage_digest,
    rows: results.map((row) => row.disposition === "represented" ? {
      unitId: row.unit_id,
      disposition: "represented",
      ownerId: row.owner_id,
    } : {
      unitId: row.unit_id,
      disposition: "excluded",
      exclusionReason: row.exclusion_reason,
    }),
  };
  const validation = await validateCoverageManifestAuthority(input, semanticManifest);
  return validation.ok ? validation.authority : null;
}

/** Read the last normalized coverage revision even when its semantic authority
 * is stale. This is used only to enforce monotonic revision transitions. */
export async function readStoredCoverageManifestAuthority(
  db: StorySourceDatabase,
  workflowRunId: string,
): Promise<CoverageManifestAuthority | null> {
  const manifest = await db.prepare(`SELECT revision,semantic_manifest_revision,
      semantic_manifest_digest,coverage_digest,serialized_bytes
      FROM story_coverage_manifests WHERE workflow_run_id=?`)
    .bind(workflowRunId).first<Record<string, unknown>>();
  if (!manifest) return null;
  const { results } = await db.prepare(`SELECT unit_id,disposition,owner_id,exclusion_reason
      FROM story_coverage_rows WHERE workflow_run_id=? ORDER BY unit_id`)
    .bind(workflowRunId).all<Record<string, unknown>>();
  return {
    revision: Number(manifest.revision),
    semanticManifestRevision: Number(manifest.semantic_manifest_revision),
    semanticManifestDigest: String(manifest.semantic_manifest_digest),
    coverageDigest: String(manifest.coverage_digest),
    serializedBytes: Number(manifest.serialized_bytes),
    rows: results.map((row) => ({
      unitId: String(row.unit_id),
      disposition: row.disposition === "represented" ? "represented" : "excluded",
      ownerId: String(row.owner_id),
      ...(row.exclusion_reason ? {
        exclusionReason: String(row.exclusion_reason) as CoverageExclusionReason,
      } : {}),
    })),
  };
}

export type StoryCandidateFailureCode =
  | "STORY_CANDIDATE_MISSING"
  | "STORY_CHAPTER_INVALID"
  | "STORY_KEY_DUPLICATED"
  | "STORY_SUMMARY_MISSING"
  | "STORY_SUMMARY_INCONSISTENT"
  | "STORY_CHAPTER_OVERVIEW_INVALID"
  | "STORY_PHASE_ORDER_INVALID"
  | "STORY_PHASE_QUALITY_INVALID"
  | "STORY_CURRENT_STATE_INVALID"
  | "STORY_NARRATIVE_SELF_REVIEW_MISSING"
  | "STORY_NARRATIVE_CONTRACT_FAILED"
  | "STORY_JUDGMENT_COVERAGE_INVALID"
  | "STORY_CONTEXT_RETENTION_INVALID"
  | "STORY_CLAIM_TRACEABILITY_INVALID"
  | "STORY_EVIDENCE_UNQUALIFIED"
  | "STORY_EVIDENCE_UNRESOLVED"
  | "STORY_EVIDENCE_DOCUMENT_MISMATCH"
  | "STORY_VALIDATION_FAILED"
  | "STORY_PEOPLE_EVIDENCE_INVALID";

export type StoryCandidateValidation =
  | { ok: true; chapterCount: number; canonicalCandidate: string }
  | { ok: false; code: StoryCandidateFailureCode };

const failure = (code: StoryCandidateFailureCode): StoryCandidateValidation => ({ ok: false, code });

export type SuccessorStorySourceFailureCode =
  | "SUCCESSOR_STORY_CANDIDATE_MISSING"
  | "SUCCESSOR_STORY_CHAPTER_INVALID"
  | "SUCCESSOR_STORY_KEY_DUPLICATED"
  | "SUCCESSOR_STORY_PHASE_INVALID"
  | "SUCCESSOR_STORY_PHASE_ORDER_INVALID"
  | "SUCCESSOR_STORY_EVIDENCE_INVALID"
  | "SUCCESSOR_STORY_PEOPLE_INVALID"
  | "SUCCESSOR_STORY_SEMANTIC_AUTHORITY_STALE"
  | "SUCCESSOR_STORY_COVERAGE_INVALID"
  | "SUCCESSOR_STORY_EXCLUDED_EVIDENCE_INVALID"
  | "SUCCESSOR_STORY_INSIGHT_GROUNDING_INVALID";

export type StoryCompletenessAuthority = {
  semanticManifest: SemanticManifestAuthority;
  coverageManifest: CoverageManifestAuthority;
};

export type StoryActivationAuthorityValidation =
  | {
      ok: true;
      source: Extract<RecognizedStorySourceValidation, { ok: true }>;
      coverageManifest: CoverageManifestAuthority;
    }
  | {
      ok: false;
      code: CoverageManifestFailureCode | SuccessorStorySourceFailureCode
        | StoryCandidateFailureCode | "STORY_SOURCE_PACKAGE_INVALID";
    };

export type SuccessorStorySourceValidation =
  | { ok: true; chapterCount: number; canonicalCandidate: string }
  | { ok: false; code: SuccessorStorySourceFailureCode };

export type RecognizedStorySourceValidation =
  | {
      ok: true;
      sourceSchema: "oxygen.story/3";
      sessionSchema: "oxygen.story-review-session/2";
      chapterCount: number;
      canonicalCandidate: string;
    }
  | {
      ok: true;
      sourceSchema: "oxygen.story-highlight/2";
      sessionSchema: "oxygen.story-review-session/1";
      chapterCount: number;
      canonicalCandidate: string;
    }
  | {
      ok: false;
      code: StoryCandidateFailureCode | SuccessorStorySourceFailureCode | "STORY_SOURCE_PACKAGE_INVALID";
    };

const successorFailure = (
  code: SuccessorStorySourceFailureCode,
): SuccessorStorySourceValidation => ({ ok: false, code });

const normalizedCopy = (value: string) => value.toLowerCase()
  .replace(/[^a-z0-9\p{L}]+/gu, " ")
  .trim();

const GENERIC_TITLES = new Set([
  "project update", "benchmark discussion", "project evolution", "workflow progress",
  "项目更新", "基准讨论", "项目演进", "工作流进展",
]);
const GENERIC_PHASES = new Set([
  "project evolution", "project update", "workflow progress",
  "项目演进", "项目更新", "工作流进展",
]);
const GENERIC_FILLER = [
  /^the team needed to\b/i,
  /^the team was working on the project\.?$/i,
  /^this passage shows\b/i,
  /^the evidence supported (?:a|the) change\.?$/i,
  /^the project adopted the new direction\.?$/i,
  /^the evidence supported a more explicit decision boundary\b/i,
  /^this highlights the importance of\b/i,
  /^the key takeaway is\b/i,
  /^(?:团队需要|这段文字表明|证据支持了更明确的决策边界|这凸显了|关键启示是)/,
  /^(?:团队正在开展项目|证据支持了(?:一项|这项)?变更|项目采用了新的方向)。?$/,
];
const PROHIBITED_EDITORIAL_STYLE = [
  /\bthe team needed to\b/i,
  /\bthis passage shows\b/i,
  /\bthis highlights the importance of\b/i,
  /\bthe key takeaway is\b/i,
  /\bthe project learned\b/i,
  /\bthe evidence wanted\b/i,
  /\bthe workflow fought back\b/i,
  /\brather than\b/i,
  /\binstead of\b/i,
  /,\s*(?:but\s+)?not\b/i,
  /\bnot\b[^.!?。！？]{0,80}\b(?:but|rather)\b/i,
  /(?:团队需要|这段文字表明|这凸显了|关键启示是|项目学会了|证据想要|工作流进行了反抗)/,
  /(?:不是.{0,40}而是|而不是|而非)/,
  /\b(?:evidence|workflow|model|agent|system|data|project)\s+(?:wanted|felt|believed|fought|hoped)\b/i,
];

const ACTOR_TYPES = new Set([
  "human", "user", "assistant", "ai", "agent", "implementation agent", "research agent",
  "reviewer", "operator", "speaker", "owner", "project owner", "technical lead",
  "data contributor", "contributor", "participant",
]);
const ACTOR_EVENTS = new Set([
  "message", "record", "speech", "instruction", "approval", "disagreement", "decision",
  "assignment", "agent action", "reviewer action", "operator action", "ownership",
]);
const CHAPTER_NAVIGATION_PROMPTS = [
  /^open (?:this|the) chapter\b/i,
  /^read (?:this|the) chapter\b/i,
  /^view (?:this|the) chapter\b/i,
  /^(?:打开|阅读|查看)(?:本|这)(?:章|章节)/,
];
const PASSAGE_IMPLEMENTATION_META = [
  /\b(?:this is\s+)?(?:the\s+)?(?:first|second|third|fourth|fifth|next|previous|semantic|numbered)\s+passage\b/i,
  /\bsemantic passage\s*\d+\b/i,
  /(?:这是)?本章第\s*\d+\s*个?(?:语义)?段落/,
  /第\s*\d+\s*个?语义段落/,
];

function looksLikeGenericFiller(value: string) {
  const compact = value.replace(/\s+/g, " ").trim();
  const englishWords = compact.match(/[A-Za-z0-9][A-Za-z0-9_-]*/g)?.length || 0;
  return GENERIC_FILLER.some((pattern) => pattern.test(compact))
    && (englishWords ? englishWords < 14 : compact.length < 32);
}

function isChapterNavigationPrompt(value: string) {
  const compact = value.replace(/\s+/g, " ").trim();
  return CHAPTER_NAVIGATION_PROMPTS.some((pattern) => pattern.test(compact));
}

function containsPassageImplementationMeta(value: string) {
  const compact = value.replace(/\s+/g, " ").trim();
  return PASSAGE_IMPLEMENTATION_META.some((pattern) => pattern.test(compact));
}

function actorSignature(row: StoryEvidenceRow) {
  const actorType = normalizedCopy(row.actorType || "");
  const eventType = normalizedCopy(row.eventType || "");
  if (actorType === "tool" || actorType === "system") {
    if (!row.actorId?.trim() || !ACTOR_EVENTS.has(eventType)) return "";
  } else if (!ACTOR_TYPES.has(actorType) && !(row.actorId?.trim() && ACTOR_EVENTS.has(eventType))) return "";
  const actorId = normalizedCopy(row.actorId || "");
  return JSON.stringify([actorType || "actor", actorId || eventType]);
}

function violatesEditorialStyle(value: string) {
  const compact = value.replace(/\s+/g, " ").trim();
  return PROHIBITED_EDITORIAL_STYLE.some((pattern) => pattern.test(compact));
}

function editorialCopy(annotation: StoryAnnotation) {
  const summary = annotation.reviewPresentation.projectSummary;
  const presentation = annotation.reviewPresentation.en;
  return [
    summary?.en || "",
    presentation.phase, presentation.title, presentation.timelineSummary,
    presentation.before, presentation.after, presentation.overview,
    ...presentation.people.flatMap((person) => [person.role, person.description]),
    presentation.story.scene, ...presentation.story.reconstruction,
    ...presentation.story.importantDetails, presentation.story.decisionOutcome,
    presentation.story.uncertainty || "",
    ...Object.values(presentation.passageContext).flatMap((context) => [
      context.whatWasHappening, context.whyItMattered,
      context.whatWeLearned || "", context.reusableLesson || "",
    ]),
    ...presentation.highlights.flatMap((insight) => [insight.title, insight.noticed, insight.lesson]),
  ];
}

function participantRolesAreIntegrated(
  presentation: StoryAnnotation["reviewPresentation"]["en"],
) {
  const decisionProcess = normalizedCopy(presentation.story.reconstruction.join(" "));
  return presentation.people.every((person) => {
    const role = normalizedCopy(person.role);
    return role.length > 1 && ` ${decisionProcess} `.includes(` ${role} `);
  });
}

function narrativeQualityPasses(annotation: StoryAnnotation) {
  const presentation = annotation.reviewPresentation.en;
  const canonicalStory = annotation.reviewPresentation.en.story;
  const editorial = annotation.narrativeReview?.editorial;
  if (!editorial
    || editorial.standardTerminology !== true
    || editorial.neutralStructure !== true
    || editorial.factualClaimsEvidenceBound !== true
    || editorial.interpretationSeparated !== true
    || editorial.uncertaintyPreserved !== true
    || editorial.prohibitedStyleChecked !== true
    || editorialCopy(annotation).some(violatesEditorialStyle)
    || GENERIC_TITLES.has(normalizedCopy(annotation.title))
    || GENERIC_TITLES.has(normalizedCopy(presentation.title))
    || !participantRolesAreIntegrated(presentation)
    || annotation.releaseEpisode.scene !== canonicalStory.scene
    || JSON.stringify(annotation.releaseEpisode.reconstruction) !== JSON.stringify(canonicalStory.reconstruction)
    || JSON.stringify(annotation.releaseEpisode.importantDetails) !== JSON.stringify(canonicalStory.importantDetails)
    || annotation.releaseEpisode.decisionOutcome !== canonicalStory.decisionOutcome
    || (annotation.releaseEpisode.uncertainty || "") !== (canonicalStory.uncertainty || "")) return false;
  return (() => {
    const blocks = new Map<string, string>([
      ["scene", presentation.story.scene],
      ...presentation.story.reconstruction.map((copy, index) => [`reconstruction-${index}`, copy] as const),
      ...presentation.story.importantDetails.map((copy, index) => [`detail-${index}`, copy] as const),
      ["outcome", presentation.story.decisionOutcome],
      ...(presentation.story.uncertainty ? [["uncertainty", presentation.story.uncertainty] as const] : []),
    ]);
    if ([...blocks.values()].some(looksLikeGenericFiller)) return false;
    const passageCopy: string[] = [];
    for (const [blockId, source] of blocks) {
      const context = presentation.passageContext[blockId];
      if (!context?.whatWasHappening?.trim()
        || !context.whyItMattered?.trim()
        || !context.whatWeLearned?.trim()
        || !context.reusableLesson?.trim()) return false;
      const fields = [
        context.whatWasHappening, context.whyItMattered,
        context.whatWeLearned, context.reusableLesson,
      ];
      const normalizedFields = fields.map(normalizedCopy);
      if (normalizedFields.includes(normalizedCopy(source))
        || new Set(normalizedFields).size !== normalizedFields.length
        || fields.some(looksLikeGenericFiller)
        || fields.some(containsPassageImplementationMeta)) return false;
      passageCopy.push(...fields);
    }
    const insight = presentation.highlights[0];
    const insightFields = [insight.title, insight.noticed, insight.lesson];
    const comparedCopy = [...blocks.values(), ...passageCopy].map(normalizedCopy);
    return new Set(insightFields.map(normalizedCopy)).size === insightFields.length
      && insightFields.every((copy) => !looksLikeGenericFiller(copy)
        && !comparedCopy.includes(normalizedCopy(copy)));
  })();
}

/** Validate one complete staged Story package without exposing any Story or Evidence payload. */
export function validateStoryCandidatePackage(
  candidateRows: StoryCandidateRow[],
  evidenceRows: StoryEvidenceRow[],
): StoryCandidateValidation {
  if (!candidateRows.length) return failure("STORY_CANDIDATE_MISSING");
  const orderedCandidateRows = [...candidateRows].sort(compareStorySourceIdentity);
  const annotations: StoryAnnotation[] = [];
  const keys = new Set<string>();
  let projectSummary = "";
  let activePhase = "";
  let activePhaseRationale = "";
  const completedPhases = new Set<string>();
  const phaseRationales = new Map<string, string>();
  const chapterOverviewsEn = new Set<string>();
  let currentStateChapterCount = 0;

  for (const row of orderedCandidateRows) {
    if (!row.summary.startsWith(STORY_PREFIX) || row.summary.startsWith(LEGACY_STORY_PREFIX)) {
      return failure("STORY_CHAPTER_INVALID");
    }
    const parsed = parseStoryAnnotation(row.summary);
    if (!parsed || parsed.schema !== "oxygen.story-highlight/2") {
      return failure("STORY_CHAPTER_INVALID");
    }
    if (parsed.kind === "current_state") currentStateChapterCount += 1;
    if (keys.has(parsed.key)) return failure("STORY_KEY_DUPLICATED");
    keys.add(parsed.key);

    const summary = parsed.reviewPresentation.projectSummary;
    if (!summary?.en?.trim()) return failure("STORY_SUMMARY_MISSING");
    const canonicalSummary = summary.en.trim();
    if (projectSummary && canonicalSummary !== projectSummary) {
      return failure("STORY_SUMMARY_INCONSISTENT");
    }
    projectSummary = canonicalSummary;

    const overviewEn = parsed.reviewPresentation.en.overview.trim();
    const normalizedOverviewEn = normalizedCopy(overviewEn);
    const exactSingleFieldCopy = [
      parsed.reviewPresentation.en.title,
      parsed.reviewPresentation.en.timelineSummary,
      parsed.reviewPresentation.en.before,
      parsed.reviewPresentation.en.after,
      parsed.reviewPresentation.en.story.scene,
      parsed.reviewPresentation.en.story.decisionOutcome,
    ].some((value) => normalizedCopy(value) === normalizedOverviewEn);
    if (isChapterNavigationPrompt(overviewEn)
      || looksLikeGenericFiller(overviewEn)
      || exactSingleFieldCopy
      || chapterOverviewsEn.has(normalizedOverviewEn)) {
      return failure("STORY_CHAPTER_OVERVIEW_INVALID");
    }
    chapterOverviewsEn.add(normalizedOverviewEn);

    const narrativeReview = parsed.narrativeReview;
    if (!narrativeReview) return failure("STORY_NARRATIVE_SELF_REVIEW_MISSING");
    if (!narrativeQualityPasses(parsed)) return failure("STORY_NARRATIVE_CONTRACT_FAILED");
    const phase = parsed.reviewPresentation.en.phase.trim();
    const phaseRationale = narrativeReview.phase.rationale.trim();
    if (normalizedCopy(parsed.phase) !== normalizedCopy(phase)
      || GENERIC_PHASES.has(normalizedCopy(phase))
      || normalizedCopy(phaseRationale) === normalizedCopy(phase)
      || looksLikeGenericFiller(phaseRationale)) {
      return failure("STORY_PHASE_QUALITY_INVALID");
    }
    if (phaseRationales.has(parsed.phase)
      && phaseRationales.get(parsed.phase) !== normalizedCopy(phaseRationale)) {
      return failure("STORY_PHASE_QUALITY_INVALID");
    }
    phaseRationales.set(parsed.phase, normalizedCopy(phaseRationale));

    if (parsed.phase !== activePhase) {
      if (completedPhases.has(parsed.phase)) return failure("STORY_PHASE_ORDER_INVALID");
      if (activePhase && activePhaseRationale === normalizedCopy(phaseRationale)) {
        return failure("STORY_PHASE_QUALITY_INVALID");
      }
      if (activePhase) completedPhases.add(activePhase);
      activePhase = parsed.phase;
      activePhaseRationale = normalizedCopy(phaseRationale);
    }

    const chapterEvidence = new Map<string, { row: StoryEvidenceRow; actor: string }>();
    for (const reference of [parsed.evidence.primary, ...parsed.evidence.supporting]) {
      const resolution = resolveEvidenceTarget(evidenceRows, reference.eventId);
      if (resolution.status !== "resolved") return failure("STORY_EVIDENCE_UNRESOLVED");
      if (reference.eventId !== resolution.itemId) return failure("STORY_EVIDENCE_UNQUALIFIED");
      const evidenceRow = evidenceRows[resolution.index];
      if (!evidenceRow) return failure("STORY_EVIDENCE_UNRESOLVED");
      if (evidenceRow?.documentId !== reference.documentId) {
        return failure("STORY_EVIDENCE_DOCUMENT_MISMATCH");
      }
      chapterEvidence.set(JSON.stringify([reference.documentId, resolution.itemId]), {
        row: evidenceRow,
        actor: actorSignature(evidenceRow),
      });
    }

    const people = parsed.reviewPresentation.en.people;
    const actorCoverage = narrativeReview.actorCoverage;
    const requiredActors = new Set([...chapterEvidence.values()].map((entry) => entry.actor).filter(Boolean));
    if (people.length === 0) return failure("STORY_VALIDATION_FAILED");
    if (requiredActors.size > 0) {
      if (actorCoverage?.state !== "people_present"
        || JSON.stringify(actorCoverage.personIds) !== JSON.stringify(people.map((person) => person.id))) {
        return failure("STORY_PEOPLE_EVIDENCE_INVALID");
      }
      const coveredActors = new Set<string>();
      for (const person of people) {
        if (!person.evidence?.length) return failure("STORY_PEOPLE_EVIDENCE_INVALID");
        const personActors = new Set<string>();
        for (const reference of person.evidence) {
          const resolution = resolveEvidenceTarget(evidenceRows, reference.eventId);
          if (resolution.status !== "resolved") return failure("STORY_PEOPLE_EVIDENCE_INVALID");
          if (reference.eventId !== resolution.itemId) {
            return failure("STORY_PEOPLE_EVIDENCE_INVALID");
          }
          const key = JSON.stringify([reference.documentId, resolution.itemId]);
          const chapterEntry = chapterEvidence.get(key);
          if (!chapterEntry || chapterEntry.row.documentId !== reference.documentId || !chapterEntry.actor) {
            return failure("STORY_PEOPLE_EVIDENCE_INVALID");
          }
          personActors.add(chapterEntry.actor);
        }
        if (personActors.size !== 1 || [...personActors].some((actor) => coveredActors.has(actor))) {
          return failure("STORY_PEOPLE_EVIDENCE_INVALID");
        }
        personActors.forEach((actor) => coveredActors.add(actor));
      }
      if ([...requiredActors].some((actor) => !coveredActors.has(actor))) {
        return failure("STORY_PEOPLE_EVIDENCE_INVALID");
      }
    } else return failure("STORY_PEOPLE_EVIDENCE_INVALID");

    const storyBlocks = [
      "scene",
      ...parsed.reviewPresentation.en.story.reconstruction.map((_, index) => `reconstruction-${index}`),
      ...parsed.reviewPresentation.en.story.importantDetails.map((_, index) => `detail-${index}`),
      "outcome",
      ...(parsed.reviewPresentation.en.story.uncertainty ? ["uncertainty"] : []),
    ];
    const peopleBlocks = people.map((person) => `people:${person.id}`);
    const insightBlocks = parsed.reviewPresentation.en.highlights.map((insight) => `insight:${insight.id}`);
    const expectedTraceKinds = new Map([
      ["overview", "factual_claim"] as const,
      ...peopleBlocks.map((blockId) => [blockId, "factual_claim"] as const),
      ...storyBlocks.map((blockId) => [blockId, "factual_claim"] as const),
      ...insightBlocks.map((blockId) => [blockId, "insight_input"] as const),
    ]);
    const referenceBelongsToChapter = (reference: { documentId: string; eventId: string }) => {
      const resolution = resolveEvidenceTarget(evidenceRows, reference.eventId);
      if (resolution.status !== "resolved" || reference.eventId !== resolution.itemId) return false;
      const entry = chapterEvidence.get(JSON.stringify([reference.documentId, resolution.itemId]));
      return Boolean(entry && entry.row.documentId === reference.documentId);
    };
    const referenceResolves = (reference: { documentId: string; eventId: string }) => {
      const resolution = resolveEvidenceTarget(evidenceRows, reference.eventId);
      if (resolution.status !== "resolved" || reference.eventId !== resolution.itemId) return false;
      return evidenceRows[resolution.index]?.documentId === reference.documentId;
    };
    const referenceKey = (reference: { documentId: string; eventId: string }) => (
      JSON.stringify([reference.documentId, reference.eventId])
    );
    const traceability = narrativeReview.claimTraceability;
    if (!traceability?.length) return failure("STORY_CLAIM_TRACEABILITY_INVALID");
    const traceEvidenceByBlock = new Map<string, Set<string>>();
    const traceUnitsByBlock = new Map<string, Set<string>>();
    for (const claim of traceability) {
      const expectedKind = expectedTraceKinds.get(claim.blockId);
      if (!expectedKind || claim.kind !== expectedKind
        || !claim.evidence.length || !claim.evidence.every(referenceBelongsToChapter)) {
        return failure("STORY_CLAIM_TRACEABILITY_INVALID");
      }
      const keysForBlock = traceEvidenceByBlock.get(claim.blockId) || new Set<string>();
      claim.evidence.forEach((reference) => keysForBlock.add(referenceKey(reference)));
      traceEvidenceByBlock.set(claim.blockId, keysForBlock);
      if (claim.unitIds?.length) {
        const unitsForBlock = traceUnitsByBlock.get(claim.blockId) || new Set<string>();
        claim.unitIds.forEach((unitId) => unitsForBlock.add(unitId));
        traceUnitsByBlock.set(claim.blockId, unitsForBlock);
      }
    }
    if ([...expectedTraceKinds.keys()].some((blockId) => !traceEvidenceByBlock.has(blockId))) {
      return failure("STORY_CLAIM_TRACEABILITY_INVALID");
    }

    const retention = narrativeReview.contextRetention;
    if (!retention) return failure("STORY_CONTEXT_RETENTION_INVALID");
    const declaredScope = new Set(retention.sourceScope.map(referenceKey));
    const chapterScope = new Set([
      parsed.evidence.primary,
      ...parsed.evidence.supporting,
    ].map(referenceKey));
    const requiredScope = new Set<string>();
    for (const claim of traceability) {
      if (claim.kind === "factual_claim") {
        claim.evidence.forEach((reference) => requiredScope.add(referenceKey(reference)));
      }
    }
    for (const unit of retention.units) {
      if (unit.state === "represented") requiredScope.add(referenceKey(unit.evidence));
    }
    const sameScope = (left: Set<string>, right: Set<string>) => (
      left.size === right.size && [...left].every((key) => right.has(key))
    );
    if (!retention.sourceScope.every(referenceBelongsToChapter)
      || !sameScope(declaredScope, chapterScope)
      || !sameScope(chapterScope, requiredScope)) {
      return failure("STORY_CONTEXT_RETENTION_INVALID");
    }
    const representedUnits = new Map(retention.units
      .filter((unit) => unit.state === "represented")
      .map((unit) => [unit.id, unit]));
    if (representedUnits.size !== retention.representedUnitCount) {
      return failure("STORY_CONTEXT_RETENTION_INVALID");
    }
    for (const unit of retention.units) {
      if (unit.state === "excluded" && !referenceResolves(unit.evidence)) {
        return failure("STORY_CONTEXT_RETENTION_INVALID");
      }
      if (unit.state === "represented" && !referenceBelongsToChapter(unit.evidence)) {
        return failure("STORY_CONTEXT_RETENTION_INVALID");
      }
      if (unit.state !== "represented") continue;
      const evidenceKeyForUnit = referenceKey(unit.evidence);
      for (const blockId of unit.blockIds) {
        if (!storyBlocks.includes(blockId)
          || !traceUnitsByBlock.get(blockId)?.has(unit.id)
          || !traceEvidenceByBlock.get(blockId)?.has(evidenceKeyForUnit)) {
          return failure("STORY_CONTEXT_RETENTION_INVALID");
        }
      }
    }
    for (const claim of traceability) {
      for (const unitId of claim.unitIds || []) {
        const unit = representedUnits.get(unitId);
        if (!unit || !unit.blockIds.includes(claim.blockId)
          || !unit.evidence || !claim.evidence.some((reference) => (
            referenceKey(reference) === referenceKey(unit.evidence)
          ))) return failure("STORY_CONTEXT_RETENTION_INVALID");
      }
    }

    const coverage = narrativeReview.coverageLedger;
    if (!coverage) return failure("STORY_JUDGMENT_COVERAGE_INVALID");
    for (const key of STORY_COVERAGE_KEYS) {
      const item = coverage[key];
      if (!item) return failure("STORY_JUDGMENT_COVERAGE_INVALID");
      if (item.state === "represented") {
        if (!item.evidence.every(referenceBelongsToChapter)
          || item.blockIds.some((blockId) => key === "participants"
            ? !peopleBlocks.includes(blockId)
            : !storyBlocks.includes(blockId))) {
          return failure("STORY_JUDGMENT_COVERAGE_INVALID");
        }
        for (const blockId of item.blockIds) {
          const claimEvidence = traceEvidenceByBlock.get(blockId);
          if (!claimEvidence || !item.evidence.some((reference) => claimEvidence.has(referenceKey(reference)))) {
            return failure("STORY_JUDGMENT_COVERAGE_INVALID");
          }
        }
      } else if (item.state === "supporting_detail") {
        // Historical artifacts remain parseable, but a new reviewable Chapter must
        // place every supported explanatory unit in a traceable Story block.
        return failure("STORY_CONTEXT_RETENTION_INVALID");
      }
    }
    const requiredRepresentations: Array<[typeof STORY_COVERAGE_KEYS[number], string]> = [
      ["mainProblem", "scene"],
      ["finalAction", "outcome"],
      ["result", "outcome"],
    ];
    if (requiredRepresentations.some(([key, blockId]) => (
      coverage[key].state !== "represented" || !coverage[key].blockIds.includes(blockId)
    ))) return failure("STORY_JUDGMENT_COVERAGE_INVALID");
    const participantCoverage = coverage.participants;
    if (participantCoverage.state !== "represented"
      || JSON.stringify([...participantCoverage.blockIds].sort()) !== JSON.stringify([...peopleBlocks].sort())) {
      return failure("STORY_JUDGMENT_COVERAGE_INVALID");
    }
    const peopleEvidence = new Set(people.flatMap((person) => (person.evidence || []).map(referenceKey)));
    if (JSON.stringify([...new Set(participantCoverage.evidence.map(referenceKey))].sort())
      !== JSON.stringify([...peopleEvidence].sort())) {
      return failure("STORY_JUDGMENT_COVERAGE_INVALID");
    }
    const uncertaintyCoverage = coverage.remainingUncertainty;
    if (parsed.reviewPresentation.en.story.uncertainty) {
      if (uncertaintyCoverage.state !== "represented"
        || !uncertaintyCoverage.blockIds.includes("uncertainty")) {
        return failure("STORY_JUDGMENT_COVERAGE_INVALID");
      }
    } else if (uncertaintyCoverage.state !== "not_supported") {
      return failure("STORY_JUDGMENT_COVERAGE_INVALID");
    }
    annotations.push(parsed);
  }

  if (currentStateChapterCount !== 1 || annotations.at(-1)?.kind !== "current_state") {
    return failure("STORY_CURRENT_STATE_INVALID");
  }

  return {
    ok: true,
    chapterCount: annotations.length,
    canonicalCandidate: JSON.stringify(orderedCandidateRows.map((row) => ({ id: row.id, summary: row.summary }))),
  };
}

const successorGenericPhases = new Set([
  ...GENERIC_PHASES,
  "general work",
  "other",
  "later stage",
]);
const successorPhaseLabelPattern = /^[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*(?:\s+[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*)?$/u;

/** Validate Story-First source semantics without widening current contracts. */
export function validateSuccessorStorySourcePackage(
  candidateRows: StoryCandidateRow[],
  evidenceRows: StoryEvidenceRow[],
  completenessAuthority?: StoryCompletenessAuthority,
): SuccessorStorySourceValidation {
  if (!candidateRows.length) return successorFailure("SUCCESSOR_STORY_CANDIDATE_MISSING");
  const orderedCandidateRows = [...candidateRows].sort(compareStorySourceIdentity);
  const keys = new Set<string>();
  const completedPhases = new Set<string>();
  const phaseLabels = new Map<string, string>();
  const declaredCoverage = new Set<string>();
  const semanticUnits = completenessAuthority
    ? new Map(completenessAuthority.semanticManifest.units.map((unit) => [unit.id, unit]))
    : null;
  const coverageRows = completenessAuthority
    ? new Map(completenessAuthority.coverageManifest.rows.map((row) => [row.unitId, row]))
    : null;
  const memberCoverage = new Map<string, CoverageRowAuthority>();
  if (completenessAuthority) {
    if (completenessAuthority.coverageManifest.semanticManifestRevision
        !== completenessAuthority.semanticManifest.revision
      || completenessAuthority.coverageManifest.semanticManifestDigest
        !== completenessAuthority.semanticManifest.manifestDigest
      || coverageRows!.size !== completenessAuthority.coverageManifest.rows.length
      || semanticUnits!.size !== completenessAuthority.semanticManifest.units.length
      || coverageRows!.size !== semanticUnits!.size) {
      return successorFailure("SUCCESSOR_STORY_SEMANTIC_AUTHORITY_STALE");
    }
    for (const unit of completenessAuthority.semanticManifest.units) {
      const row = coverageRows!.get(unit.id);
      if (!row) return successorFailure("SUCCESSOR_STORY_COVERAGE_INVALID");
      for (const member of unit.members) memberCoverage.set(member, row);
    }
  }
  let semanticReference = "";
  let coverageReference = "";
  let activePhase = "";

  for (const row of orderedCandidateRows) {
    if (!row.summary.startsWith(SUCCESSOR_STORY_PREFIX)) {
      return successorFailure("SUCCESSOR_STORY_CHAPTER_INVALID");
    }
    const parsed = parseStorySource(row.summary);
    if (!parsed || parsed.schema !== "oxygen.story/3") {
      return successorFailure("SUCCESSOR_STORY_CHAPTER_INVALID");
    }
    if (row.id !== parsed.evidence.primary.eventId
      || row.documentId !== parsed.evidence.primary.documentId) {
      return successorFailure("SUCCESSOR_STORY_EVIDENCE_INVALID");
    }
    if (keys.has(parsed.key)) return successorFailure("SUCCESSOR_STORY_KEY_DUPLICATED");
    keys.add(parsed.key);

    const chapterSemanticReference = `${parsed.coverage.semanticManifest.revision}:`
      + parsed.coverage.semanticManifest.digest;
    const chapterCoverageReference = `${parsed.coverage.coverageManifest.revision}:`
      + parsed.coverage.coverageManifest.digest;
    if ((semanticReference && semanticReference !== chapterSemanticReference)
      || (coverageReference && coverageReference !== chapterCoverageReference)) {
      return successorFailure("SUCCESSOR_STORY_SEMANTIC_AUTHORITY_STALE");
    }
    semanticReference = chapterSemanticReference;
    coverageReference = chapterCoverageReference;
    if (completenessAuthority && (
      parsed.coverage.semanticManifest.revision !== completenessAuthority.semanticManifest.revision
      || parsed.coverage.semanticManifest.digest !== completenessAuthority.semanticManifest.manifestDigest
      || parsed.coverage.coverageManifest.revision !== completenessAuthority.coverageManifest.revision
      || parsed.coverage.coverageManifest.digest !== completenessAuthority.coverageManifest.coverageDigest
    )) return successorFailure("SUCCESSOR_STORY_SEMANTIC_AUTHORITY_STALE");

    for (const unitId of parsed.coverage.representedUnitIds) {
      if (declaredCoverage.has(unitId)) {
        return successorFailure("SUCCESSOR_STORY_COVERAGE_INVALID");
      }
      declaredCoverage.add(unitId);
      if (completenessAuthority) {
        const coverage = coverageRows!.get(unitId);
        if (!semanticUnits!.has(unitId) || coverage?.disposition !== "represented"
          || coverage.ownerId !== parsed.key) {
          return successorFailure("SUCCESSOR_STORY_COVERAGE_INVALID");
        }
      }
    }
    for (const excluded of parsed.coverage.excludedUnits) {
      if (declaredCoverage.has(excluded.unitId)) {
        return successorFailure("SUCCESSOR_STORY_COVERAGE_INVALID");
      }
      declaredCoverage.add(excluded.unitId);
      if (completenessAuthority) {
        const coverage = coverageRows!.get(excluded.unitId);
        if (!semanticUnits!.has(excluded.unitId) || coverage?.disposition !== "excluded"
          || coverage.exclusionReason !== excluded.reason) {
          return successorFailure("SUCCESSOR_STORY_COVERAGE_INVALID");
        }
      }
    }

    const phaseId = parsed.phase.id;
    const phaseLabel = parsed.phase.label.trim();
    const phaseWordCount = phaseLabel.split(/\s+/u).length;
    if (phaseWordCount < 1 || phaseWordCount > 2
      || !successorPhaseLabelPattern.test(phaseLabel)
      || successorGenericPhases.has(normalizedCopy(phaseLabel))) {
      return successorFailure("SUCCESSOR_STORY_PHASE_INVALID");
    }
    const existingPhaseLabel = phaseLabels.get(phaseId);
    if (existingPhaseLabel && existingPhaseLabel !== phaseLabel) {
      return successorFailure("SUCCESSOR_STORY_PHASE_INVALID");
    }
    phaseLabels.set(phaseId, phaseLabel);
    if (phaseId !== activePhase) {
      if (completedPhases.has(phaseId)) {
        return successorFailure("SUCCESSOR_STORY_PHASE_ORDER_INVALID");
      }
      if (activePhase) completedPhases.add(activePhase);
      activePhase = phaseId;
    }

    const chapterEvidence = new Map<string, { row: StoryEvidenceRow; actor: string }>();
    const evidenceReferences = [parsed.evidence.primary, ...parsed.evidence.supporting];
    for (const reference of evidenceReferences) {
      const resolution = resolveEvidenceTarget(evidenceRows, reference.eventId);
      if (resolution.status !== "resolved" || reference.eventId !== resolution.itemId) {
        return successorFailure("SUCCESSOR_STORY_EVIDENCE_INVALID");
      }
      const evidenceRow = evidenceRows[resolution.index];
      if (!evidenceRow || evidenceRow.documentId !== reference.documentId) {
        return successorFailure("SUCCESSOR_STORY_EVIDENCE_INVALID");
      }
      if (completenessAuthority
        && memberCoverage.get(reference.eventId)?.disposition === "excluded") {
        return successorFailure("SUCCESSOR_STORY_EXCLUDED_EVIDENCE_INVALID");
      }
      chapterEvidence.set(JSON.stringify([reference.documentId, reference.eventId]), {
        row: evidenceRow,
        actor: actorSignature(evidenceRow),
      });
    }
    const belongsToChapter = (reference: { documentId: string; eventId: string }) => (
      chapterEvidence.has(JSON.stringify([reference.documentId, reference.eventId]))
    );
    const narrativeEvidence = new Set<string>();

    if (parsed.people.length === 0) return successorFailure("SUCCESSOR_STORY_PEOPLE_INVALID");
    const requiredActors = new Set([...chapterEvidence.values()].map((entry) => entry.actor).filter(Boolean));
    if (requiredActors.size === 0) return successorFailure("SUCCESSOR_STORY_PEOPLE_INVALID");
    const coveredActors = new Set<string>();
    for (const person of parsed.people) {
      if (!person.evidence.every(belongsToChapter)) {
        return successorFailure("SUCCESSOR_STORY_PEOPLE_INVALID");
      }
      person.evidence.forEach((reference) => narrativeEvidence.add(reference.eventId));
      const personActors = new Set(person.evidence.map((reference) => (
        chapterEvidence.get(JSON.stringify([reference.documentId, reference.eventId]))?.actor || ""
      )));
      if (personActors.size !== 1 || personActors.has("")
        || [...personActors].some((actor) => coveredActors.has(actor))) {
        return successorFailure("SUCCESSOR_STORY_PEOPLE_INVALID");
      }
      personActors.forEach((actor) => coveredActors.add(actor));
    }
    if ([...requiredActors].some((actor) => !coveredActors.has(actor))) {
      return successorFailure("SUCCESSOR_STORY_PEOPLE_INVALID");
    }

    const storyBlocks = new Map(parsed.story.blocks.map((block) => [block.id, block]));
    for (const block of parsed.story.blocks) {
      if (!block.evidence.every(belongsToChapter)) {
        return successorFailure("SUCCESSOR_STORY_EVIDENCE_INVALID");
      }
      block.evidence.forEach((reference) => narrativeEvidence.add(reference.eventId));
    }
    for (const insight of parsed.insights) {
      const anchoredBlocks = insight.quote.storyBlockIds.map((blockId) => storyBlocks.get(blockId));
      if (anchoredBlocks.some((block) => !block)
        || !insight.evidence.every(belongsToChapter)) {
        return successorFailure("SUCCESSOR_STORY_INSIGHT_GROUNDING_INVALID");
      }
      const anchoredEvidence = new Set(anchoredBlocks.flatMap((block) => (
        block?.evidence.map((reference) => JSON.stringify([reference.documentId, reference.eventId])) || []
      )));
      if (insight.evidence.some((reference) => !anchoredEvidence.has(
        JSON.stringify([reference.documentId, reference.eventId]),
      ))) return successorFailure("SUCCESSOR_STORY_INSIGHT_GROUNDING_INVALID");
      insight.evidence.forEach((reference) => narrativeEvidence.add(reference.eventId));
    }
    if (completenessAuthority) {
      for (const unitId of parsed.coverage.representedUnitIds) {
        const unit = semanticUnits!.get(unitId);
        if (!unit || !unit.members.some((member) => narrativeEvidence.has(member))) {
          return successorFailure("SUCCESSOR_STORY_COVERAGE_INVALID");
        }
      }
    }
  }

  if (completenessAuthority && (
    declaredCoverage.size !== coverageRows!.size
    || [...coverageRows!.keys()].some((unitId) => !declaredCoverage.has(unitId))
  )) return successorFailure("SUCCESSOR_STORY_COVERAGE_INVALID");

  return {
    ok: true,
    chapterCount: orderedCandidateRows.length,
    canonicalCandidate: JSON.stringify(orderedCandidateRows.map((row) => ({ id: row.id, summary: row.summary }))),
  };
}

/** Permanently dispatch one complete homogeneous review package by exact source
 * version. Historical, mixed, malformed, unknown, and empty packages fail closed. */
export function validateRecognizedStorySourcePackage(
  candidateRows: StoryCandidateRow[],
  evidenceRows: StoryEvidenceRow[],
  completenessAuthority?: StoryCompletenessAuthority,
): RecognizedStorySourceValidation {
  if (!candidateRows.length) return { ok: false, code: "STORY_SOURCE_PACKAGE_INVALID" };
  if (candidateRows.every((row) => row.summary.startsWith(SUCCESSOR_STORY_PREFIX))) {
    const validation = validateSuccessorStorySourcePackage(
      candidateRows,
      evidenceRows,
      completenessAuthority,
    );
    return validation.ok
      ? {
          ...validation,
          sourceSchema: "oxygen.story/3",
          sessionSchema: "oxygen.story-review-session/2",
        }
      : validation;
  }
  if (candidateRows.every((row) => row.summary.startsWith(STORY_PREFIX))) {
    const validation = validateStoryCandidatePackage(candidateRows, evidenceRows);
    return validation.ok
      ? {
          ...validation,
          sourceSchema: "oxygen.story-highlight/2",
          sessionSchema: "oxygen.story-review-session/1",
        }
      : validation;
  }
  return { ok: false, code: "STORY_SOURCE_PACKAGE_INVALID" };
}

/** One canonical activation seam: normalize server-owned unit coverage, then
 * validate the Story package against that exact semantic authority. */
export async function validateStoryActivationAuthority(
  candidateRows: StoryCandidateRow[],
  evidenceRows: StoryEvidenceRow[],
  semanticManifest: SemanticManifestAuthority,
  coverageInput: unknown,
): Promise<StoryActivationAuthorityValidation> {
  const coverage = await validateCoverageManifestAuthority(coverageInput, semanticManifest);
  if (!coverage.ok) return coverage;
  const source = validateRecognizedStorySourcePackage(candidateRows, evidenceRows, {
    semanticManifest,
    coverageManifest: coverage.authority,
  });
  return source.ok
    ? { ok: true, source, coverageManifest: coverage.authority }
    : source;
}

/** Render only explicit v2 Chapters. Fallback/legacy milestones are never a review-ready Story. */
export function selectReviewableStoryTimeline<T extends TimelineCandidate>(
  events: T[],
): Array<TimelineMilestone<T>> {
  const milestones = selectProjectTimeline(events, Number.MAX_SAFE_INTEGER);
  return milestones.length > 0 && milestones.every((milestone) => (
    milestone.story.explicit
    && Boolean(milestone.story.releaseEpisode)
    && Boolean(milestone.story.reviewPresentation)
    && Boolean(milestone.story.insight)
    && Boolean(milestone.story.evidence)
  ))
    ? milestones
    : [];
}
