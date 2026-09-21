// Pure halves of the frame event route
// (app/api/frames/[frameId]/event/[eventName]/route.ts), kept out of the
// route so they can be tested without a database.

import type { ContractProfile } from "./cloud-frames-contract";
import {
  cloudCustomEventRoute,
  cloudEventRouteVerbs,
  contractEventNames,
  customEventDeclarableOrigins,
  customEventMaxNameLength,
  type CloudEventRoute,
} from "./events-contract.gen";
import { frameosVersionSatisfies } from "./store-versions";

const maxSceneIdChars = 256;
// An event payload is a handful of form fields or a button's pin/label, not a
// data channel: the same ceiling public scene state has on this route.
export const maxSceneEventPayloadBytes = 16 * 1024;
const sceneEventVerb = "scene_event";

/** Where an event goes for one frame: a hub verb, or an honest refusal.
 * `unsupported_event` is final for this frame; `frame_update_required` means
 * only the firmware is in the way, and says which release is not. */
export type CloudEventRouting =
  | { ok: true; verb: string }
  | { ok: false; error: "unsupported_event"; status: 404; reason?: string }
  | { ok: false; error: "frame_update_required"; status: 409; minFrameosVersion: string };

const unsupported = (reason?: string): CloudEventRouting => ({
  error: "unsupported_event",
  ok: false,
  status: 404,
  ...(reason ? { reason } : {}),
});

// A frame that has not reported a version is an old one for this purpose (the
// same answer frameSupportsSettingsFrom gives): a verb the device does not
// know is refused `unknown_verb` after waiting in the queue, so "probably new
// enough" is the wrong way to be wrong.
function frameKnowsSince(since: string, frameosVersion: string | null | undefined): boolean {
  if (typeof frameosVersion !== "string" || frameosVersion.trim().length === 0) {
    return false;
  }
  return frameosVersionSatisfies(since, frameosVersion);
}

function routeFor(
  route: CloudEventRoute,
  profile: ContractProfile,
  frameosVersion: string | null | undefined,
  allowBefore = true,
): CloudEventRouting {
  if (route.profiles && !route.profiles.includes(profile)) {
    return unsupported();
  }
  if (route.since === undefined || frameKnowsSince(route.since, frameosVersion)) {
    return { ok: true, verb: route.verb };
  }
  // Older firmware: what the event became before its verb existed, where
  // that ever worked; otherwise the update is what is missing.
  if (
    allowBefore &&
    route.before &&
    (!route.before.profiles || route.before.profiles.includes(profile))
  ) {
    return { ok: true, verb: route.before.verb };
  }
  return { error: "frame_update_required", minFrameosVersion: route.since, ok: false, status: 409 };
}

/** Is `name` one of the contract's built-in events? Any other name is a
 * custom scene event. */
export function isContractEventName(name: string): boolean {
  return contractEventNames.includes(name);
}

/**
 * Where a CONTRACT event goes for a frame of this profile and firmware: the
 * contract's verb when the frame's FrameOS knows it (`since`), what the event
 * became before that (`before`) when it does not, or a refusal — the event is
 * not one the contract gives the `cloud` origin (docs/events-contract.json),
 * its verb has no such device profile, or the firmware predates it.
 *
 * `allowBefore: false` is for a caller that named the verb itself (the raw
 * command route): an older frame's stand-in is not what it asked for.
 */
export function cloudEventRouting(
  eventName: string,
  profile: ContractProfile,
  frameosVersion?: string | null,
  { allowBefore = true }: { allowBefore?: boolean } = {},
): CloudEventRouting {
  const routed = Object.prototype.hasOwnProperty.call(cloudEventRouteVerbs, eventName)
    ? cloudEventRouteVerbs[eventName]
    : undefined;
  return routed ? routeFor(routed, profile, frameosVersion, allowBefore) : unsupported();
}

/** The hub verb a contract event becomes on this frame, or undefined when the
 * cloud cannot send it there (cloudEventRouting says why). */
export function cloudEventVerb(
  eventName: string,
  profile: ContractProfile,
  frameosVersion?: string | null,
): { verb: string } | undefined {
  const routing = cloudEventRouting(eventName, profile, frameosVersion);
  return routing.ok ? { verb: routing.verb } : undefined;
}

// Byte length, not UTF-16 units: the limit is the ESP32's 64-byte name buffer.
function validEventName(name: unknown): name is string {
  if (typeof name !== "string" || name.length === 0) {
    return false;
  }
  return new TextEncoder().encode(name).length <= customEventMaxNameLength;
}

