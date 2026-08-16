import { and, desc, eq, isNull } from "drizzle-orm";
import {
  type createDb,
  storeScenes,
  storeSceneVersions,
} from "@frameos-cloud/db";
import { blobNamespaces, readBlob, storeBlob } from "./blobs";
import {
  maxSceneZipBytes,
  rebuildZipWithPreview,
  validateSceneZip,
} from "./store";

type SyncResult =
  | { ok: true; version: number }
  | {
      ok: false;
      error: "invalid_scene_zip" | "scene_too_large" | "version_not_found";
    };

// Append an immutable version whose single FrameOS preview matches the lead
// cloud-gallery image. Existing versions are intentionally never rewritten.
export async function syncLatestSceneZipPreview(
  db: ReturnType<typeof createDb>,
  scene: { id: string; latestVersion: number },
  previewImage?: Buffer,
): Promise<SyncResult> {
  const [latest] = await db
    .select({
      content: storeSceneVersions.content,
      frameosVersion: storeSceneVersions.frameosVersion,
      objectKey: storeSceneVersions.objectKey,
    })
    .from(storeSceneVersions)
    .where(
      and(
        eq(storeSceneVersions.sceneId, scene.id),
        isNull(storeSceneVersions.yankedAt),
      ),
    )
    .orderBy(desc(storeSceneVersions.version))
    .limit(1);
  if (!latest) {
    return { ok: false, error: "version_not_found" };
  }
  const latestContent = await readBlob(latest);
  if (!latestContent) {
    return { ok: false, error: "version_not_found" };
  }

  const content = rebuildZipWithPreview(Buffer.from(latestContent), previewImage);
  if (!content) {
    return { ok: false, error: "invalid_scene_zip" };
  }
  if (content.length > maxSceneZipBytes) {
    return { ok: false, error: "scene_too_large" };
  }

  const validated = validateSceneZip(content);
  if (!validated.ok) {
    return { ok: false, error: "invalid_scene_zip" };
  }

  const nextVersion = scene.latestVersion + 1;
  const stored = await storeBlob(
    blobNamespaces.sceneVersion,
    content,
    "application/zip",
    { extension: "zip" },
  );
  await db.insert(storeSceneVersions).values({
    contentType: "application/zip",
    frameosVersion: validated.value.frameosVersion ?? latest.frameosVersion,
    objectKey: stored.objectKey,
    riskFlags: validated.value.riskFlags,
    sceneId: scene.id,
    sha256: stored.sha256,
    sizeBytes: stored.sizeBytes,
    version: nextVersion,
  });
  // No version prune any more: the bytes are not Postgres blobs, so the
  // documented deviation from immutable-versions-forever (STORE-TODO
  // decision 2) has nothing left to buy.
  await db
    .update(storeScenes)
    .set({
      latestVersion: nextVersion,
      riskFlags: validated.value.riskFlags,
      updatedAt: new Date(),
    })
    .where(eq(storeScenes.id, scene.id));

  return { ok: true, version: nextVersion };
}
