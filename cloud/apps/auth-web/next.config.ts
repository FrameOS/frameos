import path from "node:path";
import type { NextConfig } from "next";
import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_SERVER,
} from "next/constants";
import {
  assertDatabaseUrlConfigured,
  assertSharedSessionConfigured,
  getCloudBaseUrl,
} from "./src/lib/env";

function assertRuntimeConfig(phase: string) {
  if (phase !== PHASE_DEVELOPMENT_SERVER && phase !== PHASE_PRODUCTION_SERVER) {
    return;
  }

  assertDatabaseUrlConfigured({ allowTestEnvironment: true });
  assertSharedSessionConfigured();
}

function createNextConfig(phase: string): NextConfig {
  assertRuntimeConfig(phase);

  // The dev server needs general eval for hot reloading. Production grants
  // only WebAssembly compilation for the scene preview; it still blocks
  // JavaScript eval() and new Function(). 'unsafe-inline' stays because the
  // App Router streams the RSC payload via inline scripts; replacing it
  // requires nonce-based CSP middleware.
  const scriptSrc =
    phase === PHASE_DEVELOPMENT_SERVER
      ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
      : "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'";

  // The frames SPA opens a WebSocket to the frame hub. In production that is
  // the same origin (nginx proxies /api/frames/ws and /**/updates), which
  // 'self' already covers. In development the hub is a second process on its
  // own port, so it is a different origin and CSP refuses the connection —
  // the socket fails before the fleet UI can load, with no clue why unless
  // you notice the CSP violation. Allow the hub explicitly, in both its http
  // and ws forms (connect-src matches the scheme literally).
  //
  // Dev server only: headers() is evaluated at BUILD time, and production
  // bundles are built on a dev machine whose .env.local sets
  // FRAME_HUB_PUBLIC_URL to a LAN address — reading it here shipped that LAN
  // IP inside the production CSP header. Production needs no entry at all.
  const hubOrigin =
    phase === PHASE_DEVELOPMENT_SERVER
      ? process.env.FRAME_HUB_PUBLIC_URL?.trim().replace(/\/$/, "") ||
        "http://localhost:3100"
      : "";
  const hubConnectSrc = hubOrigin
    ? ` ${hubOrigin} ${hubOrigin.replace(/^http/, "ws")}`
    : "";

  // Forms are same-origin except the logout button, which posts to the cloud
  // origin from the scenes host too. That origin is a runtime fact
  // (FRAMEOS_CLOUD_APP_URL on the server) the build machine cannot know —
  // baking getCloudBaseUrl() here shipped `form-action http://localhost:3000`
  // to production, where it CSP-blocked logout on scenes.frameos.net. In
  // production allow https: targets (matching the frame-src posture); the
  // dev server, evaluated live with real env, keeps the exact origin.
  const formAction =
    phase === PHASE_DEVELOPMENT_SERVER
      ? `form-action 'self' ${new URL(getCloudBaseUrl()).origin}`
      : "form-action 'self' https:";

  // Cloudflare zone-injected RUM beacon; without this entry the browser
  // console fills with CSP violations on every prod page load.
  //
  // challenges.cloudflare.com is Turnstile (src/lib/turnstile.ts). Unlike the
  // beacon it is needed in development too — anyone running against real
  // Turnstile keys locally would otherwise get a widget that silently never
  // loads, and a signup button that never enables. frame-src already allows
  // https:, which covers the challenge iframe.
  const scriptSrcElem =
    phase === PHASE_DEVELOPMENT_SERVER
      ? " https://challenges.cloudflare.com"
      : " https://static.cloudflareinsights.com https://challenges.cloudflare.com";

  const contentSecurityPolicy = (frameAncestors: string) =>
    [
      "default-src 'self'",
      "base-uri 'self'",
      `connect-src 'self' https:${hubConnectSrc}`,
      "font-src 'self' data:",
      formAction,
      `frame-ancestors ${frameAncestors}`,
      // 'self' for the embedded scene editor; http(s) so the account pages
      // can open a linked FrameOS backend (user-chosen origin) in a frame.
      "frame-src 'self' https: http:",
      "img-src 'self' data: https:",
      "object-src 'none'",
      `${scriptSrc}${scriptSrcElem}`,
      "style-src 'self' 'unsafe-inline'",
    ].join("; ");

  return {
    // Production deploys ship .next/standalone as a self-contained bundle
    // (see cloud/docs/deployment.md). Trace from the monorepo root so pnpm
    // workspace dependencies resolve into the bundle.
    output: "standalone",
    outputFileTracingRoot: path.join(__dirname, "../../.."),
    async headers() {
      const noStoreHeader = {
        key: "Cache-Control",
        value: "no-store, max-age=0",
      };

      return [
        {
          headers: [
            {
              key: "Content-Security-Policy",
              value: contentSecurityPolicy("'none'"),
            },
            {
              key: "Permissions-Policy",
              value: "camera=(), microphone=(), geolocation=(), payment=()",
            },
            {
              key: "Referrer-Policy",
              value: "strict-origin-when-cross-origin",
            },
            {
              key: "Strict-Transport-Security",
              value: "max-age=63072000; includeSubDomains; preload",
            },
            {
              key: "X-Content-Type-Options",
              value: "nosniff",
            },
            {
              key: "X-Frame-Options",
              value: "DENY",
            },
          ],
          source: "/(.*)",
        },
        {
          // The embedded scene editor (static frameos-editor bundle) runs in
          // an iframe on our own scene pages — allow same-origin framing for
          // it only. Later rules override the catch-all's headers.
          headers: [
            {
              key: "Content-Security-Policy",
              value: contentSecurityPolicy("'self'"),
            },
            {
              key: "X-Frame-Options",
              value: "SAMEORIGIN",
            },
          ],
          source: "/frameos-editor/:path*",
        },
        {
          // The editor html references hashed assets; keeping the html itself
          // uncached means a redeployed bundle is picked up immediately.
          headers: [noStoreHeader],
          source: "/frameos-editor/index.html",
        },
        {
          // Un-hashed frames-app files (images copied from frontend/public):
          // no-cache forces revalidation while the ETag keeps repeat loads
          // as cheap 304s. (Cloudflare's Browser Cache TTL rewrites this to
          // max-age=14400 unless the zone is set to respect origin headers.)
          headers: [
            {
              key: "Cache-Control",
              value: "no-cache",
            },
          ],
          source: "/frames-app/:path*",
        },
        {
          // The entry bundle is content-hashed (cloud-frontend/build.mjs):
          // the no-store shell references new names each deploy, so these
          // can be cached forever — which also sidesteps Cloudflare
          // rewriting weaker origin cache-control headers.
          headers: [
            {
              key: "Cache-Control",
              value: "public, max-age=31536000, immutable",
            },
          ],
          source: "/frames-app/static/:path*",
        },
        {
          headers: [noStoreHeader],
          source: "/account/:path*",
        },
        {
          headers: [noStoreHeader],
          source: "/device/:path*",
        },
        {
          headers: [noStoreHeader],
          source: "/admin/:path*",
        },
        {
          // Every API response is no-store — most routes are session-scoped
          // and a static rule cannot tell them apart — EXCEPT the store's
          // /api/store/ subtree, whose public reads are meant to sit at the
          // edge (the immutable ?v= preview, scenes.json's five minutes, the
          // CDN redirect). A headers() rule overrides whatever a handler set,
          // so exempting the subtree is the only way to let those routes
          // decide; in exchange every store route states its own policy,
          // refusals included, via src/lib/store-cache.ts storeRoute
          // (default no-store). Negative lookahead: path-to-regexp accepts a
          // custom pattern for the segment.
          headers: [noStoreHeader],
          source: "/api/:path((?!store/).*)",
        },
      ];
    },
    transpilePackages: [
      "@frameos-cloud/auth-client",
      "@frameos-cloud/db",
      "@frameos-cloud/mcp",
      "@frameos-cloud/scene-convert",
    ],
  };
}

export default createNextConfig;
