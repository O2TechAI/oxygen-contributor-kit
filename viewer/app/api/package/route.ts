import { createZip } from "../../../lib/zip.ts";
import {
  activeRedactionFragments,
  redactKnownFragments,
  releaseDocument,
  releaseItem,
  redactionSummary,
} from "../../../lib/release.mjs";
import { computeSourceDigest, redactionReleaseError } from "../../../lib/redaction-pass.mjs";
import {
  capturePackageReleasePrivacySnapshot,
  captureStoryReleasePrivacySnapshot,
  validateReleaseSourcePrivacyReceipt,
  type ReleaseSnapshotTestOptions,
} from "../../../lib/release-privacy-snapshot.ts";
import {
  releaseOrganizationReason,
  sanitizeReviewedStoryRelease,
} from "../../../lib/story-release.ts";
import {
  RELEASE_ERROR,
  parseServerOwnedReleaseRequest,
  reconstructReviewedStoryRelease,
  reconstructReviewedStoryReleaseFromDatabase,
  releaseErrorResponse,
} from "../../../lib/story-release-server.ts";
import { renderReviewedStoryHtml } from "../organization/export/route.ts";

function parseStoredJson(value: unknown) {
  if (typeof value !== "string" || !value) throw new Error("stored JSON is missing");
  return JSON.parse(value) as unknown;
}
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
type PackageDatabase = Parameters<typeof capturePackageReleasePrivacySnapshot>[0];

/** Render the same canonical, sanitized reviewed Story used by the standalone
 * HTML release. Insights remain nested under their accepted Story block; the
 * release shape contains no anchor, Evidence, authority, CAS, or review IDs. */
export function renderPackagedLocalViewer(reviewedStoryJson: string) {
  return renderReviewedStoryHtml(reviewedStoryJson);
}

