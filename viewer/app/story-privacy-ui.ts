export type StoryPrivacyCandidate = {
  id: string;
  reviewState: "deterministic" | "needs_confirmation";
  title: string;
  whyFlagged: string;
  uncertaintyReason: string | null;
  releaseTargets: string[];
  resolved: boolean;
};

export type StoryPrivacyOccurrence = {
  originalStartOffset: number;
  originalEndOffset: number;
  proposalStartOffset: number;
  proposalEndOffset: number;
  category: string;
  originalText: string;
  proposedText: string;
  canPublish: boolean;
  isPublic: boolean;
};

export type StoryPrivacyTarget = {
  targetId: string;
  targetContentDigest: string;
  originalText: string;
  proposedText: string;
  selectedText: string | null;
  edited: boolean;
  occurrences: StoryPrivacyOccurrence[];
  decidedAt: string | null;
};

export type StoryPrivacyTargetChoice = {
  editedText: string | null;
  publicOverrides: Array<{
    originalStartOffset: number;
    originalEndOffset: number;
    category: string;
  }>;
};

export type StoryPrivacyAuthority = {
  workflowRunId: string;
  sourceRevision: number;
  activeStoryDigest: string;
  authorityDigest: string;
  status: "preparation_required" | "completed_empty" | "completed_with_candidates";
  candidates: StoryPrivacyCandidate[];
  targets: StoryPrivacyTarget[];
};

export type StoryPrivacyState =
  | { status: "unavailable" | "loading" | "error"; authority: null; message: string }
  | { status: "ready"; authority: StoryPrivacyAuthority; message: string };

export type StoryPrivacyRequestTicket = { generation: number; signal: AbortSignal };

export class StoryPrivacyRequestGate {
  #generation = 0;
  #active: { generation: number; controller: AbortController } | null = null;

