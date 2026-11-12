import { Buffer } from "node:buffer";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { deflate } from "node:zlib";
import { zlibSync } from "fflate";
import { describeOutOfMemory, type DeviceLimits } from "frameos-wasm";
import { logWarn } from "./log";
import { panelPackerSource } from "./panel-pack";
import { addressIsPrivateSource } from "./private-address";

// Headless scene rendering on the server: the same frameos-wasm bundle the
// browser live preview runs (public/frameos-wasm, built with `node` in its
// emscripten ENVIRONMENT — the self-hosted backend's thin-client renderer
// drives it the same way, backend/tools/embedded_wasm_render.mjs). No
// Chromium, no Playwright: a worker thread loads the module, runs the
// scene once (plus a short settle for scenes that re-render themselves),
// hands back raw RGBA, and the main thread PNG-encodes it with fflate.
//
// Why a worker: the Nim/pixie pipeline is synchronous and so is the HTTP
// bridge scene apps fetch through (a sync XHR; here each request runs in a
// short-lived child Node, exactly as the backend's renderer does). Neither
// may sit on the server's event loop. Every render gets a fresh worker and
// a fresh module — nothing leaks between two accounts' scenes — and the
// pool below bounds how many 64 MB wasm heaps exist at once.

export type SceneRenderOptions = {
  /**
   * Render under a device's memory and run as it (esp32DeviceLimits): a
   * scene that would run that frame out of memory fails with
   * render_out_of_memory instead of drawing. Omitted renders with the
   * worker's own memory.
   */
  deviceLimits?: DeviceLimits | null | undefined;
  /**
   * What a frame rendered on the server relayed with its pull
   * (docs/server-rendering.md "Keys, touch and the schedule"): its key
   * edges and the events its own producers would have handed its scene,
   * each from its origin, every `atMs` on the board's clock. Delivered after
   * `events` and before the render (`frameos_wasm_device_input`), so the
   * dispatcher's origin rules, event maps and press timing decide.
   */
  deviceInput?: RelayedDeviceInput | undefined;
  /**
   * Compress the PNG on the thread pool instead of this thread. For a caller
   * whose event loop holds live sockets (the frame hub rendering a virtual
   * frame): a full-HD frame is a few hundred milliseconds of deflate.
   */
  encodeOffThread?: boolean | undefined;
  /**
   * Events a control plane sent the scene since its last render (a button, a
   * custom event), delivered before it draws. `origin` is the event
   * contract's (docs/events-contract.json); the runtime refuses what that
   * origin may not emit.
   */
  events?: { name: string; origin: string; payload?: unknown }[] | undefined;
  height: number;
  /**
   * The time the scene should believe it is, epoch ms: a picture drawn
   * ahead of a sleeping frame's wake shows the minute it wakes into
   * (docs/server-rendering.md). Shifts `Date.now` inside the worker, which is
   * the wasm runtime's only clock; the scene's HTTP (a child process each)
   * keeps the real one. Omitted renders at the real time.
   */
  nowMs?: number | undefined;
  /**
   * Pack the picture for a panel in the worker, where the pixels are, and
   * hand back the FOSB (`fosb` in the result) instead of the pixels: on a
   * 13.3" Spectra 6 panel the dither is a hundred milliseconds that would
   * otherwise be the event loop's (docs/server-rendering.md "Packing"). The
   * panel's native size, `fos_pixel_format_t` and rotation, and the frame's
   * `palette` colour list; the photo palette is the render's own. The
   * worker builds its packer from panel-pack.ts's text; when it cannot, the
   * result carries the RGBA instead, as `rawRgba` does, with `packError`.
   * Implies no PNG.
   */
  pack?: RenderPanelPack | undefined;
  /**
   * Hand back the raw RGBA (`rgba` in the result) and skip the PNG: a panel
   * is packed from the pixels (panel-pack.ts), and a full-size deflate it
   * never reads is a few hundred milliseconds of the event loop. `png` is
   * then empty.
   */
  rawRgba?: boolean | undefined;
  /**
   * The frame's own render scale (its `render_scale` setting, docs/jsx-ui.md
   * "Scale"): what a UI from a .tsx/.jsx app is laid out for. Omitted, null
   * or 0 leaves the runtime on automatic, worked out from width and height:
   * a render with no frame behind it, or a frame that never set one.
   */
  renderScale?: number | null | undefined;
  /**
   * Also hand back a small copy that fits a square of this many pixels
   * (`thumbnail` in the result), averaged down from the same pixels.
   */
  thumbnailMaxDimension?: number | undefined;
  /**
   * Who the render is for (an account id, or a client key for anonymous
   * callers). At most one render per owner runs at a time and only a
   * couple more may wait, so a single caller cannot hold every global slot.
   */
  owner?: string | undefined;
  /** Scene to select; defaults to the runtime's default scene. */
  sceneId?: string | undefined;
  scenes: unknown[];
  /** Frame settings the runtime reads (service keys etc.). */
  settings?: Record<string, unknown> | undefined;
  /**
   * The frame's own configuration the device's runtime is handed besides
   * its scenes (docs/server-rendering.md "Packing", "Keys, touch and the
   * schedule"): its event map (frame.json `eventMap`, the rules that run
   * whatever scene shows), its `palette` colour list and its `colors` block,
   * so the dispatcher and the automatic fit decide as on the device.
   * Omitted keys leave the runtime's defaults. Its panel too, for a render
   * for hardware: the format the fit aims at, the rotation a touch is turned
   * by.
   */
  frame?: RenderFrameConfig | undefined;
  /** Give up after this long, worker included; default 30 s. */
  timeoutMs?: number | undefined;
  /** IANA zone the simulated frame lives in; default UTC. */
  timeZone?: string | undefined;
  /** Seed per-scene state: { [sceneId]: state }. */
  states?: Record<string, unknown> | undefined;
  width: number;
};

