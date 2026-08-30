import { getLocalDatabase } from "../../../../db";
import {
  STORY_PRIVACY_ERROR,
  isStoryPrivacyCandidateId,
  isStoryPrivacyDigest,
  saveStoryPrivacyTargetChoice,
} from "../../../../lib/story-privacy-authority";
import type { StoryReleaseTarget } from "../../../../lib/timeline";
import { isWorkflowRunId } from "../../../../lib/workflow-progress";

const requestKeys = [
  "workflowRunId", "sourceRevision", "activeStoryDigest", "authorityDigest",
  "targetContentDigest", "editedText", "publicOverrides",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function safeText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= maximum
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!isStoryPrivacyCandidateId(id)) {
    return Response.json({ error: "Story Privacy target not found" }, { status: 404 });
  }
  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: "A valid Story Privacy target choice is required" }, { status: 400 });
  }
  if (!isRecord(body) || !exactKeys(body, requestKeys)
    || !isWorkflowRunId(body.workflowRunId)
    || !Number.isSafeInteger(body.sourceRevision) || Number(body.sourceRevision) <= 0
    || !isStoryPrivacyDigest(body.activeStoryDigest)
    || !isStoryPrivacyDigest(body.authorityDigest)
    || !isStoryPrivacyDigest(body.targetContentDigest)
    || (body.editedText !== null && !safeText(body.editedText, 1_000_000))
    || !Array.isArray(body.publicOverrides)
    || body.publicOverrides.some((override) => !isRecord(override)
      || !exactKeys(override, ["originalStartOffset", "originalEndOffset", "category"])
      || !Number.isSafeInteger(override.originalStartOffset)
      || Number(override.originalStartOffset) < 0
      || !Number.isSafeInteger(override.originalEndOffset)
      || Number(override.originalEndOffset) <= Number(override.originalStartOffset)
      || !safeText(override.category, 64))
    || (body.editedText !== null && body.publicOverrides.length > 0)) {
    return Response.json({ error: "An exact current Story Privacy target choice is required" }, {
      status: 400,
    });
  }
  const result = await saveStoryPrivacyTargetChoice(await getLocalDatabase(), {
    workflowRunId: body.workflowRunId,
    sourceRevision: Number(body.sourceRevision),
    activeStoryDigest: body.activeStoryDigest,
    authorityDigest: body.authorityDigest,
    targetId: id as StoryReleaseTarget,
    targetContentDigest: body.targetContentDigest,
    editedText: body.editedText,
    publicOverrides: body.publicOverrides,
  }, new Date().toISOString());
  if (!result.ok) {
    const status = result.code === STORY_PRIVACY_ERROR.foreignWorkflow
      || result.code === STORY_PRIVACY_ERROR.targetNotFound ? 404 : 409;
    return Response.json({
      error: status === 404 ? "Story Privacy target not found"
        : "Story Privacy choice authority changed; reload before deciding",
      code: result.code,
    }, { status, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
  return Response.json(result.authority, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
