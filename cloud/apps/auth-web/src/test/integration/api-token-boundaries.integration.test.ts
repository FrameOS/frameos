// A personal API token stands in for the session cookie on ordinary routes.
// These tests pin the routes where it must NOT: the second-factor enrolment
// routes, self-serve account deletion, the superadmin API, and — for the
// enrolment routes — that even a cookie session needs a recent proof.
import { eq, sql } from "drizzle-orm";
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
import { POST as createApiToken } from "../../../app/api/account/api-tokens/route";
import { POST as deleteAccount } from "../../../app/api/account/delete/route";
import { GET as exportAccount } from "../../../app/api/account/export/route";
import { PATCH as adminPatchUser } from "../../../app/api/admin/users/[accountId]/route";
import { GET as listApiTokens } from "../../../app/api/account/api-tokens/route";
import { GET as accountSettings } from "../../../app/api/settings/route";
import { POST as passkeyOptions } from "../../../app/api/account/two-factor/passkeys/options/route";
import { POST as beginTotp } from "../../../app/api/account/two-factor/totp/route";
import { POST as confirmTotp } from "../../../app/api/account/two-factor/totp/confirm/route";
import { GET as adminUsers } from "../../../app/api/admin/users/route";
import { totpCodeAtStep, totpStepFor } from "../../lib/two-factor";
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
const password = "a long enough password";
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
      password,
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
  it("cannot download the account export with a read-only token", async () => {
    const { accountId, email } = await signUpVerifiedUser();
    await establishSession(accountId, email);
    const minted = await createApiToken(
      request("/api/account/api-tokens", { access: "read_only", name: "dash" }),
    );
    expect(minted.status).toBe(201);
    const { token } = (await minted.json()) as { token: string };
    expect(token).toMatch(/^fc_apiro_/);
    cookieJar.clear();
    requestHeaders.set("authorization", `Bearer ${token}`);

    const refused = await exportAccount();
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: "read_only_token" });
  });

  it("never puts service-setting values in the export", async () => {
    const { accountId, email } = await signUpVerifiedUser();
    await establishSession(accountId, email);
    await db.execute(
      sql`insert into account_settings (account_id, key, value) values (${accountId}, 'openAiApiKey', ${JSON.stringify("sk-proj-0123456789abcdef")}::jsonb)`,
    );
    const response = await exportAccount();
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("sk-proj-0123456789abcdef");
    const parsed = JSON.parse(body) as { settings: { key: string; value: unknown }[] };
    expect(parsed.settings).toEqual([
      expect.objectContaining({ key: "openAiApiKey", value: "••••cdef" }),
    ]);
  });

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

describe("a job token is not a person", () => {
  it("opens no ordinary route, not even a read", async () => {
    const { accountId } = await signUpVerifiedUser();
    const token = `fc_apijob_${"k".repeat(43)}`;
    await db.insert(accountApiTokens).values({
      access: "billing_nightly",
      accountId,
      name: "nightly accounting job",
      tokenHash: hashSecret(token),
      tokenHint: token.slice(0, 14),
    });
    requestHeaders.set("authorization", `Bearer ${token}`);
    const settings = await accountSettings(
      request("/api/settings", undefined, "GET", { authorization: `Bearer ${token}` }),
    );
    expect(settings.status).toBe(401);
    const tokens = await listApiTokens(
      request("/api/account/api-tokens", undefined, "GET", {
        authorization: `Bearer ${token}`,
      }),
    );
    expect(tokens.status).toBe(401);
  });
});

describe("enrolling a second factor revokes every API token", () => {
  // A token never answers a second factor, so one minted before 2FA was on
  // would keep bypassing it for as long as it lived.
  it("kills the tokens minted before an authenticator was confirmed", async () => {
    const { accountId, email } = await signUpVerifiedUser();
    await establishSession(accountId, email);
    const minted = await createApiToken(
      request("/api/account/api-tokens", { name: "script" }),
    );
    expect(minted.status).toBe(201);
    const { token } = (await minted.json()) as { token: string };

    const start = await beginTotp(
      request("/api/account/two-factor/totp", { password }),
    );
    expect(start.status).toBe(200);
    const { secret } = (await start.json()) as { secret: string };
    const confirm = await confirmTotp(
      request("/api/account/two-factor/totp/confirm", {
        code: totpCodeAtStep(secret, totpStepFor()),
      }),
    );
    expect(confirm.status).toBe(200);
    expect(await confirm.json()).toMatchObject({ api_tokens_revoked: 1, ok: true });

    // The token is dead: the row is revoked and the bearer no longer resolves.
    const [row] = await db
      .select({ revokedAt: accountApiTokens.revokedAt })
      .from(accountApiTokens)
      .where(eq(accountApiTokens.accountId, accountId));
    expect(row?.revokedAt).not.toBeNull();
    cookieJar.clear();
    const asToken = await listApiTokens(
      request("/api/account/api-tokens", undefined, "GET", {
        authorization: `Bearer ${token}`,
      }),
    );
    expect(asToken.status).toBe(401);
  });
});

describe("superadmin mutations need a recent proof of credentials", () => {
  it("sends a superadmin cookie through reauth before a mutation", async () => {
    const admin = await signUpVerifiedUser();
    const target = await signUpVerifiedUser();
    await db
      .update(accounts)
      .set({ isSuperadmin: true })
      .where(eq(accounts.id, admin.accountId));
    const sessionToken = await establishSession(admin.accountId, admin.email);

    const fresh = await adminPatchUser(
      request(`/api/admin/users/${target.accountId}`, { is_superadmin: true }, "PATCH"),
      { params: Promise.resolve({ accountId: target.accountId }) },
    );
    expect(fresh.status).toBe(200);
    // A garbage id is a 404, never a database error.
    const garbage = await adminPatchUser(
      request(`/api/admin/users/not-a-uuid`, { is_superadmin: true }, "PATCH"),
      { params: Promise.resolve({ accountId: "not-a-uuid" }) },
    );
    expect(garbage.status).toBe(404);

    await db
      .update(sessions)
      .set({ authenticatedAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(sessions.tokenHash, hashSecret(sessionToken)));
    const stale = await adminPatchUser(
      request(`/api/admin/users/${target.accountId}`, { is_superadmin: false }, "PATCH"),
      { params: Promise.resolve({ accountId: target.accountId }) },
    );
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({
      error: "reauth_required",
      reauth: { path: "/login/reauth" },
    });
    const [row] = await db
      .select({ isSuperadmin: accounts.isSuperadmin })
      .from(accounts)
      .where(eq(accounts.id, target.accountId));
    expect(row?.isSuperadmin).toBe(true);
  });
});

describe("second-factor enrolment needs a recent proof of credentials", () => {
  it("refuses a cookie session that proved itself too long ago", async () => {
    const { accountId, email } = await signUpVerifiedUser();
    const sessionToken = await establishSession(accountId, email);

    const fresh = await beginTotp(request("/api/account/two-factor/totp", { password }));
    expect(fresh.status).toBe(200);

    await db
      .update(sessions)
      .set({ authenticatedAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(sessions.tokenHash, hashSecret(sessionToken)));

    const stale = await beginTotp(request("/api/account/two-factor/totp", { password }));
    expect(stale.status).toBe(403);
    const payload = (await stale.json()) as {
      error: string;
      reauth?: { path?: string };
    };
    expect(payload.error).toBe("reauth_required");
    expect(payload.reauth?.path).toBe("/login/reauth");
  });
});
