import { createSocket } from "node:dgram";
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

// RFC1918 space, shared by enrollmentOrigin (picking this machine's LAN
// address) and the hub-origin injection below (recognizing that a request
// arrived through that address).
const rfc1918Prefix = /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/;

// A complete private IPv4 literal — the hostname a dev machine is browsed
// through from elsewhere on its LAN (a phone, a second laptop). Requires the
// full dotted-quad shape, not just the prefix: "10.4.evil.example" is a
// public hostname.
function isPrivateLanIPv4(hostname: string) {
  return (
    /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) &&
    rfc1918Prefix.test(hostname)
  );
}

// Interfaces a frame on the WiFi cannot reach even when their address is
// RFC1918: VM/Internet-Sharing bridges, container networks, tunnels. macOS
// Internet Sharing's bridge100 (192.168.139.x) once beat the real en0 LAN
// address purely by enumeration order, and every provisioned frame dialed a
// host-only bridge forever.
const virtualInterfacePrefix =
  /^(bridge|vmnet|vboxnet|docker|veth|virbr|utun|tun|tap|zt|ts|tailscale|llw|awdl|anpi|ap)\d*$/i;

// Ask the routing table which source address reaches the internet: connecting
// a UDP socket sends no packets, it only makes the OS pick the outbound
// interface for the destination. Same trick the firmware's primaryIpAddress()
// uses. Returns undefined on machines with no route at all.
function defaultRouteAddress(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    const done = (address?: string) => {
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve(address);
    };
    socket.once("error", () => done(undefined));
    try {
      socket.connect(53, "8.8.8.8", () => {
        try {
          done(socket.address().address);
        } catch {
          done(undefined);
        }
      });
    } catch {
      done(undefined);
    }
  });
}

// The enrollment origin is written into ESP32 NVS and SD images — a frame on
// the WiFi then dials it. On a dev server reached as localhost that origin is
// useless (the frame would dial itself and never connect), so substitute this
// machine's LAN IPv4, which the device firmware accepts over plain http for
// private-network hosts. Real hostnames are never touched, and with no LAN
// address the localhost origin is kept (still correct for wasm previews).
//
// Which IPv4? The default route's source address when it is RFC1918 — that is
// the LAN the machine actually shares with the frame. When the default route
// goes elsewhere (full-tunnel VPN, carrier NAT), fall back to scanning
// interfaces, preferring RFC1918 addresses on physical-looking interfaces
// over virtual bridges.
async function enrollmentOrigin(accountOrigin: string): Promise<string> {
  const url = new URL(accountOrigin);
  if (!localHosts.has(url.hostname)) {
    return accountOrigin;
  }
  let lan = await defaultRouteAddress();
  if (!lan || !rfc1918Prefix.test(lan)) {
    const candidates = Object.entries(networkInterfaces())
      .flatMap(([name, entries]) =>
        (entries ?? []).map((entry) => ({ name, ...entry })),
      )
      .filter((entry) => entry.family === "IPv4" && !entry.internal);
    // Prefer RFC1918 space (a machine can also hold carrier or VPN addresses
    // a frame on the home network cannot reach), and within it real NICs over
    // virtual bridges.
    lan = (
      candidates.find(
        (entry) =>
          rfc1918Prefix.test(entry.address) &&
          !virtualInterfacePrefix.test(entry.name),
      ) ??
      candidates.find((entry) => rfc1918Prefix.test(entry.address)) ??
      candidates[0]
    )?.address;
  }
  if (!lan) {
    return accountOrigin;
  }
  url.hostname = lan;
  return url.origin;
}

