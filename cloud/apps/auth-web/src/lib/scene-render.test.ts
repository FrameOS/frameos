import { describe, expect, it } from "vitest";
import {
  encodePng,
  isRenderErrorLine,
  rendererAvailable,
  renderScenes,
} from "./scene-render";

// The PNG writer and the error classifier are pure. The end-to-end render
// needs the wasm bundle under public/frameos-wasm, which the dev/build
// scripts copy in; without it (a bare checkout) that test skips rather
// than fails, the same way the route answers renderer_unavailable.

describe("encodePng", () => {
  it("writes a well-formed RGBA PNG", () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]);
    const png = encodePng(rgba, 2, 1);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(2);
    expect(png.readUInt32BE(20)).toBe(1);
    expect(png.subarray(png.length - 8, png.length - 4).toString("ascii")).toBe("IEND");
  });

  it("refuses a buffer that does not match the dimensions", () => {
    expect(() => encodePng(new Uint8Array(3), 1, 1)).toThrow(/expected 4/);
  });
});

describe("isRenderErrorLine", () => {
  it("classifies runtime events and plain lines", () => {
    expect(isRenderErrorLine('{"event":"error:4","error":"no key"}')).toBe(true);
    expect(isRenderErrorLine('{"event":"render:done"}')).toBe(false);
    expect(isRenderErrorLine("http error while fetching")).toBe(true);
    expect(isRenderErrorLine("scene initialized")).toBe(false);
  });
});

describe.skipIf(!rendererAvailable())("renderScenes", () => {
  it("renders a scene to a PNG with its logs and state", async () => {
    const result = await renderScenes({
      height: 120,
      scenes: [
        {
          edges: [],
          fields: [{ access: "public", name: "text", type: "string", value: "hi" }],
          id: "s1",
          name: "Blank",
          nodes: [
            { data: { keyword: "render" }, id: "e1", position: { x: 0, y: 0 }, type: "event" },
          ],
          settings: { backgroundColor: "#ffffff", execution: "interpreted" },
        },
      ],
      timeZone: "Europe/Brussels",
      width: 160,
    });
    expect(result.width).toBe(160);
    expect(result.height).toBe(120);
    expect(result.png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(result.logs.some((line) => line.includes("initialized"))).toBe(true);
    expect(result.state).toMatchObject({ text: "hi" });
  }, 60_000);
});
