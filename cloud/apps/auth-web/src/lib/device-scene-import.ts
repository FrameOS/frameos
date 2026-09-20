// Import the scenes a frame was already running into the owner's library.
//
// The hub stores what the frame reported (`scenes_get`, device-scenes.ts);
// this turns it into what the cloud's model needs: a private draft store
// scene per device scene, assigned to the frame and pushed back, so the frame
// is an ordinary in-sync cloud frame afterwards — its scenes listed, editable
// and activatable — instead of an empty one rendering things the cloud cannot
// see.
//
// Every draft goes through createAccountScene, i.e. the SAME publish path as
// "save to my account": zip validation, moderation, classification, quotas,
// audit. An importer with its own insert would be the hole in all of those.
//
// Dedupe, in order — a re-enrolled frame must not fork the library again:
//   1. the scene carries a store `origin` stamp (it was installed from the
//      store, or pushed by the cloud before the frame was re-enrolled) and
//      that store scene still holds exactly this content → reuse it;
//   2. this account already imported exactly this content (the
//      store_scene_imports ledger) and still has the draft → reuse it;
//   3. otherwise mint a draft and record it in the ledger.
// "Exactly this content" is deviceSceneContentSha256: canonical JSON without
// the `origin` stamp. A scene the owner edited on the frame since is different
// content and becomes a new draft — silently overwriting either copy would
// lose work.

import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import {
  createDb,
  frameDeviceScenes,
  frames,
  storeSceneImports,
  storeScenes,
  storeSceneVersions,
} from "@frameos-cloud/db";
import { createAccountScene } from "./account-scene-create";
import { recordAuditEvent } from "./audit";
import { readBlob } from "./blobs";
import {
  deviceSceneContentSha256,
  deviceSceneName,
  parseDeviceScenesDocument,
  withoutDeviceSceneOrigin,
  type DeviceScene,
} from "./device-scenes";
import {
  assignScenesToFrame,
  currentSceneAssignments,
  maxScenesPerFrame,
  type RequestedScene,
} from "./frame-scenes";
import { declaredServiceSettingGroups, pinnedSceneVersion } from "./frames";
import { reportError } from "./log";
import { extractScenesFromZip } from "./scene-title";
import { maxNewScenesPerDay, maxScenesPerAccount } from "./store";
import type { PublishActor } from "./store-publish";

type Database = ReturnType<typeof createDb>;
type FrameRow = typeof frames.$inferSelect;

// An `importing` claim older than this belongs to an import that died (the
// process restarted mid-request); the next attempt takes it over. Ten
// minutes is well past the slowest real import — a day's worth of new
// scenes, each with a model call.
const staleImportClaimMs = 10 * 60 * 1000;
// Moderation and classification are model calls; run a few drafts at a time
// so a frame with a dozen scenes imports in seconds, not minutes.
const draftConcurrency = 4;

// Refusals that a later attempt can get past (tomorrow's daily budget, a
// moderation outage, space the owner freed). The snapshot stays `ready` so
// the banner can offer "Import the rest"; the ledger makes the retry skip
// what already landed.
const retryableReasons = new Set([
  "daily_scene_limit_exceeded",
  "moderation_unavailable",
  "scene_quota_exceeded",
  "storage_quota_exceeded",
]);

export type ImportedDeviceScene = {
  // False when the draft exists but could not go onto the frame (the frame
  // is full, or the scene runs shell apps a cloud push may never carry).
  assigned: boolean;
  device_scene_id: string;
  name: string;
  // Service-key groups the scene declares and was NOT granted (an import
  // grants none): names only, for "this scene needs your OpenAI key".
  needs_settings_groups?: string[];
  not_assigned_reason?: string;
  scene_id: string;
  version: number;
};

export type SkippedDeviceScene = {
  device_scene_id: string;
  name: string;
  reason: string;
};

export type DeviceSceneImportResult = {
  assigned: number;
  command_id: string | null;
  imported: ImportedDeviceScene[];
  reused: ImportedDeviceScene[];
  skipped: SkippedDeviceScene[];
  skipped_compiled: number;
  // `partial`: something was refused for a reason a retry can get past.
  status: "imported" | "partial";
};

