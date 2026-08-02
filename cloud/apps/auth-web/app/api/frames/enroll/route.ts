import { eq } from "drizzle-orm";
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
  isValidEd25519PublicKey,
  maxFramesPerAccount,
  redeemClaimToken,
} from "../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { createEncryptedSecretToken, hashSecret } from "../../../../src/lib/secrets";

export const runtime = "nodejs";

const wsPath = "/api/frames/ws";

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

  if (claimToken) {
    return enrollWithClaimToken(db, {
      claimToken,
      frameosVersion,
      hardware,
      name,
      publicKey,
    });
  }
  if (authorizationHeader) {
    return enrollLinkedFrame(db, authorizationHeader, {
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

async function enrollWithClaimToken(
  db: NonNullable<ReturnType<typeof requireDatabase>["db"]>,
  input: EnrollInput & { claimToken: string },
) {
  // Atomic budget spend: single-use tokens admit exactly one enrollment;
  // multi-use tokens (SD images flashed to many cards) admit max_uses. A
  // replay past the budget or expiry sees invalid_claim_token.
  const token = await redeemClaimToken(db, input.claimToken, hashSecret);
  if (!token) {
    return jsonError("invalid_claim_token", 400);
  }

  if ((await countFramesForAccount(db, token.accountId)) >= maxFramesPerAccount) {
    return jsonError("frame_quota_exceeded", 403, {
      max_frames: maxFramesPerAccount,
    });
  }

  const displayName = input.name ?? token.name ?? "FrameOS frame";
  const accessToken = createEncryptedSecretToken("fc_link");

  const frame = await db.transaction(async (tx) => {
    const [linkedClient] = await tx
      .insert(linkedClients)
      .values({
        accountId: token.accountId,
        clientKind: "frame",
        providerClientMetadata: {
          enrolledVia: "claim_token",
          requestedScopes: [frameManagedScope],
        },
        publicDisplayName: displayName,
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
        name: displayName,
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
    return insertedFrame;
  });

  await recordAuditEvent(db, {
    accountId: token.accountId,
    actor: { claimTokenId: token.id, kind: "frame_enrollment" },
    eventType: "frame.enrolled",
    metadata: { via: "claim_token" },
    target: { frameId: frame.id, linkedClientId: frame.linkedClientId },
  });

  return NextResponse.json({
    access_token: accessToken.token,
    frame_id: frame.id,
    scope: frameManagedScope,
    status: frame.status,
    token_type: "Bearer",
    ws_path: wsPath,
  });
}

async function enrollLinkedFrame(
  db: NonNullable<ReturnType<typeof requireDatabase>["db"]>,
  authorizationHeader: string,
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
  });
}
