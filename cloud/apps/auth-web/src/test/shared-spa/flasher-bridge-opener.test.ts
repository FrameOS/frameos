// @vitest-environment jsdom
//
// The backend page's half of the flash.frameos.net bridge
// (frontend/src/scenes/workspace/flasherBridgeLogic.ts): a page with no Web
// Serial opens the flasher, hands its window — and only its window, at the
// flasher's origin — the frame's setup document, answers its requests for the
// release, and files what comes back under the frame.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initKea } from "../../../../../../frontend/src/initKea";
import { embeddedUsbLogsModel } from "../../../../../../frontend/src/models/embeddedUsbLogsModel";
import { framesModel } from "../../../../../../frontend/src/models/framesModel";
import { flasherBridgeLogic } from "../../../../../../frontend/src/scenes/workspace/flasherBridgeLogic";
import type { FrameType } from "../../../../../../frontend/src/types";
import { bridgeMessage } from "../../../../../../frontend/src/utils/flasherBridge";

const apiFetchMock = vi.hoisted(() => vi.fn<(input: string, init?: RequestInit) => Promise<Response>>());
vi.mock("../../../../../../frontend/src/utils/apiFetch", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, apiFetch: (input: string, init?: RequestInit) => apiFetchMock(input, init) };
});

const FLASHER = "https://flash.frameos.net";

const setupDocument = {
  format: "frameos-setup",
  version: 1,
  frame: { id: 12, name: "Kitchen" },
  backend: { url: "http://192.168.1.10:8989" },
  provisioning: {
    supported: true,
    platform: "esp32-s3",
    releasePlatform: "esp32-s3-generic",
    releaseFlashSize: "8MB",
    releaseFormat: "bin",
    blockers: [],
    warnings: [],
    settings: [{ key: "backend", value: "http://192.168.1.10:8989", secret: false }],
    wifi: { ssid: "Home", password: "hunter2" },
  },
  scenes: [],
};

const frame = { id: 12, name: "Kitchen", mode: "embedded", embedded: { platform: "esp32-s3" } } as unknown as FrameType;

function fakePopup() {
  const popup = { postMessage: vi.fn(), close: vi.fn(), focus: vi.fn(), closed: false };
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  return popup;
}

function fromFlasher(source: unknown, data: unknown, origin = FLASHER) {
  window.dispatchEvent(new MessageEvent("message", { data, origin, source: source as Window }));
}

async function settle() {
  for (let index = 0; index < 5; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (input: string) => {
    if (input === "/api/frames/12/embedded/setup") {
      return Response.json(setupDocument);
    }
    if (input === "/api/frames/firmware") {
      return Response.json({ release: "v2026.11.14", assets: [] });
    }
    if (input === "/api/frames/firmware?platform=esp32-s3-generic&signature=1") {
      return new Response("the minisig");
    }
    if (input === "/api/frames/firmware?platform=esp32-s3-generic") {
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "x-frameos-image-name": "frameos-2026.11.14-esp32-s3-generic.bin", "x-frameos-release": "v2026.11.14" },
      });
    }
    return new Response("null", { status: 404 });
  });
  // As embedded-release-flasher.test.tsx mounts it: no socket, no backend.
  (window as { FRAMEOS_APP_CONFIG?: unknown }).FRAMEOS_APP_CONFIG = { cloudMode: true };
  (window as { FRAMEOS_EMBEDDED_NO_BACKEND?: boolean }).FRAMEOS_EMBEDDED_NO_BACKEND = true;
  initKea();
  framesModel.mount();
  embeddedUsbLogsModel.mount();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as { FRAMEOS_APP_CONFIG?: unknown }).FRAMEOS_APP_CONFIG;
  delete (window as { FRAMEOS_EMBEDDED_NO_BACKEND?: boolean }).FRAMEOS_EMBEDDED_NO_BACKEND;
});

