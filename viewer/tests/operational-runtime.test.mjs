import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";


test("official runtime can isolate state and run concurrent ports", () => {
  const config = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.match(config, /persistState:\s*\{ path: viewerStateDir \}/);
  assert.match(config, /inspectorPort:\s*false/);
  assert.match(config, /host:\s*viewerHost/);
  assert.match(config, /strictPort:\s*true/);
  assert.equal(packageJson.scripts.dev, "vinext dev");
  assert.equal(packageJson.scripts.build, "vinext build");
  assert.equal(packageJson.scripts.start, "vinext start");
});
