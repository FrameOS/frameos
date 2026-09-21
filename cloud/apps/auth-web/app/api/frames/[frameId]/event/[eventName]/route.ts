import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "../../../../../../src/lib/audit";
import { csrfResponse } from "../../../../../../src/lib/csrf";
import {
  jsonError,
  parseOptionalString,
  readJsonObject,
  requireDatabase,
} from "../../../../../../src/lib/device-flow";
import {
  buttonEventCommand,
  cloudEventRouting,
  isContractEventName,
  sceneEventCommand,
  sceneStateCommand,
  sceneStateEventCommand,
  type SceneEventCommand,
} from "../../../../../../src/lib/frame-events";
import {
  enqueueFrameCommand,
  frameContractProfile,
  frameForAccount,
  maxScenesPayloadBytes,
  supersedePendingCommands,
} from "../../../../../../src/lib/frames";
import {
  currentSceneAssignments,
  customEventRoutingForFrame,
  frameHoldsAssignedScenes,
  redeployAssignedScenesToFrame,
} from "../../../../../../src/lib/frame-scenes";
import { deviceSceneIdForFrame } from "../../../../../../src/lib/scene-images";
import { rateLimitResponse } from "../../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../../src/lib/session";
import {
  compiledSceneHint,
  compiledSceneNames,
  detectRiskFlags,
  riskFlagShell,
} from "../../../../../../src/lib/store";

export const runtime = "nodejs";

// "Now"-events expire like the command route's verbs: a scene activation
// queued on Monday must not fire on Friday.
const eventCommandTtlMs = 5 * 60 * 1000;
const maxSceneIdChars = 256;
// Public scene-state values ride along with an activation; they are a handful
// of form fields, not a data channel.
const maxStateBytes = 16 * 1024;
const maxScenesPerUpload = 20;

