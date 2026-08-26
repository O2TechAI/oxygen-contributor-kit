import type { WorkflowProgressState } from "./workflow-progress";
import type { WorkspaceStatus } from "./workspace-types";

const RETRY_DELAYS_MS = [500, 1000, 2000];

type OrganizationPollingOptions = {
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
  let passes = 0;
  let terminalRefresh = false;
  const active = () => !cancelled && !controller.signal.aborted;
  const stop = () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
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
  const request = async (method: "GET" | "POST"): Promise<void> => {
    if (!active()) return;
    try {
      const status = await options.requestOrganization({ method, signal: controller.signal });
      if (!active()) return;
      retries = 0;
      options.onStatus(status);
      options.onRecovered();
      if (status.status === "complete" || status.status === "empty") {
        await finish();
        return;
      }
      if (method === "POST" && ++passes % 4 === 0) {
        await options.loadWorkflow(controller.signal);
        if (!active()) return;
      }
      void request("POST");
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
        void request(method);
      }, delay);
    }
  };
  void (async () => {
    try {
      const workflow = await options.loadWorkflow(controller.signal);
      if (!active()) return;
      if (!workflow) {
        options.onError("Workflow status could not be confirmed");
        stop();
        return;
      }
      if (workflow.currentStageId === "collect" || workflow.currentStageId === "review") {
        stop();
        return;
      }
      await request("GET");
    } catch (value) {
      if (active()) options.onError(message(value));
      stop();
    }
  })();
  return stop;
}
