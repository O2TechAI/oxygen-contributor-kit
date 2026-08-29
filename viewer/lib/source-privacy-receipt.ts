import { validActivatedSourceRevision } from "./authority-validation.mjs";

type JsonRecord = Record<string, unknown>;

const encoder = new TextEncoder();
const digestPattern = /^[0-9a-f]{64}$/u;
const documentIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;
const corpusKeys = ["revision", "digest", "documentCount", "itemCount"] as const;
const turnKeys = [
  "eventId", "itemId", "sequence", "role", "timestamp", "textByteLength", "textDigest",
] as const;
const bundleKeys = [
  "documentId", "documentKind", "inputByteLength", "inputDigest", "turns",
] as const;
const dialogueKeys = ["bundleCount", "turnCount", "bundles", "digest"] as const;
const redactionKeys = ["count", "digest"] as const;
const receiptCoreKeys = [
  "status", "workflowRunId", "sourceRevision", "finalizedCorpus", "sourceDigest",
  "dialogue", "redactions",
] as const;
const receiptKeys = [...receiptCoreKeys, "receiptDigest"] as const;
const storedReceiptRowKeys = [
  "job_id", "workflow_run_id", "source_revision", "source_digest", "receipt_digest",
  "receipt_json", "created_at",
] as const;

function exactKeys(value: unknown, keys: readonly string[]): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value as JsonRecord).length === keys.length
    && Object.keys(value as JsonRecord).every((key) => keys.includes(key));
}

function compareUtf8(left: string, right: string) {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.length - rightBytes.length;
}

export function canonicalSourcePrivacyJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("Source Privacy value is not JSON-compatible");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalSourcePrivacyJson).join(",")}]`;
  const record = value as JsonRecord;
  return `{${Object.keys(record).sort(compareUtf8).map((key) => (
    `${JSON.stringify(key)}:${canonicalSourcePrivacyJson(record[key])}`
  )).join(",")}}`;
}

async function sha256Bytes(value: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(value).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sourcePrivacyDigest(value: unknown) {
  return sha256Bytes(encoder.encode(canonicalSourcePrivacyJson(value)));
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && validActivatedSourceRevision(value);
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export type SourcePrivacyReceipt = {
  status: "complete";
  workflowRunId: string;
  sourceRevision: number;
  finalizedCorpus: {
    revision: number;
    digest: string;
    documentCount: number;
    itemCount: number;
  };
  sourceDigest: string;
  dialogue: {
    bundleCount: number;
    turnCount: number;
    bundles: Array<{
      documentId: string;
      documentKind: "trajectory" | "meeting";
      inputByteLength: number;
      inputDigest: string;
      turns: Array<{
        eventId: string;
        itemId: string;
        sequence: number;
        role: string | null;
        timestamp: string | null;
        textByteLength: number;
        textDigest: string;
      }>;
    }>;
    digest: string;
  };
  redactions: { count: number; digest: string };
  receiptDigest: string;
};

export async function parseSourcePrivacyReceipt(value: unknown): Promise<SourcePrivacyReceipt | null> {
  if (!exactKeys(value, receiptKeys) || value.status !== "complete"
    || typeof value.workflowRunId !== "string" || !value.workflowRunId.trim()
    || !positiveInteger(value.sourceRevision) || !digestPattern.test(String(value.sourceDigest || ""))
    || !exactKeys(value.finalizedCorpus, corpusKeys)
    || !positiveInteger(value.finalizedCorpus.revision)
    || !digestPattern.test(String(value.finalizedCorpus.digest || ""))
    || !nonnegativeInteger(value.finalizedCorpus.documentCount)
    || !nonnegativeInteger(value.finalizedCorpus.itemCount)
    || !exactKeys(value.dialogue, dialogueKeys)
    || !nonnegativeInteger(value.dialogue.bundleCount) || value.dialogue.bundleCount < 1
    || !nonnegativeInteger(value.dialogue.turnCount) || value.dialogue.turnCount < 1
    || !Array.isArray(value.dialogue.bundles)
    || value.dialogue.bundleCount !== value.dialogue.bundles.length
    || value.finalizedCorpus.documentCount < value.dialogue.bundleCount
    || value.finalizedCorpus.itemCount < value.dialogue.turnCount
    || !digestPattern.test(String(value.dialogue.digest || ""))
    || !exactKeys(value.redactions, redactionKeys)
    || !nonnegativeInteger(value.redactions.count)
    || !digestPattern.test(String(value.redactions.digest || ""))
    || !digestPattern.test(String(value.receiptDigest || ""))) return null;
  let turnCount = 0;
  const documentIds = new Set<string>();
  const itemIds = new Set<string>();
  let previousDocumentId: string | null = null;
  for (const bundle of value.dialogue.bundles) {
    if (!exactKeys(bundle, bundleKeys)
      || typeof bundle.documentId !== "string" || !documentIdPattern.test(bundle.documentId)
      || documentIds.has(bundle.documentId)
      || (previousDocumentId !== null && compareUtf8(previousDocumentId, bundle.documentId) >= 0)
      || !["trajectory", "meeting"].includes(String(bundle.documentKind))
      || !nonnegativeInteger(bundle.inputByteLength) || bundle.inputByteLength < 1
      || !digestPattern.test(String(bundle.inputDigest || ""))
      || !Array.isArray(bundle.turns) || bundle.turns.length < 1) return null;
    documentIds.add(bundle.documentId);
    previousDocumentId = bundle.documentId;
    let previousTurn: { sequence: number; itemId: string } | null = null;
    const eventIds = new Set<string>();
    for (const turn of bundle.turns) {
      if (!exactKeys(turn, turnKeys)
        || typeof turn.eventId !== "string" || !turn.eventId
        || typeof turn.itemId !== "string" || !turn.itemId
        || turn.eventId !== turn.itemId
        || eventIds.has(turn.eventId) || itemIds.has(turn.itemId)
        || !positiveInteger(turn.sequence)
        || (turn.role !== null && typeof turn.role !== "string")
        || (turn.timestamp !== null && typeof turn.timestamp !== "string")
        || !positiveInteger(turn.textByteLength)
        || !digestPattern.test(String(turn.textDigest || ""))
        || (previousTurn !== null && (
          turn.sequence < previousTurn.sequence
          || (turn.sequence === previousTurn.sequence
            && compareUtf8(turn.itemId, previousTurn.itemId) <= 0)
        ))) return null;
      eventIds.add(turn.eventId);
      itemIds.add(turn.itemId);
      previousTurn = { sequence: turn.sequence, itemId: turn.itemId };
      turnCount += 1;
    }
  }
  if (turnCount !== value.dialogue.turnCount
    || await sourcePrivacyDigest(value.dialogue.bundles) !== value.dialogue.digest) return null;
  const core = Object.fromEntries(receiptCoreKeys.map((key) => [key, value[key]]));
  if (await sourcePrivacyDigest(core) !== value.receiptDigest) return null;
  return value as unknown as SourcePrivacyReceipt;
}

export type CurrentSourceRow = {
  document_id: unknown;
  document_kind: unknown;
  id: unknown;
  sequence: unknown;
  event_type: unknown;
  actor_type: unknown;
  timestamp: unknown;
  content: unknown;
  original_json: unknown;
};

export type StoredSourcePrivacyReceiptRow = {
  job_id: unknown;
  workflow_run_id: unknown;
  source_revision: unknown;
  source_digest: unknown;
  receipt_digest: unknown;
  receipt_json: unknown;
  created_at: unknown;
};

export type PersistedSourcePrivacyRedaction = {
  item_id: unknown;
  document_id: unknown;
  start_offset: unknown;
  end_offset: unknown;
  category: unknown;
  confidence: unknown;
  reason: unknown;
  review_state: unknown;
  uncertainty_reason: unknown;
  status: unknown;
  created_by: unknown;
};

type CanonicalTransportRedaction = {
  itemId: string;
  documentId: string;
  startOffset: number;
  endOffset: number;
  category: string;
  confidence: string | null;
  reason: string | null;
  reviewState: string;
  uncertaintyReason: string | null;
  createdBy: string;
};

export function canonicalSourcePrivacyRedactions(
  spans: Array<Record<string, unknown>>,
): CanonicalTransportRedaction[] {
  return spans.map((span) => ({
    itemId: span.itemId as string,
    documentId: span.documentId as string,
    startOffset: Number(span.startOffset),
    endOffset: Number(span.endOffset),
    category: span.category as string,
    confidence: span.confidence == null ? null : span.confidence as string,
    reason: span.reason == null ? null : span.reason as string,
    reviewState: span.reviewState as string,
    uncertaintyReason: span.uncertaintyReason == null ? null : span.uncertaintyReason as string,
    createdBy: span.createdBy == null ? "llm" : span.createdBy as string,
  })).sort((left, right) => compareUtf8(left.documentId, right.documentId)
    || compareUtf8(left.itemId, right.itemId)
    || left.startOffset - right.startOffset
    || left.endOffset - right.endOffset
    || compareUtf8(left.category, right.category));
}

function canonicalPersistedSourcePrivacyRedactions(
  rows: PersistedSourcePrivacyRedaction[],
) {
  const transport: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const reviewState = String(row.review_state || "");
    if (typeof row.item_id !== "string" || !row.item_id
      || typeof row.document_id !== "string" || !row.document_id
      || !nonnegativeInteger(row.start_offset) || !positiveInteger(row.end_offset)
      || Number(row.end_offset) <= Number(row.start_offset)
      || typeof row.category !== "string" || !row.category
      || (row.confidence !== null && typeof row.confidence !== "string")
      || (row.reason !== null && typeof row.reason !== "string")
      || !["deterministic", "needs_confirmation", "confirmed_keep", "confirmed_redact"]
        .includes(reviewState)
      || (row.uncertainty_reason !== null && typeof row.uncertainty_reason !== "string")) {
      return null;
    }
    const expectedPersistence = reviewState === "confirmed_keep"
      ? { status: "removed", createdBy: "contributor" }
      : reviewState === "confirmed_redact"
        ? { status: "active", createdBy: "contributor" }
        : { status: "active", createdBy: "llm" };
    if (row.status !== expectedPersistence.status
      || row.created_by !== expectedPersistence.createdBy) return null;
    const importedReviewState = reviewState === "deterministic"
      ? "deterministic"
      : "needs_confirmation";
    if ((importedReviewState === "deterministic" && row.uncertainty_reason !== null)
      || (importedReviewState === "needs_confirmation"
        && !String(row.uncertainty_reason || "").trim())) return null;
    transport.push({
      itemId: row.item_id,
      documentId: row.document_id,
      startOffset: row.start_offset,
      endOffset: row.end_offset,
      category: row.category,
      confidence: row.confidence,
      reason: row.reason,
      reviewState: importedReviewState,
      uncertaintyReason: row.uncertainty_reason,
      createdBy: "llm",
    });
  }
  return canonicalSourcePrivacyRedactions(transport);
}

/** Validate the normalized durable receipt against every current authority it
 * binds. Confirmed review states map back to their immutable imported pending
 * state; reviewer decisions do not rewrite the terminal worker receipt. */
export async function validateStoredSourcePrivacyReceipt(
  row: unknown,
  expected: {
    jobId: string;
    workflowRunId: string;
    sourceRevision: number;
    sourceDigest: string;
    finalizedCorpus: SourcePrivacyReceipt["finalizedCorpus"];
    dialogue?: SourcePrivacyReceipt["dialogue"];
    redactions: PersistedSourcePrivacyRedaction[];
  },
): Promise<SourcePrivacyReceipt | null> {
  if (!exactKeys(row, storedReceiptRowKeys)) return null;
  const stored = row as unknown as StoredSourcePrivacyReceiptRow;
  if (stored.job_id !== expected.jobId
    || stored.workflow_run_id !== expected.workflowRunId
    || Number(stored.source_revision) !== expected.sourceRevision
    || stored.source_digest !== expected.sourceDigest
    || !digestPattern.test(String(stored.receipt_digest || ""))
    || typeof stored.receipt_json !== "string"
    || typeof stored.created_at !== "string" || !stored.created_at) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored.receipt_json);
  } catch {
    return null;
  }
  const receipt = await parseSourcePrivacyReceipt(parsed);
  if (!receipt || canonicalSourcePrivacyJson(receipt) !== stored.receipt_json
    || receipt.receiptDigest !== stored.receipt_digest
    || receipt.workflowRunId !== expected.workflowRunId
    || receipt.sourceRevision !== expected.sourceRevision
    || receipt.sourceDigest !== expected.sourceDigest
    || canonicalSourcePrivacyJson(receipt.finalizedCorpus)
      !== canonicalSourcePrivacyJson(expected.finalizedCorpus)
    || (expected.dialogue !== undefined && canonicalSourcePrivacyJson(receipt.dialogue)
      !== canonicalSourcePrivacyJson(expected.dialogue))) return null;
  const redactions = canonicalPersistedSourcePrivacyRedactions(expected.redactions);
  if (!redactions || receipt.redactions.count !== redactions.length
    || receipt.redactions.digest !== await sourcePrivacyDigest(redactions)) return null;
  return receipt;
}

function codePointLength(value: string) {
  return Array.from(value).length;
}

export async function buildCurrentSourcePrivacyDialogue(rows: CurrentSourceRow[]) {
  const byDocument = new Map<string, {
    trajectory: string;
    document_kind: "trajectory" | "meeting";
    turns: Array<{
      event_id: string;
      document_id: string;
      item_id: string;
      sequence: number;
      role: string | null;
      timestamp: string | null;
      text: string;
    }>;
    chars: number;
  }>();
  for (const row of rows) {
    const documentId = String(row.document_id || "");
    const documentKind = String(row.document_kind || "");
    const itemId = String(row.id || "");
    const sequence = Number(row.sequence);
    const eventType = String(row.event_type || "");
    const text = String(row.content ?? "");
    if (!documentIdPattern.test(documentId) || !itemId || !positiveInteger(sequence)
      || !["trajectory", "meeting"].includes(documentKind)) throw new Error("invalid source row");
    const reviewable = documentKind === "trajectory"
      ? eventType === "message" && Boolean(text.trim())
      : eventType === "record" && Boolean(text.trim());
    if (!reviewable) continue;
    let original: JsonRecord;
    try {
      const parsed = JSON.parse(String(row.original_json || "")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      original = parsed as JsonRecord;
    } catch {
      throw new Error("invalid source envelope");
    }
    const role = documentKind === "meeting"
      ? "user"
      : (() => {
          const payload = original.payload;
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
          const value = (payload as JsonRecord).role;
          return value == null ? null : String(value);
        })();
    const current = byDocument.get(documentId) || {
      trajectory: documentId,
      document_kind: documentKind as "trajectory" | "meeting",
      turns: [],
      chars: 0,
    };
    if (current.document_kind !== documentKind) throw new Error("conflicting document kind");
    current.turns.push({
      event_id: itemId,
      document_id: documentId,
      item_id: itemId,
      sequence,
      role,
      timestamp: row.timestamp == null ? null : String(row.timestamp),
      text,
    });
    current.chars += codePointLength(text);
    byDocument.set(documentId, current);
  }
  const bundles = [...byDocument.values()].sort((left, right) => (
    compareUtf8(left.trajectory, right.trajectory)
  ));
  const authorities = [];
  for (const bundle of bundles) {
    bundle.turns.sort((left, right) => left.sequence - right.sequence
      || compareUtf8(left.item_id, right.item_id));
    const raw = encoder.encode(`${canonicalSourcePrivacyJson(bundle)}\n`);
    authorities.push({
      documentId: bundle.trajectory,
      documentKind: bundle.document_kind,
      inputByteLength: raw.byteLength,
      inputDigest: await sha256Bytes(raw),
      turns: await Promise.all(bundle.turns.map(async (turn) => {
        const textBytes = encoder.encode(turn.text);
        return {
          eventId: turn.event_id,
          itemId: turn.item_id,
          sequence: turn.sequence,
          role: turn.role,
          timestamp: turn.timestamp,
          textByteLength: textBytes.byteLength,
          textDigest: await sha256Bytes(textBytes),
        };
      })),
    });
  }
  const authority = {
    bundleCount: authorities.length,
    turnCount: authorities.reduce((count, bundle) => count + bundle.turns.length, 0),
    bundles: authorities,
  };
  return { ...authority, digest: await sourcePrivacyDigest(authorities) };
}
