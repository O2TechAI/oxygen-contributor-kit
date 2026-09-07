import { getLocalDatabase } from "../../../../db";
import { applyStoryChapterReview, isStoryPrivacyDigest } from "../../../../lib/story-privacy-authority";
import { isWorkflowRunId } from "../../../../lib/workflow-progress";

export async function POST(request: Request) {
  const input = await request.json().catch(() => null);
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).sort().join(",") !== "authorityDigest,chapterKey,choices,expectedVersion,sourceRevision,workflowRunId"
    || !isWorkflowRunId(input.workflowRunId) || !isStoryPrivacyDigest(input.authorityDigest)
    || !Number.isSafeInteger(input.sourceRevision) || input.sourceRevision <= 0
    || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0
    || typeof input.chapterKey !== "string" || !input.chapterKey
    || !Array.isArray(input.choices) || input.choices.length > 4000
    || input.choices.some((choice: unknown) => !choice || typeof choice !== "object" || Array.isArray(choice)
      || Object.keys(choice).sort().join(",") !== "editedText,publicOverrides,targetContentDigest,targetId")) {
    return Response.json({ error: "An exact Chapter review is required" }, { status: 400 });
  }
  const result = await applyStoryChapterReview(await getLocalDatabase(), input, new Date().toISOString());
  return Response.json(result.ok ? result : { ...result,
    error: "Review was not applied. Your drafts are retained; check the current Chapter preparation." },
  { status: result.ok ? 200 : 409, headers: { "Cache-Control": "no-store" } });
}
