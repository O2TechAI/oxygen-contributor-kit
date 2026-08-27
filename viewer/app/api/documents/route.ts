import { getD1 } from "../../../db";
import {
  WORKFLOW_RUN_AUTHORITY,
  requireEstablishedWorkflowRun,
  workflowRunErrorResponse,
} from "../../../lib/workflow-run-server";
import {
  STORY_SOURCE_WRITE_STATUS,
  abortStorySourceMutation,
  assertFinalizedCorpusQueryBudget,
  beginStorySourceMutation,
  jsonParameterBatches,
  publishFinalizedCorpusSourceMutation,
} from "../../../lib/story-source-publication";

type NormalizedItem = {
  id: string;
  documentId: string;
  sequence: number;
  eventType: string | null;
  actorId: string | null;
  actorType: string | null;
  timestamp: string | null;
  content: string;
  originalJson: string;
  organizationCategory: string | null;
  organizationConfidence: number | null;
  organizationReason: string | null;
};

type NormalizedDocument = {
  id: string;
  kind: "meeting" | "trajectory";
  title: string;
  sourceUser: string | null;
  sourceSystem: string | null;
  sourceTimestamp: string | null;
  itemCount: number;
  metadataJson: string;
  originalEnvelopeJson: string;
  items: NormalizedItem[];
};

export type NormalizedFinalizedCorpus = {
  documents: NormalizedDocument[];
  itemCount: number;
  normalizedBytes: number;
  canonicalPayload: string;
};

export const MAX_CORPUS_DOCUMENTS = 2_000;
export const MAX_CORPUS_ITEMS = 25_000;
export const MAX_CORPUS_REQUEST_BYTES = 64_000_000;
export const MAX_CORPUS_NORMALIZED_BYTES = 64_000_000;
export const MAX_CORPUS_CONTENT_BYTES = 400_000;
export const MAX_CORPUS_ORIGINAL_JSON_BYTES = 600_000;
export const MAX_CORPUS_DOCUMENT_JSON_BYTES = 750_000;

const MAX_ID_BYTES = 300;
const MAX_TITLE_BYTES = 4_096;
const MAX_OPTIONAL_TEXT_BYTES = 16_384;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,299}$/;
const encoder = new TextEncoder();

const TOP_LEVEL_KEYS = new Set(["documents"]);
const CORPUS_DOCUMENT_KEYS = new Set(["document", "items"]);
const DOCUMENT_KEYS = new Set([
  "id", "kind", "title", "sourceUser", "sourceSystem", "sourceTimestamp",
  "metadata", "envelope", "itemCount",
]);
const ITEM_KEYS = new Set([
  "id", "sequence", "eventType", "actorId", "actorType", "timestamp", "content",
  "original", "organizationCategory", "organizationConfidence", "organizationReason",
]);

export class CorpusValidationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 400) {
    super(code);
    this.name = "CorpusValidationError";
    this.code = code;
    this.status = status;
  }
}

function byteLength(value: string) {
  return encoder.encode(value).byteLength;
}

