import { canonicalAuthorityJson, type StoryCandidateRow } from "./story-readiness.ts";
import { validActivatedSourceRevision } from "./authority-validation.mjs";
import {
  parseStorySource,
  type StoryReleaseTarget,
  type StoryReleaseTargetDescriptor,
  type StoryReleaseTargetName,
  type StorySource,
} from "./timeline.ts";

export const STORY_PREPARATION_SCHEMA = "oxygen.story-preparation" as const;
export const STORY_PREPARATION_LANES = [
  "story",
  "insight",
  "story_privacy",
  "preference",
] as const;
export const STORY_PREPARATION_EMPTY_ARRAY_DIGEST =
  "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
export const MAX_PREFERENCE_QUESTIONS = 20;
export const MAX_PREFERENCE_EVIDENCE_IDS = 500;

export type StoryPreparationLane = typeof STORY_PREPARATION_LANES[number];

export type StoryPreparationReceipt = {
  lane: StoryPreparationLane;
  status: "complete";
  inputDigest: string;
  scopeDigest: string;
  scopeCount: number;
  outputDigest: string;
  outputCount: number;
};

export type StoryPreparationPrivacyCandidate = {
  id: string;
  reviewState: "deterministic" | "needs_confirmation";
  title: string;
  whyFlagged: string;
  uncertaintyReason: string | null;
  releaseTargets: StoryReleaseTarget[];
};

export type StoryPreparationPrivacyTargetProposal = {
  targetId: StoryReleaseTarget;
  targetContentDigest: string;
  proposedText: string;
  occurrences: Array<{
    originalStartOffset: number;
    originalEndOffset: number;
    proposalStartOffset: number;
    proposalEndOffset: number;
    category: string;
  }>;
};

export type StoryPreparationPrivacyOutput = {
  candidates: StoryPreparationPrivacyCandidate[];
  targetProposals: StoryPreparationPrivacyTargetProposal[];
};

export type StoryReleaseTargetContent = StoryReleaseTargetDescriptor & { content: string };

export type StoryPreparationManifest = {
  schema: typeof STORY_PREPARATION_SCHEMA;
  workflowRunId: string;
  sourceRevision: number;
  receipts: StoryPreparationReceipt[];
  storyPrivacy: StoryPreparationPrivacyOutput;
};

export type PreferenceBatchAuthority = {
  workflowRunId: string;
  sourceRevision: number;
  inputDigest: string;
  outputDigest: string;
  outputCount: number;
  insightScope: PreferenceInsightBinding[];
  lifecycleDigest?: string;
};

export type PreferenceInsightBinding = { storyKey: string; insightId: string; insightAuthorityDigest: string };

export type StoryPreparationContext = {
  workflowRunId: string;
  sourceRevision: number;
  semanticManifestDigest: string;
  semanticUnitIds: string[];
  storyCandidates: StoryCandidateRow[];
  preference: PreferenceBatchAuthority | null;
};

export type StoryPreparationAuthority = {
  receipts: StoryPreparationReceipt[];
  privacy: StoryPreparationManifest["storyPrivacy"];
  preference: PreferenceBatchAuthority;
};

export type StoryPreparationValidation =
  | { ok: true; authority: StoryPreparationAuthority }
  | { ok: false; code: string };

const digestPattern = /^[0-9a-f]{64}$/;
const targetSeparator = "::";
const encoder = new TextEncoder();

