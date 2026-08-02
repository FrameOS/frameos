import { and, eq, isNull } from "drizzle-orm";
import { frameosLoginCodes } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { authenticateLinkedClient } from "../../../../../src/lib/backend-auth";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../../src/lib/device-flow";
import { parseFrameosLoginCodeProfile } from "../../../../../src/lib/frameos-login";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { hashSecret } from "../../../../../src/lib/secrets";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const limited = rateLimitResponse(request, "frameos-login:token", {
    limit: 120,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  const linkedClient = await authenticateLinkedClient(
    db,
    request.headers.get("authorization"),
  );
  if (!linkedClient) {
    return jsonError("invalid_link_token", 401);
  }

  const body = await readJsonObject(request);
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!code) {
    return jsonError("invalid_code", 400);
  }

  // Atomically claim the code: bound to this linked client, unredeemed, and
  // unexpired. A replayed or stolen code fails here.
  const [redeemed] = await db
    .update(frameosLoginCodes)
    .set({ redeemedAt: new Date() })
    .where(
      and(
        eq(frameosLoginCodes.codeHash, hashSecret(code)),
        eq(frameosLoginCodes.linkedClientId, linkedClient.id),
        isNull(frameosLoginCodes.redeemedAt),
      ),
    )
    .returning({
      expiresAt: frameosLoginCodes.expiresAt,
      profile: frameosLoginCodes.profile,
    });

  if (!redeemed || redeemed.expiresAt <= new Date()) {
    return jsonError("invalid_code", 400);
  }

  const profile = parseFrameosLoginCodeProfile(redeemed.profile);
  if (!profile) {
    return jsonError("invalid_code", 400);
  }

  return NextResponse.json({
    claims: {
      account_id: profile.accountId,
      email: profile.email,
      email_verified: profile.emailVerified ?? false,
      name: profile.name,
      provider_subject: profile.providerSubject,
      sub: profile.providerSubject,
    },
    provider_issuer: profile.providerIssuer,
  });
}
