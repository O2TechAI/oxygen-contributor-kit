import type { EvidenceReference } from "./timeline.ts";
import { resolveEvidenceTarget } from "./timeline.ts";

export type ReviewedEvidenceItem = {
  documentId: string;
  id: string;
  content: string;
};

export type AdditionEvidenceClaim = {
  annotationId: string;
  instruction: string;
  supportingEvidence: EvidenceReference[];
};

export type StoryEvidenceReview = {
  evidenceResolved: boolean;
  supportedAddIds: string[];
};

const evidenceKey = (reference: EvidenceReference) => JSON.stringify([reference.documentId, reference.eventId]);

function normalized(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}_./:+-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function claimVariants(instruction: string) {
  const copy = normalized(instruction);
  const withoutDirection = copy
    .replace(/^(?:please )?(?:add|include)(?: that)? /, "")
    .replace(/^(?:请)?(?:补充|加入|加上)(?:说明)? /, "")
    .trim();
  return [...new Set([copy, withoutDirection])].filter((value) => value.length >= 3);
}

function exactReviewedSupport(instruction: string, contents: string[]) {
  const claims = claimVariants(instruction);
  const sources = contents.map(normalized);
  return claims.length > 0 && claims.some((claim) => sources.some((source) => source.includes(claim)));
}

/** Resolve Story evidence against the actual reviewed item inventory. Add is
 * intentionally conservative in this deterministic prototype: the proposed
 * factual wording must occur in a resolved reviewed source item. */
export function reviewStoryEvidence(
  items: ReviewedEvidenceItem[],
  chapterEvidence: EvidenceReference[],
  additions: AdditionEvidenceClaim[],
): StoryEvidenceReview {
  const byDocument = new Map<string, ReviewedEvidenceItem[]>();
  for (const item of items) byDocument.set(item.documentId, [...(byDocument.get(item.documentId) || []), item]);

  const resolved = new Map<string, ReviewedEvidenceItem | null>();
  const resolve = (reference: EvidenceReference) => {
    const key = evidenceKey(reference);
    if (resolved.has(key)) return resolved.get(key) || null;
    const documentItems = byDocument.get(reference.documentId) || [];
    const result = resolveEvidenceTarget(documentItems, reference.eventId);
    const item = result.status === "resolved" ? documentItems[result.index] : null;
    resolved.set(key, item);
    return item;
  };

  const chapterKeys = new Set(chapterEvidence.map(evidenceKey));
  const evidenceResolved = chapterEvidence.length > 0
    && chapterKeys.size === chapterEvidence.length
    && chapterEvidence.every((reference) => Boolean(resolve(reference)));
  const supportedAddIds = additions.flatMap((addition) => {
    if (!addition.supportingEvidence.length
      || addition.supportingEvidence.some((reference) => !chapterKeys.has(evidenceKey(reference)))) return [];
    const support = addition.supportingEvidence.map(resolve);
    if (support.some((item) => !item)) return [];
    return exactReviewedSupport(addition.instruction, support.map((item) => item!.content))
      ? [addition.annotationId]
      : [];
  });
  return { evidenceResolved, supportedAddIds };
}
