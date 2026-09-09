// @vitest-environment jsdom
//
// The scene editor (frontend/) has no test runner; its logics are pinned
// from here, built against the embedded editor's frameLogic shim the same way
// embedded-editor-logics.test.ts does.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initKea } from "../../../../../../frontend/src/initKea";
import type { FrameScene, FrameType } from "../../../../../../frontend/src/types";

vi.mock("../../../../../../frontend/src/scenes/frame/frameLogic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../../frontend/src/scenes/frame/frameLogic")>();
  const { embedFrameLogic } = await import("../../../../../../frontend/src/embed/embedFrameLogic");
  return { ...actual, frameLogic: embedFrameLogic };
});

import { embedFrameLogic } from "../../../../../../frontend/src/embed/embedFrameLogic";
import { sceneStateLogic } from "../../../../../../frontend/src/scenes/frame/panels/SceneState/sceneStateLogic";

const frameId = 1 as unknown as FrameType["id"];
const sceneId = "scene-a";

function field(name: string) {
  return { name, label: name, type: "string", persist: "disk", access: "public", value: "" };
}

const scene = {
  id: sceneId,
  name: "A",
  nodes: [],
  edges: [],
  fields: [field("first"), field("second"), field("third")],
  settings: { execution: "interpreted" },
} as unknown as FrameScene;

beforeEach(() => {
  (window as { FRAMEOS_EMBEDDED_NO_BACKEND?: boolean }).FRAMEOS_EMBEDDED_NO_BACKEND = true;
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("null", { status: 404 }))));
  initKea({ memoryRouter: true });
  embedFrameLogic({ frameId }).mount();
  embedFrameLogic({ frameId }).actions.initEmbedFrame({
    id: frameId,
    name: "Embedded",
    scenes: [scene],
    width: 800,
    height: 480,
  } as Partial<FrameType>);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as { FRAMEOS_EMBEDDED_NO_BACKEND?: boolean }).FRAMEOS_EMBEDDED_NO_BACKEND;
});

describe("sceneStateLogic.removeField", () => {
  it("drops that field from the scene and shifts the open editors after it down", () => {
    const logic = sceneStateLogic({ frameId, sceneId });
    const unmount = logic.mount();

    logic.actions.editField(2);
    logic.actions.editField(0);
    expect(logic.values.editingFields).toEqual({ "0": true, "2": true });

    logic.actions.removeField(0);
    expect((logic.values.scene?.fields ?? []).map((f) => f.name)).toEqual(["second", "third"]);
    // The editor that was open on "third" (index 2) is now index 1; the
    // removed field's own entry is gone. Before the fix `=== index` kept
    // exactly the wrong one.
    expect(logic.values.editingFields).toEqual({ "1": true });

    logic.actions.removeField(1);
    expect((logic.values.scene?.fields ?? []).map((f) => f.name)).toEqual(["second"]);
    expect(logic.values.editingFields).toEqual({});
    unmount();
  });

  it("appends and opens a blank field on addField, and appends a given one on createField", () => {
    const logic = sceneStateLogic({ frameId, sceneId });
    const unmount = logic.mount();
    logic.actions.addField();
    expect(logic.values.scene?.fields).toHaveLength(4);
    expect(logic.values.scene?.fields?.[3]).toMatchObject({ name: "", type: "string", persist: "disk", access: "public" });
    expect(logic.values.editingFields).toEqual({ "3": true });

    logic.actions.createField({ name: "fourth", label: "Fourth", type: "integer", persist: "memory", access: "private" });
    expect(logic.values.scene?.fields?.[4]).toMatchObject({ name: "fourth", type: "integer" });
    unmount();
  });
});
