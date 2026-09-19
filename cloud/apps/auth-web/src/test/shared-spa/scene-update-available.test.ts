// @vitest-environment jsdom
//
// "Update available" on an installed scene, and "Update to latest"
// (frontend/src/scenes/frame/panels/Scenes/sceneUpdatesLogic.ts). The two
// control planes keep an installed scene differently, so each half is pinned
// on its own:
//
//   * cloud   — the scene is a store-scene ASSIGNMENT. The frame holds the
//     version it was last sent, the workspace shows that version (not the
//     store's latest), and the update is one server call that moves the
//     assignment and pushes.
//   * backend — the scene is a COPY stamped with its origin. A newer version
//     is found in any catalog that lists the source, the account's private
//     cloud scenes included — they live in their own logic, not in
//     /api/repositories, and used to be invisible here.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";

const apiFetchMock = vi.hoisted(() => vi.fn<(input: string, init?: RequestInit) => Promise<Response>>());
vi.mock("../../../../../../frontend/src/utils/apiFetch", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, apiFetch: (input: string, init?: RequestInit) => apiFetchMock(input, init) };
});
// The dialog has no host in this harness and would fall back to
// window.confirm; the question itself is asserted through the mock.
const confirmMock = vi.hoisted(() => vi.fn<(request: { message: string }) => Promise<boolean>>());
vi.mock("../../../../../../frontend/src/utils/confirmDialogLogic", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, confirmDialog: confirmMock };
});

import { initKea } from "../../../../../../frontend/src/initKea";
import { framesModel } from "../../../../../../frontend/src/models/framesModel";
import { cloudDriveLogic } from "../../../../../../frontend/src/scenes/frame/panels/Templates/cloudDriveLogic";
import { frameLogic } from "../../../../../../frontend/src/scenes/frame/frameLogic";
import { sceneUpdatesLogic } from "../../../../../../frontend/src/scenes/frame/panels/Scenes/sceneUpdatesLogic";
import type { FrameType, TemplateType } from "../../../../../../frontend/src/types";

type TestWindow = Window & {
  FRAMEOS_APP_CONFIG?: { cloudMode: boolean };
  FRAMEOS_EMBEDDED_NO_BACKEND?: boolean;
};
const testWindow = window as TestWindow;

const storeSceneId = "11111111-2222-4333-8444-555555555555";

function sceneJson(version: number): unknown[] {
  return [
    {
      id: "rt-1",
      name: "Abstract Architecture",
      nodes: [
        { id: "render", type: "event", position: { x: 0, y: 0 }, data: { keyword: "render" } },
        ...(version >= 5 ? [{ id: "added-in-v5", type: "event", position: { x: 0, y: 0 }, data: { keyword: "init" } }] : []),
      ],
      edges: [],
      origin: { storeSceneId, version: String(version), href: "https://scenes.example/s/abstract" },
    },
  ];
}

function calls(pattern: RegExp): string[] {
  return apiFetchMock.mock.calls
    .map(([input, init]) => `${init?.method ?? "GET"} ${String(input)}`)
    .filter((entry) => pattern.test(entry));
}

beforeEach(() => {
  // No websocket, no project lookup: the logics talk to the mocked apiFetch only.
  testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
  apiFetchMock.mockReset();
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(true);
});

afterEach(() => {
  delete testWindow.FRAMEOS_APP_CONFIG;
  delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
});

