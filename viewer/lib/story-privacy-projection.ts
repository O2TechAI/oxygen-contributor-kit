import type { StoryReleaseTarget } from "./timeline.ts";

export type StoryPrivacyOccurrence = {
  originalStartOffset: number;
  originalEndOffset: number;
  proposalStartOffset: number;
  proposalEndOffset: number;
  category: string;
};

export type StoryPrivacyPublicOverride = Pick<StoryPrivacyOccurrence,
  "originalStartOffset" | "originalEndOffset" | "category">;

export type StoryPrivacyOccurrenceReview = StoryPrivacyOccurrence & {
  originalText: string;
  proposedText: string;
  canPublish: boolean;
  isPublic: boolean;
};

export type StoryPrivacyTargetReview = {
  targetId: StoryReleaseTarget;
  targetContentDigest: string;
  originalText: string;
  proposedText: string;
  selectedText: string | null;
  edited: boolean;
  occurrences: StoryPrivacyOccurrenceReview[];
  decidedAt: string | null;
};

const retiredWholeTargetText = new Set([
  "[Confidential detail abstracted; narrative context retained]",
  "[Redacted]",
]);

export const storyPrivacyCredentialCategory = (category: string) => (
  /(?:credential|token|secret|password|api[-_]?key|private[-_]?key)/iu.test(category)
);

export const storyPrivacyCredentialText = (value: string) => (
  /-----BEGIN [^-\r\n]*PRIVATE KEY-----/u.test(value)
  || /(?:^|[^A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{8,}|(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]{8,}|gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[0-9A-Za-z-]{10,})/u.test(value)
  || /(?:^|\s)Bearer\s+[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:$|\s)/iu.test(value)
  || /(?:^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:$|[^A-Za-z0-9_-])/u.test(value)
  || /(?:api[ _-]?key|access[ _-]?token|auth[ _-]?token|password|secret)\s*[:=]\s*\S{4,}/iu.test(value)
);

export const storyPrivacyOverrideKey = (value: StoryPrivacyPublicOverride) => (
  `${value.originalStartOffset}:${value.originalEndOffset}:${value.category}`
);

export function storyPrivacyTextAllowed(value: string, knownFragments: string[] = []) {
  return Boolean(value.trim()) && value.length <= 1_000_000
    && !retiredWholeTargetText.has(value) && !storyPrivacyCredentialText(value)
    && !knownFragments.some((fragment) => fragment && value.includes(fragment));
}

export function applyStoryPrivacyPublicOverrides(
  originalText: string,
  proposedText: string,
  occurrences: StoryPrivacyOccurrence[],
  publicOverrides: StoryPrivacyPublicOverride[],
) {
  const requested = new Set(publicOverrides.map(storyPrivacyOverrideKey));
  if (requested.size !== publicOverrides.length) return null;
  const original = Array.from(originalText);
  const selected = Array.from(proposedText);
  const matches = occurrences.filter((occurrence) => requested.has(storyPrivacyOverrideKey(occurrence)));
  if (matches.length !== requested.size || matches.some((occurrence) => {
    const copy = original.slice(occurrence.originalStartOffset, occurrence.originalEndOffset).join("");
    return storyPrivacyCredentialCategory(occurrence.category) || storyPrivacyCredentialText(copy);
  })) return null;
  for (const occurrence of [...matches].sort((left, right) => right.proposalStartOffset
    - left.proposalStartOffset)) {
    selected.splice(
      occurrence.proposalStartOffset,
      occurrence.proposalEndOffset - occurrence.proposalStartOffset,
      ...original.slice(occurrence.originalStartOffset, occurrence.originalEndOffset),
    );
  }
  return selected.join("");
}

export function storyPrivacyOccurrenceReviews(
  originalText: string,
  proposedText: string,
  occurrences: StoryPrivacyOccurrence[],
  publicOverrides: StoryPrivacyPublicOverride[],
  credentialRanges: Array<{ startOffset: number; endOffset: number }> = [],
): StoryPrivacyOccurrenceReview[] {
  const original = Array.from(originalText);
  const proposal = Array.from(proposedText);
  const selected = new Set(publicOverrides.map(storyPrivacyOverrideKey));
  return occurrences.map((occurrence) => {
    const originalCopy = original.slice(occurrence.originalStartOffset, occurrence.originalEndOffset).join("");
    const canPublish = !storyPrivacyCredentialCategory(occurrence.category)
      && !storyPrivacyCredentialText(originalCopy)
      && !credentialRanges.some((range) => occurrence.originalStartOffset < range.endOffset
        && occurrence.originalEndOffset > range.startOffset);
    return {
      ...occurrence,
      originalText: originalCopy,
      proposedText: proposal.slice(occurrence.proposalStartOffset, occurrence.proposalEndOffset).join(""),
      canPublish,
      isPublic: canPublish && selected.has(storyPrivacyOverrideKey(occurrence)),
    };
  });
}