/** The custom events a scene lets the cloud send: `customEvents` entries that
 * list the `cloud` origin. The device's reading of the same array
 * (declaredCustomEventOrigins, frameos/events.nim): an entry without
 * `origins` adds nothing, and a contract event's name cannot be declared. */
export function cloudDeclaredCustomEvents(customEvents: unknown): Set<string> {
  const declared = new Set<string>();
  if (!Array.isArray(customEvents) || !customEventDeclarableOrigins.includes("cloud")) {
    return declared;
  }
  for (const entry of customEvents) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const { name, origins } = entry as { name?: unknown; origins?: unknown };
    if (
      validEventName(name) &&
      !isContractEventName(name) &&
      Array.isArray(origins) &&
      origins.includes("cloud")
    ) {
      declared.add(name);
    }
  }
  return declared;
}

// The runtime registers every pushed scene as "uploaded/<id>" and reports the
// active one that way; scenes.json carries the bare id.
function bareSceneId(sceneId: string): string {
  return sceneId.startsWith("uploaded/") ? sceneId.slice("uploaded/".length) : sceneId;
}

/**
 * Where a CUSTOM event goes. The device delivers one from the cloud only when
 * the scene it is showing declares it with `origins: ["cloud"]` — anything
 * else is logged `event:refused` there and nothing happens — so the same
 * question is asked here first, where the person pressing the button can
 * still be told.
 *
 * `scenes` are the scene objects the cloud assigned to the frame. The scene
 * the frame last reported showing decides when it is one of them; when it is
 * not known, or is not one the cloud holds (an ad-hoc preview, a scene of the
 * frame's own), any assigned scene declaring the event is enough: the device
 * checks again against what it is really showing.
 *
 * The declaration is checked before the firmware, so `frame_update_required`
 * means exactly that: updating is all that is missing.
 */
export function customEventRouting(input: {
  eventName: string;
  profile: ContractProfile;
  frameosVersion: string | null | undefined;
  activeSceneId: string | undefined;
  scenes: readonly unknown[];
}): CloudEventRouting {
  if (!validEventName(input.eventName) || isContractEventName(input.eventName)) {
    return unsupported();
  }
  const scenes = input.scenes.filter(
    (scene): scene is { id?: unknown; customEvents?: unknown } =>
      Boolean(scene) && typeof scene === "object" && !Array.isArray(scene),
  );
  const activeId = input.activeSceneId === undefined ? undefined : bareSceneId(input.activeSceneId);
  const showing = activeId === undefined ? undefined : scenes.find((scene) => scene.id === activeId);
  const declared = (showing ? [showing] : scenes).some((scene) =>
    cloudDeclaredCustomEvents(scene.customEvents).has(input.eventName),
  );
  if (!declared) {
    return unsupported("event_not_declared");
  }
  return routeFor(cloudCustomEventRoute, input.profile, input.frameosVersion);
}

export type SceneEventCommand =
  | { ok: true; payload: { name: string; payload?: Record<string, unknown> } }
  | { ok: false; error: string; status: number };

/**
 * The `scene_event {name, payload?}` command, or why it cannot be one. The
 * tokens are the device's own (handleSceneEvent, hub_client.nim), answered
 * before anything is queued:
 * - `invalid_event`: no name, or one over the contract's length.
 * - `event_not_allowed`: a contract event that does not ride this verb — a
 *   device command (`reboot`, `uploadScenes`), which has a verb and an audit
 *   line of its own, or an event the contract routes elsewhere (`render`,
 *   `setCurrentScene`). A custom name passes: whether the scene showing
 *   declares it is customEventRouting's question, and the device's.
 * - `invalid_payload` / `payload_too_large`: the payload is a JSON object, and
 *   a small one.
 */
export function sceneEventCommand(name: unknown, payload?: unknown): SceneEventCommand {
  if (!validEventName(name)) {
    return { error: "invalid_event", ok: false, status: 400 };
  }
  if (
    isContractEventName(name) &&
    !(
      Object.prototype.hasOwnProperty.call(cloudEventRouteVerbs, name) &&
      cloudEventRouteVerbs[name]?.verb === sceneEventVerb
    )
  ) {
    return { error: "event_not_allowed", ok: false, status: 400 };
  }
  if (payload === undefined || payload === null) {
    return { ok: true, payload: { name } };
  }
  if (typeof payload !== "object" || Array.isArray(payload)) {
    return { error: "invalid_payload", ok: false, status: 400 };
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    serialized = undefined;
  }
  if (serialized === undefined) {
    return { error: "invalid_payload", ok: false, status: 400 };
  }
  if (new TextEncoder().encode(serialized).length > maxSceneEventPayloadBytes) {
    return { error: "payload_too_large", ok: false, status: 400 };
  }
  return { ok: true, payload: { name, payload: payload as Record<string, unknown> } };
}

