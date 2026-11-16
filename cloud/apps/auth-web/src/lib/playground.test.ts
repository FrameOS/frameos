import { describe, expect, it, vi } from "vitest";
import type { FrameOSPreviewOptions } from "frameos-wasm";
import {
  excludedTemplates,
  leadingTemplates,
  playgroundLayoutId as bundledLayoutId,
  playgroundScenes,
} from "../../scripts/build-playground-scenes.mjs";
import {
  playgroundLayoutId,
  playgroundSize,
  startPlayground,
  type PlaygroundStatus,
} from "./playground";

// cloud/docs/playground.md. The runtime is the wasm bundle; here a fake
// preview records what the playground asks of it.

class FakePreview {
  runtimeInfo = { resize: true };
  calls: Array<[string, ...unknown[]]> = [];
  destroyed = false;
  constructor(readonly options: FrameOSPreviewOptions) {}
  chooseLayout(id: string) {
    this.calls.push(["chooseLayout", id]);
  }
  resize(width: number, height: number) {
    this.calls.push(["resize", width, height]);
  }
  setRenderScale(scale: number) {
    this.calls.push(["setRenderScale", scale]);
  }
  attachPointerInput() {
    return () => {};
  }
  attachKeyboardInput() {
    return () => {};
  }
  destroy() {
    this.destroyed = true;
  }
}

function start(viewport = { height: 900, width: 1440 }) {
  const previews: FakePreview[] = [];
  const statuses: PlaygroundStatus[] = [];
  const canvas = { focus: vi.fn(), height: 0, width: 0 } as unknown as HTMLCanvasElement;
  const size = { ...viewport };
  const playground = startPlayground({
    canvas,
    createPreview: ((options: FrameOSPreviewOptions) => {
      const preview = new FakePreview(options);
      previews.push(preview);
      return preview;
    }) as never,
    fetchScenes: async () => [{ id: "first" }, { id: playgroundLayoutId, settings: { isLayout: true } }],
    onStatus: (status) => statuses.push(status),
    origin: "https://playground.frameos.net",
    viewport: () => size,
  });
  return { canvas, playground, previews, size, statuses };
}

describe("the playground", () => {
  it("boots a desktop the size of the window, in Windows 98", async () => {
    const { canvas, previews, statuses } = start();
    await vi.waitFor(() => expect(previews).toHaveLength(1));
    const options = previews[0]!.options;
    expect(options).toMatchObject({
      fastMode: true,
      framePage: true,
      height: 900,
      proxyUrl: "/api/store/preview-proxy",
      sceneId: "first",
      storeUrl: "https://playground.frameos.net",
      width: 1440,
      windowed: true,
      workerUrl: "/frameos-wasm/preview-worker.js",
    });
    expect(canvas.width).toBe(1440);
    expect(canvas.focus).toHaveBeenCalled();
    options.onReady?.({} as never, null, {} as never);
    expect(previews[0]!.calls).toEqual([["chooseLayout", "layout-windows-98"]]);
    expect(statuses).toEqual([{ kind: "loading" }]);
    options.onFrame?.({ height: 900, renderMs: 1, width: 1440 });
    expect(statuses.at(-1)).toEqual({ kind: "running" });
  });

  it("follows the window in place, and starts again on Restart", async () => {
    const { playground, previews, size } = start();
    await vi.waitFor(() => expect(previews).toHaveLength(1));
    size.width = 1000;
    playground.resize();
    expect(previews[0]!.calls).toEqual([["resize", 1000, 900]]);

    previews[0]!.options.onSceneEvent?.("frameSettings", { renderScale: 2 });
    expect(previews[0]!.calls.at(-1)).toEqual(["setRenderScale", 2]);

    previews[0]!.options.onSceneEvent?.("restart", {});
    expect(previews[0]!.destroyed).toBe(true);
    expect(previews).toHaveLength(2);
    // The scale set on the frame page outlives the restart.
    expect(previews[1]!.options).toMatchObject({ renderScale: 2, width: 1000 });

    playground.destroy();
    expect(previews[1]!.destroyed).toBe(true);
  });

  it("starts again for a resize the runtime cannot take in place", async () => {
    const { playground, previews, size } = start();
    await vi.waitFor(() => expect(previews).toHaveLength(1));
    previews[0]!.runtimeInfo.resize = false;
    size.height = 700;
    playground.resize();
    expect(previews).toHaveLength(2);
    expect(previews[1]!.options.height).toBe(700);
  });

  it("caps what the runtime draws on a huge screen", () => {
    expect(playgroundSize(5120, 2880)).toEqual({ height: 1600, width: 2560 });
    expect(playgroundSize(100, 100)).toEqual({ height: 240, width: 320 });
  });
});

describe("the playground's scenes", () => {
  const scenes = playgroundScenes();

  it("open on the Welcome, with the store and the layout", () => {
    const names = scenes.map((scene) => scene.name);
    expect(names[0]).toBe("Welcome");
    expect(scenes[0]!.id).toBe("playground-welcome");
    expect(leadingTemplates).toContain("Scene store");
    expect(scenes.some((scene) => scene.id === "scene-store")).toBe(true);
    expect(bundledLayoutId).toBe(playgroundLayoutId);
    expect(scenes.some((scene) => scene.id === playgroundLayoutId)).toBe(true);
    expect(scenes.length).toBeGreaterThan(30);
  });

  it("hold every real-time and interactive sample", () => {
    const ids = new Set(scenes.map((scene) => scene.id));
    for (const id of [
      "kitchen-sink",
      "64a15e71-cc27-467b-a69b-c4c28bb77017", // Pixel toys
      "58257360-472f-45ef-9acd-05b4f2b8f067", // Color cycling
      "dvd-logo-bounce",
      "keyboard-test",
      "touch-test",
      "terminal-app",
      "form-showcase",
      "map",
      "now-playing",
      "to-do",
      "colors",
      "calculator",
      "home",
      "clock",
      "weather-demo",
      "steps",
      "gallery",
      "tap-counter",
      "theme-roles",
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
    for (const name of leadingTemplates) {
      expect(excludedTemplates.has(name), name).toBe(false);
    }
  });

  it("hold Files, under the id the desktops find it by", () => {
    // Renamed from "Asset browser" on 2026-11-16; its scene id stayed.
    const files = scenes.find((scene) => scene.id === "asset-browser");
    expect(files?.name).toBe("Files");
    expect(leadingTemplates).toContain("Files");
    expect(leadingTemplates).not.toContain("Asset browser");
  });

  it("leave out what needs a key or a Pi", () => {
    expect(excludedTemplates.has("OpenAI image")).toBe(true);
    expect(scenes.some((scene) => scene.id === "9f5a338b-0048-495a-a64f-e3190071ff51")).toBe(false);
  });
});
