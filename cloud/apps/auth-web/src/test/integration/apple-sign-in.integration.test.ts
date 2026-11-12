import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  accountIdentities,
  accountTotp,
  createDb,
  createPasswordAccount,
  ensurePasswordIdentityForAccount,
  linkIdentityToAccount,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as appleCallback } from "../../../app/api/auth/apple/callback/route";
import { POST as appleNative } from "../../../app/api/auth/apple/native/route";
import { GET as appleStart } from "../../../app/api/auth/apple/start/route";
import { POST as link } from "../../../app/api/auth/link/route";
import { POST as signup } from "../../../app/api/auth/signup/route";
import {
  appleFlowCookieName,
  appleNonceHash,
  openAppleToken,
  revokeAccountAppleTokens,
} from "../../lib/apple-sign-in";
import { hashPassword } from "../../lib/passwords";
import { resolveProviderSignIn } from "../../lib/provider-account";
import { linkConfirmMethods, pendingLinkCookieName } from "../../lib/provider-link";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { liveSessionByToken, reauthMethods } from "../../lib/recent-auth";
import { encryptSecret } from "../../lib/secrets";
import { createSession, sessionCookieName } from "../../lib/session";
import { pendingSignInCookieName } from "../../lib/two-factor";
import { startAppleFake, type AppleFake } from "../apple-fake";

// Sign in with Apple (src/lib/apple-sign-in.ts, docs/auth.md) end to end
// against the real tables and a stand-in for Apple's endpoints
// (src/test/apple-fake.ts): the app's native route, the web's round trip,
// the merge rules it shares with Google, and the revoke on deletion.

const baseUrl = "http://localhost:3000";
const db = createDb();
let apple: AppleFake;
const savedEnv: Record<string, string | undefined> = {};
const bundleId = "net.frameos.app";
const nonce = "a-nonce-the-app-made-0123456789";
let counter = 0;

beforeAll(async () => {
  apple = await startAppleFake();
  for (const [key, value] of Object.entries(apple.env)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
});

afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await apple.close();
  await db.$client.end({ timeout: 5 });
});