// The backend's event surface, translated onto the cloud's durable command
// queue (cloud/docs/cloud-workspace-gaps.md item 4). The shared SPA posts
// /api/frames/{id}/event/<name> from the scene editor ("preview on frame"),
// the Assets panel's run-image-scene buttons and the scene control rail; in
// cloud mode those map onto queue verbs the device already speaks:
//
//   render          → render
//   metrics         → get_metrics
//   setCurrentScene → set_current_scene {scene_id, state?}
//   uploadScenes    → set_scenes {scenes, checksum, scene_id?, state?}
//   turnOn/turnOff  → set_display_power {on}                  (linux only)
//   setSceneState   → scene_event {name, payload: {state, render: true}}
//                     before FrameOS 2026.9.21: set_current_scene
//                     {scene_id: <the scene showing>, state}, linux only
//                     (src/lib/frame-events.ts says why)
//   button          → scene_event {name, payload: {pin?, label?, level?}}
//   <custom event>  → scene_event {name, payload: <the request body>}, when
//                     a scene on the frame declares it with the `cloud`
//                     origin (`customEvents: [{name, origins: ["cloud"]}]`)
//
// `scene_event` is the one generic verb — "an event for the scene the frame
// is showing, said by the provider" — and frames know it from FrameOS
// 2026.9.21 (the contract's `since`). An older frame gets what the event
// became before, where that exists, and otherwise 409 frame_update_required
// with the release that would do: a verb the device answers `unknown_verb`
// to would sit in the queue looking delivered.
//
// An uploadScenes push deliberately does NOT touch the frame's store-scene
// assignments: the device's scenes_checksum will differ from the assigned
// checksum afterwards, and the workspace showing "out of sync" is the truth
// about an ad-hoc preview. It does go through the same two refusals as an
// assignment push, though (assignScenesToFrame): a scene the store would
// flag `shell` and a legacy compiled scene are refused here too, so the
// ad-hoc route is not a way around the gates on the assigned one. Anything
// else the backend accepts as an event — an input event, a lifecycle event, a
// custom event no scene on the frame lets the cloud send — 404s honestly.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string; eventName: string }> },
) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "frames:event", {
    limit: 120,
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
  const { frameId, eventName } = await params;
  const frame = await frameForAccount(db, session.accountId, frameId);
  if (!frame) {
    return jsonError("invalid_frame", 404);
  }
  if (frame.status !== "active") {
    return jsonError("frame_not_active", 409);
  }

  const body = await readJsonObject(request);
  // The SPA spells it sceneId on events (backend contract); scene_id also
  // accepted so callers of the command dialect can reuse this route.
  const sceneId =
    parseOptionalString(body.sceneId) ?? parseOptionalString(body.scene_id);
  const state =
    body.state &&
    typeof body.state === "object" &&
    !Array.isArray(body.state) &&
    Buffer.byteLength(JSON.stringify(body.state), "utf8") <= maxStateBytes
      ? (body.state as Record<string, unknown>)
      : undefined;

  // Which events this route takes, and the hub verb each becomes, is the
  // event contract's (docs/events-contract.json, the `cloud` origin): an event
  // that is not there, or whose verb the frame's device plane cannot carry
  // (`set_display_power` and a `set_current_scene` with state are Linux only
  // — the esp32 profile would let the command wait out its TTL to refuse it),
  // is a 404. A name the contract does not have is a custom scene event: the
  // device delivers one from the cloud only to a scene that declares it with
  // the `cloud` origin, so that is asked of the frame's scenes here. What is
  // left below is each verb's payload.
  const custom = !isContractEventName(eventName);
  const routed = custom
    ? await customEventRoutingForFrame(db, frame, eventName)
    : cloudEventRouting(eventName, frameContractProfile(frame), frame.frameosVersion);
  if (!routed.ok) {
    return jsonError(
      routed.error,
      routed.status,
      routed.error === "frame_update_required"
        ? { min_frameos_version: routed.minFrameosVersion }
        : routed.reason
          ? { reason: routed.reason }
          : undefined,
    );
  }
  const type = routed.verb;
  let payload: Record<string, unknown> | undefined;
  let sceneEvent: SceneEventCommand | undefined;
  switch (eventName) {
    case "render":
      break;
    // The Metrics panel's "Request metrics" button. The device answers with a
    // metrics message the hub already stores (frame_metrics + new_metrics
    // broadcast), so mapping the event is all it takes.
    case "metrics":
      break;
    // The frame menu's Turn display off / on. The verb carries the flag
    // rather than being two verbs, so the device has one place to refuse a
    // payload it cannot read; which displays can do anything with it is the
    // workspace's gate (workspaceSurfaces.displayPowerDevices) — the queue
    // does not know what panel is attached, and a frame whose driver ignores
    // the event still acks, so gating here would be guesswork.
    case "turnOn":
    case "turnOff":
      payload = { on: eventName === "turnOn" };
      break;
    case "setCurrentScene": {
      if (!sceneId || sceneId.length > maxSceneIdChars) {
        return jsonError("invalid_scene_id", 400);
      }
      // The workspace names scenes by store uuid; the device by the ids in
      // the deployed scenes.json (deviceSceneIdForFrame).
      const deviceSceneId = await deviceSceneIdForFrame(db, frame.id, sceneId);
      // A scene the device does not hold (assignment never acked, a preview
      // replaced the set, …) cannot be selected: the device answers
      // set_current_scene with `apply-failed` while the queue says
      // "delivered" and the panel keeps showing the old scene. Activating an
      // ASSIGNED scene on such a frame re-pushes the assigned set with this
      // scene active — one durable set_scenes, the same push the assignment
      // route makes. Unassigned ids (a previewed scene, a runtime id typed
      // by hand) keep the plain select: nothing to deploy for them.
      const lowered = sceneId.toLowerCase();
      if (
        !frameHoldsAssignedScenes(frame) &&
        (await currentSceneAssignments(db, frame.id)).some(
          (assignment) => assignment.sceneId.toLowerCase() === lowered,
        )
      ) {
        const redeploy = await redeployAssignedScenesToFrame(db, {
          accountId: session.accountId,
          activeSceneId: deviceSceneId,
          frame,
          state,
        });
        if (redeploy.ok) {
          await recordAuditEvent(db, {
            accountId: session.accountId,
            actor: {
              accountId: session.accountId,
              providerSubject: session.providerSubject,
            },
            eventType: "frame.command_sent",
            metadata: {
              event: eventName,
              reason: "scene_not_on_device",
              type: "set_scenes",
            },
            target: { commandId: redeploy.commandId, frameId: frame.id },
          });
          return NextResponse.json({
            command_id: redeploy.commandId,
            status: "queued",
            type: "set_scenes",
          });
        }
        // The assigned set cannot be assembled (a pulled scene, a yanked
        // version): fall through to the plain select, which is what the
        // route always did — the device's own log then says why.
      }
      payload = { scene_id: deviceSceneId, ...(state ? { state } : {}) };
      break;
    }
    // A GPIO button press, said from the workspace instead of the frame's own
    // button: the scene's `button` listeners cannot tell the difference, which
    // is the point.
    case "button":
      sceneEvent = buttonEventCommand(body);
      break;
    case "setSceneState": {
      if (type === "scene_event") {
        sceneEvent = sceneStateEventCommand(state);
        break;
      }
      // Older firmware: the set_current_scene stand-in.
      const command = sceneStateCommand({
        lastState: frame.lastState,
        profile: frameContractProfile(frame),
        state,
      });
      if (!command.ok) {
        return jsonError(command.error, command.status);
      }
      payload = command.payload;
      break;
    }
    case "uploadScenes": {
      const scenes = body.scenes;
      if (
        !Array.isArray(scenes) ||
        scenes.length === 0 ||
        scenes.length > maxScenesPerUpload
      ) {
        return jsonError("invalid_scenes", 400);
      }
      if (
        !scenes.every(
          (scene) =>
            scene &&
            typeof scene === "object" &&
            !Array.isArray(scene) &&
            typeof (scene as { id?: unknown }).id === "string",
        )
      ) {
        return jsonError("invalid_scenes", 400);
      }
      const serialized = JSON.stringify(scenes);
      if (Buffer.byteLength(serialized, "utf8") > maxScenesPayloadBytes) {
        return jsonError("scenes_payload_too_large", 400);
      }
      if (detectRiskFlags(scenes).includes(riskFlagShell)) {
        return jsonError("scene_refused", 422, {
          detail:
            "This scene runs shell commands, which cloud-managed frames refuse.",
          reason: riskFlagShell,
        });
      }
      const compiled = compiledSceneNames(scenes);
      if (compiled.length > 0) {
        return jsonError("scene_refused", 422, {
          detail: compiledSceneHint,
          reason: "compiled",
          scenes: compiled,
        });
      }
      // The same digest the assignment push uses (buildScenesPayloadForFrame):
      // the device stores it opaquely and echoes it in scene_ack, which is
      // how the workspace can tell this ad-hoc set apart from the assigned one.
      const checksum = createHash("sha256").update(serialized).digest("hex");
      if (sceneId && sceneId.length > maxSceneIdChars) {
        return jsonError("invalid_scene_id", 400);
      }
      payload = {
        checksum,
        scenes,
        ...(sceneId ? { scene_id: sceneId } : {}),
        ...(state ? { state } : {}),
      };
      // A newer scene push of either kind makes the older one pointless.
      await supersedePendingCommands(db, frame.id, "set_scenes");
      break;
    }
    default:
      if (!custom) {
        return jsonError("unsupported_event", 404);
      }
      // A custom event's payload is the request body, as it is on the
      // backend's event route and the frame's own /event/<name>.
      sceneEvent = sceneEventCommand(
        eventName,
        Object.keys(body).length > 0 ? body : undefined,
      );
  }
  if (sceneEvent) {
    if (!sceneEvent.ok) {
      return jsonError(sceneEvent.error, sceneEvent.status);
    }
    payload = sceneEvent.payload;
  }

  const command = await enqueueFrameCommand(db, {
    createdByAccountId: session.accountId,
    frameId: frame.id,
    payload,
    // A preview push waits for the frame like an assignment push does: the
    // battery frames this exists for spend most of their life asleep.
    ...(type === "set_scenes" ? {} : { ttlMs: eventCommandTtlMs }),
    type,
  });

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    eventType: "frame.command_sent",
    metadata: {
      event: eventName,
      type,
      ...(type === "set_scenes" && payload
        ? {
            checksum: payload.checksum,
            scene_count: (payload.scenes as unknown[]).length,
          }
        : {}),
    },
    target: { commandId: command?.id, frameId: frame.id },
  });

  return NextResponse.json({
    command_id: command?.id,
    status: "queued",
    type,
  });
}
