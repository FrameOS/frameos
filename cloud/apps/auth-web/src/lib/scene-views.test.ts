import { describe, expect, it } from "vitest";
import {
  defaultSceneEditorPanels,
  openPanelCount,
  sceneEditorHashFor,
  sceneEditorPanelsForHash,
  type SceneEditorPanels,
} from "./scene-views";

function panels(open: Partial<SceneEditorPanels>): SceneEditorPanels {
  return { ai: false, editor: false, info: false, preview: false, ...open };
}

describe("scene editor hashes", () => {
  it("round-trips every non-empty panel combination through its hash", () => {
    for (const info of [false, true]) {
      for (const editor of [false, true]) {
        for (const ai of [false, true]) {
          for (const preview of [false, true]) {
            const set = panels({ ai, editor, info, preview });
            if (openPanelCount(set) === 0) {
              continue;
            }
            expect(sceneEditorPanelsForHash(sceneEditorHashFor(set))).toEqual(set);
          }
        }
      }
    }
  });

  it("keeps the pre-Editor-toggle spellings meaning what they did (editor included)", () => {
    expect(sceneEditorHashFor(panels({ editor: true }))).toBe("#scene-editor");
    expect(sceneEditorHashFor(panels({ editor: true, preview: true }))).toBe("#scene-editor-preview");
    expect(sceneEditorHashFor(panels({ ai: true, editor: true }))).toBe("#scene-editor-ai");
    expect(sceneEditorHashFor(panels({ ai: true, editor: true, preview: true }))).toBe(
      "#scene-editor-preview-ai",
    );
    expect(sceneEditorHashFor(panels({ editor: true, info: true, preview: true }))).toBe(
      "#scene-editor-info-preview",
    );
    expect(sceneEditorHashFor(panels({ ai: true, editor: true, info: true, preview: true }))).toBe(
      "#scene-editor-info-preview-ai",
    );
  });

  it("spells editor-less sets with the plain #scene prefix", () => {
    expect(sceneEditorHashFor(panels({ info: true, preview: true }))).toBe("#scene-info-preview");
    expect(sceneEditorHashFor(panels({ preview: true }))).toBe("#scene-preview");
    expect(sceneEditorHashFor(panels({ info: true }))).toBe("#scene-info");
    expect(sceneEditorHashFor(panels({ ai: true, info: true }))).toBe("#scene-info-ai");
    expect(sceneEditorHashFor(panels({ ai: true, preview: true }))).toBe("#scene-preview-ai");
    // Nothing open is a view of its own.
    expect(sceneEditorHashFor(panels({}))).toBe("#scene-none");
    expect(sceneEditorPanelsForHash("#scene-none")).toEqual(panels({}));
  });

  it("reads the panel names in any order, once each", () => {
    expect(sceneEditorPanelsForHash("#scene-editor-ai-preview")).toEqual(
      panels({ ai: true, editor: true, preview: true }),
    );
    expect(sceneEditorPanelsForHash("#scene-ai-info")).toEqual(panels({ ai: true, info: true }));
    expect(sceneEditorPanelsForHash("#scene-editor-preview-preview")).toBeNull();
    expect(sceneEditorPanelsForHash("#scene-editor-editor")).toBeNull();
    expect(sceneEditorPanelsForHash("#scene-editor-settings")).toBeNull();
    expect(sceneEditorPanelsForHash("#scene-editor-")).toBeNull();
    expect(sceneEditorPanelsForHash("#scene-")).toBeNull();
    expect(sceneEditorPanelsForHash("#scene")).toBeNull();
    expect(sceneEditorPanelsForHash("#scene-editors")).toBeNull();
  });

  it("treats the old #live-preview hash as the preview alone", () => {
    expect(sceneEditorPanelsForHash("#live-preview")).toEqual(panels({ preview: true }));
  });

  it("is null for hashes that are not the workspace's", () => {
    expect(sceneEditorPanelsForHash("")).toBeNull();
    expect(sceneEditorPanelsForHash("#settings-openai")).toBeNull();
    expect(sceneEditorPanelsForHash("#scenes")).toBeNull();
  });
});

describe("defaultSceneEditorPanels", () => {
  it("is Info + Editor + Preview, the AI assistant off", () => {
    expect(defaultSceneEditorPanels).toEqual({ ai: false, editor: true, info: true, preview: true });
  });
});

describe("openPanelCount", () => {
  it("counts the open panels", () => {
    expect(openPanelCount(panels({}))).toBe(0);
    expect(openPanelCount(panels({ editor: true, info: true }))).toBe(2);
  });
});
