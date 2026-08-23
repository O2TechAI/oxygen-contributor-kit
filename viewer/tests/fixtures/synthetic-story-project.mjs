import { STORY_PREFIX } from "../../lib/timeline.ts";

export const syntheticStoryProject = {
  name: "Harbor Sensor Calibration",
  overview: {
    en: "The project began with sensors that could not be compared. A controlled trial exposed temperature drift, and an independent holdout became the release gate.",
    zh: "项目起初无法比较不同传感器。对照试验暴露温度漂移后，独立留出验证成为发布门槛。",
  },
  sourceRecordCount: 7,
};

const chapters = [
  {
    key: "baseline-question",
    phase: { en: "Signal Baseline", zh: "信号基线" },
    kind: "discovery",
    date: "2031-03-02T09:00:00Z",
    title: { en: "The baseline could not be compared", zh: "基线暂时无法比较" },
    before: { en: "Sensors used unrelated scales", zh: "传感器使用不同量纲" },
    after: { en: "One calibration question was defined", zh: "团队明确了统一校准问题" },
    people: [{ id: "calibration-owner", label: "A", en: ["Calibration owner", "Defined the comparison boundary."], zh: ["校准负责人", "明确了比较边界。"] }],
    privacy: [],
    evidenceId: "synthetic-evidence-alpha",
    chip: { en: "4 sensor types", zh: "4 类传感器" },
  },
  {
    key: "controlled-trial",
    phase: { en: "Signal Baseline", zh: "信号基线" },
    kind: "validation",
    date: "2031-03-05T14:30:00Z",
    title: { en: "A controlled trial exposed drift", zh: "对照试验暴露了漂移" },
    before: { en: "Drift looked like random noise", zh: "漂移看起来像随机噪声" },
    after: { en: "Temperature became a measured variable", zh: "温度成为明确测量变量" },
    people: [
      { id: "calibration-owner", label: "A", en: ["Calibration owner", "Kept the trial comparable."], zh: ["校准负责人", "保证试验可比较。"] },
      { id: "field-technician", label: "B", en: ["Field technician", "Connected the drift to operating conditions."], zh: ["现场技术员", "将漂移与运行条件联系起来。"] },
    ],
    privacy: [{
      id: "demo-location",
      releaseTargets: ["people:field-technician"],
      original: { availability: "available", excerpt: "Synthetic dock code HARBOR-DEMO-7", sourceLanguage: "en" },
      en: ["Synthetic location code", "A demonstration location appears in otherwise useful context.", "The displayed synthetic site code could identify a location if reused with real data."],
      zh: ["合成位置代码", "有用的上下文中出现了演示位置。", "显示的合成站点代码若替换为真实数据，可能识别具体位置。"],
    }],
    evidenceId: "synthetic-evidence-beta",
    chip: { en: "±0.8 demo units", zh: "±0.8 演示单位" },
  },
  {
    key: "deployment-gate",
    phase: { en: "Deployment Gate", zh: "部署门槛" },
    kind: "current_state",
    date: "2031-03-11T16:00:00Z",
    title: { en: "The holdout became the deployment gate", zh: "留出验证成为部署门槛" },
    before: { en: "A passing trial implied readiness", zh: "试验通过就被视为可部署" },
    after: { en: "A separate holdout now gates release", zh: "独立留出验证决定是否发布" },
    people: [],
    privacy: [{
      id: "removed-demo-metric",
      releaseTargets: ["detail-0"],
      original: { availability: "unavailable" },
      en: ["Unavailable demonstration metric", "Reviewed metadata records a removed internal-style metric.", "The value is unavailable, so its disclosure status cannot be assessed; review confirms only whether the surviving context remains."],
      zh: ["不可用的演示指标", "已审阅元数据记录了一项已移除的内部式指标。", "原始数值不可用，无法判断其披露状态；人工只能确认是否保留现有安全上下文。"],
    }],
    evidenceId: "synthetic-evidence-gamma",
    chip: { en: "1 holdout gate", zh: "1 项留出门槛" },
  },
];

function peopleFor(chapter, language) {
  return chapter.people.map((person) => ({
    id: person.id,
    releaseLabel: person.label,
    role: person[language][0],
    description: person[language][1],
    localIdentityState: "not_identified",
  }));
}

