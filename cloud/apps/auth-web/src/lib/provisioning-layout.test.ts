import { describe, expect, it } from "vitest";
import {
  provisioningLayoutOf,
  readProvisioningLayoutBody,
  runtimeScenesByStoreScene,
  withProvisioningLayout,
} from "./provisioning-layout";

const layoutStoreId = "0b4f5c2e-8d7a-4a51-9a51-8a7f3c1d2e10";
const clockStoreId = "1c5e6d3f-9e8b-4b62-8b62-9b8e4d2e3f21";
const packStoreId = "2d6f7e4a-af9c-4c73-9c73-ac9f5e3f4a32";

describe("readProvisioningLayoutBody", () => {
  it("reads the claim code's layout and tells absent from malformed", () => {
    const desk = { name: "Desk", nodes: [], edges: [], settings: { isLayout: true } };
    expect(readProvisioningLayoutBody(undefined)).toBeUndefined();
    expect(readProvisioningLayoutBody(null)).toBeUndefined();
    expect(readProvisioningLayoutBody({ scene: desk, state: { look: "x" } })).toEqual({
      scene: desk,
      state: { look: "x" },
    });
    expect(readProvisioningLayoutBody({ scene: desk, state: {} })).toEqual({ scene: desk });
    expect(readProvisioningLayoutBody("desk")).toBe(false);
    expect(readProvisioningLayoutBody({ scene_id: layoutStoreId, layout_scene_id: "desk" })).toBe(false);
    expect(readProvisioningLayoutBody({ scene: { ...desk, settings: {} } })).toBe(false);
    expect(readProvisioningLayoutBody({ scene: desk, state: [] })).toBe(false);
  });

  it("tolerates whatever the column holds", () => {
    expect(provisioningLayoutOf(null)).toBeNull();
    expect(provisioningLayoutOf({ storeSceneId: "nope", layout: { sceneId: "desk" } })).toBeNull();
    expect(provisioningLayoutOf({ storeSceneId: layoutStoreId, layout: { sceneId: "desk" } })).toEqual({
      layout: { sceneId: "desk" },
      storeSceneId: layoutStoreId,
    });
  });
});

describe("withProvisioningLayout", () => {
  const provisioning = { layout: { sceneId: "desk", state: { look: "contrast" } }, storeSceneId: layoutStoreId };

  it("dresses every copied scene that is not a layout, and installs the layout last", () => {
    const runtime = runtimeScenesByStoreScene([
      { id: "clock", origin: { storeSceneId: clockStoreId } },
      { id: "photos", origin: { storeSceneId: packStoreId } },
      { id: "bar", origin: { storeSceneId: packStoreId }, settings: { isLayout: true } },
      { id: "loose" },
    ]);
    const requested = withProvisioningLayout(
      [
        { sceneId: clockStoreId, sceneVersion: 2, layouts: { clock: { sceneId: "old" } } },
        { sceneId: packStoreId, sceneVersion: null },
      ],
      runtime,
      provisioning,
    );
    expect(requested).toEqual([
      { sceneId: clockStoreId, sceneVersion: 2, layouts: { clock: provisioning.layout } },
      { sceneId: packStoreId, sceneVersion: null, layouts: { photos: provisioning.layout } },
      { sceneId: layoutStoreId, sceneVersion: null },
    ]);
  });

  it("installs the layout alone on a frame that starts with nothing, and never twice", () => {
    expect(withProvisioningLayout([], new Map(), provisioning)).toEqual([
      { sceneId: layoutStoreId, sceneVersion: null },
    ]);
    expect(
      withProvisioningLayout([{ sceneId: layoutStoreId, sceneVersion: 3 }], new Map(), provisioning),
    ).toEqual([{ sceneId: layoutStoreId, sceneVersion: null }]);
  });
});
