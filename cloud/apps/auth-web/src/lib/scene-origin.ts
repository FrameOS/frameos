import { readTemplateZip, templateZipBytes, templateZipLegacyBytes } from "./scene-zip";
import { withAppPermissions } from "../../../../../frontend/src/utils/sceneAccess";
import { getScenesBaseUrl } from "./env";

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

/**
 * Every scene object of a scenes.json array with its `origin` replaced by
 * this source, and every JavaScript app that has no config.json
 * `permissions` given the list its code calls for (withAppPermissions,
 * frontend/src/utils/sceneAccess.ts). A frame from 2026.10.16 gives an app
 * exactly its list and an app with none nothing, and store versions are
 * immutable zips, many published before the lists existed: this is where
 * they get one. A list the publisher wrote is left as it is: it is what the
 * store's tags show.
 *
 * `appPermissions: false` leaves the apps alone: the device push for a
 * firmware that predates the lists, so the payload changes exactly when the
 * firmware starts reading them and the hub's firmware-change resync
 * (frame-hub, `fromVersion`) delivers them.
 */
export function withStoreSceneOrigin<T>(
  scenes: readonly T[],
  source: StoreSceneOriginSource,
  options: { appPermissions?: boolean } = {},
): T[] {
  const appPermissions = options.appPermissions !== false;
  const origin = storeSceneOrigin(source);
  return scenes.map((scene) => {
    if (!scene || typeof scene !== "object" || Array.isArray(scene)) {
      return scene;
    }
    const id = (scene as { id?: unknown }).id;
    const stamped = {
      ...scene,
      origin: { ...origin, ...(typeof id === "string" ? { sceneId: id } : {}) },
    } as T;
    return appPermissions ? withAppPermissions(stamped, { onlyMissing: true }) : stamped;
  });
}

// The template interchange zip with every scene stamped, as scene packages
// (docs/scene-packages.md); `layout: "json"` writes the form before packages,
// a scenes.json with the whole array, for a backend that reads only that.
// The manifest and the cover are carried over.
export function rebuildZipWithSceneOrigins(
  zipBytes: Buffer,
  source: StoreSceneOriginSource,
  layout: "packages" | "json" = "packages",
): Buffer | undefined {
  try {
    const zip = readTemplateZip(new Uint8Array(zipBytes));
    if (!zip) {
      return undefined;
    }
    const scenes = withStoreSceneOrigin(zip.scenes, source);
    return layout === "json"
      ? templateZipLegacyBytes(zip.folder, zip.manifest, scenes, zip.image)
      : templateZipBytes(zip.folder, zip.manifest, scenes, zip.image);
  } catch {
    return undefined;
  }
}
