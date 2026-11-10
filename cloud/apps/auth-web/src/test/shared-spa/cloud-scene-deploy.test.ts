// @vitest-environment jsdom
//
// Cloud deploy (cloud/docs/cloud-workspace-gaps.md item 3). The workspace's
// Deploy used to POST /api/frames/{id}/deploy, a backend-only route: a 404 and
// a "Failed to start deploy" toast on every cloud frame. Then it pushed the
// form through the uploadScenes shim, which the cloud records as a preview of
// the whole list, outside the assignment ledger. A cloud frame's scenes are its
// assignments: framesModel.deployFrame pushes the assigned list again (POST
// /api/frames/{id}/scenes, one set_scenes), keeping the scene it shows.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initKea } from "../../../../../../frontend/src/initKea";
import type { FrameType } from "../../../../../../frontend/src/types";

const fetchMock = vi.fn<typeof fetch>();

type CloudTestWindow = Window & {
  FRAMEOS_APP_CONFIG?: { cloudMode: boolean; ingress_path: string };
};
const testWindow = window as CloudTestWindow;

// socketLogic dials an account-wide WebSocket on mount; jsdom must not.
class FakeWebSocket {
  onopen: unknown;
  onmessage: unknown;
  onerror: unknown;
  onclose: unknown;
  close(): void {}
}

function cloudFrame(): FrameType {
  return {
    id: "frame-1" as unknown as FrameType["id"],
    project_id: 1,
    name: "Cloud frame",
    managed_by: "cloud",
    frame_host: "",
    frame_port: 8787,
    frame_access_key: "",
    frame_access: "private",
    ssh_port: 22,
    server_port: 8989,
    status: "active",
    interval: 300,
    metrics_interval: 60,
    scaling_mode: "contain",
    background_color: "#000000",
    // The runtime reports ad-hoc scenes with the uploaded/ prefix; the
    // deploy push must strip it back to the payload scene id.
    active_scene_id: "uploaded/scene-1",
    scenes: [
      { id: "scene-1", name: "Clock", nodes: [], edges: [] },
      { id: "scene-2", name: "Weather", nodes: [], edges: [] },
    ],
  } as unknown as FrameType;
}

function requestedPaths(): string[] {
  return fetchMock.mock.calls.map((call) =>
    String(call[0]).split("?")[0] ?? "",
  );
}

