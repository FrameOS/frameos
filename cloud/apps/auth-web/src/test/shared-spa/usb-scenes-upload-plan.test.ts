// A set of scenes over the USB console after a flash
// (frontend/src/scenes/workspace/embeddedFlashShared.tsx
// uploadScenesOverUsbAfterFlash): one `upload-scenes` holds 512 KB at most on
// the board (SCENES_HELD_MAX_BYTES), so a bigger set goes as the scenes that
// fit, then the rest a scene at a time with `scene-put`.
import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: { command: string; bytes: number }[] = [];

vi.mock("../../../../../../frontend/src/models/embeddedUsbLogsModel", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    runEmbeddedUsbApiCommand: vi.fn(async (_frameId: unknown, command: string, options?: { payload?: Uint8Array }) => {
      sent.push({ command, bytes: options?.payload?.byteLength ?? 0 });
      return { output: "", text: "" };
    }),
  };
});

import { uploadScenesOverUsbAfterFlash } from "../../../../../../frontend/src/scenes/workspace/embeddedFlashShared";
import {
  EMBEDDED_USB_WHOLE_SET_MAX_BYTES,
  embeddedUsbScenesUploadPlan,
} from "../../../../../../frontend/src/utils/embeddedUsbUpload";

function scene(id: string, kilobytes: number): Record<string, unknown> {
  return { id, pad: "x".repeat(kilobytes * 1024 - 20) };
}

describe("embeddedUsbScenesUploadPlan", () => {
  it("sends a set that fits in one upload whole", () => {
    const scenes = [scene("a", 100), scene("b", 100)];
    expect(embeddedUsbScenesUploadPlan(scenes)).toEqual({ whole: scenes, each: [] });
  });

  it("sends the first scenes that fit, then the rest alone", () => {
    const scenes = [scene("store", 64), scene("a", 200), scene("b", 200), scene("c", 100), scene("d", 10)];
    const plan = embeddedUsbScenesUploadPlan(scenes);
    expect(plan.whole.map((entry) => entry.id)).toEqual(["store", "a", "b"]);
    expect(plan.each.map((entry) => entry.id)).toEqual(["c", "d"]);
    expect(new TextEncoder().encode(JSON.stringify(plan.whole)).byteLength).toBeLessThanOrEqual(
      EMBEDDED_USB_WHOLE_SET_MAX_BYTES,
    );
  });

  it("always sends at least one scene whole, so the board's set is replaced", () => {
    const plan = embeddedUsbScenesUploadPlan([scene("big", 600), scene("small", 1)]);
    expect(plan.whole.map((entry) => entry.id)).toEqual(["big"]);
  });
});

describe("uploadScenesOverUsbAfterFlash", () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it("uploads a small set in one command", async () => {
    const statuses: string[] = [];
    const port = {} as SerialPort;
    await expect(
      uploadScenesOverUsbAfterFlash("flasher", [scene("a", 10), scene("b", 10)], port, (message) =>
        statuses.push(message),
      ),
    ).resolves.toBe(true);
    expect(sent.map((entry) => entry.command)).toEqual(["upload-scenes"]);
    expect(statuses).toEqual(["Uploading 2 scene(s) over USB"]);
  });

  it("uploads a big set as one upload and a put per scene after it", async () => {
    const statuses: string[] = [];
    const scenes = [scene("store", 64), scene("a", 300), scene("b", 300), scene("c", 300)];
    await uploadScenesOverUsbAfterFlash("flasher", scenes, {} as SerialPort, (message) => statuses.push(message));
    expect(sent.map((entry) => entry.command)).toEqual(["upload-scenes", "scene-put", "scene-put"]);
    expect(sent.every((entry) => entry.bytes <= EMBEDDED_USB_WHOLE_SET_MAX_BYTES)).toBe(true);
    expect(statuses).toEqual([
      "Uploading 2 of 4 scenes over USB",
      "Uploading scene 3 of 4 over USB",
      "Uploading scene 4 of 4 over USB",
    ]);
  });

  it("sends nothing when there is nothing to send", async () => {
    await expect(uploadScenesOverUsbAfterFlash("flasher", [], {} as SerialPort, () => undefined)).resolves.toBe(
      false,
    );
    expect(sent).toEqual([]);
  });
});
