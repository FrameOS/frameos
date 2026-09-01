import { and, desc, eq, gt, sql } from "drizzle-orm";
import { accounts, createDb, storeScenes } from "@frameos-cloud/db";
import { getScenesBaseUrl } from "./env";
import { frameosVersionSatisfiesSql } from "./store-versions-sql";
import { sceneCoverHeightSql, sceneCoverWidthSql, sceneHasImageSql } from "./store-listing";

// The public store index in the frameos repository JSON format, shared by the
// unversioned index (/api/store/repository.json) and the per-version ones
// (/api/store/{frameosVersion}/repository.json).

type Database = ReturnType<typeof createDb>;

export const storeRepositoryLimit = 500;

export async function buildStoreRepository(
  db: Database,
  { frameosVersion }: { frameosVersion?: string } = {},
) {
  const conditions = [
    eq(storeScenes.visibility, "public"),
    eq(storeScenes.status, "active"),
    gt(storeScenes.latestVersion, 0),
  ];
  if (frameosVersion) {
    conditions.push(
      frameosVersionSatisfiesSql(storeScenes.frameosVersion, frameosVersion),
    );
  }

  const scenes = await db
    .select({
      authorName: accounts.displayName,
      category: storeScenes.category,
      description: storeScenes.description,
      downloadCount: storeScenes.downloadCount,
      featuredAt: storeScenes.featuredAt,
      frameosVersion: storeScenes.frameosVersion,
      hasPreview: sceneHasImageSql,
      id: storeScenes.id,
      latestVersion: storeScenes.latestVersion,
      name: storeScenes.name,
      previewImageHeight: sceneCoverHeightSql,
      previewImageWidth: sceneCoverWidthSql,
      riskFlags: storeScenes.riskFlags,
      slug: storeScenes.slug,
      tags: storeScenes.tags,
    })
    .from(storeScenes)
    .leftJoin(accounts, eq(accounts.id, storeScenes.accountId))
    .where(and(...conditions))
    .orderBy(
      sql`${storeScenes.featuredAt} desc nulls last`,
      desc(storeScenes.downloadCount),
      desc(storeScenes.updatedAt),
    )
    .limit(storeRepositoryLimit);

  const baseUrl = getScenesBaseUrl();
  const absolute = (path: string) => new URL(path, baseUrl).toString();
  // The unversioned index sits next to the scene routes, so it can keep the
  // relative "./..." form frameos resolves against the repository URL. A
  // versioned index lives one directory deeper, where "./scenes/…" would
  // resolve inside the version folder — and the frameos backend only rewrites
  // URLs that start with "./" (app/models/repository.py), so "../scenes/…"
  // would leak through unresolved. Versioned indexes therefore emit absolute
  // URLs, exactly like the "my cloud drive" index does.
  const asset = frameosVersion
    ? (path: string) => absolute(`/api/store${path}`)
    : (path: string) => `.${path}`;

  return {
    description: frameosVersion
      ? `Scenes published by the FrameOS community that run on FrameOS ${frameosVersion}`
      : "Scenes published by the FrameOS community",
    name: "FrameOS Cloud store",
    templates: scenes.map((scene) => ({
      // Extra fields (author, flags) are ignored by older frameos installs.
      author: scene.authorName ?? undefined,
      category: scene.category ?? undefined,
      description: scene.description ?? undefined,
      flags: scene.riskFlags.length > 0 ? scene.riskFlags : undefined,
      frameosVersion: scene.frameosVersion ?? undefined,
      id: scene.slug,
      // ?v pins the preview to the published version, making the image URL
      // immutable — the route answers it with a forever cache-control, so
      // the CDN edge serves thumbnails without touching Postgres.
      image: scene.hasPreview ? asset(`/scenes/${scene.id}/image?v=${scene.latestVersion}`) : undefined,
      imageHeight: scene.previewImageHeight ?? undefined,
      imageWidth: scene.previewImageWidth ?? undefined,
      name: scene.name,
      // The scene uuid. The /frames workspace needs it to assign a picked
      // scene to a cloud frame (POST /api/frames/{id}/scenes takes store
      // scene ids) and to reach /scenes/{id}/scenes.json without parsing it
      // out of the zip URL; the drive index has carried it for the same
      // reason since it shipped. Older frameos installs ignore extra fields.
      sceneId: scene.id,
      tags: scene.tags.length > 0 ? scene.tags : undefined,
      // Human-facing scene page ("View store page" in frameos' templates
      // panel); absolute because it lives outside the /api/store/ prefix
      // that the "./" URLs resolve against.
      url: absolute(`/s/${scene.slug}`),
      version: String(scene.latestVersion),
      zip: asset(`/scenes/${scene.id}/download`),
    })),
  };
}
