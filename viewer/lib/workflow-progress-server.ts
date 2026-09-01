import { getLocalDatabase } from "../db/index.ts";
import {
  hydrateStoryReviewSession,
  STORY_REVIEW_SESSION_SCHEMA,
} from "./story-review-session.ts";
import {
  emptyChapterReview,
  type ChapterReviewState,
  type PrivacyDecision,
} from "./story-review.ts";
import {
  readActiveStoryReviewContract,
  readPassiveActiveStoryReviewContract,
  readStoryReviewSessionRecord,
} from "./story-review-session-server.ts";
import {
  STORY_PREFIX,
  compareStorySourceIdentity,
  parseStorySource,
} from "./timeline.ts";
import { deriveWorkflowProgress, isStoryReviewReady } from "./workflow-progress.ts";
import {
  WORKFLOW_RUN_AUTHORITY,
  WorkflowRunAuthorityError,
  requireEstablishedWorkflowRun,
  requireExactWorkflowRun,
} from "./workflow-run-server.ts";
import type { WorkspaceDocument, WorkspaceStatus } from "./workspace-types.ts";
import { readProjectReleaseConfirmation } from "./project-release-confirmation.ts";
import {
  validActivatedSourceRevision,
  validNonnegativeAuthorityCounter,
} from "./authority-validation.mjs";
import {
  canonicalSourcePrivacyJson,
  parseSourcePrivacyReceipt,
} from "./source-privacy-receipt.ts";

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
  story_source_revision: number;
  active_story_digest?: string;
  updated_at: string;
};

type SessionBindingRow = { server_version?: number; state_json?: string };
type ConfirmationPresenceRow = { present?: number };
type FinalizedCorpusRow = {
  workflow_run_id?: string;
  corpus_revision?: number;
  corpus_digest?: string;
  document_count?: number;
  item_count?: number;
};

type SourcePrivacyCompletionRow = {
  job_id?: string;
  job_status?: string;
  job_completed?: number;
  job_total?: number;
  job_rejected?: number;
  job_source_digest?: string;
  receipt_job_id?: string;
  receipt_workflow_run_id?: string;
  receipt_source_revision?: number;
  receipt_source_digest?: string;
  stored_receipt_digest?: string;
  receipt_json?: string;
  corpus_revision?: number;
  corpus_digest?: string;
  corpus_document_count?: number;
  corpus_item_count?: number;
  current_redaction_count?: number;
};

async function normalizedSourcePrivacyComplete(
  row: SourcePrivacyCompletionRow | null,
  workflowRunId: string,
  currentSourceRevision: number,
) {
  if (!row || row.job_status !== "complete"
    || !validActivatedSourceRevision(currentSourceRevision)
    || !validActivatedSourceRevision(row.receipt_source_revision)
    || Number(row.receipt_source_revision) > currentSourceRevision
    || row.job_id !== row.receipt_job_id
    || row.receipt_workflow_run_id !== workflowRunId
    || !validNonnegativeAuthorityCounter(row.job_completed)
    || !validNonnegativeAuthorityCounter(row.job_total)
    || row.job_completed !== row.job_total
    || row.job_completed !== Number(row.current_redaction_count)
    || row.job_rejected !== 0
    || typeof row.receipt_json !== "string") return false;
  let parsed: unknown;
  try { parsed = JSON.parse(row.receipt_json); } catch { return false; }
  const receipt = await parseSourcePrivacyReceipt(parsed);
  return Boolean(receipt
    && canonicalSourcePrivacyJson(receipt) === row.receipt_json
    && receipt.workflowRunId === workflowRunId
    && receipt.sourceRevision === row.receipt_source_revision
    && receipt.sourceDigest === row.job_source_digest
    && receipt.sourceDigest === row.receipt_source_digest
    && receipt.receiptDigest === row.stored_receipt_digest
    && receipt.redactions.count === row.job_completed
    && receipt.finalizedCorpus.revision === Number(row.corpus_revision)
    && receipt.finalizedCorpus.digest === row.corpus_digest
    && receipt.finalizedCorpus.documentCount === Number(row.corpus_document_count)
    && receipt.finalizedCorpus.itemCount === Number(row.corpus_item_count));
}

type WorkflowProgressReadMode = "authoritative" | "polling_projection";

