// Cloud-managed frames: enrollment, command queue, settings allowlist, log
// retention. Wire contract: docs/cloud-frames.md at the repo root; design:
// cloud/docs/cloud-frames.md. Free of Next-request imports so the frame hub
// (apps/frame-hub) can share the pure helpers via direct source import.

import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  createDb,
  frameAssetFiles,
  frameAssets,
  frameCommands,
  frameEnrollmentTokens,
  frameLogs,
  frameMetrics,
  frames,
  frameSceneAssignments,
  linkedClients,
  storeScenes,
  storeSceneVersions,
} from "@frameos-cloud/db";
import { unzipSync } from "fflate";
import { linkedClientScopes } from "./backend-auth";
import {
  deleteBlobIfUnreferenced,
  frameCacheNamespace,
  readBlob,
  storeBlob,
} from "./blobs";
import { deviceDeliverableFields } from "./frame-service-settings";
import { requiredSettingsForScenes } from "./preview-settings";
import { withStoreSceneOrigin } from "./scene-origin";
import { compiledSceneNames } from "./store";
import { maxSceneZipEntries, maxSceneZipUncompressedBytes } from "./store";
import { frameosVersionSatisfies } from "./store-versions";
import {
  allContractSettingKeys,
  contractSettingKeys,
  contractSettingKeysSince,
  contractSettingRule,
  contractSettingSince,
  checkContractSettings,
  validateContractSetting,
  type ContractProfile,
} from "./cloud-frames-contract";
import { fetchTzSlice } from "./tz-slice";
import { logWarn, reportError } from "./log";
// usage.ts only type-imports from this module, so no runtime cycle.
import {
  cullFrameLogsForFrameOverBudget,
  cullFrameLogsOverBudget,
} from "./usage";

type Database = ReturnType<typeof createDb>;

// drizzle hands a transaction callback a PgTransaction, not the database
// object, and the two are structurally different types. Helpers that must
// work both standalone and inside a transaction take this union so callers
// never have to cast.
export type FramesDatabase =
  | Database
  | Parameters<Parameters<Database["transaction"]>[0]>[0];

export const claimTokenPrefix = "FRCT";
// Base scope for a cloud-managed frame; telemetry scopes are opt-in.
export const frameManagedScope = "frame:managed";
export const frameTelemetryLogsScope = "telemetry:logs";
export const frameTelemetryMetricsScope = "telemetry:metrics";
// Lets the frame PULL the account's service API keys (Unsplash, OpenAI, Home
// Assistant, …) from GET /api/frames/{id}/service-settings. Never a push: see
// enqueueServiceSettingsRefresh below for why the keys stay off the queue.
export const frameServiceSettingsScope = "settings:services";

// Deployment-tunable limits. A self-hoster with 60 frames, or a developer
// re-opening "Add frame" all afternoon, should not have to patch the source.
// Read once at module load: they are used as plain values throughout, and a
// limit that changes mid-process would be worse than one that needs a restart.
function limitFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    // Don't fail the boot over a typo'd limit, but don't silently run with a
    // nonsense one either.
    logWarn("frames.invalid_limit_env", {
      fallback,
      name,
      value: raw,
    });
    return fallback;
  }
  return parsed;
}

// The frame quota is part of the free tier, so it is defined with the rest of
// it in usage.ts and re-exported here for the many callers that already import
// it from this module.
export { maxFramesPerAccount } from "./usage";
// Outstanding unused claim codes. This bounds how many enrollment secrets can
// be live at once; it is not a product limit, so when an account reaches it we
// evict its oldest unused single-use code rather than refuse (see
// makeRoomForClaimToken) — the bound holds either way.
export const maxClaimTokensPerAccount = limitFromEnv(
  "FRAMEOS_CLOUD_MAX_CLAIM_TOKENS_PER_ACCOUNT",
  50,
);
export const claimTokenTtlMs =
  limitFromEnv("FRAMEOS_CLOUD_CLAIM_TOKEN_TTL_HOURS", 24) * 60 * 60 * 1000;
// A frame-bound (re-enrollment) token is redeemed within one flashing
// session, minutes after it is minted, and it is far more powerful than an
// ordinary claim code: redeeming it hands a device the identity of an
// existing frame, with its scenes, assets and logs. Hence one hour, not a
// day, and single-use always.
export const boundClaimTokenTtlMs = 60 * 60 * 1000;
// Hard per-frame log retention cap. Retained bytes count toward the
// account's storage usage; db-cleanup.sh prunes by age as well.
export const maxLogsPerFrame = 5000;
export const maxLogBatch = 200;
export const maxLogLineBytes = 8 * 1024;

// Cap on the assembled set_scenes payload. The hub ships it to the device in
// ONE WebSocket frame and the device (a Pi Zero, sometimes an ESP32) caps its
// inbound message size at 4 MiB — stay comfortably below that so the JSON
// envelope, checksum and framing overhead still fit. Assignment fails with
// scenes_payload_too_large rather than queueing a push the device will drop.
export const maxScenesPayloadBytes = 3 * 1024 * 1024;

// The declarative settings a set_settings push may carry, and their value
// rules, come from the verb contract (docs/cloud-frames-contract.json →
// cloud-frames-contract.gen.ts, walked by cloud-frames-contract.ts). The
// Linux runtime and the ESP32 firmware validate against the same document
// and docs/cloud-frames-fixtures.json pins all three to one verdict — the
// device refuses the WHOLE verb when it sees a key it does not know, so a
// list declared three times was a push silently dropped waiting to happen.
//
// A Map, not a plain object: `allowedFrameSettings["toString"]` on an object
// resolves through Object.prototype to a truthy, callable function that
// returns a truthy string, so a prototype key would pass validation — and
// "__proto__" / "valueOf" would throw a TypeError instead.
//
// Each check is "acceptable on SOME profile"; the settings route applies the
// exact profile once it knows the device (checkContractSettings). Companion
// keys (the ESP32's tzdata slice) are not here: the cloud attaches them
// itself in frameSettingsDevicePayload, a client never sends them.
export const allowedFrameSettings = new Map<
  string,
  (value: unknown) => boolean
>(allContractSettingKeys().map((key) => [key, (value) => validateContractSetting(key, value)]));

function ruleBound(key: string, profile: ContractProfile, bound: "min" | "max"): number {
  const value = contractSettingRule(key, profile)?.[bound];
  if (value === undefined) throw new Error(`contract: ${key} has no ${bound} on ${profile}`);
  return value;
}

// Bounds shared with the device (the contract's max_http_response_bytes rule):
// the ceiling is the runtime's own default (64 MiB), so a push can lower a Pi
// Zero's per-request memory bound but never raise it.
export const minMaxHttpResponseBytes = ruleBound("max_http_response_bytes", "linux", "min");
export const maxMaxHttpResponseBytes = ruleBound("max_http_response_bytes", "linux", "max");

// The batches the Linux runtime learned keys in, by firmware floor (the
// contract's `since`). Every one of them must ALSO be in allowedFrameSettings
// (it is — same table); the settings route refuses them for frames whose
// reported firmware predates the batch (and for esp32 frames, whose firmware
// has no consumer for any of them).
export const extendedFrameSettingsMinVersion = "2026.8.30";
export const extendedFrameSettingKeys = new Set(contractSettingKeysSince("linux", extendedFrameSettingsMinVersion));

/**
 * Does a frame reporting `frameosVersion` understand the extended settings
 * batch? Three answers, mirrored by the SPA's cloudFrameSupportsExtendedSettings
 * (frontend/src/utils/cloudFrameSettings.ts) — the two must agree or the SPA
 * offers fields the route refuses:
 *  - a parseable version compares against extendedFrameSettingsMinVersion;
 *  - a non-empty but unparseable one ("unknown", a dev build) is trusted —
 *    dev builds carry the newest code, and refusing them would make the
 *    batch untestable against a locally built frame;
 *  - null/empty (the frame never reported one, i.e. never connected) is NOT:
 *    nothing is known about the firmware, and a push that sits queued until
 *    a first connect that then refuses it helps nobody.
 */
export function frameSupportsExtendedSettings(
  frameosVersion: string | null | undefined,
): boolean {
  return frameSupportsSettingsFrom(extendedFrameSettingsMinVersion, frameosVersion);
}

// The 2026.8.31 hardware batch: keys the display driver reads at init.
export const hardwareFrameSettingsMinVersion = "2026.8.31";
export const hardwareFrameSettingKeys = new Set(contractSettingKeysSince("linux", hardwareFrameSettingsMinVersion));

export function frameSupportsHardwareSettings(
  frameosVersion: string | null | undefined,
): boolean {
  return frameSupportsSettingsFrom(hardwareFrameSettingsMinVersion, frameosVersion);
}

