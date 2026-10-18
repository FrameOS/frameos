// The store's rule for Photos share links (docs/photos.md "Share links"): a
// scene that holds one is readable by its owner and nobody else.
//
// An album scene carries its album's share link, a bearer credential for the
// whole album, as a plain string. The cloud saves every installed album
// scene as a private store scene, and nothing used to stop the owner from
// handing that scene out: making it public, the scene's sharing link
// (`/s/<slug>?share=`), or a fork of a public scene. So:
//
// - a version with a link is refused on a public scene, and a scene with
//   one in ANY version (every version stays downloadable) cannot be made
//   public or get a sharing link;
// - a scene that takes a version with a link loses its sharing link in the
//   same write, rather than refusing the save: every scene is born with a
//   sharing link (store_scenes.share_token defaults to a random uuid), so
//   refusing would refuse every album scene;
// - the share-token door of the content routes (scenes.json, download)
//   refuses a version with a link, which also covers album scenes saved
//   before these rules.
//
// Private saves of the owner's own scene keep working with the link: that is
// how album scenes are installed.

import { desc, eq } from "drizzle-orm";
import { type createDb, storeSceneVersions } from "@frameos-cloud/db";
import { readBlob } from "./blobs";
import { jsonError } from "./device-flow";
import { hasPhotoShareLink } from "./photos/share-links-in-scenes";
import { extractScenesFromZip } from "./scene-title";

type Database =
  | ReturnType<typeof createDb>
  | Parameters<Parameters<ReturnType<typeof createDb>["transaction"]>[0]>[0];

export const photoLinkErrorCode = "scene_contains_photo_link";
export const photoLinkErrorDetail =
  "This scene contains a Photos album link. Anyone who gets the scene could open the album, so remove the link before sharing it.";

/** The refusal every exposing path answers with. `detail` carries the
 *  wording for clients without the store's error table. */
export function photoLinkRefusal(status = 400) {
  return jsonError(photoLinkErrorCode, status, { detail: photoLinkErrorDetail });
}

/** Whether a version zip's scenes.json holds a share link. */
export function zipHasPhotoShareLink(zip: Buffer): boolean {
  return hasPhotoShareLink(extractScenesFromZip(zip));
}

// Versions are read a few at a time: a scene saved from the editor for a
// year has hundreds of them, each an object-store read.
const versionReadConcurrency = 6;

/** The numbers of the scene's versions (yanked ones included: they stay
 *  downloadable by number) whose scenes hold a share link, newest first.
 *  `firstOnly` stops at the first one found. A version whose bytes are gone
 *  is not served either, so it does not count. */
export async function versionsWithPhotoShareLinks(
  db: Database,
  sceneId: string,
  options: { firstOnly?: boolean } = {},
): Promise<number[]> {
  const rows = await db
    .select({
      id: storeSceneVersions.id,
      objectKey: storeSceneVersions.objectKey,
      version: storeSceneVersions.version,
    })
    .from(storeSceneVersions)
    .where(eq(storeSceneVersions.sceneId, sceneId))
    .orderBy(desc(storeSceneVersions.version));
  const found: number[] = [];
  let next = 0;
  const worker = async () => {
    while (next < rows.length && !(options.firstOnly && found.length > 0)) {
      const row = rows[next++]!;
      // The rare version still kept inline is read on its own, so the scan
      // never holds every zip at once.
      const content = row.objectKey
        ? await readBlob({ objectKey: row.objectKey })
        : await readBlob(
            (
              await db
                .select({ content: storeSceneVersions.content })
                .from(storeSceneVersions)
                .where(eq(storeSceneVersions.id, row.id))
                .limit(1)
            )[0],
          );
      if (content && zipHasPhotoShareLink(content)) {
        found.push(row.version);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(versionReadConcurrency, rows.length) }, worker),
  );
  return found.sort((a, b) => b - a);
}

/** True when any version of the scene holds a share link. */
export async function sceneHasPhotoShareLink(db: Database, sceneId: string): Promise<boolean> {
  return (await versionsWithPhotoShareLinks(db, sceneId, { firstOnly: true })).length > 0;
}
