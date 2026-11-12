// Rendering on the server for a hardware frame (docs/server-rendering.md): an
// ESP32-C3, or a board whose owner set `render_mode` to "remote". The frame
// pulls its picture (GET /api/frames/{id}/embedded/render); this runs the
// scene in the wasm runtime, packs the pixels into the panel's format and
// keeps what a render needs between two pulls on `frame_server_renders`. The
// frame hub calls `prerenderFrame` to draw a sleeping frame's next picture
// before it wakes.
//
// Shared by auth-web (the pull) and the frame hub (the pre-render), so it
// imports nothing from Next.
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, or, sql, gt } from "drizzle-orm";
import { frameCommands, frameServerRenders, frames, linkedClients, type createDb } from "@frameos-cloud/db";
import { revealedServiceSettings } from "./account-settings";
import { linkedClientScopes } from "./backend-auth";
import { cloudRenderedMinIntervalSeconds, frameIsCloudRendered } from "./cloud-rendered";
import { buildServiceSettingsPayload } from "./frame-service-settings";
import {
  buildScenesPayloadForFrame,
  carriedScenePreview,
  frameRenderScale,
  frameServiceSettingsScope,
  frameTelemetryLogsScope,
  readFrameSettings,
  readServiceSettingGroups,
  storeFrameLogs,
} from "./frames";
import { logError, logWarn } from "./log";
import {
  isPanelPixelFormat,
  panelFosb,
  panelPalette,
  sceneCanvasSize,
  type PanelPixelFormatCode,
} from "./panel-pack";
import {
  isRenderErrorLine,
  maxRenderDimension,
  maxRenderPixels,
  minRenderDimension,
  rendererVersion,
  renderScenes,
  SceneRenderError,
  type RelayedDeviceInput,
  type RenderFrameConfig,
  type SceneRenderOptions,
  type SceneRenderResult,
} from "./scene-render";
import { publicSceneState, storableSceneState } from "./virtual-frames";

type Database = ReturnType<typeof createDb>;
type FrameRow = typeof frames.$inferSelect;
type LinkedClientRow = typeof linkedClients.$inferSelect;
type RenderRow = typeof frameServerRenders.$inferSelect;

export type ServerRenderer = (options: SceneRenderOptions) => Promise<SceneRenderResult>;

/** The panel a pull draws for: its native size, its format, the frame's rotation. */
export type ServerRenderPanel = {
  format: PanelPixelFormatCode;
  height: number;
  rotate: 0 | 90 | 180 | 270;
  width: number;
};

/** How far from the time it was drawn for a kept pre-render may still be handed out. */
export const prerenderValidityMs = 120_000;
/** Pre-render lead: twice the last render plus 10 s, between 20 and 90 s. */
export const prerenderMinLeadMs = 20_000;
export const prerenderMaxLeadMs = 90_000;
const maxSceneIdChars = 256;
const maxStoredLogLines = 20;

// The scenes built into every runtime (docs/events-contract.json
// `scenes.switcher`, `scenes.settings`; server-render.test.ts reads the
// contract): in no scene list, yet the scene a render can end on when a key,
// a swipe or a tap opened one (docs/server-rendering.md "Keys, touch and the
// schedule"). The plane keeps one as its active scene while the frame is
// awake, as the device's RAM would.
export const builtInSceneIds: readonly string[] = ["system/sceneSwitcher", "system/sceneSettings"];
// What of a built-in scene's state is kept between two pulls, at most: its
// `from`, its layout, the fields and values of the scene it shows.
const maxBuiltInStateBytes = 32 * 1024;

export function isBuiltInSceneId(id: unknown): id is string {
  return typeof id === "string" && builtInSceneIds.includes(id);
}

// ---------------------------------------------------------------------------
// Relayed input (docs/server-rendering.md "Keys, touch and the schedule")
// ---------------------------------------------------------------------------

/** A pull's body at most: 32 edges and 32 events of a few hundred bytes each. */
export const maxDeviceInputBytes = 16 * 1024;
/** Edges and events kept of one body, each (frameos/relayed_input.nim takes 32). */
export const maxDeviceInputItems = 32;
/** The origins a device relays its own producers' events from; others are not delivered. */
export const relayedEventOrigins: readonly string[] = ["driver", "schedule", "http:write", "http:admin"];
const maxRelayedEventNameChars = 64;
const relayedEdgeLabel = /^[A-Za-z0-9_.-]{1,16}$/;

function isWholeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/**
 * The input a device sent with its pull, as the runtime takes it:
 * `{nowMs, edges?: [{label, action: "down" | "up", atMs, pin?, wake?,
 * claimed?}], events?: [{origin, name, payload}]}`, oldest first. Null for a
 * body of another shape (the route answers 400); an edge or an event that
 * says nothing usable is dropped, one from another origin is not delivered,
 * and past maxDeviceInputItems of each the rest are. The same rules as the
 * backend's `embedded_device_input`.
 */
