import test from "node:test";
import assert from "node:assert/strict";
import {
  LEGACY_STORY_PREFIX,
  STORY_PREFIX,
  milestoneKindLabel,
  parseStoryAnnotation,
  resolveEvidenceTarget,
  selectProjectTimeline,
} from "../lib/timeline.ts";

const languagePresentation = (language, key) => ({
  phase: language === "zh" ? "建立信心" : "Build confidence",
  title: language === "zh" ? `${key} 的转折` : `The turn in ${key}`,
  timelineSummary: language === "zh" ? "证据改变了项目方向。" : "Evidence changed the project direction.",
  before: language === "zh" ? "决定依赖猜测。" : "The decision depended on a guess.",
  after: language === "zh" ? "证据改变了方向。" : "Evidence changed the direction.",
  timelineChips: language === "zh" ? ["3 项证据"] : ["3 evidence points"],
  overview: language === "zh" ? "这一章解释证据为何改变了决定。" : "This chapter explains why evidence changed the decision.",
  people: [{
    id: "benchmark-owner",
    releaseLabel: "A",
    role: language === "zh" ? "基准负责人" : "Benchmark owner",
    description: language === "zh" ? "定义成功边界。" : "Defined the boundary for success.",
    localIdentityState: "not_identified",
  }],
  story: {
    scene: language === "zh" ? "团队需要决定下一步。" : "The team needed to decide what came next.",
    reconstruction: [language === "zh" ? "他们比较证据后改变了方向。" : "They compared evidence and changed direction."],
    importantDetails: [language === "zh" ? "失败仍然可见。" : "The failure remained visible."],
    decisionOutcome: language === "zh" ? "采用证据支持的路径。" : "Use the evidence-backed path.",
  },
  highlights: [{
    id: "lesson",
    title: language === "zh" ? "证据形成共识" : "Evidence created alignment",
    noticed: language === "zh" ? "团队用同一标准讨论问题。" : "The team used one standard to discuss the problem.",
    lesson: language === "zh" ? "先定义什么叫做好。" : "Define what good means first.",
  }],
  privacy: {
    summary: language === "zh" ? "AI 找到 1 项候选。" : "AI found 1 candidate.",
    candidates: [{
      id: "metric",
      title: language === "zh" ? "内部指标" : "Internal metric",
      explanation: language === "zh" ? "这个值可能不适合发布。" : "This value may not belong in a release.",
      recommendation: "redact",
      releaseTargets: ["scene"],
      original: { availability: "unavailable" },
      whyFlagged: language === "zh" ? "已审阅元数据表明这里曾有内部指标，但原始数值已不可用；人工只能确认保留的上下文，不会恢复数值。" : "Reviewed metadata identifies an internal metric, but its original value is unavailable; the human confirms only the retained context and no value is restored.",
      suggestedRelease: language === "zh" ? "只保留决策。" : "Keep only the decision.",
    }, {
      id: "path",
      title: language === "zh" ? "本地路径" : "Local path",
      explanation: language === "zh" ? "路径可能暴露项目身份。" : "The path may expose project identity.",
      recommendation: "redact",
      releaseTargets: [],
      original: { availability: "available", excerpt: "/reviewed/local/project", sourceLanguage: "en" },
      whyFlagged: language === "zh" ? "显示的绝对路径包含机器特定目录，可能暴露本地环境与项目身份。" : "The displayed absolute path contains machine-specific directories that can reveal the local environment and project identity.",
      suggestedRelease: language === "zh" ? "不保留路径。" : "Do not retain the path.",
    }],
  },
});

const story = (value) => STORY_PREFIX + JSON.stringify({
  schema: "oxygen.story-highlight/2",
  key: value.key,
  phase: value.phase || "Build confidence",
  kind: value.kind || "decision",
  title: value.title || value.key,
  timelineSummary: value.narrative || `Why ${value.key} mattered`,
  whyThisMatters: "It changed the project state",
  before: value.before || "Earlier state",
  after: value.after || "Changed state",
  importance: value.importance || 3,
  releaseEpisode: {
    readingTimeMinutes: 2,
    scene: "The team was deciding what to do.",
    reconstruction: ["They compared evidence and changed direction."],
    importantDetails: ["The failure stayed visible."],
    decisionOutcome: "Use the evidence-backed path.",
    compression: {
      sourceScope: "Two reviewed events",
      retained: ["Decision and evidence"],
      omittedLowValue: ["Repeated status"],
      omittedSensitive: [],
      rewriteBrief: "Preserve meaning and uncertainty.",
    },
  },
  insight: { proposal: "Use evidence next time.", rationale: "The decision followed evidence.", reviewState: "ai_proposed" },
  evidence: { primary: { documentId: "doc", eventId: "event" }, supporting: [] },
  sourceVersion: { defaultView: "release", originalState: "local_evidence_only", releaseState: "ai_prepared_draft", note: "Original stays local." },
  privacyReview: { state: "reviewed_release", note: "Reviewed boundary." },
  reviewPresentation: {
    en: languagePresentation("en", value.key),
    zh: languagePresentation("zh", value.key),
    semanticAnchors: ["evidence", "decision"],
  },
});

