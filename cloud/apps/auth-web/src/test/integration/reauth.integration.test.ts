import { desc, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  accountIdentities,
  accounts,
  auditEvents,
  createDb,
  frames,
  linkedClients,
  passwordProviderIssuer,
  sessions,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as confirmTotp } from "../../../app/api/account/two-factor/totp/confirm/route";
import { POST as startTotp } from "../../../app/api/account/two-factor/totp/route";
import { POST as reauthPasskeyOptions } from "../../../app/api/auth/reauth/passkey/options/route";
import { POST as reauthPasskeyVerify } from "../../../app/api/auth/reauth/passkey/verify/route";
import { POST as reauth } from "../../../app/api/auth/reauth/route";
import { POST as signup } from "../../../app/api/auth/signup/route";
import { POST as authorizeDevice } from "../../../app/api/device/authorize/route";
import { POST as revokeLinkedClient } from "../../../app/api/device/revoke/route";
import { POST as startDevice } from "../../../app/api/device/start/route";
import { POST as revokeFrame } from "../../../app/api/frames/[frameId]/revoke/route";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import {
  markSessionReauthenticated,
  reauthMethods,
  recentApprovalMaxAgeSeconds,
  recentAuthMaxAgeSeconds,
} from "../../lib/recent-auth";
import { hashSecret } from "../../lib/secrets";
import { createSession, sessionCookieName } from "../../lib/session";
import { totpCodeAtStep, totpStepFor } from "../../lib/two-factor";
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
const googleIssuer = "https://accounts.google.com";
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
  options: { body?: unknown; cookies?: Record<string, string>; method?: string } = {},
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

// A password account, verified, with a real session in the jar.
async function passwordUser() {
  userCounter += 1;
  const email = `reauth-${userCounter}@example.com`;
  const response = await signup(
    request("/api/auth/signup", {
      body: { email, name: `Reauth ${userCounter}`, password },
    }),
  );
  expect(response.status).toBe(200);
  const [account] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.primaryEmail, email))
    .limit(1);
  await db
    .update(accountIdentities)
    .set({ emailVerified: true })
    .where(eq(accountIdentities.accountId, account!.id));
  const token = await createSession(db, {
    accountId: account!.id,
    email,
    providerIssuer: passwordProviderIssuer,
    providerSubject: email,
  });
  cookieJar.set(sessionCookieName, token);
  return { accountId: account!.id, email, token };
}

