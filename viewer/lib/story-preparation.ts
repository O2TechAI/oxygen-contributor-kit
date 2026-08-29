import { canonicalAuthorityJson, type StoryCandidateRow } from "./story-readiness.ts";
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

export type StoryPreparationManifest = {
  schema: typeof STORY_PREPARATION_SCHEMA;
  workflowRunId: string;
  sourceRevision: number;
  receipts: StoryPreparationReceipt[];
  storyPrivacyCandidates: StoryPreparationPrivacyCandidate[];
};

export type PreferenceBatchAuthority = {
  workflowRunId: string;
  sourceRevision: number;
  inputDigest: string;
  outputDigest: string;
  outputCount: number;
};

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
  privacyCandidates: StoryPreparationManifest["storyPrivacyCandidates"];
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
const safeText = (value: unknown): value is string => (
  nonEmptyString(value) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
);
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

function storyTargetNames(story: StorySource): StoryReleaseTargetName[] {
  const targets: StoryReleaseTargetName[] = ["phase", "title", "overview"];
  if (story.transition) targets.push("transition:before", "transition:after");
  for (const person of story.people) {
    targets.push(
      `people:${person.id}:releaseLabel`,
      `people:${person.id}:role`,
      `people:${person.id}:description`,
    );
  }
  for (const block of story.story.blocks) targets.push(`story:${block.id}`);
  if (story.story.uncertainty !== undefined) targets.push("uncertainty");
  for (const insight of story.insights) {
    if (insight.title !== undefined) targets.push(`insight:${insight.id}:title`);
    targets.push(
      `insight:${insight.id}:background`,
      `insight:${insight.id}:quote`,
      `insight:${insight.id}:directlyAcquiredExperience`,
      `insight:${insight.id}:principle`,
    );
  }
  return targets;
}

export function deriveStoryReleaseTargetCatalog(
  stories: StorySource[],
): StoryReleaseTargetDescriptor[] | null {
  const catalog: StoryReleaseTargetDescriptor[] = [];
  const ids = new Set<string>();
  for (const story of stories) {
    if (!stableId(story.key)) return null;
    for (const target of storyTargetNames(story)) {
      if (!stableId(target)) return null;
      const id = storyReleaseTargetId(story.key, target);
      if (ids.has(id)) return null;
      ids.add(id);
      catalog.push({ id, storyKey: story.key, target });
    }
  }
  return catalog;
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

function reusableLessonOutput(stories: StorySource[]) {
  return stories.flatMap((story) => story.insights.map((insight) => ({
    storyKey: story.key,
    insightId: insight.id,
    ...(insight.title === undefined ? {} : { title: insight.title }),
    background: insight.background,
    directlyAcquiredExperience: insight.directlyAcquiredExperience,
    principle: insight.principle,
  })));
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

function parsePrivacyCandidates(
  value: unknown,
  targetCatalog: StoryReleaseTargetDescriptor[],
): StoryPreparationManifest["storyPrivacyCandidates"] | null {
  if (!Array.isArray(value)) return null;
  const validTargets = new Set(targetCatalog.map((target) => target.id));
  const targetOrder = new Map(targetCatalog.map((target, index) => [target.id, index]));
  const seenCandidateIds = new Set<string>();
  const candidates: StoryPreparationPrivacyCandidate[] = [];
  for (const candidate of value) {
    if (!isObject(candidate) || !onlyKeys(candidate, [
      "id", "reviewState", "title", "whyFlagged", "uncertaintyReason", "releaseTargets",
    ]) || !stableId(candidate.id) || seenCandidateIds.has(candidate.id)
      || (candidate.reviewState !== "deterministic" && candidate.reviewState !== "needs_confirmation")
      || !safeText(candidate.title) || !safeText(candidate.whyFlagged)
      || (candidate.reviewState === "deterministic" && candidate.uncertaintyReason !== null)
      || (candidate.reviewState === "needs_confirmation" && !safeText(candidate.uncertaintyReason))
      || !Array.isArray(candidate.releaseTargets) || candidate.releaseTargets.length === 0
      || !candidate.releaseTargets.every((target) => (
        typeof target === "string" && validTargets.has(target as StoryReleaseTarget)
      )) || new Set(candidate.releaseTargets).size !== candidate.releaseTargets.length) return null;
    seenCandidateIds.add(candidate.id);
    candidates.push({
      id: candidate.id,
      reviewState: candidate.reviewState,
      title: candidate.title,
      whyFlagged: candidate.whyFlagged,
      uncertaintyReason: candidate.uncertaintyReason as string | null,
      releaseTargets: [...candidate.releaseTargets]
        .sort((left, right) => Number(targetOrder.get(left as StoryReleaseTarget))
          - Number(targetOrder.get(right as StoryReleaseTarget))) as StoryReleaseTarget[],
    });
  }
  candidates.sort((left, right) => compareUtf8(left.id, right.id));
  return candidates;
}

const mismatch = (code: string): StoryPreparationValidation => ({ ok: false, code });

export async function validateStoryPreparationManifest(
  input: unknown,
  context: StoryPreparationContext,
): Promise<StoryPreparationValidation> {
  if (!isObject(input) || !onlyKeys(input, [
    "schema", "workflowRunId", "sourceRevision", "receipts", "storyPrivacyCandidates",
  ]) || input.schema !== STORY_PREPARATION_SCHEMA
    || input.workflowRunId !== context.workflowRunId
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
  const insightIdentities = stories.flatMap((story) => story.insights.map((insight) => ({
    storyKey: story.key,
    insightId: insight.id,
  }))).sort((left, right) => (
    compareUtf8(left.storyKey, right.storyKey) || compareUtf8(left.insightId, right.insightId)
  ));
  const targetCatalog = deriveStoryReleaseTargetCatalog(stories);
  if (!targetCatalog) return mismatch("STORY_PREPARATION_TARGET_CATALOG_INVALID");
  const privacyCandidates = parsePrivacyCandidates(
    input.storyPrivacyCandidates,
    targetCatalog,
  );
  if (!privacyCandidates) return mismatch("STORY_PREPARATION_PRIVACY_CANDIDATES_INVALID");
  if (!context.preference
    || context.preference.workflowRunId !== context.workflowRunId
    || context.preference.sourceRevision !== context.sourceRevision
    || !digestPattern.test(context.preference.inputDigest)
    || !digestPattern.test(context.preference.outputDigest)
    || !exactNonNegativeInteger(context.preference.outputCount)) {
    return mismatch("STORY_PREPARATION_PREFERENCE_AUTHORITY_INVALID");
  }

  const storyOutput = storyLaneOutput(context.storyCandidates, stories);
  const completeStoryOutput = finalStoryOutput(context.storyCandidates, stories);
  const insightOutput = insightLaneOutput(context.storyCandidates, stories);
  const insightCount = stories.reduce((total, story) => total + story.insights.length, 0);
  const lessonOutput = reusableLessonOutput(stories);
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
      outputDigest: await storyPreparationDigest(privacyCandidates),
      outputCount: privacyCandidates.length,
    },
    preference: {
      lane: "preference",
      status: "complete",
      inputDigest: await storyPreparationDigest(lessonOutput),
      scopeDigest: await storyPreparationDigest(insightIdentities),
      scopeCount: insightIdentities.length,
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
      privacyCandidates,
      preference: context.preference,
    },
  };
}
