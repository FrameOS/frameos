import { Buffer } from "node:buffer";
import { chromium, type Browser, type BrowserContext } from "playwright";

// Node-side headless render check for FrameOS scenes, used by the AI evals.
//
// The browser already does this (frontend/src/utils/wasmSceneRenderCheck.ts):
// run the scene once in the frameos-wasm preview worker — the same runtime the
// device runs — and collect what it logs. Here the "browser" is a headless
// Chromium driven by Playwright, pointed at the cloud dev server, which serves
// the worker (public/frameos-wasm/preview-worker.js + frameos.js/.wasm next to
// it) and the same-origin HTTP proxy the runtime's data apps fetch through.
//
// One Chromium is reused across many render() calls; every render gets a
// fresh page (and so a fresh Worker), so no state ever leaks between scenes.
//
// This file is imported by plain Node (tsx) as well as vitest: keep it free of
// Next imports.

export type HeadlessRenderResult = {
  /** At least one frame was produced (errors may still have been logged). */
  rendered: boolean;
  renderMs: number | null;
  /** Log lines the runtime flagged as errors (logError, render failures). */
  errors: string[];
  /** All collected log lines, errors included, oldest first. */
  logs: string[];
  /** The last frame the runtime produced, PNG-encoded; null when none. */
  png: Buffer | null;
  width: number;
  height: number;
  /** Cheap content statistics of the last frame, for "is it blank" checks. */
  pixelStats: PixelStats | null;
};

export type PixelStats = {
  /** Distinct colours after quantising to 4 bits per channel, on a sample grid. */
  distinctColors: number;
  /** Fraction of sampled pixels that differ noticeably from the dominant colour. */
  inkFraction: number;
  /** Mean luminance 0..1 of the sample. */
  meanLuminance: number;
};

export type HeadlessRendererLaunchOptions = {
  /** Origin of the cloud dev server; defaults to http://localhost:3000. */
  cloudUrl?: string;
  headless?: boolean;
};

export type HeadlessRenderOptions = {
  /** The scenes to load — the parsed contents of a scenes.json. */
  scenes: unknown[];
  /** Scene to select; defaults to the runtime's default scene. */
  sceneId?: string;
  width: number;
  height: number;
  /** Frame settings (app API keys etc.); most scenes run fine without. */
  settings?: Record<string, unknown>;
  /** IANA time zone for the simulated frame; defaults to the host's. */
  timeZone?: string;
  /** Give up on the first frame after this long; default 45s. */
  timeoutMs?: number;
  /** After the first frame, keep collecting async re-renders and their
   * logs for this long before finishing; default 2.5s. */
  settleMs?: number;
};

export const DEFAULT_CLOUD_URL = "http://localhost:3000";
export const DEFAULT_RENDER_TIMEOUT_MS = 45_000;
export const DEFAULT_SETTLE_MS = 2_500;

const WORKER_PATH = "/frameos-wasm/preview-worker.js";
const PROXY_PATH = "/api/store/preview-proxy";
// Any lightweight same-origin page that yields a normal HTML document; the
// worker only needs an origin, the page's own content is irrelevant.
const HOST_PAGE_PATH = "/legal/imprint";
const MAX_COLLECTED_LOGS = 100;
const MAX_COLLECTED_ERRORS = 20;

/**
 * Classifies one runtime log line as an error. Mirrors the in-browser check:
 * a JSON payload counts when its `event` starts with "error" or it carries an
 * `error` key; a plain-text line counts when it mentions the word "error".
 */
export function isRenderError(line: string): boolean {
  try {
    const payload: unknown = JSON.parse(line);
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const record = payload as Record<string, unknown>;
      const event = typeof record.event === "string" ? record.event : "";
      return event.startsWith("error") || "error" in record;
    }
  } catch {
    // plain-text log line (http hook failures etc.)
  }
  return /\berror\b/i.test(line);
}

type InPageArgs = {
  workerPath: string;
  proxyUrl: string;
  width: number;
  height: number;
  timeZone: string;
  scenesJson: string;
  settingsJson: string;
  sceneId: string;
  timeoutMs: number;
  settleMs: number;
  maxLogs: number;
  maxErrors: number;
};

type InPageResult = {
  rendered: boolean;
  renderMs: number | null;
  errors: string[];
  logs: string[];
  pngDataUrl: string | null;
  width: number;
  height: number;
  pixelStats: PixelStats | null;
};

