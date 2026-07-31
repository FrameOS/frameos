import { and, desc, eq, gt, sql } from "drizzle-orm";
import { accounts, storeScenes } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { requireDatabase } from "../../../../src/lib/device-flow";
import { getScenesBaseUrl } from "../../../../src/lib/env";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";

export const runtime = "nodejs";

// The public store index in the frameos repository JSON format, so any
// FrameOS install (old or new) can add
//   {provider}/api/store/repository.json
// as a plain scenes repository. frameos resolves "./..." URLs against this
// file's URL, which lands on /api/store/scenes/{id}/....
export async function GET(request: NextRequest) {
  const limited = rateLimitResponse(request, "store:index", {
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

  const scenes = await db
    .select({
      authorName: accounts.displayName,
      category: storeScenes.category,
      description: storeScenes.description,
      downloadCount: storeScenes.downloadCount,
      featuredAt: storeScenes.featuredAt,
      frameosVersion: storeScenes.frameosVersion,
      hasPreview: sql<boolean>`${storeScenes.previewImage} is not null`,
      id: storeScenes.id,
      latestVersion: storeScenes.latestVersion,
      name: storeScenes.name,
      previewImageHeight: storeScenes.previewImageHeight,
      previewImageWidth: storeScenes.previewImageWidth,
      riskFlags: storeScenes.riskFlags,
      slug: storeScenes.slug,
      tags: storeScenes.tags,
    })
    .from(storeScenes)
    .leftJoin(accounts, eq(accounts.id, storeScenes.accountId))
    .where(
      and(
        eq(storeScenes.visibility, "public"),
        eq(storeScenes.status, "active"),
        gt(storeScenes.latestVersion, 0),
      ),
    )
    .orderBy(
      sql`${storeScenes.featuredAt} desc nulls last`,
      desc(storeScenes.downloadCount),
      desc(storeScenes.updatedAt),
    )
    .limit(500);

  return NextResponse.json(
    {
      description: "Scenes published by the FrameOS community",
      name: "FrameOS Cloud store",
      templates: scenes.map((scene) => ({
        // Extra fields (author, flags) are ignored by older frameos installs.
        author: scene.authorName ?? undefined,
        category: scene.category ?? undefined,
        description: scene.description ?? undefined,
        flags: scene.riskFlags.length > 0 ? scene.riskFlags : undefined,
        frameosVersion: scene.frameosVersion ?? undefined,
        id: scene.slug,
        image: scene.hasPreview ? `./scenes/${scene.id}/image` : undefined,
        imageHeight: scene.previewImageHeight ?? undefined,
        imageWidth: scene.previewImageWidth ?? undefined,
        name: scene.name,
        tags: scene.tags.length > 0 ? scene.tags : undefined,
        // Human-facing scene page ("View store page" in frameos' templates
        // panel); absolute because it lives outside the /api/store/ prefix
        // that the "./" URLs resolve against.
        url: new URL(`/s/${scene.slug}`, getScenesBaseUrl()).toString(),
        version: String(scene.latestVersion),
        zip: `./scenes/${scene.id}/download`,
      })),
    },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}