/**
 * Whether the frame's enrollment hardware report says esp32 (any variant —
 * "esp32-s3" etc). The chip's firmware speaks a narrower set_settings
 * profile than the Pi runtime, so both the settings route and the rename
 * route branch on this.
 */
export function frameHardwareIsEsp32(frame: {
  hardware: unknown;
}): boolean {
  const platform = (frame.hardware as { platform?: unknown } | null)
    ?.platform;
  return (
    typeof platform === "string" && platform.toLowerCase().startsWith("esp32")
  );
}

/** The contract profile a frame validates against. */
export function frameContractProfile(frame: { hardware: unknown }): ContractProfile {
  return frameHardwareIsEsp32(frame) ? "esp32" : "linux";
}

/** The three-way answer above, for any floor. */
export function frameSupportsSettingsFrom(
  minVersion: string,
  frameosVersion: string | null | undefined,
): boolean {
  if (typeof frameosVersion !== "string" || frameosVersion.trim().length === 0) {
    return false;
  }
  return frameosVersionSatisfies(minVersion, frameosVersion);
}

/**
 * Why a device of `frame`'s profile and firmware would refuse `settings`,
 * before anything is queued: a key its profile does not take
 * (settings_not_supported_by_device), a key its firmware is too old for
 * (settings_need_newer_firmware, with the lowest floor that would do), or a
 * value outside the profile's rules (invalid_settings — e.g. nine GPIO
 * buttons for a chip whose table holds eight). null when the push would be
 * accepted. Every answer is the contract's, so this and the device agree.
 */
export function frameSettingsRefusal(
  frame: { frameosVersion: string | null | undefined; hardware: unknown },
  settings: Record<string, unknown>,
): { error: string; minFrameosVersion?: string } | null {
  const profile = frameContractProfile(frame);
  const keys = Object.keys(settings);
  if (keys.some((key) => contractSettingSince(key, profile) === undefined)) {
    return { error: "settings_not_supported_by_device" };
  }
  const floors = keys
    .map((key) => contractSettingSince(key, profile))
    .filter((since): since is string => typeof since === "string" && !frameSupportsSettingsFrom(since, frame.frameosVersion))
    .sort((a, b) => (frameosVersionSatisfies(a, b) ? 1 : -1));
  const lowestFloor = floors[0];
  if (lowestFloor !== undefined) {
    return { error: "settings_need_newer_firmware", minFrameosVersion: lowestFloor };
  }
  if (checkContractSettings(settings, profile) !== null) {
    return { error: "invalid_settings" };
  }
  return null;
}

// Palette / partial-refresh / GPIO bounds, from the contract's rules.
function ruleNumber(value: number | undefined, what: string): number {
  if (value === undefined) throw new Error(`contract: ${what} is not in the table`);
  return value;
}
export const maxPaletteColors = ruleNumber(
  contractSettingRule("palette", "linux")?.keys?.colors?.maxItems, "palette.colors.maxItems");
export const maxPartialRefreshesBeforeFull = ruleNumber(
  contractSettingRule("device_config", "linux")?.keys?.partialMaxRefreshesBeforeFull?.max,
  "device_config.partialMaxRefreshesBeforeFull.max");
export const maxGpioButtons = ruleNumber(contractSettingRule("gpio_buttons", "linux")?.maxItems, "gpio_buttons.maxItems");
export const maxGpioButtonPin = ruleNumber(
  contractSettingRule("gpio_buttons", "linux")?.items?.keys?.pin?.max, "gpio_buttons.items.pin.max");

export const allowedFrameCommandTypes = new Set([
  "get_metrics",
  // Advisory only: the device fetches the manifest and verifies the image
  // signature itself (docs/cloud-frames.md "Signed OTA") — the queue can
  // only suggest, never install.
  "notify_update_available",
  "reboot",
  // Zero-payload nudge: "your service settings changed, re-pull them".
  // Carries no keys — see enqueueServiceSettingsRefresh.
  "refresh_service_settings",
  "render",
  "restart_runtime",
  "set_current_scene",
  "set_schedule",
]);

export function validateFrameSettings(
  value: unknown,
  profile?: ContractProfile,
): { settings?: Record<string, unknown>; error?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "invalid_settings" };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return { error: "invalid_settings" };
  }
  if (profile) {
    // The device's exact verdict (the same one it would ack).
    const error = checkContractSettings(Object.fromEntries(entries), profile);
    return error ? { error } : { settings: Object.fromEntries(entries) };
  }
  for (const [key, entryValue] of entries) {
    const check = allowedFrameSettings.get(key);
    // One disallowed key refuses the whole payload — a partial apply would
    // make the device and the control plane disagree about what was set.
    if (!check || !check(entryValue)) {
      return { error: "setting_not_allowed" };
    }
  }
  return { settings: Object.fromEntries(entries) };
}

// The ESP32 firmware's profile of set_settings, from the contract: the keys
// that map onto its NVS config and no other. Everything else has no
// on-device consumer, so the firmware refuses the WHOLE verb on them and the
// route refuses them up front instead of half-applying a push. The keys only
// the chip knows (the power management block) are refused up front for
// non-esp32 frames for the same reason.
export const esp32SettableKeys = new Set(contractSettingKeys("esp32"));
export const esp32OnlySettableKeys = new Set(
  contractSettingKeys("esp32").filter((key) => contractSettingSince(key, "linux") === undefined),
);

// The floors at which the firmware learned keys (the contract's `since`);
// older firmware refuses the whole verb on them, so the route gates each on
// the reported version, like the Linux batches.
export const esp32ExtendedFrameSettingsMinVersion = "2026.8.31";
export const esp32ExtendedFrameSettingKeys = new Set(contractSettingKeysSince("esp32", esp32ExtendedFrameSettingsMinVersion));
export const esp32MaxGpioButtons = ruleNumber(contractSettingRule("gpio_buttons", "esp32")?.maxItems, "gpio_buttons.maxItems (esp32)");

export const esp32TimeZoneFrameSettingsMinVersion = "2026.8.34";
export const esp32TimeZoneFrameSettingKeys = new Set(contractSettingKeysSince("esp32", esp32TimeZoneFrameSettingsMinVersion));

export const esp32BatteryEnablePinFrameSettingsMinVersion = "2026.8.39";
export const esp32BatteryEnablePinFrameSettingKeys = new Set(
  contractSettingKeysSince("esp32", esp32BatteryEnablePinFrameSettingsMinVersion),
);

// An IANA zone name as the device console and fos_tz accept it
// ("Europe/Brussels", "UTC", "America/Argentina/Buenos_Aires"); the tzdata
// slice lookup is what rejects unknown-but-well-formed names later.
export function isValidTimeZoneName(value: unknown): value is string {
  return validateContractSetting("timezone", value);
}

/**
 * Can this frame be sent the `timezone` setting? Every Pi/Linux runtime
 * takes it (base six); an ESP32 only from 2026.8.34 (fos_tz.c), and one
 * that never reported a version is refused like the other gated tails —
 * firmware below the floor refuses the WHOLE set_settings push on it.
 */
export function frameSupportsTimeZoneSetting(frame: {
  frameosVersion: string | null | undefined;
  hardware: unknown;
}): boolean {
  return (
    !frameHardwareIsEsp32(frame) ||
    frameSupportsSettingsFrom(
      esp32TimeZoneFrameSettingsMinVersion,
      frame.frameosVersion,
    )
  );
}

/**
 * The set_settings payload the device receives for a validated push. An
 * ESP32 has no tz database, so its zone rides with the tzdata slice
 * (`timezone_data`, fos_tz.h) — command payload only, never mirrored into
 * frames.settings. A slice lookup that fails just omits the key; the device
 * then fetches the slice itself, at the cost of one round trip.
 */
export async function frameSettingsDevicePayload(
  frame: { hardware: unknown },
  settings: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (
    frameHardwareIsEsp32(frame) &&
    typeof settings.timezone === "string" &&
    settings.timezone.trim()
  ) {
    const slice = await fetchTzSlice(settings.timezone);
    if (slice) {
      return { ...settings, timezone_data: slice };
    }
  }
  return settings;
}

/**
 * Queue a validated settings push toward the device, superseding any
 * undelivered one (a newer set_settings makes the older pointless). The one
 * path for PATCH /api/frames/{id}/settings and the enrollment time-zone
 * seed, so both build the same device payload. Callers gate the keys on the
 * frame's firmware first (frameSupportsTimeZoneSetting and friends).
 */
