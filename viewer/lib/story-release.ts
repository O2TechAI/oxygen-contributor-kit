import type {
  ChapterReviewState,
  SuccessorChapterReviewState,
  SuccessorHumanInsightContent,
} from "./story-review.ts";
import {
  applyStoryReviewToBlock,
  successorHumanQuoteText,
  successorStoryBlocks,
  validateChapterReviewCompletion,
  validateSuccessorChapterReviewCompletion,
} from "./story-review.ts";
import {
  LEGACY_STORY_PREFIX,
  SUCCESSOR_STORY_PREFIX,
  STORY_PREFIX,
  storyReleaseTargetCatalog,
  type SuccessorStorySource,
  type StoryLanguage,
  type StoryReleaseTarget,
  type StoryReleaseTargetCatalog,
  type StoryReleaseTargetDescriptor,
  type TimelineMilestone,
} from "./timeline.ts";
import { isReservedStoryOrganizationReason } from "./story-readiness.ts";

type ReleasePerson = { releaseLabel: string; role: string; description: string };
type ReleaseInsight = { id: string; title: string; noticed: string; lesson: string };
type ReleaseLocale = {
  phase: string;
  title: string;
  overview: string;
  before: string;
  after: string;
  people: ReleasePerson[];
  story: {
    scene: string;
    reconstruction: string[];
    importantDetails: string[];
    decisionOutcome: string;
    uncertainty?: string;
  };
  insights: ReleaseInsight[];
};

function sourceBlocks(milestone: TimelineMilestone) {
  return (["en", "zh"] as const).reduce<Record<StoryLanguage, Record<string, string>>>((result, language) => {
    const presentation = milestone.story.reviewPresentation?.[language];
    if (!presentation) return result;
    result[language] = {
      scene: presentation.story.scene,
      ...Object.fromEntries(presentation.story.reconstruction.map((copy, index) => [`reconstruction-${index}`, copy])),
      ...Object.fromEntries(presentation.story.importantDetails.map((copy, index) => [`detail-${index}`, copy])),
      outcome: presentation.story.decisionOutcome,
      ...(presentation.story.uncertainty ? { uncertainty: presentation.story.uncertainty } : {}),
    };
    return result;
  }, { en: {}, zh: {} });
}

export type ReviewedReleaseChapter = {
  key: string;
  kind: string;
  revision: number;
  en: ReleaseLocale;
  /** Optional non-canonical localization. It is omitted whenever unavailable
   * or carrying unresolved cross-language review debt. */
  zh?: ReleaseLocale;
};

export type ReviewedStoryRelease = {
  schema_version: "oxygen.reviewed-story/1";
  publication_approved: false;
  chapters: ReviewedReleaseChapter[];
};

export const SUCCESSOR_REVIEWED_STORY_SCHEMA = "oxygen.reviewed-story/2" as const;

type SuccessorReleasePerson = {
  releaseLabel: string;
  role: string;
  description: string;
};

export type SuccessorReleaseInsight = {
  id: string;
  title?: string;
  background: string;
  quote: string;
  directlyAcquiredExperience: string;
  principle: string;
};

type SuccessorReleaseLocale = {
  title: string;
  overview: string;
  people: SuccessorReleasePerson[];
  story: {
    blocks: string[];
    uncertainty?: string;
  };
  insights: SuccessorReleaseInsight[];
};

export type SuccessorReviewedReleaseChapter = {
  key: string;
  phase: { id: string; label: string };
  kind?: string;
  revision: number;
  en: SuccessorReleaseLocale;
};

export type SuccessorReviewedStoryRelease = {
  schema_version: typeof SUCCESSOR_REVIEWED_STORY_SCHEMA;
  publication_approved: false;
  chapters: SuccessorReviewedReleaseChapter[];
};

export type SuccessorReleasePrivacy = {
  redact: (copy: string) => string;
};

type ScalarReleaseField = Extract<StoryReleaseTargetDescriptor, { kind: "scalar" }>["field"];
type ReleaseTargetSelection = {
  scalars: Set<ScalarReleaseField>;
  reconstruction: Set<number>;
  details: Set<number>;
  people: Set<string>;
  insights: Set<string>;
};

