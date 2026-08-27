import type { ChapterReviewState, HumanInsightContent } from "./story-review.ts";
import {
  applyStoryReviewToBlock,
  humanQuoteText,
  storyBlocks,
  validateChapterReviewCompletion,
} from "./story-review.ts";
import {
  STORY_PREFIX,
  parseStorySource,
  type StoryReleaseTarget,
  type StoryReleaseTargetName,
  type StorySource,
} from "./timeline.ts";
import { isReservedStoryOrganizationReason } from "./story-readiness.ts";

export const REVIEWED_STORY_SCHEMA = "oxygen.reviewed-story" as const;
const FIXED_REDACTION = "[Redacted]";

type ReleasePerson = { releaseLabel: string; role: string; description: string };

export type ReleaseInsight = {
  title?: string;
  background: string;
  quote: string;
  directlyAcquiredExperience: string;
  principle: string;
};

export type ReleaseStoryBlock = { text: string; insights: ReleaseInsight[] };

type ReleaseLocale = {
  title: string;
  overview: string;
  transition?: { before: string; after: string };
  people: ReleasePerson[];
  story: { blocks: ReleaseStoryBlock[]; uncertainty?: string };
};

export type ReviewedReleaseChapter = { phase: string; kind?: string; en: ReleaseLocale };

export type ReviewedStoryRelease = {
  schema: typeof REVIEWED_STORY_SCHEMA;
  publication_approved: false;
  chapters: ReviewedReleaseChapter[];
};

export type ReleasePrivacy = {
  redact: (copy: string) => string;
  suppressedTargets?: ReadonlySet<StoryReleaseTarget>;
};

const noReleaseRedaction: ReleasePrivacy = { redact: (copy) => copy };

function reviewContext(source: StorySource, state: ChapterReviewState) {
  const sourceCollection = storyBlocks(source);
  return {
    source,
    privacyCandidates: [],
    privacyDecisions: {},
    targetCatalog: new Map(),
    evidenceResolved: true,
    supportedAddIds: [],
    supportedEditIds: [],
    sourceBlocks: sourceCollection,
    reviewedBlocks: {
      en: Object.fromEntries(source.story.blocks.map((block) => [
        block.id,
        applyStoryReviewToBlock(block.text, block.id, "en", state),
      ])),
      zh: {},
    },
  };
}

function targetId(storyKey: string, target: StoryReleaseTargetName) {
  return `${storyKey}::${target}` as StoryReleaseTarget;
}

function targetSuppressed(privacy: ReleasePrivacy, storyKey: string, target: StoryReleaseTargetName) {
  return privacy.suppressedTargets?.has(targetId(storyKey, target)) ?? false;
}

function requiredCopy(
  privacy: ReleasePrivacy,
  storyKey: string,
  target: StoryReleaseTargetName,
  copy: string,
) {
  if (targetSuppressed(privacy, storyKey, target)) return FIXED_REDACTION;
  return privacy.redact(copy) === copy ? copy : FIXED_REDACTION;
}

function optionalCopy(
  privacy: ReleasePrivacy,
  storyKey: string,
  target: StoryReleaseTargetName,
  copy: string,
) {
  if (targetSuppressed(privacy, storyKey, target)) return null;
  return privacy.redact(copy) === copy ? copy : null;
}

function insightProduct(
  storyKey: string,
  insightId: string,
  content: Omit<HumanInsightContent, "quote" | "evidence">,
  quote: string,
  privacy: ReleasePrivacy,
): ReleaseInsight | null {
  const required: Array<[StoryReleaseTargetName, string]> = [
    [`insight:${insightId}:background`, content.background],
    [`insight:${insightId}:directlyAcquiredExperience`, content.directlyAcquiredExperience],
    [`insight:${insightId}:principle`, content.principle],
  ];
  if (required.some(([target, copy]) => (
    targetSuppressed(privacy, storyKey, target) || privacy.redact(copy) !== copy
  )) || privacy.redact(quote) !== quote) return null;
  const title = content.title === undefined
    ? null
    : optionalCopy(privacy, storyKey, `insight:${insightId}:title`, content.title);
  return {
    ...(title === null ? {} : { title }),
    background: content.background,
    quote,
    directlyAcquiredExperience: content.directlyAcquiredExperience,
    principle: content.principle,
  };
}

