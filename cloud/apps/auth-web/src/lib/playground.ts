// The playground (cloud/docs/playground.md): a frame in the browser, the
// size of the window. The repo's scenes run side by side in the Windows 98
// desktop, the Control Panel is the frame's own page, and the Scene store
// browses and previews from this origin. Everything here is the wasm runtime
// the cloud ships (public/frameos-wasm, the release pinned in versions.json).
import { createFrameOSPreview, type FrameOSPreview, type FrameOSScene } from "frameos-wasm";

export const playgroundScenesUrl = "/playground-assets/scenes.json";
export const playgroundWorkerUrl = "/frameos-wasm/preview-worker.js";
export const playgroundProxyUrl = "/api/store/preview-proxy";
export const playgroundLayoutId = "layout-windows-98";

// A huge window renders at this size at most and is stretched by the browser:
// every pixel is the runtime's work, on every frame of every window.
export const maxPlaygroundWidth = 2560;
export const maxPlaygroundHeight = 1600;

export type PlaygroundStatus =
  | { kind: "loading" }
  | { kind: "running" }
  | { kind: "error"; message: string };

export function playgroundSize(width: number, height: number) {
  return {
    height: Math.max(240, Math.min(maxPlaygroundHeight, Math.round(height))),
    width: Math.max(320, Math.min(maxPlaygroundWidth, Math.round(width))),
  };
}

export interface PlaygroundOptions {
  canvas: HTMLCanvasElement;
  /** The viewport, read at start and on every resize. */
  viewport: () => { width: number; height: number };
  onStatus: (status: PlaygroundStatus) => void;
  fetchScenes?: () => Promise<FrameOSScene[]>;
  createPreview?: typeof createFrameOSPreview;
  /** The store the Scene store browses: the page's own origin by default. */
  storeUrl?: string | undefined;
}

export interface Playground {
  /** Fit the frame to the viewport again (a resize of the window). */
  resize(): void;
  destroy(): void;
}

async function fetchPlaygroundScenes(): Promise<FrameOSScene[]> {
  const response = await fetch(playgroundScenesUrl);
  if (!response.ok) {
    throw new Error(`could not load the scenes (${response.status})`);
  }
  return (await response.json()) as FrameOSScene[];
}

export function startPlayground(options: PlaygroundOptions): Playground {
  const create = options.createPreview ?? createFrameOSPreview;
  const storeUrl = options.storeUrl ?? window.location.origin;
  let scenes: FrameOSScene[] | null = null;
  let preview: FrameOSPreview | null = null;
  let detachInput: Array<() => void> = [];
  let size = playgroundSize(options.viewport().width, options.viewport().height);
  let destroyed = false;
  let renderScale = 0;

  // The keyboard is the frame's while it has the focus: the browser's default
  // for a key never runs, so Cmd+L, Cmd+F or Cmd+1 reach a desktop's Super
  // bindings instead of the address bar, the find bar or a tab. What the
  // browser reserves (Cmd+W, Cmd+T, Cmd+Q) it keeps: a desktop that binds Super
  // takes Ctrl too (Omarchy's "Super key"), which no Mac browser binds.
  const onKey = (event: KeyboardEvent) => event.preventDefault();
  options.canvas.addEventListener("keydown", onKey);
  options.canvas.addEventListener("keyup", onKey);

  const stop = () => {
    for (const detach of detachInput) {
      detach();
    }
    detachInput = [];
    preview?.destroy();
    preview = null;
  };

  // A frame's Restart and Reboot start the runtime again; so does a resize
  // on a bundle that cannot take one in place.
  const boot = () => {
    stop();
    if (destroyed || !scenes) {
      return;
    }
    options.onStatus({ kind: "loading" });
    options.canvas.width = size.width;
    options.canvas.height = size.height;
    let firstFrame = true;
    const started = create({
      browserAssets: true,
      canvas: options.canvas,
      fastMode: true,
      framePage: true,
      height: size.height,
      name: "FrameOS playground",
      proxyUrl: playgroundProxyUrl,
      renderScale,
      sceneId: scenes[0]!.id,
      scenes,
      storeUrl,
      width: size.width,
      windowed: true,
      workerUrl: playgroundWorkerUrl,
      onReady: () => {
        started.chooseLayout(playgroundLayoutId);
      },
      onFrame: () => {
        if (firstFrame) {
          firstFrame = false;
          options.onStatus({ kind: "running" });
        }
      },
      onSceneEvent: (name, payload) => {
        if (name === "restart" || name === "reboot") {
          boot();
        } else if (name === "frameSettings" && typeof payload.renderScale === "number") {
          renderScale = payload.renderScale;
          started.setRenderScale(renderScale);
        }
      },
      onError: (message) => options.onStatus({ kind: "error", message }),
      onOutOfMemory: () =>
        options.onStatus({ kind: "error", message: "The frame ran out of memory. Reload the page to start it again." }),
    });
    preview = started;
    detachInput = [started.attachPointerInput(options.canvas), started.attachKeyboardInput(options.canvas)];
    options.canvas.focus();
  };

  void (options.fetchScenes ?? fetchPlaygroundScenes)()
    .then((loaded) => {
      if (loaded.length === 0) {
        throw new Error("there are no scenes to show");
      }
      scenes = loaded;
      boot();
    })
    .catch((error: unknown) => {
      if (!destroyed) {
        options.onStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
    });

  return {
    resize() {
      const next = playgroundSize(options.viewport().width, options.viewport().height);
      if (next.width === size.width && next.height === size.height) {
        return;
      }
      size = next;
      if (!preview) {
        return;
      }
      if (preview.runtimeInfo.resize) {
        // The windows and everything in them stay; the canvas takes the
        // next frame's size when it is painted.
        preview.resize(size.width, size.height);
      } else {
        boot();
      }
    },
    destroy() {
      destroyed = true;
      stop();
      options.canvas.removeEventListener("keydown", onKey);
      options.canvas.removeEventListener("keyup", onKey);
    },
  };
}
