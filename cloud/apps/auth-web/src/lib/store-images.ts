import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  type createDb,
  storeImages,
  storeSceneVersionImages,
  storeSceneVersions,
} from "@frameos-cloud/db";
import { blobNamespaces, readBlob, storeBlob } from "./blobs";
import {
  detectImageContentType,
  imageDimensions,
  maxImagesPerScene,
} from "./store";

// Store images are content-addressed: one store_images row per distinct
// bytes, keyed by digest, and versions link to them in order. Nothing is
// ever copied — a fork, a reorder, a screenshot kept across ten versions all
// point at the same row and the same object. Uploading registers bytes;
// publishing a version binds them.

type Database =
  | ReturnType<typeof createDb>
  | Parameters<Parameters<ReturnType<typeof createDb>["transaction"]>[0]>[0];

export type StoreImage = {
  contentType: string;
  height: number | null;
  objectKey: string;
  sha256: string;
  sizeBytes: number;
  width: number | null;
};

export const sha256Pattern = /^[0-9a-f]{64}$/;

/** Put image bytes in the store and record them. Idempotent: the same bytes
 * come back with the same digest and no second row. The caller has already
 * vetted the bytes (a real raster, within size, not transparent, moderated).
 */
export async function registerStoreImage(
  db: Database,
  content: Buffer,
  contentType?: string,
  /** Dimensions the caller knows (a zip manifest's), used when the bytes
   * do not say — WebP and GIF headers are not read. */
  known?: { height?: number | undefined; width?: number | undefined },
): Promise<StoreImage> {
  const type = contentType ?? detectImageContentType(content) ?? "image/jpeg";
  const stored = await storeBlob(blobNamespaces.sceneImage, content, type);
  const size = imageDimensions(content);
  const width = size?.width ?? known?.width ?? null;
  const height = size?.height ?? known?.height ?? null;
  const [row] = await db
    .insert(storeImages)
    .values({
      contentType: type,
      height,
      objectKey: stored.objectKey,
      sha256: stored.sha256,
      sizeBytes: stored.sizeBytes,
      width,
    })
    // The same bytes under an older key (a publish-time preview lives under
    // store/scene-previews) keep their row; the object is the same either
    // way once read through readBlob. Dimensions fill in when a later
    // registration knows them.
    .onConflictDoUpdate({
      set: {
        height: sql`coalesce(${storeImages.height}, ${height})`,
        width: sql`coalesce(${storeImages.width}, ${width})`,
      },
      target: storeImages.sha256,
    })
    .returning();
  return row ?? (await storeImageRows(db, [stored.sha256]))[0]!;
}

/** The rows for these digests, in the order asked for; digests nobody
 * registered are simply missing from the result. */
export async function storeImageRows(
  db: Database,
  shas: readonly string[],
): Promise<StoreImage[]> {
  if (shas.length === 0) {
    return [];
  }
  const rows = await db
    .select()
    .from(storeImages)
    .where(inArray(storeImages.sha256, [...shas]));
  const bySha = new Map(rows.map((row) => [row.sha256, row]));
  return shas.flatMap((sha) => {
    const row = bySha.get(sha);
    return row ? [row] : [];
  });
}

/** The ordered image set of one version of a scene (`version` null: the
 * latest non-yanked one). A version published before image sets were
 * recorded per version shows the latest version's set — the images the
 * scene had when recording began, which is what its page showed then. */
export async function imageSetForVersion(
  db: Database,
  sceneId: string,
  version: number | null,
): Promise<StoreImage[]> {
  const [row] = await db
    .select({
      id: storeSceneVersions.id,
      listingRecorded: storeSceneVersions.listingRecorded,
    })
    .from(storeSceneVersions)
    .where(
      version === null
        ? and(eq(storeSceneVersions.sceneId, sceneId), isNull(storeSceneVersions.yankedAt))
        : and(eq(storeSceneVersions.sceneId, sceneId), eq(storeSceneVersions.version, version)),
    )
    .orderBy(desc(storeSceneVersions.version))
    .limit(1);
  if (!row) {
    return [];
  }
  if (!row.listingRecorded && version !== null) {
    return imageSetForVersion(db, sceneId, null);
  }
  return imageSetForVersionId(db, row.id);
}

export async function imageSetForVersionId(
  db: Database,
  versionId: string,
): Promise<StoreImage[]> {
  return db
    .select({
      contentType: storeImages.contentType,
      height: storeImages.height,
      objectKey: storeImages.objectKey,
      sha256: storeImages.sha256,
      sizeBytes: storeImages.sizeBytes,
      width: storeImages.width,
    })
    .from(storeSceneVersionImages)
    .innerJoin(storeImages, eq(storeImages.sha256, storeSceneVersionImages.imageSha256))
    .where(eq(storeSceneVersionImages.versionId, versionId))
    .orderBy(asc(storeSceneVersionImages.position));
}

/** The bytes of a store image. */
export async function readStoreImage(image: { objectKey: string }): Promise<Buffer | undefined> {
  return readBlob({ objectKey: image.objectKey });
}

/** Validates a draft's image list: digests only, no repeats, within the
 * per-version limit, and every one registered. Returns the rows in order or
 * the API error code. */
export async function resolveImageSet(
  db: Database,
  input: unknown,
): Promise<{ images: StoreImage[] } | { error: string }> {
  if (
    !Array.isArray(input) ||
    input.length > maxImagesPerScene ||
    !input.every((sha): sha is string => typeof sha === "string" && sha256Pattern.test(sha)) ||
    new Set(input).size !== input.length
  ) {
    return { error: "invalid_images" };
  }
  const images = await storeImageRows(db, input);
  if (images.length !== input.length) {
    return { error: "image_not_found" };
  }
  return { images };
}

export function sameImageSet(a: readonly { sha256: string }[], b: readonly { sha256: string }[]): boolean {
  return a.length === b.length && a.every((image, index) => image.sha256 === b[index]?.sha256);
}
