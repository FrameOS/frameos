import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "../../../../src/lib/device-flow";
import {
  identityRateLimitResponse,
  rateLimitResponse,
} from "../../../../src/lib/rate-limit";
import { readSession } from "../../../../src/lib/session";

export const runtime = "nodejs";

// GitHub release assets are not fetchable from a browser: the 302 from
// github.com carries no access-control-allow-origin, and neither does the
// signed object it points at. So the SD image builder streams the generic
// release image through this same-origin route instead. It is a dumb byte
// pipe — the personalization still happens in the browser, so WiFi
// credentials never reach the server.
//
// This is not an "image proxy" in the sense the project forbids: that rule
// is about frame *content* (photos rendered on frames, fetched on every
// render). This is a one-off OS image download, and the bytes are public
// release artifacts.

const releaseApiUrl =
  "https://api.github.com/repos/FrameOS/frameos/releases/latest";

// Only these boards, and only the exact generic buildroot asset shape — the
// upstream host and path are never taken from user input, so this cannot be
// steered into an SSRF.
const allowedPlatforms = new Set([
  "raspberry-pi-32",
  "raspberry-pi-64",
  "raspberry-pi-5",
]);

interface ReleaseAsset {
  browser_download_url: string;
  name: string;
  size: number;
}

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

  const releaseResponse = await fetch(releaseApiUrl, {
    headers: { accept: "application/vnd.github+json" },
    // Releases change rarely; caching keeps us far from GitHub's rate limit.
    next: { revalidate: 300 },
  });
  if (!releaseResponse.ok) {
    return jsonError("release_lookup_failed", 502);
  }
  const release = (await releaseResponse.json()) as {
    assets?: ReleaseAsset[];
    tag_name?: string;
  };
  const suffix = `-${platform}-buildroot.img.gz`;
  const asset = release.assets?.find(
    (entry) =>
      entry.name.startsWith("frameos-") && entry.name.endsWith(suffix),
  );
  if (!asset) {
    return jsonError("image_not_published", 404, {
      platform,
      release: release.tag_name ?? null,
    });
  }
  // Belt and braces: the URL comes from the GitHub API, but pin the host
  // anyway so a compromised/unexpected API response cannot redirect us.
  let assetUrl: URL;
  try {
    assetUrl = new URL(asset.browser_download_url);
  } catch {
    return jsonError("release_lookup_failed", 502);
  }
  if (assetUrl.protocol !== "https:" || assetUrl.host !== "github.com") {
    return jsonError("release_lookup_failed", 502);
  }

  const upstream = await fetch(assetUrl, { redirect: "follow" });
  if (!upstream.ok || !upstream.body) {
    return jsonError("image_download_failed", 502);
  }

  const headers = new Headers({
    "cache-control": "private, max-age=300",
    "content-type": "application/gzip",
    "x-frameos-image-name": asset.name,
    "x-frameos-release": release.tag_name ?? "",
  });
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) {
    headers.set("content-length", contentLength);
  }
  // Streamed straight through: the route never buffers the image.
  return new NextResponse(upstream.body, { headers, status: 200 });
}
