import { getLocalDatabase } from "../../../db";
import {
  WORKFLOW_RUN_AUTHORITY,
  requireEstablishedWorkflowRun,
  workflowRunErrorResponse,
} from "../../../lib/workflow-run-server";
import {
  STORY_SOURCE_WRITE_STATUS,
  abortStorySourceMutation,
  beginStorySourceMutation,
  isStorySourceWriteInProgress,
  publishFinalizedCorpusSourceMutation,
} from "../../../lib/story-source-publication";
import { validActivatedSourceRevision } from "../../../lib/authority-validation.mjs";

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
  canonicalPayload: string;
};

const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,299}$/;
const encoder = new TextEncoder();

const TOP_LEVEL_KEYS = new Set(["documents"]);
const CORPUS_DOCUMENT_KEYS = new Set(["document", "items"]);
const DOCUMENT_KEYS = new Set([
  "id", "kind", "title", "sourceUser", "sourceSystem", "sourceTimestamp",
  "metadata", "envelope", "itemCount",
]);
const ITEM_KEYS = new Set([
  "id", "sequence", "eventType", "actorId", "actorType", "timestamp", "content",
  "original",
]);

export class CorpusValidationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CorpusValidationError";
    this.code = code;
  }
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

function requiredString(value: unknown, code: string) {
  if (typeof value !== "string" || !value.length || value.includes("\0")) {
    throw new CorpusValidationError(code);
  }
  return value;
}

function optionalString(value: unknown, code: string) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.includes("\0")) {
    throw new CorpusValidationError(code);
  }
  return value;
}

function validDocumentId(value: unknown, code: string) {
  const id = requiredString(value, code);
  if (!DOCUMENT_ID_PATTERN.test(id) || id !== id.trim()) throw new CorpusValidationError(code);
  return id;
}

function validItemId(value: unknown, code: string) {
  const id = requiredString(value, code);
  if (!ITEM_ID_PATTERN.test(id) || id !== id.trim()) throw new CorpusValidationError(code);
  return id;
}

function normalizedDocumentJson(value: unknown, code: string) {
  if (value === undefined || value === null) return "{}";
  if (!isRecord(value)) throw new CorpusValidationError(code);
  return canonicalCorpusJson(value);
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
  const id = validItemId(item.id, "CORPUS_ITEM_ID_INVALID");
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
  if (content === null) throw new CorpusValidationError("CORPUS_ITEM_CONTENT_INVALID");
  const originalJson = canonicalCorpusJson(item.original);
  const original = item.original;
  const originalEventId = isRecord(original) ? original.event_id : undefined;
  const originalTrajectoryId = isRecord(original) ? original.trajectory_id : undefined;
  const eventOwned = typeof originalEventId === "string"
    && originalEventId === id
    && typeof originalTrajectoryId === "string"
    && originalTrajectoryId === documentId;
  const qualifiedRecordOwned = originalEventId === undefined
    && (originalTrajectoryId === undefined || originalTrajectoryId === documentId)
    && id.startsWith(`${documentId}:`);
  if (!eventOwned && !qualifiedRecordOwned) {
    throw new CorpusValidationError("CORPUS_ITEM_OWNERSHIP_INVALID");
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
  };
}