/** A relayed pull's input, as the device sent it (server-render.ts readDeviceInput). */
export type RelayedDeviceInput = {
  edges: Record<string, unknown>[];
  events: { name: string; origin: string; payload: Record<string, unknown> }[];
  nowMs: number;
};

/** SceneRenderOptions.pack. */
export type RenderPanelPack = {
  format: number;
  height: number;
  /** The frame's `palette` colours, `["#rrggbb", …]` (panel-pack.ts panelPalette). */
  palette?: unknown;
  rotate: number;
  width: number;
};

/**
 * SceneRenderOptions.frame: what `frameos_wasm_set_frame` takes (every key
 * optional). `pixelFormat` is the panel's `fos_pixel_format_t`, which the
 * automatic fit aims at; `rotate` the frame's, by which a relayed touch's
 * panel position becomes the scene's point.
 */
export type RenderFrameConfig = {
  colors?: unknown;
  eventMap?: unknown;
  palette?: unknown;
  pixelFormat?: number;
  rotate?: number;
};

export type SceneRenderResult = {
  errors: string[];
  /** The panel's FOSB, packed in the worker, when the render asked for `pack` (and `rgba` is then absent). */
  fosb?: Buffer;
  height: number;
  logs: string[];
  /** Why a render that asked for `pack` came back with the RGBA instead. */
  packError?: string;
  /**
   * The photo palette the render drew with last (a colour profile's
   * `palette`, `["#rrggbb", …]`), which the panel's packer dithers to
   * (panel-pack.ts panelPalette). Absent when there was none, or the
   * runtime predates the report.
   */
  palette?: string[];
  /** Empty when the render asked for `rawRgba`. */
  png: Buffer;
  renderMs: number;
  /** The pixels, when the render asked for `rawRgba`. */
  rgba?: Uint8Array;
  /**
   * The scene the render ended on: the selected one, or the one an event
   * switched to. Absent when the runtime could not say.
   */
  sceneId?: string;
  /** The state of the scene the render ended on (what it changed). */
  state: unknown;
  /** PNG of the small copy, when `thumbnailMaxDimension` asked for one. */
  thumbnail?: Buffer;
  width: number;
};

export const defaultRenderTimeoutMs = 30_000;
export const maxRenderPixels = 8 * 1024 * 1024;
export const maxRenderDimension = 4096;
export const minRenderDimension = 16;
const maxConcurrentRenders = 2;
const maxQueuedRenders = 8;
// Per owner: one in flight, two waiting. The global queue is 8 deep and a
// render can take 30 s, so without this one account's burst (its own rate
// limit allows 60 per 15 min) would occupy both slots and the whole queue
// for minutes while everyone else got renderer_busy.
export const maxConcurrentRendersPerOwner = 1;
export const maxQueuedRendersPerOwner = 2;
// Renders one account may start per window, through any door: POST
// /api/scenes/render and the AI chat's render_scene share the bucket.
export const accountRenderRateLimit = { limit: 60, windowMs: 15 * 60 * 1000 };
const maxCollectedLogs = 200;
const settleMs = 1_500;

export class SceneRenderError extends Error {
  constructor(
    public readonly code:
      | "render_concurrency_limit"
      | "render_failed"
      | "render_out_of_memory"
      | "render_timeout"
      | "renderer_busy"
      | "renderer_unavailable",
    message: string,
    public readonly logs: string[] = [],
  ) {
    super(message);
  }
}

let wasmAssetsDirOverride: string | undefined;

/**
 * Where the runtime bundle is, for a process that is not auth-web: the frame
 * hub renders virtual frames with the bundle auth-web ships, from its own
 * working directory.
 */
export function setWasmAssetsDir(dir: string | undefined) {
  wasmAssetsDirOverride = dir;
}

