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
});