export function readDeviceInput(body: unknown): RelayedDeviceInput | null {
  if (!isRecord(body) || !isWholeNumber(body.nowMs)) {
    return null;
  }
  if (body.edges !== undefined && !Array.isArray(body.edges)) {
    return null;
  }
  if (body.events !== undefined && !Array.isArray(body.events)) {
    return null;
  }
  const nowMs = body.nowMs;
  const edges: Record<string, unknown>[] = [];
  for (const edge of (body.edges as unknown[] | undefined) ?? []) {
    if (edges.length >= maxDeviceInputItems) {
      break;
    }
    if (!isRecord(edge)) {
      continue;
    }
    const { action, atMs, label } = edge;
    if (typeof label !== "string" || !relayedEdgeLabel.test(label)) {
      continue;
    }
    if ((action !== "down" && action !== "up") || !isWholeNumber(atMs) || atMs < 0 || atMs > nowMs) {
      continue;
    }
    edges.push({
      action,
      atMs,
      label,
      ...(isWholeNumber(edge.pin) ? { pin: edge.pin } : {}),
      ...(edge.wake === true ? { wake: true } : {}),
      ...(edge.claimed === true ? { claimed: true } : {}),
    });
  }
  const events: RelayedDeviceInput["events"] = [];
  for (const event of (body.events as unknown[] | undefined) ?? []) {
    if (events.length >= maxDeviceInputItems) {
      break;
    }
    if (!isRecord(event)) {
      continue;
    }
    const { name, origin } = event;
    if (typeof origin !== "string" || !relayedEventOrigins.includes(origin)) {
      continue;
    }
    if (typeof name !== "string" || name.length === 0 || name.length > maxRelayedEventNameChars) {
      continue;
    }
    if (event.payload !== undefined && !isRecord(event.payload)) {
      continue;
    }
    events.push({ name, origin, payload: isRecord(event.payload) ? event.payload : {} });
  }
  return { edges, events, nowMs };
}

/**
 * frames.last_state as the device would report it (hello `states` plus
 * `active_scene`), from the plane's own memory: what the workspace shows as
 * the frame's scene, and what custom events are routed against
 * (reportedActiveSceneId). Only the frame's scenes: a built-in scene's
 * state is the plane's business, and while one shows the frame's scene is
 * the one it was opened from.
 */
export function planeLastState(
  activeScene: string | null | undefined,
  states: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, state] of Object.entries(states)) {
    if (!isBuiltInSceneId(id) && id !== "active_scene") {
      out[id] = state;
    }
  }
  const from = isBuiltInSceneId(activeScene) ? states[activeScene]?.from : activeScene;
  if (typeof from === "string" && from.length > 0 && !builtInSceneIds.includes(from)) {
    out.active_scene = from.slice(0, maxSceneIdChars);
  }
  return out;
}

async function writePlaneLastState(
  db: Database,
  frameId: string,
  activeScene: string | null | undefined,
  states: Record<string, Record<string, unknown>>,
): Promise<void> {
  await db
    .update(frames)
    .set({ lastState: planeLastState(activeScene, states) })
    .where(eq(frames.id, frameId));
}

/** Whether a pull's input holds anything for the scene. */
export function deviceInputHasAny(input: RelayedDeviceInput | null | undefined): input is RelayedDeviceInput {
  return !!input && (input.edges.length > 0 || input.events.length > 0);
}

let rendererOverride: ServerRenderer | undefined;
/** Test seam: what renders instead of the wasm runtime. */
export function setServerRendererForTests(render: ServerRenderer | undefined) {
  rendererOverride = render;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function statesRecord(value: unknown): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  if (isRecord(value)) {
    for (const [key, state] of Object.entries(value)) {
      if (isRecord(state)) {
        out[key] = state;
      }
    }
  }
  return out;
}

function sceneIdOf(scene: unknown): string {
  return isRecord(scene) && typeof scene.id === "string" ? scene.id : "";
}

function sceneIsLayout(scene: unknown): boolean {
  return isRecord(scene) && isRecord(scene.settings) && scene.settings.isLayout === true;
}

/** `width`, `height`, `format`, `rotate` from the pull's query, or null when they are not a panel. */
export function parseServerRenderPanel(params: URLSearchParams): ServerRenderPanel | null {
  const whole = (name: string): number | null => {
    const raw = params.get(name);
    if (raw === null || !/^\d{1,5}$/.test(raw)) {
      return null;
    }
    return Number(raw);
  };
  const width = whole("width");
  const height = whole("height");
  const format = whole("format");
  if (
    width === null ||
    height === null ||
    width < minRenderDimension ||
    height < minRenderDimension ||
    width > maxRenderDimension ||
    height > maxRenderDimension ||
    width * height > maxRenderPixels ||
    !isPanelPixelFormat(format)
  ) {
    return null;
  }
  const rotateRaw = params.get("rotate");
  const rotate = rotateRaw === null || rotateRaw === "" ? 0 : whole("rotate");
  if (rotate !== 0 && rotate !== 90 && rotate !== 180 && rotate !== 270) {
    return null;
  }
  return { format, height, rotate, width };
}