export type DeviceSceneImportOutcome =
  | { ok: true; result: DeviceSceneImportResult }
  | { ok: false; failure: { code: string; detail?: Record<string, unknown>; status: number } };

type Resolved = { sceneId: string; version: number; pin: boolean };

// Every scene of one store version, digested — tier 1's "does the store
// still hold exactly this?".
async function storeVersionDigests(
  db: Database,
  sceneId: string,
  version: number,
): Promise<Set<string>> {
  const [row] = await db
    .select()
    .from(storeSceneVersions)
    .where(
      and(
        eq(storeSceneVersions.sceneId, sceneId),
        eq(storeSceneVersions.version, version),
        isNull(storeSceneVersions.yankedAt),
      ),
    )
    .limit(1);
  const content = await readBlob(row);
  const scenes = content ? extractScenesFromZip(content) : undefined;
  return new Set(
    (scenes ?? [])
      .filter(
        (scene): scene is Record<string, unknown> =>
          typeof scene === "object" && scene !== null && !Array.isArray(scene),
      )
      .map(deviceSceneContentSha256),
  );
}

// Tier 1: the scene's own `origin` stamp names a store scene this account may
// install, and the stamped version (else the newest) holds this exact content.
// A scene by another publisher is pinned at the matched version — joining the
// cloud must not be the moment someone else's newer code lands on the frame.
async function resolveFromOrigin(
  db: Database,
  accountId: string,
  scene: DeviceScene,
  digest: string,
): Promise<Resolved | undefined> {
  const origin = scene.origin;
  if (typeof origin !== "object" || origin === null) {
    return undefined;
  }
  const storeSceneId = (origin as { storeSceneId?: unknown }).storeSceneId;
  if (typeof storeSceneId !== "string" || !/^[0-9a-f-]{36}$/i.test(storeSceneId)) {
    return undefined;
  }
  const [store] = await db
    .select({
      accountId: storeScenes.accountId,
      status: storeScenes.status,
      visibility: storeScenes.visibility,
    })
    .from(storeScenes)
    .where(eq(storeScenes.id, storeSceneId))
    .limit(1);
  if (
    !store ||
    store.status !== "active" ||
    (store.accountId !== accountId && store.visibility !== "public")
  ) {
    return undefined;
  }
  const stamped = Number.parseInt(
    String((origin as { version?: unknown }).version ?? ""),
    10,
  );
  const candidates: number[] = [];
  if (Number.isInteger(stamped) && stamped > 0) {
    candidates.push(stamped);
  }
  const latest = await pinnedSceneVersion(db, storeSceneId, null);
  if (latest && !candidates.includes(latest.version)) {
    candidates.push(latest.version);
  }
  for (const version of candidates) {
    if ((await storeVersionDigests(db, storeSceneId, version)).has(digest)) {
      return { pin: store.accountId !== accountId, sceneId: storeSceneId, version };
    }
  }
  return undefined;
}

// Tier 2: the ledger. The draft must still be the account's and active; its
// row dies with the scene, so a deleted draft is simply not found.
async function resolveFromLedger(
  db: Database,
  accountId: string,
  digest: string,
): Promise<Resolved | undefined> {
  const [row] = await db
    .select({
      sceneId: storeSceneImports.sceneId,
      sceneVersion: storeSceneImports.sceneVersion,
    })
    .from(storeSceneImports)
    .innerJoin(storeScenes, eq(storeScenes.id, storeSceneImports.sceneId))
    .where(
      and(
        eq(storeSceneImports.accountId, accountId),
        eq(storeSceneImports.contentSha256, digest),
        eq(storeScenes.accountId, accountId),
        eq(storeScenes.status, "active"),
      ),
    )
    .limit(1);
  return row
    ? { pin: false, sceneId: row.sceneId, version: row.sceneVersion }
    : undefined;
}

