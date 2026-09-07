import type { StoryReleaseTarget } from "./timeline.ts";
import type { getLocalDatabase } from "../db";

export async function readStoryPrivacySourceRedactions(db: Awaited<ReturnType<typeof getLocalDatabase>>) {
  const [items, rows] = await Promise.all([
    db.prepare("SELECT id,document_id AS documentId,content FROM items ORDER BY document_id,sequence,id")
      .all<{ id: string; documentId: string; content: string }>(),
    db.prepare("SELECT * FROM redactions ORDER BY id").all<Record<string, unknown>>(),
  ]);
  return storyPrivacySourceRedactions(items.results, rows.results);
}

export type StoryPrivacyOccurrence = {
  originalStartOffset: number;
  originalEndOffset: number;
  proposalStartOffset: number;
  proposalEndOffset: number;
  category: string;
};

export type StoryPrivacySourceRedaction = {
  id: string;
  documentId: string;
  itemId: string;
  startOffset: number;
  endOffset: number;
  category: string;
  text: string;
  context: string;
};

export type StoryPrivacySourceMatch = {
  sourceRedactionId: string;
  originalStartOffset: number;
  originalEndOffset: number;
  relation: "inherited" | "unrelated";
  reason: string;
};

export function storyPrivacySourceRedactions(
  items: Array<{ id: string; documentId: string; content: string }>,
  rows: Array<Record<string, unknown>>,
): StoryPrivacySourceRedaction[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return rows.filter((row) => row.status === "active"
    && ["deterministic", "confirmed_redact"].includes(String(row.review_state))).map((row) => {
    const item = byId.get(String(row.item_id));
    const start = Number(row.start_offset), end = Number(row.end_offset);
    const points = Array.from(item?.content || "");
    if (!item || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end <= start || end > points.length || !row.id
      || (row.document_id !== undefined && row.document_id !== item.documentId)) {
      throw new Error("STORY_PRIVACY_SOURCE_INVALID");
    }
    const index = items.indexOf(item);
    const neighbors = [{ itemId: item.id, text: points.slice(Math.max(0, start - 160), end + 160).join("") }];
    for (const direction of [-1, 1]) {
      let remaining = Math.max(0, 160 - (direction < 0 ? start : points.length - end));
      for (let cursor = index + direction; remaining > 0 && items[cursor]?.documentId === item.documentId; cursor += direction) {
        const neighbor = items[cursor], copy = Array.from(neighbor.content);
        const text = (direction < 0 ? copy.slice(-remaining) : copy.slice(0, remaining)).join("");
        const entry = { itemId: neighbor.id, text };
        if (direction < 0) neighbors.unshift(entry); else neighbors.push(entry);
        remaining -= Math.max(1, Array.from(text).length);
      }
    }
    return { id: String(row.id), documentId: item.documentId, itemId: item.id,
      startOffset: start, endOffset: end, category: String(row.category),
      text: points.slice(start, end).join(""),
      context: JSON.stringify({ documentId: item.documentId, items: neighbors }) };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function storyPrivacySourceRanges(text: string, fragment: string) {
  const points = Array.from(text), needle = Array.from(fragment);
  const ranges: Array<{ originalStartOffset: number; originalEndOffset: number }> = [];
  for (let start = 0; needle.length && start + needle.length <= points.length; start += 1) {
    if (needle.every((point, offset) => points[start + offset] === point)) {
      ranges.push({ originalStartOffset: start, originalEndOffset: start + needle.length });
    }
  }
  return ranges;
}

export function matchingStoryPrivacySources(
  targets: Array<{ content: string; editedText?: string }>, sources: StoryPrivacySourceRedaction[],
) {
  return sources.filter((source) => targets.some((target) => target.content.includes(source.text)
    || target.editedText?.includes(source.text)));
}

/** Semantic workers explain every exact source match, including homonyms. The
 * recorder checks range coverage; it never guesses semantic inheritance. */
export function validStoryPrivacySourceMatches(
  original: string, proposal: string, occurrences: StoryPrivacyOccurrence[],
  matches: StoryPrivacySourceMatch[] | undefined, sources?: StoryPrivacySourceRedaction[],
) {
  if (matches !== undefined && (!Array.isArray(matches) || matches.length === 0
    || matches.some((match) => !match || Object.keys(match).sort().join(",")
      !== "originalEndOffset,originalStartOffset,reason,relation,sourceRedactionId"
      || !Number.isSafeInteger(match.originalStartOffset) || match.originalStartOffset < 0
      || !Number.isSafeInteger(match.originalEndOffset)
      || match.originalEndOffset <= match.originalStartOffset
      || !["inherited", "unrelated"].includes(match.relation)
      || typeof match.sourceRedactionId !== "string" || !match.sourceRedactionId
      || typeof match.reason !== "string" || !match.reason.trim() || match.reason.length > 2000))) return false;
  const key = (match: Pick<StoryPrivacySourceMatch, "sourceRedactionId" | "originalStartOffset" | "originalEndOffset">) =>
    JSON.stringify([match.sourceRedactionId, match.originalStartOffset, match.originalEndOffset]);
  const byKey = new Map((matches || []).map((match) => [key(match), match]));
  if (byKey.size !== (matches || []).length) return false;
  if (!sources) return true; // Shape-only reads cannot establish source authority.
  const expected = sources.flatMap((source) => storyPrivacySourceRanges(original, source.text)
    .map((range) => ({ ...range, sourceRedactionId: source.id, source })));
  if (expected.length !== byKey.size) return false;
  return expected.every((range) => {
    const match = byKey.get(key(range));
    if (!match) return false;
    const credential = storyPrivacyCredentialCategory(range.source.category)
      || storyPrivacyCredentialText(range.source.text);
    if (match.relation === "unrelated") return !credential;
    const occurrence = occurrences.find((value) => value.originalStartOffset <= range.originalStartOffset
      && value.originalEndOffset >= range.originalEndOffset);
    return Boolean(occurrence && !Array.from(proposal).slice(occurrence.proposalStartOffset,
      occurrence.proposalEndOffset).join("").includes(range.source.text));
  });
}

export function storyPrivacyProposalRanges(proposal: { occurrences: StoryPrivacyOccurrence[];
  sourceMatches?: StoryPrivacySourceMatch[]; proposalSourceMatches?: StoryPrivacySourceMatch[];
  editedProposal?: { inputDigest: string; text: string; sourceMatches?: StoryPrivacySourceMatch[] } }) {
  const { occurrences, sourceMatches, proposalSourceMatches, editedProposal } = proposal;
  return JSON.stringify(sourceMatches || proposalSourceMatches || editedProposal
    ? { occurrences, ...(sourceMatches ? { sourceMatches } : {}),
      ...(proposalSourceMatches ? { proposalSourceMatches } : {}), ...(editedProposal ? { editedProposal } : {}) }
    : occurrences);
}

export type StoryPrivacyPublicOverride = Pick<StoryPrivacyOccurrence,
  "originalStartOffset" | "originalEndOffset" | "category">;

/** A contributor requests new suggestions for these current, undecided passages.
 * Retention is exact-range permission, never a global term exception. */
export type StoryPrivacyRereviewRequest = {
  reason: string;
  targets: Array<{ targetId: string; targetContentDigest: string;
    retainOriginal: Array<StoryPrivacyPublicOverride & { originalText: string }> }>;
};

export function storyPrivacyShardBinding<T extends { rereviewRequest?: StoryPrivacyRereviewRequest }>(
  binding: T, targetIds: string[],
): T {
  return binding.rereviewRequest ? { ...binding, rereviewRequest: { ...binding.rereviewRequest,
    targets: binding.rereviewRequest.targets.filter((target) => targetIds.includes(target.targetId)) } } : binding;
}

export function parseStoryPrivacyRereviewRequest(value: unknown): StoryPrivacyRereviewRequest | null {
  const record = (entry: unknown): entry is Record<string, unknown> => Boolean(entry)
    && typeof entry === "object" && !Array.isArray(entry);
  const keys = (entry: Record<string, unknown>, names: string[]) =>
    Object.keys(entry).sort().join(",") === names.sort().join(",");
  if (!record(value) || !keys(value, ["reason", "targets"])
    || typeof value.reason !== "string" || !value.reason.trim() || value.reason.length > 2000
    || !Array.isArray(value.targets) || value.targets.length === 0 || value.targets.length > 64
    || value.targets.some((target) => !record(target)
      || !keys(target, ["targetId", "targetContentDigest", "retainOriginal"])
      || typeof target.targetId !== "string" || !target.targetId.trim() || target.targetId.length > 1000
      || typeof target.targetContentDigest !== "string" || !/^[0-9a-f]{64}$/.test(target.targetContentDigest)
      || !Array.isArray(target.retainOriginal) || target.retainOriginal.length > 64
      || target.retainOriginal.some((span) => !record(span)
        || !keys(span, ["originalStartOffset", "originalEndOffset", "category", "originalText"])
        || !Number.isSafeInteger(span.originalStartOffset) || Number(span.originalStartOffset) < 0
        || !Number.isSafeInteger(span.originalEndOffset) || Number(span.originalEndOffset) <= Number(span.originalStartOffset)
        || typeof span.category !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(span.category)
        || typeof span.originalText !== "string" || !span.originalText.trim() || span.originalText.length > 1000
        || storyPrivacyCredentialCategory(span.category) || storyPrivacyCredentialText(span.originalText))
      || new Set(target.retainOriginal.map((span) => storyPrivacyOverrideKey(span))).size !== target.retainOriginal.length)
    || new Set(value.targets.map((target) => target.targetId)).size !== value.targets.length) return null;
  return value as StoryPrivacyRereviewRequest;
}

export function validStoryPrivacyRereviewTargets(request: StoryPrivacyRereviewRequest,
  targets: Array<{ id: string; content: string; contentDigest: string }>) {
  return request.targets.length === targets.length && request.targets.every((requested) => {
    const target = targets.find((entry) => entry.id === requested.targetId);
    return target?.contentDigest === requested.targetContentDigest && requested.retainOriginal.every((span) =>
      Array.from(target.content).slice(span.originalStartOffset, span.originalEndOffset).join("") === span.originalText);
  });
}

export function storyPrivacyRereviewRespected(request: StoryPrivacyRereviewRequest,
  proposals: Array<{ targetId: string; occurrences: StoryPrivacyOccurrence[] }>) {
  return request.targets.every((target) => {
    const proposal = proposals.find((entry) => entry.targetId === target.targetId);
    return proposal && target.retainOriginal.every((span) => !proposal.occurrences.some((change) =>
      change.originalStartOffset < span.originalEndOffset && change.originalEndOffset > span.originalStartOffset));
  });
}

export type StoryPrivacyOccurrenceReview = StoryPrivacyOccurrence & {
  originalText: string;
  proposedText: string;
  canPublish: boolean;
  isPublic: boolean;
};

export type StoryPrivacyTargetReview = {
  editedProposal?: { inputDigest: string; text: string };
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
