#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { finalizeCoverageManifestAuthority } from "../../../viewer/lib/story-readiness.ts";

const arguments_ = process.argv.slice(2);
const [semanticPath, draftPath, outputPath] = arguments_;
const previousPath = arguments_.length === 5 && arguments_[3] === "--previous"
  ? arguments_[4]
  : null;
if (!semanticPath || !draftPath || !outputPath
  || (arguments_.length !== 3 && previousPath === null)) {
  console.error("usage: finalize_story_coverage.mjs <project-map-or-semantic-manifest.json> <coverage-draft.json> <output.json> [--previous <server-accepted-coverage.json>]");
  process.exitCode = 2;
} else {
  try {
    const semanticDocument = JSON.parse(await readFile(resolve(semanticPath), "utf8"));
    const semanticManifest = semanticDocument.semantic_manifest || semanticDocument;
    const draft = JSON.parse(await readFile(resolve(draftPath), "utf8"));
    const previous = previousPath
      ? JSON.parse(await readFile(resolve(previousPath), "utf8"))
      : null;
    const validation = await finalizeCoverageManifestAuthority(draft, semanticManifest, previous);
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
