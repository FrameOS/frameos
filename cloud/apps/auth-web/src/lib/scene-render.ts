import { Buffer } from "node:buffer";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { zlibSync } from "fflate";
import { logWarn } from "./log";
import { addressIsPrivateSource } from "./ssrf";

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
  height: number;
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
  /** Give up after this long, worker included; default 30 s. */
  timeoutMs?: number | undefined;
  /** IANA zone the simulated frame lives in; default UTC. */
  timeZone?: string | undefined;
  /** Seed per-scene state: { [sceneId]: state }. */
  states?: Record<string, unknown> | undefined;
  width: number;
};

export type SceneRenderResult = {
  errors: string[];
  height: number;
  logs: string[];
  png: Buffer;
  renderMs: number;
  /** The selected scene's state after the render (what it changed). */
  state: unknown;
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
const maxCollectedLogs = 200;
const settleMs = 1_500;

export class SceneRenderError extends Error {
  constructor(
    public readonly code:
      | "render_concurrency_limit"
      | "render_failed"
      | "render_timeout"
      | "renderer_busy"
      | "renderer_unavailable",
    message: string,
    public readonly logs: string[] = [],
  ) {
    super(message);
  }
}

export function wasmAssetsDir(): string {
  return path.join(process.cwd(), "public", "frameos-wasm");
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
      buffer: ArrayBuffer;
      height: number;
      logs: string[];
      ok: true;
      renderMs: number;
      state: unknown;
      width: number;
    }
  | { logs: string[]; message: string; ok: false };

function runWorker(options: SceneRenderOptions): Promise<SceneRenderResult> {
  const timeoutMs = options.timeoutMs ?? defaultRenderTimeoutMs;
  return new Promise<SceneRenderResult>((resolve, reject) => {
    const worker = new Worker(workerSourceText(), {
      eval: true,
      // No IDBFS, no assets: a plain MEMFS is all a preview needs.
      resourceLimits: { maxOldGenerationSizeMb: 512 },
      workerData: {
        assetsDir: wasmAssetsDir(),
        height: options.height,
        maxLogs: maxCollectedLogs,
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
          reject(new SceneRenderError("render_failed", result.message, result.logs));
          return;
        }
        try {
          resolve({
            errors: result.logs.filter(isRenderErrorLine),
            height: result.height,
            logs: result.logs,
            png: encodePng(
              new Uint8Array(result.buffer),
              result.width,
              result.height,
            ),
            renderMs: result.renderMs,
            state: result.state,
            width: result.width,
          });
        } catch (error) {
          reject(
            new SceneRenderError(
              "render_failed",
              error instanceof Error ? error.message : String(error),
              result.logs,
            ),
          );
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

export function encodePng(
  rgba: Uint8Array,
  width: number,
  height: number,
): Buffer {
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
    chunk("IDAT", zlibSync(raw, { level: 6 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
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

  const renderOnce = () => {
    const rc = call("frameos_wasm_render", "number", [], []);
    return rc !== 2;
  };
  if (!renderOnce()) {
    return fail("render failed: " + lastError());
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
    if (!renderOnce()) break;
  }

  const width = call("frameos_wasm_width", "number", [], []);
  const height = call("frameos_wasm_height", "number", [], []);
  const ptr = call("frameos_wasm_buffer", "number", [], []);
  const len = call("frameos_wasm_buffer_len", "number", [], []);
  if (!ptr || !len || len !== width * height * 4) {
    return fail("unexpected frame buffer: " + lastError());
  }
  const buffer = Module.HEAPU8.buffer.slice(ptr, ptr + len);
  let state = null;
  try {
    state = JSON.parse(call("frameos_wasm_scene_state", "string", [], []));
  } catch {
    state = null;
  }
  parentPort.postMessage(
    { ok: true, buffer, width, height, logs, renderMs: Date.now() - started, state },
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
