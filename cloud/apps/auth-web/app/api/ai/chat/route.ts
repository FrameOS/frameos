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
import {
  priceUsage,
  readAccountMargin,
  resolveModelPrice,
  splitProviderUsage,
} from "@frameos-cloud/ledger";
import { aiRefusalResponse } from "../../../../src/lib/ai/access";
import { resolveAiAccess } from "../../../../src/lib/ai/api-key";
import { meterAiUsageInBackground } from "../../../../src/lib/billing";
import { buildInitialInput, runAgentLoop } from "../../../../src/lib/ai/loop";
import { formatAiException, type JsonObject } from "../../../../src/lib/ai/scene-utils";
import { captureAiGeneration, captureAiTurn } from "../../../../src/lib/ai/telemetry";
import type { ListingEvent, ScenesEvent, ToolContext } from "../../../../src/lib/ai/tools";
import {
  activeTurnForChat,
  startTurn,
  turnStream,
} from "../../../../src/lib/ai/turn-runner";
import { csrfResponse } from "../../../../src/lib/csrf";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../src/lib/device-flow";
import { frameForAccount } from "../../../../src/lib/frames";
import { logInfo, logWarn, reportError } from "../../../../src/lib/log";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { readSession } from "../../../../src/lib/session";

export const runtime = "nodejs";
// The relay stream of one turn; the turn itself has its own ceiling
// (TURN_MAX_MS) and outlives this response if the client drops.
export const maxDuration = 600;

// AI chat v2: a single streaming agentic loop over the OpenAI Responses API,
// replacing the old /api/ai/scenes/chat pipeline (router → plan → generate →
// review → repair as sequential blocking calls). The response is NDJSON —
// one JSON event per line (see ChatStreamEvent) — consumed by the shared
// SPA's chatLogic in cloud mode and the store's SceneAiPanel. Chats persist
// in ai_chats/ai_chat_messages.
//
// The turn runs detached (turn-runner.ts): this response only relays its
// events. A dropped connection does not abort the model; the client resumes
// at GET /api/ai/chat/turns/[turnId]?after=N.

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
/** The editor's draft listing, when the client sent one: only the fields
 * it named, and only in the shapes the listing has. */
function parseDraftListing(value: unknown): ListingEvent["listing"] | null {
  const record = objectOrNull(value);
  if (!record) {
    return null;
  }
  const draft: ListingEvent["listing"] = {};
  if (typeof record.description === "string" || record.description === null) {
    draft.description = record.description;
  }
  if (typeof record.category === "string" || record.category === null) {
    draft.category = record.category;
  }
  if (typeof record.frameosVersion === "string" || record.frameosVersion === null) {
    draft.frameosVersion = record.frameosVersion;
  }
  if (Array.isArray(record.tags) && record.tags.every((tag) => typeof tag === "string")) {
    draft.tags = record.tags.slice(0, 5) as string[];
  }
  return Object.keys(draft).length > 0 ? draft : null;
}

