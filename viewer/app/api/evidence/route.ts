import { getD1 } from "../../../db";
import {
  reviewStoryEvidence,
  type AdditionEvidenceClaim,
  type ReviewedEvidenceItem,
} from "../../../lib/story-evidence";
import { resolveEvidenceTarget, type EvidenceReference } from "../../../lib/timeline";

const onlyKeys = (value: object, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));
const referenceKey = (value: EvidenceReference) => JSON.stringify([value.documentId, value.eventId]);
const itemKey = (documentId: string, id: string) => JSON.stringify([documentId, id]);

const validReference = (value: unknown): value is EvidenceReference => {
  if (!value || typeof value !== "object") return false;
  const reference = value as Partial<EvidenceReference>;
  return onlyKeys(value, ["documentId", "eventId", "label"])
    && typeof reference.documentId === "string" && reference.documentId.length > 0 && reference.documentId.length <= 500
    && typeof reference.eventId === "string" && reference.eventId.length > 0 && reference.eventId.length <= 500
    && (reference.label === undefined || (typeof reference.label === "string" && reference.label.length <= 500));
};

const validAddition = (value: unknown): value is AdditionEvidenceClaim => {
  if (!value || typeof value !== "object") return false;
  const addition = value as Partial<AdditionEvidenceClaim>;
  return onlyKeys(value, ["annotationId", "instruction", "supportingEvidence"])
    && typeof addition.annotationId === "string" && addition.annotationId.length > 0 && addition.annotationId.length <= 500
    && typeof addition.instruction === "string" && addition.instruction.trim().length > 0 && addition.instruction.length <= 20_000
    && Array.isArray(addition.supportingEvidence) && addition.supportingEvidence.length <= 10
    && addition.supportingEvidence.every(validReference);
};

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as {
    chapterEvidence?: unknown;
    additions?: unknown;
  } | null;
  if (!body || !onlyKeys(body, ["chapterEvidence", "additions"])
    || !Array.isArray(body.chapterEvidence) || body.chapterEvidence.length > 100
    || !body.chapterEvidence.every(validReference)
    || !Array.isArray(body.additions) || body.additions.length > 100
    || !body.additions.every(validAddition)
    || new Set(body.additions.map((addition) => addition.annotationId)).size !== body.additions.length) {
    return Response.json({ error: "Invalid Story evidence review request" }, { status: 400 });
  }

  const documentIds = [...new Set(body.chapterEvidence.map((reference) => reference.documentId))];
  const db = await getD1();
  const inventories = await Promise.all(documentIds.map(async (documentId) => {
    const response = await db.prepare(
      "SELECT id FROM items WHERE document_id=? ORDER BY sequence"
    ).bind(documentId).all<Record<string, unknown>>();
    return [documentId, response.results.map((item) => ({ id: String(item.id) }))] as const;
  }));
  const byDocument = new Map(inventories);
  const supportKeys = new Set(body.additions.flatMap((addition) => addition.supportingEvidence.map(referenceKey)));
  const resolvedSupportItems = body.chapterEvidence.flatMap((reference) => {
    if (!supportKeys.has(referenceKey(reference))) return [];
    const resolution = resolveEvidenceTarget(byDocument.get(reference.documentId) || [], reference.eventId);
    return resolution.status === "resolved" ? [{ documentId: reference.documentId, id: resolution.itemId }] : [];
  });
  const itemKeys = new Set<string>();
  const uniqueSupportItems = resolvedSupportItems.filter((item) => {
    const key = itemKey(item.documentId, item.id);
    if (itemKeys.has(key)) return false;
    itemKeys.add(key);
    return true;
  });
  const contentResults = await Promise.all(uniqueSupportItems.map(async (item): Promise<ReviewedEvidenceItem | null> => {
    const row = await db.prepare(
      "SELECT id,content FROM items WHERE document_id=? AND id=? LIMIT 1"
    ).bind(item.documentId, item.id).first<Record<string, unknown>>();
    return row ? { documentId: item.documentId, id: String(row.id), content: String(row.content || "") } : null;
  }));
  const contentByItem = new Map(contentResults.flatMap((item) => item
    ? [[itemKey(item.documentId, item.id), item.content] as const]
    : []));
  const reviewedItems = inventories.flatMap(([documentId, items]) => items.map((item): ReviewedEvidenceItem => ({
    documentId,
    id: item.id,
    content: contentByItem.get(itemKey(documentId, item.id)) || "",
  })));
  return Response.json(reviewStoryEvidence(
    reviewedItems,
    body.chapterEvidence,
    body.additions,
  ), { headers: { "cache-control": "no-store" } });
}
