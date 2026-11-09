// The device half of a virtual frame (docs/cloud-frames.md "Virtual frames").
//
// A virtual frame has no hardware: this object is its device. It speaks the
// frame side of the hub protocol — it is handed the same command frames a
// socket would carry and answers with the same acks, `scene_ack`, `state`,
// `log_batch`, `render` and `asset_chunk` messages — so every route, MCP tool
// and workspace panel that works on a frame works on a virtual one without
// knowing. What hardware keeps on its own disk (the pushed scenes, the scene
// showing, scene state) is the virtual_frames row; what hardware draws on a
// panel is rendered here with the wasm runtime and kept as the frame's image.
//
// It renders when it is told to (a push, a scene switch, an event, `render`)
// and, while somebody is looking, on its interval — never under the plan's
// floor (cloud/docs/accounting-todo.md §0.2: renders per day are the cost).
// A picture nobody looks at is not drawn again.
import { createHash } from "node:crypto";
import { eq, getTableColumns, sql } from "drizzle-orm";
import {
  frames,
  linkedClients,
  virtualFrames,
  type createDb,
} from "@frameos-cloud/db";
import { revealedServiceSettings } from "../../auth-web/src/lib/account-settings";
import { linkedClientScopes } from "../../auth-web/src/lib/backend-auth";
import { readBlob } from "../../auth-web/src/lib/blobs";
import {
  cachedAssetFile,
  sceneSnapshotAssetPath,
  sceneSnapshotAssetPrefix,
} from "../../auth-web/src/lib/frame-asset-cache";
import { buildServiceSettingsPayload } from "../../auth-web/src/lib/frame-service-settings";
import {
  frameImageAssetPath,
  frameRenderScale,
  frameServiceSettingsScope,
  frameTelemetryLogsScope,
  readFrameSettings,
  readServiceSettingGroups,
  scheduleDevicePayload,
  storeFrameAssetFile,
  validateFrameSchedule,
} from "../../auth-web/src/lib/frames";
import {
  SceneRenderError,
  type SceneRenderOptions,
  type SceneRenderResult,
} from "../../auth-web/src/lib/scene-render";
import {
  publicSceneState,
  sceneRefreshSeconds,
  storableSceneState,
  virtualFrameSize,
} from "../../auth-web/src/lib/virtual-frames";
import { errorField, logError, logWarn } from "./log";
import { isRecord } from "./protocol";

type Database = ReturnType<typeof createDb>;

export type VirtualRender = (options: SceneRenderOptions) => Promise<SceneRenderResult>;

export interface VirtualDeviceHost {
  db: Database;
  /** Device → hub: one protocol message, handled as a socket's would be. */
  deliver(message: Record<string, unknown>): void;
  frameId: string;
  /** The hub's render queue (two at a time, one per account). */
  render: VirtualRender;
  /** The runtime's version: what this device reports as its FrameOS. */
  rendererVersion(): string | null;
  /**
   * End this session and start the frame's device again, as hardware drops
   * its socket and redials after a restart. The new device draws at once.
   */
  restart(): void;
}

// The device row without its scene bundle (see load), and whether it has one.
const { scenes: _scenes, ...deviceColumnsWithoutScenes } = getTableColumns(virtualFrames);
const deviceColumns = {
  ...deviceColumnsWithoutScenes,
  // CASE, not AND: Postgres may evaluate both sides, and the length of a
  // non-array is an error.
  hasScenes: sql<boolean>`case when jsonb_typeof(${virtualFrames.scenes}) = 'array' then jsonb_array_length(${virtualFrames.scenes}) > 0 else false end`,
};
type DeviceRow = Omit<typeof virtualFrames.$inferSelect, "scenes"> & { hasScenes: boolean };

// Every verb of the wire contract (docs/cloud-frames.md "Provider → frame
// verbs"). One this device does not serve is `unsupported_verb`; anything
// else is `unknown_verb`, as on hardware.
const contractVerbs = new Set([
  "asset_delete",
  "asset_get",
  "asset_mkdir",
  "asset_put",
  "asset_put_chunk",
  "asset_rename",
  "assets_list",
  "get_logs",
  "get_metrics",
  "get_state",
  "image_get",
  "lan_access_challenge",
  "lan_access_set",
  "notify_update_available",
  "reboot",
  "refresh_service_settings",
  "render",
  "restart_runtime",
  "scene_event",
  "scenes_get",
  "set_current_scene",
  "set_display_power",
  "set_scenes",
  "set_schedule",
  "set_settings",
]);

