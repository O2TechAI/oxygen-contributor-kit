const CONVERSATIONAL_TYPES = new Set(["message", "record"]);
const ACTION_LABELS = {
  system: "[system action]",
  tool_call: "[tool call]",
  tool_result: "[tool result]",
  artifact: "[artifact]",
  git: "[version control]",
  version_control: "[version control]",
  agent_event: "[agent event]",
  user_event: "[user event]",
  action_label: "[action]",
};
const SAFE_ACTION_LABELS = new Set(Object.values(ACTION_LABELS));
const SAFE_SOURCE_SYSTEMS = new Set([
  "codex",
  "claude-code",
  "claude-ai-export",
  "meeting-transcript",
  "local-agent-history",
]);

export const codePointLength = (value) => Array.from(String(value ?? "")).length;

const safeCategory = (value) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(String(value || ""))
  ? String(value)
  : "sensitive";

function normalizedActiveSpans(points, spans) {
  return [...(spans || [])]
    .filter((span) => !span.status || span.status === "active")
    .map((span) => ({
      ...span,
      start: Number(span.start_offset),
      end: Number(span.end_offset),
      category: safeCategory(span.category),
    }))
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .map((span) => {
      if (!Number.isInteger(span.start) || !Number.isInteger(span.end)
          || span.start < 0 || span.end <= span.start || span.end > points.length) {
        throw new Error(
          `invalid redaction offsets for ${span.item_id || "item"}: ${span.start}:${span.end}/${points.length}`,
        );
      }
      return span;
    });
}

export function activeRedactionFragments(content, spans) {
  const points = Array.from(String(content ?? ""));
  return normalizedActiveSpans(points, spans).map((span) => ({
    text: points.slice(span.start, span.end).join(""),
    category: span.category,
  }));
}

export function redactKnownFragments(value, fragments) {
  const source = String(value ?? "");
  const ordered = [...new Map((fragments || [])
    .filter((fragment) => fragment?.text)
    .map((fragment) => [fragment.text, fragment])).values()]
    .sort((a, b) => Array.from(b.text).length - Array.from(a.text).length);
  let output = "";
  let cursor = 0;
  while (cursor < source.length) {
    let match = null;
    for (const fragment of ordered) {
      const index = source.indexOf(fragment.text, cursor);
      if (index >= 0 && (!match || index < match.index
          || (index === match.index && fragment.text.length > match.fragment.text.length))) {
        match = { index, fragment };
      }
    }
    if (!match) break;
    output += source.slice(cursor, match.index);
    output += `<redacted category="${safeCategory(match.fragment.category)}"/>`;
    cursor = match.index + match.fragment.text.length;
  }
  return output + source.slice(cursor);
}

export function redactKnownValue(value, fragments) {
  if (typeof value === "string") return redactKnownFragments(value, fragments);
  if (Array.isArray(value)) return value.map((entry) => redactKnownValue(entry, fragments));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .map(([key, entry]) => [key, redactKnownValue(entry, fragments)]));
  }
  return value;
}

export function applyActiveRedactions(content, spans) {
  const points = Array.from(String(content ?? ""));
  const active = normalizedActiveSpans(points, spans);
  const output = [];
  let cursor = 0;
  for (const span of active) {
    const { start, end } = span;
    if (start > cursor) output.push(points.slice(cursor, start).join(""));
    if (end > cursor) {
      output.push(`<redacted category="${span.category}"/>`);
      cursor = end;
    }
  }
  output.push(points.slice(cursor).join(""));
  return output.join("");
}

export function releaseDocument(row, id) {
  const sourceSystem = String(row.source_system || "local-agent-history");
  return {
    id,
    kind: String(row.kind || "trajectory"),
    title: id,
    source_system: SAFE_SOURCE_SYSTEMS.has(sourceSystem)
      ? sourceSystem
      : "local-agent-history",
    item_count: Number(row.item_count || 0),
  };
}

export function releaseItem(row, spans, id, documentId) {
  const sourceType = String(row.event_type || "other");
  const conversational = CONVERSATIONAL_TYPES.has(sourceType);
  const preparedLabel = String(row.content || "");
  const actionLabel = sourceType === "action_label" && SAFE_ACTION_LABELS.has(preparedLabel)
    ? preparedLabel
    : ACTION_LABELS[sourceType] || "[action]";
  return {
    id,
    document_id: documentId,
    sequence: Number(row.sequence || 0),
    event_type: conversational ? sourceType : "action_label",
    actor_type: sourceType === "record"
      ? "participant"
      : conversational ? String(row.actor_type || "participant") : "tool",
    timestamp: conversational && sourceType !== "record" ? row.timestamp || null : null,
    content: conversational
      ? applyActiveRedactions(String(row.content || ""), spans)
      : actionLabel,
    organization_category: row.organization_category || "Unclassified",
    organization_confidence: row.organization_confidence ?? null,
    organization_reason: row.organization_reason || "Project event",
  };
}

export function redactionSummary(redactions, job) {
  const categories = {};
  for (const span of redactions) {
    const category = String(span.category || "sensitive");
    categories[category] = (categories[category] || 0) + 1;
  }
  return {
    schema: "oxygen.ai-redaction-summary",
    backend: "ai",
    model: job?.model || null,
    status: job?.status || "missing",
    active_spans: redactions.length,
    categories,
    rejected: Number(job?.rejected || 0),
    notice: "Best-effort AI redaction; original-contributor final review is required before release.",
  };
}
