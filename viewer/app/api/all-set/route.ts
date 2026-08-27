import { getLocalDatabase } from "../../../db/index.ts";
import { allSetErrorResponse, confirmProjectAllSet } from "../../../lib/project-all-set.ts";

export async function GET() {
  return Response.json({ error: "Method not allowed" }, {
    status: 405,
    headers: { allow: "POST" },
  });
}

export async function POST(request: Request) {
  const input = await request.json().catch(() => null);
  const result = await confirmProjectAllSet(await getLocalDatabase(), input);
  return result.ok ? Response.json(result) : allSetErrorResponse(result);
}
