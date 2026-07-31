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

  const contentSecurityPolicy = (frameAncestors: string) =>
    [
      "default-src 'self'",
      "base-uri 'self'",
      "connect-src 'self' https:",
      "font-src 'self' data:",
      `form-action 'self' ${new URL(getCloudBaseUrl()).origin}`,
      `frame-ancestors ${frameAncestors}`,
      // 'self' for the embedded scene editor; http(s) so the account pages
      // can open a linked FrameOS backend (user-chosen origin) in a frame.
      "frame-src 'self' https: http:",
      "img-src 'self' data: https:",
      "object-src 'none'",
      scriptSrc,
      "style-src 'self' 'unsafe-inline'",
    ].join("; ");

  return {
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
          headers: [noStoreHeader],
          source: "/api/:path*",
        },
      ];
    },
    transpilePackages: ["@frameos-cloud/auth-client", "@frameos-cloud/db"],
  };
}

export default createNextConfig;
