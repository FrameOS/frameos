import { eq } from "drizzle-orm";
import { accountSettings } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import {
  readAppSources,
  runAppChat,
} from "../../../../../src/lib/ai/app-chat";
import {
  appendChatMessage,
  ensureChat,
  historyForModel,
} from "../../../../../src/lib/ai/chat-store";
import {
  resolveChatModel,
  resolveReasoningEffort,
} from "../../../../../src/lib/ai/openai";
import { formatAiException } from "../../../../../src/lib/ai/scene-utils";
import { csrfResponse } from "../../../../../src/lib/csrf";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../../src/lib/device-flow";
import { frameForAccount } from "../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";

export const runtime = "nodejs";
// One model call, no agent loop — but a large app rewrite on a reasoning
// model is still slow, so this sits well above the platform default.
export const maxDuration = 300;

// App-code chat for the cloud (the backend's twin is
// backend/app/api/ai_apps.py). Plain JSON in, plain JSON out — the SPA's
// chatLogic fakes the typing client-side for this panel, unlike the scene
// chat's NDJSON stream.
//
// The app's sources arrive in the request; the cloud stores none of them.

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "ai:apps-chat", {
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
  const sources = readAppSources(body.sources);
  if (!sources) {
    return jsonError("invalid_sources", 400, {
      detail: "App sources are required",
    });
  }

  const settingsRows = await db
    .select()
    .from(accountSettings)
    .where(eq(accountSettings.accountId, accountId));
  const openaiValue = settingsRows.find((row) => row.key === "openAI")?.value;
  const openaiSettings =
    openaiValue && typeof openaiValue === "object" && !Array.isArray(openaiValue)
      ? (openaiValue as Record<string, unknown>)
      : {};
  const apiKey = openaiSettings.backendApiKey;
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return jsonError("missing_api_key", 400, {
      detail: "OpenAI backend API key not set",
    });
  }

  // A frame id the account does not own is dropped rather than refused: the
  // chat is about the app's code, and the frame is only how the panel groups
  // its conversations.
  const requestedFrameId = stringOrNull(body.frameId);
  const frame = requestedFrameId
    ? await frameForAccount(db, accountId, requestedFrameId)
    : undefined;
  const sceneId = stringOrNull(body.sceneId);
  const nodeId = stringOrNull(body.nodeId);

  const chat = await ensureChat(db, accountId, {
    chatId: stringOrNull(body.chatId) ?? crypto.randomUUID(),
    // Same composite the backend builds, so a chat opened on one app node is
    // not confused with another node's in the same scene.
    contextId: sceneId && nodeId ? `${sceneId}::${nodeId}` : null,
    contextType: "app",
    frameId: frame?.id ?? null,
  });
  if (!chat) {
    return jsonError("invalid_chat", 403, {
      detail: "This chat id belongs to another account.",
    });
  }

  let history = await historyForModel(db, chat.id);
  if (history.length === 0 && Array.isArray(body.history)) {
    history = (body.history as unknown[])
      .map((item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? (item as Record<string, unknown>)
          : null,
      )
      .filter(
        (item): item is Record<string, unknown> =>
          item !== null &&
          (item.role === "user" || item.role === "assistant") &&
          typeof item.content === "string" &&
          Boolean(item.content.trim()),
      )
      .map((item) => ({
        content: (item.content as string).trim(),
        role: item.role as "user" | "assistant",
      }))
      .slice(-12);
  }

  await appendChatMessage(db, chat.id, { content: prompt, role: "user" });

  try {
    const result = await runAppChat({
      apiKey: apiKey.trim(),
      appKeyword: stringOrNull(body.appKeyword),
      appName: stringOrNull(body.appName),
      history,
      model: resolveChatModel(openaiSettings),
      nodeId,
      prompt,
      reasoningEffort: resolveReasoningEffort(openaiSettings),
      sceneId,
      signal: request.signal,
      sources,
    });
    await appendChatMessage(db, chat.id, {
      content: result.reply,
      // File contents are NOT persisted: they are already in the user's
      // editor, they can be large, and a chat row is not a version store.
      payload: result.files ? { files: Object.keys(result.files) } : null,
      role: "assistant",
      tool: result.tool,
    });
    return NextResponse.json({
      chatId: chat.id,
      reply: result.reply,
      tool: result.tool,
      ...(result.files ? { files: result.files } : {}),
    });
  } catch (error) {
    const detail = `App chat failed: ${formatAiException(error)}`;
    try {
      await appendChatMessage(db, chat.id, {
        content: detail,
        role: "assistant",
        tool: "error",
      });
    } catch {
      // persisting the failure is best-effort
    }
    // The panel renders `detail` as the reply, so this reaches the user as
    // the assistant saying what went wrong rather than a silent dead chat.
    return NextResponse.json({ detail, error: "ai_failed" }, { status: 502 });
  }
}