// A Google account (no password) with a real session in the jar.
async function googleUser() {
  userCounter += 1;
  const providerSubject = `reauth-google-${userCounter}`;
  const email = `reauth-google-${userCounter}@example.com`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Reauth Google ${userCounter}`,
    email,
    emailVerified: true,
    providerIssuer: googleIssuer,
    providerKey: "google",
    providerSubject,
  });
  const token = await createSession(db, {
    accountId,
    email,
    providerIssuer: googleIssuer,
    providerSubject,
  });
  cookieJar.set(sessionCookieName, token);
  return { accountId, email, token };
}

// Pushes the session's last credential check past the freshness window.
async function ageSession(token: string, seconds = recentAuthMaxAgeSeconds + 60) {
  await db
    .update(sessions)
    .set({ authenticatedAt: new Date(Date.now() - seconds * 1000) })
    .where(eq(sessions.tokenHash, hashSecret(token)));
}

async function enrollTotp() {
  const start = await startTotp(request("/api/account/two-factor/totp", { body: {} }));
  expect(start.status).toBe(200);
  const started = (await start.json()) as { secret: string };
  const confirm = await confirmTotp(
    request("/api/account/two-factor/totp/confirm", {
      body: { code: totpCodeAtStep(started.secret, totpStepFor()) },
    }),
  );
  expect(confirm.status).toBe(200);
  const confirmed = (await confirm.json()) as { recovery_codes: string[] };
  return { recoveryCodes: confirmed.recovery_codes, secret: started.secret };
}

async function seedFrame(accountId: string) {
  const [client] = await db
    .insert(linkedClients)
    .values({
      accountId,
      clientKind: "frame",
      providerClientMetadata: { requestedScopes: ["frame:managed"] },
      publicDisplayName: "Seeded frame",
      tokenReference: hashSecret(`fc_link_seed_${accountId}`),
    })
    .returning();
  const [frame] = await db
    .insert(frames)
    .values({
      accountId,
      linkedClientId: client!.id,
      name: "Seeded frame",
      publicKey: "c2VlZGVkLXB1YmxpYy1rZXk=",
      status: "active",
    })
    .returning();
  return { frameId: frame!.id, linkedClientId: client!.id };
}

async function startDeviceRequest() {
  const response = await startDevice(
    request("/api/device/start", {
      body: {
        capabilities: { scenes: true },
        local_origin: "http://10.0.0.5:8989",
        public_display_name: "Test Backend",
        reported_frameos_version: "1.0.0",
      },
    }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { device_code: string; user_code: string };
}

async function latestAuditEvents(accountId: string, limit = 5) {
  return db
    .select({ eventType: auditEvents.eventType, metadata: auditEvents.metadata })
    .from(auditEvents)
    .where(eq(auditEvents.accountId, accountId))
    .orderBy(desc(auditEvents.createdAt))
    .limit(limit);
}

describe("sensitive routes require a recent credential check", () => {
  it("a fresh sign-in is recent enough", async () => {
    const user = await passwordUser();
    const { frameId } = await seedFrame(user.accountId);
    const response = await revokeFrame(request(`/api/frames/${frameId}/revoke`, { body: {} }), {
      params: Promise.resolve({ frameId }),
    });
    expect(response.status).toBe(200);
  });

  it("a stale session gets 403 reauth_required with the proofs on offer", async () => {
    const user = await passwordUser();
    // Older than BOTH windows, so revoke and approve alike refuse.
    await ageSession(user.token, recentApprovalMaxAgeSeconds + 60);
    const { frameId, linkedClientId } = await seedFrame(user.accountId);

    const frameResponse = await revokeFrame(
      request(`/api/frames/${frameId}/revoke`, { body: {} }),
      { params: Promise.resolve({ frameId }) },
    );
    expect(frameResponse.status).toBe(403);
    expect(await frameResponse.json()).toMatchObject({
      error: "reauth_required",
      reauth: {
        max_age_seconds: recentAuthMaxAgeSeconds,
        methods: { code: false, passkey: false, password: true, sign_in: false },
        path: "/login/reauth",
      },
    });
    // Nothing happened.
    const [frame] = await db.select().from(frames).where(eq(frames.id, frameId));
    expect(frame?.status).toBe("active");

    const linkResponse = await revokeLinkedClient(
      request("/api/device/revoke", { body: { linked_client_id: linkedClientId } }),
    );
    expect(linkResponse.status).toBe(403);
    expect(await linkResponse.json()).toMatchObject({ error: "reauth_required" });

    const { user_code: userCode } = await startDeviceRequest();
    const authorizeResponse = await authorizeDevice(
      request("/api/device/authorize", { body: { user_code: userCode } }),
    );
    expect(authorizeResponse.status).toBe(403);
    expect(await authorizeResponse.json()).toMatchObject({
      error: "reauth_required",
      reauth: { max_age_seconds: recentApprovalMaxAgeSeconds },
    });
  });

  it("approving rides the wider window; revoking does not", async () => {
    // Signed in twenty minutes ago: stale for a revoke (15 min window),
    // fresh enough to approve a device link (2 h window) — an afternoon of
    // setting up frames must not re-prompt on every board.
    const user = await passwordUser();
    await ageSession(user.token, 20 * 60);
    const { frameId } = await seedFrame(user.accountId);

    const revoke = await revokeFrame(request(`/api/frames/${frameId}/revoke`, { body: {} }), {
      params: Promise.resolve({ frameId }),
    });
    expect(revoke.status).toBe(403);

    const { user_code: userCode } = await startDeviceRequest();
    const approve = await authorizeDevice(
      request("/api/device/authorize", { body: { user_code: userCode } }),
    );
    expect(approve.status).toBe(200);
  });

  it("the password re-proves the session and the action goes through", async () => {
    const user = await passwordUser();
    await ageSession(user.token);
    const { frameId } = await seedFrame(user.accountId);

    const wrong = await reauth(
      request("/api/auth/reauth", { body: { password: "not it" } }),
    );
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toMatchObject({ error: "invalid_password" });

    const right = await reauth(
      request("/api/auth/reauth", {
        body: { password, return_to: "/account/frames" },
      }),
    );
    expect(right.status).toBe(200);
    expect(await right.json()).toMatchObject({ ok: true, redirect: "/account/frames" });
    // The session token itself is unchanged: no Set-Cookie.
    expect(responseCookies(right).has(sessionCookieName)).toBe(false);

    const response = await revokeFrame(request(`/api/frames/${frameId}/revoke`, { body: {} }), {
      params: Promise.resolve({ frameId }),
    });
    expect(response.status).toBe(200);

    const events = await latestAuditEvents(user.accountId);
    expect(events.map((row) => row.eventType)).toEqual(
      expect.arrayContaining([
        "account.reauthentication_failed",
        "account.reauthenticated",
        "frame.revoked",
      ]),
    );
    expect(
      events.find((row) => row.eventType === "account.reauthenticated")?.metadata,
    ).toMatchObject({ method: "password" });
  });

  it("rejects an unsafe return_to and falls back to the account page", async () => {
    const user = await passwordUser();
    await ageSession(user.token);
    const response = await reauth(
      request("/api/auth/reauth", {
        body: { password, return_to: "https://evil.example/steal" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ redirect: "/account" });
  });

  it("an authenticator or recovery code works for accounts without a password", async () => {
    const user = await googleUser();
    const { recoveryCodes, secret } = await enrollTotp();
    await ageSession(user.token);
    expect(await reauthMethods(db, user.accountId)).toEqual({
      code: true,
      passkey: false,
      password: false,
      sign_in: false,
    });

    // The password path is closed (dummy-hash compare, never succeeds).
    const viaPassword = await reauth(
      request("/api/auth/reauth", { body: { password } }),
    );
    expect(viaPassword.status).toBe(403);

    const bad = await reauth(request("/api/auth/reauth", { body: { code: "000000" } }));
    expect(bad.status).toBe(403);
    expect(await bad.json()).toMatchObject({ error: "invalid_code" });

    // Enrollment consumed the current step; the replay guard wants the next.
    const good = await reauth(
      request("/api/auth/reauth", {
        body: { code: totpCodeAtStep(secret, totpStepFor() + 1) },
      }),
    );
    expect(good.status).toBe(200);

    await ageSession(user.token);
    const recovery = await reauth(
      request("/api/auth/reauth", { body: { code: recoveryCodes[0] } }),
    );
    expect(recovery.status).toBe(200);
    expect(await recovery.json()).toMatchObject({ recovery_codes_remaining: 9 });
    const events = await latestAuditEvents(user.accountId, 3);
    expect(events[0]).toMatchObject({
      eventType: "account.reauthenticated",
      metadata: { method: "recovery_code", recovery_codes_remaining: 9 },
    });
  });

  it("an account with nothing to check can only sign in again", async () => {
    const user = await googleUser();
    await ageSession(user.token);
    expect(await reauthMethods(db, user.accountId)).toEqual({
      code: false,
      passkey: false,
      password: false,
      sign_in: true,
    });
    const response = await reauth(request("/api/auth/reauth", { body: { code: "123456" } }));
    expect(response.status).toBe(403);
    // A fresh session (what the Google round-trip mints) is recent again.
    const token = await createSession(db, {
      accountId: user.accountId,
      providerIssuer: googleIssuer,
      providerSubject: "whoever",
    });
    cookieJar.set(sessionCookieName, token);
    const { frameId } = await seedFrame(user.accountId);
    const revoke = await revokeFrame(request(`/api/frames/${frameId}/revoke`, { body: {} }), {
      params: Promise.resolve({ frameId }),
    });
    expect(revoke.status).toBe(200);
  });

  it("passkey re-authentication issues a challenge bound to the account and rejects junk", async () => {
    const user = await passwordUser();
    const options = await reauthPasskeyOptions(
      request("/api/auth/reauth/passkey/options", { body: {} }),
    );
    expect(options.status).toBe(200);
    const challenge = responseCookies(options).get(webauthnChallengeCookieName);
    expect(challenge).toBeTruthy();
    expect(await options.json()).toMatchObject({
      options: { allowCredentials: [], challenge: expect.any(String) },
    });

    const noChallenge = await reauthPasskeyVerify(
      request("/api/auth/reauth/passkey/verify", { body: { response: { id: "x" } } }),
    );
    expect(noChallenge.status).toBe(400);
    expect(await noChallenge.json()).toMatchObject({ error: "challenge_expired" });

    const junk = await reauthPasskeyVerify(
      request("/api/auth/reauth/passkey/verify", {
        body: { response: { id: "not-a-credential" } },
        cookies: { [webauthnChallengeCookieName]: challenge! },
      }),
    );
    expect(junk.status).toBe(403);
    expect(await junk.json()).toMatchObject({ error: "invalid_passkey" });
    expect((await latestAuditEvents(user.accountId, 1))[0]).toMatchObject({
      eventType: "account.reauthentication_failed",
      metadata: { method: "passkey" },
    });
  });

  it("needs a session, and stamps only a live one", async () => {
    const anonymous = await reauth(request("/api/auth/reauth", { body: { password } }));
    expect(anonymous.status).toBe(401);
    expect(await markSessionReauthenticated(db, "no-such-token")).toBe(false);
  });

  it("limits guessing per account", async () => {
    await passwordUser();
    let lastStatus = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await reauth(
        request("/api/auth/reauth", { body: { password: "wrong" } }),
      );
      lastStatus = response.status;
    }
    expect(lastStatus).toBe(429);
  });
});
