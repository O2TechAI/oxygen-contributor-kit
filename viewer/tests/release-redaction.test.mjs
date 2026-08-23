import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  activeRedactionFragments,
  applyActiveRedactions,
  codePointLength,
  redactKnownValue,
  releaseDocument,
  releaseItem,
} from "../lib/release.mjs";
import {
  computeSourceDigest,
  finalRedactionStatus,
  partitionPersistableRedactions,
  redactionReleaseError,
} from "../lib/redaction-pass.mjs";

test("AI offsets use Unicode code points for Chinese text after emoji", () => {
  const content = "A😀秘密Z";
  assert.equal(codePointLength(content), 5);
  assert.equal(
    applyActiveRedactions(content, [{
      item_id: "item-1", start_offset: 2, end_offset: 4,
      category: "private-personal", status: "active",
    }]),
    'A😀<redacted category="private-personal"/>Z',
  );
});

test("soft-deleted spans do not enter the release", () => {
  const content = "keep this";
  assert.equal(applyActiveRedactions(content, [{
    item_id: "item-1", start_offset: 0, end_offset: 4,
    category: "sensitive", status: "removed",
  }]), content);
});

test("overlapping active spans fail safe without leaking covered text", () => {
  const output = applyActiveRedactions("abcdef", [
    { item_id: "item-1", start_offset: 1, end_offset: 4, category: "sensitive", status: "active" },
    { item_id: "item-1", start_offset: 3, end_offset: 5, category: "credential", status: "active" },
  ]);
  assert.equal(output, 'a<redacted category="sensitive"/><redacted category="credential"/>f');
  assert.equal(output.replace(/<redacted category="[^"]+"\/>/g, ""), "af");
});

test("invalid active offsets block export", () => {
  assert.throws(() => applyActiveRedactions("abc", [{
    item_id: "item-1", start_offset: 1, end_offset: 9,
    category: "sensitive", status: "active",
  }]), /invalid redaction offsets/);
});

test("release records exclude raw envelopes and collapse non-conversation content", () => {
  const document = releaseDocument({
    id: "traj-bruce", kind: "trajectory", title: "private title",
    source_user: "bruce", source_system: "codex", item_count: 2,
    metadata_json: '{"secret":"value"}',
  }, "document-000001");
  assert.deepEqual(document, {
    id: "document-000001", kind: "trajectory", title: "document-000001",
    source_system: "codex", item_count: 2,
  });
  const item = releaseItem({
    event_type: "tool_result", sequence: 1, timestamp: "2026-01-02T03:04:05Z",
    content: "SECRET TOOL OUTPUT",
    original_json: '{"token":"secret"}', organization_category: "Oxygen",
  }, [], "event-000001", "document-000001");
  assert.equal(item.event_type, "action_label");
  assert.equal(item.content, "[tool result]");
  assert.equal(item.timestamp, null);
  assert.doesNotMatch(JSON.stringify(item), /SECRET|token|original_json/);

  const unknownSource = releaseDocument({
    kind: "trajectory", source_system: "private-codename", item_count: 1,
  }, "document-000002");
  assert.equal(unknownSource.source_system, "local-agent-history");
});

test("meeting release records discard source identity and timestamps", () => {
  const item = releaseItem({
    event_type: "record", sequence: 0, actor_type: "Named Person",
    timestamp: "2026-01-02T03:04:05Z", content: "meeting text",
  }, [], "event-000001", "document-000001");
  assert.equal(item.actor_type, "participant");
  assert.equal(item.timestamp, null);
  assert.equal(item.sequence, 0);
});

test("prepared safe action labels remain distinct without consulting raw payloads", () => {
  const labels = [
    "[system action]", "[tool call]", "[tool result]",
    "[artifact]", "[version control]", "[action]",
  ];
  const released = labels.map((label, index) => releaseItem({
    event_type: "action_label",
    sequence: index + 1,
    content: label,
    original_json: JSON.stringify({
      command: "DO NOT RELEASE --secret synthetic",
      path: "/private/synthetic/path",
      artifact: "private-artifact-payload",
    }),
  }, [], `event-${index}`, "document-1"));
  assert.deepEqual(released.map((item) => item.content), labels);
  assert.equal(releaseItem({
    event_type: "action_label",
    content: "[tool call] arbitrary command text",
  }, [], "event-unsafe", "document-1").content, "[action]");
  assert.doesNotMatch(JSON.stringify(released), /DO NOT RELEASE|private\/synthetic|artifact-payload/);
});

test("only internally consistent completed redaction passes are releasable", () => {
  const digest = "a".repeat(64);
  assert.equal(finalRedactionStatus({
    requestedStatus: "complete", completed: 0, total: 999,
    rejected: 0, sourceDigest: digest,
  }), "incomplete");
  assert.equal(finalRedactionStatus({
    requestedStatus: "complete", completed: 3, total: 3,
    rejected: 1, sourceDigest: digest,
  }), "incomplete");
  assert.equal(finalRedactionStatus({
    requestedStatus: "complete", completed: 3, total: 3,
    rejected: 0, sourceDigest: digest,
  }), "complete");
  assert.equal(finalRedactionStatus({
    requestedStatus: "complete", completed: 0, total: 0,
    rejected: 0, sourceDigest: digest,
  }), "complete");

  assert.match(redactionReleaseError({
    status: "complete", completed: 0, total: 999, rejected: 0,
    source_digest: digest,
  }, digest), /incomplete/);
  assert.match(redactionReleaseError({
    status: "complete", completed: 2, total: 3, rejected: 0,
    source_digest: digest,
  }, digest), /incomplete/);
  assert.match(redactionReleaseError({
    status: "complete", completed: 3, total: 3, rejected: 1,
    source_digest: digest,
  }, digest), /rejected spans/);
  assert.equal(redactionReleaseError({
    status: "complete", completed: 3, total: 3, rejected: 0,
    source_digest: digest,
  }, digest), null);
  assert.equal(redactionReleaseError({
    status: "complete", completed: 0, total: 0, rejected: 0,
    source_digest: digest,
  }, digest), null);
});

test("duplicate span ids cannot inflate the persisted completion count", () => {
  const { persistable, duplicates } = partitionPersistableRedactions([
    { id: "span-1", itemId: "item-1", startOffset: 0, endOffset: 1 },
    { id: "span-1", itemId: "item-1", startOffset: 1, endOffset: 2 },
  ]);
  assert.equal(persistable.length, 1);
  assert.equal(duplicates.length, 1);
  assert.equal(finalRedactionStatus({
    requestedStatus: "complete",
    completed: persistable.length,
    total: 2,
    rejected: duplicates.length,
    sourceDigest: "a".repeat(64),
  }), "incomplete");
});

test("same ids and Unicode length cannot substitute different reviewed content", async () => {
  const common = {
    document_id: "traj-1", id: "traj-1:event-1", sequence: 1,
    event_type: "message", actor_type: "user", timestamp: "2026-08-19T00:00:00Z",
  };
  const sourceA = [{ ...common, content: "A😀秘密Z" }];
  const sourceB = [{ ...common, content: "A😀公开Z" }];
  assert.equal(codePointLength(sourceA[0].content), codePointLength(sourceB[0].content));
  const digestA = await computeSourceDigest(sourceA);
  const digestB = await computeSourceDigest(sourceB);
  assert.notEqual(digestA, digestB);
  assert.match(redactionReleaseError({
    status: "complete", completed: 1, total: 1, rejected: 0,
    source_digest: digestA,
  }, digestB), /source changed/);
});

test("confirmed fragments are removed from derived ZIP text too", () => {
  const content = "联系张三确认计划";
  const spans = [{
    start_offset: 2, end_offset: 4,
    category: "private-personal", status: "active",
  }];
  const fragments = activeRedactionFragments(content, spans);
  const derived = redactKnownValue({
    summary: "张三负责这个项目",
    options: ["保留张三", "移除"],
  }, fragments);
  assert.equal(derived.summary, '<redacted category="private-personal"/>负责这个项目');
  assert.equal(derived.options[0], '保留<redacted category="private-personal"/>');
});

test("package route is gated and never selects original event JSON", async () => {
  const route = await readFile(new URL("../app/api/package/route.ts", import.meta.url), "utf8");
  const redactions = await readFile(new URL("../app/api/redactions/route.ts", import.meta.url), "utf8");
  const documents = await readFile(new URL("../app/api/documents/route.ts", import.meta.url), "utf8");
  const compare = await readFile(new URL("../app/redaction-compare.tsx", import.meta.url), "utf8");
  assert.match(route, /redactionReleaseError/);
  assert.match(route, /computeSourceDigest/);
  assert.match(route, /WHERE status='active'/);
  assert.match(route, /privacy\/redaction-summary\.json/);
  assert.match(route, /preference-probes\.json/);
  assert.match(route, /safeTextCache\.has\(source\)/);
  assert.match(route, /turns: Number\(row\.turns/);
  assert.match(route, /events: projectEvents/);
  assert.match(route, /source_types: sourceTypes/);
  assert.match(route, /details_omitted_for_privacy/);
  assert.doesNotMatch(route, /original_json/);
  assert.match(redactions, /'running','validating'/);
  assert.match(redactions, /source_digest/);
  assert.match(documents, /source_changed/);
  assert.match(compare, /const items = allItems/);
  assert.match(compare, /Redaction pass is not releasable/);
});
