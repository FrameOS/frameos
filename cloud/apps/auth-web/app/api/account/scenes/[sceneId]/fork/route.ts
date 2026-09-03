import { NextRequest } from "next/server";
import { csrfResponse } from "../../../../../../src/lib/csrf";
import {
  defaultJsonBodyBytes,
  jsonError,
  readBoundedJsonObject,
  requireDatabase,
} from "../../../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../../src/lib/session";
import { forkStoreScene } from "../../../../../../src/lib/store-fork";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sceneId: string }> };

// Fork a scene: create a NEW private store scene under the caller's account,
// seeded with the posted scenes JSON inside a copy of the source's latest
// zip (manifest renamed, preview image carried over). The body lives in
// src/lib/store-fork.ts so the AI chat's save_scene tool forks through the
// exact same path (quotas, moderation, lineage in the audit event).
export async function POST(request: NextRequest, context: RouteContext) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }

  const limited = await rateLimitResponse(request, "account:scenes", {
    limit: 60,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const session = await readSession();
  if (!session?.accountId) {
    return jsonError("login_required", 401);
  }
  const accountId = session.accountId;

  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  const { sceneId } = await context.params;
  const parsed = await readBoundedJsonObject(request, defaultJsonBodyBytes);
  if (parsed.response) {
    return parsed.response;
  }
  const body = parsed.body;
  if (!Array.isArray(body.scenes) || body.scenes.length === 0) {
    return jsonError("invalid_scenes", 400);
  }

  return forkStoreScene(db, {
    accountId,
    actor: { accountId, providerSubject: session.providerSubject },
    scenes: body.scenes,
    sourceSceneId: sceneId,
  });
}
