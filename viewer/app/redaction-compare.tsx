"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

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
  const out: ReactNode[] = [];
  let cursor = 0;
  ordered.forEach((span) => {
    if (span.start_offset > cursor) {
      out.push(<span key={`safe-${cursor}`}>{content.slice(cursor, span.start_offset)}</span>);
    }
    out.push(masked
      ? <span key={`tag-${span.id}`} className="redactedReplacement">
          &lt;redacted · {span.category}&gt;
        </span>
      : <mark key={`hit-${span.id}`} className="redactionHit">
          {content.slice(span.start_offset, span.end_offset)}
        </mark>);
    cursor = Math.max(cursor, span.end_offset);
  });
  if (cursor < content.length) {
    out.push(<span key={`safe-${cursor}`}>{content.slice(cursor)}</span>);
  }
  return out;
}

export function RedactionCompare(props: {
  job: RedactionJob;
  redactions: Redaction[];
  detail: Detail;
  isProject: boolean;
  busyId: string;
  onUpdate: (id: string, patch: { category?: string; status?: string }) => void;
  onDelete: (id: string) => void;
}) {
  const { job, redactions, detail, isProject, busyId, onUpdate, onDelete } = props;

  const allItems = detail?.items || [];
  const documentId = detail?.document.id;
  const [limit, setLimit] = useState(PAGE_SIZE);
  const sentinel = useRef<HTMLDivElement | null>(null);

  // A different record starts from the top again.
  useEffect(() => { setLimit(PAGE_SIZE); }, [documentId]);

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

  // Action labels carry no content by design — 7k rows of "[artifact]" bury the
  // turns a reviewer actually has to read. They stay in the package; they just
  // do not each get a row.
  const items = allItems.filter((item) => item.event_type !== "action_label");
  const hidden = allItems.length - items.length;
  const redactedCount = items.filter((item) => byItem.has(item.id)).length;
  const spanCount = items.reduce((total, item) => total + (byItem.get(item.id)?.length || 0), 0);
  const visible = items.slice(0, limit);

  return <div className="redactionPanel">
    <h2>
      Release preview · {items.length} conversational event(s) · {spanCount} span(s) across {redactedCount} event(s)
    </h2>
    {hidden > 0 && <p className="redactionMuted">
      {hidden} non-conversational event(s) are in the package as bare action labels and are not
      listed here — they carry no text, no command, no path, and no artifact content.
    </p>}
    {notice}
    {visible.map((item) => {
      const spans = byItem.get(item.id) || [];
      return <article className={`redactionRow ${spans.length ? "" : "clean"}`} key={item.id}>
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
