// Creating a virtual frame (docs/cloud-frames.md "Virtual frames"). Its own
// file because it reads the plan (usage.ts → the ledger), which the frame
// hub's bundle has no use for; the rules both processes share are
// virtual-frames.ts.

import { generateKeyPairSync } from "node:crypto";
import { sql } from "drizzle-orm";
import { frames, linkedClients, virtualFrames, type createDb } from "@frameos-cloud/db";
import { frameManagedScope, frameServiceSettingsScope, frameTelemetryLogsScope } from "./frames";
import { createSecretToken, hashSecret } from "./secrets";
import { accountLimits, countCloudRenderedFramesForAccount } from "./usage";
import { newVirtualViewToken, notifyVirtualFrame, virtualHardware } from "./virtual-frames";

type Database = ReturnType<typeof createDb>;

export class VirtualFrameQuotaError extends Error {
  constructor(
    readonly code: "cloud_rendered_frame_quota_exceeded",
    readonly limit: number,
  ) {
    super(code);
  }
}

// What the frame's link is granted. Its owner made it, here, signed in: the
// same grant a single-use claim token carries, minus metrics (there is no
// host to chart). `settings:services` is the owner's per-frame switch like
// on hardware, with one difference the form says out loud: this frame's
// scenes run on the cloud's servers, so that is where the keys are used.
export const virtualFrameScopes = [
  frameManagedScope,
  frameServiceSettingsScope,
  frameTelemetryLogsScope,
];

/**
 * Insert the frame, its link and its device row, inside the plan's
 * `cloud_rendered_frames` (zero on the free plan). That is its only pool: the
 * plan's `frames` are for hardware the account owns (countFramesForAccount
 * leaves virtual frames out), because the two cost entirely different things
 * — a WebSocket and a row against a render per refresh. Checked in the
 * insert's transaction, behind a lock on the account, so two requests cannot
 * both take the last place.
 */
export async function createVirtualFrame(
  db: Database,
  input: { accountId: string; height: number; name: string; timezone?: string | null; width: number },
) {
  // A link like any frame's, so the owner's switches (telemetry, service
  // keys) work on it unchanged — but nothing can dial in as this frame: the
  // token and the private key are made here and kept nowhere.
  const tokenReference = hashSecret(createSecretToken("fc_link", 40));
  const { publicKey } = generateKeyPairSync("ed25519");
  const publicKeyBase64 = Buffer.from(String(publicKey.export({ format: "jwk" }).x), "base64url").toString("base64");

  const created = await db.transaction(async (tx) => {
    // Serializes this account's creations: without it two concurrent
    // requests both read "one place left" and both insert.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`virtual-frames:${input.accountId}`}, 0))`);
    const limits = await accountLimits(tx, input.accountId);
    if ((await countCloudRenderedFramesForAccount(tx, input.accountId)) >= limits.cloudRenderedFrames) {
      throw new VirtualFrameQuotaError("cloud_rendered_frame_quota_exceeded", limits.cloudRenderedFrames);
    }
    const [linkedClient] = await tx
      .insert(linkedClients)
      .values({
        accountId: input.accountId,
        clientKind: "frame",
        providerClientMetadata: { enrolledVia: "virtual", requestedScopes: virtualFrameScopes },
        publicDisplayName: input.name,
        tokenReference,
      })
      .returning();
    if (!linkedClient) {
      throw new Error("linked_client_insert_failed");
    }
    const [frame] = await tx
      .insert(frames)
      .values({
        accountId: input.accountId,
        hardware: virtualHardware(input.width, input.height),
        linkedClientId: linkedClient.id,
        name: input.name,
        publicKey: publicKeyBase64,
        ...(input.timezone ? { settings: { timezone: input.timezone } } : {}),
        // The owner is the one creating it: nothing to confirm.
        status: "active",
      })
      .returning();
    if (!frame) {
      throw new Error("frame_insert_failed");
    }
    const [virtual] = await tx
      .insert(virtualFrames)
      .values({ frameId: frame.id, viewToken: newVirtualViewToken() })
      .returning();
    if (!virtual) {
      throw new Error("virtual_frame_insert_failed");
    }
    return { frame, linkedClient, virtual };
  });
  // After the commit: the hub starts the frame's device.
  await notifyVirtualFrame(db, created.frame.id);
  return created;
}
