import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import {
  canonicalAuthorityJson,
  MAX_SEMANTIC_MANIFEST_BYTES,
} from "../../../viewer/lib/story-readiness.ts";

export const MAX_PROJECT_MAP_BYTES = 3 * MAX_SEMANTIC_MANIFEST_BYTES;
export const MAX_STORY_PREPARATION_FILE_BYTES = 25_000_000;

const PROJECT_MAP_MARKERS = [
  "schema_version", "primary_project", "semantic_units", "source_authority",
];
const hex = /^[0-9a-f]{64}$/u;
const encoder = new TextEncoder();

export class StoryPreparationTransportError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export const fail = (code) => { throw new StoryPreparationTransportError(code); };
export const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
export const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
export const exactKeys = (value, keys) => isObject(value)
  && Object.keys(value).length === keys.length && keys.every((key) => owns(value, key));
export const stableId = (value) => typeof value === "string" && Boolean(value.trim())
  && !/[\u0000-\u001f\u007f]/u.test(value);
export const compareUtf8 = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));
export const canonicalDigest = (value) => createHash("sha256")
  .update(canonicalAuthorityJson(value)).digest("hex");
export const canonicalJsonEqual = (left, right) => (
  canonicalAuthorityJson(left) === canonicalAuthorityJson(right)
);
export const serializedBytes = (value) => encoder.encode(canonicalAuthorityJson(value)).byteLength;

export async function readStrictJson(path, maximumBytes, codes = {}) {
  const invalid = codes.invalid ?? "STORY_PREPARATION_INPUT_INVALID";
  const changed = codes.changed ?? "STORY_PREPARATION_INPUT_CHANGED";
  const oversized = codes.oversized ?? "STORY_PREPARATION_INPUT_TOO_LARGE";
  const jsonInvalid = codes.jsonInvalid ?? "STORY_PREPARATION_JSON_INVALID";
  let handle;
  try {
    handle = await open(resolve(path), "r");
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) fail(invalid);
    if (before.size > BigInt(maximumBytes)) fail(oversized);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (bytes.byteLength > maximumBytes) fail(oversized);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || BigInt(bytes.byteLength) !== after.size) fail(changed);
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return { value: JSON.parse(text), byteLength: bytes.byteLength };
    } catch {
      fail(jsonInvalid);
    }
  } catch (error) {
    if (error instanceof StoryPreparationTransportError) throw error;
    fail(invalid);
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function selectSemanticManifest(document, transportBytes) {
  const record = isObject(document) ? document : null;
  const declaresManifest = Boolean(record && owns(record, "semantic_manifest"));
  const looksLikeProjectMap = Boolean(record && PROJECT_MAP_MARKERS.some((key) => owns(record, key)));
  let semanticManifest = document;
  if (declaresManifest || looksLikeProjectMap) {
    if (!declaresManifest || !isObject(record.semantic_manifest)) {
      fail("PROJECT_MAP_SEMANTIC_MANIFEST_INVALID");
    }
    semanticManifest = record.semantic_manifest;
  } else if (transportBytes > MAX_SEMANTIC_MANIFEST_BYTES) {
    fail("SEMANTIC_MANIFEST_TOO_LARGE");
  }
  let bytes;
  try {
    bytes = serializedBytes(semanticManifest);
  } catch {
    fail("SEMANTIC_MANIFEST_INVALID");
  }
  if (bytes > MAX_SEMANTIC_MANIFEST_BYTES) fail("SEMANTIC_MANIFEST_TOO_LARGE");
  return semanticManifest;
}

export function validateSemanticAuthority(value) {
  if (!exactKeys(value, [
    "projectId", "revision", "sourceDigest", "universeDigest", "manifestDigest", "units",
  ]) || !stableId(value.projectId) || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !hex.test(value.sourceDigest) || !hex.test(value.universeDigest)
    || !hex.test(value.manifestDigest) || !Array.isArray(value.units)) {
    fail("SEMANTIC_MANIFEST_INVALID");
  }
  const units = [...value.units].sort((left, right) => compareUtf8(String(left?.id), String(right?.id)));
  const unitIds = units.map((unit) => unit?.id);
  if (unitIds.some((id) => !stableId(id)) || new Set(unitIds).size !== unitIds.length) {
    fail("SEMANTIC_UNIT_SET_INVALID");
  }
  const core = {
    projectId: value.projectId,
    revision: value.revision,
    sourceDigest: value.sourceDigest,
    universeDigest: value.universeDigest,
    units,
  };
  if (canonicalDigest(core) !== value.manifestDigest) fail("SEMANTIC_MANIFEST_DIGEST_STALE");
  return { ...core, manifestDigest: value.manifestDigest };
}

export async function readSemanticTransport(path, codes = {}) {
  const document = await readStrictJson(path, MAX_PROJECT_MAP_BYTES, {
    invalid: codes.invalid,
    changed: codes.changed,
    oversized: codes.oversized ?? "PROJECT_MAP_TRANSPORT_TOO_LARGE",
    jsonInvalid: codes.jsonInvalid,
  });
  return validateSemanticAuthority(selectSemanticManifest(document.value, document.byteLength));
}
