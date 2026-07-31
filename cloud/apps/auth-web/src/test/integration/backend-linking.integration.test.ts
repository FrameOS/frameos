import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  accounts,
  auditEvents,
  connectedBackends,
  consentEvents,
  createDb,
  deviceAuthorizationRequests,
  linkedClients,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as backendGrants } from "../../../app/api/backends/grants/route";
import { POST as backendInventory } from "../../../app/api/backends/inventory/route";
import { POST as rotateToken } from "../../../app/api/backends/rotate-token/route";
import { POST as unlinkBackend } from "../../../app/api/backends/unlink/route";
import { POST as authorizeDevice } from "../../../app/api/device/authorize/route";
import { POST as denyDevice } from "../../../app/api/device/deny/route";
import { POST as pollDevice } from "../../../app/api/device/poll/route";
import { GET as lookupDeviceRequest } from "../../../app/api/device/request/route";
import { POST as revokeLinkedClient } from "../../../app/api/device/revoke/route";
import { POST as startDevice } from "../../../app/api/device/start/route";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { hashSecret } from "../../lib/secrets";
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
const issuer = "https://accounts.google.com";
const db = createDb();
let userCounter = 0;

afterAll(async () => {
  await db.$client.end({ timeout: 5 });
});

beforeEach(async () => {
  resetRateLimitForTests();
  cookieJar.clear();
  await truncateAllTables();
});

async function truncateAllTables() {
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
}

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

