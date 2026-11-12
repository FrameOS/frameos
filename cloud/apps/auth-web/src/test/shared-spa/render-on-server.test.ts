// Where an ESP32's scenes run (docs/server-rendering.md): the SPA's reading
// of the setting on both planes, and which frames the battery popover offers
// rendering on the server to.
import { describe, expect, it } from "vitest";
import {
  backendFrameRenderMode,
  cloudFrameRenderMode,
  frameCanRenderItself,
  frameCouldRenderOnServer,
  normalizeRenderMode,
} from "../../../../../../frontend/src/utils/renderOnServer";

describe("normalizeRenderMode", () => {
  it("reads every spelling the backend reads (embedded_render_mode_for_frame)", () => {
    expect(normalizeRenderMode("remote")).toBe("remote");
    expect(normalizeRenderMode("thin-client")).toBe("remote");
    expect(normalizeRenderMode("Backend")).toBe("remote");
    expect(normalizeRenderMode("local")).toBe("local");
    expect(normalizeRenderMode("on_device")).toBe("local");
    expect(normalizeRenderMode("cloud")).toBeUndefined();
    expect(normalizeRenderMode(1)).toBeUndefined();
    expect(normalizeRenderMode(undefined)).toBeUndefined();
  });
});

describe("frameCanRenderItself", () => {
  it("is false for a board without a runtime, true for an S3 and for a frame that never said", () => {
    expect(frameCanRenderItself({ platform: "esp32-s3" })).toBe(true);
    expect(frameCanRenderItself({ platform: "esp32" })).toBe(true);
    expect(frameCanRenderItself(undefined)).toBe(true);
    expect(frameCanRenderItself({ platform: "esp32-c3" })).toBe(false);
    expect(frameCanRenderItself({ platform: "pico-2w" })).toBe(false);
    expect(frameCanRenderItself({ platform: "virtual" })).toBe(false);
    expect(frameCanRenderItself({ platform: "esp32-s3", localRenderSupported: false })).toBe(false);
  });
});

describe("the render mode on each plane", () => {
  it("backend: device_config first, then the embedded block, local by default", () => {
    expect(backendFrameRenderMode({ device_config: { renderMode: "remote" }, embedded: undefined })).toBe("remote");
    expect(backendFrameRenderMode({ device_config: { render_mode: "remote" }, embedded: undefined })).toBe("remote");
    expect(
      backendFrameRenderMode({
        device_config: { renderMode: "local" },
        embedded: { renderMode: "remote" } as never,
      }),
    ).toBe("local");
    expect(backendFrameRenderMode({ device_config: {}, embedded: { renderMode: "remote" } as never })).toBe("remote");
    expect(backendFrameRenderMode({ device_config: undefined, embedded: undefined })).toBe("local");
  });

  it("cloud: the owner's setting, else what the device reports", () => {
    expect(cloudFrameRenderMode({ render_mode: "remote", hardware: { renderMode: "local" } })).toBe("remote");
    expect(cloudFrameRenderMode({ render_mode: undefined, hardware: { renderMode: "remote" } })).toBe("remote");
    expect(cloudFrameRenderMode({ render_mode: undefined, hardware: undefined })).toBe("local");
  });
});

describe("frameCouldRenderOnServer", () => {
  it("cloud: an ESP32 with a runtime that renders itself", () => {
    expect(frameCouldRenderOnServer({ mode: "rpios", hardware: { platform: "esp32-s3" } }, "cloud")).toBe(true);
    expect(
      frameCouldRenderOnServer({ mode: "rpios", hardware: { platform: "esp32-s3" }, render_mode: "remote" }, "cloud"),
    ).toBe(false);
    expect(frameCouldRenderOnServer({ mode: "rpios", hardware: { platform: "esp32-c3" } }, "cloud")).toBe(false);
    expect(frameCouldRenderOnServer({ mode: "rpios", hardware: { platform: "linux" } }, "cloud")).toBe(false);
  });

  it("backend: an embedded S3 set to render locally", () => {
    expect(frameCouldRenderOnServer({ mode: "embedded", embedded: { platform: "esp32-s3" } as never }, "backend")).toBe(
      true,
    );
    expect(
      frameCouldRenderOnServer(
        { mode: "embedded", embedded: { platform: "esp32-s3" } as never, device_config: { renderMode: "remote" } },
        "backend",
      ),
    ).toBe(false);
    expect(frameCouldRenderOnServer({ mode: "embedded", embedded: { platform: "esp32-c3" } as never }, "backend")).toBe(
      false,
    );
    expect(frameCouldRenderOnServer({ mode: "embedded", embedded: { platform: "pico-w" } as never }, "backend")).toBe(
      false,
    );
    expect(frameCouldRenderOnServer({ mode: "rpios" }, "backend")).toBe(false);
  });
});
