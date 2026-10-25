// The scene AI as a sub-turn of the voice chat (docs/voice-chat.md "Scenes
// written by voice"): `create_scene` and `change_scene` hand a spoken request
// to the chat's scene-building loop and get one scene back, checked.
//
// The sub-turn is the AI chat's own agent loop (loop.ts) with the chat's
// system prompt (the scene guide included) and the EDITOR and CATALOG tools
// alone — create_scenes, update_scene, patch_scene, edit_app_source,
// render_scene, search_apps, get_app, search_examples, get_example,
// search_docs, read_doc (ToolContext.allowedTools). Never the store's,
// the frames' or the MCP server's tools: the caller is a frame's own
// credential, not the owner's. What the model "delivers to the editor" is
// captured here instead, then rendered once more in the frame's memory at
// the frame's size: a scene with runtime errors or one that runs the frame
// out of memory goes back to the model as the browser's `[Automatic render
// check]` would (docs/ai-chat.md), twice at most, and only a scene that
// draws is handed back for the preview push. Without a renderer on this
// server the check is skipped, as the chat's install check is.
//
// The backend's twin is backend/app/utils/voice_scene_builder.py.
import { buildInitialInput, runAgentLoop } from "./loop";
import type { ResponseInputItem } from "./openai";
import { buildSystemPrompt } from "./prompts";
import type { RenderDevice } from "./render-device";
import { renderDeviceLimits } from "./render-device";
import type { JsonObject } from "./scene-utils";
import type { ToolContext } from "./tools";
import {
  isRenderErrorLine,
  rendererAvailable,
  renderScenes,
  SceneRenderError,
  type SceneRenderResult,
} from "../scene-render";
import type { VoiceSceneBuild } from "./voice";

// The frame waits three minutes for the answer (VOICE_DONE_TIMEOUT_MS); the
// transcription and the voice turn's own rounds take some of it.
export const SCENE_BUILDER_TIMEOUT_MS = 100_000;
export const MAX_BUILDER_ROUNDS = 10;
// The browser's render check runs twice per message at most; so does this one.
export const MAX_RENDER_CHECKS = 2;
const defaultRenderSize = { height: 480, width: 800 };

export const SCENE_BUILDER_TOOLS: ReadonlySet<string> = new Set([
  "search_apps",
  "get_app",
  "search_examples",
  "get_example",
  "search_docs",
  "read_doc",
  "create_scenes",
  "update_scene",
  "patch_scene",
  "edit_app_source",
  "render_scene",
]);

const renderOutOfMemoryNote =
  "The scene needs more memory than the frame has, so on the frame this render aborts and the device restarts. " +
  "Make it need less: every image the size of the frame is width x height x 4 bytes, so draw into the frame's " +
  "canvas instead of building full-size images, and keep fetched data small.";

export type RenderCheck = { ok: boolean; errors: string[]; outOfMemory?: boolean; skipped?: boolean };

/** The follow-up the model gets when its scene did not draw: the same
 * opening as the browser's automatic render check (chatLogic), so the
 * prompt's rules for it apply. */
export function renderCheckMessage(check: RenderCheck): string {
  if (check.outOfMemory) {
    return (
      `[Automatic render check] The scene was rendered in the frame's memory and ran out: ${check.errors.join("; ")}\n` +
      `${renderOutOfMemoryNote} Deliver the corrected scene again.`
    );
  }
  return (
    "[Automatic render check] The scene was rendered on the frame's runtime and reported these errors:\n" +
    check.errors.map((line) => `- ${line}`).join("\n") +
    "\nFix them and deliver the complete corrected scene again (update_scene or patch_scene)."
  );
}

/** The sub-turn's context: the frame, what was asked by voice, and the
 * rules of this turn (what the tools are, where the scene goes). */
export function builderContext(
  frameBlock: string,
  request: string,
  base: JsonObject | null,
  name: string | null,
): string {
  const lines = [frameBlock, ""];
  if (base) {
    lines.push(
      "The user asked, by voice, for a change to the scene the frame shows. The scene is below; change it as " +
        "asked with patch_scene / edit_app_source (small changes) or update_scene (most of it changes), keeping " +
        "everything not mentioned. The changed scene goes on the frame as a preview; the user's installed scene " +
        "is not touched.",
    );
    lines.push(`The spoken request: ${request}`);
    lines.push("The scene the frame shows:");
    lines.push(JSON.stringify(base));
  } else {
    lines.push(
      "The user asked, by voice, for a new scene for this frame. Build it with create_scenes: one scene, fit " +
        "for the frame's size and colors, that renders without the account's service keys unless the request " +
        "needs an app that takes one.",
    );
    lines.push(`The spoken request: ${request}`);
    if (name) {
      lines.push(`Name the scene: ${name}`);
    }
  }
  lines.push(
    "This turn has the editor tools (create_scenes, update_scene, patch_scene, edit_app_source, render_scene) and " +
      "the catalog tools (search_apps, get_app, search_examples, get_example, search_docs, read_doc) and no others: " +
      "nothing here saves, installs or touches a frame; the scene you deliver is shown on the frame as a preview by " +
      "the caller. Deliver, render it once with render_scene to check it, fix what is wrong, and end with one " +
      "sentence saying what the scene shows. Nobody reads a question back: decide and build.",
  );
  return lines.join("\n");
}

export type SceneRenderer = (
  scenes: JsonObject[],
  sceneId: string,
  size: { width: number; height: number },
) => Promise<RenderCheck>;

