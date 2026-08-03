import { and, eq, isNull, sql } from "drizzle-orm";
import { frameEnrollmentTokens, frames, linkedClients } from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import {
  authenticateLinkedClient,
  linkedClientHasScope,
} from "../../../../src/lib/backend-auth";
import {
  jsonError,
  parseOptionalString,
  readJsonObject,
  requireDatabase,
} from "../../../../src/lib/device-flow";
import {
  countFramesForAccount,
  frameManagedScope,
  frameTelemetryLogsScope,
  frameTelemetryMetricsScope,
  isValidEd25519PublicKey,
  maxFramesPerAccount,
  redeemClaimToken,
} from "../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { createEncryptedSecretToken, hashSecret } from "../../../../src/lib/secrets";

export const runtime = "nodejs";

const wsPath = "/api/frames/ws";

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
// Flow A — unauthenticated, with a single-use claim token from "Add frame".
//   The frame is born `pending`; the owner confirms it in the account UI
//   before any scene push is accepted.
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
    console.error(
      "frames/enroll: encryption unavailable:",
      error instanceof Error ? error.message : "unknown error",
    );
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

      const name = displayName ?? token.name ?? "FrameOS frame";
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
            requestedScopes: [
              frameManagedScope,
              frameTelemetryLogsScope,
              frameTelemetryMetricsScope,
            ],
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
          status: "pending",
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
    metadata: { via: "claim_token" },
    target: {
      frameId: result.frame.id,
      linkedClientId: result.frame.linkedClientId,
    },
  });

  return NextResponse.json({
    access_token: result.accessTokenValue,
    frame_id: result.frame.id,
    scope: frameManagedScope,
    status: result.frame.status,
    token_type: "Bearer",
    ws_path: wsPath,
    ...(wsUrl ? { ws_url: wsUrl } : {}),
  });
}

// Has this exact device already enrolled with this exact claim token? Only a
// still-pending frame on a live linked client counts; the claim token itself
// is the secret that authorizes the lookup, so this grants nothing a fresh
// enrollment would not have granted.
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

  const [existing] = await db
    .select({ frame: frames })
    .from(frames)
    .innerJoin(linkedClients, eq(linkedClients.id, frames.linkedClientId))
    .where(
      and(
        eq(frames.accountId, token.accountId),
        eq(frames.publicKey, input.publicKey),
        eq(frames.status, "pending"),
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
    scope: frameManagedScope,
    status: existing.frame.status,
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
      scope: frameManagedScope,
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
    scope: frameManagedScope,
    status: frame.status,
    ws_path: wsPath,
    ...(wsUrl ? { ws_url: wsUrl } : {}),
  });
}
