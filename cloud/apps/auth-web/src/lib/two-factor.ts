// Optional second factors for cloud accounts: authenticator-app codes (TOTP,
// RFC 6238), passkeys (see ./webauthn.ts) and single-use recovery codes.
//
// Two-factor is ON for an account exactly when it has a confirmed TOTP secret
// or at least one passkey. Sign-in then stops short of a session: the
// password/Google step mints a short-lived "pending sign-in" token (a signed
// JWT in an httpOnly cookie) and the second step — TOTP, passkey or recovery
// code — exchanges it for the real session. Nothing about the pending token
// grants access on its own; it only proves the first factor passed.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import {
  accountPasskeys,
  accountRecoveryCodes,
  accountTotp,
  type createDb,
} from "@frameos-cloud/db";
import { derivedSigningKey } from "./keys";
import { decryptSecret, encryptSecret } from "./secrets";
import type { SessionProfile } from "./session";

export const totpIssuer = "FrameOS Cloud";
export const totpStepSeconds = 30;
export const totpDigits = 6;
// One step either side: phone clocks drift.
const totpWindow = 1;

export const recoveryCodeCount = 10;
const recoveryCodeAlphabet = "abcdefghjkmnpqrstuvwxyz23456789";

export const pendingSignInCookieName = "frameos_signin_pending";
export const pendingSignInMaxAgeSeconds = 10 * 60;

export type SecondFactorMethod = "passkey" | "recovery_code" | "totp";

// ---------------------------------------------------------------------------
// TOTP

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += base32Alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += base32Alphabet[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string) {
  const cleaned = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of cleaned) {
    value = (value << 5) | base32Alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret() {
  // 160 bits, the RFC 4226 recommendation; base32 so it pastes into any app.
  return base32Encode(randomBytes(20));
}

export function totpCodeAtStep(secret: string, step: number) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", base32Decode(secret))
    .update(counter)
    .digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** totpDigits).padStart(totpDigits, "0");
}

export function totpStepFor(now = Date.now()) {
  return Math.floor(now / 1000 / totpStepSeconds);
}

export function normalizeTotpCode(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }
  const digits = value.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(digits) ? digits : undefined;
}

// Returns the matching step when `code` is valid for `secret` within the
// drift window and strictly newer than `lastUsedStep`, else undefined. The
// caller persists the returned step — that is what stops replay.
export function verifyTotpCode(
  secret: string,
  code: string,
  options: { lastUsedStep?: number | null | undefined; now?: number } = {},
) {
  const current = totpStepFor(options.now);
  const lastUsed = options.lastUsedStep ?? -1;
  const expected = Buffer.from(code);
  let matched: number | undefined;
  // Check every candidate (no early return) so timing does not reveal which
  // step matched.
  for (let delta = -totpWindow; delta <= totpWindow; delta += 1) {
    const step = current + delta;
    const candidate = Buffer.from(totpCodeAtStep(secret, step));
    if (
      candidate.length === expected.length &&
      timingSafeEqual(candidate, expected) &&
      step > lastUsed
    ) {
      matched = step;
    }
  }
  return matched;
}

