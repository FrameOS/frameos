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
    target: { claimTokenId: row.id },
  });

  return NextResponse.json({
    claim_token: token,
    expires_at: expiresAt.toISOString(),
  });
}