test("explicit reviewed annotations define the story without time buckets", () => {
  const events = Array.from({ length: 100 }, (_, index) => ({
    id: `routine-${index}`,
    timestamp: `2026-08-${String((index % 20) + 1).padStart(2, "0")}T12:00:00Z`,
    summary: "Reports progress for the current task",
    content: "Still running; no terminal state yet.",
  }));
  events.push(
    { id: "turn", timestamp: "2026-08-03T09:00:00Z", summary: story({ key:"turn", kind:"direction_change", title:"Direction changed" }), content:"source" },
    { id: "root", timestamp: "2026-08-02T09:00:00Z", summary: story({ key:"root", kind:"root_cause", title:"Root cause found" }), content:"source" },
    { id: "ending", timestamp: "2026-08-19T09:00:00Z", summary: story({ key:"ending", kind:"current_state", title:"Current state" }), content:"source" },
  );
  const selected = selectProjectTimeline(events);
  assert.deepEqual(selected.map((event) => event.id), ["root", "turn", "ending"]);
  assert.ok(selected.every((event) => event.story.explicit));
  assert.equal(selected[1].story.title, "Direction changed");
  assert.equal(selected[1].story.releaseEpisode.readingTimeMinutes, 2);
  assert.equal(selected[1].story.insight.reviewState, "ai_proposed");
  assert.equal(selected[1].story.reviewPresentation.zh.people[0].releaseLabel, "A");
  assert.equal(selected[1].story.reviewPresentation.en.before, "The decision depended on a guess.");
  assert.deepEqual(selected[1].story.reviewPresentation.zh.timelineChips, ["3 项证据"]);
});

test("repeated conversations cannot create duplicate milestones", () => {
  const repeated = story({ key:"one-decision", title:"One durable decision" });
  const parsed = JSON.parse(repeated.slice(STORY_PREFIX.length));
  const reordered = STORY_PREFIX + JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse()));
  const selected = selectProjectTimeline([
    { id:"first", timestamp:"2026-08-01T00:00:00Z", summary:repeated },
    { id:"repeat", timestamp:"2026-08-02T00:00:00Z", summary:reordered },
    { id:"next", timestamp:"2026-08-03T00:00:00Z", summary:story({ key:"next-state", kind:"validation" }) },
  ]);
  assert.deepEqual(selected.map((event) => event.id), ["first", "next"]);
});

test("conflicting duplicate reviewed Chapter keys fail closed", () => {
  assert.throws(() => selectProjectTimeline([
    { id:"first", timestamp:"2026-08-01T00:00:00Z", summary:story({ key:"conflict", title:"First account" }) },
    { id:"second", timestamp:"2026-08-02T00:00:00Z", summary:story({ key:"conflict", title:"Different account" }) },
  ]), /Conflicting reviewed Story chapter key: conflict/);
});

test("explicit maximum keeps the most important milestones and restores chronology", () => {
  const selected = selectProjectTimeline([
    { id:"low", timestamp:"2026-08-01T00:00:00Z", summary:story({ key:"low", importance:1 }) },
    { id:"latest", timestamp:"2026-08-03T00:00:00Z", summary:story({ key:"latest", importance:5, kind:"current_state" }) },
    { id:"middle", timestamp:"2026-08-02T00:00:00Z", summary:story({ key:"middle", importance:4 }) },
  ], 2);
  assert.deepEqual(selected.map((event) => event.id), ["middle", "latest"]);
});

test("fallback selection suppresses routine activity and deduplicates summaries", () => {
  const selected = selectProjectTimeline([
    { id:"routine", timestamp:"2026-08-01T00:00:00Z", summary:"Reports progress for the current task", content:"Still running; no terminal state yet." },
    { id:"decision", timestamp:"2026-08-02T00:00:00Z", summary:"Decision: replace the broad integration", content:"The team pivoted because the old path was blocked." },
    { id:"decision-repeat", timestamp:"2026-08-03T00:00:00Z", summary:"Decision: replace the broad integration", content:"Repeated discussion of the same decision." },
    { id:"cause", timestamp:"2026-08-04T00:00:00Z", summary:"Root cause found", content:"Validation failed because the source contract had drifted." },
  ]);
  assert.deepEqual(selected.map((event) => event.id), ["decision", "cause"]);
  assert.ok(selected.every((event) => !event.story.explicit));
});