export async function enqueueFrameSettingsPush(
  db: Database,
  frame: { hardware: unknown; id: string },
  settings: Record<string, unknown>,
  options: { createdByAccountId?: string } = {},
) {
  const payload = await frameSettingsDevicePayload(frame, settings);
  await supersedePendingCommands(db, frame.id, "set_settings");
  return enqueueFrameCommand(db, {
    ...(options.createdByAccountId
      ? { createdByAccountId: options.createdByAccountId }
      : {}),
    frameId: frame.id,
    payload: { settings: payload },
    type: "set_settings",
  });
}

// The settings frames.settings mirrors, in the device's spelling. `name` is
// excluded on purpose: frames.name is the authoritative display name, and a
// second copy here could disagree with it.
function persistableSettings(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(settings).filter(([key]) => key !== "name"),
  );
}

// Merge a validated push onto whatever was stored before, so a push carrying
// only `interval` does not blank out a previously pushed `rotate`. Returns
// undefined when the push has nothing to mirror (a name-only rename).
export function mergeFrameSettings(
  stored: unknown,
  pushed: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const incoming = persistableSettings(pushed);
  if (Object.keys(incoming).length === 0) {
    return undefined;
  }
  return { ...readFrameSettings(stored), ...incoming };
}

// Read the stored jsonb back through the allowlist. It is written through
// validateFrameSettings, but it is still jsonb from a previous release's
// (or a future release's) allowlist — screening it here keeps a retired key
// from reappearing in the summary and, from there, in the next push.
export function readFrameSettings(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const stored = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, check] of allowedFrameSettings) {
    if (key === "name") continue;
    if (Object.hasOwn(stored, key) && check(stored[key])) {
      out[key] = stored[key];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scene schedule (docs/cloud-frames.md `set_schedule`)
// ---------------------------------------------------------------------------

// Caps sized to the smallest schedule engine in the fleet — the ESP32's
// (embedded/esp32/main/fos_schedule.c): SCHEDULE_MAX_EVENTS 64 and
// SCHEDULE_MAX_BYTES 32 KiB, enforced here so a push the device would refuse
// (or silently truncate) is refused up front instead. The per-event payload
// cap is server-side prudence for a jsonb column the SPA replays; note the
// ESP32 additionally drops any single event whose payload serializes past
// its own 512-byte SCHEDULE_PAYLOAD_LEN.
export const maxScheduleEvents = 64;
export const maxScheduleEventPayloadBytes = 4 * 1024;
export const maxScheduleBytes = 32 * 1024;
// UTC offsets of real zones span -12:00 (Etc/GMT+12) to +14:00 (Kiritimati).
export const minScheduleUtcOffsetMinutes = -12 * 60;
export const maxScheduleUtcOffsetMinutes = 14 * 60;

export interface FrameScheduleEvent {
  id: string;
  minute: number;
  hour: number;
  weekday: number;
  event: string;
  payload: Record<string, unknown>;
  disabled?: boolean;
}

export interface FrameSchedule {
  events: FrameScheduleEvent[];
  disabled?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Validate and rebuild a schedule from the SPA's Schedule panel. Sanitize by
// reconstruction (the parseAssetEntries doctrine — this jsonb is persisted
// and replayed to every browser and to devices), but refuse the WHOLE
// schedule on any invalid event: an edit that silently dropped events is
// exactly the bug this write path exists to fix. Shape per
// embedded/esp32/main/fos_schedule.h and the Pi's config.nim loadSchedule:
// {events: [{id, minute 0-59, hour 0-23, weekday 0-9, event, payload,
// disabled?}], disabled?}.
export function validateFrameSchedule(
  value: unknown,
): { schedule?: FrameSchedule; error?: string } {
  if (!isPlainObject(value) || !Array.isArray(value.events)) {
    return { error: "invalid_schedule" };
  }
  if (value.events.length > maxScheduleEvents) {
    return { error: "schedule_too_large" };
  }
  const events: FrameScheduleEvent[] = [];
  for (const item of value.events) {
    if (!isPlainObject(item)) {
      return { error: "invalid_schedule" };
    }
    const { id, minute, hour, weekday, event, payload, disabled } = item;
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > 64 ||
      !Number.isInteger(minute) ||
      (minute as number) < 0 ||
      (minute as number) > 59 ||
      !Number.isInteger(hour) ||
      (hour as number) < 0 ||
      (hour as number) > 23 ||
      // 0 daily, 1-7 mon-sun, 8 weekdays, 9 weekends; absent = daily.
      (weekday !== undefined &&
        weekday !== null &&
        (!Number.isInteger(weekday) ||
          (weekday as number) < 0 ||
          (weekday as number) > 9)) ||
      typeof event !== "string" ||
      event.length === 0 ||
      // The ESP32 stores the name in a 64-byte buffer, NUL included.
      event.length > 63 ||
      (payload !== undefined && !isPlainObject(payload)) ||
      (disabled !== undefined && typeof disabled !== "boolean")
    ) {
      return { error: "invalid_schedule" };
    }
    const eventPayload = isPlainObject(payload) ? payload : {};
    if (
      Buffer.byteLength(JSON.stringify(eventPayload), "utf8") >
      maxScheduleEventPayloadBytes
    ) {
      return { error: "schedule_too_large" };
    }
    events.push({
      // weekday/payload always materialized: the Pi runtime parses frame.json
      // into a concrete object and the ESP32 defaults absent fields the same
      // way — explicit beats relying on two parsers' defaults agreeing.
      event,
      hour: hour as number,
      id,
      minute: minute as number,
      payload: eventPayload,
      weekday: (weekday ?? 0) as number,
      ...(disabled === true ? { disabled: true } : {}),
    });
  }
  const schedule: FrameSchedule = {
    events,
    ...(value.disabled === true ? { disabled: true } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(schedule), "utf8") > maxScheduleBytes) {
    return { error: "schedule_too_large" };
  }
  return { schedule };
}

// The schedule object a set_schedule push carries. Devices fire every event
// they are given — the backend's embedded_device.py strips disabled events
// before serving frame.json for exactly this reason — so the disabled flags
// are resolved here and never reach the wire. A fully disabled schedule
// ships as zero events, NOT as null: the Pi's set_schedule handler
// (hub_client.nim handleSetSchedule) refuses a non-object schedule.
export function scheduleDevicePayload(schedule: FrameSchedule): {
  events: Omit<FrameScheduleEvent, "disabled">[];
} {
  if (schedule.disabled) {
    return { events: [] };
  }
  return {
    events: schedule.events
      .filter((event) => !event.disabled)
      .map(({ disabled: _disabled, ...event }) => event),
  };
}

export function isValidEd25519PublicKey(publicKeyBase64: unknown): boolean {
  if (typeof publicKeyBase64 !== "string") {
    return false;
  }
  try {
    const raw = Buffer.from(publicKeyBase64, "base64");
    if (raw.length !== 32) {
      return false;
    }
    ed25519KeyFromRaw(raw);
    return true;
  } catch {
    return false;
  }
}

// RFC 8410 SubjectPublicKeyInfo wrapper for a raw Ed25519 public key, so
// node:crypto can consume the 32 raw bytes the device sends.
function ed25519KeyFromRaw(raw: Buffer) {
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  return createPublicKey({
    format: "der",
    key: Buffer.concat([prefix, raw]),
    type: "spki",
  });
}

export function verifyFrameSignature(
  publicKeyBase64: string,
  message: Buffer,
  signatureBase64: string,
): boolean {
  try {
    const raw = Buffer.from(publicKeyBase64, "base64");
    const signature = Buffer.from(signatureBase64, "base64");
    if (raw.length !== 32 || signature.length !== 64) {
      return false;
    }
    return cryptoVerify(null, message, ed25519KeyFromRaw(raw), signature);
  } catch {
    return false;
  }
}

export function frameSummary(
  frame: typeof frames.$inferSelect,
  // The frame's linked client, when the caller already holds it. Its scope
  // list is the ONLY record of "does this frame receive the account's service
  // keys" — the owner's per-frame switch grants or revokes
  // `settings:services` on the link itself (see the enabled route) — so
  // `service_settings_enabled` is OMITTED, not false, when the caller cannot
  // answer. The SPA merges update_frame events over the row it already has,
  // so an omitted field keeps its last known value instead of flickering off.
  linkedClient?: { providerClientMetadata: unknown },
) {
  return {
    // The last-pushed settings round-trip as TOP-LEVEL fields in the
    // device's own spelling (interval, rotate, …) because that is how the
    // shared SPA's frameForm reads them — see cloudFrameSettingKeys in
    // frontend/src/utils/cloudFrameSettings.ts. Without this the Settings
    // panel rendered blanks after every reload. Spread first so the
    // provider-owned fields below always win, `name` above all.
    ...readFrameSettings(frame.settings),
    assigned_checksum: frame.assignedChecksum,
    // Per-scene deploy ledger ({storeSceneId: {version, checksum}}): what
    // the last assignment push contained vs what the device has acked. NULL
    // on frames that predate the columns — the SPA then falls back to the
    // all-or-nothing checksum comparison.
    assigned_scene_state: frame.assignedSceneState,
    connected: frame.connected,
    created_at: frame.createdAt,
    frameos_version: frame.frameosVersion,
    hardware: frame.hardware,
    id: frame.id,
    deployed_scene_state: frame.deployedSceneState,
    last_seen_at: frame.lastSeenAt,
    // The device's deep-sleep forecast (hub handleSleep): when it redials
    // next, when the panel refreshes next, and why it sleeps. null while
    // connected and on firmware without the `sleep` message — the SPA then
    // estimates from the power settings above.
    next_wake_at: frame.nextWakeAt,
    next_render_at: frame.nextRenderAt,
    sleep_reason: frame.sleepReason,
    linked_client_id: frame.linkedClientId,
    name: frame.name,
    scenes_checksum: frame.scenesChecksum,
    schedule: frame.schedule,
    // Which service-settings groups the owner has GRANTED to this frame's
    // assigned scenes (the union over the frame's assignments; what the
    // device pull ships) — group NAMES only, never a field or a value. `[]`
    // covers both "nothing granted" and the NULL column of a frame assigned
    // scenes before the column existed; the device pull backfills that on
    // its next poll. What each scene DECLARES is per assignment, on
    // GET /api/frames/{id}/scenes.
    service_setting_groups: readServiceSettingGroups(frame.serviceSettingGroups) ?? [],
    ...(linkedClient
      ? {
          service_settings_enabled: linkedClientScopes(linkedClient).includes(
            frameServiceSettingsScope,
          ),
          // Same contract: the owner's per-frame telemetry switch
          // (telemetry/enabled route). Pre-2026-08-03 enrollments report
          // false here — that is the empty-Logs-panel case, now named.
          telemetry_enabled: linkedClientScopes(linkedClient).includes(
            frameTelemetryLogsScope,
          ),
        }
      : {}),
    status: frame.status,
  };
}

// Frame ids arrive as raw URL path segments. Postgres throws "invalid input
// syntax for type uuid" on anything else, which surfaces as a 500 — screen
// the shape first (same check loadOwnedScene uses for scene ids) so every
// caller's existing "no such frame" branch returns a clean 404 instead.
const frameIdPattern = /^[0-9a-f-]{36}$/i;

export function isFrameId(value: unknown): value is string {
  return typeof value === "string" && frameIdPattern.test(value);
}

export async function frameForAccount(
  db: ReturnType<typeof createDb>,
  accountId: string,
  frameId: string,
) {
  if (!isFrameId(frameId)) {
    return undefined;
  }
  const [frame] = await db
    .select()
    .from(frames)
    .where(and(eq(frames.id, frameId), eq(frames.accountId, accountId)))
    .limit(1);
  return frame;
}

// The link behind a frame, for callers that need its scopes (frameSummary's
// `service_settings_enabled`). Undefined if the row is gone.
export async function linkedClientForFrame(
  db: ReturnType<typeof createDb>,
  frame: { linkedClientId: string },
) {
  const [linkedClient] = await db
    .select()
    .from(linkedClients)
    .where(eq(linkedClients.id, frame.linkedClientId))
    .limit(1);
  return linkedClient;
}

export async function frameForLinkedClient(
  db: ReturnType<typeof createDb>,
  linkedClientId: string,
) {
  const [frame] = await db
    .select()
    .from(frames)
    .where(eq(frames.linkedClientId, linkedClientId))
    .limit(1);
  return frame;
}

// Postgres NOTIFY channel the hub listens on; payload is the frame id. The
// queue itself is durable (frame_commands) — the notify is only a wake-up.
export const frameCommandsNotifyChannel = "frameos_frame_commands";

export async function enqueueFrameCommand(
  db: ReturnType<typeof createDb>,
  input: {
    frameId: string;
    type: string;
    payload?: unknown;
    createdByAccountId?: string;
    // Commands that only make sense "now" (render, reboot) expire quickly;
    // state-carrying commands (set_scenes) wait for the next connect.
    ttlMs?: number;
  },
) {
  const [command] = await db
    .insert(frameCommands)
    .values({
      createdByAccountId: input.createdByAccountId ?? null,
      expiresAt: input.ttlMs ? new Date(Date.now() + input.ttlMs) : null,
      frameId: input.frameId,
      payload: input.payload ?? null,
      type: input.type,
    })
    .returning();
  await db.execute(
    sql`select pg_notify(${frameCommandsNotifyChannel}, ${input.frameId})`,
  );
  return command;
}

// Supersede undelivered commands of the same type: a newer set_scenes or
// set_settings makes the older one pointless (and applying both in order would
// be wasted work on a slow device). "sent" counts as undelivered — the hub
// redelivers unacked sent rows after a grace period (redeliverSentCommands in
// apps/frame-hub/src/hub.ts), so leaving them alone would resurrect a command
// this one replaces.
export async function supersedePendingCommands(
  db: ReturnType<typeof createDb>,
  frameId: string,
  type: string,
) {
  await db
    .update(frameCommands)
    .set({ error: "superseded", status: "expired" })
    .where(
      and(
        eq(frameCommands.frameId, frameId),
        eq(frameCommands.type, type),
        inArray(frameCommands.status, ["pending", "sent"]),
      ),
    );
}

// ---------------------------------------------------------------------------
// Queue observability (GET/DELETE /api/frames/{id}/commands)
// ---------------------------------------------------------------------------

// What a queued command looks like to its owner. Deliberately NOT the raw
// row: `payload` can carry a scene bundle (set_scenes) or a settings object,
// and the queue view is a list of intentions, not a data dump. Only the
// scene-id payload of set_current_scene is small and meaningful enough to
// echo, and it is a public store id the owner already sees in the workspace.
export interface PendingFrameCommand {
  id: string;
  type: string;
  status: string;
  created_at: string;
  expires_at: string | null;
  sent_at: string | null;
  scene_id?: string;
}

function pendingCommandView(
  row: typeof frameCommands.$inferSelect,
): PendingFrameCommand {
  const payload = row.payload;
  const sceneId =
    row.type === "set_current_scene" &&
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    typeof (payload as Record<string, unknown>).scene_id === "string"
      ? ((payload as Record<string, unknown>).scene_id as string)
      : undefined;
  return {
    created_at: row.createdAt.toISOString(),
    expires_at: row.expiresAt ? row.expiresAt.toISOString() : null,
    id: row.id,
    sent_at: row.sentAt ? row.sentAt.toISOString() : null,
    status: row.status,
    type: row.type,
    ...(sceneId ? { scene_id: sceneId } : {}),
  };
}

// Commands still waiting for the device, oldest first — the same order the
// hub drains them in (drainCommands). Already-expired rows are filtered here
// rather than swept: the sweep belongs to the hub and to db-cleanup.sh, and a
// read-only view must not be the thing that mutates the queue.
//
// "sent" counts as waiting. It means the hub wrote the command to a socket
// and the device has not acked it, which for a frame that went back to sleep
// mid-delivery is indistinguishable from pending — and the hub will redeliver
// it (redeliverSentCommands), so the owner can still meaningfully cancel it.
export async function listPendingFrameCommands(
  db: ReturnType<typeof createDb>,
  frameId: string,
  limit = 50,
): Promise<PendingFrameCommand[]> {
  const rows = await db
    .select()
    .from(frameCommands)
    .where(
      and(
        eq(frameCommands.frameId, frameId),
        inArray(frameCommands.status, ["pending", "sent"]),
        or(
          isNull(frameCommands.expiresAt),
          gt(frameCommands.expiresAt, new Date()),
        ),
      ),
    )
    .orderBy(asc(frameCommands.createdAt), asc(frameCommands.id))
    .limit(limit);
  return rows.map(pendingCommandView);
}

/**
 * Drop one queued command on the owner's say-so.
 *
 * Same terminal state supersedePendingCommands uses (`expired`, with a reason
 * in `error`) rather than a DELETE: the row is the audit trail of what was
 * asked for, and the hub's drain already ignores anything not `pending`.
 *
 * "sent" is cancellable for the same reason it is listed: the hub requeues
 * unacked sent rows, so leaving one alone would let a cancelled reboot land
 * on the next reconnect. What cancelling cannot do is recall a command the
 * device already received and acted on — the queue is the only thing under
 * our control, which is exactly why fast-expiring "now" commands exist.
 *
 * Returns false when nothing matched: an unknown id, another frame's command,
 * or one that finished (or expired) between the list and the click.
 */
export async function cancelFrameCommand(
  db: ReturnType<typeof createDb>,
  frameId: string,
  commandId: string,
): Promise<boolean> {
  const cancelled = await db
    .update(frameCommands)
    .set({ error: "cancelled", status: "expired" })
    .where(
      and(
        eq(frameCommands.id, commandId),
        eq(frameCommands.frameId, frameId),
        inArray(frameCommands.status, ["pending", "sent"]),
      ),
    )
    .returning({ id: frameCommands.id });
  return cancelled.length > 0;
}

// ---------------------------------------------------------------------------
// Service settings (docs/cloud-frames.md "Service settings")
// ---------------------------------------------------------------------------

// The nudge is advisory, so it expires quickly: a frame that was offline when
// the owner saved a key re-pulls on its own at `ready` anyway (and on every
// render pass that needs a key), so a stale nudge redelivered days later buys
// nothing and only costs a wake-up on a battery frame.
export const serviceSettingsRefreshTtlMs = 5 * 60 * 1000;

/**
 * Tell a frame its service settings changed. The payload is EMPTY, always.
 *
 * The keys themselves travel over the device-authed HTTPS pull
 * (GET /api/frames/{id}/service-settings), never over this queue:
 *
 *  - `frame_commands` rows are never deleted, so a pushed secret would sit in
 *    Postgres — and in every backup — forever, long after the owner deleted
 *    the key from their account;
 *  - the payload passes through the hub, whose log redaction matches
 *    token/secret/password/authorization/cookie/signature (apps/frame-hub/
 *    src/log.ts) and would NOT match `apiKey` or `accessKey`;
 *  - delivery is at-least-once, so a queued key could be redelivered to a
 *    device after the owner revoked it.
 *
 * A pull has none of those properties: it is computed fresh per request,
 * answered `Cache-Control: no-store`, and stops the moment the scope is
 * revoked.
 */
export async function enqueueServiceSettingsRefresh(
  db: ReturnType<typeof createDb>,
  frameId: string,
) {
  // N saves while a frame is offline are one re-pull, not N wake-ups.
  await supersedePendingCommands(db, frameId, "refresh_service_settings");
  return enqueueFrameCommand(db, {
    frameId,
    payload: {},
    ttlMs: serviceSettingsRefreshTtlMs,
    type: "refresh_service_settings",
  });
}

// Nudge ONE frame, if it can actually act on it: an inactive frame or a
// linked client without `settings:services` gets a 403 from the pull, so
// waking it would spend a battery frame's radio on nothing. Mirrors the
// per-account fan-out in app/api/settings/route.ts (nudgeManagedFrames).
// Failures are swallowed for the same reason they are there: the caller's
// real work (a scene assignment, a settings save) is already committed, and
// an un-nudged frame re-pulls at its next `ready` anyway.
export async function enqueueServiceSettingsRefreshIfScoped(
  db: ReturnType<typeof createDb>,
  frameId: string,
) {
  try {
    const [row] = await db
      .select({
        providerClientMetadata: linkedClients.providerClientMetadata,
        status: frames.status,
      })
      .from(frames)
      .innerJoin(linkedClients, eq(linkedClients.id, frames.linkedClientId))
      .where(and(eq(frames.id, frameId), isNull(linkedClients.revokedAt)))
      .limit(1);
    if (!row || row.status !== "active") {
      return;
    }
    if (!linkedClientScopes(row).includes(frameServiceSettingsScope)) {
      return;
    }
    await enqueueServiceSettingsRefresh(db, frameId);
  } catch (error) {
    reportError("frames.service_settings_nudge_failed", error, { frameId });
  }
}

// Read a jsonb list of service-settings group names — frames.service_setting_groups
// (the granted union) or either per-assignment column. `undefined` means
// "never computed" (a NULL column, or garbage from a hand-edited row) and,
// on the frame row, tells the pull route to compute and backfill it; an
// empty array means "computed, nothing" and is NOT recomputed. Screened
// through deviceDeliverableFields so a group retired from the deliverable
// list can never reappear from an old row, and de-duplicated.
export function readServiceSettingGroups(
  value: unknown,
): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return [
    ...new Set(
      value.filter(
        (entry): entry is string =>
          typeof entry === "string" && deviceDeliverableFields.has(entry),
      ),
    ),
  ];
}

// The groups a set of interpreted scenes declare, in the shape the column
// stores. Pure: callers that already hold the assembled scenes (the scene
// assignment route) pass them straight in rather than re-reading anything.
// A declaration is a REQUEST — the owner's per-assignment grant decides
// what the device receives (grantedSettingsGroupsForAssignment).
export function declaredServiceSettingGroups(scenes: unknown[]): string[] {
  return requiredSettingsForScenes(scenes as Record<string, unknown>[])
    .map((group) => group.key)
    .filter((key) => deviceDeliverableFields.has(key));
}

// What ONE assignment's scene may actually receive: the owner's grant,
// narrowed to what the (current) version declares. A NULL grant is a row
// from before grants existed (migration 0048) and reads as "everything it
// declares" — the behaviour those frames were assigned under — until the
// owner next saves the scene list and it becomes explicit. Pure.
export function grantedSettingsGroupsForAssignment(assignment: {
  declaredSettingsGroups: unknown;
  grantedSettingsGroups: unknown;
}): string[] {
  const declared = readServiceSettingGroups(assignment.declaredSettingsGroups) ?? [];
  const granted = readServiceSettingGroups(assignment.grantedSettingsGroups);
  if (granted === undefined) {
    return declared;
  }
  return granted.filter((group) => declared.includes(group));
}

// The union of the granted groups across a frame's assignments, in
// assignment order and de-duplicated: what frames.service_setting_groups
// holds and what the device pull answers with.
export function grantedServiceSettingGroupsUnion(
  assignments: readonly {
    declaredSettingsGroups: unknown;
    grantedSettingsGroups: unknown;
  }[],
): string[] {
  const union: string[] = [];
  for (const assignment of assignments) {
    for (const group of grantedSettingsGroupsForAssignment(assignment)) {
      if (!union.includes(group)) {
        union.push(group);
      }
    }
  }
  return union;
}

// Compute the granted groups from the frame's CURRENT assignments and
// persist them: each assignment's declared list (so a legacy row learns
// what its scene asks for; its NULL grant stays NULL and keeps reading as
// "all of it") and the frame row's granted union. Only the backfill path
// (a NULL column on an old frame) pays for this: it unzips every assigned
// scene, which is exactly why the column exists. Returns [] when the scenes
// cannot be assembled at all (a pulled scene, a yanked version) and persists
// nothing in that case, so the next request retries instead of freezing
// "nothing" into the row.
export async function computeAndStoreServiceSettingGroups(
  db: ReturnType<typeof createDb>,
  frameId: string,
): Promise<string[]> {
  const built = await buildScenesPayloadForFrame(db, frameId);
  if ("error" in built) {
    return [];
  }
  return storeDeclaredSettingsGroups(db, frameId, built.assignments);
}

// Persist what a freshly assembled payload says each assignment declares
// (grants untouched) and the frame row's granted union; returns the union.
// Shared by the backfill above and by the re-push of an unpinned assignment
// that may have moved to a newer version.
export async function storeDeclaredSettingsGroups(
  db: FramesDatabase,
  frameId: string,
  assignments: readonly AssignmentSettingsGroups[],
): Promise<string[]> {
  for (const assignment of assignments) {
    await db
      .update(frameSceneAssignments)
      .set({
        declaredSettingsGroups: assignment.declaredSettingsGroups,
        updatedAt: new Date(),
      })
      .where(eq(frameSceneAssignments.id, assignment.id));
  }
  const groups = grantedServiceSettingGroupsUnion(assignments);
  await storeServiceSettingGroups(db, frameId, groups);
  return groups;
}

export async function storeServiceSettingGroups(
  db: FramesDatabase,
  frameId: string,
  groups: string[],
) {
  await db
    .update(frames)
    .set({ serviceSettingGroups: groups, updatedAt: new Date() })
    .where(eq(frames.id, frameId));
}

// Pull the shallowest scenes.json out of a published template zip. The zip is
// untrusted input (an old version row, a future publish path), so it gets the
// same entry-count and uncompressed-size caps validateSceneZip enforces at
// publish time — zip-bomb defence in depth. `bytes` is the raw scenes.json
// length, used to bound the assembled payload before it is re-serialized.
export function extractScenesJson(
  zip: Buffer,
): { bytes: number; scenes: unknown[] } | undefined {
  try {
    let best: { path: string; data: Uint8Array } | undefined;
    let entryCount = 0;
    let totalUncompressed = 0;
    const entries = unzipSync(new Uint8Array(zip), {
      filter: (file) => {
        entryCount += 1;
        totalUncompressed += file.originalSize ?? 0;
        if (
          entryCount > maxSceneZipEntries ||
          totalUncompressed > maxSceneZipUncompressedBytes
        ) {
          throw new Error("zip_bounds_exceeded");
        }
        // Inflate only scenes.json; other entries still count against the
        // caps above but are never decompressed.
        return /(^|\/)scenes\.json$/.test(file.name);
      },
    });
    for (const [path, data] of Object.entries(entries)) {
      if (!best || path.split("/").length < best.path.split("/").length) {
        best = { data, path };
      }
    }
    // originalSize is read from the central directory and can be absent, so
    // re-check the one entry we actually inflated against the same ceiling.
    if (!best || best.data.length > maxSceneZipUncompressedBytes) {
      return undefined;
    }
    const parsed = JSON.parse(Buffer.from(best.data).toString("utf8"));
    return Array.isArray(parsed)
      ? { bytes: best.data.length, scenes: parsed }
      : undefined;
  } catch {
    return undefined;
  }
}

// Resolve the store_scene_versions row an assignment actually pins: the
// requested version when pinned, otherwise the newest non-yanked one.
//
// The per-version risk flags live here. store_scenes.risk_flags is a
// denormalized copy of the LATEST version's flags (store-publish.ts
// overwrites it on every publish), so it says nothing about an older pinned
// version — checking it would let "publish shell v1, publish clean v2, pin
// v1" push shell-flagged bytes.
export async function pinnedSceneVersion(
  db: FramesDatabase,
  sceneId: string,
  sceneVersion: number | null | undefined,
) {
  const [row] = await db
    .select({
      riskFlags: storeSceneVersions.riskFlags,
      version: storeSceneVersions.version,
    })
    .from(storeSceneVersions)
    .where(
      and(
        eq(storeSceneVersions.sceneId, sceneId),
        isNull(storeSceneVersions.yankedAt),
        ...(sceneVersion === null || sceneVersion === undefined
          ? []
          : [eq(storeSceneVersions.version, sceneVersion)]),
      ),
    )
    .orderBy(desc(storeSceneVersions.version))
    .limit(1);
  return row;
}

// One store scene's slice of an assignment push: the version that produced
// the bytes and the checksum of just that scene's runtime scenes. Stored on
// the frame as assigned_scene_state / deployed_scene_state so sync state can
// be answered per scene, not only for the set as a whole.
export type SceneDeployState = { version: number; checksum: string };

// One assignment's service-settings picture, as the payload build saw it:
// what the version it assembled declares, and the grant the row carries
// (raw jsonb — NULL for a legacy row; grantedSettingsGroupsForAssignment
// resolves it).
export type AssignmentSettingsGroups = {
  id: string;
  sceneId: string;
  declaredSettingsGroups: string[];
  grantedSettingsGroups: unknown;
};

// Build the interpreted-scene payload for a frame from its assignments. The
// payload shape matches the device's uploaded-scenes path ({"scenes": […]});
// the checksum lets the device and the fleet UI agree on sync state, and
// sceneStates carries the same information per store scene. `assignments`
// carries, per assignment, the settings groups the assembled version
// declares — computed here because this is the one place the scene bytes
// are already open.
export async function buildScenesPayloadForFrame(
  db: FramesDatabase,
  frameId: string,
): Promise<
  | {
      scenes: unknown[];
      checksum: string;
      sceneNames: string[];
      sceneStates: Record<string, SceneDeployState>;
      assignments: AssignmentSettingsGroups[];
    }
  | { error: string }
> {
  const assignments = await db
    .select({
      grantedSettingsGroups: frameSceneAssignments.grantedSettingsGroups,
      id: frameSceneAssignments.id,
      sceneId: frameSceneAssignments.sceneId,
      sceneName: storeScenes.name,
      sceneSlug: storeScenes.slug,
      sceneStatus: storeScenes.status,
      sceneVersion: frameSceneAssignments.sceneVersion,
    })
    .from(frameSceneAssignments)
    .innerJoin(storeScenes, eq(storeScenes.id, frameSceneAssignments.sceneId))
    .where(eq(frameSceneAssignments.frameId, frameId))
    .orderBy(asc(frameSceneAssignments.position));

  const scenes: unknown[] = [];
  const sceneNames: string[] = [];
  const sceneStates: Record<string, SceneDeployState> = {};
  const assignmentGroups: AssignmentSettingsGroups[] = [];
  let rawBytes = 0;
  for (const assignment of assignments) {
    if (assignment.sceneStatus !== "active") {
      return { error: "scene_pulled" };
    }
    const versionRows = await db
      .select({
        content: storeSceneVersions.content,
        objectKey: storeSceneVersions.objectKey,
        riskFlags: storeSceneVersions.riskFlags,
        version: storeSceneVersions.version,
      })
      .from(storeSceneVersions)
      .where(
        and(
          eq(storeSceneVersions.sceneId, assignment.sceneId),
          isNull(storeSceneVersions.yankedAt),
          ...(assignment.sceneVersion === null ||
          assignment.sceneVersion === undefined
            ? []
            : [eq(storeSceneVersions.version, assignment.sceneVersion)]),
        ),
      )
      .orderBy(desc(storeSceneVersions.version))
      .limit(1);
    const versionRow = versionRows[0];
    if (!versionRow) {
      return { error: "scene_version_missing" };
    }
    // Last line of defence on the path that actually produces the bytes: the
    // risk flags of the pinned version, not the scene's denormalized copy of
    // the latest version's flags.
    if (versionRow.riskFlags?.includes("shell")) {
      return { error: "scene_not_allowed" };
    }
    const versionContent = await readBlob(versionRow);
    if (!versionContent) {
      return { error: "scene_version_missing" };
    }
    const extracted = extractScenesJson(versionContent);
    if (!extracted) {
      return { error: "invalid_scene_payload" };
    }
    // A cloud frame runs the interpreter only: a legacy compiled scene would
    // deploy and then log `not_interpreted`. Refuse here, before anything is
    // committed, and count it.
    if (compiledSceneNames(extracted.scenes).length > 0) {
      logWarn("frames.assign.refused_compiled_scene", {
        frameId,
        sceneId: assignment.sceneId,
      });
      return { error: "scene_requires_compilation" };
    }
    // Running bound on the raw scenes.json bytes, so 20 scenes at the store's
    // 32 MiB per-zip ceiling can never all be held at once. The exact check on
    // the serialized payload follows.
    rawBytes += extracted.bytes;
    if (rawBytes > maxScenesPayloadBytes) {
      return { error: "scenes_payload_too_large" };
    }
    // Every pushed scene says where it came from (`origin`: store page,
    // scene uuid, the version these bytes are) — the frame's copy is the
    // record of its install, and the workspace reads it back from there.
    const stamped = withStoreSceneOrigin(extracted.scenes, {
      id: assignment.sceneId,
      slug: assignment.sceneSlug,
      version: versionRow.version,
    });
    scenes.push(...stamped);
    sceneNames.push(assignment.sceneName);
    assignmentGroups.push({
      declaredSettingsGroups: declaredServiceSettingGroups(stamped),
      grantedSettingsGroups: assignment.grantedSettingsGroups,
      id: assignment.id,
      sceneId: assignment.sceneId,
    });
    // The digest of just this assignment's slice of the payload. Comparing
    // it against the copy stored at the last device-acked push is what lets
    // the workspace flag the one edited scene instead of all of them.
    sceneStates[assignment.sceneId] = {
      checksum: createHash("sha256")
        .update(JSON.stringify(stamped))
        .digest("hex"),
      version: versionRow.version,
    };
  }

  const serialized = JSON.stringify(scenes);
  if (Buffer.byteLength(serialized, "utf8") > maxScenesPayloadBytes) {
    return { error: "scenes_payload_too_large" };
  }
  const checksum = createHash("sha256").update(serialized).digest("hex");
  return {
    assignments: assignmentGroups,
    checksum,
    sceneNames,
    sceneStates,
    scenes,
  };
}

// Store one batch of shipped logs, enforcing the per-frame retention cap in
// the same transaction so a chatty device cannot grow unbounded.
export async function storeFrameLogs(
  db: FramesDatabase,
  frameId: string,
  logs: { timestamp: Date; payload: unknown }[],
  // The frame's owning account, for the account-wide byte budget. Optional
  // so older callers/tests keep working; without it only the per-frame row
  // cap applies.
  accountId?: string,
) {
  const batch = logs.slice(0, maxLogBatch).flatMap((entry) => {
    const serialized = JSON.stringify(entry.payload ?? null);
    if (Buffer.byteLength(serialized, "utf8") > maxLogLineBytes) {
      return [];
    }
    return [
      {
        frameId,
        payload: entry.payload,
        sizeBytes: Buffer.byteLength(serialized, "utf8"),
        timestamp: entry.timestamp,
      },
    ];
  });
  if (batch.length === 0) {
    return 0;
  }
  await db.transaction(async (tx) => {
    await tx.insert(frameLogs).values(batch);
    // Prune beyond the cap: cheap because frame_logs_frame_idx is
    // (frame_id, id).
    const [cutoff] = await tx
      .select({ id: frameLogs.id })
      .from(frameLogs)
      .where(eq(frameLogs.frameId, frameId))
      .orderBy(desc(frameLogs.id))
      .offset(maxLogsPerFrame)
      .limit(1);
    if (cutoff) {
      await tx
        .delete(frameLogs)
        .where(
          and(eq(frameLogs.frameId, frameId), lt(frameLogs.id, cutoff.id + 1)),
        );
    }
    // Account byte budget: logs are telemetry, so over budget old lines are
    // culled — never refused (a frame must not learn its logs bounced;
    // usage.ts owns the budget). The frame that overflowed loses its own
    // oldest lines first; the account-wide cull is the fallback.
    if (accountId) {
      const stillOver = await cullFrameLogsForFrameOverBudget(
        tx,
        accountId,
        frameId,
      );
      if (stillOver) {
        await cullFrameLogsOverBudget(tx, accountId);
      }
    }
  });
  return batch.length;
}

// ---------------------------------------------------------------------------
// Asset browsing (docs/cloud-frames.md `assets_list` / `asset_get`)
// ---------------------------------------------------------------------------

// A listing bigger than this is rejected, never truncated (the device already
// bounds itself and says `truncated: true` when it does — see the protocol's
// reject-don't-truncate doctrine in apps/frame-hub/src/protocol.ts).
export const maxAssetListingBytes = 256 * 1024;
// Per cached file; matches the device-side HubMaxAssetFileBytes refusal.
export const maxAssetFileBytes = 8 * 1024 * 1024;
export const maxAssetPathChars = 1024;
// Where image_get replies live in the frame_asset_files cache. A dot-path on
// purpose: devices never include dotfiles in assets_list, so no real asset
// can collide with (or shadow) the current-image slot.
export const frameImageAssetPath = ".frame/image";
// Per-frame blob-cache LRU bounds. Thumbnails dominate (a few tens of KiB
// each); the byte bound is what really matters for full-size downloads.
export const maxAssetFilesPerFrame = 64;
export const maxAssetCacheBytesPerFrame = 24 * 1024 * 1024;

// --- Preview viewer presence ------------------------------------------------
//
// The fleet-preview doctrine (docs/cloud-frames.md, "Previews"): the cloud
// never renders a frame's scenes and never runs a screenshot service. What it
// may do is keep a copy of the snapshot the DEVICE already writes for itself —
// and only while a person is actually looking, because the alternative is
// scraping every frame in every account forever for images nobody opened.
//
// "Looking" is one timestamp per frame, stamped by the surfaces that render a
// frame's images and by an attached browser socket. Everything else reads it.

// How long after the last stamp a frame still counts as watched. Long enough
// to cover a tab left open between renders, short enough that a closed laptop
// stops costing the device anything within minutes.
export const previewWatchWindowMs = 3 * 60 * 1000;
// The stamp is a write on a hot read path (every tile, every poll), so it is
// only refreshed this often. Losing one costs a preview that refreshes on the
// next page load instead of instantly.
const previewWatchThrottleMs = 30 * 1000;

const lastPreviewWatchWrite = new Map<string, number>();

/**
 * Record that someone is looking at this frame's images. Cheap by design:
 * in-process throttle first, then one UPDATE.
 */
export async function markFramePreviewWatched(
  db: FramesDatabase,
  frameId: string,
): Promise<void> {
  const now = Date.now();
  const previous = lastPreviewWatchWrite.get(frameId) ?? 0;
  if (now - previous < previewWatchThrottleMs) {
    return;
  }
  lastPreviewWatchWrite.set(frameId, now);
  // Bounded: a fleet larger than this just loses throttling, not correctness.
  if (lastPreviewWatchWrite.size > 10_000) {
    lastPreviewWatchWrite.clear();
  }
  try {
    await db
      .update(frames)
      .set({ previewWatchedAt: new Date(now) })
      .where(eq(frames.id, frameId));
  } catch (error) {
    // Presence is an optimisation; a failed stamp must never fail the request
    // that was actually asked for.
    logWarn("frames.preview_watch_failed", { error: String(error), frameId });
  }
}

// `graceMs` stretches the window for a frame that was asleep: a deep-sleep
// frame renders once per sleep, so "looked at it within the last sleep" is
// what makes its next render worth fetching (previewWatchGraceMs in
// frame-sleep.ts; the hub remembers each frame's last announced sleep).
export function framePreviewIsWatched(
  frame: { previewWatchedAt: Date | null },
  now = Date.now(),
  graceMs = 0,
): boolean {
  return (
    frame.previewWatchedAt !== null &&
    now - frame.previewWatchedAt.getTime() <= previewWatchWindowMs + graceMs
  );
}

export function resetFramePreviewWatchThrottleForTests() {
  lastPreviewWatchWrite.clear();
}

export interface FrameAssetEntry {
  path: string;
  size: number;
  mtime: number;
  is_dir?: boolean;
}

// Sanitize a device-reported listing: keep only the wire contract's fields
// (a compromised device must not get arbitrary jsonb persisted and replayed
// to every browser), require relative paths, drop malformed entries.
export function parseAssetEntries(value: unknown): FrameAssetEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: FrameAssetEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path : "";
    if (
      path.length === 0 ||
      path.length > maxAssetPathChars ||
      path.startsWith("/") ||
      path.split("/").includes("..")
    ) {
      continue;
    }
    const size = typeof record.size === "number" && Number.isFinite(record.size) ? record.size : 0;
    const mtime =
      typeof record.mtime === "number" && Number.isFinite(record.mtime) ? record.mtime : 0;
    entries.push({
      ...(record.is_dir === true ? { is_dir: true } : {}),
      mtime,
      path,
      size,
    });
  }
  return entries;
}

