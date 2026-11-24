// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FrameOSPreview,
  PREVIEW_GESTURE_MS,
  attachKeyboardInput,
  attachPointerInput,
  safeFileName,
  type PreviewFileRequest,
} from "frameos-wasm";

// Upload and Download in the Files scene, the page's half (frameos/wasm/src/files.ts):
// the worker's `fileRequest` opens the file picker or saves the file when the
// person pressed on the preview a moment ago and the page still has that
// gesture, else waits for the page's own button, else is turned down (scene
// code is anyone's and may ask at any time); the files picked go back to the
// worker, which writes them into the preview's folder
// (frameos/tools/wasm/preview-worker.js).

/** What the page posts the worker. */
interface Posted {
  type?: string;
  id?: number;
  files?: Array<{ name: string; data: ArrayBuffer }>;
  [key: string]: unknown;
}

class FakeWorker {
  static instances: FakeWorker[] = [];
  messages: Posted[] = [];
  transfers: Array<Transferable[] | undefined> = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  constructor(readonly url: string | URL) {
    FakeWorker.instances.push(this);
  }
  postMessage(message: Posted, transfer?: Transferable[]) {
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
// The page's record of the last press on a preview outlives a test: every
// test starts an hour after the one before, with nothing pressed.
let clock = Date.UTC(2026, 10, 24);

class FakeCanvas extends EventTarget {
  width = 800;
  height = 480;
  tabIndex = -1;
  setPointerCapture = vi.fn();
  getBoundingClientRect() {
    return { height: 480, left: 0, top: 0, width: 800 };
  }
}

/** The person taps the preview: what a tap on the Files scene's Download is. */
function tapPreview() {
  const canvas = new FakeCanvas();
  const detach = attachPointerInput(canvas as unknown as HTMLCanvasElement, () => undefined, { inputV2: () => true });
  canvas.dispatchEvent(
    Object.assign(new Event("pointerdown", { cancelable: true }), {
      button: 0, buttons: 1, clientX: 10, clientY: 10, pointerId: 1, pointerType: "mouse",
    }),
  );
  detach();
}

beforeEach(() => {
  FakeWorker.instances = [];
  pickerClicks = [];
  saved = [];
  gesture = true;
  clock += 60 * 60 * 1000;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock);
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
  vi.useRealTimers();
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
    tapPreview();
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
    const files = upload.files ?? [];
    expect(files.map((file) => file.name)).toEqual(["beach.jpg", "notes.txt"]);
    expect(new Uint8Array(files[0]!.data)).toEqual(new Uint8Array([1, 2, 3]));
    // The bytes are transferred, not copied.
    expect(worker.transfers.at(-1)).toEqual(files.map((file) => file.data));
    expect(input.isConnected).toBe(false);
  });

  it("says a picker closed with nothing picked was cancelled", async () => {
    const { worker } = makePreview();
    tapPreview();
    worker.reply({ id: 3, name: "", op: "upload", type: "fileRequest" });
    pickerClicks[0]!.dispatchEvent(new Event("cancel"));
    await settled();
    expect(worker.messages.at(-1)).toEqual({ error: "cancelled", id: 3, ok: false, type: "fileTransferDone" });
  });

  it("asks the page for a button when the gesture ran out, and opens the picker from its click", async () => {
    gesture = false;
    const asked: Array<PreviewFileRequest | null> = [];
    const { preview, worker } = makePreview({ onFileRequest: (request) => asked.push(request) });
    tapPreview();
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
    tapPreview();
    worker.reply({ data: new Uint8Array([1, 2]).buffer, id: 4, name: "beach.jpg", op: "download", type: "fileRequest" });
    expect(saved).toEqual([{ href: "blob:frameos-test", name: "beach.jpg" }]);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(worker.messages.at(-1)).toEqual({ id: 4, ok: true, type: "fileTransferDone" });
  });

