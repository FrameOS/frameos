// @vitest-environment jsdom
//
// "Preview on frame" goes through the control plane first, as Activate does:
// the plane records the preview (the preview row, its Install and Discard)
// and pushes it. USB used to go first on an ESP32 on this browser's cable, and
// the plane never heard of the preview. Over USB now only when the plane
// cannot be reached, with the frame's scene list kept (the preview's scenes
// alone replaced the frame's whole set), and the task says the plane does not
// know (docs/scene-previews.md "Over USB").
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn<(input: string, init?: RequestInit) => Promise<Response>>());
vi.mock("../../../../../../frontend/src/utils/apiFetch", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, apiFetch: (input: string, init?: RequestInit) => apiFetchMock(input, init) };
});

const usbCommandMock = vi.hoisted(() =>
  vi.fn<(frameId: unknown, command: string, options?: { payload?: Uint8Array }) => Promise<unknown>>(),
);
vi.mock("../../../../../../frontend/src/models/embeddedUsbLogsModel", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    embeddedUsbApiCanUse: () => true,
    runEmbeddedUsbApiCommand: (frameId: unknown, command: string, options?: { payload?: Uint8Array }) =>
      usbCommandMock(frameId, command, options),
  };
});

import { initKea } from "../../../../../../frontend/src/initKea";
import { framesModel } from "../../../../../../frontend/src/models/framesModel";
import { longRunningTasksModel } from "../../../../../../frontend/src/models/longRunningTasksModel";
import { frameLogic } from "../../../../../../frontend/src/scenes/frame/frameLogic";
import { scenesLogic } from "../../../../../../frontend/src/scenes/frame/panels/Scenes/scenesLogic";
import type { FrameScene, FrameType } from "../../../../../../frontend/src/types";

type TestWindow = Window & { FRAMEOS_EMBEDDED_NO_BACKEND?: boolean };
const testWindow = window as TestWindow;
const frameId = 64 as unknown as FrameType["id"];
const listed: FrameScene[] = [
  { id: "clock", name: "Clock", nodes: [], edges: [] } as unknown as FrameScene,
  { id: "weather", name: "Weather", nodes: [], edges: [] } as unknown as FrameScene,
];
const frame = { id: 64, project_id: 1, name: "Desk", mode: "embedded", scenes: listed };
const draft = { id: "draft", name: "Draft", nodes: [], edges: [] } as unknown as FrameScene;

let planeAnswers: () => Promise<Response>;

function previewCalls(): string[] {
  return apiFetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.endsWith("/event/uploadScenes"));
}

beforeEach(() => {
  testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
  apiFetchMock.mockReset();
  usbCommandMock.mockReset();
  usbCommandMock.mockResolvedValue({ ok: true });
  planeAnswers = async () => Response.json({ message: "ok" });
  apiFetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/event/uploadScenes")) {
      return planeAnswers();
    }
    return /\/api\/frames$/.test(url) ? Response.json({ frames: [frame] }) : Response.json({ frame });
  });
  initKea();
  framesModel.mount();
  longRunningTasksModel.mount();
});

afterEach(() => {
  delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
});

async function mountedScenes() {
  const logic = scenesLogic({ frameId });
  logic.mount();
  await waitFor(() => expect(frameLogic({ frameId }).values.frame?.id).toBe(64));
  return logic;
}

describe("previewing a scene on an ESP32 on this browser's USB", () => {
  it("goes through the control plane, and leaves the cable alone", async () => {
    const logic = await mountedScenes();
    logic.actions.previewScene("draft", undefined, [draft]);
    await waitFor(() => expect(previewCalls()).toHaveLength(1));
    await waitFor(() => expect(logic.values.previewingSceneId).toBeNull());
    expect(usbCommandMock).not.toHaveBeenCalled();
    const body = JSON.parse(String(apiFetchMock.mock.calls.find(([url]) => String(url).endsWith("/event/uploadScenes"))?.[1]?.body));
    expect(body.sceneId).toBe("draft");
  });

  it("falls back to USB when the plane cannot be reached, with the frame's list kept, and says the plane does not know", async () => {
    planeAnswers = async () => new Response("down", { status: 502 });
    const logic = await mountedScenes();
    logic.actions.previewScene("draft", undefined, [draft]);
    await waitFor(() => expect(usbCommandMock).toHaveBeenCalledTimes(1));

    const [, command, options] = usbCommandMock.mock.calls[0] ?? [];
    expect(command).toBe("upload-scenes");
    const sent = JSON.parse(new TextDecoder().decode(options?.payload));
    expect(sent.sceneId).toBe("draft");
    expect(sent.scenes.map((scene: FrameScene) => scene.id)).toEqual(["clock", "weather", "draft"]);

    await waitFor(() => {
      const tasks = Object.values(longRunningTasksModel.values.tasks ?? {}) as Array<{ status?: string; detail?: string }>;
      expect(tasks.some((task) => /does not know about this preview/.test(task.detail ?? ""))).toBe(true);
    });
  });
});
