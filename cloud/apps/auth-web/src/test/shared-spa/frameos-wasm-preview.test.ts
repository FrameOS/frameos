import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FrameOSPreview, POINTER_AXIS_MAX, pointerAxis, pointerButton, pointerPictureRect } from "frameos-wasm";

// The frameos-wasm package's typed wrapper around the preview worker: the
// init message it sends, the fast-mode switch, and the request/reply
// plumbing for the browser asset folder ops. The worker itself is an
// emscripten bundle — stand in with a fake that records messages and lets
// the test answer them.

class FakeWorker {
  static instances: FakeWorker[] = [];
  messages: Array<Record<string, unknown>> = [];
  transfers: Array<Transferable[] | undefined> = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  constructor(
    readonly url: string | URL,
    readonly options?: WorkerOptions,
  ) {
    FakeWorker.instances.push(this);
  }
  postMessage(message: Record<string, unknown>, transfer?: Transferable[]) {
    this.messages.push(message);
    this.transfers.push(transfer);
  }
  terminate() {
    this.terminated = true;
  }
  /** Deliver a message from the "worker" to the page. */
  reply(data: Record<string, unknown>) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal("Worker", FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makePreview(extra: Partial<ConstructorParameters<typeof FrameOSPreview>[0]> = {}) {
  const preview = new FrameOSPreview({
    height: 480,
    scenes: [{ id: "scene-1" }],
    width: 800,
    workerUrl: "/frameos-wasm/preview-worker.js",
    ...extra,
  });
  return { preview, worker: FakeWorker.instances[0]! };
}

describe("FrameOSPreview init", () => {
  it("starts throttled with the browser folder mounted and saving allowed", () => {
    const { worker } = makePreview();
    expect(worker.options).toEqual({ type: "module" });
    expect(worker.messages[0]).toMatchObject({
      browserAssets: true,
      fastMode: false,
      saveAssets: true,
      type: "init",
    });
  });

  it("passes fastMode, saveAssets and browserAssets through", () => {
    const { worker } = makePreview({
      browserAssets: false,
      fastMode: true,
      saveAssets: { render: false },
    });
    expect(worker.messages[0]).toMatchObject({
      browserAssets: false,
      fastMode: true,
      saveAssets: { render: false },
    });
  });

  it("reports the folder's backing with ready", () => {
    const onReady = vi.fn();
    const { preview, worker } = makePreview({ onReady });
    const browserAssets = { maxBytes: 1, mounted: true, persistent: false, root: "/srv/assets" };
    worker.reply({ browserAssets, sceneInfo: { currentSceneId: "scene-1" }, type: "ready" });
    // The third argument is the runtime the worker booted (#444: the wasm
    // bundle is a release asset and the preview shows "runtime <version>");
    // a worker that names none reports null rather than an absent field.
    expect(onReady).toHaveBeenCalledWith({ currentSceneId: "scene-1" }, browserAssets, {
      pointerEvents: false,
      version: null,
    });
    expect(preview.assetsInfo).toEqual(browserAssets);
    expect(preview.currentSceneId).toBe("scene-1");
    expect(preview.runtimeInfo).toEqual({ pointerEvents: false, version: null });
  });

  it("names the runtime version the worker reports", () => {
    const onReady = vi.fn();
    const { preview, worker } = makePreview({ onReady });
    worker.reply({ runtimeVersion: "2026.9.2", type: "ready" });
    expect(onReady).toHaveBeenLastCalledWith(undefined, null, { pointerEvents: false, version: "2026.9.2" });
    expect(preview.runtimeInfo).toEqual({ pointerEvents: false, version: "2026.9.2" });
  });
});

// Pointer input: the page sends what a frame's evdev driver sends. The cloud
// serves the LAST RELEASE's bundle, so a page can be newer than its worker —
// and a worker from before pointer input would hand the scene raw 0..32767
// coordinates and render on every move.
describe("FrameOSPreview pointer input", () => {
  class FakeCanvas extends EventTarget {
    width = 800;
    height = 480;
    setPointerCapture = vi.fn();
    getBoundingClientRect() {
      return { height: 240, left: 10, top: 20, width: 400 };
    }
  }

  function pointer(type: string, init: Record<string, number>) {
    return Object.assign(new Event(type, { cancelable: true }), { button: -1, buttons: 0, pointerId: 7, ...init });
  }

  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  it("forwards nothing to a bundle that does not say it takes pointers", () => {
    const { preview, worker } = makePreview();
    const canvas = new FakeCanvas();
    preview.attachPointerInput(canvas as unknown as HTMLCanvasElement);
    worker.reply({ runtimeVersion: "2026.9.20", type: "ready" });
    const sent = worker.messages.length;
    canvas.dispatchEvent(pointer("pointerdown", { button: 0, buttons: 1, clientX: 210, clientY: 140 }));
    canvas.dispatchEvent(pointer("pointermove", { clientX: 220, clientY: 140 }));
    expect(worker.messages).toHaveLength(sent);
    // ...and the right click keeps its menu.
    const menu = new Event("contextmenu", { cancelable: true });
    canvas.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(false);
  });

  it("sends mouseMove / mouseDown / mouseUp the way the evdev driver does", () => {
    const { preview, worker } = makePreview();
    const canvas = new FakeCanvas();
    const detach = preview.attachPointerInput(canvas as unknown as HTMLCanvasElement);
    worker.reply({ pointerEvents: true, runtimeVersion: "2026.9.21", type: "ready" });
    expect(preview.runtimeInfo.pointerEvents).toBe(true);
    const sent = worker.messages.length;

    // The middle of the picture, pressed: the position lands first.
    canvas.dispatchEvent(pointer("pointerdown", { button: 0, buttons: 1, clientX: 210, clientY: 140 }));
    expect(canvas.setPointerCapture).toHaveBeenCalledWith(7);
    // Dragged off the bottom-right corner, where it is let go.
    canvas.dispatchEvent(pointer("pointermove", { buttons: 1, clientX: 900, clientY: 900 }));
    canvas.dispatchEvent(pointer("pointerup", { button: 0, clientX: 900, clientY: 900 }));
    expect(worker.messages.slice(sent)).toEqual([
      { name: "mouseMove", payload: { x: 16384, y: 16384 }, type: "event" },
      { name: "mouseDown", payload: { button: 0 }, type: "event" },
      { name: "mouseMove", payload: { x: 32767, y: 32767 }, type: "event" },
      { name: "mouseMove", payload: { x: 32767, y: 32767 }, type: "event" },
      { name: "mouseUp", payload: { button: 0 }, type: "event" },
    ]);

    // The right button is a button here, not the browser's menu.
    const menu = new Event("contextmenu", { cancelable: true });
    canvas.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);

    detach();
    const afterDetach = worker.messages.length;
    canvas.dispatchEvent(pointer("pointerdown", { button: 0, buttons: 1, clientX: 210, clientY: 140 }));
    expect(worker.messages).toHaveLength(afterDetach);
  });

  it("names a second button by the driver's numbers, and lets go of all of them on a cancel", () => {
    const { preview, worker } = makePreview();
    const canvas = new FakeCanvas();
    preview.attachPointerInput(canvas as unknown as HTMLCanvasElement);
    worker.reply({ pointerEvents: true, type: "ready" });
    const sent = worker.messages.length;

    canvas.dispatchEvent(pointer("pointerdown", { button: 0, buttons: 1, clientX: 10, clientY: 20 }));
    // The right button (DOM 2) joins while the left is held: a pointermove
    // that names it. The driver calls it button 1.
    canvas.dispatchEvent(pointer("pointermove", { button: 2, buttons: 3, clientX: 10, clientY: 20 }));
    canvas.dispatchEvent(new Event("pointercancel"));
    const names = worker.messages.slice(sent).map((message) => [message.name, message.payload]);
    expect(names).toEqual([
      ["mouseMove", { x: 0, y: 0 }],
      ["mouseDown", { button: 0 }],
      ["mouseMove", { x: 0, y: 0 }],
      ["mouseDown", { button: 1 }],
      ["mouseUp", { button: 0 }],
      ["mouseUp", { button: 1 }],
    ]);
  });
});

describe("pointer arithmetic", () => {
  it("scales a position to 0..32767 and keeps it on the picture", () => {
    expect(pointerAxis(0, 400)).toBe(0);
    expect(pointerAxis(400, 400)).toBe(POINTER_AXIS_MAX);
    expect(pointerAxis(200, 400)).toBe(16384);
    expect(pointerAxis(-30, 400)).toBe(0);
    expect(pointerAxis(999, 400)).toBe(POINTER_AXIS_MAX);
    // A canvas that is not laid out yet has no size to divide by.
    expect(pointerAxis(10, 0)).toBe(0);
  });

  it("finds the picture inside a letterboxed (object-fit: contain) element", () => {
    // An 800x480 frame in a 1000x1000 box: full width, centred vertically.
    expect(pointerPictureRect({ height: 1000, left: 0, top: 0, width: 1000 }, 800, 480)).toEqual({
      height: 600,
      left: 0,
      top: 200,
      width: 1000,
    });
    const box = { height: 240, left: 10, top: 20, width: 400 };
    expect(pointerPictureRect(box, 800, 480)).toEqual(box);
    expect(pointerPictureRect(box, 0, 0)).toBe(box);
  });

  it("maps DOM buttons to the evdev driver's", () => {
    expect([0, 1, 2, 3, 4, 5].map(pointerButton)).toEqual([0, 2, 1, 3, 4, -1]);
  });
});

describe("FrameOSPreview render pacing", () => {
  it("surfaces the worker's fast-render request and forwards setFastMode", () => {
    const onFastRenderRequest = vi.fn();
    const { preview, worker } = makePreview({ onFastRenderRequest });
    worker.reply({ intervalMs: 42, type: "fastRenderRequest" });
    expect(onFastRenderRequest).toHaveBeenCalledWith(42);

    preview.setFastMode(true);
    expect(preview.fastMode).toBe(true);
    expect(worker.messages.at(-1)).toEqual({ enabled: true, type: "setFastMode" });
  });
});

describe("FrameOSPreview browser assets", () => {
  it("answers each request by id and transfers written bytes", async () => {
    const onAssetsChanged = vi.fn();
    const { preview, worker } = makePreview({ onAssetsChanged });

    const listing = preview.listAssets();
    const listRequest = worker.messages.at(-1)!;
    expect(listRequest).toMatchObject({ op: "list", type: "assets" });
    const entries = [{ isDir: false, mtime: 1, path: "a.jpg", size: 3 }];
    const info = { maxBytes: 9, mounted: true, persistent: true, root: "/srv/assets" };
    worker.reply({ entries, info, ok: true, requestId: listRequest.requestId, type: "assetsResult" });
    expect(await listing).toEqual(entries);
    expect(preview.assetsInfo).toEqual(info);

    const bytes = new Uint8Array([1, 2, 3]);
    const writing = preview.writeAsset("photos/new.jpg", bytes);
    const writeRequest = worker.messages.at(-1)!;
    expect(writeRequest).toMatchObject({ op: "write", path: "photos/new.jpg", type: "assets" });
    expect(writeRequest.requestId).not.toBe(listRequest.requestId);
    expect(new Uint8Array(writeRequest.data as ArrayBuffer)).toEqual(bytes);
    // The buffer is transferred, not copied.
    expect(worker.transfers.at(-1)).toEqual([writeRequest.data]);
    worker.reply({ ok: true, requestId: writeRequest.requestId, type: "assetsResult" });
    await writing;

    // Unrelated ids are ignored; an error reply rejects that request only.
    worker.reply({ ok: true, requestId: 999, type: "assetsResult" });
    const deleting = preview.deleteAsset("../etc");
    const deleteRequest = worker.messages.at(-1)!;
    worker.reply({ error: "invalid path", ok: false, requestId: deleteRequest.requestId, type: "assetsResult" });
    await expect(deleting).rejects.toThrow("invalid path");

    worker.reply({ type: "assetsChanged" });
    expect(onAssetsChanged).toHaveBeenCalledTimes(1);
  });

  it("rejects pending requests when destroyed, and refuses new ones", async () => {
    const { preview } = makePreview();
    const pending = preview.resetAssets();
    preview.destroy();
    await expect(pending).rejects.toThrow("preview destroyed");
    await expect(preview.listAssets()).rejects.toThrow("preview is not running");
  });
});
