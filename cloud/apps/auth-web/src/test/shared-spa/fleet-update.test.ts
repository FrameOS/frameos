// @vitest-environment jsdom
//
// "Update all" in the frames sidebar (fleetUpdateLogic): which active frames
// it counts, which verb each control plane uses for one frame, and that a
// click asks the frames one after another with a pause in between, spins
// until the last request went out, and refuses to run twice at once. The
// logic lives in frontend/src (the shared SPA, no test runner of its own), so
// it is tested from auth-web like the other shared-spa suites.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initKea } from "../../../../../../frontend/src/initKea";
import type { FrameType } from "../../../../../../frontend/src/types";

const apiFetchMock = vi.hoisted(() => vi.fn<(input: string, init?: RequestInit) => Promise<Response>>());
vi.mock("../../../../../../frontend/src/utils/apiFetch", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    apiFetch: (input: string, init?: RequestInit) => apiFetchMock(input, init),
  };
});

import { framesModel } from "../../../../../../frontend/src/models/framesModel";
import { publishedReleaseModel } from "../../../../../../frontend/src/models/publishedReleaseModel";
import { pendingFrameosUpgrade } from "../../../../../../frontend/src/scenes/frame/frameLogic";
import {
  FLEET_UPDATE_STAGGER_MS,
  fleetUpdateInFlight,
  fleetUpdateLogic,
  fleetUpdateVerbForFrame,
} from "../../../../../../frontend/src/scenes/workspace/fleetUpdateLogic";

type CloudTestWindow = Window & {
  FRAMEOS_APP_CONFIG?: { cloudMode: boolean };
  FRAMEOS_EMBEDDED_NO_BACKEND?: boolean;
};
const testWindow = window as CloudTestWindow;

const LATEST = "2026.9.22";

function cloudFrame(id: string, overrides: Partial<FrameType> = {}): FrameType {
  return {
    id: id as unknown as FrameType["id"],
    name: `Frame ${id}`,
    managed_by: "cloud",
    mode: "cloud",
    hardware: { platform: "esp32s3", width: 800, height: 480 },
    status: "active",
    connected: true,
    last_seen_at: new Date().toISOString(),
    frameos_version: "2026.9.20",
    ...overrides,
  } as unknown as FrameType;
}

function backendFrame(id: string, overrides: Partial<FrameType> = {}): FrameType {
  return {
    id: id as unknown as FrameType["id"],
    name: `Frame ${id}`,
    mode: "rpios",
    status: "ready",
    active_connections: 1,
    last_successful_deploy: { frameos_version: "2026.9.20" },
    ...overrides,
  } as unknown as FrameType;
}

function commandPosts(): string[] {
  return apiFetchMock.mock.calls
    .filter(([, init]) => init?.method === "POST")
    .map(([url]) => url);
}

beforeEach(() => {
  testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (url) =>
    url.endsWith("/command") ? Response.json({ ok: true }) : new Response("null", { status: 404 })
  );
});

afterEach(() => {
  vi.useRealTimers();
  delete testWindow.FRAMEOS_APP_CONFIG;
  delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
});

describe("pendingFrameosUpgrade", () => {
  beforeEach(() => {
    testWindow.FRAMEOS_APP_CONFIG = { cloudMode: true };
  });

  it("is the release a cloud frame is behind on", () => {
    expect(pendingFrameosUpgrade(cloudFrame("a"), LATEST)).toEqual({
      kind: "upgrade",
      previousVersion: "2026.9.20",
      currentVersion: LATEST,
    });
  });

  it("is nothing for a frame on the latest release, an unknown release, or a frame with other changes pending", () => {
    expect(pendingFrameosUpgrade(cloudFrame("a", { frameos_version: LATEST }), LATEST)).toBeNull();
    expect(pendingFrameosUpgrade(cloudFrame("a"), null)).toBeNull();
    expect(pendingFrameosUpgrade(cloudFrame("a", { frameos_version: "" }), LATEST)).toBeNull();
    expect(
      pendingFrameosUpgrade(cloudFrame("a", { assigned_checksum: "new", scenes_checksum: "old" }), LATEST)
    ).toBeNull();
    expect(pendingFrameosUpgrade(cloudFrame("a", { archived: true }), LATEST)).toBeNull();
  });
});

describe("fleetUpdateVerbForFrame", () => {
  it("nudges every cloud frame through the hub", () => {
    testWindow.FRAMEOS_APP_CONFIG = { cloudMode: true };
    expect(fleetUpdateVerbForFrame(cloudFrame("pi", { hardware: { platform: "linux", width: 800, height: 480 } }))).toBe(
      "cloudNotify"
    );
    expect(fleetUpdateVerbForFrame(cloudFrame("esp"))).toBe("cloudNotify");
  });

  it("picks the backend's verb from the frame's mode", () => {
    expect(fleetUpdateVerbForFrame(backendFrame("pi"))).toBe("fullDeploy");
    const adoptedCard = { mode: "buildroot", ssh_pass: "", ssh_keys: [], buildroot: { adopted: true } } as Partial<FrameType>;
    expect(fleetUpdateVerbForFrame(backendFrame("card", adoptedCard))).toBe("deviceUpgrade");
    expect(fleetUpdateVerbForFrame(backendFrame("card", { ...adoptedCard, ssh_pass: "secret" }))).toBe("fullDeploy");
    expect(fleetUpdateVerbForFrame(backendFrame("esp", { mode: "embedded", embedded: { platform: "esp32s3" } }))).toBe(
      "embeddedOta"
    );
    expect(
      fleetUpdateVerbForFrame(backendFrame("small", { mode: "embedded", embedded: { platform: "esp32c3", flashSize: "4MB" } }))
    ).toBeNull();
    expect(fleetUpdateVerbForFrame(backendFrame("pico", { mode: "embedded", embedded: { platform: "pico_w" } }))).toBeNull();
    expect(fleetUpdateVerbForFrame(backendFrame("virtual", { mode: "embedded", embedded: { platform: "virtual" } }))).toBeNull();
    expect(fleetUpdateVerbForFrame(backendFrame("elsewhere", { managed_by: "cloud" }))).toBeNull();
  });
});