export function wasmAssetsDir(): string {
  return (
    wasmAssetsDirOverride ??
    (process.env.FRAMEOS_WASM_DIR?.trim() || path.join(process.cwd(), "public", "frameos-wasm"))
  );
}

// The stamp build_wasm.sh writes next to the bundle and the release tarball
// carries (scripts/lib/wasm-runtime.mjs installs it with the runtime): which
// FrameOS version the interpreter is. Frames run their own firmware, so a
// render's caller can tell whether the two match. Null when the bundle is
// missing or predates the stamp.
export function rendererVersion(): string | null {
  const stampPath = path.join(wasmAssetsDir(), "version.json");
  if (!existsSync(stampPath)) {
    return null;
  }
  try {
    const stamp: unknown = JSON.parse(readFileSync(stampPath, "utf8"));
    if (stamp && typeof stamp === "object" && typeof (stamp as { version?: unknown }).version === "string") {
      return (stamp as { version: string }).version;
    }
  } catch {
    // unreadable stamp: same answer as no stamp
  }
  return null;
}

export function rendererAvailable(): boolean {
  const dir = wasmAssetsDir();
  return (
    existsSync(path.join(dir, "frameos.js")) &&
    existsSync(path.join(dir, "frameos.wasm"))
  );
}

// Same classification the in-browser render check uses: a JSON log whose
// event starts with "error" or carries an `error` key, or a plain line that
// mentions the word.
export function isRenderErrorLine(line: string): boolean {
  try {
    const payload: unknown = JSON.parse(line);
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const record = payload as Record<string, unknown>;
      const event = typeof record.event === "string" ? record.event : "";
      return event.startsWith("error") || "error" in record;
    }
  } catch {
    // plain text
  }
  return /\berror\b/i.test(line);
}

let running = 0;
const runningPerOwner = new Map<string, number>();
const waiting: { owner: string | undefined; resolve: () => void }[] = [];

function ownerRunning(owner: string | undefined) {
  return owner === undefined ? 0 : (runningPerOwner.get(owner) ?? 0);
}

function ownerWaiting(owner: string | undefined) {
  return owner === undefined
    ? 0
    : waiting.filter((entry) => entry.owner === owner).length;
}

function take(owner: string | undefined) {
  running += 1;
  if (owner !== undefined) {
    runningPerOwner.set(owner, ownerRunning(owner) + 1);
  }
}

// Hand a free slot to the first waiter whose owner is under its own cap.
// A waiter blocked by its owner's in-flight render is picked up when that
// render releases, so nothing is left waiting on a free slot forever.
function dispatch() {
  if (running >= maxConcurrentRenders) {
    return;
  }
  const index = waiting.findIndex(
    (entry) => ownerRunning(entry.owner) < maxConcurrentRendersPerOwner,
  );
  if (index === -1) {
    return;
  }
  const [next] = waiting.splice(index, 1);
  if (next) {
    take(next.owner);
    next.resolve();
  }
}

/** Exported for the queue tests; renderScenes is the only real caller. */
export async function acquireRenderSlot(
  owner?: string,
): Promise<() => void> {
  if (
    running < maxConcurrentRenders &&
    ownerRunning(owner) < maxConcurrentRendersPerOwner
  ) {
    take(owner);
  } else {
    if (owner !== undefined && ownerWaiting(owner) >= maxQueuedRendersPerOwner) {
      throw new SceneRenderError(
        "render_concurrency_limit",
        "You already have renders in flight; wait for them to finish.",
      );
    }
    if (waiting.length >= maxQueuedRenders) {
      throw new SceneRenderError(
        "renderer_busy",
        "Too many renders in flight; try again in a moment.",
      );
    }
    await new Promise<void>((resolve) => waiting.push({ owner, resolve }));
  }
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    running -= 1;
    if (owner !== undefined) {
      const left = ownerRunning(owner) - 1;
      if (left > 0) {
        runningPerOwner.set(owner, left);
      } else {
        runningPerOwner.delete(owner);
      }
    }
    dispatch();
  };
}

export function renderQueueStateForTests() {
  return {
    running,
    runningPerOwner: Object.fromEntries(runningPerOwner),
    waiting: waiting.map((entry) => entry.owner),
  };
}

export async function renderScenes(
  options: SceneRenderOptions,
): Promise<SceneRenderResult> {
  if (!rendererAvailable()) {
    throw new SceneRenderError(
      "renderer_unavailable",
      "The wasm runtime is not installed on this server.",
    );
  }
  const release = await acquireRenderSlot(options.owner);
  try {
    return await runWorker(options);
  } finally {
    release();
  }
}

type WorkerResult =
  | {
      // The RGBA, or the FOSB when `packed`.
      buffer: ArrayBuffer;
      height: number;
      logs: string[];
      ok: true;
      packError?: string;
      packed?: boolean;
      palette: string[] | null;
      renderMs: number;
      sceneId: string;
      state: unknown;
      width: number;
    }
  | {
      logs: string[];
      message: string;
      ok: false;
      outOfMemory?: { refusedBytes: number; usedBytes: number };
    };

