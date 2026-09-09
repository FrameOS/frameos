import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "../../../../src/lib/device-flow";
import {
  fetchLatestRelease,
  fetchReleaseAssetText,
  findAsset,
  pinnedAssetUrl,
} from "../../../../src/lib/firmware-release";
import {
  identityRateLimitResponse,
  rateLimitResponse,
} from "../../../../src/lib/rate-limit";
import {
  forgetSdImageVerdict,
  verifiedSdImage,
} from "../../../../src/lib/sd-image-verify";
import { readSession } from "../../../../src/lib/session";

export const runtime = "nodejs";

// GitHub release assets are not fetchable from a browser: the 302 from
// github.com carries no access-control-allow-origin, and neither does the
// signed object it points at. So the SD image builder streams the generic
// release image through this same-origin route instead. The personalization
// still happens in the browser, so WiFi credentials never reach the server.
//
// This is not an "image proxy" in the sense the project forbids: that rule
// is about frame *content* (photos rendered on frames, fetched on every
// render). This is a one-off OS image download, and the bytes are public
// release artifacts.
//
// The image is signed like every other release asset (minisign, Ed25519
// over BLAKE2b-512 — .github/workflows/docker-publish-multi.yml), and this
// route is one of its three readers: the self-hosted backend verifies on
// download and on every cache hit (backend/app/tasks/buildroot_image.py),
// the browser flasher verifies what it is about to write, and the cloud
// verifies here before a single byte is served. The first request for a
// release makes one extra pass over the image (hashing, never buffering)
// and remembers the verdict for the process; every later request streams
// straight through after checking that GitHub still serves the same bytes.
//
//   GET /api/frames/sd-image?platform=raspberry-pi-64
//     -> the .img.gz, verified (502 release_signature_invalid otherwise)
//   GET /api/frames/sd-image?platform=raspberry-pi-64&signature=1
//     -> the release's .minisig text, for the browser to verify with too
//
// A release whose image has no .minisig is answered 409 unsigned_release:
// the flasher must never be offered an image nobody could verify.

// Only these boards, and only the exact generic buildroot asset shape — the
// upstream host and path are never taken from user input, so this cannot be
// steered into an SSRF.
const allowedPlatforms = new Set([
  "raspberry-pi-32",
  "raspberry-pi-64",
  "raspberry-pi-5",
]);

export async function GET(request: NextRequest) {
  // Large responses. The IP limit catches shared-address abuse; the real
  // budget is per account, because one logged-in user behind rotating
  // addresses would otherwise get a fresh bucket every request.
  const limited = await rateLimitResponse(request, "frames:sd-image", {
    limit: 30,
    windowMs: 60 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const session = await readSession();
  if (!session?.accountId) {
    return jsonError("login_required", 401);
  }
  const accountLimited = await identityRateLimitResponse(
    session.accountId,
    "frames:sd-image",
    { limit: 10, windowMs: 60 * 60 * 1000 },
  );
  if (accountLimited) {
    return accountLimited;
  }

  const platform = request.nextUrl.searchParams.get("platform") ?? "";
  if (!allowedPlatforms.has(platform)) {
    return jsonError("invalid_platform", 400);
  }

  const release = await fetchLatestRelease();
  if (!release) {
    return jsonError("release_lookup_failed", 502);
  }
  const asset = findAsset(release, `-${platform}-buildroot.img.gz`);
  if (!asset) {
    return jsonError("image_not_published", 404, {
      platform,
      release: release.tag_name ?? null,
    });
  }
  const assetUrl = pinnedAssetUrl(asset);
  if (!assetUrl) {
    return jsonError("release_lookup_failed", 502);
  }

  const signatureAsset = release.assets?.find(
    (candidate) => candidate.name === `${asset.name}.minisig`,
  );
  if (!signatureAsset) {
    return jsonError("unsigned_release", 409, {
      platform,
      release: release.tag_name ?? null,
    });
  }
  const minisig = await fetchReleaseAssetText(signatureAsset);
  if (!minisig) {
    return jsonError("release_lookup_failed", 502);
  }

  const wantsSignature = request.nextUrl.searchParams.get("signature");
  if (wantsSignature === "1" || wantsSignature === "true") {
    return new NextResponse(minisig, {
      headers: {
        "cache-control": "private, max-age=300",
        "content-type": "text/plain; charset=utf-8",
        "x-frameos-image-name": asset.name,
        "x-frameos-release": release.tag_name ?? "",
      },
      status: 200,
    });
  }

  const verdict = await verifiedSdImage(asset, assetUrl, minisig);
  if (!verdict.ok) {
    return jsonError("release_signature_invalid", 502, {
      platform,
      release: release.tag_name ?? null,
    });
  }

  const upstream = await fetch(assetUrl, { redirect: "follow" });
  if (!upstream.ok || !upstream.body) {
    return jsonError("image_download_failed", 502);
  }
  // The verdict covers exactly the bytes that were hashed. GitHub serving a
  // different object now (a re-upload under the same name, a truncated
  // response) is not covered, and the client must not get it.
  const contentLength = upstream.headers.get("content-length");
  const etag = upstream.headers.get("etag") ?? undefined;
  if (
    (contentLength && Number(contentLength) !== verdict.byteLength) ||
    (verdict.etag && etag && etag !== verdict.etag)
  ) {
    forgetSdImageVerdict(asset);
    await upstream.body.cancel().catch(() => undefined);
    return jsonError("release_signature_invalid", 502, {
      platform,
      release: release.tag_name ?? null,
    });
  }

  const headers = new Headers({
    "cache-control": "private, max-age=300",
    "content-type": "application/gzip",
    "content-length": String(verdict.byteLength),
    "x-frameos-image-name": asset.name,
    "x-frameos-release": release.tag_name ?? "",
  });
  // Streamed straight through: the route never buffers the image.
  return new NextResponse(upstream.body, { headers, status: 200 });
}
