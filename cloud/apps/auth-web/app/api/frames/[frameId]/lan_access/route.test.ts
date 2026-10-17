import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { waitForFrameCommand } from "../../../../../src/lib/frame-command-wait";
import { enqueueFrameCommand, frameForAccount, supersedePendingCommands } from "../../../../../src/lib/frames";
import { identityRateLimitResponse, rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";
import { POST as postChallenge } from "./challenge/route";
import { POST as postSet } from "./route";

// The two local network access routes with the database stubbed: the gates, what goes
// into the queue (and what never does: the code outside the payload), and
// how each outcome is answered. The queue round trip against a real
// Postgres is in src/test/integration/frame-lan-access.integration.test.ts.

vi.mock("../../../../../src/lib/rate-limit", () => ({
  identityRateLimitResponse: vi.fn(() => Promise.resolve(undefined)),
  rateLimitResponse: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("../../../../../src/lib/csrf", () => ({
  csrfResponse: vi.fn(() => undefined),
}));
vi.mock("../../../../../src/lib/session", () => ({
  readSession: vi.fn(),
}));
vi.mock("../../../../../src/lib/audit", () => ({
  recordAuditEvent: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../../../../src/lib/frame-command-wait", () => ({
  waitForFrameCommand: vi.fn(),
}));
vi.mock("../../../../../src/lib/frames", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  enqueueFrameCommand: vi.fn(() => Promise.resolve({ id: "cmd-1" } as never)),
  frameForAccount: vi.fn(),
  supersedePendingCommands: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../../../../src/lib/device-flow", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireDatabase: () => ({ db: fakeDb as never, response: undefined }),
}));

const sessionMock = vi.mocked(readSession);
const frameMock = vi.mocked(frameForAccount);
const enqueueMock = vi.mocked(enqueueFrameCommand);
const supersedeMock = vi.mocked(supersedePendingCommands);
const waitMock = vi.mocked(waitForFrameCommand);
const auditMock = vi.mocked(recordAuditEvent);
const rateLimitMock = vi.mocked(rateLimitResponse);
const identityLimitMock = vi.mocked(identityRateLimitResponse);

const frameId = "11111111-2222-3333-4444-555555555555";
const accountId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

let updates: Record<string, unknown>[] = [];
const fakeDb = {
  update: () => ({
    set: (values: Record<string, unknown>) => {
      updates.push(values);
      return { where: () => Promise.resolve(undefined) };
    },
  }),
};

function frameRow(overrides: Record<string, unknown> = {}) {
  return {
    accountId,
    connected: true,
    hardware: { lanAccess: false, platform: "buildroot" },
    id: frameId,
    nextWakeAt: null,
    status: "active",
    ...overrides,
  } as never;
}

function request(path: string, body: unknown) {
  return new NextRequest(`https://cloud.example/api/frames/${frameId}${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: "https://cloud.example" },
    method: "POST",
  });
}

const routeParams = { params: Promise.resolve({ frameId }) };
const challenge = () => postChallenge(request("/lan_access/challenge", {}), routeParams);
const setSwitch = (body: unknown) => postSet(request("/lan_access", body), routeParams);

beforeEach(() => {
  updates = [];
  sessionMock.mockResolvedValue({ accountId, providerSubject: "subject" } as never);
  frameMock.mockResolvedValue(frameRow());
  waitMock.mockResolvedValue({ state: "acked" });
  for (const mock of [enqueueMock, supersedeMock, waitMock, auditMock, rateLimitMock, identityLimitMock]) {
    mock.mockClear();
  }
});

describe("POST /api/frames/[frameId]/lan_access/challenge", () => {
  it("queues the verb, waits for the ack and says the code is shown", async () => {
    const response = await challenge();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ expires_in_seconds: 300, status: "shown" });
    expect(supersedeMock).toHaveBeenCalledWith(expect.anything(), frameId, "lan_access_challenge");
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ frameId, payload: {}, ttlMs: 10 * 60 * 1000, type: "lan_access_challenge" }),
    );
    expect(waitMock).toHaveBeenCalledWith(expect.anything(), "cmd-1", { pollMs: 500, timeoutMs: 15_000 });
    expect(auditMock.mock.calls[0]?.[1]).toMatchObject({
      eventType: "frame.command_sent",
      metadata: { type: "lan_access_challenge" },
    });
    // Challenges have their own per-account, per-frame ceiling.
    expect(identityLimitMock).toHaveBeenCalledWith(`${accountId}:${frameId}`, "frames:lan-access-challenge", expect.anything());
  });

  it("answers no_panel and unsupported from the device", async () => {
    waitMock.mockResolvedValueOnce({ error: "no_panel", state: "failed" });
    const noPanel = await challenge();
    expect(noPanel.status).toBe(409);
    await expect(noPanel.json()).resolves.toEqual({
      detail: "This frame has no screen to show a code on.",
      error: "no_panel",
    });

    waitMock.mockResolvedValueOnce({ error: "unknown_verb", state: "failed" });
    const old = await challenge();
    expect(old.status).toBe(409);
    await expect(old.json()).resolves.toMatchObject({ error: "unsupported" });
  });

  it("does not wait for a frame that is asleep or offline", async () => {
    frameMock.mockResolvedValueOnce(frameRow({ nextWakeAt: new Date(Date.now() + 10 * 60 * 1000) }));
    const asleep = await challenge();
    await expect(asleep.json()).resolves.toEqual({ status: "queued" });

    frameMock.mockResolvedValueOnce(frameRow({ connected: false }));
    const offline = await challenge();
    await expect(offline.json()).resolves.toEqual({ status: "queued" });

    expect(enqueueMock).toHaveBeenCalledTimes(2);
    expect(waitMock).not.toHaveBeenCalled();
  });

  it("refuses firmware that does not report the switch, before queueing anything", async () => {
    for (const hardware of [null, { platform: "esp32s3" }]) {
      frameMock.mockResolvedValueOnce(frameRow({ hardware }));
      const response = await challenge();
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        detail: "Update this frame's FrameOS first.",
        error: "unsupported",
      });
    }
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("keeps the reboot route's gates", async () => {
    sessionMock.mockResolvedValueOnce(undefined as never);
    expect((await challenge()).status).toBe(401);

    frameMock.mockResolvedValueOnce(undefined as never);
    const missing = await challenge();
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: "invalid_frame" });

    frameMock.mockResolvedValueOnce(frameRow({ status: "pending" }));
    const pending = await challenge();
    expect(pending.status).toBe(409);
    await expect(pending.json()).resolves.toEqual({ error: "frame_not_active" });

    rateLimitMock.mockResolvedValueOnce(new Response(null, { status: 429 }) as never);
    expect((await challenge()).status).toBe(429);
    expect(rateLimitMock.mock.calls.at(-1)?.[1]).toBe("frames:lan-access");

    identityLimitMock.mockResolvedValueOnce(new Response(null, { status: 429 }) as never);
    expect((await challenge()).status).toBe(429);

    expect(enqueueMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/frames/[frameId]/lan_access", () => {
  it("turns on with the code, mirrors the answer and audits it without the code", async () => {
    const response = await setSwitch({ code: "123 456", enabled: true });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ lan_access: true, status: "applied" });
    expect(supersedeMock).toHaveBeenCalledWith(expect.anything(), frameId, "lan_access_set");
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        payload: { code: "123456", enabled: true },
        ttlMs: 5 * 60 * 1000,
        type: "lan_access_set",
      }),
    );
    // hardware.lanAccess is rewritten in place (one jsonb key).
    expect(updates).toHaveLength(1);
    expect(updates[0]).toHaveProperty("hardware");
    const events = auditMock.mock.calls.map((call) => call[1]);
    expect(events.map((event) => event.eventType)).toEqual(["frame.command_sent", "frame.lan_access_changed"]);
    expect(events[0]?.metadata).toEqual({ enabled: true, type: "lan_access_set" });
    expect(events[1]?.metadata).toEqual({ enabled: true });
    expect(JSON.stringify(events)).not.toContain("123456");
  });

  it("turns off without a code and never forwards one", async () => {
    const response = await setSwitch({ code: "999999", enabled: false });

    await expect(response.json()).resolves.toEqual({ lan_access: false, status: "applied" });
    expect(enqueueMock.mock.calls[0]?.[1].payload).toEqual({ enabled: false });
  });

  it("refuses a bad body before queueing anything", async () => {
    const cases: [unknown, number, string][] = [
      [{}, 400, "invalid_lan_access"],
      [{ enabled: "on" }, 400, "invalid_lan_access"],
      [{ enabled: true }, 400, "code_required"],
      [{ code: "12345", enabled: true }, 400, "invalid_code"],
    ];
    for (const [body, status, error] of cases) {
      const response = await setSwitch(body);
      expect(response.status, JSON.stringify(body)).toBe(status);
      const payload = await response.json();
      expect(payload.error, JSON.stringify(body)).toBe(error);
      expect(typeof payload.detail).toBe("string");
    }
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("answers the device's code tokens with 403 and leaves the mirror alone", async () => {
    for (const error of ["invalid_code", "code_expired", "too_many_attempts", "code_required"]) {
      waitMock.mockResolvedValueOnce({ error, state: "failed" });
      const response = await setSwitch({ code: "123456", enabled: true });
      expect(response.status, error).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error });
    }
    waitMock.mockResolvedValueOnce({ error: "persist_failed", state: "failed" });
    expect((await setSwitch({ enabled: false })).status).toBe(500);
    expect(updates).toHaveLength(0);
    expect(auditMock.mock.calls.map((call) => call[1].eventType)).not.toContain("frame.lan_access_changed");
  });

  it("says queued when the frame has not answered yet, and a timeout when the command expired", async () => {
    waitMock.mockResolvedValueOnce({ state: "waiting" });
    const queued = await setSwitch({ code: "123456", enabled: true });
    expect(queued.status).toBe(200);
    await expect(queued.json()).resolves.toEqual({ status: "queued" });

    waitMock.mockResolvedValueOnce({ error: "superseded", state: "expired" });
    const expired = await setSwitch({ code: "123456", enabled: true });
    expect(expired.status).toBe(504);
    await expect(expired.json()).resolves.toMatchObject({ error: "timeout" });
    expect(updates).toHaveLength(0);
  });
});
