"use client";

import type { StoryLanguage } from "../lib/timeline";
import type { WorkflowProgressState, WorkflowStageId } from "../lib/workflow-progress";

type OrganizationStatus = {
  status: string; stage: string; completed: number; total: number;
  percent: number; documentCount: number; warnings: string[];
};

const copy = {
  en: {
    kicker: "Local workflow", title: "Preparing your project workflow",
    intro: "Follow the contributor workflow at a safe, useful level. Nothing is uploaded, and private Agent reasoning is never shown here.",
    close: "Close workflow progress", completed: "completed", next: "Up next", updated: "Last updated",
    stages: {
      collect: "Collect project history", organize: "Organize project", privacy: "Check privacy",
      story: "Build Project Story", review: "Review Story", handoff: "Release handoff",
    },
    status: {
      target_working_folder_required: "Confirm a working folder to begin.",
      target_working_folder_confirmed: "Working folder confirmed. Collection is ready to begin.",
      collecting_project_history: "Collecting only in-scope local project history.",
      collection_failed: "Collection needs attention before the workflow can continue.",
      no_project_history_found: "No exact or child working-folder history was found in the configured local stores.",
      collection_ready_for_organization: "Collection is complete. Project organization is up next.",
      organizing_project: "Organizing reviewed events into one project story.",
      organization_blocked: "Project organization needs attention before the workflow can continue.",
      checking_privacy: "Checking the reviewed release boundary.",
      privacy_check_required: "Privacy preparation is the next required stage.",
      privacy_blocked: "Privacy preparation needs human attention before Story review.",
      building_project_story: "Building evidence-linked Chapters from the reviewed project.",
      story_generation_blocked: "Project Story validation needs attention before review can begin.",
      waiting_for_story_review: "Waiting for your Chapter review.",
      release_handoff_ready: "Every Chapter is human-confirmed; release handoff is ready for your next action.",
    },
  },
  zh: {
    kicker: "本地工作流", title: "正在准备项目工作流",
    intro: "你可以在这里了解贡献工作流的安全进度。所有处理均在本地进行，也不会展示 Agent 的私密推理。",
    close: "关闭工作流进度", completed: "已完成", next: "下一步", updated: "最后更新",
    stages: {
      collect: "收集项目历史", organize: "整理项目", privacy: "检查隐私",
      story: "生成项目故事", review: "审阅故事", handoff: "发布交接",
    },
    status: {
      target_working_folder_required: "请先确认工作文件夹。",
      target_working_folder_confirmed: "工作文件夹已确认，可以开始收集。",
      collecting_project_history: "正在仅收集范围内的本地项目历史。",
      collection_failed: "收集阶段需要处理后，工作流才能继续。",
      no_project_history_found: "配置的本地存储中没有匹配当前或子级工作文件夹的历史。",
      collection_ready_for_organization: "收集已完成，下一步将整理项目。",
      organizing_project: "正在把已审阅事件整理成一条项目故事。",
      organization_blocked: "项目整理需要处理后，工作流才能继续。",
      checking_privacy: "正在检查已审阅的发布边界。",
      privacy_check_required: "下一步需要完成隐私准备。",
      privacy_blocked: "隐私准备需要人工处理，之后才能审阅故事。",
      building_project_story: "正在依据已审阅项目生成可追溯的章节。",
      story_generation_blocked: "项目故事验证需要处理后，才能开始人工审阅。",
      waiting_for_story_review: "等待你审阅各个章节。",
      release_handoff_ready: "所有章节都已获得人工确认，可以进入发布交接。",
    },
  },
} as const;

const fallbackProgress = (status: OrganizationStatus | null): WorkflowProgressState => ({
  workflowRunId: "local-review",
  status: "running",
  currentStageId: status ? "organize" : "collect",
  safeStatusCode: status ? "organizing_project" : "target_working_folder_required",
  stages: (["collect", "organize", "privacy", "story", "review", "handoff"] as WorkflowStageId[]).map((id, index) => ({
    id,
    status: index === 0 && status ? "complete" : index === (status ? 1 : 0) ? "current" : "up_next",
    ...(id === "organize" && status?.total ? { progress: { completed: status.completed, total: status.total } } : {}),
  })),
  completedStages: status ? 1 : 0,
  totalStages: 6,
  updatedAt: null,
  requiresHumanAction: false,
  storyGenerationStatus: "not_started",
  storySourceSchema: null,
  storySessionSchema: null,
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
  const currentProgress = current?.progress;
  const determinate = Boolean(currentProgress && currentProgress.total > 0);
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
      <div className={`progressTrack ${determinate ? "" : "indeterminate"}`}
        aria-label={labels.stages[state.currentStageId]}
        {...(determinate ? {
          "aria-valuemin": 0,
          "aria-valuemax": currentProgress!.total,
          "aria-valuenow": currentProgress!.completed,
        } : {})}
        role="progressbar">
        <div style={determinate ? { width: `${Math.round(currentProgress!.completed / currentProgress!.total * 100)}%` } : undefined} />
      </div>
      <div className="progressMeta">
        <strong>{determinate
          ? `${currentProgress!.completed.toLocaleString()} / ${currentProgress!.total.toLocaleString()}`
          : `${state.completedStages.toLocaleString()} ${labels.completed}`}</strong>
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
