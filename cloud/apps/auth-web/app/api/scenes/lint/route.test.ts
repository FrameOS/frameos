import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readSession } from "../../../../src/lib/session";
import { POST } from "./route";

// The lint route is the AI's delivery gate on a public door: shape errors
// and catalog errors block, structural warnings advise. Session-gated, no
// database.

vi.mock("../../../../src/lib/rate-limit", () => ({
  rateLimitResponse: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("../../../../src/lib/session", () => ({
  readSession: vi.fn(),
}));

const sessionMock = vi.mocked(readSession);

function request(body: unknown) {
  return new NextRequest("https://cloud.example/api/scenes/lint", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

const renderEvent = {
  data: { keyword: "render" },
  id: "e1",
  position: { x: 0, y: 0 },
  type: "event",
};

beforeEach(() => {
  sessionMock.mockResolvedValue({
    accountId: "acc-1",
    providerIssuer: "frameos-cloud",
    providerSubject: "me",
  });
});

describe("POST /api/scenes/lint", () => {
  it("requires a session", async () => {
    sessionMock.mockResolvedValueOnce(undefined);
    const response = await POST(request({ scenes: [{}] }));
    expect(response.status).toBe(401);
  });

  it("refuses an empty payload", async () => {
    const response = await POST(request({ scenes: [] }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_scenes" });
  });

  it("reports shape errors as errors", async () => {
    const response = await POST(request({ scenes: [{ name: "no id" }] }));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { errors: { message: string }[]; ok: boolean };
    expect(payload.ok).toBe(false);
    expect(payload.errors.length).toBeGreaterThan(0);
  });

  it("passes a minimal valid scene", async () => {
    const response = await POST(
      request({
        scenes: [
          {
            edges: [],
            fields: [],
            id: "s1",
            name: "Minimal",
            nodes: [renderEvent],
            settings: { execution: "interpreted" },
          },
        ],
      }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { errors: unknown[]; ok: boolean; warnings: unknown[] };
    expect(payload.errors).toEqual([]);
    expect(payload.ok).toBe(true);
  });

  it("flags unknown app keywords", async () => {
    const response = await POST(
      request({
        scenes: [
          {
            edges: [],
            fields: [],
            id: "s1",
            name: "Bad app",
            nodes: [
              renderEvent,
              {
                data: { keyword: "does/notExist" },
                id: "a1",
                position: { x: 0, y: 0 },
                type: "app",
              },
            ],
            settings: { execution: "interpreted" },
          },
        ],
      }),
    );
    const payload = (await response.json()) as { errors: { message: string }[]; ok: boolean };
    expect(payload.ok).toBe(false);
    expect(payload.errors.some((issue) => issue.message.includes("does/notExist"))).toBe(true);
  });
});