async function loadWorkflowProgressWithMode(
  workflowRunId: string | undefined,
  mode: WorkflowProgressReadMode,
) {
  const db = await getLocalDatabase();
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
      story_generation_total,story_source_revision,active_story_digest,updated_at
      FROM workflow_runs WHERE id=?`).bind(authority.workflowRunId).first<WorkflowRunRow>();
  const [
    items, documents, finalizedCorpus, organization, redaction,
    sourcePrivacyCompletion, run, sessionBinding, projectionConfirmation,
  ] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN organization_category IS NOT NULL THEN 1 ELSE 0 END) AS completed
      FROM items`).first<CountRow>(),
    db.prepare("SELECT COUNT(*) AS total FROM documents").first<{ total: number }>(),
    db.prepare(`SELECT workflow_run_id,corpus_revision,corpus_digest,document_count,item_count
      FROM finalized_corpus_manifests WHERE workflow_run_id=?`)
      .bind(authority.workflowRunId).first<FinalizedCorpusRow>(),
    db.prepare("SELECT id,status,updated_at FROM organization_jobs ORDER BY updated_at DESC LIMIT 1").first<JobRow>(),
    db.prepare("SELECT id,status,updated_at FROM redaction_jobs ORDER BY started_at DESC LIMIT 1").first<JobRow>(),
    mode === "authoritative"
      ? db.prepare(`SELECT j.id AS job_id,j.status AS job_status,j.completed AS job_completed,
          j.total AS job_total,j.rejected AS job_rejected,j.source_digest AS job_source_digest,
          p.job_id AS receipt_job_id,
          p.workflow_run_id AS receipt_workflow_run_id,p.source_revision AS receipt_source_revision,
          p.source_digest AS receipt_source_digest,p.receipt_digest AS stored_receipt_digest,
          p.receipt_json,f.corpus_revision,f.corpus_digest,
          f.document_count AS corpus_document_count,f.item_count AS corpus_item_count,
          (SELECT COUNT(*) FROM redactions) AS current_redaction_count
        FROM redaction_jobs j LEFT JOIN source_privacy_receipts p ON p.job_id=j.id
        LEFT JOIN finalized_corpus_manifests f ON f.workflow_run_id=?
        ORDER BY j.started_at DESC,j.id DESC LIMIT 1`).bind(authority.workflowRunId)
        .first<SourcePrivacyCompletionRow>()
      : Promise.resolve(null),
    runQuery,
    mode === "authoritative"
      ? db.prepare(`SELECT server_version,state_json FROM story_review_sessions
          WHERE workflow_run_id=?`)
        .bind(authority.workflowRunId).first<SessionBindingRow>()
      : Promise.resolve(null),
    mode === "polling_projection"
      ? db.prepare(`SELECT 1 AS present FROM project_release_confirmations
          WHERE workflow_run_id=? LIMIT 1`)
        .bind(authority.workflowRunId).first<ConfirmationPresenceRow>()
      : Promise.resolve(null),
  ]);
  const updatedAt = [run?.updated_at, organization?.updated_at, redaction?.updated_at]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) || null;
  const readyProjection = run?.story_generation_status === "ready_for_human_review"
    && validActivatedSourceRevision(Number(run.story_source_revision))
    && /^[0-9a-f]{64}$/.test(String(run.active_story_digest || ""));
  // Polling exposes only non-authoritative UI hints from durable operational
  // metadata. Story/session/Privacy/release authority is still revalidated by
  // the deep bootstrap and mutation readers before any Story bytes are used.
  const activeContract = mode === "polling_projection"
    ? readyProjection ? {
        storySourceSchema: "oxygen.story" as const,
        storySessionSchema: STORY_REVIEW_SESSION_SCHEMA,
      } : null
    : run?.story_generation_status === "ready_for_human_review"
      ? await readPassiveActiveStoryReviewContract(db, authority.workflowRunId)
      : null;
  let storedSourceRevision: number | null = null;
  try {
    const stored = JSON.parse(String(sessionBinding?.state_json || ""));
    storedSourceRevision = validActivatedSourceRevision(stored?.sourceRevision)
      ? Number(stored.sourceRevision) : null;
  } catch {
    storedSourceRevision = null;
  }
  const currentServerVersion = Number(sessionBinding?.server_version);
  const currentSourceRevision = Number(run?.story_source_revision);
  const documentCount = Number(documents?.total || 0);
  const itemCount = Number(items?.total || 0);
  const collectionFinalized = Boolean(
    finalizedCorpus?.workflow_run_id === authority.workflowRunId
    && validActivatedSourceRevision(finalizedCorpus?.corpus_revision)
    && /^[0-9a-f]{64}$/.test(String(finalizedCorpus?.corpus_digest || ""))
    && validNonnegativeAuthorityCounter(finalizedCorpus?.document_count)
    && validNonnegativeAuthorityCounter(finalizedCorpus?.item_count)
    && Number(finalizedCorpus?.document_count) === documentCount
    && Number(finalizedCorpus?.item_count) === itemCount
  );
  const privacyComplete = mode === "polling_projection"
    ? redaction?.status === "complete"
    : redaction?.status === "complete"
      && await normalizedSourcePrivacyComplete(
        sourcePrivacyCompletion,
        authority.workflowRunId,
        currentSourceRevision,
      );
  const releaseConfirmed = mode === "polling_projection"
    ? Boolean(readyProjection && projectionConfirmation?.present === 1)
    : Boolean(run?.active_story_digest
      && validNonnegativeAuthorityCounter(currentServerVersion)
      && validActivatedSourceRevision(currentSourceRevision)
      && storedSourceRevision === currentSourceRevision
      && await readProjectReleaseConfirmation(db, {
        workflowRunId: authority.workflowRunId,
        serverVersion: currentServerVersion,
        sourceRevision: currentSourceRevision,
      }));
  return deriveWorkflowProgress({
    workflowRunId: run?.id || authority.workflowRunId,
    targetConfirmed: Boolean(run?.target_confirmed),
    collectionStatus: run?.collection_status || null,
    collectionCompleted: Number(run?.collection_completed || 0),
    collectionTotal: Number(run?.collection_total || 0),
    collectionFinalized,
    documentCount,
    itemCount,
    organizedItemCount: Number(items?.completed || 0),
    organizationStatus: organization?.status || null,
    redactionStatus: redaction?.status === "complete"
      ? privacyComplete ? "complete" : null
      : redaction?.status || null,
    storyGenerationStatus: run?.story_generation_status || "not_started",
    storyGenerationCompleted: Number(run?.story_generation_completed || 0),
    storyGenerationTotal: Number(run?.story_generation_total || 0),
    storySourceSchema: activeContract?.storySourceSchema || null,
    storySessionSchema: activeContract?.storySessionSchema || null,
    releaseConfirmed,
    updatedAt,
  });
}

