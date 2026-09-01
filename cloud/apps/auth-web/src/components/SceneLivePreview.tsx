"use client";

import {
  coerceStateFieldValue,
  describeDeviceLimits,
  deviceLimitsFor,
  devicePresets,
  evaluateShowIf,
  FrameOSPreview,
  panelPalettes,
  sceneEventButtons,
  stateFieldShowIfValues,
  type FrameOSScene,
  type PanelPaletteKey,
  type SceneInfo,
  type StateField,
} from "frameos-wasm";
import {
  Camera,
  CircleDollarSign,
  FolderOpen,
  ImageDown,
  KeyRound,
  Play,
  RectangleHorizontal,
  RectangleVertical,
  RotateCw,
  X,
  Zap,
} from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  paidServicesForScenes,
  requiredSettingsForScenes,
  type PreviewSettingsGroup,
} from "../lib/preview-settings";
import type { PreviewLogLine } from "../lib/preview-log";
import { selectFieldOptions } from "../lib/select-options";
import { ImageLightbox } from "./ImageLightbox";
import { PreviewAssetsDialog } from "./PreviewAssetsDialog";
import { PreviewLog } from "./PreviewLog";

type SceneLivePreviewPanelProps = {
  /** The store scene, or null for a scene that is not saved yet (then
   * screenshots cannot go to a gallery). */
  sceneId: string | null;
  /** The editor's current scenes, as last reported by onScenesChanged —
   * what the panel runs. The runtime reloads (debounced) whenever their
   * content changes. */
  scenes: readonly SceneJsonLike[];
  /** The scene selected in the editor — the runtime shows that one. */
  editorSceneId?: string | null | undefined;
  width?: number | null | undefined;
  height?: number | null | undefined;
  /** Owner-only: shows "Save to images", which uploads the current frame to
   * the scene's image gallery. "Download PNG" is there for everyone. */
  canSaveToGallery?: boolean | undefined;
  /** A screenshot was registered with the server; the workspace adds its
   * digest to the draft's image set (published by Save). */
  onImageRegistered?: ((sha256: string) => void) | undefined;
  /** The account's settings page (where service keys are saved), linked from
   * the credentials hint when a scene needs keys. */
  settingsUrl?: string | undefined;
};

type SceneJsonLike = { id: string } & Record<string, unknown>;

const maxLogLines = 200;
/** Editor edits arrive debounced already; this keeps a burst of them from
 * booting the runtime more than once. */
export const EDITOR_RELOAD_DEBOUNCE_MS = 700;
/** How long a transient notice ("Screenshot downloaded.") stays up. */
export const NOTICE_HIDE_MS = 4000;
/** With "Auto apply" on, a burst of typing in the state form becomes one
 * render: this long after the last keystroke. */
export const AUTO_APPLY_DEBOUNCE_MS = 400;
/** A scene rendering at full speed reports frames and log lines many times
 * a second; the panel batches those into one React update per this long.
 * The first report after a quiet spell goes through at once. */
export const UI_FLUSH_INTERVAL_MS = 200;
/** Where "Auto apply" is remembered between editor sessions (this browser). */
const AUTO_APPLY_STORAGE_KEY = "frameos.preview.autoApply";
/** Where the panel simulation is remembered (this browser). Empty means off;
 * anything else is a panelPalettes key. */
const PANEL_STORAGE_KEY = "frameos.preview.panel";
const DEVICE_STORAGE_KEY = "frameos.preview.device";

/** Megabytes with one decimal below 10 — the scale these numbers live at. */
function formatMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

/** Which panel the dither checkbox turns on first — the newest colour e-ink,
 * and what the 13.3" boards FrameOS ships for use. */
const DEFAULT_PANEL: PanelPaletteKey = "spectra6";

/** "every 42 ms (about 24 times a second)" for the fast-render prompt. */
export function describeRenderRate(intervalMs: number): string {
  const ms = Math.max(1, Math.round(intervalMs));
  return `every ${ms} ms (about ${formatFps(1000 / ms)} times a second)`;
}

/** "24" / "7.5": whole numbers from 10 up, one decimal below. */
export function formatFps(fps: number): string {
  return fps >= 10 ? Math.round(fps).toString() : fps.toFixed(1).replace(/\.0$/, "");
}

/** How many frames are averaged for the live fps figure. */
export const FPS_WINDOW = 6;

/** Frames per second over the last FPS_WINDOW frame arrival times, or null
 * with fewer than two of them. */
