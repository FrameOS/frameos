import { and, eq } from "drizzle-orm";
import { storeScenes } from "@frameos-cloud/db";
import type { NextRequest } from "next/server";
import { csrfResponse } from "./csrf";
import { jsonError, requireDatabase } from "./device-flow";
import { rateLimitResponse } from "./rate-limit";
import { readSession } from "./session";

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

  const limited = rateLimitResponse(
    request,
    options.rateLimit?.action ?? "account:scenes",
    options.rateLimit ?? { limit: 60, windowMs: 15 * 60 * 1000 },
  );
  if (limited) {
    return { errorResponse: limited };
  }

  const session = await readSession();
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
