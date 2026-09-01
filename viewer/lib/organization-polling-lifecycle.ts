import type { WorkflowProgressState } from "./workflow-progress";
import type { WorkspaceStatus } from "./workspace-types";

const RETRY_DELAYS_MS = [500, 1000, 2000];
const POLL_INTERVAL_MS = 2000;

type OrganizationPollingOptions = {
  currentStageId: WorkflowProgressState["currentStageId"];
  loadWorkflow(signal: AbortSignal): Promise<WorkflowProgressState | null>;
  requestOrganization(init: RequestInit): Promise<WorkspaceStatus>;
  loadDocuments(signal: AbortSignal): Promise<unknown>;
  onStatus(status: WorkspaceStatus): void;
  onError(message: string): void;
  onRecovered(): void;
};

type OrganizationPollingError = Error & { status?: number; retryable?: boolean };

const message = (value: unknown) => value instanceof Error && value.message
  ? value.message
  : "Organization failed";

export function isTransientOrganizationPollingFailure(value: unknown) {
  if (!(value instanceof Error)) return true;
  const error = value as OrganizationPollingError;
  return error.retryable !== false && (error.status === undefined
    || error.status === 408 || error.status === 425 || error.status === 429
    || error.status >= 500 && error.status < 600);
}

export function startOrganizationPolling(options: OrganizationPollingOptions) {
  const controller = new AbortController();
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retries = 0;
  let terminalRefresh = false;
  const active = () => !cancelled && !controller.signal.aborted;
  const stop = () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    controller.abort();
  };
  const finish = async () => {
    if (!active() || terminalRefresh) return;
    terminalRefresh = true;
    try {
      await options.loadDocuments(controller.signal);
      if (!active()) return;
      await options.loadWorkflow(controller.signal);
    } catch (value) {
      if (active()) options.onError(message(value));
    } finally {
      stop();
    }
  };
  const request = async (): Promise<void> => {
    if (!active()) return;
    try {
      const status = await options.requestOrganization({ method: "GET", signal: controller.signal });
      if (!active()) return;
      retries = 0;
      options.onStatus(status);
      options.onRecovered();
      if (status.status === "complete" || status.status === "empty") {
        await finish();
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        void request();
      }, POLL_INTERVAL_MS);
    } catch (value) {
      if (!active()) return;
      options.onError(message(value));
      const delay = isTransientOrganizationPollingFailure(value) ? RETRY_DELAYS_MS[retries++] : undefined;
      if (delay === undefined) {
        stop();
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        void request();
      }, delay);
    }
  };
  if (options.currentStageId !== "organize") {
    stop();
    return stop;
  }
  void request();
  return stop;
}
