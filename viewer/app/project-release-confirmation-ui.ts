import type { BulkDecision, Probe, ProbeRun } from "./probe-panel";
import type { DownloadReviewBlockerGroup } from "../lib/story-navigation";

export function projectReleaseConfirmationPreferencesComplete(
  run: ProbeRun,
  probes: Probe[],
  bulkDecisions: BulkDecision[],
) {
  return run?.status === "complete" && run.stage === "preference"
    && probes.every((probe) => Boolean(probe.answered_at && probe.answer_choice))
    && bulkDecisions.every((decision) => Boolean(decision.answered_at && decision.answer));
}

export type ProjectReleaseConfirmationRequest = {
  generation: number;
  workflowRunId: string;
  signal: AbortSignal;
};

export type ProjectReleaseAction = "confirm" | "download_html" | "download_zip";
export type ProjectReleaseStoryPrivacyState =
  | "complete" | "unresolved" | "preparation_required" | "unavailable";
export type ProjectReleasePreferenceState = "complete" | "unanswered" | "stale" | "missing";
export type ProjectReleaseRecoveryDestination =
  | "release_preview" | "preferences" | "story_review" | "confirm_release";
export type ProjectReleaseAuthorityBlocker = {
  code: "story_privacy_unresolved" | "story_privacy_preparation_required"
    | "story_privacy_unavailable" | "preference_unanswered" | "preference_stale"
    | "preference_missing" | "review_authority_mismatch" | "release_confirmation_missing";
  destination: ProjectReleaseRecoveryDestination;
  agentRecovery: boolean;
};

export type ProjectReleaseActionBlockers = {
  chapterGroups: DownloadReviewBlockerGroup[];
  authority: ProjectReleaseAuthorityBlocker[];
  requiresAgentRecovery: boolean;
};

export const PROJECT_RELEASE_AGENT_RESUME_INSTRUCTION =
  "Resume the current local Oxygen workflow in the existing Viewer and workflow run. Revalidate Story Privacy, Preference, and Story review persistence authority. Do not repair SQLite or create release authority by hand.";

export function projectReleaseActionBlockers(input: {
  action: ProjectReleaseAction;
  chapterGroups: DownloadReviewBlockerGroup[];
  storyPrivacy: ProjectReleaseStoryPrivacyState;
  preferences: ProjectReleasePreferenceState;
  reviewAuthorityCurrent: boolean;
  releaseConfirmed: boolean;
}): ProjectReleaseActionBlockers {
  const authority: ProjectReleaseAuthorityBlocker[] = [];
  if (input.storyPrivacy === "unresolved") {
    authority.push({ code:"story_privacy_unresolved", destination:"release_preview", agentRecovery:false });
  } else if (input.storyPrivacy === "preparation_required") {
    authority.push({
      code:"story_privacy_preparation_required", destination:"release_preview", agentRecovery:true,
    });
  } else if (input.storyPrivacy === "unavailable") {
    authority.push({ code:"story_privacy_unavailable", destination:"release_preview", agentRecovery:true });
  }
  if (input.preferences === "unanswered") {
    authority.push({ code:"preference_unanswered", destination:"preferences", agentRecovery:false });
  } else if (input.preferences === "stale") {
    authority.push({ code:"preference_stale", destination:"preferences", agentRecovery:true });
  } else if (input.preferences === "missing") {
    authority.push({ code:"preference_missing", destination:"preferences", agentRecovery:true });
  }
  if (!input.reviewAuthorityCurrent) {
    authority.push({ code:"review_authority_mismatch", destination:"story_review", agentRecovery:true });
  }
  if (input.action !== "confirm" && !input.releaseConfirmed) {
    authority.push({
      code:"release_confirmation_missing", destination:"confirm_release", agentRecovery:false,
    });
  }
  return {
    chapterGroups: input.chapterGroups,
    authority,
    requiresAgentRecovery: authority.some((blocker) => blocker.agentRecovery),
  };
}

export function projectReleaseActionBlocked(blockers: ProjectReleaseActionBlockers) {
  return blockers.chapterGroups.length > 0 || blockers.authority.length > 0;
}

/** Prevent a rapid second download click from starting another durable handoff. */
export class ProjectReleaseDownloadRequestGate {
  private active: ProjectReleaseAction | null = null;

  begin(action: ProjectReleaseAction) {
    if (this.active || action === "confirm") return false;
    this.active = action;
    return true;
  }

  finish(action: ProjectReleaseAction) {
    if (this.active === action) this.active = null;
  }

  retire() {
    this.active = null;
  }
}

/** One contributor click owns one request epoch. Replacement or cleanup aborts
 * the fetch and makes every response from the retired epoch ineligible to
 * update the current run. */
export class ProjectReleaseConfirmationRequestGate {
  private generation = 0;
  private active: (ProjectReleaseConfirmationRequest & { controller: AbortController }) | null = null;

  begin(workflowRunId: string): ProjectReleaseConfirmationRequest | null {
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

  isCurrent(request: ProjectReleaseConfirmationRequest) {
    return this.active?.generation === request.generation
      && this.active.workflowRunId === request.workflowRunId
      && !request.signal.aborted;
  }

  finish(request: ProjectReleaseConfirmationRequest) {
    if (this.active?.generation === request.generation) this.active = null;
  }

  retire() {
    this.generation += 1;
    this.active?.controller.abort();
    this.active = null;
  }
}
