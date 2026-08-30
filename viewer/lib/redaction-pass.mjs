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

export function redactionReleaseError(
  job,
  currentSourceDigest,
  redactions = [],
  currentSourceRevision,
) {
  if (!job) return "AI redaction must complete before the contribution ZIP can be built";
  const rejected = Number(job.rejected);
  if (!Number.isSafeInteger(rejected) || rejected !== 0) {
    return "AI redaction contains rejected spans; resolve or rerun it before export";
  }
  if (job.status !== "complete") {
    return "AI redaction must complete before the contribution ZIP can be built";
  }
  const completed = Number(job.completed);
  const total = Number(job.total);
  if (!Number.isSafeInteger(completed) || !Number.isSafeInteger(total)
      || completed < 0 || total < 0 || completed !== total
      || completed !== redactions.length) {
    return "AI redaction is incomplete; completed and total counts do not match";
  }
  if (!job.source_digest) {
    return "AI redaction source identity is missing; rerun redaction before export";
  }
  if (!Number.isSafeInteger(job.source_revision) || job.source_revision <= 0
      || !/^[0-9a-f]{64}$/u.test(String(job.receipt_digest || ""))
      || (currentSourceRevision !== undefined
        && (!Number.isSafeInteger(currentSourceRevision) || currentSourceRevision <= 0
          || job.source_revision > currentSourceRevision))) {
    return "AI redaction source receipt is missing or stale; rerun redaction before export";
  }
  if (job.source_digest !== currentSourceDigest) {
    return "AI redaction source changed after review; rerun redaction before export";
  }
  return redactionReviewReleaseError(redactions);
}
