import { getLocalDatabase } from "../../../db";
import { canonicalizeAutoRemoved } from "../../../lib/auto-removed.mjs";
import {
  normalizeBulkPreferencePresentations,
  normalizeProbePresentations,
  type BulkPreferencePresentations,
  type ProbePresentations,
} from "../../../lib/preference-presentation";
import {
  canonicalPreferenceQuestionBatch,
  storyPreparationDigest,
} from "../../../lib/story-preparation";
import {
  WORKFLOW_RUN_AUTHORITY,
  requireEstablishedWorkflowRun,
  workflowRunErrorResponse,
} from "../../../lib/workflow-run-server";
import { validActivatedSourceRevision } from "../../../lib/authority-validation.mjs";

const SIGNALS = new Set([
  "repeated_correction", "long_exchange", "late_rejection", "decision_reversal",
  "explicit_rule", "sustained_disagreement",
]);
const BODY_KEYS = new Set([
  "workflowRunId", "sourceRevision", "inputDigest", "outputDigest", "outputCount",
  "setAside", "probes", "bulkDecisions", "autoRemoved",
]);
const PROBE_KEYS = new Set([
  "id", "documentId", "documentKind", "eventIds", "timestamp", "signal", "score",
  "turns", "recap", "question", "options", "presentations", "allowOther", "allowSkip",
]);
const BULK_KEYS = new Set(["id", "kind", "count", "question", "evidenceSample", "presentations"]);
const OPTION_KEYS = new Set(["id", "text"]);
const DIGEST = /^[0-9a-f]{64}$/;

type PreferenceOption = { id: string; text: string };
type AcceptedProbe = {
  id: string; documentId: string; documentKind: string; eventIds: string[];
  timestamp: string | null; signal: string; score: number; turns: number;
  recap: string; question: string; options: PreferenceOption[];
  presentations: ProbePresentations; allowOther: boolean; allowSkip: boolean;
};
type AcceptedBulkDecision = {
  id: string; kind: string; count: number; question: string;
  evidenceSample: string[]; presentations: BulkPreferencePresentations;
};

const isObject = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === "object" && !Array.isArray(value)
);
const onlyKnownKeys = (value: Record<string, unknown>, allowed: Set<string>) => (
  Object.keys(value).every((key) => allowed.has(key))
);
const safeText = (value: unknown): value is string => (
  typeof value === "string" && Boolean(value.trim())
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
);
const stableId = (value: unknown): value is string => (
  safeText(value) && !/[\u0000-\u001f\u007f]/u.test(value)
);
const nonNegativeInteger = (value: unknown): value is number => (
  Number.isSafeInteger(value) && Number(value) >= 0
);

function normalizeOptions(value: unknown): PreferenceOption[] | null {
  if (!Array.isArray(value) || (value.length !== 2 && value.length !== 3)) return null;
  const options: PreferenceOption[] = [];
  const ids = new Set<string>();
  for (const option of value) {
    if (!isObject(option) || Object.keys(option).length !== OPTION_KEYS.size
      || !onlyKnownKeys(option, OPTION_KEYS) || !stableId(option.id) || ids.has(option.id)
      || !safeText(option.text)) return null;
    ids.add(option.id);
    options.push({ id: option.id, text: option.text });
  }
  return options;
}

function normalizeProbe(value: unknown): AcceptedProbe | null {
  if (!isObject(value) || Object.keys(value).length !== PROBE_KEYS.size
    || !onlyKnownKeys(value, PROBE_KEYS)
    || !stableId(value.id) || !stableId(value.documentId)
    || (value.documentKind !== "trajectory" && value.documentKind !== "meeting")
    || !Array.isArray(value.eventIds) || value.eventIds.length === 0
    || !value.eventIds.every(stableId)
    || new Set(value.eventIds).size !== value.eventIds.length
    || (value.timestamp !== null && !safeText(value.timestamp))
    || !SIGNALS.has(String(value.signal)) || !nonNegativeInteger(value.score)
    || Number(value.score) > 100 || !nonNegativeInteger(value.turns) || !safeText(value.recap)
    || !safeText(value.question)
    || value.allowOther !== true || value.allowSkip !== true) return null;
  const options = normalizeOptions(value.options);
  if (!options) return null;
  const presentations = normalizeProbePresentations(value.presentations, options);
  if (!presentations) return null;
  return {
    id: value.id,
    documentId: value.documentId,
    documentKind: value.documentKind,
    eventIds: [...value.eventIds],
    timestamp: value.timestamp as string | null,
    signal: value.signal as string,
    score: Number(value.score),
    turns: Number(value.turns),
    recap: value.recap,
    question: value.question,
    options,
    presentations,
    allowOther: true,
    allowSkip: true,
  };
}

