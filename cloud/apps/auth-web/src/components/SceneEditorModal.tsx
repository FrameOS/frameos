"use client";

import type { EmbeddedSceneEditorApi } from "frameos-editor/react";
import { FileArchive, GitFork, Pencil, Play, Save, Sparkles, X } from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { applyAiScenes, type AiScenesEvent, type SceneJson } from "../lib/ai-scenes-apply";
import {
  livePreviewHash,
  sceneEditorAiHash,
  sceneEditorHash,
  sceneEditorHashFor,
  sceneEditorPanelsForHash,
  sceneEditorPreviewHash,
  type SceneEditorPanels,
} from "../lib/scene-views";
import { SceneAiPanel, type SceneAiPanelProps } from "./SceneAiPanel";
import { SceneLivePreviewPanel, type SceneVersionOption } from "./SceneLivePreview";

// The FrameOS scene editor as a plain React component in this app's tree
// (react/react-dom are externalized in its bundle — one React). It is
// browser-only (kea, Monaco, wasm), hence the ssr: false dynamic import.
const EmbeddedSceneEditor = dynamic(
  () => import("frameos-editor/react").then((module) => module.EmbeddedSceneEditor),
  { ssr: false },
);

type SceneEditorModalProps = {
  sceneId: string;
  width?: number | null;
  height?: number | null;
  /** Store listing description, shown in the editor's Scene settings panel
   * (scenes.json itself doesn't carry one). */
  description?: string | null;
  /** Owner-only: offer "Save as new version". Everyone else gets the diagram
   * as an explorable playground — edits stay in the browser. */
  canSave?: boolean;
  /** Signed-in users can fork: save the (edited) scenes as a new private
   * scene under their own account. */
  canFork?: boolean;
  /** Offer "Remix with AI" next to the edit link (active scenes only). The
   * AI panel itself is available to everyone; signed-out visitors see the
   * sign-in prompt inside it. */
  canRemix?: boolean;
  /** Offer "Live preview" (the editor with its Preview panel); pulled
   * scenes don't get one. */
  canPreview?: boolean;
  signedIn?: boolean;
  /** Share token for private scenes, so shared visitors can load scenes.json. */
  share?: string | undefined;
  /** The store zip of the scene as the page shows it (its "Download zip"
   * link: pinned version and share token included), offered in the bar. */
  downloadUrl?: string | undefined;
  /** Where the OpenAI key is set (the fleet workspace's settings page). */
  settingsUrl?: string | undefined;
  /** The sign-in page; the AI panel appends `return_to`. */
  loginUrl?: string | undefined;
  /** The scene's published versions, for the Preview panel's source list. */
  versions?: SceneVersionOption[] | undefined;
  /** The version the page is pinned to via ?version=N (not the latest):
   * the Preview panel then starts on it rather than on the editor. */
  pinnedVersion?: number | null | undefined;
};

export type { EmbeddedSceneEditorApi, SceneJson };

/** The name of a scene as the editor bar shows it (null: no such scene yet). */
export function sceneNameFor(scenes: SceneJson[] | null, sceneId: string | null): string | null {
  if (!scenes || scenes.length === 0) {
    return null;
  }
  const scene = scenes.find((candidate) => candidate.id === sceneId) ?? scenes[0];
  if (!scene) {
    return null;
  }
  return typeof scene.name === "string" && scene.name.trim() ? scene.name : "Untitled scene";
}

type SceneNameTitleProps = {
  /** null while the scenes are still loading. */
  name: string | null;
  onRename: (name: string) => void;
};