function releaseTargetSelection(
  catalog: StoryReleaseTargetCatalog,
  targets: string[],
): ReleaseTargetSelection | null {
  const selection: ReleaseTargetSelection = {
    scalars: new Set(),
    reconstruction: new Set(),
    details: new Set(),
    people: new Set(),
    insights: new Set(),
  };
  for (const target of targets) {
    const descriptor = catalog.get(target as StoryReleaseTarget);
    if (!descriptor) return null;
    if (descriptor.kind === "scalar") selection.scalars.add(descriptor.field);
    else if (descriptor.kind === "reconstruction") selection.reconstruction.add(descriptor.index);
    else if (descriptor.kind === "detail") selection.details.add(descriptor.index);
    else if (descriptor.kind === "person") selection.people.add(descriptor.id);
    else selection.insights.add(descriptor.id);
  }
  return selection;
}

const blockCopy = (
  source: string,
  blockId: string,
  redacted: boolean,
  language: StoryLanguage,
  state: ChapterReviewState,
) => redacted
  ? ""
  : applyStoryReviewToBlock(source, blockId, language, state);

function localeProjection(
  milestone: TimelineMilestone,
  state: ChapterReviewState,
  language: StoryLanguage,
  selection: ReleaseTargetSelection,
): ReleaseLocale | null {
  const presentation = milestone.story.reviewPresentation?.[language];
  if (!presentation || presentation.highlights.length !== 1) return null;
  const insightReviews = state.insightReviews;
  return {
    phase: blockCopy(presentation.phase, "phase", selection.scalars.has("phase"), language, state),
    title: blockCopy(presentation.title, "title", selection.scalars.has("title"), language, state),
    overview: blockCopy(presentation.overview, "overview", selection.scalars.has("overview"), language, state),
    before: blockCopy(presentation.before, "before", selection.scalars.has("before"), language, state),
    after: blockCopy(presentation.after, "after", selection.scalars.has("after"), language, state),
    people: presentation.people.filter((person) => !selection.people.has(person.id)).map((person) => ({
      releaseLabel: person.releaseLabel,
      role: person.role,
      description: person.description,
    })),
    story: {
      scene: blockCopy(presentation.story.scene, "scene", selection.scalars.has("scene"), language, state),
      reconstruction: presentation.story.reconstruction
        .map((copy, index) => blockCopy(copy, `reconstruction-${index}`, selection.reconstruction.has(index), language, state))
        .filter(Boolean),
      importantDetails: presentation.story.importantDetails
        .map((copy, index) => blockCopy(copy, `detail-${index}`, selection.details.has(index), language, state))
        .filter(Boolean),
      decisionOutcome: blockCopy(presentation.story.decisionOutcome, "outcome", selection.scalars.has("decisionOutcome"), language, state),
      ...(presentation.story.uncertainty
        ? { uncertainty: blockCopy(presentation.story.uncertainty, "uncertainty", selection.scalars.has("uncertainty"), language, state) }
        : {}),
    },
    insights: presentation.highlights.flatMap((highlight) => {
      const review = insightReviews[highlight.id];
      if (selection.insights.has(highlight.id)
        || (review?.status === "rejected" && review.resolution === "applied")) return [];
      const localized = review?.localized[language] || highlight;
      return [{ id: localized.id, title: localized.title, noticed: localized.noticed, lesson: localized.lesson }];
    }),
  };
}

/** Build the only Story representation eligible for download. It includes only
 * human-confirmed Chapter copy and intentionally omits annotations, instructions,
 * exact evidence, Privacy originals, local identities, and review metadata. */
