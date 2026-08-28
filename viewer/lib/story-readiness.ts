import type { getLocalDatabase } from "../db";
import {
  STORY_PREFIX,
  STORY_SEMANTIC_EXCLUSION_REASONS,
  MAX_STORY_SEMANTIC_UNIT_REFERENCES,
  compareStorySourceIdentity,
  parseStorySource,
  resolveEvidenceTarget,
  type StorySource,
  type TimelineCandidate,
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
  | { ok: true; rows: StoryCandidateRow[]; storyItemsByDocument: Map<string, TimelineCandidate[]> }
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
  const storyItemsByDocument = new Map<string, TimelineCandidate[]>();
  for (const candidate of input) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return { ok: false, code: "STORY_CANDIDATE_SUBMISSION_INVALID" };
    }
    const record = candidate as Record<string, unknown>;
    if (!authorityOnlyKeys(record, ["id", "summary"])
      || !boundedAuthorityId(record.id) || typeof record.summary !== "string"
      || !record.summary.startsWith(STORY_PREFIX)) {
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
    const storyItems = storyItemsByDocument.get(authority.documentId) || [];
    storyItems.push({
      id: row.id,
      sequence: row.sequence,
      ...(row.timestamp ? { timestamp: row.timestamp } : {}),
      ...(authority.project ? { project: authority.project } : {}),
      summary: row.summary,
    });
    storyItemsByDocument.set(authority.documentId, storyItems);
  }
  rows.sort(compareStorySourceIdentity);
  for (const storyItems of storyItemsByDocument.values()) storyItems.sort(compareStorySourceIdentity);
  return { ok: true, rows, storyItemsByDocument };
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

export type ViewerChapter = {
  id: string;
  sequence: number;
  timestamp?: string;
  project: string;
  documentId?: string;
  source: StorySource;
  story: StorySource;
};

