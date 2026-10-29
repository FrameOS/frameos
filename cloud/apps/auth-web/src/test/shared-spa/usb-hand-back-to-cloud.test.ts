// @vitest-environment jsdom
//
// "Hand back to the cloud" on the USB card: a cloud frame whose board also has
// a self-hosted backend set turns down the cloud's scenes and settings
// (docs/cloud-frames.md "While managed"). The card clears the backend's three
// keys and restarts the board, after asking.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => [] as string[]);
// What `usb_api status` answers: a backend set until the board restarts.
const board = vi.hoisted(() => ({ backendUrl: "http://10.4.0.47:8991", frameId: 1 }));
vi.mock("../../../../../../frontend/src/models/embeddedUsbLogsModel", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    usbClear: async (_frameId: unknown, key: string) => {
      sent.push(`set ${key} ""`);
    },
    usbSet: async (_frameId: unknown, key: string, value: string) => {
      sent.push(`set ${key} ${value}`);
    },
    usbRestart: async () => {
      sent.push("restart");
      board.backendUrl = "";
      board.frameId = 0;
    },
    runEmbeddedUsbApiCommand: async (_frameId: unknown, command: string) => {
      sent.push(command);
      return { text: JSON.stringify({ cloud: { frameId: cloudFrameId }, config: { ...board } }) };
    },
  };
});
const confirmMock = vi.hoisted(() => vi.fn(async (_request: { title?: string; message: string }) => true));
vi.mock("../../../../../../frontend/src/utils/confirmDialogLogic", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, confirmDialog: confirmMock };
});
vi.mock("../../../../../../frontend/src/utils/apiFetch", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, apiFetch: () => Promise.reject(new Error("no cloud in this test")) };
});

import { initKea } from "../../../../../../frontend/src/initKea";
import { embeddedUsbLogsModel } from "../../../../../../frontend/src/models/embeddedUsbLogsModel";
import { embeddedUsbConnectLogic } from "../../../../../../frontend/src/scenes/workspace/embeddedUsbConnectLogic";
import type { FrameId, FrameType } from "../../../../../../frontend/src/types";

const cloudFrameId = "9994a1e1-9988-4ca5-8c86-26dd763049ee";
const frame = {
  id: cloudFrameId,
  name: "E1002",
  hardware: { platform: "esp32-s3" },
  scenes: [],
} as unknown as FrameType;

type CloudTestWindow = Window & { FRAMEOS_APP_CONFIG?: { cloudMode: boolean }; FRAMEOS_EMBEDDED_NO_BACKEND?: boolean };
const testWindow = window as CloudTestWindow;

// A board on the cable: the USB log stream is open, so the card probes it.
async function connected() {
  const frameId = cloudFrameId as unknown as FrameId;
  embeddedUsbLogsModel.mount();
  const logic = embeddedUsbConnectLogic({ frameId, frame });
  logic.mount();
  embeddedUsbLogsModel.actions.setUsbLogStreamState(frameId, { status: "streaming" });
  await vi.waitFor(() => expect(logic.values.identity?.kind).toBe("this-frame"));
  sent.length = 0;
  return logic;
}

beforeEach(() => {
  testWindow.FRAMEOS_APP_CONFIG = { cloudMode: true };
  testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
  sent.length = 0;
  board.backendUrl = "http://10.4.0.47:8991";
  board.frameId = 1;
  confirmMock.mockClear();
  confirmMock.mockResolvedValue(true);
  initKea();
});

afterEach(() => {
  delete testWindow.FRAMEOS_APP_CONFIG;
  delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
});

describe("hand back to the cloud", () => {
  it("clears the backend, its key and frame id, then restarts the board", async () => {
    const logic = await connected();
    expect(logic.values.identity).toMatchObject({ kind: "this-frame", strayBackend: "10.4.0.47:8991" });
    logic.actions.handBackToCloud();
    await vi.waitFor(() => expect(sent).toContain("restart"));
    expect(sent.slice(0, 4)).toEqual(['set backend ""', 'set api_key ""', "set frame_id 0", "restart"]);
    expect(confirmMock.mock.calls[0]?.[0]).toMatchObject({ title: "Hand this frame back to FrameOS Cloud?" });
    expect(confirmMock.mock.calls[0]?.[0].message).toContain("10.4.0.47:8991");
    await vi.waitFor(() => expect(logic.values.message).toContain("The board restarted"));
    // It reads the board again afterwards, and the backend is gone.
    await vi.waitFor(() => expect(sent).toContain("status"));
    await vi.waitFor(() => expect(logic.values.identity).toEqual(expect.objectContaining({ kind: "this-frame" })));
    expect(logic.values.identity).not.toHaveProperty("strayBackend");
    logic.unmount();
  });

  it("sends nothing when the owner says no, or when no backend is set", async () => {
    confirmMock.mockResolvedValue(false);
    const logic = await connected();
    logic.actions.handBackToCloud();
    await vi.waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    logic.actions.probeSuccess({ kind: "this-frame", status: { cloud: { frameId: cloudFrameId } } });
    logic.actions.handBackToCloud();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
    logic.unmount();
  });
});
