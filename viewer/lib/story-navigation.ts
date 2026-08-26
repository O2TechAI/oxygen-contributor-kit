import type { ChapterReviewBlocker, ChapterReviewStage } from "./story-review";

export type ChapterRestoreContext = {
  storyKey: string;
  scrollTop: number;
  focusOriginId: string;
};

export type StoryNavigation = {
  project: string;
  storyKey: string;
};

export type StoryReviewFocusTarget = Pick<ChapterReviewBlocker, "targetKind" | "targetId" | "itemId"> & {
  chapterKey: string;
};

export type DownloadReviewBlocker = Omit<ChapterReviewBlocker, "chapterKey" | "code"> & {
  code: ChapterReviewBlocker["code"] | "chapter_not_confirmed";
};

export type DownloadReviewBlockerGroup = {
  project: string;
  chapterKey: string;
  title: string;
  blockers: DownloadReviewBlocker[];
};

export function groupDownloadReviewBlockers(chapters: Array<{
  project: string;
  chapterKey: string;
  title: string;
  stage: ChapterReviewStage;
  completionBlockers: ChapterReviewBlocker[];
}>): DownloadReviewBlockerGroup[] {
  return chapters.flatMap((chapter) => {
    const blockers: DownloadReviewBlocker[] = chapter.completionBlockers.map((blocker) => ({
      code: blocker.code,
      targetKind: blocker.targetKind,
      ...(blocker.targetId ? { targetId: blocker.targetId } : {}),
      ...(blocker.itemId ? { itemId: blocker.itemId } : {}),
    }));
    if (chapter.stage !== "human_confirmed") {
      blockers.push({ code: "chapter_not_confirmed", targetKind: "chapter" });
    }
    return blockers.length ? [{
      project: chapter.project,
      chapterKey: chapter.chapterKey,
      title: chapter.title,
      blockers,
    }] : [];
  });
}

type StoryNavigationCandidate = {
  project?: string;
  story: { key: string };
};

export const STORY_PROJECT_QUERY = "storyProject";
export const STORY_CHAPTER_QUERY = "storyChapter";

export function storyNavigationProjects(candidates: StoryNavigationCandidate[]) {
  return Array.from(new Set(candidates.flatMap((candidate) => (
    typeof candidate.project === "string" && candidate.project ? [candidate.project] : []
  ))));
}

export function resolveStoryNavigation(
  candidates: StoryNavigationCandidate[],
  requested: Partial<StoryNavigation>,
  fallbackProject = "",
): StoryNavigation {
  const projects = storyNavigationProjects(candidates);
  const project = projects.includes(requested.project || "")
    ? requested.project || ""
    : projects.includes(fallbackProject) ? fallbackProject : projects[0] || "";
  const storyKey = candidates.some((candidate) => (
    candidate.project === project && candidate.story.key === requested.storyKey
  )) ? requested.storyKey || "" : "";
  return { project, storyKey };
}

export function readStoryNavigation(search: string): StoryNavigation {
  const params = new URLSearchParams(search);
  return {
    project: params.get(STORY_PROJECT_QUERY) || "",
    storyKey: params.get(STORY_CHAPTER_QUERY) || "",
  };
}

export function writeStoryNavigation(search: string, navigation: StoryNavigation) {
  const params = new URLSearchParams(search);
  if (navigation.project) params.set(STORY_PROJECT_QUERY, navigation.project);
  else params.delete(STORY_PROJECT_QUERY);
  if (navigation.project && navigation.storyKey) params.set(STORY_CHAPTER_QUERY, navigation.storyKey);
  else params.delete(STORY_CHAPTER_QUERY);
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

export function restoreChapterContext(context: ChapterRestoreContext | null, storyKey: string) {
  return context?.storyKey === storyKey
    ? { scrollTop: context.scrollTop, focusOriginId: context.focusOriginId }
    : { scrollTop: 0, focusOriginId: "" };
}

/** Reveal and focus the exact control that opened Evidence. The disclosure is
 * closed again when the Chapter remounts, so focus restoration must reopen it
 * before returning focus to the captured origin. */
export function restoreEvidenceOrigin(origin: HTMLElement | null, fallback: HTMLElement | null) {
  const disclosure = origin?.closest<HTMLDetailsElement>("details");
  if (disclosure) disclosure.open = true;
  (origin || fallback)?.focus({ preventScroll: true });
  return Boolean(origin);
}

export function phaseGroupIdentity(name: string, index: number) {
  return `${name}:${index}`;
}
