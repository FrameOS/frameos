import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  accountIdentities,
  accountPasskeys,
  accountRecoveryCodes,
  accounts,
  accountTotp,
  auditEvents,
  createDb,
  passwordProviderIssuer,
  sessions,
} from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as disableTwoFactor } from "../../../app/api/account/two-factor/disable/route";
import { POST as passkeyRegistrationOptions } from "../../../app/api/account/two-factor/passkeys/options/route";
import { POST as registerPasskey } from "../../../app/api/account/two-factor/passkeys/route";
import { POST as regenerateRecoveryCodes } from "../../../app/api/account/two-factor/recovery-codes/route";
import { GET as twoFactorStatus } from "../../../app/api/account/two-factor/route";
import { POST as confirmTotp } from "../../../app/api/account/two-factor/totp/confirm/route";
import {
  DELETE as removeTotp,
  POST as startTotp,
} from "../../../app/api/account/two-factor/totp/route";
import { POST as login } from "../../../app/api/auth/login/route";
import { POST as passkeySignInOptions } from "../../../app/api/auth/passkey/options/route";
import { POST as passkeySignInVerify } from "../../../app/api/auth/passkey/verify/route";
import { POST as secondFactorCode } from "../../../app/api/auth/second-factor/code/route";
import { POST as secondFactorPasskeyOptions } from "../../../app/api/auth/second-factor/passkey/options/route";
import { POST as signup } from "../../../app/api/auth/signup/route";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { createSession, readSession, sessionCookieName } from "../../lib/session";
import {
  pendingSignInCookieName,
  totpCodeAtStep,
  totpStepFor,
} from "../../lib/two-factor";
import { webauthnChallengeCookieName } from "../../lib/webauthn";

const cookieJar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
  headers: async () => new Headers(),
}));

const baseUrl = "http://localhost:3000";
const db = createDb();
let userCounter = 0;
const password = "a long enough password";

afterAll(async () => {
  await db.$client.end({ timeout: 5 });
});

beforeEach(async () => {
  resetRateLimitForTests();
  cookieJar.clear();
  const tables = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  const names = tables
    .map((row) => row.tablename)
    .filter((name) => name !== "schema_migrations")
    .map((name) => `"${name}"`);
  if (names.length > 0) {
    await db.execute(sql.raw(`TRUNCATE TABLE ${names.join(", ")} CASCADE`));
  }
});

function request(
  path: string,
  options: {
    body?: unknown;
    cookies?: Record<string, string>;
    method?: string;
  } = {},
) {
  const cookieHeader = Object.entries(options.cookies ?? {})
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  return new NextRequest(new URL(path, baseUrl), {
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    headers: {
      "content-type": "application/json",
      origin: baseUrl,
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
    method: options.method ?? "POST",
  });
}

// Set-Cookie values from a route response, by name.
function responseCookies(response: Response) {
  const jar = new Map<string, string>();
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    const eqIndex = pair?.indexOf("=") ?? -1;
    if (pair && eqIndex > 0) {
      jar.set(pair.slice(0, eqIndex), pair.slice(eqIndex + 1));
    }
  }
  return jar;
}

async function signUpVerifiedUser() {
  userCounter += 1;
  const email = `two-factor-${userCounter}@example.com`;
  const response = await signup(
    request("/api/auth/signup", {
      body: { email, name: `Two Factor ${userCounter}`, password },
    }),
  );
  expect(response.status).toBe(200);
  const [account] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.primaryEmail, email))
    .limit(1);
  if (!account) {
    throw new Error("signup did not create an account");
  }
  await db
    .update(accountIdentities)
    .set({ emailVerified: true })
    .where(eq(accountIdentities.accountId, account.id));
  return { accountId: account.id, email };
}

async function establishSession(accountId: string, email: string) {
  const token = await createSession(db, {
    accountId,
    email,
    providerIssuer: passwordProviderIssuer,
    providerSubject: email,
  });
  cookieJar.set(sessionCookieName, token);
  return token;
}