export async function storeFrameAssetListing(
  db: ReturnType<typeof createDb>,
  frameId: string,
  entries: FrameAssetEntry[],
  truncated: boolean,
) {
  const sizeBytes = Buffer.byteLength(JSON.stringify(entries), "utf8");
  if (sizeBytes > maxAssetListingBytes) {
    return false;
  }
  const now = new Date();
  await db
    .insert(frameAssets)
    .values({
      frameId,
      payload: entries,
      sizeBytes,
      truncated,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      set: { payload: entries, sizeBytes, truncated, updatedAt: now },
      target: frameAssets.frameId,
    });
  return true;
}

// Upsert one fetched file into the per-frame LRU cache, pruning past the
// count/byte caps in the same transaction (the storeFrameLogs pattern).
export async function storeFrameAssetFile(
  db: ReturnType<typeof createDb>,
  frameId: string,
  file: { path: string; thumb: boolean; contentType: string; content: Buffer },
) {
  if (file.content.length > maxAssetFileBytes) {
    return false;
  }
  const now = new Date();
  // The bytes go to object storage before the row does, and outside the
  // transaction: a snapshot upload is a network call, and holding a Postgres
  // connection open across it is how a busy fleet exhausts the pool. An
  // object with no row is inert — the key is its digest, so the next write of
  // the same bytes finds it and uploads nothing.
  const stored = await storeBlob(
    frameCacheNamespace(frameId),
    file.content,
    file.contentType,
  );
  const evicted: string[] = [];
  const replaced: string[] = [];
  await db.transaction(async (tx) => {
    const [previous] = await tx
      .select({ objectKey: frameAssetFiles.objectKey })
      .from(frameAssetFiles)
      .where(
        and(
          eq(frameAssetFiles.frameId, frameId),
          eq(frameAssetFiles.path, file.path),
          eq(frameAssetFiles.thumb, file.thumb),
        ),
      )
      .limit(1);
    if (previous?.objectKey && previous.objectKey !== stored.objectKey) {
      replaced.push(previous.objectKey);
    }
    await tx
      .insert(frameAssetFiles)
      .values({
        contentType: file.contentType,
        frameId,
        objectKey: stored.objectKey,
        path: file.path,
        sizeBytes: stored.sizeBytes,
        thumb: file.thumb,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        set: {
          content: null,
          contentType: file.contentType,
          objectKey: stored.objectKey,
          sizeBytes: stored.sizeBytes,
          updatedAt: now,
        },
        target: [frameAssetFiles.frameId, frameAssetFiles.path, frameAssetFiles.thumb],
      });
    // LRU prune: walk newest-first, keep rows while under both caps, delete
    // the rest. One frame's cache is at most a few dozen small rows, so
    // selecting the metadata (never the bytes) stays cheap.
    const rows = await tx
      .select({
        id: frameAssetFiles.id,
        objectKey: frameAssetFiles.objectKey,
        sizeBytes: frameAssetFiles.sizeBytes,
      })
      .from(frameAssetFiles)
      .where(eq(frameAssetFiles.frameId, frameId))
      .orderBy(desc(frameAssetFiles.updatedAt), desc(frameAssetFiles.id));
    let total = 0;
    const evict: number[] = [];
    rows.forEach((row, index) => {
      total += row.sizeBytes;
      if (index >= maxAssetFilesPerFrame || total > maxAssetCacheBytesPerFrame) {
        evict.push(row.id);
        if (row.objectKey) {
          evicted.push(row.objectKey);
        }
      }
    });
    if (evict.length > 0) {
      await tx.delete(frameAssetFiles).where(inArray(frameAssetFiles.id, evict));
    }
  });
  // After the commit, and only for keys nothing points at any more: two rows
  // of one frame can hold identical bytes (a thumb of an unchanged scene, the
  // same cover copied onto several scenes), and they share the object.
  for (const objectKey of [...evicted, ...replaced]) {
    await deleteBlobIfUnreferenced(objectKey, async () => {
      const [remaining] = await db
        .select({ id: frameAssetFiles.id })
        .from(frameAssetFiles)
        .where(eq(frameAssetFiles.objectKey, objectKey))
        .limit(1);
      return Boolean(remaining);
    });
  }
  return true;
}

