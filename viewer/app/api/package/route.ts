import { getD1 } from "../../../db";
import { createZip } from "../../../lib/zip";
import { selectProjectTimeline } from "../../../lib/timeline";
import {
  activeRedactionFragments,
  redactKnownFragments,
  redactKnownValue,
  releaseDocument,
  releaseItem,
  redactionSummary,
} from "../../../lib/release.mjs";
import { computeSourceDigest, redactionReleaseError } from "../../../lib/redaction-pass.mjs";
import { canonicalizeStoredAutoRemoved } from "../../../lib/auto-removed.mjs";

const clean = <T,>(value: string, fallback: T): T => {
  try { return JSON.parse(value) as T; } catch { return fallback; }
};
const canonicalId = (prefix: string, index: number) => `${prefix}-${String(index + 1).padStart(6, "0")}`;

type Summary = { primary_project?: string; project_summary?: string };
type ReleaseDocument = {
  id: string; kind: string; title: string; source_system: string; item_count: number;
};
type ReleaseEvent = {
  id: string; document_id: string; sequence: number; event_type: string;
  timestamp?: string | null; content: string; organization_category: string;
  organization_confidence?: number | null; organization_reason: string;
};

export async function GET() {
  const db = await getD1();
  const redactionJob = await db.prepare(
    "SELECT * FROM redaction_jobs ORDER BY started_at DESC LIMIT 1"
  ).first<Record<string, unknown>>();
  const preliminaryError = redactionReleaseError(
    redactionJob,
    redactionJob?.source_digest,
  );
  if (preliminaryError) {
    return Response.json({ error: preliminaryError }, { status: 409 });
  }

  const [documentResult, itemResult, redactionResult, probeResult, bulkResult, probeRun] = await Promise.all([
    db.prepare(
      `SELECT id,kind,source_system,item_count,metadata_json,formatted_summary_json
         FROM documents ORDER BY source_timestamp,title`
    ).all<Record<string, unknown>>(),
    db.prepare(
      `SELECT id,document_id,sequence,event_type,actor_type,timestamp,content,
              organization_category,organization_confidence,organization_reason
         FROM items ORDER BY document_id,sequence`
    ).all<Record<string, unknown>>(),
    db.prepare(
      `SELECT id,item_id,document_id,start_offset,end_offset,category,status
         FROM redactions WHERE status='active' ORDER BY item_id,start_offset`
    ).all<Record<string, unknown>>(),
    db.prepare("SELECT * FROM probes ORDER BY score DESC,created_at").all<Record<string, unknown>>(),
    db.prepare("SELECT * FROM probe_bulk_decisions ORDER BY count DESC").all<Record<string, unknown>>(),
    db.prepare("SELECT * FROM probe_runs ORDER BY started_at DESC LIMIT 1").first<Record<string, unknown>>(),
  ]);
  const currentSourceDigest = await computeSourceDigest(itemResult.results);
  const sourceError = redactionReleaseError(redactionJob, currentSourceDigest);
  if (sourceError) {
    return Response.json({ error: sourceError }, { status: 409 });
  }

  const documentIds = new Map<string, string>();
  const summaries = new Map<string, Summary>();
  let sourceWarningCount = 0;
  const sourceDocuments: ReleaseDocument[] = documentResult.results.map((row: Record<string, unknown>, index: number) => {
    const id = canonicalId("document", index);
    documentIds.set(String(row.id), id);
    summaries.set(String(row.id), clean<Summary>(String(row.formatted_summary_json || "{}"), {}));
    const metadata = clean<Record<string, unknown>>(String(row.metadata_json || "{}"), {});
    const manifest = metadata.manifest && typeof metadata.manifest === "object"
      ? metadata.manifest as Record<string, unknown>
      : {};
    const warnings = Number(metadata.source_warning_count ?? manifest.source_warning_count ?? 0);
    if (Number.isInteger(warnings) && warnings >= 0) sourceWarningCount += warnings;
    return releaseDocument(row, id) as ReleaseDocument;
  });
  const redactionsByItem = new Map<string, Record<string, unknown>[]>();
  for (const span of redactionResult.results as Record<string, unknown>[]) {
    const itemId = String(span.item_id);
    redactionsByItem.set(itemId, [...(redactionsByItem.get(itemId) || []), span]);
  }

  const evidenceIds = new Map<string, string>();
  const unqualifiedEvidenceIds = new Map<string, string | null>();
  const sensitiveFragments: Array<{ text: string; category: string }> = [];
  let releaseError = "";
  const items = itemResult.results.map((row: Record<string, unknown>, index: number) => {
    const id = canonicalId("event", index);
    const originalId = String(row.id);
    const originalDocumentId = String(row.document_id);
    const separator = originalId.indexOf(":");
    const bareId = separator >= 0 ? originalId.slice(separator + 1) : originalId;
    evidenceIds.set(`${originalDocumentId}:${bareId}`, id);
    const existingEvidenceId = unqualifiedEvidenceIds.get(bareId);
    if (existingEvidenceId === undefined) unqualifiedEvidenceIds.set(bareId, id);
    else if (existingEvidenceId !== id) unqualifiedEvidenceIds.set(bareId, null);
    try {
      const spans = redactionsByItem.get(originalId) || [];
      sensitiveFragments.push(...activeRedactionFragments(String(row.content || ""), spans));
      return releaseItem(
        row,
        spans,
        id,
        documentIds.get(originalDocumentId) || "document-unknown",
      ) as ReleaseEvent;
    } catch (error) {
      releaseError = error instanceof Error ? error.message : "invalid redaction state";
      return null;
    }
  });
  if (releaseError || items.some((item: ReleaseEvent | null) => item === null)) {
    return Response.json({ error: `ZIP export blocked: ${releaseError}` }, { status: 409 });
  }
  // Organization labels and summaries repeat across tens of thousands of events.
  // Cache by source text so the same AI-confirmed fragment set is not rebuilt and
  // scanned for every repeated value during ZIP generation.
  const safeTextCache = new Map<string, string>();
  const safeText = (value: unknown) => {
    const source = String(value ?? "");
    if (safeTextCache.has(source)) return safeTextCache.get(source)!;
    const redacted = redactKnownFragments(source, sensitiveFragments);
    safeTextCache.set(source, redacted);
    return redacted;
  };
  const documents: ReleaseDocument[] = sourceDocuments.map((document: ReleaseDocument) => ({
    ...document,
    source_system: safeText(document.source_system),
  }));
  const releaseItems = (items as ReleaseEvent[]).map((item) => ({
    ...item,
    organization_category: safeText(item.organization_category),
    organization_reason: safeText(item.organization_reason),
  }));

  const primaryProject = safeText(
    Array.from(summaries.values()).find((summary) => summary.primary_project)
      ?.primary_project || "Unclassified"
  );
  const projectSummary = safeText(
    Array.from(summaries.values()).find((summary) => summary.project_summary)
      ?.project_summary || ""
  );
  const projectNames = Array.from(new Set(releaseItems.map((item) => item.organization_category)));
  const projects = projectNames.map((name) => ({
    name,
    primary: name === primaryProject,
    event_count: releaseItems.filter((item) => item.organization_category === name).length,
    timeline: selectProjectTimeline(releaseItems
      .filter((item) => item.organization_category === name && ["message", "record"].includes(item.event_type))
      .map((item) => ({
        id: item.id,
        sequence: item.sequence,
        timestamp: item.timestamp || undefined,
        project: item.organization_category,
        summary: item.organization_reason,
        content: item.content,
        document_id: item.document_id,
      }))),
  }));
  const projectEvents = Object.fromEntries(releaseItems.map((item) => [
    `${item.document_id}:${item.id}`,
    {
      project: item.organization_category,
      confidence: item.organization_confidence,
      summary: item.organization_reason,
    },
  ]));
  const projectMap = {
    schema_version: "1",
    primary_project: primaryProject,
    summary: projectSummary,
    projects,
    events: projectEvents,
  };
  const privacy = redactionSummary(redactionResult.results, redactionJob);

  let autoRemoved = { total: 0, reversible: true, categories: [] as Array<{ kind: string; count: number }> };
  if (probeRun) {
    try {
      autoRemoved = canonicalizeStoredAutoRemoved(String(probeRun.auto_removed_json || ""));
    } catch (error) {
      const detail = error instanceof Error ? error.message : "invalid aggregate";
      return Response.json(
        { error: `ZIP export blocked: invalid stored auto_removed: ${detail}` },
        { status: 409 },
      );
    }
  }

  const probes = probeResult.results.map((row: Record<string, unknown>, index: number) => {
    const originalDocumentId = String(row.document_id);
    const eventIds = clean<string[]>(String(row.event_ids_json || "[]"), [])
      .map((eventId) => evidenceIds.get(`${originalDocumentId}:${eventId}`))
      .filter((eventId): eventId is string => Boolean(eventId));
    const choice = row.answer_choice ? String(row.answer_choice) : null;
    return {
      id: canonicalId("probe", index),
      document_id: documentIds.get(originalDocumentId) || "document-unknown",
      document_kind: row.document_kind || "trajectory",
      event_ids: eventIds,
      timestamp: row.timestamp || null,
      signal: row.signal,
      score: Number(row.score || 0),
      turns: Number(row.turns || 0),
      recap: safeText(row.recap),
      question: safeText(row.question),
      options: redactKnownValue(clean(String(row.options_json || "[]"), []), sensitiveFragments),
      allow_other: true,
      allow_skip: true,
      answer: choice
        ? { choice: choice === "none" ? "skip" : choice, ...(choice === "other" ? { text: safeText(row.answer_text) } : {}) }
        : null,
    };
  });
  const preferenceProbes = {
    schema_version: "1",
    primary_project: primaryProject,
    generated_from: "project-map.json",
    auto_removed: autoRemoved,
    bulk_decisions: bulkResult.results.map((row: Record<string, unknown>, index: number) => ({
      id: canonicalId("bulk-decision", index),
      kind: safeText(row.kind),
      count: Number(row.count || 0),
      question: safeText(row.question),
      default: "keep",
      answer: row.answer ? safeText(row.answer) : null,
      evidence_sample: clean<string[]>(String(row.evidence_sample_json || "[]"), [])
        .map((eventId) => evidenceIds.get(String(eventId))
          ?? unqualifiedEvidenceIds.get(String(eventId)))
        .filter((eventId): eventId is string => Boolean(eventId)),
    })),
    probes,
    set_aside: Number(probeRun?.set_aside || 0),
  };

  const exportedAt = new Date().toISOString();
  const sourceTypes = Array.from(new Set(documents.map((document) => document.source_system))).sort();
  const counts = {
    documents: documents.length,
    events: releaseItems.length,
    trajectories: documents.filter((document) => document.kind === "trajectory").length,
    meetings: documents.filter((document) => document.kind === "meeting").length,
    conversational_events: releaseItems.filter((item) => ["message", "record"].includes(item.event_type)).length,
    action_labels: releaseItems.filter((item) => item.event_type === "action_label").length,
    active_redactions: privacy.active_spans,
  };
  const manifest = {
    format: "oxygen-contribution",
    version: 1,
    exported_at: exportedAt,
    publication_approved: false,
    document_count: documents.length,
    event_count: releaseItems.length,
    counts,
    warnings: { count: sourceWarningCount, details_omitted_for_privacy: true },
    source_types: sourceTypes,
    exclusions: [
      "raw source envelopes and original event JSON",
      "private AI findings, reviewer identities, and redaction ledgers",
      "non-conversational payload content and artifacts",
      "local runtime state, databases, caches, and credentials",
    ],
    ai_redaction: privacy,
    notice: "Local AI-reviewed package. Nothing was uploaded by the viewer.",
  };
  const viewer = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Oxygen local review</title><style>body{margin:0;background:#f5f3ed;color:#191b1a;font:14px/1.6 Arial}header{padding:22px 5vw;background:#fffef9;border-bottom:1px solid #dedbd2}main{max-width:920px;margin:auto;padding:30px}.project,.event{background:#fffef9;border:1px solid #dedbd2;border-radius:14px;padding:20px;margin:14px 0}.meta{color:#71766f;font-size:12px}pre{white-space:pre-wrap}</style><header><b>O₂ Oxygen</b> · AI-reviewed release · local only</header><main id="app"></main><script>const P=${JSON.stringify(projectMap).replace(/</g, "\\u003c")};const e=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));document.getElementById('app').innerHTML=P.projects.map(p=>'<section class="project"><div class="meta">'+(p.primary?'PRIMARY PROJECT':'PROJECT')+'</div><h1>'+e(p.name)+'</h1>'+p.timeline.map((x,i)=>'<article class="event"><div class="meta">'+(i+1)+' · '+e(x.timestamp||'Time unavailable')+'</div><h2>'+e(x.summary||'Project event')+'</h2><pre>'+e(x.content||'')+'</pre></article>').join('')+'</section>').join('')</script>`;
  const entries = [
    { name: "manifest.json", data: JSON.stringify(manifest, null, 2) },
    { name: "data/documents.json", data: JSON.stringify(documents, null, 2) },
    { name: "data/events.json", data: JSON.stringify(releaseItems, null, 2) },
    { name: "project-map.json", data: JSON.stringify(projectMap, null, 2) },
    { name: "privacy/redaction-summary.json", data: JSON.stringify(privacy, null, 2) },
    { name: "review/oxygen-local-viewer.html", data: viewer },
  ];
  if (probes.length || bulkResult.results.length || probeRun) {
    entries.splice(4, 0, {
      name: "preference-probes.json",
      data: JSON.stringify(preferenceProbes, null, 2),
    });
  }
  const zip = createZip(entries);
  return new Response(zip, { headers: {
    "content-type": "application/zip",
    "content-disposition": 'attachment; filename="oxygen-contribution.zip"',
    "cache-control": "no-store",
  } });
}
