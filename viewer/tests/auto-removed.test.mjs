import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  canonicalizeAutoRemoved,
  canonicalizeStoredAutoRemoved,
} from "../lib/auto-removed.mjs";

const validAggregate = () => ({
  total: 2,
  reversible: true,
  categories: [
    { kind: "credential", count: 1 },
    { kind: "private-personal", count: 1 },
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
    { ...validAggregate(), total: Number.MAX_SAFE_INTEGER + 1 },
    { ...validAggregate(), total: "2" },
    { ...validAggregate(), reversible: false },
    { ...validAggregate(), reversible: "false" },
    { ...validAggregate(), categories: {} },
    { ...validAggregate(), categories: [{ kind: "private-personal", count: -1 }] },
    { total: 0, reversible: true, categories: [{ kind: "private-personal", count: 0 }] },
    { total: Number.MAX_SAFE_INTEGER + 1, reversible: true,
      categories: [{ kind: "private-personal", count: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...validAggregate(), categories: [{ kind: "private-personal", count: 1.5 }] },
    { ...validAggregate(), categories: [
      { kind: "private-personal", count: 1 },
      { kind: "private-personal", count: 1 },
    ] },
    { total: 1, reversible: true, categories: [{ kind: "free-form private label", count: 1 }] },
    { total: 1, reversible: true, categories: [{ kind: "user_path", count: 1 }] },
    { total: 1, reversible: true, categories: [{ kind: "third_party_contact", count: 1 }] },
    { total: 2, reversible: true, categories: [
      { kind: "private-personal", count: 1 },
      { kind: "credential", count: 1 },
    ] },
  ];
  for (const value of cases) assert.throws(() => canonicalizeAutoRemoved(value));
});

test("stored package aggregate rejects old unknown fields instead of retaining a compatibility lane", () => {
  const legacy = validAggregate();
  legacy.removed_text = "AUTO-REMOVED-PRIVATE-SENTINEL-8472";
  legacy.categories[0].sample = "AUTO-REMOVED-PRIVATE-SENTINEL-8472";
  assert.throws(() => canonicalizeStoredAutoRemoved(JSON.stringify(legacy)), /unknown fields/);
});

test("package canonicalization fails closed on malformed persisted state", () => {
  assert.throws(() => canonicalizeStoredAutoRemoved("not-json"), /not valid JSON/);
  assert.throws(() => canonicalizeStoredAutoRemoved(JSON.stringify({
    total: 1,
    reversible: false,
    categories: [{ kind: "private-personal", count: -1 }],
  })), /reversible must be true/);
});

test("Preference import and package routes use strict aggregate boundaries", async () => {
  const probesRoute = await readFile(new URL("../app/api/probes/route.ts", import.meta.url), "utf8");
  const packageRoute = await readFile(new URL("../app/api/package/route.ts", import.meta.url), "utf8");
  assert.match(probesRoute, /canonicalizeAutoRemoved\(body\.autoRemoved\)/);
  assert.doesNotMatch(probesRoute, /body\.run|crypto\.randomUUID|replaceAll/);
  assert.match(probesRoute, /status: 400/);
  assert.match(packageRoute, /canonicalizeStoredAutoRemoved/);
  assert.match(packageRoute, /status: 409/);
  assert.doesNotMatch(packageRoute, /auto_removed:\s*clean/);
});
