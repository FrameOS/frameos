import type { DeviceLimits } from "frameos-wasm";
import type { createDb } from "@frameos-cloud/db";
import type { InProcessMcp } from "@frameos-cloud/mcp";
import { frameForAccount, frameRenderScale } from "../frames";
import { checkIdentityRateLimit } from "../rate-limit";
import { withRetiredAppsReplaced } from "../retired-apps";
import { accountRenderRateLimit, maxRenderPixels, renderScenes, SceneRenderError } from "../scene-render";
import { frameRenderDevice, renderDeviceLimits, type RenderDevice } from "./render-device";
import type { ToolOutput } from "./tools";

// The chat puts scenes on frames through the MCP tools, and from the frames
// home it does so with no editor and no render on the way: the E1004's clock
// (2026-10-20) went scene_create → frame_scene_install and then aborted every
// render on the device. So before frame_scene_install / frame_scene_update
// reaches a frame that renders in a few megabytes, the scene renders in that
// frame's memory, and one that runs out is not installed (docs/ai-chat.md).
// Only memory refuses: a source the tool will reject, a scene from a URL, or
// a render that fails some other way goes through to the tool as before.
// The backend's chat does the same (check_install in app/api/ai_chat.py).

export const INSTALL_TOOLS: ReadonlySet<string> = new Set(["frame_scene_install", "frame_scene_update"]);

export const installOutOfMemoryNote =
  "Nothing was installed: on this frame the scene would abort every render and restart the device. Make it " +
  "need less memory (every image the size of the frame is width x height x 4 bytes, so draw into the frame's " +
  "canvas instead of building full-size images, and keep fetched data small), then install it again.";

type JsonObject = Record<string, unknown>;

export type InstallMemoryCheck = {
  /** The device a frame renders on, its panel size and its own render scale
   * (null = automatic); null renders unlimited. */
  frameDevice(
    frameId: string,
  ): Promise<{ device: RenderDevice; height: number; renderScale?: number | null; width: number } | null>;
  /** Renders `sceneId`: the out-of-memory sentence when the ceiling refused an
   * allocation, null for anything else. */
  outOfMemory(
    scenes: JsonObject[],
    sceneId: string | null,
    width: number,
    height: number,
    limits: DeviceLimits,
    renderScale?: number | null,
  ): Promise<string | null>;
};

function sceneList(value: unknown): JsonObject[] | null {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray((parsed as JsonObject).scenes)) {
    parsed = (parsed as JsonObject).scenes;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    parsed = [parsed];
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return null;
  }
  const scenes = parsed.filter((scene): scene is JsonObject => Boolean(scene) && typeof scene === "object");
  return scenes.length === parsed.length ? scenes : null;
}

async function storeSceneContent(mcp: InProcessMcp, sceneId: string, version?: unknown): Promise<JsonObject[] | null> {
  const result = await mcp.call("scene_get_content", {
    scene: sceneId,
    ...(typeof version === "number" ? { version } : {}),
  });
  if (result.isError) {
    return null;
  }
  const body = result.content.find((item) => item.type === "text");
  return body && typeof body.text === "string" ? sceneList(body.text) : null;
}

// Every scene set the call would put on the frame.
async function scenesToInstall(mcp: InProcessMcp, name: string, args: JsonObject): Promise<JsonObject[][]> {
  if (name === "frame_scene_install") {
    if (args.scenes !== undefined && args.scenes !== null) {
      const scenes = sceneList(args.scenes);
      return scenes ? [scenes] : [];
    }
    if (typeof args.scene_id === "string") {
      const scenes = await storeSceneContent(mcp, args.scene_id, args.scene_version);
      return scenes ? [scenes] : [];
    }
    // A URL: someone's published scene, not one this chat wrote.
    return [];
  }
  const ids = Array.isArray(args.scene_ids)
    ? args.scene_ids.filter((id): id is string => typeof id === "string")
    : typeof args.scene_id === "string"
      ? [args.scene_id]
      : [];
  const sets: JsonObject[][] = [];
  for (const id of ids) {
    // frame_scene_update moves the scene to its newest version.
    const scenes = await storeSceneContent(mcp, id);
    if (scenes) {
      sets.push(scenes);
    }
  }
  return sets;
}

/** The tool result that refuses the call, or null to let it through. */
export async function installRefusal(
  mcp: InProcessMcp,
  check: InstallMemoryCheck,
  name: string,
  args: JsonObject,
): Promise<ToolOutput | null> {
  if (!INSTALL_TOOLS.has(name) || typeof args.frame_id !== "string") {
    return null;
  }
  const target = await check.frameDevice(args.frame_id);
  if (!target) {
    return null;
  }
  const limits = renderDeviceLimits(target.device, target.width, target.height);
  for (const scenes of await scenesToInstall(mcp, name, args)) {
    const main = scenes.find((scene) => scene.default === true) ?? scenes[0]!;
    const sceneId = typeof main.id === "string" ? main.id : null;
    const outOfMemory = await check.outOfMemory(
      scenes,
      sceneId,
      target.width,
      target.height,
      limits,
      target.renderScale ?? null,
    );
    if (outOfMemory) {
      return {
        images: [],
        text: JSON.stringify({
          error: outOfMemory,
          installed: false,
          note: installOutOfMemoryNote,
          ok: false,
          rendered_in: `the frame's memory: ${target.device.label}`,
        }),
      };
    }
  }
  return null;
}

/** The check for one account's chat: its own frames, its render budget
 * (scenes:render, shared with render_scene and POST /api/scenes/render). */
export function accountInstallMemoryCheck(options: {
  accountId: string;
  db: ReturnType<typeof createDb>;
  timeZone?: string | null;
}): InstallMemoryCheck {
  return {
    async frameDevice(frameId) {
      const frame = await frameForAccount(options.db, options.accountId, frameId);
      const device = frame ? frameRenderDevice(frame) : null;
      const hardware = (frame?.hardware ?? {}) as { height?: unknown; width?: unknown };
      const { height, width } = hardware;
      if (!frame || !device || typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0) {
        return null;
      }
      return { device, height, renderScale: frameRenderScale(frame), width };
    },
    async outOfMemory(scenes, sceneId, width, height, limits, renderScale) {
      if (width * height > maxRenderPixels) {
        return null;
      }
      const budget = await checkIdentityRateLimit(options.accountId, "scenes:render", accountRenderRateLimit);
      if (!budget.allowed) {
        return null;
      }
      try {
        await renderScenes({
          deviceLimits: limits,
          height,
          owner: options.accountId,
          renderScale: renderScale ?? null,
          sceneId: sceneId ?? undefined,
          // A scene from before a Nim app was retired renders with its
          // replacement, as the frame gets it.
          scenes: withRetiredAppsReplaced(scenes),
          timeZone: options.timeZone ?? "UTC",
          width,
        });
        return null;
      } catch (error) {
        return error instanceof SceneRenderError && error.code === "render_out_of_memory" ? error.message : null;
      }
    },
  };
}
