import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordAuditEvent } from "../../../../src/lib/audit";
import { requireRecentAuth } from "../../../../src/lib/recent-auth";
import { readSession } from "../../../../src/lib/session";
import { GET, POST } from "./route";

// Minting is the sensitive half: it needs a session (never a token), a
// recent proof of credentials, a name, and room under the cap; the secret
// leaves exactly once, and only its hash and hint are stored.

vi.mock("../../../../src/lib/rate-limit", () => ({
  rateLimitResponse: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("../../../../src/lib/csrf", () => ({
  csrfResponse: vi.fn(() => undefined),
}));
vi.mock("../../../../src/lib/session", () => ({
  readSession: vi.fn(),
}));
vi.mock("../../../../src/lib/audit", () => ({
  recordAuditEvent: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../../../src/lib/recent-auth", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireRecentAuth: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("../../../../src/lib/device-flow", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireDatabase: () => ({ db: fakeDb as never, response: undefined }),
}));

const sessionMock = vi.mocked(readSession);
const auditMock = vi.mocked(recordAuditEvent);
const recentAuthMock = vi.mocked(requireRecentAuth);

let liveCount = 0;
let inserted: Record<string, unknown>[] = [];
let listed: Record<string, unknown>[] = [];

const fakeDb = {
  insert: () => ({
    values: (values: Record<string, unknown>) => {
      inserted.push(values);
      return {
        returning: () =>
          Promise.resolve([
            {
              ...values,
              createdAt: new Date(),
              id: "tok-new",
              lastUsedAt: null,
              revokedAt: null,
              updatedAt: new Date(),
            },
          ]),
      };
    },
  }),
  select: () => ({
    from: () => ({
      where: () => {
        const rows = Promise.resolve([{ count: liveCount }]);
        return Object.assign(rows, {
          orderBy: () => Promise.resolve(listed),
        });
      },
    }),
  }),
};

function post(body: unknown) {
  return new NextRequest("https://cloud.example/api/account/api-tokens", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: "https://cloud.example" },
    method: "POST",
  });
}

const session = {
  accountId: "acc-1",
  providerIssuer: "frameos-cloud",
  providerSubject: "me",
};

beforeEach(() => {
  liveCount = 0;
  inserted = [];
  listed = [];
  sessionMock.mockResolvedValue(session);
  auditMock.mockClear();
  recentAuthMock.mockResolvedValue(undefined);
});

describe("POST /api/account/api-tokens", () => {
  it("mints a token, returns the secret once and stores only its hash", async () => {
    const response = await POST(post({ access: "read_only", expires_in_days: 30, name: "laptop" }));
    expect(response.status).toBe(201);
    const payload = (await response.json()) as {
      api_token: { access: string; name: string; token_hint: string };
      token: string;
    };
    expect(payload.token).toMatch(/^fc_apiro_/);
    expect(payload.api_token).toMatchObject({ access: "read_only", name: "laptop" });
    expect(payload.token.startsWith(payload.api_token.token_hint)).toBe(true);
    expect(inserted[0]).toMatchObject({ access: "read_only", accountId: "acc-1", name: "laptop" });
    expect(inserted[0]?.tokenHash).not.toContain(payload.token);
    expect(inserted[0]?.expiresAt).toBeInstanceOf(Date);
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "account.api_token_created" }),
    );
  });

  it("refuses to mint from a token session", async () => {
    sessionMock.mockResolvedValueOnce({
      ...session,
      apiToken: { access: "full", id: "tok-1", name: "other" },
    });
    const response = await POST(post({ name: "escalate" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "api_token_not_allowed" });
    expect(inserted).toHaveLength(0);
  });

  it("requires recent authentication", async () => {
    recentAuthMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "reauth_required" }), { status: 403 }) as never,
    );
    const response = await POST(post({ name: "laptop" }));
    expect(response.status).toBe(403);
    expect(inserted).toHaveLength(0);
  });

  it("validates the name, access and expiry", async () => {
    expect((await POST(post({}))).status).toBe(400);
    expect((await POST(post({ access: "admin", name: "x" }))).status).toBe(400);
    expect((await POST(post({ expires_in_days: 0, name: "x" }))).status).toBe(400);
    expect((await POST(post({ expires_in_days: 400, name: "x" }))).status).toBe(400);
    // "Never" is not an option: every token expires.
    const never = await POST(post({ expires_in_days: null, name: "x" }));
    expect(never.status).toBe(400);
    expect(await never.json()).toEqual({ error: "invalid_expiry" });
    expect(inserted).toHaveLength(0);
  });

  it("defaults the expiry to ninety days when none is given", async () => {
    const before = Date.now();
    const response = await POST(post({ name: "laptop" }));
    const after = Date.now();
    expect(response.status).toBe(201);
    const expiresAt = inserted[0]?.expiresAt as Date;
    expect(expiresAt).toBeInstanceOf(Date);
    const dayMs = 24 * 60 * 60 * 1000;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 90 * dayMs);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + 90 * dayMs);
    const payload = (await response.json()) as { api_token: { expires_at: string | null } };
    expect(payload.api_token.expires_at).toBe(expiresAt.toISOString());
  });

  it("enforces the per-account cap", async () => {
    liveCount = 25;
    const response = await POST(post({ name: "one more" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "token_quota_exceeded", max_tokens: 25 });
  });
});

describe("GET /api/account/api-tokens", () => {
  it("lists tokens without secrets", async () => {
    listed = [
      {
        access: "full",
        createdAt: new Date("2026-08-01T00:00:00Z"),
        expiresAt: null,
        id: "tok-1",
        lastUsedAt: null,
        name: "laptop",
        revokedAt: null,
        tokenHash: "should-not-leak",
        tokenHint: "fc_api_abcd",
      },
    ];
    const response = await GET(
      new NextRequest("https://cloud.example/api/account/api-tokens"),
    );
    const payload = (await response.json()) as {
      default_ttl_days: number;
      max_tokens: number;
      tokens: Record<string, unknown>[];
    };
    expect(payload.max_tokens).toBe(25);
    expect(payload.default_ttl_days).toBe(90);
    expect(payload.tokens[0]).toMatchObject({ id: "tok-1", token_hint: "fc_api_abcd" });
    expect(JSON.stringify(payload)).not.toContain("should-not-leak");
  });
});
