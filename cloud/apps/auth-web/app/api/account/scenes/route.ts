import { NextRequest } from "next/server";
import {
  createAccountScene,
  maxSceneNameChars,
} from "../../../../src/lib/account-scene-create";
import { csrfResponse } from "../../../../src/lib/csrf";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../src/lib/device-flow";
import {
  identityRateLimitResponse,
  rateLimitResponse,
} from "../../../../src/lib/rate-limit";
import { readSession } from "../../../../src/lib/session";
import { maxPublishesPerHour } from "../../../../src/lib/store";

export const runtime = "nodejs";

// Create a NEW private cloud scene from raw scenes JSON — the workspace's
// "save this frame's edited scenes to my account" path, which has no ZIP to
// upload. The work itself lives in src/lib/account-scene-create.ts, shared
// with the AI chat's save_scene tool so both go through the same quota,
// moderation, classification and audit path.
export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "account:scene-create", {
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
  const accountLimited = await identityRateLimitResponse(
    session.accountId,
    "store:publish",
    { limit: maxPublishesPerHour, windowMs: 60 * 60 * 1000 },
  );
  if (accountLimited) {
    return accountLimited;
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  const body = await readJsonObject(request);
  const requestedName =
    typeof body.name === "string" ? body.name.trim().slice(0, maxSceneNameChars) : "";
  if (!Array.isArray(body.scenes) || body.scenes.length === 0) {
    return jsonError("invalid_scenes", 400);
  }
  const description =
    typeof body.description === "string"
      ? body.description.trim().slice(0, 2000)
      : undefined;

  return createAccountScene(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    ...(description ? { description } : {}),
    name: requestedName.length > 0 ? requestedName : "Untitled scene",
    scenes: body.scenes,
  });
}
