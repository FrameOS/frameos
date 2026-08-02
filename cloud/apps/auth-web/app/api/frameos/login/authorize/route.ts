import { and, eq, isNull } from "drizzle-orm";
import { frameosLoginCodes, linkedClients } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { linkedClientHasScope } from "../../../../../src/lib/backend-auth";
import { requireDatabase } from "../../../../../src/lib/device-flow";
import {
  loginCodeExpiresInSeconds,
  verifyFrameosLoginRequestToken,
  type FrameosLoginCodeProfile,
  type FrameosLoginRequest,
} from "../../../../../src/lib/frameos-login";
import { createSecretToken, hashSecret } from "../../../../../src/lib/secrets";
import { readSession } from "../../../../../src/lib/session";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const requestToken = request.nextUrl.searchParams.get("request") ?? "";
  const loginRequest = await verifyFrameosLoginRequestToken(requestToken);
  if (!loginRequest) {
    return NextResponse.redirect(
      new URL("/login?error=invalid_state", request.url),
    );
  }

  const session = await readSession();
  if (!session?.accountId) {
    const returnTo = `/api/frameos/login/authorize?request=${encodeURIComponent(requestToken)}`;
    return NextResponse.redirect(
      new URL(`/login?return_to=${encodeURIComponent(returnTo)}`, request.url),
    );
  }

  const { db } = requireDatabase();
  if (!db) {
    return redirectWithError(loginRequest, "provider_unavailable");
  }

  const [linkedClient] = await db
    .select({
      id: linkedClients.id,
      providerClientMetadata: linkedClients.providerClientMetadata,
    })
    .from(linkedClients)
    .where(
      and(
        eq(linkedClients.id, loginRequest.linkedClientId),
        eq(linkedClients.accountId, session.accountId),
        isNull(linkedClients.revokedAt),
      ),
    )
    .limit(1);

  if (!linkedClient) {
    return redirectWithError(loginRequest, "linked_client_required");
  }

  // Re-check the scope rather than trusting the request token minted at
  // /start: that token lives for 10 minutes, so without this a scope removed
  // in the meantime still yields a login code for the rest of its life.
  if (!linkedClientHasScope(linkedClient, "auth:login")) {
    return redirectWithError(loginRequest, "insufficient_scope");
  }

  // The code in the redirect URL is an opaque single-use token. The profile
  // claims stay server-side and are released only at the token endpoint, so
  // browser history and proxy/access logs never see PII.
  const profile: FrameosLoginCodeProfile = {
    accountId: session.accountId,
    email: session.email,
    emailVerified: session.emailVerified,
    name: session.name,
    providerIssuer: session.providerIssuer,
    providerSubject: session.providerSubject,
  };
  const code = createSecretToken("fc_login", 32);
  await db.insert(frameosLoginCodes).values({
    codeHash: hashSecret(code),
    expiresAt: new Date(Date.now() + loginCodeExpiresInSeconds * 1000),
    linkedClientId: linkedClient.id,
    profile,
  });

  const redirect = new URL(loginRequest.redirectUri);
  redirect.searchParams.set("code", code);
  redirect.searchParams.set("state", loginRequest.state);
  return NextResponse.redirect(redirect);
}

function redirectWithError(loginRequest: FrameosLoginRequest, error: string) {
  const redirect = new URL(loginRequest.redirectUri);
  redirect.searchParams.set("error", error);
  redirect.searchParams.set("state", loginRequest.state);
  return NextResponse.redirect(redirect);
}
