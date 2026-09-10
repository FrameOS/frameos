import { describe, expect, it } from "vitest";
import {
  acquireRenderSlot,
  encodePng,
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

describe("isRenderErrorLine", () => {
  it("classifies runtime events and plain lines", () => {
    expect(isRenderErrorLine('{"event":"error:4","error":"no key"}')).toBe(true);
    expect(isRenderErrorLine('{"event":"render:done"}')).toBe(false);
    expect(isRenderErrorLine("http error while fetching")).toBe(true);
    expect(isRenderErrorLine("scene initialized")).toBe(false);
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
});