export function measureFps(arrivals: readonly number[]): number | null {
  if (arrivals.length < 2) {
    return null;
  }
  const first = arrivals[0]!;
  const last = arrivals[arrivals.length - 1]!;
  if (last <= first) {
    return null;
  }
  return ((arrivals.length - 1) * 1000) / (last - first);
}
// Runs a scene in the browser through the frameos-wasm runtime: canvas,
// showIf-aware state fields, event buttons, and logs — no frame needed. The
// runtime assets are copied into /frameos-wasm by scripts/copy-wasm-assets.mjs.
// Rendered as a side column of the scene editor (SceneEditorWorkspace); the
// control surface uses the store's form styling rather than the package's
// own mountFrameOSManager.
export function SceneLivePreviewPanel({
  sceneId,
  scenes: editorScenesProp,
  editorSceneId = null,
  width,
  height,
  canSaveToGallery = false,
  onImageRegistered,
  settingsUrl,
}: SceneLivePreviewPanelProps) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savingShot, setSavingShot] = useState(false);
  // The frame blown up over the page (a click on the canvas). Live: the
  // lightbox shows a canvas the runtime's every frame is mirrored into, so a
  // slideshow or clock keeps moving at full size.
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const lightboxCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // A notice ("Screenshot downloaded.") is transient: it goes away on its
  // own, or sooner with its × button.
  useEffect(() => {
    if (notice === null) {
      return;
    }
    const timer = setTimeout(() => setNotice(null), NOTICE_HIDE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  // The editor's scenes, committed to the runtime after a quiet period. The
  // first payload lands at once (nothing is running yet); later ones only
  // when their content actually differs from what runs.
  const [editorScenes, setEditorScenes] = useState<FrameOSScene[] | null>(null);
  // The JSON of what runs — the identity a paid-preview go-ahead is tied to.
  const [editorScenesJson, setEditorScenesJson] = useState("");
  const committedEditorJsonRef = useRef("");
  useEffect(() => {
    const json = JSON.stringify(editorScenesProp);
    if (json === committedEditorJsonRef.current) {
      return;
    }
    const commit = () => {
      committedEditorJsonRef.current = json;
      setEditorScenesJson(json);
      setEditorScenes(editorScenesProp as unknown as FrameOSScene[]);
    };
    if (committedEditorJsonRef.current === "") {
      commit();
      return;
    }
    const timer = setTimeout(commit, EDITOR_RELOAD_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [editorScenesProp]);

  const scenes = editorScenes;

  // The viewport applied to the running preview, and the form values being
  // typed (applied on "Resize").
  const [viewport, setViewport] = useState({
    height: height || 480,
    width: width || 800,
  });
  const [viewportForm, setViewportForm] = useState(viewport);

  // Bumped by the Restart button; recreates the whole wasm runtime.
  const [restartCount, setRestartCount] = useState(0);

  // Render pacing. The runtime throttles every scene to one render per
  // second; a scene asking for more (a 24 fps slideshow) gets to ask the
  // visitor once, and only runs at full speed after "Run at full speed".
  // The answer survives runtime restarts (editor edits, Restart, Resize).
  const [fastMode, setFastMode] = useState(false);
  const [fastRenderRequest, setFastRenderRequest] = useState<{
    intervalMs: number;
    answered: boolean;
  } | null>(null);
  // The rate the runtime actually renders at (last FPS_WINDOW frames),
  // shown on the real-time toggle; arrival times live in a ref, the figure
  // is published with the batched frame status.
  const frameArrivalsRef = useRef<number[]>([]);
  const [measuredFps, setMeasuredFps] = useState<number | null>(null);

  // The browser asset folder dialog, and the running preview it manages
  // (previewRef is not reactive; this state follows the runtime's life).
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [previewInstance, setPreviewInstance] = useState<FrameOSPreview | null>(null);
  // Bumped when the runtime reports files changed (a scene saved one).
  const [assetsVersion, setAssetsVersion] = useState(0);

  // A screenshot before the runtime's first paint would capture a fully
  // transparent canvas; the button stays disabled until a frame arrives.
  // Reset whenever the runtime restarts (restart, resize, new settings).
  const [hasPaintedFrame, setHasPaintedFrame] = useState(false);

  // App settings (API keys etc.) some scenes need to render. Typed values are
  // kept per flat "group.field" key; "Apply" nests them into the settings
  // object the runtime expects and restarts the preview.
  const [settingsForm, setSettingsForm] = useState<Record<string, string>>({});
  const [appliedSettings, setAppliedSettings] = useState<
    Record<string, Record<string, string>>
  >({});
  // Groups whose keys are saved on the account start collapsed ("using your
  // account's key"); "Use another key" opens that group's fields.
  const [credentialsExpanded, setCredentialsExpanded] = useState<Record<string, boolean>>({});
  // Service keys saved in the account's settings (GET /api/settings), used
  // as the base layer so scenes render without retyping them; anything typed
  // above wins per field. null until the (best-effort) fetch settles — the
  // runtime start waits for it so it doesn't boot keyless and restart.
  const [storedSettings, setStoredSettings] = useState<Record<
    string,
    Record<string, string>
  > | null>(null);
  const requiredSettings = useMemo<PreviewSettingsGroup[]>(
    () => (scenes ? requiredSettingsForScenes(scenes) : []),
    [scenes],
  );

  // A scene that calls a pay-per-request service (OpenAI) never renders on
  // its own: not on open, not after an editor change. "Run preview" gives
  // the go-ahead for the scene content as it is now; the next content change
  // takes it back, so an editor (or AI) edit cannot quietly bill a render.
  // Restart, Resize and new settings keep the go-ahead: they are clicks.
  const paidServices = useMemo(
    () => (scenes ? paidServicesForScenes(scenes) : []),
    [scenes],
  );
  const [paidRunJson, setPaidRunJson] = useState<string | null>(null);
  const previewGated =
    paidServices.length > 0 && paidRunJson !== editorScenesJson;

  // "Auto apply": every change in the state form is applied and rendered
  // (debounced) without pressing "Apply & render". Never offered for a paid
  // scene — there every render is a deliberate click. Remembered per browser.
  const [autoApply, setAutoApply] = useState(false);
  useEffect(() => {
    try {
      setAutoApply(window.localStorage.getItem(AUTO_APPLY_STORAGE_KEY) === "1");
    } catch {
      // Storage blocked: the checkbox still works for this session.
    }
  }, []);
  function toggleAutoApply(checked: boolean) {
    setAutoApply(checked);
    try {
      window.localStorage.setItem(AUTO_APPLY_STORAGE_KEY, checked ? "1" : "0");
    } catch {
      // See above.
    }
  }

  // "Dither": show the rendered frame the way an e-ink panel would — the
  // device's own Floyd-Steinberg, to that panel's measured inks or greys.
  // A full-colour preview flatters a scene; six inks is what the frame has.
  // Null is off. Remembered per browser, like Auto apply.
  const [panel, setPanel] = useState<PanelPaletteKey | null>(null);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(PANEL_STORAGE_KEY);
      if (stored && panelPalettes.some((entry) => entry.key === stored)) {
        setPanel(stored as PanelPaletteKey);
      }
    } catch {
      // Storage blocked: the controls still work for this session.
    }
  }, []);
  // Read when the runtime is (re)booted — a Restart, a Resize or an editor
  // edit must come back through the same panel.
  const panelRef = useRef<PanelPaletteKey | null>(panel);
  panelRef.current = panel;
  function choosePanel(next: PanelPaletteKey | null) {
    setPanel(next);
    // The frame on screen is repainted through the new palette; no re-render
    // is needed, it is the same picture.
    previewRef.current?.setPanelPalette(next);
    try {
      window.localStorage.setItem(PANEL_STORAGE_KEY, next ?? "");
    } catch {
      // See above.
    }
  }

  // "Device": run the runtime under a real device's memory ceiling, so a
  // scene too heavy for that frame fails here instead of on hardware. The
  // ceiling is applied when the runtime boots, so changing it restarts the
  // runtime the way Resize does. Remembered per browser, like Dither.
  const [device, setDevice] = useState<string>("browser");
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(DEVICE_STORAGE_KEY);
      if (stored && devicePresets.some((entry) => entry.key === stored)) {
        setDevice(stored);
      }
    } catch {
      // Storage blocked: the control still works for this session.
    }
  }, []);
  const deviceRef = useRef<string>(device);
  deviceRef.current = device;
  // What the last render cost, and whether one was refused outright.
  const [deviceMemory, setDeviceMemory] = useState<{
    limitBytes: number;
    peakBytes: number;
  } | null>(null);
  const [outOfMemory, setOutOfMemory] = useState<{
    refusedBytes: number;
    limitBytes: number;
  } | null>(null);
  const deviceLimits = deviceLimitsFor(device, viewport.width, viewport.height);
  function chooseDevice(next: string) {
    setDevice(next);
    setDeviceMemory(null);
    setOutOfMemory(null);
    try {
      window.localStorage.setItem(DEVICE_STORAGE_KEY, next);
    } catch {
      // See above.
    }
    // The ceiling can only be set on a fresh heap; reboot the runtime.
    setRestartCount((count) => count + 1);
  }

  // Runtime plumbing: the canvas the worker paints onto, the live preview
  // handle, and what the runtime has reported so far.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewRef = useRef<FrameOSPreview | null>(null);
  const [sceneInfo, setSceneInfo] = useState<SceneInfo | null>(null);
  const [currentSceneId, setCurrentSceneId] = useState<string | null>(null);
  const [runtimeState, setRuntimeState] = useState<Record<string, unknown>>({});
  // State-field values edited in the form, overriding the runtime's reported
  // state until "Apply & render" sends them and the runtime confirms them.
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  // What "Apply & render" last sent, replayed into a freshly booted runtime
  // (an editor reload, Restart, Resize) so the preview keeps showing the
  // values being tried out rather than snapping back to the defaults.
  const appliedStateRef = useRef<Record<string, unknown>>({});
  const [status, setStatus] = useState("");
  // Runtime output, one entry per line, stamped when it arrived (the
  // runtime's lines carry no time of their own); ids are list keys.
  const [logs, setLogs] = useState<PreviewLogLine[]>([]);
  const logIdRef = useRef(0);
  const fieldIdPrefix = useId();
  const editorSceneIdRef = useRef(editorSceneId);
  editorSceneIdRef.current = editorSceneId;
  useEffect(() => {
    if (storedSettings !== null) {
      return;
    }
    let cancelled = false;
    (async () => {
      const groups: Record<string, Record<string, string>> = {};
      try {
        const response = await fetch("/api/settings");
        if (response.ok) {
          // {group: {field: value}} — keep the non-empty string fields; the
          // wasm runtime consumes exactly that shape.
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
        }
      } catch {
        // Not signed in / no stored keys: the preview still runs, and the
        // form above lets the visitor type keys for this tab.
      }
      if (!cancelled) {
        setStoredSettings(groups);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storedSettings]);

  // Stored account keys under, per-field overrides typed in this tab over.
  const previewSettings = useMemo(() => {
    const merged: Record<string, Record<string, string>> = {};
    for (const [group, fields] of Object.entries(storedSettings ?? {})) {
      merged[group] = { ...fields };
    }
    for (const [group, fields] of Object.entries(appliedSettings)) {
      merged[group] = { ...(merged[group] ?? {}), ...fields };
    }
    return merged;
  }, [storedSettings, appliedSettings]);

  // Boots the runtime (a worker) against the canvas; torn down and recreated
  // whenever the scenes, viewport or settings change, or on Restart.
  useEffect(() => {
    if (!scenes || storedSettings === null || !canvasRef.current || previewGated) {
      return;
    }
    let cancelled = false;
    let preview: FrameOSPreview | null = null;
    setHasPaintedFrame(false);
    setSceneInfo(null);
    setRuntimeState({});
    setLogs([]);
    frameArrivalsRef.current = [];
    setMeasuredFps(null);
    setStatus("Loading FrameOS runtime…");
    // Overrides for fields the reloaded scenes no longer have are dropped;
    // the rest stay in the form (and, once applied, in the runtime).
    const fieldNames = new Set(
      scenes.flatMap((scene) => (scene.fields ?? []).map((field) => field.name)),
    );
    const keepKnown = (values: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(values).filter(([key]) => fieldNames.has(key)));
    setEdits(keepKnown);
    appliedStateRef.current = keepKnown(appliedStateRef.current);
    // Leading-edge throttle: the first line (or frame) after a quiet spell
    // lands at once, a burst collapses into one trailing update.
    const flushes: Record<string, { timer: ReturnType<typeof setTimeout> | null; lastAt: number }> = {};
    const scheduleFlush = (key: string, flush: () => void) => {
      const entry = (flushes[key] ??= { lastAt: 0, timer: null });
      if (entry.timer !== null) {
        return;
      }
      const elapsed = Date.now() - entry.lastAt;
      if (elapsed >= UI_FLUSH_INTERVAL_MS) {
        entry.lastAt = Date.now();
        flush();
        return;
      }
      entry.timer = setTimeout(() => {
        entry.timer = null;
        entry.lastAt = Date.now();
        flush();
      }, UI_FLUSH_INTERVAL_MS - elapsed);
    };
    let logQueue: PreviewLogLine[] = [];
    const appendLog = (line: string) => {
      if (cancelled) {
        return;
      }
      logQueue.push({ id: logIdRef.current++, line, receivedAt: Date.now() });
      scheduleFlush("log", () => {
        const lines = logQueue;
        logQueue = [];
        if (cancelled || lines.length === 0) {
          return;
        }
        setLogs((previous) => {
          const next = [...previous, ...lines];
          return next.length > maxLogLines ? next.slice(-maxLogLines) : next;
        });
      });
    };
    try {
      preview = new FrameOSPreview({
        canvas: canvasRef.current,
        workerUrl: "/frameos-wasm/preview-worker.js",
        width: viewport.width,
        height: viewport.height,
        scenes,
        settings: previewSettings,
        // Fallback only: the runtime fetches URLs client-side first and
        // routes just CORS-blocked hosts through this endpoint.
        proxyUrl: "/api/store/preview-proxy",
        fastMode,
        panelPalette: panelRef.current,
        deviceLimits: deviceLimitsFor(
          deviceRef.current,
          viewport.width,
          viewport.height
        ),
        onMemory: (usage) => {
          if (!cancelled) {
            setDeviceMemory({
              limitBytes: usage.limitBytes,
              peakBytes: usage.peakBytes,
            });
          }
        },
        onOutOfMemory: (info) => {
          if (!cancelled) {
            setOutOfMemory({
              refusedBytes: info.refusedBytes,
              limitBytes: info.limitBytes,
            });
          }
        },
        onFastRenderRequest: (intervalMs) => {
          if (cancelled) {
            return;
          }
          // A restart re-asks; keep the answer already given.
          setFastRenderRequest((current) => ({
            intervalMs,
            answered: current?.answered ?? false,
          }));
        },
        onAssetsChanged: () => {
          if (!cancelled) {
            setAssetsVersion((version) => version + 1);
          }
        },
        onReady: (info) => {
          if (cancelled || !preview) {
            return;
          }
          setSceneInfo(info ?? null);
          setStatus("");
          // Show the scene being edited, not the default one, when the
          // editor has several.
          const wanted = editorSceneIdRef.current;
          const wantedExists = wanted !== null && scenes.some((scene) => scene.id === wanted);
          if (wantedExists && wanted !== info?.currentSceneId) {
            preview.selectScene(wanted);
            setCurrentSceneId(wanted);
          } else {
            setCurrentSceneId(info?.currentSceneId ?? null);
          }
          const replay = appliedStateRef.current;
          if (Object.keys(replay).length > 0) {
            preview.setSceneState(replay);
          }
        },
        onFrame: (frame) => {
          if (cancelled) {
            return;
          }
          setHasPaintedFrame(true);
          // Straight through, not batched: the full-size view should move as
          // soon as the small one does.
          paintLightbox();
          const arrivals = frameArrivalsRef.current;
          arrivals.push(performance.now());
          if (arrivals.length > FPS_WINDOW) {
            arrivals.splice(0, arrivals.length - FPS_WINDOW);
          }
          scheduleFlush("frame", () => {
            if (!cancelled) {
              setStatus(`Rendered ${frame.width}×${frame.height} in ${frame.renderMs} ms`);
              setMeasuredFps(measureFps(frameArrivalsRef.current));
            }
          });
        },
        onState: (state) => {
          if (cancelled) {
            return;
          }
          const reported = state ?? {};
          setRuntimeState(reported);
          // Drop only the edits the runtime has confirmed; anything typed
          // but not yet applied survives a render (or any other state
          // report) instead of being silently reverted.
          setEdits((previous) => {
            const unconfirmed: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(previous)) {
              if (String(reported[key] ?? "") !== String(value ?? "")) {
                unconfirmed[key] = value;
              }
            }
            return unconfirmed;
          });
        },
        onLog: appendLog,
        onSceneEvent: (name, payload) =>
          appendLog(`event: ${name} ${JSON.stringify(payload)}`),
        onError: (message) => {
          if (cancelled) {
            return;
          }
          setError(message);
          appendLog(`error: ${message}`);
        },
      });
      previewRef.current = preview;
      setPreviewInstance(preview);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    return () => {
      cancelled = true;
      for (const entry of Object.values(flushes)) {
        if (entry.timer !== null) {
          clearTimeout(entry.timer);
        }
      }
      preview?.destroy();
      if (previewRef.current === preview) {
        previewRef.current = null;
      }
      setPreviewInstance((current) => (current === preview ? null : current));
    };
    // fastMode reaches a running runtime through setFastMode below; only a
    // fresh runtime reads it from the options, so it is no dependency here.
  }, [scenes, viewport, storedSettings, previewSettings, restartCount, previewGated]);

  // A new runtime starts with a clean heap.
  useEffect(() => {
    setOutOfMemory(null);
  }, [restartCount]);

  function answerFastRender(enabled: boolean) {
    setFastMode(enabled);
    setFastRenderRequest((current) => (current ? { ...current, answered: true } : current));
    previewRef.current?.setFastMode(enabled);
  }

  // The editor switched scenes while the runtime is up: follow it.
  const runtimeReady = sceneInfo !== null;
  useEffect(() => {
    if (!runtimeReady || !editorSceneId || !scenes?.some((scene) => scene.id === editorSceneId)) {
      return;
    }
    setCurrentSceneId((current) => {
      if (current !== editorSceneId) {
        previewRef.current?.selectScene(editorSceneId);
      }
      return editorSceneId;
    });
  }, [runtimeReady, editorSceneId, scenes]);

  // The scene whose fields the form shows: the runtime's current one, else
  // the default from scenes.json (so the form is there before the worker is).
  const currentScene = useMemo(() => {
    if (!scenes) {
      return undefined;
    }
    return (
      scenes.find((scene) => scene.id === currentSceneId) ??
      scenes.find((scene) => scene.default) ??
      scenes[0]
    );
  }, [scenes, currentSceneId]);
  const publicFields = useMemo(
    () =>
      (currentScene?.fields ?? []).filter(
        (field) => field.access === "public" && field.name,
      ),
    [currentScene],
  );
  const fieldValues = useMemo(
    () => stateFieldShowIfValues(publicFields, runtimeState, edits),
    [publicFields, runtimeState, edits],
  );
  const visibleFields = publicFields.filter((field) =>
    evaluateShowIf(field.showIf, fieldValues, field.name),
  );
  const eventButtons = useMemo(
    () => sceneEventButtons(currentScene),
    [currentScene],
  );

  function editField(field: StateField, value: unknown) {
    setEdits((previous) => ({ ...previous, [field.name]: value }));
  }

  function applyState() {
    const state: Record<string, unknown> = {};
    for (const field of visibleFields) {
      const value =
        field.name in edits ? edits[field.name] : fieldValues[field.name];
      if (value !== undefined) {
        state[field.name] = coerceStateFieldValue(field, value);
      }
    }
    appliedStateRef.current = { ...appliedStateRef.current, ...state };
    previewRef.current?.setSceneState(state);
  }

  // Typed into the form but not sent yet (an applied edit is dropped as
  // soon as the runtime confirms it, see onState).
  const hasUnappliedEdits = Object.entries(edits).some(
    ([key, value]) => String(runtimeState[key] ?? "") !== String(value ?? ""),
  );
  const autoApplyOffered = paidServices.length === 0;
  const autoApplyActive = autoApply && autoApplyOffered;

  // Auto apply: once the typing pauses, send what "Apply & render" would.
  // Keyed on the edits themselves, so the closure applies the latest values;
  // a confirmed edit clears out of `edits` and does not re-trigger.
  useEffect(() => {
    if (!autoApplyActive || !runtimeReady || !hasUnappliedEdits) {
      return;
    }
    const timer = setTimeout(applyState, AUTO_APPLY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // applyState is recreated every render; `edits` is what actually changes.
  }, [autoApplyActive, runtimeReady, hasUnappliedEdits, edits]);

  // Back to the values in the scene: shown in the form at once (as
  // overrides, until the runtime confirms them) and sent to the runtime.
  function resetState() {
    const defaults: Record<string, unknown> = {};
    for (const field of publicFields) {
      const value = coerceStateFieldValue(field, field.value);
      if (value !== undefined && value !== null) {
        defaults[field.name] = value;
      }
    }
    setEdits(defaults);
    appliedStateRef.current = {};
    previewRef.current?.setSceneState(defaults);
  }

  function selectScene(id: string) {
    setEdits({});
    setCurrentSceneId(id);
    previewRef.current?.selectScene(id);
  }

  // Portrait <-> landscape: swaps the two sizes and applies at once (the
  // same as typing them and pressing Resize).
  function rotateViewport() {
    const rotated = { height: viewport.width, width: viewport.height };
    setViewportForm(rotated);
    setViewport(rotated);
  }

  function applySettings() {
    const nested: Record<string, Record<string, string>> = {};
    for (const group of requiredSettings) {
      for (const field of group.fields) {
        const value = settingsForm[field.path.join(".")]?.trim();
        if (value) {
          nested[field.path[0]] = {
            ...nested[field.path[0]],
            [field.path[1]]: value,
          };
        }
      }
    }
    setAppliedSettings(nested);
  }

  // Mirror the preview canvas into the lightbox canvas (when open), over an
  // opaque white ground like the screenshots.
  function paintLightbox() {
    const source = canvasRef.current;
    const target = lightboxCanvasRef.current;
    if (!source || !target) {
      return;
    }
    if (target.width !== source.width || target.height !== source.height) {
      target.width = source.width;
      target.height = source.height;
    }
    const context = target.getContext("2d");
    if (!context) {
      return;
    }
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, target.width, target.height);
    context.drawImage(source, 0, 0);
  }

  // The current frame composited over white, or null (with the error set)
  // when there is nothing to capture yet.
  function flattenFrame(): HTMLCanvasElement | null {
    const canvas = canvasRef.current;
    if (!canvas || !hasPaintedFrame) {
      setError(
        "The preview has not rendered a frame yet — wait for the first render before taking a screenshot.",
      );
      return null;
    }
    // Composite over an opaque background before encoding: a canvas can
    // hold transparent pixels, and a transparent PNG makes a blank store
    // tile (same fillRect recipe as frontend's splitScreenThumbnail).
    const flattened = document.createElement("canvas");
    flattened.width = canvas.width;
    flattened.height = canvas.height;
    const context = flattened.getContext("2d");
    if (!context) {
      setError("Could not capture the canvas.");
      return null;
    }
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, flattened.width, flattened.height);
    context.drawImage(canvas, 0, 0);
    return flattened;
  }

  /** The current frame as an opaque PNG blob (see flattenFrame). */
  async function captureFrame(): Promise<Blob | null> {
    const flattened = flattenFrame();
    if (!flattened) {
      return null;
    }
    const blob = await new Promise<Blob | null>((resolve) =>
      flattened.toBlob(resolve, "image/png"),
    );
    if (!blob) {
      setError("Could not capture the canvas.");
    }
    return blob;
  }

  function closeLightbox() {
    setLightboxOpen(false);
  }

  function openLightbox() {
    if (!hasPaintedFrame) {
      return;
    }
    setLightboxOpen(true);
  }

  async function downloadScreenshot() {
    setError(null);
    setNotice(null);
    const blob = await captureFrame();
    if (!blob) {
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${sceneId ?? "scene"}-preview.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    setNotice("Screenshot downloaded.");
  }

  async function saveScreenshotToGallery() {
    if (sceneId === null) {
      return;
    }
    setSavingShot(true);
    setError(null);
    setNotice(null);
    try {
      const blob = await captureFrame();
      if (!blob) {
        return;
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      const response = await fetch(`/api/account/scenes/${sceneId}/images`, {
        body: JSON.stringify({ content_base64: btoa(binary) }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok && typeof payload.image?.sha256 === "string") {
        setNotice("Screenshot added to the scene's images — Save publishes it.");
        onImageRegistered?.(payload.image.sha256 as string);
      } else {
        setError(`Saving screenshot failed: ${payload.error ?? response.status}`);
      }
    } finally {
      setSavingShot(false);
    }
  }

  const runtimeScenes = sceneInfo?.scenes ?? [];

  // A settings group whose every field is saved on the account is shown as
  // "from your account" until "Use another key"; a group with a missing
  // field, or one typed over, shows its inputs.
  const credentialsFormShown = (group: PreviewSettingsGroup): boolean =>
    credentialsExpanded[group.key] === true ||
    group.fields.some((field) => !storedSettings?.[field.path[0]]?.[field.path[1]]);
  const anyCredentialsFormShown = requiredSettings.some(credentialsFormShown);

  const viewportValid =
    Number.isFinite(viewportForm.width) &&
    Number.isFinite(viewportForm.height) &&
    viewportForm.width >= 64 &&
    viewportForm.height >= 64 &&
    viewportForm.width <= 4096 &&
    viewportForm.height <= 4096;

  return (
    <div className="live-preview-panel stack">
      <div className="live-preview-panel__header stack">
        <div className="live-preview-panel__bar">
        <div className="button-row live-preview-panel__actions">
          <button
            aria-label="Restart"
            className="button button--subtle button--small"
            disabled={previewGated}
            onClick={() => {
              setError(null);
              setRestartCount((count) => count + 1);
            }}
            title={
              previewGated
                ? "Start the preview first"
                : "Restart: reload the wasm FrameOS runtime from scratch"
            }
            type="button"
          >
            <RotateCw aria-hidden size={16} />
          </button>
          <button
            aria-label="Download PNG"
            className="button button--subtle button--small"
            disabled={!hasPaintedFrame}
            onClick={() => void downloadScreenshot()}
            title={
              hasPaintedFrame
                ? "Download a PNG screenshot of the current frame"
                : "Available after the preview renders its first frame"
            }
            type="button"
          >
            <ImageDown aria-hidden size={16} />
          </button>
          <button
            className="button button--subtle button--small"
            onClick={() => setAssetsOpen(true)}
            title="Manage the browser-only asset folder the preview mounts at /srv/assets"
            type="button"
          >
            <FolderOpen aria-hidden size={16} />
            Browser assets
          </button>
          {canSaveToGallery && sceneId !== null ? (
            <button
              className="button button--subtle button--small"
              disabled={savingShot || !hasPaintedFrame}
              onClick={() => void saveScreenshotToGallery()}
              title={
                hasPaintedFrame
                  ? "Save the current frame to this scene's images"
                  : "Available after the preview renders its first frame"
              }
              type="button"
            >
              <Camera aria-hidden size={16} />
              {savingShot ? "Saving…" : "Save to images"}
            </button>
          ) : null}
          </div>
        </div>
        {scenes ? (
          // The actions stay in view while a long form scrolls underneath
          // (the sticky header): nothing here re-renders on its own, so
          // "Apply & render" must never be below the fold.
          <div className="button-row live-preview-panel__toolbar">
            {visibleFields.length > 0 ? (
              <>
                {/* The button IS the "unapplied changes" indicator: it
                    lights up when the form has moved ahead of the runtime
                    and drops back to a plain action once it has caught up.
                    A banner here said the same thing and shoved everything
                    below it down the page on every keystroke. */}
                <button
                  className={`button button--small ${
                    hasUnappliedEdits ? "button-primary" : "button--subtle"
                  }`}
                  disabled={!runtimeReady}
                  onClick={applyState}
                  type="button"
                >
                  Apply &amp; render
                </button>
                <button
                  className="button button--subtle button--small"
                  disabled={!runtimeReady}
                  onClick={resetState}
                  title="Back to the values the scene defines"
                  type="button"
                >
                  Reset
                </button>
              </>
            ) : null}
            {/* Custom event nodes as buttons. Listener nodes filter on
                payload values (a "button" listener with label "A" only
                fires for {label: "A"}), so the label rides along in the
                payload, not just as the caption. */}
            {eventButtons.map((event) => (
              <button
                className="button button--subtle button--small"
                disabled={!runtimeReady}
                key={`${event.keyword}:${event.label ?? ""}`}
                onClick={() =>
                  previewRef.current?.sendEvent(
                    event.keyword,
                    event.label ? { label: event.label } : {},
                  )
                }
                type="button"
              >
                {event.label || event.keyword}
              </button>
            ))}
            <button
              className="button button--subtle button--small"
              disabled={!runtimeReady}
              onClick={() => previewRef.current?.render()}
              type="button"
            >
              Render
            </button>
            {visibleFields.length > 0 && autoApplyOffered ? (
              <label
                className="live-preview-panel__auto-apply"
                title="Apply & render as soon as a value below changes"
              >
                <input
                  checked={autoApply}
                  onChange={(event) => toggleAutoApply(event.target.checked)}
                  type="checkbox"
                />
                Auto apply
              </label>
            ) : null}
          </div>
        ) : null}
      </div>
      {fastRenderRequest && !fastRenderRequest.answered ? (
        <div className="notice live-preview__fast" role="status">
          <Zap aria-hidden className="live-preview__fast-icon" size={18} />
          <span className="live-preview__fast-copy">
            This scene wants to render {describeRenderRate(fastRenderRequest.intervalMs)}. The
            preview is holding it to one render per second — let it go at full speed? It keeps your
            browser busy while the editor is open.
          </span>
          <span className="button-row">
            <button
              className="button button-primary button--small"
              onClick={() => answerFastRender(true)}
              type="button"
            >
              Run at full speed
            </button>
            <button
              className="button button--subtle button--small"
              onClick={() => answerFastRender(false)}
              type="button"
            >
              Keep 1 fps
            </button>
          </span>
        </div>
      ) : null}
      {fastRenderRequest?.answered ? (
        <label
          className="live-preview-panel__auto-apply live-preview__fast-toggle"
          title="Let the scene render as often as it asks instead of once per second"
        >
          <input
            checked={fastMode}
            onChange={(event) => answerFastRender(event.target.checked)}
            type="checkbox"
          />
          Real-time rendering
          {fastMode && measuredFps !== null
            ? ` · ${formatFps(measuredFps)} fps`
            : ` (the scene asks for ~${formatFps(1000 / Math.max(1, fastRenderRequest.intervalMs))} fps)`}
        </label>
      ) : null}
      <div className="live-preview">
        {previewGated ? (
          <div className="live-preview__gate" role="status">
            <CircleDollarSign aria-hidden className="live-preview__gate-icon" size={28} />
            <p className="live-preview__gate-title">
              This preview waits for you to start it
            </p>
            <p className="live-preview__gate-copy">
              This scene calls {joinNames(paidServices.map((group) => group.title))},
              which bills per request. To keep that under your control, nothing
              renders until you ask for it — and every change to the scene
              needs a fresh go-ahead.
            </p>
            <button
              className="button button-primary"
              onClick={() => {
                setError(null);
                setPaidRunJson(editorScenesJson);
              }}
              type="button"
            >
              <Play aria-hidden size={16} />
              Run preview
            </button>
          </div>
        ) : null}
        <div className="live-preview__stage" hidden={previewGated}>
          <canvas
            aria-label={hasPaintedFrame ? "Show the frame at full size" : undefined}
            className={`live-preview__canvas${hasPaintedFrame ? " live-preview__canvas--zoomable" : ""}`}
            height={viewport.height}
            onClick={openLightbox}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openLightbox();
              }
            }}
            ref={canvasRef}
            role={hasPaintedFrame ? "button" : undefined}
            tabIndex={hasPaintedFrame ? 0 : undefined}
            title={hasPaintedFrame ? "Click to view at full size" : undefined}
            width={viewport.width}
          />
        </div>
        <div
          className={`live-preview__status${error ? " live-preview__status--error" : ""}`}
        >
          {scenes === null ? "Loading the scene…" : previewGated ? "" : status}
        </div>
      </div>
      {error ? (
        <p className="notice notice-error notice--dismissible" role="alert">
          <span>{error}</span>
          <button
            aria-label="Dismiss"
            className="notice__dismiss"
            onClick={() => setError(null)}
            type="button"
          >
            <X aria-hidden size={14} />
          </button>
        </p>
      ) : null}
      {notice ? (
        <p className="notice notice--dismissible" role="status">
          <span>{notice}</span>
          <button
            aria-label="Dismiss"
            className="notice__dismiss"
            onClick={() => setNotice(null)}
            type="button"
          >
            <X aria-hidden size={14} />
          </button>
        </p>
      ) : null}
      <div className="viewport-controls">
        <label className="viewport-controls__label" htmlFor={`${fieldIdPrefix}-width`}>
          Resolution
        </label>
        <input
          className="viewport-controls__input"
          id={`${fieldIdPrefix}-width`}
          min={64}
          max={4096}
          onChange={(event) =>
            setViewportForm((form) => ({
              ...form,
              width: Number(event.target.value),
            }))
          }
          type="number"
          value={viewportForm.width}
        />
        ×
        <input
          aria-label="Viewport height"
          className="viewport-controls__input"
          min={64}
          max={4096}
          onChange={(event) =>
            setViewportForm((form) => ({
              ...form,
              height: Number(event.target.value),
            }))
          }
          type="number"
          value={viewportForm.height}
        />
        <button
          className="button button--subtle button--small"
          disabled={
            !viewportValid ||
            (viewportForm.width === viewport.width &&
              viewportForm.height === viewport.height)
          }
          onClick={() => setViewport(viewportForm)}
          type="button"
        >
          Resize
        </button>
        <button
          aria-label="Rotate"
          className="button button--subtle button--small"
          onClick={rotateViewport}
          title="Swap width and height"
          type="button"
        >
          {/* The orientation you would switch to. */}
          {viewport.width >= viewport.height ? (
            <RectangleVertical aria-hidden size={16} />
          ) : (
            <RectangleHorizontal aria-hidden size={16} />
          )}
          Rotate
        </button>
      </div>
      {/* What the panel would make of this picture. The preview otherwise
          shows full colour on a backlit screen — flattering, and nothing
          like six inks on paper. */}
      <div className="viewport-controls">
        <label className="viewport-controls__toggle">
          <input
            checked={panel !== null}
            onChange={(event) => choosePanel(event.target.checked ? DEFAULT_PANEL : null)}
            type="checkbox"
          />
          Dither
        </label>
        <select
          aria-label="Panel to simulate"
          className="viewport-controls__select"
          disabled={panel === null}
          onChange={(event) => choosePanel(event.target.value as PanelPaletteKey)}
          value={panel ?? DEFAULT_PANEL}
        >
          {panelPalettes.map((entry) => (
            <option key={entry.key} value={entry.key}>
              {entry.label}
            </option>
          ))}
        </select>
        {/* Memory: a browser has gigabytes, a frame has a few megabytes, and
            until now the difference only showed up on the device. */}
        <label className="viewport-controls__label" htmlFor="preview-device">
          Memory
        </label>
        <select
          className="viewport-controls__select"
          id="preview-device"
          onChange={(event) => chooseDevice(event.target.value)}
          title={
            deviceLimits
              ? describeDeviceLimits(deviceLimits)
              : "Renders with the browser's own memory."
          }
          value={device}
        >
          {devicePresets.map((entry) => (
            <option key={entry.key} value={entry.key}>
              {entry.label}
            </option>
          ))}
        </select>
        {deviceMemory && deviceMemory.limitBytes > 0 && !outOfMemory ? (
          <span className="viewport-controls__hint">
            peak {formatMegabytes(deviceMemory.peakBytes)} of{" "}
            {formatMegabytes(deviceMemory.limitBytes)}
          </span>
        ) : null}
      </div>
      {outOfMemory ? (
        <div className="preview-notice preview-notice--error" role="status">
          <strong>Out of memory on the simulated device.</strong> The render
          asked for {formatMegabytes(outOfMemory.refusedBytes)} with a{" "}
          {formatMegabytes(outOfMemory.limitBytes)} ceiling and could not get
          it — this scene would fail on that frame. Restart the preview after
          changing the scene.
        </div>
      ) : null}
      {assetsOpen ? (
        <PreviewAssetsDialog
          assetsVersion={assetsVersion}
          onClose={() => setAssetsOpen(false)}
          preview={previewInstance}
        />
      ) : null}
      {lightboxOpen ? (
        <ImageLightbox
          alt="The rendered frame"
          height={viewport.height}
          label="Preview frame"
          liveCanvasRef={(canvas) => {
            lightboxCanvasRef.current = canvas;
            // First paint on mount; every later frame repaints via onFrame.
            paintLightbox();
          }}
          onClose={closeLightbox}
          width={viewport.width}
        />
      ) : null}
      {requiredSettings.length > 0 ? (
        <div className="card preview-settings">
          <h4 className="preview-settings__title">
            <KeyRound aria-hidden size={16} />
            {anyCredentialsFormShown
              ? "This scene uses services that need credentials"
              : "This scene uses keys saved in your account"}
          </h4>
          {anyCredentialsFormShown ? (
            <p className="copy preview-settings__hint">
              Keys saved in your{" "}
              {settingsUrl ? (
                <a href={settingsUrl} rel="noreferrer" target="_blank">
                  account settings
                </a>
              ) : (
                "account settings"
              )}{" "}
              are applied automatically. Anything typed here stays in this
              browser tab and is used only by the preview.
            </p>
          ) : null}
          {requiredSettings.map((group) =>
            credentialsFormShown(group) ? (
              <div className="preview-settings__group" key={group.key}>
                <span className="preview-settings__group-title">{group.title}</span>
                {group.fields.map((field) => {
                  const formKey = field.path.join(".");
                  return (
                    <label className="preview-settings__field" key={formKey}>
                      <span>{field.label}</span>
                      <input
                        autoComplete="off"
                        className="preview-settings__input"
                        onChange={(event) =>
                          setSettingsForm((form) => ({
                            ...form,
                            [formKey]: event.target.value,
                          }))
                        }
                        type={field.secret ? "password" : "text"}
                        value={settingsForm[formKey] ?? ""}
                      />
                    </label>
                  );
                })}
              </div>
            ) : (
              <div className="preview-settings__group preview-settings__group--stored" key={group.key}>
                <span className="preview-settings__stored">
                  <span className="preview-settings__group-title">{group.title}</span>
                  {" · "}
                  {joinNames(group.fields.map((field) => field.label))} from your account
                </span>
                <button
                  className="button button--subtle button--small"
                  onClick={() =>
                    setCredentialsExpanded((current) => ({ ...current, [group.key]: true }))
                  }
                  title={`Type a different ${group.title} key for this preview only`}
                  type="button"
                >
                  Use another key
                </button>
              </div>
            ),
          )}
          {anyCredentialsFormShown ? (
            <button
              className="button button--small"
              onClick={applySettings}
              type="button"
            >
              Apply &amp; reload preview
            </button>
          ) : null}
        </div>
      ) : null}
      {scenes ? (
        <div className="live-preview">
          <div className="live-preview__form">
            {runtimeScenes.length > 1 ? (
              <div className="live-preview__field">
                <label
                  className="live-preview__label"
                  htmlFor={`${fieldIdPrefix}-scene`}
                >
                  Scene
                </label>
                <select
                  className="live-preview__control"
                  id={`${fieldIdPrefix}-scene`}
                  onChange={(event) => selectScene(event.target.value)}
                  value={currentSceneId ?? ""}
                >
                  {runtimeScenes.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name || item.id}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {visibleFields.map((field) => (
              <StateFieldRow
                field={field}
                id={`${fieldIdPrefix}-${field.name}`}
                key={field.name}
                onChange={(value) => editField(field, value)}
                value={
                  field.name in edits ? edits[field.name] : fieldValues[field.name]
                }
              />
            ))}
          </div>
        </div>
      ) : null}
      <PreviewLog lines={logs} />
      <p className="copy live-preview-panel__footnote">
        Runs in your browser via WebAssembly. Scenes that fetch external data or use device-only
        apps may render incompletely.
      </p>
    </div>
  );
}

// "OpenAI" / "OpenAI and Immich" / "OpenAI, Immich and X".
function joinNames(names: string[]): string {
  if (names.length <= 1) {
    return names[0] ?? "a paid service";
  }
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function textValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function jsonFieldText(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isValidJson(text: string): boolean {
  if (text.trim() === "") {
    return true;
  }
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// "#rgb" / "#rrggbb" (case-insensitive) → "#rrggbb"; anything else null. The
// swatch input only accepts the long form, so names and rgba() stay text-only.
export function normalizeHexColor(text: string): string | null {
  const trimmed = text.trim();
  const long = /^#([0-9a-f]{6})$/i.exec(trimmed);
  if (long) {
    return `#${long[1]!.toLowerCase()}`;
  }
  const short = /^#([0-9a-f]{3})$/i.exec(trimmed);
  if (short) {
    return `#${short[1]!
      .toLowerCase()
      .split("")
      .map((digit) => digit + digit)
      .join("")}`;
  }
  return null;
}

type StateFieldRowProps = {
  field: StateField;
  id: string;
  value: unknown;
  onChange: (value: unknown) => void;
};

// One row of the state form: a label and the control for the field's type.
// Textareas (text, json) take the full width with the label above.
function StateFieldRow({ field, id, value, onChange }: StateFieldRowProps) {
  const label = field.label || field.name;
  const type = field.type ?? "string";

  if (type === "json" || type === "text") {
    const text = type === "json" ? jsonFieldText(value) : textValue(value);
    const invalid = type === "json" && !isValidJson(text);
    return (
      <div className="live-preview__field live-preview__field--wide">
        <label className="live-preview__label" htmlFor={id}>
          {label}
        </label>
        <textarea
          aria-invalid={invalid || undefined}
          className={`live-preview__control live-preview__textarea${
            type === "json" ? " live-preview__textarea--code" : ""
          }${invalid ? " live-preview__control--invalid" : ""}`}
          id={id}
          onChange={(event) => onChange(event.target.value)}
          rows={type === "json" ? 8 : 3}
          spellCheck={type === "json" ? false : undefined}
          value={text}
        />
      </div>
    );
  }

  let control: ReactNode;
  if (type === "boolean") {
    const checked = value === true || value === "true";
    control = (
      <div className="live-preview__checkbox-row">
        <input
          checked={checked}
          className="live-preview__checkbox"
          id={id}
          onChange={(event) => onChange(event.target.checked)}
          type="checkbox"
        />
        <label className="live-preview__checkbox-label" htmlFor={id}>
          {checked ? "Yes" : "No"}
        </label>
      </div>
    );
  } else if (type === "select" || type === "font") {
    const options = selectFieldOptions(field.options);
    const current = textValue(value);
    control = (
      <select
        className="live-preview__control"
        id={id}
        onChange={(event) => onChange(event.target.value)}
        value={current}
      >
        {options.some((option) => option.value === current) ? null : (
          <option value={current}>{current || "—"}</option>
        )}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  } else if (type === "color") {
    // Swatch and hex text stay in sync: both edit the same value; the swatch
    // shows the last valid colour when the text is mid-edit or not a hex.
    const text = textValue(value);
    const hex = normalizeHexColor(text);
    control = (
      <div className="live-preview__color">
        <input
          aria-label={`${label} swatch`}
          className="live-preview__swatch"
          onChange={(event) => onChange(event.target.value)}
          type="color"
          value={hex ?? "#000000"}
        />
        <input
          autoComplete="off"
          className="live-preview__control live-preview__hex"
          id={id}
          onChange={(event) => onChange(event.target.value)}
          placeholder="#rrggbb"
          spellCheck={false}
          type="text"
          value={text}
        />
      </div>
    );
  } else {
    control = (
      <input
        className="live-preview__control"
        id={id}
        onChange={(event) => onChange(event.target.value)}
        placeholder={field.placeholder}
        step={type === "float" ? "any" : type === "integer" ? 1 : undefined}
        type={
          type === "integer" || type === "float"
            ? "number"
            : type === "date"
              ? "date"
              : "text"
        }
        value={textValue(value)}
      />
    );
  }

  return (
    <div className="live-preview__field">
      {type === "boolean" ? (
        <span className="live-preview__label">{label}</span>
      ) : (
        <label className="live-preview__label" htmlFor={id}>
          {label}
        </label>
      )}
      {control}
    </div>
  );
}
