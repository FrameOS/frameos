import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderScenes, SceneRenderError } from "../../../../src/lib/scene-render";
import { readSession } from "../../../../src/lib/session";
import { POST } from "./route";

// The render route's gates around the renderer: the first-party Origin
// check on a cookie POST, the per-owner concurrency answer, and what the
// renderer's own refusals turn into. The renderer itself is mocked — the
// wasm bundle is exercised by scene-render.test.ts when it is installed.

vi.mock("../../../../src/lib/rate-limit", () => ({
  identityRateLimitResponse: vi.fn(() => Promise.resolve(undefined)),
  rateLimitResponse: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("../../../../src/lib/session", () => ({
  readSession: vi.fn(),
}));
vi.mock("../../../../src/lib/device-flow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/lib/device-flow")>()),
  requireDatabase: () => ({ db: {}, response: undefined }),
}));
vi.mock("../../../../src/lib/scene-render", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/lib/scene-render")>()),
  renderScenes: vi.fn(),
}));

const sessionMock = vi.mocked(readSession);
const renderMock = vi.mocked(renderScenes);

process.env.FRAMEOS_CLOUD_APP_URL = "https://cloud.example";

function request(body: unknown, headers: Record<string, string> = { origin: "https://cloud.example" }) {
  return new NextRequest("https://cloud.example/api/scenes/render", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });
}

const scenes = [{ edges: [], fields: [], id: "s1", name: "One", nodes: [] }];

beforeEach(() => {
  sessionMock.mockReset();
  renderMock.mockReset();
  sessionMock.mockResolvedValue({
    accountId: "acc-1",
    providerIssuer: "frameos-cloud",
    providerSubject: "me",
  });
});

describe("POST /api/scenes/render", () => {
  it("refuses a cookie POST from another origin or with none, before the session", async () => {
    const foreign = await POST(request({ scenes }, { origin: "https://evil.example" }));
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ error: "invalid_origin" });
    const bare = await POST(request({ scenes }, {}));
    expect(bare.status).toBe(403);
    expect(await bare.json()).toEqual({ error: "missing_origin" });
    expect(sessionMock).not.toHaveBeenCalled();
    expect(renderMock).not.toHaveBeenCalled();
  });

  it("lets an API token in without an Origin and renders for the account", async () => {
    renderMock.mockResolvedValueOnce({
      errors: [],
      height: 480,
      logs: [],
      png: Buffer.from("png"),
      renderMs: 1,
      state: {},
      width: 800,
    });
    const response = await POST(
      request({ format: "json", scenes }, { authorization: "Bearer fc_api_abcdef" }),
    );
    expect(response.status).toBe(200);
    // The render is queued under the account, so one account's burst
    // cannot hold every global slot.
    expect(renderMock).toHaveBeenCalledWith(expect.objectContaining({ owner: "acc-1" }));
  });

  it("answers the per-account concurrency cap with 429 and a retry hint", async () => {
    renderMock.mockRejectedValueOnce(
      new SceneRenderError("render_concurrency_limit", "You already have renders in flight."),
    );
    const response = await POST(request({ scenes }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toMatchObject({ error: "render_concurrency_limit" });
  });

  it("answers a full global queue with 503", async () => {
    renderMock.mockRejectedValueOnce(new SceneRenderError("renderer_busy", "busy"));
    const response = await POST(request({ scenes }));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
  });
});