// Creates a fresh account with a real session row and puts the session cookie
// in the jar, mirroring what the OAuth callback does after a login.
async function signIn() {
  userCounter += 1;
  const providerSubject = `integration-user-${userCounter}`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Integration Tester ${userCounter}`,
    email: `tester-${userCounter}@example.com`,
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
  return accountId;
}

async function startDeviceRequest(
  body: Record<string, unknown> = {
    capabilities: { scenes: true },
    local_origin: "http://10.0.0.5:8989",
    public_display_name: "Test Backend",
    reported_frameos_version: "1.0.0",
  },
) {
  const response = await startDevice(postJson("/api/device/start", body));
  expect(response.status).toBe(200);
  const payload = await readJson(response);
  return {
    deviceCode: payload.device_code as string,
    payload,
    userCode: payload.user_code as string,
  };
}

// Runs the full linking flow (start, approve, poll) and returns the minted
// link token, for tests that exercise the authenticated backend APIs.
async function linkBackend() {
  const { deviceCode, userCode } = await startDeviceRequest();
  const accountId = await signIn();

  const authorizeResponse = await authorizeDevice(
    postJson("/api/device/authorize", { user_code: userCode }, { origin: baseUrl }),
  );
  expect(authorizeResponse.status).toBe(200);
  const { linked_client_id: linkedClientId } = await readJson(authorizeResponse);

  const pollResponse = await pollDevice(
    postJson("/api/device/poll", { device_code: deviceCode }),
  );
  expect(pollResponse.status).toBe(200);
  const { access_token: accessToken } = await readJson(pollResponse);

  return {
    accessToken: accessToken as string,
    accountId,
    linkedClientId: linkedClientId as string,
  };
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("backend linking flow", () => {
  it("links a backend end-to-end through the device authorization flow", async () => {
    const { deviceCode, payload, userCode } = await startDeviceRequest();

    expect(deviceCode).toMatch(/^fc_device_/);
    expect(userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(payload.expires_in).toBe(600);
    expect(payload.verification_uri).toBe(`${baseUrl}/device`);
    expect(payload.verification_uri_complete).toBe(
      `${baseUrl}/device?user_code=${userCode}`,
    );

    // The stored copy of the user code is masked; the full code only exists in
    // the start response.
    const [stored] = await db.select().from(deviceAuthorizationRequests);
    expect(stored?.userCodeDisplay).toBe(`${userCode.slice(0, 4)}-****`);
    expect(stored?.status).toBe("pending");

    // Anonymous code lookups are rejected outright: finding a device requires
    // a signed-in session.
    const anonymousLookup = await lookupDeviceRequest(
      getJson(`/api/device/request?user_code=${userCode}`),
    );
    expect(anonymousLookup.status).toBe(401);
    expect((await readJson(anonymousLookup)).error).toBe("login_required");

    // Polling before approval reports pending and counts the poll.
    const pendingPoll = await pollDevice(
      postJson("/api/device/poll", { device_code: deviceCode }),
    );
    expect(pendingPoll.status).toBe(428);
    expect((await readJson(pendingPoll)).error).toBe("authorization_pending");
    const [polled] = await db.select().from(deviceAuthorizationRequests);
    expect(polled?.pollCount).toBe(1);

    // Approval requires a signed-in session.
    const unauthenticated = await authorizeDevice(
      postJson("/api/device/authorize", { user_code: userCode }, { origin: baseUrl }),
    );
    expect(unauthenticated.status).toBe(401);

    const accountId = await signIn();

    const signedInLookup = await lookupDeviceRequest(
      getJson(`/api/device/request?user_code=${userCode}`),
    );
    const signedInPayload = await readJson(signedInLookup);
    expect(signedInPayload.signed_in).toBe(true);
    expect(signedInPayload.local_origin).toBe("http://10.0.0.5:8989");
    expect(signedInPayload.public_display_name).toBe("Test Backend");
    expect(signedInPayload.scope_change).toBe(false);

    const authorizeResponse = await authorizeDevice(
      postJson("/api/device/authorize", { user_code: userCode }, { origin: baseUrl }),
    );
    expect(authorizeResponse.status).toBe(200);
    const authorizePayload = await readJson(authorizeResponse);
    expect(authorizePayload.status).toBe("approved");
    const linkedClientId = authorizePayload.linked_client_id as string;

    // Approval atomically created the linked client, connected backend,
    // consent event, and audit trail.
    const [linkedClient] = await db.select().from(linkedClients);
    expect(linkedClient?.id).toBe(linkedClientId);
    expect(linkedClient?.accountId).toBe(accountId);
    expect(linkedClient?.publicDisplayName).toBe("Test Backend");
    expect(linkedClient?.localOrigin).toBe("http://10.0.0.5:8989");
    expect(linkedClient?.clientKind).toBe("backend");

    const backends = await db.select().from(connectedBackends);
    expect(backends).toHaveLength(1);
    expect(backends[0]?.linkedClientId).toBe(linkedClientId);
    expect(backends[0]?.capabilities).toEqual({ scenes: true });

    const [consent] = await db.select().from(consentEvents);
    expect(consent?.decision).toBe("approved");
    expect(consent?.accountId).toBe(accountId);

    const audits = await db.select().from(auditEvents);
    expect(audits.map((event) => event.eventType)).toContain(
      "device_authorization.approved",
    );

    // A second approval of the same code conflicts.
    const repeatAuthorize = await authorizeDevice(
      postJson("/api/device/authorize", { user_code: userCode }, { origin: baseUrl }),
    );
    expect(repeatAuthorize.status).toBe(409);
    expect((await readJson(repeatAuthorize)).error).toBe(
      "device_request_approved",
    );

    // The backend polls once more and receives the link token.
    const approvedPoll = await pollDevice(
      postJson("/api/device/poll", { device_code: deviceCode }),
    );
    expect(approvedPoll.status).toBe(200);
    const tokenPayload = await readJson(approvedPoll);
    const accessToken = tokenPayload.access_token as string;
    expect(accessToken).toMatch(/^fc_link_/);
    expect(tokenPayload.token_type).toBe("Bearer");
    expect(tokenPayload.linked_client_id).toBe(linkedClientId);
    expect(tokenPayload.token_reference).toBe(hashSecret(accessToken));
    expect(tokenPayload.scope).toBe("backend:link backend:read");
    // The approver's identity comes along so FrameOS can map its local user
    // to this cloud account without a second handoff.
    const approvedBy = tokenPayload.approved_by as Record<string, unknown>;
    expect(approvedBy.account_id).toBe(accountId);
    expect(approvedBy.provider_subject).toBeTruthy();
    expect(approvedBy.provider_issuer).toBeTruthy();

    // The device code is single-use: a replay cannot fetch the token again.
    const replayedPoll = await pollDevice(
      postJson("/api/device/poll", { device_code: deviceCode }),
    );
    expect(replayedPoll.status).toBe(400);
    expect((await readJson(replayedPoll)).error).toBe("expired_token");

    // The minted token authenticates the backend APIs.
    const grantsResponse = await backendGrants(
      getJson("/api/backends/grants", bearer(accessToken)),
    );
    expect(grantsResponse.status).toBe(200);
    const grantsPayload = await readJson(grantsResponse);
    expect(grantsPayload.linked_client_id).toBe(linkedClientId);
    expect(grantsPayload.grants).toEqual([
      expect.objectContaining({
        account_email: expect.stringMatching(/^tester-\d+@example\.com$/),
        account_id: accountId,
        role: "owner",
      }),
    ]);

    const inventoryResponse = await backendInventory(
      postJson(
        "/api/backends/inventory",
        {
          capabilities: { scenes: true, ssh: false },
          health: { frames: 2 },
          reported_frameos_version: "1.2.3",
        },
        bearer(accessToken),
      ),
    );
    expect(inventoryResponse.status).toBe(200);
    expect((await readJson(inventoryResponse)).status).toBe("synced");

    // Inventory updates the backend row created at approval instead of adding
    // a second one.
    const syncedBackends = await db.select().from(connectedBackends);
    expect(syncedBackends).toHaveLength(1);
    expect(syncedBackends[0]?.reportedFrameosVersion).toBe("1.2.3");
    expect(syncedBackends[0]?.lastHealthPayload).toEqual({ frames: 2 });
    expect(syncedBackends[0]?.lastSyncAt).not.toBeNull();
  });

  it("rotates the link token with a grace window for the previous token", async () => {
    const { accessToken, linkedClientId } = await linkBackend();

    const rotateResponse = await rotateToken(
      postJson("/api/backends/rotate-token", {}, bearer(accessToken)),
    );
    expect(rotateResponse.status).toBe(200);
    const rotatePayload = await readJson(rotateResponse);
    const newToken = rotatePayload.access_token as string;
    expect(newToken).toMatch(/^fc_link_/);
    expect(newToken).not.toBe(accessToken);
    expect(rotatePayload.linked_client_id).toBe(linkedClientId);

    // The old token keeps working during the grace window in case the backend
    // never received the rotation response.
    const oldTokenDuringGrace = await backendGrants(
      getJson("/api/backends/grants", bearer(accessToken)),
    );
    expect(oldTokenDuringGrace.status).toBe(200);

    // First use of the new token proves delivery and retires the old token.
    const newTokenResponse = await backendGrants(
      getJson("/api/backends/grants", bearer(newToken)),
    );
    expect(newTokenResponse.status).toBe(200);

    const oldTokenAfterUse = await backendGrants(
      getJson("/api/backends/grants", bearer(accessToken)),
    );
    expect(oldTokenAfterUse.status).toBe(401);
  });

  it("keeps allowlisted scopes and drops unknown ones from device requests", async () => {
    const { deviceCode, userCode } = await startDeviceRequest({
      public_display_name: "Scoped Backend",
      scopes: ["backend:link", "auth:login", "foo:bar"],
    });

    // The unknown scope never reaches storage.
    const [stored] = await db.select().from(deviceAuthorizationRequests);
    expect(stored?.requestedScopes).toEqual(["backend:link", "auth:login"]);

    await signIn();
    const authorizeResponse = await authorizeDevice(
      postJson("/api/device/authorize", { user_code: userCode }, { origin: baseUrl }),
    );
    expect(authorizeResponse.status).toBe(200);

    const pollResponse = await pollDevice(
      postJson("/api/device/poll", { device_code: deviceCode }),
    );
    expect(pollResponse.status).toBe(200);
    expect((await readJson(pollResponse)).scope).toBe("backend:link auth:login");
  });

  it("records a frame that links directly as client_kind frame", async () => {
    const { deviceCode, userCode } = await startDeviceRequest({
      local_origin: "http://10.0.0.9:8787",
      public_display_name: "Kitchen frame",
      scopes: ["frame:link", "auth:login"],
    });

    const [storedRequest] = await db
      .select()
      .from(deviceAuthorizationRequests);
    expect(storedRequest?.clientKind).toBe("frame");

    await signIn();

    // The consent lookup reports the kind so the approval screen can say
    // "frame" instead of "backend".
    const lookup = await lookupDeviceRequest(
      getJson(`/api/device/request?user_code=${userCode}`),
    );
    expect((await readJson(lookup)).client_kind).toBe("frame");

    const authorizeResponse = await authorizeDevice(
      postJson("/api/device/authorize", { user_code: userCode }, { origin: baseUrl }),
    );
    expect(authorizeResponse.status).toBe(200);

    const pollResponse = await pollDevice(
      postJson("/api/device/poll", { device_code: deviceCode }),
    );
    expect(pollResponse.status).toBe(200);

    const [linkedClient] = await db.select().from(linkedClients);
    expect(linkedClient?.clientKind).toBe("frame");
  });

  it("includes the owning account's email in grants", async () => {
    const { accessToken, accountId } = await linkBackend();

    const grantsResponse = await backendGrants(
      getJson("/api/backends/grants", bearer(accessToken)),
    );
    expect(grantsResponse.status).toBe(200);

    const [account] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId));
    expect(account?.primaryEmail).toMatch(/@example\.com$/);
    expect((await readJson(grantsResponse)).grants).toEqual([
      expect.objectContaining({
        account_email: account?.primaryEmail,
        account_id: accountId,
      }),
    ]);
  });

  it("lets a backend unlink itself with its link token", async () => {
    const { accessToken, linkedClientId } = await linkBackend();

    // A bad token cannot unlink anything.
    const badToken = await unlinkBackend(
      postJson("/api/backends/unlink", {}, bearer("fc_link_not_a_real_token")),
    );
    expect(badToken.status).toBe(401);
    expect((await readJson(badToken)).error).toBe("invalid_link_token");

    const unlinkResponse = await unlinkBackend(
      postJson("/api/backends/unlink", {}, bearer(accessToken)),
    );
    expect(unlinkResponse.status).toBe(200);
    expect((await readJson(unlinkResponse)).status).toBe("unlinked");

    const [linkedClient] = await db.select().from(linkedClients);
    expect(linkedClient?.id).toBe(linkedClientId);
    expect(linkedClient?.revokedAt).not.toBeNull();

    const audits = await db.select().from(auditEvents);
    expect(audits.map((event) => event.eventType)).toContain(
      "linked_client.unlinked",
    );

    // The token stops authenticating: reads and repeated unlinks both 401.
    const grantsAfter = await backendGrants(
      getJson("/api/backends/grants", bearer(accessToken)),
    );
    expect(grantsAfter.status).toBe(401);
    const repeatUnlink = await unlinkBackend(
      postJson("/api/backends/unlink", {}, bearer(accessToken)),
    );
    expect(repeatUnlink.status).toBe(401);
    expect((await readJson(repeatUnlink)).error).toBe("invalid_link_token");
  });

  it("reports access_denied to a backend whose request the user denied", async () => {
    const { deviceCode, userCode } = await startDeviceRequest();
    await signIn();

    const denyResponse = await denyDevice(
      postJson("/api/device/deny", { user_code: userCode }, { origin: baseUrl }),
    );
    expect(denyResponse.status).toBe(200);
    expect((await readJson(denyResponse)).status).toBe("denied");

    const pollResponse = await pollDevice(
      postJson("/api/device/poll", { device_code: deviceCode }),
    );
    expect(pollResponse.status).toBe(403);
    expect((await readJson(pollResponse)).error).toBe("access_denied");

    const authorizeResponse = await authorizeDevice(
      postJson("/api/device/authorize", { user_code: userCode }, { origin: baseUrl }),
    );
    expect(authorizeResponse.status).toBe(409);
    expect((await readJson(authorizeResponse)).error).toBe(
      "device_request_denied",
    );
  });

  it("rejects a revoked linked client's token, and only the owner can revoke", async () => {
    const { accessToken, linkedClientId } = await linkBackend();
    const ownerCookie = cookieJar.get(sessionCookieName);

    // A different signed-in account cannot revoke someone else's client.
    await signIn();
    const foreignRevoke = await revokeLinkedClient(
      postJson(
        "/api/device/revoke",
        { linked_client_id: linkedClientId },
        { origin: baseUrl },
      ),
    );
    expect(foreignRevoke.status).toBe(404);

    const stillWorks = await backendGrants(
      getJson("/api/backends/grants", bearer(accessToken)),
    );
    expect(stillWorks.status).toBe(200);

    // The owner revokes; the backend's token stops authenticating.
    cookieJar.set(sessionCookieName, ownerCookie ?? "");
    const ownerRevoke = await revokeLinkedClient(
      postJson(
        "/api/device/revoke",
        { linked_client_id: linkedClientId },
        { origin: baseUrl },
      ),
    );
    expect(ownerRevoke.status).toBe(200);

    const afterRevoke = await backendGrants(
      getJson("/api/backends/grants", bearer(accessToken)),
    );
    expect(afterRevoke.status).toBe(401);
    expect((await readJson(afterRevoke)).error).toBe("invalid_link_token");
  });

  it("expires stale device requests on poll and on approval", async () => {
    const pollFlow = await startDeviceRequest();
    await expireDeviceRequest(pollFlow.deviceCode);

    const pollResponse = await pollDevice(
      postJson("/api/device/poll", { device_code: pollFlow.deviceCode }),
    );
    expect(pollResponse.status).toBe(400);
    expect((await readJson(pollResponse)).error).toBe("expired_token");
    const [polled] = await db
      .select()
      .from(deviceAuthorizationRequests)
      .where(
        eq(
          deviceAuthorizationRequests.deviceCodeHash,
          hashSecret(pollFlow.deviceCode),
        ),
      );
    expect(polled?.status).toBe("expired");

    const approveFlow = await startDeviceRequest();
    await expireDeviceRequest(approveFlow.deviceCode);
    await signIn();

    const authorizeResponse = await authorizeDevice(
      postJson(
        "/api/device/authorize",
        { user_code: approveFlow.userCode },
        { origin: baseUrl },
      ),
    );
    expect(authorizeResponse.status).toBe(400);
    expect((await readJson(authorizeResponse)).error).toBe("expired_token");
  });

  it("rejects unknown codes, cross-origin approvals, and bad link tokens", async () => {
    const unknownPoll = await pollDevice(
      postJson("/api/device/poll", { device_code: "fc_device_unknown" }),
    );
    expect(unknownPoll.status).toBe(400);
    expect((await readJson(unknownPoll)).error).toBe("invalid_device_code");

    await signIn();
    const unknownAuthorize = await authorizeDevice(
      postJson(
        "/api/device/authorize",
        { user_code: "AAAA-2222" },
        { origin: baseUrl },
      ),
    );
    expect(unknownAuthorize.status).toBe(404);
    expect((await readJson(unknownAuthorize)).error).toBe("invalid_user_code");

    // CSRF: approvals must come from the app's own origin.
    const missingOrigin = await authorizeDevice(
      postJson("/api/device/authorize", { user_code: "AAAA-2222" }),
    );
    expect(missingOrigin.status).toBe(403);
    const wrongOrigin = await authorizeDevice(
      postJson(
        "/api/device/authorize",
        { user_code: "AAAA-2222" },
        { origin: "https://evil.example" },
      ),
    );
    expect(wrongOrigin.status).toBe(403);

    const badBearer = await backendGrants(
      getJson("/api/backends/grants", bearer("fc_link_not_a_real_token")),
    );
    expect(badBearer.status).toBe(401);
    expect((await readJson(badBearer)).error).toBe("invalid_link_token");
  });
});

async function expireDeviceRequest(deviceCode: string) {
  await db
    .update(deviceAuthorizationRequests)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(
      eq(deviceAuthorizationRequests.deviceCodeHash, hashSecret(deviceCode)),
    );
}
