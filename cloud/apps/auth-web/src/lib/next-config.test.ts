import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_SERVER,
} from "next/constants";
import { describe, expect, it, vi } from "vitest";
import createNextConfig from "../../next.config";

async function contentSecurityPolicy(phase: string) {
  const config = createNextConfig(phase);
  const rules = await config.headers?.();
  const catchAll = rules?.find((rule) => rule.source === "/(.*)");
  return catchAll?.headers.find(
    (header) => header.key === "Content-Security-Policy",
  )?.value;
}

describe("API cache headers", () => {
  it("stamps no-store on the API surface but leaves /api/store/ to its routes", async () => {
    // A headers() rule overrides whatever a route handler set, so the
    // blanket no-store used to make the store's deliberate edge caching (the
    // immutable ?v= preview, scenes.json's five minutes) a no-op in
    // production. The store subtree is exempt; storeRoute (store-cache.ts)
    // then makes every route there — refusals included — state its own
    // policy, so nothing under it is left without a Cache-Control.
    const config = createNextConfig(PHASE_PRODUCTION_SERVER);
    const rules = (await config.headers?.()) ?? [];
    const apiRule = rules.find(
      (rule) =>
        rule.source.startsWith("/api/") &&
        rule.headers.some((header) => header.key === "Cache-Control"),
    );
    expect(apiRule).toBeTruthy();
    // Compile the source exactly as Next does and probe the paths that matter.
    // @ts-expect-error -- Next ships this vendored dependency without types.
    const { pathToRegexp } = (await import("next/dist/compiled/path-to-regexp")) as {
      pathToRegexp: (source: string) => RegExp;
    };
    const matcher = pathToRegexp(apiRule!.source);
    for (const covered of [
      "/api/frames/1/settings",
      "/api/account/scenes",
      "/api/store", // no trailing slash: not a store read
      "/api/storefront/anything",
    ]) {
      expect(matcher.test(covered), `${covered} should be no-store`).toBe(true);
    }
    for (const exempt of [
      "/api/store/browse",
      "/api/store/repository.json",
      "/api/store/2026.8.0/repository.json",
      "/api/store/scenes/abc/image",
      "/api/store/scenes/abc/images/def",
      "/api/store/scenes/abc/scenes.json",
      "/api/store/scenes/abc/download",
      "/api/store/account/repository.json",
    ]) {
      expect(matcher.test(exempt), `${exempt} decides its own caching`).toBe(false);
    }
  });
});

describe("Next.js security headers", () => {
  it("allows WebAssembly compilation without general eval in production", async () => {
    const policy = await contentSecurityPolicy(PHASE_PRODUCTION_SERVER);

    expect(policy).toContain(
      "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    );
    expect(policy).not.toContain(" 'unsafe-eval'");
  });

  it("keeps general eval available to the development server", async () => {
    const policy = await contentSecurityPolicy(PHASE_DEVELOPMENT_SERVER);

    expect(policy).toContain(
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    );
  });

  it("keeps the build machine's dev env out of the production CSP", async () => {
    // headers() runs at BUILD time, on a dev machine whose .env.local points
    // FRAME_HUB_PUBLIC_URL at a LAN IP — that IP (and a localhost
    // form-action from getCloudBaseUrl) shipped inside the prod CSP once.
    vi.stubEnv("FRAME_HUB_PUBLIC_URL", "http://10.4.0.47:3100");
    try {
      const policy = await contentSecurityPolicy(PHASE_PRODUCTION_SERVER);

      expect(policy).toContain("connect-src 'self' https:;");
      expect(policy).not.toContain("10.4.0.47");
      // The logout form posts to the cloud origin from the scenes host — a
      // runtime fact the build cannot know, so production allows https:.
      expect(policy).toContain("form-action 'self' https:");
      expect(policy).not.toContain("localhost");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("allows the dev hub's second port in the development CSP", async () => {
    const policy = await contentSecurityPolicy(PHASE_DEVELOPMENT_SERVER);

    expect(policy).toContain("http://localhost:3100 ws://localhost:3100");
  });

  it("allows the Cloudflare RUM beacon in production only", async () => {
    const production = await contentSecurityPolicy(PHASE_PRODUCTION_SERVER);
    const development = await contentSecurityPolicy(PHASE_DEVELOPMENT_SERVER);

    expect(production).toContain(
      "'wasm-unsafe-eval' https://static.cloudflareinsights.com",
    );
    expect(development).not.toContain("cloudflareinsights");
  });

  it("allows the Turnstile script in both phases", async () => {
    // Unlike the RUM beacon this one has to work in development too: with it
    // missing, a developer running against real Turnstile keys gets a widget
    // that never loads and a submit button that never enables, with nothing
    // but a CSP violation in the console to say why.
    for (const phase of [PHASE_PRODUCTION_SERVER, PHASE_DEVELOPMENT_SERVER]) {
      const policy = await contentSecurityPolicy(phase);
      expect(policy).toContain("https://challenges.cloudflare.com");
    }
  });
});
