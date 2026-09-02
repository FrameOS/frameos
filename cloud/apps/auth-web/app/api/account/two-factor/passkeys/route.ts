// Passkey registration, step 2: verify the attestation and store the
// credential. The first second factor on the account also mints recovery
// codes, returned exactly once.
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { NextRequest, NextResponse } from "next/server";
import {
  accountSecurityContext,
  readJsonBody,
} from "../../../../../src/lib/account-security";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { requireDatabase } from "../../../../../src/lib/device-flow";
import {
  regenerateRecoveryCodes,
  secondFactorStatus,
} from "../../../../../src/lib/two-factor";
import {
  normalizePasskeyName,
  readChallengeToken,
  storePasskey,
  verifyPasskeyRegistration,
  webauthnChallengeCookieName,
  webauthnChallengeCookieOptions,
} from "../../../../../src/lib/webauthn";

export async function POST(request: NextRequest) {
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const context = await accountSecurityContext(request, db, {
    action: "two-factor-passkeys",
    mutating: true,
    recentAuth: true,
  });
  if ("response" in context) {
    return context.response;
  }
  const challenge = await readChallengeToken(
    request.cookies.get(webauthnChallengeCookieName)?.value,
    "register",
  );
  if (!challenge || challenge.accountId !== context.accountId) {
    return NextResponse.json({ error: "challenge_expired" }, { status: 400 });
  }
  const body = await readJsonBody(request);
  const attestation = body?.response as RegistrationResponseJSON | undefined;
  if (!attestation || typeof attestation !== "object") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  let info: Awaited<ReturnType<typeof verifyPasskeyRegistration>>;
  try {
    info = await verifyPasskeyRegistration(attestation, challenge.challenge);
  } catch {
    info = undefined;
  }
  if (!info) {
    return NextResponse.json({ error: "invalid_passkey" }, { status: 400 });
  }
  const before = await secondFactorStatus(db, context.accountId);
  const name = normalizePasskeyName(
    body?.name,
    `Passkey ${before.passkeys.length + 1}`,
  );
  const transports = Array.isArray(attestation.response?.transports)
    ? attestation.response.transports
        .filter((value) => typeof value === "string")
        .map((value) => String(value))
    : undefined;
  const passkeyId = await storePasskey(
    db,
    context.accountId,
    name,
    info,
    transports,
  );
  if (!passkeyId) {
    return NextResponse.json({ error: "passkey_exists" }, { status: 409 });
  }
  const recoveryCodes =
    before.enabled && before.recoveryCodesRemaining > 0
      ? undefined
      : await regenerateRecoveryCodes(db, context.accountId);
  await recordAuditEvent(db, {
    accountId: context.accountId,
    actor: {
      accountId: context.accountId,
      providerSubject: context.providerSubject,
    },
    eventType: "account.passkey_added",
    metadata: { method: "passkey", name },
    target: { passkeyId },
  });
  const result = NextResponse.json({
    ok: true,
    passkey: { id: passkeyId, name },
    ...(recoveryCodes ? { recovery_codes: recoveryCodes } : {}),
  });
  result.cookies.set(webauthnChallengeCookieName, "", {
    ...webauthnChallengeCookieOptions(),
    maxAge: 0,
  });
  return result;
}
