// Content-addressed blobs on top of the object store (object-store.ts).
//
// The rule for every table that used to hold a `bytea`: the row keeps
// `content` (nullable) AND an `object_key`, and exactly one of them is set.
// Writes go to the object store and leave `content` null. The column is empty
// everywhere it has ever been deployed, and stays only as the reading half of
// migration 0032's contract — `readBlob` serves whichever of the two a row
// carries, so a row that predates the move would still work.
//
// Keys are `<namespace>/<sha256>` — content-addressed, so republishing the
// same preview PNG a thousand times stores it once and `storeBlob` skips the
// upload entirely when the object is already there. The flip side is that two
// rows can share a key, so deletion has to ask whether anyone else still
// points at it: `deleteBlobIfUnreferenced` takes that question as a callback
// rather than guessing.

import { createHash } from "node:crypto";
import { logWarn } from "./log";
import { isValidObjectKey, objectStore } from "./object-store";

/** Namespaces, one per kind of thing, because this bucket will hold more. */
export const blobNamespaces = {
  sceneImage: "store/scene-images",
  scenePreview: "store/scene-previews",
  sceneVersion: "store/scene-versions",
} as const;

export type BlobNamespace =
  (typeof blobNamespaces)[keyof typeof blobNamespaces] | `frames/${string}/cache`;

/**
 * The per-frame namespace for cached device assets. Scoped by frame rather
 * than global so one frame's cache can be reasoned about (and swept) on its
 * own, and so two accounts' identical files never share an object.
 */
export function frameCacheNamespace(frameId: string): BlobNamespace {
  if (!/^[0-9a-f-]{36}$/i.test(frameId)) {
    throw new Error(`Invalid frame id for object key: ${JSON.stringify(frameId)}`);
  }
  return `frames/${frameId}/cache`;
}

export type StoredBlob = {
  objectKey: string;
  sha256: string;
  sizeBytes: number;
};

export function blobSha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function blobObjectKey(
  namespace: BlobNamespace,
  sha256: string,
  extension?: string,
): string {
  const suffix = extension ? `.${extension.replace(/^\.+/, "")}` : "";
  const key = `${namespace}/${sha256}${suffix}`;
  if (!isValidObjectKey(key)) {
    throw new Error(`Invalid object key: ${JSON.stringify(key)}`);
  }
  return key;
}

/**
 * Put `content` in the object store and return what the row should record.
 * Idempotent by construction: the key is the digest, so a second call with the
 * same bytes finds the object already there and uploads nothing.
 */
export async function storeBlob(
  namespace: BlobNamespace,
  content: Buffer,
  contentType: string,
  options?: { extension?: string },
): Promise<StoredBlob> {
  const sha256 = blobSha256(content);
  const objectKey = blobObjectKey(namespace, sha256, options?.extension);
  const store = objectStore();
  const existing = await store.head(objectKey);
  if (existing !== content.length) {
    // A size mismatch on a content-addressed key means a truncated earlier
    // write, so overwrite rather than trust it.
    await store.put(objectKey, content, contentType);
  }
  return { objectKey, sha256, sizeBytes: content.length };
}

export type BlobRow = {
  content?: Buffer | null;
  objectKey?: string | null;
};

/**
 * The bytes a row points at, wherever they are. Returns undefined when the row
 * has neither — a preview that was never uploaded, or an object that has gone
 * missing (which reads as "no image", never as a crashed page).
 */
export async function readBlob(row: BlobRow | undefined): Promise<Buffer | undefined> {
  if (!row) {
    return undefined;
  }
  if (row.content && row.content.length > 0) {
    return row.content;
  }
  if (!row.objectKey) {
    return undefined;
  }
  return await objectStore().get(row.objectKey);
}

/**
 * Delete the object behind `objectKey` unless some other row still references
 * it. `stillReferenced` is asked only when there is something to delete, and
 * a `true` answer leaves the object alone.
 */
export async function deleteBlobIfUnreferenced(
  objectKey: string | null | undefined,
  stillReferenced: () => Promise<boolean>,
): Promise<void> {
  if (!objectKey) {
    return;
  }
  if (await stillReferenced()) {
    return;
  }
  try {
    await objectStore().delete(objectKey);
  } catch (error) {
    // Reclaiming space is never worth failing the request that freed it. The
    // row is already gone by the time this runs, so throwing here would 500 a
    // delete that actually succeeded. A bucket lock refusing the delete (R2
    // retention rules answer 403), a credential that lost delete permission,
    // and a transient R2 error all land here; the object becomes garbage that
    // scripts/object-store-sweep.sh collects once the reason goes away.
    logWarn("object_store.delete_failed", {
      error: error instanceof Error ? error.message : String(error),
      objectKey,
    });
  }
}

/**
 * A CDN URL for an object that is public by construction (a public store
 * scene's zip, preview or gallery image). undefined when the deployment has no
 * public alias configured, or when the row still keeps its bytes in Postgres —
 * both cases mean "serve it yourself".
 *
 * Never call this for anything private: the alias has no authentication in
 * front of it, and a content-addressed key is a capability.
 */
export function publicBlobUrl(objectKey: string | null | undefined): string | undefined {
  if (!objectKey) {
    return undefined;
  }
  return objectStore().publicUrl(objectKey);
}
