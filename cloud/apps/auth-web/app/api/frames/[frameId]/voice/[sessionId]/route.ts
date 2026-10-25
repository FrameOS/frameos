import { frames } from "@frameos-cloud/db";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { storedAccountSettings } from "../../../../../../src/lib/account-settings";
import { recordAuditEvent } from "../../../../../../src/lib/audit";
import { resolveAiAccess } from "../../../../../../src/lib/ai/api-key";
import { appendChatMessage, ensureChat, historyForModel } from "../../../../../../src/lib/ai/chat-store";
import { assignedScenes, frameContextBlock } from "../../../../../../src/lib/ai/frame-context";
import { buildInitialInput, runAgentLoop } from "../../../../../../src/lib/ai/loop";
import { OpenAiRequestError } from "../../../../../../src/lib/ai/openai";
import type { JsonObject } from "../../../../../../src/lib/ai/scene-utils";
import { inFlightSpendMicros } from "../../../../../../src/lib/ai/spend-reservations";
import type { ToolContext } from "../../../../../../src/lib/ai/tools";
import {
  buildVoiceSystemPrompt,
  imageSourcesForSettings,
  MAX_VOICE_HISTORY,
  MAX_VOICE_ROUNDS,
  pcmPeak,
  readVoicePermissions,
  TRANSCRIPTION_MODEL,
  transcribePcm,
  transcriptIsHintEcho,
  VOICE_MAX_CHUNK_BYTES,
  VOICE_MIN_AUDIO_BYTES,
  VOICE_SESSION_ID_PATTERN,
  VOICE_SESSIONS_PER_FRAME_PER_15_MIN,
  VOICE_SILENCE_PEAK,
  voiceChatId,
  voiceContextBlock,
  voiceSessions,
  voiceTools,
  type VoicePreview,
  type VoiceQueue,
  type VoiceScene,
  type VoiceSettingsUpdate,
} from "../../../../../../src/lib/ai/voice";
import { meterAiUsageInBackground } from "../../../../../../src/lib/billing";
import { jsonError, requireDatabase } from "../../../../../../src/lib/device-flow";
import { authenticateFrameDevice } from "../../../../../../src/lib/frame-device-auth";
import { cloudEventRouting, reportedActiveSceneId, sceneStateEventCommand } from "../../../../../../src/lib/frame-events";
import {
  currentSceneAssignments,
  frameHoldsAssignedScenes,
  redeployAssignedScenesToFrame,
} from "../../../../../../src/lib/frame-scenes";
import { buildServiceSettingsPayload } from "../../../../../../src/lib/frame-service-settings";
import {
  computeAndStoreServiceSettingGroups,
  enqueueFrameCommand,
  enqueueFrameSettingsPush,
  frameContractProfile,
  frameSettingsRefusal,
  mergeFrameSettings,
  readFrameSettings,
  readServiceSettingGroups,
  supersedePendingCommands,
  validateFrameSettings,
} from "../../../../../../src/lib/frames";
import { logInfo, logWarn, reportError } from "../../../../../../src/lib/log";
import { identityRateLimitResponse, rateLimitResponse } from "../../../../../../src/lib/rate-limit";
import { scenesForRuntime } from "../../../../../../src/lib/retired-apps";
import { deviceSceneIdForFrame, resolveStoreSceneForFrameScene } from "../../../../../../src/lib/scene-images";

export const runtime = "nodejs";
// The closing chunk waits for the transcription and the chat turn.
export const maxDuration = 300;

// Voice chat for a cloud-managed frame (docs/voice-chat.md). Called by the
// DEVICE with its enrollment access token, like the service-settings pull:
//
//   POST /api/frames/{id}/voice/{session}?seq={n}&done={0|1}
//   Content-Type: audio/L16; rate=16000; channels=1
//   <raw 16 kHz 16-bit mono PCM, little-endian; may be empty when done=1>
//
//   -> 202 {"ok": true, "bytes": n}                  every chunk but the last
//   -> 200 {"ok": true, "transcript", "reply", "tools": [...]}
//   -> 200 {"ok": false, "error": "nothing_heard" | "transcription_failed" |
//                        "chat_failed" | "ai_unavailable", "detail"}
//   -> 409 seq_mismatch / unknown_session, 413 over the caps, 429 too many
//
// The chunks are held in this process's memory until `done` (voiceSessions);
// the audio is kept nowhere after the turn. The turn is the AI chat's loop
// with the voice prompt, the frame's context and ONLY the voice tools, each
// doing on this frame what the workspace's rail would (a queued command, a
// preview push, a settings push): a frame's token is a frame's credential,
// never the owner's. A picture (show_image) uses only the service keys the
// owner already granted this frame's scenes: the voice turn grants nothing.
// The owner's three permission switches (frames.voice_permissions,
// docs/voice-chat.md "What the voice chat may do") decide which of the tools
// the model is offered at all.

