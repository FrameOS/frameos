// Persistence for AI chats. The cloud chat used to be stateless (history
// vanished on reload); v2 stores every turn. Chat ids are client-minted uuids
// — ownership is checked on every access, and an id owned by another account
// is refused, never adopted.
import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import { aiChatMessages, aiChats, createDb } from "@frameos-cloud/db";

type Database = ReturnType<typeof createDb>;

export const maxChatsPerAccount = 100;
export const maxMessagesPerChat = 400;
const chatIdPattern = /^[0-9a-f-]{36}$/i;

export function isChatId(value: unknown): value is string {
  return typeof value === "string" && chatIdPattern.test(value);
}

export async function chatForAccount(
  db: Database,
  accountId: string,
  chatId: string,
) {
  if (!isChatId(chatId)) {
    return undefined;
  }
  const [chat] = await db
    .select()
    .from(aiChats)
    .where(and(eq(aiChats.id, chatId), eq(aiChats.accountId, accountId)))
    .limit(1);
  return chat;
}

// Get-or-create. Returns undefined when the id exists but belongs to someone
// else (the caller should answer 403, not create a shadow chat).
export async function ensureChat(
  db: Database,
  accountId: string,
  input: {
    chatId: string;
    frameId?: string | null;
    contextType?: string | null;
    contextId?: string | null;
  },
) {
  if (!isChatId(input.chatId)) {
    return undefined;
  }
  const [existing] = await db
    .select()
    .from(aiChats)
    .where(eq(aiChats.id, input.chatId))
    .limit(1);
  if (existing) {
    return existing.accountId === accountId ? existing : undefined;
  }
  const contextType =
    input.contextType === "scene" || input.contextType === "app"
      ? input.contextType
      : "frame";
  const [created] = await db
    .insert(aiChats)
    .values({
      accountId,
      contextId: input.contextId ?? null,
      contextType,
      frameId: input.frameId ?? null,
      id: input.chatId,
    })
    .onConflictDoNothing()
    .returning();
  if (!created) {
    // Lost a concurrent insert race; re-read with the ownership check.
    return chatForAccount(db, accountId, input.chatId);
  }
  // Cap chats per account: drop the oldest beyond the limit.
  const stale = await db
    .select({ id: aiChats.id })
    .from(aiChats)
    .where(eq(aiChats.accountId, accountId))
    .orderBy(desc(aiChats.updatedAt), desc(aiChats.id))
    .offset(maxChatsPerAccount);
  if (stale.length > 0) {
    for (const chat of stale) {
      await db.delete(aiChats).where(eq(aiChats.id, chat.id));
    }
  }
  return created;
}

export async function appendChatMessage(
  db: Database,
  chatId: string,
  message: {
    role: "user" | "assistant";
    content: string;
    tool?: string | null;
    payload?: unknown;
  },
) {
  await db.insert(aiChatMessages).values({
    chatId,
    content: message.content,
    payload: message.payload ?? null,
    role: message.role,
    tool: message.tool ?? null,
  });
  await db
    .update(aiChats)
    .set({
      messageCount: sql`${aiChats.messageCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(aiChats.id, chatId));
  // Cap messages per chat (keep the newest window).
  const [cutoff] = await db
    .select({ id: aiChatMessages.id })
    .from(aiChatMessages)
    .where(eq(aiChatMessages.chatId, chatId))
    .orderBy(desc(aiChatMessages.id))
    .offset(maxMessagesPerChat)
    .limit(1);
  if (cutoff) {
    await db
      .delete(aiChatMessages)
      .where(
        and(eq(aiChatMessages.chatId, chatId), lt(aiChatMessages.id, cutoff.id + 1)),
      );
  }
}

export async function listChats(
  db: Database,
  accountId: string,
  options: { frameId?: string | null; limit: number; offset: number },
) {
  const conditions = [eq(aiChats.accountId, accountId)];
  if (options.frameId) {
    conditions.push(eq(aiChats.frameId, options.frameId));
  }
  const rows = await db
    .select()
    .from(aiChats)
    .where(and(...conditions))
    .orderBy(desc(aiChats.updatedAt))
    .limit(options.limit + 1)
    .offset(options.offset);
  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;
  return {
    chats: page.map((chat) => ({
      contextId: chat.contextId,
      contextType: chat.contextType,
      createdAt: chat.createdAt.toISOString(),
      frameId: chat.frameId,
      id: chat.id,
      messageCount: chat.messageCount,
      sceneId: chat.contextType === "scene" ? chat.contextId : null,
      title: chat.title,
      updatedAt: chat.updatedAt.toISOString(),
    })),
    hasMore,
    nextOffset: options.offset + page.length,
  };
}

export async function chatMessages(db: Database, chatId: string) {
  const rows = await db
    .select()
    .from(aiChatMessages)
    .where(eq(aiChatMessages.chatId, chatId))
    .orderBy(asc(aiChatMessages.id));
  return rows.map((row) => ({
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    id: String(row.id),
    // Structured extras of the turn (delivered scenes), so a client that lost
    // the live stream can still pick up what the assistant made.
    payload: row.payload ?? null,
    role: row.role as "user" | "assistant",
    tool: row.tool,
  }));
}

// The model-facing history: recent user/assistant turns as plain text.
export async function historyForModel(
  db: Database,
  chatId: string,
  limit = 12,
): Promise<{ role: "user" | "assistant"; content: string }[]> {
  const rows = await db
    .select()
    .from(aiChatMessages)
    .where(eq(aiChatMessages.chatId, chatId))
    .orderBy(desc(aiChatMessages.id))
    .limit(limit);
  rows.reverse();
  return rows
    .filter(
      (row) =>
        (row.role === "user" || row.role === "assistant") && row.content.trim(),
    )
    .map((row) => ({
      content: row.content,
      role: row.role as "user" | "assistant",
    }));
}