export function buildReviewedStoryRelease(
  milestones: TimelineMilestone[],
  reviews: Record<string, ChapterReviewState>,
): ReviewedStoryRelease {
  const chapters = milestones.flatMap((milestone) => {
    const state = reviews[milestone.story.key];
    const enPresentation = milestone.story.reviewPresentation?.en;
    const sources = sourceBlocks(milestone);
    const targetCatalog = enPresentation ? storyReleaseTargetCatalog(enPresentation) : null;
    const selection = targetCatalog && state ? releaseTargetSelection(targetCatalog, state.redactedBlocks) : null;
    if (!state || state.stage !== "human_confirmed" || !enPresentation
      || !targetCatalog || !selection
      || !validateChapterReviewCompletion(state, {
        storyKey: milestone.story.key,
        privacyCandidates: enPresentation.privacy.candidates,
        privacyDecisions: state.appliedPrivacyDecisions,
        targetCatalog,
        reviewableInsightIds: enPresentation.highlights.map((highlight) => highlight.id),
        sourceBlocks: sources,
        reviewedBlocks: sources,
      })) return [];
    const en = localeProjection(milestone, state, "en", selection);
    if (!en) return [];
    const zh = state.staleTranslations.length > 0 ? null : localeProjection(milestone, state, "zh", selection);
    return [{
      key: milestone.story.key,
      kind: milestone.story.kind,
      revision: state.revision,
      en,
      ...(zh ? { zh } : {}),
    }];
  });
  return { schema_version: "oxygen.reviewed-story/1", publication_approved: false, chapters };
}

const noReleaseRedaction: SuccessorReleasePrivacy = { redact: (copy) => copy };

function successorReviewContext(source: SuccessorStorySource, state: SuccessorChapterReviewState) {
  const sourceCollection = successorStoryBlocks(source);
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
  source: SuccessorStorySource,
  state: SuccessorChapterReviewState,
  privacy: SuccessorReleasePrivacy,
) {
  return source.story.blocks.map<PrivacyPreparedStoryBlock>((block) => {
    const reviewed = applyStoryReviewToBlock(block.text, block.id, "en", state);
    const safe = privacy.redact(reviewed);
    return { id: block.id, copy: safe, redacted: safe !== reviewed };
  });
}

function successorInsightProjection(
  id: string,
  content: {
    title?: string;
    background: string;
    quote: { storyBlockIds: string[] };
    directlyAcquiredExperience: string;
    principle: string;
  },
  blocks: Map<string, PrivacyPreparedStoryBlock>,
  privacy: SuccessorReleasePrivacy,
): SuccessorReleaseInsight | null {
  const anchors = content.quote.storyBlockIds.map((blockId) => blocks.get(blockId));
  if (!anchors.length || anchors.some((block) => !block || block.redacted)) return null;
  return successorInsightProduct(id, content, anchors.map((block) => block!.copy).join("\n\n"), privacy);
}

function successorInsightProduct(
  id: string,
  content: Omit<SuccessorHumanInsightContent, "quote" | "evidence">,
  quote: string,
  privacy: SuccessorReleasePrivacy,
): SuccessorReleaseInsight {
  return {
    id,
    ...(content.title === undefined ? {} : { title: privacy.redact(content.title) }),
    background: privacy.redact(content.background),
    quote,
    directlyAcquiredExperience: privacy.redact(content.directlyAcquiredExperience),
    principle: privacy.redact(content.principle),
  };
}

function successorHumanInsightProjection(
  id: string,
  content: SuccessorHumanInsightContent,
  state: SuccessorChapterReviewState,
  source: SuccessorStorySource,
  privacy: SuccessorReleasePrivacy,
): SuccessorReleaseInsight | null {
  const quote = successorHumanQuoteText(state, source, content);
  if (quote === null) return null;
  const privacyPreparedQuote = privacy.redact(quote);
  if (privacyPreparedQuote !== quote) return null;
  return successorInsightProduct(id, content, quote, privacy);
}

/** Build the distinct Story-First reviewed product. AI Quotes use safe Story
 * blocks; Human Quotes use their exact Privacy-safe Story selection. Anchors,
 * Evidence, and review provenance never enter the released contract. */