// The editor bar's title: the selected scene's name, renamed in place with
// the pencil (Enter / blur commit, Esc cancels, an empty name is refused).
export function SceneNameTitle({ name, onRename }: SceneNameTitleProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  // Set synchronously by commit/cancel: the input's blur can still fire
  // while it unmounts, and must not commit (or cancel) a second time.
  const editingRef = useRef(false);

  function start() {
    if (name === null) {
      return;
    }
    editingRef.current = true;
    setInvalid(false);
    setDraft(name);
  }

  function cancel() {
    editingRef.current = false;
    setInvalid(false);
    setDraft(null);
  }

  /** Commits the draft; an empty name stays in the input, flagged. */
  function commit(): boolean {
    if (draft === null) {
      return false;
    }
    const next = draft.trim();
    if (!next) {
      setInvalid(true);
      return false;
    }
    editingRef.current = false;
    setDraft(null);
    if (next !== name) {
      onRename(next);
    }
    return true;
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  }

  function onBlur() {
    if (!editingRef.current) {
      return;
    }
    // Leaving the field with nothing in it is a cancel, not a rename.
    if (!commit()) {
      cancel();
    }
  }

  if (draft !== null) {
    return (
      <input
        aria-invalid={invalid || undefined}
        aria-label="Scene name"
        autoFocus
        className="input editor-modal__name-input"
        onBlur={onBlur}
        onChange={(event) => {
          setInvalid(false);
          setDraft(event.target.value);
        }}
        onFocus={(event) => event.target.select()}
        onKeyDown={onKeyDown}
        placeholder="Scene name"
        value={draft}
      />
    );
  }

  return (
    <span className="editor-modal__name">
      <span className="editor-modal__name-text" onDoubleClick={start} title={name ?? undefined}>
        {name ?? "Scene editor"}
      </span>
      <button
        aria-label="Rename scene"
        className="editor-modal__name-edit"
        disabled={name === null}
        onClick={start}
        title="Rename scene"
        type="button"
      >
        <Pencil aria-hidden size={14} />
      </button>
    </span>
  );
}

export type SceneEditorScreenshotHandler = (
  dataUrl: string,
  sceneId: string | null,
) => Promise<{ ok: boolean; error?: string | undefined; fallbackDownload?: boolean | undefined }>;

// The editor's assets (Monaco workers, wasm preview runtime, stylesheet) are
// copied to /frameos-editor by scripts/copy-editor-assets.mjs; the bundle
// resolves them against this path.
const EDITOR_ASSET_PATH = "/frameos-editor";

if (typeof window !== "undefined") {
  const anyWindow = window as unknown as Record<string, unknown>;
  const config = (anyWindow.FRAMEOS_APP_CONFIG = anyWindow.FRAMEOS_APP_CONFIG || {}) as Record<string, unknown>;
  config.ingress_path = EDITOR_ASSET_PATH;
}

// The editor's stylesheet is global (tailwind preflight included), so it is
// only linked while the full-screen editor is open and removed on close.
export function useEditorStylesheet(open: boolean) {
  useEffect(() => {
    if (!open) {
      return;
    }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `${EDITOR_ASSET_PATH}/static/lib.css`;
    document.head.appendChild(link);
    const html = document.documentElement;
    const previousTheme = html.dataset.frameosTheme;
    html.dataset.frameosTheme = html.classList.contains("theme-dark") ? "dark" : "light";
    return () => {
      link.remove();
      if (previousTheme === undefined) {
        delete html.dataset.frameosTheme;
      } else {
        html.dataset.frameosTheme = previousTheme;
      }
    };
  }, [open]);
}

/** The page's current theme, as the editor and the AI panel want it. */
export function readDocumentTheme(): "light" | "dark" {
  return document.documentElement.classList.contains("theme-dark") ? "dark" : "light";
}

/** Which side panels were open last time; remembered per browser. */
export const PANELS_STORAGE_KEY = "frameos:scene-editor-panels";
const noPanels: SceneEditorPanels = { ai: false, preview: false };
/** First visit (nothing remembered): the diagram with just the preview. */
const defaultPanels: SceneEditorPanels = { ai: false, preview: true };

