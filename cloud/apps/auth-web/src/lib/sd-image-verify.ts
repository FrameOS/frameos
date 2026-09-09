// Signature verdicts for the Buildroot SD images app/api/frames/sd-image
// streams: one hashing pass per release per process, then a remembered
// verdict. Kept out of the route file because Next only lets a route module
// export HTTP handlers and config.

import type { ReleaseAsset } from "./firmware-release";
import { createReleaseDigest, verifyReleaseDigest } from "./release-signing";

// What the verification pass saw, so the streaming pass can insist on the
// same bytes: GitHub's etag for the object and the exact length hashed.
export type SdImageVerdict =
  | { ok: true; byteLength: number; etag: string | undefined }
  | { ok: false; at: number };

// Keyed on the asset URL + the size the API listed; a re-published asset
// under the same name changes both. Positive verdicts live for the process
// (release assets are immutable); a negative one is retried after a minute
// so a transient truncated download cannot pin a release as bad forever.
const verdicts = new Map<string, SdImageVerdict>();
const inFlight = new Map<string, Promise<SdImageVerdict>>();
export const negativeVerdictTtlMs = 60 * 1000;

/** Forget every cached verdict (tests only). */
export function resetSdImageVerdictsForTests() {
  verdicts.clear();
  inFlight.clear();
}

function verdictKey(asset: ReleaseAsset) {
  return `${asset.browser_download_url}|${asset.size}`;
}

/** Drop one asset's verdict: GitHub served different bytes than were hashed. */
export function forgetSdImageVerdict(asset: ReleaseAsset) {
  verdicts.delete(verdictKey(asset));
}

// One pass over the image: BLAKE2b-512 of the stream, then Ed25519 against
// the release key. Nothing is kept but the digest.
async function verifyAsset(
  assetUrl: URL,
  minisig: string,
): Promise<SdImageVerdict> {
  const upstream = await fetch(assetUrl, { redirect: "follow" });
  if (!upstream.ok || !upstream.body) {
    return { ok: false, at: Date.now() };
  }
  const hash = createReleaseDigest();
  let byteLength = 0;
  const reader = upstream.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    hash.update(value);
    byteLength += value.byteLength;
  }
  if (!verifyReleaseDigest(hash.digest(), minisig)) {
    return { ok: false, at: Date.now() };
  }
  return {
    ok: true,
    byteLength,
    etag: upstream.headers.get("etag") ?? undefined,
  };
}

/**
 * The cached verdict for `asset`, or a fresh one from a full hashing pass.
 * Concurrent callers for the same asset share one pass.
 */
export async function verifiedSdImage(
  asset: ReleaseAsset,
  assetUrl: URL,
  minisig: string,
): Promise<SdImageVerdict> {
  const key = verdictKey(asset);
  const cached = verdicts.get(key);
  if (cached && (cached.ok || Date.now() - cached.at < negativeVerdictTtlMs)) {
    return cached;
  }
  const pending = inFlight.get(key);
  if (pending) {
    return pending;
  }
  const attempt = verifyAsset(assetUrl, minisig)
    .catch((): SdImageVerdict => ({ ok: false, at: Date.now() }))
    .then((verdict) => {
      verdicts.set(key, verdict);
      return verdict;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, attempt);
  return attempt;
}
