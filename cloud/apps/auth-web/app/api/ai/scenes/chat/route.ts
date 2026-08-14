import { asc, eq } from "drizzle-orm";
import {
  accountSettings,
  createDb,
  frameSceneAssignments,
  storeScenes,
} from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import {
  answerFrameQuestion,
  answerSceneQuestion,
  CHAT_MODEL,
  formatAiException,
  formatFrameContext,
  formatFrameSceneSummary,
  generateSceneJson,
  generateScenePlan,
  modifySceneJson,
  normalizeSceneChatTool,
  openaiModel,
  repairSceneJson,
  reviewSceneSolution,
  routeSceneChat,
  SCENE_MODEL,
  SCENE_REVIEW_MODEL,
  splitStateNodesByApp,
  stampScenePrompt,
  validateScenePayload,
  type ChatHistoryItem,
  type JsonObject,
} from "../../../../../src/lib/ai-scene";
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
// Scene generation chains several OpenAI calls; the Python backend allows
// 600 s per call, so don't let the platform default cut the route short.
export const maxDuration = 600;

// AI scene chat for the cloud workspace — the cloud counterpart of the
// self-hosted backend's POST /api/ai/scenes/chat (backend/app/api/
// ai_scenes.py, chat_scene). Same request/response wire shape as the SPA's
// chatLogic expects: {reply, tool, chatId, scenes?, title?}. Stateless by
// design: no chat tables — the SPA resends the full history with every
// request, so chatId is just echoed (or minted). The account's own OpenAI
// backend key (openAI.backendApiKey in account_settings) pays for the calls.

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function objectOrNull(value: unknown): JsonObject | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return null;
}

function objectArrayOrNull(value: unknown): JsonObject[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.filter(
    (entry): entry is JsonObject =>
      Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
  );
}

function historyFromBody(value: unknown): ChatHistoryItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const history: ChatHistoryItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const role = (entry as JsonObject).role;
    const content = (entry as JsonObject).content;
    if (typeof role === "string" && typeof content === "string") {
      history.push({ content, role });
    }
  }
  return history;
}

