import { frameEnrollmentTokens } from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { csrfResponse } from "../../../../src/lib/csrf";
import {
  jsonError,
  parseOptionalString,
  readJsonObject,
  requireDatabase,
} from "../../../../src/lib/device-flow";
import {
  boundClaimTokenTtlMs,
  claimTokenExpiry,
  claimTokenPrefix,
  countActiveClaimTokens,
  countFramesForAccount,
  evictOldestUnusedClaimTokens,
  frameForAccount,
  maxClaimTokensPerAccount,
  maxFramesPerAccount,
  sweepExpiredClaimTokens,
} from "../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { createSecretToken, hashSecret } from "../../../../src/lib/secrets";
import { readSession } from "../../../../src/lib/session";

export const runtime = "nodejs";

// Mint a single-use claim token for "Add frame" (wire contract:
// docs/cloud-frames.md, enrollment flow A). The token is shown once and
// stored only as a hash.
//
// With `frame_id` it mints a RE-ENROLLMENT token instead: bound to a frame
// this account already owns, so redeeming it re-keys that frame (new device
// key, rotated link token) rather than enrolling a second row for the same
// physical board. That is the path for moving a board or rescuing one whose
// NVS was erased. Bound tokens are always single-use, expire in an hour, and
// do NOT consume frame quota — no frame is created.
export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  // Has to stay above the outstanding-code cap, or an account cannot reach a
  // quota it is allowed to hold. Abuse is bounded by the cap itself (and by
  // recycling, which makes hammering this endpoint pointless), so the rate
  // limit only needs to stop a runaway loop.
  const limited = await rateLimitResponse(request, "frames:claim-tokens", {
    limit: Math.max(30, maxClaimTokensPerAccount + 10),
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const session = await readSession();
  if (!session?.accountId) {
    return jsonError("login_required", 401);
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  const body = await readJsonObject(request);
  const name = parseOptionalString(body.name)?.slice(0, 256);

  // Re-enrollment: bind the token to one of the account's own frames.
  // frameForAccount IS the ownership check (and screens the uuid shape), so
  // someone else's frame id is a 404 — invisible, not forbidden.
  const boundFrameId = parseOptionalString(body.frame_id);
  let boundFrame: Awaited<ReturnType<typeof frameForAccount>>;
  if (boundFrameId !== undefined) {
    boundFrame = await frameForAccount(db, session.accountId, boundFrameId);
    if (!boundFrame) {
      return jsonError("invalid_frame", 404);
    }
    // A revoked frame's link is dead; re-keying it would resurrect access the
    // owner deliberately took away. Delete it and enroll fresh instead.
    if (boundFrame.status === "revoked") {
      return jsonError("frame_revoked", 409);
    }
    // Multi-use makes no sense for a token whose whole job is to re-key ONE
    // row: a second redemption would hand a second board the same identity.
    if (body.multi_use === true || (body.max_uses !== undefined && body.max_uses !== 1)) {
      return jsonError("invalid_max_uses", 400);
    }
  }

  // Provisioning-time scene intent: every frame this token enrolls starts
  // with the scenes of a frame the account already owns. Ownership is checked
  // here, at mint time, by the same frameForAccount that guards re-enrollment
  // — the enrollment itself is unauthenticated, so it must never be the place
  // that decides whose scenes travel. Copied per frame at CONFIRMATION, so a
  // board nobody confirmed is still sent nothing.
  const sceneSourceFrameId = parseOptionalString(body.scene_source_frame_id);
  let sceneSourceFrame: Awaited<ReturnType<typeof frameForAccount>>;
  if (sceneSourceFrameId !== undefined) {
    sceneSourceFrame = await frameForAccount(
      db,
      session.accountId,
      sceneSourceFrameId,
    );
    if (!sceneSourceFrame) {
      return jsonError("invalid_scene_source_frame", 404);
    }
  }

  // Multi-use tokens back the SD-image download: one image, many cards,
  // each boot enrolls a distinct pending frame. Budget capped at the frame
  // quota — a leaked image can never enroll more than the account could
  // hold anyway, and every enrollment still needs owner confirmation.
  let maxUses = 1;
  if (body.multi_use === true) {
    maxUses = maxFramesPerAccount;
  } else if (body.max_uses !== undefined) {
    if (
      typeof body.max_uses !== "number" ||
      !Number.isInteger(body.max_uses) ||
      body.max_uses < 1 ||
      body.max_uses > maxFramesPerAccount
    ) {
      return jsonError("invalid_max_uses", 400);
    }
    maxUses = body.max_uses;
  }

  await sweepExpiredClaimTokens(db, session.accountId);
  let active = await countActiveClaimTokens(db, session.accountId);
  if (active >= maxClaimTokensPerAccount) {
    // At the cap, recycle: a hashed code that was never used is one nobody can
    // read back anyway, so the oldest of those gives way to the one being
    // minted now. Only multi-use codes (SD images, possibly already flashed)
    // are held, so an account whose cap is entirely those still gets the
    // error — with the count, so the message can say something actionable.
    const freed = await evictOldestUnusedClaimTokens(
      db,
      session.accountId,
      active - maxClaimTokensPerAccount + 1,
    );
    if (freed > 0) {
      await recordAuditEvent(db, {
        accountId: session.accountId,
        actor: {
          accountId: session.accountId,
          providerSubject: session.providerSubject,
        },
        eventType: "frame.claim_tokens_recycled",
        metadata: { freed },
      });
    }
    active -= freed;
    if (active >= maxClaimTokensPerAccount) {
      return jsonError("claim_token_quota_exceeded", 403, {
        max_claim_tokens: maxClaimTokensPerAccount,
      });
    }
  }
  // Frame quota applies to tokens that CREATE a frame. A re-enrollment token
  // re-keys a row that already counts, so an account sitting at its quota
  // must still be able to rescue a board — refusing here would make the
  // limit into a lockout.
  if (
    boundFrame === undefined &&
    (await countFramesForAccount(db, session.accountId)) >= maxFramesPerAccount
  ) {
    return jsonError("frame_quota_exceeded", 403, {
      max_frames: maxFramesPerAccount,
    });
  }

  // The default 24h expiry suits a token consumed during one add-frame flow,
  // but a multi-use code baked into an SD image is a long-lived artifact —
  // cards get flashed weeks later. Numeric values are bounded at a year;
  // "forever" mints a code that outlives any plausible deployment (100
  // years — the expires_at column stays non-null so sweep/redeem logic is
  // untouched). Expiry is what limits how long a leaked image keeps
  // enrolling, but each enrollment still needs owner confirmation and the
  // frame quota caps the blast radius, so opting out is a fair trade.
  let ttlMs: number | undefined;
  if (body.ttl_days === "forever") {
    ttlMs = 100 * 365 * 24 * 60 * 60 * 1000;
  } else if (body.ttl_days !== undefined) {
    if (
      typeof body.ttl_days !== "number" ||
      !Number.isInteger(body.ttl_days) ||
      body.ttl_days < 1 ||
      body.ttl_days > 365
    ) {
      return jsonError("invalid_ttl_days", 400);
    }
    ttlMs = body.ttl_days * 24 * 60 * 60 * 1000;
  }

  const token = createSecretToken(claimTokenPrefix, 24);
  // A bound token ignores any requested TTL: it is redeemed minutes after it
  // is minted, and it is worth more than an ordinary code.
  const expiresAt = boundFrame
    ? new Date(Date.now() + boundClaimTokenTtlMs)
    : ttlMs
      ? new Date(Date.now() + ttlMs)
      : claimTokenExpiry();
  const [row] = await db
    .insert(frameEnrollmentTokens)
    .values({
      accountId: session.accountId,
      boundFrameId: boundFrame?.id ?? null,
      expiresAt,
      maxUses,
      name: name ?? null,
      sceneSourceFrameId: sceneSourceFrame?.id ?? null,
      tokenHash: hashSecret(token),
    })
    .returning({ id: frameEnrollmentTokens.id });
  if (!row) {
    return jsonError("claim_token_failed", 500);
  }

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    eventType: boundFrame
      ? "frame.rebind_token_created"
      : "frame.claim_token_created",
    metadata: { maxUses },
    target: {
      claimTokenId: row.id,
      ...(boundFrame ? { frameId: boundFrame.id } : {}),
    },
  });

  return NextResponse.json({
    claim_token: token,
    expires_at: expiresAt.toISOString(),
    max_uses: maxUses,
    ...(sceneSourceFrame ? { scene_source_frame_id: sceneSourceFrame.id } : {}),
    // Echoed so the flasher can assert it is provisioning the frame the user
    // started from, rather than inferring one from a new-frame watch.
    ...(boundFrame ? { frame_id: boundFrame.id } : {}),
  });
}
