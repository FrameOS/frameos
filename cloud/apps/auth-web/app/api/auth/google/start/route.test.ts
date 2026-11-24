import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

// What the Google start asks of Google: prompt=login on a re-authentication,
// and, when the operator switched it on, the auth_time claim on every start
// (src/lib/google-auth-time.ts).

vi.mock("@frameos-cloud/auth-client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  discoverOidcProvider: vi.fn(() =>
    Promise.resolve({
      authorization_endpoint: "https://accounts.example/o/oauth2/v2/auth",
      issuer: "https://accounts.example",
      jwks_uri: "https://accounts.example/certs",
      token_endpoint: "https://accounts.example/token",
    }),
  ),
}));
vi.mock("../../../../../src/lib/rate-limit", () => ({
  rateLimitResponse: vi.fn(() => Promise.resolve(undefined)),
}));

const saved = { ...process.env };

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = "client-id";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret";
  delete process.env.GOOGLE_REQUIRE_AUTH_TIME;
});

afterEach(() => {
  process.env = { ...saved };
});

async function startUrl(query = "") {
  const response = await GET(new NextRequest(`http://localhost:3000/api/auth/google/start${query}`));
  expect(response.status).toBe(307);
  return new URL(response.headers.get("location") ?? "");
}

describe("GET /api/auth/google/start", () => {
  it("asks for nothing extra by default, and prompt=login on a re-authentication", async () => {
    const plain = await startUrl();
    expect(plain.searchParams.get("claims")).toBeNull();
    expect(plain.searchParams.get("prompt")).toBeNull();
    const reauth = await startUrl("?reauth=1");
    expect(reauth.searchParams.get("prompt")).toBe("login");
  });

  it("asks for auth_time on every start once the operator turned it on", async () => {
    process.env.GOOGLE_REQUIRE_AUTH_TIME = "1";
    for (const url of [await startUrl(), await startUrl("?reauth=1")]) {
      expect(JSON.parse(url.searchParams.get("claims") ?? "null")).toEqual({
        id_token: { auth_time: { essential: true } },
      });
    }
    expect((await startUrl("?reauth=1")).searchParams.get("prompt")).toBe("login");
  });
});
