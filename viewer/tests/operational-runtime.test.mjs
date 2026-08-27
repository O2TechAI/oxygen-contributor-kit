import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

async function doesNotExist(path) {
  await assert.rejects(access(new URL(path, import.meta.url)), { code: "ENOENT" });
}

test("viewer uses the native Next local runtime contract", async () => {
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
});

test("forbidden hosting packages are absent from the manifest and lockfile", async () => {
  const packageJson = JSON.parse(await read("../package.json"));
  const lockfile = JSON.parse(await read("../package-lock.json"));
  const forbidden = [
    "@cloudflare/vite-plugin",
    "vinext",
    "wrangler",
    "vite",
    "@vitejs/plugin-react",
    "@vitejs/plugin-rsc",
    "react-server-dom-webpack",
    "drizzle-orm",
    "drizzle-kit",
  ];
  const manifestDependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };
  for (const packageName of forbidden) {
    assert.equal(manifestDependencies[packageName], undefined, packageName);
    assert.equal(
      Object.keys(lockfile.packages).some((path) =>
        path === `node_modules/${packageName}` || path.endsWith(`/node_modules/${packageName}`),
      ),
      false,
      packageName,
    );
  }
});

test("deleted hosting assets and compatibility files are absent", async () => {
  for (const path of [
    "../vite.config.ts",
    "../worker/index.ts",
    "../.openai/hosting.json",
    "../build/sites-vite-plugin.ts",
    "../drizzle.config.ts",
    "../db/schema.ts",
  ]) {
    await doesNotExist(path);
  }

  const nextConfig = await read("../next.config.ts");
  assert.doesNotMatch(nextConfig, /cloudflare|vinext|wrangler|vite|compatibility/i);
  assert.doesNotMatch(nextConfig, /migration|hosting|worker/i);
});
