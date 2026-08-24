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
    constraint: { en: "Four sensor types described the same harbor condition with incompatible units", zh: "四类传感器用互不兼容的单位描述同一港区状态" },
    turn: { en: "The calibration owner replaced four device-specific targets with one comparison question", zh: "校准负责人用一个共同比较问题取代了四套设备目标" },
    detail: { en: "A shared question became the prerequisite for every later drift claim", zh: "共同问题成为后续所有漂移判断的前提" },
    uncertainty: { en: "The shared question did not yet explain which operating condition caused drift", zh: "共同问题仍未解释哪种运行条件会导致漂移" },
    principle: { en: "Define the comparison boundary before interpreting differences", zh: "先定义比较边界，再解释差异" },
    phaseRationale: "Establish one comparable calibration signal before interpreting drift.",
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
    constraint: { en: "An apparent random error changed with operating temperature", zh: "看似随机的误差会随运行温度变化" },
    turn: { en: "A controlled trial separated temperature drift from device-to-device noise", zh: "对照试验把温度漂移与设备间噪声区分开来" },
    detail: { en: "The observed ±0.8 demo-unit swing was large enough to change the validation plan", zh: "观测到的 ±0.8 演示单位波动足以改变验证计划" },
    uncertainty: { en: "The controlled trial still could not prove behavior outside its measured range", zh: "对照试验仍无法证明测量范围之外的表现" },
    principle: { en: "Turn suspected noise into a controlled variable before widening a trial", zh: "扩大试验前，先把疑似噪声转化为受控变量" },
    phaseRationale: "Establish one comparable calibration signal before interpreting drift.",
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
    constraint: { en: "The controlled trial and deployment decision still depended on the same evidence", zh: "对照试验与部署决定仍依赖同一组证据" },
    turn: { en: "The team reserved an independent holdout instead of treating the passing trial as release proof", zh: "团队保留独立留出集，不再把试验通过当作发布证明" },
    detail: { en: "One holdout gate now separates model tuning from deployment approval", zh: "一项留出门槛把模型调优与部署批准分开" },
    uncertainty: { en: "Release remains blocked until the holdout reproduces the calibrated behavior", zh: "在留出集复现校准表现之前，发布仍然受阻" },
    principle: { en: "Reserve independent evidence for the decision that matters most", zh: "为最关键的决定保留独立证据" },
    phaseRationale: "Separate calibration evidence from the independent deployment decision gate.",
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
  const story = {
    scene: chinese
      ? `SENSOR-DEMO 的起点是：${chapter.before.zh}；${chapter.constraint.zh}。`
      : `SENSOR-DEMO began with ${chapter.before.en.toLowerCase()}; ${chapter.constraint.en.toLowerCase()}.`,
    reconstruction: [chinese ? `${chapter.turn.zh}。` : `${chapter.turn.en}.`],
    importantDetails: [chinese ? `${chapter.detail.zh}。` : `${chapter.detail.en}.`],
    decisionOutcome: chinese ? `${chapter.after.zh}。` : `${chapter.after.en}.`,
    uncertainty: chinese ? `${chapter.uncertainty.zh}。` : `${chapter.uncertainty.en}.`,
  };
  const context = (subject, consequence, learning, reusable) => ({
    whatWasHappening: subject,
    whyItMattered: consequence,
    whatWeLearned: learning,
    reusableLesson: reusable,
  });
  return {
    phase: chapter.phase[language],
    title: chapter.title[language],
    timelineSummary: chinese ? `SENSOR-DEMO：${chapter.after.zh}。` : `SENSOR-DEMO: ${chapter.after.en}.`,
    before: chapter.before[language],
    after: chapter.after[language],
    timelineChips: [chapter.chip[language]],
    overview: chinese ? "SENSOR-DEMO 展示证据如何改变下一步。" : "SENSOR-DEMO shows how evidence changed the next step.",
    people: peopleFor(chapter, language),
    story,
    passageContext: {
      scene: context(
        chinese ? `本章开场时，${chapter.before.zh}，而且${chapter.constraint.zh}。` : `At the opening, ${chapter.before.en.toLowerCase()}, while ${chapter.constraint.en.toLowerCase()}.`,
        chinese ? "没有共同边界，后续差异就无法区分信号与测量方式。" : "Without a common boundary, later differences could not distinguish signal from measurement method.",
        chinese ? "首要任务不是增加数据，而是先明确什么算作可比较结果。" : "The first task was not more data; it was defining what would count as a comparable result.",
        chinese ? chapter.principle.zh : chapter.principle.en,
      ),
      "reconstruction-0": context(
        chinese ? `真正的转折是${chapter.turn.zh}。` : `The decisive turn was that ${chapter.turn.en.toLowerCase()}.`,
        chinese ? "这一步改变了下一轮验证要隔离的变量。" : "That move changed which variable the next validation round had to isolate.",
        chinese ? "可操作的重构把模糊分歧转化成了可检验问题。" : "An operational reframe turned an ambiguous disagreement into a testable question.",
        chinese ? chapter.principle.zh : chapter.principle.en,
      ),
      "detail-0": context(
        chinese ? `决定性的证据是${chapter.detail.zh}。` : `The consequential evidence was that ${chapter.detail.en.toLowerCase()}.`,
        chinese ? "这个细节足以改变项目门槛，而不是只补充背景。" : "This detail was strong enough to change the project gate rather than merely add context.",
        chinese ? "只有能改变下一步的测量，才应进入核心叙事。" : "A measurement belongs in the core narrative when it changes the next action.",
        chinese ? chapter.principle.zh : chapter.principle.en,
      ),
      outcome: context(
        chinese ? `结果把项目带到“${chapter.after.zh}”这一新状态。` : `The result moved the project to a new state: ${chapter.after.en.toLowerCase()}.`,
        chinese ? "新的状态为后续工作提供了明确、可审查的门槛。" : "The new state gave later work an explicit, reviewable gate.",
        chinese ? "结果的价值在于它改变了决策规则，而不只是完成了一项任务。" : "The result mattered because it changed the decision rule, not because a task was completed.",
        chinese ? chapter.principle.zh : chapter.principle.en,
      ),
      uncertainty: context(
        chinese ? `证据边界仍然是：${chapter.uncertainty.zh}。` : `The evidence boundary remained: ${chapter.uncertainty.en.toLowerCase()}.`,
        chinese ? "明确剩余边界可以防止把阶段性结论误写成最终成功。" : "Naming the remaining boundary prevents an interim result from being rewritten as final success.",
        chinese ? "可靠的项目记忆必须同时保存结论和它尚未覆盖的范围。" : "Reliable project memory preserves both the conclusion and the range it still does not cover.",
        chinese ? chapter.principle.zh : chapter.principle.en,
      ),
    },
    highlights: [{
      id: `insight-${chapter.key}`,
      title: chinese ? "证据重写了决策门槛" : "Evidence rewrote the decision gate",
      noticed: chinese
        ? `${chapter.constraint.zh}。${chapter.turn.zh}，因此${chapter.after.zh}。`
        : `${chapter.constraint.en}. ${chapter.turn.en}, so ${chapter.after.en.toLowerCase()}.`,
      lesson: chinese
        ? `${chapter.principle.zh}。但${chapter.uncertainty.zh}，下一轮仍须验证这一边界。`
        : `${chapter.principle.en}. However, ${chapter.uncertainty.en.toLowerCase()}, so the next round must still test that boundary.`,
    }],
    privacy: {
      summary: chinese ? `AI 找到 ${chapter.privacy.length} 项候选。` : `AI found ${chapter.privacy.length} candidate(s).`,
      candidates: privacyFor(chapter, language),
    },
  };
}

function eventFor(chapter, index) {
  const english = presentation(chapter, "en");
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
      ...english.story,
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
      en: english,
      zh: presentation(chapter, "zh"),
      projectSummary: syntheticStoryProject.overview,
      semanticAnchors: ["SENSOR-DEMO"],
    },
    narrativeReview: {
      schema: "oxygen.story-narrative-review/1",
      status: "passed",
      title: { tensionAndOutcome: true },
      roles: {
        background: ["scene"],
        evidenceThread: ["reconstruction-0", "detail-0"],
        turn: ["reconstruction-0"],
        result: ["outcome"],
        directLearning: [`insight:insight-${chapter.key}`],
        reusablePrinciple: [`insight:insight-${chapter.key}`],
        openTension: { state: "supported", blockIds: ["uncertainty"] },
      },
      phase: {
        rationale: chapter.phaseRationale,
        assignmentCoherent: true,
        adjacentBoundaryReviewed: true,
      },
      passageInsightsDistinct: true,
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