export function readStoredPanels(): SceneEditorPanels {
  try {
    const raw = window.localStorage.getItem(PANELS_STORAGE_KEY);
    if (!raw) {
      return defaultPanels;
    }
    const parsed = JSON.parse(raw) as Partial<SceneEditorPanels> | null;
    if (!parsed || typeof parsed !== "object") {
      return defaultPanels;
    }
    return { ai: parsed.ai === true, preview: parsed.preview === true };
  } catch {
    return defaultPanels;
  }
}

export function storePanels(panels: SceneEditorPanels) {
  try {
    window.localStorage.setItem(PANELS_STORAGE_KEY, JSON.stringify(panels));
  } catch {
    // Private mode / storage disabled: the panels just don't persist.
  }
}

const AI_PANEL_MIN_WIDTH = 300;
const AI_PANEL_MAX_WIDTH = 640;
const AI_PANEL_DEFAULT_WIDTH = 380;
const PREVIEW_PANEL_MIN_WIDTH = 320;
const PREVIEW_PANEL_MAX_WIDTH = 900;
const PREVIEW_PANEL_DEFAULT_WIDTH = 520;

// A side column width the user can drag (the handle sits on the column's
// left edge, so dragging left widens it).
function useResizableWidth(defaultWidth: number, minWidth: number, maxWidth: number) {
  const [width, setWidth] = useState(defaultWidth);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  return {
    width,
    onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
      dragRef.current = { startWidth: width, startX: event.clientX };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }
      const next = drag.startWidth + (drag.startX - event.clientX);
      setWidth(Math.min(maxWidth, Math.max(minWidth, Math.round(next))));
    },
    onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
      dragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
  };
}

type PanelResizerProps = {
  label: string;
  resize: ReturnType<typeof useResizableWidth>;
};

function PanelResizer({ label, resize }: PanelResizerProps) {
  return (
    <div
      aria-label={label}
      aria-orientation="vertical"
      className="editor-modal__resizer"
      onPointerCancel={resize.onPointerUp}
      onPointerDown={resize.onPointerDown}
      onPointerMove={resize.onPointerMove}
      onPointerUp={resize.onPointerUp}
      role="separator"
    />
  );
}

export type SceneEditorPreviewOptions = {
  /** The store scene (null for a scene that is not saved yet). */
  sceneId: string | null;
  /** The editor's current scenes, kept up to date while the panel is open. */
  scenes: SceneJson[] | null;
  canSaveToGallery?: boolean | undefined;
  share?: string | undefined;
  versions?: SceneVersionOption[] | undefined;
  pinnedVersion?: number | null | undefined;
  initialSource?: "editor" | "version" | undefined;
};

type SceneEditorWorkspaceProps = {
  /** null while loading. */
  scenes: SceneJson[] | null;
  /** The scene to select in the editor (after an AI build: the new one). */
  sceneId?: string | null | undefined;
  width: number;
  height: number;
  theme: "light" | "dark";
  description?: string | undefined;
  onScenesChanged: (scenes: SceneJson[]) => void;
  /** The editor's scene tabs: which scene the user is looking at. */
  onSelectedSceneChanged?: ((sceneId: string | null) => void) | undefined;
  onSaveScreenshot?: SceneEditorScreenshotHandler | undefined;
  /** Filled with the mounted editor's API (rename in place). */
  editorApiRef?: { current: EmbeddedSceneEditorApi | null } | undefined;
  panels: SceneEditorPanels;
  ai: Omit<SceneAiPanelProps, "width" | "height" | "selectedSceneId">;
  preview: SceneEditorPreviewOptions;
};

/** The three-way panel switch in the modal bar: Preview and AI, each on or
 * off independently (the diagram is always there). */
