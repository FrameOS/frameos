import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { createDb, sessions, upsertAccountFromIdentity } from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GET as authorize,
  POST as confirmAuthorize,
} from "../../../app/api/auth/app/authorize/route";
import { POST as exchange } from "../../../app/api/auth/app/token/route";
import { pkceChallenge } from "../../lib/app-sign-in";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { createSession, sessionCookieName } from "../../lib/session";
import { hashSecret } from "../../lib/secrets";

// The app sign-in handoff (src/lib/app-sign-in.ts) against the real tables:
// the browser half (authorize) with a cookie jar standing in for next/headers,
// the app half (token) as the app sends it.
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
const issuer = "https://accounts.google.com";
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

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { challenge: pkceChallenge(verifier), verifier };
}

function get(path: string) {
  return new NextRequest(new URL(path, baseUrl));
}

function postJson(path: string, body: Record<string, unknown>) {
  return new NextRequest(new URL(path, baseUrl), {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: baseUrl },
    method: "POST",
  });
}

function location(response: Response) {
  const value = response.headers.get("location");
  expect(value, `status ${response.status}`).toBeTruthy();
  return new URL(value!, baseUrl);
}

// A Google account signed in in "the browser" (the cookie jar).
async function signIn() {
  userCounter += 1;
  const email = `app-${userCounter}@example.com`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `App Tester ${userCounter}`,
    email,
    emailVerified: true,
    providerIssuer: issuer,
    providerKey: "google",
    providerSubject: `app-user-${userCounter}`,
  });
  const token = await createSession(db, {
    accountId,
    email,
    emailVerified: true,
    providerIssuer: issuer,
    providerSubject: `app-user-${userCounter}`,
  });
  cookieJar.set(sessionCookieName, token);
  return { accountId, email, token };
}

async function setAuthenticatedAt(token: string, at: Date) {
  await db
    .update(sessions)
    .set({ authenticatedAt: at })
    .where(eq(sessions.tokenHash, hashSecret(token)));
}

// The first visit, signed out: the request comes back as a signed token in
// the sign-in's return_to.
async function startSignedOut(challenge: string, extra = "") {
  const response = await authorize(
    get(`/api/auth/app/authorize?code_challenge=${challenge}&code_challenge_method=S256&state=app-state${extra}`),
  );
  const target = location(response);
  const returnTo = new URL(target.searchParams.get("return_to")!, baseUrl);
  return { returnTo, target, token: returnTo.searchParams.get("request")! };
}