async function storeSceneContextBlock(
  db: ReturnType<typeof createDb>,
  accountId: string,
  storeSceneId: string | null,
  draft: ListingEvent["listing"] | null,
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
  // The listing as the user sees it: the editor's draft when it sent one
  // (unsaved edits included), else the published one.
  const description = draft?.description !== undefined ? draft.description : scene.description;
  const category = draft?.category !== undefined ? draft.category : scene.category;
  const tags = draft?.tags ?? scene.tags;
  const lines = [
    "The user is on the scene store, looking at this store scene in its editor:",
    `- Store scene id: ${scene.id} (slug "${scene.slug}", version ${scene.latestVersion})`,
    `- Name: ${scene.name}`,
    // Always stated, empty included: "update the description" on a scene
    // with none must not read as an invitation to find one elsewhere.
    `- Listing description${draft ? " (the editor's draft)" : ""}: ${description || "(none yet)"}`,
    ...(category ? [`- Category: ${category}`] : []),
    ...(tags.length > 0 ? [`- Tags: ${tags.join(", ")}`] : []),
    `- Publisher: ${scene.publisher ?? "FrameOS user"}${owned ? " (this is the user's own scene)" : ""}`,
    `- Visibility: ${scene.visibility}`,
    ...(owned
      ? [
          "- Saving: the editor's \"Save as new version\" button publishes the edited scene as a new version of this listing; \"Fork & save copy\" makes a separate private copy. save_scene always makes a private copy (a fork of this store scene by default).",
          "- The listing (description, tags, category, minimum FrameOS version) is part of a version: update_scene_listing edits the draft, and Save publishes it with the scene.",
        ]
      : [
          "- Saving: the user does not own this scene, so edits are saved as a FORK — the editor's \"Fork & save copy\" button or save_scene (which forks this store scene by default) creates a private copy in their account. Never suggest they can overwrite the original.",
          "- The listing can be edited in the draft (update_scene_listing) like the scene, but only a fork of their own can carry it.",
        ]),
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

  // The one gate: the AI switch, the key, and the daily cap, in that order
  // (§5.1/§5.3). Every AI surface goes through it, which is what makes
  // "does the cap apply here?" a question with one answer.
  const access = await resolveAiAccess(db, accountId, { surface: "scene_chat" });
  if (!access.ok) {
    return aiRefusalResponse(access.refusal);
  }
  const { apiKey, model, reasoningEffort, source: credentialSource } =
    access.credentials;
  // The in-turn budget (§5.3): the gate let the turn start under the cap,
  // and this is what stops it once its own rounds have carried the day past
  // cap + overdraft. Priced the way metering will price it, from the same
  // price row and the same margin, so the number the runner stops on is the
  // number the record will say.
  const budget = access.budget
    ? {
        ...access.budget,
        marginBasisPoints: await readAccountMargin(db, accountId),
        price: await resolveModelPrice(db, model),
      }
    : undefined;

  const requestedChatId = stringOrNull(body.chatId) ?? crypto.randomUUID();
  const scenePayload = objectOrNull(body.scene);
  const sceneId = stringOrNull(body.sceneId);
  const { block: frameBlock, frameId } = await frameContextBlock(
    db,
    accountId,
    stringOrNull(body.frameId),
  );
  const draftListing = parseDraftListing(body.listing);
  const { block: storeBlock, storeSceneId } = await storeSceneContextBlock(
    db,
    accountId,
    stringOrNull(body.storeSceneId),
    draftListing,
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

  if (activeTurnForChat(chat.id)) {
    return jsonError("turn_in_progress", 409, {
      detail: "The assistant is still working on the previous message in this chat.",
    });
  }

  await appendChatMessage(db, chat.id, { content: prompt, role: "user" });

  // The metered surface is the gate's, never the client's. `surface` decides
  // whether a turn is absorbed — free and uncapped — so a client-chosen value
  // was free AI for anyone who sent "scene_convert" (§9.2 item 1). What the
  // client says about where it is ("editor", "frame", "store") is kept as
  // context for the usage page, and nothing prices on it.
  const surface = "scene_chat";
  const context =
    typeof body.surface === "string" && /^[a-z0-9_-]{1,32}$/i.test(body.surface)
      ? body.surface.toLowerCase()
      : frameId
        ? "frame"
        : "editor";
  const scenesDelivered: { tool: string; title?: string; count: number }[] = [];
  const deliveredScenes: unknown[] = [];
  const roundToolCalls: string[] = [];
  const toolArgErrors: string[] = [];

  const turnId = crypto.randomUUID();
  let roundsSeen = 0;
  let usageSeen = { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  // The turn's emit, once it is running; emitScenes forwards through it.
  let turnEmit: (event: ScenesEvent | ListingEvent) => void = () => {};
  const toolContext: ToolContext = {
    accountId,
    currentListing: draftListing,
    currentScene: scenePayload,
    currentSceneId: sceneId ?? (stringOrNull(scenePayload?.id) || null),
    db,
    editorScenes,
    emitListing: (event) => {
      turnEmit(event);
    },
    emitScenes: (event) => {
      scenesDelivered.push({
        count: event.scenes.length,
        ...(event.title ? { title: event.title } : {}),
        tool: event.tool,
      });
      // The persisted copy lets a client that lost the stream for good
      // recover the delivered scene from the chat history.
      deliveredScenes.splice(0, deliveredScenes.length, ...event.scenes);
      turnEmit(event);
    },
    frameId,
    prompt,
    // Audit actor for save_scene's store write.
    providerSubject: session.providerSubject,
    storeSceneId,
  };

  const turn = startTurn({
    accountId,
    chatId: chat.id,
    id: turnId,
    onFinish: (finished, outcome, failure) => {
      const durationMs = Date.now() - finished.startedAt;
      // Metered whatever the outcome: a turn that errored or was stopped
      // still burned the tokens it burned, and the provider bills for them.
      // Not awaited — onFinish runs while the turn tears down.
      meterAiUsageInBackground({
        accountId,
        chatId: chat.id,
        context,
        credentialSource,
        model,
        rounds: roundsSeen,
        surface,
        turnId: finished.id,
        usage: usageSeen,
      });
      captureAiTurn({
        accountId,
        chatId: chat.id,
        deliveredTool: toolContext.deliveredTool ?? "reply",
        disconnects: finished.disconnects,
        durationMs,
        error: failure instanceof Error ? failure.message : failure ? String(failure) : undefined,
        model,
        outcome,
        resumes: finished.resumes,
        rounds: roundsSeen,
        surface,
        toolArgErrors,
        toolCalls: roundToolCalls,
        turnId: finished.id,
        usage: usageSeen,
      });
      logInfo("ai.chat.turn_finished", {
        accountId,
        chatId: chat.id,
        disconnects: finished.disconnects,
        durationMs,
        outcome,
        resumes: finished.resumes,
        rounds: roundsSeen,
        toolCalls: roundToolCalls.join(","),
        turnId: finished.id,
      });
    },
    run: async (emit, signal) => {
      turnEmit = emit;
      emit({ chatId: chat.id, turnId, type: "chat" });
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
          onRound: (report) => {
            roundsSeen = report.round;
            roundToolCalls.push(...report.toolCalls);
            if (report.usage) {
              usageSeen = {
                cachedInputTokens: usageSeen.cachedInputTokens + report.usage.cachedInputTokens,
                inputTokens: usageSeen.inputTokens + report.usage.inputTokens,
                outputTokens: usageSeen.outputTokens + report.usage.outputTokens,
                reasoningTokens: usageSeen.reasoningTokens + report.usage.reasoningTokens,
              };
              if (budget && !signal.aborted) {
                const soFar = priceUsage({
                  billable: true,
                  marginBasisPoints: budget.marginBasisPoints,
                  price: budget.price,
                  usage: splitProviderUsage(usageSeen),
                }).priceMicros;
                if (budget.spentMicros + soFar >= budget.capMicros + budget.overdraftMicros) {
                  // The turn crossed the day's line mid-flight: stop it here
                  // rather than let a long tool loop run the overshoot up.
                  // The tokens already burned are metered in onFinish.
                  logWarn("ai.chat.turn_over_budget", {
                    accountId,
                    chatId: chat.id,
                    round: report.round,
                    soFarMicros: soFar.toString(),
                    spentMicros: budget.spentMicros.toString(),
                    turnId,
                  });
                  turn.controller.abort(
                    new Error(
                      budget.allowance === "shared"
                        ? "This reply used up today's free AI allowance on the shared key. Nothing is billed for it; it resets at midnight UTC."
                        : "This account reached its daily AI limit during this reply. Today's limit resets at midnight UTC.",
                    ),
                  );
                }
              }
            }
            captureAiGeneration({
              accountId,
              chatId: chat.id,
              error: report.error,
              httpStatus: report.httpStatus,
              latencyMs: report.latencyMs,
              model,
              reasoningEffort,
              round: report.round,
              status: report.status,
              toolCalls: report.toolCalls,
              turnId,
              usage: report.usage,
            });
          },
          onToolArgumentError: (report) => {
            toolArgErrors.push(report.tool);
            // The parse failure and the byte count, never the arguments
            // themselves — enough to tell "the model wrote bad JSON" from
            // "the model was cut off", which the tool result alone cannot.
            logWarn("ai.chat.tool_arguments_unparsable", {
              accountId,
              chatId: chat.id,
              detail: report.detail,
              length: report.length,
              round: report.round,
              tool: report.tool,
              turnId,
            });
          },
          reasoningEffort,
          signal,
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
          payload:
            scenesDelivered.length > 0
              ? { delivered: deliveredScenes, scenes: scenesDelivered }
              : null,
          role: "assistant",
          tool,
        });
        emit({ reply: content, tool, type: "done" });
      } catch (error) {
        const detail = `AI chat failed: ${formatAiException(error)}`;
        emit({ detail, type: "error" });
        if (signal.aborted) {
          logWarn("ai.chat.turn_aborted", {
            accountId,
            chatId: chat.id,
            reason: formatAiException(signal.reason),
            turnId,
          });
        } else {
          reportError("ai.chat.turn_failed", error, {
            accountId,
            chatId: chat.id,
            model,
            turnId,
          });
        }
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
    },
  });

  const stream = turnStream(turn, 0, {
    onDisconnect: (delivered) => {
      logWarn("ai.chat.client_disconnected", {
        accountId,
        afterEvents: delivered,
        chatId: chat.id,
        elapsedMs: Date.now() - turn.startedAt,
        turnId: turn.id,
      });
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