describe("flasherBridgeLogic", () => {
  it("opens the flasher in the click and hands its window the job, at the flasher's origin only", async () => {
    const popup = fakePopup();
    const logic = flasherBridgeLogic({ frameId: 12, frame });
    logic.mount();

    logic.actions.start("setup");
    expect(window.open).toHaveBeenCalledWith(`${FLASHER}/?bridge=1`, "frameos-flasher-12", expect.any(String));
    await settle();
    // Nothing goes out before the flasher says it is there.
    expect(popup.postMessage).not.toHaveBeenCalled();

    // A hello from any other window, or from the right one at another origin, is not the flasher's.
    fromFlasher({}, bridgeMessage({ type: "ready" }));
    fromFlasher(popup, bridgeMessage({ type: "ready" }), "https://evil.example");
    expect(popup.postMessage).not.toHaveBeenCalled();

    fromFlasher(popup, bridgeMessage({ type: "ready" }));
    expect(popup.postMessage).toHaveBeenCalledTimes(1);
    const [message, target] = popup.postMessage.mock.calls[0]!;
    expect(target).toBe(FLASHER);
    expect(message).toMatchObject({ type: "job", job: { kind: "setup", setup: { frame: { id: 12, name: "Kitchen" } } } });
    expect(logic.values.status).toBe("running");
  });

  it("answers the flasher's request for the image with its own bytes and signature", async () => {
    const popup = fakePopup();
    const logic = flasherBridgeLogic({ frameId: 12, frame });
    logic.mount();
    logic.actions.start("setup");
    await settle();
    fromFlasher(popup, bridgeMessage({ type: "ready" }));

    fromFlasher(popup, bridgeMessage({ type: "image-request", id: 7, platform: "esp32-s3-generic" }));
    await settle();
    const answer = popup.postMessage.mock.calls.find(([message]) => (message as { type: string }).type === "image");
    expect(answer).toBeDefined();
    const [message, target, transfer] = answer!;
    expect(target).toBe(FLASHER);
    expect(message).toMatchObject({ id: 7, minisig: "the minisig", name: "frameos-2026.11.14-esp32-s3-generic.bin" });
    expect(Array.from(new Uint8Array((message as { bytes: ArrayBuffer }).bytes))).toEqual([1, 2, 3]);
    expect(transfer).toHaveLength(1);
  });

  it("files the flasher's progress and USB log under the frame", async () => {
    const popup = fakePopup();
    const logic = flasherBridgeLogic({ frameId: 12, frame });
    logic.mount();
    logic.actions.start("setup");
    await settle();
    fromFlasher(popup, bridgeMessage({ type: "ready" }));

    fromFlasher(popup, bridgeMessage({ type: "status", phase: "flashing", message: "Flashing", progress: 42 }));
    fromFlasher(popup, bridgeMessage({ type: "log", line: "I (123) frameos: booted" }));
    fromFlasher(popup, bridgeMessage({ type: "log", line: "not the flasher" }), "https://evil.example");
    fromFlasher(popup, bridgeMessage({ type: "scenes-uploaded" }));
    await settle();

    expect(logic.values.progress).toBe(42);
    const lines = (embeddedUsbLogsModel.values.usbLogsByFrameId[12] ?? []).map((log) => log.line);
    expect(lines).toContain("I (123) frameos: booted");
    expect(lines).not.toContain("not the flasher");
    expect(apiFetchMock).toHaveBeenCalledWith("/api/frames/12/embedded/usb_deploy_complete", { method: "POST" });

    fromFlasher(popup, bridgeMessage({ type: "finished", outcome: "done", message: "Flashed." }));
    expect(logic.values.status).toBe("done");
    expect(logic.values.message).toBe("Flashed.");
  });

  it("says when the browser blocked the window", () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const logic = flasherBridgeLogic({ frameId: 12, frame });
    logic.mount();
    logic.actions.start("update", { pushScenes: true });
    expect(logic.values.status).toBe("error");
    expect(logic.values.error).toMatch(/blocked the flasher’s window/);
  });
});
