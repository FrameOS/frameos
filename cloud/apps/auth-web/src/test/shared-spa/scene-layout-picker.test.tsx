// @vitest-environment jsdom
//
// The layout select under a scene's picture and "Layout settings"
// (frontend/src/scenes/frame/panels/Scenes/sceneLayoutLogic.ts): choosing
// writes the installed scene's `layout` into the frame form
// (docs/scene-layouts.md), never into its nodes.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn<(input: string, init?: RequestInit) => Promise<Response>>());
vi.mock("../../../../../../frontend/src/utils/apiFetch", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, apiFetch: (input: string, init?: RequestInit) => apiFetchMock(input, init) };
});

import { initKea } from "../../../../../../frontend/src/initKea";
import { framesModel } from "../../../../../../frontend/src/models/framesModel";
import { frameLogic } from "../../../../../../frontend/src/scenes/frame/frameLogic";
import { frameSettingsSectionRenders } from "../../../../../../frontend/src/scenes/frame/panels/FrameSettings/frameSettingsSurface";
import { FrameLayoutsFields } from "../../../../../../frontend/src/scenes/frame/panels/FrameSettings/sections/layoutsSection";
import { SceneLayoutPicker } from "../../../../../../frontend/src/scenes/frame/panels/Scenes/SceneLayoutPicker";
import { sceneLayoutLogic } from "../../../../../../frontend/src/scenes/frame/panels/Scenes/sceneLayoutLogic";
import type { FrameType } from "../../../../../../frontend/src/types";

type TestWindow = Window & { FRAMEOS_EMBEDDED_NO_BACKEND?: boolean };
const testWindow = window as TestWindow;
const frameId = 41 as unknown as FrameType["id"];

const frame = {
  id: 41,
  project_id: 1,
  name: "Kitchen",
  mode: "rpios",
  scenes: [
    { id: "clock", name: "Clock", nodes: [], edges: [] },
    {
      id: "bar",
      name: "Bar",
      nodes: [],
      edges: [],
      settings: { isLayout: true },
      fields: [{ name: "height", type: "integer", value: "40", access: "public" }],
    },
  ],
};

beforeEach(() => {
  testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (input) =>
    /\/api\/frames$/.test(String(input)) ? Response.json({ frames: [frame] }) : Response.json({ frame }),
  );
  initKea();
  framesModel.mount();
});

afterEach(() => {
  cleanup();
  delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
});

async function mounted() {
  const logic = frameLogic({ frameId });
  logic.mount();
  await waitFor(() => expect(logic.values.frameForm?.scenes?.length).toBe(2));
  return logic;
}

const sceneNamed = (logic: ReturnType<typeof frameLogic>, id: string) =>
  logic.values.frameForm.scenes?.find((scene) => scene.id === id);

describe("the layout picker", () => {
  it("writes the choice beside the scene, keeps its settings, and clears it", async () => {
    const logic = await mounted();
    render(<SceneLayoutPicker frameId={frameId} sceneId="clock" />);
    fireEvent.change(screen.getByLabelText("Layout"), { target: { value: "bar" } });
    expect(sceneNamed(logic, "clock")?.layout).toEqual({ sceneId: "bar" });

    const layout = sceneLayoutLogic({ frameId, sceneId: "clock" });
    layout.mount();
    layout.actions.openLayoutSettings();
    expect(layout.values.fields.map((field: { name: string }) => field.name)).toContain("height");
    layout.actions.setStateValue({ name: "height" } as never, 60);
    layout.actions.saveLayoutSettings();
    expect(sceneNamed(logic, "clock")?.layout).toEqual({ sceneId: "bar", state: { height: 60 } });

    fireEvent.change(screen.getByLabelText("Layout"), { target: { value: "" } });
    expect(sceneNamed(logic, "clock")).not.toHaveProperty("layout");
  });

  it("shows nothing on a layout", async () => {
    await mounted();
    const { container } = render(<SceneLayoutPicker frameId={frameId} sceneId="bar" />);
    expect(container.querySelector("select")).toBeNull();
  });
});

describe("the Layouts section of a frame's settings", () => {
  async function mountedWithThree() {
    const logic = await mounted();
    logic.actions.setFrameFormValues({
      scenes: [
        { ...frame.scenes[0], layout: { sceneId: "bar", state: { height: 60 } } },
        { id: "photos", name: "Photos", nodes: [], edges: [] },
        frame.scenes[1],
      ],
    } as never);
    return logic;
  }

  it("sets one scene, then all of them, keeping the settings of a scene that already wears it", async () => {
    const logic = await mountedWithThree();
    render(<FrameLayoutsFields frameId={frameId} />);
    const all = screen.getByLabelText("Layout for all scenes") as HTMLSelectElement;
    expect(all.value).toBe("__different");

    fireEvent.change(screen.getByLabelText("Layout for Photos"), { target: { value: "bar" } });
    expect(sceneNamed(logic, "photos")?.layout).toEqual({ sceneId: "bar" });
    expect(all.value).toBe("bar");

    fireEvent.change(all, { target: { value: "" } });
    expect(sceneNamed(logic, "clock")).not.toHaveProperty("layout");
    expect(sceneNamed(logic, "photos")).not.toHaveProperty("layout");
    expect(sceneNamed(logic, "bar")).not.toHaveProperty("layout");

    fireEvent.change(all, { target: { value: "bar" } });
    expect(sceneNamed(logic, "clock")?.layout).toEqual({ sceneId: "bar" });
    expect(sceneNamed(logic, "bar")).not.toHaveProperty("layout");
  });

  it("is on every surface that saves scenes", () => {
    for (const surface of ["backend", "frameAdmin", "cloudLinux", "cloudEsp32", "cloudVirtual"] as const) {
      expect(frameSettingsSectionRenders("layouts", surface)).toBe(true);
    }
  });
});
