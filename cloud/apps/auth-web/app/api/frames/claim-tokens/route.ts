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
  claimTokenExpiry,
  claimTokenPrefix,
  countActiveClaimTokens,
  countFramesForAccount,
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
export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "frames:claim-tokens", {
    limit: 30,
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
  if (
    (await countActiveClaimTokens(db, session.accountId)) >=
    maxClaimTokensPerAccount
  ) {
    return jsonError("claim_token_quota_exceeded", 403);
  }
  if (
    (await countFramesForAccount(db, session.accountId)) >= maxFramesPerAccount
  ) {
    return jsonError("frame_quota_exceeded", 403, {
      max_frames: maxFramesPerAccount,
    });
  }

  const token = createSecretToken(claimTokenPrefix, 24);
  const expiresAt = claimTokenExpiry();
  const [row] = await db
    .insert(frameEnrollmentTokens)
    .values({
      accountId: session.accountId,
      expiresAt,
      maxUses,
      name: name ?? null,
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
    eventType: "frame.claim_token_created",
    metadata: { maxUses },
    target: { claimTokenId: row.id },
  });

  return NextResponse.json({
    claim_token: token,
    expires_at: expiresAt.toISOString(),
    max_uses: maxUses,
  });
}
