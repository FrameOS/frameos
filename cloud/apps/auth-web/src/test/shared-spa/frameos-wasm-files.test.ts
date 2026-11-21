// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FrameOSPreview, type PreviewFileRequest } from "frameos-wasm";

// Upload and Download in the Files scene, the page's half (frameos/wasm/src/files.ts):
// the worker's `fileRequest` opens the file picker or saves the file while the
// page still has the tap's gesture, else waits for the page's own button; the
// files picked go back to the worker, which writes them into the preview's
// folder (frameos/tools/wasm/preview-worker.js).

class FakeWorker {
  static instances: FakeWorker[] = [];
  messages: Array<Record<string, any>> = [];
  transfers: Array<Transferable[] | undefined> = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  constructor(readonly url: string | URL) {
    FakeWorker.instances.push(this);
  }
  postMessage(message: Record<string, any>, transfer?: Transferable[]) {
    this.messages.push(message);
    this.transfers.push(transfer);
  }
  terminate() {}
  reply(data: Record<string, unknown>) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

let gesture = true;
let pickerClicks: HTMLInputElement[] = [];
let saved: Array<{ name: string; href: string }> = [];

beforeEach(() => {
  FakeWorker.instances = [];
  pickerClicks = [];
  saved = [];
  gesture = true;
  vi.stubGlobal("Worker", FakeWorker);
  Object.defineProperty(navigator, "userActivation", {
    configurable: true,
    get: () => ({ isActive: gesture }),
  });
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
    pickerClicks.push(this);
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ href: this.href, name: this.download });
  });
  URL.createObjectURL = vi.fn(() => "blob:frameos-test");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (navigator as { userActivation?: unknown }).userActivation;
});

function makePreview(extra: Partial<ConstructorParameters<typeof FrameOSPreview>[0]> = {}) {
  const preview = new FrameOSPreview({
    height: 480,
    scenes: [{ id: "asset-browser" }],
    width: 800,
    workerUrl: "/frameos-wasm/preview-worker.js",
    ...extra,
  });
  return { preview, worker: FakeWorker.instances[0]! };
}

/** The files the person picks in the input the preview opened. */
function pick(input: HTMLInputElement, files: Array<{ name: string; bytes: number[] }>) {
  Object.defineProperty(input, "files", {
    configurable: true,
    value: files.map((file) => ({
      arrayBuffer: async () => new Uint8Array(file.bytes).buffer,
      name: file.name,
    })),
  });
  input.dispatchEvent(new Event("change"));
}

