import { getD1 } from "../../../db";
import { canonicalizeAutoRemoved } from "../../../lib/auto-removed.mjs";
import {
  normalizeBulkPreferencePresentations,
  normalizeProbePresentations,
  type BulkPreferencePresentations,
  type ProbePresentations,
} from "../../../lib/preference-presentation";
import {
  WORKFLOW_RUN_AUTHORITY,
  requireEstablishedWorkflowRun,
  workflowRunErrorResponse,
} from "../../../lib/workflow-run-server";

const SIGNALS = new Set([
  "repeated_correction",
  "long_exchange",
  "late_rejection",
  "decision_reversal",
  "explicit_rule",
  "sustained_disagreement",
]);

type IncomingProbe = {
  id?: string;
  documentId: string;
  documentKind?: string;
  eventIds?: string[];
  timestamp?: string;
  signal: string;
  score?: number;
  turns?: number;
  recap: string;
  question: string;
  options?: Array<{ id: string; text: string }>;
  presentations?: unknown;
};

type AcceptedProbe = IncomingProbe & { normalizedPresentations: ProbePresentations };

export async function GET() {
  const db = await getD1();
  const authority = await requireEstablishedWorkflowRun(db);
  if (authority.state !== WORKFLOW_RUN_AUTHORITY.exactRun) {
    return workflowRunErrorResponse(authority);
  }
  const [probes, bulk, run] = await Promise.all([
    db.prepare("SELECT * FROM probes ORDER BY score DESC, created_at ASC").all(),
    db.prepare("SELECT * FROM probe_bulk_decisions ORDER BY count DESC").all(),
    db.prepare("SELECT * FROM probe_runs ORDER BY started_at DESC LIMIT 1").first(),
  ]);
  return Response.json({
    probes: (probes.results || []).map((row) => {
      const probe = row as Record<string, unknown>;
      return {
        ...probe,
        event_ids: JSON.parse(String(probe.event_ids_json || "[]")),
        options: JSON.parse(String(probe.options_json || "[]")),
        presentations: JSON.parse(String(probe.presentations_json || "{}")),
      };
    }),
    bulkDecisions: (bulk.results || []).map((row) => {
      const decision = row as Record<string, unknown>;
      return {
        ...decision,
        evidence_sample: JSON.parse(String(decision.evidence_sample_json || "[]")),
        presentations: JSON.parse(String(decision.presentations_json || "{}")),
      };
    }),
    run: run || null,
  });
}

export async function POST(request: Request) {
  const db = await getD1();
  const authority = await requireEstablishedWorkflowRun(db);
  if (authority.state !== WORKFLOW_RUN_AUTHORITY.exactRun) {
    return workflowRunErrorResponse(authority);
  }
  const body = await request.json() as {
    run?: { status: string; stage: string; model?: string; setAside?: number; autoRemoved?: unknown };
    probes?: IncomingProbe[];
    bulkDecisions?: Array<{ id?: string; kind: string; count: number; question: string; evidenceSample?: string[]; presentations?: unknown }>;
    replaceAll?: boolean;
  };
  const now = new Date().toISOString();
  let autoRemoved: ReturnType<typeof canonicalizeAutoRemoved> | undefined;
  if (body.run) {
    try {
      autoRemoved = canonicalizeAutoRemoved(body.run.autoRemoved);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "invalid aggregate";
      return Response.json({ error: `invalid auto_removed: ${detail}` }, { status: 400 });
    }
  }

  if (body.replaceAll) {
    // Answers belong to the probe set that produced them, so a regenerated set
    // starts unanswered rather than inheriting stale answers.
    await db.prepare("DELETE FROM probes").run();
    await db.prepare("DELETE FROM probe_bulk_decisions").run();
  }

  const incoming = body.probes || [];
  const rejected: Array<{ recap: string; reason: string }> = [];
  const accepted: AcceptedProbe[] = [];

  for (const probe of incoming) {
    if (!SIGNALS.has(probe.signal)) {
      rejected.push({ recap: probe.recap?.slice(0, 40) || "", reason: "unknown signal" });
      continue;
    }
    if (!probe.recap || !probe.question) {
      rejected.push({ recap: probe.recap?.slice(0, 40) || "", reason: "missing recap or question" });
      continue;
    }
    const normalizedPresentations = normalizeProbePresentations(probe.presentations, probe.options || []);
    if (!normalizedPresentations) {
      rejected.push({ recap: probe.recap?.slice(0, 40) || "", reason: "invalid localized presentations" });
      continue;
    }
    accepted.push({ ...probe, normalizedPresentations });
  }

  // The contract caps a batch at 20; keep the highest scoring and report the
  // rest as set aside rather than dropping them silently.
  accepted.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const kept = accepted.slice(0, 20);
  const setAside = accepted.length - kept.length;

  for (let start = 0; start < kept.length; start += 50) {
    await db.batch(kept.slice(start, start + 50).map((probe) => db.prepare(
      `INSERT INTO probes
        (id,document_id,document_kind,event_ids_json,timestamp,signal,score,turns,
         recap,question,options_json,presentations_json,allow_other,allow_skip,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,1,?)`
    ).bind(
      probe.id || crypto.randomUUID(), probe.documentId, probe.documentKind || "trajectory",
      JSON.stringify(probe.eventIds || []), probe.timestamp || null, probe.signal,
      probe.score ?? 0, probe.turns ?? 0, probe.recap, probe.question,
      JSON.stringify(probe.options || []), JSON.stringify(probe.normalizedPresentations), now,
    )));
  }

  for (const decision of body.bulkDecisions || []) {
    const presentations = normalizeBulkPreferencePresentations(decision.presentations);
    if (!presentations) {
      return Response.json({ error: `invalid localized presentations for bulk decision ${decision.id || "unknown"}` }, { status: 400 });
    }
    await db.prepare(
      `INSERT INTO probe_bulk_decisions
        (id,kind,count,question,default_answer,evidence_sample_json,presentations_json,created_at)
       VALUES (?,?,?,?,'keep',?,?,?)`
    ).bind(
      decision.id || crypto.randomUUID(), decision.kind, decision.count,
      decision.question, JSON.stringify(decision.evidenceSample || []),
      JSON.stringify(presentations satisfies BulkPreferencePresentations), now,
    ).run();
  }

  if (body.run) {
    await db.prepare("DELETE FROM probe_runs").run();
    await db.prepare(
      `INSERT INTO probe_runs
        (id,status,stage,model,generated,set_aside,auto_removed_json,
         started_at,updated_at,completed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      crypto.randomUUID(), body.run.status, body.run.stage, body.run.model || null,
      kept.length, body.run.setAside ?? setAside,
      JSON.stringify(autoRemoved), now, now,
      body.run.status === "complete" ? now : null,
    ).run();
  }

  return Response.json({ imported: kept.length, setAside, rejected });
}
