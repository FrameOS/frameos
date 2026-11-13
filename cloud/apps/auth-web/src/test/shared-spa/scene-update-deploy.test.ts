// @vitest-environment jsdom
//
// A deploy from the drawer updates the installed scenes that have a newer
// version, on both control planes, and the drawer shows what each update
// changes (sceneUpdatesLogic: pendingSceneUpdates, openSceneUpdateDiff,
// deployWithSceneUpdates). The diff is the scene's code as files: an app's
// TSX diffed line by line, never as a string inside scene JSON (the diff
// itself: scene-diff.test.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";

const apiFetchMock = vi.hoisted(() => vi.fn<(input: string, init?: RequestInit) => Promise<Response>>());
vi.mock("../../../../../../frontend/src/utils/apiFetch", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, apiFetch: (input: string, init?: RequestInit) => apiFetchMock(input, init) };
});

import { initKea } from "../../../../../../frontend/src/initKea";
import { framesModel } from "../../../../../../frontend/src/models/framesModel";
import { frameLogic } from "../../../../../../frontend/src/scenes/frame/frameLogic";
import { cloudDriveLogic } from "../../../../../../frontend/src/scenes/frame/panels/Templates/cloudDriveLogic";
import { sceneUpdatesLogic } from "../../../../../../frontend/src/scenes/frame/panels/Scenes/sceneUpdatesLogic";
import type { FrameScene, FrameType, TemplateType } from "../../../../../../frontend/src/types";
import { templateUpdatePatches } from "../../../../../../frontend/src/utils/sceneTemplateUpdate";

type TestWindow = Window & { FRAMEOS_APP_CONFIG?: { cloudMode: boolean }; FRAMEOS_EMBEDDED_NO_BACKEND?: boolean };
const testWindow = window as TestWindow;

const appV1 = 'export function get() {\n  return <div>Hello</div>\n}\n';
const appV2 = 'export function get() {\n  const name = "world"\n  return <div>Hello {name}</div>\n}\n';

function clockScene(id: string, app: string, extra: Partial<FrameScene> = {}): FrameScene {
  return {
    id,
    name: "Clock",
    nodes: [
      { id: "render", type: "event", position: { x: 0, y: 0 }, data: { keyword: "render" } },
      { id: "app-1", type: "app", position: { x: 200, y: 0 }, data: { keyword: "clock", config: {} } },
      { id: "code-1", type: "code", position: { x: 0, y: 200 }, data: { codeJS: "return 1 + 1" } },
    ],
    edges: [],
    apps: { clock: { name: "Clock", sources: { "app.tsx": app, "config.json": '{\n  "name": "Clock"\n}\n' } } },
    ...extra,
  } as unknown as FrameScene;
}

describe("a template update's patches", () => {
  it("keeps the field values set on the copy and updates a scene installed twice", () => {
    const template = [
      { ...clockScene("t1", appV2), fields: [{ name: "city", type: "string", value: "Tartu" }] } as unknown as FrameScene,
    ];
    const installed = ["copy-a", "copy-b"].map(
      (id, index) =>
        ({
          ...clockScene(id, appV1),
          fields: [{ name: "city", type: "string", value: index === 0 ? "Paris" : "Rome" }],
          origin: { repositoryUrl: "https://repo", templateId: "clock", sceneId: "t1", version: "1" },
        }) as unknown as FrameScene,
    );
    const patches = templateUpdatePatches(installed, template, (sceneId) => ({ sceneId, version: "2" }));
    expect([...patches.keys()]).toEqual(["copy-a", "copy-b"]);
    expect(patches.get("copy-a")!.fields?.[0]?.value).toBe("Paris");
    expect(patches.get("copy-b")!.fields?.[0]?.value).toBe("Rome");
    expect(patches.get("copy-b")!.apps?.clock?.sources["app.tsx"]).toBe(appV2);
    expect(patches.get("copy-a")!.origin).toEqual({ sceneId: "t1", version: "2" });
  });
});

