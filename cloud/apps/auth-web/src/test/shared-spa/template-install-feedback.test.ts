// @vitest-environment jsdom
//
// Installing a catalog scene downloads it first (a self-hosted backend fetches
// the store's zip), and only then does a tile appear. templatesLogic says
// which installs are in flight so the row's Install button can spin meanwhile
// — and a download that fails says so instead of the click doing nothing.
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn<(input: string, init?: RequestInit) => Promise<Response>>());
vi.mock("../../../../../../frontend/src/utils/apiFetch", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, apiFetch: (input: string, init?: RequestInit) => apiFetchMock(input, init) };
});

import { initKea } from "../../../../../../frontend/src/initKea";
import { framesModel } from "../../../../../../frontend/src/models/framesModel";
import { longRunningTasksModel } from "../../../../../../frontend/src/models/longRunningTasksModel";
import { frameLogic } from "../../../../../../frontend/src/scenes/frame/frameLogic";
import { templateFavouriteId } from "../../../../../../frontend/src/scenes/frame/panels/Templates/templateFavourites";
import { templatesLogic } from "../../../../../../frontend/src/scenes/frame/panels/Templates/templatesLogic";
import type { FrameType, RepositoryType, TemplateType } from "../../../../../../frontend/src/types";

type TestWindow = Window & { FRAMEOS_EMBEDDED_NO_BACKEND?: boolean };
const testWindow = window as TestWindow;
const frameId = 63 as unknown as FrameType["id"];
const frame = { id: 63, project_id: 1, name: "Hallway", mode: "rpios", scenes: [] };

const scenesUrl = "https://store.example/scenes/weather/scenes.json";
const repository = { id: "store", name: "Store", url: "https://store.example/repository.json" } as unknown as RepositoryType;
const template = { id: "weather", name: "Weather", scenesUrl } as unknown as TemplateType;
const installId = templateFavouriteId(template, repository);

let templateScenes: Promise<Response>;

beforeEach(() => {
  testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === scenesUrl) {
      return templateScenes;
    }
    if (/\/api\/(repositories|templates)/.test(url)) {
      return Response.json([]);
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

describe("installing a catalog scene", () => {
  it("is marked as in flight from the click until the scene is on the frame", async () => {
    const logic = templatesLogic({ frameId });
    logic.mount();
    await waitFor(() => expect(frameLogic({ frameId }).values.frame?.id).toBe(63));

    let deliver = (_: Response): void => {};
    templateScenes = new Promise<Response>((resolve) => (deliver = resolve));
    logic.actions.applyRemoteToFrame(repository, template);
    expect(logic.values.installingTemplateIds).toEqual({ [installId]: true });

    // A second click while it runs installs nothing twice.
    logic.actions.applyRemoteToFrame(repository, template);
    expect(apiFetchMock.mock.calls.filter(([input]) => String(input) === scenesUrl)).toHaveLength(1);

    deliver(Response.json([{ id: "t-1", name: "Weather", nodes: [], edges: [] }]));
    await waitFor(() => expect(logic.values.installingTemplateIds).toEqual({}));
    expect(frameLogic({ frameId }).values.frameForm.scenes?.map((scene) => scene.name)).toEqual(["Weather"]);
  });

  it("reports a download that fails, and lets go of the button", async () => {
    const logic = templatesLogic({ frameId });
    logic.mount();
    await waitFor(() => expect(frameLogic({ frameId }).values.frame?.id).toBe(63));

    templateScenes = Promise.resolve(new Response("nope", { status: 502 }));
    logic.actions.applyRemoteToFrame(repository, template);
    await waitFor(() => expect(logic.values.installingTemplateIds).toEqual({}));

    expect(frameLogic({ frameId }).values.frameForm.scenes ?? []).toEqual([]);
    const [task] = longRunningTasksModel.values.tasks;
    expect(task?.status).toBe("error");
    expect(task?.title).toBe('Adding "Weather"');
  });
});