// Hub → frame messages that are not verbs: the session's own traffic, and
// the hub's refusal of something this device sent.
const sessionMessages = new Set(["ack", "challenge", "error", "ready"]);

const maxLogLinesPerRender = 100;
const maxSceneIdChars = 256;
const thumbnailMaxDimension = 320;
// How far back a tick looks for schedule minutes it has not fired yet (a
// slow tick, a busy hub). Older ones are gone, as on a frame that was off.
const maxScheduleCatchUpMinutes = 5;

function sceneId(scene: unknown): string {
  return isRecord(scene) && typeof scene.id === "string" ? scene.id : "";
}

function sceneList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((scene) => sceneId(scene) !== "") : [];
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

/** The local wall clock of `timeZone` at `at`: what a schedule entry matches. */
export function localMinute(at: Date, timeZone: string): { hour: number; minute: number; weekday: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hourCycle: "h23",
      minute: "numeric",
      timeZone,
      weekday: "short",
    }).formatToParts(at);
  } catch {
    return localMinute(at, "UTC");
  }
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return {
    hour: Number(part("hour")) % 24,
    minute: Number(part("minute")),
    // 1-7 = Monday-Sunday, the schedule's own numbering.
    weekday: weekdays.indexOf(part("weekday")) + 1,
  };
}

/** Whether a schedule entry's weekday (0 daily, 1-7 Mon-Sun, 8 weekdays, 9 weekends) covers `weekday`. */
export function scheduleWeekdayMatches(entry: number, weekday: number): boolean {
  if (entry === 0) {
    return true;
  }
  if (entry === 8) {
    return weekday >= 1 && weekday <= 5;
  }
  if (entry === 9) {
    return weekday === 6 || weekday === 7;
  }
  return entry === weekday;
}

export class VirtualDevice {
  private closed = false;
  // Verbs are handled one at a time, in the order they arrived.
  private handling: Promise<void> = Promise.resolve();
  private lastScheduleMinute: number;
  // Events a verb delivered for the scene, waiting for the render that runs
  // them (a render is the only time the scene's code runs).
  private pendingEvents: { name: string; origin: string; payload?: unknown }[] = [];
  // The render loop while one runs (requestRender): what settle() waits for.
  private renderLoop: Promise<void> = Promise.resolve();
  private renderRunning = false;
  private renderWanted = false;
  private scopes: string[] = [];
  // Moved by every verb that writes scene state, so a render that started
  // before one does not write its older reading over it.
  private stateRevision = 0;

  constructor(private readonly host: VirtualDeviceHost, now = Date.now()) {
    this.lastScheduleMinute = Math.floor(now / 60_000);
  }

  private get db() {
    return this.host.db;
  }

  private get frameId() {
    return this.host.frameId;
  }

  // The frame, its link and its device row — without the scene bundle, which
  // is megabytes and wanted only by the verbs that read scene code
  // (loadScenes): a `get_state` or a schedule minute must not drag it along.
  private async load() {
    const [row] = await this.db
      .select({ frame: frames, linkedClient: linkedClients, virtual: deviceColumns })
      .from(virtualFrames)
      .innerJoin(frames, eq(frames.id, virtualFrames.frameId))
      .innerJoin(linkedClients, eq(linkedClients.id, frames.linkedClientId))
      .where(eq(virtualFrames.frameId, this.frameId))
      .limit(1);
    return row;
  }

  private async loadScenes(): Promise<Record<string, unknown>[]> {
    const [row] = await this.db
      .select({ scenes: virtualFrames.scenes })
      .from(virtualFrames)
      .where(eq(virtualFrames.frameId, this.frameId))
      .limit(1);
    return sceneList(row?.scenes);
  }

  /** The session-start message, from what the row holds. */
  async hello(): Promise<Record<string, unknown> | undefined> {
    const loaded = await this.load();
    if (!loaded) {
      return undefined;
    }
    return { type: "hello", ...this.statePayload(loaded.virtual) };
  }