describe("cloud: a store scene the frame holds an older version of", () => {
  // framesModel throttles hydration per frame id in a module-level map that
  // outlives initKea(), so every test gets a frame of its own.
  let frameNumber = 0;
  let frameId = "";
  // What the server knows; "Update to latest" moves it.
  let assignedVersion: number;

  beforeEach(() => {
    frameNumber += 1;
    frameId = `frame-upd-${frameNumber}`;
    assignedVersion = 3;
    testWindow.FRAMEOS_APP_CONFIG = { cloudMode: true };
    apiFetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === `/api/frames/${frameId}/scenes/update` && method === "POST") {
        assignedVersion = 5;
        return Response.json({ status: "queued", scene_version: 5, previous_version: 3, connected: true });
      }
      if (url === `/api/frames/${frameId}/scenes`) {
        return Response.json({
          scenes: [
            {
              scene_id: storeSceneId,
              // Follows the latest — and is still on v3 until a push.
              scene_version: null,
              assigned_version: assignedVersion,
              latest_version: 5,
              update_available: assignedVersion < 5,
              name: "Abstract Architecture",
            },
          ],
        });
      }
      const scenesJson = url.match(/\/scenes\.json(?:\?version=(\d+))?$/);
      if (scenesJson) {
        return Response.json(sceneJson(scenesJson[1] ? Number(scenesJson[1]) : 5));
      }
      const frame = { id: frameId, name: "Hallway", mode: "embedded", last_state: { active_scene: "rt-1" } };
      return url === "/api/frames" ? Response.json({ frames: [frame] }) : Response.json({ frame });
    });
    initKea();
  });

  it("shows the held version's content and offers the newer one", async () => {
    framesModel.mount();
    const logic = sceneUpdatesLogic({ frameId: frameId as unknown as FrameType["id"] });
    logic.mount();

    await waitFor(() => expect(logic.values.sceneUpdateVersions).toEqual({ "rt-1": "5" }));
    // v3 is what the frame runs: that is what the workspace fetched…
    expect(calls(/scenes\.json/)).toEqual([`GET /api/store/scenes/${storeSceneId}/scenes.json?version=3`]);
    // …and what its origin line says.
    expect(logic.values.installedScenes[0]?.origin?.version).toBe("3");
    expect(logic.values.installedScenes[0]?.nodes.map((node) => node.id)).toEqual(["render"]);
  });

  it("asks, then moves the assignment server-side and rehydrates at the new version", async () => {
    framesModel.mount();
    const logic = sceneUpdatesLogic({ frameId: frameId as unknown as FrameType["id"] });
    logic.mount();
    await waitFor(() => expect(logic.values.sceneUpdateVersions).toEqual({ "rt-1": "5" }));

    logic.actions.confirmSceneUpdate("rt-1");
    await waitFor(() => expect(logic.values.sceneUpdateVersions).toEqual({}));

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.calls[0]![0].message).toContain("deployed right away");
    const update = apiFetchMock.mock.calls.find(([input]) => String(input).endsWith("/scenes/update"));
    // The active runtime scene rides along so the push does not switch scenes.
    expect(JSON.parse(String(update![1]!.body))).toEqual({ scene_id: storeSceneId, active_scene_id: "rt-1" });
    expect(logic.values.installedScenes[0]?.origin?.version).toBe("5");
    expect(logic.values.installedScenes[0]?.nodes.map((node) => node.id)).toEqual(["render", "added-in-v5"]);
  });

  it("does nothing when the owner says no", async () => {
    confirmMock.mockResolvedValue(false);
    framesModel.mount();
    const logic = sceneUpdatesLogic({ frameId: frameId as unknown as FrameType["id"] });
    logic.mount();
    await waitFor(() => expect(logic.values.sceneUpdateVersions).toEqual({ "rt-1": "5" }));

    logic.actions.confirmSceneUpdate("rt-1");
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(calls(/scenes\/update/)).toEqual([]);
  });

  it("an update lands in a form with unsaved edits elsewhere, and keeps those edits", async () => {
    framesModel.mount();
    const typedFrameId = frameId as unknown as FrameType["id"];
    const logic = sceneUpdatesLogic({ frameId: typedFrameId });
    logic.mount();
    await waitFor(() => expect(logic.values.sceneUpdateVersions).toEqual({ "rt-1": "5" }));

    frameLogic({ frameId: typedFrameId }).actions.setFrameFormValues({ name: "Hallway (renamed, unsaved)" });
    await waitFor(() => expect(logic.values.unsavedChanges).toBe(true));

    logic.actions.updateSceneFromRepo("rt-1");
    await waitFor(() =>
      expect(logic.values.installedScenes[0]?.nodes.map((node) => node.id)).toEqual(["render", "added-in-v5"]),
    );
    expect(logic.values.frameForm.name).toBe("Hallway (renamed, unsaved)");
  });
});

describe("backend: a copy installed from the account's private cloud scenes", () => {
  const frameId = 21 as unknown as FrameType["id"];

  beforeEach(() => {
    const frame = {
      id: 21,
      project_id: 1,
      name: "Kitchen",
      mode: "rpios",
      scenes: [
        {
          id: "local-copy",
          name: "My clock",
          nodes: [],
          edges: [],
          origin: { repositoryId: "cloud-drive", storeSceneId, sceneId: "rt-1", templateName: "My clock", version: "3" },
        },
      ],
    };
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (/\/api\/repositories/.test(url)) {
        return Response.json([]);
      }
      return /\/api\/frames$/.test(url) ? Response.json({ frames: [frame] }) : Response.json({ frame });
    });
    initKea();
  });

  it("finds the newer version in the private drive, which no repository row lists", async () => {
    framesModel.mount();
    const logic = sceneUpdatesLogic({ frameId });
    logic.mount();
    await waitFor(() => expect(logic.values.installedScenes).toHaveLength(1));
    expect(logic.values.sceneUpdateVersions).toEqual({});

    cloudDriveLogic.actions.loadDriveSuccess([
      { id: "my-clock", name: "My clock", sceneId: storeSceneId, version: "4" } as unknown as TemplateType,
    ]);
    expect(logic.values.sceneUpdateVersions).toEqual({ "local-copy": "4" });

    // Same version in the drive again: nothing to offer.
    cloudDriveLogic.actions.loadDriveSuccess([
      { id: "my-clock", name: "My clock", sceneId: storeSceneId, version: "3" } as unknown as TemplateType,
    ]);
    expect(logic.values.sceneUpdateVersions).toEqual({});
  });
});
