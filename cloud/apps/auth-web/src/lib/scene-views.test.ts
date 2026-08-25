// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  openLivePreviewView,
  sceneEditorHashFor,
  sceneEditorPanelsForHash,
  type SceneEditorPanels,
} from "./scene-views";

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scene editor hashes", () => {
  it("round-trips every panel combination through its hash", () => {
    const combinations: SceneEditorPanels[] = [
      { ai: false, preview: false },
      { ai: false, preview: true },
      { ai: true, preview: false },
      { ai: true, preview: true },
    ];
    for (const panels of combinations) {
      expect(sceneEditorPanelsForHash(sceneEditorHashFor(panels))).toEqual(panels);
    }
    expect(sceneEditorHashFor({ ai: false, preview: false })).toBe("#scene-editor");
    expect(sceneEditorHashFor({ ai: false, preview: true })).toBe("#scene-editor-preview");
    expect(sceneEditorHashFor({ ai: true, preview: false })).toBe("#scene-editor-ai");
    expect(sceneEditorHashFor({ ai: true, preview: true })).toBe("#scene-editor-preview-ai");
  });

  it("treats the old #live-preview hash as the editor with its Preview panel", () => {
    expect(sceneEditorPanelsForHash("#live-preview")).toEqual({ ai: false, preview: true });
  });

  it("is null for hashes that are not the editor's", () => {
    expect(sceneEditorPanelsForHash("")).toBeNull();
    expect(sceneEditorPanelsForHash("#settings-openai")).toBeNull();
  });
});

describe("openLivePreviewView", () => {
  it("pushes the editor-with-preview hash, tagged for the modal's Close, and nudges the listeners", () => {
    const hashChanged = vi.fn();
    window.addEventListener("hashchange", hashChanged);
    openLivePreviewView();
    expect(window.location.hash).toBe("#scene-editor-preview");
    expect(window.history.state).toEqual({ frameosSceneEditor: true });
    expect(hashChanged).toHaveBeenCalledOnce();
    window.removeEventListener("hashchange", hashChanged);
  });
});