  // No `hardware`, in a hello or a state: the hub writes a device's report
  // onto the frame row, and this frame's size is that row's own, set by its
  // owner. A report read before a size change and sent after it would put
  // the old size back.
  private statePayload(virtual: DeviceRow): Record<string, unknown> {
    const version = this.host.rendererVersion();
    return {
      active_scene: virtual.activeScene ?? "",
      ...(version ? { frameos_version: version } : {}),
      // "" when the row holds no scenes: the hub then pushes the assigned set
      // again, as it does for hardware whose store came up empty.
      scenes_checksum: virtual.hasScenes ? (virtual.scenesChecksum ?? "") : "",
      states: statesRecord(virtual.states),
    };
  }

  /** Hub → device: one text frame, as the socket would carry it. */
  receive(text: string) {
    if (this.closed) {
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!isRecord(message) || typeof message.type !== "string") {
      return;
    }
    const verb = message;
    this.handling = this.handling.then(() =>
      this.handle(verb).catch((error: unknown) => {
        logError("virtual.verb_failed", {
          error: errorField(error),
          frameId: this.frameId,
          type: verb.type,
        });
        this.ack(verb, "internal_error");
      }),
    );
  }

  close() {
    this.closed = true;
  }

  /**
   * Resolves once every verb received so far has been handled and the render
   * running, if any, has finished. After close() nothing new starts, so a hub
   * shutting down awaits this to end with no query of this device's in
   * flight: a late one would run against whatever follows the hub (in the
   * integration suite the next test's TRUNCATE, which it deadlocks).
   */
  async settle() {
    // A verb may start a render; a render never queues a verb.
    await this.handling;
    await this.renderLoop;
  }

  /** The row changed under the device (its size): show it. */
  poke() {
    this.requestRender();
  }

  private send(message: Record<string, unknown>) {
    if (!this.closed) {
      this.host.deliver(message);
    }
  }

  private ack(verb: Record<string, unknown>, error?: string) {
    this.send({
      ...(typeof verb.id === "string" ? { id: verb.id } : {}),
      ...(error ? { error } : {}),
      ok: !error,
      type: "ack",
    });
  }

  private async handle(verb: Record<string, unknown>) {
    const type = verb.type as string;
    if (sessionMessages.has(type)) {
      if (type === "ready" && Array.isArray(verb.scopes)) {
        this.scopes = verb.scopes.filter((scope): scope is string => typeof scope === "string");
      }
      return;
    }
    switch (type) {
      case "set_scenes":
        return await this.setScenes(verb);
      case "set_current_scene":
        return await this.setCurrentScene(verb);
      case "scene_event":
        return await this.sceneEvent(verb);
      case "get_state":
        return await this.getState(verb);
      case "image_get":
        return await this.imageGet(verb);
      case "asset_get":
        return await this.assetGet(verb);
      case "assets_list":
        // No assets directory: the fonts the runtime draws with are its own.
        this.ack(verb);
        this.send({ assets: [], id: verb.id, type: "assets" });
        return;
      case "get_logs":
        // Lines go out as they are written; there is no ring to replay.
        this.ack(verb);
        if (this.scopes.includes(frameTelemetryLogsScope)) {
          this.send({ id: verb.id, logs: [], type: "log_batch" });
        }
        return;
      case "reboot":
      case "restart_runtime":
        // Nothing to power-cycle, but the verbs mean "start over", and what
        // sends them (the telemetry switch, a deploy's bar) waits for a frame
        // that comes back and draws: a new session, then a render.
        this.ack(verb);
        this.host.restart();
        return;
      case "render":
      case "refresh_service_settings":
      case "set_settings":
      case "set_schedule":
        // The settings, the schedule and the service keys are read from the
        // frame's row at every render and every tick: the verb is the nudge.
        this.ack(verb);
        this.requestRender();
        return;
      default:
        this.ack(verb, contractVerbs.has(type) ? "unsupported_verb" : "unknown_verb");
    }
  }

