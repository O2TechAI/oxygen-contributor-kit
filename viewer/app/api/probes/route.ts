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
  STORY_PREPARATION_EMPTY_ARRAY_DIGEST,
  storyPreparationDigest,
} from "../../../lib/story-preparation";
import {
  WORKFLOW_RUN_AUTHORITY,
  requireEstablishedWorkflowRun,
  workflowRunErrorResponse,
} from "../../../lib/workflow-run-server";

const SIGNALS = new Set([
  "repeated_correction", "long_exchange", "late_rejection", "decision_reversal",
  "explicit_rule", "sustained_disagreement",
]);
const BODY_KEYS = new Set([
  "workflowRunId", "sourceRevision", "inputDigest", "outputDigest", "outputCount",
  "probes", "bulkDecisions", "autoRemoved",
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
const stableId = (value: unknown): value is string => safeText(value);
const nonNegativeInteger = (value: unknown): value is number => (
  Number.isSafeInteger(value) && Number(value) >= 0
);

function normalizeOptions(value: unknown): PreferenceOption[] | null {
  if (!Array.isArray(value)) return null;
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
  if (!isObject(value) || !onlyKnownKeys(value, PROBE_KEYS)
    || !stableId(value.id) || !stableId(value.documentId)
    || (value.documentKind !== undefined && !safeText(value.documentKind))
    || !Array.isArray(value.eventIds) || !value.eventIds.every(stableId)
    || new Set(value.eventIds).size !== value.eventIds.length
    || (value.timestamp !== undefined && value.timestamp !== null && !safeText(value.timestamp))
    || !SIGNALS.has(String(value.signal)) || !nonNegativeInteger(value.score ?? 0)
    || !nonNegativeInteger(value.turns ?? 0) || !safeText(value.recap)
    || !safeText(value.question)
    || (value.allowOther !== undefined && typeof value.allowOther !== "boolean")
    || (value.allowSkip !== undefined && typeof value.allowSkip !== "boolean")) return null;
  const options = normalizeOptions(value.options ?? []);
  if (!options) return null;
  const presentations = normalizeProbePresentations(value.presentations, options);
  if (!presentations) return null;
  return {
    id: value.id,
    documentId: value.documentId,
    documentKind: value.documentKind === undefined ? "trajectory" : value.documentKind,
    eventIds: [...value.eventIds],
    timestamp: value.timestamp === undefined ? null : value.timestamp as string | null,
    signal: value.signal as string,
    score: Number(value.score ?? 0),
    turns: Number(value.turns ?? 0),
    recap: value.recap,
    question: value.question,
    options,
    presentations,
    allowOther: value.allowOther === undefined ? true : value.allowOther,
    allowSkip: value.allowSkip === undefined ? true : value.allowSkip,
  };
}

function normalizeBulkDecision(value: unknown): AcceptedBulkDecision | null {
  if (!isObject(value)) return null;
  const evidenceSample = value.evidenceSample ?? [];
  if (!onlyKnownKeys(value, BULK_KEYS)
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
  const [probes, bulk, run] = await Promise.all([
    db.prepare("SELECT * FROM probes ORDER BY score DESC, created_at ASC").all(),
    db.prepare("SELECT * FROM probe_bulk_decisions ORDER BY count DESC").all(),
    db.prepare("SELECT * FROM probe_runs WHERE workflow_run_id=?")
      .bind(authority.workflowRunId).first(),
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
    run: run || null,
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
    || !nonNegativeInteger(body.sourceRevision)
    || typeof body.inputDigest !== "string" || !DIGEST.test(body.inputDigest)
    || typeof body.outputDigest !== "string" || !DIGEST.test(body.outputDigest)
    || !nonNegativeInteger(body.outputCount)
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
  if (recomputedOutputDigest !== body.outputDigest
    || (body.outputCount === 0 && body.outputDigest !== STORY_PREPARATION_EMPTY_ARRAY_DIGEST)) {
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

  const now = new Date().toISOString();
  const statements = [
    db.prepare("DELETE FROM probes"),
    db.prepare("DELETE FROM probe_bulk_decisions"),
    db.prepare("DELETE FROM probe_runs"),
    ...acceptedProbes.map((probe) => db.prepare(
      `INSERT INTO probes
        (id,document_id,document_kind,event_ids_json,timestamp,signal,score,turns,
         recap,question,options_json,presentations_json,allow_other,allow_skip,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      probe.id, probe.documentId, probe.documentKind, JSON.stringify(probe.eventIds),
      probe.timestamp, probe.signal, probe.score, probe.turns, probe.recap, probe.question,
      JSON.stringify(probe.options), JSON.stringify(probe.presentations),
      probe.allowOther ? 1 : 0, probe.allowSkip ? 1 : 0, now,
    )),
    ...acceptedBulk.map((decision) => db.prepare(
      `INSERT INTO probe_bulk_decisions
        (id,kind,count,question,default_answer,evidence_sample_json,presentations_json,created_at)
       VALUES (?,?,?,?,'keep',?,?,?)`,
    ).bind(
      decision.id, decision.kind, decision.count, decision.question,
      JSON.stringify(decision.evidenceSample), JSON.stringify(decision.presentations), now,
    )),
    db.prepare(`INSERT INTO probe_runs
      (workflow_run_id,id,source_revision,input_digest,output_digest,output_count,
       status,stage,generated,set_aside,auto_removed_json,started_at,updated_at,completed_at)
      VALUES (?,?,?,?,?,?,'complete','preference',?,0,?,?,?,?)`).bind(
      body.workflowRunId, body.workflowRunId, body.sourceRevision, body.inputDigest, body.outputDigest,
      body.outputCount, body.outputCount, JSON.stringify(autoRemoved), now, now, now,
    ),
  ];
  try {
    await db.batch(statements);
  } catch {
    return Response.json({ error: "Preference replacement failed" }, { status: 409 });
  }
  return Response.json({ imported: acceptedProbes.length, bulkImported: acceptedBulk.length });
}
