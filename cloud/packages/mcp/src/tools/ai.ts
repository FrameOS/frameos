import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CloudApiError } from "../client";
import { failure, run, text, uuid, type ToolContext } from "../result";
import { resolveStoreSceneId } from "./scene-source";

// The scene AI (the cloud's agentic chat that builds and edits scenes),
// driven as tools. A turn runs detached on the server and streams NDJSON;
// the MCP tool follows the stream for up to `wait_seconds`, then either
// reports the finished turn or hands back a turn_id to resume with
// ai_turn_wait — an MCP call cannot sit on a 15-minute turn.
//
// What a turn delivers is unsaved scene JSON. `apply` decides what to do
// with it: save it as a new version of the scene being edited, create a new
// private scene, or just return it.

const maxWaitSeconds = 55;
const defaultWaitSeconds = 45;

type StreamEvent = Record<string, unknown> & { type: string };

type TurnOutcome = {
  chat_id: string | undefined;
  delivered: { scenes: Record<string, unknown>[]; title?: string; tool: string }[];
  error: string | undefined;
  events_seen: number;
  finished: boolean;
  reply: string;
  reply_partial: string;
  tools: string[];
  turn_id: string | undefined;
};

function newOutcome(): TurnOutcome {
  return {
    chat_id: undefined,
    delivered: [],
    error: undefined,
    events_seen: 0,
    finished: false,
    reply: "",
    reply_partial: "",
    tools: [],
    turn_id: undefined,
  };
}

function absorb(outcome: TurnOutcome, event: StreamEvent) {
  if (event.type !== "ping") {
    outcome.events_seen += 1;
  }
  switch (event.type) {
    case "chat":
      outcome.chat_id = typeof event.chatId === "string" ? event.chatId : outcome.chat_id;
      outcome.turn_id = typeof event.turnId === "string" ? event.turnId : outcome.turn_id;
      break;
    case "delta":
      outcome.reply_partial += typeof event.text === "string" ? event.text : "";
      break;
    case "tool":
      if (event.status === "done" || event.status === "error") {
        outcome.tools.push(
          `${String(event.label ?? event.name)}${event.status === "error" ? " (failed)" : ""}${
            typeof event.detail === "string" && event.detail ? `: ${event.detail}` : ""
          }`,
        );
      }
      break;
    case "scenes":
      if (Array.isArray(event.scenes)) {
        outcome.delivered.push({
          scenes: event.scenes as Record<string, unknown>[],
          ...(typeof event.title === "string" ? { title: event.title } : {}),
          tool: String(event.tool ?? "build_scene"),
        });
      }
      break;
    case "done":
      outcome.finished = true;
      outcome.reply = typeof event.reply === "string" ? event.reply : outcome.reply_partial;
      break;
    case "error":
      outcome.finished = true;
      outcome.error = typeof event.detail === "string" ? event.detail : "AI turn failed";
      break;
    default:
      break;
  }
}

function isTerminal(event: Record<string, unknown>) {
  return event.type === "done" || event.type === "error";
}

