import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordAuditEvent } from "../../../../../../src/lib/audit";
import { frameForAccount } from "../../../../../../src/lib/frames";
import { readSession } from "../../../../../../src/lib/session";
import { POST } from "./route";

// The owner's voice chat switches (docs/voice-chat.md "What the voice chat
// may do") with the database stubbed: the gates, what is written (the whole
// set, defaults filled in), what is refused, and that an unchanged save
// writes nothing. The turn reading them is in
// src/test/integration/frame-voice.integration.test.ts.

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
  frameForAccount: vi.fn(),
}));
vi.mock("../../../../../../src/lib/device-flow", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireDatabase: () => ({ db: fakeDb as never, response: undefined }),
}));

const sessionMock = vi.mocked(readSession);
const frameMock = vi.mocked(frameForAccount);
const auditMock = vi.mocked(recordAuditEvent);

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
  return { accountId, id: frameId, status: "active", voicePermissions: null, ...overrides } as never;
}

function post(body: unknown) {
  return POST(
    new NextRequest(`https://cloud.example/api/frames/${frameId}/voice/permissions`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", origin: "https://cloud.example" },
      method: "POST",
    }),
    { params: Promise.resolve({ frameId }) },
  );
}

beforeEach(() => {
  updates = [];
  sessionMock.mockResolvedValue({ accountId, providerSubject: "subject" } as never);
  frameMock.mockResolvedValue(frameRow());
  auditMock.mockClear();
});

describe("POST /api/frames/[frameId]/voice/permissions", () => {
  it("writes the whole set with the defaults filled in, and audits the change", async () => {
    const response = await post({ create_scenes: true });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "updated",
      voice_permissions: { change_settings: true, create_scenes: true, use_scenes: true },
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.voicePermissions).toEqual({ change_settings: true, create_scenes: true, use_scenes: true });
    expect(auditMock.mock.calls[0]?.[1]).toMatchObject({
      eventType: "frame.voice_permissions_changed",
      metadata: {
        from: { change_settings: true, create_scenes: false, use_scenes: true },
        to: { change_settings: true, create_scenes: true, use_scenes: true },
      },
      target: { frameId },
    });
  });

  it("keeps the switches it was not sent, and writes nothing for a save that changes nothing", async () => {
    frameMock.mockResolvedValue(frameRow({ voicePermissions: { create_scenes: true, use_scenes: false } }));
    const same = await post({ use_scenes: false });
    await expect(same.json()).resolves.toEqual({
      status: "unchanged",
      voice_permissions: { change_settings: true, create_scenes: true, use_scenes: false },
    });
    expect(updates).toEqual([]);
    expect(auditMock).not.toHaveBeenCalled();

    const flipped = await post({ change_settings: false });
    await expect(flipped.json()).resolves.toMatchObject({
      status: "updated",
      voice_permissions: { change_settings: false, create_scenes: true, use_scenes: false },
    });
    expect(updates).toHaveLength(1);
  });

  it("refuses an unknown key, a non-boolean and an empty body", async () => {
    for (const body of [{ allow_everything: true }, { use_scenes: "yes" }, {}, { use_scenes: true, extra: 1 }]) {
      const response = await post(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_voice_permissions" });
    }
    expect(updates).toEqual([]);
  });

  it("is the owner's alone", async () => {
    sessionMock.mockResolvedValueOnce(null as never);
    expect((await post({ use_scenes: false })).status).toBe(401);
    frameMock.mockResolvedValueOnce(null as never);
    expect((await post({ use_scenes: false })).status).toBe(404);
    expect(updates).toEqual([]);
  });
});