export type SceneStateCommand =
  | { ok: true; payload: { scene_id: string; state: Record<string, unknown> } }
  | { ok: false; error: string; status: number };

/** The scene a frame last reported as the one it shows (`last_state` is the
 * device's `states` map plus `active_scene`, in the device's own spelling). */
export function reportedActiveSceneId(lastState: unknown): string | undefined {
  if (!lastState || typeof lastState !== "object" || Array.isArray(lastState)) {
    return undefined;
  }
  const activeScene = (lastState as Record<string, unknown>).active_scene;
  return typeof activeScene === "string" &&
    activeScene.length > 0 &&
    activeScene.length <= maxSceneIdChars
    ? activeScene
    : undefined;
}

/**
 * `setSceneState` — "set public state on the scene the frame is showing, and
 * render" — for a frame whose FrameOS predates `scene_event` (the contract's
 * `before` route; newer frames get the event itself, sceneStateEventCommand).
 * What those frames do have is `set_current_scene {scene_id, state}`, and the
 * full runtime treats one that names the scene ALREADY showing as exactly
 * this: apply `state`, render, no switch (runner.nim, the
 * `elif payload.hasKey("state")` branch). So the event becomes that verb,
 * aimed at the scene the frame last reported.
 *
 * Two limits, both honest refusals rather than a silent no-op:
 * - esp32: the firmware's `set_current_scene` reads `scene_id` only and drops
 *   `state` (fos_cloud.c), so the command would re-render and change nothing.
 * - a frame that has not reported an active scene yet: there is nothing to aim
 *   at, and guessing would switch scenes.
 *
 * What it is not: the scene receives `setCurrentScene`, not `setSceneState`,
 * so an event node listening for `setSceneState` does not run; and if the
 * frame switches scenes between its last report and this command, the command
 * switches it back. Neither is true of `scene_event`.
 */
export function sceneStateCommand(input: {
  lastState: unknown;
  profile: ContractProfile;
  state: Record<string, unknown> | undefined;
}): SceneStateCommand {
  if (input.profile !== "linux") {
    return { error: "unsupported_event", ok: false, status: 404 };
  }
  if (!input.state) {
    return { error: "invalid_state", ok: false, status: 400 };
  }
  const sceneId = reportedActiveSceneId(input.lastState);
  if (!sceneId) {
    return { error: "active_scene_unknown", ok: false, status: 409 };
  }
  return { ok: true, payload: { scene_id: sceneId, state: input.state } };
}

/** `setSceneState` as the event it is, for a frame that knows `scene_event`:
 * the scene applies `state`. `render: true` asks for the render that follows
 * — on that firmware a state change renders anyway; it is spelled out so the
 * command reads as what the person asked for. */
export function sceneStateEventCommand(
  state: Record<string, unknown> | undefined,
): SceneEventCommand {
  if (!state) {
    return { error: "invalid_state", ok: false, status: 400 };
  }
  return sceneEventCommand("setSceneState", { render: true, state });
}

/** `button` — a GPIO button press said by the cloud (the control rail, an
 * automation): the contract's three payload keys pass through, nothing else
 * does. A scene's button listener filters on `label` or `pin`, so a press
 * naming neither could match nothing. */
export function buttonEventCommand(body: Record<string, unknown>): SceneEventCommand {
  const { label, level, pin } = body;
  const validInt = (value: unknown) => Number.isInteger(value) && (value as number) >= 0;
  if (
    (pin !== undefined && !validInt(pin)) ||
    (level !== undefined && !validInt(level)) ||
    (label !== undefined && (typeof label !== "string" || label.length === 0 || label.length > 64)) ||
    (pin === undefined && label === undefined)
  ) {
    return { error: "invalid_payload", ok: false, status: 400 };
  }
  return sceneEventCommand("button", {
    ...(pin !== undefined ? { pin } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(level !== undefined ? { level } : {}),
  });
}
