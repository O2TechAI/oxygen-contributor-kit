import { getLocalDatabase } from "../../../../db";
import {
  STORY_PRIVACY_ERROR,
  importReviewedStoryPrivacyAuthority,
} from "../../../../lib/story-privacy-authority";

export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: "A valid reviewed Story Privacy import is required" }, { status: 400 });
  }
  const result = await importReviewedStoryPrivacyAuthority(
    await getLocalDatabase(), body, new Date().toISOString(),
  );
  if (!result.ok) {
    const status = result.code === STORY_PRIVACY_ERROR.foreignWorkflow ? 404
      : result.code === STORY_PRIVACY_ERROR.importInvalid ? 400 : 409;
    return Response.json({
      error: status === 400
        ? "The reviewed Story Privacy import is invalid"
        : "The reviewed Story Privacy authority changed before import",
      code: result.code,
    }, { status, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
  return Response.json(result.authority, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