// Revoking a frame revokes the underlying linked client (the device sees a
// 401 and demotes itself to standalone) and marks the frame row.
export async function revokeFrame(
  db: ReturnType<typeof createDb>,
  frame: { id: string; linkedClientId: string },
) {
  const now = new Date();
  await db
    .update(linkedClients)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(linkedClients.id, frame.linkedClientId),
        isNull(linkedClients.revokedAt),
      ),
    );
  await db
    .update(frames)
    .set({ connected: false, status: "revoked", updatedAt: now })
    .where(eq(frames.id, frame.id));
  await db
    .update(frameCommands)
    .set({ error: "frame_revoked", status: "expired" })
    .where(
      and(
        eq(frameCommands.frameId, frame.id),
        inArray(frameCommands.status, ["pending", "sent"]),
      ),
    );
  await db.execute(
    sql`select pg_notify(${frameCommandsNotifyChannel}, ${frame.id})`,
  );
}

export function claimTokenExpiry(now = new Date()) {
  return new Date(now.getTime() + claimTokenTtlMs);
}

// Spend one use of a claim token, atomically: concurrent enrollments race on
// use_count < max_uses, so a budget of N admits exactly N frames. used_at is
// stamped when the budget is spent (single-use tokens: on their only use).
export async function redeemClaimToken(
  db: FramesDatabase,
  claimToken: string,
  tokenHashFn: (secret: string) => string,
) {
  const [token] = await db
    .update(frameEnrollmentTokens)
    .set({
      useCount: sql`${frameEnrollmentTokens.useCount} + 1`,
      usedAt: sql`case when ${frameEnrollmentTokens.useCount} + 1 >= ${frameEnrollmentTokens.maxUses} then now() else ${frameEnrollmentTokens.usedAt} end`,
    })
    .where(
      and(
        eq(frameEnrollmentTokens.tokenHash, tokenHashFn(claimToken)),
        lt(frameEnrollmentTokens.useCount, frameEnrollmentTokens.maxUses),
        gt(frameEnrollmentTokens.expiresAt, new Date()),
      ),
    )
    .returning();
  return token;
}

