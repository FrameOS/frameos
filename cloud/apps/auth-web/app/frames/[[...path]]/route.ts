import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import {
  getAccountBaseUrl,
  getAccountUrl,
  getCloudBaseUrl,
  getScenesBaseUrl,
  getSessionCookieDomain,
} from "../../../src/lib/env";
import { claimTokenTtlMs } from "../../../src/lib/frames";

export const runtime = "nodejs";

// Config the SPA cannot work out for itself, injected into the shell before
// it is served (cloud-frontend/src/cloudConfig.ts consumes it):
//
//   * the account/scenes/auth surfaces may sit on three different origins, and
//     getAccountPath() shortens /account/* on a split-host deployment;
//   * the enrollment origin is written into SD images, ESP32 NVS and install
//     commands, so it must be the deployment's public URL rather than whatever
//     host the admin is browsing through (a tunnel, a LAN IP, 127.0.0.1);
//   * the claim-code TTL is FRAMEOS_CLOUD_CLAIM_TOKEN_TTL_HOURS, so a
//     hardcoded "24 hours" in the panel would lie on a tuned install.
const localHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// The enrollment origin is written into ESP32 NVS and SD images — a frame on
// the WiFi then dials it. On a dev server reached as localhost that origin is
// useless (the frame would dial itself and never connect), so substitute this
// machine's LAN IPv4, which the device firmware accepts over plain http for
// private-network hosts. Real hostnames are never touched, and with no LAN
// address the localhost origin is kept (still correct for wasm previews).
function enrollmentOrigin(accountOrigin: string): string {
  const url = new URL(accountOrigin);
  if (!localHosts.has(url.hostname)) {
    return accountOrigin;
  }
  const addresses = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
  // Prefer RFC1918 space: a machine can also hold carrier or VPN addresses a
  // frame on the home network cannot reach.
  const lan =
    addresses.find((address) =>
      /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(address),
    ) ?? addresses[0];
  if (!lan) {
    return accountOrigin;
  }
  url.hostname = lan;
  return url.origin;
}

function appConfigLines(): string[] {
  const accountOrigin = new URL(getAccountBaseUrl()).origin;
  return [
    `cloud_account_url: ${JSON.stringify(getAccountUrl())},`,
    // The fleet SPA is served from the account origin (this route).
    `cloud_frames_url: ${JSON.stringify(new URL("/frames", getAccountBaseUrl()).toString())},`,
    `cloud_logout_url: ${JSON.stringify(new URL("/api/auth/logout", getCloudBaseUrl()).toString())},`,
    `cloud_scenes_url: ${JSON.stringify(new URL("/", getScenesBaseUrl()).toString())},`,
    `cloud_origin: ${JSON.stringify(enrollmentOrigin(accountOrigin))},`,
    `cloud_claim_token_ttl_hours: ${Math.round(claimTokenTtlMs / (60 * 60 * 1000))},`,
    // The workspace and the account pages are two different apps sharing one
    // theme preference, carried in the frameos_theme cookie. The SPA has to
    // write it with the same Domain the account pages use, or on a split-host
    // deployment it would set a host-only cookie that shadows the shared one
    // and the two surfaces would disagree again.
    `cloud_theme_cookie_domain: ${JSON.stringify(getSessionCookieDomain() ?? "")},`,
  ];
}

// Replace the line that is nothing but `anchor` with `lines`, keeping its
// indentation. Whole line, never a substring: the shell documents both anchors
// in a comment above the config object, and a plain .replace() rewrites that
// comment instead — leaving the real line untouched and the explanation above
// it mangled into nonsense. That is exactly how the websocket origin shipped
// broken once (see route.test.ts).
function injectAtAnchor(
  html: string,
  anchor: string,
  lines: string[],
): string | undefined {
  const htmlLines = html.split("\n");
  const anchorIndex = htmlLines.findIndex((line) => line.trim() === anchor);
  if (anchorIndex === -1) {
    return undefined;
  }
  const anchorLine = htmlLines[anchorIndex]!;
  const indent = anchorLine.slice(0, anchorLine.indexOf(anchor));
  htmlLines.splice(
    anchorIndex,
    1,
    ...lines.map((line) => `${indent}${line}`),
  );
  return htmlLines.join("\n");
}

