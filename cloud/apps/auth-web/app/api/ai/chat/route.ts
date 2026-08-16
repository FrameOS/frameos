import { asc, eq } from "drizzle-orm";
import {
  accountSettings,
  createDb,
  frameSceneAssignments,
  storeScenes,
} from "@frameos-cloud/db";
import { NextRequest } from "next/server";
import {
  appendChatMessage,
  ensureChat,
  historyForModel,
} from "../../../../src/lib/ai/chat-store";
import { buildInitialInput, runAgentLoop, type ChatStreamEvent } from "../../../../src/lib/ai/loop";
import {
  resolveChatModel,
  resolveReasoningEffort,
} from "../../../../src/lib/ai/openai";
import { formatAiException, type JsonObject } from "../../../../src/lib/ai/scene-utils";
import type { ToolContext } from "../../../../src/lib/ai/tools";
import { csrfResponse } from "../../../../src/lib/csrf";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../src/lib/device-flow";
import { frameForAccount } from "../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { readSession } from "../../../../src/lib/session";

export const runtime = "nodejs";
// One streaming agent loop; generous ceiling for multi-tool scene builds.
export const maxDuration = 600;

// AI chat v2: a single streaming agentic loop over the OpenAI Responses API,
// replacing the old /api/ai/scenes/chat pipeline (router → plan → generate →
// review → repair as sequential blocking calls). The response is NDJSON —
// one JSON event per line (see ChatStreamEvent) — consumed by the shared
// SPA's chatLogic in cloud mode. Chats persist in ai_chats/ai_chat_messages.

function objectOrNull(value: unknown): JsonObject | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

async function frameContextBlock(
  db: ReturnType<typeof createDb>,
  accountId: string,
  frameId: string | null,
): Promise<{ block: string; frameId: string | null }> {
  if (!frameId) {
    return { block: "", frameId: null };
  }
  const frame = await frameForAccount(db, accountId, frameId);
  if (!frame) {
    return { block: "", frameId: null };
  }
  const hardware = objectOrNull(frame.hardware) ?? {};
  const lines: string[] = ["The user is working with this frame:"];
  lines.push(`- Frame id: ${frame.id}`);
  if (frame.name) {
    lines.push(`- Name: ${frame.name}`);
  }
  const width = hardware.width;
  const height = hardware.height;
  if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
    lines.push(`- Resolution: ${width}x${height}`);
  }
  if (typeof hardware.device === "string" && hardware.device) {
    lines.push(`- Device: ${hardware.device}`);
  }
  if (typeof hardware.color === "string" && hardware.color) {
    lines.push(`- Color mode: ${hardware.color}`);
  }
  lines.push(`- Connected: ${frame.connected ? "yes" : "no"} (status: ${frame.status})`);
  const assignments = await db
    .select({ name: storeScenes.name, sceneId: frameSceneAssignments.sceneId })
    .from(frameSceneAssignments)
    .innerJoin(storeScenes, eq(storeScenes.id, frameSceneAssignments.sceneId))
    .where(eq(frameSceneAssignments.frameId, frame.id))
    .orderBy(asc(frameSceneAssignments.position));
  if (assignments.length > 0) {
    lines.push(
      "- Assigned scenes: " +
        assignments.map((row) => `${row.name} (${row.sceneId})`).join(", "),
    );
  } else {
    lines.push("- No scenes assigned yet.");
  }
  return { block: lines.join("\n"), frameId: frame.id };
}

