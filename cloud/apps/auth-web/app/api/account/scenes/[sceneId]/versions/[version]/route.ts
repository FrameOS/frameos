import { and, eq, isNull } from "drizzle-orm";
import {
  storeScenes,
  storeSceneVersions,
} from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { csrfResponse } from "../../../../../../../src/lib/csrf";
import {
  defaultJsonBodyBytes,
  jsonError,
  readBoundedJsonObject,
  requireDatabase,
} from "../../../../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../../../src/lib/session";
import { syncLatestVersion } from "../../../../../../../src/lib/store-version-write";

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

  const parsed = await readBoundedJsonObject(request, defaultJsonBodyBytes);
  if (parsed.response) {
    return parsed.response;
  }
  const body = parsed.body;
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

  // The flip and the `latest_version` move are one transaction: "latest"
  // follows the newest non-yanked version, so yanking the version the store
  // index advertised (and whose `?v=N` cover URL the edge caches immutable
  // for a year) hands the pointer to the one the download route now serves
  // by default, and unyanking a newer one hands it back.
  const outcome = await db.transaction(async (tx) => {
    const [updated] = await tx
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
      return undefined;
    }
    return { latestVersion: await syncLatestVersion(tx, scene.id) };
  });

  if (!outcome) {
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
    latest_version: outcome.latestVersion ?? null,
    status: body.yanked ? "yanked" : "unyanked",
    version: versionNumber,
  });
}