export async function buildPackageFromDatabase(
  db: PackageDatabase,
  reviewedStoryJson: string,
  releaseRequest: unknown,
  options: ReleaseSnapshotTestOptions = {},
) {
  const parsedReleaseRequest = parseServerOwnedReleaseRequest(releaseRequest);
  if (!parsedReleaseRequest) {
    return releaseErrorResponse({ ok: false, code: RELEASE_ERROR.requestInvalid });
  }
  const initialStorySnapshot = await captureStoryReleasePrivacySnapshot(
    db,
    parsedReleaseRequest.workflowRunId,
  );
  const initialReconstruction = await reconstructReviewedStoryReleaseFromDatabase(
    db,
    parsedReleaseRequest,
  );
  if (!initialReconstruction.ok) return releaseErrorResponse(initialReconstruction);
  if (initialReconstruction.serializedStory !== reviewedStoryJson) {
    return releaseErrorResponse({ ok: false, code: RELEASE_ERROR.stateInvalid });
  }
  await options.afterInitialStoryReconstruction?.();
  const privacySnapshot = await capturePackageReleasePrivacySnapshot(db);
  const redactionJob = privacySnapshot.redactionJob;
  const preliminaryError = redactionReleaseError(
    redactionJob,
    redactionJob?.source_digest,
    privacySnapshot.redactionReviewRows,
    parsedReleaseRequest.sourceRevision,
  );
  if (preliminaryError) {
    return Response.json({ error: preliminaryError }, { status: 409 });
  }

  const documentResult = { results: privacySnapshot.documentRows };
  const itemResult = { results: privacySnapshot.itemRows };
  const redactionResult = { results: privacySnapshot.redactionRows };
  const probeResult = { results: privacySnapshot.probeRows };
  const bulkResult = { results: privacySnapshot.bulkRows };
  const probeRun = privacySnapshot.probeRun;
  const currentSourceDigest = await computeSourceDigest(itemResult.results);
  const sourceReceiptValid = await validateReleaseSourcePrivacyReceipt(
    privacySnapshot,
    parsedReleaseRequest.workflowRunId,
    parsedReleaseRequest.sourceRevision,
    currentSourceDigest,
  );
  const sourceError = !sourceReceiptValid ? "Source Privacy receipt is stale" : redactionReleaseError(
    redactionJob,
    currentSourceDigest,
    privacySnapshot.redactionReviewRows,
    parsedReleaseRequest.sourceRevision,
  );
  if (sourceError) {
    return Response.json({ error: sourceError }, { status: 409 });
  }

  const documentIds = new Map<string, string>();
  const summaries = new Map<string, Summary>();
  let sourceWarningCount = 0;
  const sourceDocuments: ReleaseDocument[] = [];
  try {
    for (const [index, row] of documentResult.results.entries()) {
      const id = canonicalId("document", index);
      documentIds.set(String(row.id), id);
      const summary = parseStoredJson(row.formatted_summary_json);
      const metadata = parseStoredJson(row.metadata_json);
      if (!summary || typeof summary !== "object" || Array.isArray(summary)
        || !metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        throw new Error("stored document JSON has invalid shape");
      }
      summaries.set(String(row.id), summary as Summary);
      const metadataRecord = metadata as Record<string, unknown>;
      const manifest = metadataRecord.manifest && typeof metadataRecord.manifest === "object"
        && !Array.isArray(metadataRecord.manifest)
        ? metadataRecord.manifest as Record<string, unknown>
        : {};
      const warnings = Number(metadataRecord.source_warning_count ?? manifest.source_warning_count ?? 0);
      if (!Number.isInteger(warnings) || warnings < 0) throw new Error("invalid source warning count");
      sourceWarningCount += warnings;
      sourceDocuments.push(releaseDocument(row, id) as ReleaseDocument);
    }
  } catch {
    return releaseErrorResponse({ ok: false, code: RELEASE_ERROR.stateInvalid });
  }
  const redactionsByItem = new Map<string, Record<string, unknown>[]>();
  for (const span of redactionResult.results as Record<string, unknown>[]) {
    const itemId = String(span.item_id);
    redactionsByItem.set(itemId, [...(redactionsByItem.get(itemId) || []), span]);
  }

  const sensitiveFragments: Array<{ text: string; category: string }> = [];
  const items = itemResult.results.map((row: Record<string, unknown>, index: number) => {
    const id = canonicalId("event", index);
    const originalId = String(row.id);
    const originalDocumentId = String(row.document_id);
    try {
      const spans = redactionsByItem.get(originalId) || [];
      sensitiveFragments.push(...activeRedactionFragments(String(row.content || ""), spans));
      return releaseItem(
        row,
        spans,
        id,
        documentIds.get(originalDocumentId) || "document-unknown",
      ) as ReleaseEvent;
    } catch {
      return null;
    }
  });
  if (items.some((item: ReleaseEvent | null) => item === null)) {
    return releaseErrorResponse({ ok: false, code: RELEASE_ERROR.stateInvalid });
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
    organization_reason: safeText(releaseOrganizationReason(item.organization_reason)),
  }));

  const primaryProject = safeText(
    Array.from(summaries.values()).find((summary) => summary.primary_project)
      ?.primary_project || "Unclassified"
  );
  const projectSummary = safeText(
    Array.from(summaries.values()).find((summary) => summary.project_summary)
      ?.project_summary || ""
  );
  let reviewedStory: ReturnType<typeof sanitizeReviewedStoryRelease> = null;
  try {
    reviewedStory = sanitizeReviewedStoryRelease(parseStoredJson(reviewedStoryJson));
  } catch {
    reviewedStory = null;
  }
  if (!reviewedStory) {
    return releaseErrorResponse({ ok: false, code: RELEASE_ERROR.stateInvalid });
  }
  const reviewedTimeline = reviewedStory.chapters.map((chapter, index) => ({
    id: canonicalId("chapter", index),
    summary: chapter.en.title,
    content: [chapter.en.overview, ...chapter.en.story.blocks.map((block) => block.text)].join("\n\n"),
  }));
  const projectNames = Array.from(new Set(releaseItems.map((item) => item.organization_category)));
  const projects = projectNames.map((name) => ({
    name,
    primary: name === primaryProject,
    event_count: releaseItems.filter((item) => item.organization_category === name).length,
    timeline: name === primaryProject ? reviewedTimeline : [],
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
    primary_project: primaryProject,
    summary: projectSummary,
    projects,
    events: projectEvents,
  };
  const privacy = redactionSummary(redactionResult.results, redactionJob);

  const probes = probeResult.results.map((row: Record<string, unknown>, index: number) => {
    const choice = row.answer_choice ? String(row.answer_choice) : null;
    return {
      id: canonicalId("probe", index),
      question: safeText(row.question),
      answer: choice
        ? { choice: choice === "none" ? "skip" : choice, ...(choice === "other" ? { text: safeText(row.answer_text) } : {}) }
        : null,
    };
  });
  const preferenceProbes = {
    bulkDecisions: bulkResult.results.map((row: Record<string, unknown>, index: number) => ({
      id: canonicalId("bulk-decision", index),
      question: safeText(row.question),
      answer: row.answer ? safeText(row.answer) : null,
    })),
    probes,
  };

  const exportedAt = options.exportedAt ?? new Date().toISOString();
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
  const viewer = renderPackagedLocalViewer(reviewedStoryJson);
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
  entries.push({
    name: "story/reviewed-project-story.json",
    data: reviewedStoryJson,
  });
  const zip = createZip(entries);
  await options.beforeFinalPrivacyCheck?.();
  const finalReconstruction = await reconstructReviewedStoryReleaseFromDatabase(db, parsedReleaseRequest);
  if (!finalReconstruction.ok) return releaseErrorResponse(finalReconstruction);
  if (finalReconstruction.serializedStory !== reviewedStoryJson) {
    return releaseErrorResponse({ ok: false, code: RELEASE_ERROR.stateInvalid });
  }
  const finalPrivacySnapshot = await capturePackageReleasePrivacySnapshot(db);
  const finalStorySnapshot = await captureStoryReleasePrivacySnapshot(
    db,
    parsedReleaseRequest.workflowRunId,
  );
  if (finalPrivacySnapshot.digest !== privacySnapshot.digest
    || finalStorySnapshot.digest !== initialStorySnapshot.digest) {
    return releaseErrorResponse({ ok: false, code: RELEASE_ERROR.privacyConflict });
  }
  return new Response(zip, { headers: {
    "content-type": "application/zip",
    "content-disposition": 'attachment; filename="oxygen-contribution.zip"',
    "cache-control": "no-store",
  } });
}

async function buildPackage(reviewedStoryJson: string, releaseRequest: unknown) {
  const { getLocalDatabase } = await import("../../../db/index.ts");
  return buildPackageFromDatabase(await getLocalDatabase(), reviewedStoryJson, releaseRequest);
}

export async function GET() {
  return Response.json({ error: "Method not allowed" }, {
    status: 405,
    headers: { allow: "POST" },
  });
}

export async function POST(request: Request) {
  const releaseRequest = await request.json().catch(() => null);
  const reconstruction = await reconstructReviewedStoryRelease(releaseRequest);
  if (!reconstruction.ok) return releaseErrorResponse(reconstruction);
  return buildPackage(reconstruction.serializedStory, releaseRequest);
}
