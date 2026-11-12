import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { inflateSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { esp32DeviceLimits } from "frameos-wasm";
import { fosbHeaderBytes, panelFosb, panelPalette } from "./panel-pack";
import {
  acquireRenderSlot,
  downscaleRgba,
  encodePng,
  encodePngOffThread,
  fetchChildScript,
  isRenderErrorLine,
  maxQueuedRendersPerOwner,
  rendererAvailable,
  rendererVersion,
  renderQueueStateForTests,
  renderScenes,
  SceneRenderError,
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

describe("encodePngOffThread", () => {
  it("writes the same picture with the deflate off this thread", async () => {
    const rgba = new Uint8Array(64 * 32 * 4).map((_, index) => index % 251);
    const png = await encodePngOffThread(rgba, 64, 32);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.readUInt32BE(16)).toBe(64);
    expect(png.readUInt32BE(20)).toBe(32);
    // Same scanlines in: the two encoders differ only in how they deflate.
    const idat = (file: Buffer) => inflateSync(file.subarray(41, file.length - 16));
    expect(idat(png)).toEqual(idat(encodePng(rgba, 64, 32)));
    await expect(encodePngOffThread(new Uint8Array(3), 1, 1)).rejects.toThrow(/expected 4/);
  });
});

describe("downscaleRgba", () => {
  it("averages the picture down to fit, and never up", () => {
    // 4x2: a white left half and a black right half, opaque.
    const rgba = new Uint8Array(4 * 2 * 4);
    for (let y = 0; y < 2; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        const value = x < 2 ? 255 : 0;
        rgba.set([value, value, value, 255], (y * 4 + x) * 4);
      }
    }
    const small = downscaleRgba(rgba, 4, 2, 2);
    expect([small.width, small.height]).toEqual([2, 1]);
    expect([...small.rgba]).toEqual([255, 255, 255, 255, 0, 0, 0, 255]);
    // One pixel is the mean of everything.
    expect([...downscaleRgba(rgba, 4, 2, 1).rgba]).toEqual([128, 128, 128, 255]);
    // Already small enough: handed back as it is.
    expect(downscaleRgba(rgba, 4, 2, 320).rgba).toBe(rgba);
    expect(() => downscaleRgba(new Uint8Array(3), 1, 1, 1)).toThrow(/expected 4/);
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

describe("the HTTP child's host check", () => {
  // The check is the socket's own lookup, so a name that answers public to a
  // first lookup cannot answer private to the connect's (DNS rebinding).
  // `localhost` is the one name a test resolves without the network.
  function fetchInChild(url: string): { status: number; error?: string } {
    const child = spawnSync(process.execPath, ["-e", fetchChildScript], {
      encoding: "utf-8",
      input: JSON.stringify({ method: "GET", url }),
      timeout: 15_000,
    });
    return JSON.parse(child.stdout) as { status: number; error?: string };
  }

  it("refuses a name or a literal that is private, at connect time", async () => {
    const server: Server = createServer((_request, response) => response.end("internal"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      for (const url of [`http://localhost:${port}/`, `http://127.0.0.1:${port}/`, `http://[::1]:${port}/`]) {
        const result = fetchInChild(url);
        expect(result.status, url).toBe(0);
        expect(result.error, url).toContain("host not allowed");
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("rendererVersion", () => {
  // The stamp ships next to the bundle (build_wasm.sh / the release
  // tarball); without a bundle, or with one from before the stamp, it is
  // simply unknown rather than an error.
  it("is the bundle's published FrameOS version, or null", () => {
    const version = rendererVersion();
    if (version !== null) {
      expect(version).toMatch(/^\d{4}\.\d{1,2}\.\d+$/);
    }
  });
});

describe("render queue", () => {
  // Resolved-or-not without awaiting: a settled promise runs its `then`
  // before a later microtask, a pending one does not.
  async function settled(promise: Promise<unknown>) {
    let done = false;
    void promise.then(() => {
      done = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    return done;
  }

  it("lets one owner hold only one of the global slots", async () => {
    const releaseA1 = await acquireRenderSlot("a");
    const a2 = acquireRenderSlot("a");
    // The second render for `a` waits even though a global slot is free…
    expect(await settled(a2)).toBe(false);
    expect(renderQueueStateForTests()).toMatchObject({ running: 1, waiting: ["a"] });
    // …while someone else takes that slot at once.
    const releaseB = await acquireRenderSlot("b");
    expect(renderQueueStateForTests().running).toBe(2);
    // When a's first render finishes, its queued one runs.
    releaseA1();
    const releaseA2 = await a2;
    expect(renderQueueStateForTests()).toMatchObject({ running: 2, waiting: [] });
    releaseA2();
    releaseB();
    expect(renderQueueStateForTests()).toEqual({ running: 0, runningPerOwner: {}, waiting: [] });
  });

  it("refuses an owner's renders beyond its own queue share with its own code", async () => {
    const release = await acquireRenderSlot("a");
    const queued: Promise<() => void>[] = [];
    for (let index = 0; index < maxQueuedRendersPerOwner; index += 1) {
      queued.push(acquireRenderSlot("a"));
    }
    await expect(acquireRenderSlot("a")).rejects.toMatchObject({
      code: "render_concurrency_limit",
    } satisfies Partial<SceneRenderError>);
    // Nobody else is affected by a's backlog.
    const releaseB = await acquireRenderSlot("b");
    releaseB();
    release();
    for (const next of queued) {
      (await next)();
    }
    expect(renderQueueStateForTests()).toEqual({ running: 0, runningPerOwner: {}, waiting: [] });
  });

  it("does not hand a freed slot to a waiter whose owner is still rendering", async () => {
    const releaseA1 = await acquireRenderSlot("a");
    const a2 = acquireRenderSlot("a");
    const releaseB = await acquireRenderSlot("b");
    releaseB();
    // b's slot is free, but a2 is a's second render and a's first is still
    // running: the slot stays free rather than going to a2.
    expect(await settled(a2)).toBe(false);
    expect(renderQueueStateForTests()).toMatchObject({ running: 1, waiting: ["a"] });
    releaseA1();
    (await a2)();
    expect(renderQueueStateForTests().running).toBe(0);
  });

  it("keeps the global queue depth for callers without an owner", async () => {
    const releases = [await acquireRenderSlot(), await acquireRenderSlot()];
    const waiters = Array.from({ length: 8 }, () => acquireRenderSlot());
    await expect(acquireRenderSlot()).rejects.toMatchObject({ code: "renderer_busy" });
    for (const release of releases) {
      release();
    }
    for (const waiter of waiters) {
      (await waiter)();
    }
    expect(renderQueueStateForTests().running).toBe(0);
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

  // What the frame hub asks for when it renders a virtual frame.
  it("hands back a thumbnail, takes seeded state and hears a control plane's events", async () => {
    const result = await renderScenes({
      encodeOffThread: true,
      events: [
        { name: "setSceneState", origin: "cloud", payload: { state: { text: "from an event" } } },
        // Not an origin a control plane may speak as: refused, not fatal.
        { name: "anything", origin: "driver", payload: {} },
      ],
      height: 240,
      sceneId: "s1",
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
      states: { s1: { text: "seeded" } },
      thumbnailMaxDimension: 80,
      width: 480,
    });
    expect(result.png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(result.png.readUInt32BE(16)).toBe(480);
    expect(result.thumbnail?.readUInt32BE(16)).toBe(80);
    expect(result.thumbnail?.readUInt32BE(20)).toBe(40);
    expect(result.state).toMatchObject({ text: "from an event" });
    expect(result.logs.some((line) => line.includes("event:refused"))).toBe(true);
  }, 60_000);

  // What a pull for a panel asks for (server-render.ts): the picture packed
  // in the worker from panel-pack.ts's own text, only the FOSB coming back,
  // byte for byte what the main thread would have packed.
  it("packs the picture for a panel in its worker", async () => {
    const scenes = [
      {
        edges: [],
        fields: [],
        id: "s1",
        name: "Blue",
        nodes: [{ data: { keyword: "render" }, id: "e1", position: { x: 0, y: 0 }, type: "event" }],
        settings: { backgroundColor: "#4a6fa5", execution: "interpreted" },
      },
    ];
    const palette = ["#101010", "#f0f0f0", "#e0d000", "#c00000", "#2040c0", "#20a040"];
    const panel = { format: 7 as const, height: 160, rotate: 90, width: 120 };
    const pixels = await renderScenes({ height: 120, rawRgba: true, scenes, width: 160 });
    const packed = await renderScenes({ height: 120, pack: { ...panel, palette }, rawRgba: true, scenes, width: 160 });
    expect(packed.packError).toBeUndefined();
    expect(packed.rgba).toBeUndefined();
    expect(packed.fosb?.length).toBe(fosbHeaderBytes + 60 * 160);
    const expected = panelFosb(pixels.rgba!, { height: 120, width: 160 }, panel, panelPalette(7, { frame: palette }));
    expect(packed.fosb?.equals(expected)).toBe(true);
  }, 60_000);

  it("fails a render that does not fit the device's memory as render_out_of_memory", async () => {
    // A full-panel SVG drawn with an offset is rasterized into an image of
    // its own: 7.68 MB at 1200x1600, which the E1004 (8 MB PSRAM, RGB565
    // canvas) does not have beside everything else.
    const svg =
      '<svg viewBox="0 0 1200 1600" width="1200" height="1600"><rect width="1200" height="1600" fill="#efe7d7"/></svg>';
    const attempt = renderScenes({
      deviceLimits: esp32DeviceLimits(1200, 1600, 8 * 1024 * 1024),
      height: 1600,
      scenes: [
        {
          edges: [
            { id: "e", source: "e1", sourceHandle: "next", target: "svg", targetHandle: "prev" },
          ],
          fields: [],
          id: "s1",
          name: "Too big",
          nodes: [
            { data: { keyword: "render" }, id: "e1", position: { x: 0, y: 0 }, type: "event" },
            {
              data: {
                config: { blendMode: "normal", offsetX: "1", offsetY: "0", placement: "center", svg },
                keyword: "render/svg",
              },
              id: "svg",
              position: { x: 200, y: 0 },
              type: "app",
            },
          ],
          settings: { execution: "interpreted" },
        },
      ],
      width: 1200,
    });
    await expect(attempt).rejects.toMatchObject({
      code: "render_out_of_memory",
      message: expect.stringMatching(/^Out of memory: an allocation of 7\.3 MB was refused/),
    });
  }, 60_000);
});