function runWorker(options: SceneRenderOptions): Promise<SceneRenderResult> {
  const timeoutMs = options.timeoutMs ?? defaultRenderTimeoutMs;
  return new Promise<SceneRenderResult>((resolve, reject) => {
    const worker = new Worker(workerSourceText(), {
      eval: true,
      // No IDBFS, no assets: a plain MEMFS is all a preview needs.
      resourceLimits: { maxOldGenerationSizeMb: 512 },
      workerData: {
        assetsDir: wasmAssetsDir(),
        deviceInputJson: options.deviceInput ? JSON.stringify(options.deviceInput) : "",
        deviceLimits: options.deviceLimits ?? null,
        eventsJson: JSON.stringify(options.events ?? []),
        frameJson: JSON.stringify(options.frame ?? {}),
        height: options.height,
        maxLogs: maxCollectedLogs,
        nowMs: typeof options.nowMs === "number" && Number.isFinite(options.nowMs) ? options.nowMs : null,
        pack: options.pack ?? null,
        packerSource: options.pack ? panelPackerSource : "",
        renderScale: options.renderScale && options.renderScale > 0 ? options.renderScale : 0,
        sceneId: options.sceneId ?? "",
        scenesJson: JSON.stringify(options.scenes),
        settingsJson: JSON.stringify(options.settings ?? {}),
        settleMs,
        statesJson: JSON.stringify(options.states ?? {}),
        timeZone: options.timeZone || "UTC",
        width: options.width,
      },
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new SceneRenderError(
            "render_timeout",
            `The scene did not render within ${Math.round(timeoutMs / 1000)}s.`,
          ),
        ),
      );
    }, timeoutMs);
    worker.once("message", (result: WorkerResult) => {
      finish(() => {
        if (!result.ok) {
          reject(
            result.outOfMemory && options.deviceLimits
              ? new SceneRenderError(
                  "render_out_of_memory",
                  describeOutOfMemory(result.outOfMemory, options.deviceLimits),
                  result.logs,
                )
              : new SceneRenderError("render_failed", result.message, result.logs),
          );
          return;
        }
        const encodeFailed = (error: unknown) =>
          reject(
            new SceneRenderError(
              "render_failed",
              error instanceof Error ? error.message : String(error),
              result.logs,
            ),
          );
        const reported = {
          ...(result.palette && result.palette.length > 0 ? { palette: result.palette } : {}),
          ...(result.sceneId ? { sceneId: result.sceneId } : {}),
        };
        if (result.packed) {
          resolve({
            errors: result.logs.filter(isRenderErrorLine),
            fosb: Buffer.from(result.buffer),
            height: result.height,
            logs: result.logs,
            png: Buffer.alloc(0),
            renderMs: result.renderMs,
            ...reported,
            state: result.state,
            width: result.width,
          });
          return;
        }
        const rgba = new Uint8Array(result.buffer);
        if (options.rawRgba || options.pack) {
          resolve({
            errors: result.logs.filter(isRenderErrorLine),
            height: result.height,
            logs: result.logs,
            ...(result.packError ? { packError: result.packError } : {}),
            png: Buffer.alloc(0),
            renderMs: result.renderMs,
            rgba,
            ...reported,
            state: result.state,
            width: result.width,
          });
          return;
        }
        const done = (png: Buffer) => {
          const small =
            options.thumbnailMaxDimension && options.thumbnailMaxDimension > 0
              ? downscaleRgba(rgba, result.width, result.height, options.thumbnailMaxDimension)
              : undefined;
          resolve({
            errors: result.logs.filter(isRenderErrorLine),
            height: result.height,
            logs: result.logs,
            png,
            renderMs: result.renderMs,
            ...reported,
            state: result.state,
            ...(small ? { thumbnail: encodePng(small.rgba, small.width, small.height) } : {}),
            width: result.width,
          });
        };
        if (options.encodeOffThread) {
          encodePngOffThread(rgba, result.width, result.height).then(done, encodeFailed);
          return;
        }
        try {
          done(encodePng(rgba, result.width, result.height));
        } catch (error) {
          encodeFailed(error);
        }
      });
    });
    worker.once("error", (error) => {
      logWarn("scene_render.worker_error", { message: String(error) });
      finish(() =>
        reject(new SceneRenderError("render_failed", String(error))),
      );
    });
    worker.once("exit", (code) => {
      finish(() =>
        reject(
          new SceneRenderError(
            "render_failed",
            `The renderer exited early (code ${code}).`,
          ),
        ),
      );
    });
  });
}

// Minimal PNG writer: 8-bit RGBA, filter type 0 on every scanline, one
// IDAT. fflate already ships for the zip handling, so no native encoder is
// needed for a preview.
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

