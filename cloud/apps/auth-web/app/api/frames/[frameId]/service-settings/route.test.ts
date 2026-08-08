import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonError } from "../../../../../src/lib/device-flow";
import { authenticateFrameDevice } from "../../../../../src/lib/frame-device-auth";
import { computeAndStoreServiceSettingGroups } from "../../../../../src/lib/frames";
import {
  identityRateLimitResponse,
  rateLimitResponse,
} from "../../../../../src/lib/rate-limit";
import { GET } from "./route";

// The device-authed service-settings pull (docs/cloud-frames.md, "Service
// settings"). The bearer auth itself is integration-tested against a real
// enrollment in src/test/integration/frame-service-settings.integration.test.ts;
// here it is mocked — the firmware routes' pattern
// (../firmware/route.test.ts) — so the gate order, the ETag/304 handling and
// the caching headers can be pinned without a database.

vi.mock("../../../../../src/lib/rate-limit", () => ({
  identityRateLimitResponse: vi.fn(() => Promise.resolve(undefined)),
  rateLimitResponse: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("../../../../../src/lib/frame-device-auth", () => ({
  authenticateFrameDevice: vi.fn(),
}));
vi.mock("../../../../../src/lib/frames", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  computeAndStoreServiceSettingGroups: vi.fn(() => Promise.resolve([])),
}));
vi.mock("../../../../../src/lib/device-flow", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireDatabase: () => ({ db: fakeDb as never, response: undefined }),
}));

const authMock = vi.mocked(authenticateFrameDevice);
const rateLimitMock = vi.mocked(rateLimitResponse);
const identityRateLimitMock = vi.mocked(identityRateLimitResponse);
const computeGroupsMock = vi.mocked(computeAndStoreServiceSettingGroups);

const frameId = "11111111-2222-3333-4444-555555555555";
const accountId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const unsplashKey = "unsplash-secret-value";
const openAiKey = "openai-secret-value";

let settingsRows: { key: string; value: unknown }[] = [];

// db.select().from(account_settings).where(...) is the only query the route
// makes; everything else it needs is on the authenticated frame row.
const fakeDb = {
  select: () => ({
    from: () => ({ where: () => Promise.resolve(settingsRows) }),
  }),
};

function request(headers: Record<string, string> = {}) {
  return new NextRequest(
    `https://cloud.example/api/frames/${frameId}/service-settings`,
    { headers: { authorization: "Bearer fc_link_test", ...headers } },
  );
}

const routeParams = (id: string) => ({ params: Promise.resolve({ frameId: id }) });

function authAs(overrides: {
  frame?: Record<string, unknown>;
  scopes?: string[];
}) {
  authMock.mockResolvedValue({
    frame: {
      accountId,
      id: frameId,
      serviceSettingGroups: ["unsplash"],
      status: "active",
      ...overrides.frame,
    } as never,
    linkedClient: {
      providerClientMetadata: {
        requestedScopes: overrides.scopes ?? [
          "frame:managed",
          "settings:services",
        ],
      },
    } as never,
  });
}

beforeEach(() => {
  settingsRows = [
    { key: "unsplash", value: { accessKey: unsplashKey } },
    { key: "openAI", value: { apiKey: openAiKey } },
  ];
  authAs({});
  computeGroupsMock.mockReset();
  computeGroupsMock.mockResolvedValue([]);
});

afterEach(() => {
  authMock.mockReset();
  rateLimitMock.mockClear();
  identityRateLimitMock.mockClear();
  vi.unstubAllGlobals();
});