function normalizeBulkDecision(value: unknown): AcceptedBulkDecision | null {
  if (!isObject(value)) return null;
  const evidenceSample = value.evidenceSample;
  if (Object.keys(value).length !== BULK_KEYS.size || !onlyKnownKeys(value, BULK_KEYS)
    || !stableId(value.id) || !safeText(value.kind) || !nonNegativeInteger(value.count)
    || !safeText(value.question) || !Array.isArray(evidenceSample)
    || !evidenceSample.every(stableId)
    || new Set(evidenceSample).size !== evidenceSample.length) return null;
  const presentations = normalizeBulkPreferencePresentations(value.presentations);
  if (!presentations) return null;
  return {
    id: value.id,
    kind: value.kind,
    count: value.count,
    question: value.question,
    evidenceSample: [...evidenceSample],
    presentations,
  };
}

const preferenceQuestionAuthority = (probe: AcceptedProbe) => ({
  id: probe.id, documentId: probe.documentId, documentKind: probe.documentKind,
  eventIds: probe.eventIds, timestamp: probe.timestamp, signal: probe.signal,
  score: probe.score, turns: probe.turns, recap: probe.recap, question: probe.question,
  options: probe.options, presentations: probe.presentations,
  allowOther: probe.allowOther, allowSkip: probe.allowSkip,
});
const bulkQuestionAuthority = (decision: AcceptedBulkDecision) => ({
  id: decision.id, kind: decision.kind, count: decision.count,
  question: decision.question, evidenceSample: decision.evidenceSample,
  presentations: decision.presentations,
});

