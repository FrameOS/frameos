import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  accountIdentities,
  accounts,
  createDb,
  emailVerificationTokens,
  googleProviderKey,
  passwordProviderIssuer,
  passwordResetTokens,
  sessions,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE as adminDeleteUser, PATCH as adminPatchUser } from "../../../app/api/admin/users/[accountId]/route";
import { POST as adminRevokeSessions } from "../../../app/api/admin/users/[accountId]/revoke-sessions/route";
import { GET as adminListUsers } from "../../../app/api/admin/users/route";
import { POST as login } from "../../../app/api/auth/login/route";
import { POST as logout } from "../../../app/api/auth/logout/route";
import { POST as resetConfirm } from "../../../app/api/auth/reset/confirm/route";
import { POST as resetRequest } from "../../../app/api/auth/reset/request/route";
import { POST as signup } from "../../../app/api/auth/signup/route";
import { confirmEmailVerification } from "../../lib/email-verification";
import { resolveGoogleSignIn } from "../../lib/google-account";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { createSecretToken, hashSecret } from "../../lib/secrets";
import { createSession, sessionCookieName } from "../../lib/session";

// Route handlers read the session cookie through next/headers, which only
// works inside a real Next.js request scope. Replace it with a jar the tests
// control; everything below it (JWT verification, the sessions table check)
// still runs for real.
const cookieJar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

const baseUrl = "http://localhost:3000";
const db = createDb();
let userCounter = 0;

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

function postJson(path: string, body: Record<string, unknown>) {
  return new NextRequest(new URL(path, baseUrl), {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: baseUrl },
    method: "POST",
  });
}

