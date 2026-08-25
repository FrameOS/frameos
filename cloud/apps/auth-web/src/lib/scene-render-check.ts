// Headless render check for AI-delivered scenes, in the browser: run the
// scene once through the frameos-wasm preview worker (the same runtime the
// device runs) and collect what it logs instead of what it draws. The AI
// panel feeds the errors straight back to the agent — a scene that
// validates as JSON can still fail at render time (unsupported SVG, missing
// fields, app errors). A port of frontend/src/utils/wasmSceneRenderCheck.ts
// for the scene store, where there is no frame: settings come from the
// account (GET /api/settings) and CORS-blocked fetches go through the
// store's preview proxy.

export const RENDER_CHECK_SETTLE_MS = 2000;
export const RENDER_CHECK_TIMEOUT_MS = 30_000;
const MAX_COLLECTED_LOGS = 100;
const MAX_COLLECTED_ERRORS = 20;

export const RENDER_CHECK_WORKER_URL = "/frameos-wasm/preview-worker.js";
export const RENDER_CHECK_PROXY_URL = "/api/store/preview-proxy";

export type RenderCheckScene = { id: string } & Record<string, unknown>;

export interface SceneRenderCheckOptions {
  scenes: RenderCheckScene[];
  sceneId: string;
  width: number;
  height: number;
  /** Pre-fetched account settings; fetched from /api/settings when omitted. */
  settings?: Record<string, Record<string, string>> | undefined;
  timeZone?: string | undefined;
}

export interface SceneRenderCheckResult {
  /** At least one frame was produced (errors may still have been logged). */
  rendered: boolean;
  renderMs: number | null;
  /** Log lines the runtime flagged as errors (logError, render failures). */
  errors: string[];
  /** All collected log lines, errors included, oldest first. */
  logs: string[];
  /** The last frame the scene drew, as a PNG data URL composited over
   * opaque white (like the live preview's screenshot); null when no frame
   * arrived or the canvas could not encode it. */
  pngDataUrl: string | null;
  /** The frame's size (the requested size when no frame arrived). */
  width: number;
  height: number;
}

type RawFrame = { width: number; height: number; buffer: ArrayBuffer };

