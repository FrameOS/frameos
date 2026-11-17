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

/**
 * Whose the keyboard is: the page's (the browser keeps the shortcuts it
 * reserves, Cmd+W and the like), offered (a Super key was pressed: the page
 * shows the offer of full screen), or the frame's (full screen, every key the
 * operating system lets a browser have).
 */
export type PlaygroundKeyboard = "page" | "offered" | "frame";

/** The Keyboard Lock API (Chromium): `navigator.keyboard`. */
export interface KeyboardLock {
  lock(keyCodes?: string[]): Promise<void>;
  unlock(): void;
}

/** What the playground asks of the page for the keyboard: its full screen and the lock. */
export interface PlaygroundPage {
  /** Full screen for the whole page, asked from a press (a user's gesture). */
  enterFullscreen(): Promise<void>;
  isFullscreen(): boolean;
  /** Listen for full screen coming and going; returns the detach. */
  onFullscreenChange(listener: () => void): () => void;
  /** Null where the browser has no Keyboard Lock (Firefox, Safari): no offer there. */
  keyboard: KeyboardLock | null;
}

export interface PlaygroundOptions {
  canvas: HTMLCanvasElement;
  /** The viewport, read at start and on every resize. */
  viewport: () => { width: number; height: number };
  onStatus: (status: PlaygroundStatus) => void;
  /** Whose the keyboard is now (`PlaygroundKeyboard`). */
  onKeyboard?: (keyboard: PlaygroundKeyboard) => void;
  fetchScenes?: () => Promise<FrameOSScene[]>;
  createPreview?: typeof createFrameOSPreview;
  /** The page's full screen and keyboard lock: the browser's by default, null for none. */
  page?: PlaygroundPage | null;
  /** The store the Scene store browses: the page's own origin by default. */
  storeUrl?: string | undefined;
}

export interface Playground {
  /** Fit the frame to the viewport again (a resize of the window). */
  resize(): void;
  /** Full screen with every key the frame's: from a press on the offer. */
  captureKeyboard(): Promise<void>;
  /** The offer turned down: not made again until the page is loaded again. */
  declineKeyboard(): void;
  destroy(): void;
}

function browserPage(): PlaygroundPage | null {
  if (typeof document === "undefined" || typeof navigator === "undefined") {
    return null;
  }
  const keyboard = (navigator as Navigator & { keyboard?: Partial<KeyboardLock> }).keyboard;
  return {
    enterFullscreen: () => document.documentElement.requestFullscreen({ navigationUI: "hide" }),
    isFullscreen: () => document.fullscreenElement !== null,
    onFullscreenChange: (listener) => {
      document.addEventListener("fullscreenchange", listener);
      return () => document.removeEventListener("fullscreenchange", listener);
    },
    keyboard:
      keyboard && typeof keyboard.lock === "function" && typeof keyboard.unlock === "function"
        ? (keyboard as KeyboardLock)
        : null,
  };
}

// A Super chord: Cmd on a Mac, the Windows key elsewhere, or that key alone.
const superKey = (event: KeyboardEvent) => event.metaKey || event.key === "Meta" || event.key === "OS";

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

  // The keyboard. While the frame has the focus every key is its: the
  // browser's default for it never runs, so Cmd+L, Cmd+F or Cmd+1 reach a
  // desktop's Super bindings instead of the address bar, the find bar or a
  // tab. What the browser reserves (Cmd+W, Cmd+T, Cmd+N, Cmd+Q) only the
  // Keyboard Lock API takes, and only in full screen the page asked for, so
  // the first Super key offers that; holding Esc leaves it. What the
  // operating system keeps (Cmd+Space, Cmd+Tab on a Mac) no page gets.
  const page = options.page === undefined ? browserPage() : options.page;
  let keyboard: PlaygroundKeyboard = "page";
  let declined = false;
  const setKeyboard = (next: PlaygroundKeyboard) => {
    if (next !== keyboard) {
      keyboard = next;
      options.onKeyboard?.(next);
    }
  };
  const onKey = (event: KeyboardEvent) => {
    event.preventDefault();
    if (event.type === "keydown" && keyboard === "page" && !declined && page?.keyboard && superKey(event)) {
      setKeyboard("offered");
    }
  };
  options.canvas.addEventListener("keydown", onKey);
  options.canvas.addEventListener("keyup", onKey);
  const detachFullscreen = page
    ? page.onFullscreenChange(() => {
        if (!page.isFullscreen()) {
          page.keyboard?.unlock();
          setKeyboard("page");
        }
      })
    : () => {};

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
    async captureKeyboard() {
      if (!page) {
        return;
      }
      try {
        if (!page.isFullscreen()) {
          await page.enterFullscreen();
        }
        // Chromium asks the visitor first; a no leaves the page's keyboard.
        await page.keyboard?.lock();
        setKeyboard(page.keyboard ? "frame" : "page");
      } catch {
        setKeyboard("page");
      } finally {
        options.canvas.focus();
      }
    },
    declineKeyboard() {
      declined = true;
      setKeyboard("page");
      options.canvas.focus();
    },
    destroy() {
      destroyed = true;
      stop();
      options.canvas.removeEventListener("keydown", onKey);
      options.canvas.removeEventListener("keyup", onKey);
      detachFullscreen();
    },
  };
}
