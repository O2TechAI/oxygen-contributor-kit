import { getLocalDatabase } from "../../../db/index.ts";
import {
  confirmProjectReleaseConfirmation,
  releaseConfirmationErrorResponse,
} from "../../../lib/project-release-confirmation.ts";

export async function GET() {
  return Response.json({ error: "Method not allowed" }, {
    status: 405,
    headers: { allow: "POST" },
  });
}

export async function POST(request: Request) {
  const input = await request.json().catch(() => null);
  const result = await confirmProjectReleaseConfirmation(await getLocalDatabase(), input);
  return result.ok ? Response.json(result) : releaseConfirmationErrorResponse(result);
}
