import { and, desc, eq, gt, sql } from "drizzle-orm";
import { accounts, storeScenes } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import {
  authenticateLinkedClient,
  linkedClientHasScope,
} from "../../../../../src/lib/backend-auth";
import {
  jsonError,
  requireDatabase,
} from "../../../../../src/lib/device-flow";
import { getScenesBaseUrl } from "../../../../../src/lib/env";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";
import { storePublishScope } from "../../../../../src/lib/store";
import { storeRoute } from "../../../../../src/lib/store-cache";
import { sceneHasAnyImageSql } from "../../../../../src/lib/store-preview";

export const runtime = "nodejs";

// "My cloud drive": the authenticated account's own scenes — private and
// public — in the frameos repository format. Two callers, two credentials:
//
//   * a linked frameos backend sends its link token (Authorization header)
//     and needs the store scope;
//   * the /frames workspace runs ON the cloud, where the browser session IS
//     the account — its Add-scene drawer lists these directly, no link
//     involved.
//
// URLs are absolute because the backend attaches the link token when
// requesting them from the provider host; for the workspace they are
// same-deployment URLs the browser can fetch with its session cookie.
async function handleGet(request: NextRequest) {
  const limited = await rateLimitResponse(request, "store:drive", {
    limit: 240,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  let accountId: string | undefined;
  const authorization = request.headers.get("authorization");
  if (authorization) {
    const linkedClient = await authenticateLinkedClient(db, authorization);
    if (!linkedClient) {
      return jsonError("invalid_link_token", 401);
    }
    if (!linkedClientHasScope(linkedClient, storePublishScope)) {
      return jsonError("insufficient_scope", 403);
    }
    accountId = linkedClient.accountId;
  } else {
    const session = await readSession();
    if (!session?.accountId) {
      return jsonError("login_required", 401);
    }
    accountId = session.accountId;
  }

  const scenes = await db
    .select({
      authorName: accounts.displayName,
      description: storeScenes.description,
      frameosVersion: storeScenes.frameosVersion,
      hasPreview: sceneHasAnyImageSql,
      id: storeScenes.id,
      latestVersion: storeScenes.latestVersion,
      name: storeScenes.name,
      previewImageHeight: storeScenes.previewImageHeight,
      previewImageWidth: storeScenes.previewImageWidth,
      riskFlags: storeScenes.riskFlags,
      slug: storeScenes.slug,
      status: storeScenes.status,
      tags: storeScenes.tags,
      updatedAt: storeScenes.updatedAt,
      visibility: storeScenes.visibility,
    })
    .from(storeScenes)
    .leftJoin(accounts, eq(accounts.id, storeScenes.accountId))
    .where(
      and(
        eq(storeScenes.accountId, accountId),
        eq(storeScenes.status, "active"),
        gt(storeScenes.latestVersion, 0),
      ),
    )
    .orderBy(desc(storeScenes.updatedAt))
    .limit(500);

  const baseUrl = getScenesBaseUrl();
  const absolute = (path: string) => new URL(path, baseUrl).toString();

  return NextResponse.json(
    {
      description: "Your scenes on FrameOS Cloud",
      name: "My cloud drive",
      templates: scenes.map((scene) => ({
        author: scene.authorName ?? undefined,
        description: scene.description ?? undefined,
        flags: scene.riskFlags.length > 0 ? scene.riskFlags : undefined,
        frameosVersion: scene.frameosVersion ?? undefined,
        id: scene.slug,
        image: scene.hasPreview
          ? absolute(`/api/store/scenes/${scene.id}/image`)
          : undefined,
        imageHeight: scene.previewImageHeight ?? undefined,
        imageWidth: scene.previewImageWidth ?? undefined,
        name: scene.name,
        // The scene uuid, so a frameos backend can proxy image/zip requests
        // (the browser cannot attach the link token to an <img> tag).
        sceneId: scene.id,
        tags: scene.tags.length > 0 ? scene.tags : undefined,
        url: absolute(`/s/${scene.slug}`),
        version: String(scene.latestVersion),
        visibility: scene.visibility,
        zip: absolute(`/api/store/scenes/${scene.id}/download`),
      })),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

// Cache policy is per-response here (see storeRoute): anything this
// handler did not decide is no-store.
export const GET = storeRoute(handleGet);
