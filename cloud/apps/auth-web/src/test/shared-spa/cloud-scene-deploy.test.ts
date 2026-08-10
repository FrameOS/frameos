// @vitest-environment jsdom
//
// Cloud deploy (cloud/docs/cloud-workspace-gaps.md item 3). The workspace's
// Deploy used to POST /api/frames/{id}/deploy — a backend-only route, a
// guaranteed 404 and a "Failed to start deploy" toast on every cloud frame.
// The cloud's deploy primitive is the uploadScenes event shim
// (POST /api/frames/{id}/event/uploadScenes → durable, checksummed
// set_scenes), so framesModel.deployFrame now branches there in cloud mode,
// never touching /deploy or /fast_deploy.

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

function uploadScenesCall(): { path: string; body: Record<string, unknown> } | null {
  const call = fetchMock.mock.calls.find((candidate) =>
    String(candidate[0]).includes("/event/uploadScenes"),
  );
  if (!call) {
    return null;
  }
  return {
    path: String(call[0]),
    body: JSON.parse(String((call[1] as RequestInit | undefined)?.body ?? "{}")),
  };
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

    it("deployCloudFrameScenes posts to the uploadScenes shim and surfaces its errors", async () => {
      const { deployCloudFrameScenes } = await import(
        "../../../../../../frontend/src/utils/cloudFrameApi"
      );
      fetchMock.mockResolvedValueOnce(
        Response.json({ command_id: "c1", status: "queued" }),
      );
      await deployCloudFrameScenes("frame-1", [{ id: "a" }], { sceneId: "a" });
      const call = uploadScenesCall();
      expect(call?.path).toContain("/api/frames/frame-1/event/uploadScenes");
      expect(call?.body).toEqual({ scenes: [{ id: "a" }], sceneId: "a" });

      fetchMock.mockResolvedValueOnce(
        Response.json({ error: "scenes_payload_too_large" }, { status: 400 }),
      );
      await expect(
        deployCloudFrameScenes("frame-1", [{ id: "a" }]),
      ).rejects.toThrow(/3 MB/);
    });
  });

  describe("framesModel.deployFrame in cloud mode", () => {
    async function mountFramesModelWithFrame(frame: FrameType) {
      fetchMock.mockImplementation(async (input) => {
        const path = String(input).split("?")[0] ?? "";
        if (path.endsWith("/api/frames")) {
          return Response.json({ frames: [frame] });
        }
        if (path.endsWith("/event/uploadScenes")) {
          return Response.json({ command_id: "c1", status: "queued" });
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

    it("posts the frame's scenes to event/uploadScenes and never /deploy or /fast_deploy", async () => {
      const { framesModel, unmount } = await mountFramesModelWithFrame(
        cloudFrame(),
      );
      try {
        // fastDeploy: true on purpose — compiled fast-vs-full does not exist
        // for interpreted-only cloud frames, both flags take the shim.
        framesModel.actions.deployFrame("frame-1", true);
        await vi.waitFor(() => {
          expect(uploadScenesCall()).not.toBeNull();
        });

        const call = uploadScenesCall();
        const scenes = call?.body.scenes as { id: string }[];
        expect(scenes.map((scene) => scene.id)).toEqual([
          "scene-1",
          "scene-2",
        ]);
        // active_scene_id "uploaded/scene-1" → payload sceneId "scene-1".
        expect(call?.body.sceneId).toBe("scene-1");

        for (const path of requestedPaths()) {
          expect(path).not.toMatch(/\/deploy$|\/fast_deploy$/);
        }

        const { longRunningTasksModel } = await import(
          "../../../../../../frontend/src/models/longRunningTasksModel"
        );
        const task = longRunningTasksModel.values.tasks.find(
          (candidate) => candidate.kind === "deploy",
        );
        expect(task?.status).toBe("success");
      } finally {
        unmount();
      }
    });

    it("surfaces the shim's size/count 400s in the deploy task toast", async () => {
      const frame = cloudFrame();
      const { framesModel, unmount } = await mountFramesModelWithFrame(frame);
      try {
        fetchMock.mockImplementation(async (input) => {
          const path = String(input).split("?")[0] ?? "";
          if (path.endsWith("/event/uploadScenes")) {
            return Response.json(
              { error: "scenes_payload_too_large" },
              { status: 400 },
            );
          }
          return Response.json({ frames: [frame] });
        });

        framesModel.actions.deployFrame("frame-1");
        const { longRunningTasksModel } = await import(
          "../../../../../../frontend/src/models/longRunningTasksModel"
        );
        await vi.waitFor(() => {
          const task = longRunningTasksModel.values.tasks.find(
            (candidate) => candidate.kind === "deploy",
          );
          expect(task?.status).toBe("error");
          expect(task?.detail).toContain("3 MB");
        });
      } finally {
        unmount();
      }
    });
  });
});
