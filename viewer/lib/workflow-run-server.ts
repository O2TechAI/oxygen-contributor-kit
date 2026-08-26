import type { getD1 } from "../db";

type WorkflowDatabase = Awaited<ReturnType<typeof getD1>>;

export const WORKFLOW_RUN_AUTHORITY = {
  noRun: "NO_RUN_ESTABLISHED",
  exactRun: "EXACT_RUN_ESTABLISHED",
  foreignRun: "FOREIGN_RUN_REQUESTED",
  multipleRuns: "MULTIPLE_RUN_ROWS_INVALID",
} as const;

export type WorkflowRunAuthority =
  | { state: typeof WORKFLOW_RUN_AUTHORITY.noRun }
  | { state: typeof WORKFLOW_RUN_AUTHORITY.exactRun; workflowRunId: string }
  | { state: typeof WORKFLOW_RUN_AUTHORITY.foreignRun }
  | { state: typeof WORKFLOW_RUN_AUTHORITY.multipleRuns };

export type EstablishedWorkflowRun = Extract<
  WorkflowRunAuthority,
  { state: typeof WORKFLOW_RUN_AUTHORITY.exactRun }
>;
export type WorkflowRunAuthorityFailure = Exclude<WorkflowRunAuthority, EstablishedWorkflowRun>;

export class WorkflowRunAuthorityError extends Error {
  readonly authority: WorkflowRunAuthorityFailure;

  constructor(authority: WorkflowRunAuthorityFailure) {
    super(authority.state);
    this.name = "WorkflowRunAuthorityError";
    this.authority = authority;
  }
}

/** Inspect only singleton identity. Never choose a row by creation/update time
 * and never derive workflow ownership from Viewer-global jobs. */
export async function inspectEstablishedWorkflowRun(
  db: WorkflowDatabase,
  requestedRunId?: string,
): Promise<WorkflowRunAuthority> {
  const response = await db.prepare(
    "SELECT id FROM workflow_runs ORDER BY id LIMIT 2",
  ).all<{ id: string }>();
  const rows = response.results || [];
  if (rows.length === 0) return { state: WORKFLOW_RUN_AUTHORITY.noRun };
  if (rows.length > 1) return { state: WORKFLOW_RUN_AUTHORITY.multipleRuns };
  const workflowRunId = rows[0].id;
  if (requestedRunId !== undefined && requestedRunId !== workflowRunId) {
    return { state: WORKFLOW_RUN_AUTHORITY.foreignRun };
  }
  return { state: WORKFLOW_RUN_AUTHORITY.exactRun, workflowRunId };
}

/** Atomically establish the first target-confirmed run. SQLite serializes this
 * single write statement, so concurrent distinct IDs cannot both observe and
 * insert an empty workflow_runs table. */
export async function establishWorkflowRun(
  db: WorkflowDatabase,
  requestedRunId: string,
  now: string,
) {
  await db.prepare(`INSERT INTO workflow_runs (
      id,target_confirmed,collection_status,collection_completed,collection_total,
      blocker_code,created_at,updated_at
    ) SELECT ?,1,'pending',0,0,NULL,?,?
      WHERE NOT EXISTS (SELECT 1 FROM workflow_runs)`)
    .bind(requestedRunId, now, now)
    .run();
  return inspectEstablishedWorkflowRun(db, requestedRunId);
}

export function requireEstablishedWorkflowRun(db: WorkflowDatabase) {
  return inspectEstablishedWorkflowRun(db);
}

export function requireExactWorkflowRun(db: WorkflowDatabase, requestedRunId: string) {
  return inspectEstablishedWorkflowRun(db, requestedRunId);
}

export function workflowRunErrorResponse(authority: WorkflowRunAuthorityFailure) {
  const error = authority.state === WORKFLOW_RUN_AUTHORITY.noRun
    ? "Workflow run is not established"
    : authority.state === WORKFLOW_RUN_AUTHORITY.foreignRun
      ? "Requested workflow run is not established"
      : "Viewer workflow state is invalid";
  return Response.json({ error, code: authority.state }, { status: 409 });
}
