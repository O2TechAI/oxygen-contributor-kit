import { getD1 } from "../../../db";
import { loadWorkflowProgress } from "../../../lib/workflow-progress-server";
import {
  validateStoryCandidatePackage,
  type StoryCandidateRow,
  type StoryEvidenceRow,
} from "../../../lib/story-readiness";
import { LEGACY_STORY_PREFIX, STORY_PREFIX } from "../../../lib/timeline";
import { isWorkflowRunId } from "../../../lib/workflow-progress";

const EVENTS = new Set([
  "target_confirmed",
  "collection_started",
  "collection_progress",
  "collection_completed",
  "collection_failed",
  "story_generation_started",
  "story_generation_progress",
  "story_generation_blocked",
  "story_ready_for_human_review",
]);
const BODY_KEYS = new Set(["workflowRunId", "event", "completed", "total"]);

export const dynamic = "force-dynamic";

const count = (value: unknown) => typeof value === "number"
  && Number.isSafeInteger(value)
  && value >= 0
  ? value
  : null;

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function GET(request: Request) {
  const requestedRunId = new URL(request.url).searchParams.get("workflowRunId");
  if (requestedRunId !== null && !isWorkflowRunId(requestedRunId)) {
    return Response.json({ error: "Invalid workflow run" }, { status: 400 });
  }
  return Response.json(await loadWorkflowProgress(requestedRunId || undefined), {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid workflow event" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Invalid workflow event" }, { status: 400 });
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !BODY_KEYS.has(key))) {
    return Response.json({ error: "Unsupported workflow field" }, { status: 400 });
  }
  const workflowRunId = typeof record.workflowRunId === "string" ? record.workflowRunId : "";
  const event = typeof record.event === "string" ? record.event : "";
  if (!isWorkflowRunId(workflowRunId) || !EVENTS.has(event)) {
    return Response.json({ error: "Invalid workflow event" }, { status: 400 });
  }

  const completed = record.completed === undefined ? 0 : count(record.completed);
  const total = record.total === undefined ? 0 : count(record.total);
  const needsCounts = [
    "collection_progress", "collection_completed", "story_generation_progress",
  ].includes(event);
  if (completed === null || total === null || completed > total
    || (needsCounts && record.total === undefined)) {
    return Response.json({ error: "Invalid workflow counts" }, { status: 400 });
  }

  const db = await getD1();
  if (event.startsWith("story_")) {
    const [run, organization, redaction] = await Promise.all([
      db.prepare(`SELECT id,story_generation_status,story_source_revision
        FROM workflow_runs WHERE id=?`).bind(workflowRunId).first<{
          id: string; story_generation_status: string; story_source_revision: number;
        }>(),
      db.prepare("SELECT status FROM organization_jobs ORDER BY updated_at DESC LIMIT 1")
        .first<{ status: string }>(),
      db.prepare("SELECT status FROM redaction_jobs ORDER BY started_at DESC LIMIT 1")
        .first<{ status: string }>(),
    ]);
    if (!run) return Response.json({ error: "Workflow run not found" }, { status: 404 });
    if (organization?.status !== "complete" || redaction?.status !== "complete") {
      return Response.json({ error: "Reviewed Story boundary is not ready" }, { status: 409 });
    }
    const now = new Date().toISOString();
    if (event === "story_generation_started") {
      await db.prepare(`UPDATE workflow_runs
        SET story_generation_status='running',story_generation_completed=0,
            story_generation_total=0,active_story_digest=NULL,updated_at=? WHERE id=?`)
        .bind(now, workflowRunId).run();
      return Response.json(await loadWorkflowProgress(workflowRunId));
    }
    if (event === "story_generation_progress") {
      if (run.story_generation_status !== "running") {
        return Response.json({ error: "Story generation is not running" }, { status: 409 });
      }
      await db.prepare(`UPDATE workflow_runs
        SET story_generation_completed=?,story_generation_total=?,updated_at=? WHERE id=?`)
        .bind(completed, total, now, workflowRunId).run();
      return Response.json(await loadWorkflowProgress(workflowRunId));
    }
    if (event === "story_generation_blocked") {
      await db.prepare(`UPDATE workflow_runs
        SET story_generation_status='blocked',active_story_digest=NULL,updated_at=? WHERE id=?`)
        .bind(now, workflowRunId).run();
      return Response.json(await loadWorkflowProgress(workflowRunId));
    }
    if (run.story_generation_status !== "running") {
      return Response.json({ error: "Story generation is not running" }, { status: 409 });
    }
    const [{ results: candidateRows }, { results: evidenceRows }] = await Promise.all([
      db.prepare(`SELECT id,document_id AS documentId,organization_reason AS summary
        FROM items
        WHERE organization_reason LIKE ? OR organization_reason LIKE ?
        ORDER BY COALESCE(timestamp,''),document_id,sequence`)
        .bind(`${STORY_PREFIX}%`, `${LEGACY_STORY_PREFIX}%`).all<StoryCandidateRow>(),
      db.prepare(`SELECT id,document_id AS documentId,event_type AS eventType,
        actor_id AS actorId,actor_type AS actorType FROM items ORDER BY document_id,sequence`)
        .all<StoryEvidenceRow>(),
    ]);
    const validation = validateStoryCandidatePackage(candidateRows, evidenceRows);
    if (!validation.ok) {
      await db.prepare(`UPDATE workflow_runs
        SET story_generation_status='blocked',active_story_digest=NULL,updated_at=? WHERE id=?`)
        .bind(now, workflowRunId).run();
      return Response.json({ error: "Story candidate validation failed", code: validation.code }, { status: 409 });
    }
    const digest = await sha256(validation.canonicalCandidate);
    const activated = await db.prepare(`UPDATE workflow_runs
      SET story_generation_status='ready_for_human_review',
          story_generation_completed=?,story_generation_total=?,active_story_digest=?,updated_at=?
      WHERE id=? AND story_source_revision=? AND story_generation_status='running'`)
      .bind(validation.chapterCount, validation.chapterCount, digest, now,
        workflowRunId, run.story_source_revision).run();
    if (Number(activated.meta.changes || 0) !== 1) {
      return Response.json({ error: "Story candidate changed during validation" }, { status: 409 });
    }
    return Response.json(await loadWorkflowProgress(workflowRunId));
  }

  const existing = await db.prepare(
    "SELECT collection_status FROM workflow_runs WHERE id=?",
  ).bind(workflowRunId).first<{ collection_status: string }>();
  const nextStatus = event === "collection_failed"
    ? "failed"
    : event === "collection_completed"
      ? "complete"
      : event === "target_confirmed"
        ? "pending"
        : "running";
  if (existing && ["complete", "failed"].includes(existing.collection_status)
    && existing.collection_status !== nextStatus) {
    return Response.json({ error: "Workflow collection state is terminal" }, { status: 409 });
  }

  const now = new Date().toISOString();
  const blockerCode = nextStatus === "failed" ? "COLLECTION_FAILED" : null;
  await db.prepare(`INSERT INTO workflow_runs (
      id,target_confirmed,collection_status,collection_completed,collection_total,
      blocker_code,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      target_confirmed=excluded.target_confirmed,
      collection_status=excluded.collection_status,
      collection_completed=excluded.collection_completed,
      collection_total=excluded.collection_total,
      blocker_code=excluded.blocker_code,
      updated_at=excluded.updated_at`)
    .bind(workflowRunId, 1, nextStatus, completed, total, blockerCode, now, now)
    .run();

  return Response.json(await loadWorkflowProgress(workflowRunId));
}
