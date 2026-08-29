import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  canonicalSourcePrivacyJson,
  parseSourcePrivacyReceipt,
  sourcePrivacyDigest,
} from "../lib/source-privacy-receipt.ts";

const fixture = fileURLToPath(new URL(
  "../../tools/llm_redact/tests/source_privacy_fixture.py",
  import.meta.url,
));

test("Python and TypeScript share one frozen Unicode completed-zero receipt", async () => {
  const result = spawnSync("python", [fixture], {
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const canonical = result.stdout.trimEnd();
  const receipt = JSON.parse(canonical);
  assert.equal(canonicalSourcePrivacyJson(receipt), canonical);
  assert.ok(await parseSourcePrivacyReceipt(receipt));
  assert.equal(receipt.receiptDigest,
    "aa296d8e6eaaaff81e06ac7ca06faa84e8982fd5173b3f4b2dd566f6bc5706d4");
  assert.equal(receipt.dialogue.bundles[0].inputByteLength, 363);
  assert.equal(receipt.dialogue.bundles[0].turns[0].textByteLength, 25);
  const core = { ...receipt };
  delete core.receiptDigest;
  assert.equal(await sourcePrivacyDigest(core), receipt.receiptDigest);
});
