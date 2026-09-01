import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { storeScenes } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import {
  createAccountScene,
  maxSceneNameChars,
} from "../../../../src/lib/account-scene-create";
import { sceneSummary } from "../../../../src/lib/store";
import { sceneHasImageSql } from "../../../../src/lib/store-listing";
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
import { framePreviewForNewScene } from "../../../../src/lib/scene-images";

export const runtime = "nodejs";

// The account's own scenes, the same rows /my-scenes renders, as JSON —
// for scripts and the MCP server, which have no server-rendered page to
// read. `?q=` matches name, slug and tags; `?visibility=private|public`
// and `?status=active|pulled|featured` narrow it the way the page's
// filters do. Newest change first, capped at 500 like the drive index.
export async function GET(request: NextRequest) {
  const limited = await rateLimitResponse(request, "account:scenes-list", {
    limit: 240,
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
  const params = request.nextUrl.searchParams;
  const query = params.get("q")?.trim().slice(0, 100) ?? "";
  const visibility = params.get("visibility") ?? "";
  const status = params.get("status") ?? "";
  const conditions: SQL[] = [eq(storeScenes.accountId, session.accountId)];
  if (query) {
    const pattern = `%${query.replace(/[%_\\]/g, "\\$&")}%`;
    const match = or(
      ilike(storeScenes.name, pattern),
      ilike(storeScenes.slug, pattern),
      sql`array_to_string(${storeScenes.tags}, ' ') ilike ${pattern}`,
    );
    if (match) {
      conditions.push(match);
    }
  }
  if (visibility === "private" || visibility === "public") {
    conditions.push(eq(storeScenes.visibility, visibility));
  }
  if (status === "pulled" || status === "active") {
    conditions.push(eq(storeScenes.status, status));
  } else if (status === "featured") {
    conditions.push(sql`${storeScenes.featuredAt} is not null`);
  }
  const rows = await db
    .select({
      category: storeScenes.category,
      createdAt: storeScenes.createdAt,
      description: storeScenes.description,
      downloadCount: storeScenes.downloadCount,
      featuredAt: storeScenes.featuredAt,
      frameosVersion: storeScenes.frameosVersion,
      hasPreview: sceneHasImageSql,
      id: storeScenes.id,
      latestVersion: storeScenes.latestVersion,
      name: storeScenes.name,
      riskFlags: storeScenes.riskFlags,
      slug: storeScenes.slug,
      status: storeScenes.status,
      tags: storeScenes.tags,
      updatedAt: storeScenes.updatedAt,
      visibility: storeScenes.visibility,
    })
    .from(storeScenes)
    .where(and(...conditions))
    .orderBy(desc(storeScenes.updatedAt))
    .limit(500);
  return NextResponse.json(
    {
      scenes: rows.map((row) => ({
        ...sceneSummary(row),
        has_preview: Boolean(row.hasPreview),
      })),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

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
  // The workspace save's cover hint: "use whatever this frame's snapshot
  // cache holds for this runtime scene" — the image an uploaded zip left
  // there, or the device's own render. Resolved here so the bytes never go
  // through the browser; an unusable hint (foreign frame, nothing cached,
  // not a raster) yields a scene without a preview, never an error.
  const hint = body.preview_from_frame;
  const previewImage =
    hint && typeof hint === "object" && !Array.isArray(hint)
      ? await framePreviewForNewScene(
          db,
          session.accountId,
          (hint as Record<string, unknown>).frame_id,
          (hint as Record<string, unknown>).scene_id,
        )
      : undefined;

  return createAccountScene(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    ...(description ? { description } : {}),
    name: requestedName.length > 0 ? requestedName : "Untitled scene",
    ...(previewImage ? { previewImage } : {}),
    scenes: body.scenes,
  });
}
