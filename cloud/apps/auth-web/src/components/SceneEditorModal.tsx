"use client";

import type { EmbeddedSceneEditorApi } from "frameos-editor/react";
import {
  ArrowLeft,
  FileArchive,
  GitFork,
  Info,
  MonitorDown,
  Pencil,
  Play,
  Save,
  Sparkles,
  Workflow,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { applyAiScenes, type AiScenesEvent, type SceneJson } from "../lib/ai-scenes-apply";
import {
  defaultSceneEditorPanels,
  openPanelCount,
  sceneEditorHashFor,
  sceneEditorPanelNames,
  sceneEditorPanelsForHash,
  type SceneEditorPanelName,
  type SceneEditorPanels,
} from "../lib/scene-views";
import { SceneAiPanel, type SceneAiPanelProps } from "./SceneAiPanel";
import { SceneInfoPanel, type SceneInfoData } from "./SceneInfoPanel";
import { SceneInstallDialog } from "./SceneInstallDialog";
import {
  SceneLivePreviewPanel,
  type PreviewSource,
  type SceneVersionOption,
} from "./SceneLivePreview";

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
  /** Whether the AI panel is on offer (active scenes only). It is available
   * to everyone; signed-out visitors see the sign-in prompt inside it. */
  canRemix?: boolean;
  /** Whether the Preview panel is on offer; pulled scenes don't get one. */
  canPreview?: boolean;
  signedIn?: boolean;
  /** Share token for private scenes, so shared visitors can load scenes.json. */
  share?: string | undefined;
  /** The store zip of the scene as the page shows it (its "Download zip"
   * link: pinned version and share token included), offered in the bar. */
  downloadUrl?: string | undefined;
  /** Where the OpenAI key is set (the fleet workspace's settings page). */
  settingsUrl?: string | undefined;
  /** The sign-in page; the AI panel and the Install dialog append
   * `return_to`. */
  loginUrl?: string | undefined;
  /** The account creation page (the Install dialog's invite). */
  signupUrl?: string | undefined;
  /** The scene's published versions, for the Preview panel's source list. */
  versions?: SceneVersionOption[] | undefined;
  /** The version the page is pinned to via ?version=N (not the latest):
   * the Preview panel then starts on it rather than on the editor. */
  pinnedVersion?: number | null | undefined;
  /** What the scene page shows besides the diagram (gallery, description,
   * versions, install instructions…), for the Info panel. Without it there
   * is no Info panel (the page renders it itself, full width). */
  info?: SceneInfoData | undefined;
  /** Where Back goes when there is no same-origin page to go back to: the
   * store front. */
  backUrl?: string | undefined;
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

/** Which panels were open last time; remembered per browser. */
export const PANELS_STORAGE_KEY = "frameos:scene-editor-panels";

/** The remembered panel set, or null when there is none. A set stored before
 * the Editor became a toggle (no `editor` key) had the diagram always on. */
export function readStoredPanels(): SceneEditorPanels | null {
  try {
    const raw = window.localStorage.getItem(PANELS_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<SceneEditorPanels> | null;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return {
      ai: parsed.ai === true,
      editor: "editor" in parsed ? parsed.editor === true : true,
      info: parsed.info === true,
      preview: parsed.preview === true,
    };
  } catch {
    return null;
  }
}

export function storePanels(panels: SceneEditorPanels) {
  try {
    window.localStorage.setItem(PANELS_STORAGE_KEY, JSON.stringify(panels));
  } catch {
    // Private mode / storage disabled: the panels just don't persist.
  }
}

/** Which panels a workspace can show at all (no Info without page info, no
 * Preview for a pulled scene…); anything not mentioned is available. */
export type SceneEditorPanelAvailability = Partial<Record<SceneEditorPanelName, boolean>>;

/** A panel set limited to the available panels — and never empty: the
 * Editor (else the first available panel) stands in. */
export function constrainPanels(
  panels: SceneEditorPanels,
  available: SceneEditorPanelAvailability,
): SceneEditorPanels {
  const next = { ...panels };
  for (const name of sceneEditorPanelNames) {
    if (available[name] === false) {
      next[name] = false;
    }
  }
  if (openPanelCount(next) === 0) {
    const fallback =
      available.editor === false
        ? sceneEditorPanelNames.find((name) => available[name] !== false)
        : "editor";
    if (fallback) {
      next[fallback] = true;
    }
  }
  return next;
}

/** The set after toggling one panel, or null when that would close the
 * last open one (at least one panel stays). */
export function togglePanelIn(
  panels: SceneEditorPanels,
  panel: SceneEditorPanelName,
): SceneEditorPanels | null {
  const next = { ...panels, [panel]: !panels[panel] };
  return openPanelCount(next) === 0 ? null : next;
}

export type EditorViewportAdjustment = { kind: "fit" } | { kind: "pan"; dx: number } | { kind: "none" };

/** What the diagram does when its column's width changes from `previousWidth`
 * (null: never measured — the column just appeared) to `nextWidth`: a fit
 * when it appears or jumps by more than 40% in one step (a column beside it
 * collapsed or expanded — a pan would leave the diagram off to one side), a
 * pan by half the change otherwise (a drag, a small resize), so what was in
 * the middle stays there. */
export function editorViewportForWidthChange(
  previousWidth: number | null,
  nextWidth: number,
): EditorViewportAdjustment {
  if (previousWidth === null) {
    return { kind: "fit" };
  }
  const delta = nextWidth - previousWidth;
  if (delta === 0) {
    return { kind: "none" };
  }
  if (Math.abs(delta) / Math.max(previousWidth, nextWidth) > 0.4) {
    return { kind: "fit" };
  }
  return { kind: "pan", dx: delta / 2 };
}

const panelWidths: Record<SceneEditorPanelName, { initial: number; min: number; max: number }> = {
  ai: { initial: 380, max: 640, min: 300 },
  editor: { initial: 640, max: 1600, min: 320 },
  info: { initial: 380, max: 720, min: 280 },
  preview: { initial: 520, max: 900, min: 320 },
};

/** The narrowest each column goes when the frame is too narrow for the
 * widths the user chose (the editor's floor is also 30% of the frame). */
export const panelMinWidths: Record<SceneEditorPanelName, number> = {
  ai: 240,
  editor: 360,
  info: 240,
  preview: 320,
};

const resizerWidth = 6;

/** The frame's grid-template-columns for the open panels (`layout`, in
 * order), the one taking the leftover width (`flexible`) and the widths the
 * user dragged the others to. The fixed columns get exactly their width
 * while it fits beside the flexible column's floor (plain px, not
 * `minmax(min, width)`: grid hands free space to bounded tracks before the
 * `fr` one, which would pin the editor at its floor); when it does not, they
 * all give up the same share, down to their minimums — and below those,
 * still uniformly, when even the minimums overflow. Unknown frame width
 * (before the first measure): the widths as stored. */
export function panelColumnTemplate(
  layout: readonly SceneEditorPanelName[],
  flexible: SceneEditorPanelName | undefined,
  widths: Record<SceneEditorPanelName, number>,
  frameWidth: number | null,
): string {
  const fixed = layout.filter((name) => name !== flexible);
  const gaps = resizerWidth * (layout.length - 1);
  const flexibleMin =
    flexible === "editor"
      ? Math.max(panelMinWidths.editor, frameWidth === null ? 0 : Math.round(frameWidth * 0.3))
      : flexible
        ? panelMinWidths[flexible]
        : 0;
  const sizes: Partial<Record<SceneEditorPanelName, number>> = {};
  for (const name of fixed) {
    sizes[name] = widths[name];
  }
  if (frameWidth !== null && fixed.length > 0) {
    const room = Math.max(0, frameWidth - gaps - flexibleMin);
    const stored = fixed.reduce((sum, name) => sum + widths[name], 0);
    if (stored > room) {
      for (const name of fixed) {
        sizes[name] = Math.max(panelMinWidths[name], Math.floor((widths[name] * room) / stored));
      }
      const atMinimums = fixed.reduce((sum, name) => sum + sizes[name]!, 0);
      if (atMinimums > room) {
        const minimums = fixed.reduce((sum, name) => sum + panelMinWidths[name], 0);
        for (const name of fixed) {
          sizes[name] = Math.floor((panelMinWidths[name] * room) / minimums);
        }
      }
    }
  }
  return layout
    .map(
      (name, index) =>
        `${index === 0 ? "" : `${resizerWidth}px `}${
          name === flexible ? `minmax(${flexibleMin}px, 1fr)` : `${sizes[name]}px`
        }`,
    )
    .join(" ");
}

/** Which side of a drag handle the column it resizes sits on. */
type ResizeSide = "left" | "right";

// A column width the user can drag. The handle sits on the column's edge
// facing its neighbour: a column left of the handle widens when the handle
// is dragged right, one right of it when dragged left.
function useResizableWidth({ initial, min, max }: { initial: number; min: number; max: number }) {
  const [width, setWidth] = useState(initial);
  const dragRef = useRef<{ startX: number; startWidth: number; side: ResizeSide } | null>(null);
  return {
    width,
    onPointerDown(event: ReactPointerEvent<HTMLDivElement>, side: ResizeSide) {
      dragRef.current = { side, startWidth: width, startX: event.clientX };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }
      const delta = event.clientX - drag.startX;
      const next = drag.startWidth + (drag.side === "left" ? delta : -delta);
      setWidth(Math.min(max, Math.max(min, Math.round(next))));
    },
    onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
      dragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
  };
}

type Resize = ReturnType<typeof useResizableWidth>;

type PanelResizerProps = {
  label: string;
  resize: Resize;
  side: ResizeSide;
  className?: string | undefined;
};

function PanelResizer({ label, resize, side, className }: PanelResizerProps) {
  return (
    <div
      aria-label={label}
      aria-orientation="vertical"
      className={className ? `editor-modal__resizer ${className}` : "editor-modal__resizer"}
      onPointerCancel={resize.onPointerUp}
      onPointerDown={(event) => resize.onPointerDown(event, side)}
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
  /** A version to switch the panel to (from the Info panel's table). */
  versionRequest?: { version: number } | null | undefined;
  onSourceChange?: ((source: PreviewSource) => void) | undefined;
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
  /** The Info column's content (left of the diagram); none for a scene
   * that has no page yet. */
  info?: ReactNode;
};

const panelCopy: Record<
  SceneEditorPanelName,
  { label: string; Icon: typeof Info; show: string; hide: string }
> = {
  ai: { Icon: Sparkles, hide: "Hide the AI assistant", label: "AI", show: "Show the AI assistant" },
  editor: { Icon: Workflow, hide: "Hide the diagram", label: "Editor", show: "Show the scene's diagram" },
  info: {
    Icon: Info,
    hide: "Hide the scene info",
    label: "Info",
    show: "Show the scene's images, description and versions",
  },
  preview: { Icon: Play, hide: "Hide the live preview", label: "Preview", show: "Run the scene in your browser" },
};

/** The segmented panel switch in the bar: Info · Editor · AI · Preview, each
 * on or off on its own — except the last open one, which stays. */
export function SceneEditorPanelToggles({
  panels,
  onToggle,
  available = {},
}: {
  panels: SceneEditorPanels;
  onToggle: (panel: SceneEditorPanelName) => void;
  available?: SceneEditorPanelAvailability | undefined;
}) {
  const openCount = openPanelCount(panels);
  return (
    <div aria-label="Panels" className="view-toggle editor-modal__panels" role="group">
      {sceneEditorPanelNames
        .filter((name) => available[name] !== false)
        .map((name) => {
          const { label, Icon, show, hide } = panelCopy[name];
          const last = panels[name] && openCount === 1;
          return (
            <button
              aria-pressed={panels[name]}
              className="view-toggle__button"
              disabled={last}
              key={name}
              onClick={() => onToggle(name)}
              title={last ? "At least one panel stays open" : panels[name] ? hide : show}
              type="button"
            >
              <Icon aria-hidden size={15} />
              {label}
            </button>
          );
        })}
    </div>
  );
}

/** The bar's leftmost control: leaves the workspace (a link when there is
 * a fixed place to go, a button when the destination is decided on click). */
export function SceneEditorBackButton({
  label,
  href,
  onClick,
}: {
  label: string;
  href?: string | undefined;
  onClick?: (() => void) | undefined;
}) {
  const content = <ArrowLeft aria-hidden size={18} />;
  if (href) {
    return (
      <a aria-label={label} className="editor-modal__back" href={href} title={label}>
        {content}
      </a>
    );
  }
  return (
    <button aria-label={label} className="editor-modal__back" onClick={onClick} title={label} type="button">
      {content}
    </button>
  );
}

// The area below the bar: the open panels as columns — Info, the embedded
// FrameOS editor, the AI panel, the live preview — each draggable wider or
// narrower, the leftover width going to the Editor (else the Preview).
// Shared by the store scene's workspace and the "new scene" page.
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
  info,
}: SceneEditorWorkspaceProps) {
  const resizes: Record<SceneEditorPanelName, Resize> = {
    ai: useResizableWidth(panelWidths.ai),
    editor: useResizableWidth(panelWidths.editor),
    info: useResizableWidth(panelWidths.info),
    preview: useResizableWidth(panelWidths.preview),
  };
  const open: SceneEditorPanels = { ...panels, info: panels.info && info !== undefined };
  const layout = sceneEditorPanelNames.filter((name) => open[name]);
  // The editor is heavy (kea, Monaco, wasm): mounted the first time its
  // panel opens, and kept mounted — hidden — from then on, so hiding the
  // panel keeps the unsaved edits.
  const [editorMounted, setEditorMounted] = useState(open.editor);
  useEffect(() => {
    if (open.editor) {
      setEditorMounted(true);
    }
  }, [open.editor]);
  // The frame's width decides how much the fixed columns must give (see
  // panelColumnTemplate): measured before the first paint, then followed
  // through the window's resizes (the frame spans the viewport) and its own.
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [frameWidth, setFrameWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) {
      return;
    }
    const measure = () => setFrameWidth(Math.round(frame.getBoundingClientRect().width));
    measure();
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(frame);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, []);

  // A change of the editor column's width (a panel toggled, a handle
  // dragged, the window resized) would leave the diagram off-centre: the
  // viewport pans by half the change, or re-fits when the column appears
  // or jumps (editorViewportForWidthChange). A fit waits a frame, so that
  // reactflow has measured its container's new size by then. A hidden
  // column is 0 wide with nothing painted: skipped, and treated as newly
  // appeared (a fit) when it shows.
  const editorCellRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const cell = editorCellRef.current;
    if (!cell || typeof ResizeObserver === "undefined") {
      return;
    }
    let previousWidth: number | null = null;
    const observer = new ResizeObserver((entries) => {
      if (cell.hidden) {
        previousWidth = null;
        return;
      }
      const width = entries[entries.length - 1]?.contentRect.width ?? cell.clientWidth;
      const adjustment = editorViewportForWidthChange(previousWidth, width);
      previousWidth = width;
      if (adjustment.kind === "pan") {
        editorApiRef?.current?.panBy(adjustment.dx, 0);
      } else if (adjustment.kind === "fit") {
        window.requestAnimationFrame(() => editorApiRef?.current?.fitView());
      }
    });
    observer.observe(cell);
    return () => observer.disconnect();
  }, [editorApiRef]);
  const flexible: SceneEditorPanelName | undefined = layout.includes("editor")
    ? "editor"
    : layout.includes("preview")
      ? "preview"
      : layout[layout.length - 1];
  const editorOnly = layout.length === 1 && layout[0] === "editor";
  const template = panelColumnTemplate(
    layout,
    flexible,
    { ai: resizes.ai.width, editor: resizes.editor.width, info: resizes.info.width, preview: resizes.preview.width },
    frameWidth,
  );

  // Each fixed column's handle sits on its edge facing the flexible column:
  // the handle before a column drags the column to its left when that side
  // is where the flexible column is (or the column itself is flexible), and
  // the column to its right otherwise.
  function resizerBefore(name: SceneEditorPanelName) {
    const index = layout.indexOf(name);
    if (index <= 0) {
      return null;
    }
    const flexibleIndex = flexible ? layout.indexOf(flexible) : -1;
    const dragsLeft = index <= flexibleIndex;
    const target = dragsLeft ? layout[index - 1]! : name;
    return (
      <PanelResizer
        className={target === "info" ? "editor-modal__resizer--info" : undefined}
        label={`Resize the ${panelCopy[target].label} panel`}
        resize={resizes[target]}
        side={dragsLeft ? "left" : "right"}
      />
    );
  }

  return (
    <div
      className={
        editorOnly
          ? "editor-modal__frame"
          : `editor-modal__frame editor-modal__frame--with-panels editor-modal__frame--panels-${layout.length}`
      }
      ref={frameRef}
      style={editorOnly ? undefined : { gridTemplateColumns: template }}
    >
      {open.info ? (
        <aside aria-label="Scene info" className="editor-modal__info">
          {info}
        </aside>
      ) : null}
      {open.editor ? resizerBefore("editor") : null}
      <div className="editor-modal__editor" hidden={!open.editor} ref={editorCellRef}>
        {scenes && editorMounted ? (
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
      {open.ai ? (
        <>
          {resizerBefore("ai")}
          <aside aria-label="AI assistant" className="editor-modal__ai">
            <SceneAiPanel {...ai} height={height} selectedSceneId={sceneId ?? null} width={width} />
          </aside>
        </>
      ) : null}
      {open.preview ? (
        <>
          {resizerBefore("preview")}
          <aside aria-label="Live preview" className="editor-modal__preview">
            {/* Mounted once the scenes are in, so the panel's first source
                choice sees them (it is made on mount). */}
            {preview.scenes ? (
              <SceneLivePreviewPanel
                canSaveToGallery={preview.canSaveToGallery}
                editorSceneId={sceneId ?? null}
                height={height}
                initialSource={preview.initialSource}
                onSourceChange={preview.onSourceChange}
                pinnedVersion={preview.pinnedVersion}
                sceneId={preview.sceneId}
                scenes={preview.scenes}
                share={preview.share}
                versionRequest={preview.versionRequest}
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

type NavigationApi = {
  currentEntry?: { index: number } | null;
  entries(): { url: string | null }[];
};

/** Whether the previous history entry is a page of ours. The Navigation
 * API knows (a client-side route change leaves document.referrer as it
 * was); where it is missing, the referrer plus a history to go back in. */
function cameFromOurPage(): boolean {
  const origin = `${window.location.origin}/`;
  const navigation = (window as unknown as { navigation?: NavigationApi }).navigation;
  if (navigation?.currentEntry) {
    const previous = navigation.entries()[navigation.currentEntry.index - 1];
    return Boolean(previous?.url?.startsWith(origin));
  }
  return document.referrer.startsWith(origin) && window.history.length > 1;
}

// The store scene page's workspace: the scene's Info column, the FrameOS
// editor rendered as a component in this page's React tree, the AI panel
// and the live preview, toggled from the bar. Saving publishes the edited
// scenes as a new immutable version; the Preview panel runs the editor's
// unsaved state (or a published version); the AI panel edits the same
// scenes; Save / Fork then do the rest.
export function SceneEditorModal({
  sceneId,
  width,
  height,
  description,
  canSave = false,
  canFork = false,
  canRemix = true,
  canPreview = true,
  signedIn = canFork,
  share,
  downloadUrl,
  settingsUrl,
  loginUrl = "/login",
  signupUrl = "/signup",
  versions,
  pinnedVersion = null,
  info,
  backUrl = "/",
}: SceneEditorModalProps) {
  const router = useRouter();
  // null until mounted: the URL hash and the browser's memory decide the
  // panel set, and the server render sees neither.
  const [panels, setPanels] = useState<SceneEditorPanels | null>(null);
  // A version picked in the Info panel's table, handed to the Preview
  // panel; and what that panel reports it runs, shown back in the table.
  const [versionRequest, setVersionRequest] = useState<{ version: number } | null>(null);
  const [previewSource, setPreviewSource] = useState<PreviewSource | null>(null);
  const [initialPrompt, setInitialPrompt] = useState<string | undefined>(undefined);
  const [installOpen, setInstallOpen] = useState(false);
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
  // up to date while that panel is open (each update re-renders the page).
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
  const available: SceneEditorPanelAvailability = {
    ai: canRemix,
    info: info !== undefined,
    preview: canPreview,
  };
  const availableRef = useRef(available);
  availableRef.current = available;
  useEditorStylesheet(true);

  // The editor's current scenes, wherever they come from (the initial load,
  // the editor's edits, the AI): the source of truth for Save / Fork / AI
  // and, while it is open, the Preview panel.
  function publishScenes(next: SceneJson[] | null) {
    latestScenesRef.current = next;
    setSceneName(sceneNameFor(next, selectedSceneIdRef.current));
    if (panelsRef.current?.preview || next === null) {
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
  }, [sceneId, share]);

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

  // The URL hash names the open panels; without one, the browser's memory
  // decides, then the default (Info + Editor + Preview). Back/forward and a
  // hand-edited hash are followed live. ?ai=<prompt> hands the AI panel its
  // first message (entry points link here with it); read once, on load.
  const promptReadRef = useRef(false);
  useEffect(() => {
    const sync = () => {
      const hash = window.location.hash;
      const fromHash = sceneEditorPanelsForHash(hash);
      let next = constrainPanels(
        fromHash ?? readStoredPanels() ?? defaultSceneEditorPanels,
        availableRef.current,
      );
      if (!promptReadRef.current) {
        promptReadRef.current = true;
        const prompt = new URLSearchParams(window.location.search).get("ai")?.trim();
        if (prompt) {
          setInitialPrompt(prompt);
          next = constrainPanels({ ...next, ai: true }, availableRef.current);
        }
      }
      if (fromHash && sceneEditorHashFor(next) !== hash) {
        // An old spelling, or a panel this scene cannot show: keep the URL
        // on what is actually open.
        window.history.replaceState(window.history.state, "", sceneEditorHashFor(next));
      }
      if (next.preview) {
        setPreviewScenes(latestScenesRef.current);
      }
      setPanels(next);
    };
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    sync();
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);

  function togglePanel(panel: SceneEditorPanelName) {
    if (!panels) {
      return;
    }
    const next = togglePanelIn(panels, panel);
    if (!next) {
      return;
    }
    if (panel === "preview") {
      if (next.preview) {
        // Hand the panel what the editor holds right now; it follows edits
        // from here on (publishScenes).
        setPreviewScenes(latestScenesRef.current);
      } else {
        // A closed panel runs nothing; the next one starts afresh.
        setVersionRequest(null);
        setPreviewSource(null);
      }
    }
    setPanels(next);
    storePanels(next);
    // Keep the URL truthful (a reload or a shared link reopens the same
    // view) without adding a history entry Back would have to step through.
    window.history.replaceState(window.history.state, "", sceneEditorHashFor(next));
  }

  // A version row in the Info panel: run that version in the Preview panel
  // (opening the panel first when it is closed).
  function selectVersion(version: number) {
    setVersionRequest({ version });
    if (panels && !panels.preview) {
      togglePanel("preview");
    }
  }

  // Back: to the page that led here when it was one of ours (the store, My
  // scenes, a publisher page), else to the store front.
  function goBack() {
    if (cameFromOurPage()) {
      window.history.back();
      return;
    }
    router.push(backUrl);
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
      // Jump to the fresh copy; its workspace opens on unsaved-free state.
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
      // The page's data (versions, the Info panel) catches up.
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  if (!panels) {
    return null;
  }

  const saveHint = canSave
    ? "“Save as new version” publishes the edited scene as a new version for everyone who installs it."
    : canFork
      ? "“Fork & save copy” saves your remix as a private scene in your account."
      : "Sign in to save a remix as a private scene in your account.";

  // The scene's name (and its rename pencil) heads the Info column; only
  // while that column is closed does the bar carry it.
  const nameTitle = <SceneNameTitle name={sceneName} onRename={renameScene} />;
  const nameInInfo = info !== undefined && panels.info;
  // The version being looked at (the Preview panel's, when it runs a
  // published one): the Info table marks it, and a cloud install pins it
  // when it is not the latest.
  const viewingVersion =
    info && panels.preview && previewSource?.kind === "version"
      ? (previewSource.version ?? info.scene.latestVersion)
      : null;
  const installVersion =
    info && viewingVersion !== null && viewingVersion !== info.scene.latestVersion ? viewingVersion : null;

  return (
    // ph-no-capture: the scene's own diagram, node labels and settings.
    <div className="editor-modal ph-no-capture">
      <div className="editor-modal__bar">
        <div className="editor-modal__title">
          <SceneEditorBackButton label="Back" onClick={goBack} />
          <SceneEditorPanelToggles available={available} onToggle={togglePanel} panels={panels} />
          {nameInInfo ? null : nameTitle}
          {!canSave ? (
            <span className="pill" title="Explore and tweak freely; nothing you change here is saved anywhere">
              Playground — changes are not saved
            </span>
          ) : null}
          {error ? <span className="pill pill-warning">{error}</span> : null}
        </div>
        <div className="button-row">
          {(canSave || canFork) && dirty ? (
            <span className="pill pill-warning">Unsaved changes</span>
          ) : null}
          {info ? (
            <button
              className="button button--small"
              onClick={() => setInstallOpen(true)}
              title="Install this scene on a frame"
              type="button"
            >
              <MonitorDown aria-hidden size={16} />
              Install
            </button>
          ) : null}
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
        </div>
      </div>
      <SceneEditorWorkspace
        info={
          info ? (
            <SceneInfoPanel
              {...info}
              heading={nameTitle}
              onSelectVersion={selectVersion}
              viewingVersion={viewingVersion}
            />
          ) : undefined
        }
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
          onSourceChange: setPreviewSource,
          pinnedVersion,
          sceneId,
          scenes: previewScenes,
          share,
          versionRequest,
          versions,
        }}
        sceneId={selectedSceneId}
        scenes={scenes}
        theme={theme}
        width={width || 800}
      />
      {installOpen && info ? (
        <SceneInstallDialog
          framesUrl={info.framesUrl}
          installVersion={installVersion}
          installableFrames={info.installableFrames}
          isPrivate={info.scene.visibility !== "public"}
          loginUrl={loginUrl}
          onClose={() => setInstallOpen(false)}
          pageUrl={info.pageUrl}
          returnTo={`${window.location.pathname}${window.location.search}${window.location.hash}`}
          sceneId={sceneId}
          sceneName={info.scene.name}
          signedIn={info.signedIn}
          signupUrl={signupUrl}
        />
      ) : null}
    </div>
  );
}
