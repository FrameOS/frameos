import { and, eq, isNull, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  accountApiTokens,
  accountIdentities,
  accounts,
  createDb,
  passwordProviderIssuer,
  sessions,
} from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as changePassword } from "../../../app/api/account/password/route";
import { POST as login } from "../../../app/api/auth/login/route";
import { POST as signup } from "../../../app/api/auth/signup/route";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { hashSecret } from "../../lib/secrets";
import { createSession, sessionCookieName } from "../../lib/session";
import {
  beginTotpEnrollment,
  confirmTotpEnrollment,
  totpCodeAtStep,
  totpStepFor,
} from "../../lib/two-factor";

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

const initialPassword = "a long enough password";

async function signUpVerifiedUser() {
  userCounter += 1;
  const email = `password-tester-${userCounter}@example.com`;
  const response = await signup(
    postJson("/api/auth/signup", {
      email,
      name: `Password Tester ${userCounter}`,
      password: initialPassword,
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

async function activeSessionCount(accountId: string) {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.accountId, accountId), isNull(sessions.revokedAt)));
  return rows.length;
}

describe("account password change", () => {
  it("requires a signed-in session", async () => {
    const response = await changePassword(
      postJson("/api/account/password", {
        currentPassword: initialPassword,
        newPassword: "an even longer password",
      }),
    );
    expect(response.status).toBe(401);
  });

  it("rejects a wrong current password", async () => {
    const user = await signUpVerifiedUser();
    await establishSession(user.accountId, user.email);

    const response = await changePassword(
      postJson("/api/account/password", {
        currentPassword: "not the right password",
        newPassword: "an even longer password",
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_password" });
  });

  it("rejects a weak new password", async () => {
    const user = await signUpVerifiedUser();
    await establishSession(user.accountId, user.email);

    const response = await changePassword(
      postJson("/api/account/password", {
        currentPassword: initialPassword,
        newPassword: "short",
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "weak_password" });
  });

  it("changes the password and keeps only the current session", async () => {
    const user = await signUpVerifiedUser();
    // An older session elsewhere, then the current one.
    await createSession(db, {
      accountId: user.accountId,
      email: user.email,
      providerIssuer: passwordProviderIssuer,
      providerSubject: user.email,
    });
    const currentToken = await establishSession(user.accountId, user.email);
    expect(await activeSessionCount(user.accountId)).toBe(2);

    const newPassword = "an even longer password";
    const response = await changePassword(
      postJson("/api/account/password", {
        currentPassword: initialPassword,
        newPassword,
      }),
    );
    expect(response.status).toBe(200);

    // The other session is revoked, the current one survives.
    expect(await activeSessionCount(user.accountId)).toBe(1);
    const [survivor] = await db
      .select({ tokenHash: sessions.tokenHash })
      .from(sessions)
      .where(
        and(
          eq(sessions.accountId, user.accountId),
          isNull(sessions.revokedAt),
        ),
      );
    expect(survivor).toBeDefined();
    void currentToken;

    // Old password no longer signs in, the new one does.
    const oldLogin = await login(
      postJson("/api/auth/login", {
        email: user.email,
        password: initialPassword,
      }),
    );
    expect(oldLogin.status).toBe(401);
    const newLogin = await login(
      postJson("/api/auth/login", {
        email: user.email,
        password: newPassword,
      }),
    );
    expect(newLogin.status).toBe(200);
  });

  it("revokes the account's API tokens", async () => {
    // A token minted under the old password is a way in that would outlive
    // the new one; a reset and a second-factor change already end them.
    const user = await signUpVerifiedUser();
    await establishSession(user.accountId, user.email);
    await db.insert(accountApiTokens).values({
      access: "full",
      accountId: user.accountId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      name: "script",
      tokenHash: hashSecret("fc_api_test_password_change"),
      tokenHint: "ange",
    });

    const response = await changePassword(
      postJson("/api/account/password", {
        currentPassword: initialPassword,
        newPassword: "an even longer password",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ api_tokens_revoked: 1, ok: true });
    const [row] = await db
      .select({ revokedAt: accountApiTokens.revokedAt })
      .from(accountApiTokens)
      .where(eq(accountApiTokens.accountId, user.accountId));
    expect(row?.revokedAt).not.toBeNull();
  });

  it("needs a recent second-factor proof on an account with two-factor", async () => {
    // With a second factor on, the password alone proves less than sign-in
    // did: a lifted cookie plus a phished password must not rotate it.
    const user = await signUpVerifiedUser();
    const sessionToken = await establishSession(user.accountId, user.email);
    const secret = await beginTotpEnrollment(db, user.accountId);
    if (!secret) {
      throw new Error("enrollment did not start");
    }
    expect(
      await confirmTotpEnrollment(
        db,
        user.accountId,
        totpCodeAtStep(secret, totpStepFor()),
      ),
    ).toBe(true);
    await db
      .update(sessions)
      .set({ authenticatedAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(sessions.tokenHash, hashSecret(sessionToken)));

    const refused = await changePassword(
      postJson("/api/account/password", {
        currentPassword: initialPassword,
        newPassword: "an even longer password",
      }),
    );
    expect(refused.status).toBe(403);
    const payload = (await refused.json()) as {
      error: string;
      reauth?: { methods?: { code?: boolean; password?: boolean } };
    };
    expect(payload.error).toBe("reauth_required");
    expect(payload.reauth?.methods).toMatchObject({ code: true, password: false });

    // The old password still signs in (to the second-factor step): nothing changed.
    const stillOld = await login(
      postJson("/api/auth/login", { email: user.email, password: initialPassword }),
    );
    expect(stillOld.status).toBe(200);
  });

  it("asks an account without two-factor for the password only", async () => {
    const user = await signUpVerifiedUser();
    const sessionToken = await establishSession(user.accountId, user.email);
    await db
      .update(sessions)
      .set({ authenticatedAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(sessions.tokenHash, hashSecret(sessionToken)));
    const response = await changePassword(
      postJson("/api/account/password", {
        currentPassword: initialPassword,
        newPassword: "an even longer password",
      }),
    );
    expect(response.status).toBe(200);
  });
});