async function readJson(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

async function signUpUserUnverified(overrides: Record<string, unknown> = {}) {
  userCounter += 1;
  const email = `auth-tester-${userCounter}@example.com`;
  const response = await signup(
    postJson("/api/auth/signup", {
      email,
      name: `Auth Tester ${userCounter}`,
      password: "a long enough password",
      ...overrides,
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
  return { accountId: account.id, email };
}

// Most tests need an account that can actually log in, so flip the
// verification flag directly instead of round-tripping the emailed token.
async function signUpUser(overrides: Record<string, unknown> = {}) {
  const user = await signUpUserUnverified(overrides);
  await db
    .update(accountIdentities)
    .set({ emailVerified: true })
    .where(eq(accountIdentities.accountId, user.accountId));
  return user;
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

describe("password signup and login", () => {
  it("signs up without a session and records the password identity", async () => {
    const response = await signup(
      postJson("/api/auth/signup", {
        email: "First.User@Example.com",
        name: "First User",
        password: "a long enough password",
      }),
    );

    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({ verify_email: true });
    // No session until the email is verified.
    expect(response.headers.get("set-cookie")).toBeNull();

    const [identity] = await db
      .select({
        accountId: accountIdentities.accountId,
        providerIssuer: accountIdentities.providerIssuer,
        providerSubject: accountIdentities.providerSubject,
      })
      .from(accountIdentities)
      .limit(1);
    expect(identity?.providerIssuer).toBe(passwordProviderIssuer);
    expect(identity?.providerSubject).toBe("first.user@example.com");

    const [account] = await db
      .select({
        isSuperadmin: accounts.isSuperadmin,
        passwordHash: accounts.passwordHash,
        primaryEmail: accounts.primaryEmail,
      })
      .from(accounts)
      .limit(1);
    expect(account?.primaryEmail).toBe("first.user@example.com");
    expect(account?.passwordHash).toMatch(/^scrypt\$/);
    expect(account?.isSuperadmin).toBe(false);
  });

  it("rejects a duplicate signup for the same email", async () => {
    const { email } = await signUpUser();
    const response = await signup(
      postJson("/api/auth/signup", {
        email: email.toUpperCase(),
        password: "another long password",
      }),
    );
    expect(response.status).toBe(409);
    expect(await readJson(response)).toMatchObject({ error: "email_taken" });
  });

  it("rejects weak passwords", async () => {
    const response = await signup(
      postJson("/api/auth/signup", {
        email: "weak@example.com",
        password: "short",
      }),
    );
    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({ error: "weak_password" });
  });

  it("logs in with the right password and rejects the wrong one", async () => {
    const { email } = await signUpUser();

    const wrong = await login(
      postJson("/api/auth/login", { email, password: "not the password" }),
    );
    expect(wrong.status).toBe(401);

    const right = await login(
      postJson("/api/auth/login", { email, password: "a long enough password" }),
    );
    expect(right.status).toBe(200);
    expect(right.headers.get("set-cookie")).toContain(sessionCookieName);
    expect(await readJson(right)).toMatchObject({ redirect: "/account" });
  });

  it("rejects logins for unknown emails without leaking existence", async () => {
    const response = await login(
      postJson("/api/auth/login", {
        email: "nobody@example.com",
        password: "whatever password",
      }),
    );
    expect(response.status).toBe(401);
    expect(await readJson(response)).toMatchObject({
      error: "invalid_credentials",
    });
  });

  it("revokes the session row on logout", async () => {
    const { accountId, email } = await signUpUser();
    const token = await establishSession(accountId, email);

    const request = new NextRequest(new URL("/api/auth/logout", baseUrl), {
      headers: { origin: baseUrl },
      method: "POST",
    });
    request.cookies.set(sessionCookieName, token);
    const response = await logout(request);
    expect(response.status).toBe(303);

    // The signup call also minted a session; only the one presented in the
    // logout request must be revoked.
    const [row] = await db
      .select({ revokedAt: sessions.revokedAt })
      .from(sessions)
      .where(eq(sessions.tokenHash, hashSecret(token)));
    expect(row?.revokedAt).not.toBeNull();
  });
});

describe("email verification", () => {
  it("blocks login until the email is verified and resends the link", async () => {
    const { accountId, email } = await signUpUserUnverified();

    const blocked = await login(
      postJson("/api/auth/login", { email, password: "a long enough password" }),
    );
    expect(blocked.status).toBe(403);
    expect(await readJson(blocked)).toMatchObject({
      error: "email_unverified",
    });
    // The blocked login resent a link: signup's token plus the resend.
    const tokens = await db
      .select({ id: emailVerificationTokens.id })
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.accountId, accountId));
    expect(tokens.length).toBe(2);

    await db
      .update(accountIdentities)
      .set({ emailVerified: true })
      .where(eq(accountIdentities.accountId, accountId));

    const allowed = await login(
      postJson("/api/auth/login", { email, password: "a long enough password" }),
    );
    expect(allowed.status).toBe(200);
  });

  it("creates a verification token on signup and verifies the identity once", async () => {
    const { accountId } = await signUpUserUnverified();

    const [tokenRow] = await db
      .select({ tokenHash: emailVerificationTokens.tokenHash })
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.accountId, accountId));
    expect(tokenRow).toBeDefined();

    const [before] = await db
      .select({ emailVerified: accountIdentities.emailVerified })
      .from(accountIdentities)
      .where(eq(accountIdentities.accountId, accountId));
    expect(before?.emailVerified).toBe(false);

    // The raw token only exists in the emailed link; mint a fresh one the
    // test controls, exactly like beginEmailVerification does.
    const rawToken = createSecretToken("frev", 32);
    await db.insert(emailVerificationTokens).values({
      accountId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      tokenHash: hashSecret(rawToken),
    });

    expect(await confirmEmailVerification(db, rawToken)).toBe("verified");
    expect(await confirmEmailVerification(db, rawToken)).toBe("invalid");

    const [after] = await db
      .select({ emailVerified: accountIdentities.emailVerified })
      .from(accountIdentities)
      .where(eq(accountIdentities.accountId, accountId));
    expect(after?.emailVerified).toBe(true);
  });

  it("rejects expired verification tokens", async () => {
    const { accountId } = await signUpUser();
    const rawToken = createSecretToken("frev", 32);
    await db.insert(emailVerificationTokens).values({
      accountId,
      expiresAt: new Date(Date.now() - 1000),
      tokenHash: hashSecret(rawToken),
    });

    expect(await confirmEmailVerification(db, rawToken)).toBe("invalid");
  });
});

describe("password reset", () => {
  it("responds identically whether or not the email exists", async () => {
    const { email } = await signUpUser();
    const known = await resetRequest(
      postJson("/api/auth/reset/request", { email }),
    );
    const unknown = await resetRequest(
      postJson("/api/auth/reset/request", { email: "ghost@example.com" }),
    );
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);

    const tokens = await db.select().from(passwordResetTokens);
    expect(tokens).toHaveLength(1);
  });

  it("resets the password once per token, revokes sessions, and verifies the email", async () => {
    // Unverified on purpose: following the reset link proves email control,
    // so it must also verify the identity or the account stays locked out.
    const { accountId, email } = await signUpUserUnverified();
    await establishSession(accountId, email);

    const rawToken = createSecretToken("frpr", 32);
    await db.insert(passwordResetTokens).values({
      accountId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      tokenHash: hashSecret(rawToken),
    });

    const confirm = await resetConfirm(
      postJson("/api/auth/reset/confirm", {
        password: "a brand new password",
        token: rawToken,
      }),
    );
    expect(confirm.status).toBe(200);

    const [identity] = await db
      .select({ emailVerified: accountIdentities.emailVerified })
      .from(accountIdentities)
      .where(eq(accountIdentities.accountId, accountId));
    expect(identity?.emailVerified).toBe(true);

    // Everything issued before the reset must be revoked; the logins below
    // mint fresh sessions, so assert before them.
    const rows = await db
      .select({ revokedAt: sessions.revokedAt })
      .from(sessions)
      .where(eq(sessions.accountId, accountId));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);

    const replay = await resetConfirm(
      postJson("/api/auth/reset/confirm", {
        password: "yet another password",
        token: rawToken,
      }),
    );
    expect(replay.status).toBe(400);

    const oldPassword = await login(
      postJson("/api/auth/login", { email, password: "a long enough password" }),
    );
    expect(oldPassword.status).toBe(401);

    const newPassword = await login(
      postJson("/api/auth/login", { email, password: "a brand new password" }),
    );
    expect(newPassword.status).toBe(200);
  });

  it("rejects expired tokens", async () => {
    const { accountId } = await signUpUser();
    const rawToken = createSecretToken("frpr", 32);
    await db.insert(passwordResetTokens).values({
      accountId,
      expiresAt: new Date(Date.now() - 1000),
      tokenHash: hashSecret(rawToken),
    });

    const confirm = await resetConfirm(
      postJson("/api/auth/reset/confirm", {
        password: "a brand new password",
        token: rawToken,
      }),
    );
    expect(confirm.status).toBe(400);
  });
});

