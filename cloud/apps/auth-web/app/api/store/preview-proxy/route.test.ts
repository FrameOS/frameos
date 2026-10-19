import { NextRequest } from "next/server";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { derivedSigningKey } from "../../../../src/lib/keys";
import {
  createPreviewProxyToken,
  previewProxyTokenHeader,
  previewProxyTokenTtlSeconds,
  previewProxyTokenValid,
} from "../../../../src/lib/preview-proxy-token";
import { OPTIONS, POST } from "./route";
import { POST as mintToken } from "./token/route";

vi.mock("../../../../src/lib/rate-limit", () => ({
  rateLimitResponse: vi.fn(() => Promise.resolve(undefined)),
}));
// The proxy fetches through undici with a guarded dispatcher
// (src/lib/ssrf.ts); routed to the global fetch here so a test can stub the
// upstream. The connect-time check has its own tests (ssrf.test.ts).
vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: (input: unknown, init?: RequestInit) =>
    globalThis.fetch(input as string, init),
}));

const appOrigin = "http://localhost:3000";
const originalSecret = process.env.SESSION_SECRET;
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  process.env.SESSION_SECRET = "preview-proxy-token-test-secret";
  fetchMock.mockReset();
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      new Response("upstream-bytes", {
        headers: { "content-type": "text/x-upstream" },
        status: 201,
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalSecret === undefined) {
    delete process.env.SESSION_SECRET;
  } else {
    process.env.SESSION_SECRET = originalSecret;
  }
});

function proxyRequest(headers: Record<string, string>) {
  return new NextRequest(new URL("/api/store/preview-proxy", appOrigin), {
    body: JSON.stringify({ url: "https://example.com/data" }),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });
}

describe("preview proxy tokens", () => {
  it("verify for their lifetime and not after", async () => {
    const now = Date.UTC(2026, 9, 19, 12);
    const { expiresAt, expiresIn, token } = await createPreviewProxyToken(now);
    expect(expiresIn).toBe(previewProxyTokenTtlSeconds);
    expect(Date.parse(expiresAt)).toBe(now + previewProxyTokenTtlSeconds * 1000);
    expect(await previewProxyTokenValid(token, now)).toBe(true);
    expect(await previewProxyTokenValid(token, now + (previewProxyTokenTtlSeconds + 1) * 1000)).toBe(false);
  });

  it("are refused when tampered with, signed for another purpose or stretched", async () => {
    const { token } = await createPreviewProxyToken();
    const tampered = `${token.slice(0, -2)}${token.endsWith("AA") ? "BB" : "AA"}`;
    expect(await previewProxyTokenValid(tampered)).toBe(false);
    expect(await previewProxyTokenValid("")).toBe(false);
    expect(await previewProxyTokenValid(null)).toBe(false);
    expect(await previewProxyTokenValid("not.a.jwt")).toBe(false);

    const session = await new SignJWT({ frameos_type: "frameos_preview_proxy" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(derivedSigningKey("session"));
    expect(await previewProxyTokenValid(session)).toBe(false);

    const stretched = await new SignJWT({ frameos_type: "frameos_preview_proxy" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1d")
      .sign(derivedSigningKey("preview-proxy-token"));
    expect(await previewProxyTokenValid(stretched)).toBe(false);
  });
});

describe("POST /api/store/preview-proxy/token", () => {
  it("mints for a same-origin page", async () => {
    const response = await mintToken(
      new NextRequest(new URL("/api/store/preview-proxy/token", appOrigin), {
        headers: { origin: appOrigin },
        method: "POST",
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { token: string; expiresIn: number };
    expect(body.expiresIn).toBe(previewProxyTokenTtlSeconds);
    expect(await previewProxyTokenValid(body.token)).toBe(true);
  });

  it("refuses another origin, an opaque one, or none", async () => {
    for (const origin of ["https://evil.example", "null", undefined]) {
      const response = await mintToken(
        new NextRequest(new URL("/api/store/preview-proxy/token", appOrigin), {
          headers: origin ? { origin } : {},
          method: "POST",
        }),
      );
      expect(response.status, String(origin)).toBe(403);
    }
  });
});

describe("POST /api/store/preview-proxy", () => {
  it("serves a token holder with no cookie from an opaque origin, CORS included", async () => {
    const { token } = await createPreviewProxyToken();
    const response = await POST(
      proxyRequest({ origin: "null", [previewProxyTokenHeader]: token }),
    );
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("upstream-bytes");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "x-upstream-content-type",
    );
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    // The token is ours; it never travels on to the upstream.
    expect(new Headers(init.headers).get(previewProxyTokenHeader)).toBeNull();
  });

  it("refuses an expired or forged token from an opaque origin, readably", async () => {
    const expired = (
      await createPreviewProxyToken(Date.now() - 2 * previewProxyTokenTtlSeconds * 1000)
    ).token;
    for (const token of [expired, "forged"]) {
      const response = await POST(
        proxyRequest({ origin: "null", [previewProxyTokenHeader]: token }),
      );
      expect(response.status).toBe(401);
      expect(((await response.json()) as { error: string }).error).toBe(
        "invalid_preview_token",
      );
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still serves a same-origin page without a token, or with a stale one", async () => {
    const plain = await POST(proxyRequest({ origin: appOrigin }));
    expect(plain.status).toBe(201);
    expect(plain.headers.get("access-control-allow-origin")).toBeNull();

    const stale = await POST(
      proxyRequest({ origin: appOrigin, [previewProxyTokenHeader]: "stale" }),
    );
    expect(stale.status).toBe(201);
  });

  it("refuses no token and no same-origin check", async () => {
    for (const headers of [{}, { origin: "null" }, { origin: "https://evil.example" }]) {
      const response = await POST(proxyRequest(headers));
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers the preflight with the token header allowed", async () => {
    const response = await OPTIONS(
      new NextRequest(new URL("/api/store/preview-proxy", appOrigin), {
        headers: {
          "access-control-request-headers": `content-type, ${previewProxyTokenHeader}`,
          "access-control-request-method": "POST",
          origin: "null",
        },
        method: "OPTIONS",
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-headers")).toContain(
      previewProxyTokenHeader,
    );
    expect(response.headers.get("access-control-allow-methods")).toBe("POST");
  });
});