// Tier 3: a new private draft, through the one publish path.
async function mintDraft(
  db: Database,
  input: {
    accountId: string;
    actor: PublishActor;
    digest: string;
    frameId: string;
    scene: DeviceScene;
  },
): Promise<Resolved | { reason: string }> {
  const response = await createAccountScene(db, {
    accountId: input.accountId,
    actor: input.actor,
    name: deviceSceneName(input.scene),
    // The stamp names where a scene CAME from; this draft is a new scene of
    // the owner's, and the cloud stamps its own origin on whatever it serves.
    scenes: [withoutDeviceSceneOrigin(input.scene)],
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    scene?: { id?: string; version?: number };
  };
  if (!response.ok || !body.scene?.id || typeof body.scene.version !== "number") {
    return { reason: body.error ?? `save_failed_${response.status}` };
  }
  await db
    .insert(storeSceneImports)
    .values({
      accountId: input.accountId,
      contentSha256: input.digest,
      deviceSceneId: input.scene.id,
      frameId: input.frameId,
      sceneId: body.scene.id,
      sceneVersion: body.scene.version,
    })
    // Two frames importing the same scene at once: the first ledger row
    // stands, the second draft is merely unrecorded.
    .onConflictDoNothing();
  return { pin: false, sceneId: body.scene.id, version: body.scene.version };
}

async function inBatches<T, R>(
  items: readonly T[],
  size: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += size) {
    results.push(...(await Promise.all(items.slice(start, start + size).map(run))));
  }
  return results;
}

// One import per frame at a time: `ready` → `importing` is the claim, and it
// returns the payload it claimed. A stale claim is a crashed import.
async function claimSnapshot(db: Database, frameId: string) {
  const [claimed] = await db
    .update(frameDeviceScenes)
    .set({ status: "importing", statusAt: new Date() })
    .where(
      and(
        eq(frameDeviceScenes.frameId, frameId),
        or(
          eq(frameDeviceScenes.status, "ready"),
          and(
            eq(frameDeviceScenes.status, "importing"),
            lt(frameDeviceScenes.statusAt, new Date(Date.now() - staleImportClaimMs)),
          ),
        ),
      ),
    )
    .returning();
  return claimed;
}

async function releaseSnapshot(
  db: Database,
  frameId: string,
  status: "ready" | "imported",
  result: DeviceSceneImportResult | null,
) {
  await db
    .update(frameDeviceScenes)
    .set({
      // The scenes are in the library now; keeping a second copy of them
      // here would only be bytes nobody reads.
      ...(status === "imported" ? { payload: null, sizeBytes: 0 } : {}),
      ...(result ? { result } : {}),
      status,
      statusAt: new Date(),
    })
    .where(eq(frameDeviceScenes.frameId, frameId));
}

/**
 * Import the frame's reported scenes and assign them to it. The caller owns
 * authentication and ownership (pass a frame row from frameForAccount).
 */
