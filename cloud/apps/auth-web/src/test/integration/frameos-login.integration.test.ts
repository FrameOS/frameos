import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  createDb,
  frameosLoginCodes,
  linkedClients,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as authorizeDevice } from "../../../app/api/device/authorize/route";
import { POST as pollDevice } from "../../../app/api/device/poll/route";
import { POST as startDevice } from "../../../app/api/device/start/route";
import { GET as authorizeLogin } from "../../../app/api/frameos/login/authorize/route";
import { POST as startLogin } from "../../../app/api/frameos/login/start/route";
import { POST as redeemLoginCode } from "../../../app/api/frameos/login/token/route";
import { resetRateLimitForTests } from "../../lib/rate-limit";
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
const backendOrigin = "http://10.1.1.2:8989";
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

function postJson(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return new NextRequest(new URL(path, baseUrl), {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });
}

async function readJson(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

async function signIn() {
  userCounter += 1;
  const providerSubject = `login-handoff-user-${userCounter}`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Handoff Tester ${userCounter}`,
    email: `handoff-${userCounter}@example.com`,
    emailVerified: true,
    providerIssuer: issuer,
    providerKey: "google",
    providerSubject,
  });
  const token = await createSession(db, {
    accountId,
    email: `handoff-${userCounter}@example.com`,
    emailVerified: true,
    name: `Handoff Tester ${userCounter}`,
    providerIssuer: issuer,
    providerSubject,
  });
  cookieJar.set(sessionCookieName, token);
  return { accountId, providerSubject };
}

// Full device flow with the given scopes; the currently signed-in session (or
// a fresh one) approves. Returns the minted link token.
async function linkBackend(scopes: string[], reuseSession = false) {
  const startResponse = await startDevice(
    postJson("/api/device/start", {
      local_origin: backendOrigin,
      public_display_name: "Handoff Backend",
      scopes,
    }),
  );
  expect(startResponse.status).toBe(200);
  const startPayload = await readJson(startResponse);

  const session = reuseSession ? undefined : await signIn();
  const authorizeResponse = await authorizeDevice(
    postJson(
      "/api/device/authorize",
      { user_code: startPayload.user_code },
      { origin: baseUrl },
    ),
  );
  expect(authorizeResponse.status).toBe(200);

  const pollResponse = await pollDevice(
    postJson("/api/device/poll", {
      device_code: startPayload.device_code,
    }),
  );
  expect(pollResponse.status).toBe(200);
  const { access_token: accessToken } = await readJson(pollResponse);
  return { accessToken: accessToken as string, session };
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

/** Runs start + authorize and returns the single-use login code. */
async function runHandoffForCode(accessToken: string) {
  const startResponse = await startLogin(
    postJson(
      "/api/frameos/login/start",
      {
        redirect_uri: `${backendOrigin}/api/cloud/login/callback`,
        state: "state-helper",
      },
      bearer(accessToken),
    ),
  );
  expect(startResponse.status).toBe(200);
  const { authorization_url: authorizationUrl } = await readJson(startResponse);
  const authorizeResponse = await authorizeLogin(
    new NextRequest(new URL(authorizationUrl as string)),
  );
  const location = new URL(authorizeResponse.headers.get("location") ?? "");
  const code = location.searchParams.get("code");
  expect(code).toMatch(/^fc_login_/);
  return code as string;
}

describe("frameos login handoff", () => {
  it("logs a user in end-to-end: start, authorize, code exchange", async () => {
    const { accessToken, session } = await linkBackend([
      "backend:link",
      "backend:read",
      "auth:login",
    ]);

    const startResponse = await startLogin(
      postJson(
        "/api/frameos/login/start",
        {
          redirect_uri: `${backendOrigin}/api/cloud/login/callback`,
          state: "state-123",
        },
        bearer(accessToken),
      ),
    );
    expect(startResponse.status).toBe(200);
    const { authorization_url: authorizationUrl } =
      await readJson(startResponse);
    expect(authorizationUrl).toContain("/api/frameos/login/authorize?request=");

    // The signed-in owner follows the authorization URL and is bounced back to
    // the backend with a single-use code.
    const authorizeResponse = await authorizeLogin(
      new NextRequest(new URL(authorizationUrl as string)),
    );
    expect(authorizeResponse.status).toBeGreaterThanOrEqual(302);
    const location = new URL(authorizeResponse.headers.get("location") ?? "");
    expect(location.origin).toBe(backendOrigin);
    expect(location.searchParams.get("state")).toBe("state-123");
    const code = location.searchParams.get("code");
    expect(code).toMatch(/^fc_login_/);

    const tokenResponse = await redeemLoginCode(
      postJson("/api/frameos/login/token", { code }, bearer(accessToken)),
    );
    expect(tokenResponse.status).toBe(200);
    const tokenPayload = await readJson(tokenResponse);
    const claims = tokenPayload.claims as Record<string, unknown>;
    expect(claims.account_id).toBe(session?.accountId);
    expect(claims.provider_subject).toBe(session?.providerSubject);
    expect(claims.email_verified).toBe(true);
    expect(tokenPayload.provider_issuer).toBe(issuer);

    // The code is single-use.
    const replayResponse = await redeemLoginCode(
      postJson("/api/frameos/login/token", { code }, bearer(accessToken)),
    );
    expect(replayResponse.status).toBe(400);
  });

  it("clears the profile snapshot once the claims are released", async () => {
    const { accessToken } = await linkBackend([
      "backend:link",
      "backend:read",
      "auth:login",
    ]);
    const code = await runHandoffForCode(accessToken);

    const tokenResponse = await redeemLoginCode(
      postJson("/api/frameos/login/token", { code }, bearer(accessToken)),
    );
    expect(tokenResponse.status).toBe(200);

    // The row still proves the code was used, but no longer carries the
    // account's email, name and subject waiting for a cleanup run.
    const rows = await db.select().from(frameosLoginCodes);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.redeemedAt).not.toBeNull();
    expect(rows[0]?.profile).toEqual({});
  });

  it("stops honouring a login request once auth:login is removed", async () => {
    const { accessToken } = await linkBackend([
      "backend:link",
      "backend:read",
      "auth:login",
    ]);

    const startResponse = await startLogin(
      postJson(
        "/api/frameos/login/start",
        {
          redirect_uri: `${backendOrigin}/api/cloud/login/callback`,
          state: "state-scope",
        },
        bearer(accessToken),
      ),
    );
    expect(startResponse.status).toBe(200);
    const { authorization_url: authorizationUrl } =
      await readJson(startResponse);

    // The request token lives for 10 minutes; revoking the scope in that
    // window must take effect immediately, not when the token expires.
    await db
      .update(linkedClients)
      .set({
        providerClientMetadata: { requestedScopes: ["backend:link", "backend:read"] },
      });

    const authorizeResponse = await authorizeLogin(
      new NextRequest(new URL(authorizationUrl as string)),
    );
    const location = new URL(authorizeResponse.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("insufficient_scope");
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("stops honouring an already-minted code once auth:login is removed", async () => {
    const { accessToken } = await linkBackend([
      "backend:link",
      "backend:read",
      "auth:login",
    ]);
    const code = await runHandoffForCode(accessToken);

    await db
      .update(linkedClients)
      .set({
        providerClientMetadata: { requestedScopes: ["backend:link", "backend:read"] },
      });

    const tokenResponse = await redeemLoginCode(
      postJson("/api/frameos/login/token", { code }, bearer(accessToken)),
    );
    expect(tokenResponse.status).toBe(403);
    expect((await readJson(tokenResponse)).error).toBe("insufficient_scope");
  });

  it("requires the auth:login scope to start a handoff", async () => {
    const { accessToken } = await linkBackend(["backend:link", "backend:read"]);

    const startResponse = await startLogin(
      postJson(
        "/api/frameos/login/start",
        {
          redirect_uri: `${backendOrigin}/api/cloud/login/callback`,
          state: "state-123",
        },
        bearer(accessToken),
      ),
    );
    expect(startResponse.status).toBe(403);
    expect((await readJson(startResponse)).error).toBe("insufficient_scope");
  });

  it("rejects redirect URIs off the linked backend's origin", async () => {
    const { accessToken } = await linkBackend([
      "backend:link",
      "auth:login",
    ]);

    const startResponse = await startLogin(
      postJson(
        "/api/frameos/login/start",
        {
          redirect_uri: "http://evil.example/api/cloud/login/callback",
          state: "state-123",
        },
        bearer(accessToken),
      ),
    );
    expect(startResponse.status).toBe(400);
    expect((await readJson(startResponse)).error).toBe("invalid_redirect_uri");
  });

  it("only lets the owning account complete a handoff", async () => {
    const { accessToken } = await linkBackend([
      "backend:link",
      "auth:login",
    ]);

    const startResponse = await startLogin(
      postJson(
        "/api/frameos/login/start",
        {
          redirect_uri: `${backendOrigin}/api/cloud/login/callback`,
          state: "state-123",
        },
        bearer(accessToken),
      ),
    );
    const { authorization_url: authorizationUrl } =
      await readJson(startResponse);

    // A different signed-in account cannot mint a login code for a backend it
    // does not own; it is bounced back with an error instead.
    await signIn();
    const authorizeResponse = await authorizeLogin(
      new NextRequest(new URL(authorizationUrl as string)),
    );
    const location = new URL(authorizeResponse.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("linked_client_required");
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("works for frames that link directly", async () => {
    const { accessToken, session } = await linkBackend([
      "frame:link",
      "auth:login",
    ]);

    const startResponse = await startLogin(
      postJson(
        "/api/frameos/login/start",
        {
          redirect_uri: `${backendOrigin}/api/cloud/login/callback`,
          state: "frame-state",
        },
        bearer(accessToken),
      ),
    );
    expect(startResponse.status).toBe(200);
    const { authorization_url: authorizationUrl } =
      await readJson(startResponse);

    const authorizeResponse = await authorizeLogin(
      new NextRequest(new URL(authorizationUrl as string)),
    );
    const location = new URL(authorizeResponse.headers.get("location") ?? "");
    const code = location.searchParams.get("code");

    const tokenResponse = await redeemLoginCode(
      postJson("/api/frameos/login/token", { code }, bearer(accessToken)),
    );
    expect(tokenResponse.status).toBe(200);
    const claims = (await readJson(tokenResponse)).claims as Record<
      string,
      unknown
    >;
    expect(claims.account_id).toBe(session?.accountId);
  });
});