async function frameContextForRequest(
  db: ReturnType<typeof createDb>,
  accountId: string,
  frameId: unknown,
): Promise<{ frameContext: string | null; frameSceneSummary: string | null }> {
  // Missing or foreign frame ids never fail the chat — the frame details are
  // optional context, so just proceed without them (the self-hosted 404 is a
  // stricter check the stateless cloud chat does not need).
  if (typeof frameId !== "string") {
    return { frameContext: null, frameSceneSummary: null };
  }
  const frame = await frameForAccount(db, accountId, frameId);
  if (!frame) {
    return { frameContext: null, frameSceneSummary: null };
  }
  const hardware = objectOrNull(frame.hardware) ?? {};
  const frameContext = formatFrameContext({
    color: hardware.color,
    device: hardware.device,
    height: hardware.height,
    name: frame.name,
    width: hardware.width,
  });
  const rows = await db
    .select({
      sceneId: frameSceneAssignments.sceneId,
      sceneName: storeScenes.name,
    })
    .from(frameSceneAssignments)
    .innerJoin(storeScenes, eq(storeScenes.id, frameSceneAssignments.sceneId))
    .where(eq(frameSceneAssignments.frameId, frame.id))
    .orderBy(asc(frameSceneAssignments.position));
  const frameSceneSummary = formatFrameSceneSummary(
    rows.map((row) => ({ id: row.sceneId, name: row.sceneName })),
  );
  return { frameContext, frameSceneSummary };
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

  const body = await readJsonObject(request);
  const prompt =
    typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return jsonError("invalid_prompt", 400, { detail: "Prompt is required" });
  }
  const chatId = stringOrNull(body.chatId) ?? crypto.randomUUID();

  const settingsRows = await db
    .select()
    .from(accountSettings)
    .where(eq(accountSettings.accountId, session.accountId));
  const openaiSettings =
    objectOrNull(settingsRows.find((row) => row.key === "openAI")?.value) ?? {};
  const apiKey = openaiSettings.backendApiKey;
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return jsonError("missing_api_key", 400, {
      detail: "OpenAI backend API key not set",
    });
  }

  const { frameContext, frameSceneSummary } = await frameContextForRequest(
    db,
    session.accountId,
    body.frameId,
  );

  const history = historyFromBody(body.history);
  const scenePayload = objectOrNull(body.scene);
  const sceneId = stringOrNull(body.sceneId);
  const selectedNodes = objectArrayOrNull(body.selectedNodes);
  const selectedEdges = objectArrayOrNull(body.selectedEdges);
  const chatModel = openaiModel(openaiSettings, "chatModel", CHAT_MODEL);
  const sceneModel = openaiModel(openaiSettings, "sceneModel", SCENE_MODEL);
  const reviewModel = openaiModel(
    openaiSettings,
    "reviewModel",
    SCENE_REVIEW_MODEL,
  );

  try {
    const scenePrefix = "Build a new scene:";
    let tool: string | null = null;
    let toolPrompt: string | null = null;
    if (prompt.startsWith(scenePrefix)) {
      tool = "build_scene";
      toolPrompt = prompt.slice(scenePrefix.length).trim() || prompt;
    } else {
      const toolPayload = await routeSceneChat({
        apiKey,
        frameContext,
        history,
        model: chatModel,
        prompt,
        scene: scenePayload,
      });
      tool = typeof toolPayload.tool === "string" ? toolPayload.tool : null;
      toolPrompt =
        typeof toolPayload.tool_prompt === "string"
          ? toolPayload.tool_prompt
          : null;
    }
    if (!toolPrompt || !toolPrompt.trim()) {
      toolPrompt = prompt;
    }
    tool = normalizeSceneChatTool(tool, Boolean(scenePayload));
    if (tool === "answer_frame_question" || tool === "answer_scene_question") {
      toolPrompt = prompt;
    }

    if ((tool === "answer_scene_question" || tool === "reply") && scenePayload) {
      const answer = await answerSceneQuestion({
        apiKey,
        frameContext,
        history,
        model: chatModel,
        prompt: toolPrompt,
        scene: scenePayload,
        selectedEdges,
        selectedNodes,
      });
      return NextResponse.json({ chatId, reply: answer, tool });
    }

    if (tool === "answer_frame_question" || tool === "reply") {
      const answer = await answerFrameQuestion({
        apiKey,
        frameContext,
        frameSceneSummary,
        history,
        model: chatModel,
        prompt: toolPrompt,
      });
      return NextResponse.json({ chatId, reply: answer, tool });
    }

    if (tool === "build_scene") {
      let responsePayload: JsonObject = {};
      let validationIssues: string[] = [];
      let reviewIssues: string[] = [];
      // Initial generation plus one repair retry.
      const maxAttempts = 2;
      const scenePlan = await generateScenePlan({
        apiKey,
        frameContext,
        model: sceneModel,
        prompt: toolPrompt,
      });
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (attempt === 1) {
          responsePayload = await generateSceneJson({
            apiKey,
            frameContext,
            model: sceneModel,
            plan: scenePlan,
            prompt: toolPrompt,
          });
        } else {
          responsePayload = await repairSceneJson({
            apiKey,
            frameContext,
            issues: [...validationIssues, ...reviewIssues],
            model: sceneModel,
            plan: scenePlan,
            prompt: toolPrompt,
          });
        }
        validationIssues = validateScenePayload(responsePayload);
        if (validationIssues.length > 0) {
          continue;
        }
        reviewIssues = await reviewSceneSolution({
          apiKey,
          frameContext,
          model: reviewModel,
          payload: responsePayload,
          prompt: toolPrompt,
        });
        if (reviewIssues.length > 0) {
          continue;
        }
        break;
      }

      const title =
        typeof responsePayload.title === "string"
          ? responsePayload.title
          : "Untitled Scene";
      const scenes = responsePayload.scenes;
      if (!Array.isArray(scenes)) {
        return jsonError("ai_chat_failed", 500, {
          detail: "AI response did not include scenes.",
        });
      }
      splitStateNodesByApp(responsePayload);
      stampScenePrompt(scenes, toolPrompt);
      return NextResponse.json({
        chatId,
        reply: `Generated a new scene: ${title}.`,
        scenes,
        title,
        tool,
      });
    }

    if (tool === "modify_scene") {
      let responsePayload: JsonObject = {};
      let validationIssues: string[] = [];
      // Initial modification plus one repair retry, as in the Python.
      const maxAttempts = 2;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        responsePayload = await modifySceneJson({
          apiKey,
          frameContext,
          issues: validationIssues.length > 0 ? validationIssues : null,
          model: sceneModel,
          prompt: toolPrompt,
          scene: scenePayload ?? {},
          selectedEdges,
          selectedNodes,
        });
        validationIssues = validateScenePayload(responsePayload);
        if (validationIssues.length === 0) {
          break;
        }
      }

      const scenes = responsePayload.scenes;
      if (!Array.isArray(scenes) || scenes.length === 0) {
        return jsonError("ai_chat_failed", 500, {
          detail: "AI response did not include scenes.",
        });
      }
      const firstScene = objectOrNull(scenes[0]);
      if (sceneId && firstScene) {
        firstScene.id = sceneId;
        const existingName = scenePayload?.name;
        if (existingName && !firstScene.name) {
          firstScene.name = existingName;
        }
      }
      splitStateNodesByApp(responsePayload);
      stampScenePrompt(scenes, toolPrompt);
      let reply = "Updated the current scene.";
      if (validationIssues.length > 0) {
        reply += " Note: the update may need review for validation issues.";
      }
      return NextResponse.json({ chatId, reply, scenes, tool });
    }

    const answer = await answerFrameQuestion({
      apiKey,
      frameContext,
      frameSceneSummary,
      history,
      model: chatModel,
      prompt: toolPrompt,
    });
    return NextResponse.json({ chatId, reply: answer, tool: "reply" });
  } catch (error) {
    return jsonError("ai_chat_failed", 500, {
      detail: `AI chat failed: ${formatAiException(error)}`,
    });
  }
}
