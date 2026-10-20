import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { esp32DeviceLimits } from "frameos-wasm";
import { frameRenderDevice } from "../../../../../../frontend/src/utils/frameRenderDevice";
import type { FrameType } from "../../../../../../frontend/src/types";

// The AI chat's render check runs an ESP32 frame's scene in that frame's
// memory, so a scene that would abort on the device goes back to the
// assistant first. The ceiling is the frameos-wasm package's; the
// self-hosted frontend keeps its own copy of that file
// (frontend/src/utils/deviceLimits.ts) because it does not depend on the
// package.

const repoFile = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../../../${path}`, import.meta.url)), "utf8");

// Everything from the first declaration on: the two headers say who they are.
function body(source: string): string {
  return source.slice(source.indexOf("export interface DeviceLimits"));
}

const MB = 1024 * 1024;
const testWindow = globalThis as { window?: { FRAMEOS_APP_CONFIG?: { cloudMode: boolean } } };

afterEach(() => {
  delete testWindow.window;
});

describe("device limits, package and frontend", () => {
  it("is one file kept twice", () => {
    expect(body(repoFile("frontend/src/utils/deviceLimits.ts"))).toBe(body(repoFile("frameos/wasm/src/devices.ts")));
  });
});

describe("frameRenderDevice", () => {
  it("gives a backend ESP32 the PSRAM the backend derived for its board", () => {
    const e1004 = {
      embedded: { layout: { ram: { psramBytes: 8 * MB, renderMode: "local" } }, platform: "esp32-s3" },
      height: 1600,
      width: 1200,
    } as Partial<FrameType>;
    expect(frameRenderDevice(e1004)).toEqual({
      label: "ESP32 with 8 MB PSRAM at 1200x1600",
      limits: esp32DeviceLimits(1200, 1600, 8 * MB),
    });
  });

  it("gives a cloud ESP32 the PSRAM it reported, and 8 MB when it reported none", () => {
    testWindow.window = { FRAMEOS_APP_CONFIG: { cloudMode: true } };
    const reported = {
      hardware: { memory: { psramBytes: 16 * MB }, platform: "esp32-s3" },
      height: 480,
      width: 800,
    } as Partial<FrameType>;
    expect(frameRenderDevice(reported)?.limits).toEqual(esp32DeviceLimits(800, 480, 16 * MB));
    const silent = { hardware: { platform: "esp32-s3" }, height: 480, width: 800 } as Partial<FrameType>;
    expect(frameRenderDevice(silent)?.label).toBe("ESP32 with 8 MB PSRAM at 800x480");
  });

  it("leaves Pis and thin clients to the browser's memory", () => {
    expect(frameRenderDevice({ height: 480, mode: "rpios", width: 800 } as Partial<FrameType>)).toBeNull();
    const thinClient = {
      embedded: { layout: { ram: { psramBytes: 0, renderMode: "remote" } }, platform: "esp32-c3" },
      height: 480,
      width: 800,
    } as Partial<FrameType>;
    expect(frameRenderDevice(thinClient)).toBeNull();
    expect(frameRenderDevice(null)).toBeNull();
  });
});
