const text = (value) => String(value ?? "");

export function canonicalSourceRows(rows) {
  return [...(rows || [])]
    .map((row) => ({
      document_id: text(row.document_id),
      id: text(row.id),
      sequence: Number(row.sequence || 0),
      event_type: text(row.event_type),
      actor_type: text(row.actor_type),
      timestamp: row.timestamp == null ? null : text(row.timestamp),
      content: text(row.content),
    }))
    .sort((a, b) => a.document_id.localeCompare(b.document_id)
      || a.sequence - b.sequence || a.id.localeCompare(b.id));
}

export async function computeSourceDigest(rows) {
  const encoded = new TextEncoder().encode(JSON.stringify(canonicalSourceRows(rows)));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

/** Compare one import batch with the source-bearing fields already reviewed.
 * Organization labels, Story metadata, and original envelopes are deliberately
 * outside the redaction source identity, so a source-equivalent reattach can
 * retain a completed Privacy pass. */
export function sourceImportMatchesExisting(existingRows, documentId, incomingItems) {
  if (!Array.isArray(existingRows) || !Array.isArray(incomingItems)
      || existingRows.length !== incomingItems.length) return false;
  const incomingRows = incomingItems.map((item) => ({
    document_id: documentId,
    id: item?.id,
    sequence: item?.sequence,
    event_type: item?.eventType,
    actor_id: item?.actorId,
    actor_type: item?.actorType,
    timestamp: item?.timestamp,
    content: item?.content,
  }));
  const expected = canonicalSourceRows(incomingRows);
  const actual = canonicalSourceRows(existingRows);
  const actorIdentity = (rows) => rows.map((row) => ({
    document_id: text(row.document_id),
    id: text(row.id),
    actor_id: text(row.actor_id),
  })).sort((a, b) => a.document_id.localeCompare(b.document_id) || a.id.localeCompare(b.id));
  return JSON.stringify(actual) === JSON.stringify(expected)
    && JSON.stringify(actorIdentity(existingRows)) === JSON.stringify(actorIdentity(incomingRows));
}

export function finalRedactionStatus({ requestedStatus, completed, total, rejected, sourceDigest }) {
  const complete = requestedStatus === "complete"
    && Number.isInteger(completed) && completed >= 0
    && Number.isInteger(total) && total >= 0
    && completed === total
    && Number.isInteger(rejected) && rejected === 0
    && Boolean(sourceDigest);
  if (complete) return "complete";
  return requestedStatus === "complete" ? "incomplete" : "running";
}

export function partitionPersistableRedactions(spans) {
  const persistable = [];
  const duplicates = [];
  const ids = new Set();
  for (const span of spans || []) {
    if (span.id && ids.has(span.id)) {
      duplicates.push(span);
      continue;
    }
    if (span.id) ids.add(span.id);
    persistable.push(span);
  }
  return { persistable, duplicates };
}

const persistedReviewStates = new Set([
  "deterministic", "needs_confirmation", "confirmed_keep", "confirmed_redact",
]);

function redactionReviewReleaseError(redactions) {
  let pending = false;
  for (const row of redactions || []) {
    const reviewState = row?.review_state == null ? "" : String(row.review_state);
    const status = String(row?.status || "");
    if (!persistedReviewStates.has(reviewState)) {
      return "AI redaction review state is missing or invalid; rerun Privacy before release";
    }
    const expectedStatus = reviewState === "confirmed_keep" ? "removed" : "active";
    if (status !== expectedStatus) return "AI redaction review state is inconsistent";
    if (reviewState === "needs_confirmation") pending = true;
  }
  return pending
    ? "AI redaction requires contributor confirmation before release"
    : null;
}

export function redactionReleaseError(job, currentSourceDigest, redactions = []) {
  if (!job) return "AI redaction must complete before the contribution ZIP can be built";
  if (Number(job.rejected || 0) > 0) {
    return "AI redaction contains rejected spans; resolve or rerun it before export";
  }
  if (job.status !== "complete") {
    return "AI redaction must complete before the contribution ZIP can be built";
  }
  const completed = Number(job.completed);
  const total = Number(job.total);
  if (!Number.isInteger(completed) || !Number.isInteger(total)
      || completed < 0 || total < 0 || completed !== total) {
    return "AI redaction is incomplete; completed and total counts do not match";
  }
  if (!job.source_digest) {
    return "AI redaction source identity is missing; rerun redaction before export";
  }
  if (job.source_digest !== currentSourceDigest) {
    return "AI redaction source changed after review; rerun redaction before export";
  }
  return redactionReviewReleaseError(redactions);
}
