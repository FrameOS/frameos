import { and, eq, isNull } from "drizzle-orm";
import {
  storeScenes,
  storeSceneVersions,
} from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { csrfResponse } from "../../../../../../../src/lib/csrf";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../../../src/lib/session";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sceneId: string; version: string }> };

// Yank / unyank one published version (crates.io semantics): a yanked
// version is skipped when serving "latest" but stays downloadable when
// requested explicitly, and its bytes stay auditable.
export async function PATCH(request: NextRequest, context: RouteContext) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }

  const limited = rateLimitResponse(request, "account:scenes", {
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

  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  const { sceneId, version: rawVersion } = await context.params;
  const versionNumber = Number(rawVersion);
  if (
    !/^[0-9a-f-]{36}$/i.test(sceneId) ||
    !Number.isInteger(versionNumber) ||
    versionNumber <= 0
  ) {
    return jsonError("version_not_found", 404);
  }

  const [scene] = await db
    .select({ id: storeScenes.id, name: storeScenes.name })
    .from(storeScenes)
    .where(
      and(
        eq(storeScenes.id, sceneId),
        eq(storeScenes.accountId, session.accountId),
      ),
    )
    .limit(1);
  if (!scene) {
    return jsonError("scene_not_found", 404);
  }

  const body = await readJsonObject(request);
  if (typeof body.yanked !== "boolean") {
    return jsonError("invalid_yanked", 400);
  }

  // A scene must always keep at least one non-yanked version, otherwise
  // repository.json would advertise a package with nothing to serve.
  if (body.yanked) {
    const alive = await db
      .select({ version: storeSceneVersions.version })
      .from(storeSceneVersions)
      .where(
        and(
          eq(storeSceneVersions.sceneId, scene.id),
          isNull(storeSceneVersions.yankedAt),
        ),
      );
    if (alive.length <= 1 && alive[0]?.version === versionNumber) {
      return jsonError("cannot_yank_last_version", 400);
    }
  }

  const [updated] = await db
    .update(storeSceneVersions)
    .set({ yankedAt: body.yanked ? new Date() : null })
    .where(
      and(
        eq(storeSceneVersions.sceneId, scene.id),
        eq(storeSceneVersions.version, versionNumber),
      ),
    )
    .returning({ version: storeSceneVersions.version });

  if (!updated) {
    return jsonError("version_not_found", 404);
  }

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    eventType: body.yanked
      ? "store.version_yanked"
      : "store.version_unyanked",
    metadata: { name: scene.name, version: versionNumber },
    target: { sceneId: scene.id },
  });

  return NextResponse.json({
    status: body.yanked ? "yanked" : "unyanked",
    version: versionNumber,
  });
}
