export type StoryPrivacyDecision = "keep" | "redact";

export type StoryPrivacyCandidate = {
  id: string;
  reviewState: "deterministic" | "needs_confirmation";
  title: string;
  whyFlagged: string;
  uncertaintyReason: string | null;
  releaseTargets: string[];
  decision: StoryPrivacyDecision | null;
  decisionVersion: 0 | 1;
  decidedAt: string | null;
};

export type StoryPrivacyAuthority = {
  workflowRunId: string;
  sourceRevision: number;
  activeStoryDigest: string;
  candidateDigest: string;
  status: "completed_empty" | "completed_with_candidates";
  candidates: StoryPrivacyCandidate[];
};

export type StoryPrivacyState =
  | { status: "unavailable" | "loading" | "error"; authority: null; message: string }
  | { status: "ready"; authority: StoryPrivacyAuthority; message: string };

const digest = /^[0-9a-f]{64}$/u;

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeText(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim())
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function stableId(value: unknown): value is string {
  return safeText(value) && !/[\u0009\u000a\u000d]/u.test(value);
}

function exactTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

const encoder = new TextEncoder();
function compareUtf8(left: string, right: string) {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

export function parseStoryPrivacyAuthority(value: unknown): StoryPrivacyAuthority | null {
  const authorityKeys = [
    "workflowRunId", "sourceRevision", "activeStoryDigest", "candidateDigest", "status", "candidates",
  ];
  const candidateKeys = [
    "id", "reviewState", "title", "whyFlagged", "uncertaintyReason", "releaseTargets",
    "decision", "decisionVersion", "decidedAt",
  ];
  if (!record(value) || !exactKeys(value, authorityKeys)
    || !stableId(value.workflowRunId) || !Number.isSafeInteger(value.sourceRevision) || Number(value.sourceRevision) <= 0
    || typeof value.activeStoryDigest !== "string" || !digest.test(value.activeStoryDigest)
    || typeof value.candidateDigest !== "string" || !digest.test(value.candidateDigest)
    || (value.status !== "completed_empty" && value.status !== "completed_with_candidates")
    || !Array.isArray(value.candidates)) return null;
  const candidates: StoryPrivacyCandidate[] = [];
  for (const rawCandidate of value.candidates) {
    if (!record(rawCandidate) || !exactKeys(rawCandidate, candidateKeys)
      || !stableId(rawCandidate.id)
      || (rawCandidate.reviewState !== "deterministic" && rawCandidate.reviewState !== "needs_confirmation")
      || !safeText(rawCandidate.title) || !safeText(rawCandidate.whyFlagged)
      || (rawCandidate.reviewState === "deterministic" && rawCandidate.uncertaintyReason !== null)
      || (rawCandidate.reviewState === "needs_confirmation" && !safeText(rawCandidate.uncertaintyReason))
      || !Array.isArray(rawCandidate.releaseTargets) || rawCandidate.releaseTargets.length === 0
      || !rawCandidate.releaseTargets.every(stableId)
      || new Set(rawCandidate.releaseTargets).size !== rawCandidate.releaseTargets.length
      || (rawCandidate.decision !== null && rawCandidate.decision !== "keep" && rawCandidate.decision !== "redact")
      || (rawCandidate.decisionVersion !== 0 && rawCandidate.decisionVersion !== 1)
      || (rawCandidate.decidedAt !== null && !exactTimestamp(rawCandidate.decidedAt))) return null;
    if (rawCandidate.reviewState === "deterministic"
      ? rawCandidate.decision !== null || rawCandidate.decisionVersion !== 0 || rawCandidate.decidedAt !== null
      : rawCandidate.decision === null
        ? rawCandidate.decisionVersion !== 0 || rawCandidate.decidedAt !== null
        : rawCandidate.decisionVersion !== 1 || !exactTimestamp(rawCandidate.decidedAt)) return null;
    candidates.push(rawCandidate as StoryPrivacyCandidate);
  }
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length
    || candidates.some((candidate, index) => index > 0 && compareUtf8(candidates[index - 1].id, candidate.id) >= 0)
    || (value.status === "completed_empty") !== (candidates.length === 0)) return null;
  return { ...(value as StoryPrivacyAuthority), candidates };
}

export function storyPrivacyCandidateResolved(candidate: StoryPrivacyCandidate) {
  return candidate.reviewState === "deterministic" || candidate.decision !== null;
}

export function storyPrivacyAuthorityComplete(authority: StoryPrivacyAuthority | null) {
  return Boolean(authority && authority.candidates.every(storyPrivacyCandidateResolved));
}

export function chapterStoryPrivacyCandidates(authority: StoryPrivacyAuthority | null, storyKey: string) {
  const prefix = `${storyKey}::`;
  return authority?.candidates.filter((candidate) => (
    candidate.releaseTargets.some((target) => target.startsWith(prefix))
  )) || [];
}
