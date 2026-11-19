import { and, eq } from "drizzle-orm";
import { storeScenes } from "@frameos-cloud/db";
import type { NextRequest } from "next/server";
import { csrfResponse } from "./csrf";
import { jsonError, requireDatabase } from "./device-flow";
import { readSession } from "./session";
import { storeWriteRateLimitResponse } from "./store-publish-limit";

// Shared guard for owner web-session management of a published scene
// (PATCH/DELETE metadata, content edits): CSRF, rate limit, session, and
// ownership all checked; the scene row is returned in full.
export async function loadOwnedScene(
  request: NextRequest,
  context: { params: Promise<{ sceneId: string }> },
  options: {
    rateLimit?: { action: string; limit: number; windowMs: number };
  } = {},
) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return { errorResponse: csrf };
  }

  // A superadmin's store writes have no per-address limit (store-publish-limit.ts).
  const session = await readSession();
  const limited = await storeWriteRateLimitResponse(
    request,
    session?.accountId,
    options.rateLimit?.action ?? "account:scenes",
    options.rateLimit ?? { limit: 120, windowMs: 15 * 60 * 1000 },
  );
  if (limited) {
    return { errorResponse: limited };
  }

  if (!session?.accountId) {
    return { errorResponse: jsonError("login_required", 401) };
  }

  const { db, response } = requireDatabase();
  if (!db) {
    return { errorResponse: response };
  }

  const { sceneId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(sceneId)) {
    return { errorResponse: jsonError("scene_not_found", 404) };
  }

  const [scene] = await db
    .select()
    .from(storeScenes)
    .where(
      and(
        eq(storeScenes.id, sceneId),
        eq(storeScenes.accountId, session.accountId),
      ),
    )
    .limit(1);

  if (!scene) {
    return { errorResponse: jsonError("scene_not_found", 404) };
  }

  return { db, scene, session };
}