/** Build the only reviewed Story product. Privacy is applied once from exact
 * target IDs, then internal IDs, anchors, Evidence and revision ledgers are
 * removed. Each Insight is nested under its exact first safe paragraph. */
export function buildReviewedStoryRelease(
  sources: StorySource[],
  reviews: Record<string, ChapterReviewState>,
  privacy: ReleasePrivacy = noReleaseRedaction,
): ReviewedStoryRelease {
  const seen = new Set<string>();
  const chapters = sources.flatMap((source) => {
    const state = reviews[source.key];
    if (seen.has(source.key) || !state || state.stage !== "human_confirmed") return [];
    seen.add(source.key);
    if (!validateChapterReviewCompletion(state, reviewContext(source, state))) return [];

    const releaseBlocks: ReleaseStoryBlock[] = [];
    const releaseBlockIndex = new Map<string, number>();
    for (const block of source.story.blocks) {
      const reviewed = applyStoryReviewToBlock(block.text, block.id, "en", state);
      if (targetSuppressed(privacy, source.key, `story:${block.id}`)
        || privacy.redact(reviewed) !== reviewed) continue;
      releaseBlockIndex.set(block.id, releaseBlocks.length);
      releaseBlocks.push({ text: reviewed, insights: [] });
    }

    for (const sourceInsight of source.insights) {
      const review = state.sourceInsightReviews[sourceInsight.id];
      if (review?.decision === "rejected") continue;
      if (!review || review.decision !== "accepted" || review.resolution !== "applied"
        || review.appliedVersion !== review.version) return [];
      const content = review.editedContent || sourceInsight;
      const anchors = content.quote.storyBlockIds.map((blockId) => releaseBlockIndex.get(blockId));
      if (!anchors.length || anchors.some((index) => index === undefined)) continue;
      const quote = content.quote.storyBlockIds
        .map((blockId) => releaseBlocks[releaseBlockIndex.get(blockId)!].text).join("\n\n");
      const product = insightProduct(source.key, sourceInsight.id, content, quote, privacy);
      if (product) releaseBlocks[anchors[0]!].insights.push(product);
    }

    for (const [insightId, review] of Object.entries(state.humanInsights)
      .sort(([left], [right]) => left.localeCompare(right))) {
      if (review.decision !== "human_approved" || review.resolution !== "applied"
        || review.appliedVersion !== review.version) return [];
      const anchorIndex = releaseBlockIndex.get(review.content.quote.storyBlockId);
      if (anchorIndex === undefined) continue;
      const quote = humanQuoteText(state, source, review.content);
      if (quote === null) continue;
      const product = insightProduct(source.key, insightId, review.content, quote, privacy);
      if (product) releaseBlocks[anchorIndex].insights.push(product);
    }

    const people = source.people.flatMap((person) => {
      const fields: Array<[StoryReleaseTargetName, string]> = [
        [`people:${person.id}:releaseLabel`, person.releaseLabel],
        [`people:${person.id}:role`, person.role],
        [`people:${person.id}:description`, person.description],
      ];
      if (fields.some(([target, copy]) => (
        targetSuppressed(privacy, source.key, target) || privacy.redact(copy) !== copy
      ))) return [];
      return [{
        releaseLabel: person.releaseLabel,
        role: person.role,
        description: person.description,
      }];
    });

    let transition: ReleaseLocale["transition"];
    if (source.transition) {
      const before = optionalCopy(privacy, source.key, "transition:before", source.transition.before);
      const after = optionalCopy(privacy, source.key, "transition:after", source.transition.after);
      if (before !== null && after !== null) transition = { before, after };
    }
    const uncertainty = source.story.uncertainty === undefined
      ? null
      : optionalCopy(privacy, source.key, "uncertainty", source.story.uncertainty);

    return [{
      phase: requiredCopy(privacy, source.key, "phase", source.phase.label),
      ...(source.kind === undefined ? {} : { kind: source.kind }),
      en: {
        title: requiredCopy(privacy, source.key, "title", source.title),
        overview: requiredCopy(privacy, source.key, "overview", source.overview),
        ...(transition ? { transition } : {}),
        people,
        story: {
          blocks: releaseBlocks,
          ...(uncertainty === null ? {} : { uncertainty }),
        },
      },
    }];
  });
  return { schema: REVIEWED_STORY_SCHEMA, publication_approved: false, chapters };
}