export async function GET() {
  const db = await getLocalDatabase();
  const authority = await requireEstablishedWorkflowRun(db);
  if (authority.state !== WORKFLOW_RUN_AUTHORITY.exactRun) return workflowRunErrorResponse(authority);
  const currentAuthority = `EXISTS (SELECT 1 FROM workflow_runs workflow
    JOIN probe_runs probe_run ON probe_run.workflow_run_id=workflow.id
    WHERE workflow.id=? AND workflow.story_generation_status='ready_for_human_review'
      AND probe_run.status='complete' AND probe_run.stage='preference'
      AND workflow.story_source_revision>0 AND probe_run.source_revision>0
      AND probe_run.source_revision=workflow.story_source_revision)`;
  const [probes, bulk, runs] = await db.batch([
    db.prepare(`SELECT * FROM probes WHERE ${currentAuthority}
      ORDER BY score DESC,created_at ASC`).bind(authority.workflowRunId),
    db.prepare(`SELECT * FROM probe_bulk_decisions WHERE ${currentAuthority}
      ORDER BY count DESC`).bind(authority.workflowRunId),
    db.prepare(`SELECT probe_run.* FROM probe_runs probe_run
      JOIN workflow_runs workflow ON workflow.id=probe_run.workflow_run_id
      WHERE workflow.id=? AND workflow.story_generation_status='ready_for_human_review'
        AND probe_run.status='complete' AND probe_run.stage='preference'
        AND workflow.story_source_revision>0 AND probe_run.source_revision>0
        AND probe_run.source_revision=workflow.story_source_revision`)
      .bind(authority.workflowRunId),
  ]);
  return Response.json({
    probes: (probes.results || []).map((row) => {
      const probe = row as Record<string, unknown>;
      return { ...probe,
        event_ids: JSON.parse(String(probe.event_ids_json || "[]")),
        options: JSON.parse(String(probe.options_json || "[]")),
        presentations: JSON.parse(String(probe.presentations_json || "{}")),
      };
    }),
    bulkDecisions: (bulk.results || []).map((row) => {
      const decision = row as Record<string, unknown>;
      return { ...decision,
        evidence_sample: JSON.parse(String(decision.evidence_sample_json || "[]")),
        presentations: JSON.parse(String(decision.presentations_json || "{}")),
      };
    }),
    run: runs.results?.[0] || null,
  });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid Preference batch" }, { status: 400 });
  }
  if (!isObject(body) || Object.keys(body).length !== BODY_KEYS.size
    || !onlyKnownKeys(body, BODY_KEYS) || !stableId(body.workflowRunId)
    || !validActivatedSourceRevision(body.sourceRevision)
    || typeof body.inputDigest !== "string" || !DIGEST.test(body.inputDigest)
    || typeof body.outputDigest !== "string" || !DIGEST.test(body.outputDigest)
    || !nonNegativeInteger(body.outputCount)
    || !nonNegativeInteger(body.setAside)
    || !Array.isArray(body.probes) || !Array.isArray(body.bulkDecisions)) {
    return Response.json({ error: "Invalid Preference batch" }, { status: 400 });
  }
  const probes = body.probes.map(normalizeProbe);
  const bulkDecisions = body.bulkDecisions.map(normalizeBulkDecision);
  if (probes.some((probe) => !probe) || bulkDecisions.some((decision) => !decision)) {
    return Response.json({ error: "Invalid Preference question content" }, { status: 400 });
  }
  const acceptedProbes = probes as AcceptedProbe[];
  const acceptedBulk = bulkDecisions as AcceptedBulkDecision[];
  const ids = [...acceptedProbes, ...acceptedBulk].map((item) => item.id);
  if (new Set(ids).size !== ids.length || body.outputCount !== ids.length) {
    return Response.json({ error: "Invalid Preference question count or identity" }, { status: 400 });
  }
  if (body.outputCount === 0 && body.setAside !== 0) {
    return Response.json({ error: "Completed-zero Preference batch cannot set questions aside" }, { status: 400 });
  }
  let autoRemoved: ReturnType<typeof canonicalizeAutoRemoved>;
  try {
    autoRemoved = canonicalizeAutoRemoved(body.autoRemoved);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid aggregate";
    return Response.json({ error: `invalid auto_removed: ${detail}` }, { status: 400 });
  }
  const recomputedOutputDigest = await storyPreparationDigest(
    canonicalPreferenceQuestionBatch(
      acceptedProbes.map(preferenceQuestionAuthority),
      acceptedBulk.map(bulkQuestionAuthority),
    ),
  );
  if (recomputedOutputDigest !== body.outputDigest) {
    return Response.json({ error: "Preference output digest mismatch" }, { status: 400 });
  }

  const db = await getLocalDatabase();
  const authority = await requireEstablishedWorkflowRun(db);
  if (authority.state !== WORKFLOW_RUN_AUTHORITY.exactRun) return workflowRunErrorResponse(authority);
  if (authority.workflowRunId !== body.workflowRunId) {
    return workflowRunErrorResponse({ state: WORKFLOW_RUN_AUTHORITY.foreignRun });
  }
  const run = await db.prepare(`SELECT story_generation_status,story_source_revision
    FROM workflow_runs WHERE id=?`).bind(body.workflowRunId).first<{
      story_generation_status: string; story_source_revision: number;
    }>();
  if (!run || run.story_generation_status !== "running"
    || Number(run.story_source_revision) !== body.sourceRevision) {
    return Response.json({ error: "Preference source authority is stale" }, { status: 409 });
  }
  const [{ results: documents }, { results: items }] = await Promise.all([
    db.prepare("SELECT id,kind FROM documents").all<{ id: string; kind: string }>(),
    db.prepare("SELECT id,document_id FROM items").all<{ id: string; document_id: string }>(),
  ]);
  const documentKinds = new Map(documents.map((document) => [document.id, document.kind]));
  const itemOwners = new Map(items.map((item) => [item.id, item.document_id]));
  if (acceptedProbes.some((probe) => documentKinds.get(probe.documentId) !== probe.documentKind
    || probe.eventIds.some((eventId) => itemOwners.get(eventId) !== probe.documentId))
    || acceptedBulk.some((decision) => decision.evidenceSample.some((eventId) => !itemOwners.has(eventId)))) {
    return Response.json({ error: "Invalid Preference evidence authority" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const leaseSql = `EXISTS (SELECT 1 FROM workflow_runs
    WHERE id=? AND story_generation_status='running' AND story_source_revision=?)`;
  const leaseBindings = [body.workflowRunId, body.sourceRevision];
  const statements = [
    db.prepare(`DELETE FROM probes WHERE ${leaseSql}`).bind(...leaseBindings),
    db.prepare(`DELETE FROM probe_bulk_decisions WHERE ${leaseSql}`).bind(...leaseBindings),
    db.prepare(`DELETE FROM probe_runs WHERE workflow_run_id=? AND ${leaseSql}`)
      .bind(body.workflowRunId, ...leaseBindings),
    ...acceptedProbes.map((probe) => db.prepare(
      `INSERT INTO probes
        (id,document_id,document_kind,event_ids_json,timestamp,signal,score,turns,
         recap,question,options_json,presentations_json,allow_other,allow_skip,created_at)
       SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${leaseSql}`,
    ).bind(
      probe.id, probe.documentId, probe.documentKind, JSON.stringify(probe.eventIds),
      probe.timestamp, probe.signal, probe.score, probe.turns, probe.recap, probe.question,
      JSON.stringify(probe.options), JSON.stringify(probe.presentations),
      probe.allowOther ? 1 : 0, probe.allowSkip ? 1 : 0, now,
      ...leaseBindings,
    )),
    ...acceptedBulk.map((decision) => db.prepare(
      `INSERT INTO probe_bulk_decisions
        (id,kind,count,question,default_answer,evidence_sample_json,presentations_json,created_at)
       SELECT ?,?,?,?,'keep',?,?,? WHERE ${leaseSql}`,
    ).bind(
      decision.id, decision.kind, decision.count, decision.question,
      JSON.stringify(decision.evidenceSample), JSON.stringify(decision.presentations), now,
      ...leaseBindings,
    )),
    db.prepare(`INSERT INTO probe_runs
      (workflow_run_id,id,source_revision,input_digest,output_digest,output_count,
       status,stage,generated,set_aside,auto_removed_json,started_at,updated_at,completed_at)
       SELECT ?,?,?,?,?,?,'complete','preference',?,?,?, ?,?,? WHERE ${leaseSql}`).bind(
      body.workflowRunId, body.workflowRunId, body.sourceRevision, body.inputDigest, body.outputDigest,
      body.outputCount, body.outputCount, body.setAside, JSON.stringify(autoRemoved), now, now, now,
      ...leaseBindings,
    ),
    db.prepare(`SELECT json_extract(CASE WHEN
      ${leaseSql}
      AND EXISTS (SELECT 1 FROM probe_runs
        WHERE workflow_run_id=? AND id=? AND source_revision=?
          AND input_digest=? AND output_digest=? AND output_count=?
          AND status='complete' AND stage='preference' AND generated=? AND set_aside=?)
      AND (SELECT COUNT(*) FROM probes) + (SELECT COUNT(*) FROM probe_bulk_decisions)=?
      THEN '{}' ELSE '' END,'$.preference_authority') AS preference_authority_assertion`).bind(
      ...leaseBindings,
      body.workflowRunId,
      body.workflowRunId,
      body.sourceRevision,
      body.inputDigest,
      body.outputDigest,
      body.outputCount,
      body.outputCount,
      body.setAside,
      body.outputCount,
    ),
  ];
  try {
    await db.batch(statements);
  } catch {
    return Response.json({ error: "Preference replacement failed" }, { status: 409 });
  }
  return Response.json({ imported: acceptedProbes.length, bulkImported: acceptedBulk.length });
}