const onlyKeys = (value: Record<string, unknown>, keys: string[]) => (
  Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
);
const isObject = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === "object" && !Array.isArray(value)
);
const nonEmptyString = (value: unknown): value is string => (
  typeof value === "string" && Boolean(value.trim())
);
const stableId = (value: unknown): value is string => (
  nonEmptyString(value) && !/[\u0000-\u001f\u007f]/u.test(value)
);
export const validPreferenceDocumentKind = (value: unknown): value is string => (
  typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(value)
);
const safeText = (value: unknown): value is string => (
  nonEmptyString(value) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
);
const scalarText = (value: unknown): value is string => {
  if (!safeText(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const point = value.charCodeAt(index);
    if (point >= 0xd800 && point <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (point >= 0xdc00 && point <= 0xdfff) return false;
  }
  return true;
};
const exactNonNegativeInteger = (value: unknown): value is number => (
  Number.isSafeInteger(value) && Number(value) >= 0
);
export const compareUtf8 = (left: string, right: string) => {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
};
const sortedUniqueIds = (values: string[]) => (
  new Set(values).size === values.length ? [...values].sort(compareUtf8) : null
);

export async function storyPreparationDigest(value: unknown) {
  const bytes = encoder.encode(canonicalAuthorityJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const insightAuthorityValue = (storyKey: string, insight: StorySource["insights"][number]) => ({
  storyKey, insightId: insight.id, content: insight,
});

export function canonicalPreferenceQuestionBatch(
  probes: Array<Record<string, unknown> & { id: string }>,
  bulkDecisions: Array<Record<string, unknown> & { id: string }>,
) {
  return [
    ...probes.map((probe) => ({ ...probe, type: "probe" as const })),
    ...bulkDecisions.map((decision) => ({ ...decision, type: "bulk" as const })),
  ].sort((left, right) => compareUtf8(`${left.type}:${left.id}`, `${right.type}:${right.id}`));
}

export function storyReleaseTargetId(
  storyKey: string,
  target: StoryReleaseTargetName,
): StoryReleaseTarget {
  return `${storyKey}${targetSeparator}${target}` as StoryReleaseTarget;
}

function storyTargetValues(story: StorySource): Array<{ target: StoryReleaseTargetName; content: string }> {
  const targets: Array<{ target: StoryReleaseTargetName; content: string }> = [
    { target:"phase", content:story.phase.label },
    { target:"title", content:story.title },
    { target:"overview", content:story.overview },
  ];
  if (story.transition) targets.push(
    { target:"transition:before", content:story.transition.before },
    { target:"transition:after", content:story.transition.after },
  );
  for (const person of story.people) {
    targets.push(
      { target:`people:${person.id}:releaseLabel`, content:person.releaseLabel },
      { target:`people:${person.id}:role`, content:person.role },
      { target:`people:${person.id}:description`, content:person.description },
    );
  }
  for (const block of story.story.blocks) {
    targets.push({ target:`story:${block.id}`, content:block.text });
  }
  if (story.story.uncertainty !== undefined) {
    targets.push({ target:"uncertainty", content:story.story.uncertainty });
  }
  for (const insight of story.insights) {
    if (insight.title !== undefined) {
      targets.push({ target:`insight:${insight.id}:title`, content:insight.title });
    }
    targets.push(
      { target:`insight:${insight.id}:background`, content:insight.background },
      { target:`insight:${insight.id}:quote`, content:insight.quote.text },
      { target:`insight:${insight.id}:directlyAcquiredExperience`,
        content:insight.directlyAcquiredExperience },
      { target:`insight:${insight.id}:principle`, content:insight.principle },
    );
  }
  return targets;
}

export function deriveStoryReleaseTargetContents(
  stories: StorySource[],
): StoryReleaseTargetContent[] | null {
  const targets: StoryReleaseTargetContent[] = [];
  const ids = new Set<string>();
  for (const story of stories) {
    if (!stableId(story.key)) return null;
    for (const value of storyTargetValues(story)) {
      if (!stableId(value.target) || typeof value.content !== "string") return null;
      const id = storyReleaseTargetId(story.key, value.target);
      if (ids.has(id)) return null;
      ids.add(id);
      targets.push({ id, storyKey:story.key, target:value.target, content:value.content });
    }
  }
  return targets;
}

export function deriveStoryReleaseTargetCatalog(
  stories: StorySource[],
): StoryReleaseTargetDescriptor[] | null {
  return deriveStoryReleaseTargetContents(stories)?.map(({ id, storyKey, target }) => ({ id, storyKey, target }))
    || null;
}

function parseStories(rows: StoryCandidateRow[]) {
  const stories: StorySource[] = [];
  for (const row of rows) {
    const story = parseStorySource(row.summary);
    if (!story) return null;
    stories.push(story);
  }
  return stories;
}

function storyLaneOutput(rows: StoryCandidateRow[], stories: StorySource[]) {
  return rows.map((row, index) => ({
    id: row.id,
    story: { ...stories[index], insights: [] },
  }));
}

function finalStoryOutput(rows: StoryCandidateRow[], stories: StorySource[]) {
  return rows.map((row, index) => ({ id: row.id, story: stories[index] }));
}

function insightLaneOutput(rows: StoryCandidateRow[], stories: StorySource[]) {
  const insightCount = stories.reduce((total, story) => total + story.insights.length, 0);
  return insightCount === 0 ? [] : finalStoryOutput(rows, stories);
}

async function reusableLessonOutput(stories: StorySource[]) {
  return Promise.all(stories.flatMap((story) => story.insights.map(async (insight) => ({
    storyKey: story.key, insightId: insight.id,
    insightAuthorityDigest: await storyPreparationDigest(insightAuthorityValue(story.key, insight)),
    ...(insight.title === undefined ? {} : { title: insight.title }),
    background: insight.background, directlyAcquiredExperience: insight.directlyAcquiredExperience,
    principle: insight.principle,
  }))));
}

function parseReceipt(value: unknown): StoryPreparationReceipt | null {
  if (!isObject(value) || !onlyKeys(value, [
    "lane", "status", "inputDigest", "scopeDigest", "scopeCount", "outputDigest", "outputCount",
  ])) return null;
  if (!STORY_PREPARATION_LANES.includes(value.lane as StoryPreparationLane)
    || value.status !== "complete"
    || typeof value.inputDigest !== "string" || !digestPattern.test(value.inputDigest)
    || typeof value.scopeDigest !== "string" || !digestPattern.test(value.scopeDigest)
    || !exactNonNegativeInteger(value.scopeCount)
    || typeof value.outputDigest !== "string" || !digestPattern.test(value.outputDigest)
    || !exactNonNegativeInteger(value.outputCount)) return null;
  return value as StoryPreparationReceipt;
}

export async function normalizeStoryPrivacyOutput(
  value: unknown,
  targetCatalog: StoryReleaseTargetContent[],
): Promise<StoryPreparationPrivacyOutput | null> {
  if (!isObject(value) || !onlyKeys(value, ["candidates", "targetProposals"])
    || !Array.isArray(value.candidates) || !Array.isArray(value.targetProposals)) return null;
  const validTargets = new Map(targetCatalog.map((target) => [target.id, target.content]));
  const targetOrder = new Map(targetCatalog.map((target, index) => [target.id, index]));
  const targetDigests = new Map(await Promise.all(targetCatalog.map(async (target) => (
    [target.id, await storyPreparationDigest(target.content)] as const
  ))));
  const candidates: StoryPreparationPrivacyCandidate[] = [];
  const seenCandidateIds = new Set<string>();
  const flaggedTargets = new Set<StoryReleaseTarget>();
  for (const candidate of value.candidates) {
    if (!isObject(candidate) || !onlyKeys(candidate, [
      "id", "reviewState", "title", "whyFlagged", "uncertaintyReason", "releaseTargets",
    ]) || !stableId(candidate.id) || candidate.id.length > 1_000 || seenCandidateIds.has(candidate.id)
      || (candidate.reviewState !== "deterministic" && candidate.reviewState !== "needs_confirmation")
      || !safeText(candidate.title) || candidate.title.length > 500
      || !safeText(candidate.whyFlagged) || candidate.whyFlagged.length > 4_000
      || (candidate.reviewState === "deterministic" && candidate.uncertaintyReason !== null)
      || (candidate.reviewState === "needs_confirmation" && (!safeText(candidate.uncertaintyReason)
        || candidate.uncertaintyReason.length > 4_000))
      || !Array.isArray(candidate.releaseTargets) || candidate.releaseTargets.length === 0
      || candidate.releaseTargets.length > 2_000
      || candidate.releaseTargets.some((target) => typeof target !== "string"
        || !validTargets.has(target as StoryReleaseTarget))
      || new Set(candidate.releaseTargets).size !== candidate.releaseTargets.length) return null;
    const releaseTargets = (candidate.releaseTargets as StoryReleaseTarget[])
      .slice().sort((left, right) => Number(targetOrder.get(left)) - Number(targetOrder.get(right)));
    releaseTargets.forEach((target) => flaggedTargets.add(target));
    seenCandidateIds.add(candidate.id);
    candidates.push({
      id: candidate.id,
      reviewState: candidate.reviewState,
      title: candidate.title,
      whyFlagged: candidate.whyFlagged,
      uncertaintyReason: candidate.uncertaintyReason as string | null,
      releaseTargets,
    });
  }
  candidates.sort((left, right) => compareUtf8(left.id, right.id));
  const seenTargets = new Set<StoryReleaseTarget>();
  const proposals: StoryPreparationPrivacyTargetProposal[] = [];
  for (const proposal of value.targetProposals) {
    if (!isObject(proposal) || !onlyKeys(proposal, [
      "targetId", "targetContentDigest", "proposedText", "occurrences",
    ]) || typeof proposal.targetId !== "string"
      || !validTargets.has(proposal.targetId as StoryReleaseTarget)
      || seenTargets.has(proposal.targetId as StoryReleaseTarget)
      || proposal.targetContentDigest !== targetDigests.get(proposal.targetId as StoryReleaseTarget)
      || !scalarText(proposal.proposedText) || proposal.proposedText.length > 1_000_000
      || !Array.isArray(proposal.occurrences) || proposal.occurrences.length > 4_000) return null;
    const occurrences: StoryPreparationPrivacyTargetProposal["occurrences"] = [];
    for (const occurrence of proposal.occurrences) {
      if (!isObject(occurrence) || !onlyKeys(occurrence, [
        "originalStartOffset", "originalEndOffset", "proposalStartOffset", "proposalEndOffset",
        "category",
      ]) || !Number.isSafeInteger(occurrence.originalStartOffset)
        || Number(occurrence.originalStartOffset) < 0
        || !Number.isSafeInteger(occurrence.originalEndOffset)
        || Number(occurrence.originalEndOffset) <= Number(occurrence.originalStartOffset)
        || !Number.isSafeInteger(occurrence.proposalStartOffset)
        || Number(occurrence.proposalStartOffset) < 0
        || !Number.isSafeInteger(occurrence.proposalEndOffset)
        || Number(occurrence.proposalEndOffset) <= Number(occurrence.proposalStartOffset)
        || typeof occurrence.category !== "string"
        || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(occurrence.category)) return null;
      occurrences.push({
        originalStartOffset: Number(occurrence.originalStartOffset),
        originalEndOffset: Number(occurrence.originalEndOffset),
        proposalStartOffset: Number(occurrence.proposalStartOffset),
        proposalEndOffset: Number(occurrence.proposalEndOffset),
        category: occurrence.category,
      });
    }
    occurrences.sort((left, right) => left.originalStartOffset - right.originalStartOffset
      || left.originalEndOffset - right.originalEndOffset
      || left.proposalStartOffset - right.proposalStartOffset
      || left.proposalEndOffset - right.proposalEndOffset
      || compareUtf8(left.category, right.category));
    const originalPoints = Array.from(validTargets.get(proposal.targetId as StoryReleaseTarget) || "");
    const proposalPoints = Array.from(proposal.proposedText);
    let originalCursor = 0;
    let proposalCursor = 0;
    for (const occurrence of occurrences) {
      if (occurrence.originalEndOffset > originalPoints.length
        || occurrence.proposalEndOffset > proposalPoints.length
        || occurrence.originalStartOffset < originalCursor
        || occurrence.proposalStartOffset < proposalCursor
        || originalPoints.slice(originalCursor, occurrence.originalStartOffset).join("")
          !== proposalPoints.slice(proposalCursor, occurrence.proposalStartOffset).join("")
        || originalPoints.slice(occurrence.originalStartOffset, occurrence.originalEndOffset).join("")
          === proposalPoints.slice(occurrence.proposalStartOffset, occurrence.proposalEndOffset).join("")) {
        return null;
      }
      originalCursor = occurrence.originalEndOffset;
      proposalCursor = occurrence.proposalEndOffset;
    }
    if (originalPoints.slice(originalCursor).join("") !== proposalPoints.slice(proposalCursor).join("")
      || (occurrences.length === 0
        && validTargets.get(proposal.targetId as StoryReleaseTarget) !== proposal.proposedText)) return null;
    const targetId = proposal.targetId as StoryReleaseTarget;
    seenTargets.add(targetId);
    proposals.push({
      targetId,
      targetContentDigest: proposal.targetContentDigest as string,
      proposedText: proposal.proposedText,
      occurrences,
    });
  }
  if (seenTargets.size !== targetCatalog.length) return null;
  proposals.sort((left, right) => Number(targetOrder.get(left.targetId))
    - Number(targetOrder.get(right.targetId)));
  const changedTargets = new Set(proposals.filter((proposal) => proposal.occurrences.length > 0)
    .map((proposal) => proposal.targetId));
  if (changedTargets.size !== flaggedTargets.size
    || [...changedTargets].some((target) => !flaggedTargets.has(target))) return null;
  return { candidates, targetProposals: proposals };
}

const mismatch = (code: string): StoryPreparationValidation => ({ ok: false, code });

export async function validateStoryPreparationManifest(
  input: unknown,
  context: StoryPreparationContext,
): Promise<StoryPreparationValidation> {
  if (!isObject(input) || !onlyKeys(input, [
    "schema", "workflowRunId", "sourceRevision", "receipts", "storyPrivacy",
  ]) || input.schema !== STORY_PREPARATION_SCHEMA
    || input.workflowRunId !== context.workflowRunId
    || !validActivatedSourceRevision(context.sourceRevision)
    || !validActivatedSourceRevision(input.sourceRevision)
    || input.sourceRevision !== context.sourceRevision
    || !Array.isArray(input.receipts) || input.receipts.length !== STORY_PREPARATION_LANES.length) {
    return mismatch("STORY_PREPARATION_MANIFEST_INVALID");
  }
  const receipts = input.receipts.map(parseReceipt);
  if (receipts.some((receipt) => !receipt)) return mismatch("STORY_PREPARATION_RECEIPT_INVALID");
  const receiptMap = new Map(receipts.map((receipt) => [receipt!.lane, receipt!]));
  if (receiptMap.size !== STORY_PREPARATION_LANES.length
    || STORY_PREPARATION_LANES.some((lane) => !receiptMap.has(lane))) {
    return mismatch("STORY_PREPARATION_RECEIPT_SET_INVALID");
  }
  if (!digestPattern.test(context.semanticManifestDigest)) {
    return mismatch("STORY_PREPARATION_SEMANTIC_AUTHORITY_INVALID");
  }
  const semanticUnitIds = sortedUniqueIds(context.semanticUnitIds);
  const stories = parseStories(context.storyCandidates);
  if (!semanticUnitIds || !stories || stories.length === 0) {
    return mismatch("STORY_PREPARATION_STORY_INVALID");
  }
  const storyKeys = sortedUniqueIds(stories.map((story) => story.key));
  if (!storyKeys) return mismatch("STORY_PREPARATION_SCOPE_INVALID");
  const lessonOutput = await reusableLessonOutput(stories);
  const insightScope = lessonOutput.map(({ storyKey, insightId, insightAuthorityDigest }) => ({
    storyKey, insightId, insightAuthorityDigest,
  })).sort((left, right) => (
    compareUtf8(left.storyKey, right.storyKey) || compareUtf8(left.insightId, right.insightId)
  ));
  const targetContents = deriveStoryReleaseTargetContents(stories);
  if (!targetContents) return mismatch("STORY_PREPARATION_TARGET_CATALOG_INVALID");
  const targetCatalog = targetContents.map(({ id, storyKey, target }) => ({ id, storyKey, target }));
  const privacy = await normalizeStoryPrivacyOutput(
    input.storyPrivacy,
    targetContents,
  );
  if (!privacy) return mismatch("STORY_PREPARATION_PRIVACY_INVALID");
  if (!context.preference
    || context.preference.workflowRunId !== context.workflowRunId
    || !validActivatedSourceRevision(context.preference.sourceRevision)
    || context.preference.sourceRevision !== context.sourceRevision
    || !digestPattern.test(context.preference.inputDigest)
    || !digestPattern.test(context.preference.outputDigest)
    || !exactNonNegativeInteger(context.preference.outputCount)
    || context.preference.outputCount > MAX_PREFERENCE_QUESTIONS
    || canonicalAuthorityJson(context.preference.insightScope) !== canonicalAuthorityJson(insightScope)) {
    return mismatch("STORY_PREPARATION_PREFERENCE_AUTHORITY_INVALID");
  }

  const storyOutput = storyLaneOutput(context.storyCandidates, stories);
  const completeStoryOutput = finalStoryOutput(context.storyCandidates, stories);
  const insightOutput = insightLaneOutput(context.storyCandidates, stories);
  const insightCount = stories.reduce((total, story) => total + story.insights.length, 0);
  const expected: Record<StoryPreparationLane, StoryPreparationReceipt> = {
    story: {
      lane: "story",
      status: "complete",
      inputDigest: context.semanticManifestDigest,
      scopeDigest: await storyPreparationDigest(semanticUnitIds),
      scopeCount: semanticUnitIds.length,
      outputDigest: await storyPreparationDigest(storyOutput),
      outputCount: stories.length,
    },
    insight: {
      lane: "insight",
      status: "complete",
      inputDigest: await storyPreparationDigest(storyOutput),
      scopeDigest: await storyPreparationDigest(storyKeys),
      scopeCount: storyKeys.length,
      outputDigest: await storyPreparationDigest(insightOutput),
      outputCount: insightCount,
    },
    story_privacy: {
      lane: "story_privacy",
      status: "complete",
      inputDigest: await storyPreparationDigest(completeStoryOutput),
      scopeDigest: await storyPreparationDigest(targetCatalog.map((target) => target.id)),
      scopeCount: targetCatalog.length,
      outputDigest: await storyPreparationDigest(privacy),
      outputCount: privacy.targetProposals.length,
    },
    preference: {
      lane: "preference",
      status: "complete",
      inputDigest: await storyPreparationDigest(lessonOutput),
      scopeDigest: await storyPreparationDigest(insightScope),
      scopeCount: insightScope.length,
      outputDigest: context.preference.outputDigest,
      outputCount: context.preference.outputCount,
    },
  };

  if (context.preference.inputDigest !== expected.preference.inputDigest) {
    return mismatch("STORY_PREPARATION_PREFERENCE_INPUT_STALE");
  }
  for (const lane of STORY_PREPARATION_LANES) {
    const actual = receiptMap.get(lane)!;
    if (canonicalAuthorityJson(actual) !== canonicalAuthorityJson(expected[lane])) {
      return mismatch(`STORY_PREPARATION_${lane.toUpperCase()}_RECEIPT_STALE`);
    }
    if (actual.outputCount === 0 && actual.outputDigest !== STORY_PREPARATION_EMPTY_ARRAY_DIGEST) {
      return mismatch(`STORY_PREPARATION_${lane.toUpperCase()}_ZERO_INVALID`);
    }
  }
  return {
    ok: true,
    authority: {
      receipts: STORY_PREPARATION_LANES.map((lane) => expected[lane]),
      privacy,
      preference: context.preference,
    },
  };
}
