// The event map a device comes with (frontend/src/utils/frameEventMap.ts
// `deviceEventMap`): what a frame never given one runs with. The runtime's
// copy is frameos/src/frameos/device_event_map.nim; the two must agree, or
// "Button actions" shows a backend frame one thing while it does another.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deviceEventMap } from "../../../../../../frontend/src/utils/frameEventMap";

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url));

function nimHyperPixelMap(): unknown {
  const nim = readFileSync(`${repoRoot}frameos/src/frameos/device_event_map.nim`, "utf8");
  const body = nim.match(/const hyperPixelEventMap = """([\s\S]*?)"""/)?.[1];
  if (body === undefined) throw new Error("hyperPixelEventMap not found in device_event_map.nim");
  return JSON.parse(body);
}

describe("deviceEventMap", () => {
  it("gives every HyperPixel back and forward from the left and the right edge, up from the bottom the scene switcher and down from the top the settings", () => {
    for (const device of [
      "pimoroni.hyperpixel4sq_touch",
      "pimoroni.hyperpixel4_touch",
      "pimoroni.hyperpixel2r",
    ]) {
      expect(deviceEventMap(device)).toEqual([
        { event: "edgeSwipe", match: { edge: "right" }, emit: "forward", as: {} },
        { event: "edgeSwipe", match: { edge: "left" }, emit: "back", as: {} },
        { event: "edgeSwipe", match: { edge: "bottom" }, emit: "sceneSwitcher", as: {} },
        { event: "edgeSwipe", match: { edge: "top" }, emit: "sceneSettings", as: {} },
      ]);
    }
  });

  it("is nothing for a device that comes with no map", () => {
    expect(deviceEventMap("framebuffer")).toBeNull();
    expect(deviceEventMap(null)).toBeNull();
    expect(deviceEventMap(undefined)).toBeNull();
  });

  it("matches the runtime's table", () => {
    expect(deviceEventMap("pimoroni.hyperpixel4sq_touch")).toEqual(nimHyperPixelMap());
  });

  it("hands out a fresh copy each time", () => {
    const first = deviceEventMap("pimoroni.hyperpixel4sq_touch")?.[0];
    expect(first).toBeDefined();
    if (first) first.as.direction = "prev";
    expect(deviceEventMap("pimoroni.hyperpixel4sq_touch")?.[0]?.as).toEqual({});
  });
});
