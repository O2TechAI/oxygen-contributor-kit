import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("database schema is defined in db/index.ts", async () => {
  const db = await read("../db/index.ts");
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

test("the home page is dynamic and database-backed", async () => {
  const page = await read("../app/page.tsx");
  assert.match(page, /export const dynamic = "force-dynamic"/);
  assert.match(page, /loadWorkspaceBootstrap/);
});

test("the root layout has no remote font loading", async () => {
  const layout = await read("../app/layout.tsx");
  assert.equal(/next\/font|https?:\/\//i.test(layout), false);
});