  private async setScenes(verb: Record<string, unknown>) {
    const scenes = verb.scenes;
    if (
      !Array.isArray(scenes) ||
      scenes.length === 0 ||
      scenes.some((scene) => sceneId(scene) === "" || sceneId(scene).length > maxSceneIdChars)
    ) {
      this.ack(verb, "invalid_scenes");
      return;
    }
    const loaded = await this.load();
    if (!loaded) {
      this.ack(verb, "write_failed");
      return;
    }
    const checksum = typeof verb.checksum === "string" ? verb.checksum : "";
    const requested = typeof verb.scene_id === "string" ? verb.scene_id : "";
    const seed = isRecord(verb.state) ? verb.state : undefined;
    // What this device already holds, pushed again with no scene to switch to
    // and no state to seed: nothing to do, as on hardware. The ack and the
    // scene_ack still go out, with the scene it is showing.
    if (
      checksum !== "" &&
      checksum === loaded.virtual.scenesChecksum &&
      requested === "" &&
      !seed &&
      loaded.virtual.hasScenes
    ) {
      this.ack(verb);
      this.send({ active_scene: loaded.virtual.activeScene ?? "", checksum, type: "scene_ack" });
      return;
    }
    const ids = scenes.map(sceneId);
    // The scene the push names, else its first: the device's own rule
    // (expectedActiveSceneId in hub_client.nim).
    const active = requested !== "" && ids.includes(requested) ? requested : (ids[0] as string);
    const states = statesRecord(loaded.virtual.states);
    // State of scenes that are gone goes with them.
    for (const key of Object.keys(states)) {
      if (!ids.includes(key)) {
        delete states[key];
      }
    }
    const scene = scenes.find((entry) => sceneId(entry) === active);
    if (seed) {
      states[active] = { ...(states[active] ?? {}), ...publicSceneState(scene, seed) };
    }
    this.stateRevision += 1;
    await this.db
      .update(virtualFrames)
      .set({
        activeScene: active,
        refreshSeconds: this.refreshSeconds(scene, states[active]),
        scenes,
        scenesChecksum: checksum,
        states,
        updatedAt: new Date(),
      })
      .where(eq(virtualFrames.frameId, this.frameId));
    this.ack(verb);
    this.send({ active_scene: active, checksum, type: "scene_ack" });
    this.requestRender();
  }

  private refreshSeconds(scene: unknown, state: unknown): number | null {
    const seconds = sceneRefreshSeconds(scene, state);
    return seconds === null ? null : Math.max(1, Math.min(Math.round(seconds), 7 * 86_400));
  }

  // Shared by the verb, the schedule and (through setSceneState) events.
  private async switchScene(target: string, state: unknown): Promise<string | undefined> {
    const loaded = await this.load();
    if (!loaded) {
      return "write_failed";
    }
    const scenes = await this.loadScenes();
    const scene = scenes.find((entry) => sceneId(entry) === target);
    if (!scene) {
      return "scene_not_found";
    }
    const states = statesRecord(loaded.virtual.states);
    if (isRecord(state)) {
      states[target] = { ...(states[target] ?? {}), ...publicSceneState(scene, state) };
    }
    this.stateRevision += 1;
    await this.db
      .update(virtualFrames)
      .set({
        activeScene: target,
        refreshSeconds: this.refreshSeconds(scene, states[target]),
        states,
        updatedAt: new Date(),
      })
      .where(eq(virtualFrames.frameId, this.frameId));
    return undefined;
  }

  private async setCurrentScene(verb: Record<string, unknown>) {
    const target = typeof verb.scene_id === "string" ? verb.scene_id : "";
    if (target === "" || target.length > maxSceneIdChars) {
      this.ack(verb, "invalid_scene_id");
      return;
    }
    const error = await this.switchScene(target, verb.state);
    this.ack(verb, error);
    if (!error) {
      this.requestRender();
    }
  }

  private async applySceneState(state: unknown): Promise<void> {
    const loaded = await this.load();
    const active = loaded?.virtual.activeScene;
    if (!loaded || !active) {
      return;
    }
    await this.switchScene(active, state);
  }

  private async sceneEvent(verb: Record<string, unknown>) {
    const name = typeof verb.name === "string" ? verb.name : "";
    if (name === "" || Buffer.byteLength(name, "utf8") > 63) {
      this.ack(verb, "invalid_event");
      return;
    }
    if (verb.payload !== undefined && verb.payload !== null && !isRecord(verb.payload)) {
      this.ack(verb, "invalid_payload");
      return;
    }
    const payload = isRecord(verb.payload) ? verb.payload : {};
    if (name === "setSceneState") {
      // Kept in the row, so the scene has it at this render and every later
      // one. The runtime would apply it and forget it with the process.
      await this.applySceneState(payload.state);
    } else {
      // The runtime decides what the cloud may say to this scene (the event
      // contract's origins, a custom event the scene declares for `cloud`),
      // at the render that delivers it. Bounded: a frame that cannot render
      // must not collect events forever.
      if (this.pendingEvents.length >= 32) {
        this.ack(verb, "queue_full");
        return;
      }
      this.pendingEvents.push({ name, origin: "cloud", payload });
    }
    this.ack(verb);
    this.requestRender();
  }