describe("fleetUpdateInFlight", () => {
  it("sees a queued nudge, a busy status and a running task", () => {
    expect(fleetUpdateInFlight(cloudFrame("a"), [])).toBe(false);
    expect(fleetUpdateInFlight(cloudFrame("a", { pending_command_types: ["notify_update_available"] }), [])).toBe(true);
    expect(fleetUpdateInFlight(backendFrame("a", { status: "deploying" }), [])).toBe(true);
    expect(
      fleetUpdateInFlight(backendFrame("a"), [
        { id: "t", frameId: "a" as unknown as FrameType["id"], kind: "embeddedOta", status: "running", title: "", logs: [] },
      ] as never)
    ).toBe(true);
    expect(
      fleetUpdateInFlight(backendFrame("a"), [
        { id: "t", frameId: "a" as unknown as FrameType["id"], kind: "render", status: "running", title: "", logs: [] },
      ] as never)
    ).toBe(false);
  });
});

describe("fleetUpdateLogic on the cloud", () => {
  let unmount: () => void = () => {};
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // addFrame hydrates a cloud frame's scene list from the API; the 404 the
    // mock answers is logged, not thrown.
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
    testWindow.FRAMEOS_APP_CONFIG = { cloudMode: true };
    initKea({ memoryRouter: true });
    framesModel.mount();
    for (const frame of [
      cloudFrame("behind-1"),
      cloudFrame("behind-2"),
      cloudFrame("queued", { pending_command_types: ["notify_update_available"] }),
      cloudFrame("current", { frameos_version: LATEST }),
      cloudFrame("asleep", { connected: false, last_seen_at: new Date(Date.now() - 3 * 3600_000).toISOString() }),
      cloudFrame("behind-3"),
    ]) {
      framesModel.actions.addFrame(frame);
    }
    publishedReleaseModel.mount();
    publishedReleaseModel.actions.loadPublishedReleaseSuccess(LATEST);
    unmount = fleetUpdateLogic.mount();
  });

  afterEach(() => {
    unmount();
    consoleError.mockRestore();
  });

  it("counts the active frames that are only a release behind with nothing queued", () => {
    expect(fleetUpdateLogic.values.framesNeedingUpdate.map((frame) => frame.id)).toEqual([
      "behind-1",
      "behind-2",
      "behind-3",
    ]);
    expect(fleetUpdateLogic.values.updateAllTitle).toBe(`Update 3 active frames to FrameOS ${LATEST}`);
  });

  it("asks the frames one after another, spins until the last request, and runs once at a time", async () => {
    fleetUpdateLogic.actions.updateAllFrames();
    expect(fleetUpdateLogic.values.updatingAll).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(commandPosts()).toEqual(["/api/frames/behind-1/command"]);
    // Every frame the loop has asked leaves the list at once.
    expect(fleetUpdateLogic.values.framesNeedingUpdate.map((frame) => frame.id)).toEqual(["behind-2", "behind-3"]);

    // A second click while the first loop runs starts nothing.
    fleetUpdateLogic.actions.updateAllFrames();
    await vi.advanceTimersByTimeAsync(0);
    expect(commandPosts()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(FLEET_UPDATE_STAGGER_MS - 1);
    expect(commandPosts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(commandPosts()).toEqual(["/api/frames/behind-1/command", "/api/frames/behind-2/command"]);
    expect(fleetUpdateLogic.values.updatingAll).toBe(true);

    await vi.advanceTimersByTimeAsync(FLEET_UPDATE_STAGGER_MS);
    expect(commandPosts()).toEqual([
      "/api/frames/behind-1/command",
      "/api/frames/behind-2/command",
      "/api/frames/behind-3/command",
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fleetUpdateLogic.values.updatingAll).toBe(false);
    expect(fleetUpdateLogic.values.framesNeedingUpdate).toEqual([]);
    const firstCommand = apiFetchMock.mock.calls.find(([url]) => url.endsWith("/command"));
    expect(firstCommand?.[1]?.body).toBe(JSON.stringify({ type: "notify_update_available" }));

    // Nothing left: a click is a no-op that settles at once.
    fleetUpdateLogic.actions.updateAllFrames();
    await vi.advanceTimersByTimeAsync(0);
    expect(commandPosts()).toHaveLength(3);
    expect(fleetUpdateLogic.values.updatingAll).toBe(false);
  });

  it("moves on when a frame refuses the request", async () => {
    apiFetchMock.mockImplementation(async (url) =>
      url.includes("behind-1") && url.endsWith("/command")
        ? Response.json({ error: "frame_not_active" }, { status: 409 })
        : url.endsWith("/command")
          ? Response.json({ ok: true })
          : new Response("null", { status: 404 })
    );
    fleetUpdateLogic.actions.updateAllFrames();
    await vi.advanceTimersByTimeAsync(FLEET_UPDATE_STAGGER_MS * 2 + 10);
    expect(commandPosts()).toEqual([
      "/api/frames/behind-1/command",
      "/api/frames/behind-2/command",
      "/api/frames/behind-3/command",
    ]);
    expect(fleetUpdateLogic.values.updatingAll).toBe(false);
  });
});