// "Now"-commands expire like the event route's: a scene switch spoken on
// Monday must not fire on Friday.
const commandTtlMs = 5 * 60 * 1000;

function failure(error: string, detail: string) {
  // 200 on purpose: the frame reads the body and sounds the error; a 5xx
  // would read as "the cloud is down" when the cloud is fine.
  return NextResponse.json({ detail: detail.slice(0, 500), error, ok: false });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string; sessionId: string }> },
) {
  // A session is up to 30 chunks (a second each); the per-frame session
  // budget below is the real cap, this only bounds an unauthenticated flood.
  const limited = await rateLimitResponse(request, "frames:voice", {
    limit: 1200,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const auth = await authenticateFrameDevice(db, request.headers.get("authorization"));
  if ("response" in auth) {
    return auth.response;
  }
  const { frameId, sessionId } = await params;
  const frame = auth.frame;
  if (frame.id !== frameId) {
    return jsonError("frame_mismatch", 403);
  }
  if (frame.status !== "active") {
    return jsonError("frame_not_active", 409);
  }
  if (!VOICE_SESSION_ID_PATTERN.test(sessionId)) {
    return jsonError("invalid_session_id", 400);
  }
  const seqRaw = request.nextUrl.searchParams.get("seq") ?? "0";
  const seq = /^\d{1,5}$/.test(seqRaw) ? Number(seqRaw) : -1;
  if (seq < 0) {
    return jsonError("invalid_seq", 400);
  }
  const done = request.nextUrl.searchParams.get("done") === "1";
  if (seq === 0) {
    const sessionLimited = await identityRateLimitResponse(frame.id, "frames:voice-session", {
      limit: VOICE_SESSIONS_PER_FRAME_PER_15_MIN,
      windowMs: 15 * 60 * 1000,
    });
    if (sessionLimited) {
      return sessionLimited;
    }
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > VOICE_MAX_CHUNK_BYTES) {
    return jsonError("chunk_too_large", 413);
  }
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length > VOICE_MAX_CHUNK_BYTES) {
    return jsonError("chunk_too_large", 413);
  }
  const appended = voiceSessions.append(frame.id, sessionId, seq, body);
  if (typeof appended === "string") {
    return jsonError(appended, appended === "session_too_long" ? 413 : 409);
  }
  if (!done) {
    return NextResponse.json({ bytes: appended.received, ok: true }, { status: 202 });
  }
  const pcm = voiceSessions.take(frame.id, sessionId);
  if (!pcm) {
    return jsonError("unknown_session", 409);
  }

  const accountId = frame.accountId;
  const access = await resolveAiAccess(db, accountId, {
    inFlightMicros: inFlightSpendMicros(accountId),
    surface: "voice_chat",
  });
  if (!access.ok) {
    logWarn("frames.voice_refused", { frameId: frame.id, reason: access.refusal.reason });
    return failure("ai_unavailable", access.refusal.detail);
  }
  const { credentials } = access;
  if (pcm.length < VOICE_MIN_AUDIO_BYTES) {
    return failure("nothing_heard", "the recording was too short");
  }
  const peak = pcmPeak(pcm);
  if (peak < VOICE_SILENCE_PEAK) {
    return failure("nothing_heard", `silence (peak ${peak})`);
  }

  // What the frame holds, by store id and name, and which one it reports
  // showing (a runtime id, mapped back to its store scene).
  const scenes: VoiceScene[] = (await assignedScenes(db, frame.id)).map((row) => ({
    id: row.sceneId,
    name: row.name,
  }));
  const reportedActive = reportedActiveSceneId(frame.lastState);
  const activeStoreId = reportedActive
    ? await resolveStoreSceneForFrameScene(db, frame.id, reportedActive)
    : undefined;
  const showing = scenes.find((scene) => scene.id === activeStoreId) ?? null;

  const turnId = `voice-${frame.id}-${sessionId}`;
  let transcript: string;
  try {
    const heard = await transcribePcm(pcm, {
      apiKey: credentials.apiKey,
      prompt: scenes.map((scene) => scene.name).join(", ") || undefined,
    });
    transcript = heard.text;
    if (heard.usage) {
      meterAiUsageInBackground({
        accountId,
        credentialSource: credentials.source,
        model: TRANSCRIPTION_MODEL,
        surface: "voice_chat",
        turnId: `${turnId}-stt`,
        usage: heard.usage,
      });
    }
  } catch (error) {
    reportError("frames.voice_transcription_failed", error, { accountId, frameId: frame.id });
    return failure("transcription_failed", error instanceof Error ? error.message : String(error));
  }
  if (!transcript) {
    return failure("nothing_heard", "the transcription came back empty");
  }
  if (transcriptIsHintEcho(transcript, scenes.map((scene) => scene.name))) {
    return failure("nothing_heard", "only the scene names came back");
  }

  const chat = await ensureChat(db, accountId, {
    chatId: voiceChatId(frame.id),
    contextType: "frame",
    frameId: frame.id,
  });
  const history = chat ? await historyForModel(db, chat.id, MAX_VOICE_HISTORY) : [];

  // Each tool queues what the workspace's rail would, on this frame alone.
  const queue: VoiceQueue = async (type, payload) => {
    const audit = async (commandType: string, commandId: string | undefined) => {
      await recordAuditEvent(db, {
        accountId,
        actor: { accountId, frameId: frame.id, kind: "voice_chat" },
        eventType: "frame.command_sent",
        metadata: { source: "voice_chat", type: commandType },
        target: { commandId, frameId: frame.id },
      });
    };
    if (type === "set_current_scene") {
      const storeSceneId = typeof payload?.scene_id === "string" ? payload.scene_id : "";
      const deviceSceneId = await deviceSceneIdForFrame(db, frame.id, storeSceneId);
      // A scene the device does not hold yet: re-push the assigned set with
      // this one active, as the event route does for the same case.
      const assigned = (await currentSceneAssignments(db, frame.id)).some(
        (assignment) => assignment.sceneId.toLowerCase() === storeSceneId.toLowerCase(),
      );
      if (!frameHoldsAssignedScenes(frame) && assigned) {
        const redeploy = await redeployAssignedScenesToFrame(db, {
          accountId,
          activeSceneId: deviceSceneId,
          frame,
        });
        if (redeploy.ok) {
          await audit("set_scenes", redeploy.commandId);
          return { command_id: redeploy.commandId, ok: true, type: "set_scenes" };
        }
      }
      const command = await enqueueFrameCommand(db, {
        createdByAccountId: accountId,
        frameId: frame.id,
        payload: { scene_id: deviceSceneId },
        ttlMs: commandTtlMs,
        type: "set_current_scene",
      });
      await audit("set_current_scene", command?.id);
      return { command_id: command?.id, ok: true, type: "set_current_scene" };
    }
    if (type === "scene_event") {
      // `setSceneState` rides scene_event from FrameOS 2026.9.21; an older
      // frame cannot take it, and the model is told so instead of a command
      // sitting in the queue looking delivered.
      const routed = cloudEventRouting("setSceneState", frameContractProfile(frame), frame.frameosVersion);
      if (!routed.ok || routed.verb !== "scene_event") {
        return { error: routed.ok ? "unsupported_event" : routed.error, ok: false };
      }
      const state = (payload?.payload as JsonObject | undefined)?.state as Record<string, unknown> | undefined;
      const event = sceneStateEventCommand(state);
      if (!event.ok) {
        return { error: event.error, ok: false };
      }
      const command = await enqueueFrameCommand(db, {
        createdByAccountId: accountId,
        frameId: frame.id,
        payload: event.payload,
        ttlMs: commandTtlMs,
        type: "scene_event",
      });
      await audit("scene_event", command?.id);
      return { command_id: command?.id, ok: true, type: "scene_event" };
    }
    const command = await enqueueFrameCommand(db, {
      createdByAccountId: accountId,
      frameId: frame.id,
      ttlMs: commandTtlMs,
      type: "render",
    });
    await audit("render", command?.id);
    return { command_id: command?.id, ok: true, type: "render" };
  };
  // Which picture sources the frame can draw: the service keys the owner
  // granted its scenes (the same answer the device's service-settings pull
  // gives), and no others. The voice turn never widens a grant.
  let grantedGroups = readServiceSettingGroups(frame.serviceSettingGroups);
  if (!grantedGroups) {
    try {
      grantedGroups = await computeAndStoreServiceSettingGroups(db, frame.id);
    } catch (error) {
      reportError("frames.voice_service_settings_failed", error, { accountId, frameId: frame.id });
      grantedGroups = [];
    }
  }
  const revealed = await storedAccountSettings(db, accountId, { reveal: true });
  const stored: Record<string, Record<string, string>> = {};
  for (const [group, value] of Object.entries(revealed)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      stored[group] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
    }
  }
  const imageSources = imageSourcesForSettings(buildServiceSettingsPayload(grantedGroups, stored).settings);

  // The editor's "Preview on frame" (the event route's uploadScenes): a
  // set_scenes push of the picture alone. A later activate_scene finds the
  // assigned scenes gone from the device and re-pushes them, as the queue
  // above does — and that push carries the picture along, so it stays
  // selectable until installed or discarded (docs/scene-previews.md).
  const previewScenes: VoicePreview = async (previewed, sceneId) => {
    const delivered = scenesForRuntime(previewed, frame.frameosVersion);
    const checksum = createHash("sha256").update(JSON.stringify(delivered)).digest("hex");
    await supersedePendingCommands(db, frame.id, "set_scenes");
    // `preview` outlives the bundle (spentCommandPayload keeps it): the
    // workspace's preview row reads it (scenePreviewsByFrame).
    const shown = previewed.find((scene) => scene.id === sceneId);
    const command = await enqueueFrameCommand(db, {
      createdByAccountId: accountId,
      frameId: frame.id,
      payload: {
        checksum,
        // `scene` is the shown scene itself, for the preview row's "Install";
        // only the newest push keeps it (enqueueFrameCommand trims the rest).
        preview: {
          name: typeof shown?.name === "string" ? shown.name : "Preview",
          scene: shown ?? null,
          scene_id: sceneId,
          source: "voice",
        },
        scene_id: sceneId,
        scenes: delivered,
      },
      type: "set_scenes",
    });
    await recordAuditEvent(db, {
      accountId,
      actor: { accountId, frameId: frame.id, kind: "voice_chat" },
      eventType: "frame.command_sent",
      metadata: { checksum, scene_count: delivered.length, source: "voice_chat", type: "set_scenes" },
      target: { commandId: command?.id, frameId: frame.id },
    });
    return { command_id: command?.id, ok: true, type: "set_scenes" };
  };

  // The Settings panel's push (PATCH /api/frames/{id}/settings): validated
  // against the contract and the frame's firmware, mirrored into the frame
  // row, queued as set_settings.
  const updateSettings: VoiceSettingsUpdate = async (settings) => {
    const validated = validateFrameSettings(settings);
    if (validated.error || !validated.settings) {
      return { error: validated.error ?? "invalid_settings", ok: false };
    }
    const refusal = frameSettingsRefusal(frame, validated.settings);
    if (refusal) {
      return { error: refusal.error, ok: false };
    }
    const merged = mergeFrameSettings(frame.settings, validated.settings);
    if (merged) {
      await db.update(frames).set({ settings: merged, updatedAt: new Date() }).where(eq(frames.id, frame.id));
    }
    const command = await enqueueFrameSettingsPush(db, frame, validated.settings, { createdByAccountId: accountId });
    await recordAuditEvent(db, {
      accountId,
      actor: { accountId, frameId: frame.id, kind: "voice_chat" },
      eventType: "frame.settings_pushed",
      metadata: { keys: Object.keys(validated.settings), source: "voice_chat" },
      target: { commandId: command?.id, frameId: frame.id },
    });
    return { command_id: command?.id, ok: true, type: "set_settings" };
  };

  const permissions = readVoicePermissions(frame.voicePermissions);
  const tools = voiceTools({
    activeSceneId: showing?.id,
    imageSources,
    permissions,
    previewScenes,
    queue,
    scenes,
    updateSettings,
  });
  const toolContext: ToolContext = {
    accountId,
    baseTools: false,
    db,
    editorAvailable: false,
    emitScenes: () => undefined,
    extraTools: tools,
    frameId: frame.id,
    prompt: transcript,
  };
  const context = await frameContextBlock(db, accountId, frame.id);
  let result;
  try {
    result = await runAgentLoop({
      apiKey: credentials.apiKey,
      emit: () => undefined,
      input: buildInitialInput({
        contextBlock: voiceContextBlock(
          context.block,
          showing,
          typeof readFrameSettings(frame.settings).rotate === "number"
            ? (readFrameSettings(frame.settings).rotate as number)
            : 0,
          imageSources,
          permissions,
        ),
        history,
        prompt: transcript,
      }),
      instructions: buildVoiceSystemPrompt(),
      maxRounds: MAX_VOICE_ROUNDS,
      model: credentials.model,
      reasoningEffort: credentials.reasoningEffort,
      toolContext,
    });
  } catch (error) {
    reportError("frames.voice_turn_failed", error, { accountId, frameId: frame.id });
    const detail = error instanceof OpenAiRequestError ? error.message : `AI chat failed: ${String(error)}`;
    return failure("chat_failed", detail);
  }
  meterAiUsageInBackground({
    accountId,
    chatId: chat?.id ?? null,
    credentialSource: credentials.source,
    model: credentials.model,
    rounds: result.rounds,
    surface: "voice_chat",
    turnId,
    usage: result.usage,
  });
  const reply = result.reply.trim() || "Done.";
  if (chat) {
    await appendChatMessage(db, chat.id, { content: transcript, role: "user", tool: "voice" });
    await appendChatMessage(db, chat.id, { content: reply, role: "assistant", tool: "voice" });
  }
  logInfo("frames.voice_turn", {
    frameId: frame.id,
    rounds: result.rounds,
    tools: result.toolCalls.join(","),
  });
  return NextResponse.json({ ok: true, reply, tools: result.toolCalls, transcript });
}
