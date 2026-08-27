import type { BulkDecision, Probe, ProbeRun } from "./probe-panel";

export function projectAllSetPreferencesComplete(
  run: ProbeRun,
  probes: Probe[],
  bulkDecisions: BulkDecision[],
) {
  return run?.status === "complete" && run.stage === "preference"
    && probes.every((probe) => Boolean(probe.answered_at && probe.answer_choice))
    && bulkDecisions.every((decision) => Boolean(decision.answered_at && decision.answer));
}

export type ProjectAllSetRequest = {
  generation: number;
  workflowRunId: string;
  signal: AbortSignal;
};

/** One contributor click owns one request epoch. Replacement or cleanup aborts
 * the fetch and makes every response from the retired epoch ineligible to
 * update the current run. */
export class ProjectAllSetRequestGate {
  private generation = 0;
  private active: (ProjectAllSetRequest & { controller: AbortController }) | null = null;

  begin(workflowRunId: string): ProjectAllSetRequest | null {
    if (this.active || !workflowRunId) return null;
    const controller = new AbortController();
    const request = {
      generation: ++this.generation,
      workflowRunId,
      signal: controller.signal,
      controller,
    };
    this.active = request;
    return request;
  }

  isCurrent(request: ProjectAllSetRequest) {
    return this.active?.generation === request.generation
      && this.active.workflowRunId === request.workflowRunId
      && !request.signal.aborted;
  }

  finish(request: ProjectAllSetRequest) {
    if (this.active?.generation === request.generation) this.active = null;
  }

  retire() {
    this.generation += 1;
    this.active?.controller.abort();
    this.active = null;
  }
}