export function serverRenderPanelKey(panel: ServerRenderPanel): string {
  return `${panel.width}x${panel.height}/${panel.format}/${panel.rotate}`;
}

/** The FOSB's ETag: the first 32 hex digits of its sha256. */
export function serverRenderEtag(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 32);
}

/** Whether an If-None-Match header names `etag` (quoted or not, weak or not, in a list). */
export function ifNoneMatchHas(header: string | null | undefined, etag: string | null | undefined): boolean {
  if (!header || !etag) {
    return false;
  }
  return header
    .split(",")
    .map((part) => part.trim().replace(/^W\//, "").replace(/^"|"$/g, ""))
    .some((part) => part === etag || part === "*");
}

export function prerenderLeadMs(lastRenderMs: number | null | undefined): number {
  const last = typeof lastRenderMs === "number" && lastRenderMs > 0 ? lastRenderMs : 0;
  return Math.min(prerenderMaxLeadMs, Math.max(prerenderMinLeadMs, 2 * last + 10_000));
}

/**
 * "Which scene" (docs/server-rendering.md): a switch the plane sent that the
 * device has not taken yet wins, then the scene the device says it is on,
 * then the plane's own, then the frame's default. Only a scene of the frame
 * that is not a layout counts, and, for the plane's own, a built-in scene
 * (the switcher, the scene settings) a render ended on.
 */
export function chooseServerRenderScene(input: {
  activeScene: string | null | undefined;
  deviceScene: string | null | undefined;
  pendingSwitch: boolean;
  scenes: readonly unknown[];
}): string | undefined {
  const usable = new Set(input.scenes.filter((scene) => !sceneIsLayout(scene)).map(sceneIdOf).filter(Boolean));
  const pick = (id: string | null | undefined) => (id && usable.has(id) ? id : undefined);
  const planes = pick(input.activeScene) ?? (isBuiltInSceneId(input.activeScene) ? input.activeScene : undefined);
  if (input.pendingSwitch && planes) {
    return planes;
  }
  return (
    pick(input.deviceScene) ??
    planes ??
    pick(
      sceneIdOf(input.scenes.find((scene) => isRecord(scene) && scene.default === true && !sceneIsLayout(scene))),
    ) ??
    pick(sceneIdOf(input.scenes.find((scene) => !sceneIsLayout(scene))))
  );
}

/** The scene a pull asks for before the bundle is open: what a kept picture is checked against. */
export function candidateServerRenderScene(input: {
  activeScene: string | null | undefined;
  deviceScene: string | null | undefined;
  pendingSwitch: boolean;
}): string | undefined {
  if (input.pendingSwitch && input.activeScene) {
    return input.activeScene;
  }
  return input.deviceScene || input.activeScene || undefined;
}

/** The last picture may be handed out again: same scene, revision and panel, inside the plan's floor. */
export function lastPictureUsable(
  row: Pick<RenderRow, "picture" | "pictureScene" | "pictureRevision" | "picturePanel" | "renderedAt" | "revision">,
  input: { now: Date; panelKey: string; scene: string | undefined; floorSeconds: number },
): boolean {
  return (
    !!row.picture &&
    !!input.scene &&
    row.pictureScene === input.scene &&
    row.pictureRevision === row.revision &&
    row.picturePanel === input.panelKey &&
    row.renderedAt !== null &&
    input.now.getTime() - row.renderedAt.getTime() < input.floorSeconds * 1000
  );
}

/** A kept pre-render may be taken: same scene, revision and panel, no event waiting, near the time it was drawn for. */
export function prerenderUsable(
  row: Pick<
    RenderRow,
    "pendingEvents" | "prerender" | "prerenderAsOf" | "prerenderPanel" | "prerenderRevision" | "prerenderScene" | "revision"
  >,
  input: { now: Date; panelKey: string; scene: string | undefined },
): boolean {
  return (
    !!row.prerender &&
    !!input.scene &&
    row.prerenderScene === input.scene &&
    row.prerenderRevision === row.revision &&
    row.prerenderPanel === input.panelKey &&
    (!Array.isArray(row.pendingEvents) || row.pendingEvents.length === 0) &&
    row.prerenderAsOf !== null &&
    Math.abs(input.now.getTime() - row.prerenderAsOf.getTime()) <= prerenderValidityMs
  );
}

/** A `set_current_scene` (or a push that names a scene) the device has not taken yet. */
async function hasPendingSceneSwitch(db: Database, frameId: string, now: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: frameCommands.id })
    .from(frameCommands)
    .where(
      and(
        eq(frameCommands.frameId, frameId),
        inArray(frameCommands.status, ["pending", "sent"]),
        or(isNull(frameCommands.expiresAt), gt(frameCommands.expiresAt, now)),
        or(
          eq(frameCommands.type, "set_current_scene"),
          and(eq(frameCommands.type, "set_scenes"), sql`${frameCommands.payload} ? 'scene_id'`),
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
}

async function loadRenderRow(db: Database, frameId: string): Promise<RenderRow> {
  await db.insert(frameServerRenders).values({ frameId }).onConflictDoNothing();
  const [row] = await db.select().from(frameServerRenders).where(eq(frameServerRenders.frameId, frameId)).limit(1);
  if (!row) {
    throw new Error("frame_server_renders row missing");
  }
  return row;
}

// The keys the owner granted this frame's scenes, when the frame may have
// them at all: the same answer the virtual device and the device's own
// service-settings pull get.
async function serviceSettings(db: Database, frame: FrameRow, linkedClient: LinkedClientRow): Promise<Record<string, unknown>> {
  if (!linkedClientScopes(linkedClient).includes(frameServiceSettingsScope)) {
    return {};
  }
  const groups = readServiceSettingGroups(frame.serviceSettingGroups) ?? [];
  if (groups.length === 0) {
    return {};
  }
  if (!process.env.FRAMEOS_CLOUD_ENCRYPTION_KEY) {
    logWarn("server_render.service_settings_unavailable", { frameId: frame.id });
    return {};
  }
  try {
    return buildServiceSettingsPayload(groups, await revealedServiceSettings(db, frame.accountId)).settings;
  } catch (error) {
    logError("server_render.service_settings_failed", { error: String(error), frameId: frame.id });
    return {};
  }
}

/**
 * What the device's runtime is told of its frame besides its scenes
 * (scene-render.ts RenderFrameConfig): the frame's event map (the one the
 * plane set, else the one the device reports running: its board's preset),
 * its palette's colour list and its colours block.
 */
export function renderFrameConfig(frame: Pick<FrameRow, "hardware" | "settings">): RenderFrameConfig {
  const settings = readFrameSettings(frame.settings);
  const hardware = isRecord(frame.hardware) ? frame.hardware : {};
  const eventMap = Array.isArray(settings.event_map)
    ? settings.event_map
    : Array.isArray(hardware.eventMap)
      ? hardware.eventMap
      : undefined;
  const palette = isRecord(settings.palette) && Array.isArray(settings.palette.colors) ? settings.palette.colors : undefined;
  return {
    ...(isRecord(settings.colors) ? { colors: settings.colors } : {}),
    ...(eventMap ? { eventMap } : {}),
    ...(palette ? { palette } : {}),
  };
}

/** The scene's state as the plane keeps it: a scene's storable fields, a built-in scene's state if it is small. */
function keptSceneState(scene: Record<string, unknown> | undefined, sceneId: string, state: unknown): Record<string, unknown> | undefined {
  if (!isRecord(state)) {
    return undefined;
  }
  if (scene) {
    return storableSceneState(scene, state);
  }
  if (isBuiltInSceneId(sceneId)) {
    return JSON.stringify(state).length <= maxBuiltInStateBytes ? state : typeof state.from === "string" ? { from: state.from } : {};
  }
  return undefined;
}

/** The frame's scenes as a render runs them: the assigned set, and the standing preview. */
async function frameScenes(
  db: Database,
  frameId: string,
): Promise<{ checksum: string; scenes: Record<string, unknown>[] } | { error: string }> {
  const built = await buildScenesPayloadForFrame(db, frameId, { runtimeVersion: rendererVersion() });
  if ("error" in built) {
    return built;
  }
  const scenes = built.scenes.filter(isRecord);
  const carried = await carriedScenePreview(db, frameId, scenes);
  if (carried) {
    return { checksum: `${built.checksum}+${sceneIdOf(carried.scene)}`, scenes: [...scenes, carried.scene] };
  }
  return { checksum: built.checksum, scenes };
}

/** The states a render starts from: each scene's kept state, with what verbs sent folded in (public fields only). */
function foldedStates(row: RenderRow, scenes: readonly Record<string, unknown>[]): Record<string, Record<string, unknown>> {
  const ids = new Set(scenes.map(sceneIdOf));
  const states: Record<string, Record<string, unknown>> = {};
  for (const [id, state] of Object.entries(statesRecord(row.states))) {
    if (ids.has(id) || isBuiltInSceneId(id)) {
      states[id] = state;
    }
  }
  for (const [id, state] of Object.entries(statesRecord(row.pendingStates))) {
    const scene = scenes.find((entry) => sceneIdOf(entry) === id);
    if (scene) {
      states[id] = { ...(states[id] ?? {}), ...publicSceneState(scene, state) };
    }
  }
  return states;
}

function heldEvents(row: RenderRow): { name: string; origin: string; payload?: unknown }[] {
  if (!Array.isArray(row.pendingEvents)) {
    return [];
  }
  return row.pendingEvents.flatMap((event) =>
    isRecord(event) && typeof event.name === "string"
      ? [{ name: event.name, origin: typeof event.origin === "string" ? event.origin : "cloud", payload: event.payload ?? {} }]
      : [],
  );
}

type Drawn = {
  body: Buffer;
  etag: string;
  renderMs: number;
  scene: string;
  states: Record<string, Record<string, unknown>>;
};

type DrawFailure = { code: string; message: string; retryAfterSeconds?: number };

/** Run the scene and pack it. Writes nothing. */
async function draw(
  db: Database,
  frame: FrameRow,
  linkedClient: LinkedClientRow,
  row: RenderRow,
  input: {
    deviceInput?: RelayedDeviceInput | undefined;
    deviceScene?: string | undefined;
    nowMs?: number | undefined;
    panel: ServerRenderPanel;
    pendingSwitch: boolean;
    render?: ServerRenderer | undefined;
    withEvents: boolean;
  },
): Promise<{ checksum: string; drawn: Drawn; logs: string[] } | { failure: DrawFailure; logs?: string[] }> {
  const loaded = await frameScenes(db, frame.id);
  if ("error" in loaded) {
    return { failure: { code: loaded.error, message: "The frame's scenes could not be read." } };
  }
  const { checksum, scenes } = loaded;
  const active = chooseServerRenderScene({
    activeScene: row.activeScene,
    deviceScene: input.deviceScene,
    pendingSwitch: input.pendingSwitch,
    scenes,
  });
  const scene = scenes.find((entry) => sceneIdOf(entry) === active);
  if (!active || (!scene && !isBuiltInSceneId(active))) {
    return { failure: { code: "no_scenes", message: "The frame has no scene to render." } };
  }
  const states = foldedStates(row, scenes);
  const canvas = sceneCanvasSize(input.panel.width, input.panel.height, input.panel.rotate);
  const settings = readFrameSettings(frame.settings);
  const render = input.render ?? rendererOverride ?? renderScenes;
  let result: SceneRenderResult;
  try {
    result = await render({
      ...(input.deviceInput ? { deviceInput: input.deviceInput } : {}),
      events: input.withEvents ? heldEvents(row) : [],
      frame: { ...renderFrameConfig(frame), pixelFormat: input.panel.format, rotate: input.panel.rotate },
      height: canvas.height,
      ...(typeof input.nowMs === "number" ? { nowMs: input.nowMs } : {}),
      owner: frame.accountId,
      rawRgba: true,
      renderScale: frameRenderScale(frame),
      sceneId: active,
      scenes,
      settings: await serviceSettings(db, frame, linkedClient),
      states,
      ...(typeof settings.timezone === "string" ? { timeZone: settings.timezone } : {}),
      width: canvas.width,
    });
  } catch (error) {
    if (error instanceof SceneRenderError) {
      return {
        failure: {
          code: error.code,
          message: error.message,
          ...(error.code === "renderer_busy" || error.code === "render_concurrency_limit" ? { retryAfterSeconds: 5 } : {}),
        },
        logs: error.logs,
      };
    }
    return { failure: { code: "render_failed", message: error instanceof Error ? error.message : String(error) } };
  }
  if (!result.rgba || result.width !== canvas.width || result.height !== canvas.height) {
    return {
      failure: { code: "render_failed", message: `The renderer drew ${result.width}x${result.height}, not ${canvas.width}x${canvas.height}.` },
      logs: result.logs,
    };
  }
  const body = panelFosb(
    result.rgba,
    canvas,
    input.panel,
    panelPalette(input.panel.format, { frame: renderFrameConfig(frame).palette, photo: result.palette }),
  );
  // The scene it ended on (a key, a tap or the schedule may have switched
  // it), and what that scene kept, beside the others' (a copy: the renderer
  // was handed `states`).
  const ended =
    result.sceneId && (isBuiltInSceneId(result.sceneId) || scenes.some((entry) => sceneIdOf(entry) === result.sceneId && !sceneIsLayout(entry)))
      ? result.sceneId
      : active;
  const rendered = keptSceneState(
    scenes.find((entry) => sceneIdOf(entry) === ended),
    ended,
    result.state,
  );
  const after = rendered !== undefined ? { ...states, [ended]: rendered } : states;
  return {
    checksum,
    drawn: { body, etag: serverRenderEtag(body), renderMs: result.renderMs, scene: ended, states: after },
    logs: result.logs,
  };
}

// What the scene said while the cloud ran it, on the frame's log like a
// device's own lines, where the owner lets the frame log at all. Small: the
// summary line and the scene's errors.
async function storeRenderLogs(
  db: Database,
  frame: FrameRow,
  linkedClient: LinkedClientRow,
  lines: unknown[],
): Promise<void> {
  if (!linkedClientScopes(linkedClient).includes(frameTelemetryLogsScope) || lines.length === 0) {
    return;
  }
  const timestamp = new Date();
  try {
    await storeFrameLogs(
      db,
      frame.id,
      lines.slice(0, maxStoredLogLines).map((payload) => ({ payload, timestamp })),
      frame.accountId,
    );
  } catch (error) {
    logWarn("server_render.logs_failed", { error: String(error), frameId: frame.id });
  }
}

// What the scene heard of the frame's input and of the events held for it:
// the dispatcher's `event:*` lines (the `gpio` edges, the `button` they made,
// a custom event, what the scene dispatched in turn), as the device's own
// runtime logs them, and as the backend writes them for a thin client. Not
// the runtime's own (`origin: system`, the fresh worker opening its scene).
function isHeardLine(line: string): boolean {
  try {
    const parsed: unknown = JSON.parse(line);
    return (
      isRecord(parsed) &&
      typeof parsed.event === "string" &&
      parsed.event.startsWith("event:") &&
      parsed.origin !== "system"
    );
  } catch {
    return false;
  }
}

function sceneLogPayloads(logs: readonly string[] | undefined, heard = false): unknown[] {
  return (logs ?? [])
    .filter((line) => isRenderErrorLine(line) || (heard && isHeardLine(line)))
    .slice(0, maxStoredLogLines - 1)
    .map((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        if (isRecord(parsed)) {
          return { ...parsed, source: "cloud" };
        }
      } catch {
        // a plain line
      }
      return { event: "log", message: line.slice(0, 2000), source: "cloud" };
    });
}

export type ServerRenderPull =
  | { etag: string; status: 304 }
  | { body: Buffer; etag: string; from: "picture" | "prerender" | "render"; scene: string; status: 200 }
  | { error: string; message: string; retryAfterSeconds?: number; status: 409 | 429 | 502 | 503 };

/**
 * One pull: hand the device its picture, a 304 when it already shows it, or
 * why there is none. The caller has authenticated the device and checked the
 * frame is one the cloud renders for.
 */
export async function pullServerRender(
  db: Database,
  input: {
    /** What the device relayed with this pull (readDeviceInput); a pull with any never takes a kept picture. */
    deviceInput?: RelayedDeviceInput | null | undefined;
    deviceScene?: string | undefined;
    frame: FrameRow;
    ifNoneMatch?: string | null | undefined;
    linkedClient: LinkedClientRow;
    /**
     * Asked before a render that is not a kept picture: false refuses it (the
     * caller's rate limit). `input` when the render is for the device's
     * relayed input, which a frame being used asks for often.
     */
    mayRender?: (reason: "input" | "pull") => Promise<boolean>;
    now?: Date;
    panel: ServerRenderPanel;
    render?: ServerRenderer;
  },
): Promise<ServerRenderPull> {
  const now = input.now ?? new Date();
  const frameId = input.frame.id;
  const deviceScene =
    input.deviceScene && input.deviceScene.length <= maxSceneIdChars ? input.deviceScene : undefined;
  const panelKey = serverRenderPanelKey(input.panel);
  const deviceInput = deviceInputHasAny(input.deviceInput) ? input.deviceInput : undefined;
  const row = await loadRenderRow(db, frameId);
  const pendingSwitch = await hasPendingSceneSwitch(db, frameId, now);
  const candidate = candidateServerRenderScene({ activeScene: row.activeScene, deviceScene, pendingSwitch });

  const answer = (body: Buffer, etag: string, from: "picture" | "prerender" | "render", scene: string): ServerRenderPull =>
    ifNoneMatchHas(input.ifNoneMatch, etag) ? { etag, status: 304 } : { body, etag, from, scene, status: 200 };

  // The last picture again: nothing it depends on moved, and the plan's
  // floor has not passed since it was drawn. Never for a pull with input:
  // the scene has not heard it.
  if (
    !deviceInput &&
    lastPictureUsable(row, { floorSeconds: cloudRenderedMinIntervalSeconds, now, panelKey, scene: candidate }) &&
    row.picture &&
    row.pictureEtag
  ) {
    return answer(row.picture, row.pictureEtag, "picture", row.pictureScene as string);
  }

  // The picture drawn before this wake: taken once, its state committed now.
  // Not for a pull with input: drawn before the input, it never heard it.
  if (!deviceInput && prerenderUsable(row, { now, panelKey, scene: candidate }) && row.prerender && row.prerenderEtag) {
    const taken = await db
      .update(frameServerRenders)
      .set({
        activeScene: row.prerenderScene,
        pendingStates: {},
        picture: row.prerender,
        pictureEtag: row.prerenderEtag,
        picturePanel: row.prerenderPanel,
        pictureRevision: row.revision,
        pictureScene: row.prerenderScene,
        pictureScenesChecksum: row.pictureScenesChecksum,
        prerender: null,
        prerenderAsOf: null,
        prerenderEtag: null,
        prerenderMs: null,
        prerenderPanel: null,
        prerenderRevision: null,
        prerenderScene: null,
        prerenderState: null,
        renderError: null,
        renderMs: row.prerenderMs,
        renderedAt: now,
        ...(isRecord(row.prerenderState) ? { states: row.prerenderState } : {}),
        updatedAt: now,
      })
      .where(and(eq(frameServerRenders.frameId, frameId), eq(frameServerRenders.revision, row.revision)))
      .returning({ frameId: frameServerRenders.frameId });
    if (taken.length > 0) {
      await writePlaneLastState(
        db,
        frameId,
        row.prerenderScene,
        isRecord(row.prerenderState) ? statesRecord(row.prerenderState) : statesRecord(row.states),
      );
      return answer(row.prerender, row.prerenderEtag, "prerender", row.prerenderScene as string);
    }
  }

  if (input.mayRender && !(await input.mayRender(deviceInput ? "input" : "pull"))) {
    return { error: "render_rate_limited", message: "This frame asked for too many renders; try again later.", retryAfterSeconds: 60, status: 429 };
  }

  const startedAt = Date.now();
  const outcome = await draw(db, input.frame, input.linkedClient, row, {
    deviceInput,
    deviceScene,
    panel: input.panel,
    pendingSwitch,
    render: input.render,
    withEvents: true,
  });
  if ("failure" in outcome) {
    const { failure } = outcome;
    await db
      .update(frameServerRenders)
      .set({ renderError: `${failure.code}: ${failure.message}`.slice(0, 512), updatedAt: now })
      .where(eq(frameServerRenders.frameId, frameId));
    await storeRenderLogs(db, input.frame, input.linkedClient, [
      { code: failure.code, error: failure.message, event: "render:error", source: "cloud" },
      ...sceneLogPayloads(outcome.logs, !!deviceInput || heldEvents(row).length > 0),
    ]);
    if (failure.code === "no_scenes") {
      return { error: "no_scenes", message: failure.message, status: 409 };
    }
    if (failure.code === "renderer_unavailable" || failure.code === "renderer_busy" || failure.code === "render_concurrency_limit") {
      return {
        error: failure.code === "renderer_unavailable" ? "renderer_unavailable" : "renderer_busy",
        message: failure.message,
        retryAfterSeconds: failure.retryAfterSeconds ?? 30,
        status: 503,
      };
    }
    return { error: "render_failed", message: failure.message, status: 502 };
  }
  const { checksum, drawn } = outcome;
  const picture = {
    activeScene: drawn.scene,
    picture: drawn.body,
    pictureEtag: drawn.etag,
    picturePanel: panelKey,
    pictureScene: drawn.scene,
    pictureScenesChecksum: checksum,
    renderError: null,
    renderMs: drawn.renderMs,
    renderedAt: now,
    updatedAt: now,
  };
  // Its state, and the events and verb state it used up, only if no verb
  // moved the revision meanwhile: then they are kept for the next render,
  // and this picture is marked as drawn at the old revision. A picture kept
  // for a wake is older than this one (and never heard this pull's input):
  // it goes.
  const committed = await db
    .update(frameServerRenders)
    .set({
      ...picture,
      ...noPrerender,
      pendingEvents: [],
      pendingStates: {},
      pictureRevision: row.revision,
      states: drawn.states,
    })
    .where(and(eq(frameServerRenders.frameId, frameId), eq(frameServerRenders.revision, row.revision)))
    .returning({ frameId: frameServerRenders.frameId });
  if (committed.length === 0) {
    await db
      .update(frameServerRenders)
      .set({ ...picture, ...noPrerender, pictureRevision: row.revision })
      .where(eq(frameServerRenders.frameId, frameId));
  }
  // What the frame shows now, for the workspace and the event routing: the
  // device's own report is stale in remote mode (planeKeepsSceneState). The
  // states as they stand when this render's were not committed.
  await writePlaneLastState(
    db,
    frameId,
    drawn.scene,
    committed.length > 0 ? drawn.states : statesRecord((await loadRenderRow(db, frameId)).states),
  );
  await storeRenderLogs(db, input.frame, input.linkedClient, [
    {
      event: "render:server",
      ms: Date.now() - startedAt,
      renderMs: drawn.renderMs,
      sceneId: drawn.scene,
      source: "cloud",
      ...(deviceInput ? { input: deviceInput.edges.length + deviceInput.events.length } : {}),
    },
    ...sceneLogPayloads(outcome.logs, !!deviceInput || heldEvents(row).length > 0),
  ]);
  return answer(drawn.body, drawn.etag, "render", drawn.scene);
}

// A kept pre-render's columns, emptied.
const noPrerender = {
  prerender: null,
  prerenderAsOf: null,
  prerenderEtag: null,
  prerenderMs: null,
  prerenderPanel: null,
  prerenderRevision: null,
  prerenderScene: null,
  prerenderState: null,
} as const;

/**
 * A frame going to sleep leaves a built-in scene (the switcher, the scene
 * settings) for the scene it was opened from (its state's `from`), as the
 * device's own runtime does, which never keeps one past a sleep
 * (docs/server-rendering.md "Keys, touch and the schedule"). Called before
 * the picture for the wake is drawn. True when it went back.
 */
export async function leaveBuiltInSceneForSleep(db: Database, frameId: string): Promise<boolean> {
  const [row] = await db
    .select({ activeScene: frameServerRenders.activeScene, states: frameServerRenders.states })
    .from(frameServerRenders)
    .where(eq(frameServerRenders.frameId, frameId))
    .limit(1);
  if (!row || !isBuiltInSceneId(row.activeScene)) {
    return false;
  }
  const builtIn = row.activeScene;
  const states = statesRecord(row.states);
  const from = states[builtIn]?.from;
  const { [builtIn]: _left, ...kept } = states;
  const next = typeof from === "string" && from.length > 0 && !builtInSceneIds.includes(from) ? from : null;
  const left = await db
    .update(frameServerRenders)
    .set({ activeScene: next, states: kept, updatedAt: new Date() })
    .where(and(eq(frameServerRenders.frameId, frameId), eq(frameServerRenders.activeScene, builtIn)))
    .returning({ frameId: frameServerRenders.frameId });
  if (left.length > 0) {
    await writePlaneLastState(db, frameId, next, kept);
  }
  return left.length > 0;
}

export type PrerenderOutcome =
  | "kept"
  | "awake"
  | "events_pending"
  | "failed"
  | "missing"
  | "not_server_rendered"
  | "panel_unknown"
  | "revision_moved";

/**
 * Draw a sleeping frame's next picture before it wakes, as of `asOf` (the
 * wake's render time), and keep it for the pull at the wake
 * (docs/server-rendering.md "Deep sleep"). Writes nothing but the kept
 * picture: its state is committed only if the pull takes it.
 */
export async function prerenderFrame(
  db: Database,
  frameId: string,
  input: { asOf: Date; render?: ServerRenderer },
): Promise<PrerenderOutcome> {
  const [loaded] = await db
    .select({ frame: frames, linkedClient: linkedClients })
    .from(frames)
    .innerJoin(linkedClients, eq(linkedClients.id, frames.linkedClientId))
    .where(eq(frames.id, frameId))
    .limit(1);
  if (!loaded || loaded.frame.status !== "active") {
    return "missing";
  }
  if (!frameIsCloudRendered(loaded.frame)) {
    return "not_server_rendered";
  }
  // Up already (a key woke it): its own pull is under way.
  if (loaded.frame.connected) {
    return "awake";
  }
  const row = await loadRenderRow(db, frameId);
  if (heldEvents(row).length > 0) {
    return "events_pending";
  }
  const panel = panelFromKey(row.picturePanel);
  if (!panel) {
    return "panel_unknown";
  }
  const outcome = await draw(db, loaded.frame, loaded.linkedClient, row, {
    nowMs: input.asOf.getTime(),
    panel,
    pendingSwitch: await hasPendingSceneSwitch(db, frameId, new Date()),
    render: input.render,
    withEvents: false,
  });
  if ("failure" in outcome) {
    logWarn("server_render.prerender_failed", { code: outcome.failure.code, frameId });
    return "failed";
  }
  const kept = await db
    .update(frameServerRenders)
    .set({
      prerender: outcome.drawn.body,
      prerenderAsOf: input.asOf,
      prerenderEtag: outcome.drawn.etag,
      prerenderMs: outcome.drawn.renderMs,
      prerenderPanel: row.picturePanel,
      prerenderRevision: row.revision,
      prerenderScene: outcome.drawn.scene,
      prerenderState: outcome.drawn.states,
      updatedAt: new Date(),
    })
    .where(and(eq(frameServerRenders.frameId, frameId), eq(frameServerRenders.revision, row.revision)))
    .returning({ frameId: frameServerRenders.frameId });
  return kept.length > 0 ? "kept" : "revision_moved";
}

function panelFromKey(key: string | null): ServerRenderPanel | null {
  const match = key ? /^(\d+)x(\d+)\/(\d+)\/(\d+)$/.exec(key) : null;
  if (!match) {
    return null;
  }
  const params = new URLSearchParams({ format: match[3]!, height: match[2]!, rotate: match[4]!, width: match[1]! });
  return parseServerRenderPanel(params);
}

/** The last render's time on the plane, for the pre-render's lead. */
export async function lastServerRenderMs(db: Database, frameId: string): Promise<number | null> {
  const [row] = await db
    .select({ renderMs: frameServerRenders.renderMs })
    .from(frameServerRenders)
    .where(eq(frameServerRenders.frameId, frameId))
    .limit(1);
  return row?.renderMs ?? null;
}
