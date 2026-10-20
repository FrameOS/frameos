// The chat's install guard (install-memory-check.ts): before the MCP install
// tools put a scene on a frame that renders in a few megabytes, the scene
// renders in that frame's memory, and one that runs out is not installed.
// The cloud API is a fake fetch; the render is the check's own stub.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { esp32DeviceLimits, type DeviceLimits } from "frameos-wasm";
import type { InstallMemoryCheck } from "./install-memory-check";
import { connectChatMcpTools } from "./mcp-tools";

const frameId = "11111111-2222-3333-4444-555555555555";
const storeSceneId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const otherSceneId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const clock = [{ edges: [], id: "clock", name: "Clock", nodes: [] }];
const e1004 = { device: { label: "ESP32 with 8 MB PSRAM", psramBytes: 8 * 1024 * 1024 }, height: 1600, width: 1200 };

let seen: string[] = [];

async function fakeCloud(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  seen.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
  if (url.pathname === `/api/store/scenes/${storeSceneId}/scenes.json`) {
    return Response.json(clock);
  }
  if (url.pathname === `/api/store/scenes/${otherSceneId}/scenes.json`) {
    return Response.json([{ ...clock[0], id: "other" }]);
  }
  return Response.json({ error: "not_found" }, { status: 404 });
}

beforeEach(() => {
  seen = [];
  vi.stubGlobal("fetch", vi.fn(fakeCloud));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type Render = { height: number; limits: DeviceLimits; sceneId: string | null; scenes: unknown[]; width: number };

function installCheck(answer: string | null, target: typeof e1004 | null = e1004) {
  const renders: Render[] = [];
  const check: InstallMemoryCheck = {
    frameDevice: async () => target,
    outOfMemory: async (scenes, sceneId, width, height, limits) => {
      renders.push({ height, limits, sceneId, scenes, width });
      return answer;
    },
  };
  return { check, renders };
}

async function connect(check: InstallMemoryCheck) {
  return connectChatMcpTools({
    baseUrl: "http://127.0.0.1:3000",
    credential: { cookie: "session=abc", origin: "https://cloud.example" },
    installCheck: check,
    publicOrigin: "https://cloud.example",
    storeOrigin: "https://scenes.example",
  });
}

const outOfMemory = "Out of memory: an allocation of 7.3 MB was refused with 4.4 MB of the device's 6.1 MB in use.";

describe("installing on a frame that renders in a few megabytes", () => {
  it("renders the store scene in the frame's memory and installs nothing when it runs out", async () => {
    const { check, renders } = installCheck(outOfMemory);
    const tools = await connect(check);
    const result = await tools.call("frame_scene_install", {
      confirm: true,
      frame_id: frameId,
      scene_id: storeSceneId,
      scene_version: 3,
    });
    expect(JSON.parse(result.text)).toMatchObject({
      error: outOfMemory,
      installed: false,
      ok: false,
      rendered_in: "the frame's memory: ESP32 with 8 MB PSRAM",
    });
    expect(renders).toEqual([
      {
        height: 1600,
        limits: esp32DeviceLimits(1200, 1600, 8 * 1024 * 1024),
        sceneId: "clock",
        scenes: clock,
        width: 1200,
      },
    ]);
    // The version it would install was read, and nothing else was asked of the API.
    expect(seen).toEqual([`GET /api/store/scenes/${storeSceneId}/scenes.json?version=3`]);
    await tools.close();
  });

  it("lets a scene that fits through to the install", async () => {
    const { check, renders } = installCheck(null);
    const tools = await connect(check);
    await tools.call("frame_scene_install", { confirm: true, frame_id: frameId, scenes: clock });
    expect(renders.map((render) => render.scenes)).toEqual([clock]);
    // No store read for raw JSON; the install itself went on to the API.
    expect(seen.some((line) => line.includes("/api/store/scenes/"))).toBe(false);
    expect(seen.length).toBeGreaterThan(0);
    await tools.close();
  });

  it("checks every scene an update moves to its newest version", async () => {
    const { check, renders } = installCheck(null);
    const tools = await connect(check);
    await tools.call("frame_scene_update", { confirm: true, frame_id: frameId, scene_ids: [storeSceneId, otherSceneId] });
    expect(renders.map((render) => render.sceneId)).toEqual(["clock", "other"]);
    await tools.close();
  });

  it("leaves frames with memory to spare and scenes from a URL alone", async () => {
    const roomy = installCheck(outOfMemory, null);
    const tools = await connect(roomy.check);
    await tools.call("frame_scene_install", { confirm: true, frame_id: frameId, scene_id: storeSceneId });
    expect(roomy.renders).toEqual([]);
    await tools.close();

    const tight = installCheck(outOfMemory);
    const fromUrl = await connect(tight.check);
    await fromUrl.call("frame_scene_install", {
      confirm: true,
      frame_id: frameId,
      url: "https://scenes.example/s/clock",
    });
    expect(tight.renders).toEqual([]);
    await fromUrl.close();
  });
});