  begin(replace = false): StoryPrivacyRequestTicket | null {
    if (this.#active && !replace) return null;
    this.#active?.controller.abort();
    const controller = new AbortController();
    const generation = ++this.#generation;
    this.#active = { generation, controller };
    return { generation, signal:controller.signal };
  }

  isCurrent(ticket: StoryPrivacyRequestTicket) {
    return !ticket.signal.aborted && this.#active?.generation === ticket.generation;
  }

  finish(ticket: StoryPrivacyRequestTicket) {
    if (this.#active?.generation === ticket.generation) this.#active = null;
  }

  retire() {
    this.#generation += 1;
    this.#active?.controller.abort();
    this.#active = null;
  }
}

const digest = /^[0-9a-f]{64}$/u;
const encoder = new TextEncoder();

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function safeText(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= 1_000_000
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    && !/[\ud800-\udfff]/u.test(Array.from(value).join(""));
}

function stableId(value: unknown): value is string {
  return safeText(value) && value.length <= 1_000 && !/[\u0009\u000a\u000d]/u.test(value);
}

function exactTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function compareUtf8(left: string, right: string) {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

export function parseStoryPrivacyAuthority(value: unknown): StoryPrivacyAuthority | null {
  if (!record(value) || !exactKeys(value, [
    "workflowRunId", "sourceRevision", "activeStoryDigest", "authorityDigest", "status",
    "candidates", "targets",
  ]) || !stableId(value.workflowRunId)
    || !Number.isSafeInteger(value.sourceRevision) || Number(value.sourceRevision) <= 0
    || typeof value.activeStoryDigest !== "string" || !digest.test(value.activeStoryDigest)
    || typeof value.authorityDigest !== "string" || !digest.test(value.authorityDigest)
    || !["preparation_required", "completed_empty", "completed_with_candidates"]
      .includes(String(value.status))
    || !Array.isArray(value.candidates) || !Array.isArray(value.targets)) return null;

  const targets: StoryPrivacyTarget[] = [];
  for (const raw of value.targets) {
    if (!record(raw) || !exactKeys(raw, [
      "targetId", "targetContentDigest", "originalText", "proposedText", "selectedText", "edited",
      "occurrences", "decidedAt",
    ]) || !stableId(raw.targetId) || typeof raw.targetContentDigest !== "string"
      || !digest.test(raw.targetContentDigest) || !safeText(raw.originalText)
      || !safeText(raw.proposedText) || (raw.selectedText !== null && !safeText(raw.selectedText))
      || typeof raw.edited !== "boolean" || !Array.isArray(raw.occurrences)
      || (raw.selectedText === null ? raw.decidedAt !== null : !exactTimestamp(raw.decidedAt))) return null;
    const occurrences: StoryPrivacyOccurrence[] = [];
    for (const occurrence of raw.occurrences) {
      if (!record(occurrence) || !exactKeys(occurrence, [
        "originalStartOffset", "originalEndOffset", "proposalStartOffset", "proposalEndOffset",
        "category", "originalText", "proposedText", "canPublish", "isPublic",
      ]) || !Number.isSafeInteger(occurrence.originalStartOffset)
        || Number(occurrence.originalStartOffset) < 0
        || !Number.isSafeInteger(occurrence.originalEndOffset)
        || Number(occurrence.originalEndOffset) <= Number(occurrence.originalStartOffset)
        || !Number.isSafeInteger(occurrence.proposalStartOffset)
        || Number(occurrence.proposalStartOffset) < 0
        || !Number.isSafeInteger(occurrence.proposalEndOffset)
        || Number(occurrence.proposalEndOffset) <= Number(occurrence.proposalStartOffset)
        || typeof occurrence.category !== "string"
        || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(occurrence.category)
        || !safeText(occurrence.originalText)
        || !safeText(occurrence.proposedText) || typeof occurrence.canPublish !== "boolean"
        || typeof occurrence.isPublic !== "boolean" || (occurrence.isPublic && !occurrence.canPublish)
        || Array.from(raw.originalText).slice(Number(occurrence.originalStartOffset),
          Number(occurrence.originalEndOffset)).join("") !== occurrence.originalText
        || Array.from(raw.proposedText).slice(Number(occurrence.proposalStartOffset),
          Number(occurrence.proposalEndOffset)).join("") !== occurrence.proposedText) return null;
      occurrences.push(occurrence as StoryPrivacyOccurrence);
    }
    if (occurrences.some((item, index) => index > 0
      && (occurrences[index - 1].originalEndOffset > item.originalStartOffset
        || occurrences[index - 1].proposalEndOffset > item.proposalStartOffset))) return null;
    const original = Array.from(raw.originalText);
    const proposal = Array.from(raw.proposedText);
    let originalCursor = 0;
    let proposalCursor = 0;
    for (const occurrence of occurrences) {
      if (original.slice(originalCursor, occurrence.originalStartOffset).join("")
          !== proposal.slice(proposalCursor, occurrence.proposalStartOffset).join("")) return null;
      originalCursor = occurrence.originalEndOffset;
      proposalCursor = occurrence.proposalEndOffset;
    }
    if (original.slice(originalCursor).join("") !== proposal.slice(proposalCursor).join("")) return null;
    const publicOccurrences = occurrences.filter((occurrence) => occurrence.isPublic);
    if (publicOccurrences.length > 0) {
      const reconstructed = [...proposal];
      for (const occurrence of [...publicOccurrences]
        .sort((left, right) => right.proposalStartOffset - left.proposalStartOffset)) {
        reconstructed.splice(occurrence.proposalStartOffset,
          occurrence.proposalEndOffset - occurrence.proposalStartOffset,
          ...original.slice(occurrence.originalStartOffset, occurrence.originalEndOffset));
      }
      if (raw.selectedText !== reconstructed.join("")) return null;
    }
    const expectedEdited = raw.selectedText !== null && raw.selectedText !== raw.proposedText
      && publicOccurrences.length === 0;
    if (raw.edited !== expectedEdited
      || (raw.selectedText === null && publicOccurrences.length > 0)) return null;
    targets.push({ ...(raw as StoryPrivacyTarget), occurrences });
  }
  if (new Set(targets.map((target) => target.targetId)).size !== targets.length) return null;
  const targetById = new Map(targets.map((target) => [target.targetId, target]));

  const candidates: StoryPrivacyCandidate[] = [];
  for (const raw of value.candidates) {
    if (!record(raw) || !exactKeys(raw, [
      "id", "reviewState", "title", "whyFlagged", "uncertaintyReason", "releaseTargets", "resolved",
    ]) || !stableId(raw.id)
      || (raw.reviewState !== "deterministic" && raw.reviewState !== "needs_confirmation")
      || !safeText(raw.title) || !safeText(raw.whyFlagged)
      || (raw.reviewState === "deterministic" && raw.uncertaintyReason !== null)
      || (raw.reviewState === "needs_confirmation" && !safeText(raw.uncertaintyReason))
      || !Array.isArray(raw.releaseTargets) || raw.releaseTargets.length === 0
      || !raw.releaseTargets.every(stableId)
      || new Set(raw.releaseTargets).size !== raw.releaseTargets.length
      || typeof raw.resolved !== "boolean"
      || raw.releaseTargets.some((target) => !targetById.has(target))
      || raw.resolved !== raw.releaseTargets.every((target) => (
        targetById.get(target)?.selectedText !== null
      ))) return null;
    candidates.push(raw as StoryPrivacyCandidate);
  }
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length
    || candidates.some((candidate, index) => index > 0
      && compareUtf8(candidates[index - 1].id, candidate.id) >= 0)
    || (value.status === "completed_empty" && candidates.length !== 0)
    || (value.status === "completed_with_candidates" && candidates.length === 0)) return null;
  const flaggedTargets = new Set(candidates.flatMap((candidate) => candidate.releaseTargets));
  const changedTargets = new Set(targets.filter((target) => target.occurrences.length > 0)
    .map((target) => target.targetId));
  if (flaggedTargets.size !== changedTargets.size
    || [...flaggedTargets].some((target) => !changedTargets.has(target))) return null;
  return { ...(value as StoryPrivacyAuthority), candidates, targets };
}

export const storyPrivacyCandidateResolved = (candidate: StoryPrivacyCandidate) => candidate.resolved;

export function storyPrivacyAuthorityCurrent(
  state: StoryPrivacyState,
  workflowRunId: string,
) {
  return state.status === "ready"
    && state.authority.workflowRunId === workflowRunId
    && state.authority.status !== "preparation_required";
}

export function storyPrivacyApplyBlockerCopy(
  status: StoryPrivacyState["status"] | "preparation_required",
) {
  if (status === "loading") {
    return "Story Privacy is still loading. Apply review is blocked until the current authority is available.";
  }
  if (status === "preparation_required") {
    return "Story Privacy must be refreshed after applied release content changed. Apply review is blocked until refreshed authority is available.";
  }
  return "Current Story Privacy authority is unavailable. Apply review is blocked until it can be loaded safely.";
}

export function storyPrivacyAuthorityComplete(authority: StoryPrivacyAuthority | null) {
  return Boolean(authority && authority.status !== "preparation_required"
    && authority.targets.every((target) => target.selectedText !== null));
}

export function chapterStoryPrivacyCandidates(authority: StoryPrivacyAuthority | null, storyKey: string) {
  const prefix = `${storyKey}::`;
  return authority?.candidates.filter((candidate) => (
    candidate.releaseTargets.some((target) => target.startsWith(prefix))
  )) || [];
}