const requiredString = (value: unknown, maximum = 20_000) => typeof value === "string"
  && value.length > 0 && value.length <= maximum;
const boundedString = (value: unknown, maximum = 20_000) => typeof value === "string"
  && value.length <= maximum;

function sanitizeInsight(value: unknown): ReleaseInsight | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<ReleaseInsight>;
  if ((input.title !== undefined && !boundedString(input.title, 500))
    || !requiredString(input.background, 4_000) || !requiredString(input.quote, 1_000_000)
    || !requiredString(input.directlyAcquiredExperience, 4_000)
    || !requiredString(input.principle, 4_000)) return null;
  return {
    ...(input.title === undefined ? {} : { title: input.title }),
    background: input.background!,
    quote: input.quote!,
    directlyAcquiredExperience: input.directlyAcquiredExperience!,
    principle: input.principle!,
  };
}

function sanitizeLocale(value: unknown): ReleaseLocale | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<ReleaseLocale>;
  if (!requiredString(input.title, 500) || !requiredString(input.overview)) return null;
  if (input.transition !== undefined && (!requiredString(input.transition?.before, 4_000)
    || !requiredString(input.transition?.after, 4_000))) return null;
  if (!Array.isArray(input.people) || input.people.length > 100 || !input.people.every((person) => (
    requiredString(person?.releaseLabel, 100) && requiredString(person?.role, 500)
    && requiredString(person?.description)
  ))) return null;
  if (!input.story || !Array.isArray(input.story.blocks) || input.story.blocks.length > 200
    || (input.story.uncertainty !== undefined && !requiredString(input.story.uncertainty, 4_000))) return null;
  const blocks: ReleaseStoryBlock[] = [];
  for (const block of input.story.blocks) {
    if (!block || !requiredString(block.text) || !Array.isArray(block.insights)
      || block.insights.length > 500) return null;
    const insights = block.insights.map(sanitizeInsight);
    if (insights.some((insight) => !insight)) return null;
    blocks.push({ text: block.text, insights: insights as ReleaseInsight[] });
  }
  return {
    title: input.title!,
    overview: input.overview!,
    ...(input.transition === undefined ? {} : {
      transition: { before: input.transition.before, after: input.transition.after },
    }),
    people: input.people.map((person) => ({
      releaseLabel: person.releaseLabel,
      role: person.role,
      description: person.description,
    })),
    story: {
      blocks,
      ...(input.story.uncertainty === undefined ? {} : { uncertainty: input.story.uncertainty }),
    },
  };
}

export function sanitizeReviewedStoryRelease(value: unknown): ReviewedStoryRelease | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<ReviewedStoryRelease>;
  if (input.schema !== REVIEWED_STORY_SCHEMA || input.publication_approved !== false
    || !Array.isArray(input.chapters) || input.chapters.length > 500) return null;
  const chapters: ReviewedReleaseChapter[] = [];
  for (const chapter of input.chapters) {
    if (!requiredString(chapter?.phase, 500)
      || (chapter.kind !== undefined && !requiredString(chapter.kind, 100))) return null;
    const en = sanitizeLocale(chapter.en);
    if (!en) return null;
    chapters.push({
      phase: chapter.phase,
      ...(chapter.kind === undefined ? {} : { kind: chapter.kind }),
      en,
    });
  }
  return { schema: REVIEWED_STORY_SCHEMA, publication_approved: false, chapters };
}

export function reviewedStoryPackageEntry(value: unknown) {
  const story = sanitizeReviewedStoryRelease(value);
  return story?.chapters.length ? {
    name: "story/reviewed-project-story.json",
    data: serializeReviewedStoryRelease(story)!,
  } : null;
}

export function serializeReviewedStoryRelease(value: unknown) {
  const story = sanitizeReviewedStoryRelease(value);
  return story ? JSON.stringify(story, null, 2) : null;
}

export function releaseOrganizationReason(value: unknown) {
  const source = String(value ?? "");
  if (!source.startsWith(STORY_PREFIX)) return isReservedStoryOrganizationReason(source)
    ? "Reviewed project Story" : source;
  const story = parseStorySource(source);
  return story?.overview || story?.title || "Reviewed project Story";
}