// Enrolls an authenticator through the real routes and returns the secret
// plus the recovery codes handed out on confirmation.
async function enrollTotp() {
  const start = await startTotp(request("/api/account/two-factor/totp", { body: { password } }));
  expect(start.status).toBe(200);
  const started = (await start.json()) as { otpauth_url: string; secret: string };
  expect(started.secret).toMatch(/^[A-Z2-7]{32}$/);
  expect(started.otpauth_url).toContain("otpauth://totp/");

  const confirm = await confirmTotp(
    request("/api/account/two-factor/totp/confirm", {
      body: { code: totpCodeAtStep(started.secret, totpStepFor()) },
    }),
  );
  expect(confirm.status).toBe(200);
  const confirmed = (await confirm.json()) as { recovery_codes?: string[] };
  expect(confirmed.recovery_codes).toHaveLength(10);
  return { recoveryCodes: confirmed.recovery_codes!, secret: started.secret };
}

async function latestAuditTypes(accountId: string, limit = 5) {
  const rows = await db
    .select({ eventType: auditEvents.eventType, metadata: auditEvents.metadata })
    .from(auditEvents)
    .where(eq(auditEvents.accountId, accountId))
    .orderBy(desc(auditEvents.createdAt))
    .limit(limit);
  return rows;
}

describe("authenticator app enrollment", () => {
  it("needs a session", async () => {
    const response = await startTotp(request("/api/account/two-factor/totp", { body: { password } }));
    expect(response.status).toBe(401);
  });

  it("reports off, enrolls, and reports on", async () => {
    const user = await signUpVerifiedUser();
    await establishSession(user.accountId, user.email);

    const before = await twoFactorStatus(
      request("/api/account/two-factor", { method: "GET" }),
    );
    expect(await before.json()).toMatchObject({
      enabled: false,
      has_password: true,
      passkeys: [],
      recovery_codes_remaining: 0,
      totp_enabled: false,
    });

    await enrollTotp();

    const after = await twoFactorStatus(
      request("/api/account/two-factor", { method: "GET" }),
    );
    expect(await after.json()).toMatchObject({
      enabled: true,
      recovery_codes_remaining: 10,
      totp_enabled: true,
      totp_pending: false,
    });
    const events = await latestAuditTypes(user.accountId);
    expect(events.map((row) => row.eventType)).toContain("account.totp_enabled");
  });

  it("rejects a wrong confirmation code and keeps the secret pending", async () => {
    const user = await signUpVerifiedUser();
    await establishSession(user.accountId, user.email);
    const start = await startTotp(request("/api/account/two-factor/totp", { body: { password } }));
    expect(start.status).toBe(200);

    const confirm = await confirmTotp(
      request("/api/account/two-factor/totp/confirm", { body: { code: "000000" } }),
    );
    expect(confirm.status).toBe(400);
    expect(await confirm.json()).toMatchObject({ error: "invalid_code" });

    const status = (await (
      await twoFactorStatus(request("/api/account/two-factor", { method: "GET" }))
    ).json()) as { enabled: boolean; totp_pending: boolean };
    expect(status).toMatchObject({ enabled: false, totp_pending: true });

    // A pending secret never gates sign-in.
    const signIn = await login(
      request("/api/auth/login", { body: { email: user.email, password } }),
    );
    expect(signIn.status).toBe(200);
    expect(responseCookies(signIn).has(sessionCookieName)).toBe(true);
  });

  it("needs the account's password to start enrollment, when it has one", async () => {
    const user = await signUpVerifiedUser();
    await establishSession(user.accountId, user.email);

    const missing = await startTotp(request("/api/account/two-factor/totp", { body: {} }));
    expect(missing.status).toBe(403);
    expect(await missing.json()).toMatchObject({ error: "invalid_password" });

    const wrong = await startTotp(
      request("/api/account/two-factor/totp", { body: { password: "not it" } }),
    );
    expect(wrong.status).toBe(403);

    // Nothing was minted: no pending secret sits on the account.
    expect(
      await db.select().from(accountTotp).where(eq(accountTotp.accountId, user.accountId)),
    ).toHaveLength(0);

    const right = await startTotp(
      request("/api/account/two-factor/totp", { body: { password } }),
    );
    expect(right.status).toBe(200);
  });

  it("starts enrollment on the session alone when the account has no password", async () => {
    // A Google-first account: an identity row, no password hash.
    const [account] = await db
      .insert(accounts)
      .values({ displayName: "No Password", primaryEmail: "no-password@example.com" })
      .returning({ id: accounts.id });
    await establishSession(account!.id, "no-password@example.com");
    const start = await startTotp(request("/api/account/two-factor/totp", { body: {} }));
    expect(start.status).toBe(200);
  });

  it("refuses to restart enrollment once confirmed", async () => {
    const user = await signUpVerifiedUser();
    await establishSession(user.accountId, user.email);
    await enrollTotp();
    const again = await startTotp(request("/api/account/two-factor/totp", { body: { password } }));
    expect(again.status).toBe(409);
  });
});