export function SceneEditorPanelToggles({
  panels,
  onToggle,
}: {
  panels: SceneEditorPanels;
  onToggle: (panel: keyof SceneEditorPanels) => void;
}) {
  return (
    <div aria-label="Side panels" className="view-toggle editor-modal__panels" role="group">
      <button
        aria-pressed={panels.ai}
        className="view-toggle__button"
        onClick={() => onToggle("ai")}
        title={panels.ai ? "Hide the AI assistant" : "Show the AI assistant"}
        type="button"
      >
        <Sparkles aria-hidden size={15} />
        AI
      </button>
      <button
        aria-pressed={panels.preview}
        className="view-toggle__button"
        onClick={() => onToggle("preview")}
        title={panels.preview ? "Hide the live preview" : "Show the live preview next to the diagram"}
        type="button"
      >
        <Play aria-hidden size={15} />
        Preview
      </button>
    </div>
  );
}

// The editor area below a modal bar: the embedded FrameOS editor and — when
// open — the AI panel and/or the live preview (rightmost) as side columns
// the user can drag wider or narrower. Shared by the store scene's editor modal and the
// "new scene" page.
export function SceneEditorWorkspace({
  scenes,
  sceneId,
  width,
  height,
  theme,
  description,
  onScenesChanged,
  onSelectedSceneChanged,
  onSaveScreenshot,
  editorApiRef,
  panels,
  ai,
  preview,
}: SceneEditorWorkspaceProps) {
  const previewResize = useResizableWidth(
    PREVIEW_PANEL_DEFAULT_WIDTH,
    PREVIEW_PANEL_MIN_WIDTH,
    PREVIEW_PANEL_MAX_WIDTH,
  );
  const aiResize = useResizableWidth(AI_PANEL_DEFAULT_WIDTH, AI_PANEL_MIN_WIDTH, AI_PANEL_MAX_WIDTH);
  const openCount = Number(panels.preview) + Number(panels.ai);
  // Column order: diagram, AI, Preview (the preview is always rightmost).
  const columns = ["minmax(0, 1fr)"];
  if (panels.ai) {
    columns.push("6px", `${aiResize.width}px`);
  }
  if (panels.preview) {
    columns.push("6px", `${previewResize.width}px`);
  }

  return (
    <div
      className={
        openCount === 0
          ? "editor-modal__frame"
          : `editor-modal__frame editor-modal__frame--with-panels editor-modal__frame--panels-${openCount}`
      }
      style={openCount > 0 ? { gridTemplateColumns: columns.join(" ") } : undefined}
    >
      <div className="editor-modal__editor">
        {scenes ? (
          <EmbeddedSceneEditor
            scenes={scenes}
            sceneId={sceneId ?? undefined}
            width={width}
            height={height}
            mode="rpios"
            theme={theme}
            // The editor's own wasm preview is hidden (showPreviewButton):
            // the Preview panel here does that job. Its render-check and
            // image nodes still route CORS-blocked fetches through this.
            previewProxyUrl="/api/store/preview-proxy"
            description={description}
            onScenesChanged={(nextScenes) => onScenesChanged(nextScenes as SceneJson[])}
            onSelectedSceneChanged={onSelectedSceneChanged}
            onSaveScreenshot={onSaveScreenshot}
            apiRef={editorApiRef}
            showPreviewButton={false}
          />
        ) : null}
      </div>
      {panels.ai ? (
        <>
          <PanelResizer label="Resize the AI panel" resize={aiResize} />
          <aside aria-label="AI assistant" className="editor-modal__ai">
            <SceneAiPanel {...ai} height={height} selectedSceneId={sceneId ?? null} width={width} />
          </aside>
        </>
      ) : null}
      {panels.preview ? (
        <>
          <PanelResizer label="Resize the preview panel" resize={previewResize} />
          <aside aria-label="Live preview" className="editor-modal__preview">
            {/* Mounted once the editor has scenes, so the panel's first
                source choice sees them (it is made on mount). */}
            {preview.scenes ? (
              <SceneLivePreviewPanel
                canSaveToGallery={preview.canSaveToGallery}
                editorSceneId={sceneId ?? null}
                height={height}
                initialSource={preview.initialSource}
                pinnedVersion={preview.pinnedVersion}
                sceneId={preview.sceneId}
                scenes={preview.scenes}
                share={preview.share}
                versions={preview.versions}
                width={width}
              />
            ) : null}
          </aside>
        </>
      ) : null}
    </div>
  );
}

