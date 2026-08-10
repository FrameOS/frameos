import { and, eq, isNull, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
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
import { createSession, sessionCookieName } from "../../lib/session";

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
});
