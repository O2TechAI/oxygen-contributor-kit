export const WORKFLOW_STAGE_IDS = [
  "collect",
  "organize",
  "privacy",
  "story",
  "review",
  "handoff",
] as const;

export type WorkflowStageId = typeof WORKFLOW_STAGE_IDS[number];
export type WorkflowStageStatus = "complete" | "current" | "up_next" | "waiting" | "blocked";
export type WorkflowStatus = "running" | "waiting" | "blocked" | "complete";
export type StoryGenerationStatus =
  | "not_started"
  | "running"
  | "blocked"
  | "ready_for_human_review";
export type StorySourceSchema = "oxygen.story";
export type StorySessionSchema = "oxygen.story-review-session";
export type WorkflowSafeStatusCode =
  | "target_working_folder_required"
  | "target_working_folder_confirmed"
  | "collecting_project_history"
  | "collection_failed"
  | "no_project_history_found"
  | "collection_ready_for_organization"
  | "organizing_project"
  | "organization_blocked"
  | "checking_privacy"
  | "privacy_check_required"
  | "privacy_blocked"
  | "building_project_story"
  | "story_generation_blocked"
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
  storyGenerationStatus: StoryGenerationStatus;
  storySourceSchema: StorySourceSchema | null;
  storySessionSchema: StorySessionSchema | null;
  blockedReasonCode?:
    | "COLLECTION_FAILED"
    | "COLLECTION_EMPTY"
    | "ORGANIZATION_FAILED"
    | "PRIVACY_REVIEW_INCOMPLETE"
    | "STORY_VALIDATION_FAILED";
};

export type WorkflowFacts = {
  workflowRunId?: string;
  targetConfirmed?: boolean;
  collectionStatus?: string | null;
  collectionCompleted?: number;
  collectionTotal?: number;
  documentCount: number;
  itemCount: number;
  organizedItemCount: number;
  organizationStatus?: string | null;
  redactionStatus?: string | null;
  storyGenerationStatus?: string | null;
  storyGenerationCompleted?: number;
  storyGenerationTotal?: number;
  storySourceSchema?: StorySourceSchema | null;
  storySessionSchema?: StorySessionSchema | null;
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
  const storyContract = facts.storyGenerationStatus === "ready_for_human_review"
    && facts.storySourceSchema === "oxygen.story"
    && facts.storySessionSchema === "oxygen.story-review-session";
  return {
    workflowRunId: facts.workflowRunId || "",
    status,
    currentStageId,
    safeStatusCode,
    stages: stagesThrough(completedStages, currentStageId, stageStatus, progress),
    completedStages,
    totalStages: WORKFLOW_STAGE_IDS.length,
    updatedAt: facts.updatedAt || null,
    requiresHumanAction,
    storyGenerationStatus: normalizeStoryGenerationStatus(facts.storyGenerationStatus),
    storySourceSchema: storyContract ? facts.storySourceSchema! : null,
    storySessionSchema: storyContract ? facts.storySessionSchema! : null,
    ...(blockedReasonCode ? { blockedReasonCode } : {}),
  };
}

const STORY_GENERATION_STATUSES = new Set<StoryGenerationStatus>([
  "not_started", "running", "blocked", "ready_for_human_review",
]);
const WORKFLOW_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isWorkflowRunId(value: unknown): value is string {
  return typeof value === "string" && WORKFLOW_RUN_ID.test(value);
}

function normalizeStoryGenerationStatus(value: unknown): StoryGenerationStatus {
  return typeof value === "string" && STORY_GENERATION_STATUSES.has(value as StoryGenerationStatus)
    ? value as StoryGenerationStatus
    : "not_started";
}

export function isStoryReviewReady(progress: WorkflowProgressState | null | undefined) {
  return Boolean(progress
    && progress.storyGenerationStatus === "ready_for_human_review"
    && progress.storySourceSchema
    && progress.storySessionSchema
    && progress.currentStageId === "review"
    && progress.requiresHumanAction === true);
}

