import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { frameEnrollmentTokens, frames, linkedClients } from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../src/lib/audit";
import { applyProvisioningScenes } from "../../../../src/lib/frame-provisioning";
import { NextRequest, NextResponse } from "next/server";
import {
  authenticateLinkedClient,
  linkedClientHasScope,
  linkedClientScopes,
} from "../../../../src/lib/backend-auth";
import {
  jsonError,
  parseOptionalString,
  readJsonObject,
  requireDatabase,
} from "../../../../src/lib/device-flow";
import {
  countFramesForAccount,
  frameCommandsNotifyChannel,
  frameManagedScope,
  frameServiceSettingsScope,
  frameTelemetryLogsScope,
  frameTelemetryMetricsScope,
  isValidEd25519PublicKey,
  maxFramesPerAccount,
  redeemClaimToken,
} from "../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { createEncryptedSecretToken, hashSecret } from "../../../../src/lib/secrets";
import { reportError } from "../../../../src/lib/log";

export const runtime = "nodejs";

const wsPath = "/api/frames/ws";

// What a claim-token enrollment grants (see the linked-client insert below).
// The response's `scope` string must list ALL of it: the device stores that
// string as its local scope list and gates its own telemetry push loops on
// it — reporting only frame:managed here is how frames ended up never
// sending a single log line while the hub sat ready to accept them.
const claimTokenGrantedScopes = [
  frameManagedScope,
  // Service API keys (Unsplash/OpenAI/Home Assistant/…) the frame's scenes
  // declare, fetched by the device from
  // GET /api/frames/{id}/service-settings — never pushed over the queue.
  // Granted at mint time for the same reason telemetry is: the owner minted
  // this claim token to run their own scenes on their own frame, and a scene
  // that renders "please provide an API key" until the owner finds a second
  // switch is the trap this grant avoids.
  //
  // NEW enrollments only. Existing frames are deliberately NOT backfilled —
  // adding a scope to a link the owner approved before this feature existed
  // is exactly the silent escalation autoGrantedDeviceScopes refuses to do.
  // The per-frame owner toggle
  // (POST /api/frames/{id}/service-settings/enabled) is how an already
  // enrolled frame gets it.
  frameServiceSettingsScope,
  frameTelemetryLogsScope,
  frameTelemetryMetricsScope,
];
const claimTokenScopeString = claimTokenGrantedScopes.join(" ");

// Same set the frames-app shell route uses to decide "is this a dev server".
const localHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// Where the device should dial its management WebSocket, when that differs
// from `{cloud_url}{ws_path}`. In production nginx proxies /api/frames/ws to
// the frame hub on the same origin, so this returns undefined and the field
// stays off the wire. In development the hub is a second process on its own
// port (getHubPort in apps/frame-hub, default 3100) that this Next server
// knows about and the device cannot guess — the exact analogue of the
// cloud_ws_origin injection app/frames/[[...path]]/route.ts does for the
// browser SPA. FRAME_HUB_PUBLIC_URL wins wherever it is set (empty counts as
// unset, same trap as there); otherwise only a loopback request host gets the
// :3100 default, because behind a real hostname we never guess.
//
// The returned URL is a full ws:// or wss:// URL. Devices accept it under the
// same transport rule as cloud_url: wss:// anywhere, plain ws:// only for
// localhost/.local/private-network hosts (docs/cloud-frames.md).
function frameWsUrl(request: NextRequest): string | undefined {
  const configuredHub = process.env.FRAME_HUB_PUBLIC_URL?.trim().replace(
    /\/$/,
    "",
  );
  const hostname = new URL(request.url).hostname;
  const hubOrigin =
    configuredHub ||
    (localHosts.has(hostname) ? `http://${hostname}:3100` : undefined);
  if (!hubOrigin) {
    return undefined;
  }
  // http → ws, https → wss (already-ws origins pass through unchanged).
  return `${hubOrigin.replace(/^http/, "ws")}${wsPath}`;
}