/**
 * The picture averaged down to fit a square of `maxDimension` pixels (never
 * up): each output pixel is the mean of the source pixels it covers. Returns
 * the input when it already fits.
 */
export function downscaleRgba(
  rgba: Uint8Array,
  width: number,
  height: number,
  maxDimension: number,
): { height: number; rgba: Uint8Array; width: number } {
  if (rgba.length !== width * height * 4) {
    throw new Error(
      `pixel buffer is ${rgba.length} bytes, expected ${width * height * 4}`,
    );
  }
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  if (scale >= 1) {
    return { height, rgba, width };
  }
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.round(height * scale));
  const sums = new Float64Array(outWidth * outHeight * 4);
  const counts = new Uint32Array(outWidth * outHeight);
  for (let y = 0; y < height; y += 1) {
    const outY = Math.min(outHeight - 1, Math.floor((y * outHeight) / height));
    for (let x = 0; x < width; x += 1) {
      const outX = Math.min(outWidth - 1, Math.floor((x * outWidth) / width));
      const source = (y * width + x) * 4;
      const target = outY * outWidth + outX;
      sums[target * 4] = (sums[target * 4] ?? 0) + (rgba[source] ?? 0);
      sums[target * 4 + 1] = (sums[target * 4 + 1] ?? 0) + (rgba[source + 1] ?? 0);
      sums[target * 4 + 2] = (sums[target * 4 + 2] ?? 0) + (rgba[source + 2] ?? 0);
      sums[target * 4 + 3] = (sums[target * 4 + 3] ?? 0) + (rgba[source + 3] ?? 0);
      counts[target] = (counts[target] ?? 0) + 1;
    }
  }
  const out = new Uint8Array(outWidth * outHeight * 4);
  for (let index = 0; index < counts.length; index += 1) {
    const count = counts[index] || 1;
    for (let channel = 0; channel < 4; channel += 1) {
      out[index * 4 + channel] = Math.round((sums[index * 4 + channel] ?? 0) / count);
    }
  }
  return { height: outHeight, rgba: out, width: outWidth };
}

// The scanlines as PNG wants them before compression: filter type 0 ahead of
// every row.
function pngScanlines(rgba: Uint8Array, width: number, height: number): Uint8Array {
  if (rgba.length !== width * height * 4) {
    throw new Error(
      `pixel buffer is ${rgba.length} bytes, expected ${width * height * 4}`,
    );
  }
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return raw;
}

function pngFile(width: number, height: number, compressed: Uint8Array): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", compressed),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

export function encodePng(
  rgba: Uint8Array,
  width: number,
  height: number,
): Buffer {
  return pngFile(width, height, zlibSync(pngScanlines(rgba, width, height), { level: 6 }));
}

/** encodePng with the deflate on the thread pool (SceneRenderOptions.encodeOffThread). */
export function encodePngOffThread(
  rgba: Uint8Array,
  width: number,
  height: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let raw: Uint8Array;
    try {
      raw = pngScanlines(rgba, width, height);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    deflate(raw, { level: 6 }, (error, compressed) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(pngFile(width, height, compressed));
    });
  });
}

