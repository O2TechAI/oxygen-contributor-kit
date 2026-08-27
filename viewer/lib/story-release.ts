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
  type StorySource,
} from "./timeline.ts";
import { isReservedStoryOrganizationReason } from "./story-readiness.ts";

export const REVIEWED_STORY_SCHEMA = "oxygen.reviewed-story" as const;

type ReleasePerson = {
  releaseLabel: string;
  role: string;
  description: string;
};

export type ReleaseInsight = {
  id: string;
  title?: string;
  background: string;
  quote: string;
  directlyAcquiredExperience: string;
  principle: string;
};

type ReleaseLocale = {
  title: string;
  overview: string;
  people: ReleasePerson[];
  story: {
    blocks: string[];
    uncertainty?: string;
  };
  insights: ReleaseInsight[];
};

export type ReviewedReleaseChapter = {
  key: string;
  phase: { id: string; label: string };
  kind?: string;
  revision: number;
  en: ReleaseLocale;
};

export type ReviewedStoryRelease = {
  schema: typeof REVIEWED_STORY_SCHEMA;
  publication_approved: false;
  chapters: ReviewedReleaseChapter[];
};

export type ReleasePrivacy = {
  redact: (copy: string) => string;
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

type PrivacyPreparedStoryBlock = {
  id: string;
  copy: string;
  redacted: boolean;
};

function privacyPreparedStoryBlocks(
  source: StorySource,
  state: ChapterReviewState,
  privacy: ReleasePrivacy,
) {
  return source.story.blocks.map<PrivacyPreparedStoryBlock>((block) => {
    const reviewed = applyStoryReviewToBlock(block.text, block.id, "en", state);
    const safe = privacy.redact(reviewed);
    return { id: block.id, copy: safe, redacted: safe !== reviewed };
  });
}

function insightProjection(
  id: string,
  content: {
    title?: string;
    background: string;
    quote: { storyBlockIds: string[] };
    directlyAcquiredExperience: string;
    principle: string;
  },
  blocks: Map<string, PrivacyPreparedStoryBlock>,
  privacy: ReleasePrivacy,
): ReleaseInsight | null {
  const anchors = content.quote.storyBlockIds.map((blockId) => blocks.get(blockId));
  if (!anchors.length || anchors.some((block) => !block || block.redacted)) return null;
  return insightProduct(id, content, anchors.map((block) => block!.copy).join("\n\n"), privacy);
}

function insightProduct(
  id: string,
  content: Omit<HumanInsightContent, "quote" | "evidence">,
  quote: string,
  privacy: ReleasePrivacy,
): ReleaseInsight {
  return {
    id,
    ...(content.title === undefined ? {} : { title: privacy.redact(content.title) }),
    background: privacy.redact(content.background),
    quote,
    directlyAcquiredExperience: privacy.redact(content.directlyAcquiredExperience),
    principle: privacy.redact(content.principle),
  };
}

function humanInsightProjection(
  id: string,
  content: HumanInsightContent,
  state: ChapterReviewState,
  source: StorySource,
  privacy: ReleasePrivacy,
): ReleaseInsight | null {
  const quote = humanQuoteText(state, source, content);
  if (quote === null) return null;
  const privacyPreparedQuote = privacy.redact(quote);
  if (privacyPreparedQuote !== quote) return null;
  return insightProduct(id, content, quote, privacy);
}

/** Build the only Story representation eligible for release. Anchors,
 * Evidence, local Privacy state, and review provenance never enter it. */
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

    const preparedBlocks = privacyPreparedStoryBlocks(source, state, privacy);
    const blocksById = new Map(preparedBlocks.map((block) => [block.id, block]));
    const insights: ReleaseInsight[] = [];
    for (const sourceInsight of source.insights) {
      const review = state.sourceInsightReviews[sourceInsight.id];
      if (review.decision === "rejected") continue;
      if (review.decision !== "accepted" || review.resolution !== "applied"
        || review.appliedVersion !== review.version) return [];
      const projected = insightProjection(
        sourceInsight.id,
        review.editedContent || sourceInsight,
        blocksById,
        privacy,
      );
      if (projected) insights.push(projected);
    }
    for (const [insightId, review] of Object.entries(state.humanInsights)) {
      if (review.decision !== "human_approved" || review.resolution !== "applied"
        || review.appliedVersion !== review.version) return [];
      const projected = humanInsightProjection(
        insightId,
        review.content,
        state,
        source,
        privacy,
      );
      if (projected) insights.push(projected);
    }
    insights.sort((left, right) => left.id.localeCompare(right.id));

    return [{
      key: source.key,
      phase: { id: source.phase.id, label: privacy.redact(source.phase.label) },
      ...(source.kind === undefined ? {} : { kind: source.kind }),
      revision: state.revision,
      en: {
        title: privacy.redact(source.title),
        overview: privacy.redact(source.overview),
        people: source.people.map((person) => ({
          releaseLabel: privacy.redact(person.releaseLabel),
          role: privacy.redact(person.role),
          description: privacy.redact(person.description),
        })),
        story: {
          blocks: preparedBlocks.filter((block) => !block.redacted).map((block) => block.copy),
          ...(source.story.uncertainty === undefined
            ? {} : { uncertainty: privacy.redact(source.story.uncertainty) }),
        },
        insights,
      },
    }];
  });
  return {
    schema: REVIEWED_STORY_SCHEMA,
    publication_approved: false,
    chapters,
  };
}