/** The server's renderer as a check: the scene at the frame's size, in the
 * frame's memory when it has little (an ESP32). null when this server
 * cannot render, and the check is skipped. */
export function serverRenderer(owner: string, device: RenderDevice | null, timeZone: string): SceneRenderer | null {
  if (!rendererAvailable()) {
    return null;
  }
  return async (scenes, sceneId, size) => {
    let result: SceneRenderResult;
    try {
      result = await renderScenes({
        deviceLimits: device ? renderDeviceLimits(device, size.width, size.height) : null,
        height: size.height,
        owner,
        sceneId,
        scenes,
        timeZone,
        width: size.width,
      });
    } catch (error) {
      if (error instanceof SceneRenderError) {
        if (error.code === "render_concurrency_limit" || error.code === "renderer_busy") {
          // Not the scene's fault: let it through rather than fail the turn.
          return { errors: [], ok: true, skipped: true };
        }
        return { errors: [error.message], ok: false, outOfMemory: error.code === "render_out_of_memory" };
      }
      throw error;
    }
    const errors = [...new Set([...result.errors, ...result.logs.filter(isRenderErrorLine)])].slice(0, 20);
    return { errors, ok: errors.length === 0 };
  };
}

export async function buildSceneByVoice({
  db,
  accountId,
  frameId,
  frameBlock,
  request,
  base,
  name,
  apiKey,
  model,
  reasoningEffort,
  renderDevice,
  renderSize,
  timeZone = "UTC",
  render,
  timeoutMs = SCENE_BUILDER_TIMEOUT_MS,
  onUsage,
}: {
  db: ToolContext["db"];
  accountId: string;
  frameId: string;
  frameBlock: string;
  request: string;
  base: JsonObject | null;
  name: string | null;
  apiKey: string;
  model: string;
  reasoningEffort: string;
  renderDevice: RenderDevice | null;
  renderSize: { width: number; height: number } | null;
  timeZone?: string;
  /** The render check; undefined = this server's (serverRenderer), null = none. */
  render?: SceneRenderer | null;
  timeoutMs?: number;
  onUsage?: ((result: Awaited<ReturnType<typeof runAgentLoop>>) => void) | undefined;
}): Promise<VoiceSceneBuild & { rounds?: number; renderChecked?: boolean }> {
  const size = renderSize ?? defaultRenderSize;
  const renderer = render === undefined ? serverRenderer(accountId, renderDevice, timeZone) : render;
  const delivered: JsonObject[] = [];
  // `base` keeps its id: the preview is replaced in place; an installed
  // scene arrives here as a copy under a new id (voiceTools' change_scene),
  // since a preview whose id an assigned scene holds would read as
  // "installed" (docs/scene-previews.md) and the voice chat never
  // overwrites one.
  const working: JsonObject | null = base ? { ...base } : null;
  const toolContext: ToolContext = {
    accountId,
    allowedTools: SCENE_BUILDER_TOOLS,
    currentScene: working,
    currentSceneId: working ? (working.id as string) : null,
    db,
    editorAvailable: true,
    emitScenes: (event) => {
      const first = event.scenes[0];
      if (first && typeof first === "object" && !Array.isArray(first)) {
        delivered.splice(0, delivered.length, first as JsonObject);
      }
    },
    frameId,
    prompt: request,
    renderDevice,
    renderSize: size,
    renderTimeZone: timeZone,
  };
  const input: ResponseInputItem[] = buildInitialInput({
    contextBlock: builderContext(frameBlock, request, working, name),
    history: [],
    prompt: request,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const runOnce = async () => {
    const result = await runAgentLoop({
      apiKey,
      emit: () => undefined,
      input,
      instructions: buildSystemPrompt(),
      maxRounds: MAX_BUILDER_ROUNDS,
      model,
      reasoningEffort,
      signal: controller.signal,
      toolContext,
    });
    onUsage?.(result);
    return result;
  };
  try {
    let result = await runOnce();
    let checks = 0;
    for (;;) {
      const scene = delivered[0];
      if (!scene) {
        return { detail: (result.reply.trim() || "the scene AI delivered no scene").slice(0, 500), error: "no_scene", ok: false };
      }
      const check = renderer ? await renderer([scene], scene.id as string, size) : { errors: [], ok: true, skipped: true };
      if (check.ok || checks >= MAX_RENDER_CHECKS) {
        if (!check.ok) {
          return {
            detail: check.errors.join("; ").slice(0, 500),
            error: check.outOfMemory ? "render_out_of_memory" : "render_failed",
            ok: false,
            rounds: result.rounds,
          };
        }
        return {
          ok: true,
          renderChecked: !check.skipped,
          rounds: result.rounds,
          scene,
          summary: result.reply.trim().slice(0, 500),
        };
      }
      checks += 1;
      // The scene it delivered is now the one to fix: update_scene and
      // patch_scene edit it (the editor would hold it by now).
      toolContext.currentScene = scene;
      toolContext.currentSceneId = typeof scene.id === "string" ? scene.id : null;
      // The browser's automatic render check, server-side: the model's
      // reply stays in the input, the errors follow as a user message.
      if (result.reply.trim()) {
        input.push({ content: [{ text: result.reply.trim(), type: "output_text" }], role: "assistant" });
      }
      input.push({ content: [{ text: renderCheckMessage(check), type: "input_text" }], role: "user" });
      result = await runOnce();
    }
  } catch (error) {
    if (controller.signal.aborted) {
      return { detail: `the scene AI did not finish within ${Math.round(timeoutMs / 1000)} seconds`, error: "timeout", ok: false };
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
