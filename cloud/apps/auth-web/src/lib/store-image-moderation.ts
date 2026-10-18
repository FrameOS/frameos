// Image moderation for the store happens when an image is about to be shown
// publicly, not before. A private scene's cover is often a personal photo
// (an album scene's cover is one of the album's thumbnails) or the frame's
// own render, and it used to go to OpenAI on every save. Now the image goes
// when the scene is public or becoming public: a publish or a flip to public
// (every image any version links, since each version's page shows its own),
// and a new version, a new cover or a gallery upload on a scene that already
// is. Text (name, description, tags, the version note) is still checked on
// every save. Without a key nothing is checked; with one, an image that
// cannot be checked keeps the scene private (fails closed).

import { eq, inArray } from "drizzle-orm";
import {
  type createDb,
  storeImages,
  storeSceneVersionImages,
  storeSceneVersions,
} from "@frameos-cloud/db";
import type { NextResponse } from "next/server";
import { recordAuditEvent } from "./audit";
import { jsonError } from "./device-flow";
import {
  isModerationConfigured,
  moderateStoreContent,
  type ModerationResult,
} from "./moderation";
import { readStoreImage, type StoreImage } from "./store-images";
import { photoLinkRefusal, sceneHasPhotoShareLink } from "./store-photo-links";
import type { PublishActor } from "./store-publish";

type Database =
  | ReturnType<typeof createDb>
  | Parameters<Parameters<ReturnType<typeof createDb>["transaction"]>[0]>[0];

// One image per moderation call, a few calls at a time.
const imageModerationConcurrency = 4;

/** Every distinct image some version of the scene links: what a public
 *  scene's pages and image route serve. */
export async function imagesLinkedByScene(db: Database, sceneId: string): Promise<StoreImage[]> {
  const links = await db
    .selectDistinct({ sha256: storeSceneVersionImages.imageSha256 })
    .from(storeSceneVersionImages)
    .innerJoin(storeSceneVersions, eq(storeSceneVersions.id, storeSceneVersionImages.versionId))
    .where(eq(storeSceneVersions.sceneId, sceneId));
  if (links.length === 0) {
    return [];
  }
  return db
    .select({
      contentType: storeImages.contentType,
      height: storeImages.height,
      objectKey: storeImages.objectKey,
      sha256: storeImages.sha256,
      sizeBytes: storeImages.sizeBytes,
      width: storeImages.width,
    })
    .from(storeImages)
    .where(
      inArray(
        storeImages.sha256,
        links.map((link) => link.sha256),
      ),
    );
}

/** Moderates each image on its own. A rejection anywhere rejects the lot
 *  (with every category that fired); otherwise one image that could not be
 *  checked makes the whole answer `moderation_unavailable`. An image whose
 *  bytes are gone is not served, so it is skipped. */
export async function moderateStoreImages(
  images: readonly Pick<StoreImage, "contentType" | "objectKey">[],
): Promise<ModerationResult> {
  if (!isModerationConfigured() || images.length === 0) {
    return { checked: isModerationConfigured(), ok: true };
  }
  const results: ModerationResult[] = [];
  let next = 0;
  const worker = async () => {
    while (next < images.length) {
      const image = images[next++]!;
      const content = await readStoreImage(image);
      if (!content) {
        continue;
      }
      results.push(
        await moderateStoreContent({
          image: { content, contentType: image.contentType },
          texts: [],
        }),
      );
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(imageModerationConcurrency, images.length) }, worker),
  );
  const categories = new Set<string>();
  for (const result of results) {
    if (!result.ok && result.error === "content_rejected") {
      result.categories.forEach((category) => categories.add(category));
    }
  }
  if (categories.size > 0) {
    return { categories: [...categories].sort(), error: "content_rejected", ok: false };
  }
  if (results.some((result) => !result.ok)) {
    return { error: "moderation_unavailable", ok: false };
  }
  return { checked: true, ok: true };
}

/** What turning an existing scene public checks besides its listing text:
 *  no version holds a Photos share link (store-photo-links.ts), and every
 *  image some version links passes moderation. The refusal to answer with,
 *  or undefined when the scene may go public. */
export async function goingPublicRefusal(
  db: ReturnType<typeof createDb>,
  input: { accountId: string; actor: PublishActor; sceneId: string; sceneName: string },
): Promise<NextResponse | undefined> {
  if (await sceneHasPhotoShareLink(db, input.sceneId)) {
    return photoLinkRefusal();
  }
  const moderation = await moderateStoreImages(await imagesLinkedByScene(db, input.sceneId));
  if (moderation.ok) {
    return undefined;
  }
  if (moderation.error === "content_rejected") {
    await recordAuditEvent(db, {
      accountId: input.accountId,
      actor: input.actor,
      eventType: "store.publish_rejected",
      metadata: { categories: moderation.categories, images: true, name: input.sceneName },
      target: { sceneId: input.sceneId },
    });
    return jsonError("content_rejected", 422, { categories: moderation.categories });
  }
  return jsonError("moderation_unavailable", 503);
}
