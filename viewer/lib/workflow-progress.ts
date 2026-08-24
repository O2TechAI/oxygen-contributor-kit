export const WORKFLOW_STAGE_IDS = [
  "prepare",
  "organize",
  "privacy",
  "story",
  "review",
  "handoff",
] as const;

export type WorkflowStageId = typeof WORKFLOW_STAGE_IDS[number];
export type WorkflowStageStatus = "complete" | "current" | "up_next" | "waiting" | "blocked";
export type WorkflowStatus = "running" | "waiting" | "blocked" | "complete";
export type WorkflowSafeStatusCode =
  | "preparing_reviewed_project"
  | "import_required"
  | "organizing_project"
  | "organization_blocked"
  | "checking_privacy"
  | "privacy_check_required"
  | "privacy_blocked"
  | "building_project_story"
  | "waiting_for_story_review"
  | "release_handoff_ready";

export type WorkflowStageProgress = {
  completed: number;
  total: number;
};

export type WorkflowStageState = {
  id: WorkflowStageId;
  status: WorkflowStageStatus;
  progress?: WorkflowStageProgress;
};

export type WorkflowProgressState = {
  workflowRunId: string;
  status: WorkflowStatus;
  currentStageId: WorkflowStageId;
  safeStatusCode: WorkflowSafeStatusCode;
  stages: WorkflowStageState[];
  completedStages: number;
  totalStages: number;
  updatedAt: string | null;
  requiresHumanAction: boolean;
  blockedReasonCode?: "ORGANIZATION_FAILED" | "PRIVACY_REVIEW_INCOMPLETE";
};

export type WorkflowFacts = {
  workflowRunId?: string;
  documentCount: number;
  itemCount: number;
  organizedItemCount: number;
  organizationStatus?: string | null;
  redactionStatus?: string | null;
  storyChapterCount: number;
  updatedAt?: string | null;
};

const nonNegativeInteger = (value: number) => Number.isFinite(value)
  ? Math.max(0, Math.trunc(value))
  : 0;

const stagesThrough = (
  completed: number,
  currentStageId: WorkflowStageId,
  currentStatus: WorkflowStageStatus,
  progress?: WorkflowStageProgress,
) => WORKFLOW_STAGE_IDS.map<WorkflowStageState>((id, index) => ({
  id,
  status: index < completed ? "complete" : id === currentStageId ? currentStatus : "up_next",
  ...(id === currentStageId && progress ? { progress } : {}),
}));

function state(
  facts: WorkflowFacts,
  completedStages: number,
  currentStageId: WorkflowStageId,
  status: WorkflowStatus,
  stageStatus: WorkflowStageStatus,
  safeStatusCode: WorkflowSafeStatusCode,
  requiresHumanAction: boolean,
  progress?: WorkflowStageProgress,
  blockedReasonCode?: WorkflowProgressState["blockedReasonCode"],
): WorkflowProgressState {
  return {
    workflowRunId: facts.workflowRunId || "local-review",
    status,
    currentStageId,
    safeStatusCode,
    stages: stagesThrough(completedStages, currentStageId, stageStatus, progress),
    completedStages,
    totalStages: WORKFLOW_STAGE_IDS.length,
    updatedAt: facts.updatedAt || null,
    requiresHumanAction,
    ...(blockedReasonCode ? { blockedReasonCode } : {}),
  };
}

/** Derive display-safe progress only from persistent operational facts. The
 * returned model intentionally has no free-form message or Story/Evidence
 * payload field that could carry model reasoning or private content. */
export function deriveWorkflowProgress(input: WorkflowFacts): WorkflowProgressState {
  const facts = {
    ...input,
    documentCount: nonNegativeInteger(input.documentCount),
    itemCount: nonNegativeInteger(input.itemCount),
    organizedItemCount: nonNegativeInteger(input.organizedItemCount),
    storyChapterCount: nonNegativeInteger(input.storyChapterCount),
  };
  if (!facts.documentCount) {
    return state(facts, 0, "prepare", "waiting", "waiting", "import_required", true);
  }

  const organizationStatus = String(facts.organizationStatus || "idle");
  const organizationComplete = facts.itemCount === 0
    || (facts.organizedItemCount >= facts.itemCount && organizationStatus === "complete");
  if (!organizationComplete) {
    const progress = facts.itemCount > 0
      ? { completed: Math.min(facts.organizedItemCount, facts.itemCount), total: facts.itemCount }
      : undefined;
    if (!["idle", "running", "pending"].includes(organizationStatus)) {
      return state(facts, 1, "organize", "blocked", "blocked", "organization_blocked", false, progress, "ORGANIZATION_FAILED");
    }
    return state(facts, 1, "organize", "running", "current", "organizing_project", false, progress);
  }

  const redactionStatus = String(facts.redactionStatus || "missing");
  if (redactionStatus !== "complete") {
    if (redactionStatus === "running") {
      return state(facts, 2, "privacy", "running", "current", "checking_privacy", false);
    }
    if (redactionStatus !== "missing") {
      return state(facts, 2, "privacy", "blocked", "blocked", "privacy_blocked", true, undefined, "PRIVACY_REVIEW_INCOMPLETE");
    }
    return state(facts, 2, "privacy", "waiting", "waiting", "privacy_check_required", false);
  }

  if (!facts.storyChapterCount) {
    return state(facts, 3, "story", "running", "current", "building_project_story", false);
  }

  return state(facts, 4, "review", "waiting", "waiting", "waiting_for_story_review", true);
}

/** Overlay the in-session human review count without pretending it is a new
 * persisted workflow. Refresh safely falls back to persistent `review` state. */
export function withHumanReviewProgress(
  progress: WorkflowProgressState,
  confirmedChapters: number,
  totalChapters: number,
): WorkflowProgressState {
  if (progress.currentStageId !== "review" || progress.status === "blocked") return progress;
  const total = nonNegativeInteger(totalChapters);
  const confirmed = Math.min(nonNegativeInteger(confirmedChapters), total);
  if (!total || confirmed < total) {
    return {
      ...progress,
      stages: progress.stages.map((stage) => stage.id === "review"
        ? { ...stage, status: "waiting", ...(total ? { progress: { completed: confirmed, total } } : {}) }
        : stage),
    };
  }
  return {
    ...progress,
    status: "waiting",
    currentStageId: "handoff",
    safeStatusCode: "release_handoff_ready",
    stages: WORKFLOW_STAGE_IDS.map((id, index) => ({
      id,
      status: index < WORKFLOW_STAGE_IDS.length - 1 ? "complete" : "waiting",
      ...(id === "review" ? { progress: { completed: confirmed, total } } : {}),
    })),
    completedStages: WORKFLOW_STAGE_IDS.length - 1,
    requiresHumanAction: true,
  };
}