export async function sweepExpiredClaimTokens(
  db: ReturnType<typeof createDb>,
  accountId: string,
) {
  await db
    .delete(frameEnrollmentTokens)
    .where(
      and(
        eq(frameEnrollmentTokens.accountId, accountId),
        lt(frameEnrollmentTokens.useCount, frameEnrollmentTokens.maxUses),
        lt(frameEnrollmentTokens.expiresAt, new Date()),
      ),
    );
}

// Make room for one more claim code when the account is at its cap, by
// deleting the oldest never-used single-use codes.
//
// Codes are stored only as hashes, so an outstanding one can never be shown
// again — "reuse the code you already have" is impossible by construction, and
// every visit to "Add frame" that mints one is a code nobody can retrieve.
// Refusing at the cap therefore locks the account out for a full TTL over
// codes that were already unusable. Evicting keeps the same bound on live
// secrets and only invalidates the code least likely to be in flight.
//
// Multi-use codes are never evicted: those back SD-card images that may have
// been flashed to hardware already, where the code IS the enrollment path.
// Returns the number of codes freed.
export async function evictOldestUnusedClaimTokens(
  db: ReturnType<typeof createDb>,
  accountId: string,
  wanted: number,
) {
  if (wanted < 1) {
    return 0;
  }
  const evictable = await db
    .select({ id: frameEnrollmentTokens.id })
    .from(frameEnrollmentTokens)
    .where(
      and(
        eq(frameEnrollmentTokens.accountId, accountId),
        eq(frameEnrollmentTokens.maxUses, 1),
        eq(frameEnrollmentTokens.useCount, 0),
        gt(frameEnrollmentTokens.expiresAt, new Date()),
      ),
    )
    .orderBy(asc(frameEnrollmentTokens.createdAt))
    .limit(wanted);
  if (evictable.length === 0) {
    return 0;
  }
  await db.delete(frameEnrollmentTokens).where(
    inArray(
      frameEnrollmentTokens.id,
      evictable.map((row) => row.id),
    ),
  );
  return evictable.length;
}

