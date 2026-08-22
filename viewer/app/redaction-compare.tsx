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
  category: string; confidence?: string; reason?: string;
  status: string; created_by: string;
};
export type RedactionJob = {
  status: string; stage: string; model?: string;
  completed: number; total: number; rejected: number;
} | null;
type Item = {
  id: string; sequence: number; event_type?: string;
  timestamp?: string; content: string;
};
type Detail = { document: { id: string; title: string }; items: Item[] } | null;

const CATEGORIES = [
  "credential",
  "private-personal",
  "sensitive",
  "internal-metric",
  "internal-timeline",
  "mosaic-reidentification",
];

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
          &lt;redacted · {span.category}&gt;
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
  onUpdate: (id: string, patch: { category?: string; status?: string }) => void;
  onDelete: (id: string) => void;
}) {
  const { job, redactions, detail, isProject, focusItemId, busyId, onUpdate, onDelete } = props;

  const allItems = detail?.items || [];
  const documentId = detail?.document.id;
  const [limit, setLimit] = useState(PAGE_SIZE);
  const sentinel = useRef<HTMLDivElement | null>(null);

  // A different record starts from the top again.
  useEffect(() => { setLimit(PAGE_SIZE); }, [documentId]);

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
        setLimit((current) => Math.min(current + PAGE_SIZE, allItems.length));
      }
    }, { rootMargin: "800px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [limit, allItems.length]);

  if (job && job.status === "running") {
    const percent = job.total ? Math.round((job.completed / job.total) * 100) : 0;
    return <div className="redactionPanel">
      <h2>Redaction pass running…</h2>
      <p className="redactionMuted">
        Stage: {job.stage}{job.model ? ` · model ${job.model}` : ""} ·
        {" "}{job.completed}/{job.total} done ({percent}%)
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
    Best-effort redaction v0.1; no formal anonymity guarantee. Original-contributor final review
    is required before release. Every event that would ship is listed below — left column is the
    original, right column is the release version. Editing a category or deleting a span takes
    effect immediately.
  </p>;

  if (isProject || !detail) {
    const byCategory = redactions.reduce<Record<string, number>>((acc, span) => {
      acc[span.category] = (acc[span.category] || 0) + 1;
      return acc;
    }, {});
    const byDocument = redactions.reduce<Record<string, number>>((acc, span) => {
      acc[span.document_id] = (acc[span.document_id] || 0) + 1;
      return acc;
    }, {});
    return <div className="redactionPanel">
      <h2>Redaction overview · {redactions.length} span(s)</h2>
      {notice}
      {redactions.length === 0 && <p className="redactionMuted">
        {job
          ? "The pass completed without a single hit. That can be a correct result, but it can also mean coverage was too thin — sample the records by hand before deciding to publish."
          : "No redaction pass has been run yet."}
      </p>}
      <div className="redactionChips">
        {Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([category, count]) =>
          <span className="redactionChip" key={category}>{category} <b>{count}</b></span>)}
      </div>
      <h3>By source record</h3>
      <ul className="redactionDocs">
        {Object.entries(byDocument).sort((a, b) => b[1] - a[1]).map(([documentId, count]) =>
          <li key={documentId}><code>{documentId}</code><span>{count} span(s)</span></li>)}
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
  const redactedCount = items.filter((item) => byItem.has(item.id)).length;
  const spanCount = items.reduce((total, item) => total + (byItem.get(item.id)?.length || 0), 0);
  const visible = items.slice(0, visibleLimit);

  return <div className="redactionPanel">
    <h2>
      Release preview · {items.length} event(s) · {spanCount} span(s) across {redactedCount} event(s)
    </h2>
    {notice}
    {focusItemId && focusResolution?.status !== "resolved" && <p className="redactionNotice" role="alert">
      Exact evidence target {focusResolution?.status === "ambiguous" ? "is ambiguous" : "is missing"}. The reference was not approximated.
    </p>}
    {visible.map((item) => {
      const spans = byItem.get(item.id) || [];
      return <article id={`source-event-${item.id}`} tabIndex={item.id===resolvedFocusId?-1:undefined} className={`redactionRow ${spans.length ? "" : "clean"} ${item.id===resolvedFocusId?"sourceFocused":""}`} key={item.id}>
        <div className="redactionMeta">
          #{item.sequence} · {item.event_type || "record"} · {fmt(item.timestamp)} ·
          {" "}{spans.length ? `${spans.length} span(s)` : "no redactions"}
        </div>
        {spans.length ? <>
          <div className="redactionCols">
            <div>
              <h4>Original</h4>
              <pre>{segments(item.content, spans, false)}</pre>
            </div>
            <div>
              <h4>Release version</h4>
              <pre>{segments(item.content, spans, true)}</pre>
            </div>
          </div>
          <ul className="redactionSpans">
            {spans.map((span) => <li key={span.id}>
              <select
                value={span.category}
                disabled={busyId === span.id}
                onChange={(event) => onUpdate(span.id, { category: event.target.value })}
              >
                {CATEGORIES.map((category) =>
                  <option key={category} value={category}>{category}</option>)}
              </select>
              <span className="redactionReason">{span.reason || "no reason given"}</span>
              <span className="redactionMuted">{span.confidence || "—"} · {span.created_by}</span>
              <button disabled={busyId === span.id} onClick={() => onDelete(span.id)}>Delete</button>
            </li>)}
          </ul>
        </> : <pre className="redactionClean">{item.content}</pre>}
      </article>;
    })}
    {limit < items.length && <div ref={sentinel} className="redactionSentinel">
      Showing {limit} of {items.length} events — scroll to load more
    </div>}
  </div>;
}