function compareIdentity(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireExactObject(
  value: unknown,
  allowed: ReadonlySet<string>,
  required: readonly string[],
  code: string,
) {
  if (!isRecord(value)
    || Object.keys(value).some((key) => !allowed.has(key))
    || required.some((key) => !Object.hasOwn(value, key))) {
    throw new CorpusValidationError(code);
  }
  return value;
}

export function canonicalCorpusJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CorpusValidationError("CORPUS_JSON_INVALID");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalCorpusJson).join(",")}]`;
  if (!isRecord(value)) throw new CorpusValidationError("CORPUS_JSON_INVALID");
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalCorpusJson(value[key])}`
  )).join(",")}}`;
}

function requiredString(value: unknown, maximumBytes: number, code: string) {
  if (typeof value !== "string" || !value.length || value.includes("\0")
    || byteLength(value) > maximumBytes) {
    throw new CorpusValidationError(code);
  }
  return value;
}

function optionalString(value: unknown, code: string) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.includes("\0")
    || byteLength(value) > MAX_OPTIONAL_TEXT_BYTES) {
    throw new CorpusValidationError(code);
  }
  return value;
}

function validId(value: unknown, code: string) {
  const id = requiredString(value, MAX_ID_BYTES, code);
  if (!ID_PATTERN.test(id) || id !== id.trim()) throw new CorpusValidationError(code);
  return id;
}

function boundedJson(value: unknown, maximumBytes: number, code: string) {
  const serialized = canonicalCorpusJson(value);
  if (byteLength(serialized) > maximumBytes) throw new CorpusValidationError(code, 413);
  return serialized;
}

function normalizedDocumentJson(value: unknown, code: string) {
  if (value === undefined || value === null) return "{}";
  if (!isRecord(value)) throw new CorpusValidationError(code);
  return boundedJson(value, MAX_CORPUS_DOCUMENT_JSON_BYTES, code);
}

function normalizeItem(
  value: unknown,
  documentId: string,
  itemIds: Set<string>,
  sequences: Set<number>,
): NormalizedItem {
  const item = requireExactObject(
    value,
    ITEM_KEYS,
    ["id", "sequence", "content", "original"],
    "CORPUS_ITEM_INVALID",
  );
  const id = validId(item.id, "CORPUS_ITEM_ID_INVALID");
  if (itemIds.has(id)) throw new CorpusValidationError("CORPUS_ITEM_ID_DUPLICATE");
  itemIds.add(id);
  const sequence = item.sequence;
  if (!Number.isSafeInteger(sequence) || Number(sequence) < 1) {
    throw new CorpusValidationError("CORPUS_ITEM_SEQUENCE_INVALID");
  }
  if (sequences.has(Number(sequence))) {
    throw new CorpusValidationError("CORPUS_ITEM_SEQUENCE_AMBIGUOUS");
  }
  sequences.add(Number(sequence));
  const content = typeof item.content === "string" ? item.content : null;
  if (content === null || byteLength(content) > MAX_CORPUS_CONTENT_BYTES) {
    throw new CorpusValidationError("CORPUS_ITEM_CONTENT_INVALID", content === null ? 400 : 413);
  }
  const originalJson = boundedJson(
    item.original,
    MAX_CORPUS_ORIGINAL_JSON_BYTES,
    "CORPUS_ITEM_ORIGINAL_TOO_LARGE",
  );
  const original = item.original;
  const originalEventId = isRecord(original) ? original.event_id : undefined;
  const originalTrajectoryId = isRecord(original) ? original.trajectory_id : undefined;
  const eventOwned = typeof originalEventId === "string"
    && originalEventId === id
    && typeof originalTrajectoryId === "string"
    && originalTrajectoryId === documentId;
  const qualifiedRecordOwned = originalEventId === undefined && id.startsWith(`${documentId}:`);
  if (!eventOwned && !qualifiedRecordOwned) {
    throw new CorpusValidationError("CORPUS_ITEM_OWNERSHIP_INVALID");
  }
  const organizationConfidence = item.organizationConfidence;
  if (organizationConfidence !== undefined && organizationConfidence !== null
    && (typeof organizationConfidence !== "number"
      || !Number.isFinite(organizationConfidence)
      || organizationConfidence < 0
      || organizationConfidence > 100)) {
    throw new CorpusValidationError("CORPUS_ITEM_ORGANIZATION_INVALID");
  }
  return {
    id,
    documentId,
    sequence: Number(sequence),
    eventType: optionalString(item.eventType, "CORPUS_ITEM_EVENT_TYPE_INVALID"),
    actorId: optionalString(item.actorId, "CORPUS_ITEM_ACTOR_INVALID"),
    actorType: optionalString(item.actorType, "CORPUS_ITEM_ACTOR_INVALID"),
    timestamp: optionalString(item.timestamp, "CORPUS_ITEM_TIMESTAMP_INVALID"),
    content,
    originalJson,
    organizationCategory: optionalString(
      item.organizationCategory,
      "CORPUS_ITEM_ORGANIZATION_INVALID",
    ),
    organizationConfidence: organizationConfidence === undefined || organizationConfidence === null
      ? null
      : organizationConfidence,
    organizationReason: optionalString(
      item.organizationReason,
      "CORPUS_ITEM_ORGANIZATION_INVALID",
    ),
  };
}

export function normalizeFinalizedCorpus(
  value: unknown,
  requestBytes = byteLength(JSON.stringify(value)),
): NormalizedFinalizedCorpus {
  if (!Number.isSafeInteger(requestBytes) || requestBytes < 0
    || requestBytes > MAX_CORPUS_REQUEST_BYTES) {
    throw new CorpusValidationError("CORPUS_REQUEST_TOO_LARGE", 413);
  }
  const body = requireExactObject(
    value,
    TOP_LEVEL_KEYS,
    ["documents"],
    "CORPUS_PAYLOAD_INVALID",
  );
  if (!Array.isArray(body.documents) || body.documents.length < 1) {
    throw new CorpusValidationError("CORPUS_DOCUMENTS_REQUIRED");
  }
  if (body.documents.length > MAX_CORPUS_DOCUMENTS) {
    throw new CorpusValidationError("CORPUS_DOCUMENT_LIMIT_EXCEEDED", 413);
  }
  const documentIds = new Set<string>();
  const itemIds = new Set<string>();
  let itemCount = 0;
  const documents = body.documents.map((entryValue) => {
    const entry = requireExactObject(
      entryValue,
      CORPUS_DOCUMENT_KEYS,
      ["document", "items"],
      "CORPUS_DOCUMENT_ENTRY_INVALID",
    );
    const document = requireExactObject(
      entry.document,
      DOCUMENT_KEYS,
      ["id", "kind", "title", "itemCount"],
      "CORPUS_DOCUMENT_INVALID",
    );
    const id = validId(document.id, "CORPUS_DOCUMENT_ID_INVALID");
    if (documentIds.has(id)) throw new CorpusValidationError("CORPUS_DOCUMENT_ID_DUPLICATE");
    documentIds.add(id);
    if (document.kind !== "meeting" && document.kind !== "trajectory") {
      throw new CorpusValidationError("CORPUS_DOCUMENT_KIND_INVALID");
    }
    if (!Array.isArray(entry.items)) throw new CorpusValidationError("CORPUS_ITEMS_INVALID");
    if (!Number.isSafeInteger(document.itemCount)
      || Number(document.itemCount) !== entry.items.length) {
      throw new CorpusValidationError("CORPUS_DOCUMENT_ITEM_COUNT_MISMATCH");
    }
    itemCount += entry.items.length;
    if (itemCount > MAX_CORPUS_ITEMS) {
      throw new CorpusValidationError("CORPUS_ITEM_LIMIT_EXCEEDED", 413);
    }
    const sequences = new Set<number>();
    const items = entry.items.map((item) => normalizeItem(item, id, itemIds, sequences));
    items.sort((left, right) => left.sequence - right.sequence || compareIdentity(left.id, right.id));
    return {
      id,
      kind: document.kind,
      title: requiredString(document.title, MAX_TITLE_BYTES, "CORPUS_DOCUMENT_TITLE_INVALID"),
      sourceUser: optionalString(document.sourceUser, "CORPUS_DOCUMENT_SOURCE_INVALID"),
      sourceSystem: optionalString(document.sourceSystem, "CORPUS_DOCUMENT_SOURCE_INVALID"),
      sourceTimestamp: optionalString(document.sourceTimestamp, "CORPUS_DOCUMENT_SOURCE_INVALID"),
      itemCount: items.length,
      metadataJson: normalizedDocumentJson(document.metadata, "CORPUS_DOCUMENT_METADATA_INVALID"),
      originalEnvelopeJson: normalizedDocumentJson(
        document.envelope,
        "CORPUS_DOCUMENT_ENVELOPE_INVALID",
      ),
      items,
    } satisfies NormalizedDocument;
  });
  documents.sort((left, right) => compareIdentity(left.id, right.id));
  const canonicalPayload = canonicalCorpusJson({ documents });
  const normalizedBytes = byteLength(canonicalPayload);
  if (normalizedBytes > MAX_CORPUS_NORMALIZED_BYTES) {
    throw new CorpusValidationError("CORPUS_NORMALIZED_PAYLOAD_TOO_LARGE", 413);
  }
  return { documents, itemCount, normalizedBytes, canonicalPayload };
}

export async function finalizedCorpusDigest(corpus: NormalizedFinalizedCorpus) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(corpus.canonicalPayload));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function corpusErrorResponse(error: unknown) {
  if (error instanceof CorpusValidationError) {
    return Response.json({ error: "Invalid finalized corpus", code: error.code }, { status: error.status });
  }
  return null;
}

export async function GET() {
  const db = await getD1();
  const authority = await requireEstablishedWorkflowRun(db);
  if (authority.state !== WORKFLOW_RUN_AUTHORITY.exactRun) {
    return workflowRunErrorResponse(authority);
  }
  const { results } = await db.prepare(
    `SELECT id,kind,title,source_user,source_system,source_timestamp,item_count,
            updated_at,organization_status,formatted_summary_json
       FROM documents ORDER BY source_timestamp,title`
  ).all();
  return Response.json({ documents: results.map((document: Record<string, unknown>) => ({
    ...document,
    formatted_summary: JSON.parse(String(document.formatted_summary_json || "{}")),
    formatted_summary_json: undefined,
  })) });
}

export async function POST(request: Request) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CORPUS_REQUEST_BYTES) {
    return Response.json({
      error: "Invalid finalized corpus",
      code: "CORPUS_REQUEST_TOO_LARGE",
    }, { status: 413 });
  }
  let serialized: string;
  try {
    serialized = await request.text();
  } catch {
    return Response.json({ error: "Invalid finalized corpus", code: "CORPUS_PAYLOAD_INVALID" }, {
      status: 400,
    });
  }
  const requestBytes = byteLength(serialized);
  if (requestBytes > MAX_CORPUS_REQUEST_BYTES) {
    return Response.json({
      error: "Invalid finalized corpus",
      code: "CORPUS_REQUEST_TOO_LARGE",
    }, { status: 413 });
  }
  let corpus: NormalizedFinalizedCorpus;
  try {
    corpus = normalizeFinalizedCorpus(JSON.parse(serialized), requestBytes);
  } catch (error) {
    return corpusErrorResponse(error) || Response.json({
      error: "Invalid finalized corpus",
      code: "CORPUS_PAYLOAD_INVALID",
    }, { status: 400 });
  }
  let documentPayloads: string[];
  let itemPayloads: string[];
  try {
    documentPayloads = jsonParameterBatches(corpus.documents.map((document) => ({
      id: document.id,
      kind: document.kind,
      title: document.title,
      sourceUser: document.sourceUser,
      sourceSystem: document.sourceSystem,
      sourceTimestamp: document.sourceTimestamp,
      itemCount: document.itemCount,
      metadataJson: document.metadataJson,
      originalEnvelopeJson: document.originalEnvelopeJson,
    })));
    itemPayloads = jsonParameterBatches(corpus.documents.flatMap((document) => document.items));
    assertFinalizedCorpusQueryBudget(7 + documentPayloads.length + itemPayloads.length);
  } catch (error) {
    const bounded = corpusErrorResponse(error);
    if (bounded) return bounded;
    return Response.json({
      error: "Finalized corpus exceeds the D1 replacement bounds",
      code: "CORPUS_D1_BOUNDS_EXCEEDED",
    }, { status: 413 });
  }
  const corpusDigest = await finalizedCorpusDigest(corpus);
  const db = await getD1();
  const authority = await requireEstablishedWorkflowRun(db);
  if (authority.state !== WORKFLOW_RUN_AUTHORITY.exactRun) {
    return workflowRunErrorResponse(authority);
  }
  const now = new Date().toISOString();
  if (!await beginStorySourceMutation(db, authority.workflowRunId, now)) {
    return Response.json({ error: "Another Story source mutation is already running" }, { status: 409 });
  }
  let leasedRevision: number | undefined;
  try {
    const sourceAuthority = await db.prepare(`SELECT r.story_source_revision,
        COALESCE(m.corpus_revision,0) AS corpus_revision
      FROM workflow_runs r LEFT JOIN finalized_corpus_manifests m ON m.workflow_run_id=r.id
      WHERE r.id=? AND r.story_generation_status IN (?,?)`)
      .bind(
        authority.workflowRunId,
        STORY_SOURCE_WRITE_STATUS.idle,
        STORY_SOURCE_WRITE_STATUS.resumeGeneration,
      ).first<{ story_source_revision: number; corpus_revision: number }>();
    if (!sourceAuthority
      || !Number.isSafeInteger(Number(sourceAuthority.story_source_revision))
      || !Number.isSafeInteger(Number(sourceAuthority.corpus_revision))) {
      throw new Error("Finalized corpus lease authority is unavailable");
    }
    leasedRevision = Number(sourceAuthority.story_source_revision);
    const corpusRevision = Number(sourceAuthority.corpus_revision) + 1;
    const leaseSql = `EXISTS (SELECT 1 FROM workflow_runs
      WHERE id=? AND story_source_revision=? AND story_generation_status IN (?,?))`;
    const leaseBindings = [
      authority.workflowRunId,
      leasedRevision,
      STORY_SOURCE_WRITE_STATUS.idle,
      STORY_SOURCE_WRITE_STATUS.resumeGeneration,
    ];
    const statements: ReturnType<typeof db.prepare>[] = [
      db.prepare(`DELETE FROM items WHERE ${leaseSql}`).bind(...leaseBindings),
      db.prepare(`DELETE FROM documents WHERE ${leaseSql}`).bind(...leaseBindings),
    ];
    for (const payload of documentPayloads) {
      statements.push(db.prepare(`INSERT INTO documents
        (id,kind,title,source_user,source_system,source_timestamp,item_count,metadata_json,
         original_envelope_json,imported_at,updated_at,organization_status,formatted_summary_json)
        SELECT json_extract(value,'$.id'),json_extract(value,'$.kind'),
          json_extract(value,'$.title'),json_extract(value,'$.sourceUser'),
          json_extract(value,'$.sourceSystem'),json_extract(value,'$.sourceTimestamp'),
          json_extract(value,'$.itemCount'),json_extract(value,'$.metadataJson'),
          json_extract(value,'$.originalEnvelopeJson'),?,?,'pending','{}'
        FROM json_each(?) WHERE ${leaseSql}`)
        .bind(now, now, payload, ...leaseBindings));
    }
    for (const payload of itemPayloads) {
      statements.push(db.prepare(`INSERT INTO items
        (id,document_id,sequence,event_type,actor_id,actor_type,timestamp,content,original_json,
         organization_category,organization_confidence,organization_reason)
        SELECT json_extract(value,'$.id'),json_extract(value,'$.documentId'),
          json_extract(value,'$.sequence'),json_extract(value,'$.eventType'),
          json_extract(value,'$.actorId'),json_extract(value,'$.actorType'),
          json_extract(value,'$.timestamp'),json_extract(value,'$.content'),
          json_extract(value,'$.originalJson'),json_extract(value,'$.organizationCategory'),
          json_extract(value,'$.organizationConfidence'),json_extract(value,'$.organizationReason')
        FROM json_each(?) WHERE ${leaseSql}`)
        .bind(payload, ...leaseBindings));
    }
    statements.push(
      db.prepare(`DELETE FROM organization_jobs WHERE ${leaseSql}`).bind(...leaseBindings),
      db.prepare(`UPDATE redaction_jobs
          SET status='stale',stage='source_changed',completed_at=NULL,updated_at=?
        WHERE status!='stale' AND ${leaseSql}`).bind(now, ...leaseBindings),
      db.prepare(`DELETE FROM finalized_corpus_manifests
        WHERE workflow_run_id=? AND ${leaseSql}`)
        .bind(authority.workflowRunId, ...leaseBindings),
      db.prepare(`INSERT INTO finalized_corpus_manifests
        (workflow_run_id,corpus_revision,corpus_digest,document_count,item_count,finalized_at)
        SELECT ?,?,?,?,?,? WHERE ${leaseSql}`).bind(
        authority.workflowRunId,
        corpusRevision,
        corpusDigest,
        corpus.documents.length,
        corpus.itemCount,
        now,
        ...leaseBindings,
      ),
    );
    if (!await publishFinalizedCorpusSourceMutation(
      db,
      statements,
      authority.workflowRunId,
      leasedRevision,
      corpusRevision,
      corpusDigest,
      corpus.documents.length,
      corpus.itemCount,
      now,
    )) {
      throw new Error("Finalized corpus publication boundary changed during replacement");
    }
    return Response.json({
      finalized: true,
      corpusRevision,
      corpusDigest,
      documentCount: corpus.documents.length,
      itemCount: corpus.itemCount,
    });
  } catch (error) {
    await abortStorySourceMutation(db, authority.workflowRunId, now, leasedRevision);
    throw error;
  }
}