export async function countActiveClaimTokens(
  db: ReturnType<typeof createDb>,
  accountId: string,
) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(frameEnrollmentTokens)
    .where(
      and(
        eq(frameEnrollmentTokens.accountId, accountId),
        lt(frameEnrollmentTokens.useCount, frameEnrollmentTokens.maxUses),
        gt(frameEnrollmentTokens.expiresAt, new Date()),
      ),
    );
  return row?.count ?? 0;
}

// Both live with the rest of the free tier in usage.ts, so the number the
// account page displays and the number enrollment refuses on cannot drift.
// Re-exported here for the callers that already import them from this module.
export { countFramesForAccount, revokedFrameQuotaGraceMs } from "./usage";

// ---------------------------------------------------------------------------
// Metrics retention (scope telemetry:metrics)
// ---------------------------------------------------------------------------

// Hard per-frame retention cap for stored metrics samples, mirroring the
// backend's METRICS_RETAINED_PER_FRAME so the SPA's Metrics panel sees the
// same depth of history in cloud mode.
export const maxMetricsPerFrame = 1000;
// Per-sample size ceiling. Must match the hub's maxMetricsBytes
// (apps/frame-hub/src/protocol.ts) — the hub rejects oversized samples before
// they get here; this re-check keeps the helper safe for any other caller.
export const maxMetricsSampleBytes = 16 * 1024;

