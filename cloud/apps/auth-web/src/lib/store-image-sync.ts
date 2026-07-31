import { and, desc, eq, isNull, lt } from "drizzle-orm";
import {
  type createDb,
  storeScenes,
  storeSceneVersions,
} from "@frameos-cloud/db";
import { sha256Hex } from "./backups";
import {
  maxSceneZipBytes,
  maxVersionsPerScene,
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

  const content = rebuildZipWithPreview(
    Buffer.from(latest.content),
    previewImage,
  );
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
  await db.insert(storeSceneVersions).values({
    content,
    contentType: "application/zip",
    frameosVersion: validated.value.frameosVersion ?? latest.frameosVersion,
    riskFlags: validated.value.riskFlags,
    sceneId: scene.id,
    sha256: sha256Hex(content),
    sizeBytes: content.length,
    version: nextVersion,
  });
  await db
    .delete(storeSceneVersions)
    .where(
      and(
        eq(storeSceneVersions.sceneId, scene.id),
        lt(storeSceneVersions.version, nextVersion - maxVersionsPerScene + 1),
      ),
    );
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