  private async getState(verb: Record<string, unknown>) {
    const loaded = await this.load();
    this.ack(verb, loaded ? undefined : "read_failed");
    if (loaded) {
      this.send({ id: verb.id, type: "state", ...this.statePayload(loaded.virtual) });
    }
  }

  private sendFile(verb: Record<string, unknown>, content: Buffer, contentType: string) {
    this.ack(verb);
    this.send({
      content_type: contentType,
      data: content.toString("base64"),
      done: true,
      id: verb.id,
      seq: 0,
      size: content.length,
      type: "asset_chunk",
    });
  }

  private async imageGet(verb: Record<string, unknown>) {
    const row = await cachedAssetFile(this.db, this.frameId, frameImageAssetPath, false);
    const content = await readBlob(row);
    if (!row || !content) {
      this.ack(verb, "no_image");
      return;
    }
    this.sendFile(verb, content, row.contentType);
  }

  // The one kind of file this device has: the snapshots of its own renders.
  private async assetGet(verb: Record<string, unknown>) {
    const path = typeof verb.path === "string" ? verb.path : "";
    if (path === "" || path.startsWith("/") || path.split("/").includes("..")) {
      this.ack(verb, "invalid_path");
      return;
    }
    if (!path.startsWith(sceneSnapshotAssetPrefix)) {
      this.ack(verb, "not_found");
      return;
    }
    const row = await cachedAssetFile(this.db, this.frameId, path, verb.thumb === true);
    const content = await readBlob(row);
    if (!row || !content) {
      this.ack(verb, "not_found");
      return;
    }
    this.sendFile(verb, content, row.contentType);
  }

  /** Render as soon as the queue allows; calls while one runs fold into one more. */
  requestRender() {
    if (this.closed) {
      return;
    }
    this.renderWanted = true;
    if (this.renderRunning) {
      return;
    }
    this.renderRunning = true;
    this.renderLoop = (async () => {
      try {
        while (this.renderWanted && !this.closed) {
          this.renderWanted = false;
          try {
            await this.renderOnce();
          } catch (error) {
            logError("virtual.render_failed", { error: errorField(error), frameId: this.frameId });
          }
        }
      } finally {
        this.renderRunning = false;
      }
    })();
  }

  // The keys the owner granted this frame's scenes, when the frame may have
  // them at all (`settings:services`, the owner's switch) and this process
  // can open them. Hardware pulls the same answer over HTTP.
  private async serviceSettings(
    frame: typeof frames.$inferSelect,
    linkedClient: typeof linkedClients.$inferSelect,
  ): Promise<Record<string, unknown>> {
    if (!linkedClientScopes(linkedClient).includes(frameServiceSettingsScope)) {
      return {};
    }
    const groups = readServiceSettingGroups(frame.serviceSettingGroups) ?? [];
    if (groups.length === 0) {
      return {};
    }
    if (!process.env.FRAMEOS_CLOUD_ENCRYPTION_KEY) {
      logWarn("virtual.service_settings_unavailable", {
        frameId: this.frameId,
        hint: "set FRAMEOS_CLOUD_ENCRYPTION_KEY for the frame hub (cloud/docs/deployment.md)",
      });
      return {};
    }
    try {
      return buildServiceSettingsPayload(groups, await revealedServiceSettings(this.db, frame.accountId)).settings;
    } catch (error) {
      // Never the values: which account, and that it failed.
      logError("virtual.service_settings_failed", { error: errorField(error), frameId: this.frameId });
      return {};
    }
  }

