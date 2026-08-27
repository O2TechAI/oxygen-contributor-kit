"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { resolveEvidenceTarget } from "../lib/timeline";

// Rows are mounted a page at a time as the sentinel scrolls into view. Row
// heights vary by two orders of magnitude here (a one-line status event next to
// a multi-kilobyte artifact), so a fixed-height window would mis-size the
// scrollbar badly; bounding how much is mounted keeps the cost predictable
// without pretending every row is the same size. Off-screen rows that are
// mounted are skipped by the engine via `content-visibility` in the stylesheet.
const PAGE_SIZE = 60;

export type Redaction = {
  id: string; item_id: string; document_id: string;
  start_offset: number; end_offset: number;
  category: string; status: string;
  review_state: "deterministic" | "needs_confirmation" | "confirmed_keep" | "confirmed_redact";
  uncertainty_reason?: string | null;
};
export type RedactionJob = {
  status: string; stage: string;
  completed: number; total: number; rejected: number;
} | null;
type Item = {
  id: string; sequence: number; event_type?: string;
  timestamp?: string; content: string;
};
type Detail = { document: { id: string; title: string }; items: Item[] } | null;

const fmt = (value?: string) => value
  ? new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })
  : "no timestamp";

/** Split one event into safe text and redacted spans, in offset order. */
export function segments(content: string, spans: Redaction[], masked: boolean): ReactNode[] {
  const ordered = [...spans].sort((a, b) => a.start_offset - b.start_offset);
  // Python workers and SQLite length() use Unicode code-point offsets. JS
  // String.slice() uses UTF-16 code units, so split first to keep spans aligned
  // when emoji or other astral characters appear before a redaction.
  const points = Array.from(content);
  const out: ReactNode[] = [];
  let cursor = 0;
  ordered.forEach((span) => {
    if (span.start_offset > cursor) {
      out.push(<span key={`safe-${cursor}`}>{points.slice(cursor, span.start_offset).join("")}</span>);
    }
    out.push(masked
      ? <span key={`tag-${span.id}`} className="redactedReplacement">
          &lt;redacted&gt;
        </span>
      : <mark key={`hit-${span.id}`} className="redactionHit">
          {points.slice(span.start_offset, span.end_offset).join("")}
        </mark>);
    cursor = Math.max(cursor, span.end_offset);
  });
  if (cursor < points.length) {
    out.push(<span key={`safe-${cursor}`}>{points.slice(cursor).join("")}</span>);
  }
  return out;
}

