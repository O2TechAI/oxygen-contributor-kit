import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeBulkPreferencePresentations,
  normalizeProbePresentations,
  resolveBulkPreferencePresentation,
  resolveProbePresentation,
} from "../lib/preference-presentation.ts";

const options = [{ id: "A", text: "Canonical A" }, { id: "B", text: "Canonical B" }];
const presentations = {
  en: {
    recap: "A reviewed English recap.",
    question: "What should the agent remember?",
    options: [{ id: "A", text: "English A" }, { id: "B", text: "English B" }],
  },
  zh: {
    recap: "一段经过审阅的中文说明。",
    question: "你希望 Agent 记住什么？",
    options: [{ id: "A", text: "中文 A" }, { id: "B", text: "中文 B" }],
  },
};

test("Preferences resolve one locale while preserving semantic answer identity", () => {
  const normalized = normalizeProbePresentations(presentations, options);
  assert.ok(normalized);
  const probe = { id: "stable-probe", answer_choice: "A", answered_at: "2030-01-01", presentations: normalized };
  const en = resolveProbePresentation(probe, "en");
  const zh = resolveProbePresentation(probe, "zh");
  const enAgain = resolveProbePresentation(probe, "en");
  assert.deepEqual([en.id, zh.id, enAgain.id], ["stable-probe", "stable-probe", "stable-probe"]);
  assert.deepEqual([en.answer_choice, zh.answer_choice, enAgain.answer_choice], ["A", "A", "A"]);
  assert.match(en.question, /agent remember/);
  assert.match(zh.question, /你希望/);
  assert.doesNotMatch(en.question, /[\u4e00-\u9fff]/u);
  assert.doesNotMatch(zh.question, /agent remember/i);
});

test("Preferences fail visibly upstream when selected-locale copy is absent", () => {
  const normalized = normalizeProbePresentations({ en: presentations.en }, options);
  assert.ok(normalized);
  assert.equal(resolveProbePresentation({ id: "stable-probe", presentations: normalized }, "zh"), null);
  assert.equal(normalizeProbePresentations({
    ...presentations,
    zh: { ...presentations.zh, options: [...presentations.zh.options].reverse() },
  }, options), null);
  assert.equal(normalizeProbePresentations({
    ...presentations,
    zh: { ...presentations.zh, options: [{ id: "A", text: "中文 A" }, { id: "C", text: "中文 C" }] },
  }, options), null);
});

test("bulk preference questions localize without forking the decision", () => {
  const normalized = normalizeBulkPreferencePresentations({
    en: { question: "Keep this reviewed class?" },
    zh: { question: "保留这类已审阅内容吗？" },
  });
  assert.ok(normalized);
  const decision = { id: "stable-bulk", answer: "keep", presentations: normalized };
  const en = resolveBulkPreferencePresentation(decision, "en");
  const zh = resolveBulkPreferencePresentation(decision, "zh");
  assert.equal(en.id, zh.id);
  assert.equal(en.answer, zh.answer);
  assert.notEqual(en.question, zh.question);
});
