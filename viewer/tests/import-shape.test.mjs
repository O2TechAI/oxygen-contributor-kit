import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

async function doesNotExist(path) {
  await assert.rejects(access(new URL(path, import.meta.url)), { code: "ENOENT" });
}

test("SQLite has one schema authority in db/index.ts", async () => {
  const db = await read("../db/index.ts");
  await doesNotExist("../db/schema.ts");
  await doesNotExist("../drizzle.config.ts");
  assert.match(db, /CREATE TABLE IF NOT EXISTS documents/);
  assert.match(db, /CREATE TABLE IF NOT EXISTS items/);
  assert.match(db, /CREATE TABLE IF NOT EXISTS organization_jobs/);
  assert.match(db, /CREATE TABLE IF NOT EXISTS semantic_manifests/);
  assert.match(db, /CREATE TABLE IF NOT EXISTS story_coverage_rows/);
});

test("database routes use neutral parameterized SQLite json_each", async () => {
  const routes = await Promise.all([
    read("../app/api/documents/route.ts"),
    read("../app/api/organization/route.ts"),
    read("../app/api/workflow/route.ts"),
  ]);
  for (const route of routes) {
    const jsonEachUses = route.match(/json_each\([^)]*\)/g) ?? [];
    assert.ok(jsonEachUses.length > 0);
    assert.ok(jsonEachUses.every((use) => use === "json_each(?)"));
  }
});

test("owned platform files contain no future Cloudflare compatibility contract", async () => {
  const [packageJson, nextConfig, page, layout] = await Promise.all([
    read("../package.json"),
    read("../next.config.ts"),
    read("../app/page.tsx"),
    read("../app/layout.tsx"),
  ]);
  assert.doesNotMatch(
    `${packageJson}\n${nextConfig}\n${page}\n${layout}`,
    /cloudflare|vinext|wrangler|vite|worker|compatibility|hosting/i,
  );
  assert.match(page, /export const dynamic = "force-dynamic"/);
  assert.doesNotMatch(layout, /next\/font\/google|Geist|font-geist|https?:/);
});
