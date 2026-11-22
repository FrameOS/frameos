import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { frameForAccount } from "../../../../../src/lib/frames";
import { readSession } from "../../../../../src/lib/session";
import { POST } from "./route";

// How the cloud dithers a frame's panel picture (docs/dithering.md), with the
// database stubbed: the gates, what is written, what is refused, and that an
// unchanged save writes nothing. The packer reading it is panel-dither.test.ts.

vi.mock("../../../../../src/lib/rate-limit", () => ({
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
vi.mock("../../../../../src/lib/frames", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  frameForAccount: vi.fn(),
}));
vi.mock("../../../../../src/lib/device-flow", async (importOriginal) => ({
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
  return { accountId, id: frameId, status: "active", dither: null, ...overrides } as never;
}

function post(body: unknown) {
  return POST(
    new NextRequest(`https://cloud.example/api/frames/${frameId}/dither`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", origin: "https://cloud.example" },
      method: "POST",
    }),
    { params: Promise.resolve({ frameId }) },
  );
}

const opendisplay = { method: "opendisplay", dbs: true, exposure: 1.3, viewingDistanceCm: 50 };

beforeEach(() => {
  updates = [];
  sessionMock.mockResolvedValue({ accountId, providerSubject: "subject" } as never);
  frameMock.mockResolvedValue(frameRow());
  auditMock.mockClear();
});

describe("POST /api/frames/[frameId]/dither", () => {
  it("stores the setting and audits the change", async () => {
    const response = await post({ dither: opendisplay });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "updated", dither: opendisplay });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ dither: opendisplay });
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "frame.dither_changed", metadata: { from: null, to: opendisplay } }),
    );
  });

  it("goes back to Floyd-Steinberg with null", async () => {
    frameMock.mockResolvedValue(frameRow({ dither: opendisplay }));
    const response = await post({ dither: null });

    await expect(response.json()).resolves.toEqual({ status: "updated", dither: null });
    expect(updates[0]).toMatchObject({ dither: null });
  });

  it("writes nothing for an unchanged save", async () => {
    frameMock.mockResolvedValue(frameRow({ dither: opendisplay }));
    const response = await post({ dither: opendisplay });

    await expect(response.json()).resolves.toEqual({ status: "unchanged", dither: opendisplay });
    expect(updates).toHaveLength(0);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it.each([
    [{}],
    [{ dither: { method: "dbs" } }],
    [{ dither: { method: "opendisplay", exposure: 5 } }],
    [{ dither: { method: "opendisplay", extra: 1 } }],
    [{ dither: "opendisplay" }],
  ])("refuses %j", async (body) => {
    const response = await post(body);

    expect(response.status).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it("is the owner's", async () => {
    frameMock.mockResolvedValue(undefined as never);
    expect((await post({ dither: opendisplay })).status).toBe(404);
    sessionMock.mockResolvedValue(null as never);
    expect((await post({ dither: opendisplay })).status).toBe(401);
  });
});