// Runs inside the page (serialised by Playwright, so it must be
// self-contained: no closures over module scope, no imports). Mirrors
// frontend/src/utils/wasmSceneRenderCheck.ts and paints the last frame the
// worker produced onto a canvas so we can hand back a PNG.
async function runRenderCheckInPage(args: InPageArgs): Promise<InPageResult> {
  const errors: string[] = [];
  const logs: string[] = [];
  let rendered = false;
  let renderMs: number | null = null;
  let lastFrame: { width: number; height: number; buffer: ArrayBuffer } | null =
    null;

  const pushCapped = (list: string[], entry: string, cap: number): void => {
    list.push(entry);
    if (list.length > cap) {
      list.splice(0, list.length - cap);
    }
  };
  const isError = (line: string): boolean => {
    try {
      const payload = JSON.parse(line);
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const event = typeof payload.event === "string" ? payload.event : "";
        return event.startsWith("error") || "error" in payload;
      }
    } catch {
      // plain text
    }
    return /\berror\b/i.test(line);
  };

  const worker = new Worker(args.workerPath, { type: "module" });
  await new Promise<void>((resolve) => {
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    const finish = (): void => {
      if (done) {
        return;
      }
      done = true;
      if (settleTimer !== null) {
        clearTimeout(settleTimer);
      }
      clearTimeout(timeoutTimer);
      worker.terminate();
      resolve();
    };
    const timeoutTimer = setTimeout(() => {
      if (!rendered) {
        pushCapped(
          errors,
          `Render check timed out: the scene produced no frame within ${Math.round(args.timeoutMs / 1000)}s`,
          args.maxErrors,
        );
      }
      finish();
    }, args.timeoutMs);
    worker.onerror = (event: ErrorEvent) => {
      pushCapped(
        errors,
        event.message || "Preview worker failed to load",
        args.maxErrors,
      );
      if (!rendered) {
        finish();
      }
    };
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data || {};
      if (msg.type === "frame") {
        const firstFrame = !rendered;
        rendered = true;
        renderMs = typeof msg.renderMs === "number" ? msg.renderMs : renderMs;
        if (msg.buffer instanceof ArrayBuffer && msg.buffer.byteLength > 0) {
          lastFrame = { width: msg.width, height: msg.height, buffer: msg.buffer };
        }
        if (firstFrame) {
          // Let immediate re-renders and async data apps settle so their
          // errors (and their pixels) are collected too.
          settleTimer = setTimeout(finish, args.settleMs);
        }
      } else if (msg.type === "log" && typeof msg.message === "string") {
        pushCapped(logs, msg.message, args.maxLogs);
        if (isError(msg.message)) {
          pushCapped(errors, msg.message, args.maxErrors);
        }
      } else if (msg.type === "error") {
        pushCapped(errors, String(msg.message ?? "Render failed"), args.maxErrors);
        if (!rendered) {
          finish();
        }
      }
    };
    worker.postMessage({
      type: "init",
      width: args.width,
      height: args.height,
      name: "render check",
      timeZone: args.timeZone,
      scenesJson: args.scenesJson,
      settingsJson: args.settingsJson,
      proxyUrl: args.proxyUrl,
      sceneId: args.sceneId,
    });
  });

  let pngDataUrl: string | null = null;
  let pixelStats: PixelStats | null = null;
  let width = args.width;
  let height = args.height;
  const frame = lastFrame as { width: number; height: number; buffer: ArrayBuffer } | null;
  if (frame) {
    width = frame.width;
    height = frame.height;
    try {
      // Sample ~10k pixels on a grid: enough to tell a blank frame from a
      // drawn one without touching every byte.
      const bytes = new Uint8Array(frame.buffer);
      const step = Math.max(1, Math.floor(Math.sqrt((frame.width * frame.height) / 10_000)));
      const counts = new Map<number, number>();
      let samples = 0;
      let luminance = 0;
      for (let y = 0; y < frame.height; y += step) {
        for (let x = 0; x < frame.width; x += step) {
          const offset = (y * frame.width + x) * 4;
          const r = bytes[offset] ?? 0;
          const g = bytes[offset + 1] ?? 0;
          const b = bytes[offset + 2] ?? 0;
          const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
          counts.set(key, (counts.get(key) ?? 0) + 1);
          luminance += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
          samples += 1;
        }
      }
      let dominant = 0;
      for (const count of counts.values()) {
        dominant = Math.max(dominant, count);
      }
      pixelStats = {
        distinctColors: counts.size,
        inkFraction: samples > 0 ? 1 - dominant / samples : 0,
        meanLuminance: samples > 0 ? luminance / samples : 0,
      };
    } catch {
      pixelStats = null;
    }
    try {
      const canvas = document.createElement("canvas");
      canvas.width = frame.width;
      canvas.height = frame.height;
      const context = canvas.getContext("2d");
      if (context) {
        context.putImageData(
          new ImageData(new Uint8ClampedArray(frame.buffer), frame.width, frame.height),
          0,
          0,
        );
        pngDataUrl = canvas.toDataURL("image/png");
      }
    } catch (error) {
      pushCapped(errors, `Failed to encode frame as PNG: ${String(error)}`, args.maxErrors);
    }
  }
  return { rendered, renderMs, errors, logs, pngDataUrl, width, height, pixelStats };
}