function frameFromMessage(msg: {
  width?: unknown;
  height?: unknown;
  buffer?: unknown;
}): RawFrame | null {
  const { width, height, buffer } = msg;
  if (typeof width !== "number" || typeof height !== "number") {
    return null;
  }
  if (buffer instanceof ArrayBuffer && buffer.byteLength > 0) {
    return { buffer, height, width };
  }
  if (ArrayBuffer.isView(buffer) && buffer.byteLength > 0) {
    // Copy into a fresh (non-shared) ArrayBuffer for ImageData.
    const copy = new Uint8Array(buffer.byteLength);
    copy.set(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
    return { buffer: copy.buffer, height, width };
  }
  return null;
}

// RGBA pixels → PNG data URL, flattened onto white first: the runtime can
// leave transparent pixels and a transparent PNG shows the chat bubble
// through the frame (same fillRect recipe as SceneLivePreview.captureFrame).
// Never throws: a missing document (tests), a 2d-context refusal or a
// mismatched buffer all yield null.
function encodeFramePng({ width, height, buffer }: RawFrame): string | null {
  try {
    if (typeof document === "undefined" || width <= 0 || height <= 0) {
      return null;
    }
    if (buffer.byteLength !== width * height * 4) {
      return null;
    }
    const pixels = document.createElement("canvas");
    pixels.width = width;
    pixels.height = height;
    const pixelContext = pixels.getContext("2d");
    if (!pixelContext) {
      return null;
    }
    pixelContext.putImageData(new ImageData(new Uint8ClampedArray(buffer), width, height), 0, 0);
    const flattened = document.createElement("canvas");
    flattened.width = width;
    flattened.height = height;
    const context = flattened.getContext("2d");
    if (!context) {
      return null;
    }
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(pixels, 0, 0);
    const dataUrl = flattened.toDataURL("image/png");
    return dataUrl.startsWith("data:image/png") ? dataUrl : null;
  } catch {
    return null;
  }
}

function pushCapped(list: string[], entry: string, cap: number): void {
  list.push(entry);
  if (list.length > cap) {
    list.splice(0, list.length - cap);
  }
}

/** Whether a runtime log line reports an error (JSON events or plain text). */
export function logLineIsError(message: string): boolean {
  try {
    const payload = JSON.parse(message) as unknown;
    if (payload && typeof payload === "object") {
      const record = payload as Record<string, unknown>;
      const event = typeof record.event === "string" ? record.event : "";
      return event.startsWith("error") || typeof record.error === "string";
    }
  } catch {
    // plain-text log line (http hook failures etc.)
  }
  return /\berror\b/i.test(message);
}

// Scene ids a scene reaches through "scene" nodes and setCurrentScene
// dispatches; those scenes ship with it so the runtime can resolve them.
function referencedSceneIds(scene: RenderCheckScene): string[] {
  const ids = new Set<string>();
  const nodes = Array.isArray(scene.nodes) ? (scene.nodes as unknown[]) : [];
  for (const node of nodes) {
    if (!node || typeof node !== "object") {
      continue;
    }
    const { type, data } = node as { type?: unknown; data?: unknown };
    const record =
      data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    if (type === "scene" && typeof record.keyword === "string" && record.keyword) {
      ids.add(record.keyword);
    } else if (type === "dispatch" && record.keyword === "setCurrentScene") {
      const config =
        record.config && typeof record.config === "object"
          ? (record.config as Record<string, unknown>)
          : {};
      if (typeof config.sceneId === "string" && config.sceneId) {
        ids.add(config.sceneId);
      }
    }
  }
  return [...ids];
}

/** The root scene plus every scene it (transitively) references. */
export function collectRenderCheckScenes(
  root: RenderCheckScene,
  scenes: RenderCheckScene[],
): RenderCheckScene[] {
  const byId = new Map(scenes.map((scene) => [scene.id, scene]));
  const result: RenderCheckScene[] = [];
  const visited = new Set<string>();
  const visit = (scene: RenderCheckScene) => {
    if (visited.has(scene.id)) {
      return;
    }
    visited.add(scene.id);
    result.push(scene);
    for (const id of referencedSceneIds(scene)) {
      const referenced = byId.get(id);
      if (referenced) {
        visit(referenced);
      }
    }
  };
  visit(root);
  return result;
}

// Service keys saved in the account's settings, in the {group: {field:
// value}} shape the wasm runtime consumes (same reading as SceneLivePreview).
// Best-effort: signed-out or keyless accounts render without them.
export async function fetchPreviewSettings(): Promise<
  Record<string, Record<string, string>>
> {
  const groups: Record<string, Record<string, string>> = {};
  try {
    const response = await fetch("/api/settings");
    if (!response.ok) {
      return groups;
    }
    const data = (await response.json()) as Record<string, unknown>;
    for (const [group, value] of Object.entries(data)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      const fields: Record<string, string> = {};
      for (const [field, fieldValue] of Object.entries(value)) {
        if (typeof fieldValue === "string" && fieldValue) {
          fields[field] = fieldValue;
        }
      }
      if (Object.keys(fields).length > 0) {
        groups[group] = fields;
      }
    }
  } catch {
    // not signed in / offline: render keyless
  }
  return groups;
}

/**
 * Renders `sceneId` from `scenes` once in a dedicated worker and resolves
 * with the collected logs. Never rejects: a crashed or hung worker resolves
 * as `rendered: false` with the failure in `errors`.
 */
export async function renderSceneCheck({
  scenes,
  sceneId,
  width,
  height,
  settings,
  timeZone,
}: SceneRenderCheckOptions): Promise<SceneRenderCheckResult> {
  const errors: string[] = [];
  const logs: string[] = [];
  let rendered = false;
  let renderMs: number | null = null;
  let lastFrame: RawFrame | null = null;
  const failed = (error: string): SceneRenderCheckResult => ({
    errors: [error],
    height,
    logs,
    pngDataUrl: null,
    renderMs,
    rendered,
    width,
  });

  const scene = scenes.find((item) => item.id === sceneId);
  if (!scene) {
    return failed(`Scene ${sceneId} not found`);
  }
  if (typeof Worker === "undefined") {
    return failed("Render check unavailable: no Worker support");
  }

  const payloadScenes = collectRenderCheckScenes(scene, scenes);
  const settingsJson = JSON.stringify(settings ?? (await fetchPreviewSettings()));

  let worker: Worker;
  try {
    worker = new Worker(RENDER_CHECK_WORKER_URL, { type: "module" });
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }

  await new Promise<void>((resolve) => {
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let finished = false;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
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
          `Render check timed out: the scene produced no frame within ${RENDER_CHECK_TIMEOUT_MS / 1000}s`,
          MAX_COLLECTED_ERRORS,
        );
      }
      finish();
    }, RENDER_CHECK_TIMEOUT_MS);
    worker.onerror = (event) => {
      pushCapped(errors, event.message || "Preview worker failed to load", MAX_COLLECTED_ERRORS);
      if (!rendered) {
        finish();
      }
    };
    worker.onmessage = (event: MessageEvent) => {
      const msg = (event.data ?? {}) as {
        type?: string;
        renderMs?: unknown;
        message?: unknown;
        width?: unknown;
        height?: unknown;
        buffer?: unknown;
      };
      if (msg.type === "frame") {
        const firstFrame = !rendered;
        rendered = true;
        renderMs = typeof msg.renderMs === "number" ? msg.renderMs : renderMs;
        // Keep the newest frame: data apps often draw a placeholder first.
        lastFrame = frameFromMessage(msg) ?? lastFrame;
        if (firstFrame) {
          // Let immediate re-renders and async data apps settle so their
          // errors are collected too.
          settleTimer = setTimeout(finish, RENDER_CHECK_SETTLE_MS);
        }
      } else if (msg.type === "log" && typeof msg.message === "string") {
        pushCapped(logs, msg.message, MAX_COLLECTED_LOGS);
        if (logLineIsError(msg.message)) {
          pushCapped(errors, msg.message, MAX_COLLECTED_ERRORS);
        }
      } else if (msg.type === "error") {
        pushCapped(errors, String(msg.message ?? "Render failed"), MAX_COLLECTED_ERRORS);
        if (!rendered) {
          finish();
        }
      }
    };
    worker.postMessage({
      type: "init",
      width,
      height,
      name: "render check",
      timeZone:
        timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      scenesJson: JSON.stringify(payloadScenes),
      settingsJson,
      proxyUrl: RENDER_CHECK_PROXY_URL,
      sceneId: scene.id,
    });
  });
  const frame = lastFrame as RawFrame | null;
  return {
    errors,
    height: frame?.height ?? height,
    logs,
    pngDataUrl: frame ? encodeFramePng(frame) : null,
    renderMs,
    rendered,
    width: frame?.width ?? width,
  };
}
