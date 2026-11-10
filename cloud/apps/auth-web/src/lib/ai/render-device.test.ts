import { esp32DeviceLimits } from "frameos-wasm";
import { describe, expect, it } from "vitest";
import { frameRenderDevice, renderDeviceLimits } from "./render-device";

// The reTerminal E1003's sixteen-grey canvas is its panel buffer while nothing
// turns the picture, from the firmware that does that on (main.c
// canvas_is_panel_picture): the chat's render_scene must render it in the
// 1.31 MB that frees, and keep charging two buffers to anything else.
const MB = 1024 * 1024;
const e1003 = (rotate: number | undefined, frameosVersion: string | null) => ({
  hardware: { platform: "esp32", pixelFormat: 8, memory: { psramBytes: 8 * MB }, rotate },
  frameosVersion,
});

describe("frameRenderDevice on a sixteen-grey panel", () => {
  it("renders an unturned E1003 on firmware that shares in one buffer less", () => {
    const device = frameRenderDevice(e1003(0, "2026.11.6"));
    expect(device?.rotate).toBe(0);
    expect(renderDeviceLimits(device!, 1872, 1404).memoryBytes).toBe(16_539_040);
    expect(renderDeviceLimits(device!, 1872, 1404)).toEqual(esp32DeviceLimits(1872, 1404, 8 * MB, 8, 0));
  });

  it("keeps two buffers for a turned one, older firmware and a frame that does not say", () => {
    for (const frame of [e1003(90, "2026.11.6"), e1003(0, "2026.11.5"), e1003(0, null), e1003(undefined, "2026.11.6")]) {
      const device = frameRenderDevice(frame);
      expect(device?.rotate ?? null).toBe(frame.hardware.rotate === 90 ? 90 : null);
      expect(renderDeviceLimits(device!, 1872, 1404).memoryBytes).toBe(15_224_896);
    }
  });
});