function anchorMissing(anchor: string, purpose: string) {
  return new NextResponse(
    `The frames app shell has no line consisting solely of ${anchor}, ` +
      `so ${purpose} cannot be injected. Rebuild cloud-frontend.`,
    { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
  );
}

// SPA fallback for the cloud frames UI: every /frames/** path serves the
// @frameos/cloud-frontend shell (copied into public/frames-app by
// scripts/copy-frames-app-assets.mjs). The bundle's static assets are
// root-absolute /frames-app/* references that Next serves from public/
// directly, so this route only ever answers with the HTML shell. The SPA
// itself redirects to /login on 401 — the shell is served unauthenticated,
// like every other static asset. See cloud-frontend/README.md.
export async function GET(request: NextRequest) {
  let html: string;
  try {
    html = await readFile(
      join(process.cwd(), "public", "frames-app", "index.html"),
      "utf8",
    );
  } catch {
    return new NextResponse(
      "The frames UI is not built. Run `turbo run build --filter=@frameos/cloud-frontend` " +
        "and restart (scripts/copy-frames-app-assets.mjs copies it into public/frames-app).",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  // In production nginx routes /api/frames/ws and /api/frames/**/updates to
  // the frame hub on the same origin, so no override is needed. In dev the
  // hub is a separate port — FRAME_HUB_PUBLIC_URL (e.g. http://localhost:3100)
  // tells the SPA where its fleet websocket lives.
  // The anchor is a named token, not a formatted line, so reindenting the
  // shell can't silently turn this into a no-op — and if it goes missing
  // entirely we say so instead of serving a SPA whose websocket points nowhere.
  const wsOriginAnchor = "//__FRAMEOS_CLOUD_WS_ORIGIN__";
  const appConfigAnchor = "//__FRAMEOS_CLOUD_APP_CONFIG__";
  // In development the hub is a second process on its own port, so without an
  // origin the SPA dials ws://localhost:3000/api/frames/updates — this Next
  // server, which has no WebSocket handler — and loops on 1006 forever.
  // Default to the hub's own default port (getHubPort in apps/frame-hub) so
  // `pnpm dev` works unconfigured.
  //
  // The "am I in dev" test is the request's own hostname, not NODE_ENV: this
  // has to hold for however the server was started, and a localhost request is
  // exactly the case that needs the second port. Behind a real hostname we
  // never guess — there nginx proxies the WS paths on the same origin, and
  // pointing the fleet socket at localhost would break every browser.
  //
  // Empty counts as unset: FRAME_HUB_PUBLIC_URL= in a .env would otherwise be
  // an empty string, which ?? happily keeps and which silently disables the
  // injection (same trap getHubPort documents for FRAME_HUB_PORT=).
  const configuredHub = process.env.FRAME_HUB_PUBLIC_URL?.trim().replace(
    /\/$/,
    "",
  );
  const hubOrigin =
    configuredHub ||
    (localHosts.has(new URL(request.url).hostname)
      ? "http://localhost:3100"
      : undefined);
  if (hubOrigin) {
    const injected = injectAtAnchor(html, wsOriginAnchor, [
      `cloud_ws_origin: ${JSON.stringify(hubOrigin)},`,
    ]);
    if (injected === undefined) {
      return anchorMissing(wsOriginAnchor, "the fleet websocket origin");
    }
    html = injected;
  }

  // Unconditional, unlike the websocket origin: the account header's links and
  // the enrollment origin are wrong on every deployment without them, not just
  // in dev.
  const withAppConfig = injectAtAnchor(html, appConfigAnchor, appConfigLines());
  if (withAppConfig === undefined) {
    return anchorMissing(
      appConfigAnchor,
      "the account header URLs, enrollment origin and claim-code TTL",
    );
  }
  html = withAppConfig;

  return new NextResponse(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The shell references hashless /frames-app/static/main.js|css, so it
      // must never be cached across deploys.
      "cache-control": "no-store",
    },
  });
}