function privacyFor(chapter, language) {
  return chapter.privacy.map((candidate) => ({
    id: candidate.id,
    title: candidate[language][0],
    explanation: candidate[language][1],
    recommendation: "redact",
    releaseTargets: candidate.releaseTargets,
    original: candidate.original,
    whyFlagged: candidate[language][2],
  }));
}

function presentation(chapter, language) {
  const chinese = language === "zh";
  return {
    phase: chapter.phase[language],
    title: chapter.title[language],
    timelineSummary: chinese ? `SENSOR-DEMO：${chapter.after.zh}。` : `SENSOR-DEMO: ${chapter.after.en}.`,
    before: chapter.before[language],
    after: chapter.after[language],
    timelineChips: [chapter.chip[language]],
    overview: chinese ? "SENSOR-DEMO 展示证据如何改变下一步。" : "SENSOR-DEMO shows how evidence changed the next step.",
    people: peopleFor(chapter, language),
    story: {
      scene: chinese ? "SENSOR-DEMO 团队需要一个可比较的判断。" : "The SENSOR-DEMO team needed a comparable decision.",
      reconstruction: [chinese ? "一项安全的合成观察改变了团队的判断。" : "A safe synthetic observation changed the team's interpretation."],
      importantDetails: [chinese ? "不确定性仍然清晰可见。" : "Uncertainty remained visible."],
      decisionOutcome: chapter.after[language],
    },
    highlights: [{
      id: `insight-${chapter.key}`,
      title: chinese ? "证据改变了共同标准" : "Evidence changed the shared standard",
      noticed: chinese ? "团队用相同的合成信号讨论结果。" : "The team discussed results through the same synthetic signal.",
      lesson: chinese ? "先定义可比较的判断，再扩大工作。" : "Define a comparable decision before scaling the work.",
    }],
    privacy: {
      summary: chinese ? `AI 找到 ${chapter.privacy.length} 项候选。` : `AI found ${chapter.privacy.length} candidate(s).`,
      candidates: privacyFor(chapter, language),
    },
  };
}

function eventFor(chapter, index) {
  const annotation = {
    schema: "oxygen.story-highlight/2",
    key: chapter.key,
    phase: chapter.phase.en,
    kind: chapter.kind,
    title: chapter.title.en,
    timelineSummary: `${chapter.after.en}.`,
    whyThisMatters: "The supported transition changed the synthetic project state.",
    before: chapter.before.en,
    after: chapter.after.en,
    importance: index + 2,
    releaseEpisode: {
      readingTimeMinutes: 2,
      startTimestamp: chapter.date,
      scene: "The synthetic team needed a comparable decision.",
      reconstruction: ["A safe synthetic observation changed the interpretation."],
      importantDetails: ["Uncertainty remained visible."],
      decisionOutcome: chapter.after.en,
      compression: {
        sourceScope: "One safe synthetic event",
        retained: ["Decision and uncertainty"],
        omittedLowValue: ["Routine status"],
        omittedSensitive: [],
        rewriteBrief: "Preserve supported synthetic meaning.",
      },
    },
    insight: {
      proposal: "Reuse a comparable decision boundary.",
      rationale: "The synthetic evidence changed the shared standard.",
      reviewState: "ai_proposed",
    },
    evidence: {
      primary: { documentId: "synthetic-reviewed-document", eventId: chapter.evidenceId },
      supporting: [],
    },
    sourceVersion: {
      defaultView: "release",
      originalState: "local_evidence_only",
      releaseState: "ai_prepared_draft",
      note: "Synthetic exact evidence remains local.",
    },
    privacyReview: { state: "reviewed_release", note: "Safe synthetic boundary." },
    reviewPresentation: {
      en: presentation(chapter, "en"),
      zh: presentation(chapter, "zh"),
      projectSummary: syntheticStoryProject.overview,
      semanticAnchors: ["SENSOR-DEMO"],
    },
  };
  return {
    id: chapter.evidenceId,
    document_id: "synthetic-reviewed-document",
    sequence: index + 1,
    timestamp: chapter.date,
    summary: STORY_PREFIX + JSON.stringify(annotation),
    content: "Safe synthetic reviewed event.",
  };
}

export const syntheticStoryEvents = chapters.map(eventFor);
