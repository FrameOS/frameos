// The store scene page IS the full-screen workspace: the Editor (the
// template's files: template.json — the scene page's info, its gallery,
// description, versions and listing — each scene's diagram, their apps),
// the AI assistant and the live Preview, each a panel the top bar toggles. The URL hash names the open set — SceneEditorModal
// reads it on load (falling back to the browser's remembered set, then the
// default) and rewrites it in place on every toggle, so a link or a reload
// restores the same view.
//
// Spellings: `#scene-editor[-preview][-ai]` when the Editor is open (the
// pre-Editor-toggle hashes, where the diagram was always there, keep their
// meaning: `#scene-editor` is the editor alone, `#scene-editor-preview`
// editor + preview), `#scene[-preview][-ai]` when it is closed, and the old
// `#live-preview` for the preview alone. The Info column is gone — its
// content is the editor's template.json — so an old link's `-info` token
// reads as the Editor.

/** The workspace's panels, in layout (and toggle) order. */
export type SceneEditorPanelName = "editor" | "ai" | "preview";

/** Which panels the workspace shows. */
export type SceneEditorPanels = Record<SceneEditorPanelName, boolean>;

export const sceneEditorPanelNames: readonly SceneEditorPanelName[] = ["editor", "ai", "preview"];

/** The non-editor panels in the order they appear in a hash. */
const hashTokens: readonly Exclude<SceneEditorPanelName, "editor">[] = ["preview", "ai"];
/** The retired Info column's hash token: its content is the editor's now. */
const legacyInfoToken = "info";

export const noSceneEditorPanels: SceneEditorPanels = {
  ai: false,
  editor: false,
  preview: false,
};

/** First visit (nothing remembered, no hash): the editor (opening on the
 * template's info) and the running preview; the AI assistant is a toggle
 * away. */
export const defaultSceneEditorPanels: SceneEditorPanels = {
  ai: false,
  editor: true,
  preview: true,
};

const scenePrefix = "#scene";
/** The editor alone. */
export const sceneEditorHash = "#scene-editor";
/** Every panel closed: the workspace shows its title and the four toggles. */
export const sceneEmptyHash = "#scene-none";
/** The pre-unification live-preview view: the preview alone. */
export const livePreviewHash = "#live-preview";

function isHashToken(value: string): value is (typeof hashTokens)[number] {
  return (hashTokens as readonly string[]).includes(value);
}

/** How many panels a set has open. */
export function openPanelCount(panels: SceneEditorPanels): number {
  return sceneEditorPanelNames.filter((name) => panels[name]).length;
}

/** A set of just one panel. */
export function onlyPanel(name: SceneEditorPanelName): SceneEditorPanels {
  return { ...noSceneEditorPanels, [name]: true };
}

/** The panel a narrow (single-panel) workspace shows for a set: the last
 * one the user picked while it is still in the set, else the Preview when
 * it is open, else the first open one (null: empty set). */
export function singlePanelFor(
  panels: SceneEditorPanels,
  active: SceneEditorPanelName | null,
): SceneEditorPanelName | null {
  if (active && panels[active]) {
    return active;
  }
  if (panels.preview) {
    return "preview";
  }
  return sceneEditorPanelNames.find((name) => panels[name]) ?? null;
}

/** The hash for a panel set (the exact set — a reload restores it), down to
 * the empty set: closing every panel is a view of its own. */
export function sceneEditorHashFor(panels: SceneEditorPanels): string {
  if (openPanelCount(panels) === 0) {
    return sceneEmptyHash;
  }
  const tokens = hashTokens.filter((name) => panels[name]);
  const suffix = tokens.length === 0 ? "" : `-${tokens.join("-")}`;
  if (panels.editor) {
    return `${sceneEditorHash}${suffix}`;
  }
  return `${scenePrefix}${suffix}`;
}

/** The panel set a hash asks for, or null when the hash is not the
 * workspace's. Panel names are accepted in any order (each at most once);
 * `sceneEditorHashFor` is what spells them canonically. */
export function sceneEditorPanelsForHash(hash: string): SceneEditorPanels | null {
  if (hash === livePreviewHash) {
    return { ...noSceneEditorPanels, preview: true };
  }
  if (hash === sceneEmptyHash) {
    return { ...noSceneEditorPanels };
  }
  if (!hash.startsWith(scenePrefix)) {
    return null;
  }
  const panels = { ...noSceneEditorPanels };
  let rest = hash.slice(scenePrefix.length);
  if (rest === "-editor" || rest.startsWith("-editor-")) {
    panels.editor = true;
    rest = rest.slice("-editor".length);
  }
  if (rest === "") {
    return panels.editor ? panels : null;
  }
  if (!rest.startsWith("-")) {
    return null;
  }
  let sawInfo = false;
  for (const part of rest.slice(1).split("-")) {
    if (part === legacyInfoToken && !sawInfo) {
      sawInfo = true;
      panels.editor = true;
      continue;
    }
    if (!isHashToken(part) || panels[part]) {
      return null;
    }
    panels[part] = true;
  }
  return panels;
}