  private async renderOnce() {
    const loaded = await this.load();
    if (!loaded || loaded.frame.status !== "active") {
      return;
    }
    const { frame, linkedClient, virtual } = loaded;
    const scenes = virtual.hasScenes ? await this.loadScenes() : [];
    if (scenes.length === 0) {
      return;
    }
    const active = scenes.some((scene) => sceneId(scene) === virtual.activeScene)
      ? (virtual.activeScene as string)
      : sceneId(scenes[0]);
    const scene = scenes.find((entry) => sceneId(entry) === active);
    const revision = this.stateRevision;
    const events = this.pendingEvents.splice(0);
    const size = virtualFrameSize(frame.hardware);
    const settings = readFrameSettings(frame.settings);
    const startedAt = Date.now();
    const lines: unknown[] = [{ event: "render:scene", height: size.height, sceneId: active, width: size.width }];
    let result: SceneRenderResult;
    try {
      result = await this.host.render({
        encodeOffThread: true,
        events,
        height: size.height,
        owner: frame.accountId,
        renderScale: frameRenderScale(frame),
        sceneId: active,
        scenes,
        settings: await this.serviceSettings(frame, linkedClient),
        states: statesRecord(virtual.states),
        thumbnailMaxDimension,
        ...(typeof settings.timezone === "string" ? { timeZone: settings.timezone } : {}),
        width: size.width,
      });
    } catch (error) {
      const code = error instanceof SceneRenderError ? error.code : "render_failed";
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof SceneRenderError) {
        lines.push(...error.logs.map(logLinePayload));
      }
      await this.recordRenderFailure(active, startedAt, code, message, lines);
      return;
    }
    if (this.closed) {
      return;
    }

    const version = createHash("sha256").update(result.png).digest("hex").slice(0, 32);
    try {
      await this.storePicture(active, result);
    } catch (error) {
      // The scene drew and the object store refused the picture. The owner
      // reads that on the row, in words that name no bucket or key; the
      // journal keeps the reason.
      logError("virtual.store_failed", { error: errorField(error), frameId: this.frameId });
      await this.recordRenderFailure(
        active,
        startedAt,
        "store_failed",
        "The picture could not be saved. It will be tried again at the next render.",
        lines,
      );
      return;
    }

    const rendered = isRecord(result.state) ? storableSceneState(scene, result.state) : undefined;
    const keepState = rendered !== undefined && revision === this.stateRevision;
    const now = new Date();
    await this.db
      .update(virtualFrames)
      .set({
        imageVersion: version,
        renderError: null,
        renderMs: result.renderMs,
        renderedAt: now,
        updatedAt: now,
        ...(keepState
          ? {
              refreshSeconds: this.refreshSeconds(scene, rendered),
              states: sql`jsonb_set(coalesce(${virtualFrames.states}, '{}'::jsonb), array[${active}]::text[], ${JSON.stringify(rendered)}::jsonb, true)`,
            }
          : {}),
      })
      .where(eq(virtualFrames.frameId, this.frameId));
    // What the row says now, a verb that ran meanwhile included.
    const after = await this.load();
    if (!after) {
      return;
    }

