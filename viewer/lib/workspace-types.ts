export type WorkspaceHighlight = {
  id: string;
  sequence: number;
  timestamp?: string;
  project?: string;
  summary?: string;
  content?: string;
  documentId?: string;
};

export type WorkspaceSummary = {
  primary_project?: string;
  project_summary?: string;
  projects?: Array<{ name: string; event_count: number; primary: boolean }>;
  highlights?: WorkspaceHighlight[];
};

export type WorkspaceStatus = {
  status: string;
  stage: string;
  completed: number;
  total: number;
  percent: number;
  documentCount: number;
  warnings: string[];
};

export type WorkspaceDocument = {
  id: string;
  kind: string;
  title: string;
  source_user?: string;
  source_system?: string;
  source_timestamp?: string;
  item_count: number;
  organization_status: string;
  formatted_summary?: WorkspaceSummary;
};

const ORGANIZATION_STATUSES = new Set(["idle", "running", "complete", "empty"]);
const nonNegativeNumber = (value: unknown): value is number => typeof value === "number"
  && Number.isFinite(value) && value >= 0;

export function parseWorkspaceStatus(value: unknown): WorkspaceStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = value as Partial<WorkspaceStatus>;
  return typeof status.status === "string" && ORGANIZATION_STATUSES.has(status.status)
    && typeof status.stage === "string"
    && nonNegativeNumber(status.completed)
    && nonNegativeNumber(status.total)
    && nonNegativeNumber(status.percent)
    && nonNegativeNumber(status.documentCount)
    && Array.isArray(status.warnings)
    && status.warnings.every((warning) => typeof warning === "string")
    ? status as WorkspaceStatus
    : null;
}
