import type { ChapterReviewState } from "./story-review.ts";
import { applyStoryReviewToBlock, validateChapterReviewCompletion } from "./story-review.ts";
import {
  LEGACY_STORY_PREFIX,
  STORY_PREFIX,
  storyReleaseTargetCatalog,
  type StoryLanguage,
  type StoryReleaseTarget,
  type StoryReleaseTargetCatalog,
  type StoryReleaseTargetDescriptor,
  type TimelineMilestone,
} from "./timeline.ts";

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

/** Strip local Story annotation JSON before organization summaries reach a
 * contribution package. Only the concise release-facing Timeline sentence is
 * retained; reviewPresentation and exact evidence never cross this boundary. */
export function releaseOrganizationReason(value: unknown) {
  const source = String(value ?? "");
  const prefix = source.startsWith(STORY_PREFIX)
    ? STORY_PREFIX
    : source.startsWith(LEGACY_STORY_PREFIX) ? LEGACY_STORY_PREFIX : "";
  if (!prefix) return source;
  try {
    const parsed = JSON.parse(source.slice(prefix.length)) as Record<string, unknown>;
    const summary = parsed.timelineSummary ?? parsed.narrative ?? parsed.title;
    return typeof summary === "string" ? summary : "Reviewed project milestone";
  } catch {
    return "Reviewed project milestone";
  }
}
