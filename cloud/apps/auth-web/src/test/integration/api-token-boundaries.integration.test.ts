// A personal API token stands in for the session cookie on ordinary routes.
// These tests pin the routes where it must NOT: the second-factor enrolment
// routes, self-serve account deletion, the superadmin API, and — for the
// enrolment routes — that even a cookie session needs a recent proof.
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  accountIdentities,
  accounts,
  createDb,
  passwordProviderIssuer,
  sessions,
} from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as createApiToken } from "../../../app/api/account/api-tokens/route";
import { POST as deleteAccount } from "../../../app/api/account/delete/route";
import { POST as passkeyOptions } from "../../../app/api/account/two-factor/passkeys/options/route";
import { POST as beginTotp } from "../../../app/api/account/two-factor/totp/route";
import { GET as adminUsers } from "../../../app/api/admin/users/route";
import { POST as signup } from "../../../app/api/auth/signup/route";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { hashSecret } from "../../lib/secrets";
import { createSession, sessionCookieName } from "../../lib/session";

const cookieJar = vi.hoisted(() => new Map<string, string>());
const requestHeaders = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
  headers: async () => new Headers(Object.fromEntries(requestHeaders)),
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
  requestHeaders.clear();
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
  body: Record<string, unknown> | undefined,
  method = "POST",
  headers: Record<string, string> = {},
) {
  return new NextRequest(new URL(path, baseUrl), {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      "content-type": "application/json",
      origin: baseUrl,
      ...headers,
    },
    method,
  });
}

async function signUpVerifiedUser() {
  userCounter += 1;
  const email = `token-tester-${userCounter}@example.com`;
  const response = await signup(
    request("/api/auth/signup", {
      email,
      name: `Token Tester ${userCounter}`,
      password: "a long enough password",
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

// Mint a full-access token with a fresh cookie session, then drop the cookie
// so the token is the only credential on later requests.
async function switchToApiToken(accountId: string, email: string) {
  await establishSession(accountId, email);
  const response = await createApiToken(
    request("/api/account/api-tokens", { name: "script" }),
  );
  expect(response.status).toBe(201);
  const { token } = (await response.json()) as { token: string };
  expect(token).toMatch(/^fc_api_/);
  cookieJar.clear();
  requestHeaders.set("authorization", `Bearer ${token}`);
  return token;
}

describe("what a personal API token may not do", () => {
  it("cannot enrol an authenticator or a passkey", async () => {
    const { accountId, email } = await signUpVerifiedUser();
    const token = await switchToApiToken(accountId, email);
    const bearer = { authorization: `Bearer ${token}` };

    const totp = await beginTotp(
      request("/api/account/two-factor/totp", {}, "POST", bearer),
    );
    expect(totp.status).toBe(403);
    expect((await totp.json()).error).toBe("api_token_not_allowed");

    const passkey = await passkeyOptions(
      request("/api/account/two-factor/passkeys/options", {}, "POST", bearer),
    );
    expect(passkey.status).toBe(403);
    expect((await passkey.json()).error).toBe("api_token_not_allowed");
  });

  it("cannot delete the account", async () => {
    const { accountId, email } = await signUpVerifiedUser();
    const token = await switchToApiToken(accountId, email);
    const response = await deleteAccount(
      request(
        "/api/account/delete",
        { confirmEmail: email, password: "a long enough password" },
        "POST",
        { authorization: `Bearer ${token}` },
      ),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("api_token_not_allowed");
    const [account] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.id, accountId));
    expect(account).toBeDefined();
  });

  it("cannot reach the superadmin API even when its owner is a superadmin", async () => {
    const { accountId, email } = await signUpVerifiedUser();
    await db
      .update(accounts)
      .set({ isSuperadmin: true })
      .where(eq(accounts.id, accountId));

    await establishSession(accountId, email);
    const withCookie = await adminUsers(
      request("/api/admin/users", undefined, "GET"),
    );
    expect(withCookie.status).toBe(200);

    const token = await switchToApiToken(accountId, email);
    const withToken = await adminUsers(
      request("/api/admin/users", undefined, "GET", {
        authorization: `Bearer ${token}`,
      }),
    );
    expect(withToken.status).toBe(403);
    expect((await withToken.json()).error).toBe("forbidden");
  });
});

describe("second-factor enrolment needs a recent proof of credentials", () => {
  it("refuses a cookie session that proved itself too long ago", async () => {
    const { accountId, email } = await signUpVerifiedUser();
    const sessionToken = await establishSession(accountId, email);

    const fresh = await beginTotp(request("/api/account/two-factor/totp", {}));
    expect(fresh.status).toBe(200);

    await db
      .update(sessions)
      .set({ authenticatedAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(sessions.tokenHash, hashSecret(sessionToken)));

    const stale = await beginTotp(request("/api/account/two-factor/totp", {}));
    expect(stale.status).toBe(403);
    const payload = (await stale.json()) as {
      error: string;
      reauth?: { path?: string };
    };
    expect(payload.error).toBe("reauth_required");
    expect(payload.reauth?.path).toBe("/login/reauth");
  });
});