// Owner scene editing via the FrameOS editor rendered as a component in this
// page's React tree. Saving publishes the edited scenes as a new immutable
// version. The Preview panel runs the editor's unsaved state (or a published
// version) next to the diagram; the AI panel edits the same scenes; Save /
// Fork then do the rest.
export function SceneEditorModal({
  sceneId,
  width,
  height,
  description,
  canSave = false,
  canFork = false,
  canRemix = false,
  canPreview = false,
  signedIn = canFork,
  share,
  downloadUrl,
  settingsUrl,
  loginUrl,
  versions,
  pinnedVersion = null,
}: SceneEditorModalProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [panels, setPanels] = useState<SceneEditorPanels>(noPanels);
  const [initialPrompt, setInitialPrompt] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [forking, setForking] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [scenes, setScenes] = useState<SceneJson[] | null>(null);
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  // The selected scene's name, as the bar shows it; follows the editor's
  // edits (its own Rename included) and the scene tabs.
  const [sceneName, setSceneName] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  // The editor's latest scenes as state, for the Preview panel; only kept
  // up to date while that panel is open (each update re-renders the modal).
  const [previewScenes, setPreviewScenes] = useState<SceneJson[] | null>(null);
  const latestScenesRef = useRef<SceneJson[] | null>(null);
  const editorApiRef = useRef<EmbeddedSceneEditorApi | null>(null);
  const selectedSceneIdRef = useRef<string | null>(null);
  const initialJsonRef = useRef<string>("");
  // The editor echoes the scenes it was handed (normalised: defaults filled
  // in, positions settled) as its first onScenesChanged; that echo, not the
  // raw scenes.json, is what "unchanged" means for the dirty check.
  const baselinePendingRef = useRef(false);
  const panelsRef = useRef(panels);
  panelsRef.current = panels;
  selectedSceneIdRef.current = selectedSceneId;
  useEditorStylesheet(open);

  // The editor's current scenes, wherever they come from (the initial load,
  // the editor's edits, the AI): the source of truth for Save / Fork / AI
  // and, while it is open, the Preview panel.
  function publishScenes(next: SceneJson[] | null) {
    latestScenesRef.current = next;
    setSceneName(sceneNameFor(next, selectedSceneIdRef.current));
    if (panelsRef.current.preview || next === null) {
      setPreviewScenes(next);
    }
  }

  function selectScene(nextSceneId: string | null) {
    selectedSceneIdRef.current = nextSceneId;
    setSelectedSceneId(nextSceneId);
    setSceneName(sceneNameFor(latestScenesRef.current, nextSceneId));
  }

  // The bar's pencil: rename the selected scene. Through the mounted editor
  // (its form updates in place, the diagram keeps its layout, and the edit
  // echoes back through onScenesChanged); before it has mounted, by handing
  // it the renamed scenes to start from.
  function renameScene(name: string) {
    const current = latestScenesRef.current;
    const targetId = selectedSceneIdRef.current ?? current?.[0]?.id ?? null;
    if (!current || targetId === null) {
      return;
    }
    const next = current.map((scene) => (scene.id === targetId ? { ...scene, name } : scene));
    publishScenes(next);
    setDirty(JSON.stringify(next) !== initialJsonRef.current);
    if (editorApiRef.current) {
      editorApiRef.current.renameScene(targetId, name);
    } else {
      baselinePendingRef.current = false;
      setScenes(next);
    }
  }

  useEffect(() => {
    if (!open) {
      return;
    }
    setTheme(readDocumentTheme());
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(
          `/api/store/scenes/${sceneId}/scenes.json${share ? `?share=${encodeURIComponent(share)}` : ""}`,
        );
        if (!response.ok) {
          throw new Error(`Could not load the scene (${response.status})`);
        }
        const loaded = (await response.json()) as SceneJson[];
        if (cancelled) {
          return;
        }
        latestScenesRef.current = loaded;
        setPreviewScenes(loaded);
        initialJsonRef.current = JSON.stringify(loaded);
        baselinePendingRef.current = true;
        setScenes(loaded);
        const defaultScene = loaded.find((scene) => scene.default === true) ?? loaded[0];
        selectScene(defaultScene?.id ?? null);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, sceneId, share]);

  // The editor captured a frame (its render check, or the JSON panel's
  // screenshot). Owners get it saved to the scene's image gallery; everyone
  // else gets ok:false and the editor falls back to downloading the PNG.
  async function saveScreenshot(dataUrl: string) {
    if (!canSave) {
      return { ok: false, error: "Only the scene owner can save to its images" };
    }
    if (!dataUrl.startsWith("data:image/png;base64,")) {
      return { ok: false, fallbackDownload: false, error: "Unexpected screenshot format" };
    }
    try {
      const upload = await fetch(`/api/account/scenes/${sceneId}/images`, {
        body: JSON.stringify({
          content_base64: dataUrl.slice("data:image/png;base64,".length),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await upload.json().catch(() => ({}));
      if (upload.ok) {
        router.refresh();
      }
      return {
        ok: upload.ok,
        // The gallery upload failed for a real reason (quota, moderation,
        // ...): tell the user instead of silently downloading a file they
        // wanted stored.
        fallbackDownload: false,
        error: upload.ok ? undefined : `Saving failed: ${payload.error ?? upload.status}`,
      };
    } catch {
      return { ok: false, fallbackDownload: false, error: "Saving failed" };
    }
  }

  const openRef = useRef(false);
  openRef.current = open;

  function closeNow() {
    setOpen(false);
    setPanels(noPanels);
    setInitialPrompt(undefined);
    setDirty(false);
    setError(null);
    setScenes(null);
    setSelectedSceneId(null);
    setSceneName(null);
    setPreviewScenes(null);
    latestScenesRef.current = null;
  }

  // The URL hash is the source of truth: back/forward (and loading a
  // #scene-editor / #scene-editor-preview / #scene-editor-ai link directly)
  // open and close the modal, with exactly the panels the hash names.
  // Closing simply discards unsaved edits — no confirmation dialog.
  useEffect(() => {
    const sync = () => {
      const hash = window.location.hash;
      const hashPanels = sceneEditorPanelsForHash(hash);
      const shouldOpen = hashPanels !== null;
      if (shouldOpen === openRef.current) {
        return;
      }
      if (hashPanels) {
        // ?ai=<prompt> hands the panel its first message (entry points link
        // here with it); read once, when the modal opens.
        const prompt = new URLSearchParams(window.location.search).get("ai")?.trim();
        setInitialPrompt(prompt || undefined);
        const next = { ai: hashPanels.ai || Boolean(prompt), preview: hashPanels.preview };
        if (hash === livePreviewHash) {
          // The pre-unification hash: keep the URL on today's spelling.
          window.history.replaceState(window.history.state, "", sceneEditorHashFor(next));
        }
        setPanels(next);
        setOpen(true);
      } else {
        closeNow();
      }
    };
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    sync();
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);

  function openEditor(next: SceneEditorPanels) {
    window.history.pushState({ frameosSceneEditor: true }, "", sceneEditorHashFor(next));
    setInitialPrompt(undefined);
    setPanels(next);
    setOpen(true);
  }

  function togglePanel(panel: keyof SceneEditorPanels) {
    const next = { ...panels, [panel]: !panels[panel] };
    if (panel === "preview" && next.preview) {
      // Hand the panel what the editor holds right now; it follows edits
      // from here on (publishScenes).
      setPreviewScenes(latestScenesRef.current);
    }
    setPanels(next);
    storePanels(next);
    // Keep the URL truthful (a reload reopens the same view) without adding
    // a history entry the Back button would have to step through.
    window.history.replaceState(window.history.state, "", sceneEditorHashFor(next));
  }

  function close() {
    if (window.history.state?.frameosSceneEditor) {
      // Delegates to the hash-sync handler above.
      window.history.back();
      return;
    }
    // Opened via a direct #scene-editor link: clear the hash in place.
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    closeNow();
  }

  // The AI delivered scenes: apply them with a NEW array identity (the
  // editor re-initialises on identity change), select the right one, and
  // let Save / Fork take it from there.
  function applyAiEvent(event: AiScenesEvent): string | null {
    const current = latestScenesRef.current ?? scenes ?? [];
    const result = applyAiScenes(current, event, selectedSceneIdRef.current);
    baselinePendingRef.current = false;
    selectedSceneIdRef.current = result.selectedSceneId;
    publishScenes(result.scenes);
    setScenes(result.scenes);
    setSelectedSceneId(result.selectedSceneId);
    setDirty(JSON.stringify(result.scenes) !== initialJsonRef.current);
    return result.selectedSceneId;
  }

  async function forkAndSave() {
    const latest = latestScenesRef.current;
    if (!latest || latest.length === 0) {
      setError("Nothing to fork yet.");
      return;
    }
    if (
      !window.confirm(
        "Save these scenes (including your edits) as a new private scene in your account?",
      )
    ) {
      return;
    }
    setForking(true);
    setError(null);
    try {
      const response = await fetch(`/api/account/scenes/${sceneId}/fork`, {
        body: JSON.stringify({ scenes: latest }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(
          payload.error === "login_required"
            ? "Sign in to fork this scene."
            : `Forking failed: ${payload.error ?? response.status}`,
        );
        return;
      }
      // Jump to the fresh copy; its editor opens on unsaved-free state.
      window.location.href = `/s/${payload.scene.slug}`;
    } finally {
      setForking(false);
    }
  }

  async function save() {
    const latest = latestScenesRef.current;
    if (!latest || latest.length === 0) {
      setError("Nothing to save yet.");
      return;
    }
    if (
      !window.confirm(
        "Publish the edited scenes as a new version? Everyone installing or updating this scene will get it.",
      )
    ) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/account/scenes/${sceneId}/content`, {
        body: JSON.stringify({ scenes: latest }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(
          // Renaming the scene renames the store listing with it, and two of
          // your scenes may not share a name.
          payload.error === "scene_name_taken"
            ? `You already have another scene called “${payload.name ?? "that"}” — rename this one to something else.`
            : `Saving failed: ${payload.error ?? response.status}`,
        );
        return;
      }
      setDirty(false);
      initialJsonRef.current = JSON.stringify(latest);
      close();
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    // Real links so right-click → "open in new tab" works (the hash reopens
    // the same view there); left click keeps the in-page flow, opening with
    // the panels remembered from last time plus the one the link is about.
    return (
      <>
        <a
          className="button button--subtle"
          href={sceneEditorHash}
          onClick={(event) => {
            event.preventDefault();
            openEditor(readStoredPanels());
          }}
        >
          <Pencil aria-hidden size={18} />
          {canSave ? "Edit scene" : "View diagram"}
        </a>
        {canPreview ? (
          <a
            className="button button--subtle"
            href={sceneEditorPreviewHash}
            onClick={(event) => {
              event.preventDefault();
              openEditor({ ...readStoredPanels(), preview: true });
            }}
            title="Run the scene in your browser next to its diagram"
          >
            <Play aria-hidden size={18} />
            Live preview
          </a>
        ) : null}
        {canRemix ? (
          <a
            className="button button--subtle"
            href={sceneEditorAiHash}
            onClick={(event) => {
              event.preventDefault();
              openEditor({ ...readStoredPanels(), ai: true });
            }}
            title="Open the editor with the AI assistant and describe the changes you want"
          >
            <Sparkles aria-hidden size={18} />
            Remix with AI
          </a>
        ) : null}
      </>
    );
  }

  const saveHint = canSave
    ? "“Save as new version” publishes the edited scene as a new version for everyone who installs it."
    : canFork
      ? "“Fork & save copy” saves your remix as a private scene in your account."
      : "Sign in to save a remix as a private scene in your account.";

  return (
    // ph-no-capture: the scene's own diagram, node labels and settings.
    <div aria-modal className="editor-modal ph-no-capture" role="dialog">
      <div className="editor-modal__bar">
        <div className="editor-modal__title">
          <SceneNameTitle name={sceneName} onRename={renameScene} />
          {(canSave || canFork) && dirty ? (
            <span className="pill pill-warning">Unsaved changes</span>
          ) : null}
          {!canSave ? (
            <span className="pill" title="Explore and tweak freely; nothing you change here is saved anywhere">
              Playground — changes are not saved
            </span>
          ) : null}
          {error ? <span className="pill pill-warning">{error}</span> : null}
        </div>
        <div className="button-row">
          {canSave ? (
            <button
              className="button button--small"
              disabled={saving || !dirty}
              onClick={() => void save()}
              type="button"
            >
              <Save aria-hidden size={16} />
              {saving ? "Saving…" : "Save as new version"}
            </button>
          ) : null}
          {canFork ? (
            <button
              className="button button--small"
              disabled={forking}
              onClick={() => void forkAndSave()}
              title="Save these scenes (including your edits) as a new private scene in your account"
              type="button"
            >
              <GitFork aria-hidden size={16} />
              {forking ? "Forking…" : "Fork & save copy"}
            </button>
          ) : null}
          <SceneEditorPanelToggles onToggle={togglePanel} panels={panels} />
          {downloadUrl ? (
            <a
              className="button button--small"
              href={downloadUrl}
              title="Download the scene as a zip (the published version, not the editor's unsaved edits)"
            >
              <FileArchive aria-hidden size={16} />
              Download .zip
            </a>
          ) : null}
          <button className="button button--small" onClick={close} type="button">
            <X aria-hidden size={16} />
            Close
          </button>
        </div>
      </div>
      <SceneEditorWorkspace
        ai={{
          getScenes: () => latestScenesRef.current,
          initialPrompt,
          loginUrl,
          mode: "existing",
          onScenes: applyAiEvent,
          saveHint,
          settingsUrl,
          signedIn,
          storeSceneId: sceneId,
        }}
        description={description || undefined}
        editorApiRef={editorApiRef}
        height={height || 480}
        onSaveScreenshot={saveScreenshot}
        onScenesChanged={(nextScenes) => {
          publishScenes(nextScenes);
          const json = JSON.stringify(nextScenes);
          if (baselinePendingRef.current) {
            baselinePendingRef.current = false;
            initialJsonRef.current = json;
          }
          setDirty(json !== initialJsonRef.current);
        }}
        // The editor reports null before its first init; there is nothing
        // to follow yet.
        onSelectedSceneChanged={(nextSceneId) => {
          if (nextSceneId !== null && nextSceneId !== selectedSceneIdRef.current) {
            selectScene(nextSceneId);
          }
        }}
        panels={panels}
        preview={{
          canSaveToGallery: canSave,
          initialSource: pinnedVersion !== null ? "version" : "editor",
          pinnedVersion,
          sceneId,
          scenes: previewScenes,
          share,
          versions,
        }}
        sceneId={selectedSceneId}
        scenes={scenes}
        theme={theme}
        width={width || 800}
      />
    </div>
  );
}
