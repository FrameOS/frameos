// The update manifest (docs/update-manifest.json, docs/auto-updates.md
// "Where it lives, and who serves it"), read from main on GitHub. The cloud
// decides for its own frames from it (the device firmware routes, the frame
// hub's sweep), runs the rule for anyone at /api/updates/next and
// /api/updates/firmware, and mirrors it at /api/updates/manifest — the
// fallback a self-hosted backend or a standalone Pi asks when GitHub does not
// answer.
//
// Fresh for ten minutes; concurrent callers share one fetch; the last good
// copy is kept for as long as the process lives and served whenever GitHub
// fails (a manifest hours old is still a manifest: blocks arrive late, which
// is no worse than GitHub being down); a failure backs off a minute before
// the next attempt. Undefined only when there has never been a good copy: the
// callers then install nothing automatically (fail closed).
//
// FRAMEOS_UPDATE_MANIFEST_URL points it elsewhere (a test server, a fork).

export const defaultUpdateManifestUrl =
  "https://raw.githubusercontent.com/FrameOS/frameos/main/docs/update-manifest.json";
export const updateManifestFreshMs = 10 * 60 * 1000;
export const updateManifestRetryMs = 60 * 1000;
// A manifest is a few KB; anything this big is not one.
export const updateManifestMaxBytes = 512 * 1024;

export interface UpdateManifest {
  version?: number;
  paused?: string | null;
  defaultRollout?: unknown;
  releases?: unknown[];
  [key: string]: unknown;
}

type ManifestCache = {
  manifest: UpdateManifest | undefined;
  fetchedAt: number;
  lastAttemptAt: number;
  inFlight: Promise<UpdateManifest | undefined> | undefined;
};

const cache: ManifestCache = {
  manifest: undefined,
  fetchedAt: 0,
  lastAttemptAt: 0,
  inFlight: undefined,
};

export function updateManifestUrl(): string {
  return process.env.FRAMEOS_UPDATE_MANIFEST_URL?.trim() || defaultUpdateManifestUrl;
}

/** A parsed manifest, or undefined when the body is not one. */
export function parseUpdateManifest(text: string): UpdateManifest | undefined {
  if (Buffer.byteLength(text, "utf8") > updateManifestMaxBytes) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const manifest = parsed as UpdateManifest;
    return Array.isArray(manifest.releases) ? manifest : undefined;
  } catch {
    return undefined;
  }
}

async function fetchUpdateManifestUncached(): Promise<UpdateManifest | undefined> {
  try {
    const response = await fetch(updateManifestUrl(), {
      cache: "no-store",
      headers: { accept: "application/json", "user-agent": "frameos-cloud" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return undefined;
    }
    return parseUpdateManifest(await response.text());
  } catch {
    return undefined;
  }
}

/** The manifest: fresh, or re-read, or the last good copy. */
export async function fetchUpdateManifest(now: number = Date.now()): Promise<UpdateManifest | undefined> {
  const cached = cache.manifest;
  if (cached && now - cache.fetchedAt < updateManifestFreshMs) {
    return cached;
  }
  if (cache.inFlight) {
    return cache.inFlight;
  }
  if (now - cache.lastAttemptAt < updateManifestRetryMs && cache.lastAttemptAt > cache.fetchedAt) {
    return cached;
  }
  cache.lastAttemptAt = now;
  const attempt = fetchUpdateManifestUncached().then((manifest) => {
    if (manifest) {
      cache.manifest = manifest;
      cache.fetchedAt = now;
      return manifest;
    }
    return cache.manifest;
  });
  cache.inFlight = attempt;
  try {
    return await attempt;
  } finally {
    cache.inFlight = undefined;
  }
}

/** Forget the cached manifest (tests). */
export function resetUpdateManifestCacheForTests() {
  cache.manifest = undefined;
  cache.fetchedAt = 0;
  cache.lastAttemptAt = 0;
  cache.inFlight = undefined;
}
