// The store scene page's full-screen view (the scene editor with its
// toggleable Preview / AI side panels) is hash-addressed: SceneEditorModal
// treats the URL hash as its source of truth and syncs on
// popstate/hashchange, pushing a tagged history entry when it opens itself so
// its Close can pop that entry. These helpers move the URL the same way from
// *outside* the modal (a gallery image click) and nudge the listener, since
// pushState/replaceState do not fire hashchange on their own.

/** Which side panels the editor view shows next to the diagram. */
export type SceneEditorPanels = { preview: boolean; ai: boolean };

export const sceneEditorHash = "#scene-editor";
export const sceneEditorPreviewHash = "#scene-editor-preview";
export const sceneEditorAiHash = "#scene-editor-ai";
export const sceneEditorPreviewAiHash = "#scene-editor-preview-ai";
/** The pre-unification live-preview view; still honoured by old links and
 * opens the editor with the Preview panel. */
export const livePreviewHash = "#live-preview";

/** The hash for a panel set (the exact set — a reload restores it). */
export function sceneEditorHashFor(panels: SceneEditorPanels): string {
  if (panels.preview && panels.ai) {
    return sceneEditorPreviewAiHash;
  }
  if (panels.preview) {
    return sceneEditorPreviewHash;
  }
  if (panels.ai) {
    return sceneEditorAiHash;
  }
  return sceneEditorHash;
}

/** The panel set an editor hash asks for, or null when the hash is not one
 * of the editor's. */
export function sceneEditorPanelsForHash(hash: string): SceneEditorPanels | null {
  switch (hash) {
    case sceneEditorHash:
      return { ai: false, preview: false };
    case sceneEditorPreviewHash:
    case livePreviewHash:
      return { ai: false, preview: true };
    case sceneEditorAiHash:
      return { ai: true, preview: false };
    case sceneEditorPreviewAiHash:
      return { ai: true, preview: true };
    default:
      return null;
  }
}

function notifyHashListeners() {
  window.dispatchEvent(new Event("hashchange"));
}

/** Opens the editor view with the Preview panel (the tagged entry is what
 * SceneEditorModal's Close pops). */
export function openLivePreviewView() {
  window.history.pushState({ frameosSceneEditor: true }, "", sceneEditorPreviewHash);
  notifyHashListeners();
}
