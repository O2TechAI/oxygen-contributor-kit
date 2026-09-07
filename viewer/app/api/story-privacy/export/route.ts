import { getLocalDatabase } from "../../../../db";
import {
  STORY_PRIVACY_ERROR,
  buildReviewedStoryPrivacyPreparationSnapshot,
  requestReviewedStoryPrivacyPreparation,
} from "../../../../lib/story-privacy-authority";
import { isWorkflowRunId } from "../../../../lib/workflow-progress";

const headers = { "Cache-Control": "no-store, max-age=0" };

export async function GET(request: Request) {
  const workflowRunId = new URL(request.url).searchParams.get("workflowRunId");
  if (!isWorkflowRunId(workflowRunId)) {
    return Response.json({
      error: "A valid workflow run is required",
      code: STORY_PRIVACY_ERROR.invalidAuthority,
    }, { status: 400, headers });
  }
  const result = await buildReviewedStoryPrivacyPreparationSnapshot(
    await getLocalDatabase(), workflowRunId,
  );
  if (!result.ok) {
    const status = result.code === STORY_PRIVACY_ERROR.foreignWorkflow ? 404 : 409;
    return Response.json({
      error: result.code === STORY_PRIVACY_ERROR.notActionable
        ? "Story Privacy refresh is not required"
        : "Current Story Privacy preparation is unavailable",
      code: result.code,
    }, { status, headers });
  }
  return Response.json(result.snapshot, { headers });
}

/** Explicit contributor-requested re-review; does not select or apply wording. */
export async function POST(request: Request) {
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid re-review request" }, { status: 400, headers }); }
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).sort().join(",") !== "authorityDigest,expectedVersion,rereviewRequest,sourceRevision,workflowRunId"
    || !isWorkflowRunId(body.workflowRunId)
    || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0
    || !Number.isSafeInteger(body.sourceRevision) || body.sourceRevision <= 0
    || typeof body.authorityDigest !== "string" || !/^[0-9a-f]{64}$/.test(body.authorityDigest)) {
    return Response.json({ error: "Invalid re-review request" }, { status: 400, headers });
  }
  const result = await requestReviewedStoryPrivacyPreparation(await getLocalDatabase(), body.workflowRunId, body);
  return result.ok ? Response.json(result.snapshot, { headers }) : Response.json({
    error: "Re-review requires exact current, undecided passages and no outstanding preparation. Existing review state is retained.",
    code: result.code,
  }, { status: 409, headers });
}
