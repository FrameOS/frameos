import { strToU8, unzipSync, zipSync } from "fflate";
import { getScenesBaseUrl } from "./env";
import {
  maxSceneZipEntries,
  maxSceneZipUncompressedBytes,
} from "./store";

// Where an installed scene came from — the `origin` field on every scene
// object that leaves the store. The frameos workspace reads it to say
// "installed from …, version N" and to offer an update when the store moves
// on; the self-hosted backend has carried the same field for repository
// templates since before the store existed (frontend/src/utils/sceneOrigin.ts).
//
// The stamp is written at the EGRESS points (device push, scenes.json, zip
// download) from the version row that actually produced the bytes, never at
// publish time: the stored zip stays exactly what was uploaded (object keys
// are content digests, so identical uploads keep deduplicating), old versions
// pick the stamp up without a backfill, and whatever `origin` a publisher's
// own workspace copy carried — their install bookkeeping, or a fork's source
// — is replaced rather than shipped on.
export type StoreSceneOriginSource = {
  id: string;
  slug: string;
  version: number;
};

export type StoreSceneOrigin = {
  /** The scene's public page: `https://scenes.frameos.net/s/<slug>`. */
  href: string;
  /** Store scene uuid — what the assignment and every /api/store route key on. */
  storeSceneId: string;
  /** The store version those bytes came from, as a string like every other origin version. */
  version: string;
  /** The scene's own id inside the published scenes.json (re-links scenes on update). */
  sceneId?: string;
};

export function storeSceneHref(slug: string): string {
  return new URL(`/s/${slug}`, getScenesBaseUrl()).toString();
}

export function storeSceneOrigin(
  source: StoreSceneOriginSource,
): Omit<StoreSceneOrigin, "sceneId"> {
  return {
    href: storeSceneHref(source.slug),
    storeSceneId: source.id,
    version: String(source.version),
  };
}

/** Every scene object of a scenes.json array with its `origin` replaced by this source. */
export function withStoreSceneOrigin<T>(
  scenes: readonly T[],
  source: StoreSceneOriginSource,
): T[] {
  const origin = storeSceneOrigin(source);
  return scenes.map((scene) => {
    if (!scene || typeof scene !== "object" || Array.isArray(scene)) {
      return scene;
    }
    const id = (scene as { id?: unknown }).id;
    return {
      ...scene,
      origin: { ...origin, ...(typeof id === "string" ? { sceneId: id } : {}) },
    } as T;
  });
}

// The template interchange zip with every scene in scenes.json stamped. Only
// the three files frameos reads survive (same as the other rebuildZip*
// helpers in store.ts); the manifest and image bytes are copied through.
export function rebuildZipWithSceneOrigins(
  zipBytes: Buffer,
  source: StoreSceneOriginSource,
): Buffer | undefined {
  try {
    let entryCount = 0;
    let totalUncompressed = 0;
    const files = unzipSync(new Uint8Array(zipBytes), {
      filter: (file) => {
        entryCount += 1;
        totalUncompressed += file.originalSize ?? 0;
        if (
          entryCount > maxSceneZipEntries ||
          totalUncompressed > maxSceneZipUncompressedBytes
        ) {
          throw new Error("zip_bounds_exceeded");
        }
        return /(^|\/)(template\.json|scenes\.json|image\.jpg)$/.test(
          file.name,
        );
      },
    });
    const manifestPath = Object.keys(files)
      .filter((name) => /(^|\/)template\.json$/.test(name))
      .sort(
        (a, b) =>
          a.split("/").length - b.split("/").length || a.localeCompare(b),
      )[0];
    if (!manifestPath) {
      return undefined;
    }
    const folder = manifestPath.slice(
      0,
      manifestPath.length - "template.json".length,
    );
    const scenesBytes = files[`${folder}scenes.json`];
    const manifestBytes = files[manifestPath];
    if (!scenesBytes || !manifestBytes) {
      return undefined;
    }
    const scenes: unknown = JSON.parse(Buffer.from(scenesBytes).toString("utf8"));
    if (!Array.isArray(scenes)) {
      return undefined;
    }
    const next: Record<string, Uint8Array> = {
      [manifestPath]: manifestBytes,
      [`${folder}scenes.json`]: strToU8(
        JSON.stringify(withStoreSceneOrigin(scenes, source), null, 2),
      ),
    };
    const image = files[`${folder}image.jpg`];
    if (image) {
      next[`${folder}image.jpg`] = image;
    }
    return Buffer.from(zipSync(next));
  } catch {
    return undefined;
  }
}
