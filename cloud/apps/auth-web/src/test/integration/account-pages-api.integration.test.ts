// The routes the frames workspace's account pages read
// (frontend/src/scenes/settings/account): GET /api/account/installs,
// GET /api/account/backups and GET /api/account/security, plus the listing
// shape GET /api/account/api-tokens grew for the shared Developer page.
import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { createDb, upsertAccountFromIdentity } from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as listApiTokens } from "../../../app/api/account/api-tokens/route";
import { GET as listBackups } from "../../../app/api/account/backups/route";
import { GET as listInstalls } from "../../../app/api/account/installs/route";
import { GET as readSecurity } from "../../../app/api/account/security/route";
import { GET as readActivity } from "../../../app/api/account/activity/route";
import { POST as saveBackup } from "../../../app/api/backends/backups/route";
import { POST as authorizeDevice } from "../../../app/api/device/authorize/route";
import { POST as pollDevice } from "../../../app/api/device/poll/route";
import { POST as revokeDevice } from "../../../app/api/device/revoke/route";
import { POST as startDevice } from "../../../app/api/device/start/route";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { createSession, sessionCookieName } from "../../lib/session";
import { sealedBackupBase64 } from "./sealed-backup";

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

function get(path: string) {
  return new NextRequest(new URL(path, baseUrl), { method: "GET" });
}

async function readJson(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

async function signIn() {
  userCounter += 1;
  const providerSubject = `account-pages-user-${userCounter}`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Account Pages Tester ${userCounter}`,
    email: `account-pages-${userCounter}@example.com`,
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

// The device flow for the signed-in account: a backend linked with the
// given scopes, answering with its link token.
async function linkBackend(name: string, scopes: string[]) {
  const startPayload = await readJson(
    await startDevice(
      postJson("/api/device/start", {
        local_origin: "http://10.2.2.2:8989",
        public_display_name: name,
        scopes,
      }),
    ),
  );
  const authorizeResponse = await authorizeDevice(
    postJson(
      "/api/device/authorize",
      { user_code: startPayload.user_code },
      { origin: baseUrl },
    ),
  );
  expect(authorizeResponse.status).toBe(200);
  const pollPayload = await readJson(
    await pollDevice(
      postJson("/api/device/poll", { device_code: startPayload.device_code }),
    ),
  );
  return pollPayload.access_token as string;
}

describe("GET /api/account/installs", () => {
  it("needs a session", async () => {
    expect((await listInstalls(get("/api/account/installs"))).status).toBe(401);
  });

  it("lists the linked backends with their features, origin and revocation", async () => {
    await signIn();
    const accessToken = await linkBackend("Kitchen backend", [
      "backend:link",
      "backup:frames",
    ]);
    expect(accessToken).toBeTruthy();

    const payload = await readJson(await listInstalls(get("/api/account/installs")));
    const installs = payload.installs as Record<string, unknown>[];
    expect(installs).toHaveLength(1);
    const install = installs[0]!;
    expect(install.name).toBe("Kitchen backend");
    expect(install.kind).toBe("backend");
    // The baseline link scope is not a "feature"; the backup scope is.
    expect(install.features).toEqual(["Frame backups"]);
    // The origin the backend reported when it linked, for "Open".
    expect(install.origin).toBe("http://10.2.2.2:8989");
    expect(install.revoked_at).toBeNull();
    expect(typeof install.created_at).toBe("string");

    // Revoked links stay listed (the page offers to show them), without an
    // origin to open.
    const revokeResponse = await revokeDevice(
      postJson(
        "/api/device/revoke",
        { linked_client_id: install.id },
        { origin: baseUrl },
      ),
    );
    expect(revokeResponse.status).toBe(200);
    const after = await readJson(await listInstalls(get("/api/account/installs")));
    const revoked = (after.installs as Record<string, unknown>[])[0]!;
    expect(typeof revoked.revoked_at).toBe("string");
    expect(revoked.origin).toBeNull();
  });

  it("does not list another account's links", async () => {
    await signIn();
    await linkBackend("Theirs", ["backend:link"]);
    await signIn();
    const payload = await readJson(await listInstalls(get("/api/account/installs")));
    expect(payload.installs).toEqual([]);
  });
});

describe("GET /api/account/backups", () => {
  it("needs a session", async () => {
    expect((await listBackups(get("/api/account/backups"))).status).toBe(401);
  });

  it("lists the account's backups with who pushed them and where to download", async () => {
    await signIn();
    const accessToken = await linkBackend("Backup backend", [
      "backend:link",
      "backup:frames",
    ]);
    const saveResponse = await saveBackup(
      postJson(
        "/api/backends/backups",
        {
          content_base64: sealedBackupBase64('{"scenes": []}'),
          content_type: "application/json",
          item_key: "frame-1",
          kind: "frames",
          name: "Kitchen frame",
        },
        { authorization: `Bearer ${accessToken}` },
      ),
    );
    expect(saveResponse.status).toBe(200);

    const payload = await readJson(await listBackups(get("/api/account/backups")));
    const backups = payload.backups as Record<string, unknown>[];
    expect(backups).toHaveLength(1);
    const backup = backups[0]!;
    expect(backup.name).toBe("Kitchen frame");
    expect(backup.item_key).toBe("frame-1");
    expect(backup.kind).toBe("frames");
    expect(backup.kind_label).toBe("Frame");
    expect(backup.pushed_by).toBe("Backup backend");
    expect(backup.size_bytes).toBeGreaterThan(0);
    expect(backup.download_url).toBe(`/api/account/backups/${backup.id}`);
    expect(typeof payload.max_backups).toBe("number");
  });
});

describe("GET /api/account/security", () => {
  it("needs a session", async () => {
    expect((await readSecurity(get("/api/account/security"))).status).toBe(401);
  });

  it("says what the forms need: password, superadmin, email", async () => {
    await signIn();
    const payload = await readJson(await readSecurity(get("/api/account/security")));
    // A Google-only account: no password, so deletion confirms with the email.
    expect(payload).toEqual({
      email: `account-pages-${userCounter}@example.com`,
      has_password: false,
      is_superadmin: false,
      name: `Account Pages Tester ${userCounter}`,
    });
  });
});

describe("the shared Developer page's listing shape", () => {
  it("carries the backend's fields next to the documented ones", async () => {
    await signIn();
    const payload = await readJson(await listApiTokens(get("/api/account/api-tokens")));
    expect(payload.tokens).toEqual([]);
    expect(payload.api_tokens).toEqual([]);
    expect(payload.live_count).toBe(0);
    // A session that just signed in has proved itself recently enough.
    expect(payload.can_create).toBe(true);
    expect(payload.reauth_required).toBe(false);
    expect(payload.password_required).toBe(false);
    expect(payload.mcp_url).toBe("http://localhost:3000/api/mcp");
    expect(payload.token_example).toBe("fc_api_…");
  });
});

describe("the activity feed's families", () => {
  it("names the groups the filter accepts", async () => {
    await signIn();
    const payload = await readJson(await readActivity(get("/api/account/activity")));
    const groups = payload.groups as { label: string; value: string }[];
    expect(groups.map((group) => group.value)).toEqual([
      "account",
      "backups",
      "devices",
      "frames",
      "photos",
      "store",
    ]);
    expect((await readActivity(get("/api/account/activity?group=frames"))).status).toBe(200);
  });
});