export function totpProvisioningUri(secret: string, accountLabel: string) {
  const label = encodeURIComponent(`${totpIssuer}:${accountLabel}`);
  const params = new URLSearchParams({
    algorithm: "SHA1",
    digits: String(totpDigits),
    issuer: totpIssuer,
    period: String(totpStepSeconds),
    secret,
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Recovery codes

// Keyed hash, like device user codes: a 50-bit code hashed with plain SHA-256
// is cheap to brute-force for anyone who can read the table.
export function hashRecoveryCode(code: string) {
  return createHmac("sha256", derivedSigningKey("recovery-code"))
    .update(normalizeRecoveryCode(code))
    .digest("base64url");
}

export function normalizeRecoveryCode(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function looksLikeRecoveryCode(value: unknown): value is string {
  return typeof value === "string" && normalizeRecoveryCode(value).length === 10;
}

export function generateRecoveryCodes(count = recoveryCodeCount) {
  const codes: string[] = [];
  while (codes.length < count) {
    const bytes = randomBytes(10);
    let code = "";
    for (const byte of bytes) {
      code += recoveryCodeAlphabet[byte % recoveryCodeAlphabet.length];
    }
    codes.push(`${code.slice(0, 5)}-${code.slice(5)}`);
  }
  return codes;
}

// Replaces every recovery code on the account and returns the new plaintext
// set — the only time the caller ever sees it.
export async function regenerateRecoveryCodes(
  db: ReturnType<typeof createDb>,
  accountId: string,
) {
  const codes = generateRecoveryCodes();
  await db.transaction(async (tx) => {
    await tx
      .delete(accountRecoveryCodes)
      .where(eq(accountRecoveryCodes.accountId, accountId));
    await tx.insert(accountRecoveryCodes).values(
      codes.map((code) => ({ accountId, codeHash: hashRecoveryCode(code) })),
    );
  });
  return codes;
}

// Burns a recovery code. Returns true when it was valid and unused.
export async function consumeRecoveryCode(
  db: ReturnType<typeof createDb>,
  accountId: string,
  code: string,
) {
  const updated = await db
    .update(accountRecoveryCodes)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(accountRecoveryCodes.accountId, accountId),
        eq(accountRecoveryCodes.codeHash, hashRecoveryCode(code)),
        isNull(accountRecoveryCodes.usedAt),
      ),
    )
    .returning({ id: accountRecoveryCodes.id });
  return updated.length > 0;
}

// ---------------------------------------------------------------------------
// Account state

export type PasskeySummary = {
  backedUp: boolean;
  createdAt: Date;
  id: string;
  lastUsedAt: Date | null;
  name: string;
};

export type SecondFactorStatus = {
  enabled: boolean;
  passkeys: PasskeySummary[];
  recoveryCodesRemaining: number;
  totpEnabled: boolean;
  // A secret was generated but never confirmed with a code.
  totpPending: boolean;
};

export async function secondFactorStatus(
  db: ReturnType<typeof createDb>,
  accountId: string,
): Promise<SecondFactorStatus> {
  const [totpRow] = await db
    .select({ confirmedAt: accountTotp.confirmedAt })
    .from(accountTotp)
    .where(eq(accountTotp.accountId, accountId))
    .limit(1);
  const passkeys = await db
    .select({
      backedUp: accountPasskeys.backedUp,
      createdAt: accountPasskeys.createdAt,
      id: accountPasskeys.id,
      lastUsedAt: accountPasskeys.lastUsedAt,
      name: accountPasskeys.name,
    })
    .from(accountPasskeys)
    .where(eq(accountPasskeys.accountId, accountId))
    .orderBy(desc(accountPasskeys.createdAt));
  const [remaining] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(accountRecoveryCodes)
    .where(
      and(
        eq(accountRecoveryCodes.accountId, accountId),
        isNull(accountRecoveryCodes.usedAt),
      ),
    );
  const totpEnabled = Boolean(totpRow?.confirmedAt);
  return {
    enabled: totpEnabled || passkeys.length > 0,
    passkeys,
    recoveryCodesRemaining: remaining?.count ?? 0,
    totpEnabled,
    totpPending: Boolean(totpRow) && !totpEnabled,
  };
}

// Cheap variant for the sign-in path: which second factors can satisfy the
// challenge, without the full listing.
export async function availableSecondFactors(
  db: ReturnType<typeof createDb>,
  accountId: string,
) {
  const status = await secondFactorStatus(db, accountId);
  return {
    enabled: status.enabled,
    passkeys: status.passkeys.length > 0,
    recoveryCodes: status.recoveryCodesRemaining > 0,
    totp: status.totpEnabled,
  };
}

export async function confirmedTotpSecret(
  db: ReturnType<typeof createDb>,
  accountId: string,
) {
  const [row] = await db
    .select({
      confirmedAt: accountTotp.confirmedAt,
      encryptedSecret: accountTotp.encryptedSecret,
      lastUsedStep: accountTotp.lastUsedStep,
    })
    .from(accountTotp)
    .where(eq(accountTotp.accountId, accountId))
    .limit(1);
  if (!row?.confirmedAt) {
    return undefined;
  }
  return {
    lastUsedStep: row.lastUsedStep,
    secret: decryptSecret(row.encryptedSecret),
  };
}

// Starts (or restarts) TOTP enrollment: a fresh secret, unconfirmed. An
// already-confirmed authenticator is left alone — disable it first.
export async function beginTotpEnrollment(
  db: ReturnType<typeof createDb>,
  accountId: string,
) {
  const secret = generateTotpSecret();
  const now = new Date();
  const inserted = await db
    .insert(accountTotp)
    .values({
      accountId,
      createdAt: now,
      encryptedSecret: encryptSecret(secret),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      set: {
        encryptedSecret: encryptSecret(secret),
        lastUsedStep: null,
        updatedAt: now,
      },
      target: accountTotp.accountId,
      setWhere: isNull(accountTotp.confirmedAt),
    })
    .returning({ encryptedSecret: accountTotp.encryptedSecret });
  if (inserted.length === 0) {
    return undefined;
  }
  return secret;
}

// Verifies a code against the pending (unconfirmed) secret and, when it
// matches, marks the authenticator confirmed. Returns true on success.
export async function confirmTotpEnrollment(
  db: ReturnType<typeof createDb>,
  accountId: string,
  code: string,
) {
  const [row] = await db
    .select({
      confirmedAt: accountTotp.confirmedAt,
      encryptedSecret: accountTotp.encryptedSecret,
    })
    .from(accountTotp)
    .where(eq(accountTotp.accountId, accountId))
    .limit(1);
  if (!row || row.confirmedAt) {
    return false;
  }
  const step = verifyTotpCode(decryptSecret(row.encryptedSecret), code);
  if (step === undefined) {
    return false;
  }
  const now = new Date();
  await db
    .update(accountTotp)
    .set({ confirmedAt: now, lastUsedStep: step, updatedAt: now })
    .where(
      and(eq(accountTotp.accountId, accountId), isNull(accountTotp.confirmedAt)),
    );
  return true;
}

// Checks a code against the confirmed authenticator and records the step so
// the same code cannot be used twice. Returns true on success.
export async function verifyAccountTotp(
  db: ReturnType<typeof createDb>,
  accountId: string,
  code: string,
) {
  const totp = await confirmedTotpSecret(db, accountId);
  if (!totp) {
    return false;
  }
  const step = verifyTotpCode(totp.secret, code, {
    lastUsedStep: totp.lastUsedStep,
  });
  if (step === undefined) {
    return false;
  }
  // The WHERE on last_used_step makes two concurrent submissions of the same
  // code race to a single winner.
  const updated = await db
    .update(accountTotp)
    .set({ lastUsedStep: step, updatedAt: new Date() })
    .where(
      and(
        eq(accountTotp.accountId, accountId),
        sql`coalesce(${accountTotp.lastUsedStep}, -1) < ${step}`,
      ),
    )
    .returning({ accountId: accountTotp.accountId });
  return updated.length > 0;
}

export async function removeTotp(
  db: ReturnType<typeof createDb>,
  accountId: string,
) {
  const deleted = await db
    .delete(accountTotp)
    .where(eq(accountTotp.accountId, accountId))
    .returning({ accountId: accountTotp.accountId });
  return deleted.length > 0;
}

// When the last second factor goes, the recovery codes go with it: they only
// ever stood in for a factor that no longer exists.
export async function clearRecoveryCodesIfNoFactors(
  db: ReturnType<typeof createDb>,
  accountId: string,
) {
  const status = await secondFactorStatus(db, accountId);
  if (!status.enabled) {
    await db
      .delete(accountRecoveryCodes)
      .where(eq(accountRecoveryCodes.accountId, accountId));
  }
  return status;
}

// Accepts either an authenticator code or a recovery code as proof of the
// second factor; tells the caller which one matched.
export async function verifySecondFactorCode(
  db: ReturnType<typeof createDb>,
  accountId: string,
  rawCode: unknown,
): Promise<"recovery_code" | "totp" | undefined> {
  const totpCode = normalizeTotpCode(rawCode);
  if (totpCode && (await verifyAccountTotp(db, accountId, totpCode))) {
    return "totp";
  }
  if (
    looksLikeRecoveryCode(rawCode) &&
    (await consumeRecoveryCode(db, accountId, rawCode))
  ) {
    return "recovery_code";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Pending sign-in token (first factor passed, second outstanding)

export type PendingSignIn = {
  // Extra facts for the account.signed_in audit row (e.g. the Google email).
  auditMetadata?: Record<string, unknown> | undefined;
  method: "google" | "password";
  profile: SessionProfile & { accountId: string };
  returnTo?: string | undefined;
};

function pendingKey() {
  return derivedSigningKey("pending-sign-in");
}

export async function createPendingSignInToken(pending: PendingSignIn) {
  return new SignJWT({ pending })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${pendingSignInMaxAgeSeconds}s`)
    .sign(pendingKey());
}

export async function readPendingSignInToken(token: string | undefined) {
  if (!token) {
    return undefined;
  }
  try {
    const verified = await jwtVerify(token, pendingKey());
    const pending = verified.payload.pending as PendingSignIn | undefined;
    if (
      !pending ||
      typeof pending !== "object" ||
      typeof pending.profile?.accountId !== "string"
    ) {
      return undefined;
    }
    return pending;
  } catch {
    return undefined;
  }
}

export function pendingSignInCookieOptions() {
  return {
    httpOnly: true,
    maxAge: pendingSignInMaxAgeSeconds,
    path: "/",
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
  };
}
