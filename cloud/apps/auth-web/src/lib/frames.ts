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
  frames,
  frameSceneAssignments,
  linkedClients,
  storeScenes,
  storeSceneVersions,
} from "@frameos-cloud/db";
import { unzipSync } from "fflate";
import { maxSceneZipEntries, maxSceneZipUncompressedBytes } from "./store";

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
    console.warn(
      `${name}="${raw}" is not a positive integer; using default ${fallback}`,
    );
    return fallback;
  }
  return parsed;
}

export const maxFramesPerAccount = limitFromEnv(
  "FRAMEOS_CLOUD_MAX_FRAMES_PER_ACCOUNT",
  50,
);
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

// The declarative settings a set_settings push may carry. Everything else —
// network config, credentials, agent state, update URLs — is absent by
// design; the device enforces the same list independently.
//
// These are the device's wire names, and they must stay exactly in sync with
// CLOUD_SETTINGS_ALLOWLIST in frameos/src/frameos/cloud/hub_client.nim: the
// hub forwards keys verbatim and the device refuses the WHOLE verb when it
// sees one it does not know, so a single wrong spelling here silently drops
// every setting in the push. (`brightness` joins the list once the runtime
// grows a brightness setting — see docs/cloud-frames.md `set_settings`.)
//
// A Map, not a plain object: `allowedFrameSettings["toString"]` on an object
// resolves through Object.prototype to a truthy, callable function that
// returns a truthy string, so a prototype key would pass validation — and
// "__proto__" / "valueOf" would throw a TypeError instead.
export const allowedFrameSettings = new Map<
  string,
  (value: unknown) => boolean
>([
  ["debug", (v) => typeof v === "boolean"],
  ["interval", (v) => typeof v === "number" && v >= 1 && v <= 60 * 60 * 24],
  ["name", (v) => typeof v === "string" && v.length > 0 && v.length <= 256],
  ["rotate", (v) => v === 0 || v === 90 || v === 180 || v === 270],
  [
    "scaling_mode",
    (v) =>
      v === "contain" || v === "cover" || v === "stretch" || v === "center",
  ],
  ["timezone", (v) => typeof v === "string" && v.length <= 64],
]);

export const allowedFrameCommandTypes = new Set([
  "reboot",
  "render",
  "restart_runtime",
  "set_current_scene",
]);

export function validateFrameSettings(
  value: unknown,
): { settings?: Record<string, unknown>; error?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "invalid_settings" };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return { error: "invalid_settings" };
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

export function frameSummary(frame: typeof frames.$inferSelect) {
  return {
    assigned_checksum: frame.assignedChecksum,
    connected: frame.connected,
    created_at: frame.createdAt,
    frameos_version: frame.frameosVersion,
    hardware: frame.hardware,
    id: frame.id,
    last_seen_at: frame.lastSeenAt,
    linked_client_id: frame.linkedClientId,
    name: frame.name,
    scenes_checksum: frame.scenesChecksum,
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

// Build the interpreted-scene payload for a frame from its assignments. The
// payload shape matches the device's uploaded-scenes path ({"scenes": […]});
// the checksum lets the device and the fleet UI agree on sync state.
export async function buildScenesPayloadForFrame(
  db: FramesDatabase,
  frameId: string,
): Promise<
  | { scenes: unknown[]; checksum: string; sceneNames: string[] }
  | { error: string }
> {
  const assignments = await db
    .select({
      sceneId: frameSceneAssignments.sceneId,
      sceneName: storeScenes.name,
      sceneStatus: storeScenes.status,
      sceneVersion: frameSceneAssignments.sceneVersion,
    })
    .from(frameSceneAssignments)
    .innerJoin(storeScenes, eq(storeScenes.id, frameSceneAssignments.sceneId))
    .where(eq(frameSceneAssignments.frameId, frameId))
    .orderBy(asc(frameSceneAssignments.position));

  const scenes: unknown[] = [];
  const sceneNames: string[] = [];
  let rawBytes = 0;
  for (const assignment of assignments) {
    if (assignment.sceneStatus !== "active") {
      return { error: "scene_pulled" };
    }
    const versionRows = await db
      .select({
        content: storeSceneVersions.content,
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
    const extracted = extractScenesJson(versionRow.content);
    if (!extracted) {
      return { error: "invalid_scene_payload" };
    }
    // Running bound on the raw scenes.json bytes, so 20 scenes at the store's
    // 32 MiB per-zip ceiling can never all be held at once. The exact check on
    // the serialized payload follows.
    rawBytes += extracted.bytes;
    if (rawBytes > maxScenesPayloadBytes) {
      return { error: "scenes_payload_too_large" };
    }
    scenes.push(...extracted.scenes);
    sceneNames.push(assignment.sceneName);
  }

  const serialized = JSON.stringify(scenes);
  if (Buffer.byteLength(serialized, "utf8") > maxScenesPayloadBytes) {
    return { error: "scenes_payload_too_large" };
  }
  const checksum = createHash("sha256").update(serialized).digest("hex");
  return { checksum, sceneNames, scenes };
}

// Store one batch of shipped logs, enforcing the per-frame retention cap in
// the same transaction so a chatty device cannot grow unbounded.
export async function storeFrameLogs(
  db: FramesDatabase,
  frameId: string,
  logs: { timestamp: Date; payload: unknown }[],
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
// Per-frame blob-cache LRU bounds. Thumbnails dominate (a few tens of KiB
// each); the byte bound is what really matters for full-size downloads.
export const maxAssetFilesPerFrame = 64;
export const maxAssetCacheBytesPerFrame = 24 * 1024 * 1024;

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
  await db.transaction(async (tx) => {
    await tx
      .insert(frameAssetFiles)
      .values({
        content: file.content,
        contentType: file.contentType,
        frameId,
        path: file.path,
        sizeBytes: file.content.length,
        thumb: file.thumb,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        set: {
          content: file.content,
          contentType: file.contentType,
          sizeBytes: file.content.length,
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
      }
    });
    if (evict.length > 0) {
      await tx.delete(frameAssetFiles).where(inArray(frameAssetFiles.id, evict));
    }
  });
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

// Frames revoked within this window still count toward the account quota.
// Without it the quota is freely cycleable (revoke → enroll → revoke → …)
// and the dead rows — with their command queues and retained logs — pile up
// unboundedly. Actually deleting them belongs in db-cleanup.sh, which today
// prunes logs by age but never dead frame rows.
export const revokedFrameQuotaGraceMs = 24 * 60 * 60 * 1000;

export async function countFramesForAccount(
  db: FramesDatabase,
  accountId: string,
) {
  const graceCutoff = new Date(Date.now() - revokedFrameQuotaGraceMs);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(frames)
    .where(
      and(
        eq(frames.accountId, accountId),
        or(
          sql`${frames.status} <> 'revoked'`,
          gt(frames.updatedAt, graceCutoff),
        ),
      ),
    );
  return row?.count ?? 0;
}