describe("app sign-in", () => {
  it("sends a signed-out browser to sign in, then hands the app a session", async () => {
    const { challenge, verifier } = pkce();
    const { target, returnTo, token } = await startSignedOut(challenge);
    expect(target.pathname).toBe("/login");
    expect(returnTo.pathname).toBe("/api/auth/app/authorize");
    expect(token).toBeTruthy();

    // Signed in during the request: the code comes at once.
    const browser = await signIn();
    const back = location(await authorize(get(`/api/auth/app/authorize?request=${encodeURIComponent(token)}`)));
    expect(`${back.protocol}//${back.host}`).toBe("frameos://sign-in");
    expect(back.searchParams.get("state")).toBe("app-state");
    const code = back.searchParams.get("code")!;
    // The URL names no one by email.
    expect(back.toString()).not.toContain(browser.email);

    // A wrong verifier gets nothing (and does not spend the code).
    const wrong = await exchange(postJson("/api/auth/app/token", { code, code_verifier: pkce().verifier }));
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: "invalid_grant" });

    const answer = await exchange(postJson("/api/auth/app/token", { code, code_verifier: verifier }));
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ email: browser.email, ok: true });
    const appToken = answer.cookies.get(sessionCookieName)?.value;
    expect(appToken).toBeTruthy();
    expect(appToken).not.toBe(browser.token);
    const [row] = await db
      .select({ accountId: sessions.accountId, revokedAt: sessions.revokedAt })
      .from(sessions)
      .where(eq(sessions.tokenHash, hashSecret(appToken!)));
    expect(row).toEqual({ accountId: browser.accountId, revokedAt: null });

    // Once.
    const replay = await exchange(postJson("/api/auth/app/token", { code, code_verifier: verifier }));
    expect(replay.status).toBe(400);
  });

  it("goes straight to Google when the app asks for it", async () => {
    const saved = { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET };
    process.env.GOOGLE_CLIENT_ID = "test-client";
    process.env.GOOGLE_CLIENT_SECRET = "test-secret";
    try {
      const { target, returnTo } = await startSignedOut(pkce().challenge, "&provider=google");
      expect(target.pathname).toBe("/api/auth/google/start");
      expect(returnTo.pathname).toBe("/api/auth/app/authorize");
    } finally {
      process.env.GOOGLE_CLIENT_ID = saved.id;
      process.env.GOOGLE_CLIENT_SECRET = saved.secret;
      if (saved.id === undefined) delete process.env.GOOGLE_CLIENT_ID;
      if (saved.secret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    }
  });

  it("asks before handing on a session from before the request", async () => {
    const browser = await signIn();
    await setAuthenticatedAt(browser.token, new Date(Date.now() - 60 * 60 * 1000));
    const { challenge, verifier } = pkce();
    const confirm = location(
      await authorize(get(`/api/auth/app/authorize?code_challenge=${challenge}&state=s1`)),
    );
    expect(confirm.pathname).toBe("/login/app");
    const request = confirm.searchParams.get("request")!;

    // "Continue as …"
    const pressed = await confirmAuthorize(postJson("/api/auth/app/authorize", { request }));
    expect(pressed.status).toBe(200);
    const { redirect } = (await pressed.json()) as { redirect: string };
    const code = new URL(redirect).searchParams.get("code")!;

    // The app's session keeps the browser session's proof time: a handoff is
    // never a fresh sign-in for sudo mode.
    const answer = await exchange(postJson("/api/auth/app/token", { code, code_verifier: verifier }));
    expect(answer.status).toBe(200);
    const appToken = answer.cookies.get(sessionCookieName)!.value;
    const [browserRow] = await db
      .select({ at: sessions.authenticatedAt })
      .from(sessions)
      .where(eq(sessions.tokenHash, hashSecret(browser.token)));
    const [appRow] = await db
      .select({ at: sessions.authenticatedAt })
      .from(sessions)
      .where(eq(sessions.tokenHash, hashSecret(appToken)));
    expect(appRow!.at.getTime()).toBe(browserRow!.at.getTime());
  });

  it("refuses the confirm without the browser's own origin", async () => {
    const browser = await signIn();
    await setAuthenticatedAt(browser.token, new Date(Date.now() - 60 * 60 * 1000));
    const confirm = location(
      await authorize(get(`/api/auth/app/authorize?code_challenge=${pkce().challenge}&state=s1`)),
    );
    const request = confirm.searchParams.get("request")!;
    const forged = new NextRequest(new URL("/api/auth/app/authorize", baseUrl), {
      body: JSON.stringify({ request }),
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      method: "POST",
    });
    expect((await confirmAuthorize(forged)).status).toBe(403);
  });

  it("sends a stale session through sudo mode when the app asks to confirm it is you", async () => {
    const browser = await signIn();
    await setAuthenticatedAt(browser.token, new Date(Date.now() - 60 * 60 * 1000));
    const target = location(
      await authorize(get(`/api/auth/app/authorize?code_challenge=${pkce().challenge}&state=s2&reauth=1`)),
    );
    expect(target.pathname).toBe("/login/reauth");
    expect(new URL(target.searchParams.get("return_to")!, baseUrl).pathname).toBe("/api/auth/app/authorize");

    // Proved again: straight to the app, with the fresh proof time.
    await setAuthenticatedAt(browser.token, new Date());
    const back = location(await authorize(get(target.searchParams.get("return_to")!)));
    expect(back.searchParams.get("code")).toBeTruthy();
  });

  it("ends with an error for the app on cancel and on a bad challenge", async () => {
    const cancelled = location(
      await authorize(
        get(`/api/auth/app/authorize?request=${encodeURIComponent((await startSignedOut(pkce().challenge)).token)}&cancel=1`),
      ),
    );
    expect(cancelled.searchParams.get("error")).toBe("access_denied");
    expect(cancelled.searchParams.get("state")).toBe("app-state");

    const bad = location(await authorize(get("/api/auth/app/authorize?code_challenge=short&state=s3")));
    expect(`${bad.protocol}//${bad.host}`).toBe("frameos://sign-in");
    expect(bad.searchParams.get("error")).toBe("invalid_request");

    const noState = await authorize(get(`/api/auth/app/authorize?code_challenge=${pkce().challenge}`));
    expect(noState.status).toBe(400);
  });

  it("never hands on a code whose account is gone", async () => {
    const { challenge, verifier } = pkce();
    const { token } = await startSignedOut(challenge);
    const browser = await signIn();
    const back = location(await authorize(get(`/api/auth/app/authorize?request=${encodeURIComponent(token)}`)));
    await db.execute(sql`delete from accounts where id = ${browser.accountId}`);
    const answer = await exchange(
      postJson("/api/auth/app/token", { code: back.searchParams.get("code"), code_verifier: verifier }),
    );
    expect(answer.status).toBe(400);
  });
});
