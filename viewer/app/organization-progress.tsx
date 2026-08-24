"use client";

import type { StoryLanguage } from "../lib/timeline";
import type { WorkflowProgressState, WorkflowStageId } from "../lib/workflow-progress";

type OrganizationStatus = {
  status: string; stage: string; completed: number; total: number;
  percent: number; documentCount: number; warnings: string[];
};

const copy = {
  en: {
    kicker: "Local workflow", title: "Preparing your project story",
    intro: "Follow the contributor workflow at a safe, useful level. Nothing is uploaded, and private Agent reasoning is never shown here.",
    close: "Close workflow progress", completed: "completed", next: "Up next", updated: "Last updated",
    stages: {
      prepare: "Prepare reviewed project", organize: "Organize project", privacy: "Check privacy",
      story: "Build Project Story", review: "Review Story", handoff: "Release handoff",
    },
    status: {
      preparing_reviewed_project: "Preparing the reviewed project locally.",
      import_required: "Import a reviewed project to begin.",
      organizing_project: "Organizing reviewed events into one project story.",
      organization_blocked: "Project organization needs attention before the workflow can continue.",
      checking_privacy: "Checking the reviewed release boundary.",
      privacy_check_required: "Privacy preparation is the next required stage.",
      privacy_blocked: "Privacy preparation needs human attention before Story review.",
      building_project_story: "Building evidence-linked Chapters from the reviewed project.",
      waiting_for_story_review: "Waiting for your Chapter review.",
      release_handoff_ready: "Every Chapter is human-confirmed; release handoff is ready for your next action.",
    },
  },
  zh: {
    kicker: "本地工作流", title: "正在准备项目故事",
    intro: "你可以在这里了解贡献工作流的安全进度。所有处理均在本地进行，也不会展示 Agent 的私密推理。",
    close: "关闭工作流进度", completed: "已完成", next: "下一步", updated: "最后更新",
    stages: {
      prepare: "准备已审阅项目", organize: "整理项目", privacy: "检查隐私",
      story: "生成项目故事", review: "审阅故事", handoff: "发布交接",
    },
    status: {
      preparing_reviewed_project: "正在本地准备已审阅项目。",
      import_required: "请先导入已审阅项目。",
      organizing_project: "正在把已审阅事件整理成一条项目故事。",
      organization_blocked: "项目整理需要处理后，工作流才能继续。",
      checking_privacy: "正在检查已审阅的发布边界。",
      privacy_check_required: "下一步需要完成隐私准备。",
      privacy_blocked: "隐私准备需要人工处理，之后才能审阅故事。",
      building_project_story: "正在依据已审阅项目生成可追溯的章节。",
      waiting_for_story_review: "等待你审阅各个章节。",
      release_handoff_ready: "所有章节都已获得人工确认，可以进入发布交接。",
    },
  },
} as const;

const fallbackProgress = (status: OrganizationStatus | null): WorkflowProgressState => ({
  workflowRunId: "local-review",
  status: "running",
  currentStageId: status ? "organize" : "prepare",
  safeStatusCode: status ? "organizing_project" : "preparing_reviewed_project",
  stages: (["prepare", "organize", "privacy", "story", "review", "handoff"] as WorkflowStageId[]).map((id, index) => ({
    id,
    status: index === 0 && status ? "complete" : index === (status ? 1 : 0) ? "current" : "up_next",
    ...(id === "organize" && status?.total ? { progress: { completed: status.completed, total: status.total } } : {}),
  })),
  completedStages: status ? 1 : 0,
  totalStages: 6,
  updatedAt: null,
  requiresHumanAction: false,
});

export function WorkflowProgress({
  workflow,
  status,
  error,
  language = "en",
  onClose,
}: {
  workflow: WorkflowProgressState | null;
  status?: OrganizationStatus | null;
  error: string;
  language?: StoryLanguage;
  onClose?: () => void;
}) {
  const state = workflow || fallbackProgress(status || null);
  const labels = copy[language];
  const current = state.stages.find((stage) => stage.id === state.currentStageId);
  const completedPercent = Math.round(state.completedStages / state.totalStages * 100);
  const currentProgress = current?.progress;
  return <div className={onClose ? "workflowOverlay" : "organizationPage"} onMouseDown={(event) => {
    if (onClose && event.target === event.currentTarget) onClose();
  }}>
    <section className="organizationCard workflowCard" role={onClose ? "dialog" : "status"} aria-modal={onClose ? true : undefined} aria-labelledby="workflow-title">
      {onClose && <button className="workflowClose" onClick={onClose} aria-label={labels.close}>×</button>}
      <div className="organizationBrand"><span className="brandMark">O₂</span> Oxygen</div>
      <div className="organizationKicker">{labels.kicker}</div>
      <h1 id="workflow-title">{labels.title}</h1>
      <p className="organizationIntro">{labels.intro}</p>
      <p className="workflowStatus" data-safe-status={state.safeStatusCode}>{labels.status[state.safeStatusCode]}</p>
      <div className={`progressTrack ${currentProgress ? "" : "indeterminate"}`}
        aria-label={labels.stages[state.currentStageId]}
        aria-valuemin={0}
        aria-valuemax={currentProgress?.total || state.totalStages}
        aria-valuenow={currentProgress?.completed ?? state.completedStages}
        role="progressbar">
        <div style={{ width: currentProgress ? `${Math.round(currentProgress.completed / currentProgress.total * 100)}%` : `${completedPercent}%` }} />
      </div>
      <div className="progressMeta">
        <strong>{currentProgress ? `${currentProgress.completed.toLocaleString()} / ${currentProgress.total.toLocaleString()}` : `${state.completedStages} / ${state.totalStages}`}</strong>
        <span>{labels.stages[state.currentStageId]}</span>
      </div>
      <div className="organizationStages workflowStages">
        {state.stages.map((stage, index) => <div className={stage.status} data-workflow-stage={stage.id} data-stage-status={stage.status} key={stage.id}>
          <i>{stage.status === "complete" ? "✓" : index + 1}</i><span><b>{labels.stages[stage.id]}</b>{stage.status === "complete" && <small>{labels.completed}</small>}{stage.status === "up_next" && index === state.completedStages + 1 && <small>{labels.next}</small>}</span>
        </div>)}
      </div>
      {state.updatedAt && <small className="workflowUpdated">{labels.updated}: <time dateTime={state.updatedAt}>{new Date(state.updatedAt).toLocaleString(language === "zh" ? "zh-CN" : "en-US")}</time></small>}
      {error && <div className="organizationError" role="alert">{error}</div>}
    </section>
  </div>;
}

// Retain the old export for local integrations while the canonical Viewer uses
// the generalized workflow name.
export const OrganizationProgress = WorkflowProgress;