async function follow(
  ctx: ToolContext,
  method: string,
  path: string,
  body: Record<string, unknown> | undefined,
  query: Record<string, string | number | undefined> | undefined,
  waitSeconds: number,
  outcome: TurnOutcome,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), waitSeconds * 1000);
  try {
    await ctx.client.ndjson(method, path, {
      ...(body ? { body } : {}),
      onEvent: (event) => absorb(outcome, event as StreamEvent),
      ...(query ? { query } : {}),
      signal: controller.signal,
      until: isTerminal,
    });
  } catch (error) {
    if (!controller.signal.aborted) {
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
}

type ApplyMode = "none" | "new_scene" | "save_version";

async function finalize(
  ctx: ToolContext,
  outcome: TurnOutcome,
  apply: ApplyMode,
  targetSceneId: string | undefined,
  message: string | undefined,
) {
  if (!outcome.finished) {
    return text({
      chat_id: outcome.chat_id,
      events_seen: outcome.events_seen,
      hint: `The turn is still running. Call ai_turn_wait with turn_id and after=${outcome.events_seen} to keep following it.`,
      reply_so_far: outcome.reply_partial.slice(-2000),
      status: "running",
      tools_so_far: outcome.tools,
      turn_id: outcome.turn_id,
    });
  }
  if (outcome.error) {
    return failure(`The AI turn failed: ${outcome.error}`, {
      chat_id: outcome.chat_id,
      reply_so_far: outcome.reply_partial.slice(-2000),
      tools: outcome.tools,
      turn_id: outcome.turn_id,
    });
  }
  const last = outcome.delivered.at(-1);
  let saved: Record<string, unknown> | undefined;
  let saveError: string | undefined;
  if (last && apply !== "none") {
    const scenes = last.scenes.map((scene) => {
      const copy = { ...scene };
      delete copy.origin;
      return copy;
    });
    try {
      if (apply === "save_version") {
        if (!targetSceneId) {
          saveError = "apply=save_version needs scene_id.";
        } else {
          saved = await ctx.client.json("POST", `/api/account/scenes/${targetSceneId}/content`, {
            body: { message: (message ?? outcome.reply).slice(0, 200), scenes },
          });
        }
      } else {
        saved = await ctx.client.json("POST", "/api/account/scenes", {
          body: {
            scenes,
            ...(last.title ? { name: last.title } : {}),
          },
        });
      }
    } catch (error) {
      saveError =
        error instanceof CloudApiError
          ? `${error.status} ${error.code} ${JSON.stringify(error.details)}`
          : String(error);
    }
  }
  return text({
    chat_id: outcome.chat_id,
    reply: outcome.reply,
    status: "done",
    tools: outcome.tools,
    turn_id: outcome.turn_id,
    ...(last
      ? {
          delivered: {
            scene_count: last.scenes.length,
            scenes: saved ? undefined : last.scenes,
            summary: last.scenes.map((scene) => ({
              id: scene.id,
              name: scene.name,
              nodes: Array.isArray(scene.nodes) ? scene.nodes.length : 0,
            })),
            title: last.title,
            tool: last.tool,
          },
        }
      : { delivered: null }),
    ...(saved ? { saved } : {}),
    ...(saveError ? { save_error: saveError } : {}),
    ...(last && !saved && apply === "none"
      ? {
          hint: "The scenes above are not saved anywhere. Save them with scene_update_content (existing scene) or scene_create (new scene), or re-run with apply=save_version / new_scene.",
        }
      : {}),
  });
}

export function registerAiTools(server: McpServer, ctx: ToolContext) {
  const api = ctx.client;

  server.registerTool(
    "ai_scene_chat",
    {
      description:
        "Ask the FrameOS scene AI to build a new scene or change an existing one, in plain language. Without scene_id it creates scenes from scratch; with scene_id (one of the account's scenes) the AI edits that scene's current JSON. It runs the cloud's own agent (app catalog, docs, examples, linting, frame context when frame_id is given). Waits up to wait_seconds (default 45, max 55) — if the turn is longer, you get a turn_id for ai_turn_wait. apply: none (default; returns the JSON), save_version (save as a new version of scene_id), new_scene (save as a new private scene). chat_id continues an earlier conversation.",
      inputSchema: {
        apply: z.enum(["none", "new_scene", "save_version"]).optional(),
        chat_id: uuid().optional(),
        frame_id: uuid().optional().describe("A frame to give the AI context (size, platform, logs)."),
        message: z.string().max(200).optional().describe("Version message when apply=save_version."),
        prompt: z.string().min(1).max(20000),
        scene_id: z.string().optional().describe("Scene to modify (uuid, slug or URL of one of the account's scenes)."),
        version: z.number().int().min(1).optional().describe("Edit this version of scene_id instead of the latest."),
        wait_seconds: z.number().int().min(5).max(maxWaitSeconds).optional(),
      },
    },
    async ({ apply, chat_id, frame_id, message, prompt, scene_id, version, wait_seconds }) =>
      run(async () => {
        const body: Record<string, unknown> = { prompt };
        let storeId: string | undefined;
        if (chat_id) {
          body.chatId = chat_id;
        }
        if (frame_id) {
          body.frameId = frame_id;
        }
        if (scene_id) {
          storeId = await resolveStoreSceneId(ctx, scene_id);
          if (!storeId) {
            return failure(`No store scene matches "${scene_id}".`);
          }
          const scenes = await api.json<Record<string, unknown>[]>(
            "GET",
            `/api/store/scenes/${storeId}/scenes.json`,
            { query: { version } },
          );
          const primary = scenes[0];
          if (!primary) {
            return failure("The scene has no content.");
          }
          body.scene = primary;
          body.sceneId = primary.id;
          body.scenes = scenes;
          body.storeSceneId = storeId;
          body.surface = "store";
        } else {
          body.surface = "store-new";
        }
        const outcome = newOutcome();
        await follow(
          ctx,
          "POST",
          "/api/ai/chat",
          body,
          undefined,
          wait_seconds ?? defaultWaitSeconds,
          outcome,
        );
        return finalize(ctx, outcome, apply ?? "none", storeId, message);
      }),
  );

  server.registerTool(
    "ai_turn_wait",
    {
      description:
        "Keep following a running AI turn (from ai_scene_chat) for up to wait_seconds more; pass `after` = events_seen from the previous call to skip what you already saw. Same apply/scene_id semantics as ai_scene_chat once the turn finishes.",
      inputSchema: {
        after: z.number().int().min(0).optional(),
        apply: z.enum(["none", "new_scene", "save_version"]).optional(),
        message: z.string().max(200).optional(),
        scene_id: uuid().optional(),
        turn_id: z.string(),
        wait_seconds: z.number().int().min(5).max(maxWaitSeconds).optional(),
      },
    },
    async ({ after, apply, message, scene_id, turn_id, wait_seconds }) =>
      run(async () => {
        const outcome = newOutcome();
        outcome.turn_id = turn_id;
        outcome.events_seen = after ?? 0;
        await follow(
          ctx,
          "GET",
          `/api/ai/chat/turns/${turn_id}`,
          undefined,
          { after },
          wait_seconds ?? defaultWaitSeconds,
          outcome,
        );
        return finalize(ctx, outcome, apply ?? "none", scene_id, message);
      }),
  );

  server.registerTool(
    "ai_turn_cancel",
    {
      description: "Stop a running AI turn.",
      inputSchema: { turn_id: z.string() },
    },
    async ({ turn_id }) =>
      run(async () => text(await api.json("DELETE", `/api/ai/chat/turns/${turn_id}`))),
  );

  server.registerTool(
    "ai_chats_list",
    {
      annotations: { readOnlyHint: true },
      description: "List the account's AI chats (title, context, message count), newest first; frame_id narrows to one frame's chats.",
      inputSchema: {
        frame_id: uuid().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async ({ frame_id, limit, offset }) =>
      run(async () =>
        text(
          await api.json("GET", "/api/ai/chats", {
            query: { frameId: frame_id, limit, offset },
          }),
        ),
      ),
  );

  server.registerTool(
    "ai_chat_get",
    {
      annotations: { readOnlyHint: true },
      description:
        "One AI chat with its messages. Assistant messages that delivered scenes carry them in payload.delivered — the way to recover a result whose stream was lost.",
      inputSchema: { chat_id: uuid() },
    },
    async ({ chat_id }) =>
      run(async () => text(await api.json("GET", `/api/ai/chats/${chat_id}`))),
  );

  server.registerTool(
    "ai_chat_delete",
    {
      annotations: { destructiveHint: true },
      description: "Delete an AI chat and its messages.",
      inputSchema: { chat_id: uuid() },
    },
    async ({ chat_id }) =>
      run(async () => text(await api.json("DELETE", `/api/ai/chats/${chat_id}`))),
  );
}
