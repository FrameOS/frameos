// "Edit split → Save" regenerates a split scene's graph from its layout. It
// used to regenerate the scene's SETTINGS too — exactly backgroundColor,
// execution and splitScreenLayout — so anything else set on the scene
// silently went back to its default on every layout edit.
import { describe, expect, it } from "vitest";
import { buildSplitScene } from "../../../../../../frontend/src/scenes/frame/frameLogic";
import { defaultSplitScreenSceneLayout } from "../../../../../../frontend/src/utils/splitScreenLayouts";
import type { FrameScene, FrameType } from "../../../../../../frontend/src/types";

const baseFrame: Partial<FrameType> = { id: 1, width: 800, height: 480, interval: 300, mode: "rpios", rotate: 0 };

describe("buildSplitScene", () => {
  it("keeps the edited scene's other settings under the generated keys", () => {
    const layout = defaultSplitScreenSceneLayout();
    const first = buildSplitScene(baseFrame, layout);
    const edited: FrameScene = {
      ...first,
      settings: { ...first.settings, refreshInterval: 42, backgroundColor: "#123456" },
    };
    const frame = { ...baseFrame, scenes: [edited] };

    const saved = buildSplitScene(frame, { ...layout, name: "Renamed" }, edited.id);

    expect(saved.id).toBe(edited.id);
    expect(saved.name).toBe("Renamed");
    expect(saved.settings?.refreshInterval).toBe(42);
    // The three keys the layout owns are still the layout's.
    expect(saved.settings?.backgroundColor).toBe(layout.background.color);
    expect(saved.settings?.execution).toBe("interpreted");
    expect(saved.settings?.splitScreenLayout).toMatchObject({ name: "Renamed" });
  });

  it("does not borrow settings from another scene", () => {
    const layout = defaultSplitScreenSceneLayout();
    const other: FrameScene = { ...buildSplitScene(baseFrame, layout), settings: { refreshInterval: 42 } };
    const created = buildSplitScene({ ...baseFrame, scenes: [other] }, layout);
    expect(created.id).not.toBe(other.id);
    expect(created.settings?.refreshInterval).toBe(300);
  });
});