test("malformed annotations fail closed and kind labels stay human-readable", () => {
  assert.equal(parseStoryAnnotation(`${STORY_PREFIX}{not json`), null);
  assert.equal(parseStoryAnnotation(story({ key:"valid", kind:"root_cause" }))?.key, "valid");
  assert.equal(parseStoryAnnotation(STORY_PREFIX + JSON.stringify({ schema:"oxygen.story-highlight/2", key:"incomplete" })), null);
  assert.equal(parseStoryAnnotation(LEGACY_STORY_PREFIX + JSON.stringify({
    schema:"oxygen.story-milestone/1", key:"legacy", phase:"Earlier", kind:"decision",
    title:"Legacy milestone", narrative:"Legacy summary", before:"Before", after:"After",
  }))?.key, "legacy");
  assert.equal(milestoneKindLabel("root_cause"), "Root cause");
  assert.equal(milestoneKindLabel("root_cause", "zh"), "根因");
});

test("bilingual review presentation preserves one evidence set", () => {
  const annotation = parseStoryAnnotation(story({ key:"bilingual", kind:"decision" }));
  assert.equal(annotation.reviewPresentation.en.highlights[0].id, annotation.reviewPresentation.zh.highlights[0].id);
  assert.deepEqual(annotation.evidence, { primary:{ documentId:"doc", eventId:"event" }, supporting:[] });
  assert.equal(annotation.reviewPresentation.en.people[0].localIdentityState, "not_identified");
  assert.equal(annotation.reviewPresentation.zh.people[0].localIdentityState, "not_identified");
  assert.equal(annotation.reviewPresentation.en.privacy.candidates[0].original.availability, "unavailable");
  assert.equal(annotation.reviewPresentation.en.privacy.candidates[0].original.excerpt, undefined);
  assert.match(annotation.reviewPresentation.en.privacy.candidates[0].whyFlagged, /original value is unavailable/);
  assert.equal(annotation.reviewPresentation.en.privacy.candidates[1].original.availability, "available");
  assert.equal(annotation.reviewPresentation.en.privacy.candidates[1].original.excerpt, "/reviewed/local/project");
  assert.match(annotation.reviewPresentation.en.privacy.candidates[1].whyFlagged, /displayed absolute path/);
  assert.equal(annotation.reviewPresentation.en.after, "Evidence changed the direction.");
  assert.equal(annotation.reviewPresentation.zh.after, "证据改变了方向。");
});

test("review schema rejects unavailable excerpts and bilingual identity drift", () => {
  const unavailableExcerpt = JSON.parse(story({ key:"unsafe-unavailable" }).slice(STORY_PREFIX.length));
  unavailableExcerpt.reviewPresentation.en.privacy.candidates[0].original.excerpt = "must not survive";
  unavailableExcerpt.reviewPresentation.en.privacy.candidates[0].original.sourceLanguage = "en";
  assert.equal(parseStoryAnnotation(STORY_PREFIX + JSON.stringify(unavailableExcerpt)), null);

  const privacyDrift = JSON.parse(story({ key:"privacy-drift" }).slice(STORY_PREFIX.length));
  privacyDrift.reviewPresentation.zh.privacy.candidates[0].id = "different-candidate";
  assert.equal(parseStoryAnnotation(STORY_PREFIX + JSON.stringify(privacyDrift)), null);

  const peopleDrift = JSON.parse(story({ key:"people-drift" }).slice(STORY_PREFIX.length));
  peopleDrift.reviewPresentation.zh.people[0].releaseLabel = "B";
  assert.equal(parseStoryAnnotation(STORY_PREFIX + JSON.stringify(peopleDrift)), null);

  const targetDrift = JSON.parse(story({ key:"target-drift" }).slice(STORY_PREFIX.length));
  targetDrift.reviewPresentation.zh.privacy.candidates[0].releaseTargets = ["outcome"];
  assert.equal(parseStoryAnnotation(STORY_PREFIX + JSON.stringify(targetDrift)), null);

  const evidenceLanguageDrift = JSON.parse(story({ key:"evidence-language-drift" }).slice(STORY_PREFIX.length));
  evidenceLanguageDrift.reviewPresentation.zh.privacy.candidates[1].original.excerpt = "translated local path";
  assert.equal(parseStoryAnnotation(STORY_PREFIX + JSON.stringify(evidenceLanguageDrift)), null);
});

