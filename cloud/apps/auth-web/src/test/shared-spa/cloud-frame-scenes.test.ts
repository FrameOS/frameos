// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeSceneFromLastState,
  cloudSceneCacheKey,
  cloudSceneStub,
  scenesFromStoreSceneJson,
} from "../../../../../../frontend/src/utils/cloudFrameScenes";

// Gap: "i don't see the scenes i added on cloud". Cloud frame payloads are
// scene-less frameSummary rows, so after a reload every scene tile vanished.
// The SPA now hydrates frame.scenes from GET /api/frames/{id}/scenes plus
// each store scene's scenes.json; these are the pure pieces of that path.

describe("cloud frame scene hydration helpers", () => {
  it("uses the scenes.json array verbatim — it carries the runtime scene ids", () => {
    const scenes = [
      { id: "runtime-1", name: "Clock", nodes: [{ id: "n1" }], edges: [] },
      { id: "runtime-2", name: "Weather", nodes: [], edges: [] },
    ];
    expect(scenesFromStoreSceneJson(scenes)).toBe(scenes);
  });

  it("rejects payloads that are not non-empty arrays of scenes with string ids", () => {
    expect(scenesFromStoreSceneJson(null)).toBeNull();
    expect(scenesFromStoreSceneJson({ error: "scene_pulled" })).toBeNull();
    expect(scenesFromStoreSceneJson([])).toBeNull();
    expect(scenesFromStoreSceneJson(["nope"])).toBeNull();
    expect(scenesFromStoreSceneJson([{ name: "no id" }])).toBeNull();
  });

  it("stub tile falls back name -> slug -> 'Untitled scene' and stays renderable", () => {
    expect(cloudSceneStub({ scene_id: "s1", name: "Clock", slug: "clock" })).toEqual({
      id: "s1",
      name: "Clock",
      nodes: [],
      edges: [],
    });
    expect(cloudSceneStub({ scene_id: "s2", name: null, slug: "weather" }).name).toBe(
      "weather",
    );
    expect(cloudSceneStub({ scene_id: "s3", name: "", slug: null }).name).toBe(
      "Untitled scene",
    );
  });

  it("cache key distinguishes pinned versions from tracking latest", () => {
    expect(cloudSceneCacheKey({ scene_id: "s1", scene_version: 3 })).toBe("s1@3");
    expect(cloudSceneCacheKey({ scene_id: "s1", scene_version: null })).toBe("s1@latest");
    expect(cloudSceneCacheKey({ scene_id: "s1" })).toBe("s1@latest");
  });

  // sanitizeFrameForStore lights the Active badge via exactly this mapping:
  // active_scene_id ??= last_state.active_scene.
  it("maps last_state.active_scene only when it is a non-empty string", () => {
    expect(activeSceneFromLastState({ active_scene: "runtime-1" })).toBe("runtime-1");
    expect(activeSceneFromLastState({ active_scene: "" })).toBeNull();
    expect(activeSceneFromLastState({ active_scene: 7 })).toBeNull();
    expect(activeSceneFromLastState({})).toBeNull();
    expect(activeSceneFromLastState(null)).toBeNull();
    expect(activeSceneFromLastState(undefined)).toBeNull();
    expect(activeSceneFromLastState("runtime-1")).toBeNull();
  });
});

describe("listCloudFrameScenes", () => {
  let cloudFrameApi: typeof import("../../../../../../frontend/src/utils/cloudFrameApi");
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(async () => {
    vi.resetModules();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    (window as unknown as Record<string, unknown>).FRAMEOS_APP_CONFIG = {
      cloudMode: true,
      ingress_path: "",
    };
    cloudFrameApi = await import(
      "../../../../../../frontend/src/utils/cloudFrameApi"
    );
  });

  it("returns the parsed assignment rows from GET /api/frames/{id}/scenes", async () => {
    const rows = [
      { scene_id: "a", scene_version: null, name: "Clock", slug: "clock", position: 0 },
      { scene_id: "b", scene_version: 2, name: "Weather", slug: "weather", position: 1 },
    ];
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ scenes: rows, assigned_checksum: "x" }), {
        status: 200,
      }),
    );

    expect(await cloudFrameApi.listCloudFrameScenes("frame-1")).toEqual(rows);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requested = new URL(String(fetchMock.mock.calls[0]?.[0]), "http://localhost");
    expect(requested.pathname).toBe("/api/frames/frame-1/scenes");
  });

  it("tolerates a missing scenes field and surfaces API errors", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    expect(await cloudFrameApi.listCloudFrameScenes("frame-1")).toEqual([]);

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid_frame" }), { status: 404 }),
    );
    await expect(cloudFrameApi.listCloudFrameScenes("frame-1")).rejects.toThrow(
      "Failed to load the frame scene list (invalid_frame)",
    );
  });
});
