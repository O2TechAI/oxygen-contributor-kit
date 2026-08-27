import { getLocalDatabase } from "../../../../db";
import {
  STORY_PRIVACY_ERROR,
  decideStoryPrivacyCandidate,
  isStoryPrivacyCandidateId,
  isStoryPrivacyDigest,
} from "../../../../lib/story-privacy-authority";
import { isWorkflowRunId } from "../../../../lib/workflow-progress";

const requestKeys = [
  "workflowRunId", "sourceRevision", "activeStoryDigest", "candidateDigest",
  "expectedVersion", "decision",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!isStoryPrivacyCandidateId(id)) {
    return Response.json({ error: "Story Privacy candidate not found" }, { status: 404 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "A valid Story Privacy decision body is required" }, { status: 400 });
  }
  if (!isRecord(body) || !requestKeys.every((key) => Object.hasOwn(body, key))
    || !Object.keys(body).every((key) => requestKeys.includes(key))
    || !isWorkflowRunId(body.workflowRunId)
    || !Number.isSafeInteger(body.sourceRevision) || Number(body.sourceRevision) <= 0
    || !isStoryPrivacyDigest(body.activeStoryDigest)
    || !isStoryPrivacyDigest(body.candidateDigest)
    || body.expectedVersion !== 0
    || (body.decision !== "keep" && body.decision !== "redact")) {
    return Response.json({ error: "An exact current Keep or Redact decision is required" }, {
      status: 400,
    });
  }
  const result = await decideStoryPrivacyCandidate(await getLocalDatabase(), {
    workflowRunId: body.workflowRunId,
    sourceRevision: Number(body.sourceRevision),
    activeStoryDigest: body.activeStoryDigest,
    candidateDigest: body.candidateDigest,
    expectedVersion: 0,
    decision: body.decision,
  }, id, new Date().toISOString());
  if (!result.ok) {
    const status = result.code === STORY_PRIVACY_ERROR.foreignWorkflow
      || result.code === STORY_PRIVACY_ERROR.candidateNotFound ? 404 : 409;
    return Response.json({ error: status === 404
      ? "Story Privacy candidate not found"
      : "Story Privacy decision authority changed; reload before deciding", code: result.code }, {
      status,
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  }
  return Response.json(result.candidate, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