export function selectViewerChapters(
  storyItems: TimelineCandidate[] | undefined,
  fallbackProject: string,
): { chapters: ViewerChapter[]; invalid: boolean } {
  const seen = new Map<string, string>();
  const chapters: ViewerChapter[] = [];
  for (const event of [...(storyItems || [])].sort(compareStorySourceIdentity)) {
    const source = parseStorySource(event.summary);
    if (!source) {
      if (String(event.summary || "").startsWith(STORY_PREFIX)) {
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
  options: { verifyCurrentSource?: boolean } = {},
): Promise<CoverageManifestAuthority | null> {
  const { readCoveragePrivacyAuthority } = await import("./story-coverage-privacy-authority.ts");
  const privacyAuthority = await readCoveragePrivacyAuthority(
    db,
    workflowRunId,
    semanticManifest,
    options,
  );
  if (!privacyAuthority.ok) return null;
  const manifest = await db.prepare(`SELECT revision,semantic_manifest_revision,
      semantic_manifest_digest,coverage_digest,privacy_authority_digest,serialized_bytes
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
  const validation = await validateCoverageManifestAuthority(
    input,
    semanticManifest,
    privacyAuthority.authority.authorizedUnitIds,
  );
  return validation.ok
    && manifest.privacy_authority_digest === privacyAuthority.authority.snapshotDigest
    ? validation.authority : null;
}

/** Read the last normalized coverage revision even when its semantic authority
 * is stale. This is used only to enforce monotonic revision transitions. */
export async function readStoredCoverageManifestAuthority(
  db: StorySourceDatabase,
  workflowRunId: string,
): Promise<CoverageManifestAuthority | null> {
  const manifest = await db.prepare(`SELECT revision,semantic_manifest_revision,
      semantic_manifest_digest,coverage_digest,privacy_authority_digest,serialized_bytes
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

export type StorySourceFailureCode =
  | "STORY_CANDIDATE_MISSING"
  | "STORY_CHAPTER_INVALID"
  | "STORY_KEY_DUPLICATED"
  | "STORY_PHASE_INVALID"
  | "STORY_PHASE_ORDER_INVALID"
  | "STORY_EVIDENCE_INVALID"
  | "STORY_PEOPLE_INVALID"
  | "STORY_SEMANTIC_AUTHORITY_STALE"
  | "STORY_COVERAGE_INVALID"
  | "STORY_EXCLUDED_EVIDENCE_INVALID"
  | "STORY_INSIGHT_GROUNDING_INVALID";

export type StoryCompletenessAuthority = {
  semanticManifest: SemanticManifestAuthority;
  coverageManifest: CoverageManifestAuthority;
};

export type StorySourceValidation =
  | { ok: true; chapterCount: number; canonicalCandidate: string }
  | { ok: false; code: StorySourceFailureCode };

export type StoryActivationAuthorityValidation =
  | {
      ok: true;
      source: Extract<StorySourceValidation, { ok: true }>;
      coverageManifest: CoverageManifestAuthority;
    }
  | {
      ok: false;
      code: CoverageManifestFailureCode | StorySourceFailureCode;
    };

const storySourceFailure = (
  code: StorySourceFailureCode,
): StorySourceValidation => ({ ok: false, code });

const normalizedCopy = (value: string) => value.toLowerCase()
  .replace(/[^a-z0-9\p{L}]+/gu, " ")
  .trim();

const ACTOR_TYPES = new Set([
  "human", "user", "assistant", "ai", "agent", "implementation agent", "research agent",
  "reviewer", "operator", "speaker", "owner", "project owner", "technical lead",
  "data contributor", "contributor", "participant",
]);
const ACTOR_EVENTS = new Set([
  "message", "record", "speech", "instruction", "approval", "disagreement", "decision",
  "assignment", "agent action", "reviewer action", "operator action", "ownership",
]);

function actorSignature(row: StoryEvidenceRow) {
  const actorType = normalizedCopy(row.actorType || "");
  const eventType = normalizedCopy(row.eventType || "");
  if (actorType === "tool" || actorType === "system") {
    if (!row.actorId?.trim() || !ACTOR_EVENTS.has(eventType)) return "";
  } else if (!ACTOR_TYPES.has(actorType) && !(row.actorId?.trim() && ACTOR_EVENTS.has(eventType))) return "";
  const actorId = normalizedCopy(row.actorId || "");
  return JSON.stringify([actorType || "actor", actorId || eventType]);
}

const genericStoryPhases = new Set([
  "project evolution",
  "project update",
  "workflow progress",
  "项目演进",
  "项目更新",
  "工作流进展",
  "general work",
  "other",
  "later stage",
]);
const storyPhaseLabelPattern = /^[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*(?:\s+[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*)?$/u;

/** Validate the complete canonical Story package against exact source authority. */
export function validateStorySourcePackage(
  candidateRows: StoryCandidateRow[],
  evidenceRows: StoryEvidenceRow[],
  completenessAuthority?: StoryCompletenessAuthority,
): StorySourceValidation {
  if (!candidateRows.length) return storySourceFailure("STORY_CANDIDATE_MISSING");
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
      return storySourceFailure("STORY_SEMANTIC_AUTHORITY_STALE");
    }
    for (const unit of completenessAuthority.semanticManifest.units) {
      const row = coverageRows!.get(unit.id);
      if (!row) return storySourceFailure("STORY_COVERAGE_INVALID");
      for (const member of unit.members) memberCoverage.set(member, row);
    }
  }
  let semanticReference = "";
  let coverageReference = "";
  let activePhase = "";

  for (const row of orderedCandidateRows) {
    if (!row.summary.startsWith(STORY_PREFIX)) {
      return storySourceFailure("STORY_CHAPTER_INVALID");
    }
    const parsed = parseStorySource(row.summary);
    if (!parsed || parsed.schema !== "oxygen.story") {
      return storySourceFailure("STORY_CHAPTER_INVALID");
    }
    if (row.id !== parsed.evidence.primary.eventId
      || row.documentId !== parsed.evidence.primary.documentId) {
      return storySourceFailure("STORY_EVIDENCE_INVALID");
    }
    if (keys.has(parsed.key)) return storySourceFailure("STORY_KEY_DUPLICATED");
    keys.add(parsed.key);

    const chapterSemanticReference = `${parsed.coverage.semanticManifest.revision}:`
      + parsed.coverage.semanticManifest.digest;
    const chapterCoverageReference = `${parsed.coverage.coverageManifest.revision}:`
      + parsed.coverage.coverageManifest.digest;
    if ((semanticReference && semanticReference !== chapterSemanticReference)
      || (coverageReference && coverageReference !== chapterCoverageReference)) {
      return storySourceFailure("STORY_SEMANTIC_AUTHORITY_STALE");
    }
    semanticReference = chapterSemanticReference;
    coverageReference = chapterCoverageReference;
    if (completenessAuthority && (
      parsed.coverage.semanticManifest.revision !== completenessAuthority.semanticManifest.revision
      || parsed.coverage.semanticManifest.digest !== completenessAuthority.semanticManifest.manifestDigest
      || parsed.coverage.coverageManifest.revision !== completenessAuthority.coverageManifest.revision
      || parsed.coverage.coverageManifest.digest !== completenessAuthority.coverageManifest.coverageDigest
    )) return storySourceFailure("STORY_SEMANTIC_AUTHORITY_STALE");

    for (const unitId of parsed.coverage.representedUnitIds) {
      if (declaredCoverage.has(unitId)) {
        return storySourceFailure("STORY_COVERAGE_INVALID");
      }
      declaredCoverage.add(unitId);
      if (completenessAuthority) {
        const coverage = coverageRows!.get(unitId);
        if (!semanticUnits!.has(unitId) || coverage?.disposition !== "represented"
          || coverage.ownerId !== parsed.key) {
          return storySourceFailure("STORY_COVERAGE_INVALID");
        }
      }
    }
    for (const excluded of parsed.coverage.excludedUnits) {
      if (declaredCoverage.has(excluded.unitId)) {
        return storySourceFailure("STORY_COVERAGE_INVALID");
      }
      declaredCoverage.add(excluded.unitId);
      if (completenessAuthority) {
        const coverage = coverageRows!.get(excluded.unitId);
        if (!semanticUnits!.has(excluded.unitId) || coverage?.disposition !== "excluded"
          || coverage.exclusionReason !== excluded.reason) {
          return storySourceFailure("STORY_COVERAGE_INVALID");
        }
      }
    }

    const phaseId = parsed.phase.id;
    const phaseLabel = parsed.phase.label.trim();
    const phaseWordCount = phaseLabel.split(/\s+/u).length;
    if (phaseWordCount < 1 || phaseWordCount > 2
      || !storyPhaseLabelPattern.test(phaseLabel)
      || genericStoryPhases.has(normalizedCopy(phaseLabel))) {
      return storySourceFailure("STORY_PHASE_INVALID");
    }
    const existingPhaseLabel = phaseLabels.get(phaseId);
    if (existingPhaseLabel && existingPhaseLabel !== phaseLabel) {
      return storySourceFailure("STORY_PHASE_INVALID");
    }
    phaseLabels.set(phaseId, phaseLabel);
    if (phaseId !== activePhase) {
      if (completedPhases.has(phaseId)) {
        return storySourceFailure("STORY_PHASE_ORDER_INVALID");
      }
      if (activePhase) completedPhases.add(activePhase);
      activePhase = phaseId;
    }

    const chapterEvidence = new Map<string, { row: StoryEvidenceRow; actor: string }>();
    const evidenceReferences = [parsed.evidence.primary, ...parsed.evidence.supporting];
    for (const reference of evidenceReferences) {
      const resolution = resolveEvidenceTarget(evidenceRows, reference.eventId);
      if (resolution.status !== "resolved" || reference.eventId !== resolution.itemId) {
        return storySourceFailure("STORY_EVIDENCE_INVALID");
      }
      const evidenceRow = evidenceRows[resolution.index];
      if (!evidenceRow || evidenceRow.documentId !== reference.documentId) {
        return storySourceFailure("STORY_EVIDENCE_INVALID");
      }
      if (completenessAuthority
        && memberCoverage.get(reference.eventId)?.disposition === "excluded") {
        return storySourceFailure("STORY_EXCLUDED_EVIDENCE_INVALID");
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

    if (parsed.people.length === 0) return storySourceFailure("STORY_PEOPLE_INVALID");
    const requiredActors = new Set([...chapterEvidence.values()].map((entry) => entry.actor).filter(Boolean));
    if (requiredActors.size === 0) return storySourceFailure("STORY_PEOPLE_INVALID");
    const coveredActors = new Set<string>();
    for (const person of parsed.people) {
      if (!person.evidence.every(belongsToChapter)) {
        return storySourceFailure("STORY_PEOPLE_INVALID");
      }
      person.evidence.forEach((reference) => narrativeEvidence.add(reference.eventId));
      const personActors = new Set(person.evidence.map((reference) => (
        chapterEvidence.get(JSON.stringify([reference.documentId, reference.eventId]))?.actor || ""
      )));
      if (personActors.size !== 1 || personActors.has("")
        || [...personActors].some((actor) => coveredActors.has(actor))) {
        return storySourceFailure("STORY_PEOPLE_INVALID");
      }
      personActors.forEach((actor) => coveredActors.add(actor));
    }
    if ([...requiredActors].some((actor) => !coveredActors.has(actor))) {
      return storySourceFailure("STORY_PEOPLE_INVALID");
    }

    const storyBlocks = new Map(parsed.story.blocks.map((block) => [block.id, block]));
    for (const block of parsed.story.blocks) {
      if (!block.evidence.every(belongsToChapter)) {
        return storySourceFailure("STORY_EVIDENCE_INVALID");
      }
      block.evidence.forEach((reference) => narrativeEvidence.add(reference.eventId));
    }
    for (const insight of parsed.insights) {
      const anchoredBlocks = insight.quote.storyBlockIds.map((blockId) => storyBlocks.get(blockId));
      if (anchoredBlocks.some((block) => !block)
        || !insight.evidence.every(belongsToChapter)) {
        return storySourceFailure("STORY_INSIGHT_GROUNDING_INVALID");
      }
      const anchoredEvidence = new Set(anchoredBlocks.flatMap((block) => (
        block?.evidence.map((reference) => JSON.stringify([reference.documentId, reference.eventId])) || []
      )));
      if (insight.evidence.some((reference) => !anchoredEvidence.has(
        JSON.stringify([reference.documentId, reference.eventId]),
      ))) return storySourceFailure("STORY_INSIGHT_GROUNDING_INVALID");
      insight.evidence.forEach((reference) => narrativeEvidence.add(reference.eventId));
    }
    if (completenessAuthority) {
      for (const unitId of parsed.coverage.representedUnitIds) {
        const unit = semanticUnits!.get(unitId);
        if (!unit || !unit.members.some((member) => narrativeEvidence.has(member))) {
          return storySourceFailure("STORY_COVERAGE_INVALID");
        }
      }
    }
  }

  if (completenessAuthority && (
    declaredCoverage.size !== coverageRows!.size
    || [...coverageRows!.keys()].some((unitId) => !declaredCoverage.has(unitId))
  )) return storySourceFailure("STORY_COVERAGE_INVALID");

  return {
    ok: true,
    chapterCount: orderedCandidateRows.length,
    canonicalCandidate: JSON.stringify(orderedCandidateRows.map((row) => ({ id: row.id, summary: row.summary }))),
  };
}

/** Read and consume the one durable semantic, coverage, and source-Privacy
 * authority before accepting an active Story package. Passive callers may skip
 * full source-content verification only when they never hydrate Story bytes. */
export async function validateCurrentStorySourcePackage(
  db: StorySourceDatabase,
  workflowRunId: string,
  candidateRows: StoryCandidateRow[],
  evidenceRows: StoryEvidenceRow[],
  options: { verifyCurrentSource?: boolean } = {},
): Promise<StorySourceValidation> {
  const semanticManifest = await readSemanticManifestAuthority(db, workflowRunId);
  if (!semanticManifest) return storySourceFailure("STORY_SEMANTIC_AUTHORITY_STALE");
  const coverageManifest = await readCoverageManifestAuthority(
    db,
    workflowRunId,
    semanticManifest,
    options,
  );
  if (!coverageManifest) return storySourceFailure("STORY_COVERAGE_INVALID");
  return validateStorySourcePackage(candidateRows, evidenceRows, {
    semanticManifest,
    coverageManifest,
  });
}

/** One canonical activation seam: normalize server-owned unit coverage, then
 * validate the Story package against that exact semantic authority. */
export async function validateStoryActivationAuthority(
  candidateRows: StoryCandidateRow[],
  evidenceRows: StoryEvidenceRow[],
  semanticManifest: SemanticManifestAuthority,
  coverageInput: unknown,
  privacyAuthorizedUnitIds: ReadonlySet<string> = new Set(),
): Promise<StoryActivationAuthorityValidation> {
  const coverage = await validateCoverageManifestAuthority(
    coverageInput,
    semanticManifest,
    privacyAuthorizedUnitIds,
  );
  if (!coverage.ok) return coverage;
  const source = validateStorySourcePackage(candidateRows, evidenceRows, {
    semanticManifest,
    coverageManifest: coverage.authority,
  });
  return source.ok
    ? { ok: true, source, coverageManifest: coverage.authority }
    : source;
}