describe("sign-in with a second factor", () => {
  it("withholds the session until a valid code arrives, and blocks replay", async () => {
    const user = await signUpVerifiedUser();
    await establishSession(user.accountId, user.email);
    const { secret } = await enrollTotp();
    cookieJar.clear();
    // One row: the session used for enrollment above.
    const sessionsBefore = (
      await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.accountId, user.accountId))
    ).length;

    const first = await login(
      request("/api/auth/login", { body: { email: user.email, password, return_to: "/account/frames" } }),
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      ok: true,
      redirect: "/login/verify",
      second_factor_required: true,
    });
    const firstCookies = responseCookies(first);
    expect(firstCookies.has(sessionCookieName)).toBe(false);
    const pending = firstCookies.get(pendingSignInCookieName);
    expect(pending).toBeTruthy();
    // No session row was minted by the first step.
    expect(
      await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.accountId, user.accountId)),
    ).toHaveLength(sessionsBefore);

    // A wrong code is refused and audited.
    const wrong = await secondFactorCode(
      request("/api/auth/second-factor/code", {
        body: { code: "000000" },
        cookies: { [pendingSignInCookieName]: pending! },
      }),
    );
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ error: "invalid_code" });

    // The next code finishes the sign-in, honouring return_to. (The current
    // step was already consumed by the enrollment confirmation above — the
    // replay guard is per step, and one step of drift is accepted.)
    const code = totpCodeAtStep(secret, totpStepFor() + 1);
    const second = await secondFactorCode(
      request("/api/auth/second-factor/code", {
        body: { code },
        cookies: { [pendingSignInCookieName]: pending! },
      }),
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ ok: true, redirect: "/account/frames" });
    const secondCookies = responseCookies(second);
    const sessionToken = secondCookies.get(sessionCookieName);
    expect(sessionToken).toBeTruthy();
    expect(secondCookies.get(pendingSignInCookieName)).toBe("");
    cookieJar.set(sessionCookieName, sessionToken!);
    expect((await readSession())?.accountId).toBe(user.accountId);

    const events = await latestAuditTypes(user.accountId, 3);
    expect(events[0]).toMatchObject({
      eventType: "account.signed_in",
      metadata: { method: "password", second_factor: "totp" },
    });

    // Same code again, inside its window: refused (the step was recorded).
    const replay = await secondFactorCode(
      request("/api/auth/second-factor/code", {
        body: { code },
        cookies: { [pendingSignInCookieName]: pending! },
      }),
    );
    expect(replay.status).toBe(401);
  });

  it("accepts a recovery code exactly once", async () => {
    const user = await signUpVerifiedUser();
    await establishSession(user.accountId, user.email);
    const { recoveryCodes } = await enrollTotp();
    cookieJar.clear();

    const first = await login(
      request("/api/auth/login", { body: { email: user.email, password } }),
    );
    const pending = responseCookies(first).get(pendingSignInCookieName)!;

    const recovery = await secondFactorCode(
      request("/api/auth/second-factor/code", {
        body: { code: recoveryCodes[0]!.toUpperCase() },
        cookies: { [pendingSignInCookieName]: pending },
      }),
    );
    expect(recovery.status).toBe(200);
    expect(await recovery.json()).toMatchObject({
      ok: true,
      recovery_codes_remaining: 9,
    });

    const again = await secondFactorCode(
      request("/api/auth/second-factor/code", {
        body: { code: recoveryCodes[0] },
        cookies: { [pendingSignInCookieName]: pending },
      }),
    );
    expect(again.status).toBe(401);

    // The pending cookie itself is spent: a second, still-valid recovery
    // code presented with it mints nothing — and is not consumed either.
    const spent = await secondFactorCode(
      request("/api/auth/second-factor/code", {
        body: { code: recoveryCodes[1]!.toUpperCase() },
        cookies: { [pendingSignInCookieName]: pending },
      }),
    );
    expect(spent.status).toBe(401);
    expect(await spent.json()).toMatchObject({ error: "sign_in_expired" });

    const unused = await db
      .select({ id: accountRecoveryCodes.id })
      .from(accountRecoveryCodes)
      .where(
        and(
          eq(accountRecoveryCodes.accountId, user.accountId),
          isNull(accountRecoveryCodes.usedAt),
        ),
      );
    expect(unused).toHaveLength(9);
  });

  it("refuses the second step without a pending sign-in", async () => {
    const response = await secondFactorCode(
      request("/api/auth/second-factor/code", { body: { code: "123456" } }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "sign_in_expired" });

    const options = await secondFactorPasskeyOptions(
      request("/api/auth/second-factor/passkey/options", { body: {} }),
    );
    expect(options.status).toBe(401);
  });

  it("rate-limits code guessing per account", async () => {
    const user = await signUpVerifiedUser();
    await establishSession(user.accountId, user.email);
    await enrollTotp();
    cookieJar.clear();
    const first = await login(
      request("/api/auth/login", { body: { email: user.email, password } }),
    );
    const pending = responseCookies(first).get(pendingSignInCookieName)!;
    let lastStatus = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await secondFactorCode(
        request("/api/auth/second-factor/code", {
          body: { code: "000000" },
          cookies: { [pendingSignInCookieName]: pending },
        }),
      );
      lastStatus = response.status;
    }
    expect(lastStatus).toBe(429);
  });
});