  // Scene code is anyone's (a store scene's preview runs on its public page)
  // and may ask whenever it likes. A click elsewhere on the page gives the
  // page a gesture; it is not the scene's permission to save a file.
  it("saves nothing nobody pressed for: the page asks with its own button, though it has a gesture", () => {
    const asked: Array<PreviewFileRequest | null> = [];
    const { preview, worker } = makePreview({ onFileRequest: (request) => asked.push(request) });
    worker.reply({ data: new Uint8Array([1]).buffer, id: 11, name: "setup.exe", op: "download", type: "fileRequest" });
    expect(saved).toEqual([]);
    expect(asked).toEqual([{ id: 11, name: "setup.exe", op: "download" }]);
    worker.reply({ id: 12, name: "photos", op: "upload", type: "fileRequest" });
    expect(pickerClicks).toHaveLength(0);
    expect(preview.fileRequest).toEqual({ id: 12, name: "photos", op: "upload" });
    // The page's Save: the person's own click.
    worker.reply({ data: new Uint8Array([1]).buffer, id: 13, name: "notes.txt", op: "download", type: "fileRequest" });
    preview.answerFileRequest();
    expect(saved).toEqual([{ href: "blob:frameos-test", name: "notes.txt" }]);
    expect(worker.messages.at(-1)).toEqual({ id: 13, ok: true, type: "fileTransferDone" });
  });

  it("turns a request nobody pressed for down when the page has no button to ask with", () => {
    const { preview, worker } = makePreview();
    worker.reply({ data: new Uint8Array([1]).buffer, id: 21, name: "setup.exe", op: "download", type: "fileRequest" });
    expect(saved).toEqual([]);
    expect(worker.messages.at(-1)).toEqual({ error: "cancelled", id: 21, ok: false, type: "fileTransferDone" });
    worker.reply({ id: 22, name: "", op: "upload", type: "fileRequest" });
    expect(pickerClicks).toHaveLength(0);
    expect(worker.messages.at(-1)).toEqual({ error: "cancelled", id: 22, ok: false, type: "fileTransferDone" });
    expect(preview.fileRequest).toBeNull();
  });

  it("counts a press on the preview for a few seconds, a key as well as a pointer", () => {
    const asked: Array<PreviewFileRequest | null> = [];
    const { worker } = makePreview({ onFileRequest: (request) => asked.push(request) });
    tapPreview();
    vi.setSystemTime(clock + PREVIEW_GESTURE_MS + 1);
    worker.reply({ data: new Uint8Array([1]).buffer, id: 31, name: "a.png", op: "download", type: "fileRequest" });
    expect(saved).toEqual([]);
    expect(asked).toEqual([{ id: 31, name: "a.png", op: "download" }]);
    // Enter on the scene's Download button.
    const canvas = new FakeCanvas();
    attachKeyboardInput(canvas as unknown as HTMLCanvasElement, () => undefined);
    canvas.dispatchEvent(
      Object.assign(new Event("keydown", { cancelable: true }), {
        altKey: false, code: "Enter", ctrlKey: false, isComposing: false, key: "Enter", metaKey: false,
        repeat: false, shiftKey: false,
      }),
    );
    worker.reply({ data: new Uint8Array([1]).buffer, id: 32, name: "a.png", op: "download", type: "fileRequest" });
    expect(saved).toEqual([{ href: "blob:frameos-test", name: "a.png" }]);
  });

  it("saves a file under a name the page cleaned, which is the name its button shows", () => {
    expect(safeFileName("photos/2026/beach.jpg")).toBe("beach.jpg");
    expect(safeFileName("..\\..\\boot.ini")).toBe("boot.ini");
    expect(safeFileName(".bashrc")).toBe("bashrc");
    expect(safeFileName("  ..  ")).toBe("file");
    expect(safeFileName("")).toBe("file");
    expect(safeFileName(42)).toBe("file");
    // A right-to-left override would show this as "invoice-exe.pdf".
    expect(safeFileName("invoice-\u202efdp.exe")).toBe("invoice-fdp.exe");
    expect(safeFileName("a\u0000b\r\nc<d>:e|f?g*.txt")).toBe("abc_d__e_f_g_.txt");
    expect(safeFileName("report.pdf. . ")).toBe("report.pdf");
    const long = safeFileName(`${"x".repeat(300)}.jpeg`);
    expect(long).toHaveLength(120);
    expect(long.endsWith(".jpeg")).toBe(true);

    const asked: Array<PreviewFileRequest | null> = [];
    const { preview, worker } = makePreview({ onFileRequest: (request) => asked.push(request) });
    worker.reply({
      data: new Uint8Array([1]).buffer, id: 41, name: "../../.hidden/\u202egnp.scr", op: "download", type: "fileRequest",
    });
    expect(asked).toEqual([{ id: 41, name: "gnp.scr", op: "download" }]);
    preview.answerFileRequest();
    expect(saved).toEqual([{ href: "blob:frameos-test", name: "gnp.scr" }]);
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