    lines.push(...result.logs.map(logLinePayload));
    if (!lines.some((line) => isRecord(line) && line.event === "render:done")) {
      lines.push({ event: "render:done", ms: result.renderMs, sceneId: active });
    }
    this.send({ type: "state", ...this.statePayload(after.virtual) });
    this.sendLogs(lines);
    // The image is already the frame's image; the announcement is what ends
    // a deploy's bar and tells an open workspace to look again.
    this.send({ active_scene: active, image: "image_get", type: "render" });
  }

  // A render that left no picture. rendered_at moves on a failure too: the
  // interval paces the retries, or a scene that cannot render would be tried
  // on every tick.
  private async recordRenderFailure(
    active: string,
    startedAt: number,
    code: string,
    message: string,
    lines: unknown[],
  ) {
    await this.db
      .update(virtualFrames)
      .set({
        renderError: `${code}: ${message}`.slice(0, 512),
        renderMs: Date.now() - startedAt,
        renderedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(virtualFrames.frameId, this.frameId));
    lines.push({ code, error: message, event: "render:error", sceneId: active });
    this.sendLogs(lines);
  }

  // The frame's image, and what hardware writes under its assets directory on
  // every render: the scene's snapshot, which the workspace's scene tiles show.
  private async storePicture(active: string, result: SceneRenderResult) {
    await storeFrameAssetFile(this.db, this.frameId, {
      content: result.png,
      contentType: "image/png",
      path: frameImageAssetPath,
      thumb: false,
    });
    const snapshotPath = sceneSnapshotAssetPath(active);
    await storeFrameAssetFile(this.db, this.frameId, {
      content: result.png,
      contentType: "image/png",
      path: snapshotPath,
      thumb: false,
    });
    await storeFrameAssetFile(this.db, this.frameId, {
      content: result.thumbnail ?? result.png,
      contentType: "image/png",
      path: snapshotPath,
      thumb: true,
    });
  }

  private sendLogs(lines: unknown[]) {
    if (!this.scopes.includes(frameTelemetryLogsScope) || lines.length === 0) {
      return;
    }
    const timestamp = new Date().toISOString();
    // The first line and the last ones: where a render started and how it
    // ended say the most.
    const kept =
      lines.length > maxLogLinesPerRender
        ? [...lines.slice(0, 1), ...lines.slice(lines.length - (maxLogLinesPerRender - 1))]
        : lines;
    this.send({ logs: kept.map((payload) => ({ payload, timestamp })), type: "log_batch" });
  }

  /**
   * Fire the schedule's entries for every minute since the last call (the
   * hub's tick). The schedule is the frame row's, as the workspace saved it.
   */
  async runSchedule(now = new Date()) {
    const minute = Math.floor(now.getTime() / 60_000);
    if (minute <= this.lastScheduleMinute || this.closed) {
      return;
    }
    const from = Math.max(this.lastScheduleMinute + 1, minute - maxScheduleCatchUpMinutes + 1);
    this.lastScheduleMinute = minute;
    const loaded = await this.load();
    if (!loaded || loaded.frame.status !== "active" || !loaded.frame.schedule) {
      return;
    }
    const validated = validateFrameSchedule(loaded.frame.schedule);
    if (!validated.schedule) {
      return;
    }
    const events = scheduleDevicePayload(validated.schedule).events;
    const settings = readFrameSettings(loaded.frame.settings);
    const timeZone = typeof settings.timezone === "string" ? settings.timezone : "UTC";
    for (let at = from; at <= minute; at += 1) {
      const local = localMinute(new Date(at * 60_000), timeZone);
      for (const entry of events) {
        if (
          entry.hour === local.hour &&
          entry.minute === local.minute &&
          scheduleWeekdayMatches(entry.weekday, local.weekday)
        ) {
          this.handling = this.handling.then(() =>
            this.fireScheduled(entry.event, entry.payload).catch((error: unknown) => {
              logError("virtual.schedule_failed", { error: errorField(error), frameId: this.frameId });
            }),
          );
        }
      }
    }
  }

  private async fireScheduled(event: string, payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    if (event === "setCurrentScene") {
      const target = typeof body.sceneId === "string" ? body.sceneId : "";
      if (target === "" || (await this.switchScene(target, body.state))) {
        return;
      }
    } else if (event === "setSceneState") {
      await this.applySceneState(body.state);
    } else if (event === "reboot" || event === "restart") {
      // Nothing to restart: every render is a fresh runtime.
      return;
    } else if (event !== "render") {
      this.pendingEvents.push({ name: event, origin: "cloud", payload: body });
    }
    this.sendLogs([{ event: "schedule:fire", name: event }]);
    this.requestRender();
  }
}

// A runtime log line as a frame sends it: structured when it is JSON, the
// text otherwise.
function logLinePayload(line: string): unknown {
  try {
    const parsed: unknown = JSON.parse(line);
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    // plain text
  }
  return line;
}

/**
 * The hub's render queue: `concurrency` renders at a time and one per
 * account, in arrival order otherwise, so one account's frames cannot hold
 * every slot. Each virtual frame has at most one render waiting (its own
 * loop), so the queue is bounded by the number of virtual frames.
 */
export function createVirtualRenderQueue(render: VirtualRender, concurrency = 2): VirtualRender {
  const waiting: { owner: string; start: () => void }[] = [];
  const running = new Set<string>();
  let active = 0;

  function pump() {
    while (active < concurrency) {
      const index = waiting.findIndex((entry) => !running.has(entry.owner));
      if (index === -1) {
        return;
      }
      const [next] = waiting.splice(index, 1);
      next?.start();
    }
  }

  return (options) =>
    new Promise<SceneRenderResult>((resolve, reject) => {
      const owner = options.owner ?? "";
      waiting.push({
        owner,
        start: () => {
          active += 1;
          running.add(owner);
          render(options)
            .then(resolve, reject)
            .finally(() => {
              active -= 1;
              running.delete(owner);
              pump();
            });
        },
      });
      pump();
    });
}
