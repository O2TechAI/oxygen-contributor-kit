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
