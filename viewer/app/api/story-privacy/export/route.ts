import { getLocalDatabase } from "../../../../db";
import {
  STORY_PRIVACY_ERROR,
  buildReviewedStoryPrivacyPreparationSnapshot,
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
