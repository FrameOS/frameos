import { describe, expect, it } from "vitest";
import { sceneControlNoticeContent } from "../../../../../../frontend/src/scenes/workspace/sceneControlNotice";

// The scene control drawer's "you have changes" notice. Backend and
// frameAdmin keep the save/deploy split (Save persists the form, Deploy
// rebuilds over SSH). The cloud has no scene "save" at all — its settings
// push carries no scene graphs, and its deploy is one durable set_scenes
// push through the uploadScenes shim — so the cloud copy must offer a single
// "Deploy to frame" action and never mention saving.

describe("sceneControlNoticeContent", () => {
  it("renders nothing when the scene is in sync", () => {
    for (const mode of ["backend", "cloud", "frameAdmin"] as const) {
      expect(
        sceneControlNoticeContent({
          mode,
          sceneIsUnsaved: false,
          sceneIsUndeployed: false,
        }),
      ).toBeNull();
    }
  });

  it("cloud: one Deploy action, no Save button, no save-speak in the copy", () => {
    for (const flags of [
      { sceneIsUnsaved: true, sceneIsUndeployed: true },
      { sceneIsUnsaved: true, sceneIsUndeployed: false },
      { sceneIsUnsaved: false, sceneIsUndeployed: true },
    ]) {
      const content = sceneControlNoticeContent({ mode: "cloud", ...flags });
      expect(content).toEqual({
        statusText: "This scene has changes that are not on the frame yet.",
        showSaveButton: false,
        deployLabel: "Deploy to frame",
      });
      // The cloud cannot save a scene; copy claiming otherwise is a lie.
      expect(content?.statusText.toLowerCase()).not.toContain("save");
    }
  });

  it("backend: keeps the save/deploy split", () => {
    expect(
      sceneControlNoticeContent({
        mode: "backend",
        sceneIsUnsaved: true,
        sceneIsUndeployed: true,
      }),
    ).toEqual({
      statusText:
        "This scene has unsaved changes that are not deployed to the frame.",
      showSaveButton: true,
      deployLabel: "Save & deploy",
    });

    expect(
      sceneControlNoticeContent({
        mode: "backend",
        sceneIsUnsaved: true,
        sceneIsUndeployed: false,
      }),
    ).toEqual({
      statusText: "This scene has unsaved changes.",
      showSaveButton: true,
      deployLabel: "Save & deploy",
    });

    expect(
      sceneControlNoticeContent({
        mode: "backend",
        sceneIsUnsaved: false,
        sceneIsUndeployed: true,
      }),
    ).toEqual({
      statusText: "This scene is saved but not deployed to the frame.",
      showSaveButton: false,
      deployLabel: "Deploy changes",
    });
  });

  it("frameAdmin matches the backend wording", () => {
    expect(
      sceneControlNoticeContent({
        mode: "frameAdmin",
        sceneIsUnsaved: true,
        sceneIsUndeployed: false,
      }),
    ).toEqual(
      sceneControlNoticeContent({
        mode: "backend",
        sceneIsUnsaved: true,
        sceneIsUndeployed: false,
      }),
    );
  });
});
