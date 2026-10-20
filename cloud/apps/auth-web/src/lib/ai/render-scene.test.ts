// render_scene: the chat model's view of a scene. The renderer itself is
// scene-render.ts's (tested there); these pin which scenes it is handed, at
// what size, with which settings, and what the model gets back.

import { beforeEach, describe, expect, it, vi } from "vitest";

const renderScenes = vi.hoisted(() => vi.fn());
const checkIdentityRateLimit = vi.hoisted(() => vi.fn());

vi.mock("../scene-render", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../scene-render")>()),
  renderScenes,
}));
vi.mock("../rate-limit", () => ({ checkIdentityRateLimit }));

const { SceneRenderError } = await import("../scene-render");
const { esp32DeviceLimits } = await import("frameos-wasm");
const { MAX_RENDERS_PER_TURN, runTool, scenesToRender } = await import("./tools");
type ToolContext = import("./tools").ToolContext;

function scene(id: string, extra: Record<string, unknown> = {}) {
  return { edges: [], fields: [], id, name: id, nodes: [], ...extra };
}

function context(extra: Partial<ToolContext> = {}): ToolContext {
  return {
    accountId: "account-1",
    currentScene: scene("main", { name: "Edited in the editor" }),
    currentSceneId: "main",
    db: {} as ToolContext["db"],
    editorScenes: [scene("main"), scene("clock")],
    emitScenes: () => {},
    prompt: "it looks bad",
    ...extra,
  };
}

const png = Buffer.from("png-bytes");

function rendered(extra: Record<string, unknown> = {}) {
  return { errors: [], height: 480, logs: [], png, renderMs: 120, state: {}, width: 800, ...extra };
}

describe("scenesToRender", () => {
  it("renders the editor's scene as the client sent it, with the other open scenes", () => {
    const { sceneId, scenes } = scenesToRender(context());
    expect(sceneId).toBe("main");
    expect(scenes.map((entry) => [entry.id, entry.name])).toEqual([
      ["main", "Edited in the editor"],
      ["clock", "clock"],
    ]);
  });

  it("renders what this turn delivered in place of the editor's copy", () => {
    const delivered = scene("main", { name: "Delivered" });
    const { sceneId, scenes } = scenesToRender(context({ deliveredScenes: [delivered], deliveredTool: "modify_scene" }));
    expect(sceneId).toBe("main");
    expect(scenes.map((entry) => [entry.id, entry.name])).toEqual([
      ["main", "Delivered"],
      ["clock", "clock"],
    ]);
  });

  it("targets a newly built scene", () => {
    const { sceneId } = scenesToRender(
      context({ deliveredScenes: [scene("fresh")], deliveredTool: "build_scene" }),
    );
    expect(sceneId).toBe("fresh");
  });
});

