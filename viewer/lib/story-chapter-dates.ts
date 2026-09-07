import type { StoryLanguage, StorySource } from "./timeline";
import type { WorkspaceDocument } from "./workspace-types";

function calendarDate(value: string | undefined) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value ? value : undefined;
}

function timestampDate(timestamp: string | undefined) {
  return timestamp && /^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/u.test(timestamp)
    && !timestamp.endsWith("-00:00") && Number.isFinite(Date.parse(timestamp))
    ? calendarDate(timestamp.slice(0, 10)) : undefined;
}

function documentDate(document: WorkspaceDocument | undefined) {
  if (!document) return undefined;
  const sourceDate = timestampDate(document.source_timestamp);
  if (sourceDate) return sourceDate;
  if (document.kind !== "meeting" || document.source_system !== "meeting-transcript") return undefined;
  // Transcript identifiers establish a source calendar date, never an event time or time zone.
  const dates = new Set([document.title, document.id].map((value) => calendarDate(
    /(?:^|-)transcript_(\d{4}-\d{2}-\d{2})_\d{2}\.\d{2}\.\d{2}(?:-|\.|$)/u.exec(value)?.[1],
  )).filter((value) => value !== undefined));
  return dates.size === 1 ? [...dates][0] : undefined;
}

/** Local review metadata only. Release content comes from the Privacy projection. */
export function chapterSourceDateLabel(source: Pick<StorySource, "evidence">, documents: WorkspaceDocument[], language: StoryLanguage = "en", primaryAnchor?: { documentId?: string; timestamp?: string }) {
  const documentIds = new Set([source.evidence.primary, ...source.evidence.supporting].map((item) => item.documentId));
  const dates = [...documentIds].map((id) => documentDate(documents.find((document) => document.id === id)));
  const known = dates.filter((date) => date !== undefined).sort();
  const prefix = language === "zh" ? "相关记录日期" : "Source dates";
  const format = (value: string) => new Date(`${value}T00:00:00Z`).toLocaleDateString(
    language === "zh" ? "zh-CN" : "en-US", { dateStyle: "medium", timeZone: "UTC" },
  );
  if (!known.length) {
    const anchorDate = primaryAnchor?.documentId === source.evidence.primary.documentId
      ? timestampDate(primaryAnchor?.timestamp) : undefined;
    return anchorDate ? `${language === "zh" ? "主要证据事件日期" : "Primary event date"} · ${format(anchorDate)}`
      : `${prefix} · ${language === "zh" ? "日期不可用" : "Dates unavailable"}`;
  }
  const first = known[0];
  const last = known[known.length - 1];
  const range = first === last ? format(first) : `${format(first)} – ${format(last)}`;
  const unknown = dates.some((date) => date === undefined) ? ` · ${language === "zh" ? "部分日期不可用" : "Some dates unavailable"}` : "";
  return `${prefix} · ${range}${unknown}`;
}