// The worker body, as source: `eval: true` keeps it out of Next's bundler
// (frameos.js uses import.meta.url and createRequire, which the bundler
// would rewrite) and out of the standalone file tracer's blind spot.
// Built lazily so the child script below is defined by the time it is
// interpolated.
let workerSourceCache: string | undefined;
function workerSourceText(): string {
  workerSourceCache ??= String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const logs = [];
const pushLog = (line) => {
  if (logs.length < workerData.maxLogs) {
    logs.push(String(line));
  }
};

// Synchronous HTTP for the runtime's XHR bridge: one short-lived child Node
// per request so the wait blocks this worker only. Private, loopback,
// link-local and metadata addresses are refused after resolution, the same
// guard the preview proxy applies for the browser.
const FETCH_CHILD = ${JSON.stringify(fetchChildScript)};
const MAX_REQUESTS = 24;
let requests = 0;
class SyncXMLHttpRequest {
  open(method, url) {
    this._method = method;
    this._url = url;
    this._headers = {};
    this.status = 0;
    this.response = null;
    this.responseText = "";
  }
  setRequestHeader(name, value) {
    this._headers[name] = value;
  }
  send(body) {
    requests += 1;
    if (requests > MAX_REQUESTS) {
      throw new Error("too many HTTP requests for one preview");
    }
    const request = {
      method: this._method,
      url: this._url,
      headers: this._headers,
      timeoutMs: Math.min(this.timeout || 15000, 15000),
      bodyBase64: body ? Buffer.from(body).toString("base64") : "",
    };
    const child = spawnSync(process.execPath, ["-e", FETCH_CHILD], {
      input: JSON.stringify(request),
      maxBuffer: 16 * 1024 * 1024,
      timeout: request.timeoutMs + 5000,
    });
    if (child.status !== 0 || !child.stdout) {
      throw new Error("fetch failed: " + (child.stderr || child.status));
    }
    const result = JSON.parse(child.stdout.toString("utf-8"));
    if (result.status === 0) {
      throw new Error(result.error || "request failed");
    }
    this.status = result.status;
    const bytes = Buffer.from(result.bodyBase64 || "", "base64");
    if (this.responseType === "arraybuffer") {
      this.response = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    } else {
      this.responseText = bytes.toString("utf-8");
      this.response = this.responseText;
    }
  }
}
globalThis.XMLHttpRequest = SyncXMLHttpRequest;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// A render "as of" another time (SceneRenderOptions.nowMs): the runtime reads
// the wall clock through Date.now (emscripten_date_now), so moving that moves
// the scene's clock and nothing outside this worker. Set before the module
// loads; the clock still runs from there.
if (typeof workerData.nowMs === "number") {
  const realNow = Date.now.bind(Date);
  const offset = workerData.nowMs - realNow();
  Date.now = () => realNow() + offset;
}

async function main() {
  const wasmBinary = readFileSync(join(workerData.assetsDir, "frameos.wasm"));
  const { default: createFrameOS } = await import(
    pathToFileURL(join(workerData.assetsDir, "frameos.js")).href
  );
  const Module = await createFrameOS({
    wasmBinary,
    print: pushLog,
    printErr: pushLog,
    onFrameosLog: pushLog,
  });
  const call = (name, ret, argTypes, args) => Module.ccall(name, ret, argTypes, args);
  const lastError = () => {
    try {
      return call("frameos_wasm_last_error", "string", [], []);
    } catch (error) {
      return String(error);
    }
  };
  const fail = (message) => {
    parentPort.postMessage({ ok: false, message, logs });
  };

  const started = Date.now();
  const ok = call(
    "frameos_wasm_init",
    "boolean",
    ["number", "number", "string", "string", "string"],
    [workerData.width, workerData.height, "preview", workerData.timeZone, workerData.settingsJson],
  );
  if (!ok) {
    return fail("init failed: " + lastError());
  }
  // A device's memory ceiling, set after init like the preview worker does:
  // module startup lives in a frame's flash, not in its render budget.
  const limits = workerData.deviceLimits;
  if (limits) {
    try {
      call("frameos_wasm_set_memory_limit", null, ["number", "number"], [
        Math.max(0, Math.floor(limits.memoryBytes || 0)),
        Math.max(0, Math.floor(limits.memoryReserveBytes || 0)),
      ]);
      if (limits.embedded) {
        call("frameos_wasm_set_embedded", null, ["boolean"], [true]);
      }
    } catch (error) {
      pushLog("device simulation unavailable in this runtime build: " + error);
    }
    // The canvas the device keeps (565 on a 13.3" colour panel with 8 MB),
    // one for every render as on the frame. Old bundles predate the export
    // and draw a fresh RGBX canvas, which the ceiling was worked out for.
    if (limits.embedded && limits.canvasBytesPerPixel) {
      try {
        call("frameos_wasm_set_canvas_bits_per_pixel", null, ["number"], [limits.canvasBytesPerPixel * 8]);
      } catch (error) {
        pushLog("a device canvas is unavailable in this runtime build: " + error);
      }
    }
  }
  // The frame's own render scale, when it set one; otherwise the runtime is
  // automatic. Old bundles predate the export and render at 1.
  if (workerData.renderScale > 0) {
    try {
      call("frameos_wasm_set_render_scale", null, ["number"], [workerData.renderScale]);
    } catch (error) {
      pushLog("render scale unavailable in this runtime build: " + error);
    }
  }
  // The frame's own configuration (SceneRenderOptions.frame): its event map,
  // palette, colours, panel format and rotation, as the device's runtime
  // keeps them; before the scenes load. An old bundle predates the export
  // and renders without them.
  if (workerData.frameJson && workerData.frameJson !== "{}") {
    try {
      if (!call("frameos_wasm_set_frame", "boolean", ["string"], [workerData.frameJson])) {
        pushLog(JSON.stringify({ event: "render:frameConfig", error: lastError() }));
      }
    } catch (error) {
      pushLog("frame configuration unavailable in this runtime build: " + error);
    }
  }
  const memoryStat = (name) => {
    try {
      return call(name, "number", [], []);
    } catch {
      return 0;
    }
  };
  const loaded = call("frameos_wasm_load_scenes", "number", ["string"], [workerData.scenesJson]);
  if (!loaded) {
    return fail("no scenes loaded: " + lastError());
  }
  if (workerData.sceneId) {
    if (!call("frameos_wasm_select_scene", "boolean", ["string"], [workerData.sceneId])) {
      return fail("scene " + workerData.sceneId + " not found: " + lastError());
    }
  }
  let states = {};
  try {
    states = JSON.parse(workerData.statesJson) || {};
  } catch {
    states = {};
  }
  for (const [sceneId, state] of Object.entries(states)) {
    if (!state || typeof state !== "object") continue;
    try {
      call("frameos_wasm_set_scene_state", "boolean", ["string", "string"], [sceneId, JSON.stringify(state)]);
    } catch {
      break;
    }
  }

  // What a control plane sent the scene since its last render. An old bundle
  // predates the export: the event then only re-renders.
  let events = [];
  try {
    events = JSON.parse(workerData.eventsJson) || [];
  } catch {
    events = [];
  }
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event.name !== "string") continue;
    try {
      const delivered = call(
        "frameos_wasm_control_event",
        "boolean",
        ["string", "string", "string"],
        [String(event.origin || "cloud"), event.name, JSON.stringify(event.payload ?? {})],
      );
      if (!delivered) {
        pushLog(JSON.stringify({ event: "event:refused", name: event.name, reason: lastError() }));
      }
    } catch (error) {
      pushLog("scene events unavailable in this runtime build: " + error);
      break;
    }
  }

  // What the frame relayed with its pull (SceneRenderOptions.deviceInput),
  // after the plane's own held events: its key edges and its producers'
  // events, each from its origin, through the one dispatcher. An old bundle
  // predates the export: the pull then only re-renders.
  if (workerData.deviceInputJson) {
    try {
      const delivered = call("frameos_wasm_device_input", "number", ["string"], [workerData.deviceInputJson]);
      if (delivered < 0) {
        pushLog(JSON.stringify({ event: "event:refused", name: "deviceInput", reason: lastError() }));
      }
    } catch (error) {
      pushLog("device input unavailable in this runtime build: " + error);
    }
  }

  // 3: an allocation was refused under the device ceiling. The longjmp out
  // of it leaks what the render held, as on a device (which then restarts),
  // so that is the answer and nothing renders after it.
  let outOfMemory = null;
  const renderOnce = () => {
    const rc = call("frameos_wasm_render", "number", [], []);
    if (rc === 3) {
      outOfMemory = {
        refusedBytes: memoryStat("frameos_wasm_memory_failed"),
        usedBytes: memoryStat("frameos_wasm_memory_used"),
      };
      return false;
    }
    return rc !== 2;
  };
  const failRender = () => {
    if (outOfMemory) {
      parentPort.postMessage({ ok: false, message: "out of memory", outOfMemory, logs });
      return;
    }
    fail("render failed: " + lastError());
  };
  if (!renderOnce()) {
    return failRender();
  }
  // Scenes that fetch or animate ask for another pass right after the first
  // one; give them a moment, like the browser preview's settle window.
  const settleUntil = Date.now() + workerData.settleMs;
  let extra = 0;
  while (Date.now() < settleUntil && extra < 3) {
    sleep(100);
    let requested = 0;
    try {
      requested = call("frameos_wasm_render_requested", "number", [], []);
    } catch {
      break;
    }
    if (!requested) continue;
    extra += 1;
    if (!renderOnce()) {
      if (outOfMemory) return failRender();
      break;
    }
  }

  const width = call("frameos_wasm_width", "number", [], []);
  const height = call("frameos_wasm_height", "number", [], []);
  const ptr = call("frameos_wasm_buffer", "number", [], []);
  const len = call("frameos_wasm_buffer_len", "number", [], []);
  if (!ptr || !len || len !== width * height * 4) {
    return fail("unexpected frame buffer: " + lastError());
  }
  let state = null;
  try {
    state = JSON.parse(call("frameos_wasm_scene_state", "string", [], []));
  } catch {
    state = null;
  }
  // The scene the render ended on: an event may have switched it.
  let sceneId = "";
  try {
    const info = JSON.parse(call("frameos_wasm_scene_info", "string", [], []));
    sceneId = info && typeof info.currentSceneId === "string" ? info.currentSceneId : "";
  } catch {
    sceneId = "";
  }
  // The photo palette it drew with last, which the panel is dithered to.
  let palette = null;
  try {
    const reported = JSON.parse(call("frameos_wasm_render_palette", "string", [], []));
    palette = Array.isArray(reported) ? reported.filter((color) => typeof color === "string") : null;
  } catch {
    palette = null;
  }
  // Packed for the panel here, where the pixels are (SceneRenderOptions.pack):
  // the packer is panel-pack.ts's own, built from its text, and only the
  // FOSB crosses to the main thread. Anything that goes wrong hands the
  // pixels over instead, and the main thread packs them as it always did.
  let packError = "";
  if (workerData.pack) {
    try {
      // __name is the one helper a compiler is known to put into the text:
      // esbuild's keepNames (tsx, the hub's dev runner) wraps functions to
      // keep their names. Names do not matter here, so it hands the function
      // back. Anything else the text needs is a ReferenceError, and the
      // pixels go to the main thread.
      const packer = new Function("__name", "return (" + workerData.packerSource + ")")((fn) => fn)();
      const pack = workerData.pack;
      const pixels = new Uint8Array(Module.HEAPU8.buffer, ptr, len);
      const fosb = packer.panelFosb(
        pixels,
        { width, height },
        { format: pack.format, height: pack.height, rotate: pack.rotate, width: pack.width },
        packer.panelPalette(pack.format, { frame: pack.palette, photo: palette }),
      );
      const body = fosb.byteOffset === 0 && fosb.byteLength === fosb.buffer.byteLength ? fosb.buffer : fosb.slice().buffer;
      parentPort.postMessage(
        { ok: true, packed: true, buffer: body, width, height, logs, palette, renderMs: Date.now() - started, sceneId, state },
        [body],
      );
      return;
    } catch (error) {
      packError = String((error && error.stack) || error).slice(0, 2000);
    }
  }
  const buffer = Module.HEAPU8.buffer.slice(ptr, ptr + len);
  parentPort.postMessage(
    { ok: true, buffer, width, height, logs, palette, renderMs: Date.now() - started, sceneId, state, ...(packError ? { packError } : {}) },
    [buffer],
  );
}

