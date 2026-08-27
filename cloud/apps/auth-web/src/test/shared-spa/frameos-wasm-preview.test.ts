import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FrameOSPreview } from "frameos-wasm";

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
    expect(onReady).toHaveBeenCalledWith({ currentSceneId: "scene-1" }, browserAssets);
    expect(preview.assetsInfo).toEqual(browserAssets);
    expect(preview.currentSceneId).toBe("scene-1");
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