describe("weakening the account", () => {
  it("needs the password to remove the authenticator, then clears recovery codes", async () => {
    const user = await signUpVerifiedUser();
    await establishSession(user.accountId, user.email);
    await enrollTotp();

    const noProof = await removeTotp(
      request("/api/account/two-factor/totp", { body: {}, method: "DELETE" }),
    );
    expect(noProof.status).toBe(403);
    expect(await noProof.json()).toMatchObject({ error: "invalid_password" });

    const wrongProof = await removeTotp(
      request("/api/account/two-factor/totp", {
        body: { password: "not it" },
        method: "DELETE",
      }),
    );
    expect(wrongProof.status).toBe(403);

    const removed = await removeTotp(
      request("/api/account/two-factor/totp", {
        body: { password },
        method: "DELETE",
      }),
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ ok: true, two_factor_enabled: false });

    expect(
      await db.select().from(accountTotp).where(eq(accountTotp.accountId, user.accountId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(accountRecoveryCodes)
        .where(eq(accountRecoveryCodes.accountId, user.accountId)),
    ).toHaveLength(0);
    const events = await latestAuditTypes(user.accountId, 2);
    expect(events[0]?.eventType).toBe("account.two_factor_disabled");

    // Sign-in is back to one step.
    cookieJar.clear();
    const signIn = await login(
      request("/api/auth/login", { body: { email: user.email, password } }),
    );
    expect(responseCookies(signIn).has(sessionCookieName)).toBe(true);
  });

  it("regenerates recovery codes with proof and invalidates the old set", async () => {
    const user = await signUpVerifiedUser();
    await establishSession(user.accountId, user.email);
    const { recoveryCodes } = await enrollTotp();

    const denied = await regenerateRecoveryCodes(
      request("/api/account/two-factor/recovery-codes", { body: {} }),
    );
    expect(denied.status).toBe(403);

    const regenerated = await regenerateRecoveryCodes(
      request("/api/account/two-factor/recovery-codes", { body: { password } }),
    );
    expect(regenerated.status).toBe(200);
    const payload = (await regenerated.json()) as { recovery_codes: string[] };
    expect(payload.recovery_codes).toHaveLength(10);
    expect(payload.recovery_codes).not.toEqual(recoveryCodes);

    cookieJar.clear();
    const first = await login(
      request("/api/auth/login", { body: { email: user.email, password } }),
    );
    const pending = responseCookies(first).get(pendingSignInCookieName)!;
    const old = await secondFactorCode(
      request("/api/auth/second-factor/code", {
        body: { code: recoveryCodes[0] },
        cookies: { [pendingSignInCookieName]: pending },
      }),
    );
    expect(old.status).toBe(401);
    const fresh = await secondFactorCode(
      request("/api/auth/second-factor/code", {
        body: { code: payload.recovery_codes[0] },
        cookies: { [pendingSignInCookieName]: pending },
      }),
    );
    expect(fresh.status).toBe(200);
  });

  it("turns everything off with the password", async () => {
    const user = await signUpVerifiedUser();
    await establishSession(user.accountId, user.email);
    await enrollTotp();
    const response = await disableTwoFactor(
      request("/api/account/two-factor/disable", { body: { password } }),
    );
    expect(response.status).toBe(200);
    const status = (await (
      await twoFactorStatus(request("/api/account/two-factor", { method: "GET" }))
    ).json()) as { enabled: boolean };
    expect(status.enabled).toBe(false);
  });
});

describe("passkeys", () => {
  it("issues registration options bound to the account and a challenge cookie", async () => {
    const user = await signUpVerifiedUser();
    await establishSession(user.accountId, user.email);
    const response = await passkeyRegistrationOptions(
      request("/api/account/two-factor/passkeys/options", { body: { password } }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      options: { challenge: string; rp: { id: string }; user: { name: string } };
    };
    expect(payload.options.rp.id).toBe("localhost");
    expect(payload.options.user.name).toBe(user.email);
    expect(payload.options.challenge).toBeTruthy();
    expect(responseCookies(response).has(webauthnChallengeCookieName)).toBe(true);
  });

  it("needs the account's password for registration options, when it has one", async () => {
    const user = await signUpVerifiedUser();
    await establishSession(user.accountId, user.email);
    const missing = await passkeyRegistrationOptions(
      request("/api/account/two-factor/passkeys/options", { body: {} }),
    );
    expect(missing.status).toBe(403);
    expect(await missing.json()).toMatchObject({ error: "invalid_password" });
    expect(responseCookies(missing).has(webauthnChallengeCookieName)).toBe(false);

    const wrong = await passkeyRegistrationOptions(
      request("/api/account/two-factor/passkeys/options", { body: { password: "nope" } }),
    );
    expect(wrong.status).toBe(403);
  });

  it("rejects a registration without a challenge cookie or with a bogus attestation", async () => {
    const user = await signUpVerifiedUser();
    await establishSession(user.accountId, user.email);
    const noChallenge = await registerPasskey(
      request("/api/account/two-factor/passkeys", {
        body: { name: "Key", response: { id: "x" } },
      }),
    );
    expect(noChallenge.status).toBe(400);
    expect(await noChallenge.json()).toMatchObject({ error: "challenge_expired" });

    const options = await passkeyRegistrationOptions(
      request("/api/account/two-factor/passkeys/options", { body: { password } }),
    );
    const challenge = responseCookies(options).get(webauthnChallengeCookieName)!;
    const bogus = await registerPasskey(
      request("/api/account/two-factor/passkeys", {
        body: {
          name: "Key",
          response: {
            id: "AAAA",
            rawId: "AAAA",
            response: { attestationObject: "AAAA", clientDataJSON: "AAAA" },
            type: "public-key",
          },
        },
        cookies: { [webauthnChallengeCookieName]: challenge },
      }),
    );
    expect(bogus.status).toBe(400);
    expect(await bogus.json()).toMatchObject({ error: "invalid_passkey" });
    expect(
      await db.select().from(accountPasskeys).where(eq(accountPasskeys.accountId, user.accountId)),
    ).toHaveLength(0);

    // The challenge cookie is single-use: reading it once spent it, so the
    // same cookie presented again is treated as expired.
    const replayed = await registerPasskey(
      request("/api/account/two-factor/passkeys", {
        body: { name: "Key", response: { id: "x" } },
        cookies: { [webauthnChallengeCookieName]: challenge },
      }),
    );
    expect(replayed.status).toBe(400);
    expect(await replayed.json()).toMatchObject({ error: "challenge_expired" });
  });

  it("offers passwordless options anonymously and refuses an unknown credential", async () => {
    const options = await passkeySignInOptions(
      request("/api/auth/passkey/options", { body: {} }),
    );
    expect(options.status).toBe(200);
    const payload = (await options.json()) as {
      options: { allowCredentials?: unknown[]; userVerification: string };
    };
    expect(payload.options.userVerification).toBe("required");
    expect(payload.options.allowCredentials ?? []).toHaveLength(0);
    const challenge = responseCookies(options).get(webauthnChallengeCookieName)!;

    const verify = await passkeySignInVerify(
      request("/api/auth/passkey/verify", {
        body: {
          response: {
            id: "nope",
            rawId: "nope",
            response: { authenticatorData: "AAAA", clientDataJSON: "AAAA", signature: "AAAA" },
            type: "public-key",
          },
        },
        cookies: { [webauthnChallengeCookieName]: challenge },
      }),
    );
    expect(verify.status).toBe(401);
    expect(responseCookies(verify).has(sessionCookieName)).toBe(false);
  });
});
