import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  createDb,
  deviceAuthorizationRequests,
  linkedClients,
  sessions,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as setScopes } from "../../../app/api/backends/scopes/route";
import { POST as authorizeDevice } from "../../../app/api/device/authorize/route";
import { POST as pollDevice } from "../../../app/api/device/poll/route";
import { GET as lookupDeviceRequest } from "../../../app/api/device/request/route";
import { POST as startDevice } from "../../../app/api/device/start/route";
import { GET as cloudLogout } from "../../../app/logout/route";
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
const backendOrigin = "http://10.3.3.3:8989";
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

function getJson(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(new URL(path, baseUrl), { headers });
}

async function readJson(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

async function signIn() {
  userCounter += 1;
  const providerSubject = `scope-change-user-${userCounter}`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Scope Tester ${userCounter}`,
    email: `scope-${userCounter}@example.com`,
    emailVerified: true,
    providerIssuer: issuer,
    providerKey: "google",
    providerSubject,
  });
  const token = await createSession(db, {
    accountId,
    providerIssuer: issuer,
    providerSubject,
  });
  cookieJar.set(sessionCookieName, token);
  return { accountId, token };
}

async function linkClient(scopes: string[], reuseSession = false) {
  const startResponse = await startDevice(
    postJson("/api/device/start", {
      local_origin: backendOrigin,
      public_display_name: "Scoped Backend",
      scopes,
    }),
  );
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
    postJson("/api/device/poll", { device_code: startPayload.device_code }),
  );
  const { access_token: accessToken, linked_client_id: linkedClientId } =
    await readJson(pollResponse);
  return {
    accessToken: accessToken as string,
    linkedClientId: linkedClientId as string,
    session,
  };
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("scope changes (enabled features)", () => {
  it("applies scope reductions immediately, without consent", async () => {
    const { accessToken, linkedClientId } = await linkClient([
      "backend:link",
      "backend:read",
      "auth:login",
      "backup:frames",
    ]);

    const response = await setScopes(
      postJson(
        "/api/backends/scopes",
        { scopes: ["backend:link", "backend:read", "auth:login"] },
        bearer(accessToken),
      ),
    );
    expect(response.status).toBe(200);
    const payload = await readJson(response);
    expect(payload.status).toBe("updated");
    expect(payload.scope).toBe("backend:link backend:read auth:login");

    const [client] = await db
      .select()
      .from(linkedClients)
      .where(eq(linkedClients.id, linkedClientId));
    const metadata = client?.providerClientMetadata as Record<string, unknown>;
    expect(metadata.requestedScopes).toEqual([
      "backend:link",
      "backend:read",
      "auth:login",
    ]);
  });

  it("never adds scopes without owner approval, even account-included ones", async () => {
    const { accessToken, linkedClientId } = await linkClient([
      "backend:link",
      "backend:read",
    ]);

    const response = await setScopes(
      postJson(
        "/api/backends/scopes",
        {
          scopes: [
            "backend:link",
            "backend:read",
            "backup:scenes",
            "backup:frames",
            "store:publish",
          ],
        },
        bearer(accessToken),
      ),
    );
    expect(response.status).toBe(200);
    const payload = await readJson(response);
    expect(payload.status).toBe("approval_required");
    expect(payload.device_code).toBeDefined();

    // Nothing changes until the owner approves on the device screen.
    const [client] = await db
      .select()
      .from(linkedClients)
      .where(eq(linkedClients.id, linkedClientId));
    const metadata = client?.providerClientMetadata as Record<string, unknown>;
    expect(metadata.requestedScopes).toEqual(["backend:link", "backend:read"]);
  });

  it("never drops the base link scope", async () => {
    const { accessToken } = await linkClient(["backend:link", "backend:read"]);

    const response = await setScopes(
      postJson("/api/backends/scopes", { scopes: [] }, bearer(accessToken)),
    );
    // parseScopes falls back to the defaults for an empty list; the base
    // scopes survive regardless.
    expect(response.status).toBe(200);
    const payload = await readJson(response);
    expect(payload.scope).toContain("backend:link");
  });

  it("requires owner approval to add scopes, then updates in place", async () => {
    const { accessToken, linkedClientId } = await linkClient([
      "backend:link",
      "backend:read",
    ]);

    const response = await setScopes(
      postJson(
        "/api/backends/scopes",
        {
          scopes: [
            "backend:link",
            "backend:read",
            "auth:login",
            "backup:frames",
          ],
        },
        bearer(accessToken),
      ),
    );
    expect(response.status).toBe(200);
    const payload = await readJson(response);
    expect(payload.status).toBe("approval_required");
    expect(payload.user_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const deviceCode = payload.device_code as string;
    const userCode = payload.user_code as string;

    // The consent lookup flags this as a feature change for the UI.
    const lookup = await lookupDeviceRequest(
      getJson(`/api/device/request?user_code=${userCode}`),
    );
    expect((await readJson(lookup)).scope_change).toBe(true);

    // Pending until approved.
    const pendingPoll = await pollDevice(
      postJson("/api/device/poll", { device_code: deviceCode }),
    );
    expect(pendingPoll.status).toBe(428);

    const authorizeResponse = await authorizeDevice(
      postJson(
        "/api/device/authorize",
        { user_code: userCode },
        { origin: baseUrl },
      ),
    );
    expect(authorizeResponse.status).toBe(200);
    expect((await readJson(authorizeResponse)).linked_client_id).toBe(
      linkedClientId,
    );

    // Poll returns the new scopes but NO new token — the credential is
    // unchanged.
    const pollResponse = await pollDevice(
      postJson("/api/device/poll", { device_code: deviceCode }),
    );
    expect(pollResponse.status).toBe(200);
    const pollPayload = await readJson(pollResponse);
    expect(pollPayload.access_token).toBeUndefined();
    expect(pollPayload.status).toBe("approved");
    expect(pollPayload.scope).toBe(
      "backend:link backend:read auth:login backup:frames",
    );
    expect(pollPayload.linked_client_id).toBe(linkedClientId);

    const [client] = await db
      .select()
      .from(linkedClients)
      .where(eq(linkedClients.id, linkedClientId));
    const metadata = client?.providerClientMetadata as Record<string, unknown>;
    expect(metadata.requestedScopes).toEqual([
      "backend:link",
      "backend:read",
      "auth:login",
      "backup:frames",
    ]);

    // The old token still authenticates (unchanged credential).
    const again = await setScopes(
      postJson(
        "/api/backends/scopes",
        { scopes: ["backend:link", "backend:read"] },
        bearer(accessToken),
      ),
    );
    expect(again.status).toBe(200);
  });

  it("only the owning account can approve a feature change", async () => {
    const { accessToken } = await linkClient(["backend:link", "backend:read"]);

    const response = await setScopes(
      postJson(
        "/api/backends/scopes",
        { scopes: ["backend:link", "backend:read", "auth:login"] },
        bearer(accessToken),
      ),
    );
    const { user_code: userCode } = await readJson(response);

    // A different signed-in account cannot approve it.
    await signIn();
    const authorizeResponse = await authorizeDevice(
      postJson(
        "/api/device/authorize",
        { user_code: userCode },
        { origin: baseUrl },
      ),
    );
    expect(authorizeResponse.status).toBe(403);
    expect((await readJson(authorizeResponse)).error).toBe(
      "linked_client_required",
    );

    const requests = await db.select().from(deviceAuthorizationRequests);
    const upgradeRequest = requests.find((row) => row.upgradeLinkedClientId);
    expect(upgradeRequest?.status).toBe("pending");
  });

  it("rejects scope changes without a valid link token", async () => {
    const response = await setScopes(
      postJson(
        "/api/backends/scopes",
        { scopes: ["backend:link"] },
        bearer("fc_link_bogus"),
      ),
    );
    expect(response.status).toBe(401);
  });
});

describe("cloud logout for linked installs", () => {
  it("revokes the session and returns to a linked client's origin", async () => {
    const { session } = await linkClient([
      "backend:link",
      "backend:read",
      "auth:login",
    ]);

    const response = await cloudLogout(
      getJson(
        `/logout?return_to=${encodeURIComponent(`${backendOrigin}/login`)}`,
        { cookie: `${sessionCookieName}=${session?.token}` },
      ),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${backendOrigin}/login`);

    // The session row is revoked, not just the cookie cleared.
    const rows = await db.select().from(sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revokedAt).not.toBeNull();
  });

  it("ignores return_to origins that no linked client registered", async () => {
    const { session } = await linkClient(["backend:link", "backend:read"]);

    const response = await cloudLogout(
      getJson(
        `/logout?return_to=${encodeURIComponent("https://evil.example/login")}`,
        { cookie: `${sessionCookieName}=${session?.token}` },
      ),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("/login");
    expect(response.headers.get("location")).not.toContain("evil.example");
  });

  it("allows loopback return_to for development", async () => {
    const { session } = await linkClient(["backend:link", "backend:read"]);

    const response = await cloudLogout(
      getJson(
        `/logout?return_to=${encodeURIComponent("http://localhost:8616/login")}`,
        { cookie: `${sessionCookieName}=${session?.token}` },
      ),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost:8616/login",
    );
  });

  it("still signs out without a return_to", async () => {
    const { token } = await signIn();
    const response = await cloudLogout(
      getJson("/logout", { cookie: `${sessionCookieName}=${token}` }),
    );
    expect(response.status).toBe(303);
    const rows = await db.select().from(sessions);
    expect(rows[0]?.revokedAt).not.toBeNull();
  });
});
