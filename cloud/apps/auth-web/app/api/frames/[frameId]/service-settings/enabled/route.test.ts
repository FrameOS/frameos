import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordAuditEvent } from "../../../../../../src/lib/audit";
import {
  enqueueServiceSettingsRefresh,
  frameForAccount,
} from "../../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../../src/lib/session";
import { POST } from "./route";

// The OWNER's per-frame service-settings switch. End-to-end (a real
// enrollment, a real linked client, the pull route actually answering 403
// after a revoke) lives in
// src/test/integration/frame-service-settings.integration.test.ts; here the
// database is a stub so the gates and the scope arithmetic can be pinned.

vi.mock("../../../../../../src/lib/rate-limit", () => ({
  rateLimitResponse: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("../../../../../../src/lib/csrf", () => ({
  csrfResponse: vi.fn(() => undefined),
}));
vi.mock("../../../../../../src/lib/session", () => ({
  readSession: vi.fn(),
}));
vi.mock("../../../../../../src/lib/audit", () => ({
  recordAuditEvent: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../../../../../src/lib/frames", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  enqueueServiceSettingsRefresh: vi.fn(() =>
    Promise.resolve({ id: "cmd-1" } as never),
  ),
  frameForAccount: vi.fn(),
}));
vi.mock("../../../../../../src/lib/device-flow", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireDatabase: () => ({ db: fakeDb as never, response: undefined }),
}));

const sessionMock = vi.mocked(readSession);
const frameMock = vi.mocked(frameForAccount);
const enqueueMock = vi.mocked(enqueueServiceSettingsRefresh);
const auditMock = vi.mocked(recordAuditEvent);
const rateLimitMock = vi.mocked(rateLimitResponse);

const frameId = "11111111-2222-3333-4444-555555555555";
const accountId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const linkedClientId = "cccccccc-dddd-eeee-ffff-000000000000";

let linkedClientRows: { id: string; providerClientMetadata: unknown }[] = [];
let updates: Record<string, unknown>[] = [];

const fakeDb = {
  select: () => ({
    from: () => ({
      where: () => ({ limit: () => Promise.resolve(linkedClientRows) }),
    }),
  }),
  update: () => ({
    set: (values: Record<string, unknown>) => {
      updates.push(values);
      return { where: () => Promise.resolve(undefined) };
    },
  }),
};

function request(body: unknown) {
  return new NextRequest(
    `https://cloud.example/api/frames/${frameId}/service-settings/enabled`,
    {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", origin: "https://cloud.example" },
      method: "POST",
    },
  );
}

const routeParams = (id: string) => ({ params: Promise.resolve({ frameId: id }) });

function grantedScopes() {
  const metadata = updates.at(-1)?.providerClientMetadata as
    | { requestedScopes?: string[] }
    | undefined;
  return metadata?.requestedScopes;
}

beforeEach(() => {
  updates = [];
  linkedClientRows = [
    {
      id: linkedClientId,
      providerClientMetadata: {
        enrolledVia: "claim_token",
        requestedScopes: ["frame:managed", "telemetry:logs"],
      },
    },
  ];
  sessionMock.mockResolvedValue({
    accountId,
    providerSubject: "subject",
  } as never);
  frameMock.mockResolvedValue({
    accountId,
    id: frameId,
    linkedClientId,
    status: "active",
  } as never);
  enqueueMock.mockClear();
  auditMock.mockClear();
  rateLimitMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/frames/[frameId]/service-settings/enabled", () => {
  const post = (body: unknown, id = frameId) => POST(request(body), routeParams(id));

  it("grants the scope, keeps the other scopes, and nudges the frame", async () => {
    const response = await post({ enabled: true });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      command_id: "cmd-1",
      enabled: true,
      status: "updated",
    });
    expect(grantedScopes()).toEqual([
      "frame:managed",
      "telemetry:logs",
      "settings:services",
    ]);
    // Other metadata on the linked client survives the rewrite.
    expect(
      (updates.at(-1)?.providerClientMetadata as Record<string, unknown>)
        .enrolledVia,
    ).toBe("claim_token");
    expect(enqueueMock).toHaveBeenCalledWith(expect.anything(), frameId);
  });

  it("revokes by actually removing the scope, and does not nudge", async () => {
    linkedClientRows[0]!.providerClientMetadata = {
      requestedScopes: ["frame:managed", "settings:services", "telemetry:logs"],
    };

    const response = await post({ enabled: false });

    expect(response.status).toBe(200);
    // Removed, not flagged: the device's own scope list is additive, so the
    // pull route's 403 is the only thing that actually stops delivery — and
    // it can only 403 if the scope is gone from the row.
    expect(grantedScopes()).toEqual(["frame:managed", "telemetry:logs"]);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("is idempotent: enabling an already-enabled frame rewrites nothing", async () => {
    linkedClientRows[0]!.providerClientMetadata = {
      requestedScopes: ["frame:managed", "settings:services"],
    };

    const response = await post({ enabled: true });

    expect(response.status).toBe(200);
    expect(updates).toHaveLength(0);
    // Still nudged: the owner asked for delivery, so re-pull.
    expect(enqueueMock).toHaveBeenCalled();
  });

  it("audits the flag and never a value", async () => {
    await post({ enabled: true });

    const event = auditMock.mock.calls[0]?.[1];
    expect(event?.eventType).toBe("frame.service_settings_scope_changed");
    expect(event?.metadata).toEqual({ enabled: true });
    expect(JSON.stringify(event)).not.toContain("apiKey");
    expect(JSON.stringify(event)).not.toContain("accessKey");
  });

  it("skips the nudge for a frame that is not active", async () => {
    frameMock.mockResolvedValue({
      accountId,
      id: frameId,
      linkedClientId,
      status: "pending",
    } as never);

    const response = await post({ enabled: true });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ command_id: null });
    expect(grantedScopes()).toContain("settings:services");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("401s without a session", async () => {
    sessionMock.mockResolvedValue(undefined as never);

    const response = await post({ enabled: true });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "login_required" });
  });

  it("404s a frame the session does not own", async () => {
    frameMock.mockResolvedValue(undefined as never);

    const response = await post({ enabled: true });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "invalid_frame" });
  });

  it("400s a body without a boolean `enabled`", async () => {
    for (const body of [{}, { enabled: "yes" }, { enabled: 1 }, { enabled: null }]) {
      const response = await post(body);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "invalid_enabled",
      });
    }
    expect(updates).toHaveLength(0);
  });

  it("relays the rate limiter", async () => {
    rateLimitMock.mockResolvedValueOnce(
      new Response(null, { status: 429 }) as never,
    );

    const response = await post({ enabled: true });

    expect(response.status).toBe(429);
    expect(rateLimitMock.mock.calls[0]?.[1]).toBe(
      "frames:service-settings-scope",
    );
  });
});