function parseHardware(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > 4096) {
    return null;
  }
  return value as Record<string, unknown>;
}

// Device enrollment (wire contract: docs/cloud-frames.md "Enrollment").
//
// Flow A — unauthenticated, with a claim token from "Add frame".
//   The FIRST enrollment of a token is born `active`: minting the token was
//   the owner's deliberate, authenticated act, and the overwhelmingly common
//   first redeemer is the owner's own board booting minutes later (SD images
//   mint multi-use tokens so a card can be reflashed, so "single-use only"
//   would miss exactly that case). If a stolen token or leaked image beats
//   the owner to it, the owner's own card lands `pending` behind a foreign
//   active frame — loud, auditable, and revocable. Every LATER enrollment of
//   a multi-use token is born `pending` and needs the owner's confirmation
//   click: any card holding a fleet image can enroll, so each additional
//   board brings its own proof.
// Flow B — Bearer token from the RFC 8628 device flow (client_kind "frame").
//   The consent screen was the ownership proof, so the frame is born
//   `active`; this call registers the device public key.
export async function POST(request: NextRequest) {
  const limited = await rateLimitResponse(request, "frames:enroll", {
    limit: 30,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  const body = await readJsonObject(request);
  const publicKey = parseOptionalString(body.public_key);
  if (!publicKey || !isValidEd25519PublicKey(publicKey)) {
    return jsonError("invalid_public_key", 400);
  }
  const hardware = parseHardware(body.hardware);
  const frameosVersion = parseOptionalString(body.frameos_version)?.slice(
    0,
    64,
  );
  const name = parseOptionalString(body.name)?.slice(0, 256);

  const claimToken = parseOptionalString(body.claim_token);
  const authorizationHeader = request.headers.get("authorization");
  const wsUrl = frameWsUrl(request);

  if (claimToken) {
    return enrollWithClaimToken(db, wsUrl, {
      claimToken,
      frameosVersion,
      hardware,
      name,
      publicKey,
    });
  }
  if (authorizationHeader) {
    return enrollLinkedFrame(db, authorizationHeader, wsUrl, {
      frameosVersion,
      hardware,
      name,
      publicKey,
    });
  }
  return jsonError("invalid_claim_token", 400);
}

interface EnrollInput {
  frameosVersion: string | undefined;
  hardware: Record<string, unknown> | null;
  name: string | undefined;
  publicKey: string;
}

// A frame whose HTTP response was lost retries the same enrollment. Rotating
// the linked client's token keeps the old one alive for this long, so the
// original response still works if it turns up after all (same grace window
// backends/rotate-token uses).
const rotationGraceWindowSeconds = 5 * 60;

class QuotaExceededError extends Error {}

async function enrollWithClaimToken(
  db: NonNullable<ReturnType<typeof requireDatabase>["db"]>,
  wsUrl: string | undefined,
  input: EnrollInput & { claimToken: string },
) {
  let accessToken: ReturnType<typeof createEncryptedSecretToken>;
  try {
    accessToken = createEncryptedSecretToken("fc_link");
  } catch (error) {
    reportError("frames.enroll_encryption_unavailable", error);
    return jsonError("encryption_not_configured", 503);
  }

  // Idempotent retry: the device lost the response to an enrollment that
  // already succeeded. The natural key is (claim token, device public key) —
  // hand back the same frame with a freshly rotated access token instead of
  // 400 invalid_claim_token plus an orphan pending frame. Only while the
  // frame is still pending: once the owner has confirmed it, the enrollment
  // is finished and a replay is just a replay.
  const replay = await replayEnrollment(db, wsUrl, input, accessToken);
  if (replay) {
    return replay;
  }

  // Re-enrollment: a token minted FOR an existing frame re-keys that frame in
  // place instead of inserting a second row for the same board.
  const rebind = await rebindEnrollment(db, wsUrl, input, accessToken);
  if (rebind) {
    return rebind;
  }

  const displayName = input.name ?? null;

  // Everything or nothing, and the budget is spent LAST-but-inside: the
  // device treats a 4xx here as permanent and erases its claim token, so an
  // enrollment that fails (quota, insert, encryption) must not consume a use
  // or the SD card is bricked. The UPDATE also row-locks the token until
  // commit, so N concurrent enrollments on a multi-use token serialize and
  // cannot all pass the quota check.
  let result:
    | {
        accessTokenValue: string;
        frame: typeof frames.$inferSelect;
        tokenId: string;
      }
    | undefined;
  try {
    result = await db.transaction(async (tx) => {
      // Atomic budget spend: single-use tokens admit exactly one enrollment;
      // multi-use tokens (SD images flashed to many cards) admit max_uses. A
      // replay past the budget or expiry sees invalid_claim_token.
      const token = await redeemClaimToken(tx, input.claimToken, hashSecret);
      if (!token) {
        return undefined;
      }

      if (
        (await countFramesForAccount(tx, token.accountId)) >=
        maxFramesPerAccount
      ) {
        throw new QuotaExceededError();
      }

      // The claim token's name outranks the device's: the owner typed it at
      // mint time (the ESP32 flasher's "Frame name" field), while the
      // device's is self-asserted and usually just its default hostname —
      // every stock ESP32 enrolls as "frameos", which used to shadow the
      // chosen name. Multi-use tokens (SD images) carry no token name, so
      // the device-sent name (baked into the image) still applies there.
      const name = token.name ?? displayName ?? "FrameOS frame";
      const [linkedClient] = await tx
        .insert(linkedClients)
        .values({
          accountId: token.accountId,
          clientKind: "frame",
          providerClientMetadata: {
            enrolledVia: "claim_token",
            // Telemetry comes with the claim-token grant: the owner minted
            // this token to manage the frame from the workspace, and a Logs
            // panel that stays empty until a separate scope dance is a trap
            // (the hub refuses every log_batch with insufficient_scope and
            // nothing in the UI says why). The LOCAL switch on the device
            // (send_logs) remains the privacy control.
            requestedScopes: claimTokenGrantedScopes,
          },
          publicDisplayName: name,
          tokenReference: accessToken.tokenReference,
        })
        .returning();
      if (!linkedClient) {
        throw new Error("linked_client_insert_failed");
      }
      const [insertedFrame] = await tx
        .insert(frames)
        .values({
          accountId: token.accountId,
          frameosVersion: input.frameosVersion ?? null,
          hardware: input.hardware,
          linkedClientId: linkedClient.id,
          name,
          publicKey: input.publicKey,
          // Carried, not acted on: the owner's confirmation is what copies
          // these scenes over (app/api/frames/{id}/confirm). A multi-use SD
          // card enrolls many frames, and the token's own frame_id records
          // only the last one, so the intent has to ride the frame row.
          sceneSourceFrameId: token.sceneSourceFrameId,
          // redeemClaimToken returned the post-spend row, so use_count 1 is
          // the token's first enrollment.
          status: token.useCount === 1 ? "active" : "pending",
        })
        .returning();
      if (!insertedFrame) {
        throw new Error("frame_insert_failed");
      }
      await tx
        .update(frameEnrollmentTokens)
        .set({ frameId: insertedFrame.id })
        .where(eq(frameEnrollmentTokens.id, token.id));
      return {
        accessTokenValue: accessToken.token,
        frame: insertedFrame,
        tokenId: token.id,
      };
    });
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      return jsonError("frame_quota_exceeded", 403, {
        max_frames: maxFramesPerAccount,
      });
    }
    throw error;
  }

  if (!result) {
    return jsonError("invalid_claim_token", 400);
  }

  await recordAuditEvent(db, {
    accountId: result.frame.accountId,
    actor: { claimTokenId: result.tokenId, kind: "frame_enrollment" },
    eventType: "frame.enrolled",
    metadata: {
      via: "claim_token",
      ...(result.frame.status === "active" ? { auto_confirmed: true } : {}),
    },
    target: {
      frameId: result.frame.id,
      linkedClientId: result.frame.linkedClientId,
    },
  });

  // A single-use enrollment is born active, so the provisioning scene copy
  // ("start with the scenes from <that frame>") runs here instead of at the
  // Confirm click. The source rides the token the owner minted — the
  // unauthenticated caller chooses nothing — and the ownership re-check plus
  // the deploy gates live inside applyProvisioningScenes.
  if (result.frame.status === "active") {
    await applyProvisioningScenes(db, {
      accountId: result.frame.accountId,
      actor: { claimTokenId: result.tokenId, kind: "frame_enrollment" },
      frame: result.frame,
    });
  }

  return NextResponse.json({
    access_token: result.accessTokenValue,
    frame_id: result.frame.id,
    scope: claimTokenScopeString,
    status: result.frame.status,
    token_type: "Bearer",
    ws_path: wsPath,
    ...(wsUrl ? { ws_url: wsUrl } : {}),
  });
}

// A retry may arrive minutes after the response was lost, so a frame that is
// no longer pending must still be replayable for a while.
const replayActiveWindowSeconds = 15 * 60;

// Has this exact device already enrolled with this exact claim token? The
// claim token itself is the secret that authorizes the lookup, so this grants
// nothing a fresh enrollment would not have granted. A still-pending frame on
// a live linked client always counts; an ACTIVE frame counts only briefly
// after its enrollment (a token's first enrollment is born active, so its
// lost-response retry would otherwise find nothing) — never beyond that
// window, or a claim token captured after the fact could mint fresh
// credentials for a frame that has long been in service.
async function replayEnrollment(
  db: NonNullable<ReturnType<typeof requireDatabase>["db"]>,
  wsUrl: string | undefined,
  input: EnrollInput & { claimToken: string },
  accessToken: ReturnType<typeof createEncryptedSecretToken>,
) {
  const [token] = await db
    .select()
    .from(frameEnrollmentTokens)
    .where(eq(frameEnrollmentTokens.tokenHash, hashSecret(input.claimToken)))
    .limit(1);
  if (!token || token.expiresAt <= new Date() || token.useCount === 0) {
    return undefined;
  }

  const replayableStatus = or(
    eq(frames.status, "pending"),
    and(
      eq(frames.status, "active"),
      gt(
        frames.createdAt,
        new Date(Date.now() - replayActiveWindowSeconds * 1000),
      ),
    ),
  );
  const [existing] = await db
    .select({ frame: frames })
    .from(frames)
    .innerJoin(linkedClients, eq(linkedClients.id, frames.linkedClientId))
    .where(
      and(
        eq(frames.accountId, token.accountId),
        eq(frames.publicKey, input.publicKey),
        replayableStatus,
        isNull(linkedClients.revokedAt),
      ),
    )
    .limit(1);
  if (!existing) {
    return undefined;
  }

  // The original token was never stored in decryptable form, so hand out a
  // fresh one and keep the old one valid for the grace window in case the
  // lost response finds its way to the device after all.
  await db
    .update(linkedClients)
    .set({
      lastTokenRotationAt: new Date(),
      previousTokenExpiresAt: new Date(
        Date.now() + rotationGraceWindowSeconds * 1000,
      ),
      previousTokenReference: sql`${linkedClients.tokenReference}`,
      tokenReference: accessToken.tokenReference,
      updatedAt: new Date(),
    })
    .where(eq(linkedClients.id, existing.frame.linkedClientId));

  return NextResponse.json({
    access_token: accessToken.token,
    frame_id: existing.frame.id,
    scope: claimTokenScopeString,
    status: existing.frame.status,
    token_type: "Bearer",
    ws_path: wsPath,
    ...(wsUrl ? { ws_url: wsUrl } : {}),
  });
}

// Re-enrollment (docs/cloud-frames.md, "Re-enrollment"): a claim token minted
// with `frame_id` re-keys THAT frame instead of creating one. The board keeps
// nothing across a factory reset or a full flash — it generates a new device
// keypair and has no link token — so the cloud side must accept a new public
// key for a row it already has, and the alternative (enroll fresh) forks a
// duplicate frame that orphans the original's scenes, assets and logs.
//
// What re-keying touches: frames.public_key, the reported hardware/version,
// and the link's token. What it must NOT touch: frames.id, the frame's name,
// scenes, assets, logs, schedule, settings, status, or the link's SCOPES —
// re-enrolling is not a fresh grant, so a `settings:services` the owner
// revoked stays revoked.
//
// Returns undefined when the token is not a frame-bound one, so the ordinary
// enrollment path runs; a NextResponse (success or 400) when it is.
async function rebindEnrollment(
  db: NonNullable<ReturnType<typeof requireDatabase>["db"]>,
  wsUrl: string | undefined,
  input: EnrollInput & { claimToken: string },
  accessToken: ReturnType<typeof createEncryptedSecretToken>,
) {
  const [token] = await db
    .select()
    .from(frameEnrollmentTokens)
    .where(eq(frameEnrollmentTokens.tokenHash, hashSecret(input.claimToken)))
    .limit(1);
  if (!token?.boundFrameId) {
    return undefined;
  }
  if (token.expiresAt <= new Date()) {
    return jsonError("invalid_claim_token", 400);
  }

  // The frame must still be there, still belong to the minting account, and
  // still have a live link. Anything else and the token means nothing.
  const [row] = await db
    .select({ frame: frames, linkedClient: linkedClients })
    .from(frames)
    .innerJoin(linkedClients, eq(linkedClients.id, frames.linkedClientId))
    .where(
      and(
        eq(frames.id, token.boundFrameId),
        eq(frames.accountId, token.accountId),
        isNull(linkedClients.revokedAt),
      ),
    )
    .limit(1);
  if (!row || row.frame.status === "revoked") {
    return jsonError("invalid_claim_token", 400);
  }

  // Spend the budget, or recognise the one device allowed to replay it. A
  // spent token is only good to the key that spent it: the device whose
  // response was lost retries and gets a fresh access token, while anyone
  // else holding the same string gets nothing. redeemClaimToken's atomic
  // use_count guard also settles a two-device race — the loser lands here
  // with a different key and is refused.
  if (token.useCount === 0) {
    const spent = await redeemClaimToken(db, input.claimToken, hashSecret);
    if (!spent && row.frame.publicKey !== input.publicKey) {
      return jsonError("invalid_claim_token", 400);
    }
  } else if (row.frame.publicKey !== input.publicKey) {
    return jsonError("invalid_claim_token", 400);
  }

  await db.transaction(async (tx) => {
    await tx
      .update(frames)
      .set({
        frameosVersion: input.frameosVersion ?? row.frame.frameosVersion,
        hardware: input.hardware ?? row.frame.hardware,
        publicKey: input.publicKey,
        updatedAt: new Date(),
      })
      .where(eq(frames.id, row.frame.id));
    // No grace window here, unlike the lost-response rotation above: the
    // point of a re-enrollment is that the previous credential is being
    // replaced, so it dies now.
    await tx
      .update(linkedClients)
      .set({
        lastTokenRotationAt: new Date(),
        previousTokenExpiresAt: null,
        previousTokenReference: null,
        tokenReference: accessToken.tokenReference,
        updatedAt: new Date(),
      })
      .where(eq(linkedClients.id, row.frame.linkedClientId));
    await tx
      .update(frameEnrollmentTokens)
      .set({ frameId: row.frame.id })
      .where(eq(frameEnrollmentTokens.id, token.id));
  });

  // Wake the hub: a socket the OLD device still holds was authenticated with
  // the credential just replaced, and the hub's session check compares the
  // frame's public key against the one the session enrolled with.
  await db.execute(
    sql`select pg_notify(${frameCommandsNotifyChannel}, ${row.frame.id})`,
  );

  await recordAuditEvent(db, {
    accountId: row.frame.accountId,
    actor: { claimTokenId: token.id, kind: "frame_enrollment" },
    eventType: "frame.re_enrolled",
    metadata: { via: "claim_token" },
    target: {
      frameId: row.frame.id,
      linkedClientId: row.frame.linkedClientId,
    },
  });

  return NextResponse.json({
    access_token: accessToken.token,
    frame_id: row.frame.id,
    // The link's CURRENT scopes, not the mint-time grant: re-enrollment
    // re-keys a device, it does not re-approve anything.
    scope: linkedClientScopes(row.linkedClient).join(" "),
    status: row.frame.status,
    token_type: "Bearer",
    ws_path: wsPath,
    ...(wsUrl ? { ws_url: wsUrl } : {}),
  });
}

async function enrollLinkedFrame(
  db: NonNullable<ReturnType<typeof requireDatabase>["db"]>,
  authorizationHeader: string,
  wsUrl: string | undefined,
  input: EnrollInput,
) {
  const linkedClient = await authenticateLinkedClient(db, authorizationHeader);
  if (!linkedClient) {
    return jsonError("invalid_link_token", 401);
  }
  // The frame:managed scope must have been on the consent screen (or added
  // later through the owner-approved scope-change flow). Enrollment never
  // adds scopes itself — no self-escalation.
  if (
    linkedClient.clientKind !== "frame" ||
    !linkedClientHasScope(linkedClient, frameManagedScope)
  ) {
    return jsonError("insufficient_scope", 403);
  }

  const [existing] = await db
    .select()
    .from(frames)
    .where(eq(frames.linkedClientId, linkedClient.id))
    .limit(1);

  if (existing) {
    // Re-registering an existing enrollment may refresh metadata, but never
    // the public key: a stolen bearer token must not be able to swap in an
    // attacker's key and take over the challenge/response identity.
    if (existing.publicKey !== input.publicKey) {
      return jsonError("public_key_mismatch", 409);
    }
    await db
      .update(frames)
      .set({
        frameosVersion: input.frameosVersion ?? existing.frameosVersion,
        hardware: input.hardware ?? existing.hardware,
        updatedAt: new Date(),
      })
      .where(eq(frames.id, existing.id));
    return NextResponse.json({
      frame_id: existing.id,
      // The full grant, not just frame:managed — the device unions this into
      // its local scope string (Flow B is additive) and enables its
      // telemetry push loops from it.
      scope: linkedClientScopes(linkedClient).join(" "),
      status: existing.status,
      ws_path: wsPath,
      ...(wsUrl ? { ws_url: wsUrl } : {}),
    });
  }

  if (
    (await countFramesForAccount(db, linkedClient.accountId)) >=
    maxFramesPerAccount
  ) {
    return jsonError("frame_quota_exceeded", 403, {
      max_frames: maxFramesPerAccount,
    });
  }

  // The device-flow consent screen already proved ownership → born active.
  const [frame] = await db
    .insert(frames)
    .values({
      accountId: linkedClient.accountId,
      frameosVersion: input.frameosVersion ?? null,
      hardware: input.hardware,
      linkedClientId: linkedClient.id,
      name: input.name ?? linkedClient.publicDisplayName,
      publicKey: input.publicKey,
      status: "active",
    })
    .returning();
  if (!frame) {
    return jsonError("frame_insert_failed", 500);
  }

  await recordAuditEvent(db, {
    accountId: linkedClient.accountId,
    actor: { kind: "frame_enrollment", linkedClientId: linkedClient.id },
    eventType: "frame.enrolled",
    metadata: { via: "device_flow" },
    target: { frameId: frame.id, linkedClientId: linkedClient.id },
  });

  return NextResponse.json({
    frame_id: frame.id,
    scope: linkedClientScopes(linkedClient).join(" "),
    status: frame.status,
    ws_path: wsPath,
    ...(wsUrl ? { ws_url: wsUrl } : {}),
  });
}