export function normalizeFinalizedCorpus(value: unknown): NormalizedFinalizedCorpus {
  const body = requireExactObject(
    value,
    TOP_LEVEL_KEYS,
    ["documents"],
    "CORPUS_PAYLOAD_INVALID",
  );
  if (!Array.isArray(body.documents) || body.documents.length < 1) {
    throw new CorpusValidationError("CORPUS_DOCUMENTS_REQUIRED");
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
    const id = validDocumentId(document.id, "CORPUS_DOCUMENT_ID_INVALID");
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
    const sequences = new Set<number>();
    const items = entry.items.map((item) => normalizeItem(item, id, itemIds, sequences));
    items.sort((left, right) => left.sequence - right.sequence || compareIdentity(left.id, right.id));
    return {
      id,
      kind: document.kind,
      title: requiredString(document.title, "CORPUS_DOCUMENT_TITLE_INVALID"),
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
  return { documents, itemCount, canonicalPayload };
}

export async function finalizedCorpusDigest(corpus: NormalizedFinalizedCorpus) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(corpus.canonicalPayload));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function corpusErrorResponse(error: unknown) {
  if (error instanceof CorpusValidationError) {
    return Response.json({ error: "Invalid finalized corpus", code: error.code }, { status: 400 });
  }
  return null;
}

async function exactCurrentCorpusResponse(
  db: Awaited<ReturnType<typeof getLocalDatabase>>,
  workflowRunId: string,
  corpus: NormalizedFinalizedCorpus,
  corpusDigest: string,
) {
  return db.transaction(async () => {
    const source = await db.prepare(`SELECT r.story_generation_status,r.story_source_revision,
        m.corpus_revision,m.corpus_digest,m.document_count,m.item_count
      FROM workflow_runs r LEFT JOIN finalized_corpus_manifests m ON m.workflow_run_id=r.id
      WHERE r.id=?`).bind(workflowRunId).first<Record<string, unknown>>();
    if (!source || isStorySourceWriteInProgress(source.story_generation_status)
      || !validActivatedSourceRevision(Number(source.story_source_revision))
      || !validActivatedSourceRevision(Number(source.corpus_revision))
      || source.corpus_digest !== corpusDigest
      || Number(source.document_count) !== corpus.documents.length
      || Number(source.item_count) !== corpus.itemCount) return null;
    const [{ results: documentRows }, { results: itemRows }] = await Promise.all([
      db.prepare(`SELECT id,kind,title,source_user,source_system,source_timestamp,item_count,
          metadata_json,original_envelope_json FROM documents ORDER BY id`)
        .all<Record<string, unknown>>(),
      db.prepare(`SELECT id,document_id,sequence,event_type,actor_id,actor_type,timestamp,
          content,original_json FROM items ORDER BY id`).all<Record<string, unknown>>(),
    ]);
    if (Number(source.document_count) !== documentRows.length
      || Number(source.item_count) !== itemRows.length) return null;
    try {
      const itemsByDocument = new Map<string, Record<string, unknown>[]>();
      for (const row of itemRows) {
        const documentId = String(row.document_id);
        const items = itemsByDocument.get(documentId) || [];
        items.push(row);
        itemsByDocument.set(documentId, items);
      }
      const storedDocumentIds = new Set(documentRows.map((row) => String(row.id)));
      if (documentRows.some((row) => !itemsByDocument.has(String(row.id))
        && Number(row.item_count) !== 0)
        || [...itemsByDocument].some(([documentId]) => !storedDocumentIds.has(documentId))) return null;
      const stored = normalizeFinalizedCorpus({
        documents: documentRows.map((row) => ({
          document: {
            id: row.id,
            kind: row.kind,
            title: row.title,
            sourceUser: row.source_user,
            sourceSystem: row.source_system,
            sourceTimestamp: row.source_timestamp,
            metadata: JSON.parse(String(row.metadata_json)),
            envelope: JSON.parse(String(row.original_envelope_json)),
            itemCount: Number(row.item_count),
          },
          items: (itemsByDocument.get(String(row.id)) || []).map((item) => ({
            id: item.id,
            sequence: Number(item.sequence),
            eventType: item.event_type,
            actorId: item.actor_id,
            actorType: item.actor_type,
            timestamp: item.timestamp,
            content: item.content,
            original: JSON.parse(String(item.original_json)),
          })),
        })),
      });
      const storedDocuments = new Map(stored.documents.map((document) => [document.id, document]));
      if (documentRows.some((row) => {
        const document = storedDocuments.get(String(row.id));
        return !document
          || row.metadata_json !== document.metadataJson
          || row.original_envelope_json !== document.originalEnvelopeJson;
      })) return null;
      const storedItems = new Map(stored.documents.flatMap((document) => (
        document.items.map((item) => [item.id, item] as const)
      )));
      if (itemRows.some((row) => row.original_json !== storedItems.get(String(row.id))?.originalJson)) {
        return null;
      }
      const storedDigest = await finalizedCorpusDigest(stored);
      if (stored.canonicalPayload !== corpus.canonicalPayload
        || storedDigest !== corpusDigest
        || source.corpus_digest !== storedDigest) return null;
      return {
        finalized: true,
        corpusRevision: Number(source.corpus_revision),
        corpusDigest: storedDigest,
        documentCount: stored.documents.length,
        itemCount: stored.itemCount,
      };
    } catch (error) {
      if (error instanceof CorpusValidationError || error instanceof SyntaxError) return null;
      throw error;
    }
  });
}

export async function GET() {
  const db = await getLocalDatabase();
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
  let corpus: NormalizedFinalizedCorpus;
  try {
    corpus = normalizeFinalizedCorpus(await request.json());
  } catch (error) {
    return corpusErrorResponse(error) || Response.json({
      error: "Invalid finalized corpus",
      code: "CORPUS_PAYLOAD_INVALID",
    }, { status: 400 });
  }
  const documentPayload = JSON.stringify(corpus.documents.map((document) => ({
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
  const itemPayload = JSON.stringify(corpus.documents.flatMap((document) => document.items));
  const corpusDigest = await finalizedCorpusDigest(corpus);
  const db = await getLocalDatabase();
  const authority = await requireEstablishedWorkflowRun(db);
  if (authority.state !== WORKFLOW_RUN_AUTHORITY.exactRun) {
    return workflowRunErrorResponse(authority);
  }
  const current = await exactCurrentCorpusResponse(
    db,
    authority.workflowRunId,
    corpus,
    corpusDigest,
  );
  if (current) return Response.json(current);
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
      db.prepare(`INSERT INTO documents
        (id,kind,title,source_user,source_system,source_timestamp,item_count,metadata_json,
         original_envelope_json,imported_at,updated_at,organization_status,formatted_summary_json)
        SELECT json_extract(value,'$.id'),json_extract(value,'$.kind'),
          json_extract(value,'$.title'),json_extract(value,'$.sourceUser'),
          json_extract(value,'$.sourceSystem'),json_extract(value,'$.sourceTimestamp'),
          json_extract(value,'$.itemCount'),json_extract(value,'$.metadataJson'),
          json_extract(value,'$.originalEnvelopeJson'),?,?,'pending','{}'
        FROM json_each(?) WHERE ${leaseSql}`)
        .bind(now, now, documentPayload, ...leaseBindings),
      db.prepare(`INSERT INTO items
        (id,document_id,sequence,event_type,actor_id,actor_type,timestamp,content,original_json)
        SELECT json_extract(value,'$.id'),json_extract(value,'$.documentId'),
          json_extract(value,'$.sequence'),json_extract(value,'$.eventType'),
          json_extract(value,'$.actorId'),json_extract(value,'$.actorType'),
          json_extract(value,'$.timestamp'),json_extract(value,'$.content'),
          json_extract(value,'$.originalJson')
        FROM json_each(?) WHERE ${leaseSql}`)
        .bind(itemPayload, ...leaseBindings),
    ];
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
