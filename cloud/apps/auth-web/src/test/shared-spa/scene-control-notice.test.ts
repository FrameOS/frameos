import { describe, expect, it } from "vitest";
import { sceneControlNoticeContent } from "../../../../../../frontend/src/scenes/workspace/sceneControlNotice";

// The scene control drawer's "you have changes" notice
// (docs/ui-vocabulary.md: scenes are pushed). The backend keeps the
// save/push split (Save persists the form, Push sends the scene). The cloud
// has no scene "save" at all, so it offers the push alone and never
// mentions saving. On the device there is only Save. On the active scene the
// drawer's main action is the push, so the notice does not offer it twice.

const inactive = { sceneIsActive: false };

describe("sceneControlNoticeContent", () => {
  it("renders nothing when the scene is in sync", () => {
    for (const mode of ["backend", "cloud", "frameAdmin"] as const) {
      expect(
        sceneControlNoticeContent({
          mode,
          sceneIsUnsaved: false,
          sceneIsUndeployed: false,
          ...inactive,
        }),
      ).toBeNull();
    }
  });

  it("cloud: one Push action, no Save button, no save-speak in the copy", () => {
    for (const flags of [
      { sceneIsUnsaved: true, sceneIsUndeployed: true },
      { sceneIsUnsaved: true, sceneIsUndeployed: false },
      { sceneIsUnsaved: false, sceneIsUndeployed: true },
    ]) {
      const content = sceneControlNoticeContent({ mode: "cloud", ...flags, ...inactive });
      expect(content).toEqual({
        statusText: "This scene has changes that are not on the frame yet.",
        showSaveButton: false,
        pushLabel: "Push to frame",
      });
      // The cloud cannot save a scene; copy claiming otherwise is a lie.
      expect(content?.statusText.toLowerCase()).not.toContain("save");
    }
  });

  it("backend: keeps the save/push split", () => {
    expect(
      sceneControlNoticeContent({
        mode: "backend",
        sceneIsUnsaved: true,
        sceneIsUndeployed: true,
        ...inactive,
      }),
    ).toEqual({
      statusText: "This scene has unsaved changes that are not on the frame yet.",
      showSaveButton: true,
      pushLabel: "Save & push",
    });

    expect(
      sceneControlNoticeContent({
        mode: "backend",
        sceneIsUnsaved: true,
        sceneIsUndeployed: false,
        ...inactive,
      }),
    ).toEqual({
      statusText: "This scene has unsaved changes.",
      showSaveButton: true,
      pushLabel: "Save & push",
    });

    expect(
      sceneControlNoticeContent({
        mode: "backend",
        sceneIsUnsaved: false,
        sceneIsUndeployed: true,
        ...inactive,
      }),
    ).toEqual({
      statusText: "This scene is saved but not on the frame yet.",
      showSaveButton: false,
      pushLabel: "Push to frame",
    });
  });

  it("the active scene: the drawer's main action is the push, the notice does not repeat it", () => {
    for (const mode of ["backend", "cloud"] as const) {
      const content = sceneControlNoticeContent({
        mode,
        sceneIsUnsaved: false,
        sceneIsUndeployed: true,
        sceneIsActive: true,
      });
      expect(content?.pushLabel).toBeNull();
    }
  });

  it("frameAdmin: Save only, nowhere to push to", () => {
    expect(
      sceneControlNoticeContent({
        mode: "frameAdmin",
        sceneIsUnsaved: true,
        sceneIsUndeployed: false,
        ...inactive,
      }),
    ).toEqual({
      statusText: "This scene has unsaved changes.",
      showSaveButton: true,
      pushLabel: null,
    });
  });
});
