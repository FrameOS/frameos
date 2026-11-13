// The scene workspace: the store's scene page (scenes.frameos.net/s/…) and
// a self-hosted backend's scene page alike — the bar (Back, the Editor · AI
// · Preview toggles, the scene's name, the actions) and the panels as
// resizable columns: the scene editor, the AI assistant, the live preview.
// Moved here from the cloud app (cloud/apps/auth-web) so that both control
// planes draw the same thing; what differs is passed in (the editor column,
// the actions) or set once per plane (lib/host.ts).

import {
  ArrowLeft,
  MoreHorizontal,
  Pencil,
  Play,
  Sparkles,
  type LucideIcon,
  Workflow,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
// The editor package's public types (what frameos-editor/react declares):
// the contract every editor column meets, and light enough for the cloud's
// stricter type check, which the editor's own sources are not written for.
import type {
  EmbeddedSceneEditorApi,
  EmbeddedSceneEditorProps,
  SceneTemplateMetadata,
  TemplateCategoryOption,
} from "../../../frameos/editor/react";
import type { SceneJson } from "./lib/ai-scenes-apply";
import { sceneWorkspaceHost } from "./lib/host";
import {
  onlyPanel,
  openPanelCount,
  sceneEditorPanelNames,
  singlePanelFor,
  type SceneEditorPanelName,
  type SceneEditorPanels,
} from "./lib/scene-views";
import { SceneAiPanel, type SceneAiPanelProps } from "./SceneAiPanel";
import { SceneLivePreviewPanel } from "./SceneLivePreview";

export type { EmbeddedSceneEditorApi, SceneJson };

/** The editor column's props: EmbeddedSceneEditor's, the scenes as the JSON
 * they travel as. */
export type SceneWorkspaceEditorProps = EmbeddedSceneEditorProps;

/** A field of template.json a host keeps. */
export type TemplateField = NonNullable<EmbeddedSceneEditorProps["templateFields"]>[number];

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
    const parsed = JSON.parse(raw) as (Partial<SceneEditorPanels> & { info?: boolean }) | null;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return {
      ai: parsed.ai === true,
      // A remembered Info column (retired: its content is template.json in
      // the editor) reads as the Editor.
      editor: "editor" in parsed ? parsed.editor === true || parsed.info === true : true,
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

/** Which panels a workspace can show at all (no Preview for a pulled
 * scene…); anything not mentioned is available. */
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
  // Availability closed everything the caller had open: stand something in.
  // A set that was already empty is the reader's own choice — left alone.
  if (openPanelCount(next) === 0 && openPanelCount(panels) > 0) {
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

/** The set after toggling one panel. Closing the last one is allowed: the
 * workspace then shows its title and the toggles, nothing else. */
export function togglePanelIn(
  panels: SceneEditorPanels,
  panel: SceneEditorPanelName,
): SceneEditorPanels {
  return { ...panels, [panel]: !panels[panel] };
}

/** Below this width the workspace shows one panel at a time, full width,
 * and the panel toggles become tabs. */
export const singlePanelQuery = "(max-width: 900px)";

/** Whether the viewport is too narrow for panels side by side. The server
 * render (and a browser without matchMedia) counts as wide. */
export function useSinglePanelMode(): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const query = window.matchMedia(singlePanelQuery);
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}

/** The panels a workspace shows for a set: all of them side by side, or —
 * in single-panel mode — just the one (singlePanelFor). */
export function shownPanels(
  panels: SceneEditorPanels,
  narrow: boolean,
  active: SceneEditorPanelName | null,
): SceneEditorPanels {
  if (!narrow) {
    return panels;
  }
  const single = singlePanelFor(panels, active);
  return single ? onlyPanel(single) : panels;
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
  preview: { initial: 520, max: 900, min: 320 },
};

/** The narrowest each column goes when the frame is too narrow for the
 * widths the user chose (the editor's floor is also 30% of the frame). */
export const panelMinWidths: Record<SceneEditorPanelName, number> = {
  ai: 240,
  editor: 360,
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
  /** The editor's current scenes, kept up to date while the panel is open
   * (null while they load — the panel waits for them). */
  scenes: SceneJson[] | null;
  canSaveToGallery?: boolean | undefined;
  /** A screenshot was registered; the workspace adds it to the draft. */
  onImageRegistered?: ((sha256: string) => void) | undefined;
  /** The account settings page, linked from the panel's credentials hint. */
  settingsUrl?: string | undefined;
  /** What the panel starts on, and whether it uses this browser's
   * remembered settings (SceneLivePreviewPanel's props of those names). */
  initialDevice?: string | undefined;
  initialMemoryDevice?: string | undefined;
  rememberSettings?: boolean | undefined;
};

type SceneEditorWorkspaceProps = {
  /** The editor column: the store's EmbeddedSceneEditor (frameos-editor/react,
   * its own frame logic in memory), a backend's frame-bound editor, or the
   * editor bundle in an iframe. Every one takes EmbeddedSceneEditor's props. */
  Editor: ComponentType<SceneWorkspaceEditorProps>;
  /** The choices template.json's Category field offers (the store's). */
  templateCategories?: TemplateCategoryOption[] | undefined;
  /** The template.json fields the host keeps (EmbeddedSceneEditor's). */
  templateFields?: TemplateField[] | undefined;
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
  /** template.json's view in the editor (the scene page's info); none for a scene
   * that has no page yet. */
  info?: ReactNode;
  /** What fills the frame when every panel is closed. */
  empty?: ReactNode;
  /** The X in the AI and preview panels' corners: closes that panel. */
  onClosePanel?: ((panel: "ai" | "preview") => void) | undefined;
  /** The editor's template.json: the listing the draft holds. */
  template?: SceneTemplateMetadata | undefined;
  /** Edits to template.json; absent: read only (a visitor's playground). */
  onTemplateChanged?: ((changes: Partial<SceneTemplateMetadata>) => void) | undefined;
  /** The editor opens on this file of the shown scene's first app that has
   * it (`app.tsx`), instead of template.json or the diagram. */
  initialAppFile?: string | undefined;
  /** False: the editor's file tree starts folded away (the embed's narrow
   * column). */
  initialTreeOpen?: boolean | undefined;
};

const panelCopy: Record<
  SceneEditorPanelName,
  { label: string; Icon: LucideIcon; show: string; hide: string }
> = {
  ai: { Icon: Sparkles, hide: "Hide the AI assistant", label: "AI", show: "Show the AI assistant" },
  editor: {
    Icon: Workflow,
    hide: "Hide the editor",
    label: "Editor",
    show: "Show the template's files: its info, its scenes' diagrams and their apps",
  },
  preview: { Icon: Play, hide: "Hide the live preview", label: "Preview", show: "Run the scene in your browser" },
};

/** The segmented panel switch in the bar: Editor · AI · Preview, each
 * on or off on its own — except the last open one, which stays. In
 * single-panel mode (`active` given) they are tabs: one shown at a time. */
export function SceneEditorPanelToggles({
  panels,
  onToggle,
  available = {},
  active,
  hero,
}: {
  panels: SceneEditorPanels;
  onToggle: (panel: SceneEditorPanelName) => void;
  available?: SceneEditorPanelAvailability | undefined;
  /** The one panel shown (single-panel mode); undefined for toggles. */
  active?: SceneEditorPanelName | null | undefined;
  /** The larger copy the empty workspace shows in the middle of the page. */
  hero?: boolean | undefined;
}) {
  const tabs = active !== undefined && active !== null;
  return (
    <div
      aria-label="Panels"
      className={`view-toggle editor-modal__panels${hero ? " editor-modal__panels--hero" : ""}`}
      role={tabs ? "tablist" : "group"}
    >
      {sceneEditorPanelNames
        .filter((name) => available[name] !== false)
        .map((name) => {
          const { label, Icon, show, hide } = panelCopy[name];
          const content = (
            <>
              <Icon aria-hidden size={15} />
              <span className="editor-modal__panel-label">{label}</span>
            </>
          );
          if (tabs) {
            return (
              <button
                aria-selected={active === name}
                className="view-toggle__button"
                key={name}
                onClick={() => onToggle(name)}
                role="tab"
                title={show}
                type="button"
              >
                {content}
              </button>
            );
          }
          return (
            <button
              aria-pressed={panels[name]}
              className="view-toggle__button"
              key={name}
              onClick={() => onToggle(name)}
              title={panels[name] ? hide : show}
              type="button"
            >
              {content}
            </button>
          );
        })}
    </div>
  );
}

/** One of the bar's right-hand actions (Install, Save, Fork, Download…):
 * a button in the bar while there is room, a menu item when there is not. */
export type SceneEditorAction = {
  key: string;
  label: string;
  Icon: LucideIcon;
  /** A link (the zip download) rather than a button. */
  href?: string | undefined;
  /** Where a link opens: `_top` leaves the frame the embedded workspace is
   * in for the whole window. A link's onSelect runs first. */
  target?: "_blank" | "_top" | undefined;
  onSelect?: (() => void) | undefined;
  disabled?: boolean | undefined;
  title?: string | undefined;
  /** The bar's main action: first in the overflow menu. */
  primary?: boolean | undefined;
  /** Drawn as the filled primary button while expanded. */
  emphasized?: boolean | undefined;
};

function SceneEditorActionButton({ action }: { action: SceneEditorAction }) {
  const className = action.emphasized ? "button button--small button-primary" : "button button--small";
  const content = (
    <>
      <action.Icon aria-hidden size={16} />
      {action.label}
    </>
  );
  if (action.href !== undefined) {
    return (
      <a
        className={className}
        href={action.href}
        onClick={action.onSelect}
        title={action.title}
        {...linkTarget(action.target)}
      >
        {content}
      </a>
    );
  }
  return (
    <button className={className} disabled={action.disabled} onClick={action.onSelect} title={action.title} type="button">
      {content}
    </button>
  );
}

function linkTarget(target: SceneEditorAction["target"]) {
  return target === "_blank" ? { rel: "noopener", target } : target ? { target } : {};
}

/** The actions in menu order: the primary one first, the rest as in the bar. */
export function menuOrder(actions: readonly SceneEditorAction[]): SceneEditorAction[] {
  return [...actions.filter((action) => action.primary), ...actions.filter((action) => !action.primary)];
}

// The "…" button the actions collapse into when the bar has no room for
// them, and its menu: the same actions as menu items (the primary one
// first), opened by click, closed by Escape, Tab, an outside click or a
// choice; arrow keys, Home and End move between the enabled items.
function SceneEditorActionsMenu({ actions }: { actions: readonly SceneEditorAction[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const items = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);

  useEffect(() => {
    if (open) {
      items()[0]?.focus();
    }
  }, [open]);

  function close(refocus: boolean) {
    setOpen(false);
    if (refocus) {
      buttonRef.current?.focus();
    }
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!open) {
      return;
    }
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const focusAt = (position: number) => list[(position + list.length) % list.length]?.focus();
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusAt(index + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusAt(index < 0 ? list.length - 1 : index - 1);
        break;
      case "Home":
        event.preventDefault();
        focusAt(0);
        break;
      case "End":
        event.preventDefault();
        focusAt(list.length - 1);
        break;
      case "Escape":
        event.preventDefault();
        close(true);
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        break;
    }
  }

  return (
    <div className="editor-modal__more" onKeyDown={onKeyDown} ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="More actions"
        className="button button--small"
        onClick={() => setOpen((value) => !value)}
        ref={buttonRef}
        title="More actions"
        type="button"
      >
        <MoreHorizontal aria-hidden size={16} />
      </button>
      {open ? (
        <div aria-label="Actions" className="editor-modal__more-menu" ref={menuRef} role="menu">
          {menuOrder(actions).map((action) => {
            const className = action.primary
              ? "editor-modal__more-item editor-modal__more-item--primary"
              : "editor-modal__more-item";
            const content = (
              <>
                <action.Icon aria-hidden size={16} />
                {action.label}
              </>
            );
            if (action.href !== undefined) {
              return (
                <a
                  className={className}
                  href={action.href}
                  key={action.key}
                  onClick={() => {
                    action.onSelect?.();
                    close(false);
                  }}
                  role="menuitem"
                  title={action.title}
                  {...linkTarget(action.target)}
                >
                  {content}
                </a>
              );
            }
            return (
              <button
                className={className}
                disabled={action.disabled}
                key={action.key}
                onClick={() => {
                  close(true);
                  action.onSelect?.();
                }}
                role="menuitem"
                title={action.title}
                type="button"
              >
                {content}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** The width a row of flex children needs, each at its own width, gaps
 * included (the children do not shrink: buttons at their text's width). */
function rowWidth(row: HTMLElement): number {
  const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
  const children = Array.from(row.children) as HTMLElement[];
  return (
    children.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0) +
    gap * Math.max(0, children.length - 1)
  );
}

/** The width the bar's title wants: its children at their own widths, the
 * scene name at its full text (up to its cap) rather than what the flex
 * layout left it — it grows into spare room and ellipsizes when squeezed,
 * neither of which says what it needs. */
function titleWidth(title: HTMLElement): number {
  const gap = parseFloat(getComputedStyle(title).columnGap) || 0;
  const children = Array.from(title.children) as HTMLElement[];
  const width = children.reduce((sum, child) => {
    const text = child.querySelector<HTMLElement>(".editor-modal__name-text");
    if (!text) {
      return sum + child.getBoundingClientRect().width;
    }
    const cap = parseFloat(getComputedStyle(text).maxWidth);
    const wanted = Number.isFinite(cap) ? Math.min(text.scrollWidth, cap) : text.scrollWidth;
    return sum + wanted + rowWidth(child) - text.getBoundingClientRect().width;
  }, 0);
  return width + gap * Math.max(0, children.length - 1);
}

// Whether the bar's actions must collapse into the "…" menu: what they need
// (their expanded width, remembered from the last time they were expanded)
// against what the bar has to the right of its title. Measured before the
// first paint, after every render (a pill appeared, a label changed) and on
// the bar's resizes. The server render is expanded.
function useCollapsedActions(
  barRef: RefObject<HTMLDivElement | null>,
  titleRef: RefObject<HTMLDivElement | null>,
  clusterRef: RefObject<HTMLDivElement | null>,
): boolean {
  const [collapsed, setCollapsed] = useState(false);
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const requiredRef = useRef<number | null>(null);
  const measure = useCallback(() => {
    const bar = barRef.current;
    const title = titleRef.current;
    const cluster = clusterRef.current;
    if (!bar || !title || !cluster) {
      return;
    }
    const style = getComputedStyle(bar);
    // Room for the cluster once the title has what it wants (see
    // titleWidth): the actions collapse before the name is crushed, and the
    // name only gives way when even the menu would not fit.
    const available =
      bar.clientWidth -
      (parseFloat(style.paddingLeft) || 0) -
      (parseFloat(style.paddingRight) || 0) -
      titleWidth(title) -
      (parseFloat(style.columnGap) || 0);
    if (!collapsedRef.current) {
      requiredRef.current = rowWidth(cluster);
    }
    const required = requiredRef.current;
    if (required === null || Number.isNaN(required) || Number.isNaN(available)) {
      return;
    }
    setCollapsed(required > available + 0.5);
  }, [barRef, titleRef, clusterRef]);
  useLayoutEffect(measure);
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [barRef, measure]);
  return collapsed;
}

/** What the workspace shows with every panel closed: the scene's name and
 * the four toggles, in the middle of the page and in larger type. The bar
 * keeps its own copy of the toggles. */
export function SceneEditorEmptyState({
  name,
  panels,
  onToggle,
  available,
}: {
  name: string;
  panels: SceneEditorPanels;
  onToggle: (panel: SceneEditorPanelName) => void;
  available?: SceneEditorPanelAvailability | undefined;
}) {
  return (
    <div className="editor-modal__empty">
      <h1 className="editor-modal__empty-title">{name}</h1>
      <SceneEditorPanelToggles available={available} hero onToggle={onToggle} panels={panels} />
      <p className="copy editor-modal__empty-hint">Pick a panel to open it.</p>
    </div>
  );
}

/** The workspace's top bar: Back, the panel toggles and the rest of the
 * title on the left; on the right `leading` (the Unsaved pill, a picker)
 * and then the actions — as buttons while they fit, as a "…" menu when
 * they do not. */
export function SceneEditorBar({
  children,
  leading,
  actions,
}: {
  children: ReactNode;
  leading?: ReactNode;
  actions: readonly SceneEditorAction[];
}) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLDivElement | null>(null);
  const clusterRef = useRef<HTMLDivElement | null>(null);
  const collapsed = useCollapsedActions(barRef, titleRef, clusterRef);
  return (
    <div className="editor-modal__bar editor-modal__bar--scene" ref={barRef}>
      <div className="editor-modal__title" ref={titleRef}>
        {children}
      </div>
      <div className="button-row editor-modal__actions" ref={clusterRef}>
        {leading}
        {actions.length === 0 ? null : collapsed ? (
          <SceneEditorActionsMenu actions={actions} />
        ) : (
          actions.map((action) => <SceneEditorActionButton action={action} key={action.key} />)
        )}
      </div>
    </div>
  );
}

/** The bar's "Unsaved changes" pill; on phones just "Unsaved". */
export function UnsavedPill({ label, short }: { label: string; short: string }) {
  return (
    <span className="pill pill-warning editor-modal__unsaved">
      <span className="editor-modal__unsaved-long">{label}</span>
      <span className="editor-modal__unsaved-short">{short}</span>
    </span>
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

// The area below the bar: the open panels as columns — the embedded FrameOS
// editor (whose template.json shows `info`), the AI panel, the live preview
// — each draggable wider or narrower, the leftover width going to the
// Editor (else the Preview).
// Shared by the store scene's workspace and the "new scene" page.
export function SceneEditorWorkspace({
  Editor,
  templateCategories,
  templateFields,
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
  empty,
  onClosePanel,
  template,
  onTemplateChanged,
  initialAppFile,
  initialTreeOpen,
}: SceneEditorWorkspaceProps) {
  const resizes: Record<SceneEditorPanelName, Resize> = {
    ai: useResizableWidth(panelWidths.ai),
    editor: useResizableWidth(panelWidths.editor),
    preview: useResizableWidth(panelWidths.preview),
  };
  const open: SceneEditorPanels = panels;
  const layout = sceneEditorPanelNames.filter((name) => open[name]);
  // The size the Preview panel draws at (its Resize and rotate included):
  // the AI panel's render check and the assistant's render_scene use it, so
  // the frame the assistant looks at is the one the user sees. The scene's
  // size until the Preview has been open.
  const [previewSize, setPreviewSize] = useState<{ width: number; height: number } | null>(null);
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
  // Every panel closed: the frame carries `empty` instead of columns, while
  // the editor stays mounted (hidden) below it with its edits intact.
  const nothingOpen = layout.length === 0;
  const columns = panelColumnTemplate(
    layout,
    flexible,
    { ai: resizes.ai.width, editor: resizes.editor.width, preview: resizes.preview.width },
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
        label={`Resize the ${panelCopy[target].label} panel`}
        resize={resizes[target]}
        side={dragsLeft ? "left" : "right"}
      />
    );
  }

  return (
    <div
      className={
        editorOnly || nothingOpen
          ? `editor-modal__frame${nothingOpen ? " editor-modal__frame--empty" : ""}`
          : `editor-modal__frame editor-modal__frame--with-panels editor-modal__frame--panels-${layout.length}`
      }
      ref={frameRef}
      style={editorOnly || nothingOpen ? undefined : { gridTemplateColumns: columns }}
    >
      {nothingOpen ? empty : null}
      <div className="editor-modal__editor" hidden={!open.editor} ref={editorCellRef}>
        {scenes && editorMounted ? (
          <Editor
            scenes={scenes}
            sceneId={sceneId ?? undefined}
            width={width}
            height={height}
            mode="rpios"
            theme={theme}
            // The editor's own wasm preview is hidden (showPreviewButton):
            // the Preview panel here does that job. Its render-check and
            // image nodes still route CORS-blocked fetches through this.
            previewProxyUrl={sceneWorkspaceHost().previewProxyUrl ?? undefined}
            description={description}
            onScenesChanged={(nextScenes) => onScenesChanged(nextScenes as SceneJson[])}
            onSelectedSceneChanged={onSelectedSceneChanged}
            onSaveScreenshot={onSaveScreenshot}
            apiRef={editorApiRef}
            showPreviewButton={false}
            template={template}
            onTemplateChanged={onTemplateChanged}
            templateCategories={templateCategories}
            templateFields={templateFields}
            // The scene page's own content (gallery, description, versions,
            // listing) is template.json's form, and what the editor opens on.
            templateContent={
              info === undefined ? undefined : <div className="editor-modal__template-info">{info}</div>
            }
            initialFile={info === undefined ? "diagram" : "template"}
            initialAppFile={initialAppFile}
            initialTreeOpen={initialTreeOpen}
          />
        ) : null}
      </div>
      {open.ai ? (
        <>
          {resizerBefore("ai")}
          <aside aria-label="AI assistant" className="editor-modal__ai">
            {onClosePanel ? (
              <button
                aria-label="Hide the AI assistant"
                className="editor-modal__panel-close"
                onClick={() => onClosePanel("ai")}
                title="Hide the AI assistant"
                type="button"
              >
                <X aria-hidden />
              </button>
            ) : null}
            <SceneAiPanel
              {...ai}
              height={previewSize?.height ?? height}
              selectedSceneId={sceneId ?? null}
              width={previewSize?.width ?? width}
            />
          </aside>
        </>
      ) : null}
      {open.preview ? (
        <>
          {resizerBefore("preview")}
          <aside aria-label="Live preview" className="editor-modal__preview">
            {onClosePanel ? (
              <button
                aria-label="Hide the preview"
                className="editor-modal__panel-close"
                onClick={() => onClosePanel("preview")}
                title="Hide the preview"
                type="button"
              >
                <X aria-hidden />
              </button>
            ) : null}
            {/* Mounted once the scenes are in, so the panel's first source
                choice sees them (it is made on mount). */}
            {preview.scenes ? (
              <SceneLivePreviewPanel
                canSaveToGallery={preview.canSaveToGallery}
                editorSceneId={sceneId ?? null}
                height={height}
                onImageRegistered={preview.onImageRegistered}
                onViewportChange={setPreviewSize}
                sceneId={preview.sceneId}
                scenes={preview.scenes}
                settingsUrl={preview.settingsUrl}
                width={width}
                {...(preview.initialDevice !== undefined ? { initialDevice: preview.initialDevice } : {})}
                {...(preview.initialMemoryDevice !== undefined
                  ? { initialMemoryDevice: preview.initialMemoryDevice }
                  : {})}
                {...(preview.rememberSettings === false ? { rememberSettings: false } : {})}
              />
            ) : null}
          </aside>
        </>
      ) : null}
    </div>
  );
}
