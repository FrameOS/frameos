// @vitest-environment jsdom
//
// The frame chat's render check used to keep what the scene logged and throw
// away what it drew, so a reply that said "I rendered it at 1200x1600" showed
// no picture. It now keeps the newest frame as a PNG (flattened onto white),
// which the chat shows under the reply and saves as the scene's image.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../../../frontend/src/scenes/frame/panels/Scenes/scenesLogic", () => ({
  collectScenePreviewPayloadScenes: (scene: unknown) => [scene],
}));
vi.mock("../../../../../../frontend/src/models/wasmPreviewModel", () => ({
  fetchSettingsJson: async () => "{}",
  previewProxyUrl: async () => null,
}));

import { renderSceneCheck } from "../../../../../../frontend/src/utils/wasmSceneRenderCheck";

type Message = Record<string, unknown>;
const workers: FakeWorker[] = [];

class FakeWorker {
  onmessage: ((event: { data: Message }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  init: Message | null = null;
  terminated = false;

  constructor() {
    workers.push(this);
  }

  postMessage(message: Message) {
    this.init = message;
  }

  terminate() {
    this.terminated = true;
  }

  send(data: Message) {
    this.onmessage?.({ data });
  }
}

function rgba(width: number, height: number, value: number): ArrayBuffer {
  return new Uint8Array(width * height * 4).fill(value).buffer;
}

const drawn: { putImageData: unknown[]; fillStyle: string[] } = { fillStyle: [], putImageData: [] };

beforeEach(() => {
  vi.useFakeTimers();
  workers.length = 0;
  drawn.fillStyle = [];
  drawn.putImageData = [];
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal(
    "ImageData",
    class {
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number,
      ) {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function getContext() {
    const context = {
      drawImage: () => {},
      fillRect: () => {},
      putImageData: (image: { data: Uint8ClampedArray }) => drawn.putImageData.push(image.data[0]),
      set fillStyle(value: string) {
        drawn.fillStyle.push(value);
      },
    };
    return context as unknown as CanvasRenderingContext2D;
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function toBlob(callback: BlobCallback) {
    callback(new Blob(["png"], { type: "image/png" }));
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const scene = { edges: [], id: "clock", name: "Clock", nodes: [] };

describe("renderSceneCheck", () => {
  it("keeps the newest frame it drew as a PNG on white, at the size it drew", async () => {
    const result = renderSceneCheck({ id: 1, width: 4, height: 2 }, [scene] as never, "clock");
    await vi.waitFor(() => expect(workers[0]?.init).toBeTruthy());
    expect(workers[0]!.init).toMatchObject({ height: 2, type: "init", width: 4 });
    // A data app draws a placeholder first; the second frame is the answer.
    workers[0]!.send({ buffer: rgba(4, 2, 1), height: 2, renderMs: 5, type: "frame", width: 4 });
    workers[0]!.send({ buffer: rgba(4, 2, 7), height: 2, renderMs: 6, type: "frame", width: 4 });
    await vi.advanceTimersByTimeAsync(2000);
    const check = await result;

    expect(check.rendered).toBe(true);
    expect(check.image).toMatchObject({ height: 2, width: 4 });
    expect(check.image!.blob.type).toBe("image/png");
    expect(drawn.putImageData).toEqual([7]);
    expect(drawn.fillStyle).toEqual(["#ffffff"]);
    expect(workers[0]!.terminated).toBe(true);
  });

  it("has no image when nothing was drawn", async () => {
    const result = renderSceneCheck({ id: 1, width: 4, height: 2 }, [scene] as never, "clock");
    await vi.waitFor(() => expect(workers[0]?.init).toBeTruthy());
    workers[0]!.send({ message: "Error rendering scene", type: "error" });
    const check = await result;
    expect(check.rendered).toBe(false);
    expect(check.image).toBeNull();
  });
});