describe("the cloud deploy path", () => {
  beforeEach(() => {
    testWindow.FRAMEOS_APP_CONFIG = { cloudMode: true, ingress_path: "" };
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    initKea();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete testWindow.FRAMEOS_APP_CONFIG;
  });

  describe("pure helpers (utils/cloudFrameApi)", () => {
    it("keeps the active scene active, stripping the runtime's uploaded/ prefix", async () => {
      const { cloudDeployActiveSceneId } = await import(
        "../../../../../../frontend/src/utils/cloudFrameApi"
      );
      const scenes = [{ id: "a" }, { id: "b" }];
      expect(cloudDeployActiveSceneId("uploaded/a", scenes)).toBe("a");
      expect(cloudDeployActiveSceneId("b", scenes)).toBe("b");
      // Activating a scene that is not in the pushed set would strand the
      // frame — fall back to "runtime picks" instead.
      expect(cloudDeployActiveSceneId("uploaded/gone", scenes)).toBeUndefined();
      expect(cloudDeployActiveSceneId("gone", scenes)).toBeUndefined();
      expect(cloudDeployActiveSceneId(null, scenes)).toBeUndefined();
      expect(cloudDeployActiveSceneId(undefined, scenes)).toBeUndefined();
    });

    it("translates the shim's 400s into toast-ready messages", async () => {
      const { cloudSceneDeployErrorMessage } = await import(
        "../../../../../../frontend/src/utils/cloudFrameApi"
      );
      expect(
        cloudSceneDeployErrorMessage("scenes_payload_too_large", 400),
      ).toContain("3 MB");
      expect(cloudSceneDeployErrorMessage("invalid_scenes", 400)).toContain(
        "between 1 and 20",
      );
      expect(cloudSceneDeployErrorMessage("frame_not_active", 409)).toContain(
        "pending",
      );
      expect(cloudSceneDeployErrorMessage("weird_code", 400)).toContain(
        "weird_code",
      );
      expect(cloudSceneDeployErrorMessage(undefined, 502)).toContain("502");
    });
  });

  describe("framesModel.deployFrame in cloud mode", () => {
    const assigned = [
      { scene_id: "11111111-1111-4111-8111-111111111111", scene_version: null, granted_settings_groups: [] },
      { scene_id: "22222222-2222-4222-8222-222222222222", scene_version: 3, granted_settings_groups: ["unsplash"] },
    ];

    function scenesPost(): Record<string, unknown> | null {
      const call = fetchMock.mock.calls.find(
        (candidate) =>
          String(candidate[0]).split("?")[0]?.endsWith("/api/frames/frame-1/scenes") &&
          ((candidate[1] as RequestInit | undefined)?.method ?? "GET").toUpperCase() === "POST",
      );
      return call ? JSON.parse(String((call[1] as RequestInit).body)) : null;
    }

    async function mountFramesModelWithFrame(frame: FrameType, post: () => Response) {
      fetchMock.mockImplementation(async (input, init) => {
        const path = String(input).split("?")[0] ?? "";
        const method = (init?.method ?? "GET").toUpperCase();
        if (path.endsWith("/api/frames")) {
          return Response.json({ frames: [frame] });
        }
        if (path.endsWith("/api/frames/frame-1/scenes")) {
          return method === "POST" ? post() : Response.json({ scenes: assigned });
        }
        // Hydration reads each assignment's runtime scenes: scene-1, scene-2.
        const pack = path.match(/\/api\/store\/scenes\/([^/]+)\/scenes\.json$/);
        if (pack) {
          const index = assigned.findIndex((row) => row.scene_id === pack[1]);
          return Response.json([{ id: `scene-${index + 1}`, name: `Scene ${index + 1}`, nodes: [], edges: [] }]);
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      });
      const { framesModel } = await import(
        "../../../../../../frontend/src/models/framesModel"
      );
      const unmount = framesModel.mount();
      await vi.waitFor(() => {
        expect(Object.keys(framesModel.values.frames)).toContain("frame-1");
      });
      return { framesModel, unmount };
    }

    it("pushes the assigned list again, keeping the scene it shows, and never uploadScenes, /deploy or /fast_deploy", async () => {
      const { framesModel, unmount } = await mountFramesModelWithFrame(cloudFrame(), () =>
        Response.json({ status: "queued" }),
      );
      try {
        // fastDeploy: true on purpose: fast and full are one thing on the cloud.
        framesModel.actions.deployFrame("frame-1", true);
        await vi.waitFor(() => {
          expect(scenesPost()).not.toBeNull();
        });
        const body = scenesPost();
        expect(body?.scenes).toEqual([
          { scene_id: assigned[0]!.scene_id, settings_groups: [] },
          { scene_id: assigned[1]!.scene_id, scene_version: 3, settings_groups: ["unsplash"] },
        ]);
        // active_scene_id "uploaded/scene-1" → the push names "scene-1".
        expect(body?.scene_id).toBe("scene-1");
        for (const path of requestedPaths()) {
          expect(path).not.toMatch(/\/deploy$|\/fast_deploy$|\/event\/uploadScenes$/);
        }
        const { longRunningTasksModel } = await import(
          "../../../../../../frontend/src/models/longRunningTasksModel"
        );
        await vi.waitFor(() => {
          const task = longRunningTasksModel.values.tasks.find((candidate) => candidate.kind === "deploy");
          expect(task?.status).toBe("success");
        });
      } finally {
        unmount();
      }
    });

    it("says so in the deploy toast when the push fails", async () => {
      const { framesModel, unmount } = await mountFramesModelWithFrame(cloudFrame(), () =>
        Response.json({ error: "frame_not_active" }, { status: 409 }),
      );
      try {
        framesModel.actions.deployFrame("frame-1");
        const { longRunningTasksModel } = await import(
          "../../../../../../frontend/src/models/longRunningTasksModel"
        );
        await vi.waitFor(() => {
          const task = longRunningTasksModel.values.tasks.find((candidate) => candidate.kind === "deploy");
          expect(task?.status).toBe("error");
        });
      } finally {
        unmount();
      }
    });
  });
});