describe("google sign-in merging", () => {
  const googleIssuer = "https://accounts.google.com";

  it("links google to a verified password account automatically", async () => {
    const { accountId, email } = await signUpUser();

    const resolution = await resolveGoogleSignIn(db, googleIssuer, {
      email,
      email_verified: true,
      sub: `google-sub-${email}`,
    });
    // A link into an existing account is not a new signup: created is false.
    expect(resolution).toEqual({ accountId, created: false, status: "ok" });

    const identities = await db
      .select({ providerKey: accountIdentities.providerKey })
      .from(accountIdentities)
      .where(eq(accountIdentities.accountId, accountId));
    expect(identities.map((row) => row.providerKey).sort()).toEqual([
      "google",
      "password",
    ]);
  });

  it("requires a password reset before linking to an unverified password account", async () => {
    const { accountId, email } = await signUpUserUnverified();
    const sub = `google-sub-${email}`;

    const blocked = await resolveGoogleSignIn(db, googleIssuer, {
      email,
      email_verified: true,
      sub,
    });
    expect(blocked).toEqual({ email, status: "requires_password_reset" });

    // No google identity may exist yet.
    const identities = await db
      .select({ providerKey: accountIdentities.providerKey })
      .from(accountIdentities)
      .where(eq(accountIdentities.accountId, accountId));
    expect(identities.map((row) => row.providerKey)).toEqual(["password"]);

    // After the reset flow verifies the email, the same google sign-in links.
    await db
      .update(accountIdentities)
      .set({ emailVerified: true })
      .where(eq(accountIdentities.accountId, accountId));
    const linked = await resolveGoogleSignIn(db, googleIssuer, {
      email,
      email_verified: true,
      sub,
    });
    expect(linked).toEqual({ accountId, created: false, status: "ok" });
  });

  it("never links when google did not verify the email", async () => {
    const { email } = await signUpUser();
    const resolution = await resolveGoogleSignIn(db, googleIssuer, {
      email,
      email_verified: false,
      sub: `google-sub-${email}`,
    });
    expect(resolution).toEqual({ status: "google_email_unverified" });
  });

  it("creates a fresh account when the email is unknown", async () => {
    const resolution = await resolveGoogleSignIn(db, googleIssuer, {
      email: "fresh-google@example.com",
      email_verified: true,
      name: "Fresh Google",
      sub: "google-sub-fresh",
    });
    expect(resolution.status).toBe("ok");
    // First sign-in mints the account; only then do signup notifications fire.
    expect(resolution).toMatchObject({ created: true });

    // The same Google identity signing in again is a login, not a signup.
    const again = await resolveGoogleSignIn(db, googleIssuer, {
      email: "fresh-google@example.com",
      email_verified: true,
      name: "Fresh Google",
      sub: "google-sub-fresh",
    });
    expect(again).toMatchObject({ created: false, status: "ok" });
  });

  it("adds a password to a google-first account through the reset flow", async () => {
    const email = "google-first@example.com";
    const { accountId } = await upsertAccountFromIdentity(db, {
      displayName: "Google First",
      email,
      emailVerified: true,
      providerIssuer: googleIssuer,
      providerKey: googleProviderKey,
      providerSubject: "google-sub-first",
    });

    // Direct signup on that email is refused so nobody can plant a password.
    const dup = await signup(
      postJson("/api/auth/signup", { email, password: "a long enough password" }),
    );
    expect(dup.status).toBe(409);
    expect(await readJson(dup)).toMatchObject({ error: "email_taken_google" });

    // The reset flow is the sanctioned path: request targets the google
    // account, confirm creates a verified password identity.
    const request = await resetRequest(
      postJson("/api/auth/reset/request", { email }),
    );
    expect(request.status).toBe(200);
    const [tokenRow] = await db
      .select({ id: passwordResetTokens.id })
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.accountId, accountId));
    expect(tokenRow).toBeDefined();

    const rawToken = createSecretToken("frpr", 32);
    await db.insert(passwordResetTokens).values({
      accountId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      tokenHash: hashSecret(rawToken),
    });
    const confirm = await resetConfirm(
      postJson("/api/auth/reset/confirm", {
        password: "a chosen google-first password",
        token: rawToken,
      }),
    );
    expect(confirm.status).toBe(200);

    const loggedIn = await login(
      postJson("/api/auth/login", {
        email,
        password: "a chosen google-first password",
      }),
    );
    expect(loggedIn.status).toBe(200);

    // Still one single account with both identities.
    const identities = await db
      .select({ providerKey: accountIdentities.providerKey })
      .from(accountIdentities)
      .where(eq(accountIdentities.accountId, accountId));
    expect(identities.map((row) => row.providerKey).sort()).toEqual([
      "google",
      "password",
    ]);
  });
});