test("review schema rejects duplicate semantic IDs and hidden unavailable-original fields", () => {
  const duplicatePeople = JSON.parse(story({ key:"duplicate-people" }).slice(STORY_PREFIX.length));
  for (const language of ["en", "zh"]) {
    duplicatePeople.reviewPresentation[language].people.push({
      ...duplicatePeople.reviewPresentation[language].people[0],
      role: language === "zh" ? "协作者" : "Collaborator",
    });
  }
  assert.equal(parseStoryAnnotation(STORY_PREFIX + JSON.stringify(duplicatePeople)), null);

  const duplicateHighlights = JSON.parse(story({ key:"duplicate-highlights" }).slice(STORY_PREFIX.length));
  for (const language of ["en", "zh"]) {
    duplicateHighlights.reviewPresentation[language].highlights.push({
      ...duplicateHighlights.reviewPresentation[language].highlights[0],
      title: language === "zh" ? "第二条洞察" : "Second insight",
    });
  }
  assert.equal(parseStoryAnnotation(STORY_PREFIX + JSON.stringify(duplicateHighlights)), null);

  const duplicatePrivacy = JSON.parse(story({ key:"duplicate-privacy" }).slice(STORY_PREFIX.length));
  for (const language of ["en", "zh"]) {
    duplicatePrivacy.reviewPresentation[language].privacy.candidates[1].id = "metric";
  }
  assert.equal(parseStoryAnnotation(STORY_PREFIX + JSON.stringify(duplicatePrivacy)), null);

  const hiddenUnavailable = JSON.parse(story({ key:"hidden-unavailable" }).slice(STORY_PREFIX.length));
  for (const language of ["en", "zh"]) {
    hiddenUnavailable.reviewPresentation[language].privacy.candidates[0].original.removedValue = "must not survive";
  }
  assert.equal(parseStoryAnnotation(STORY_PREFIX + JSON.stringify(hiddenUnavailable)), null);
});

test("Story schema rejects duplicate or malformed evidence references", () => {
  const duplicateEvidence = JSON.parse(story({ key:"duplicate-evidence" }).slice(STORY_PREFIX.length));
  duplicateEvidence.evidence.supporting = [{ ...duplicateEvidence.evidence.primary }];
  assert.equal(parseStoryAnnotation(STORY_PREFIX + JSON.stringify(duplicateEvidence)), null);

  const malformedLabel = JSON.parse(story({ key:"malformed-evidence-label" }).slice(STORY_PREFIX.length));
  malformedLabel.evidence.primary.label = { hidden: "value" };
  assert.equal(parseStoryAnnotation(STORY_PREFIX + JSON.stringify(malformedLabel)), null);
});

test("valid Chapters may have no supported People and no Privacy candidates", () => {
  const emptySets = JSON.parse(story({ key:"empty-supported-sets" }).slice(STORY_PREFIX.length));
  for (const language of ["en", "zh"]) {
    emptySets.reviewPresentation[language].people = [];
    emptySets.reviewPresentation[language].privacy.candidates = [];
  }
  const parsed = parseStoryAnnotation(STORY_PREFIX + JSON.stringify(emptySets));
  assert.deepEqual(parsed.reviewPresentation.en.people, []);
  assert.deepEqual(parsed.reviewPresentation.zh.privacy.candidates, []);
});

test("legacy null uncertainty is normalized to an omitted optional field", () => {
  const legacyNull = JSON.parse(story({ key:"legacy-null-uncertainty" }).slice(STORY_PREFIX.length));
  legacyNull.reviewPresentation.en.story.uncertainty = null;
  legacyNull.reviewPresentation.zh.story.uncertainty = null;
  const parsed = parseStoryAnnotation(STORY_PREFIX + JSON.stringify(legacyNull));
  assert.ok(parsed);
  assert.equal(parsed.reviewPresentation.en.story.uncertainty, undefined);
  assert.equal(parsed.reviewPresentation.zh.story.uncertainty, undefined);
});

test("exact Evidence resolver accepts one qualified or unqualified match and rejects uncertainty", () => {
  const items = [{ id:"doc-a:event-1" }, { id:"doc-a:event-2" }];
  assert.deepEqual(resolveEvidenceTarget(items, "doc-a:event-1"), { status:"resolved", itemId:"doc-a:event-1", index:0 });
  assert.deepEqual(resolveEvidenceTarget(items, "event-2"), { status:"resolved", itemId:"doc-a:event-2", index:1 });
  assert.deepEqual(resolveEvidenceTarget(items, "missing"), { status:"missing" });
  assert.deepEqual(resolveEvidenceTarget([...items, { id:"doc-b:event-2" }], "event-2"), { status:"ambiguous" });
});
