import { eq } from "drizzle-orm";
import { aiChats } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { chatForAccount, chatMessages } from "../../../../../src/lib/ai/chat-store";
import { csrfResponse } from "../../../../../src/lib/csrf";
import { jsonError, requireDatabase } from "../../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ chatId: string }> };

// One chat's messages ({messages: ChatMessageRecord[]}, the shape chatLogic's
// loadChatMessages expects).
export async function GET(request: NextRequest, context: RouteContext) {
  const limited = await rateLimitResponse(request, "ai:chats", {
    limit: 300,
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
  const { chatId } = await context.params;
  const chat = await chatForAccount(db, session.accountId, chatId);
  if (!chat) {
    return jsonError("chat_not_found", 404);
  }
  return NextResponse.json({
    chat: {
      contextId: chat.contextId,
      contextType: chat.contextType,
      createdAt: chat.createdAt.toISOString(),
      frameId: chat.frameId,
      id: chat.id,
      messageCount: chat.messageCount,
      sceneId: chat.contextType === "scene" ? chat.contextId : null,
      title: chat.title,
      updatedAt: chat.updatedAt.toISOString(),
    },
    messages: await chatMessages(db, chat.id),
  });
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "ai:chats", {
    limit: 300,
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
  const { chatId } = await context.params;
  const chat = await chatForAccount(db, session.accountId, chatId);
  if (!chat) {
    return jsonError("chat_not_found", 404);
  }
  await db.delete(aiChats).where(eq(aiChats.id, chat.id));
  return NextResponse.json({ deleted: true });
}
