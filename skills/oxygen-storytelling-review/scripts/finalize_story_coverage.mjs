#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  MAX_COVERAGE_MANIFEST_BYTES,
  MAX_SEMANTIC_MANIFEST_BYTES,
  finalizeCoverageManifestAuthority,
} from "../../../viewer/lib/story-readiness.ts";
import {
  MAX_SOURCE_PRIVACY_AUTHORITY_BYTES,
  deriveCoveragePrivacyAuthority,
} from "../../../viewer/lib/story-coverage-privacy-authority.ts";

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

async function readStrictJson(path, maximumBytes) {
  const bytes = await readFile(resolve(path));
  if (bytes.byteLength > maximumBytes) throw new Error("JSON input exceeds its byte limit");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text);
}

if (!argumentsValid || sourcePrivacyPath === null) {
  console.error("usage: finalize_story_coverage.mjs <project-map-or-semantic-manifest.json> <coverage-draft.json> <output.json> --source-privacy <current-public-source-privacy.json> [--previous <server-accepted-coverage.json>]");
  process.exitCode = 2;
} else {
  try {
    const semanticDocument = await readStrictJson(semanticPath, MAX_SEMANTIC_MANIFEST_BYTES);
    const semanticManifest = semanticDocument.semantic_manifest || semanticDocument;
    const draft = await readStrictJson(draftPath, MAX_COVERAGE_MANIFEST_BYTES);
    const sourcePrivacy = await readStrictJson(
      sourcePrivacyPath,
      MAX_SOURCE_PRIVACY_AUTHORITY_BYTES,
    );
    const previous = previousPath
      ? await readStrictJson(previousPath, MAX_COVERAGE_MANIFEST_BYTES)
      : null;
    const privacyAuthority = await deriveCoveragePrivacyAuthority(
      sourcePrivacy,
      semanticManifest,
    );
    if (!privacyAuthority.ok) throw new Error(privacyAuthority.code);
    const validation = await finalizeCoverageManifestAuthority(
      draft,
      semanticManifest,
      previous,
      privacyAuthority.authority.authorizedUnitIds,
    );
    if (!validation.ok) throw new Error(validation.code);
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
    await writeFile(resolve(outputPath), `${JSON.stringify(submission, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      output: resolve(outputPath),
      semanticManifestRevision: submission.semanticManifestRevision,
      semanticManifestDigest: submission.semanticManifestDigest,
      coverageManifestRevision: submission.revision,
      coverageManifestDigest: submission.coverageDigest,
      coverageRows: submission.rows.length,
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
