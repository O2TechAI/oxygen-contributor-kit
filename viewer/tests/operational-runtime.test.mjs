import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("viewer uses the current Next runtime contract", async () => {
  const packageJson = JSON.parse(await read("../package.json"));
  assert.deepEqual(
    {
      dev: packageJson.scripts.dev,
      build: packageJson.scripts.build,
      start: packageJson.scripts.start,
    },
    { dev: "next dev", build: "next build", start: "next start" },
  );
  assert.equal(packageJson.scripts["db:generate"], undefined);
  assert.deepEqual(packageJson.dependencies, {
    next: "16.2.6",
    react: "19.2.6",
    "react-dom": "19.2.6",
  });
  assert.deepEqual(packageJson.devDependencies, {
    "@tailwindcss/postcss": "4.2.1",
    "@types/node": "22.19.19",
    "@types/react": "19.2.14",
    "@types/react-dom": "19.2.3",
    eslint: "9.39.4",
    "eslint-config-next": "16.2.6",
    tailwindcss: "4.2.1",
    typescript: "5.9.3",
  });
});
