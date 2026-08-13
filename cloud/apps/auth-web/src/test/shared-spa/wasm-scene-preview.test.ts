import { describe, expect, it } from "vitest";
import {
  createWasmPreviewQueue,
  wasmPreviewCacheKey,
  wasmPreviewDimensions,
  withWasmPreviewEntry,
} from "../../../../../../frontend/src/utils/wasmScenePreview";

// The cloud fleet's wasm preview fallback: when a tile has no device
// snapshot and no store cover, the assigned scene renders in-browser via the
// frameos-wasm worker. These are the pure pieces — the one-at-a-time render
// queue and the capped bitmap cache (wasmPreviewModel wires them to the
// actual worker).

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("wasmPreviewCacheKey", () => {
  const frame = {
    cloud_scene_sources: { "runtime-1": { scene_id: "store-1", scene_version: 4 } },
    height: 480,
    id: 7,
    width: 800,
  };

  it("keys on frame, scene, assignment version and render dimensions", () => {
    expect(wasmPreviewCacheKey(frame, "runtime-1")).toBe("7:runtime-1:4:800x480");
    // Latest-tracking assignments and unhydrated sources fall back to 'latest'.
    expect(wasmPreviewCacheKey(frame, "runtime-2")).toBe("7:runtime-2:latest:800x480");
  });

  it("uses the rotated (render) dimensions, like the live preview canvas", () => {
    expect(wasmPreviewDimensions({ height: 480, rotate: 90, width: 800 })).toEqual({ height: 800, width: 480 });
    expect(wasmPreviewCacheKey({ ...frame, rotate: 270 }, "runtime-1")).toBe("7:runtime-1:4:480x800");
  });
});

describe("withWasmPreviewEntry", () => {
  it("stores bitmaps and tombstones, evicting the oldest entries beyond the cap", () => {
    let state: Record<string, string | null> = {};
    state = withWasmPreviewEntry(state, "a", "data:a", 2);
    state = withWasmPreviewEntry(state, "b", null, 2);
    expect(state).toEqual({ a: "data:a", b: null });

    state = withWasmPreviewEntry(state, "c", "data:c", 2);
    expect(state).toEqual({ b: null, c: "data:c" });
  });

  it("re-inserting a key refreshes its recency", () => {
    let state: Record<string, string | null> = {};
    state = withWasmPreviewEntry(state, "a", "data:a", 2);
    state = withWasmPreviewEntry(state, "b", "data:b", 2);
    state = withWasmPreviewEntry(state, "a", "data:a2", 2);
    state = withWasmPreviewEntry(state, "c", "data:c", 2);
    // b was the oldest once a was refreshed.
    expect(state).toEqual({ a: "data:a2", c: "data:c" });
  });
});

describe("createWasmPreviewQueue", () => {
  it("runs at most one task at a time, in order", async () => {
    const done: [string, string | null][] = [];
    const queue = createWasmPreviewQueue<string>((key, result) => done.push([key, result]));

    let concurrent = 0;
    let maxConcurrent = 0;
    const task = (value: string) => async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await tick();
      concurrent -= 1;
      return value;
    };

    queue.enqueue("a", task("bitmap-a"));
    queue.enqueue("b", task("bitmap-b"));
    queue.enqueue("c", task("bitmap-c"));
    await tick();
    await tick();
    await tick();
    await tick();

    expect(maxConcurrent).toBe(1);
    expect(done).toEqual([
      ["a", "bitmap-a"],
      ["b", "bitmap-b"],
      ["c", "bitmap-c"],
    ]);
  });

  it("dedupes keys while queued or in-flight, and allows a re-render after completion", async () => {
    const done: [string, string | null][] = [];
    const queue = createWasmPreviewQueue<string>((key, result) => done.push([key, result]));

    expect(queue.enqueue("a", async () => "first")).toBe(true);
    expect(queue.enqueue("a", async () => "duplicate")).toBe(false);
    expect(queue.isQueued("a")).toBe(true);
    await tick();
    await tick();

    expect(queue.isQueued("a")).toBe(false);
    expect(queue.enqueue("a", async () => "second")).toBe(true);
    await tick();
    await tick();

    expect(done).toEqual([
      ["a", "first"],
      ["a", "second"],
    ]);
  });

  it("reports a rejected render as null so the caller caches a tombstone", async () => {
    const done: [string, string | null][] = [];
    const queue = createWasmPreviewQueue<string>((key, result) => done.push([key, result]));

    queue.enqueue("boom", async () => {
      throw new Error("render crashed");
    });
    queue.enqueue("ok", async () => "bitmap");
    await tick();
    await tick();

    expect(done).toEqual([
      ["boom", null],
      ["ok", "bitmap"],
    ]);
  });
});