beforeEach(async () => {
  resetRateLimitForTests();
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

function person(overrides: Partial<{ email: string; sub: string }> = {}) {
  counter += 1;
  return {
    email: overrides.email ?? `apple-${counter}@privaterelay.appleid.com`,
    emailVerified: true,
    isPrivateEmail: true,
    sub: overrides.sub ?? `001234.apple-sub-${counter}`,
  };
}

function postJson(path: string, body: Record<string, unknown>, cookie?: string) {
  return new NextRequest(new URL(path, baseUrl), {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      origin: baseUrl,
      ...(cookie ? { cookie } : {}),
    },
    method: "POST",
  });
}

// What the app posts after the system sheet: a token for this nonce and a
// fresh code.
async function nativeBody(who: ReturnType<typeof person>, extra: Record<string, unknown> = {}) {
  return {
    authorization_code: apple.issueCode(who, { clientId: bundleId }),
    family_name: "Appleseed",
    given_name: "Jo",
    identity_token: await apple.identityToken(who, { audience: bundleId, nonce: appleNonceHash(nonce) }),
    nonce,
    ...extra,
  };
}

function setCookie(response: Response, name: string) {
  const header = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  return header?.split(";")[0]?.slice(name.length + 1);
}

async function appleIdentity(sub: string) {
  const [row] = await db
    .select()
    .from(accountIdentities)
    .where(eq(accountIdentities.providerSubject, sub));
  return row;
}

describe("Sign in with Apple from the app", () => {
  it("makes an account, signs it in, keeps the refresh token sealed, and spends the code", async () => {
    const who = person();
    const body = await nativeBody(who);
    const response = await appleNative(postJson("/api/auth/apple/native", body));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ email: who.email, ok: true });
    expect(setCookie(response, sessionCookieName)).toBeTruthy();

    const identity = await appleIdentity(who.sub);
    expect(identity).toMatchObject({
      emailSnapshot: who.email,
      emailVerified: true,
      providerIssuer: apple.url,
      providerKey: "apple",
    });
    expect(identity!.providerTokenEncrypted).not.toContain("refresh-");
    expect(openAppleToken(identity!.providerTokenEncrypted!)).toEqual({
      clientId: bundleId,
      refreshToken: `refresh-${body.authorization_code}`,
    });

    // The same token and code again: Apple has spent the code.
    const replay = await appleNative(postJson("/api/auth/apple/native", body));
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("refuses a token for another nonce, another audience or another person", async () => {
    const who = person();
    const wrongNonce = await appleNative(
      postJson("/api/auth/apple/native", await nativeBody(who, { nonce: "some-other-nonce-0123456789" })),
    );
    expect(await wrongNonce.json()).toMatchObject({ error: "invalid_grant" });

    const webToken = await appleNative(
      postJson("/api/auth/apple/native", {
        ...(await nativeBody(who)),
        identity_token: await apple.identityToken(who, {
          audience: "net.frameos.cloud.test",
          nonce: appleNonceHash(nonce),
        }),
      }),
    );
    expect(await webToken.json()).toMatchObject({ error: "invalid_grant" });

    const forged = await appleNative(
      postJson("/api/auth/apple/native", {
        ...(await nativeBody(who)),
        identity_token: await apple.identityToken(who, {
          audience: bundleId,
          issuer: "https://appleid.example.com",
          nonce: appleNonceHash(nonce),
        }),
      }),
    );
    expect(await forged.json()).toMatchObject({ error: "invalid_grant" });

    // A token for one person with a code issued to another.
    const other = person();
    const swapped = await appleNative(
      postJson("/api/auth/apple/native", {
        ...(await nativeBody(who)),
        authorization_code: apple.issueCode(other, { clientId: bundleId }),
      }),
    );
    expect(await swapped.json()).toMatchObject({ error: "invalid_grant" });
    expect(await appleIdentity(who.sub)).toBeUndefined();
    expect(await appleIdentity(other.sub)).toBeUndefined();
  });

  it("asks for the password of a verified password account with the same address, then links", async () => {
    const email = `owner-${counter}@example.com`;
    const password = "a long enough password";
    const account = await createPasswordAccount(db, {
      email,
      passwordHash: await hashPassword(password),
    });
    await ensurePasswordIdentityForAccount(db, account.accountId);
    const who = { ...person({ email }), isPrivateEmail: false };

    const first = await appleNative(postJson("/api/auth/apple/native", await nativeBody(who)));
    expect(first.status).toBe(409);
    expect(await first.json()).toMatchObject({ email, error: "link_required" });
    expect(setCookie(first, sessionCookieName)).toBeUndefined();
    expect(await appleIdentity(who.sub)).toBeUndefined();
    const pending = setCookie(first, pendingLinkCookieName);
    expect(pending).toBeTruthy();

    const wrong = await link(
      postJson("/api/auth/link", { password: "not it" }, `${pendingLinkCookieName}=${pending}`),
    );
    expect(wrong.status).toBe(403);

    const linked = await link(
      postJson("/api/auth/link", { password }, `${pendingLinkCookieName}=${pending}`),
    );
    expect(linked.status).toBe(200);
    expect(setCookie(linked, sessionCookieName)).toBeTruthy();
    const identity = await appleIdentity(who.sub);
    expect(identity).toMatchObject({ accountId: account.accountId, providerKey: "apple" });
    expect(openAppleToken(identity!.providerTokenEncrypted!).clientId).toBe(bundleId);

    // From here on Apple signs straight in.
    const again = await appleNative(postJson("/api/auth/apple/native", await nativeBody(who)));
    expect(again.status).toBe(200);
  });

  it("connects Apple to an account without a password once it is signed in to another way", async () => {
    const email = `google-first-${counter}@example.com`;
    const googleSubject = `google-${counter}`;
    const google = await upsertAccountFromIdentity(db, {
      email,
      emailVerified: true,
      providerIssuer: "https://accounts.google.com",
      providerKey: "google",
      providerSubject: googleSubject,
    });
    const who = { ...person({ email }), isPrivateEmail: false };
    const response = await appleNative(postJson("/api/auth/apple/native", await nativeBody(who)));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      detail: `A FrameOS Cloud account with ${email} already exists. Sign in to it once with Google to connect Sign in with Apple to it.`,
      email,
      error: "link_required",
      methods: { passkey: false, password: false, providers: ["google"] },
      other_ways: "Google",
    });
    expect(await appleIdentity(who.sub)).toBeUndefined();
    const pending = `${pendingLinkCookieName}=${setCookie(response, pendingLinkCookieName)}`;

    // Nothing proves the account yet: the answer lists the ways to.
    const bare = await link(postJson("/api/auth/link", {}, pending));
    expect(bare.status).toBe(400);
    expect(await bare.json()).toMatchObject({
      error: "confirm_required",
      methods: { password: false, providers: ["google"] },
    });

    const session = (accountId: string, subject: string, authenticatedAt?: Date) =>
      createSession(
        db,
        { accountId, providerIssuer: "https://accounts.google.com", providerSubject: subject },
        { authenticatedAt },
      );

    // Signed in to some other account: no proof of this one.
    const stranger = await upsertAccountFromIdentity(db, {
      email: `stranger-${counter}@example.com`,
      emailVerified: true,
      providerIssuer: "https://accounts.google.com",
      providerKey: "google",
      providerSubject: `stranger-${counter}`,
    });
    const elsewhere = await link(
      postJson(
        "/api/auth/link",
        {},
        `${pending}; ${sessionCookieName}=${await session(stranger.accountId, `stranger-${counter}`)}`,
      ),
    );
    expect(elsewhere.status).toBe(409);
    expect(await elsewhere.json()).toMatchObject({ error: "wrong_account" });

    // This account's session, but its sign-in is an hour old.
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const stale = await link(
      postJson(
        "/api/auth/link",
        {},
        `${pending}; ${sessionCookieName}=${await session(google.accountId, googleSubject, hourAgo)}`,
      ),
    );
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({ error: "reauth_required" });
    expect(await appleIdentity(who.sub)).toBeUndefined();

    // Signed in with Google just now. The account has a second factor, which
    // that sign-in already passed: none is asked again.
    await db.insert(accountTotp).values({
      accountId: google.accountId,
      confirmedAt: new Date(),
      encryptedSecret: encryptSecret("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"),
    });
    const fresh = await session(google.accountId, googleSubject);
    const linked = await link(
      postJson("/api/auth/link", {}, `${pending}; ${sessionCookieName}=${fresh}`),
    );
    expect(linked.status).toBe(200);
    expect(await linked.json()).toMatchObject({ ok: true });
    expect(setCookie(linked, sessionCookieName)).toBeTruthy();
    expect(setCookie(linked, pendingLinkCookieName)).toBe("");
    const identity = await appleIdentity(who.sub);
    expect(identity).toMatchObject({ accountId: google.accountId, providerKey: "apple" });
    expect(openAppleToken(identity!.providerTokenEncrypted!).clientId).toBe(bundleId);
    // The session that proved it goes, with every other one.
    expect(await liveSessionByToken(db, fresh)).toBeUndefined();

    // From here on Apple opens the account, second factor and all.
    const again = await appleNative(postJson("/api/auth/apple/native", await nativeBody(who)));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ second_factor_required: true });
  });

  it("keeps the password as a password account's way to confirm, and says what else works", async () => {
    const email = `owner-and-google-${counter}@example.com`;
    const account = await createPasswordAccount(db, {
      email,
      passwordHash: await hashPassword("a long enough password"),
    });
    await ensurePasswordIdentityForAccount(db, account.accountId);
    await linkIdentityToAccount(db, {
      accountId: account.accountId,
      email,
      emailVerified: true,
      providerIssuer: "https://accounts.google.com",
      providerKey: "google",
      providerSubject: `google-owner-${counter}`,
    });
    const who = { ...person({ email }), isPrivateEmail: false };
    const response = await appleNative(postJson("/api/auth/apple/native", await nativeBody(who)));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      detail: `A FrameOS Cloud account with ${email} already exists. Enter its password, or sign in to it with Google, to connect Sign in with Apple to it.`,
      methods: { passkey: false, password: true, providers: ["google"] },
    });
  });

  it("sends Google on an Apple-first address to the same confirmation, and refuses a password signup on it", async () => {
    const appleFirst = person({ email: `apple-first-${counter}@example.com` });
    expect((await appleNative(postJson("/api/auth/apple/native", await nativeBody(appleFirst)))).status).toBe(200);
    const identity = await appleIdentity(appleFirst.sub);

    // The web's Google callback asks resolveProviderSignIn too.
    expect(
      await resolveProviderSignIn(db, "google", "https://accounts.google.com", {
        email: appleFirst.email,
        email_verified: true,
        sub: `google-for-apple-${counter}`,
      }),
    ).toEqual({
      accountId: identity!.accountId,
      email: appleFirst.email,
      status: "requires_link_confirmation",
    });
    expect(await linkConfirmMethods(db, identity!.accountId, "google")).toEqual({
      passkey: false,
      password: false,
      providers: ["apple"],
    });

    // And signup will not plant a password on an Apple-first account.
    const taken = await signup(
      postJson("/api/auth/signup", { email: appleFirst.email, password: "a long enough password" }),
    );
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ error: "email_taken_apple" });
  });

  it("asks for the second factor when the account has one", async () => {
    const who = person();
    expect((await appleNative(postJson("/api/auth/apple/native", await nativeBody(who)))).status).toBe(200);
    const identity = await appleIdentity(who.sub);
    await db.insert(accountTotp).values({
      accountId: identity!.accountId,
      confirmedAt: new Date(),
      encryptedSecret: encryptSecret("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"),
    });

    const response = await appleNative(postJson("/api/auth/apple/native", await nativeBody(who)));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ second_factor_required: true });
    expect(setCookie(response, sessionCookieName)).toBeUndefined();
    expect(setCookie(response, pendingSignInCookieName)).toBeTruthy();
  });

  it("re-asks an Apple-only account through Apple, and revokes its tokens when it is deleted", async () => {
    const who = person();
    expect((await appleNative(postJson("/api/auth/apple/native", await nativeBody(who)))).status).toBe(200);
    const identity = await appleIdentity(who.sub);
    expect(await reauthMethods(db, identity!.accountId)).toEqual({
      code: false,
      passkey: false,
      password: false,
      providers: ["apple"],
      sign_in: true,
    });

    const sealed = openAppleToken(identity!.providerTokenEncrypted!);
    expect(await revokeAccountAppleTokens(db, identity!.accountId)).toEqual({ revoked: 1 });
    expect(apple.revoked).toContainEqual({ clientId: bundleId, token: sealed.refreshToken });
  });
});