/** Keep the full-screen workflow visible until the activated Story data and
 * its review session have both hydrated for the exact ready workflow run. */
export function isStoryWorkspaceReady(
  progress: WorkflowProgressState | null | undefined,
  activation: {
    storyDataReadyRunId: string;
    storySessionReadyRunId: string;
    documentCount: number;
    organizationStatus?: string;
  },
) {
  const workflowRunId = progress?.workflowRunId || "";
  return isStoryReviewReady(progress)
    && Boolean(workflowRunId)
    && activation.storyDataReadyRunId === workflowRunId
    && activation.storySessionReadyRunId === workflowRunId
    && activation.documentCount > 0
    && activation.organizationStatus === "complete";
}

/** Derive display-safe progress only from persistent operational facts. The
 * returned model intentionally has no free-form message or Story/Evidence
 * payload field that could carry model reasoning or private content. */
export function deriveWorkflowProgress(input: WorkflowFacts): WorkflowProgressState {
  const facts = {
    ...input,
    collectionCompleted: nonNegativeInteger(input.collectionCompleted || 0),
    collectionTotal: nonNegativeInteger(input.collectionTotal || 0),
    documentCount: nonNegativeInteger(input.documentCount),
    itemCount: nonNegativeInteger(input.itemCount),
    organizedItemCount: nonNegativeInteger(input.organizedItemCount),
    storyGenerationStatus: normalizeStoryGenerationStatus(input.storyGenerationStatus),
    storyGenerationCompleted: nonNegativeInteger(input.storyGenerationCompleted || 0),
    storyGenerationTotal: nonNegativeInteger(input.storyGenerationTotal || 0),
  };
  if (!facts.documentCount) {
    const collectionStatus = String(facts.collectionStatus || "pending");
    const collectionProgress = facts.collectionTotal > 0
      ? {
          completed: Math.min(facts.collectionCompleted, facts.collectionTotal),
          total: facts.collectionTotal,
        }
      : undefined;
    if (collectionStatus === "failed") {
      return state(
        facts, 0, "collect", "blocked", "blocked", "collection_failed", true,
        collectionProgress, "COLLECTION_FAILED",
      );
    }
    if (collectionStatus === "complete") {
      if (!facts.collectionTotal) {
        return state(
          facts, 0, "collect", "blocked", "blocked", "no_project_history_found", true,
          undefined, "COLLECTION_EMPTY",
        );
      }
      return state(
        facts, 1, "organize", "waiting", "waiting", "collection_ready_for_organization", false,
      );
    }
    if (collectionStatus === "running") {
      return state(
        facts, 0, "collect", "running", "current", "collecting_project_history", false,
        collectionProgress,
      );
    }
    if (facts.targetConfirmed) {
      return state(
        facts, 0, "collect", "running", "current", "target_working_folder_confirmed", false,
      );
    }
    return state(
      facts, 0, "collect", "waiting", "waiting", "target_working_folder_required", true,
    );
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

  if (facts.storyGenerationStatus === "blocked") {
    return state(
      facts, 3, "story", "blocked", "blocked", "story_generation_blocked", true,
      undefined, "STORY_VALIDATION_FAILED",
    );
  }
  if (facts.storyGenerationStatus !== "ready_for_human_review") {
    const progress = facts.storyGenerationTotal > 0
      ? {
          completed: Math.min(facts.storyGenerationCompleted, facts.storyGenerationTotal),
          total: facts.storyGenerationTotal,
        }
      : undefined;
    return state(facts, 3, "story", "running", "current", "building_project_story", false, progress);
  }
  return state(facts, 4, "review", "waiting", "waiting", "waiting_for_story_review", true);
}

/** Overlay the source-validated human review count hydrated from the
 * project-local Story review session. The projection remains count-only. */
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
