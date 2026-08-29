export const TEST_SEMANTIC_MANIFEST = Object.freeze({
  revision: 1,
  digest: "a".repeat(64),
});

export const TEST_COVERAGE_MANIFEST = Object.freeze({
  revision: 1,
  digest: "b".repeat(64),
});

export function testStoryCoverage({ representedUnitIds = [], excludedUnits = [] } = {}) {
  return {
    semanticManifest: TEST_SEMANTIC_MANIFEST,
    coverageManifest: TEST_COVERAGE_MANIFEST,
    representedUnitIds,
    excludedUnits,
  };
}
