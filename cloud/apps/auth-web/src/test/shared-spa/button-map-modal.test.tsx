// @vitest-environment jsdom
//
// "Map buttons" (frontend/src/scenes/frame/panels/Scenes/ButtonMapModal.tsx
// + buttonMapLogic.ts): one row per button the scene listens for, a choice
// per row among the frame's buttons and presses, and Apply writes the
// installed scene's `eventMap` into the frame form (docs/events.md, "Event
// map") — never into its nodes. The rule arithmetic is pinned in
// scene-event-map.test.ts.
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
import { ButtonMapModal } from "../../../../../../frontend/src/scenes/frame/panels/Scenes/ButtonMapModal";
import { buttonMapLogic } from "../../../../../../frontend/src/scenes/frame/panels/Scenes/buttonMapLogic";
import type { FrameType } from "../../../../../../frontend/src/types";

type TestWindow = Window & { FRAMEOS_EMBEDDED_NO_BACKEND?: boolean };
const testWindow = window as TestWindow;
const frameId = 31 as unknown as FrameType["id"];

const eventNode = (id: string, config: Record<string, string>) => ({
  id,
  type: "event",
  position: { x: 0, y: 0 },
  data: { keyword: "button", config },
});

// A reTerminal (REFRESH, LEFT, RIGHT) running a scene written for an Inky's A and B.
const frame = {
  id: 31,
  project_id: 1,
  name: "Kitchen",
  mode: "rpios",
  gpio_buttons: [
    { pin: 3, label: "REFRESH" },
    { pin: 4, label: "LEFT" },
    { pin: 5, label: "RIGHT" },
  ],
  scenes: [
    {
      id: "clock",
      name: "Clock",
      nodes: [eventNode("e1", { label: "A" }), eventNode("e2", { label: "B", action: "press" })],
      edges: [],
    },
  ],
};

beforeEach(() => {
  testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
  // headlessui's Dialog measures itself; jsdom has no ResizeObserver.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (input) =>
    /\/api\/frames$/.test(String(input)) ? Response.json({ frames: [frame] }) : Response.json({ frame }),
  );
  initKea();
  framesModel.mount();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
});

describe("ButtonMapModal", () => {
  it("maps the scene's A to a REFRESH press and its B to a long press, and writes the rules beside the scene", async () => {
    const logic = buttonMapLogic({ frameId, sceneId: "clock" });
    logic.mount();
    await waitFor(() => expect(frameLogic({ frameId }).values.frame?.id).toBe(31));
    logic.actions.openButtonMap();
    render(<ButtonMapModal frameId={frameId} sceneId="clock" />);

    expect(await screen.findByText("A")).toBeTruthy();
    expect(screen.getByText("B · press")).toBeTruthy();
    const [selectA, selectB] = screen.getAllByRole("combobox") as HTMLSelectElement[];
    // Neither key exists on this frame, which the default option says.
    expect(selectA!.options[selectA!.selectedIndex]!.textContent).toBe("As is (no button on this frame)");
    const apply = screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);

    fireEvent.change(selectA!, { target: { value: JSON.stringify(["REFRESH", "press"]) } });
    fireEvent.change(selectB!, { target: { value: JSON.stringify(["REFRESH", "press"]) } });
    // One press cannot mean two things.
    expect(await screen.findByText(/REFRESH · press is mapped to A and B/)).toBeTruthy();
    expect(apply.disabled).toBe(true);

    fireEvent.change(selectB!, { target: { value: JSON.stringify(["REFRESH", "longPress"]) } });
    await waitFor(() => expect(apply.disabled).toBe(false));
    fireEvent.click(apply);

    await waitFor(() => expect(screen.queryByRole("button", { name: "Apply" })).toBeNull());
    const saved = frameLogic({ frameId }).values.frameForm.scenes?.[0];
    expect(saved?.eventMap).toEqual([
      { event: "button", match: { label: "REFRESH", action: "press" }, as: { label: "A" } },
      { event: "button", match: { label: "REFRESH", action: "longPress" }, as: { label: "B", action: "press" } },
    ]);
    // The nodes are the scene's own, untouched.
    expect(saved?.nodes.map((node) => node.id)).toEqual(["e1", "e2"]);

    // Reopened, the dialog reads its rules back; "As is" on both clears the key.
    logic.actions.openButtonMap();
    const [againA, againB] = (await screen.findAllByRole("combobox")) as HTMLSelectElement[];
    expect(againA!.value).toBe(JSON.stringify(["REFRESH", "press"]));
    expect(againB!.value).toBe(JSON.stringify(["REFRESH", "longPress"]));
    fireEvent.change(againA!, { target: { value: "" } });
    fireEvent.change(againB!, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(frameLogic({ frameId }).values.frameForm.scenes?.[0]).not.toHaveProperty("eventMap"),
    );
  });
});