describe("Sign in with Apple on the web", () => {
  it("goes to Apple with a signed flow cookie and comes back through a form POST", async () => {
    const start = await appleStart(
      new NextRequest(new URL("/api/auth/apple/start?return_to=/frames", baseUrl)),
    );
    expect(start.status).toBe(307);
    const authorize = new URL(start.headers.get("location")!);
    expect(authorize.origin + authorize.pathname).toBe(`${apple.url}/auth/authorize`);
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      client_id: "net.frameos.cloud.test",
      redirect_uri: `${baseUrl}/api/auth/apple/callback`,
      response_mode: "form_post",
      response_type: "code",
      scope: "name email",
    });
    const flowCookie = start.headers.getSetCookie().find((value) => value.startsWith(`${appleFlowCookieName}=`))!;
    expect(flowCookie).toContain("HttpOnly");
    expect(flowCookie).toContain("Path=/api/auth/apple");
    const flow = flowCookie.split(";")[0]!;

    const who = person();
    const form = (fields: Record<string, string>) =>
      new NextRequest(new URL("/api/auth/apple/callback", baseUrl), {
        body: new URLSearchParams(fields),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: flow,
          origin: "https://appleid.apple.com",
        },
        method: "POST",
      });

    // A state from somewhere else is refused before anything reaches Apple.
    const forged = await appleCallback(
      form({ code: apple.issueCode(who, { clientId: "net.frameos.cloud.test" }), state: "not-the-state" }),
    );
    expect(forged.status).toBe(303);
    expect(forged.headers.get("location")).toContain("/login?error=invalid_state");

    const callback = await appleCallback(
      form({
        code: apple.issueCode(who, {
          clientId: "net.frameos.cloud.test",
          nonce: authorize.searchParams.get("nonce")!,
        }),
        state: authorize.searchParams.get("state")!,
        user: JSON.stringify({ email: who.email, name: { firstName: "Jo", lastName: "Appleseed" } }),
      }),
    );
    // 303: the browser must not post again to where it goes next.
    expect(callback.status).toBe(303);
    expect(new URL(callback.headers.get("location")!).pathname).toBe("/frames");
    expect(setCookie(callback, sessionCookieName)).toBeTruthy();
    expect(setCookie(callback, appleFlowCookieName)).toBe("");

    const identity = await appleIdentity(who.sub);
    expect(identity).toMatchObject({ providerKey: "apple" });
    expect(openAppleToken(identity!.providerTokenEncrypted!).clientId).toBe("net.frameos.cloud.test");
    const [account] = await db.execute<{ display_name: string }>(
      sql`select display_name from accounts where id = ${identity!.accountId}`,
    );
    expect(account?.display_name).toBe("Jo Appleseed");
  });

  it("sends a cancel back to the login page with its reason", async () => {
    const response = await appleCallback(
      new NextRequest(new URL("/api/auth/apple/callback", baseUrl), {
        body: new URLSearchParams({ error: "user_cancelled_authorize" }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("/login?error=apple_cancelled");
  });
});