describe("render_scene", () => {
  beforeEach(() => {
    renderScenes.mockReset();
    checkIdentityRateLimit.mockReset();
    checkIdentityRateLimit.mockResolvedValue({ allowed: true, remaining: 59, resetAt: 0 });
  });

  it("spends the account's scenes:render budget and stops when it is gone", async () => {
    renderScenes.mockResolvedValue(rendered());
    await runTool("render_scene", {}, context());
    expect(checkIdentityRateLimit).toHaveBeenCalledWith("account-1", "scenes:render", {
      limit: 60,
      windowMs: 15 * 60 * 1000,
    });
    checkIdentityRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: 0 });
    const refused = await runTool("render_scene", {}, context());
    expect(refused.images).toEqual([]);
    expect(JSON.parse(refused.text)).toMatchObject({ error: "rate_limited", ok: false });
    expect(renderScenes).toHaveBeenCalledTimes(1);
  });

  it("hands the model the frame as an image, rendered at the preview's size without keys", async () => {
    renderScenes.mockResolvedValueOnce(rendered());
    const ctx = context({ renderSize: { height: 1200, width: 1600 }, renderTimeZone: "Europe/Tallinn" });

    const result = await runTool("render_scene", {}, ctx);

    expect(result.images).toEqual([{ dataUrl: `data:image/png;base64,${png.toString("base64")}` }]);
    expect(JSON.parse(result.text)).toMatchObject({ ok: true, scene_id: "main" });
    const [options] = renderScenes.mock.calls[0]!;
    expect(options).toMatchObject({
      height: 1200,
      owner: "account-1",
      sceneId: "main",
      timeZone: "Europe/Tallinn",
      width: 1600,
    });
    expect(options.settings).toBeUndefined();
    expect(options.scenes.map((entry: { id: string }) => entry.id)).toEqual(["main", "clock"]);
    expect(ctx.rendersThisTurn).toBe(1);
  });

  it("defaults to 800x480 in UTC and takes a size the model asks for", async () => {
    renderScenes.mockResolvedValue(rendered());
    await runTool("render_scene", {}, context());
    expect(renderScenes.mock.calls[0]![0]).toMatchObject({ height: 480, timeZone: "UTC", width: 800 });
    await runTool("render_scene", { height: 800, width: 480 }, context());
    expect(renderScenes.mock.calls[1]![0]).toMatchObject({ height: 800, width: 480 });
  });

  it("frames what the scene printed as untrusted output", async () => {
    renderScenes.mockResolvedValueOnce(
      rendered({ errors: ["Error rendering SVG", "Error rendering SVG"], logs: ['{"event":"render:done"}'] }),
    );
    const { text } = await runTool("render_scene", {}, context());
    expect(text).toContain('<untrusted_data source="scene_render_output">');
    expect(text.split("Error rendering SVG").length - 1).toBe(1);
  });

  it("stops after MAX_RENDERS_PER_TURN renders in one turn", async () => {
    renderScenes.mockResolvedValue(rendered());
    const ctx = context();
    for (let index = 0; index < MAX_RENDERS_PER_TURN; index += 1) {
      expect((await runTool("render_scene", {}, ctx)).images).toHaveLength(1);
    }
    const refused = await runTool("render_scene", {}, ctx);
    expect(refused.images).toEqual([]);
    expect(JSON.parse(refused.text).ok).toBe(false);
    expect(renderScenes).toHaveBeenCalledTimes(MAX_RENDERS_PER_TURN);
  });

  it("renders an ESP32 frame's scene in that frame's memory", async () => {
    renderScenes.mockResolvedValue(rendered({ height: 1600, width: 1200 }));
    const device = { label: "ESP32 with 8 MB PSRAM", psramBytes: 8 * 1024 * 1024 };
    const result = await runTool(
      "render_scene",
      {},
      context({ renderDevice: device, renderSize: { height: 1600, width: 1200 } }),
    );
    expect(renderScenes.mock.calls[0]![0].deviceLimits).toEqual(esp32DeviceLimits(1200, 1600, 8 * 1024 * 1024));
    expect(JSON.parse(result.text.split("\n")[0]!)).toMatchObject({
      ok: true,
      rendered_in: "the frame's memory: ESP32 with 8 MB PSRAM",
    });
    // Everywhere else the renderer keeps its own memory.
    await runTool("render_scene", {}, context());
    expect(renderScenes.mock.calls[1]![0].deviceLimits).toBeNull();
  });

  it("tells the model what running the frame out of memory means", async () => {
    renderScenes.mockRejectedValueOnce(
      new SceneRenderError(
        "render_out_of_memory",
        "Out of memory: an allocation of 7.3 MB was refused with 4.4 MB of the device's 6.1 MB in use.",
      ),
    );
    const device = { label: "ESP32 with 8 MB PSRAM", psramBytes: 8 * 1024 * 1024 };
    const result = await runTool("render_scene", {}, context({ renderDevice: device }));
    const parsed = JSON.parse(result.text);
    expect(parsed).toMatchObject({ error: "render_out_of_memory", ok: false });
    expect(parsed.detail).toMatch(/^Out of memory/);
    expect(parsed.note).toMatch(/aborts and the device restarts/);
  });

  it("explains a renderer refusal instead of throwing", async () => {
    renderScenes.mockRejectedValueOnce(
      new SceneRenderError("renderer_unavailable", "The wasm runtime is not installed on this server."),
    );
    const result = await runTool("render_scene", {}, context());
    expect(result.images).toEqual([]);
    const parsed = JSON.parse(result.text);
    expect(parsed).toMatchObject({ error: "renderer_unavailable", ok: false });
    expect(parsed.note).toMatch(/cannot see/);
  });

  it("refuses without rendering when there is nothing to render or the id is unknown", async () => {
    const empty = await runTool("render_scene", {}, context({ currentScene: null, currentSceneId: null, editorScenes: [] }));
    expect(JSON.parse(empty.text).ok).toBe(false);
    const unknown = await runTool("render_scene", { scene_id: "nope" }, context());
    expect(JSON.parse(unknown.text)).toMatchObject({ ok: false, scene_ids: ["main", "clock"] });
    expect(renderScenes).not.toHaveBeenCalled();
  });

  it("passes every other tool through as text", async () => {
    const result = await runTool("no_such_tool", {}, context());
    expect(result).toEqual({ images: [], text: JSON.stringify({ error: "Unknown tool: no_such_tool" }) });
  });
});
