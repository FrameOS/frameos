import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_SERVER,
} from "next/constants";
import { describe, expect, it } from "vitest";
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
});