export async function importDeviceScenes(
  db: Database,
  input: { accountId: string; actor: PublishActor; frame: FrameRow },
): Promise<DeviceSceneImportOutcome> {
  const { accountId, actor, frame } = input;
  if (frame.status !== "active") {
    return { failure: { code: "frame_not_active", status: 409 }, ok: false };
  }
  const claimed = await claimSnapshot(db, frame.id);
  if (!claimed) {
    const [row] = await db
      .select({ status: frameDeviceScenes.status })
      .from(frameDeviceScenes)
      .where(eq(frameDeviceScenes.frameId, frame.id))
      .limit(1);
    return {
      failure:
        row?.status === "importing"
          ? { code: "import_in_progress", status: 409 }
          : { code: "nothing_to_import", status: 404 },
      ok: false,
    };
  }

  try {
    const document = claimed.payload
      ? parseDeviceScenesDocument(claimed.payload)
      : undefined;
    if (!document || document.scenes.length === 0) {
      await db
        .delete(frameDeviceScenes)
        .where(eq(frameDeviceScenes.frameId, frame.id));
      return { failure: { code: "nothing_to_import", status: 404 }, ok: false };
    }

    // Tiers 1 and 2 are database reads: settle them in order, so two device
    // scenes with identical content resolve to one store scene.
    type Entry = {
      digest: string;
      resolved?: Resolved | undefined;
      reused: boolean;
      scene: DeviceScene;
      skipped?: string | undefined;
    };
    const entries: Entry[] = [];
    const digestsSeen = new Set<string>();
    for (const scene of document.scenes) {
      const digest = deviceSceneContentSha256(scene);
      if (digestsSeen.has(digest)) {
        entries.push({ digest, reused: false, scene, skipped: "duplicate" });
        continue;
      }
      digestsSeen.add(digest);
      const resolved =
        (await resolveFromOrigin(db, accountId, scene, digest)) ??
        (await resolveFromLedger(db, accountId, digest));
      entries.push({ digest, resolved, reused: resolved !== undefined, scene });
    }

    // The store checks its quotas AFTER moderation and classification (both
    // model calls, the classifier on the operator's key), so an account at
    // its daily limit would still cost a batch of calls on every retry — and
    // the report is device-supplied, i.e. as long as its sender likes. Settle
    // the budget first, with the same counts publishStoreScene uses, and
    // never start a draft it would refuse.
    const [counts] = await db
      .select({
        recent: sql<number>`count(*) filter (where ${storeScenes.createdAt} > now() - interval '24 hours')::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(storeScenes)
      .where(eq(storeScenes.accountId, accountId));
    const dailyLeft = maxNewScenesPerDay - (counts?.recent ?? 0);
    const accountLeft = maxScenesPerAccount - (counts?.total ?? 0);
    let budget = Math.max(0, Math.min(dailyLeft, accountLeft));
    const overBudget =
      accountLeft <= dailyLeft ? "scene_quota_exceeded" : "daily_scene_limit_exceeded";
    for (const entry of entries) {
      if (entry.resolved || entry.skipped) {
        continue;
      }
      if (budget > 0) {
        budget -= 1;
      } else {
        entry.skipped = overBudget;
      }
    }

    // Tier 3, a few at a time. Once one draft is refused for a reason that
    // will refuse the rest too (the daily budget, a full account), stop
    // asking: the remaining scenes are skipped with that same reason.
    let stopReason: string | undefined;
    await inBatches(
      entries.filter((entry) => !entry.resolved && !entry.skipped),
      draftConcurrency,
      async (entry) => {
        if (stopReason) {
          entry.skipped = stopReason;
          return;
        }
        const minted = await mintDraft(db, {
          accountId,
          actor,
          digest: entry.digest,
          frameId: frame.id,
          scene: entry.scene,
        });
        if ("reason" in minted) {
          entry.skipped = minted.reason;
          if (retryableReasons.has(minted.reason)) {
            stopReason = minted.reason;
          }
        } else {
          entry.resolved = minted;
        }
      },
    );

    // Assign: what the frame already has, then the imports, up to the frame
    // cap. A shell-risk version is refused by assignScenesToFrame for the
    // whole push, so it is left out here and stays a draft.
    const existing = await currentSceneAssignments(db, frame.id);
    const assignedIds = new Set(existing.map((entry) => entry.sceneId));
    const requested: RequestedScene[] = [...existing];
    const notAssigned = new Map<string, string>();
    // NO service-key grant rides an import. What a scene declares is the
    // DEVICE's say — and claim-token enrolments hold `settings:services` by
    // default — so granting "whatever the imported scenes declare" would let
    // a frame that is not the owner's (a leaked multi-use claim code, then
    // one click on a banner that never mentions keys) declare all six groups
    // and pull the account's OpenAI / Home Assistant / Immich keys. An
    // imported scene is assigned like any NEW assignment: granted nothing,
    // until the owner grants it in the frame's settings, where the groups
    // are named. The answer says which scenes are waiting for that.
    for (const entry of entries) {
      const resolved = entry.resolved;
      if (!resolved || assignedIds.has(resolved.sceneId)) {
        continue;
      }
      const version = await pinnedSceneVersion(db, resolved.sceneId, resolved.version);
      if (version?.riskFlags?.includes("shell")) {
        notAssigned.set(resolved.sceneId, "scene_not_allowed");
        continue;
      }
      if (requested.length >= maxScenesPerFrame) {
        notAssigned.set(resolved.sceneId, "frame_full");
        continue;
      }
      assignedIds.add(resolved.sceneId);
      requested.push({
        sceneId: resolved.sceneId,
        sceneVersion: resolved.pin ? resolved.version : null,
        settingsGroups: [],
      });
    }

    let commandId: string | null = null;
    const newlyAssigned = requested.length - existing.length;
    if (newlyAssigned > 0) {
      const outcome = await assignScenesToFrame(db, {
        accountId,
        // Keep what the frame is showing on screen: the push would otherwise
        // activate the first scene of the payload.
        ...(claimed.activeScene ? { activeSceneId: claimed.activeScene } : {}),
        actor,
        frame,
        requested,
        via: "device_import",
      });
      if (!outcome.ok) {
        // The drafts exist and are in the ledger; a retry reuses them.
        await releaseSnapshot(db, frame.id, "ready", null);
        return { failure: outcome.failure, ok: false };
      }
      commandId = outcome.result.commandId ?? null;
    }

    const describe = (entry: Entry): ImportedDeviceScene => {
      const resolved = entry.resolved as Resolved;
      const reason = notAssigned.get(resolved.sceneId);
      const needs = reason === undefined ? declaredServiceSettingGroups([entry.scene]) : [];
      return {
        assigned: reason === undefined,
        device_scene_id: entry.scene.id,
        name: deviceSceneName(entry.scene),
        ...(needs.length > 0 ? { needs_settings_groups: needs } : {}),
        ...(reason ? { not_assigned_reason: reason } : {}),
        scene_id: resolved.sceneId,
        version: resolved.version,
      };
    };
    const skipped = entries
      .filter((entry) => entry.skipped && entry.skipped !== "duplicate")
      .map((entry) => ({
        device_scene_id: entry.scene.id,
        name: deviceSceneName(entry.scene),
        reason: entry.skipped as string,
      }));
    const partial = skipped.some((entry) => retryableReasons.has(entry.reason));
    const result: DeviceSceneImportResult = {
      assigned: newlyAssigned,
      command_id: commandId,
      imported: entries.filter((entry) => entry.resolved && !entry.reused).map(describe),
      reused: entries.filter((entry) => entry.resolved && entry.reused).map(describe),
      skipped,
      skipped_compiled: document.skippedCompiled,
      status: partial ? "partial" : "imported",
    };
    await releaseSnapshot(db, frame.id, partial ? "ready" : "imported", result);

    await recordAuditEvent(db, {
      accountId,
      actor,
      eventType: "frame.device_scenes_imported",
      metadata: {
        assigned: result.assigned,
        imported: result.imported.map((scene) => scene.name),
        reused: result.reused.map((scene) => scene.name),
        skipped: result.skipped.map((scene) => `${scene.name}: ${scene.reason}`),
        skippedCompiled: result.skipped_compiled,
      },
      target: { commandId, frameId: frame.id },
    });
    return { ok: true, result };
  } catch (error) {
    // Never leave the claim behind: the banner would say "importing" for ten
    // minutes over an import that is not running.
    await releaseSnapshot(db, frame.id, "ready", null).catch((releaseError: unknown) =>
      reportError("device_scenes.release_failed", releaseError, { frameId: frame.id }),
    );
    throw error;
  }
}

/**
 * "No thanks": drop the snapshot and remember the verdict, so the banner
 * stays gone and the hub stops asking this frame. The scenes on the device
 * are not touched.
 */
export async function dismissDeviceScenes(
  db: Database,
  input: { accountId: string; actor: unknown; frame: FrameRow },
): Promise<boolean> {
  const [row] = await db
    .update(frameDeviceScenes)
    .set({ payload: null, sizeBytes: 0, status: "dismissed", statusAt: new Date() })
    .where(
      and(
        eq(frameDeviceScenes.frameId, input.frame.id),
        eq(frameDeviceScenes.status, "ready"),
      ),
    )
    .returning({ sceneCount: frameDeviceScenes.sceneCount });
  if (!row) {
    return false;
  }
  await recordAuditEvent(db, {
    accountId: input.accountId,
    actor: input.actor,
    eventType: "frame.device_scenes_dismissed",
    metadata: { sceneCount: row.sceneCount },
    target: { frameId: input.frame.id },
  });
  return true;
}