describe("GET /api/frames/[frameId]/service-settings", () => {
  const get = (id = frameId, headers: Record<string, string> = {}) =>
    GET(request(headers), routeParams(id));

  it("serves only the groups the frame's scenes declare, with an ETag and no-store", async () => {
    const response = await get();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
    // openAI is stored on the account but NOT declared by this frame's
    // scenes, so it never reaches the device.
    await expect(response.json()).resolves.toEqual({
      groups: ["unsplash"],
      settings: { unsplash: { accessKey: unsplashKey } },
    });
    expect(rateLimitMock.mock.calls[0]?.[1]).toBe("frames:service-settings");
    expect(identityRateLimitMock.mock.calls[0]?.[0]).toBe(frameId);
  });

  it("answers 304 with no body when If-None-Match still matches", async () => {
    const first = await get();
    const etag = first.headers.get("etag")!;

    const second = await get(frameId, { "if-none-match": etag });

    expect(second.status).toBe(304);
    expect(second.headers.get("etag")).toBe(etag);
    expect(second.headers.get("cache-control")).toBe("no-store");
    expect(await second.text()).toBe("");
  });

  it("re-serves the body when the account's key changed under the same request", async () => {
    const first = await get();
    const etag = first.headers.get("etag")!;
    settingsRows = [{ key: "unsplash", value: { accessKey: "rotated-key" } }];

    const second = await get(frameId, { "if-none-match": etag });

    expect(second.status).toBe(200);
    expect(second.headers.get("etag")).not.toBe(etag);
  });

  it("relays the device auth failure before reading anything", async () => {
    authMock.mockResolvedValue({
      response: jsonError("invalid_link_token", 401),
    });

    const response = await get();

    expect(response.status).toBe(401);
    expect(identityRateLimitMock).not.toHaveBeenCalled();
  });

  it("refuses a token whose frame is not the one in the path", async () => {
    const response = await get("99999999-8888-7777-6666-555555555555");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "frame_mismatch" });
  });

  it("409s a frame that is not active", async () => {
    authAs({ frame: { status: "pending" } });

    const response = await get();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "frame_not_active",
    });
  });

  it("403s a frame whose owner has not granted settings:services", async () => {
    authAs({ scopes: ["frame:managed", "telemetry:logs"] });

    const response = await get();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "insufficient_scope",
    });
    // The scope gate is the boundary: nothing was computed or served.
    expect(computeGroupsMock).not.toHaveBeenCalled();
  });

  it("checks frame_mismatch, then frame_not_active, then the scope", async () => {
    // A pending frame that is also the wrong frame answers frame_mismatch:
    // the path/token disagreement is the more fundamental error.
    authAs({ frame: { status: "pending" }, scopes: ["frame:managed"] });

    const response = await get("99999999-8888-7777-6666-555555555555");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "frame_mismatch" });
  });

  it("computes and backfills the declared groups when the column is null", async () => {
    authAs({ frame: { serviceSettingGroups: null } });
    computeGroupsMock.mockResolvedValue(["openAI"]);

    const response = await get();

    expect(computeGroupsMock).toHaveBeenCalledWith(expect.anything(), frameId);
    await expect(response.json()).resolves.toEqual({
      groups: ["openAI"],
      settings: { openAI: { apiKey: openAiKey } },
    });
  });

  it("does not recompute an empty-but-computed group list", async () => {
    authAs({ frame: { serviceSettingGroups: [] } });

    const response = await get();

    expect(computeGroupsMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ groups: [], settings: {} });
  });

  it("survives a failed backfill without serving stale or partial keys", async () => {
    authAs({ frame: { serviceSettingGroups: null } });
    computeGroupsMock.mockRejectedValue(new Error("scene_pulled"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await get();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ groups: [], settings: {} });
    // The log carries the frame id and a message — never a key.
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(unsplashKey);
    consoleError.mockRestore();
  });

  it("never writes the response body to the console", async () => {
    const spies = (["debug", "error", "info", "log", "warn"] as const).map(
      (level) => vi.spyOn(console, level).mockImplementation(() => {}),
    );

    const response = await get();
    const body = await response.text();
    expect(body).toContain(unsplashKey);

    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    expect(logged).not.toContain(unsplashKey);
    expect(logged).not.toContain(openAiKey);
    for (const spy of spies) {
      spy.mockRestore();
    }
  });
});