export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "ai:chat", {
    limit: 60,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const session = await readSession();
  if (!session?.accountId) {
    return jsonError("login_required", 401);
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const accountId = session.accountId;

  const body = await readJsonObject(request);
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return jsonError("invalid_prompt", 400, { detail: "Prompt is required" });
  }

  const settingsRows = await db
    .select()
    .from(accountSettings)
    .where(eq(accountSettings.accountId, accountId));
  const openaiSettings =
    objectOrNull(settingsRows.find((row) => row.key === "openAI")?.value) ?? {};
  const apiKey = openaiSettings.backendApiKey;
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return jsonError("missing_api_key", 400, {
      detail: "OpenAI backend API key not set",
    });
  }
  const model = resolveChatModel(openaiSettings);
  const reasoningEffort = resolveReasoningEffort(openaiSettings);

  const requestedChatId = stringOrNull(body.chatId) ?? crypto.randomUUID();
  const scenePayload = objectOrNull(body.scene);
  const sceneId = stringOrNull(body.sceneId);
  const { block: frameBlock, frameId } = await frameContextBlock(
    db,
    accountId,
    stringOrNull(body.frameId),
  );

  const chat = await ensureChat(db, accountId, {
    chatId: requestedChatId,
    contextId: sceneId,
    contextType: sceneId ? "scene" : "frame",
    frameId,
  });
  if (!chat) {
    return jsonError("invalid_chat", 403, {
      detail: "This chat id belongs to another account.",
    });
  }

  // History from the store; fall back to client-supplied history for chats
  // that predate persistence.
  let history = await historyForModel(db, chat.id);
  if (history.length === 0 && Array.isArray(body.history)) {
    history = (body.history as unknown[])
      .map((item) => objectOrNull(item))
      .filter((item): item is JsonObject => item !== null)
      .filter(
        (item) =>
          (item.role === "user" || item.role === "assistant") &&
          typeof item.content === "string" &&
          item.content.trim(),
      )
      .map((item) => ({
        content: (item.content as string).trim(),
        role: item.role as "user" | "assistant",
      }))
      .slice(-12);
  }

  const contextParts: string[] = [];
  if (frameBlock) {
    contextParts.push(frameBlock);
  }
  if (scenePayload) {
    contextParts.push(
      `The user has this scene open in the editor (its id is "${sceneId ?? scenePayload.id}"). ` +
        "update_scene will modify it:\n" +
        JSON.stringify(scenePayload),
    );
  }
  const selectedNodes = Array.isArray(body.selectedNodes) ? body.selectedNodes : [];
  const selectedEdges = Array.isArray(body.selectedEdges) ? body.selectedEdges : [];
  if (selectedNodes.length > 0 || selectedEdges.length > 0) {
    contextParts.push(
      "The user has selected these elements in the editor:\n" +
        JSON.stringify({ edges: selectedEdges, nodes: selectedNodes }),
    );
  }

  await appendChatMessage(db, chat.id, { content: prompt, role: "user" });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const emit = (event: ChatStreamEvent) => {
        if (closed) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          closed = true;
        }
      };
      emit({ chatId: chat.id, type: "chat" });

      const scenesDelivered: { tool: string; title?: string; count: number }[] = [];
      const toolContext: ToolContext = {
        accountId,
        currentScene: scenePayload,
        currentSceneId: sceneId ?? (stringOrNull(scenePayload?.id) || null),
        db,
        emitScenes: (event) => {
          scenesDelivered.push({
            count: event.scenes.length,
            ...(event.title ? { title: event.title } : {}),
            tool: event.tool,
          });
          emit(event);
        },
        frameId,
        prompt,
        // Audit actor for save_scene's store write.
        providerSubject: session.providerSubject,
      };

      try {
        const { reply, tool } = await runAgentLoop({
          apiKey: apiKey.trim(),
          emit,
          input: buildInitialInput({
            contextBlock: contextParts.join("\n\n"),
            history,
            prompt,
          }),
          model,
          reasoningEffort,
          signal: request.signal,
          toolContext,
        });
        const content =
          reply.trim() ||
          (tool === "build_scene"
            ? "Generated a new scene."
            : tool === "modify_scene"
              ? "Updated the current scene."
              : "Done.");
        await appendChatMessage(db, chat.id, {
          content,
          payload: scenesDelivered.length > 0 ? { scenes: scenesDelivered } : null,
          role: "assistant",
          tool,
        });
        emit({ reply: content, tool, type: "done" });
      } catch (error) {
        const detail = `AI chat failed: ${formatAiException(error)}`;
        emit({ detail, type: "error" });
        try {
          await appendChatMessage(db, chat.id, {
            content: detail,
            role: "assistant",
            tool: "error",
          });
        } catch {
          // persisting the failure is best-effort
        }
      }
      if (!closed) {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-store",
      // NDJSON, one ChatStreamEvent per line.
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}
