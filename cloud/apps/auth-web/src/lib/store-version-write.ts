import { eq } from "drizzle-orm";
import {
  type createDb,
  storeSceneVersionImages,
  storeSceneVersions,
  storeScenes,
} from "@frameos-cloud/db";
import { blobNamespaces, blobSha256, storeBlob, type StoredBlob } from "./blobs";
import type { SceneListing } from "./store-listing";
import {
  readStoreImage,
  sameImageSet,
  type StoreImage,
} from "./store-images";
import {
  maxSceneZipBytes,
  rebuildZip,
  validateSceneZip,
  type ValidatedSceneZip,
} from "./store";

type Database =
  | ReturnType<typeof createDb>
  | Parameters<Parameters<ReturnType<typeof createDb>["transaction"]>[0]>[0];

// The one place a version is written. Every path that publishes — the
// editor's Save, a zip upload, a linked backend's push, a fork, the AI's
// save_scene — ends here, so a version always records the same three
// things: the zip, the listing it was published with, and its image set,
// with the scene row projected from it in the same transaction.

/** Make the zip's single cover (image.jpg) the set's position 0 — the
 * interchange format knows one image, and a download must show what the
 * page shows. Leaves the zip alone when it already does. Returns the bytes
 * to publish, or the error code. */
export async function alignZipCover(
  content: Buffer,
  validated: ValidatedSceneZip,
  images: readonly StoreImage[],
): Promise<
  | { content: Buffer; validated: ValidatedSceneZip }
  | { error: "invalid_scene_zip" | "scene_too_large" | "image_not_found" | string }
> {
  const cover = images[0];
  const currentSha = validated.previewImage ? blobSha256(validated.previewImage) : undefined;
  if ((cover?.sha256 ?? undefined) === currentSha) {
    return { content, validated };
  }
  const coverBytes = cover ? await readStoreImage(cover) : undefined;
  if (cover && !coverBytes) {
    return { error: "image_not_found" };
  }
  const rebuilt = rebuildZip(content, { previewImage: coverBytes ?? null });
  if (!rebuilt) {
    return { error: "invalid_scene_zip" };
  }
  if (rebuilt.length > maxSceneZipBytes) {
    return { error: "scene_too_large" };
  }
  const revalidated = validateSceneZip(rebuilt);
  if (!revalidated.ok) {
    return { error: revalidated.error };
  }
  return { content: rebuilt, validated: revalidated.value };
}

export type WriteVersionInput = {
  sceneId: string;
  version: number;
  /** The final zip bytes, already validated (`validated` is their result). */
  content: Buffer;
  validated: ValidatedSceneZip;
  /** The listing this version records — and projects onto the scene row. */
  listing: SceneListing;
  /** The ordered image set, all registered. */
  images: readonly StoreImage[];
  message?: string | null | undefined;
  publishedByLinkedClientId?: string | undefined;
  /** Extra scene-row updates published alongside (name, visibility…). */
  rowChanges?: Partial<{
    linkedClientId: string | null;
    name: string;
    visibility: string;
  }>;
};

/** Stores the zip (outside the transaction: a network call must not pin a
 * connection) then writes the version, its links and the row projection
 * atomically. */
export async function writeSceneVersion(
  db: Database,
  input: WriteVersionInput,
): Promise<
  | { stored: StoredBlob; updated: typeof storeScenes.$inferSelect }
  | { error: "scene_update_failed" }
> {
  const stored = await storeBlob(
    blobNamespaces.sceneVersion,
    input.content,
    "application/zip",
    { extension: "zip" },
  );
  const result = await db.transaction(async (tx) => {
    const [version] = await tx
      .insert(storeSceneVersions)
      .values({
        category: input.listing.category,
        contentType: "application/zip",
        description: input.listing.description,
        frameosVersion: input.listing.frameosVersion,
        listingRecorded: true,
        message: input.message ?? null,
        objectKey: stored.objectKey,
        ...(input.publishedByLinkedClientId
          ? { publishedByLinkedClientId: input.publishedByLinkedClientId }
          : {}),
        riskFlags: input.validated.riskFlags,
        sceneId: input.sceneId,
        sha256: stored.sha256,
        sizeBytes: stored.sizeBytes,
        tags: input.listing.tags,
        version: input.version,
      })
      .returning({ id: storeSceneVersions.id });
    if (!version) {
      return undefined;
    }
    if (input.images.length > 0) {
      await tx.insert(storeSceneVersionImages).values(
        input.images.map((image, position) => ({
          imageSha256: image.sha256,
          position,
          versionId: version.id,
        })),
      );
    }
    const [updated] = await tx
      .update(storeScenes)
      .set({
        category: input.listing.category,
        description: input.listing.description,
        frameosVersion: input.listing.frameosVersion,
        latestVersion: input.version,
        riskFlags: input.validated.riskFlags,
        tags: input.listing.tags,
        updatedAt: new Date(),
        ...(input.rowChanges ?? {}),
      })
      .where(eq(storeScenes.id, input.sceneId))
      .returning();
    return updated;
  });
  if (!result) {
    return { error: "scene_update_failed" };
  }
  return { stored, updated: result };
}

export { sameImageSet };
