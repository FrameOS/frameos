// @vitest-environment jsdom
//
// Save & Deploy on the backend (frontend/src/scenes/frame/frameLogic.ts).
// It used to `await asyncActions.submitFrameForm()` and deploy whatever
// happened: kea-forms resolves that promise once the save request is
// dispatched, before the server answers, so the deploy raced the save — and a
// save the backend refused (a 400 on the server host, a field that failed
// validation) still deployed the last saved copy while the drawer kept
// listing the same unsaved changes. Now the deploy waits for the save and
// stays home when it failed; the failure toast says why.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";

const apiFetchMock = vi.hoisted(() => vi.fn<(input: string, init?: RequestInit) => Promise<Response>>());
vi.mock("../../../../../../frontend/src/utils/apiFetch", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, apiFetch: (input: string, init?: RequestInit) => apiFetchMock(input, init) };
});

import { initKea } from "../../../../../../frontend/src/initKea";
import { framesModel } from "../../../../../../frontend/src/models/framesModel";
import { longRunningTasksModel } from "../../../../../../frontend/src/models/longRunningTasksModel";
import { frameLogic } from "../../../../../../frontend/src/scenes/frame/frameLogic";
import type { FrameType } from "../../../../../../frontend/src/types";

type TestWindow = Window & { FRAMEOS_EMBEDDED_NO_BACKEND?: boolean };
const testWindow = window as TestWindow;

function calls(pattern: RegExp): string[] {
  return apiFetchMock.mock.calls
    .map(([input, init]) => `${init?.method ?? "GET"} ${String(input)}`)
    .filter((entry) => pattern.test(entry));
}

// framesModel throttles per frame id in module-level maps that outlive
// initKea(), so every test gets a frame of its own.
let frameNumber = 100;
let frameId: FrameType["id"];
let frame: FrameType;
// What POST /api/frames/{id} answers; a test swaps it to fail or to stall.
let saveResponse: () => Promise<Response>;

beforeEach(() => {
  frameNumber += 1;
  frameId = frameNumber as unknown as FrameType["id"];
  frame = {
    id: frameId,
    project_id: 1,
    name: "Hallway",
    mode: "rpios",
    frame_host: "10.0.0.42",
    frame_port: 8787,
    server_host: "backend.local",
    server_port: 8989,
    status: "ready",
    interval: 300,
    metrics_interval: 60,
    scaling_mode: "contain",
    background_color: "#000000",
    device: "framebuffer",
    scenes: [],
  } as unknown as FrameType;
  saveResponse = async () => Response.json({ frame });
  testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === `/api/frames/${frameId}` && method === "POST") {
      return saveResponse();
    }
    if (/\/(deploy|fast_deploy)/.test(url)) {
      return Response.json({});
    }
    if (url === "/api/frames") {
      return Response.json({ frames: [frame] });
    }
    if (url === `/api/frames/${frameId}`) {
      return Response.json({ frame });
    }
    if (/\/assets/.test(url)) {
      return Response.json([]);
    }
    if (/\/logs/.test(url)) {
      return Response.json({ logs: [] });
    }
    return Response.json({});
  });
  initKea();
});

afterEach(() => {
  delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
});

async function mountWithUnsavedName(): Promise<ReturnType<typeof frameLogic.build>> {
  framesModel.mount();
  longRunningTasksModel.mount();
  const logic = frameLogic({ frameId });
  logic.mount();
  await waitFor(() => expect(logic.values.frame?.id).toBe(frameId));
  logic.actions.setFrameFormValues({ name: "Hallway (renamed)" });
  expect(logic.values.unsavedChanges).toBe(true);
  return logic;
}

function saveToasts(): Array<{ status: string; detail: string | null }> {
  return longRunningTasksModel.values.tasks
    .filter((task) => task.kind === "save")
    .map((task) => ({ status: task.status, detail: task.detail }));
}

describe("backend: Save & Deploy", () => {
  it("deploys only after the save has landed", async () => {
    const logic = await mountWithUnsavedName();
    let finishSave: () => void = () => undefined;
    saveResponse = () =>
      new Promise<Response>((resolve) => {
        finishSave = () => resolve(Response.json({ frame: { ...frame, name: "Hallway (renamed)" } }));
      });

    logic.actions.saveAndDeployFrame();
    await waitFor(() => expect(calls(/^POST \/api\/frames\/\d+$/)).toHaveLength(1));
    // The save is still in flight: no deploy yet
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls(/deploy/)).toEqual([]);

    finishSave();
    await waitFor(() => expect(calls(/deploy/)).toHaveLength(1));
    expect(calls(/^POST /).map((entry) => entry.replace(/\?.*$/, ""))).toEqual([
      `POST /api/frames/${frameId}`,
      `POST /api/frames/${frameId}/deploy`,
    ]);
    expect(logic.values.frameFormSaveError).toBeNull();
  });

  it("a save the backend refuses stops the deploy, keeps the changes and says why", async () => {
    const logic = await mountWithUnsavedName();
    saveResponse = async () =>
      Response.json({ detail: "Server host is not allowed: underscores are not valid in a hostname" }, { status: 400 });

    logic.actions.saveAndDeployFrame();
    await waitFor(() => expect(logic.values.frameFormSaveError).toBeInstanceOf(Error));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls(/deploy/)).toEqual([]);
    expect(logic.values.unsavedChanges).toBe(true);
    expect(saveToasts()).toEqual([
      { status: "error", detail: "Server host is not allowed: underscores are not valid in a hostname" },
    ]);
  });

  it("a form that fails validation is not sent at all, and the toast says so", async () => {
    const logic = await mountWithUnsavedName();
    logic.actions.setFrameFormValues({
      scenes: [
        { id: "scene-1", name: "Clock", nodes: [], edges: [], fields: [{ name: "", type: "string" }] },
      ] as unknown as FrameType["scenes"],
    });
    expect(logic.values.frameFormHasErrors).toBe(true);

    logic.actions.saveAndDeployFrame();
    await waitFor(() => expect(saveToasts()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls(/^POST /)).toEqual([]);
    expect(saveToasts()).toEqual([{ status: "error", detail: "Some fields need fixing before this can be saved" }]);
  });
});