export function buildSuccessorReviewedStoryRelease(
  sources: SuccessorStorySource[],
  reviews: Record<string, SuccessorChapterReviewState>,
  privacy: SuccessorReleasePrivacy = noReleaseRedaction,
): SuccessorReviewedStoryRelease {
  const seen = new Set<string>();
  const chapters = sources.flatMap((source) => {
    const state = reviews[source.key];
    if (seen.has(source.key) || !state || state.stage !== "human_confirmed") return [];
    seen.add(source.key);
    const context = successorReviewContext(source, state);
    if (!validateSuccessorChapterReviewCompletion(state, context)) return [];

    const preparedBlocks = privacyPreparedStoryBlocks(source, state, privacy);
    const blocksById = new Map(preparedBlocks.map((block) => [block.id, block]));
    const insights: SuccessorReleaseInsight[] = [];
    for (const sourceInsight of source.insights) {
      const review = state.sourceInsightReviews[sourceInsight.id];
      if (review.decision === "rejected") continue;
      if (review.decision !== "accepted" || review.resolution !== "applied"
        || review.appliedVersion !== review.version) return [];
      const projected = successorInsightProjection(
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
      const projected = successorHumanInsightProjection(
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
    schema_version: SUCCESSOR_REVIEWED_STORY_SCHEMA,
    publication_approved: false,
    chapters,
  };
}

const requiredString = (value: unknown, maximum = 20_000) => typeof value === "string"
  && value.length > 0
  && value.length <= maximum;
const boundedString = (value: unknown, maximum = 20_000) => typeof value === "string" && value.length <= maximum;
const stringArray = (value: unknown) => Array.isArray(value)
  && value.length <= 200
  && value.every((item) => requiredString(item));

function sanitizeLocale(value: unknown): ReleaseLocale | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<ReleaseLocale>;
  if (![input.phase, input.title, input.overview, input.before, input.after].every((copy) => boundedString(copy))) return null;
  if (!Array.isArray(input.people) || input.people.length > 100 || !input.people.every((person) => (
    requiredString(person?.releaseLabel, 100) && requiredString(person?.role, 500) && requiredString(person?.description)
  ))) return null;
  if (!input.story || !boundedString(input.story.scene)
    || !stringArray(input.story.reconstruction) || !stringArray(input.story.importantDetails)
    || !boundedString(input.story.decisionOutcome)
    || (input.story.uncertainty !== undefined && !boundedString(input.story.uncertainty))) return null;
  if (!Array.isArray(input.insights) || input.insights.length > 1 || !input.insights.every((insight) => (
    requiredString(insight?.id, 200) && requiredString(insight?.title)
    && requiredString(insight?.noticed) && requiredString(insight?.lesson)
  ))) return null;
  return {
    phase: input.phase!, title: input.title!, overview: input.overview!, before: input.before!, after: input.after!,
    people: input.people.map((person) => ({
      releaseLabel: person.releaseLabel,
      role: person.role,
      description: person.description,
    })),
    story: {
      scene: input.story.scene,
      reconstruction: [...input.story.reconstruction],
      importantDetails: [...input.story.importantDetails],
      decisionOutcome: input.story.decisionOutcome,
      ...(input.story.uncertainty ? { uncertainty: input.story.uncertainty } : {}),
    },
    insights: input.insights.map((insight) => ({
      id: insight.id, title: insight.title, noticed: insight.noticed, lesson: insight.lesson,
    })),
  };
}

/** Treat browser input as untrusted and recreate it from an explicit allowlist. */
export function sanitizeReviewedStoryRelease(value: unknown): ReviewedStoryRelease | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<ReviewedStoryRelease>;
  if (input.schema_version !== "oxygen.reviewed-story/1" || input.publication_approved !== false
    || !Array.isArray(input.chapters) || input.chapters.length > 100) return null;
  const seen = new Set<string>();
  const chapters: ReviewedReleaseChapter[] = [];
  for (const chapter of input.chapters) {
    if (!requiredString(chapter?.key, 300) || !requiredString(chapter?.kind, 100)
      || !Number.isInteger(chapter?.revision) || chapter.revision < 2 || seen.has(chapter.key)) return null;
    const en = sanitizeLocale(chapter.en);
    const zh = chapter.zh === undefined ? null : sanitizeLocale(chapter.zh);
    if (!en || (chapter.zh !== undefined && !zh)) return null;
    if (zh && (en.people.length !== zh.people.length
      || en.people.some((person, index) => person.releaseLabel !== zh.people[index].releaseLabel)
      || en.story.reconstruction.length !== zh.story.reconstruction.length
      || en.story.importantDetails.length !== zh.story.importantDetails.length
      || Boolean(en.story.uncertainty) !== Boolean(zh.story.uncertainty)
      || en.insights.length !== zh.insights.length
      || en.insights.some((insight, index) => insight.id !== zh.insights[index].id))) return null;
    seen.add(chapter.key);
    chapters.push({
      key: chapter.key,
      kind: chapter.kind,
      revision: chapter.revision,
      en,
      ...(zh ? { zh } : {}),
    });
  }
  return { schema_version: "oxygen.reviewed-story/1", publication_approved: false, chapters };
}

function sanitizeSuccessorLocale(value: unknown): SuccessorReleaseLocale | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<SuccessorReleaseLocale>;
  if (!requiredString(input.title, 500) || !requiredString(input.overview)) return null;
  if (!Array.isArray(input.people) || input.people.length > 100 || !input.people.every((person) => (
    requiredString(person?.releaseLabel, 100) && requiredString(person?.role, 500)
    && requiredString(person?.description)
  ))) return null;
  if (!input.story || !stringArray(input.story.blocks)
    || (input.story.uncertainty !== undefined && !requiredString(input.story.uncertainty, 4_000))) return null;
  if (!Array.isArray(input.insights) || input.insights.length > 500) return null;
  const insightIds = new Set<string>();
  const insights: SuccessorReleaseInsight[] = [];
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
    title: input.title,
    overview: input.overview,
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

/** Recreate only the Story-First product allowlist. Locales, Story-block IDs,
 * Evidence, anchors, ledgers, origins, and CAS metadata are not accepted fields. */
export function sanitizeSuccessorReviewedStoryRelease(value: unknown): SuccessorReviewedStoryRelease | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<SuccessorReviewedStoryRelease>;
  if (input.schema_version !== SUCCESSOR_REVIEWED_STORY_SCHEMA || input.publication_approved !== false
    || !Array.isArray(input.chapters) || input.chapters.length > 500) return null;
  const seen = new Set<string>();
  const chapters: SuccessorReviewedReleaseChapter[] = [];
  for (const chapter of input.chapters) {
    if (!requiredString(chapter?.key, 1_000) || seen.has(chapter.key)
      || !chapter.phase || !requiredString(chapter.phase.id, 1_000)
      || !requiredString(chapter.phase.label, 500)
      || (chapter.kind !== undefined && !requiredString(chapter.kind, 100))
      || !Number.isInteger(chapter.revision) || chapter.revision < 2) return null;
    const en = sanitizeSuccessorLocale(chapter.en);
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
    schema_version: SUCCESSOR_REVIEWED_STORY_SCHEMA,
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

export function successorReviewedStoryPackageEntry(value: unknown) {
  const story = sanitizeSuccessorReviewedStoryRelease(value);
  return story?.chapters.length ? {
    name: "story/reviewed-project-story.json",
    data: serializeSuccessorReviewedStoryRelease(story)!,
  } : null;
}

export function serializeSuccessorReviewedStoryRelease(value: unknown) {
  const story = sanitizeSuccessorReviewedStoryRelease(value);
  return story ? JSON.stringify(story, null, 2) : null;
}

/** Strip local Story annotation JSON before organization summaries reach a
 * contribution package. Only the concise release-facing Timeline sentence is
 * retained; reviewPresentation and exact evidence never cross this boundary. */
export function releaseOrganizationReason(value: unknown) {
  const source = String(value ?? "");
  const prefix = source.startsWith(STORY_PREFIX)
    ? STORY_PREFIX
    : source.startsWith(LEGACY_STORY_PREFIX) ? LEGACY_STORY_PREFIX
      : source.startsWith(SUCCESSOR_STORY_PREFIX) ? SUCCESSOR_STORY_PREFIX : "";
  if (!prefix) return isReservedStoryOrganizationReason(source)
    ? "Reviewed project milestone" : source;
  try {
    const parsed = JSON.parse(source.slice(prefix.length)) as Record<string, unknown>;
    const summary = parsed.timelineSummary ?? parsed.narrative ?? parsed.overview ?? parsed.title;
    return typeof summary === "string" ? summary : "Reviewed project milestone";
  } catch {
    return "Reviewed project milestone";
  }
}