const requiredString = (value: unknown, maximum = 20_000) => typeof value === "string"
  && value.length > 0
  && value.length <= maximum;
const boundedString = (value: unknown, maximum = 20_000) => typeof value === "string"
  && value.length <= maximum;
const stringArray = (value: unknown) => Array.isArray(value)
  && value.length <= 200
  && value.every((item) => requiredString(item));

function sanitizeLocale(value: unknown): ReleaseLocale | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<ReleaseLocale>;
  if (!requiredString(input.title, 500) || !requiredString(input.overview)) return null;
  if (!Array.isArray(input.people) || input.people.length > 100 || !input.people.every((person) => (
    requiredString(person?.releaseLabel, 100) && requiredString(person?.role, 500)
    && requiredString(person?.description)
  ))) return null;
  if (!input.story || !stringArray(input.story.blocks)
    || (input.story.uncertainty !== undefined && !requiredString(input.story.uncertainty, 4_000))) return null;
  if (!Array.isArray(input.insights) || input.insights.length > 500) return null;
  const insightIds = new Set<string>();
  const insights: ReleaseInsight[] = [];
  for (const insight of input.insights) {
    if (!requiredString(insight?.id, 1_000) || insightIds.has(insight.id)
      || (insight.title !== undefined && !boundedString(insight.title, 500))
      || !requiredString(insight.background, 4_000) || !requiredString(insight.quote, 1_000_000)
      || !requiredString(insight.directlyAcquiredExperience, 4_000)
      || !requiredString(insight.principle, 4_000)) return null;
    insightIds.add(insight.id);
    insights.push({
      id: insight.id,
      ...(insight.title === undefined ? {} : { title: insight.title }),
      background: insight.background,
      quote: insight.quote,
      directlyAcquiredExperience: insight.directlyAcquiredExperience,
      principle: insight.principle,
    });
  }
  insights.sort((left, right) => left.id.localeCompare(right.id));
  return {
    title: input.title!,
    overview: input.overview!,
    people: input.people.map((person) => ({
      releaseLabel: person.releaseLabel,
      role: person.role,
      description: person.description,
    })),
    story: {
      blocks: [...input.story.blocks],
      ...(input.story.uncertainty === undefined ? {} : { uncertainty: input.story.uncertainty }),
    },
    insights,
  };
}

/** Recreate the public Story from an explicit allowlist. Local source IDs,
 * Evidence, anchors, Privacy ledgers, originals, and CAS metadata are rejected. */
export function sanitizeReviewedStoryRelease(value: unknown): ReviewedStoryRelease | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<ReviewedStoryRelease>;
  if (input.schema !== REVIEWED_STORY_SCHEMA || input.publication_approved !== false
    || !Array.isArray(input.chapters) || input.chapters.length > 500) return null;
  const seen = new Set<string>();
  const chapters: ReviewedReleaseChapter[] = [];
  for (const chapter of input.chapters) {
    if (!requiredString(chapter?.key, 1_000) || seen.has(chapter.key)
      || !chapter.phase || !requiredString(chapter.phase.id, 1_000)
      || !requiredString(chapter.phase.label, 500)
      || (chapter.kind !== undefined && !requiredString(chapter.kind, 100))
      || !Number.isInteger(chapter.revision) || chapter.revision < 2) return null;
    const en = sanitizeLocale(chapter.en);
    if (!en) return null;
    seen.add(chapter.key);
    chapters.push({
      key: chapter.key,
      phase: { id: chapter.phase.id, label: chapter.phase.label },
      ...(chapter.kind === undefined ? {} : { kind: chapter.kind }),
      revision: chapter.revision,
      en,
    });
  }
  return {
    schema: REVIEWED_STORY_SCHEMA,
    publication_approved: false,
    chapters,
  };
}

/** Produce the exact allowlisted Story entry used by the ZIP builder. */
export function reviewedStoryPackageEntry(value: unknown) {
  const story = sanitizeReviewedStoryRelease(value);
  return story?.chapters.length ? {
    name: "story/reviewed-project-story.json",
    data: serializeReviewedStoryRelease(story)!,
  } : null;
}

/** One deterministic public Story serialization shared by HTML and ZIP POST. */
export function serializeReviewedStoryRelease(value: unknown) {
  const story = sanitizeReviewedStoryRelease(value);
  return story ? JSON.stringify(story, null, 2) : null;
}

/** Strip local Story source JSON before organization summaries enter a package. */
export function releaseOrganizationReason(value: unknown) {
  const source = String(value ?? "");
  if (!source.startsWith(STORY_PREFIX)) return isReservedStoryOrganizationReason(source)
    ? "Reviewed project Story" : source;
  const story = parseStorySource(source);
  return story?.overview || story?.title || "Reviewed project Story";
}