main().catch((error) => {
  parentPort.postMessage({ ok: false, message: String(error && error.stack || error), logs });
});
`;
  return workerSourceCache;
}

// Runs in a child Node per HTTP request and refuses anything private before a
// byte leaves the box; caps the body at 10 MB. The address classifier is
// ssrf.ts's own source, spliced in — one guard. The check sits in the
// socket's own lookup (node:http, not fetch): checking a name and letting the
// client resolve it again would let a rebinding name answer the second query
// with a private address.
export const fetchChildScript = String.raw`
const dns = require("node:dns");
const http = require("node:http");
const https = require("node:https");
const zlib = require("node:zlib");
const { isIP } = require("node:net");
const chunks = [];
${addressIsPrivateSource}
function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (error, records) => {
    if (error) return callback(error);
    if (records.length === 0 || records.some((record) => addressIsPrivate(record.address))) {
      return callback(new Error("host not allowed"));
    }
    if (options && options.all) return callback(null, records);
    callback(null, records[0].address, records[0].family);
  });
}
// A literal host is connected to as is, without a lookup.
function refused(url) {
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return isIP(host) !== 0 && addressIsPrivate(host);
}
const skippedHeaders = new Set(["host", "connection", "content-length", "transfer-encoding"]);
function requestOnce(target, req, signal) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers || {})) {
    if (!skippedHeaders.has(name.toLowerCase())) headers[name] = value;
  }
  return new Promise((resolve, reject) => {
    const client = target.protocol === "https:" ? https : http;
    const outgoing = client.request(target, { method: req.method, headers, lookup: guardedLookup, signal }, resolve);
    outgoing.on("error", reject);
    outgoing.end(req.bodyBase64 ? Buffer.from(req.bodyBase64, "base64") : undefined);
  });
}
// What fetch did on its own: an encoded body arrives decoded.
function decodedBody(response) {
  const encoding = String(response.headers["content-encoding"] || "").trim().toLowerCase();
  if (encoding === "gzip" || encoding === "x-gzip") return response.pipe(zlib.createGunzip());
  if (encoding === "deflate") return response.pipe(zlib.createInflate());
  if (encoding === "br") return response.pipe(zlib.createBrotliDecompress());
  return response;
}
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", async () => {
  const req = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs || 15000);
  try {
    let target = new URL(req.url);
    // Redirects are followed by hand so every hop passes the host check: a
    // public URL must not bounce scene code to loopback or link-local.
    let response;
    for (let hop = 0; ; hop += 1) {
      if (refused(target)) {
        throw new Error("host not allowed");
      }
      response = await requestOnce(target, req, controller.signal);
      const location = response.headers.location;
      if (response.statusCode >= 300 && response.statusCode < 400 && location) {
        response.resume();
        if (hop >= 5) {
          throw new Error("too many redirects");
        }
        target = new URL(location, target);
        continue;
      }
      break;
    }
    const cap = 10 * 1024 * 1024;
    const parts = [];
    let total = 0;
    for await (const value of decodedBody(response)) {
      total += value.length;
      if (total > cap) {
        response.destroy();
        throw new Error("response too large");
      }
      parts.push(Buffer.from(value));
    }
    const body = Buffer.concat(parts);
    process.stdout.write(JSON.stringify({ status: response.statusCode, bodyBase64: body.toString("base64") }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ status: 0, error: String(error) }));
  } finally {
    // A pending timer would hold the child open after it has answered.
    clearTimeout(timer);
  }
});
`;