describe("admin panel APIs", () => {
  async function makeSuperadmin(accountId: string) {
    await db
      .update(accounts)
      .set({ isSuperadmin: true })
      .where(eq(accounts.id, accountId));
  }

  it("gates the user list on an authenticated superadmin session", async () => {
    const admin = await signUpUser();
    const regular = await signUpUser();

    const unauthenticated = await adminListUsers(
      new NextRequest(new URL("/api/admin/users", baseUrl)),
    );
    expect(unauthenticated.status).toBe(401);

    await establishSession(regular.accountId, regular.email);
    const forbidden = await adminListUsers(
      new NextRequest(new URL("/api/admin/users", baseUrl)),
    );
    expect(forbidden.status).toBe(403);

    await makeSuperadmin(admin.accountId);
    await establishSession(admin.accountId, admin.email);
    const allowed = await adminListUsers(
      new NextRequest(new URL("/api/admin/users", baseUrl)),
    );
    expect(allowed.status).toBe(200);
    const payload = (await allowed.json()) as {
      users: { id: string; identities: { providerKey: string }[] }[];
    };
    expect(payload.users).toHaveLength(2);
    expect(payload.users[0]?.identities[0]?.providerKey).toBe("password");
  });

  it("toggles the superadmin flag but never on the acting admin", async () => {
    const admin = await signUpUser();
    const target = await signUpUser();
    await makeSuperadmin(admin.accountId);
    await establishSession(admin.accountId, admin.email);

    const granted = await adminPatchUser(
      postJson(`/api/admin/users/${target.accountId}`, {
        is_superadmin: true,
      }),
      { params: Promise.resolve({ accountId: target.accountId }) },
    );
    expect(granted.status).toBe(200);
    const [flag] = await db
      .select({ isSuperadmin: accounts.isSuperadmin })
      .from(accounts)
      .where(eq(accounts.id, target.accountId));
    expect(flag?.isSuperadmin).toBe(true);

    const self = await adminPatchUser(
      postJson(`/api/admin/users/${admin.accountId}`, {
        is_superadmin: false,
      }),
      { params: Promise.resolve({ accountId: admin.accountId }) },
    );
    expect(self.status).toBe(400);
  });

  it("revokes another user's sessions and deletes accounts", async () => {
    const admin = await signUpUser();
    const target = await signUpUser();
    await makeSuperadmin(admin.accountId);
    await createSession(db, {
      accountId: target.accountId,
      providerIssuer: passwordProviderIssuer,
      providerSubject: target.email,
    });
    await establishSession(admin.accountId, admin.email);

    const revoke = await adminRevokeSessions(
      postJson(`/api/admin/users/${target.accountId}/revoke-sessions`, {}),
      { params: Promise.resolve({ accountId: target.accountId }) },
    );
    expect(revoke.status).toBe(200);
    const targetSessions = await db
      .select({ revokedAt: sessions.revokedAt })
      .from(sessions)
      .where(eq(sessions.accountId, target.accountId));
    expect(targetSessions.length).toBeGreaterThan(0);
    expect(targetSessions.every((row) => row.revokedAt !== null)).toBe(true);

    const selfDelete = await adminDeleteUser(
      new NextRequest(new URL(`/api/admin/users/${admin.accountId}`, baseUrl), {
        headers: { origin: baseUrl },
        method: "DELETE",
      }),
      { params: Promise.resolve({ accountId: admin.accountId }) },
    );
    expect(selfDelete.status).toBe(400);

    const deleted = await adminDeleteUser(
      new NextRequest(
        new URL(`/api/admin/users/${target.accountId}`, baseUrl),
        { headers: { origin: baseUrl }, method: "DELETE" },
      ),
      { params: Promise.resolve({ accountId: target.accountId }) },
    );
    expect(deleted.status).toBe(200);

    const remaining = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.id, target.accountId));
    expect(remaining).toHaveLength(0);
  });
});