export class HeadlessRenderer {
  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    readonly cloudUrl: string,
  ) {}

  static async launch(
    opts: HeadlessRendererLaunchOptions = {},
  ): Promise<HeadlessRenderer> {
    const cloudUrl = (opts.cloudUrl ?? DEFAULT_CLOUD_URL).replace(/\/+$/, "");
    const browser = await chromium.launch({ headless: opts.headless ?? true });
    const context = await browser.newContext();
    // tsx (esbuild with keepNames) rewrites the inner closures of
    // runRenderCheckInPage into `__name(fn, "fn")` calls, and Playwright
    // serialises that source verbatim into the page, where no `__name`
    // exists. Give every page an identity helper first. Kept as a string so
    // esbuild leaves this one alone.
    await context.addInitScript(
      "globalThis.__name = globalThis.__name || ((target) => target);",
    );
    // The host page carries the site's analytics; eval renders are not
    // visits, so keep them out of PostHog.
    await context.route(/https?:\/\/[^/]*posthog\.com\//, (route) =>
      route.abort(),
    );
    return new HeadlessRenderer(browser, context, cloudUrl);
  }

  /**
   * Renders the scene once in a fresh page and resolves with the collected
   * logs plus the last frame as PNG. Never rejects on scene failures: a
   * crashed or hung worker resolves as `rendered: false` with the failure in
   * `errors`. Only a broken harness (unreachable dev server, dead browser)
   * rejects.
   */
  async render(opts: HeadlessRenderOptions): Promise<HeadlessRenderResult> {
    // The dev server hot-reloads the host page when source files change
    // (an engineer editing while evals run), which destroys the evaluate
    // context mid-render. That is a harness hiccup, not a scene failure.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.renderOnce(opts);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt < 2 && /Execution context was destroyed|Target (page|context) .* closed|navigation/i.test(message)) {
          continue;
        }
        throw error;
      }
    }
  }

  private async renderOnce(opts: HeadlessRenderOptions): Promise<HeadlessRenderResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
    const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
    const timeZone =
      opts.timeZone ||
      Intl.DateTimeFormat().resolvedOptions().timeZone ||
      "UTC";

    const page = await this.context.newPage();
    // Page-level diagnostics: only surfaced when the worker never produced a
    // frame, so a module-load failure or an uncaught error in the worker
    // shows up next to the timeout instead of vanishing.
    const pageMessages: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        pageMessages.push(`[console.${message.type()}] ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => {
      pageMessages.push(`[pageerror] ${error.message}`);
    });
    try {
      await page.goto(`${this.cloudUrl}${HOST_PAGE_PATH}`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      const args: InPageArgs = {
        workerPath: WORKER_PATH,
        proxyUrl: PROXY_PATH,
        width: opts.width,
        height: opts.height,
        timeZone,
        scenesJson: JSON.stringify(opts.scenes),
        settingsJson: JSON.stringify(opts.settings ?? {}),
        sceneId: opts.sceneId ?? "",
        timeoutMs,
        settleMs,
        maxLogs: MAX_COLLECTED_LOGS,
        maxErrors: MAX_COLLECTED_ERRORS,
      };
      // The in-page timeout is the real one; the outer guard only covers a
      // wedged page (the evaluate itself never resolving).
      let guard: ReturnType<typeof setTimeout> | null = null;
      const guardPromise = new Promise<InPageResult>((resolve) => {
        guard = setTimeout(
          () =>
            resolve({
              rendered: false,
              renderMs: null,
              errors: [`Render check hung: the page did not answer within ${Math.round((timeoutMs + settleMs + 10_000) / 1000)}s`],
              logs: [],
              pngDataUrl: null,
              width: opts.width,
              height: opts.height,
              pixelStats: null,
            }),
          timeoutMs + settleMs + 10_000,
        );
      });
      const result = await Promise.race([
        page.evaluate(runRenderCheckInPage, args),
        guardPromise,
      ]);
      if (guard !== null) {
        clearTimeout(guard);
      }
      const errors = [...result.errors];
      if (!result.rendered) {
        for (const line of pageMessages) {
          errors.push(line);
        }
      }
      return {
        rendered: result.rendered,
        renderMs: result.renderMs,
        errors,
        logs: result.logs,
        png: dataUrlToPng(result.pngDataUrl),
        width: result.width,
        height: result.height,
        pixelStats: result.pixelStats,
      };
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
  }
}

function dataUrlToPng(dataUrl: string | null): Buffer | null {
  if (!dataUrl) {
    return null;
  }
  const prefix = "data:image/png;base64,";
  if (!dataUrl.startsWith(prefix)) {
    return null;
  }
  return Buffer.from(dataUrl.slice(prefix.length), "base64");
}
