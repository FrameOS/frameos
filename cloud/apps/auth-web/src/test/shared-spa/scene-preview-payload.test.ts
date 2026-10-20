import { describe, expect, it } from "vitest";
import type { FrameScene } from "../../../../../../frontend/src/types";
import { collectScenePreviewPayloadScenes } from "../../../../../../frontend/src/utils/scenePreviewPayload";

// The scene drawer's Preview (in the browser) and the on-frame preview send
// the scene with the drawer's values seeded in. The refresh interval is
// usually the implicit field (utils/refreshInterval.ts), which is no field
// of the scene's: its value has to land in settings.refreshInterval.

function scene(partial: Partial<FrameScene>): FrameScene {
  return { id: "s", name: "Scene", nodes: [], edges: [], ...partial } as unknown as FrameScene;
}

function seeded(root: FrameScene, state: Record<string, unknown>): FrameScene {
  const [first] = collectScenePreviewPayloadScenes(root, [root], state);
  if (!first) {
    throw new Error("no scene in the payload");
  }
  return first;
}

describe("collectScenePreviewPayloadScenes", () => {
  it("puts a changed implicit refresh interval into settings", () => {
    const root = scene({
      fields: [{ name: "city", type: "string", value: "Tallinn", access: "public" }] as never,
      settings: { refreshInterval: 300 } as never,
    });
    const payload = seeded(root, { city: "Tartu", refreshInterval: "60" });
    expect(payload.settings?.refreshInterval).toBe(60);
    expect(payload.fields?.[0]?.value).toBe("Tartu");
  });

  it("does it for a scene with no fields of its own", () => {
    const root = scene({ settings: { refreshInterval: 300 } as never });
    const payload = seeded(root, { refreshInterval: 15 });
    expect(payload.settings?.refreshInterval).toBe(15);
  });

  it("a declared refresh interval field keeps its value in the field", () => {
    const root = scene({
      fields: [{ name: "refreshInterval", type: "float", value: "300", access: "public" }] as never,
      settings: { refreshInterval: 300 } as never,
    });
    const payload = seeded(root, { refreshInterval: "60" });
    expect(payload.fields?.[0]?.value).toBe("60");
    expect(payload.settings?.refreshInterval).toBe(300);
  });

  it("ignores an interval that is not a positive number", () => {
    const root = scene({ settings: { refreshInterval: 300 } as never });
    const payload = seeded(root, { refreshInterval: "" });
    expect(payload.settings?.refreshInterval).toBe(300);
  });
});
