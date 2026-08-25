import { and, asc, eq, or } from "drizzle-orm";
import {
  accounts,
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
import { resolveAiCredentials } from "../../../../src/lib/ai/api-key";
import { buildInitialInput, runAgentLoop, type ChatStreamEvent } from "../../../../src/lib/ai/loop";
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

// The store scene the chat was opened on (scenes.frameos.net). Same access
// rule as the get_store_scene tool: public+active, or the user's own. The
// editor sends the scene JSON itself (it may already hold unsaved edits), so
// this block carries the listing metadata and what saving means here.
async function storeSceneContextBlock(
  db: ReturnType<typeof createDb>,
  accountId: string,
  storeSceneId: string | null,
): Promise<{ block: string; storeSceneId: string | null }> {
  if (!storeSceneId || !/^[0-9a-f-]{36}$/i.test(storeSceneId)) {
    return { block: "", storeSceneId: null };
  }
  const [scene] = await db
    .select({
      accountId: storeScenes.accountId,
      category: storeScenes.category,
      description: storeScenes.description,
      id: storeScenes.id,
      latestVersion: storeScenes.latestVersion,
      name: storeScenes.name,
      publisher: accounts.displayName,
      slug: storeScenes.slug,
      tags: storeScenes.tags,
      visibility: storeScenes.visibility,
    })
    .from(storeScenes)
    .innerJoin(accounts, eq(accounts.id, storeScenes.accountId))
    .where(
      and(
        eq(storeScenes.id, storeSceneId),
        or(
          eq(storeScenes.accountId, accountId),
          and(eq(storeScenes.visibility, "public"), eq(storeScenes.status, "active")),
        ),
      ),
    )
    .limit(1);
  if (!scene) {
    return { block: "", storeSceneId: null };
  }
  const owned = scene.accountId === accountId;
  const lines = [
    "The user is on the scene store, looking at this store scene in its editor:",
    `- Store scene id: ${scene.id} (slug "${scene.slug}", version ${scene.latestVersion})`,
    `- Name: ${scene.name}`,
    ...(scene.description ? [`- Description: ${scene.description}`] : []),
    ...(scene.category ? [`- Category: ${scene.category}`] : []),
    ...(scene.tags.length > 0 ? [`- Tags: ${scene.tags.join(", ")}`] : []),
    `- Publisher: ${scene.publisher ?? "FrameOS user"}${owned ? " (this is the user's own scene)" : ""}`,
    `- Visibility: ${scene.visibility}`,
    owned
      ? "- Saving: the editor's \"Save as new version\" button publishes the edited scene as a new version of this listing; \"Fork & save copy\" makes a separate private copy. save_scene always makes a private copy (a fork of this store scene by default)."
      : "- Saving: the user does not own this scene, so edits are saved as a FORK — the editor's \"Fork & save copy\" button or save_scene (which forks this store scene by default) creates a private copy in their account. Never suggest they can overwrite the original.",
  ];
  return { block: lines.join("\n"), storeSceneId: scene.id };
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

  const credentials = await resolveAiCredentials(db, accountId);
  if (!credentials) {
    return jsonError("missing_api_key", 400, {
      detail: "OpenAI backend API key not set",
    });
  }
  const { apiKey, model, reasoningEffort } = credentials;

  const requestedChatId = stringOrNull(body.chatId) ?? crypto.randomUUID();
  const scenePayload = objectOrNull(body.scene);
  const sceneId = stringOrNull(body.sceneId);
  const { block: frameBlock, frameId } = await frameContextBlock(
    db,
    accountId,
    stringOrNull(body.frameId),
  );
  const { block: storeBlock, storeSceneId } = await storeSceneContextBlock(
    db,
    accountId,
    stringOrNull(body.storeSceneId),
  );
  const editorScenes = Array.isArray(body.scenes)
    ? (body.scenes as unknown[]).filter((scene) => objectOrNull(scene) !== null).slice(0, 20)
    : null;

  const chat = await ensureChat(db, accountId, {
    chatId: requestedChatId,
    contextId: storeSceneId ?? sceneId,
    contextType: storeSceneId || sceneId ? "scene" : "frame",
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
  if (storeBlock) {
    contextParts.push(storeBlock);
  } else if (body.surface === "store-new") {
    contextParts.push(
      "The user is on the scene store's new-scene editor (scenes.frameos.net), building a scene from scratch. " +
        "Nothing is saved yet: the editor's \"Save to my scenes\" button creates a private scene in their account " +
        "(save_scene does the same). There is no frame, no Deploy button and no store listing yet — do not mention " +
        "Save/Deploy or versions.",
    );
  } else if (body.surface === "store") {
    contextParts.push(
      "The user is on the scene store (scenes.frameos.net) editor. Edits are saved with the editor's own buttons " +
        "(\"Save as new version\" for their own scene, \"Fork & save copy\" otherwise) or with save_scene; there is no Deploy button here.",
    );
  }
  if (scenePayload) {
    contextParts.push(
      `The user has this scene open in the editor (its id is "${sceneId ?? scenePayload.id}"). ` +
        "update_scene will modify it:\n" +
        JSON.stringify(scenePayload),
    );
  }
  if (editorScenes && editorScenes.length > 1) {
    const others = editorScenes
      .map((scene) => scene as JsonObject)
      .filter((scene) => scene.id !== (sceneId ?? scenePayload?.id))
      .map((scene) => `${String(scene.name ?? "")} (${String(scene.id ?? "")})`);
    if (others.length > 0) {
      contextParts.push(
        "Other scenes open in the same editor (scene nodes may embed them by id): " + others.join(", "),
      );
    }
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
        editorScenes,
        frameId,
        prompt,
        // Audit actor for save_scene's store write.
        providerSubject: session.providerSubject,
        storeSceneId,
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
