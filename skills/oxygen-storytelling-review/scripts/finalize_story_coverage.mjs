#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import {
  canonicalAuthorityJson,
  MAX_COVERAGE_MANIFEST_BYTES,
  MAX_SEMANTIC_MANIFEST_BYTES,
  finalizeCoverageManifestAuthority,
} from "../../../viewer/lib/story-readiness.ts";
import {
  MAX_SOURCE_PRIVACY_AUTHORITY_BYTES,
  deriveCoveragePrivacyAuthority,
} from "../../../viewer/lib/story-coverage-privacy-authority.ts";

// A canonical project map carries the same bounded semantic membership twice:
// the Organization proposal and the finalized manifest. One additional manifest
// budget bounds deterministic JSON framing and the remaining project metadata.
const MAX_PROJECT_MAP_BYTES = 3 * MAX_SEMANTIC_MANIFEST_BYTES;
const PROJECT_MAP_MARKERS = [
  "schema_version", "primary_project", "semantic_units", "source_authority",
];
const encoder = new TextEncoder();

class FinalizationError extends Error {}

function fail(code) {
  throw new FinalizationError(code);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function owns(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

const arguments_ = process.argv.slice(2);
const [semanticPath, draftPath, outputPath] = arguments_;
let sourcePrivacyPath = null;
let previousPath = null;
let argumentsValid = Boolean(semanticPath && draftPath && outputPath);
for (let index = 3; index < arguments_.length; index += 2) {
  const option = arguments_[index];
  const value = arguments_[index + 1];
  if (!value || (option === "--source-privacy" && sourcePrivacyPath !== null)
    || (option === "--previous" && previousPath !== null)) {
    argumentsValid = false;
    break;
  }
  if (option === "--source-privacy") sourcePrivacyPath = value;
  else if (option === "--previous") previousPath = value;
  else argumentsValid = false;
}

async function readStrictJson(path, maximumBytes, oversizedCode) {
  let handle;
  try {
    handle = await open(resolve(path), "r");
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) fail("STORY_COVERAGE_INPUT_INVALID");
    if (before.size > BigInt(maximumBytes)) fail(oversizedCode);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (bytes.byteLength > maximumBytes) fail(oversizedCode);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || BigInt(bytes.byteLength) !== after.size) {
      fail("STORY_COVERAGE_INPUT_CHANGED");
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return { value: JSON.parse(text), byteLength: bytes.byteLength };
    } catch {
      fail("STORY_COVERAGE_JSON_INVALID");
    }
  } catch (error) {
    if (error instanceof FinalizationError) throw error;
    fail("STORY_COVERAGE_INPUT_INVALID");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function selectSemanticManifest(document, transportBytes) {
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
    // Preserve the bare-manifest transport behavior while allowing a larger wrapper.
    fail("SEMANTIC_MANIFEST_TOO_LARGE");
  }
  let serialized;
  try {
    serialized = canonicalAuthorityJson(semanticManifest);
  } catch {
    fail("SEMANTIC_MANIFEST_INVALID");
  }
  if (typeof serialized !== "string") fail("SEMANTIC_MANIFEST_INVALID");
  if (encoder.encode(serialized).byteLength > MAX_SEMANTIC_MANIFEST_BYTES) {
    fail("SEMANTIC_MANIFEST_TOO_LARGE");
  }
  return semanticManifest;
}

async function writeUtf8Atomically(path, text) {
  const destination = resolve(path);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx");
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, destination);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

if (!argumentsValid || sourcePrivacyPath === null) {
  console.error("usage: finalize_story_coverage.mjs <project-map-or-semantic-manifest.json> <coverage-draft.json> <output.json> --source-privacy <current-public-source-privacy.json> [--previous <server-accepted-coverage.json>]");
  process.exitCode = 2;
} else {
  try {
    const semanticDocument = await readStrictJson(
      semanticPath,
      MAX_PROJECT_MAP_BYTES,
      "PROJECT_MAP_TRANSPORT_TOO_LARGE",
    );
    const semanticManifest = selectSemanticManifest(
      semanticDocument.value,
      semanticDocument.byteLength,
    );
    const draft = (await readStrictJson(
      draftPath,
      MAX_COVERAGE_MANIFEST_BYTES,
      "COVERAGE_MANIFEST_TOO_LARGE",
    )).value;
    const sourcePrivacy = (await readStrictJson(
      sourcePrivacyPath,
      MAX_SOURCE_PRIVACY_AUTHORITY_BYTES,
      "SOURCE_PRIVACY_AUTHORITY_TOO_LARGE",
    )).value;
    const previous = previousPath
      ? (await readStrictJson(
          previousPath,
          MAX_COVERAGE_MANIFEST_BYTES,
          "COVERAGE_MANIFEST_TOO_LARGE",
        )).value
      : null;
    // This provider-free boundary only projects the supplied semantic membership.
    // Server activation must revalidate every member/source digest before persistence.
    const privacyAuthority = await deriveCoveragePrivacyAuthority(
      sourcePrivacy,
      semanticManifest,
    );
    if (!privacyAuthority.ok) fail(privacyAuthority.code);
    const validation = await finalizeCoverageManifestAuthority(
      draft,
      semanticManifest,
      previous,
      privacyAuthority.authority.authorizedUnitIds,
    );
    if (!validation.ok) fail(validation.code);
    const authority = validation.authority;
    const submission = {
      revision: authority.revision,
      semanticManifestRevision: authority.semanticManifestRevision,
      semanticManifestDigest: authority.semanticManifestDigest,
      coverageDigest: authority.coverageDigest,
      rows: authority.rows.map((row) => row.disposition === "represented" ? {
        unitId: row.unitId,
        disposition: "represented",
        ownerId: row.ownerId,
      } : {
        unitId: row.unitId,
        disposition: "excluded",
        exclusionReason: row.exclusionReason,
      }),
    };
    await writeUtf8Atomically(outputPath, `${JSON.stringify(submission, null, 2)}\n`);
    console.log(JSON.stringify({
      output: resolve(outputPath),
      semanticManifestRevision: submission.semanticManifestRevision,
      semanticManifestDigest: submission.semanticManifestDigest,
      coverageManifestRevision: submission.revision,
      coverageManifestDigest: submission.coverageDigest,
      coverageRows: submission.rows.length,
    }));
  } catch (error) {
    console.error(error instanceof FinalizationError
      ? error.message
      : "STORY_COVERAGE_FINALIZATION_FAILED");
    process.exitCode = 1;
  }
}
