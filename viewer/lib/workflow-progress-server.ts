import { getD1 } from "../db";
import { selectReviewableStoryTimeline } from "./story-readiness";
import { hydrateStoryReviewSession } from "./story-review-session";
import { deriveWorkflowProgress, isStoryReviewReady } from "./workflow-progress";
import {
  WORKFLOW_RUN_AUTHORITY,
  WorkflowRunAuthorityError,
  requireEstablishedWorkflowRun,
  requireExactWorkflowRun,
} from "./workflow-run-server";
import type { WorkspaceDocument, WorkspaceStatus } from "./workspace-types";

type CountRow = { total: number; completed: number };
type JobRow = { id?: string; status?: string; updated_at?: string };
type WorkflowRunRow = {
  id: string;
  target_confirmed: number;
  collection_status: string;
  collection_completed: number;
  collection_total: number;
  story_generation_status: string;
  story_generation_completed: number;
  story_generation_total: number;
  updated_at: string;
};

/** Read the one sanitized persisted workflow projection used by both the
 * initial server render and the polling API. No Story or Evidence payload is
 * selected or serialized across the Server/Client boundary. */
export async function loadWorkflowProgress(workflowRunId?: string) {
  const db = await getD1();
  const authority = workflowRunId
    ? await requireExactWorkflowRun(db, workflowRunId)
    : await requireEstablishedWorkflowRun(db);
  if (authority.state === WORKFLOW_RUN_AUTHORITY.noRun && !workflowRunId) {
    return deriveWorkflowProgress({
      workflowRunId: "",
      documentCount: 0,
      itemCount: 0,
      organizedItemCount: 0,
    });
  }
  if (authority.state !== WORKFLOW_RUN_AUTHORITY.exactRun) {
    throw new WorkflowRunAuthorityError(authority);
  }
  const runQuery = db.prepare(`SELECT id,target_confirmed,collection_status,collection_completed,
      collection_total,story_generation_status,story_generation_completed,
      story_generation_total,updated_at
      FROM workflow_runs WHERE id=?`).bind(authority.workflowRunId).first<WorkflowRunRow>();
  const [items, documents, organization, redaction, run] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN organization_category IS NOT NULL THEN 1 ELSE 0 END) AS completed
      FROM items`).first<CountRow>(),
    db.prepare("SELECT COUNT(*) AS total FROM documents").first<{ total: number }>(),
    db.prepare("SELECT id,status,updated_at FROM organization_jobs ORDER BY updated_at DESC LIMIT 1").first<JobRow>(),
    db.prepare("SELECT id,status,updated_at FROM redaction_jobs ORDER BY started_at DESC LIMIT 1").first<JobRow>(),
    runQuery,
  ]);
  const updatedAt = [run?.updated_at, organization?.updated_at, redaction?.updated_at]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) || null;
  return deriveWorkflowProgress({
    workflowRunId: run?.id || authority.workflowRunId,
    targetConfirmed: Boolean(run?.target_confirmed),
    collectionStatus: run?.collection_status || null,
    collectionCompleted: Number(run?.collection_completed || 0),
    collectionTotal: Number(run?.collection_total || 0),
    documentCount: Number(documents?.total || 0),
    itemCount: Number(items?.total || 0),
    organizedItemCount: Number(items?.completed || 0),
    organizationStatus: organization?.status || null,
    redactionStatus: redaction?.status || null,
    storyGenerationStatus: run?.story_generation_status || "not_started",
    storyGenerationCompleted: Number(run?.story_generation_completed || 0),
    storyGenerationTotal: Number(run?.story_generation_total || 0),
    updatedAt,
  });
}

type OrganizationStatusRow = {
  status?: string;
  stage?: string;
  warnings_json?: string;
};

type WorkspaceDocumentRow = Omit<WorkspaceDocument, "formatted_summary"> & {
  formatted_summary_json?: string;
};

function parseStoredJson<T>(value: string | undefined, fallback: T): T {
  try {
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

/** Hydrate the Review-ready page from the same persisted workflow boundary as
 * client polling. Story-bearing documents and the bounded review session are
 * loaded only after the authoritative readiness invariant succeeds. */
export async function loadWorkspaceBootstrap() {
  const workflow = await loadWorkflowProgress();
  if (!isStoryReviewReady(workflow)) {
    return {
      workflow,
      status: null,
      documents: [] as WorkspaceDocument[],
      chapterReviews: {},
      privacyDecisions: {},
      storySessionReadyRunId: "",
    };
  }

  const db = await getD1();
  const [items, documentCount, organization, documentRows, session] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN organization_category IS NOT NULL THEN 1 ELSE 0 END) AS completed
      FROM items`).first<CountRow>(),
    db.prepare("SELECT COUNT(*) AS total FROM documents").first<{ total: number }>(),
    db.prepare("SELECT status,stage,warnings_json FROM organization_jobs ORDER BY updated_at DESC LIMIT 1")
      .first<OrganizationStatusRow>(),
    db.prepare(`SELECT id,kind,title,source_user,source_system,source_timestamp,item_count,
      updated_at,organization_status,formatted_summary_json
      FROM documents ORDER BY source_timestamp,title`).all<WorkspaceDocumentRow>(),
    db.prepare("SELECT state_json FROM story_review_sessions WHERE workflow_run_id=?")
      .bind(workflow.workflowRunId).first<{ state_json?: string }>(),
  ]);
  const total = Number(items?.total || 0);
  const completed = Number(items?.completed || 0);
  const documents = documentRows.results.map((row) => {
    const { formatted_summary_json: formattedSummaryJson, ...document } = row;
    return {
      ...document,
      formatted_summary: parseStoredJson(formattedSummaryJson, {}),
    } as WorkspaceDocument;
  });
  const status: WorkspaceStatus = {
    status: String(organization?.status || (total ? "idle" : "empty")),
    stage: String(organization?.stage || "discover"),
    completed,
    total,
    percent: total ? Math.round(completed / total * 100) : 0,
    documentCount: Number(documentCount?.total || 0),
    warnings: parseStoredJson(organization?.warnings_json, [] as string[]),
  };
  const events = documents.flatMap((document) => (document.formatted_summary?.highlights || [])
    .map((event) => ({ ...event, documentId: document.id })))
    .sort((left, right) => String(left.timestamp || "").localeCompare(String(right.timestamp || "")));
  const milestones = selectReviewableStoryTimeline(events);
  const persistedSession = parseStoredJson<unknown>(session?.state_json, null);
  const hydrated = hydrateStoryReviewSession(persistedSession, workflow.workflowRunId, milestones);
  const ready = documents.length > 0
    && status.status === "complete"
    && milestones.length > 0;
  return {
    workflow,
    status,
    documents,
    chapterReviews: hydrated.chapterReviews,
    privacyDecisions: hydrated.privacyDecisions,
    storySessionReadyRunId: ready ? workflow.workflowRunId : "",
  };
}