export function RedactionCompare(props: {
  job: RedactionJob;
  redactions: Redaction[];
  detail: Detail;
  isProject: boolean;
  focusItemId?: string;
  busyId: string;
  onDecision: (id: string, decision: "keep" | "redact") => void;
}) {
  const { job, redactions, detail, isProject, focusItemId, busyId, onDecision } = props;

  const allItems = detail?.items || [];
  const documentId = detail?.document.id;
  const [pagination, setPagination] = useState({ documentId, limit: PAGE_SIZE });
  const limit = pagination.documentId === documentId ? pagination.limit : PAGE_SIZE;
  const sentinel = useRef<HTMLDivElement | null>(null);

  const focusResolution = focusItemId ? resolveEvidenceTarget(allItems, focusItemId) : null;
  const focusIndex = focusResolution?.status === "resolved" ? focusResolution.index : -1;
  const resolvedFocusId = focusResolution?.status === "resolved" ? focusResolution.itemId : "";
  const visibleLimit = focusIndex >= 0 ? Math.max(limit, focusIndex + 1) : limit;

  useEffect(() => {
    if (!focusItemId || focusIndex < 0 || focusIndex >= visibleLimit) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(`source-event-${resolvedFocusId}`);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusItemId, focusIndex, resolvedFocusId, visibleLimit, documentId]);

  useEffect(() => {
    if (limit >= allItems.length) return;
    const node = sentinel.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) {
        setPagination((current) => ({
          documentId,
          limit: Math.min(
            current.documentId === documentId ? current.limit + PAGE_SIZE : PAGE_SIZE * 2,
            allItems.length,
          ),
        }));
      }
    }, { rootMargin: "800px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [limit, allItems.length, documentId]);

  if (job && job.status === "running") {
    const percent = job.total ? Math.round((job.completed / job.total) * 100) : 0;
    return <div className="redactionPanel">
      <h2>Redaction pass running…</h2>
      <p className="redactionMuted">
        {job.completed}/{job.total} checked ({percent}%)
      </p>
      <div className="redactionBar"><span style={{ width: `${percent}%` }} /></div>
      <p className="redactionMuted">
        This page refreshes on its own and switches to the comparison when the pass finishes.
      </p>
    </div>;
  }

  if (job && (job.status !== "complete" || job.rejected > 0
      || job.completed !== job.total)) {
    return <div className="redactionPanel">
      <h2>Redaction pass is not releasable</h2>
      <p className="redactionNotice">
        Status: {job.status} · stage: {job.stage} · {job.completed}/{job.total} accepted ·
        {" "}{job.rejected} rejected. ZIP export is blocked until a complete,
        source-current pass with zero rejected spans is reviewed.
      </p>
    </div>;
  }

  const notice = <p className="redactionNotice">
    Source Privacy is local and decision-only. Automatically derived and resolved rows show only
    their release-safe projection. Only uncertain rows expose the minimum local excerpt needed for
    one Keep or Redact decision.
  </p>;

  if (isProject || !detail) {
    const byDocument = redactions.reduce<Record<string, number>>((acc, span) => {
      acc[span.document_id] = (acc[span.document_id] || 0) + 1;
      return acc;
    }, {});
    return <div className="redactionPanel">
      <h2>Source Privacy · {redactions.length} finding(s)</h2>
      {notice}
      {redactions.length === 0 && <p className="redactionMuted">
        {job
          ? "The pass completed without a single hit. That can be a correct result, but it can also mean coverage was too thin — sample the records by hand before deciding to publish."
          : "No redaction pass has been run yet."}
      </p>}
      <h3>By source record</h3>
      <ul className="redactionDocs">
        {Object.entries(byDocument).sort((a, b) => b[1] - a[1]).map(([documentId, count]) =>
          <li key={documentId}><code>{documentId}</code><span>{count} finding(s)</span></li>)}
      </ul>
      <p className="redactionMuted">
        Select a source record on the left to review every event it would publish.
      </p>
    </div>;
  }

  const byItem = new Map<string, Redaction[]>();
  redactions.forEach((span) => {
    byItem.set(span.item_id, [...(byItem.get(span.item_id) || []), span]);
  });

  // Fixed action labels are short, safe release information. Pagination keeps
  // large runs bounded while still letting the contributor inspect every row.
  const items = allItems;
  const spanCount = items.reduce((total, item) => total + (byItem.get(item.id)?.length || 0), 0);
  const pendingCount = redactions.filter((span) => span.review_state === "needs_confirmation").length;
  const visible = items.slice(0, visibleLimit);

  return <div className="redactionPanel">
    <h2>
      Source Privacy · {items.length} event(s) · {spanCount} finding(s) · {pendingCount} pending
    </h2>
    {notice}
    {focusItemId && focusResolution?.status !== "resolved" && <p className="redactionNotice" role="alert">
      Exact evidence target {focusResolution?.status === "ambiguous" ? "is ambiguous" : "is missing"}. The reference was not approximated.
    </p>}
    {visible.map((item) => {
      const spans = byItem.get(item.id) || [];
      const pending = spans.filter((span) => span.review_state === "needs_confirmation");
      const releaseSpans = spans.filter((span) => span.status === "active");
      return <article id={`source-event-${item.id}`} tabIndex={item.id===resolvedFocusId?-1:undefined} className={`redactionRow ${spans.length ? "" : "clean"} ${item.id===resolvedFocusId?"sourceFocused":""}`} key={item.id}>
        <div className="redactionMeta">
          #{item.sequence} · {item.event_type || "record"} · {fmt(item.timestamp)} ·
          {" "}{spans.length ? `${spans.length} Privacy finding(s)` : "release-safe as reviewed"}
        </div>
        {spans.length ? <>
          <div className="sourcePrivacyProjection"><h4>Release-safe projection</h4><pre>{segments(item.content, releaseSpans, true)}</pre></div>
          <ul className="sourcePrivacyStatuses" aria-label="Resolved source Privacy status">
            {spans.filter((span) => span.review_state !== "needs_confirmation").map((span) => <li key={span.id}>
              {span.review_state === "deterministic" ? "Automatically redacted"
                : span.review_state === "confirmed_keep" ? "Kept by contributor"
                  : "Redacted by contributor"}
            </li>)}
          </ul>
          {pending.map((span) => <section className="sourcePrivacyDecision" key={span.id} aria-labelledby={`source-privacy-${span.id}`}>
            <h4 id={`source-privacy-${span.id}`}>Needs confirmation</h4>
            <div className="sourcePrivacyComparison">
              <div><b>Minimum local original</b><pre>{Array.from(item.content).slice(span.start_offset, span.end_offset).join("")}</pre></div>
              <div><b>Release-safe projection</b><pre>&lt;redacted&gt;</pre></div>
            </div>
            {span.uncertainty_reason && <p>{span.uncertainty_reason}</p>}
            <div className="sourcePrivacyActions">
              <button disabled={busyId === span.id} onClick={() => onDecision(span.id, "keep")}>Keep</button>
              <button className="primary" disabled={busyId === span.id} onClick={() => onDecision(span.id, "redact")}>Redact</button>
            </div>
          </section>)}
        </> : <pre className="redactionClean">{item.content}</pre>}
      </article>;
    })}
    {limit < items.length && <div ref={sentinel} className="redactionSentinel">
      Showing {limit} of {items.length} events — scroll to load more
    </div>}
  </div>;
}
