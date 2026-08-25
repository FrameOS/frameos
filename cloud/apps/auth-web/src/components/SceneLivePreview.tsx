"use client";

import {
  coerceStateFieldValue,
  evaluateShowIf,
  FrameOSPreview,
  sceneEventButtons,
  stateFieldShowIfValues,
  type FrameOSScene,
  type SceneInfo,
  type StateField,
} from "frameos-wasm";
import {
  Camera,
  ImageDown,
  KeyRound,
  RectangleHorizontal,
  RectangleVertical,
  RotateCw,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { formatDate } from "../lib/format";
import {
  requiredSettingsForScenes,
  type PreviewSettingsGroup,
} from "../lib/preview-settings";

/** One published version of the scene, as listed in the source dropdown. */
export type SceneVersionOption = {
  version: number;
  /** ISO timestamp (serialisable from the server component). */
  createdAt: string;
  /** ISO timestamp when unpublished (yanked), null otherwise. */
  yankedAt: string | null;
};

/** What the panel runs: the editor's unsaved scenes, or one published
 * version (null = whatever scenes.json serves without `?version=`). */
export type PreviewSource = { kind: "editor" } | { kind: "version"; version: number | null };

type SceneLivePreviewPanelProps = {
  /** The store scene, or null for a scene that is not saved yet (then only
   * the editor source exists and screenshots cannot go to a gallery). */
  sceneId: string | null;
  /** The editor's current scenes, as last reported by onScenesChanged. The
   * runtime reloads (debounced) whenever their content changes. null when
   * there is no editor to preview. */
  scenes?: readonly SceneJsonLike[] | null | undefined;
  /** The scene selected in the editor — the runtime shows that one. */
  editorSceneId?: string | null | undefined;
  width?: number | null | undefined;
  height?: number | null | undefined;
  /** Owner-only: shows "Save to images", which uploads the current frame to
   * the scene's image gallery. "Download PNG" is there for everyone. */
  canSaveToGallery?: boolean | undefined;
  /** Share token for private scenes, so shared visitors can load scenes.json. */
  share?: string | undefined;
  /** The scene's versions (any order); lists them as sources. */
  versions?: readonly SceneVersionOption[] | undefined;
  /** The version the page is pinned to via ?version=N, when it is not the
   * latest — the "version" source starts there. */
  pinnedVersion?: number | null | undefined;
  /** Which source to start on. Default: the editor when it has scenes,
   * else the pinned/latest version. */
  initialSource?: "editor" | "version" | undefined;
};

type SceneJsonLike = { id: string } & Record<string, unknown>;

const noVersions: SceneVersionOption[] = [];
const maxLogLines = 200;
/** Editor edits arrive debounced already; this keeps a burst of them from
 * booting the runtime more than once. */
export const EDITOR_RELOAD_DEBOUNCE_MS = 700;
/** How long a transient notice ("Screenshot downloaded.") stays up. */
export const NOTICE_HIDE_MS = 4000;
const editorSourceValue = "editor";
const serverDefaultVersionValue = "";

function sourceValue(source: PreviewSource): string {
  if (source.kind === "editor") {
    return editorSourceValue;
  }
  return source.version === null ? serverDefaultVersionValue : String(source.version);
}

function sourceFromValue(value: string): PreviewSource {
  if (value === editorSourceValue) {
    return { kind: "editor" };
  }
  return { kind: "version", version: value === serverDefaultVersionValue ? null : Number(value) };
}

// Runs a scene in the browser through the frameos-wasm runtime: canvas,
// showIf-aware state fields, event buttons, and logs — no frame needed. The
// runtime assets are copied into /frameos-wasm by scripts/copy-wasm-assets.mjs.
// Rendered as a side column of the scene editor (SceneEditorWorkspace); the
// control surface uses the store's form styling rather than the package's
// own mountFrameOSManager.
export function SceneLivePreviewPanel({
  sceneId,
  scenes: editorScenesProp = null,
  editorSceneId = null,
  width,
  height,
  canSaveToGallery = false,
  share,
  versions = noVersions,
  pinnedVersion = null,
  initialSource,
}: SceneLivePreviewPanelProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savingShot, setSavingShot] = useState(false);
  // The frame blown up over the page (a click on the canvas): the captured
  // PNG as a data URL (the CSP's img-src allows data:, not blob:), shown
  // fitted to the viewport or at 1:1.
  const [lightbox, setLightbox] = useState<{ url: string; fit: boolean } | null>(null);

  // A notice ("Screenshot downloaded.") is transient: it goes away on its
  // own, or sooner with its × button.
  useEffect(() => {
    if (notice === null) {
      return;
    }
    const timer = setTimeout(() => setNotice(null), NOTICE_HIDE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  // Newest first; "latest" is what an unversioned fetch would serve.
  const sortedVersions = useMemo(
    () => [...versions].sort((a, b) => b.version - a.version),
    [versions],
  );
  const latestVersion =
    sortedVersions.find((candidate) => !candidate.yankedAt)?.version ?? null;
  const hasEditorSource = editorScenesProp !== null;
  const hasVersionSource = sceneId !== null;
  const [source, setSource] = useState<PreviewSource>(() =>
    hasEditorSource && (initialSource !== "version" || !hasVersionSource)
      ? { kind: "editor" }
      : { kind: "version", version: pinnedVersion ?? latestVersion },
  );

  // The editor's scenes, committed to the runtime after a quiet period. The
  // first payload lands at once (nothing is running yet); later ones only
  // when their content actually differs from what runs.
  const [editorScenes, setEditorScenes] = useState<FrameOSScene[] | null>(null);
  const committedEditorJsonRef = useRef("");
  useEffect(() => {
    if (!editorScenesProp) {
      return;
    }
    const json = JSON.stringify(editorScenesProp);
    if (json === committedEditorJsonRef.current) {
      return;
    }
    const commit = () => {
      committedEditorJsonRef.current = json;
      setEditorScenes(editorScenesProp as unknown as FrameOSScene[]);
    };
    if (committedEditorJsonRef.current === "") {
      commit();
      return;
    }
    const timer = setTimeout(commit, EDITOR_RELOAD_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [editorScenesProp]);

  // A published version's scenes.json; cleared when the version changes so
  // the fetch effect below reloads it.
  const [fetchedScenes, setFetchedScenes] = useState<FrameOSScene[] | null>(null);
  const scenes = source.kind === "editor" ? editorScenes : fetchedScenes;

  // The viewport applied to the running preview, and the form values being
  // typed (applied on "Resize").
  const [viewport, setViewport] = useState({
    height: height || 480,
    width: width || 800,
  });
  const [viewportForm, setViewportForm] = useState(viewport);

  // Bumped by the Restart button; recreates the whole wasm runtime.
  const [restartCount, setRestartCount] = useState(0);

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

  // Runtime plumbing: the canvas the worker paints onto, the live preview
  // handle, and what the runtime has reported so far.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewRef = useRef<FrameOSPreview | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);
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
  const [logs, setLogs] = useState<string[]>([]);
  const fieldIdPrefix = useId();
  const editorSceneIdRef = useRef(editorSceneId);
  editorSceneIdRef.current = editorSceneId;
  const sourceRef = useRef(source);
  sourceRef.current = source;

  // Loads the selected version's scenes.json; switching versions clears
  // `fetchedScenes`, which re-runs this with the new `?version=`.
  useEffect(() => {
    if (source.kind !== "version" || sceneId === null || fetchedScenes !== null) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const params = new URLSearchParams();
        if (source.version !== null) {
          params.set("version", String(source.version));
        }
        if (share) {
          params.set("share", share);
        }
        const query = params.toString();
        const response = await fetch(
          `/api/store/scenes/${sceneId}/scenes.json${query ? `?${query}` : ""}`,
        );
        if (!response.ok) {
          throw new Error(`Could not load the scene (${response.status})`);
        }
        const loaded = (await response.json()) as FrameOSScene[];
        if (!cancelled) {
          setFetchedScenes(loaded);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, fetchedScenes, sceneId, share]);

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
    if (!scenes || storedSettings === null || !canvasRef.current) {
      return;
    }
    let cancelled = false;
    let preview: FrameOSPreview | null = null;
    setHasPaintedFrame(false);
    setSceneInfo(null);
    setRuntimeState({});
    setLogs([]);
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
    const appendLog = (line: string) => {
      if (cancelled) {
        return;
      }
      setLogs((previous) => {
        const next = [...previous, line];
        return next.length > maxLogLines ? next.slice(-maxLogLines) : next;
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
        onReady: (info) => {
          if (cancelled || !preview) {
            return;
          }
          setSceneInfo(info ?? null);
          setStatus("");
          // Previewing the editor: show the scene being edited, not the
          // default one, when the editor has several.
          const wanted = editorSceneIdRef.current;
          const wantedExists =
            sourceRef.current.kind === "editor" &&
            wanted !== null &&
            scenes.some((scene) => scene.id === wanted);
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
          setStatus(
            `Rendered ${frame.width}×${frame.height} in ${frame.renderMs} ms`,
          );
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    return () => {
      cancelled = true;
      preview?.destroy();
      if (previewRef.current === preview) {
        previewRef.current = null;
      }
    };
  }, [scenes, viewport, storedSettings, previewSettings, restartCount]);

  // The editor switched scenes while the runtime is up: follow it.
  const runtimeReady = sceneInfo !== null;
  useEffect(() => {
    if (
      !runtimeReady ||
      source.kind !== "editor" ||
      !editorSceneId ||
      !scenes?.some((scene) => scene.id === editorSceneId)
    ) {
      return;
    }
    setCurrentSceneId((current) => {
      if (current !== editorSceneId) {
        previewRef.current?.selectScene(editorSceneId);
      }
      return editorSceneId;
    });
  }, [runtimeReady, source.kind, editorSceneId, scenes]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

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

  function selectSource(value: string) {
    const next = sourceFromValue(value);
    if (sourceValue(next) === sourceValue(source)) {
      return;
    }
    setSource(next);
    setError(null);
    setNotice(null);
    if (next.kind === "version") {
      // Clearing the scenes stops the runtime and re-fetches scenes.json for
      // the new version (same path as the initial load).
      setFetchedScenes(null);
    }
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
    setLightbox(null);
  }

  function openLightbox() {
    if (!hasPaintedFrame) {
      return;
    }
    const flattened = flattenFrame();
    if (!flattened) {
      return;
    }
    setLightbox({ fit: true, url: flattened.toDataURL("image/png") });
  }

  useEffect(() => {
    if (!lightbox) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeLightbox();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [lightbox !== null]);

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
      if (response.ok) {
        setNotice("Screenshot saved to the scene's images.");
        // The gallery behind the editor shows it as soon as it closes.
        router.refresh();
      } else {
        const payload = await response.json().catch(() => ({}));
        setError(`Saving screenshot failed: ${payload.error ?? response.status}`);
      }
    } finally {
      setSavingShot(false);
    }
  }

  const runtimeScenes = sceneInfo?.scenes ?? [];
  const sourceOptions: { label: string; value: string }[] = [];
  if (hasEditorSource) {
    sourceOptions.push({ label: "Editor (unsaved)", value: editorSourceValue });
  }
  if (hasVersionSource) {
    if (sortedVersions.length > 0) {
      for (const candidate of sortedVersions) {
        sourceOptions.push({
          label: versionLabel(candidate, latestVersion),
          value: String(candidate.version),
        });
      }
    } else if (!hasEditorSource || source.kind === "version") {
      sourceOptions.push({ label: "Published", value: serverDefaultVersionValue });
    }
  }
  // Typed into the form but not sent yet (an applied edit is dropped as
  // soon as the runtime confirms it, see onState).
  const hasUnappliedEdits = Object.entries(edits).some(
    ([key, value]) => String(runtimeState[key] ?? "") !== String(value ?? ""),
  );
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
        <label className="live-preview-panel__source">
          <span className="live-preview__label">Source</span>
          <select
            aria-label="Preview source"
            className="live-preview__version"
            disabled={sourceOptions.length <= 1}
            onChange={(event) => selectSource(event.target.value)}
            title="What the preview runs: the editor's current state, or a published version"
            value={sourceValue(source)}
          >
            {sourceOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <div className="button-row live-preview-panel__actions">
          <button
            aria-label="Restart"
            className="button button--subtle button--small"
            onClick={() => {
              setError(null);
              setRestartCount((count) => count + 1);
            }}
            title="Restart: reload the wasm FrameOS runtime from scratch"
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
                <button
                  className="button button-primary button--small"
                  disabled={!runtimeReady}
                  onClick={applyState}
                  type="button"
                >
                  Apply &amp; render
                </button>
                {hasUnappliedEdits ? (
                  <span className="live-preview-panel__unapplied" role="status">
                    unapplied changes
                  </span>
                ) : null}
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
          </div>
        ) : null}
      </div>
      <div className="live-preview">
        <div className="live-preview__stage">
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
          {scenes === null ? "Loading the scene…" : status}
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
      {lightbox
        ? createPortal(
            // The overlay lives on <body>: the editor frame's transform would
            // otherwise keep a fixed element inside the panel column.
            <div
              aria-label="Preview frame"
              aria-modal
              className="lightbox"
              onClick={closeLightbox}
              role="dialog"
            >
              <button
                aria-label="Close"
                className="lightbox__close"
                onClick={closeLightbox}
                type="button"
              >
                <X aria-hidden size={20} />
              </button>
              <div className="lightbox__hint">
                {viewport.width} × {viewport.height} ·{" "}
                {lightbox.fit ? "click the image for 1:1" : "click the image to fit"} · Esc to close
              </div>
              <div className={`lightbox__body${lightbox.fit ? " lightbox__body--fit" : ""}`}>
                <img
                  alt="The rendered frame"
                  className={`lightbox__image${lightbox.fit ? " lightbox__image--fit" : ""}`}
                  height={viewport.height}
                  onClick={(event) => {
                    event.stopPropagation();
                    setLightbox((current) => (current ? { ...current, fit: !current.fit } : current));
                  }}
                  src={lightbox.url}
                  width={viewport.width}
                />
              </div>
            </div>,
            document.body,
          )
        : null}
      {requiredSettings.length > 0 ? (
        <div className="card preview-settings">
          <h4 className="preview-settings__title">
            <KeyRound aria-hidden size={16} />
            This scene uses services that need credentials
          </h4>
          <p className="copy preview-settings__hint">
            Keys saved in your account settings are applied automatically.
            Anything typed here stays in this browser tab and is used only by
            the preview.
          </p>
          {requiredSettings.map((group) => (
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
          ))}
          <button
            className="button button--small"
            onClick={applySettings}
            type="button"
          >
            Apply &amp; reload preview
          </button>
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
      <pre className="live-preview__logs" ref={logRef}>
        {logs.join("\n")}
      </pre>
      <p className="copy live-preview-panel__footnote">
        Runs in your browser via WebAssembly. Scenes that fetch external data or use device-only
        apps may render incompletely.
      </p>
    </div>
  );
}

// "v3 · 24 Aug 2026 · latest" — the same date wording as the Versions table.
function versionLabel(
  candidate: SceneVersionOption,
  latestVersion: number | null,
): string {
  const parts = [`v${candidate.version}`, formatDate(new Date(candidate.createdAt))];
  if (candidate.yankedAt) {
    parts.push("unpublished");
  } else if (candidate.version === latestVersion) {
    parts.push("latest");
  }
  return parts.join(" · ");
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
    const options = field.options ?? [];
    const current = textValue(value);
    control = (
      <select
        className="live-preview__control"
        id={id}
        onChange={(event) => onChange(event.target.value)}
        value={current}
      >
        {options.includes(current) ? null : (
          <option value={current}>{current || "—"}</option>
        )}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
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