// Store one metrics sample, enforcing the per-frame retention cap in the same
// transaction (the storeFrameLogs pattern). Returns the inserted row's id (so
// the hub can broadcast a new_metrics event carrying the same id/timestamp the
// /metrics routes will later serve), or null when the sample is oversized.
export async function storeFrameMetrics(
  db: FramesDatabase,
  frameId: string,
  metrics: unknown,
  timestamp: Date,
): Promise<number | null> {
  const serialized = JSON.stringify(metrics ?? null);
  const sizeBytes = Buffer.byteLength(serialized, "utf8");
  if (sizeBytes > maxMetricsSampleBytes) {
    return null;
  }
  let insertedId: number | null = null;
  await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(frameMetrics)
      .values({ frameId, payload: metrics, sizeBytes, timestamp })
      .returning({ id: frameMetrics.id });
    insertedId = inserted?.id ?? null;
    // Prune beyond the cap: cheap because frame_metrics_frame_idx is
    // (frame_id, id).
    const [cutoff] = await tx
      .select({ id: frameMetrics.id })
      .from(frameMetrics)
      .where(eq(frameMetrics.frameId, frameId))
      .orderBy(desc(frameMetrics.id))
      .offset(maxMetricsPerFrame)
      .limit(1);
    if (cutoff) {
      await tx
        .delete(frameMetrics)
        .where(
          and(
            eq(frameMetrics.frameId, frameId),
            lt(frameMetrics.id, cutoff.id + 1),
          ),
        );
    }
  });
  return insertedId;
}
