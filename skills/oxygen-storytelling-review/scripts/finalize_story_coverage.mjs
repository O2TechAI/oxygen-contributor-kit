#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import {
  MAX_COVERAGE_MANIFEST_BYTES,
  finalizeCoverageManifestAuthority,
} from "../../../viewer/lib/story-readiness.ts";
import {
  MAX_SOURCE_PRIVACY_AUTHORITY_BYTES,
  deriveCoveragePrivacyAuthority,
} from "../../../viewer/lib/story-coverage-privacy-authority.ts";
import {
  MAX_PROJECT_MAP_BYTES,
  StoryPreparationTransportError,
  readStrictJson,
  selectSemanticManifest,
} from "./story_preparation_transport.mjs";

class FinalizationError extends Error {}

function fail(code) {
  throw new FinalizationError(code);
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
    const semanticDocument = await readStrictJson(semanticPath, MAX_PROJECT_MAP_BYTES, {
      invalid: "STORY_COVERAGE_INPUT_INVALID",
      changed: "STORY_COVERAGE_INPUT_CHANGED",
      oversized: "PROJECT_MAP_TRANSPORT_TOO_LARGE",
      jsonInvalid: "STORY_COVERAGE_JSON_INVALID",
    });
    const semanticManifest = selectSemanticManifest(
      semanticDocument.value,
      semanticDocument.byteLength,
    );
    const coverageCodes = (oversized) => ({
      invalid: "STORY_COVERAGE_INPUT_INVALID", changed: "STORY_COVERAGE_INPUT_CHANGED",
      oversized, jsonInvalid: "STORY_COVERAGE_JSON_INVALID",
    });
    const draft = (await readStrictJson(draftPath, MAX_COVERAGE_MANIFEST_BYTES,
      coverageCodes("COVERAGE_MANIFEST_TOO_LARGE"))).value;
    const sourcePrivacy = (await readStrictJson(sourcePrivacyPath, MAX_SOURCE_PRIVACY_AUTHORITY_BYTES,
      coverageCodes("SOURCE_PRIVACY_AUTHORITY_TOO_LARGE"))).value;
    const previous = previousPath
      ? (await readStrictJson(previousPath, MAX_COVERAGE_MANIFEST_BYTES,
          coverageCodes("COVERAGE_MANIFEST_TOO_LARGE"))).value
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
    console.error(error instanceof FinalizationError || error instanceof StoryPreparationTransportError
      ? error.message
      : "STORY_COVERAGE_FINALIZATION_FAILED");
    process.exitCode = 1;
  }
}