async function settled() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe("FrameOSPreview files to and from the computer", () => {
  it("asks the worker for Upload and Download unless told not to, and reports what the bundle took", () => {
    const { preview, worker } = makePreview();
    expect(worker.messages[0]).toMatchObject({ fileTransfer: true, type: "init" });
    worker.reply({ fileTransfer: true, type: "ready" });
    expect(preview.runtimeInfo.fileTransfer).toBe(true);
    FakeWorker.instances = [];
    const off = makePreview({ fileTransfer: false });
    expect(off.worker.messages[0]).toMatchObject({ fileTransfer: false });
    off.worker.reply({ type: "ready" });
    expect(off.preview.runtimeInfo.fileTransfer).toBe(false);
  });

  it("opens the picker at once while the tap's gesture lasts, and hands the files picked to the worker", async () => {
    const onFileRequest = vi.fn();
    const { worker } = makePreview({ onFileRequest });
    worker.reply({ id: 7, name: "photos", op: "upload", type: "fileRequest" });
    expect(onFileRequest).not.toHaveBeenCalled();
    expect(pickerClicks).toHaveLength(1);
    const input = pickerClicks[0]!;
    expect(input.type).toBe("file");
    expect(input.multiple).toBe(true);
    pick(input, [
      { bytes: [1, 2, 3], name: "beach.jpg" },
      { bytes: [4], name: "notes.txt" },
    ]);
    await settled();
    const upload = worker.messages.at(-1)!;
    expect(upload).toMatchObject({ id: 7, type: "fileUpload" });
    expect(upload.files.map((file: { name: string }) => file.name)).toEqual(["beach.jpg", "notes.txt"]);
    expect(new Uint8Array(upload.files[0].data)).toEqual(new Uint8Array([1, 2, 3]));
    // The bytes are transferred, not copied.
    expect(worker.transfers.at(-1)).toEqual(upload.files.map((file: { data: ArrayBuffer }) => file.data));
    expect(input.isConnected).toBe(false);
  });

  it("says a picker closed with nothing picked was cancelled", async () => {
    const { worker } = makePreview();
    worker.reply({ id: 3, name: "", op: "upload", type: "fileRequest" });
    pickerClicks[0]!.dispatchEvent(new Event("cancel"));
    await settled();
    expect(worker.messages.at(-1)).toEqual({ error: "cancelled", id: 3, ok: false, type: "fileTransferDone" });
  });

  it("asks the page for a button when the gesture ran out, and opens the picker from its click", async () => {
    gesture = false;
    const asked: Array<PreviewFileRequest | null> = [];
    const { preview, worker } = makePreview({ onFileRequest: (request) => asked.push(request) });
    worker.reply({ id: 9, name: "photos", op: "upload", type: "fileRequest" });
    expect(pickerClicks).toHaveLength(0);
    expect(asked).toEqual([{ id: 9, name: "photos", op: "upload" }]);
    expect(preview.fileRequest).toEqual({ id: 9, name: "photos", op: "upload" });
    // The page's button: its click is the gesture.
    gesture = true;
    preview.answerFileRequest();
    expect(asked.at(-1)).toBeNull();
    expect(preview.fileRequest).toBeNull();
    expect(pickerClicks).toHaveLength(1);
    pick(pickerClicks[0]!, [{ bytes: [9], name: "a.png" }]);
    await settled();
    expect(worker.messages.at(-1)).toMatchObject({ id: 9, type: "fileUpload" });
  });

  it("gives up a request the person dismissed, and a newer one replaces the one waiting", () => {
    gesture = false;
    const asked: Array<PreviewFileRequest | null> = [];
    const { preview, worker } = makePreview({ onFileRequest: (request) => asked.push(request) });
    worker.reply({ id: 1, name: "", op: "upload", type: "fileRequest" });
    worker.reply({ data: new Uint8Array([5]).buffer, id: 2, name: "a.png", op: "download", type: "fileRequest" });
    expect(preview.fileRequest).toEqual({ id: 2, name: "a.png", op: "download" });
    preview.cancelFileRequest();
    expect(worker.messages.at(-1)).toEqual({ error: "cancelled", id: 2, ok: false, type: "fileTransferDone" });
    expect(asked.at(-1)).toBeNull();
    // Nothing more to answer.
    const count = worker.messages.length;
    preview.answerFileRequest();
    preview.cancelFileRequest();
    expect(worker.messages).toHaveLength(count);
  });

  it("saves a download to the computer under the file's name and says it is saved", () => {
    const { worker } = makePreview();
    worker.reply({ data: new Uint8Array([1, 2]).buffer, id: 4, name: "beach.jpg", op: "download", type: "fileRequest" });
    expect(saved).toEqual([{ href: "blob:frameos-test", name: "beach.jpg" }]);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(worker.messages.at(-1)).toEqual({ id: 4, ok: true, type: "fileTransferDone" });
  });

  it("ignores a request it does not know", () => {
    const onFileRequest = vi.fn();
    const { preview, worker } = makePreview({ onFileRequest });
    worker.reply({ id: 5, name: "x", op: "rename", type: "fileRequest" });
    worker.reply({ name: "x", op: "upload", type: "fileRequest" });
    expect(preview.fileRequest).toBeNull();
    expect(onFileRequest).not.toHaveBeenCalled();
    expect(pickerClicks).toHaveLength(0);
  });
});
