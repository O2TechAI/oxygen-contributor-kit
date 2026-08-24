import { getD1 } from "../../../db";
import {
  MAX_STORY_REVIEW_SESSION_BYTES,
  canonicalizeStoryReviewSession,
} from "../../../lib/story-review-session";
import { isWorkflowRunId } from "../../../lib/workflow-progress";

type SessionRow = { state_json?: string };

async function reviewReady(db: Awaited<ReturnType<typeof getD1>>, workflowRunId: string) {
  const row = await db.prepare(
    "SELECT story_generation_status FROM workflow_runs WHERE id=?",
  ).bind(workflowRunId).first<{ story_generation_status: string }>();
  return row?.story_generation_status === "ready_for_human_review";
}

export async function GET(request: Request) {
  const workflowRunId = new URL(request.url).searchParams.get("workflowRunId");
  if (!isWorkflowRunId(workflowRunId)) return Response.json({ error: "A valid workflow run is required" }, { status: 400 });
  const db = await getD1();
  if (!await reviewReady(db, workflowRunId)) {
    return Response.json({ error: "Story review is not ready" }, { status: 409 });
  }
  const row = await db.prepare("SELECT state_json FROM story_review_sessions WHERE workflow_run_id = ?")
    .bind(workflowRunId).first<SessionRow>();
  if (!row?.state_json) return Response.json({ session: null });
  try {
    return Response.json({ session: canonicalizeStoryReviewSession(JSON.parse(row.state_json)) });
  } catch {
    return Response.json({ session: null });
  }
}

export async function POST(request: Request) {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_STORY_REVIEW_SESSION_BYTES) {
    return Response.json({ error: "Story review session is too large" }, { status: 413 });
  }
  let session;
  try {
    session = canonicalizeStoryReviewSession(JSON.parse(raw));
  } catch {
    session = null;
  }
  if (!session) return Response.json({ error: "Invalid Story review session" }, { status: 400 });
  const db = await getD1();
  if (!await reviewReady(db, session.workflowRunId)) {
    return Response.json({ error: "Story review is not ready" }, { status: 409 });
  }
  await db.prepare(`INSERT INTO story_review_sessions (workflow_run_id,state_json,updated_at)
    VALUES (?,?,?)
    ON CONFLICT(workflow_run_id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at
    WHERE excluded.updated_at >= story_review_sessions.updated_at`)
    .bind(session.workflowRunId, JSON.stringify(session), session.updatedAt).run();
  return Response.json({ saved: true, updatedAt: session.updatedAt });
}
