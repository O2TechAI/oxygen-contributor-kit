export type ChapterRestoreContext = {
  storyKey: string;
  scrollTop: number;
  focusOriginId: string;
};

export function restoreChapterContext(context: ChapterRestoreContext | null, storyKey: string) {
  return context?.storyKey === storyKey
    ? { scrollTop: context.scrollTop, focusOriginId: context.focusOriginId }
    : { scrollTop: 0, focusOriginId: "" };
}

export function phaseGroupIdentity(name: string, index: number) {
  return `${name}:${index}`;
}
