import { getLocalDatabase } from "../../../db/index.ts";
import {
  confirmProjectReleaseConfirmation,
  RELEASE_CONFIRMATION_ERROR,
  releaseConfirmationErrorResponse,
} from "../../../lib/project-release-confirmation.ts";
import { parseServerOwnedReleaseRequest } from "../../../lib/story-release-server.ts";

export async function GET() {
  return Response.json({ error: "Method not allowed" }, {
    status: 405,
    headers: { allow: "POST" },
  });
}

export async function POST(request: Request) {
  const input = await request.json().catch(() => null);
  const parsed = parseServerOwnedReleaseRequest(input);
  if (!parsed) {
    return releaseConfirmationErrorResponse({
      ok: false,
      code: RELEASE_CONFIRMATION_ERROR.requestInvalid,
    });
  }
  const result = await confirmProjectReleaseConfirmation(await getLocalDatabase(), parsed);
  return result.ok ? Response.json(result) : releaseConfirmationErrorResponse(result);
}
