import { logWarn } from "./log";
import { objectStore } from "./object-store";
import { makePhotoThumbnail, photoThumbMaxSide } from "./photos/thumbnail";

// The covers the Scene store on a frame shows (docs/scene-store.md). A store
// cover is the publisher's own picture, often a megabyte of PNG at 800 x 600
// or more: an ESP32 took 5 to 7 s to download and decode one for a card
// 140 px wide, with the panel waiting. The device listing hands frames this
// copy instead: the cover drawn once as a JPEG of at most 512 px (the photo
// library's thumbnailer), stored next to the cover and served from the CDN
// like it. The frame still fetches it straight from the CDN: this is the
// store scaling its own pictures, as the gallery does, not a proxy for a
// frame's images (AGENTS.md, "no image proxies for frames").
//
// The key is the cover's own plus a suffix, so it is as content-addressed as
// the cover, and the object-store sweep keeps it while the cover's
// store_images row lives (cloud/scripts/object-store-sweep.sh).

export const deviceCoverSuffix = ".device.jpg";
export const deviceCoverMaxSide = photoThumbMaxSide;

// The copies this process has seen in the store, and the ones being made.
const stored = new Set<string>();
const making = new Map<string, Promise<boolean>>();
const storedLimit = 5000;
// Made at most this many at once: the first listing of a page can ask for 24.
const makingAtOnce = 4;

export function deviceCoverKey(coverKey: string): string {
  return `${coverKey}${deviceCoverSuffix}`;
}

async function make(coverKey: string, key: string): Promise<boolean> {
  const store = objectStore();
  if ((await store.head(key)) !== undefined) {
    return true;
  }
  const cover = await store.get(coverKey);
  if (!cover) {
    return false;
  }
  const copy = await makePhotoThumbnail(cover);
  if (!copy) {
    return false;
  }
  await store.put(key, copy, "image/jpeg");
  return true;
}

async function ensure(coverKey: string): Promise<boolean> {
  const key = deviceCoverKey(coverKey);
  if (stored.has(key)) {
    return true;
  }
  let pending = making.get(key);
  if (!pending) {
    pending = make(coverKey, key)
      .catch((error: unknown) => {
        logWarn("store.device_cover_failed", { coverKey, error: String(error) });
        return false;
      })
      .finally(() => making.delete(key));
    making.set(key, pending);
  }
  const ok = await pending;
  if (ok) {
    if (stored.size >= storedLimit) {
      stored.clear();
    }
    stored.add(key);
  }
  return ok;
}

/**
 * For each cover's object key, the CDN URL of its device copy, made now when
 * it is missing; null for no cover, a copy that could not be made, or a
 * deployment without a public alias (a dev machine serves covers itself).
 */
export async function deviceCoverUrls(coverKeys: (string | null)[]): Promise<(string | null)[]> {
  const urls: (string | null)[] = coverKeys.map(() => null);
  for (let start = 0; start < coverKeys.length; start += makingAtOnce) {
    await Promise.all(
      coverKeys.slice(start, start + makingAtOnce).map(async (coverKey, offset) => {
        if (!coverKey) {
          return;
        }
        const url = objectStore().publicUrl(deviceCoverKey(coverKey));
        if (url && (await ensure(coverKey))) {
          urls[start + offset] = url;
        }
      }),
    );
  }
  return urls;
}

export function forgetDeviceCoversForTests() {
  stored.clear();
  making.clear();
}