describe("backend: a deploy from the drawer takes the ticked updates along", () => {
  let frameNumber = 40;
  let frameId = 0 as unknown as FrameType["id"];
  const storeSceneId = "aaaaaaaa-2222-4333-8444-555555555555";

  function driveTemplate(app: string): TemplateType {
    return {
      id: "my-clock",
      name: "My clock",
      sceneId: storeSceneId,
      version: "4",
      scenes: [clockScene("t1", app)],
    } as unknown as TemplateType;
  }

  beforeEach(() => {
    frameNumber += 1;
    frameId = frameNumber as unknown as FrameType["id"];
    testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
    const frame = {
      id: frameNumber,
      project_id: 1,
      name: "Kitchen",
      mode: "rpios",
      last_successful_deploy_at: "2026-11-01T00:00:00Z",
      scenes: [
        clockScene("local-copy", appV1, {
          origin: { repositoryId: "cloud-drive", storeSceneId, sceneId: "t1", templateName: "My clock", version: "3" },
        }),
      ],
    };
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (/\/api\/repositories/.test(url)) {
        return Response.json([]);
      }
      if (url.startsWith(`/api/frames/${frameNumber}/fast_deploy`)) {
        return Response.json({ message: "ok" });
      }
      if (url === `/api/frames/${frameNumber}`) {
        return Response.json({ frame });
      }
      return /\/api\/frames$/.test(url) ? Response.json({ frames: [frame] }) : Response.json({ frame });
    });
    initKea();
  });

  afterEach(() => {
    delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
  });

  function mountWithUpdate() {
    framesModel.mount();
    frameLogic({ frameId }).mount();
    const logic = sceneUpdatesLogic({ frameId });
    logic.mount();
    cloudDriveLogic.actions.loadDriveSuccess([driveTemplate(appV2)]);
    return logic;
  }

  it("lists the update and shows its TSX change line by line", async () => {
    const logic = mountWithUpdate();
    await waitFor(() => expect(logic.values.pendingSceneUpdates).toHaveLength(1));
    expect(logic.values.pendingSceneUpdates[0]).toMatchObject({
      name: "Clock",
      sceneIds: ["local-copy"],
      fromVersion: "3",
      toVersion: "4",
    });

    logic.actions.openSceneUpdateDiff(logic.values.pendingSceneUpdates[0]!.key);
    await waitFor(() => expect(logic.values.sceneUpdateDiff?.loading).toBe(false));
    const paths = logic.values.sceneUpdateDiff!.files!.map((file) => file.path);
    // The version moves in scene.json's origin; the code in its own file.
    expect(paths).toEqual(["scene.json", "apps/clock/app.tsx"]);
    const sceneJson = logic.values.sceneUpdateDiff!.files![0]!;
    expect(sceneJson.hunks.flatMap((hunk) => hunk.lines).some((line) => line.text.includes("<div>"))).toBe(false);
  });

  it("puts the new version in the form, then saves and deploys it", async () => {
    const logic = mountWithUpdate();
    await waitFor(() => expect(logic.values.selectedSceneUpdates).toHaveLength(1));

    logic.actions.deployWithSceneUpdates("fast");

    await waitFor(() =>
      expect(
        apiFetchMock.mock.calls.some(([input]) => String(input).startsWith(`/api/frames/${frameNumber}/fast_deploy`)),
      ).toBe(true),
    );
    const saved = apiFetchMock.mock.calls.find(
      ([input, init]) => String(input) === `/api/frames/${frameNumber}` && init?.method === "POST",
    );
    const body = JSON.parse(String(saved?.[1]?.body ?? "{}")) as { scenes?: FrameScene[] };
    const scene = body.scenes?.find((candidate) => candidate.id === "local-copy");
    expect(scene?.apps?.clock?.sources["app.tsx"]).toBe(appV2);
    expect(scene?.origin?.version).toBe("4");
  });

  it("an unticked update keeps the version the frame has", async () => {
    const logic = mountWithUpdate();
    await waitFor(() => expect(logic.values.pendingSceneUpdates).toHaveLength(1));
    logic.actions.toggleSceneUpdateSkipped(logic.values.pendingSceneUpdates[0]!.key);
    expect(logic.values.selectedSceneUpdates).toEqual([]);

    logic.actions.deployWithSceneUpdates("fast");

    await waitFor(() =>
      expect(
        apiFetchMock.mock.calls.some(([input]) => String(input).startsWith(`/api/frames/${frameNumber}/fast_deploy`)),
      ).toBe(true),
    );
    expect(frameLogic({ frameId }).values.frameForm.scenes?.[0]?.apps?.clock?.sources["app.tsx"]).toBe(appV1);
  });
});