/** Deep authority read retained for bootstrap and mutation responses. */
export function loadWorkflowProgress(workflowRunId?: string) {
  return loadWorkflowProgressWithMode(workflowRunId, "authoritative");
}

/** Sanitized, explicitly non-authoritative browser polling projection. */
export function loadWorkflowPollingProjection(workflowRunId?: string) {
  return loadWorkflowProgressWithMode(workflowRunId, "polling_projection");
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

/** Hydrate the Review-ready page from the authoritative workflow boundary.
 * Story-bearing documents and the bounded review session are loaded only
 * after the deep readiness invariant succeeds. */
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

  const db = await getLocalDatabase();
  const [items, documentCount, organization, documentRows, session, activeSource] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN organization_category IS NOT NULL THEN 1 ELSE 0 END) AS completed
      FROM items`).first<CountRow>(),
    db.prepare("SELECT COUNT(*) AS total FROM documents").first<{ total: number }>(),
    db.prepare("SELECT status,stage,warnings_json FROM organization_jobs ORDER BY updated_at DESC LIMIT 1")
      .first<OrganizationStatusRow>(),
    db.prepare(`SELECT id,kind,title,source_user,source_system,source_timestamp,item_count,
      updated_at,organization_status,formatted_summary_json
      FROM documents ORDER BY source_timestamp,title`).all<WorkspaceDocumentRow>(),
    readStoryReviewSessionRecord(db, workflow.workflowRunId),
    readActiveStoryReviewContract(db, workflow.workflowRunId),
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
    .sort(compareStorySourceIdentity);
  const recognizedEvents = events.filter((event) => (
    String(event.summary || "").startsWith(STORY_PREFIX)
  ));
  const contractMatches = Boolean(workflow.storySourceSchema
    && workflow.storySessionSchema
    && activeSource.storySourceSchema === workflow.storySourceSchema
    && activeSource.storySessionSchema === workflow.storySessionSchema);
  const revisionMatches = session.sourceRevision === activeSource.sourceRevision;
  const persistedSession = revisionMatches && session.session?.schema === workflow.storySessionSchema
    ? session.session
    : null;
  const storedStateValid = session.persistedAt === null
    || !revisionMatches || Boolean(persistedSession);
  let chapterReviews: Record<string, ChapterReviewState> = {};
  let privacyDecisions: Record<string, PrivacyDecision> = {};
  const parsedSources = recognizedEvents.map((event) => parseStorySource(event.summary));
  let projectionReady = workflow.storySourceSchema === "oxygen.story"
    && workflow.storySessionSchema === STORY_REVIEW_SESSION_SCHEMA
    && recognizedEvents.length > 0
    && parsedSources.every((source) => source !== null);
  const sources = parsedSources.flatMap((source) => source ? [source] : []);
  if (persistedSession) {
    const hydrated = hydrateStoryReviewSession(
      persistedSession,
      workflow.workflowRunId,
      sources,
    );
    chapterReviews = hydrated.chapterReviews;
    privacyDecisions = hydrated.privacyDecisions;
    projectionReady = projectionReady
      && Object.keys(hydrated.chapterReviews).length === sources.length;
  } else {
    chapterReviews = Object.fromEntries(sources.map((source) => [
      source.key,
      emptyChapterReview(source),
    ]));
  }
  const ready = documents.length > 0
    && status.status === "complete"
    && contractMatches
    && projectionReady
    && storedStateValid;
  return {
    workflow,
    status,
    documents,
    chapterReviews,
    privacyDecisions,
    storySessionReadyRunId: ready ? workflow.workflowRunId : "",
  };
}