async function appConfigLines(): Promise<string[]> {
  const accountOrigin = new URL(getAccountBaseUrl()).origin;
  return [
    `cloud_account_url: ${JSON.stringify(getAccountUrl())},`,
    // The fleet SPA is served from the account origin (this route).
    `cloud_frames_url: ${JSON.stringify(new URL("/frames", getAccountBaseUrl()).toString())},`,
    `cloud_logout_url: ${JSON.stringify(new URL("/api/auth/logout", getCloudBaseUrl()).toString())},`,
    `cloud_scenes_url: ${JSON.stringify(new URL("/", getScenesBaseUrl()).toString())},`,
    `cloud_origin: ${JSON.stringify(await enrollmentOrigin(accountOrigin))},`,
    `cloud_claim_token_ttl_hours: ${Math.round(claimTokenTtlMs / (60 * 60 * 1000))},`,
    // The workspace and the account pages are two different apps sharing one
    // theme preference, carried in the frameos_theme cookie. The SPA has to
    // write it with the same Domain the account pages use, or on a split-host
    // deployment it would set a host-only cookie that shadows the shared one
    // and the two surfaces would disagree again.
    `cloud_theme_cookie_domain: ${JSON.stringify(getSessionCookieDomain() ?? "")},`,
    // The wasm live preview's CORS escape hatch: the same anonymous,
    // rate-limited proxy the store's scene pages use. Without it the SPA
    // would try the backend's project-scoped proxy path, which the cloud
    // does not serve, and every external fetch in a preview dies on CORS.
    `preview_proxy_url: ${JSON.stringify("/api/store/preview-proxy")},`,
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
  // exactly the case that needs the second port. A private LAN IP is the same
  // dev server reached from elsewhere on the network (a phone, a second
  // laptop) — the hub is still a sibling process on this machine, so the
  // socket goes to the same host on the hub's port; anything else (localhost
  // itself included) would not resolve to this machine from that browser, and
  // the hub accepts private-network origins outside production (frame-hub
  // env.ts allowsPrivateNetworkOrigins). Behind a real hostname we never
  // guess — there nginx proxies the WS paths on the same origin, and pointing
  // the fleet socket at localhost would break every browser.
  //
  // Empty counts as unset: FRAME_HUB_PUBLIC_URL= in a .env would otherwise be
  // an empty string, which ?? happily keeps and which silently disables the
  // injection (same trap getHubPort documents for FRAME_HUB_PORT=).
  //
  // The hostname sniffing is additionally gated off in production: the
  // standalone server does not reconstruct request.url from the forwarded
  // Host header, so behind nginx every request looks like localhost — and the
  // prod shell shipped `cloud_ws_origin: "ws://localhost:3100"`, breaking the
  // fleet socket for every browser. In production the hub is same-origin
  // (nginx proxies the WS paths); only an explicit FRAME_HUB_PUBLIC_URL may
  // override that.
  const configuredHub = process.env.FRAME_HUB_PUBLIC_URL?.trim().replace(
    /\/$/,
    "",
  );
  const requestHostname = new URL(request.url).hostname;
  // The BROWSER's hub origin must share the page's hostname in dev: the
  // session cookie is host-only (no FRAMEOS_SESSION_COOKIE_DOMAIN in dev,
  // and IP literals cannot carry Domain= anyway), so a socket dialed at a
  // different host never sends it and the hub 401s every upgrade — the SPA
  // then error-loops on ws://…/api/frames/updates. FRAME_HUB_PUBLIC_URL
  // exists for DEVICES (they need a LAN address, enroll/route.ts) and still
  // shapes the device ws_url; for the browser we override only when it
  // points at a *different local/LAN host* than the page — the exact
  // cookie-breaking case — keeping its port. A public hub hostname stays
  // authoritative (a deployment fronting dev with real cookie domains).
  const hostIsLocal = (host: string): boolean =>
    localHosts.has(host) || isPrivateLanIPv4(host);
  const browserHub = (() => {
    if (!configuredHub) {
      return undefined;
    }
    try {
      const configured = new URL(configuredHub);
      if (
        process.env.NODE_ENV !== "production" &&
        hostIsLocal(configured.hostname) &&
        configured.hostname !== requestHostname &&
        hostIsLocal(requestHostname)
      ) {
        return `http://${requestHostname}:${configured.port || "3100"}`;
      }
    } catch {
      // Unparseable override: pass it through untouched below.
    }
    return configuredHub;
  })();
  const hubOrigin =
    browserHub ||
    (process.env.NODE_ENV === "production"
      ? undefined
      : localHosts.has(requestHostname)
        ? "http://localhost:3100"
        : isPrivateLanIPv4(requestHostname)
          ? `http://${requestHostname}:3100`
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
  const withAppConfig = injectAtAnchor(
    html,
    appConfigAnchor,
    await appConfigLines(),
  );
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
      // The shell references the deploy's content-hashed
      // /frames-app/static/main-<hash>.js|css, so the shell itself must
      // never be cached across deploys.
      "cache-control": "no-store",
    },
  });
}