describe("cloud: a deploy from the drawer moves the ticked store scenes in its push", () => {
  let frameNumber = 0;
  let frameId = "";
  const storeSceneId = "bbbbbbbb-2222-4333-8444-555555555555";

  beforeEach(() => {
    frameNumber += 1;
    frameId = `frame-deploy-upd-${frameNumber}`;
    testWindow.FRAMEOS_APP_CONFIG = { cloudMode: true };
    testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === `/api/frames/${frameId}/scenes` && method === "GET") {
        return Response.json({
          scenes: [
            { scene_id: storeSceneId, scene_version: null, assigned_version: 3, latest_version: 5, update_available: true, name: "Clock" },
          ],
        });
      }
      if (url === `/api/frames/${frameId}/scenes` && method === "POST") {
        return Response.json({ ok: true });
      }
      const scenesJson = url.match(/\/scenes\.json(?:\?version=(\d+))?$/);
      if (scenesJson) {
        const version = scenesJson[1] ? Number(scenesJson[1]) : 5;
        return Response.json([
          clockScene("rt-1", version >= 5 ? appV2 : appV1, { origin: { storeSceneId, version: String(version) } }),
        ]);
      }
      const frame = { id: frameId, name: "Hallway", mode: "embedded", status: "active" };
      return url === "/api/frames" ? Response.json({ frames: [frame] }) : Response.json({ frame });
    });
    initKea();
  });

  afterEach(() => {
    delete testWindow.FRAMEOS_APP_CONFIG;
    delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
  });

  it("diffs the held version against the newest, then names the scene in the deploy's push", async () => {
    framesModel.mount();
    const id = frameId as unknown as FrameType["id"];
    frameLogic({ frameId: id }).mount();
    const logic = sceneUpdatesLogic({ frameId: id });
    logic.mount();
    await waitFor(() => expect(logic.values.pendingSceneUpdates).toHaveLength(1));
    expect(logic.values.pendingSceneUpdates[0]).toMatchObject({
      key: storeSceneId,
      sceneIds: ["rt-1"],
      fromVersion: "3",
      toVersion: "5",
    });

    logic.actions.openSceneUpdateDiff(storeSceneId);
    await waitFor(() => expect(logic.values.sceneUpdateDiff?.loading).toBe(false));
    expect(logic.values.sceneUpdateDiff?.files?.map((file) => file.path)).toEqual(["scene.json", "apps/clock/app.tsx"]);

    logic.actions.deployWithSceneUpdates("deploy");
    await waitFor(() =>
      expect(
        apiFetchMock.mock.calls.some(
          ([input, init]) => String(input) === `/api/frames/${frameId}/scenes` && init?.method === "POST",
        ),
      ).toBe(true),
    );
    const push = apiFetchMock.mock.calls.find(
      ([input, init]) => String(input) === `/api/frames/${frameId}/scenes` && init?.method === "POST",
    );
    const body = JSON.parse(String(push?.[1]?.body ?? "{}")) as { scenes: Record<string, unknown>[] };
    expect(body.scenes).toEqual([expect.objectContaining({ scene_id: storeSceneId, latest: true })]);
  });
});
