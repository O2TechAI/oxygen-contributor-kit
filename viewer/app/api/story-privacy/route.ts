import { getLocalDatabase } from "../../../db";
import {
  STORY_PRIVACY_ERROR,
  readStoryPrivacyAuthority,
} from "../../../lib/story-privacy-authority";
import { isWorkflowRunId } from "../../../lib/workflow-progress";

export async function GET(request: Request) {
  const workflowRunId = new URL(request.url).searchParams.get("workflowRunId");
  if (!isWorkflowRunId(workflowRunId)) {
    return Response.json({ error: "A valid workflow run is required" }, { status: 400 });
  }
  const result = await readStoryPrivacyAuthority(await getLocalDatabase(), workflowRunId);
  if (!result.ok) {
    const status = result.code === STORY_PRIVACY_ERROR.foreignWorkflow ? 404 : 409;
    return Response.json({ error: "Current Story Privacy authority is unavailable", code: result.code }, {
      status,
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  }
  return Response.json(result.authority, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
