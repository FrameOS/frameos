// Cloud-managed frames: enrollment, command queue, settings allowlist, log
// retention. Wire contract: docs/cloud-frames.md at the repo root; design:
// cloud/docs/cloud-frames.md. Free of Next-request imports so the frame hub
// (apps/frame-hub) can share the pure helpers via direct source import.

import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  createDb,
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

export const claimTokenPrefix = "FRCT";
export const claimTokenTtlMs = 24 * 60 * 60 * 1000;
// Base scope for a cloud-managed frame; telemetry scopes are opt-in.
export const frameManagedScope = "frame:managed";
export const frameTelemetryLogsScope = "telemetry:logs";
export const frameTelemetryMetricsScope = "telemetry:metrics";

export const maxFramesPerAccount = 20;
export const maxClaimTokensPerAccount = 20;
// Hard per-frame log retention cap. Retained bytes count toward the
// account's storage usage; db-cleanup.sh prunes by age as well.
export const maxLogsPerFrame = 5000;
export const maxLogBatch = 200;
export const maxLogLineBytes = 8 * 1024;

// The declarative settings a set_settings push may carry. Everything else —
// network config, credentials, agent state, update URLs — is absent by
// design; the device enforces the same list independently.
export const allowedFrameSettings: Record<
  string,
  (value: unknown) => boolean
> = {
  brightness: (v) => typeof v === "number" && v >= 0 && v <= 100,
  debug: (v) => typeof v === "boolean",
  interval: (v) => typeof v === "number" && v >= 1 && v <= 60 * 60 * 24,
  name: (v) => typeof v === "string" && v.length > 0 && v.length <= 256,
  rotate: (v) => v === 0 || v === 90 || v === 180 || v === 270,
  scalingMode: (v) =>
    v === "contain" || v === "cover" || v === "stretch" || v === "center",
  timezone: (v) => typeof v === "string" && v.length <= 64,
};

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
    const check = allowedFrameSettings[key];
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

export async function frameForAccount(
  db: ReturnType<typeof createDb>,
  accountId: string,
  frameId: string,
) {
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

// Supersede queued-but-unsent commands of the same type: a newer set_scenes
// or set_settings makes the older pending one pointless (and applying both
// in order would be wasted work on a slow device).
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
        eq(frameCommands.status, "pending"),
      ),
    );
}

export function extractScenesJson(zip: Buffer): unknown[] | undefined {
  try {
    let best: { path: string; data: Uint8Array } | undefined;
    const entries = unzipSync(new Uint8Array(zip), {
      filter: (file) => /(^|\/)scenes\.json$/.test(file.name),
    });
    for (const [path, data] of Object.entries(entries)) {
      if (!best || path.split("/").length < best.path.split("/").length) {
        best = { data, path };
      }
    }
    if (!best) {
      return undefined;
    }
    const parsed = JSON.parse(Buffer.from(best.data).toString("utf8"));
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// Build the interpreted-scene payload for a frame from its assignments. The
// payload shape matches the device's uploaded-scenes path ({"scenes": […]});
// the checksum lets the device and the fleet UI agree on sync state.
export async function buildScenesPayloadForFrame(
  db: ReturnType<typeof createDb>,
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
  for (const assignment of assignments) {
    if (assignment.sceneStatus !== "active") {
      return { error: "scene_pulled" };
    }
    const versionRows = await db
      .select({
        content: storeSceneVersions.content,
        version: storeSceneVersions.version,
      })
      .from(storeSceneVersions)
      .where(
        and(
          eq(storeSceneVersions.sceneId, assignment.sceneId),
          isNull(storeSceneVersions.yankedAt),
          ...(assignment.sceneVersion
            ? [eq(storeSceneVersions.version, assignment.sceneVersion)]
            : []),
        ),
      )
      .orderBy(desc(storeSceneVersions.version))
      .limit(1);
    const versionRow = versionRows[0];
    if (!versionRow) {
      return { error: "scene_version_missing" };
    }
    const extracted = extractScenesJson(versionRow.content);
    if (!extracted) {
      return { error: "invalid_scene_payload" };
    }
    scenes.push(...extracted);
    sceneNames.push(assignment.sceneName);
  }

  const checksum = createHash("sha256")
    .update(JSON.stringify(scenes))
    .digest("hex");
  return { checksum, sceneNames, scenes };
}

// Store one batch of shipped logs, enforcing the per-frame retention cap in
// the same transaction so a chatty device cannot grow unbounded.
export async function storeFrameLogs(
  db: ReturnType<typeof createDb>,
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
  await db.insert(frameLogs).values(batch);
  // Prune beyond the cap: cheap because frame_logs_frame_idx is (frame_id, id).
  const [cutoff] = await db
    .select({ id: frameLogs.id })
    .from(frameLogs)
    .where(eq(frameLogs.frameId, frameId))
    .orderBy(desc(frameLogs.id))
    .offset(maxLogsPerFrame)
    .limit(1);
  if (cutoff) {
    await db
      .delete(frameLogs)
      .where(
        and(eq(frameLogs.frameId, frameId), lt(frameLogs.id, cutoff.id + 1)),
      );
  }
  return batch.length;
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
  db: ReturnType<typeof createDb>,
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

export async function countFramesForAccount(
  db: ReturnType<typeof createDb>,
  accountId: string,
) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(frames)
    .where(
      and(eq(frames.accountId, accountId), sql`${frames.status} <> 'revoked'`),
    );
  return row?.count ?? 0;
}
