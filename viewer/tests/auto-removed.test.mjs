import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  canonicalizeAutoRemoved,
  canonicalizeStoredAutoRemoved,
} from "../lib/auto-removed.mjs";

const validAggregate = () => ({
  total: 2,
  reversible: false,
  categories: [
    { kind: "private-personal", count: 1 },
    { kind: "credential", count: 1 },
  ],
});

test("valid auto_removed aggregate is reconstructed without changing semantics", () => {
  const source = validAggregate();
  const canonical = canonicalizeAutoRemoved(source);
  assert.deepEqual(canonical, source);
  assert.notEqual(canonical, source);
  assert.notEqual(canonical.categories, source.categories);
});

test("strict boundary rejects private top-level and category fields", () => {
  const topLevel = { ...validAggregate(), removed_text: "AUTO-REMOVED-PRIVATE-SENTINEL-8472" };
  assert.throws(() => canonicalizeAutoRemoved(topLevel), /unknown fields/);

  const nested = validAggregate();
  nested.categories[0].sample = "AUTO-REMOVED-PRIVATE-SENTINEL-8472";
  assert.throws(() => canonicalizeAutoRemoved(nested), /unknown fields/);
});

test("strict boundary rejects malformed aggregate values", () => {
  const cases = [
    { ...validAggregate(), total: -1 },
    { ...validAggregate(), total: "2" },
    { ...validAggregate(), reversible: "false" },
    { ...validAggregate(), categories: {} },
    { ...validAggregate(), categories: [{ kind: "private-personal", count: -1 }] },
    { ...validAggregate(), categories: [{ kind: "private-personal", count: 1.5 }] },
    { ...validAggregate(), categories: [
      { kind: "private-personal", count: 1 },
      { kind: "private-personal", count: 1 },
    ] },
    { total: 1, reversible: false, categories: [{ kind: "free-form private label", count: 1 }] },
  ];
  for (const value of cases) assert.throws(() => canonicalizeAutoRemoved(value));
});

test("package canonicalization strips legacy unknown fields without retaining sentinel", () => {
  const legacy = validAggregate();
  legacy.removed_text = "AUTO-REMOVED-PRIVATE-SENTINEL-8472";
  legacy.categories[0].sample = "AUTO-REMOVED-PRIVATE-SENTINEL-8472";
  const canonical = canonicalizeStoredAutoRemoved(JSON.stringify(legacy));
  assert.deepEqual(canonical, validAggregate());
  assert.doesNotMatch(JSON.stringify(canonical), /AUTO-REMOVED-PRIVATE-SENTINEL-8472/);
});

test("package canonicalization fails closed on malformed persisted state", () => {
  assert.throws(() => canonicalizeStoredAutoRemoved("not-json"), /not valid JSON/);
  assert.throws(() => canonicalizeStoredAutoRemoved(JSON.stringify({
    total: 1,
    reversible: false,
    categories: [{ kind: "private-personal", count: -1 }],
  })), /non-negative integer/);
});

test("API and package routes use strict and legacy-safe boundaries respectively", async () => {
  const probesRoute = await readFile(new URL("../app/api/probes/route.ts", import.meta.url), "utf8");
  const packageRoute = await readFile(new URL("../app/api/package/route.ts", import.meta.url), "utf8");
  assert.match(probesRoute, /canonicalizeAutoRemoved\(body\.run\.autoRemoved\)/);
  assert.match(probesRoute, /status: 400/);
  assert.match(packageRoute, /canonicalizeStoredAutoRemoved/);
  assert.match(packageRoute, /status: 409/);
  assert.doesNotMatch(packageRoute, /auto_removed:\s*clean/);
});
