// The bytes an account deletion must take with it. The rows cascade from
// accounts.id (packages/db/src/schema.ts), but objects in the bucket are not
// rows: left alone they stay until someone runs the sweep, and a deleted
// account's photos would sit on R2 for weeks.
//
// Only objects nobody else can point at are deleted here: the account's
// photos and their thumbnails (random keys, one row each) and its frames'
// snapshot cache (`frames/<frame-id>/cache/...`, one frame's namespace).
// Store scene zips, previews and images are content addressed and may be
// shared with another account's fork; once no row names them the sweep
// timer (scripts/object-store-sweep.sh) collects them.

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { frameAssetFiles, frames, photoEntries, type createDb } from "@frameos-cloud/db";
import { logWarn } from "./log";
import { objectStore } from "./object-store";

type Database = ReturnType<typeof createDb>;

/**
 * Every object only this account's rows point at. Read it BEFORE the account
 * row goes: afterwards the rows that name the keys are gone.
 */
export async function accountPrivateObjectKeys(db: Database, accountId: string): Promise<string[]> {
  const photoRows = await db
    .select({ objectKey: photoEntries.objectKey, thumbObjectKey: photoEntries.thumbObjectKey })
    .from(photoEntries)
    .where(eq(photoEntries.accountId, accountId));
  const frameIds = (
    await db.select({ id: frames.id }).from(frames).where(eq(frames.accountId, accountId))
  ).map((row) => row.id);
  const snapshotRows = frameIds.length
    ? await db
        .select({ objectKey: frameAssetFiles.objectKey })
        .from(frameAssetFiles)
        .where(and(inArray(frameAssetFiles.frameId, frameIds), isNotNull(frameAssetFiles.objectKey)))
    : [];
  const keys = new Set<string>();
  for (const row of photoRows) {
    for (const key of [row.objectKey, row.thumbObjectKey]) {
      if (key) {
        keys.add(key);
      }
    }
  }
  for (const row of snapshotRows) {
    if (row.objectKey) {
      keys.add(row.objectKey);
    }
  }
  return [...keys];
}

/**
 * Delete objects whose rows are already gone. Failures are logged, never
 * thrown: the account is deleted either way, and the sweep collects what is
 * left behind.
 */
export async function deleteErasedObjects(keys: string[]) {
  const pending = [...keys];
  const store = objectStore();
  const worker = async () => {
    for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
      try {
        await store.delete(key);
      } catch (error) {
        logWarn("account.object_delete_failed", {
          error: error instanceof Error ? error.message : String(error),
          objectKey: key,
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, pending.length) }, worker));
}
